/**
 * The deterministic executor: `(plan, sceneryIndex) → terrain + placements + env`.
 *
 * No network, no AI, no randomness beyond the plan's own seed. Whether the plan
 * came from the built-in planner or from Claude, this is the only code that
 * decides what a tile ends up being — which is what keeps output renderable and
 * reproducible.
 *
 * It works over the WHOLE area as one continuous field and only splits into
 * per-region files at the end, so nothing seams at a region border: the
 * heightmap, the zones, the paths and the scatter all cross freely.
 */

import { SIZE, tileIndex, type LocEntry, type MapTerrain } from '../loaders/maps'
import { materialByte } from './palette'
import { makeRng, pickWeighted, smoothstep, warpedFbm } from './rng'
import { resolveSpecies, type SceneryIndex } from './scenery'
import type {
  GenerationResult, GroundBand, ProcPlan, ScatterRule, SpeciesId, SpeciesPick, Zone,
} from './types'

const PLANES = 4

/** Stored height 1 decodes to 0 — 0 and 1 both mean "flat" (client quirk). */
const clampHeightByte = (v: number) => (v <= 1 ? 1 : Math.max(1, Math.min(255, Math.round(v))))

type Field = {
  /** area extent in tiles */
  w: number
  h: number
  /** stored height byte per tile */
  height: Float32Array
  /** 0..1 normalized height, for band matching */
  norm: Float32Array
  /** stored-unit slope per tile */
  slope: Float32Array
  underlay: Uint8Array
  overlay: Uint8Array
  shapeRot: Uint8Array
  /** occupancy so rules can avoid each other */
  isPath: Uint8Array
  isPlot: Uint8Array
  /** material byte a reserved plot pad is paved with; 0 = leave the ground */
  plotMat: Uint8Array
  isWater: Uint8Array
  occupied: Uint8Array
  /** zone index + 1 per tile, 0 = none */
  zoneAt: Uint16Array
}

const idx = (f: Field, x: number, y: number) => x * f.h + y
const inBounds = (f: Field, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h

function zoneContains(z: Zone, x: number, y: number): boolean {
  const s = z.shape
  if (s.type === 'circle') {
    const dx = x - s.cx
    const dy = y - s.cy
    return dx * dx + dy * dy <= s.radius * s.radius
  }
  return x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h
}

/** Distance to a zone's edge; negative inside, positive outside. */
function zoneEdgeDistance(z: Zone, x: number, y: number): number {
  const s = z.shape
  if (s.type === 'circle') {
    return Math.hypot(x - s.cx, y - s.cy) - s.radius
  }
  const cx = Math.max(s.x, Math.min(s.x + s.w - 1, x))
  const cy = Math.max(s.y, Math.min(s.y + s.h - 1, y))
  const outside = Math.hypot(x - cx, y - cy)
  if (outside > 0) return outside
  return -Math.min(x - s.x, s.x + s.w - 1 - x, y - s.y, s.y + s.h - 1 - y)
}

function zoneCentre(z: Zone): { x: number; y: number } {
  const s = z.shape
  return s.type === 'circle'
    ? { x: s.cx, y: s.cy }
    : { x: s.x + s.w / 2, y: s.y + s.h / 2 }
}

// ---------------------------------------------------------------------------
// 1. Heightmap
// ---------------------------------------------------------------------------

function buildHeights(plan: ProcPlan, f: Field) {
  const t = plan.terrain
  const scale = Math.max(4, t.featureScale)
  const base = t.baseHeight ?? 40
  let min = Infinity
  let max = -Infinity
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const n = warpedFbm(plan.seed, x / scale, y / scale, t.warp ?? 0.5, {
        octaves: 3 + Math.round((t.roughness ?? 0.5) * 3),
        gain: 0.45 + (t.roughness ?? 0.5) * 0.15,
        ridged: t.ridged,
      })
      // ridged fbm is already 0..1; plain fbm is -1..1
      const unit = t.ridged ? n : (n + 1) / 2
      const v = base + unit * t.amplitude
      f.height[idx(f, x, y)] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  const span = Math.max(1, max - min)
  for (let i = 0; i < f.height.length; i++) f.norm[i] = (f.height[i] - min) / span
}

function computeSlopes(f: Field) {
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const c = f.height[idx(f, x, y)]
      let worst = 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (!inBounds(f, nx, ny)) continue
        worst = Math.max(worst, Math.abs(f.height[idx(f, nx, ny)] - c))
      }
      f.slope[idx(f, x, y)] = worst
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Zones — flatten, mark, and hand out plots
// ---------------------------------------------------------------------------

function applyZones(plan: ProcPlan, f: Field, result: GenerationResult) {
  const zones = plan.zones ?? []
  zones.forEach((zone, zi) => {
    let tiles = 0
    // flatten toward the zone's mean height, with a skirt so it melts into the
    // hillside rather than terracing into it
    if (zone.flatten && zone.flatten > 0) {
      let sum = 0
      let n = 0
      for (let x = 0; x < f.w; x++) {
        for (let y = 0; y < f.h; y++) {
          if (!zoneContains(zone, x, y)) continue
          sum += f.height[idx(f, x, y)]
          n++
        }
      }
      if (n > 0) {
        const target = sum / n
        const skirt = 10
        for (let x = 0; x < f.w; x++) {
          for (let y = 0; y < f.h; y++) {
            const d = zoneEdgeDistance(zone, x, y)
            if (d > skirt) continue
            // 1 well inside, easing to 0 at the outer edge of the skirt
            const w = (1 - smoothstep(-1, skirt, d)) * zone.flatten
            if (w <= 0) continue
            const i = idx(f, x, y)
            f.height[i] = f.height[i] + (target - f.height[i]) * w
          }
        }
      }
    }
    for (let x = 0; x < f.w; x++) {
      for (let y = 0; y < f.h; y++) {
        if (!zoneContains(zone, x, y)) continue
        f.zoneAt[idx(f, x, y)] = zi + 1
        tiles++
      }
    }
    result.report.zones.push({ id: zone.id, kind: zone.kind, tiles })
  })
  if (zones.some((z) => z.flatten)) computeSlopes(f)
}

/**
 * Plots are the generator's only promise to the (deferred) prefab system: a
 * flat, tagged rectangle with room around it. They're marked so scatter avoids
 * them, and reported so a stamper can consume them later.
 */
function placePlots(plan: ProcPlan, f: Field, rnd: () => number, result: GenerationResult) {
  for (const zone of plan.zones ?? []) {
    const spec = zone.plots
    if (!spec?.count) continue
    const minS = spec.minSize ?? 4
    const maxS = spec.maxSize ?? 8
    let placed = 0
    for (let attempt = 0; attempt < spec.count * 60 && placed < spec.count; attempt++) {
      const w = minS + Math.floor(rnd() * (maxS - minS + 1))
      const h = minS + Math.floor(rnd() * (maxS - minS + 1))
      const c = zoneCentre(zone)
      const spread = zone.shape.type === 'circle' ? zone.shape.radius : Math.max(zone.shape.w, zone.shape.h) / 2
      const px = Math.round(c.x + (rnd() * 2 - 1) * spread) - (w >> 1)
      const py = Math.round(c.y + (rnd() * 2 - 1) * spread) - (h >> 1)
      let ok = true
      let sum = 0
      for (let x = px - 1; x <= px + w && ok; x++) {
        for (let y = py - 1; y <= py + h; y++) {
          if (!inBounds(f, x, y) || !zoneContains(zone, x, y)) { ok = false; break }
          const i = idx(f, x, y)
          if (f.isPlot[i] || f.isWater[i]) { ok = false; break }
          sum += f.height[i]
        }
      }
      if (!ok) continue
      // level the pad exactly — a building on a slope reads as broken
      const level = sum / ((w + 2) * (h + 2))
      const pad = spec.underlayId !== undefined ? materialByte(spec.underlayId) : 0
      for (let x = px; x < px + w; x++) {
        for (let y = py; y < py + h; y++) {
          const i = idx(f, x, y)
          f.height[i] = level
          f.isPlot[i] = 1
          f.plotMat[i] = pad
        }
      }
      result.report.plots.push({ zoneId: zone.id, x: px, y: py, w, h, purpose: spec.purpose })
      placed++
    }
  }
  computeSlopes(f)
}

// ---------------------------------------------------------------------------
// 3. Paths — greedy least-cost routes that reuse each other
// ---------------------------------------------------------------------------

/**
 * A* over the tile grid, cost = distance + slope penalty, with a large discount
 * for reusing an existing path so routes braid into a network instead of
 * running parallel. Carves the height toward the route where it must climb, so
 * a path never stripes straight up a cliff.
 */
function routePath(
  f: Field,
  from: { x: number; y: number },
  to: { x: number; y: number },
  /** per-tile meander bias in roughly [0,1]; the route seeks the low channels */
  wander: Float32Array | null,
  wanderStrength: number,
  /** per-tile EXTRA cost to route around — used to push a loop's return leg
   *  away from its outbound leg, which is otherwise the cheapest way home by a
   *  long way. Graded, not binary: a hard mask one tile thick just moves the
   *  return leg one tile sideways. */
  avoid: Float32Array | null = null,
): number[] {
  const start = idx(f, Math.round(from.x), Math.round(from.y))
  const goal = idx(f, Math.round(to.x), Math.round(to.y))
  if (start === goal) return [start]
  const n = f.w * f.h

  /**
   * Cost of running NEAR an existing path without being on it.
   *
   * Sharing tiles is braiding and is cheap; laying a second ribbon a tile or
   * two away is not — the pair just reads as one road of double the width, or
   * as two roads with a pointless gap between them. A 4-neighbour check only
   * priced distance 1, which left distance 2 as the cheapest way to shadow a
   * road, so this is a proper falloff out to 3 tiles.
   */
  const nearPathPenalty = new Float32Array(n)
  {
    const d = new Int32Array(n).fill(-1)
    const q = new Int32Array(n)
    let qh = 0
    let qt = 0
    for (let i = 0; i < n; i++) if (f.isPath[i]) { d[i] = 0; q[qt++] = i }
    const REACH = 3
    while (qh < qt) {
      const cur = q[qh++]
      if (d[cur] >= REACH) continue
      const cx = Math.floor(cur / f.h)
      const cy = cur % f.h
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const px = cx + dx
        const py = cy + dy
        if (!inBounds(f, px, py)) continue
        const pi = idx(f, px, py)
        if (d[pi] !== -1) continue
        d[pi] = d[cur] + 1
        nearPathPenalty[pi] = (REACH + 1 - d[pi]) * 1.4
        q[qt++] = pi
      }
    }
  }
  const cost = new Float32Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const seen = new Uint8Array(n)
  cost[start] = 0
  // simple binary heap
  const heap: number[] = [start]
  const key = new Float32Array(n)
  key[start] = 0
  const push = (i: number, k: number) => {
    key[i] = k
    heap.push(i)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (key[heap[p]] <= key[heap[c]]) break
      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }
  const pop = (): number => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = p * 2 + 1
        const r = l + 1
        let s = p
        if (l < heap.length && key[heap[l]] < key[heap[s]]) s = l
        if (r < heap.length && key[heap[r]] < key[heap[s]]) s = r
        if (s === p) break
        ;[heap[p], heap[s]] = [heap[s], heap[p]]
        p = s
      }
    }
    return top
  }
  const gx = Math.round(to.x)
  const gy = Math.round(to.y)
  let guard = 0
  while (heap.length && guard++ < n * 8) {
    const cur = pop()
    if (seen[cur]) continue
    seen[cur] = 1
    if (cur === goal) break
    const cx = Math.floor(cur / f.h)
    const cy = cur % f.h
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inBounds(f, nx, ny)) continue
      const ni = idx(f, nx, ny)
      if (seen[ni]) continue
      const climb = Math.abs(f.height[ni] - f.height[cur])
      // water is crossable but expensive; a bridge is a prefab problem
      let step = 1 + climb * 0.9 + (f.isWater[ni] ? 12 : 0)
      if (wander) step += wander[ni] * wanderStrength
      if (avoid && avoid[ni]) step += 8
      if (f.isPath[ni]) step *= 0.35 // braid into existing routes
      else step += nearPathPenalty[ni] // ...but do not run alongside one
      const next = cost[cur] + step
      if (next < cost[ni]) {
        cost[ni] = next
        prev[ni] = cur
        // The heuristic is deliberately UNDER-weighted against the wander cost.
        // At the old 0.9 the search ran almost straight at the goal and the
        // meander never paid for itself, which is why every route came out as
        // a ruled line across the area.
        push(ni, next + Math.hypot(nx - gx, ny - gy) * (wanderStrength > 0 ? 0.55 : 0.9))
      }
    }
  }
  if (prev[goal] === -1 && goal !== start) return []
  const out: number[] = []
  for (let i = goal; i !== -1; i = prev[i]) out.push(i)
  return out.reverse()
}

function paintPaths(plan: ProcPlan, f: Field, rnd: () => number, result: GenerationResult): number[][] {
  const spec = plan.paths
  const routes: number[][] = []
  if (!spec) return routes
  const zones = (plan.zones ?? []).filter((z) => z.kind !== 'water')
  const anchors = zones.map(zoneCentre)
  // A road through the area even with nothing to connect: an empty forest with
  // no route through it can't have lit paths, and "lights along the paths" was
  // an explicit ask for exactly those moody, unsettled themes.
  if (spec.toAreaEdge) {
    // Where a route ENTERS and LEAVES matters as much as how it bends. The
    // midpoint of one edge to the midpoint of the opposite is the single route
    // guaranteed to ignore the whole rest of the area — it bisects it and
    // touches nothing else, which is why the corners stayed empty however much
    // the path wandered. Pick different sides, at jittered positions along
    // them, so the network crosses the area rather than halving it.
    const sides = [0, 1, 2, 3]
    for (let i = sides.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[sides[i], sides[j]] = [sides[j], sides[i]]
    }
    const portal = (side: number) => {
      const t = 0.15 + rnd() * 0.7 // never right at a corner
      if (side === 0) return { x: Math.round((f.w - 1) * t), y: 1 }
      if (side === 1) return { x: f.w - 2, y: Math.round((f.h - 1) * t) }
      if (side === 2) return { x: Math.round((f.w - 1) * t), y: f.h - 2 }
      return { x: 1, y: Math.round((f.h - 1) * t) }
    }
    const portals = sides.slice(0, zones.length ? 2 : 3).map(portal)
    anchors.unshift(portals[0])
    anchors.push(...portals.slice(1))
  }

  /**
   * The meander field. A least-cost route across gentle ground IS a straight
   * line — the heightmap alone gives the router nothing to prefer, which is
   * why every path came out ruled edge to edge. This gives it a landscape of
   * cheap channels to find, so the route curves for a reason and the same plan
   * still produces the same curve.
   */
  const wanderAmt = Math.max(0, Math.min(1, spec.wander ?? 0.45))
  let wander: Float32Array | null = null
  if (wanderAmt > 0) {
    wander = new Float32Array(f.w * f.h)
    const scale = Math.max(10, Math.min(f.w, f.h) / 6)
    for (let x = 0; x < f.w; x++) {
      for (let y = 0; y < f.h; y++) {
        const n = warpedFbm(plan.seed ^ 0x51ed3, x / scale, y / scale, 0.9, { octaves: 3 })
        wander[idx(f, x, y)] = (n + 1) / 2
      }
    }
  }
  const wanderStrength = wanderAmt * 7

  const width = Math.max(1, spec.width ?? 3)
  // wider through a settlement, where the plots are; defaults to two tiles
  // more than the open-country width
  const wideWidth = Math.max(width, spec.settlementWidth ?? width + 2)

  /**
   * A road is only wide where the traffic is. `wide` applies inside a zone —
   * the settlements, which are also where the building plots are — and `w`
   * everywhere else, so a track through the woods stays a track and opens out
   * into a proper road as it reaches somewhere worth paving.
   */
  const paint = (route: number[], w: number, wide: number) => {
    for (const tile of route) {
      const tx = Math.floor(tile / f.h)
      const ty = tile % f.h
      // tolerance +0.5 rather than +0.25 so `width` is tiles-across as it
      // reads: at +0.25 an even width painted the same as the odd one below it
      const half = ((f.zoneAt[tile] > 0 ? wide : w) - 1) / 2
      for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) {
        for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++) {
          if (Math.hypot(dx, dy) > half + 0.5) continue
          const px = tx + dx
          const py = ty + dy
          if (!inBounds(f, px, py)) continue
          const pi = idx(f, px, py)
          f.isPath[pi] = 1
          f.overlay[pi] = materialByte(spec.overlayId)
          f.shapeRot[pi] = 0
        }
      }
    }
    // ease the terrain toward the route so it doesn't climb cliffs
    for (const tile of route) {
      const tx = Math.floor(tile / f.h)
      const ty = tile % f.h
      const target = f.height[tile]
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const px = tx + dx
          const py = ty + dy
          if (!inBounds(f, px, py)) continue
          const ease = 1 - smoothstep(0, 3.5, Math.hypot(dx, dy))
          const pi = idx(f, px, py)
          f.height[pi] += (target - f.height[pi]) * ease * 0.5
        }
      }
    }
  }

  // --- trunks: the through-routes and whatever the zones want connecting
  for (let i = 1; i < anchors.length; i++) {
    const route = routePath(f, anchors[i - 1], anchors[i], wander, wanderStrength)
    if (!route.length) continue
    routes.push(route)
    paint(route, width, wideWidth)
  }

  // --- spurs. A lone through-road reads as a seam across the area; branches
  // are what make it somewhere people move around in. Each leaves an existing
  // route, and because `routePath` discounts tiles that are already path, a
  // spur aimed near the network tends to REJOIN it rather than dead-end —
  // which is the braiding that turns two roads into one road system.
  //
  // Where a spur GOES is chosen by measurement, not by a random bearing.
  // Random bearings cluster: three spurs can all strike out the same way and
  // leave half the area untouched, which is exactly how a 2x2 ends up with its
  // whole network in one corner. Each spur instead aims at whatever is
  // currently furthest from any path, so every one buys the most coverage
  // available at the time.
  const spurWidth = Math.max(1, width - 1)
  const spurs: number[][] = []
  const span = Math.min(f.w, f.h)

  /** Tiles from the nearest path tile, by multi-source BFS. -1 = unreachable. */
  const distanceFromPaths = (): Int32Array => {
    const dist = new Int32Array(f.w * f.h).fill(-1)
    const queue = new Int32Array(f.w * f.h)
    let qh = 0
    let qt = 0
    for (let i = 0; i < dist.length; i++) if (f.isPath[i]) { dist[i] = 0; queue[qt++] = i }
    while (qh < qt) {
      const cur = queue[qh++]
      const cx = Math.floor(cur / f.h)
      const cy = cur % f.h
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx
        const ny = cy + dy
        if (!inBounds(f, nx, ny)) continue
        const ni = idx(f, nx, ny)
        if (dist[ni] !== -1) continue
        dist[ni] = dist[cur] + 1
        queue[qt++] = ni
      }
    }
    return dist
  }

  const coverage = spec.coverage
  const loops = Math.max(0, Math.min(1, spec.loops ?? 0))
  // The target is a DISTANCE from the network, not a spur count — that is
  // what makes the dial mean the same thing on a 1x1 and a 4x4. Curved rather
  // than linear because the interesting range is the tight end: after the
  // trunks, the furthest point is already only ~a third of the span away, so a
  // linear bar would do nothing at all until past halfway.
  const targetDist = coverage === undefined
    ? Infinity
    : 6 + Math.pow(1 - coverage, 1.5) * span * 0.55
  // With coverage driving things, `branches` is an explicit floor a caller can
  // still ask for — but it defaults to none, or "trackless" could never be
  // expressed: a floor of 2 spurs is not trackless.
  const minSpurs = spec.branches ?? (coverage === undefined ? (zones.length ? 2 : 3) : 0)
  const maxSpurs = coverage === undefined ? minSpurs : Math.max(minSpurs, 14)

  for (let b = 0; b < maxSpurs; b++) {
    const dist = distanceFromPaths()
    // furthest dry land from the network, with a little jitter between
    // near-equal candidates so two seeds don't pick the same tile every time
    let best = -1
    let bestD = -1
    // the network as it stands, so a loop can close onto something that was
    // already here rather than onto the spur it is part of
    const existing: number[] = []
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] === 0) existing.push(i)
      if (dist[i] < 0 || f.isWater[i]) continue
      const d = dist[i] + rnd() * 2
      if (d > bestD) { bestD = d; best = i }
    }
    if (best < 0) break
    // past the floor, stop as soon as the area is served well enough
    if (b >= minSpurs && bestD <= targetDist) break

    // walk down the distance gradient to the nearest path tile — that is where
    // this spur should leave the network, and A* handles the terrain between
    let cur = best
    while (dist[cur] > 0) {
      const cx = Math.floor(cur / f.h)
      const cy = cur % f.h
      let next = -1
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx
        const ny = cy + dy
        if (!inBounds(f, nx, ny)) continue
        const ni = idx(f, nx, ny)
        if (dist[ni] === dist[cur] - 1) { next = ni; break }
      }
      if (next < 0) break
      cur = next
    }
    const route = routePath(
      f,
      { x: Math.floor(cur / f.h), y: cur % f.h },
      { x: Math.floor(best / f.h), y: best % f.h },
      wander, wanderStrength,
    )
    if (route.length < 4) break // nothing further worth reaching
    routes.push(route)
    paint(route, spurWidth, Math.max(spurWidth, wideWidth - 1))

    // --- close the loop. Having reached somewhere, carry on and rejoin the
    // network at a DIFFERENT point, so you can leave one way and come back
    // another. The return leg must be routed around the outbound one: with
    // path tiles discounted, the cheapest way home is always the road you just
    // came in on, and retracing it draws nothing new.
    let looped = false
    if (loops > 0 && rnd() < loops && existing.length > 0) {
      // A CORRIDOR around the outbound leg, not the leg itself. Marking only
      // the centre line moved the return leg exactly one tile sideways and
      // drew the pair of parallel roads this is here to prevent; the return
      // has to be pushed a real distance away before a loop encloses anything.
      // Graded so it still gives way where the terrain says no.
      const avoid = new Float32Array(f.w * f.h)
      const REACH = Math.max(6, Math.round(span * 0.12))
      {
        const d = new Int32Array(f.w * f.h).fill(-1)
        const q = new Int32Array(f.w * f.h)
        let qh = 0
        let qt = 0
        // leave the last few tiles clear so the return leg can actually start
        for (let i = 0; i < route.length - 4; i++) { d[route[i]] = 0; q[qt++] = route[i] }
        while (qh < qt) {
          const c = q[qh++]
          avoid[c] = (REACH + 1 - d[c]) * 1.6
          if (d[c] >= REACH) continue
          const cx2 = Math.floor(c / f.h)
          const cy2 = c % f.h
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const px = cx2 + dx
            const py = cy2 + dy
            if (!inBounds(f, px, py)) continue
            const pi = idx(f, px, py)
            if (d[pi] !== -1) continue
            d[pi] = d[c] + 1
            q[qt++] = pi
          }
        }
      }
      const ox = Math.floor(cur / f.h)
      const oy = cur % f.h
      const bx = Math.floor(best / f.h)
      const by = best % f.h
      // nearest bit of existing network that is a decent walk from where this
      // spur left it — closing onto its own doorstep is not a loop
      let rejoin = -1
      let rejoinD = Infinity
      for (const t of existing) {
        const tx = Math.floor(t / f.h)
        const ty = t % f.h
        if (Math.hypot(tx - ox, ty - oy) < span * 0.2) continue
        const d = Math.hypot(tx - bx, ty - by)
        if (d < rejoinD) { rejoinD = d; rejoin = t }
      }
      if (rejoin >= 0) {
        const back = routePath(
          f, { x: bx, y: by },
          { x: Math.floor(rejoin / f.h), y: rejoin % f.h },
          wander, wanderStrength, avoid,
        )
        if (back.length >= 4) {
          routes.push(back)
          paint(back, spurWidth, Math.max(spurWidth, wideWidth - 1))
          looped = true
        }
      }
    }
    // only a spur that still ends nowhere gets a wayside pad — a lane that
    // carries on round is a through-route, not a place to put a hut
    if (!looped) spurs.push(route)
  }

  // --- wayside pads at the far end of a spur: somewhere a shop, a shrine or a
  // hut could be stamped later. Without these an unsettled area has no plots
  // at all, because plots are a ZONE feature and the wilds have no zones.
  const wantPads = spec.waysidePlots ?? Math.min(spurs.length, 2)
  const padMat = spec.waysidePlotUnderlayId !== undefined ? materialByte(spec.waysidePlotUnderlayId) : 0
  let pads = 0
  for (const route of spurs) {
    if (pads >= wantPads) break
    const end = route[route.length - 1]
    const ex = Math.floor(end / f.h)
    const ey = end % f.h
    const pw = 5 + Math.floor(rnd() * 3)
    const ph = 5 + Math.floor(rnd() * 3)
    // sit the pad BESIDE the spur end, not on it, so the track runs up to it
    const px = ex - (pw >> 1) + (rnd() < 0.5 ? -2 : 2)
    const py = ey - (ph >> 1) + (rnd() < 0.5 ? -2 : 2)
    let ok = true
    let sum = 0
    for (let x = px - 1; x <= px + pw && ok; x++) {
      for (let y = py - 1; y <= py + ph; y++) {
        if (!inBounds(f, x, y)) { ok = false; break }
        const i = idx(f, x, y)
        if (f.isPlot[i] || f.isWater[i]) { ok = false; break }
        sum += f.height[i]
      }
    }
    if (!ok) continue
    const level = sum / ((pw + 2) * (ph + 2))
    for (let x = px; x < px + pw; x++) {
      for (let y = py; y < py + ph; y++) {
        const i = idx(f, x, y)
        f.height[i] = level
        f.isPlot[i] = 1
        f.plotMat[i] = padMat
      }
    }
    result.report.plots.push({ zoneId: 'wayside', x: px, y: py, w: pw, h: ph, purpose: 'wayside' })
    pads++
  }

  computeSlopes(f)
  return routes
}

// ---------------------------------------------------------------------------
// 4. Ground paint
// ---------------------------------------------------------------------------

function paintGround(plan: ProcPlan, f: Field, rnd: () => number) {
  const zones = plan.zones ?? []
  const bandMatches = (b: GroundBand, x: number, y: number): boolean => {
    const i = idx(f, x, y)
    if (b.minHeight !== undefined && f.norm[i] < b.minHeight) return false
    if (b.maxHeight !== undefined && f.norm[i] > b.maxHeight) return false
    if (b.minSlope !== undefined && f.slope[i] < b.minSlope) return false
    if (b.maxSlope !== undefined && f.slope[i] > b.maxSlope) return false
    if (b.zoneId) {
      const zi = zones.findIndex((z) => z.id === b.zoneId)
      if (zi < 0 || f.zoneAt[i] !== zi + 1) return false
    }
    return true
  }
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const i = idx(f, x, y)
      for (const band of plan.ground) {
        if (!bandMatches(band, x, y)) continue
        const pick = pickWeighted(band.underlay, rnd)
        if (pick) f.underlay[i] = materialByte(pick.underlayId)
        if (band.overlayId !== undefined && !f.isPath[i]) {
          f.overlay[i] = materialByte(band.overlayId)
          f.shapeRot[i] = 0
        }
      }
      // a zone's own palette wins over the global bands
      const zi = f.zoneAt[i]
      if (zi > 0) {
        const zone = zones[zi - 1]
        if (zone?.ground?.length) {
          const pick = pickWeighted(zone.ground, rnd)
          if (pick && !f.isPath[i]) f.underlay[i] = materialByte(pick.underlayId)
        }
      }
      // a reserved plot pad wins over both: it is the one thing here that is a
      // STATEMENT OF INTENT rather than scenery, and until the prefab system
      // stamps a building on it, paving is the only way to see it exists
      if (f.plotMat[i] && !f.isPath[i]) f.underlay[i] = f.plotMat[i]
    }
  }
  // water last so nothing overwrites it
  const level = plan.terrain.waterLevel
  if (level !== undefined) {
    const waterBand = plan.ground.find((b) => b.overlayId !== undefined && b.maxHeight !== undefined)
    for (let i = 0; i < f.norm.length; i++) {
      if (f.norm[i] <= level) {
        f.isWater[i] = 1
        if (waterBand?.overlayId !== undefined) f.overlay[i] = materialByte(waterBand.overlayId)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Scatter, barriers, resources, props — everything that becomes a placement
// ---------------------------------------------------------------------------

type Placement = { x: number; y: number; objectId: number; rotation: number; shape: number }

function eligible(f: Field, rule: ScatterRule, zones: Zone[], x: number, y: number): boolean {
  const i = idx(f, x, y)
  if (f.occupied[i]) return false
  if (rule.avoid?.includes('path') && f.isPath[i]) return false
  if (rule.avoid?.includes('plot') && f.isPlot[i]) return false
  if (rule.avoid?.includes('water') && f.isWater[i]) return false
  if (!rule.avoid?.includes('water') && f.isWater[i]) return false // never plant in water by default
  if (rule.maxSlope !== undefined && f.slope[i] > rule.maxSlope) return false
  if (rule.minHeight !== undefined && f.norm[i] < rule.minHeight) return false
  if (rule.maxHeight !== undefined && f.norm[i] > rule.maxHeight) return false
  if (rule.zoneId) {
    const zi = zones.findIndex((z) => z.id === rule.zoneId)
    if (zi < 0 || f.zoneAt[i] !== zi + 1) return false
  }
  return true
}

function markOccupied(f: Field, x: number, y: number, spacing: number) {
  const r = Math.max(0, Math.floor(spacing))
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (!inBounds(f, x + dx, y + dy)) continue
      if (dx * dx + dy * dy > r * r) continue
      f.occupied[idx(f, x + dx, y + dy)] = 1
    }
  }
}

function speciesId(
  index: SceneryIndex | null,
  picks: SpeciesPick[],
  rnd: () => number,
  missing: Set<SpeciesId>,
): number | null {
  const pick = pickWeighted(picks, rnd)
  if (!pick) return null
  const id = resolveSpecies(index, pick.species, rnd)
  if (id === null) {
    missing.add(pick.species)
    // fall back to any other species in the same list that DOES resolve, so a
    // cache missing "tree_magic" still gets a forest
    for (const alt of picks) {
      const altId = resolveSpecies(index, alt.species, rnd)
      if (altId !== null) return altId
    }
    return null
  }
  return id
}

function runScatter(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>,
) {
  const zones = plan.zones ?? []
  for (const rule of plan.scatter ?? []) {
    // count eligible ground so density means the same thing everywhere
    let eligibleTiles = 0
    for (let x = 0; x < f.w; x++) for (let y = 0; y < f.h; y++) if (eligible(f, rule, zones, x, y)) eligibleTiles++
    if (!eligibleTiles) continue
    const want = Math.round((eligibleTiles / 100) * rule.density)
    const spacing = rule.spacing ?? 1
    const clustering = Math.max(0, Math.min(1, rule.clustering ?? 0.35))
    let placed = 0
    // seed a few cluster centres; higher clustering pulls picks toward them
    const centres: { x: number; y: number }[] = []
    const centreCount = Math.max(1, Math.round(want * (1 - clustering) * 0.25) + 1)
    for (let i = 0; i < centreCount; i++) {
      centres.push({ x: rnd() * f.w, y: rnd() * f.h })
    }
    for (let attempt = 0; attempt < want * 40 && placed < want; attempt++) {
      let x: number
      let y: number
      if (clustering > 0 && rnd() < clustering) {
        const c = centres[Math.floor(rnd() * centres.length)]
        const spread = 6 + (1 - clustering) * 20
        x = Math.round(c.x + (rnd() * 2 - 1) * spread)
        y = Math.round(c.y + (rnd() * 2 - 1) * spread)
      } else {
        x = Math.floor(rnd() * f.w)
        y = Math.floor(rnd() * f.h)
      }
      if (!inBounds(f, x, y) || !eligible(f, rule, zones, x, y)) continue
      const id = speciesId(index, rule.species, rnd, missing)
      if (id === null) break // nothing in this rule resolves; stop retrying
      out.push({
        x, y, objectId: id, shape: 10,
        rotation: rule.randomRotation === false ? 0 : Math.floor(rnd() * 4),
      })
      markOccupied(f, x, y, spacing)
      placed++
    }
  }
}

/**
 * A ring of scenery hugging a zone's edge. Gaps are cut at evenly spaced
 * angles so the enclosure is real but not a prison — and the path network,
 * routed before this, already has somewhere to run through.
 */
function runBarriers(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>,
) {
  const zones = plan.zones ?? []
  for (const ring of plan.barriers ?? []) {
    const zone = zones.find((z) => z.id === ring.aroundZoneId)
    if (!zone) continue
    const centre = zoneCentre(zone)
    const thickness = Math.max(1, ring.thickness ?? 2)
    const offset = ring.offset ?? 0
    const gaps = ring.gaps ?? 2
    const gapWidth = ring.gapWidth ?? 6
    // gap angles, evenly spaced with a deterministic jitter
    const gapAngles: number[] = []
    for (let i = 0; i < gaps; i++) gapAngles.push((i / Math.max(1, gaps)) * Math.PI * 2 + rnd() * 0.4)
    for (let x = 0; x < f.w; x++) {
      for (let y = 0; y < f.h; y++) {
        const d = zoneEdgeDistance(zone, x, y) - offset
        if (d < 0 || d > thickness) continue
        const i = idx(f, x, y)
        if (f.isPath[i] || f.isPlot[i] || f.occupied[i]) continue
        // leave the gaps open
        const ang = Math.atan2(y - centre.y, x - centre.x)
        const gapped = gapAngles.some((g) => {
          let diff = Math.abs(((ang - g + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
          const arc = gapWidth / Math.max(4, Math.hypot(x - centre.x, y - centre.y))
          return diff < arc
        })
        if (gapped) continue
        const id = speciesId(index, ring.species, rnd, missing)
        if (id === null) break
        out.push({ x, y, objectId: id, shape: 10, rotation: Math.floor(rnd() * 4) })
        f.occupied[i] = 1
      }
    }
  }
}

function runResources(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>,
) {
  const zones = plan.zones ?? []
  for (const node of plan.resources ?? []) {
    const zone = zones.find((z) => z.id === node.zoneId)
    if (!zone) continue
    const centre = zoneCentre(zone)
    const radius = zone.shape.type === 'circle' ? zone.shape.radius : Math.max(zone.shape.w, zone.shape.h) / 2
    // sink the pit so it reads as excavated ground
    if (node.depth) {
      for (let x = 0; x < f.w; x++) {
        for (let y = 0; y < f.h; y++) {
          const d = zoneEdgeDistance(zone, x, y)
          if (d > 4) continue
          const w = 1 - smoothstep(-radius * 0.5, 4, d)
          f.height[idx(f, x, y)] -= node.depth * w
        }
      }
      computeSlopes(f)
    }
    let placed = 0
    for (let attempt = 0; attempt < node.count * 50 && placed < node.count; attempt++) {
      const a = rnd() * Math.PI * 2
      const r = Math.sqrt(rnd()) * radius
      const x = Math.round(centre.x + Math.cos(a) * r)
      const y = Math.round(centre.y + Math.sin(a) * r)
      if (!inBounds(f, x, y)) continue
      const i = idx(f, x, y)
      if (f.occupied[i] || f.isPath[i] || f.isWater[i]) continue
      const id = speciesId(index, node.species, rnd, missing)
      if (id === null) break
      out.push({ x, y, objectId: id, shape: 10, rotation: Math.floor(rnd() * 4) })
      markOccupied(f, x, y, 1)
      placed++
    }
  }
}

function runProps(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>,
) {
  const zones = plan.zones ?? []
  for (const prop of plan.props ?? []) {
    let x = prop.x
    let y = prop.y
    if ((x === undefined || y === undefined) && prop.zoneId) {
      const zone = zones.find((z) => z.id === prop.zoneId)
      if (!zone) continue
      const c = zoneCentre(zone)
      x = Math.round(c.x)
      y = Math.round(c.y)
    }
    if (x === undefined || y === undefined || !inBounds(f, x, y)) continue
    const id = speciesId(index, [{ species: prop.species }], rnd, missing)
    if (id === null) continue
    // flatten and clear a pad, so a fountain doesn't sit half-buried
    const pad = prop.pad ?? 2
    const level = f.height[idx(f, x, y)]
    for (let dx = -pad; dx <= pad; dx++) {
      for (let dy = -pad; dy <= pad; dy++) {
        if (!inBounds(f, x + dx, y + dy)) continue
        const i = idx(f, x + dx, y + dy)
        f.height[i] = level
        f.occupied[i] = 1
      }
    }
    out.push({ x, y, objectId: id, shape: 10, rotation: prop.rotation ?? 0 })
  }
  computeSlopes(f)
}

/** Lamps along the routed paths, optionally emitting real point lights. */
function runPathLighting(
  plan: ProcPlan, f: Field, routes: number[][], index: SceneryIndex | null,
  rnd: () => number, out: Placement[], missing: Set<SpeciesId>,
  lights: { x: number; y: number; colorHsl: number; size2d: number }[],
) {
  const spec = plan.paths?.lighting
  if (!spec) return
  const every = Math.max(2, spec.every)
  const offset = spec.offset ?? 2
  for (const route of routes) {
    for (let i = 0; i < route.length; i += every) {
      const tile = route[i]
      const tx = Math.floor(tile / f.h)
      const ty = tile % f.h
      // Step PERPENDICULAR to the route's local direction, alternating sides,
      // so lamps line the verge instead of landing in the road (a fixed x
      // offset put them on it wherever the road ran east-west).
      const nextTile = route[Math.min(i + 1, route.length - 1)]
      const dirX = Math.floor(nextTile / f.h) - tx
      const dirY = (nextTile % f.h) - ty
      const len = Math.hypot(dirX, dirY) || 1
      const side = (i / every) % 2 === 0 ? 1 : -1
      // perpendicular of (dx,dy) is (-dy,dx)
      let px = Math.round(tx + (-dirY / len) * offset * side)
      let py = Math.round(ty + (dirX / len) * offset * side)
      if (!inBounds(f, px, py) || f.isPath[idx(f, px, py)]) {
        // the inside of a bend can still be road — try the other side
        px = Math.round(tx - (-dirY / len) * offset * side)
        py = Math.round(ty - (dirX / len) * offset * side)
      }
      if (!inBounds(f, px, py)) continue
      const pi = idx(f, px, py)
      if (f.isPath[pi] || f.occupied[pi] || f.isWater[pi]) continue
      const id = speciesId(index, spec.species, rnd, missing)
      if (id === null) return
      out.push({ x: px, y: py, objectId: id, shape: 10, rotation: Math.floor(rnd() * 4) })
      f.occupied[pi] = 1
      if (spec.emitsLight) {
        lights.push({
          x: px, y: py,
          colorHsl: spec.colorHsl ?? 0x3f7f,
          size2d: spec.size2d ?? 2,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function emptyTerrain(): MapTerrain {
  const tiles = PLANES * SIZE * SIZE
  return {
    underlayIds: new Uint8Array(tiles),
    overlayIds: new Uint8Array(tiles),
    overlayShapeRot: new Uint8Array(tiles),
    tileFlags: new Uint8Array(tiles),
    heightPresence: new Uint8Array(tiles >> 3),
    heightValue: new Uint8Array(tiles),
  }
}

/**
 * Run a plan. Pure apart from reading the scenery index; the caller decides
 * whether to preview or save the result.
 */
export function generate(plan: ProcPlan, index: SceneryIndex | null): GenerationResult {
  const regionsW = plan.area.x1 - plan.area.x0 + 1
  const regionsH = plan.area.y1 - plan.area.y0 + 1
  const w = regionsW * SIZE
  const h = regionsH * SIZE
  const tiles = w * h
  const f: Field = {
    w, h,
    height: new Float32Array(tiles),
    norm: new Float32Array(tiles),
    slope: new Float32Array(tiles),
    underlay: new Uint8Array(tiles),
    overlay: new Uint8Array(tiles),
    shapeRot: new Uint8Array(tiles),
    isPath: new Uint8Array(tiles),
    isPlot: new Uint8Array(tiles),
    plotMat: new Uint8Array(tiles),
    isWater: new Uint8Array(tiles),
    occupied: new Uint8Array(tiles),
    zoneAt: new Uint16Array(tiles),
  }
  const result: GenerationResult = {
    terrain: new Map(),
    objects: new Map(),
    environment: new Map(),
    report: { regions: regionsW * regionsH, placements: 0, zones: [], plots: [], unresolved: [], warnings: [] },
  }
  const rnd = makeRng(plan.seed ^ 0x9e3779b9)
  const missing = new Set<SpeciesId>()

  buildHeights(plan, f)
  computeSlopes(f)
  applyZones(plan, f, result)
  placePlots(plan, f, rnd, result)
  const routes = paintPaths(plan, f, rnd, result)
  paintGround(plan, f, rnd)

  const placements: Placement[] = []
  const lights: { x: number; y: number; colorHsl: number; size2d: number }[] = []
  // ORDER MATTERS. Everything marks occupancy, so the deliberate things go
  // down first and the filler fits around them — scatter last, or it takes the
  // verges the lamps need and the path ends up unlit.
  runResources(plan, f, index, rnd, placements, missing)
  runProps(plan, f, index, rnd, placements, missing)
  runPathLighting(plan, f, routes, index, rnd, placements, missing, lights)
  runBarriers(plan, f, index, rnd, placements, missing)
  runScatter(plan, f, index, rnd, placements, missing)

  // heights changed after the ground paint (props/resources level things), so
  // recompute normalized height once more before quantizing
  for (let ri = 0; ri < regionsW * regionsH; ri++) {
    const rx = plan.area.x0 + (ri % regionsW)
    const ry = plan.area.y0 + Math.floor(ri / regionsW)
    const regionId = (rx << 8) | ry
    const terrain = emptyTerrain()
    const ox = (rx - plan.area.x0) * SIZE
    const oy = (ry - plan.area.y0) * SIZE
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        const i = idx(f, ox + x, oy + y)
        const ti = tileIndex(0, x, y)
        terrain.underlayIds[ti] = f.underlay[i]
        terrain.overlayIds[ti] = f.overlay[i]
        terrain.overlayShapeRot[ti] = f.shapeRot[i]
        // ALWAYS write an explicit height: an absent one makes the client roll
        // its own Perlin default, which would undo the whole heightmap
        terrain.heightValue[ti] = clampHeightByte(f.height[i])
        terrain.heightPresence[ti >> 3] |= 1 << (ti & 0x7)
      }
    }
    result.terrain.set(regionId, terrain)
    result.objects.set(regionId, [])
    if (plan.environment) result.environment.set(regionId, { ...plan.environment })
  }

  // placements are area-relative; file them under the region they land in
  for (const p of placements) {
    const rx = plan.area.x0 + Math.floor(p.x / SIZE)
    const ry = plan.area.y0 + Math.floor(p.y / SIZE)
    const regionId = (rx << 8) | ry
    const list = result.objects.get(regionId)
    if (!list) continue
    list.push([p.objectId, p.shape, p.rotation, p.x % SIZE, p.y % SIZE, 0] as LocEntry)
    result.report.placements++
  }

  result.report.unresolved = [...missing]
  if (missing.size) {
    result.report.warnings.push(
      `${missing.size} species had no match in this cache and were skipped or substituted: ${[...missing].join(', ')}`,
    )
  }
  return result
}
