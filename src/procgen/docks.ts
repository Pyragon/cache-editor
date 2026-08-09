/**
 * DOCKS — mined from the real map, then built.
 *
 * "No docks on an island fishing village" is the oldest surviving fault in
 * `docs/map-learning.md` §1, and it survived because a pier had never been
 * measured as a STRUCTURE. §4 measured waterside OBJECTS by name, which is how
 * `fishing_ledge` got shipped and then pulled again (§12a): 185 placements,
 * 100% on the ground, every statistical test passed, and it is dock trim
 * authored to sit on a deck that was not there.
 *
 * §15 is the structural measurement this module implements. The findings that
 * shape every decision here:
 *
 * - **A pier is LOCS OVER WATER, not terrain.** The deck is type-22 ground
 *   decoration laid straight onto sea tiles; the terrain underneath is
 *   untouched. So building one writes placements and nothing else — no
 *   heights, no overlays, no tile flags.
 * - **A deck plank is a ground decoration that OBSTRUCTS THE GROUND.** Not "one
 *   that is lifted": only the Port Sarim family carries an `offsetY`, and the
 *   commonest decks in the cache sit at 0 and hold their height in the model.
 *   Filtering on the lift found 4 ids and 14 docks in the whole map.
 * - **71% of piers are 1-2 tiles wide**, long side p50 11.
 * - **A dock STYLE is a FAMILY of ids** (p50 2 per pier, only 24% single-id),
 *   and the ids within one are POSITIONAL — some are ~100% edge pieces.
 * - **43% of piers carry no trim at all.**
 *
 * Most dock parts are UNNAMED (`name: "null"`), which is why none of this can
 * go through `scenery.ts`'s name-substring vocabulary. The dock vocabulary is
 * carried by ID, mined per cache, exactly like the canopy map.
 */

import type { DockSpec } from './types'

/**
 * Overlays with the underwater ("um") layer authored beneath them, i.e. water.
 * Measured over all 2,413 regions: **112 alone is 1,406,704 tiles at 94.8%
 * underwater-height presence and 96% of all water in the cache**; the rest are
 * the icy and foul variants and cost nothing to carry.
 *
 * NOT the renderer's `isWaterMaterial` (`mapScene.ts`), which is a hue test on
 * the texture used to decide what to ANIMATE — it does not select 112 at all
 * and finds 9 overlays covering a rounding error of the map. And not the def's
 * `waterColor`, which is written unconditionally: 235 of 247 overlays carry the
 * identical default.
 */
export const WATER_OVERLAYS = new Set([112, 215, 200, 169, 85, 138, 196, 216, 231, 6, 114, 235, 129, 214, 189])

/** Outward directions, in the order an edge tile is tested. */
export const OUT_DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]

/**
 * One deck object, and where the map puts it.
 *
 * `edgeRot` is rotation counted against the tile's OUTWARD EDGE NORMAL, not
 * against the world — 16 counts, `dir * 4 + rotation`. Storing a bare rotation
 * histogram would let the generator reproduce the map's MIX of rotations while
 * orienting every piece at random, which is worse than useless for edge trim
 * that has to face outward. Measured relative to the normal, it can be replayed
 * correctly on a pier pointing any way.
 */
export type DockPart = {
  id: number
  n: number
  /** placements on a tile with at least one non-deck 4-neighbour */
  edge: number
  /** [outDir * 4 + rotation] for edge placements */
  edgeRot: number[]
  /** [rotation] for interior placements */
  innerRot: number[]
}

/** The set of deck ids that co-occur in one real pier — a dock STYLE. */
export type DockFamily = { ids: number[]; piers: number; tiles: number }

export type DockTrim = {
  id: number
  shape: number
  n: number
  edge: number
  piers: number
  edgeRot: number[]
}

export type DockModel = {
  fingerprint: string
  builtAt: number
  /** shore-attached piers the mine found */
  piers: number
  /** share of piers carrying no trim at all — measured 0.43 */
  bareRate: number
  /** one walkway width per pier, for sampling */
  widths: number[]
  /** one long-side length per pier, for sampling */
  lengths: number[]
  families: DockFamily[]
  parts: Record<number, DockPart>
  trim: DockTrim[]
}

export function emptyDockModel(fingerprint: string): DockModel {
  return {
    fingerprint, builtAt: Date.now(), piers: 0, bareRate: 0,
    widths: [], lengths: [], families: [], parts: {}, trim: [],
  }
}

const SIZE = 64
const MIN_DECK_TILES = 3
/** Never grow the stored model without bound — a cache has tens of styles. */
const MAX_FAMILIES = 24
const MAX_TRIM = 24

const part = (m: DockModel, id: number): DockPart => {
  let p = m.parts[id]
  if (!p) m.parts[id] = (p = { id, n: 0, edge: 0, edgeRot: new Array(16).fill(0), innerRot: [0, 0, 0, 0] })
  return p
}

/**
 * Extract this region's piers and fold them into the model.
 *
 * Called from the scan that already reads every region for the frequency prior
 * and the context model — reading 2,413 region files is the expensive part of
 * indexing, and a separate walk to learn a third thing about the same bytes
 * would be the wrong trade (the same reasoning as the context model in §12).
 *
 * `overlay` is the plane-0 slice of `overlayIds`; `objects` is the raw
 * placement rows `[id, shape, rotation, x, y, plane]`.
 */
export function observeDocks(
  model: DockModel,
  deckIds: Set<number>,
  overlay: Uint8Array,
  objects: number[][],
) {
  const deck = new Uint8Array(SIZE * SIZE)
  const water = new Uint8Array(SIZE * SIZE)
  const at = new Map<number, number[][]>()
  for (let i = 0; i < SIZE * SIZE; i++) if (WATER_OVERLAYS.has(overlay[i])) water[i] = 1
  let anyDeck = false
  for (const o of objects) {
    const x = o[3], y = o[4]
    if (o[5] !== 0 || x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
    const i = x * SIZE + y
    let l = at.get(i)
    if (!l) at.set(i, (l = []))
    l.push(o)
    if (deckIds.has(o[0])) { deck[i] = 1; anyDeck = true }
  }
  if (!anyDeck) return

  const seen = new Uint8Array(SIZE * SIZE)
  for (let s = 0; s < SIZE * SIZE; s++) {
    if (!deck[s] || seen[s]) continue
    const comp: number[] = [s]
    seen[s] = 1
    const stack = [s]
    let border = false
    while (stack.length) {
      const j = stack.pop()!
      const x = (j / SIZE) | 0, y = j % SIZE
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) border = true
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        const k = nx * SIZE + ny
        if (deck[k] && !seen[k]) { seen[k] = 1; comp.push(k); stack.push(k) }
      }
    }
    if (comp.length < MIN_DECK_TILES || border) continue
    if (!comp.some((j) => water[j])) continue
    const set = new Set(comp)

    // Shore contact separates a PIER from a moored vessel. A hulk is a deck
    // over water too — the two largest structures the first measurement found
    // were a hull carrying a Figurehead and one carrying a Ship's wheel — and
    // without the split the geometry describes boats.
    let shore = false
    for (const j of comp) {
      const x = (j / SIZE) | 0, y = j % SIZE
      for (const [dx, dy] of OUT_DIRS) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        const k = nx * SIZE + ny
        if (!set.has(k) && !water[k]) { shore = true; break }
      }
      if (shore) break
    }
    if (!shore) continue

    // walkway width: median contiguous run along the narrower axis. A bounding
    // box calls a T-headed pier 14 wide; what matters is that you walk down it
    // two abreast.
    const runs = (byRow: boolean) => {
      const out: number[] = []
      for (let a = 0; a < SIZE; a++) {
        let run = 0
        for (let b = 0; b < SIZE; b++) {
          if (set.has(byRow ? a * SIZE + b : b * SIZE + a)) run++
          else { if (run) out.push(run); run = 0 }
        }
        if (run) out.push(run)
      }
      out.sort((p, q) => p - q)
      return out.length ? out[out.length >> 1] : 1
    }
    let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1
    for (const j of comp) {
      const x = (j / SIZE) | 0, y = j % SIZE
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }

    const ids = new Set<number>()
    /** trim keys seen anywhere on THIS pier, so `piers` counts piers not planks */
    const trimHere = new Set<DockTrim>()
    let carried = 0
    for (const j of comp) {
      const x = (j / SIZE) | 0, y = j % SIZE
      // outward normal = the first non-deck 4-neighbour, in OUT_DIRS order.
      // Corners have two; taking the first CONSISTENTLY is what makes the
      // measurement replayable, since the emitter resolves them the same way.
      let outDir = -1
      for (let d = 0; d < 4; d++) {
        const nx = x + OUT_DIRS[d][0], ny = y + OUT_DIRS[d][1]
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || !set.has(nx * SIZE + ny)) { outDir = d; break }
      }
      for (const o of at.get(j) ?? []) {
        const id = o[0], shape = o[1], rot = o[2] & 3
        if (deckIds.has(id)) {
          ids.add(id)
          const p = part(model, id)
          p.n++
          if (outDir >= 0) { p.edge++; p.edgeRot[outDir * 4 + rot]++ } else p.innerRot[rot]++
          continue
        }
        carried++
        let t = model.trim.find((e) => e.id === id && e.shape === shape)
        if (!t) model.trim.push(t = { id, shape, n: 0, edge: 0, piers: 0, edgeRot: new Array(16).fill(0) })
        t.n++
        if (outDir >= 0) { t.edge++; t.edgeRot[outDir * 4 + rot]++ }
        trimHere.add(t)
      }
    }
    for (const t of trimHere) t.piers++

    model.piers++
    if (!carried) model.bareRate++
    model.widths.push(Math.min(runs(true), runs(false)))
    model.lengths.push(Math.max(maxX - minX + 1, maxY - minY + 1))
    const key = [...ids].sort((a, b) => a - b)
    const fam = model.families.find((e) => e.ids.length === key.length && e.ids.every((v, i) => v === key[i]))
    if (fam) { fam.piers++; fam.tiles += comp.length }
    else model.families.push({ ids: key, piers: 1, tiles: comp.length })
  }
}

/** Rank, prune and turn running counts into rates. Call once after the scan. */
export function finaliseDocks(model: DockModel) {
  model.bareRate = model.piers ? model.bareRate / model.piers : 0
  model.families.sort((a, b) => b.piers - a.piers || b.tiles - a.tiles)
  model.families = model.families.slice(0, MAX_FAMILIES)
  model.trim.sort((a, b) => b.piers - a.piers || b.n - a.n)
  model.trim = model.trim.slice(0, MAX_TRIM)
  // keep only the parts still reachable from a surviving family
  const keep = new Set(model.families.flatMap((f) => f.ids))
  const parts: Record<number, DockPart> = {}
  for (const id of keep) if (model.parts[id]) parts[id] = model.parts[id]
  model.parts = parts
}

// ---------------------------------------------------------------------------
// Generation side
// ---------------------------------------------------------------------------

const pickFrom = <T>(items: T[], weight: (t: T) => number, rnd: () => number): T | null => {
  let total = 0
  for (const it of items) total += Math.max(0, weight(it))
  if (total <= 0) return null
  let r = rnd() * total
  for (const it of items) { r -= Math.max(0, weight(it)); if (r <= 0) return it }
  return items[items.length - 1]
}

/** A dock style, weighted by how many real piers were built from it. */
export function pickDockFamily(model: DockModel | null, rnd: () => number): DockFamily | null {
  if (!model?.families.length) return null
  return pickFrom(model.families, (f) => f.piers, rnd)
}

/**
 * Sample a measured walkway width.
 *
 * FILTERS the outliers rather than clamping them. The mined widths run 1..24
 * (the wide values are harbour quays and jetty heads), and clamping turned
 * every one of those into a 4 — so a distribution that is 71% one-or-two tiles
 * started producing 4-wide rafts. Discarding them keeps the shape of the
 * measurement instead of piling its tail onto the boundary.
 */
export function sampleWidth(model: DockModel | null, rnd: () => number, want?: number): number {
  if (want !== undefined) return Math.max(1, Math.min(4, Math.round(want)))
  const usable = model?.widths.filter((w) => w >= 1 && w <= MAX_WALKWAY) ?? []
  if (!usable.length) return 2
  return usable[Math.floor(rnd() * usable.length)]
}

/** Above this a "pier" is a quay or a harbour deck, not a walkway (§15). */
export const MAX_WALKWAY = 4

/** Sample a measured pier length. */
export function sampleLength(model: DockModel | null, rnd: () => number, want?: number): number {
  if (want !== undefined) return Math.max(3, Math.min(40, Math.round(want)))
  if (!model?.lengths.length) return 11
  return Math.max(3, Math.min(40, model.lengths[Math.floor(rnd() * model.lengths.length)]))
}

/**
 * Which deck piece belongs on this tile, and facing which way.
 *
 * Edge affinity is the whole point: some ids in a family are ~100% edge pieces
 * and one (18863) is 14%, so tiling a family at random produces a pier with its
 * capping in the middle. Weighting by the measured edge rate reproduces the
 * arrangement without needing to know what any piece looks like.
 */
export function pickDeckPiece(
  model: DockModel | null, family: DockFamily | null,
  edge: boolean, outDir: number, rnd: () => number,
): { id: number; rotation: number } | null {
  if (!model || !family?.ids.length) return null
  const parts = family.ids.map((id) => model.parts[id]).filter(Boolean)
  if (!parts.length) return null
  const chosen = pickFrom(parts, (p) => {
    const rate = p.n ? p.edge / p.n : 0
    // + a floor, so a family whose members are all edge-ish can still fill an
    // interior rather than emitting nothing
    return p.n * ((edge ? rate : 1 - rate) + 0.05)
  }, rnd) ?? parts[0]

  // rotation, measured against the outward normal so it replays on a pier
  // pointing any way
  let rot = 0
  if (edge && outDir >= 0) {
    const slice = chosen.edgeRot.slice(outDir * 4, outDir * 4 + 4)
    const picked = pickFrom([0, 1, 2, 3], (r) => slice[r], rnd)
    if (picked !== null) rot = picked
    else {
      // never observed on this side; fall back to the piece's overall mix
      const any = pickFrom([0, 1, 2, 3], (r) => chosen.edgeRot[r] + chosen.edgeRot[4 + r]
        + chosen.edgeRot[8 + r] + chosen.edgeRot[12 + r] + chosen.innerRot[r], rnd)
      rot = any ?? 0
    }
  } else {
    rot = pickFrom([0, 1, 2, 3], (r) => chosen.innerRot[r], rnd) ?? 0
  }
  return { id: chosen.id, rotation: rot }
}

/** A trim piece for an edge tile, or null to leave it bare. */
export function pickDockTrim(
  model: DockModel | null, outDir: number, rnd: () => number,
): { id: number; shape: number; rotation: number } | null {
  if (!model?.trim.length) return null
  const t = pickFrom(model.trim, (e) => e.piers * (e.n ? e.edge / e.n : 0), rnd)
  if (!t) return null
  const slice = t.edgeRot.slice(Math.max(0, outDir) * 4, Math.max(0, outDir) * 4 + 4)
  const rot = pickFrom([0, 1, 2, 3], (r) => slice[r], rnd)
    ?? pickFrom([0, 1, 2, 3], (r) => t.edgeRot[r] + t.edgeRot[4 + r] + t.edgeRot[8 + r] + t.edgeRot[12 + r], rnd)
    ?? 0
  return { id: t.id, shape: t.shape, rotation: rot }
}

/** Everything the emitter needs about one planned jetty. */
export type DockLayout = {
  /** deck tiles, as field indices */
  tiles: number[]
  /** the land tile the pier joins, as a field index */
  anchor: number
  /** outward direction index into OUT_DIRS */
  dir: number
  spec: DockSpec
}
