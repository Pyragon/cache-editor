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
import { chooseScenery, type SceneryIndex } from './scenery'
import {
  OUT_DIRS, pickDeckPiece, pickDockFamily, pickDockTrim, sampleLength, sampleWidth,
  type DockLayout,
} from './docks'
import {
  BUILDING_PURPOSES, pickTemplate, type BuildingPurpose, type TemplateModel,
} from './templates'
import type { BuildingModel } from './buildings'
import type { BuildingSpec } from './types'
import {
  CORNER_ROT, EDGE_DX, EDGE_DY, STRAIGHT_ROT,
  pickDoorId, pickFloorPatch, pickFurniture, pickWallDecor,
  pickWallFamily, pickWallId,
  sampleFootprint, SHAPE_CORNER, SHAPE_STRAIGHT,
} from './buildings'
import type { ContextModel, TileContext } from './context'
import type {
  GenerationResult, GroundBand, ProcPlan, ScatterRule, SceneryChoice, SpeciesId, SpeciesPick, Zone,
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
  /** dock decking, so scatter and the ground paint leave it alone */
  isDeck: Uint8Array
  /** tiles from the nearest land, for water only; 0 on land */
  waterDist: Uint16Array
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
  const form = t.landform ?? 'inland'
  const shaped = form === 'coast' || form === 'island'
  const ang = ((t.coastAngle ?? 0) * Math.PI) / 180
  const sx = Math.cos(ang), sy = Math.sin(ang)
  const halfW = f.w / 2, halfH = f.h / 2
  const reach = Math.max(halfW, halfH)

  /**
   * How much LAND there should be here, 1 inland to 0 out at sea.
   *
   * This is the whole difference between "there is some water" and "this is an
   * island". `waterLevel` alone is a percentile of fractal noise, and fractal
   * basins are scattered, so it yields ponds wherever the noise happens to dip
   * — never a coherent shore, and never a landmass with sea all round it.
   */
  /**
   * `waterLevel` slides the shoreline for a shaped landform.
   *
   * It cannot do that as a height threshold, which is what it is for `inland`.
   * Every tile beyond the mask ends up at `norm` 0 (the mask drives `unit`
   * negative and it clamps), so `norm <= waterLevel` selects exactly the same
   * tiles for any level >= 0. Measured on one island seed: **52.0% sea at
   * waterLevel 0.14 and 53.3% at 0.34** — a dial the plan exposes, the panel
   * documents, and that did nothing.
   *
   * So for `coast`/`island` it moves the MASK instead. 0.34 reproduces the
   * original window exactly, which keeps every existing theme unchanged; below
   * that the landmass grows, above it shrinks. The constant is measured, not
   * guessed — see `docs/procgen.md`.
   */
  const shift = (0.34 - (t.waterLevel ?? 0.34)) * 1.1
  const landMask = (x: number, y: number): number => {
    if (form === 'coast') {
      // signed distance along the sea direction, -1 (open sea) to 1 (inland).
      // Less water pushes the shore seaward, so the window moves DOWN.
      const proj = ((x - halfW) * sx + (y - halfH) * sy) / reach
      return smoothstep(-0.9 - shift, 0.2 - shift, proj)
    }
    // island: radial, on the ellipse of the area so a non-square area still
    // gets an island rather than a stripe. Less water = a wider landmass.
    const r = Math.hypot((x - halfW) / halfW, (y - halfH) / halfH)
    return 1 - smoothstep(0.62 + shift, 1.15 + shift, r)
  }

  let min = Infinity
  let max = -Infinity
  const unitField = shaped ? new Float32Array(f.w * f.h) : null
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const n = warpedFbm(plan.seed, x / scale, y / scale, t.warp ?? 0.5, {
        octaves: 3 + Math.round((t.roughness ?? 0.5) * 3),
        gain: 0.45 + (t.roughness ?? 0.5) * 0.15,
        ridged: t.ridged,
      })
      // ridged fbm is already 0..1; plain fbm is -1..1
      let unit = t.ridged ? n : (n + 1) / 2
      const i = idx(f, x, y)
      if (shaped) {
        const m = landMask(x, y)
        // The noise stays in play so the shoreline WANDERS: a mask alone would
        // give a ruled coast or a perfect circle, which is its own tell.
        unit = unit * (0.35 + 0.65 * m) - (1 - m) * 0.6
        unitField![i] = unit
        unit = Math.max(0, unit)
      }
      const v = base + unit * t.amplitude
      f.height[i] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (shaped) {
    // Absolute, not stretched to the area's own range: with a landform the
    // water level has to mean the same depth on every seed, or the sea covers
    // 3% of one island and 25% of the next.
    for (let i = 0; i < f.norm.length; i++) {
      f.norm[i] = Math.max(0, Math.min(1, unitField![i]))
    }
  } else {
    const span = Math.max(1, max - min)
    for (let i = 0; i < f.height.length; i++) f.norm[i] = (f.height[i] - min) / span
  }
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
    // A ZONE IS DRY LAND. None of this used to know about water, so a coastal
    // village flattened the seabed into a shelf (the skirt reaches 10 tiles
    // OUTSIDE the zone, so further than the circle), claimed sea tiles as
    // village, and then `paintGround` painted its dark town earth straight over
    // the beach band — the shoreline simply disappeared under a flat dark slab.
    // Excluding water here fixes all three at once, because the flatten, the
    // zone mask and the path paving all read from it.
    if (zone.flatten && zone.flatten > 0) {
      let sum = 0
      let n = 0
      for (let x = 0; x < f.w; x++) {
        for (let y = 0; y < f.h; y++) {
          if (!zoneContains(zone, x, y)) continue
          if (f.isWater[idx(f, x, y)]) continue
          sum += f.height[idx(f, x, y)]
          n++
        }
      }
      if (n > 0) {
        // Mean over LAND only. With the sea included, a village that half
        // overlaps the shore averages toward sea level and sinks itself.
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
            if (f.isWater[i]) continue
            f.height[i] = f.height[i] + (target - f.height[i]) * w
          }
        }
      }
    }
    let wet = 0
    for (let x = 0; x < f.w; x++) {
      for (let y = 0; y < f.h; y++) {
        if (!zoneContains(zone, x, y)) continue
        if (f.isWater[idx(f, x, y)]) { wet++; continue }
        f.zoneAt[idx(f, x, y)] = zi + 1
        tiles++
      }
    }
    // Worth saying out loud: a zone mostly in the sea is a plan that placed it
    // badly, and the symptom (a small village) is not obviously that.
    if (wet > tiles) {
      result.report.warnings.push(
        `zone "${zone.id}" is mostly water (${wet} sea tiles vs ${tiles} land) — it was clipped to the land, so it is smaller than the plan asked for`,
      )
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

    // --- name the notable buildings, LARGEST PLOT FIRST.
    //
    // A church needs the room and a village's civic buildings sit on its best
    // ground, so handing purposes out in plot order would put the bank in
    // whatever 5x5 corner happened to be reserved first and then fail to find a
    // template that fits it. Anything past the end of the list keeps whatever
    // `spec.purpose` was, which is usually nothing — and that is what makes the
    // rest of the settlement houses rather than a row of banks.
    const named = spec.purposes ?? []
    if (named.length) {
      const mine = result.report.plots.filter((p) => p.zoneId === zone.id)
      mine.sort((a, b) => b.w * b.h - a.w * a.h)
      for (let i = 0; i < named.length && i < mine.length; i++) mine[i].purpose = named[i]
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
    // 8-connected. With only four moves the cheapest route between two points
    // is a staircase of right angles no matter what the cost field says — the
    // router simply has no way to express "head north-east". Diagonals cost
    // their true length so a straight run is still preferred over a zigzag.
    for (const [dx, dy] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inBounds(f, nx, ny)) continue
      const ni = idx(f, nx, ny)
      if (seen[ni]) continue
      const diag = dx !== 0 && dy !== 0
      const climb = Math.abs(f.height[ni] - f.height[cur])
      // water is crossable but expensive; a bridge is a prefab problem
      // Water is priced as a last resort rather than banned outright, so a
      // narrow inlet can still be crossed like a causeway when there is no way
      // round — but never merely because the sea is flatter than the hill. At
      // 12 it was cheaper than a modest climb; the mask was also empty at this
      // point until `markWaterLevel` was moved ahead of routing.
      // Reserved plots are expensive, not impossible. The router had no plot
      // term at all, so a road ran straight through a building's footprint and
      // the house was stamped on top of it. It stays crossable because a plot
      // can sit across the only corridor and a village with no through-route is
      // worse than one with a lane past a wall.
      let step = (diag ? 1.414 : 1) + climb * 0.9
        + (f.isWater[ni] ? 200 : 0) + (f.isPlot[ni] ? 60 : 0)
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

/**
 * Which of a tile's four corners an overlay shape covers, per `MapLoader`'s
 * own table (mirrored from `mapScene`'s OVERLAY_SHAPE_COVERS). Row = shape,
 * column = vertex id 0-7; a rotation maps a corner to `(corner + 2*rot) & 7`.
 */
const SHAPE_COVERS: boolean[][] = [
  [true, true, true, true, true, true, true, true],
  [true, true, true, false, false, false, true, true],
  [true, false, false, false, false, true, true, true],
  [false, false, true, true, true, true, false, false],
  [true, true, true, true, true, true, false, false],
  [true, true, true, false, false, true, true, true],
  [true, true, false, false, false, true, true, true],
  [true, true, false, false, false, false, false, true],
  [false, true, true, true, true, true, true, true],
  [true, false, false, false, true, true, true, true],
  [true, true, true, true, true, false, false, false],
  [true, true, true, false, false, false, false, false],
]

/** corner ids in position space: 0=SW, 2=SE, 4=NE, 6=NW */
const CORNERS = [0, 2, 4, 6] as const

/**
 * corner-set bitmask (bit i = CORNERS[i] is covered) -> the (shape, rotation)
 * that draws exactly it. Built once; 0 and 15 are handled by the caller.
 */
const SHAPE_FOR_MASK: (number | null)[] = (() => {
  const out: (number | null)[] = new Array(16).fill(null)
  // prefer LOW shape ids and low rotations for stability, and skip shape 0
  // (full tile) so it never wins a partial mask
  for (let shape = 11; shape >= 1; shape--) {
    for (let rot = 3; rot >= 0; rot--) {
      let mask = 0
      for (let c = 0; c < 4; c++) {
        if (SHAPE_COVERS[shape]?.[(CORNERS[c] + 2 * rot) & 0x7]) mask |= 1 << c
      }
      if (mask !== 0 && mask !== 15) out[mask] = (shape << 2) | rot
    }
  }
  return out
})()

/**
 * Round the corners of a PAVED road.
 *
 * A route is a chain of tiles, and painting each as a full-tile overlay keeps
 * every bend square. The real map paints only 57% of its path tiles full; the
 * rest are diagonal halves and quarters, and that is what rounds a corner.
 *
 * Two things this deliberately does NOT do, both learned the hard way:
 *
 * - It never adds overlay to a tile that had none. An earlier version filled
 *   the inside of a bend with a quarter-tile of paving, which on an unpaved
 *   country track — underlay only, no overlay anywhere — stamped isolated grey
 *   diamonds along a dirt road. And once routing went 8-connected almost every
 *   step became diagonal, so that condition fired at nearly every neighbouring
 *   tile and drew a chequerboard rather than the odd rounded corner.
 * - It leaves underlay-only tracks alone entirely. Tile shapes belong to
 *   overlays; an underlay is always a full tile, so a track's curve has to come
 *   from the route, which is what the diagonal routing is for.
 */
function shapePathCorners(f: Field, spec: ProcPlan['paths']) {
  if (!spec || spec.overlayId === undefined) return
  const was = Uint8Array.from(f.isPath)
  const at = (x: number, y: number) => (inBounds(f, x, y) ? was[idx(f, x, y)] : 0)
  // corner c sits between these two orthogonal neighbours
  const NB: readonly (readonly [number, number, number, number])[] = [
    [-1, 0, 0, -1], // SW: W and S
    [1, 0, 0, -1],  // SE: E and S
    [1, 0, 0, 1],   // NE: E and N
    [-1, 0, 0, 1],  // NW: W and N
  ]
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const i = idx(f, x, y)
      // paved tiles only — an unpaved track has no overlay to shape
      if (!was[i] || !f.overlay[i]) continue
      let mask = 0
      for (let c = 0; c < 4; c++) {
        const [ax, ay, bx, by] = NB[c]
        // keep the corner unless BOTH its edge neighbours are off the path
        if (at(x + ax, y + ay) || at(x + bx, y + by)) mask |= 1 << c
      }
      if (mask === 15 || mask === 0) continue
      const sr = SHAPE_FOR_MASK[mask]
      if (sr != null) f.shapeRot[i] = sr
    }
  }
}

function paintPaths(
  plan: ProcPlan, f: Field, rnd: () => number, result: GenerationResult,
  /** foot-of-the-jetty tiles that must end up connected to the network */
  dockAnchors: number[] = [],
): number[][] {
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
    // A portal must be on LAND. On an east-facing coast the whole of side 1 is
    // open sea, and aiming a route at it sent the road out into the water —
    // which no cost function can undo, because the goal itself was wet. Retry
    // along the side, and if a side has no dry point at all, drop it: an island
    // simply has fewer ways out than a plain does.
    const portal = (side: number) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const t = 0.15 + rnd() * 0.7 // never right at a corner
        const p = side === 0 ? { x: Math.round((f.w - 1) * t), y: 1 }
          : side === 1 ? { x: f.w - 2, y: Math.round((f.h - 1) * t) }
            : side === 2 ? { x: Math.round((f.w - 1) * t), y: f.h - 2 }
              : { x: 1, y: Math.round((f.h - 1) * t) }
        if (!f.isWater[idx(f, p.x, p.y)]) return p
      }
      return null
    }
    const portals = sides.slice(0, zones.length ? 2 : 3)
      .map(portal)
      .filter((p): p is { x: number; y: number } => p !== null)
    if (portals.length) {
      anchors.unshift(portals[0])
      anchors.push(...portals.slice(1))
    }
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
          // The ROUTE avoids water; its WIDTH did not. A road runs dry along
          // the shore and then paints two to four tiles across, and the spill
          // lands in the sea — where the water overlay covers the paving but
          // leaves the path's bare underlay showing as a stair-step of brown
          // triangles. Small, and only near a coastline, which is why it
          // survived the routing fix and only reappeared once `branches` put
          // more road along the shore.
          if (f.isWater[pi]) continue
          f.isPath[pi] = 1
          // Paved only where the traffic is. `settled` is a property of the
          // whole PLAN, so keying the surface off it paved every track in the
          // area the moment one village existed — a dirt road through a wood
          // came out as tarmac. This is the same per-tile zone test the width
          // already uses.
          const paved = f.zoneAt[pi] > 0
          const under = paved ? spec.underlayId : spec.openUnderlayId ?? spec.underlayId
          if (under !== undefined) f.underlay[pi] = materialByte(under)
          f.overlay[pi] = paved && spec.overlayId !== undefined ? materialByte(spec.overlayId) : 0
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
        // Do not swim. The spur targeting already refuses to AIM at a water
        // tile, but this BFS used to flood straight through the sea, so the
        // "furthest dry land from the network" could be a headland across an
        // inlet — and the spur then had to cross to reach it. Leaving water at
        // -1 also leaves anything only reachable THROUGH water at -1, so such
        // a target is never chosen in the first place.
        if (f.isWater[ni]) continue
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
      for (const [dx, dy] of [
        [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as const) {
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

  // --- a lane down to each jetty. The generic spur targeting aims at whatever
  // is furthest from the network, which reaches a shore anchor only by luck, so
  // docks get an explicit one. Without it a fishing village has piers standing
  // off an untouched beach.
  for (const anchor of dockAnchors) {
    const axx = Math.floor(anchor / f.h)
    const ayy = anchor % f.h
    let near = -1
    let nearD = Infinity
    for (let i = 0; i < f.isPath.length; i++) {
      if (!f.isPath[i]) continue
      const d = Math.hypot(Math.floor(i / f.h) - axx, (i % f.h) - ayy)
      if (d < nearD) { nearD = d; near = i }
    }
    if (near < 0 || nearD < 2) continue
    // no `avoid` field: that one exists to push a LOOP away from the route it
    // branches off, and a lane to the shore is a short straight errand
    const lane = routePath(
      f, { x: axx, y: ayy },
      { x: Math.floor(near / f.h), y: near % f.h },
      wander, wanderStrength, null,
    )
    if (lane.length >= 2) {
      routes.push(lane)
      paint(lane, spurWidth, spurWidth)
    }
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

  shapePathCorners(f, spec)
  computeSlopes(f)
  return routes
}

// ---------------------------------------------------------------------------
// 3b. Docks
// ---------------------------------------------------------------------------

/**
 * Lay jetties out over the water — BEFORE the paths run, so a road can be sent
 * to each one. A pier nobody can walk to is scenery, not a dock.
 *
 * Everything dimensional here is sampled from the mined model (§15) rather than
 * chosen: walkway width (71% of real piers are 1-2 tiles) and length (p50 11).
 * The plan may override, and mostly should not.
 *
 * The deck starts at the FIRST WATER TILE, not at the anchor. Two reasons: 43%
 * of real piers sit entirely over water so the apron is small, and leaving the
 * land tile clear is what lets the path reach the foot of the pier.
 */
function planDocks(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  result: GenerationResult,
): DockLayout[] {
  const specs = plan.docks ?? []
  if (!specs.length) return []
  const dm = index?.docks ?? null
  if (!dm?.families.length) {
    if (specs.length) result.report.warnings.push(
      'docks: the cache index carries no dock vocabulary, so no jetties were built '
      + '(rebuild the scenery index against a cache whose maps folder is readable)',
    )
    return []
  }
  const zones = plan.zones ?? []
  const layouts: DockLayout[] = []

  for (const spec of specs) {
    const count = Math.max(0, Math.min(8, Math.round(spec.count)))
    const zone = spec.nearZoneId ? zones.find((z) => z.id === spec.nearZoneId) : undefined
    for (let n = 0; n < count; n++) {
      const width = sampleWidth(dm, rnd, spec.width)
      const length = sampleLength(dm, rnd, spec.length)

      // --- pick a shore anchor: dry, free, with open water in front of it
      let bestScore = 0
      let bestAnchor = -1
      let bestDir = -1
      for (let x = 0; x < f.w; x++) {
        for (let y = 0; y < f.h; y++) {
          const i = idx(f, x, y)
          if (f.isWater[i] || f.occupied[i] || f.isPlot[i] || f.isDeck[i]) continue
          if (zone && zoneEdgeDistance(zone, x, y) > (spec.length ?? 24)) continue
          for (let d = 0; d < 4; d++) {
            const [dx, dy] = OUT_DIRS[d]
            if (!inBounds(f, x + dx, y + dy) || !f.isWater[idx(f, x + dx, y + dy)]) continue
            // how much open water lies straight ahead, and how clear the
            // sides are — a jetty wants a channel, not a puddle
            let ahead = 0
            for (let t = 1; t <= length; t++) {
              const nx = x + dx * t, ny = y + dy * t
              if (!inBounds(f, nx, ny)) break
              const ni = idx(f, nx, ny)
              if (!f.isWater[ni] || f.isDeck[ni]) break
              ahead++
            }
            if (ahead < 3) continue
            // keep jetties apart, so a harbour reads as several piers rather
            // than one raft
            let clearance = 1
            for (const l of layouts) {
              const lx = Math.floor(l.anchor / f.h), ly = l.anchor % f.h
              const dist = Math.hypot(x - lx, y - ly)
              if (dist < 6) { clearance = 0; break }
              clearance = Math.min(clearance, dist / 20)
            }
            const score = ahead * clearance + rnd() * 2
            if (score > bestScore) { bestScore = score; bestAnchor = i; bestDir = d }
          }
        }
      }
      if (bestAnchor < 0) break

      // --- walk out
      const ax = Math.floor(bestAnchor / f.h), ay = bestAnchor % f.h
      const [dx, dy] = OUT_DIRS[bestDir]
      const px = -dy, py = dx
      const headChance = spec.headChance ?? 0.25
      const wantHead = rnd() < headChance
      const tiles: number[] = []
      const seen = new Set<number>()
      let reach = 0
      for (let t = 1; t <= length; t++) {
        const nearEnd = t >= length - 1
        const w = wantHead && nearEnd ? width + 2 : width
        const row: number[] = []
        let ok = true
        let anyWater = false
        for (let k = 0; k < w; k++) {
          const off = k - ((w - 1) >> 1)
          const tx = ax + dx * t + px * off
          const ty = ay + dy * t + py * off
          if (!inBounds(f, tx, ty)) { ok = false; break }
          const ti = idx(f, tx, ty)
          if (f.occupied[ti] || f.isPlot[ti] || f.isDeck[ti]) { ok = false; break }
          if (f.isWater[ti]) anyWater = true
          row.push(ti)
        }
        // Reaching dry land on the far side would make this a BRIDGE, and §15
        // explicitly did not measure bridges — they are a different structure
        // with land at both ends. Stop at the water's edge instead.
        if (!ok || !anyWater) break
        for (const ti of row) if (!seen.has(ti)) { seen.add(ti); tiles.push(ti) }
        reach = t
      }
      // A jetty is longer than it is wide — §15 puts the long side at p50 11
      // against a short side of 4. Without this, a walk that runs out of water
      // after three tiles leaves a 4x4 raft bolted to the beach.
      if (tiles.length < 3 || reach < 3 || reach < width) break

      for (const ti of tiles) { f.isDeck[ti] = 1; f.occupied[ti] = 1 }
      layouts.push({ tiles, anchor: bestAnchor, dir: bestDir, spec })
      result.report.docks.push({
        x: ax, y: ay, dir: bestDir, tiles: tiles.length, length: reach, width,
      })
    }
  }
  return layouts
}

/**
 * Emit the deck itself, then whatever trim the map says it should carry, then
 * whatever cargo the PLAN asked to stand on it.
 *
 * The two clutter layers are deliberately different in kind and must not be
 * merged. Trim is mined by id, positional, and rotated against the outward
 * normal — it reproduces the map. `deckClutter` is named by the plan, because
 * the mined vocabulary has no crate in it and `scatter` cannot reach a deck
 * tile (`isDeck` exists to keep it out). One tile takes one or the other.
 */
function runDocks(
  layouts: DockLayout[], index: SceneryIndex | null, rnd: () => number, out: Placement[],
  result: GenerationResult, f: Field, missing: Set<SpeciesId>,
) {
  const dm = index?.docks ?? null
  if (!dm || !layouts.length) return
  for (const layout of layouts) {
    const family = pickDockFamily(dm, rnd)
    if (!family) continue
    const set = new Set(layout.tiles)
    // Cargo is budgeted per PIER, against that pier's own tile count, so a
    // short jetty gets a crate and a long one gets a few — a flat per-tile
    // chance would load the long piers and leave the short ones bare.
    const cargo = layout.spec.deckClutter
    let cargoLeft = cargo
      ? Math.round((layout.tiles.length / 100) * (cargo.density ?? 12))
      : 0
    // 43% of real piers carry NOTHING. Rolling it per PIER rather than per tile
    // is the difference between "some docks are bare" and "every dock is
    // half-dressed", and the measurement is about piers.
    const bare = rnd() < (layout.spec.trim !== undefined ? 1 - layout.spec.trim : dm.bareRate)
    const trimRate = layout.spec.trim ?? 0.18
    for (let k = 0; k < layout.tiles.length; k++) {
      const ti = layout.tiles[k]
      /** deck tiles still to come, this one included — the cargo denominator */
      const tilesLeft = layout.tiles.length - k
      const x = Math.floor(ti / f.h), y = ti % f.h
      // outward normal: the first non-deck 4-neighbour, in the SAME order the
      // mine used. That correspondence is the contract — measured against one
      // convention and replayed against another puts every edge piece askew.
      let outDir = -1
      for (let d = 0; d < 4; d++) {
        const nx = x + OUT_DIRS[d][0], ny = y + OUT_DIRS[d][1]
        if (!inBounds(f, nx, ny) || !set.has(idx(f, nx, ny))) { outDir = d; break }
      }
      const piece = pickDeckPiece(dm, family, outDir >= 0, outDir, rnd)
      if (!piece) continue
      out.push({ x, y, objectId: piece.id, shape: 22, rotation: piece.rotation })

      // The map's own dressing has first claim on the tile: it is POSITIONAL —
      // an edge piece rotated against the outward normal — so it cannot be
      // moved elsewhere, whereas a crate can stand anywhere on the deck.
      if (!bare && outDir >= 0 && rnd() <= trimRate) {
        const t = pickDockTrim(dm, outDir, rnd)
        if (t) {
          out.push({ x, y, objectId: t.id, shape: t.shape, rotation: t.rotation })
          continue
        }
      }

      // ...then the plan's cargo, spread over whatever deck is still clear.
      // Rolling against the tiles REMAINING rather than a flat chance is what
      // stops the whole allowance landing on the shoreward end of the pier.
      if (cargo && cargoLeft > 0 && rnd() < cargoLeft / tilesLeft) {
        const id = pickScenery(index, cargo, rnd, missing)
        // null means nothing in the cargo list resolves against this cache;
        // stop asking rather than burning the allowance a tile at a time.
        if (id === null) cargoLeft = 0
        else {
          out.push({ x, y, objectId: id, shape: 10, rotation: Math.floor(rnd() * 4) })
          cargoLeft--
        }
      }
    }
  }
  result.report.placements += 0 // counted by the caller with everything else
}

// ---------------------------------------------------------------------------
// 3c. Buildings
// ---------------------------------------------------------------------------

/**
 * Stamp a measured building onto a plot.
 *
 * The GEOMETRY is the map's — every wall loc keeps the shape and rotation the
 * real building had, so corners, jambs and door frames are whatever RuneScape
 * actually authored rather than whatever a rule reconstructed. Only the
 * MATERIAL is substituted, and only where the chosen family has a member
 * authored for that shape; a wall with no substitute keeps its original id,
 * because a hole in the wall is worse than a mismatched panel.
 *
 * Doors are never substituted. A door is the one loc whose identity carries
 * behaviour, and swapping it for a wall panel seals the building.
 */
function stampTemplate(
  plan: ProcPlan, f: Field, tm: TemplateModel, bm: BuildingModel | null,
  spec: BuildingSpec, plot: { x: number; y: number; w: number; h: number; purpose?: string },
  rnd: () => number, out: Placement[], result: GenerationResult,
  model: ContextModel | null,
): boolean {
  // The plot's own purpose wins: it was assigned per plot so a village can have
  // one church and six houses. `spec.purpose` is the blanket fallback.
  // Only a REAL purpose counts. `plots.purpose` predates building purposes and
  // is a free-text label — the shipped plan says "building", which is not a
  // kind of building, so every plot was asking for something that cannot exist,
  // failing, and taking the fallback path with a warning attached.
  const asked = plot.purpose ?? spec.purpose
  const want = BUILDING_PURPOSES.includes(asked as BuildingPurpose)
    ? (asked as BuildingPurpose)
    : undefined
  const ringCtxEarly = plotRingContext(f, plot)
  let t = pickTemplate(tm, want, plot.w, plot.h, rnd, model, ringCtxEarly)
  if (!t && want) {
    // Asked for a church and nothing of that kind fits this plot. Say so —
    // silently building a cottage where the plan asked for a church is the
    // kind of quiet substitution that is impossible to notice in a screenshot.
    result.report.warnings.push(
      `plot at (${plot.x},${plot.y}) asked for a "${want}" but no mined template of that `
      + `kind fits ${plot.w}x${plot.h} — built whatever fits instead. Give the plot a `
      + 'bigger maxSize if you want the real thing.',
    )
    t = pickTemplate(tm, undefined, plot.w, plot.h, rnd, model, ringCtxEarly)
  }
  if (!t) return false

  const ox = plot.x + Math.floor((plot.w - t.w) / 2)
  const oy = plot.y + Math.floor((plot.h - t.h) / 2)

  // every tile the building occupies, walls included, so it can be levelled
  const cover = new Set<number>()
  for (const i of t.tiles) {
    const x = ox + Math.floor(i / t.h), y = oy + (i % t.h)
    if (!inBounds(f, x, y)) return false
    cover.add(idx(f, x, y))
  }
  for (const wl of t.walls) {
    const x = ox + wl.x, y = oy + wl.y
    if (inBounds(f, x, y)) cover.add(idx(f, x, y))
  }
  if (!cover.size) return false

  // level it: a stamped building on a slope has its walls half buried
  let sum = 0
  for (const i of cover) sum += f.height[i]
  const level = sum / cover.size
  for (const i of cover) { f.height[i] = level; f.occupied[i] = 1 }

  const family = pickWallFamily(bm, rnd, model, ringCtxEarly)
  const doorSet = new Set((bm?.doors ?? []).map((d: { id: number }) => d.id))

  // --- walls, AS THE MAP BUILT THEM.
  //
  // Material substitution is off by default, and removing it fixed more than it
  // ever bought. Two faults, both invisible in a placement count:
  //
  // 1. It UNDID the context scoring. `pickTemplate` weighs a template by its
  //    own wall ids to find one that belongs on this ground — and then this
  //    threw those ids away and repainted the building in a family chosen
  //    separately. What you saw was never what was scored.
  // 2. It repainted EVERY wall-shaped loc, not just the shell. A fireplace
  //    surround, a banister and a railing are all shapes 0-3, so an interior
  //    hearth came out clad in exterior wall panels — Cody's "our fire in the
  //    middle gained corners", both it and the walls being object 23795, the
  //    substituted material.
  //
  // A real building already has walls that suit it. The job of choosing one
  // that suits the AREA belongs to selection, where the evidence is.
  let walls = 0
  for (const wl of t.walls) {
    const x = ox + wl.x, y = oy + wl.y
    if (!inBounds(f, x, y)) continue
    let id = wl.id
    if (spec.restyle && !wl.door && !doorSet.has(wl.id)) {
      const sub = pickWallId(bm, family, wl.shape, rnd, (i) => doorSet.has(i))
      if (sub !== null) id = sub
    }
    out.push({ x, y, objectId: id, shape: wl.shape, rotation: wl.rotation })
    walls++
  }

  // --- the interior is the building's OWN contents, replayed verbatim.
  //
  // NOT the furniture scatter. Running that over a stamped interior is what
  // produced four ladders in a 5x5 cottage, six chairs and seven stools around
  // a three-tile table, a well and a campfire indoors, and single decal locs
  // that are one tenth of a rug. The whole point of a template is that the map
  // already decided what is in this room; rolling dice on top of it throws
  // away the one thing we came here for.
  //
  // It also fixes what no scatter could: a bed is multi-tile and needs the
  // position and rotation the map gave it, a rug is several locs that only read
  // as a rug together, and a bank's booths belong in the bank.
  let furniture = 0
  for (const c of t.contents) {
    const x = ox + c.x, y = oy + c.y
    if (!inBounds(f, x, y)) continue
    out.push({ x, y, objectId: c.id, shape: c.shape, rotation: c.rotation })
    furniture++
  }

  result.report.buildings.push({
    x: ox, y: oy, w: t.w, h: t.h, walls, interior: t.tiles.length, furniture,
    purpose: t.purpose, from: t.from,
  })
  void plan
  return true
}

/**
 * A `TileContext` describing the COUNTRY a plot sits in, sampled from a ring
 * just outside it rather than from the plot itself.
 *
 * The plot is a paved pad, so its own material says "gravel" wherever in the
 * world it is. `observeBuildings` profiles every family against the same ring
 * around the real buildings it mined, so both sides of the comparison are
 * measuring the same thing.
 *
 * The underlay/overlay reported are the ring's MODAL values — a single
 * representative tile rather than a blend, because `TileContext` describes one
 * tile and the context model bins it as one.
 */
function plotRingContext(
  f: Field, plot: { x: number; y: number; w: number; h: number },
): TileContext {
  const RING = 3
  const under = new Map<number, number>()
  const over = new Map<number, number>()
  let hSum = 0, sSum = 0, n = 0
  for (let x = plot.x - RING; x < plot.x + plot.w + RING; x++) {
    for (let y = plot.y - RING; y < plot.y + plot.h + RING; y++) {
      if (x >= plot.x && x < plot.x + plot.w && y >= plot.y && y < plot.y + plot.h) continue
      if (!inBounds(f, x, y)) continue
      const i = idx(f, x, y)
      const u = f.underlay[i]
      if (u) under.set(u, (under.get(u) ?? 0) + 1)
      const o = f.overlay[i]
      over.set(o, (over.get(o) ?? 0) + 1)
      hSum += f.height[i]
      sSum += f.slope[i]
      n++
    }
  }
  const modal = (m: Map<number, number>): number => {
    let best = 0, bestN = -1
    for (const [v, c] of m) if (c > bestN) { bestN = c; best = v }
    return best
  }
  return {
    underlay: modal(under),
    overlay: modal(over),
    height: Math.round(n ? hSum / n : 0),
    slope: Math.round(n ? sSum / n : 0),
    // A building tile is by definition beside a wall. Saying otherwise would
    // score every wall id against the "open ground" bin it is never seen in.
    wall: 1,
  }
}

/**
 * Synthesise a building on each reserved plot: massing, walls, a door, furniture.
 *
 * Nothing here copies a layout — the massing is sampled from §14's measured
 * footprint vocabulary, the walls from a mined material family, the furniture
 * from §6's wall-distance distributions. Cody asked three times for buildings
 * deduced from the corpus rather than stamped from prefabs.
 *
 * Wall placement rests on the rotation semantics measured 2026-08-09 (see
 * `buildings.ts`): shape 0's rotation IS the exposed edge (0=+x, 1=-y, 2=-x,
 * 3=+y), and a shape-1 corner at rotation r covers edges r and (r+1)&3.
 */
function runBuildings(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], result: GenerationResult, model: ContextModel | null,
) {
  const specs = plan.buildings ?? []
  if (!specs.length) return
  const bm = index?.buildings ?? null
  const tm = index?.templates ?? null
  if (!bm?.families.length) {
    result.report.warnings.push(
      'buildings: the cache index carries no wall vocabulary, so the plots were left empty '
      + '(rebuild the scenery index against a cache whose maps folder is readable)',
    )
    return
  }

  for (const spec of specs) {
    const plots = result.report.plots.filter((p) => !spec.zoneId || p.zoneId === spec.zoneId)
    const fill = Math.max(0, Math.min(1, spec.fill ?? 1))
    for (const plot of plots) {
      if (rnd() > fill) continue
      // leave a tile of margin so a building never touches the plot edge, which
      // is where the path runs up to it
      // --- PREFAB: replay a real building, with this area's masonry ---------
      if ((spec.mode ?? 'prefab') === 'prefab' && tm?.templates.length) {
        const stamped = stampTemplate(
          plan, f, tm, bm, spec, plot, rnd, out, result, model,
        )
        if (stamped) continue
        // no template fits this plot — fall through and synthesise rather than
        // leaving the plot bare
      }

      const rects = sampleFootprint(rnd, Math.max(3, plot.w - 1), Math.max(3, plot.h - 1))
      if (!rects) continue
      // The country around the plot, NOT the plot itself — the pad is paved, so
      // its own material says "gravel" wherever in the world it is. This is the
      // same ring `observeBuildings` profiles each family against.
      const ringCtx = plotRingContext(f, plot)
      const family = pickWallFamily(bm, rnd, model, ringCtx)
      if (!family) continue

      let bw = 0, bh = 0
      for (const r of rects) { bw = Math.max(bw, r.x + r.w); bh = Math.max(bh, r.y + r.h) }
      const ox = plot.x + Math.floor((plot.w - bw) / 2)
      const oy = plot.y + Math.floor((plot.h - bh) / 2)

      const foot = new Set<number>()
      for (const r of rects) {
        for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) {
          const wx = ox + x, wy = oy + y
          if (!inBounds(f, wx, wy)) { foot.clear(); break }
          foot.add(idx(f, wx, wy))
        }
      }
      if (!foot.size) continue

      // level the ground under the whole footprint: a building on a slope has
      // its walls half-buried at one end, and the plot pad only levelled the
      // rectangle the plot reserved
      let sum = 0
      for (const i of foot) sum += f.height[i]
      const level = sum / foot.size
      for (const i of foot) { f.height[i] = level; f.occupied[i] = 1 }

      // --- perimeter: which edges of each footprint tile face outside?
      type WallTile = { i: number; x: number; y: number; edges: number[] }
      const perimeter: WallTile[] = []
      for (const i of foot) {
        const x = Math.floor(i / f.h), y = i % f.h
        const edges: number[] = []
        for (let e = 0; e < 4; e++) {
          const nx = x + EDGE_DX[e], ny = y + EDGE_DY[e]
          if (!inBounds(f, nx, ny) || !foot.has(idx(f, nx, ny))) edges.push(e)
        }
        if (edges.length) perimeter.push({ i, x, y, edges })
      }
      if (perimeter.length < 4) continue

      // --- the door goes on the side nearest a path, so the building faces the
      // road rather than presenting a blank wall to it. Reachability is not
      // probabilistic here: exactly one perimeter tile is chosen and it always
      // becomes a door.
      // Only a STRAIGHT wall tile can be a door. A corner tile is drawn as one
      // shape-1 loc covering both its edges, so hanging a door on it emitted a
      // corner and no door at all — which is how two of six buildings came out
      // sealed. Reachability has to be guaranteed, not probable (§6).
      const doorCandidates = perimeter.filter((t) => t.edges.length === 1)
      let doorTile = doorCandidates[0] ?? perimeter[0]
      let doorScore = Infinity
      for (const t of doorCandidates) {
        let best = Infinity
        for (let r = 1; r <= 6 && best === Infinity; r++) {
          for (let dx = -r; dx <= r && best === Infinity; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
              const nx = t.x + dx, ny = t.y + dy
              if (!inBounds(f, nx, ny)) continue
              if (f.isPath[idx(f, nx, ny)]) { best = r; break }
            }
          }
        }
        const score = best + rnd()
        if (score < doorScore) { doorScore = score; doorTile = t }
      }
      const doorId = pickDoorId(bm, rnd, family, model, ringCtx)

      // Doors are family MEMBERS (the key is every wall id in the building), so
      // they must be kept out of the ordinary panel picker or they get used as
      // walls. The one door is placed deliberately, below.
      const doorSet = new Set((bm.doors ?? []).map((d) => d.id))
      const notADoor = (id: number) => doorSet.has(id)

      let wallCount = 0
      let skipped = 0
      for (const t of perimeter) {
        // A tile with two exposed edges that meet is a corner, and the client
        // seals that with ONE shape-2 whole corner. Shape 1 is a diagonal post
        // that blocks nothing cardinal — see SHAPE_CORNER.
        if (t.edges.length === 2) {
          const [a, b] = t.edges
          const rot = CORNER_ROT[Math.min(a, b) * 4 + Math.max(a, b)]
          if (rot !== undefined) {
            const id = pickWallId(bm, family, SHAPE_CORNER, rnd, notADoor)
            if (id !== null) {
              out.push({ x: t.x, y: t.y, objectId: id, shape: SHAPE_CORNER, rotation: rot })
              wallCount++
            } else skipped++
            continue
          }
          // two OPPOSITE edges (a one-tile-thick spur) is not a corner; fall
          // through and seal each side with its own straight panel
        }
        for (const e of t.edges) {
          const isDoor = t === doorTile && doorId !== null && e === t.edges[0]
          const id = isDoor ? doorId : pickWallId(bm, family, SHAPE_STRAIGHT, rnd, notADoor)
          if (id === null) { skipped++; continue }
          // STRAIGHT_ROT, not `e`. `e` is the spelling authored from the tile on
          // the far side of the edge, so it drew every wall against the wrong
          // face and the ring came out offset by a tile.
          out.push({ x: t.x, y: t.y, objectId: id, shape: SHAPE_STRAIGHT, rotation: STRAIGHT_ROT[e] })
          wallCount++
        }
      }

      // --- interior
      //
      // Furniture was disabled while the wall vocabulary was wrong, because a
      // furnished interior made it impossible to tell whether a stray object
      // had been chosen as a wall or as a furnishing. It is back now that the
      // mined list is CLASSIFIED (`buildings.ts` `FurnitureClass`): roofs are
      // excluded, floor decals are their own class, and ranking is by distinct
      // buildings rather than raw placements — which is what used to put
      // "Potato" and "Wheat" at the top of the list.
      //
      // PURPOSE FIXTURES ARE NOT PLACED. A bank booth or an altar states what a
      // building is, and no plot carries a purpose yet, so `pickFurniture` and
      // friends filter them out entirely. They are mined and classified,
      // waiting for labelled plots.
      // THE WHOLE FOOTPRINT IS THE INTERIOR.
      //
      // A wall sits on a tile EDGE, so a perimeter tile is a room tile that
      // happens to have a wall on one side — it is not consumed by it. Removing
      // the perimeter left a 5x5 building with a 3x3 room and a 4x3 with a 2x1,
      // which is why every generated house was something two people could stand
      // in. This is the identical tile-versus-edge error that `observeBuildings`
      // had on the mining side: it was fixed there and left standing here, so
      // the detector and the builder disagreed about what a building even is.
      const interior = [...foot]
      const furnishRate = spec.furnish ?? 0.22
      let furniture = 0
      for (const i of interior) {
        const x = Math.floor(i / f.h), y = i % f.h
        // distance to the nearest tile carrying a wall — 0 ON a perimeter tile,
        // which is the same measure `observeBuildings` records
        let dist = 9
        for (const t of perimeter) {
          const d = Math.abs(t.x - x) + Math.abs(t.y - y)
          if (d < dist) dist = d
          if (!dist) break
        }
        // A floor patch shares the tile with whatever stands on it, so it is
        // rolled separately rather than competing for the tile. Measured at 71%
        // of buildings but only ~19% interior coverage, hence the low rate.
        if (rnd() < 0.12) {
          const patch = pickFloorPatch(bm, rnd)
          if (patch) {
            out.push({ x, y, objectId: patch.id, shape: patch.shape, rotation: Math.floor(rnd() * 4) })
          }
        }
        if (rnd() > furnishRate) continue
        // Against a wall, some of what the map puts there is MOUNTED on it.
        const piece = dist === 0 && rnd() < 0.35
          ? pickWallDecor(bm, rnd)
          : pickFurniture(bm, dist, rnd)
        if (!piece) continue
        out.push({ x, y, objectId: piece.id, shape: piece.shape, rotation: Math.floor(rnd() * 4) })
        f.occupied[i] = 1
        furniture++
      }

      // A gap in the perimeter is a hole in the building, and it is invisible
      // in a placement count — say so rather than shipping a wall with a
      // missing panel.
      if (skipped) {
        result.report.warnings.push(
          `a building at (${ox},${oy}) is missing ${skipped} wall piece(s): its material family `
          + 'has no member authored for the shape that edge needs',
        )
      }
      result.report.buildings.push({
        x: ox, y: oy, w: bw, h: bh, walls: wallCount, interior: interior.length, furniture,
      })
    }
  }
  computeSlopes(f)
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
        // paths are painted BEFORE the ground bands and carry their own
        // underlay now (a country track IS its underlay), so the bands must
        // not paint over them
        if (pick && !f.isPath[i]) f.underlay[i] = materialByte(pick.underlayId)
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
  // A band can paint the water overlay on tiles the water LEVEL never marked
  // (its own maxHeight is a separate test), and those tiles then had no
  // riverbed and rendered invisible. Anything wearing the water overlay is
  // water — for the seabed, and for scatter avoidance.
  const waterOverlayByte = (() => {
    const b = plan.ground.find((g) => g.overlayId !== undefined && g.maxHeight !== undefined)
    return b?.overlayId !== undefined ? materialByte(b.overlayId) : 0
  })()
  if (waterOverlayByte) {
    for (let i = 0; i < f.overlay.length; i++) if (f.overlay[i] === waterOverlayByte) f.isWater[i] = 1
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
    computeWaterDistance(f)
  }
}

/**
 * Mark sea from the height field alone, early enough for zones, plots and paths
 * to respect it.
 *
 * This is deliberately only the `waterLevel` half of the test. A ground band can
 * also paint the water overlay on its own `maxHeight`, but that is a
 * ground-painting decision and stays in `paintGround`; the doc's advice to tie
 * that band's `maxHeight` to `waterLevel` is what keeps the two agreeing.
 */
function markWaterLevel(plan: ProcPlan, f: Field) {
  const level = plan.terrain.waterLevel
  if (level === undefined) return
  for (let i = 0; i < f.norm.length; i++) if (f.norm[i] <= level) f.isWater[i] = 1
}

/**
 * Tiles from the nearest LAND, for every water tile (multi-source BFS off the
 * coastline). Drives the riverbed: real water is shallow at the shore and
 * deepens offshore, which is what makes the shader fade a beach to clear and
 * hold the open sea opaque.
 */
function computeWaterDistance(f: Field) {
  const n = f.w * f.h
  const q = new Int32Array(n)
  let qh = 0
  let qt = 0
  f.waterDist.fill(0)
  const seen = new Uint8Array(n)
  // sources: land tiles that touch water
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const i = idx(f, x, y)
      if (f.isWater[i]) continue
      seen[i] = 1
      q[qt++] = i
    }
  }
  while (qh < qt) {
    const cur = q[qh++]
    const cx = Math.floor(cur / f.h)
    const cy = cur % f.h
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inBounds(f, nx, ny)) continue
      const ni = idx(f, nx, ny)
      if (seen[ni]) continue
      seen[ni] = 1
      f.waterDist[ni] = Math.min(65535, f.waterDist[cur] + 1)
      q[qt++] = ni
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
  if (rule.avoidZoneIds?.length && f.zoneAt[i] > 0) {
    const here = zones[f.zoneAt[i] - 1]
    if (here && rule.avoidZoneIds.includes(here.id)) return false
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

/**
 * The tile as the CONTEXT MODEL sees it, in the cache's own units.
 *
 * `f.underlay`/`f.overlay` already hold material BYTES and `f.height`/`f.slope`
 * are in stored units, which is exactly what the scan measured off the dump —
 * so no conversion, and none should be introduced. `wall` is always 2: the
 * generator plants outdoors, and that is the honest answer rather than a
 * neutral one, since it steers selection away from furniture.
 */
function tileContext(f: Field, i: number): TileContext {
  return {
    underlay: f.underlay[i],
    overlay: f.overlay[i],
    height: Math.round(f.height[i]),
    slope: Math.round(f.slope[i]),
    wall: 2,
  }
}

/**
 * What to plant here.
 *
 * A thin wrapper over `chooseScenery`, which scores every offered species AND
 * every variant of each in one pass. The old shape of this function picked the
 * species from the plan's weights first and only then let context choose a
 * variant — so context could never veto the species itself. See the comment on
 * `chooseScenery` for why that mattered.
 */
function pickScenery(
  index: SceneryIndex | null,
  choice: SceneryChoice,
  rnd: () => number,
  missing: Set<SpeciesId>,
  /** what the real map plants where, and the tile we're planting on */
  model?: ContextModel | null,
  ctx?: TileContext | null,
): number | null {
  return chooseScenery(index, choice, rnd, model, ctx, missing)?.id ?? null
}

function runScatter(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>, model: ContextModel | null,
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
      const id = pickScenery(index, rule, rnd, missing, model, tileContext(f, idx(f, x, y)))
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
  out: Placement[], missing: Set<SpeciesId>, model: ContextModel | null,
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
        const id = pickScenery(index, ring, rnd, missing, model, tileContext(f, idx(f, x, y)))
        if (id === null) break
        out.push({ x, y, objectId: id, shape: 10, rotation: Math.floor(rnd() * 4) })
        f.occupied[i] = 1
      }
    }
  }
}

function runResources(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>, model: ContextModel | null,
) {
  const zones = plan.zones ?? []
  for (const node of plan.resources ?? []) {
    const zone = zones.find((z) => z.id === node.zoneId)
    if (!zone) continue
    const centre = zoneCentre(zone)
    const ccx = Math.max(0, Math.min(f.w - 1, Math.round(centre.x)))
    const ccy = Math.max(0, Math.min(f.h - 1, Math.round(centre.y)))
    const centreCtx = tileContext(f, idx(f, ccx, ccy))
    const radius = zone.shape.type === 'circle' ? zone.shape.radius : Math.max(zone.shape.w, zone.shape.h) / 2
    // sink the pit so it reads as excavated ground
    if (node.depth) {
      for (let x = 0; x < f.w; x++) {
        for (let y = 0; y < f.h; y++) {
          const d = zoneEdgeDistance(zone, x, y)
          if (d > 4) continue
          // Concentrate the drop at the RIM. Spreading it over half the zone
          // (-radius*0.5) turned a 22-unit dig across a 10-tile radius into a
          // ~14% grade — a shallow bowl you can walk over without noticing,
          // not an excavation. A short wall a few tiles wide reads as a pit,
          // and puts the ground steep enough that the slope bands paint stone
          // on it and the path router routes around it.
          const wall = Math.max(2.5, radius * 0.22)
          const w = 1 - smoothstep(-wall, 1.5, d)
          f.height[idx(f, x, y)] -= node.depth * w
        }
      }
      computeSlopes(f)
    }
    // Ore is not scattered — it is knotted. Measured over the 20 mining sites
    // in the live map (regions 40-55 x 46-57):
    //   the nearest rock of the SAME type is 1.4 tiles away (median) — they touch
    //   one type forms a compact blob ~4x5 tiles, aspect 1.2, filling ~25% of it
    //   the nearest OTHER type's blob centre is only 3.2 tiles away
    //   a site carries 13-19 rocks across 1-8 types, median 4 of each type
    //   about one rock in seven sits alone, away from any pocket of its own type
    // So the ore body is one tight cluster of type-segregated pockets, much
    // smaller than the pit around it, rather than an even fill of the zone.
    const POCKET_R = 2.4    // blob radius: ~5 tiles across, as measured
    const POCKET_GAP = 3.2  // measured distance between neighbouring pockets
    const LONE_SHARE = 0.15

    // One object id per ore type, resolved once, so a pocket is all one ore
    // instead of the per-rock weighted pick that produced the even mixture.
    // A plan may name the ore species outright, or just say `role: 'ore'` and
    // let the map decide what this ground carries. A role is sampled DOWN: a
    // real mining site runs 1-8 types with a median of 4 (measured above), so
    // handing it every seam in the game would produce a mine that reads as a
    // sampler rather than a place.
    let oreSpecies: SpeciesPick[]
    if (node.species?.length) {
      oreSpecies = node.species
    } else if (node.role) {
      const wantTypes = 2 + Math.floor(rnd() * 4) // 2-5, straddling the measured median
      const seen = new Set<SpeciesId>()
      oreSpecies = []
      for (let t = 0; t < wantTypes * 8 && oreSpecies.length < wantTypes; t++) {
        const p = chooseScenery(index, { role: node.role }, rnd, model, centreCtx, missing)
        if (!p || seen.has(p.species)) continue
        seen.add(p.species)
        oreSpecies.push({ species: p.species })
      }
    } else {
      continue
    }

    const kinds: { id: number; weight: number }[] = []
    for (const s of oreSpecies) {
      const weight = s.weight ?? 1
      if (weight <= 0) continue
      // one id per ore TYPE for the whole body, so the zone centre is the
      // right tile to ask about rather than any single rock's
      const id = pickScenery(index, { species: [{ species: s.species }] }, rnd, missing, model, centreCtx)
      if (id === null) continue
      kinds.push({ id, weight })
    }
    if (!kinds.length) continue

    // Split the budget by weight, handing the remainder out by largest
    // fractional part, then guarantee every named ore at least one rock —
    // the smallest real pocket is one rock, not none.
    const wsum = kinds.reduce((a, k) => a + k.weight, 0)
    const share = kinds.map((k) => (node.count * k.weight) / wsum)
    const counts = share.map((s) => Math.floor(s))
    const order = share.map((_, i) => i).sort((a, b) => (share[b] % 1) - (share[a] % 1))
    for (let left = node.count - counts.reduce((a, b) => a + b, 0), i = 0; left > 0; i++, left--) {
      counts[order[i % order.length]]++
    }
    for (let i = 0; i < counts.length; i++) if (counts[i] === 0) counts[i] = 1

    // Pocket centres on a small ring, sized so neighbours land the measured
    // gap apart — the ring, not the zone, is how wide the ore body reads.
    const ring = Math.min(radius * 0.55, (POCKET_GAP * kinds.length) / (2 * Math.PI) + 1)
    const spin = rnd() * Math.PI * 2

    for (let k = 0; k < kinds.length; k++) {
      const a = spin + (k / kinds.length) * Math.PI * 2
      const px = centre.x + Math.cos(a) * ring
      const py = centre.y + Math.sin(a) * ring
      for (let n = 0; n < counts[k]; n++) {
        // the first rock always anchors the pocket; later ones may wander off
        const lone = n > 0 && rnd() < LONE_SHARE
        const spread = lone ? radius : POCKET_R
        const ox = lone ? centre.x : px
        const oy = lone ? centre.y : py
        for (let attempt = 0; attempt < 40; attempt++) {
          const t = rnd() * Math.PI * 2
          // Widen slowly on repeated failure so a blocked pocket still lands.
          // Tried capping this and shrinking POCKET_R to keep strays closer:
          // both measured WORSE (more lone rocks, and the cap dropped a rock
          // per mine outright). A pocket that can spill is what fills.
          const r = Math.sqrt(rnd()) * spread * (1 + attempt * 0.05)
          const x = Math.round(ox + Math.cos(t) * r)
          const y = Math.round(oy + Math.sin(t) * r)
          if (!inBounds(f, x, y)) continue
          if (zoneEdgeDistance(zone, x, y) > 0) continue
          const i = idx(f, x, y)
          if (f.occupied[i] || f.isPath[i] || f.isWater[i]) continue
          out.push({ x, y, objectId: kinds[k].id, shape: 10, rotation: Math.floor(rnd() * 4) })
          // radius 0, not 1: real rocks sit orthogonally adjacent a quarter of
          // the time, and a 1-tile keep-out forces every gap to 1.4 tiles.
          markOccupied(f, x, y, 0)
          break
        }
      }
    }
  }
}

function runProps(
  plan: ProcPlan, f: Field, index: SceneryIndex | null, rnd: () => number,
  out: Placement[], missing: Set<SpeciesId>, model: ContextModel | null,
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
    const id = pickScenery(
      index,
      { role: prop.role, species: prop.species ? [{ species: prop.species }] : undefined },
      rnd, missing, model, tileContext(f, idx(f, x, y)),
    )
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
  model: ContextModel | null,
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
      const id = pickScenery(index, spec, rnd, missing, model, tileContext(f, pi))
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
export function generate(
  plan: ProcPlan, index: SceneryIndex | null, model: ContextModel | null = null,
): GenerationResult {
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
    isDeck: new Uint8Array(tiles),
    waterDist: new Uint16Array(tiles),
    occupied: new Uint8Array(tiles),
    zoneAt: new Uint16Array(tiles),
  }
  const result: GenerationResult = {
    terrain: new Map(),
    underwater: new Map(),
    objects: new Map(),
    environment: new Map(),
    report: {
      regions: regionsW * regionsH, placements: 0,
      zones: [], plots: [], docks: [], buildings: [], unresolved: [], warnings: [],
    },
  }
  const rnd = makeRng(plan.seed ^ 0x9e3779b9)
  const missing = new Set<SpeciesId>()

  // Riverbed materials. The plan speaks in ids, not roles, so take the sand
  // from its own shore band where it has one and fall back to the surveyed
  // defaults — a seabed is sand near the beach and stone out deep.
  const shoreBand = plan.ground.find((b) => b.overlayId !== undefined && b.maxHeight !== undefined)
  const sandRole = shoreBand?.underlay?.[0]?.underlayId ?? 61
  const trackRole = 64
  const stoneRole = 54

  buildHeights(plan, f)
  computeSlopes(f)
  // BEFORE zones, plots and paths — all three test `isWater` and all three ran
  // while it was still all zeroes, because only `paintGround` ever filled it in
  // and that runs later. The router's own water penalty was dead code, so a
  // coast plan routed roads out into the open sea, and plots could be reserved
  // on the seabed. The water LEVEL only needs the heightmap, so it can be known
  // here; the overlay-driven half still resolves during the ground paint.
  markWaterLevel(plan, f)
  applyZones(plan, f, result)
  placePlots(plan, f, rnd, result)
  // Docks are laid out BEFORE the paths so a road can be routed to the foot of
  // each jetty. A pier nobody can walk to is scenery; the locs themselves are
  // emitted later, with everything else.
  const docks = planDocks(plan, f, index, rnd, result)
  const routes = paintPaths(plan, f, rnd, result, docks.map((d) => d.anchor))
  paintGround(plan, f, rnd)

  const placements: Placement[] = []
  const lights: { x: number; y: number; colorHsl: number; size2d: number }[] = []
  // ORDER MATTERS. Everything marks occupancy, so the deliberate things go
  // down first and the filler fits around them — scatter last, or it takes the
  // verges the lamps need and the path ends up unlit.
  runDocks(docks, index, rnd, placements, result, f, missing)
  // Buildings before the filler for the usual reason: they claim occupancy, so
  // scatter fits around them instead of planting a tree in the parlour.
  runBuildings(plan, f, index, rnd, placements, result, model)
  runResources(plan, f, index, rnd, placements, missing, model)
  runProps(plan, f, index, rnd, placements, missing, model)
  runPathLighting(plan, f, routes, index, rnd, placements, missing, lights, model)
  runBarriers(plan, f, index, rnd, placements, missing, model)
  runScatter(plan, f, index, rnd, placements, missing, model)

  // heights changed after the ground paint (props/resources level things), so
  // recompute normalized height once more before quantizing
  for (let ri = 0; ri < regionsW * regionsH; ri++) {
    const rx = plan.area.x0 + (ri % regionsW)
    const ry = plan.area.y0 + Math.floor(ri / regionsW)
    const regionId = (rx << 8) | ry
    const terrain = emptyTerrain()
    const underwater = emptyTerrain()
    let anyWater = false
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

        // The riverbed under a water tile. `um` heights are stored POSITIVE
        // and mean downward depth (client `i_13*8 << 2`), so this is a depth,
        // not an elevation. Shallow at the shore and deepening offshore is
        // what the shader's `shore`/`depthFade` terms read — the surveyed real
        // map runs a median depth of 20 (Brimhaven) to 65 (Port Sarim).
        if (f.isWater[i]) {
          anyWater = true
          const depth = Math.max(1, Math.min(120, Math.round(4 + f.waterDist[i] * 6)))
          underwater.heightValue[ti] = depth
          underwater.heightPresence[ti >> 3] |= 1 << (ti & 0x7)
          // sandy close in, stone further out, matching what the real seabeds
          // use (bytes 55/65 = stone and brown earth)
          underwater.underlayIds[ti] = materialByte(
            f.waterDist[i] <= 3 ? sandRole : f.waterDist[i] <= 9 ? trackRole : stoneRole,
          )
        }
      }
    }
    result.terrain.set(regionId, terrain)
    if (anyWater) result.underwater.set(regionId, underwater)
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
    // Multi-part trees: the ground loc is only the bottom of a stack. An oak
    // is a trunk on plane 0 and a canopy on plane 1; a TROPICAL tree is three
    // locs — stump 1326, trunk 1327, crown 1328 — each with a different object
    // id. Emit only the ground part and you get a wood of bare poles. The real
    // map stacks them on the same tile with the same shape and rotation
    // (99.3% of 2,439 oak pairs), so each layer is a straight copy one plane up.
    const layers = index?.canopies?.[p.objectId]
    // Shape-check rather than trust: an index persisted by an older build held
    // a different shape here, which read as `undefined` and emitted locs with
    // no object — canopies vanished with no error anywhere. Skipping is the
    // right failure: bare trunks beat invisible nulls written into a region.
    if (Array.isArray(layers) && layers.length) {
      const lx = p.x % SIZE
      const ly = p.y % SIZE
      // Each layer also needs ITS plane at the right HEIGHT over this tile.
      // With no stored height the renderer puts a plane a full storey (960)
      // below the one under it — right for a tropical tree at every level, and
      // badly wrong for an oak, which stores byte 1 so plane 1 sits flush with
      // the ground and its canopy model carries its own height.
      //
      // The height must be written at the vertices the renderer actually
      // SAMPLES, and those depend on the loc's FOOTPRINT, not its tile:
      // `buildLocsMesh` averages four heights at
      //   x + (size>>1) and x + ((size+1)>>1)   (same for y)
      // so a 1x1 tropical layer samples x/x+1 but a 3x3 oak canopy samples
      // x+1/x+2. Writing the tile alone, or even a 2x2 block, left the big
      // ones reading the fallback — which is exactly why tropical (1x1) and
      // evergreen (2x2) looked right while oak and yew (3x3) floated ~720
      // units up. Heights live on a 65x65 VERTEX grid where vertex (gx,gy)
      // reads tile (gx,gy), hence writing TILES to move vertices.
      const targets: { t: MapTerrain; ti: number; lift: number }[] = []
      let reachable = true
      for (let i = 0; i < layers.length && reachable; i++) {
        const layer = layers[i]
        if (!(layer.id > 0)) { reachable = false; break }
        if (layer.lift < 0) continue
        const lo = layer.size >> 1
        const hi = (layer.size + 1) >> 1
        for (let dx = lo; dx <= hi && reachable; dx++) {
          for (let dy = lo; dy <= hi; dy++) {
            const ax = p.x + dx
            const ay = p.y + dy
            // a sampled tile can fall in the next region along, or outside the
            // generated area entirely when the tree sits on its outer edge
            const t = result.terrain.get(
              ((plan.area.x0 + Math.floor(ax / SIZE)) << 8) | (plan.area.y0 + Math.floor(ay / SIZE)),
            )
            if (!t) { reachable = false; break }
            targets.push({ t, ti: tileIndex(i + 1, ax % SIZE, ay % SIZE), lift: layer.lift })
          }
        }
      }
      // All or nothing, across the WHOLE stack. A tree on the area's outer
      // edge needs a vertex owned by a region we aren't generating, and a
      // partly-written height is the worst outcome: the average lands between
      // the two and floats the piece clear of the one below. A bare trunk
      // there is honest and barely noticeable.
      if (!reachable) continue
      for (const { t, ti, lift } of targets) {
        t.heightValue[ti] = lift
        t.heightPresence[ti >> 3] |= 1 << (ti & 0x7)
      }
      for (let i = 0; i < layers.length; i++) {
        list.push([layers[i].id, p.shape, p.rotation, lx, ly, i + 1] as LocEntry)
        result.report.canopies = (result.report.canopies ?? 0) + 1
      }
    }
  }

  result.report.unresolved = [...missing]
  if (missing.size) {
    result.report.warnings.push(
      `${missing.size} species had no match in this cache and were skipped or substituted: ${[...missing].join(', ')}`,
    )
  }
  return result
}
