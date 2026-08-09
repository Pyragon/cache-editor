/**
 * BUILDING SYNTHESIS — footprint, walls, a door, furniture.
 *
 * Cody asked three times for buildings DEDUCED from the corpus, never stamped
 * copies (`docs/map-learning.md` §1). Nothing here copies a layout: the massing
 * is sampled from the measured footprint vocabulary (§14), the walls come from a
 * mined material family, and the furniture is drawn from the measured
 * wall-distance distributions (§6).
 *
 * ## The two facts that make correct wall placement possible
 *
 * §8.5 listed "rotation remapping semantics" as an open unknown, and it was the
 * thing blocking this. Measured 2026-08-09 over the 311 PERFECTLY RECTANGULAR
 * buildings in the cache, where which side a wall tile is on is unambiguous:
 *
 * **Straight wall (shape 0): rotation IS the exposed edge.**
 *
 * | side | rot | share |
 * |---|---|---|
 * | E (+x) | 0 | 74% |
 * | S (-y) | 1 | 72% |
 * | W (-x) | 2 | 75% |
 * | N (+y) | 3 | 71% |
 *
 * The ~26% remainder is always the OPPOSITE rotation, which is the same wall
 * authored from the neighbouring tile — a wall sits on a tile EDGE, and either
 * of the two tiles sharing that edge can carry it. So this is one rule with two
 * spellings, not a 74% tendency.
 *
 * **Corner (shape 1): rotation r covers edges r and (r+1)&3.** All four corners
 * measured at 100%: ES→0, WS→1, NW→2, EN→3.
 *
 * An earlier attempt tried to reuse the trick that works for DOCK decking —
 * replaying a rotation histogram against the outward normal — and it measured
 * only 28-52% concentrated, which read as "walls are not positional". They are;
 * the proxy was wrong. It lumped interior partition walls (no outward normal at
 * all) in with perimeter walls. Restricting to unambiguous rectangle sides took
 * the same question from 40% to 100%.
 */

import type { BuildingSpec } from './types'
import { contextLikelihood, type ContextModel, type TileContext } from './context'

const SIZE = 64

/** Edge index convention, measured: 0 = +x, 1 = -y, 2 = -x, 3 = +y. */
export const EDGE_DX = [1, 0, -1, 0]
export const EDGE_DY = [0, -1, 0, 1]

export const WALL_SHAPES = new Set([0, 1, 2, 3, 9])
export const SHAPE_STRAIGHT = 0
/**
 * A corner that SEALS two sides is shape 2 (`WALL_WHOLE_CORNER`), not shape 1.
 *
 * Shape 1 is `WALL_DIAGONAL_CORNER` and the client's `ClipFlagMap.addWall`
 * blocks only a DIAGONAL for it — no cardinal edge at all. It is a decorative
 * corner post. Shape 2 is the one that blocks two cardinal edges, which is what
 * the corner of a room is.
 *
 * This module's header measured "a shape-1 corner at rotation r covers edges r
 * and (r+1)&3" at 100%, and that measurement was of which SIDE OF A RECTANGLE
 * the tile sat on — not of what the loc seals. Building with it emitted a
 * diagonal post where a corner belonged, which is why generated corners showed
 * as stray panels that meet nothing.
 */
export const SHAPE_CORNER = 2

/**
 * Rotation for a straight wall that must seal edge `e` of the tile it stands
 * on, with `e` indexed by EDGE_DX/EDGE_DY above (0=+x E, 1=-y S, 2=-x W, 3=+y N).
 *
 * From `ClipFlagMap.addWall`, shape 0: rot 0 blocks W, 1 blocks N, 2 blocks E,
 * 3 blocks S. Inverting that gives `e ^ 2` — a 180 degree flip.
 *
 * **The generator was emitting `rotation: e` directly.** That is the spelling
 * for a wall authored from the tile on the OTHER side of the edge, so every
 * wall was drawn against the wrong face and the ring came out offset by a tile,
 * with corners that do not meet. The module header even records that both
 * spellings occur in the map ("the same wall authored from the neighbouring
 * tile") — what it did not say is that you have to pick the one that matches
 * the tile you are placing on.
 */
export const STRAIGHT_ROT = [2, 3, 0, 1]

/**
 * Rotation for a whole corner (shape 2) sealing a pair of edges, keyed by
 * `min * 4 + max` of the two edge indices.
 *
 * From `ClipFlagMap.addWall` shape 2: rot 0 = N+W, 1 = N+E, 2 = E+S, 3 = S+W.
 */
export const CORNER_ROT: Record<number, number> = {
  11: 0, // W(2) + N(3) -> min*4+max = 2*4+3
  3: 1, //  E(0) + N(3) -> 0*4+3
  1: 2, //  E(0) + S(1) -> 0*4+1
  6: 3, //  S(1) + W(2) -> 1*4+2
}

/**
 * A set of wall ids that co-occur in one building — a masonry STYLE.
 *
 * `regions` is counted alongside `buildings` for the same reason doors count
 * it: one dungeon complex can contain dozens of buildings sharing one grim
 * stone family, and ranking on `buildings` alone lets that outvote a family
 * used by two houses in each of thirty towns. Selection weights on the two
 * together, so a style has to be both used and WIDESPREAD to become default.
 */
export type WallFamily = {
  ids: number[]
  buildings: number
  regions: number
  /**
   * Underlay byte → tiles, over every footprint this family was seen on.
   *
   * This is what stops a fishing village being built out of Ape Atoll. Family
   * choice used to be `pickFrom(families, f => f.buildings)` — no context at
   * all — so the vocabulary was global and a temperate green coast got bamboo
   * walls and the decaying masonry that only exists in dead places. Scenery has
   * had ground-conditioned selection since the context model landed, on the
   * measurement that **underlay is 34.5% of object identity** (§12); walls were
   * simply never given the same treatment.
   *
   * Recorded over the whole footprint (walls plus interior) rather than the
   * wall ring alone, because a wall tile's own underlay is often the building's
   * floor material rather than the country it stands in.
   */
  /**
   * Door id → times seen in a building of this family.
   *
   * Doors were picked from one global list, so a house could get a family it
   * never appears with — Cody's "doors also aren't matching the wall families".
   * A door is part of a masonry style, not an independent choice.
   */
  doors: Record<number, number>
}
export type WallPart = { id: number; n: number; shapes: Record<number, number> }
/**
 * What KIND of interior object this is, from the client's own shape groups
 * (`darkan-bot-refactor` `ObjectShapes.kt`, which is identification, not
 * drawing):
 *
 * | shapes | group | meaning |
 * |---|---|---|
 * | 0-3, 9 | wall | the building's shell |
 * | 4-8 | `wallDecor` | mounted ON a wall face |
 * | 10, 11 | `freestanding` | real furniture standing on the floor |
 * | 12-21 | — | **ROOFS**, excluded entirely |
 * | 22 | `floor` | ground decoration lying on the floor |
 *
 * The roof row is the reason this enum exists rather than "not a wall": the
 * old furniture pass swept shapes 12-21 in as furnishings, and 9 roof ids were
 * measured sitting on interior tiles across the surface. A roof stamped inside
 * a room is not a subtle bug.
 */
export type FurnitureClass = 'floor' | 'wallDecor' | 'freestanding'

/**
 * A building's PURPOSE, inferred from a fixture it contains.
 *
 * Cody's rule, and it is a hard one: a bank booth, an altar, an anvil or a
 * cooking range is not furniture. It states what the building IS, so scattering
 * one into an ordinary house is worse than leaving the house empty. These are
 * mined and classified, and deliberately NOT placed — they wait for plots that
 * carry a purpose, which the plan cannot express yet.
 */
export type FixtureRole =
  | 'bank' | 'altar' | 'forge' | 'kitchen' | 'pub' | 'church' | 'workshop' | 'store'

/**
 * Name patterns that mark an object as a purpose fixture. Name-driven so it
 * survives a re-dump, and deliberately narrow: a false positive here silently
 * removes something from the generic furniture pool.
 */
export const FIXTURE_PATTERNS: [FixtureRole, RegExp][] = [
  ['bank', /^(bank booth|bank chest|bank deposit|deposit box|bank table)/i],
  ['altar', /\baltar\b/i],
  ['forge', /^(anvil|furnace|forge)\b/i],
  ['kitchen', /^(range|stove|oven|sink|larder|shelves)\b/i],
  ['store', /^(stall|shop counter)/i],
  ['pub', /^(bar pumps|beer|keg)\b/i],
  ['church', /^(pew|lectern|organ)\b/i],
  ['workshop', /^(loom|spinning wheel|potter)/i],
]

/** The role a name implies, or null for ordinary furnishing. */
export function fixtureRoleOf(name: string | undefined): FixtureRole | null {
  if (!name) return null
  for (const [role, re] of FIXTURE_PATTERNS) if (re.test(name)) return role
  return null
}

/**
 * One interior object, as the map actually uses it.
 *
 * `buildings` — the number of DISTINCT buildings containing it — is what
 * ranking and selection use, never `n`. Measured on the surface: the commonest
 * floor decal has an enormous raw placement count because it repeats across a
 * floor, while a chair appears once or twice per room. Ranking on `n` put
 * decals at the top of the furniture list and was how "Potato" and "Wheat"
 * became the game's principal furnishings. This is the same distinct-container
 * lesson as `docks.ts` counting piers rather than planks.
 *
 * `d` is the Manhattan distance to the nearest wall-adjacent interior tile,
 * `d[0]` being "against a wall". Measured across 969 surface buildings:
 * **54% at 0, 21% at 1, 12% at 2, 5% at 3, 8% at 4+** — furniture hugs walls,
 * and sampling by distance reproduces that without anyone deciding where a
 * chest goes.
 */
export type Furniture = {
  id: number
  shape: number
  cls: FurnitureClass
  /** purpose fixture role, or null for ordinary furnishing */
  role: FixtureRole | null
  n: number
  buildings: number
  d: number[]
}

export type BuildingModel = {
  fingerprint: string
  builtAt: number
  buildings: number
  families: WallFamily[]
  parts: Record<number, WallPart>
  /**
   * Wall ids whose def offers an "Open" option — real doors.
   *
   * `regions` is the number of DISTINCT regions the door appears in, and it,
   * not `n`, is what selection weights on. Raw placement count answers "how
   * many of these exist", which is the wrong question: door 3626 is 1,459
   * placements in a SINGLE region, so weighting by `n` made a door that
   * appears nowhere else in the game the default door of every house. Distinct
   * regions answers "how widely does the map actually use this", which is what
   * a vocabulary wants. `docks.ts` already counts piers rather than planks for
   * exactly this reason.
   */
  doors: { id: number; n: number; regions: number }[]
  furniture: Furniture[]
  /** how many mined buildings showed each purpose, for labelled plots later */
  roles: Record<string, number>
}

export function emptyBuildingModel(fingerprint: string): BuildingModel {
  return {
    fingerprint, builtAt: Date.now(), buildings: 0,
    families: [], parts: {}, doors: [], furniture: [], roles: {},
  }
}

/** Tiles beyond the footprint that count as "the country this house is in". */
const GROUND_RING = 3

const MAX_FAMILIES = 24
const MAX_DOORS = 12
const MAX_FURNITURE = 90
/** kept per purpose, so a rare fixture is never crowded out by common ones */
const MAX_FIXTURES_PER_ROLE = 12

/**
 * Which cardinal edges a wall loc blocks, straight from the client.
 *
 * Source: `darkan-game-client` `ClipFlagMap.addWall`. This is collision, not
 * drawing, so it is the client's own table rather than anything inferred:
 *
 * | shape | what it blocks |
 * |---|---|
 * | 0 | ONE edge — rot 0=W, 1=N, 2=E, 3=S |
 * | 2 | TWO edges — rot 0=N+W, 1=N+E, 2=E+S, 3=S+W |
 * | 1, 3 | diagonal corners ONLY (NW/NE/SE/SW) — no cardinal edge at all |
 * | 9 | routed through `addObject`, so the whole TILE is solid |
 *
 * Directions here are 0=E(+x), 1=N(+y), 2=W(-x), 3=S(-y).
 */
const DIR_DX = [1, 0, -1, 0]
const DIR_DY = [0, 1, 0, -1]
const DIR_OPP = [2, 3, 0, 1]
const SHAPE0_EDGES: Record<number, number[]> = { 0: [2], 1: [1], 2: [0], 3: [3] }

/** Shape -> interior class, per `ObjectShapes.kt`. Null = not a furnishing. */
function classOfShape(shape: number): FurnitureClass | null {
  if (shape === 22) return 'floor'
  if (shape >= 4 && shape <= 8) return 'wallDecor'
  if (shape === 10 || shape === 11) return 'freestanding'
  return null // 12-21 are roofs; walls are handled elsewhere
}
const SHAPE2_EDGES: Record<number, number[]> = { 0: [1, 2], 1: [1, 0], 2: [0, 3], 3: [3, 2] }

/** An interior smaller than this is a nook, not a room. */
const MIN_INTERIOR = 2

/**
 * One region's walls, resolved to blocked EDGES and enclosed rooms.
 *
 * Factored out because two things now need it — the family/furniture mine and
 * the template extractor — and this session's most expensive bug by far was the
 * same tile-versus-edge logic living in two places and being fixed in only one.
 * There is exactly one flood; if it is wrong, everything is wrong together and
 * the round-trip rig (`scratchpad/rig/geometry.ts`) catches it.
 */
export type RoomScan = {
  /** bitmask of blocked directions per tile */
  blocked: Uint8Array
  /** whole-tile blockers (shape 9) */
  solid: Uint8Array
  outside: Uint8Array
  /** tile -> room index, -1 for outdoors or solid */
  roomOf: Int32Array
  rooms: number[][]
  /** tile -> the plane-0 locs standing on it */
  at: Map<number, number[][]>
  /** tile * 4 + dir -> the loc ids blocking that edge */
  blockers: Map<number, number[]>
}

export function scanRooms(objects: number[][]): RoomScan {
  const blocked = new Uint8Array(SIZE * SIZE)
  const solid = new Uint8Array(SIZE * SIZE)
  const blockers = new Map<number, number[]>()
  const at = new Map<number, number[][]>()

  const block = (x: number, y: number, d: number, id: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    const i = x * SIZE + y
    blocked[i] |= 1 << d
    let l = blockers.get(i * 4 + d)
    if (!l) blockers.set(i * 4 + d, (l = []))
    if (!l.includes(id)) l.push(id)
    // An edge is SHARED, so record it from both sides — the map authors walls
    // from either of the two tiles and both spellings must seal.
    const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return
    const ni = nx * SIZE + ny
    blocked[ni] |= 1 << DIR_OPP[d]
    let l2 = blockers.get(ni * 4 + DIR_OPP[d])
    if (!l2) blockers.set(ni * 4 + DIR_OPP[d], (l2 = []))
    if (!l2.includes(id)) l2.push(id)
  }

  for (const o of objects) {
    const id = o[0], shape = o[1], rot = o[2] & 3, x = o[3], y = o[4]
    if (o[5] !== 0 || x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
    const i = x * SIZE + y
    let l = at.get(i)
    if (!l) at.set(i, (l = []))
    l.push(o)
    if (!WALL_SHAPES.has(shape)) continue
    if (shape === 0) for (const d of SHAPE0_EDGES[rot]) block(x, y, d, id)
    else if (shape === 2) for (const d of SHAPE2_EDGES[rot]) block(x, y, d, id)
    else if (shape === 9) solid[i] = 1
    // shapes 1 and 3 block only diagonals, so they seal nothing cardinal
  }

  const outside = new Uint8Array(SIZE * SIZE)
  const st: number[] = []
  const seed = (x: number, y: number) => {
    const i = x * SIZE + y
    if (outside[i] || solid[i]) return
    outside[i] = 1
    st.push(i)
  }
  for (let n = 0; n < SIZE; n++) { seed(0, n); seed(SIZE - 1, n); seed(n, 0); seed(n, SIZE - 1) }
  while (st.length) {
    const i = st.pop()!
    const x = (i / SIZE) | 0, y = i % SIZE
    for (let d = 0; d < 4; d++) {
      if (blocked[i] & (1 << d)) continue
      const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
      const k = nx * SIZE + ny
      if (outside[k] || solid[k]) continue
      outside[k] = 1
      st.push(k)
    }
  }

  const roomOf = new Int32Array(SIZE * SIZE).fill(-1)
  const rooms: number[][] = []
  for (let s = 0; s < SIZE * SIZE; s++) {
    if (outside[s] || solid[s] || roomOf[s] >= 0) continue
    const id = rooms.length
    const tiles = [s]
    roomOf[s] = id
    const stack = [s]
    while (stack.length) {
      const i = stack.pop()!
      const x = (i / SIZE) | 0, y = i % SIZE
      for (let d = 0; d < 4; d++) {
        if (blocked[i] & (1 << d)) continue
        const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        const k = nx * SIZE + ny
        if (outside[k] || solid[k] || roomOf[k] >= 0) continue
        roomOf[k] = id
        tiles.push(k)
        stack.push(k)
      }
    }
    rooms.push(tiles)
  }
  return { blocked, solid, outside, roomOf, rooms, at, blockers }
}

export const SCAN_SIZE = SIZE

/**
 * Pull this region's buildings and fold them into the model.
 *
 * ## Why this is an EDGE flood, not a tile flood
 *
 * The previous version marked a whole TILE solid if any wall-shaped loc stood
 * on it, then flooded between tiles. That looks conservative and is in fact
 * destructive, because **a wall occupies a tile edge, not a tile**: a small
 * house is nothing but perimeter, so sealing its tiles consumed the very
 * interior the detector was looking for, and the building was discarded as
 * "encloses nothing".
 *
 * Measured over the 379 surface regions that carry objects:
 *
 * | | tile flood | edge flood |
 * |---|---|---|
 * | candidates discarded, interior vanished | **2,024 (59%)** | 0 |
 * | BUILDINGS FOUND | 387 | **969** |
 * | wall ids per building (p50) | 1 | **5** |
 *
 * The id count matters as much as the building count: single-id "families"
 * were an artefact of this bug, and they are why generated houses had no
 * corner pieces and no door that belonged with their walls.
 *
 * ## The shape of the algorithm
 *
 * Flood the outdoors in from the region border, crossing only unblocked edges;
 * whatever is unreached is interior. Each connected interior pocket is one
 * building, and its family is exactly the set of locs that blocked its
 * boundary edges — recorded at block time, so another loc that merely shares a
 * tile with a wall is never mistaken for part of it.
 *
 * A pocket touching the region border cannot exist by construction, the border
 * being where the outdoor flood starts, so the old border guard is gone rather
 * than kept as decoration.
 */
export function observeBuildings(
  model: BuildingModel,
  objects: number[][],
  isDoorId: (id: number) => boolean,
  /** plane-0 underlay bytes, `[x * 64 + y]`; only used to skip untouched tiles */
  underlay?: Uint8Array | null,
  /**
   * Called once per building with its wall ids and the ring of ground tiles
   * around it, so the caller can fold both into the shared context model. The
   * ring rather than the footprint — see the note further down.
   */
  onBuilding?: (ids: number[], ringTiles: number[]) => void,
  /** an object's name, for classifying purpose fixtures */
  nameOf?: (id: number) => string | undefined,
) {
  // Everything this ONE region taught us, so a region votes once per door and
  // once per family however many copies it holds. Mirrors `docks.ts`'s
  // `trimHere`, which counts piers rather than planks.
  const doorsHere = new Set<BuildingModel['doors'][number]>()
  const famsHere = new Set<WallFamily>()

  const scan = scanRooms(objects)
  const { blocked, at, blockers } = scan

  // --- each enclosed room is one building for family/furniture purposes.
  // (Template extraction merges adjacent rooms into whole buildings; see
  // `templates.ts`. The two answer different questions: a family is the
  // masonry of one room, a template is the shape of a whole house.)
  for (const inner of scan.rooms) {
    if (inner.length < MIN_INTERIOR) continue

    // the walls that actually seal it, and the tiles those walls stand on
    const ids = new Set<number>()
    const wallTiles = new Set<number>()
    for (const i of inner) {
      const x = (i / SIZE) | 0, y = i % SIZE
      for (let d = 0; d < 4; d++) {
        if (!(blocked[i] & (1 << d))) continue
        for (const id of blockers.get(i * 4 + d) ?? []) ids.add(id)
        wallTiles.add(i)
        const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
        if (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) wallTiles.add(nx * SIZE + ny)
      }
    }
    if (!ids.size) continue
    model.buildings++

    for (const id of ids) {
      let p = model.parts[id]
      if (!p) model.parts[id] = (p = { id, n: 0, shapes: {} })
      p.n++
      if (isDoorId(id)) {
        let d = model.doors.find((e) => e.id === id)
        if (!d) model.doors.push(d = { id, n: 0, regions: 0 })
        d.n++
        doorsHere.add(d)
      }
    }
    // which shapes each id is authored for, read off the locs themselves
    for (const j of wallTiles) {
      for (const o of at.get(j) ?? []) {
        if (!WALL_SHAPES.has(o[1]) || !ids.has(o[0])) continue
        const p = model.parts[o[0]]
        if (p) p.shapes[o[1]] = (p.shapes[o[1]] ?? 0) + 1
      }
    }

    const key = [...ids].sort((a, b) => a - b)
    let fam = model.families.find((e) => e.ids.length === key.length && e.ids.every((v, i) => v === key[i]))
    if (fam) fam.buildings++
    else model.families.push(fam = { ids: key, buildings: 1, regions: 0, doors: {} })
    famsHere.add(fam)
    for (const id of ids) if (isDoorId(id)) fam.doors[id] = (fam.doors[id] ?? 0) + 1

    // --- the COUNTRY this building stands in: a ring OUTSIDE the footprint.
    //
    // Not the footprint. A building's own floor is usually town earth whatever
    // the biome, and a GENERATED plot is a paved pad, so scoring against
    // either asks "does this style like gravel" rather than "does this style
    // belong on this coast". Both sides measure the same ring.
    let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1
    for (const j of inner) {
      const x = (j / SIZE) | 0, y = j % SIZE
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const ring: number[] = []
    for (let x = Math.max(0, x0 - GROUND_RING); x <= Math.min(SIZE - 1, x1 + GROUND_RING); x++) {
      for (let y = Math.max(0, y0 - GROUND_RING); y <= Math.min(SIZE - 1, y1 + GROUND_RING); y++) {
        const j = x * SIZE + y
        // any room tile, not just this one's — a ring must not sample the
        // inside of the house next door
        if (scan.roomOf[j] >= 0 || wallTiles.has(j)) continue
        // an underlay of 0 means the region does not cover that tile
        if (underlay && !underlay[j]) continue
        ring.push(j)
      }
    }
    onBuilding?.(key, ring)

    // --- the interior: classify, then count DISTINCT BUILDINGS per object
    const furnHere = new Set<Furniture>()
    const rolesHere = new Set<FixtureRole>()
    for (const j of inner) {
      const x = (j / SIZE) | 0, y = j % SIZE
      // distance to the nearest interior tile that touches a wall
      let best = 9
      for (const k of inner) {
        if (!wallTiles.has(k)) continue
        const d = Math.abs(((k / SIZE) | 0) - x) + Math.abs((k % SIZE) - y)
        if (d < best) best = d
        if (!best) break
      }
      for (const o of at.get(j) ?? []) {
        if (WALL_SHAPES.has(o[1])) continue
        const cls = classOfShape(o[1])
        if (!cls) continue // roofs and anything else that is not a furnishing
        const role = fixtureRoleOf(nameOf?.(o[0]))
        let e = model.furniture.find((v) => v.id === o[0] && v.shape === o[1])
        if (!e) {
          model.furniture.push(e = {
            id: o[0], shape: o[1], cls, role, n: 0, buildings: 0, d: [0, 0, 0, 0, 0],
          })
        }
        e.n++
        e.d[Math.min(4, best)]++
        furnHere.add(e)
        if (role) rolesHere.add(role)
      }
    }
    for (const e of furnHere) e.buildings++
    for (const r of rolesHere) model.roles[r] = (model.roles[r] ?? 0) + 1
  }

  for (const d of doorsHere) d.regions++
  for (const f of famsHere) f.regions++
}

/**
 * Rank on SPREAD first, volume second.
 *
 * `regions * log(1 + n)` rather than either alone: regions on its own would
 * treat a door placed once in each of six towns as equal to one placed forty
 * times in each of six, and `n` on its own is the bug this replaced. The log
 * keeps volume as a tiebreak that cannot run away — the offender had 1,459
 * placements, and no amount of volume in one region should beat presence in
 * twenty.
 */
const spread = (regions: number, n: number) => Math.max(1, regions) * Math.log1p(n)

export function finaliseBuildings(model: BuildingModel) {
  model.families.sort((a, b) => spread(b.regions, b.buildings) - spread(a.regions, a.buildings))
  model.families = model.families.slice(0, MAX_FAMILIES)
  model.doors.sort((a, b) => spread(b.regions, b.n) - spread(a.regions, a.n))
  model.doors = model.doors.slice(0, MAX_DOORS)
  // Rank on DISTINCT BUILDINGS, not raw placements. See the note on
  // `Furniture.buildings` — ranking on `n` is what crowned floor decals,
  // "Potato" and "Wheat" as the game's principal furniture.
  model.furniture.sort((a, b) => b.buildings - a.buildings || b.n - a.n)
  // Cap the two populations SEPARATELY.
  //
  // One shared cap silently destroyed the fixture classification: fixtures are
  // rare by their nature (10 altar buildings on the whole surface against 65
  // for the commonest floor decal), so ranking everything together and taking
  // the top N left exactly ONE fixture alive — a single cooking range — while
  // the mine had detected altars, forges, banks and workshops. A cap meant to
  // bound the generic pool must not decide what the purpose vocabulary is.
  const generic: Furniture[] = []
  const perRole = new Map<FixtureRole, Furniture[]>()
  for (const e of model.furniture) {
    if (!e.role) { generic.push(e); continue }
    let l = perRole.get(e.role)
    if (!l) perRole.set(e.role, (l = []))
    l.push(e)
  }
  model.furniture = [
    ...generic.slice(0, MAX_FURNITURE),
    ...[...perRole.values()].flatMap((l) => l.slice(0, MAX_FIXTURES_PER_ROLE)),
  ]
  const keep = new Set(model.families.flatMap((f) => f.ids))
  for (const d of model.doors) keep.add(d.id)
  const parts: Record<number, WallPart> = {}
  for (const id of keep) if (model.parts[id]) parts[id] = model.parts[id]
  model.parts = parts
}

// ---------------------------------------------------------------------------
// Layer 1 — massing
// ---------------------------------------------------------------------------

export type Rect = { x: number; y: number; w: number; h: number }

/**
 * Sample a footprint from §14's measured vocabulary.
 *
 * The recipe, and why each number is there:
 * - a near-square core 3-9 a side (commonest primary rects are 3x4, 4x4, 3x3,
 *   5x5), aspect kept under ~1.9 because real buildings are p90 1.86 and
 *   **anything long and thin is wrong before a wall is placed**;
 * - stop at the core ~22% of the time (21.6% of real buildings decompose to one
 *   rectangle);
 * - otherwise attach 1-3 smaller rectangles keeping the core near 72% of the
 *   whole, because the primary rect is a median 72% of the footprint — a
 *   building is a dominant mass plus additions, NOT an assembly of equals;
 * - place each addition corner-aligned (58%) or centred (37%);
 * - reject a candidate whose fill ratio drops below 0.42, which is §14's amoeba
 *   guard (p10 of the real distribution).
 *
 * This is the answer to §6's warning that local accretion makes blobs: the
 * outline is a GLOBAL decision sampled from measurement, and only then are
 * walls realized inside it.
 */
export function sampleFootprint(rnd: () => number, maxW: number, maxH: number): Rect[] | null {
  const cap = (v: number, m: number) => Math.max(3, Math.min(v, m))
  for (let attempt = 0; attempt < 24; attempt++) {
    const cw = cap(3 + Math.floor(rnd() * 7), maxW)
    const ch = cap(3 + Math.floor(rnd() * 7), maxH)
    if (Math.max(cw, ch) / Math.min(cw, ch) > 1.9) continue
    const rects: Rect[] = [{ x: 0, y: 0, w: cw, h: ch }]
    if (rnd() > 0.22) {
      const wings = 1 + Math.floor(rnd() * 3)
      for (let i = 0; i < wings; i++) {
        // sized so the core stays the dominant mass
        const ww = Math.max(2, Math.round(cw * (0.35 + rnd() * 0.4)))
        const wh = Math.max(2, Math.round(ch * (0.35 + rnd() * 0.4)))
        const side = Math.floor(rnd() * 4)
        const centred = rnd() < 0.39 // 37% centred / 58% corner-aligned, renormalised
        let x = 0, y = 0, w = ww, h = wh
        if (side === 0 || side === 2) {
          h = Math.min(wh, ch)
          x = side === 0 ? cw : -w
          y = centred ? Math.round((ch - h) / 2) : (rnd() < 0.5 ? 0 : ch - h)
        } else {
          w = Math.min(ww, cw)
          y = side === 1 ? ch : -h
          x = centred ? Math.round((cw - w) / 2) : (rnd() < 0.5 ? 0 : cw - w)
        }
        rects.push({ x, y, w, h })
      }
    }
    // normalise to non-negative coords and measure
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const r of rects) {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h)
    }
    const bw = maxX - minX, bh = maxY - minY
    if (bw > maxW || bh > maxH) continue
    for (const r of rects) { r.x -= minX; r.y -= minY }
    const mask = new Set<number>()
    for (const r of rects) {
      for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) mask.add(x * 100 + y)
    }
    if (mask.size / (bw * bh) < 0.42) continue // the amoeba guard
    return rects
  }
  return null
}

const pickFrom = <T>(items: T[], weight: (t: T) => number, rnd: () => number): T | null => {
  let total = 0
  for (const it of items) total += Math.max(0, weight(it))
  if (total <= 0) return null
  let r = rnd() * total
  for (const it of items) { r -= Math.max(0, weight(it)); if (r <= 0) return it }
  return items[items.length - 1]
}

/**
 * How well a set of wall ids belongs in this context, per the SHARED context
 * model rather than a histogram of this module's own.
 *
 * This replaced a bespoke `underlay` map on every family and door. Both
 * answered the question the context model already answers for scenery — "what
 * does the real map put on ground like this" — and two mechanisms for one
 * question is how they drift apart. The context model also weighs five
 * features rather than underlay alone, with a measured temper constant
 * (`context.ts` CONTEXT_TEMPER), so walls now get the treatment trees get.
 *
 * A family is a SET, so its members are combined with a GEOMETRIC mean: an
 * arithmetic mean lets one well-fitted member carry a family full of badly
 * fitted ones, which is precisely the failure that drops a bamboo panel into a
 * stone cottage. The geometric mean makes every member have to belong.
 *
 * Returns a RAW likelihood with no floor. The floor belongs to the caller and
 * has to be applied after normalising — see `weighByContext`.
 */
const contextFit = (
  ids: number[],
  ctxModel: ContextModel | null | undefined,
  ctx: TileContext | null | undefined,
): number => {
  if (!ctxModel || !ctx || !ids.length) return 1
  let logSum = 0
  for (const id of ids) logSum += Math.log(Math.max(1e-9, contextLikelihood(ctxModel, id, ctx)))
  return Math.exp(logSum / ids.length)
}

/**
 * Blend a popularity weight with context fit, NORMALISED across the candidates.
 *
 * The normalisation is the whole point and its absence was a shipped bug. The
 * first version floored the raw fit at 0.02 — but `contextLikelihood` is a
 * product over five features, so its absolute magnitude is small and entirely
 * scale-dependent: every family scored below the floor, every family clamped to
 * exactly 0.02, and the "ground-conditioned" picker returned an identical
 * distribution on sand, town earth, jungle and snow. It verified as working
 * because coverage was 64/64; it discriminated not at all.
 *
 * Dividing by the best candidate makes the comparison scale-free, so the floor
 * then means what it says: "the worst-fitting style still gets a 3% look-in",
 * which keeps a plot from ever coming out wall-less on synthetic ground the
 * corpus has never seen.
 */
export function weighByContext<T>(
  items: T[],
  base: (t: T) => number,
  idsOf: (t: T) => number[],
  ctxModel: ContextModel | null | undefined,
  ctx: TileContext | null | undefined,
): (t: T) => number {
  if (!ctxModel || !ctx) return base
  const fit = new Map<T, number>()
  let best = 0
  for (const it of items) {
    const v = contextFit(idsOf(it), ctxModel, ctx)
    fit.set(it, v)
    if (v > best) best = v
  }
  if (!(best > 0)) return base
  return (t: T) => base(t) * (0.03 + 0.97 * ((fit.get(t) ?? 0) / best))
}

export function pickWallFamily(
  model: BuildingModel | null,
  rnd: () => number,
  /** what the real map builds where, and the ground this plot sits in */
  ctxModel?: ContextModel | null,
  ctx?: TileContext | null,
): WallFamily | null {
  if (!model?.families.length) return null
  return pickFrom(
    model.families,
    weighByContext(
      model.families,
      (f) => spread(f.regions, f.buildings),
      (f) => f.ids,
      ctxModel, ctx,
    ),
    rnd,
  )
}

/** A family member that can actually be drawn with `shape`. */
export function pickWallId(
  model: BuildingModel | null, family: WallFamily | null, shape: number, rnd: () => number,
  /**
   * Ids this panel must not be. Always pass the DOORS: a family's key is every
   * wall id in the building, so its door is one of its members, and a door is
   * authored for shape 0 like any other straight wall. Without this filter the
   * picker used doors as ordinary wall panels — which is how a cottage came out
   * with three doors, two of them standing in as corners.
   */
  avoid?: (id: number) => boolean,
): number | null {
  if (!model || !family) return null
  const ids = avoid ? family.ids.filter((id) => !avoid(id)) : family.ids
  const able = ids.map((id) => model.parts[id]).filter((p) => p && (p.shapes[shape] ?? 0) > 0)
  if (able.length) return (pickFrom(able, (p) => p.shapes[shape], rnd) ?? able[0]).id
  // nothing in the family is authored for this shape — fall back to any member
  // rather than leaving a hole in the wall
  const any = ids.map((id) => model.parts[id]).filter(Boolean)
  return any.length ? (pickFrom(any, (p) => p.n, rnd) ?? any[0]).id : null
}

/**
 * A door for this masonry style.
 *
 * The family's own fitted doors come first and the global list is a fallback,
 * because a door is part of a style rather than an independent choice — picking
 * globally is what put a wrong door in every house.
 *
 * The fallback is load-bearing rather than a formality. A family's key is EVERY
 * wall id in the component, so a door is already one of its members; that makes
 * `fam.doors` empty for any family that simply has no door, which is common.
 * The fallback is ground-conditioned for that reason: when the corpus has never
 * seen this door with these walls, the biome is what makes them agree.
 */
export function pickDoorId(
  model: BuildingModel | null,
  rnd: () => number,
  family?: WallFamily | null,
  ctxModel?: ContextModel | null,
  ctx?: TileContext | null,
): number | null {
  const own = family ? Object.entries(family.doors) : []
  if (own.length) {
    const picked = pickFrom(own, ([, n]) => n, rnd)
    if (picked) return Number(picked[0])
  }
  if (!model?.doors.length) return null
  return (pickFrom(
    model.doors,
    weighByContext(model.doors, (d) => spread(d.regions, d.n), (d) => [d.id], ctxModel, ctx),
    rnd,
  ) ?? model.doors[0]).id
}

/**
 * A freestanding furnishing for an interior tile `dist` tiles from the nearest
 * wall, or null to leave the tile empty.
 *
 * **Purpose fixtures are excluded.** A bank booth or an altar says what a
 * building IS, and until a plot can carry a purpose there is nowhere it can
 * legitimately go — so `role !== null` is filtered out here rather than being
 * left to chance. `pickFixture` is the deliberate way in.
 */
export function pickFurniture(
  model: BuildingModel | null, dist: number, rnd: () => number,
): { id: number; shape: number } | null {
  if (!model?.furniture.length) return null
  const bucket = Math.max(0, Math.min(4, dist))
  const pool = model.furniture.filter((e) => e.cls === 'freestanding' && !e.role)
  const f = pickFrom(pool, (e) => e.buildings * (e.d[bucket] ?? 0), rnd)
  return f ? { id: f.id, shape: f.shape } : null
}

/** A wall-mounted decoration (shapes 4-8), for a tile that touches a wall. */
export function pickWallDecor(
  model: BuildingModel | null, rnd: () => number,
): { id: number; shape: number } | null {
  if (!model?.furniture.length) return null
  const pool = model.furniture.filter((e) => e.cls === 'wallDecor' && !e.role)
  const f = pickFrom(pool, (e) => e.buildings, rnd)
  return f ? { id: f.id, shape: f.shape } : null
}

/**
 * A floor patch (shape 22).
 *
 * Measured, and it overturned the obvious design: floor decals do NOT tile a
 * room. 71% of surface buildings carry one, but the dominant id covers a median
 * of just **19%** of the interior and only 66 of 684 reach 80%. They are rugs
 * and patches, so they are scattered like furniture rather than laid as a
 * floor.
 */
export function pickFloorPatch(
  model: BuildingModel | null, rnd: () => number,
): { id: number; shape: number } | null {
  if (!model?.furniture.length) return null
  const pool = model.furniture.filter((e) => e.cls === 'floor' && !e.role)
  const f = pickFrom(pool, (e) => e.buildings, rnd)
  return f ? { id: f.id, shape: f.shape } : null
}

/**
 * A purpose fixture for a building of this role — the only way one is ever
 * placed. Nothing calls this yet: plots carry no purpose, which is exactly why
 * fixtures must stay out of the generic pools until they do.
 */
export function pickFixture(
  model: BuildingModel | null, role: FixtureRole, rnd: () => number,
): { id: number; shape: number } | null {
  if (!model?.furniture.length) return null
  const pool = model.furniture.filter((e) => e.role === role)
  const f = pickFrom(pool, (e) => e.buildings, rnd)
  return f ? { id: f.id, shape: f.shape } : null
}

export type { BuildingSpec }
