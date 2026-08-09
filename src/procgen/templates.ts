/**
 * BUILDING TEMPLATES — real buildings, lifted from the map and replayed.
 *
 * ## Why this exists, when synthesis was the whole point
 *
 * `buildings.ts` synthesises: it samples a footprint, picks a masonry family
 * and lays walls by rule. Cody asked for that three times over, and the
 * intention was right — never stamp hand-authored prefabs. What it produced
 * after two days was houses two people could stand in, because **nothing in the
 * synthesis path was actually mined**. `sampleFootprint` is hand-written random
 * numbers (`3 + rnd() * 7`, plus wings) behind a comment claiming a measured
 * vocabulary. The masonry was learned from the corpus; the SHAPE never was.
 *
 * This module closes that gap the direct way: it records the real geometry of
 * real buildings — footprint, every wall loc with its shape and rotation, the
 * doors, the rooms — and replays it with a different material family. That is
 * not the prefab library Cody vetoed. A prefab library is somebody's idea of a
 * house; this is the game's own houses, measured.
 *
 * Synthesis is kept and still selectable (`BuildingSpec.mode`), because the two
 * fail in opposite directions: templates cannot produce anything the map does
 * not already contain, and synthesis can produce anything at all, including
 * nonsense.
 *
 * ## A building is MERGED ROOMS
 *
 * The room flood finds enclosed pockets, and a real house is often several —
 * measured on the surface, 969 rooms merge into 667 buildings, p50 27 interior
 * tiles across 1 room, up to 12 rooms and 1,910 tiles. Two rooms belong to the
 * same building when one wall separates them. Without the merge, a castle is a
 * dozen unrelated closets and every template is a single box, which is exactly
 * what the generator was producing.
 */

import {
  SCAN_SIZE as SIZE, WALL_SHAPES, scanRooms, fixtureRoleOf, weighByContext,
  type FixtureRole, type RoomScan,
} from './buildings'
import type { ContextModel, TileContext } from './context'

/**
 * What a building IS, so a plot can ask for one.
 *
 * Fixture-derived where the contents say so (`bank`, `church`, `forge`, `pub`,
 * `workshop`, `store`), geometry-derived otherwise. The geometry classes are
 * deliberately coarse — they are size bands with names, not an attempt to tell
 * a cottage from a farmhouse, and pretending to more precision than the corpus
 * supports is how the last few days went.
 */
export type BuildingPurpose =
  | 'house' | 'shed' | 'hall' | 'castle' | 'tower'
  | 'bank' | 'church' | 'forge' | 'pub' | 'workshop' | 'store'

/**
 * What an UNNAMED plot may be built as.
 *
 * A plot with no stated purpose means "a building people live or work in", and
 * without this the small purposes win by fitting: towers are 3-16 tiles and
 * sheds 2-11, so on a 7x8 plot they beat every house in the corpus and a
 * fishing village came out as two towers, one of which contained nothing but a
 * staircase. Castles, churches, banks and towers are landmarks — you get one
 * because the plan asked for one, never by accident.
 */
export const DEFAULT_PURPOSES: BuildingPurpose[] = ['house', 'pub', 'forge', 'workshop', 'store']

/** Every purpose, for validating what a plan asks for. */
export const BUILDING_PURPOSES: BuildingPurpose[] = [
  'house', 'shed', 'hall', 'castle', 'tower',
  'bank', 'church', 'forge', 'pub', 'workshop', 'store',
]

/**
 * One interior loc, relative to the template's south-west corner — the
 * building's ACTUAL contents.
 *
 * These are replayed verbatim. The first version of this module recorded only
 * walls and then ran the generic furniture scatter over the stamped interior,
 * which threw the real contents away and rolled dice per tile instead. A 5x5
 * cottage came out with four ladders; a room with a 3-tile table got six chairs
 * and seven stools, a well, a campfire and one corner of a rug. Every one of
 * those is a symptom of the same mistake: the corpus was measured and then
 * ignored at the moment it mattered.
 *
 * Replaying them also fixes things no scatter rule could get right — a bed is
 * multi-tile and needs the position and rotation the map gave it, a rug is
 * several decal locs that only read as a rug together, and a bank's booths
 * belong in the bank and nowhere else.
 */
export type TemplateObject = {
  x: number
  y: number
  shape: number
  rotation: number
  id: number
}

/** One wall loc, relative to the template's south-west corner. */
export type TemplateWall = {
  x: number
  y: number
  shape: number
  rotation: number
  /** the id as the map had it — replaced by the chosen family when stamped */
  id: number
  /** this loc is a door: it must survive material substitution intact */
  door: boolean
}

export type BuildingTemplate = {
  /** bounding box of the interior */
  w: number
  h: number
  /** interior tiles, relative, as `x * h + y` */
  tiles: number[]
  walls: TemplateWall[]
  /** everything standing inside, replayed as-is */
  contents: TemplateObject[]
  rooms: number
  doors: number
  purpose: BuildingPurpose
  /** the wall ids the original used, for reference and for material swapping */
  ids: number[]
  /** region it came from, so a suspect template can be found on the map */
  from: number
}

export type TemplateModel = {
  fingerprint: string
  builtAt: number
  templates: BuildingTemplate[]
}

export function emptyTemplateModel(fingerprint: string): TemplateModel {
  return { fingerprint, builtAt: Date.now(), templates: [] }
}

/**
 * Templates kept per purpose. A cap is needed — the corpus is 667 buildings and
 * storing every one of them would bloat the index for no variety gain — but it
 * has to be PER PURPOSE, or the common houses crowd out the one bank exactly
 * the way common furniture crowded out every fixture.
 */
const MAX_PER_PURPOSE = 40
/** Bigger than this is a compound (a whole walled town), not a building. */
const MAX_TEMPLATE_SPAN = 40

/**
 * Classify a merged building.
 *
 * Fixtures win over geometry: a small room with an altar is a chapel, not a
 * shed. Among geometry classes the order matters, so castle is tested before
 * hall and shed before house.
 *
 * ## `kitchen` is not a purpose
 *
 * It was one, and it was wrong — a range makes a house a house with a range.
 * It had absorbed 40 templates that were simply houses. Kitchen fixtures now
 * fall through to the geometry classes.
 *
 * ## What a tower is, and what the first attempt actually measured
 *
 * The first version asked for "more than 60% of tiles carry something on an
 * upper plane, small footprint" and classified **286 of 667 buildings — 43% of
 * everything — as towers.** The signal was not tower-ness. Measured on the
 * surface: **502 of 667 buildings have plane-1 locs and 390 are over 60%
 * upper**, because having an upper floor is what a normal RuneScape building
 * does. It was detecting "has a first floor".
 *
 * A real tower is rare, and Cody's description is the useful one: mostly a
 * stairwell shaft up to a top floor, standing on its own. So all three of these
 * are required, and together they find **11** across the whole surface:
 *
 * - **reaches plane 2**, not merely plane 1 — a house's upper storey stops at 1;
 * - a **tiny footprint** (<= 16 tiles, <= 6 across);
 * - **secluded** — more than 4 tiles of clear ground to the nearest other
 *   building. This is the test that rejects a house's corner staircase, which
 *   is otherwise indistinguishable: same size, same plane-2 locs, but it is
 *   built up against its parent.
 */
export function classifyBuilding(
  tiles: number, span: number, rooms: number, doors: number,
  roles: Set<FixtureRole>, plane2Share: number, gap: number,
): BuildingPurpose {
  // A fixture states the purpose outright. Ordered so the more specific
  // reading wins when a building carries several — a church with a kitchen is
  // a church. `kitchen` is deliberately absent: see above.
  for (const r of ['bank', 'altar', 'church', 'forge', 'pub', 'workshop', 'store'] as const) {
    if (roles.has(r as FixtureRole)) return r === 'altar' ? 'church' : (r as BuildingPurpose)
  }
  if (tiles >= 200 && rooms >= 3) return 'castle'
  if (tiles <= TOWER_MAX_TILES && span <= TOWER_MAX_SPAN
      && gap > TOWER_MIN_GAP && plane2Share > TOWER_MIN_PLANE2) return 'tower'
  if (tiles >= 80) return 'hall'
  if (tiles < 12 && doors === 0) return 'shed'
  return 'house'
}

const TOWER_MAX_TILES = 16
const TOWER_MAX_SPAN = 6
/** clear tiles to the nearest other building; 4 rejects attached stairwells */
const TOWER_MIN_GAP = 4
const TOWER_MIN_PLANE2 = 0.6

/**
 * Extract this region's buildings as templates.
 *
 * `upperAt` carries which tiles have anything on planes 1-3, which is the only
 * signal available on a plane-0 scan for "this building has storeys".
 */
export function observeTemplates(
  model: TemplateModel,
  objects: number[][],
  regionId: number,
  nameOf: (id: number) => string | undefined,
  isDoorId: (id: number) => boolean,
) {
  const scan: RoomScan = scanRooms(objects)
  if (!scan.rooms.length) return

  // Plane 2 and above, NOT plane 1. A normal house has a first floor; only a
  // tower keeps going. See `classifyBuilding`.
  const plane2At = new Set<number>()
  for (const o of objects) {
    if (o[5] >= 2 && o[3] >= 0 && o[4] >= 0 && o[3] < SIZE && o[4] < SIZE) {
      plane2At.add(o[3] * SIZE + o[4])
    }
  }

  // --- merge rooms separated by a single wall into one building
  const parent = scan.rooms.map((_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] }
    return a
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < SIZE * SIZE; i++) {
    const r = scan.roomOf[i]
    if (r < 0) continue
    const x = (i / SIZE) | 0, y = i % SIZE
    for (let d = 0; d < 4; d++) {
      if (!(scan.blocked[i] & (1 << d))) continue
      const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
      const other = scan.roomOf[nx * SIZE + ny]
      if (other >= 0 && other !== r) union(r, other)
    }
  }
  const groups = new Map<number, { tiles: number[]; rooms: number }>()
  scan.rooms.forEach((tiles, i) => {
    const k = find(i)
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { tiles: [], rooms: 0 }))
    g.rooms++
    g.tiles.push(...tiles)
  })

  // Bounding boxes first, so each building knows how close its neighbours are.
  // Seclusion cannot be judged one building at a time.
  const boxes: { g: { tiles: number[]; rooms: number }; x0: number; y0: number; x1: number; y1: number }[] = []
  for (const g of groups.values()) {
    if (g.tiles.length < 2) continue
    let bx0 = SIZE, by0 = SIZE, bx1 = -1, by1 = -1
    for (const i of g.tiles) {
      const x = (i / SIZE) | 0, y = i % SIZE
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
    boxes.push({ g, x0: bx0, y0: by0, x1: bx1, y1: by1 })
  }
  /** clear tiles between this building's box and the nearest other one */
  const gapOf = (b: typeof boxes[number]): number => {
    let best = 99
    for (const o of boxes) {
      if (o === b) continue
      const dx = Math.max(0, Math.max(b.x0 - o.x1, o.x0 - b.x1))
      const dy = Math.max(0, Math.max(b.y0 - o.y1, o.y0 - b.y1))
      best = Math.min(best, Math.max(dx, dy))
    }
    return best
  }

  for (const box of boxes) {
    const g = box.g
    const tiles = g.tiles
    const x0 = box.x0, y0 = box.y0
    const w = box.x1 - x0 + 1, h = box.y1 - y0 + 1
    if (w > MAX_TEMPLATE_SPAN || h > MAX_TEMPLATE_SPAN) continue

    const tileSet = new Set(tiles)
    // Every wall loc that seals this building, taken from the tiles it stands
    // on rather than from the blocked-edge index: a template has to replay the
    // ACTUAL locs, with their own shapes and rotations, not a reconstruction.
    // The EIGHT-neighbourhood, not four.
    //
    // A diagonal corner post (shape 1 or 3) blocks no cardinal edge, so it
    // stands on the tile diagonally off the building's corner — which is never
    // a 4-neighbour of any interior tile. Gathering only the four dropped every
    // corner post in the corpus, and the stamped buildings came out with a
    // visible gap you could see straight through at each corner. The room still
    // sealed, which is why the round-trip check passed it: a corner post is
    // scenery, not collision, so its absence is invisible to a flood fill and
    // obvious on screen.
    // Tiles whose walls belong to THIS building, and separately the diagonal
    // tiles that may only contribute a corner post.
    //
    // The first attempt took every wall on all eight neighbours, and that is
    // too greedy: a tile diagonally outside a straight run carries whatever
    // happens to be there — a fence, the next building's wall — and replaying
    // it produced a panel jutting out of the corner at a right angle to
    // nothing. Only shapes 1 and 3 legitimately stand on a diagonal tile,
    // because they are the only ones that seal no cardinal edge.
    const wallTiles = new Set<number>()
    const cornerTiles = new Set<number>()
    for (const i of tiles) {
      const x = (i / SIZE) | 0, y = i % SIZE
      let boundary = false
      for (let d = 0; d < 4; d++) {
        if (!(scan.blocked[i] & (1 << d))) continue
        boundary = true
        wallTiles.add(i)
        const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
        if (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) wallTiles.add(nx * SIZE + ny)
      }
      if (!boundary) continue
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        cornerTiles.add(nx * SIZE + ny)
      }
    }
    const rawWalls: (TemplateWall & { tile: number })[] = []
    const ids = new Set<number>()
    let doors = 0
    const consider: [number, boolean][] = []
    for (const j of wallTiles) consider.push([j, false])
    for (const j of cornerTiles) if (!wallTiles.has(j)) consider.push([j, true])
    for (const [j, cornerOnly] of consider) {
      for (const o of scan.at.get(j) ?? []) {
        if (!WALL_SHAPES.has(o[1])) continue
        // a diagonal tile contributes its corner post and nothing else
        if (cornerOnly && o[1] !== 1 && o[1] !== 3) continue
        const wx = (j / SIZE) | 0, wy = j % SIZE
        // one tile beyond the interior box is the outer ring; further than that
        // belongs to something else
        if (wx < x0 - 1 || wy < y0 - 1 || wx > x0 + w || wy > y0 + h) continue
        const door = isDoorId(o[0])
        rawWalls.push({ x: wx, y: wy, shape: o[1], rotation: o[2] & 3, id: o[0], door, tile: j })
        ids.add(o[0])
        if (door) doors++
      }
    }
    if (!rawWalls.length) continue

    // --- re-origin the template so its box covers the WALLS as well.
    //
    // `w`/`h` were the interior bbox while the walls sit a tile outside it, so
    // an 8x13 template actually occupies 10x15 — and `pickTemplate` was fitting
    // the interior to the plot and letting the walls hang over the edge, into
    // the road and the neighbouring plot. The stored box is now the real extent.
    let fx0 = x0, fy0 = y0, fx1 = x0 + w - 1, fy1 = y0 + h - 1
    for (const wl of rawWalls) {
      if (wl.x < fx0) fx0 = wl.x
      if (wl.x > fx1) fx1 = wl.x
      if (wl.y < fy0) fy0 = wl.y
      if (wl.y > fy1) fy1 = wl.y
    }
    const fw = fx1 - fx0 + 1, fh = fy1 - fy0 + 1
    const walls: TemplateWall[] = rawWalls.map((wl) => ({
      x: wl.x - fx0, y: wl.y - fy0, shape: wl.shape, rotation: wl.rotation, id: wl.id, door: wl.door,
    }))

    const roles = new Set<FixtureRole>()
    const contents: TemplateObject[] = []
    let plane2 = 0
    for (const i of tiles) {
      if (plane2At.has(i)) plane2++
      for (const o of scan.at.get(i) ?? []) {
        if (WALL_SHAPES.has(o[1])) continue
        // Roofs (12-21) are not contents; everything else the building holds is.
        if (o[1] >= 12 && o[1] <= 21) continue
        contents.push({
          x: ((i / SIZE) | 0) - fx0, y: (i % SIZE) - fy0,
          shape: o[1], rotation: o[2] & 3, id: o[0],
        })
        const r = fixtureRoleOf(nameOf(o[0]))
        if (r) roles.add(r)
      }
    }
    const purpose = classifyBuilding(
      tiles.length, Math.max(w, h), g.rooms, doors, roles,
      plane2 / tiles.length, gapOf(box),
    )
    model.templates.push({
      w: fw, h: fh,
      tiles: tiles.map((i) => (((i / SIZE) | 0) - fx0) * fh + ((i % SIZE) - fy0)),
      walls, contents, rooms: g.rooms, doors, purpose, ids: [...ids], from: regionId,
    })
    void tileSet
  }
}

const DIR_DX = [1, 0, -1, 0]
const DIR_DY = [0, 1, 0, -1]

/**
 * Does a template's own walls enclose its own tiles?
 *
 * Stamp it into an empty grid, apply its walls with the client's table, flood
 * from the outside. This is the same check the round-trip rig does, moved into
 * the extractor so a broken template can never reach a plot.
 *
 * It is needed because extraction DOES lose walls: measured 2026-08-09,
 * **81 of 188 templates failed this**, some badly (24 interior tiles held by 8
 * wall locs). The root cause is not yet found — the likeliest candidate is a
 * boundary formed by whole-tile blockers rather than by edge walls, which the
 * capture loop keys on `blocked` and therefore never sees. Until it is found,
 * dropping the broken ones is the honest move: a template that cannot enclose
 * itself will never enclose anything, and shipping it produces exactly the
 * roofless half-walled shells that have wasted days of review.
 */
export function templateEncloses(t: BuildingTemplate): boolean {
  const PAD = 3
  const W = t.w + PAD * 2, H = t.h + PAD * 2
  const blocked = new Uint8Array(W * H)
  const solid = new Uint8Array(W * H)
  const block = (x: number, y: number, d: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    blocked[x * H + y] |= 1 << d
    const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return
    blocked[nx * H + ny] |= 1 << DIR_OPP[d]
  }
  for (const wl of t.walls) {
    const x = wl.x + PAD, y = wl.y + PAD
    if (wl.shape === 0) block(x, y, SHAPE0_ROT_SIDE[wl.rotation & 3])
    else if (wl.shape === 2) for (const d of SHAPE2_ROT_SIDES[wl.rotation & 3]) block(x, y, d)
    else if (wl.shape === 9 && x >= 0 && y >= 0 && x < W && y < H) solid[x * H + y] = 1
  }
  const outside = new Uint8Array(W * H)
  const st: number[] = []
  const seed = (x: number, y: number) => {
    const i = x * H + y
    if (outside[i] || solid[i]) return
    outside[i] = 1
    st.push(i)
  }
  for (let n = 0; n < W; n++) { seed(n, 0); seed(n, H - 1) }
  for (let n = 0; n < H; n++) { seed(0, n); seed(W - 1, n) }
  while (st.length) {
    const i = st.pop()!
    const x = (i / H) | 0, y = i % H
    for (let d = 0; d < 4; d++) {
      if (blocked[i] & (1 << d)) continue
      const nx = x + DIR_DX[d], ny = y + DIR_DY[d]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const k = nx * H + ny
      if (outside[k] || solid[k]) continue
      outside[k] = 1
      st.push(k)
    }
  }
  for (const i of t.tiles) {
    const x = Math.floor(i / t.h) + PAD, y = (i % t.h) + PAD
    if (outside[x * H + y]) return false
  }
  return true
}

/** shape 0: client rotation -> the side it blocks, as a dir index */
const SHAPE0_ROT_SIDE: Record<number, number> = { 0: 2, 1: 1, 2: 0, 3: 3 }
/** shape 2: client rotation -> the two sides it blocks */
const SHAPE2_ROT_SIDES: Record<number, number[]> = { 0: [1, 2], 1: [1, 0], 2: [0, 3], 3: [3, 2] }
const DIR_OPP = [2, 3, 0, 1]

/** Drop templates that do not enclose themselves, then trim to the cap. */
export function finaliseTemplates(model: TemplateModel) {
  model.templates = model.templates.filter(templateEncloses)
  const byPurpose = new Map<BuildingPurpose, BuildingTemplate[]>()
  for (const t of model.templates) {
    let l = byPurpose.get(t.purpose)
    if (!l) byPurpose.set(t.purpose, (l = []))
    l.push(t)
  }
  const kept: BuildingTemplate[] = []
  for (const list of byPurpose.values()) {
    // Spread by size rather than taking the first N, so a purpose does not end
    // up represented entirely by its smallest examples.
    list.sort((a, b) => a.tiles.length - b.tiles.length)
    if (list.length <= MAX_PER_PURPOSE) { kept.push(...list); continue }
    const step = list.length / MAX_PER_PURPOSE
    for (let i = 0; i < MAX_PER_PURPOSE; i++) kept.push(list[Math.floor(i * step)])
  }
  model.templates = kept
}

/**
 * Rotate a template by `k` quarter-turns clockwise.
 *
 * Loc rotation is `+k` because the client's wall rotations step 90 degrees per
 * unit in the same direction (shape 0: 0=W, 1=N, 2=E, 3=S is a clockwise
 * cycle). The tile map is the matching grid rotation, with the box dimensions
 * swapping on odd turns.
 *
 * This is verified by the round-trip rig rather than by argument: stamp a
 * rotated template, re-run the room flood over what was emitted, and the room
 * must come back the same size. A wrong rotation unseals the ring and the
 * building simply disappears from the count.
 */
export function rotateTemplate(t: BuildingTemplate, k: number): BuildingTemplate {
  const turns = ((k % 4) + 4) % 4
  if (!turns) return t
  const swap = turns % 2 === 1
  const nw = swap ? t.h : t.w
  const nh = swap ? t.w : t.h
  const mapXY = (x: number, y: number): [number, number] => {
    switch (turns) {
      case 1: return [y, t.w - 1 - x]
      case 2: return [t.w - 1 - x, t.h - 1 - y]
      default: return [t.h - 1 - y, x]
    }
  }
  return {
    ...t,
    w: nw,
    h: nh,
    tiles: t.tiles.map((i) => {
      const [nx, ny] = mapXY(Math.floor(i / t.h), i % t.h)
      return nx * nh + ny
    }),
    walls: t.walls.map((wl) => {
      const [nx, ny] = mapXY(wl.x, wl.y)
      return { ...wl, x: nx, y: ny, rotation: (wl.rotation + turns) & 3 }
    }),
    contents: t.contents.map((c) => {
      const [nx, ny] = mapXY(c.x, c.y)
      return { ...c, x: nx, y: ny, rotation: (c.rotation + turns) & 3 }
    }),
  }
}

/**
 * A template of this purpose that fits this plot, scored by whether it BELONGS
 * on this ground.
 *
 * Selection used to be purpose plus fit and nothing else, so a fishing village
 * on a temperate coast got Barbarian Village furniture and a jail block: the
 * wall MATERIAL was context-substituted, but the building itself came from
 * wherever the corpus happened to offer one.
 *
 * The score runs through the same shared context model that already conditions
 * scenery, wall families and doors — `weighByContext` over the template's own
 * wall ids, normalised across the candidates so the floor means what it says.
 * A template's walls are the right handle for this: they are what
 * `observeBuildings` fed into the model in the first place, keyed to the ground
 * ring around the real building, so a bamboo hut scores badly on grass without
 * anyone writing down what bamboo is.
 */
export function pickTemplate(
  model: TemplateModel | null,
  purpose: BuildingPurpose | undefined,
  maxW: number,
  maxH: number,
  rnd: () => number,
  ctxModel?: ContextModel | null,
  ctx?: TileContext | null,
): BuildingTemplate | null {
  if (!model?.templates.length) return null
  // Try each rotation so an oblong house can still fit a plot the other way up.
  const candidates: BuildingTemplate[] = []
  for (const t of model.templates) {
    if (purpose ? t.purpose !== purpose : !DEFAULT_PURPOSES.includes(t.purpose)) continue
    // A building you cannot walk into is not a building. Measured over the
    // corpus, the door flag is sound — pubs, churches, forges, banks and
    // workshops are 100% doored, houses 32/40 — so a doorless HOUSE is a real
    // building entered from an upper floor, not a detection failure. Those are
    // still no use on a village plot. Sheds are exempt: 0 of 40 have a door,
    // because a shed is a lean-to or a walled pen and never had one.
    if (t.purpose !== 'shed' && !t.walls.some((wl) => wl.door)) continue
    for (let k = 0; k < 4; k++) {
      const r = k ? rotateTemplate(t, k) : t
      if (r.w <= maxW && r.h <= maxH) { candidates.push(r); break }
    }
  }
  if (!candidates.length) return null
  // Prefer bigger, so a generous plot is not filled with a shed — then let
  // context decide among them.
  const biggest = Math.max(...candidates.map((c) => c.tiles.length))
  const weight = weighByContext(
    candidates,
    (t) => 0.25 + 0.75 * (t.tiles.length / Math.max(1, biggest)),
    (t) => t.ids,
    ctxModel, ctx,
  )
  let total = 0
  for (const c of candidates) total += Math.max(0, weight(c))
  if (total <= 0) return candidates[0]
  let r = rnd() * total
  for (const c of candidates) { r -= Math.max(0, weight(c)); if (r <= 0) return c }
  return candidates[candidates.length - 1]
}
