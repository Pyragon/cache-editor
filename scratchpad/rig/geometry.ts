/**
 * GEOMETRY CHECK — does what the generator BUILDS look like what the miner
 * RECOGNISES as a building?
 *
 * Written 2026-08-09 after four wall bugs shipped in a row. Every audit so far
 * checked the VOCABULARY (which ids, which family, which door) and none of them
 * ever looked at the shape on the ground, which is precisely where all four
 * lived:
 *
 *  1. the interior was the footprint MINUS its perimeter, so a 5x5 house had a
 *     3x3 room — the same tile-versus-edge error the detector had, fixed there
 *     and left standing in the builder;
 *  2. doors are family members, so the panel picker used them as ordinary
 *     walls and buildings came out with three doors;
 *  3. corners were emitted as shape 1, a diagonal post that seals nothing,
 *     instead of shape 2, the whole corner;
 *  4. straight walls were emitted with `rotation: e`, the spelling authored
 *     from the tile on the FAR side of the edge, so every wall was drawn
 *     against the wrong face and the ring was offset by a tile.
 *
 * The test is a round trip. Generate a village, then decode the emitted locs
 * with the CLIENT's own forward table (`ClipFlagMap.addWall`: rot 0 blocks W,
 * 1 N, 2 E, 3 S; shape 2 blocks two) and run the same edge flood
 * `observeBuildings` uses. If the builder and the miner disagree about what was
 * built, the geometry is wrong however good the vocabulary is.
 */
import { dirHandle, installShims } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex } from '../../src/procgen/scenery'
import { generate } from '../../src/procgen/generate'
import type { ProcPlan } from '../../src/procgen/types'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64

const root = dirHandle(CACHE)
const { index, contextModel } = await buildSceneryIndex(
  await root.getDirectoryHandle('objects'), 'rig',
  undefined, undefined, undefined,
  await root.getDirectoryHandle('maps'),
  undefined,
  await root.getDirectoryHandle('map_areas'),
  await root.getDirectoryHandle('models'),
)

const tm = index.templates
const byPurpose = new Map<string, number[]>()
for (const t of tm?.templates ?? []) {
  const l = byPurpose.get(t.purpose) ?? []
  l.push(t.tiles.length)
  byPurpose.set(t.purpose, l)
}
console.log(`TEMPLATES MINED: ${tm?.templates.length ?? 0}`)
for (const [p2, sizes] of [...byPurpose].sort((a, b) => b[1].length - a[1].length)) {
  sizes.sort((a, b) => a - b)
  console.log(`  ${p2.padEnd(10)} ${String(sizes.length).padStart(3)}  `
    + `tiles ${sizes[0]}..${sizes[sizes.length - 1]} (p50 ${sizes[sizes.length >> 1]})`)
}
// Doors: is a doorless template a bug in the door test, or a building that
// genuinely has no door on plane 0? Split by purpose, because a shed having no
// door means something different from a house having none.
{
  const all = tm?.templates ?? []
  const withDoor = all.filter((t) => t.walls.some((w) => w.door))
  console.log(`  templates carrying a door: ${withDoor.length}/${all.length}`)
  const byP = new Map<string, [number, number]>()
  for (const t of all) {
    const e = byP.get(t.purpose) ?? [0, 0]
    e[1]++
    if (t.walls.some((w) => w.door)) e[0]++
    byP.set(t.purpose, e)
  }
  console.log('    ' + [...byP].map(([k, [a, b]]) => `${k} ${a}/${b}`).join('  '))
}
const multi = (tm?.templates ?? []).filter((t) => t.rooms > 1).length
console.log(`  multi-room templates: ${multi}
`)

// --- validate every template ON ITS OWN -----------------------------------
// Stamp it into an empty grid, apply its walls with the client's table, flood
// from outside. A template whose own walls do not enclose its own tiles is
// broken at extraction time, and stamping it can only ever produce a leak.
{
  const PAD = 3
  const S0v: Record<number, number> = { 0: 2, 1: 1, 2: 0, 3: 3 }
  const S2v: Record<number, number[]> = { 0: [1, 2], 1: [1, 0], 2: [0, 3], 3: [3, 2] }
  const DXv = [1, 0, -1, 0], DYv = [0, 1, 0, -1], OPPv = [2, 3, 0, 1]
  let ok = 0
  const bad: { p: string; tiles: number; walls: number; sealed: number }[] = []
  for (const t of tm?.templates ?? []) {
    const W = t.w + PAD * 2, H = t.h + PAD * 2
    const bl = new Uint8Array(W * H), sol = new Uint8Array(W * H)
    const bk = (x: number, y: number, d: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return
      bl[x * H + y] |= 1 << d
      const nx = x + DXv[d], ny = y + DYv[d]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return
      bl[nx * H + ny] |= 1 << OPPv[d]
    }
    for (const wl of t.walls) {
      const x = wl.x + PAD, y = wl.y + PAD
      if (wl.shape === 0) bk(x, y, S0v[wl.rotation & 3])
      else if (wl.shape === 2) for (const d of S2v[wl.rotation & 3]) bk(x, y, d)
      else if (wl.shape === 9 && x >= 0 && y >= 0 && x < W && y < H) sol[x * H + y] = 1
    }
    const out = new Uint8Array(W * H); const stk: number[] = []
    const sd = (x: number, y: number) => {
      const i = x * H + y
      if (out[i] || sol[i]) return
      out[i] = 1; stk.push(i)
    }
    for (let n = 0; n < W; n++) { sd(n, 0); sd(n, H - 1) }
    for (let n = 0; n < H; n++) { sd(0, n); sd(W - 1, n) }
    while (stk.length) {
      const i = stk.pop()!
      const x = (i / H) | 0, y = i % H
      for (let d = 0; d < 4; d++) {
        if (bl[i] & (1 << d)) continue
        const nx = x + DXv[d], ny = y + DYv[d]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const k = nx * H + ny
        if (out[k] || sol[k]) continue
        out[k] = 1; stk.push(k)
      }
    }
    let sealed = 0
    for (const i of t.tiles) {
      const x = Math.floor(i / t.h) + PAD, y = (i % t.h) + PAD
      if (!out[x * H + y]) sealed++
    }
    if (sealed === t.tiles.length) ok++
    else bad.push({ p: t.purpose, tiles: t.tiles.length, walls: t.walls.length, sealed })
  }
  console.log(`TEMPLATE SELF-VALIDATION: ${ok}/${tm?.templates.length ?? 0} enclose their own tiles`)
  const byP = new Map<string, number>()
  for (const b of bad) byP.set(b.p, (byP.get(b.p) ?? 0) + 1)
  if (bad.length) {
    console.log(`  broken by purpose: ${[...byP].map(([k, v]) => `${k} ${v}`).join(', ')}`)
    for (const b of bad.slice(0, 6)) {
      console.log(`    ${b.p} ${b.tiles} tiles / ${b.walls} walls -> only ${b.sealed} sealed`)
    }
  }
  console.log()
}

const plan = JSON.parse(
  await fs.readFile(`${CACHE}/procgen/plan.json`, 'utf8'),
) as ProcPlan
plan.area = { x0: 0, y0: 0, x1: 0, y1: 0 }

const result = generate(plan, index, contextModel)
const report = result.report
console.log(`plots requested: ${plan.zones?.flatMap((z) => z.plots ? [z.plots.count] : []).join(', ')}`)
console.log(`plots PLACED:    ${report.plots.length}  `
  + `[${report.plots.map((p2) => `${p2.w}x${p2.h}`).join(' ')}]`)
console.log(`buildings built: ${report.buildings.length}`)
if (report.warnings.length) {
  console.log('warnings:')
  for (const w of report.warnings.slice(0, 8)) console.log(`  - ${w}`)
}
console.log(`footprints: ${report.buildings.map((b) => `${b.w}x${b.h}`).join(', ')}`)
console.log(`interiors:  ${report.buildings.map((b) => b.interior).join(', ')}`)
console.log(`walls:      ${report.buildings.map((b) => b.walls).join(', ')}`)
console.log(`contents:   ${report.buildings.map((b) => b.furniture).join(', ')}  (replayed, not scattered)`)

// what actually ends up inside a stamped building, by name
{
  const objDir = dirHandle(`${CACHE}/objects`)
  const nm = async (id: number) => {
    try {
      const d = JSON.parse(await (await objDir.getFileHandle(`${id}.json`)).getFile().then((f2: any) => f2.text()))
      return d.name ?? 'null'
    } catch { return '?' }
  }
  // `locs` is declared below, so read the placements again here rather than
  // reordering the file around a debug print.
  const allLocs = (result.objects.get([...result.objects.keys()][0]) ?? []) as unknown as number[][]
  for (const b of report.buildings) {
    const inside = allLocs.filter((o) => o[5] === 0
      && o[3] >= b.x && o[3] < b.x + b.w && o[4] >= b.y && o[4] < b.y + b.h
      && ![0, 1, 2, 3, 9].includes(o[1]))
    const counts = new Map<number, number>()
    for (const o of inside) counts.set(o[0], (counts.get(o[0]) ?? 0) + 1)
    const parts: string[] = []
    for (const [id, c] of [...counts].sort((a, c2) => c2[1] - a[1]).slice(0, 8)) {
      parts.push(`${await nm(id)}${c > 1 ? ' x' + c : ''}`)
    }
    console.log(`  ${b.w}x${b.h} at (${b.x},${b.y}) [${b.purpose} from region ${b.from}]: ${parts.join(', ')}`)
  }
}

// --- decode every emitted loc with the CLIENT's forward table ---------------
// dirs here: 0=E(+x) 1=N(+y) 2=W(-x) 3=S(-y)
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], OPP = [2, 3, 0, 1]
/** shape 0: client rot -> blocked side, as a dir index */
const S0: Record<number, number> = { 0: 2, 1: 1, 2: 0, 3: 3 } // W, N, E, S
/** shape 2: client rot -> the two blocked sides */
const S2: Record<number, number[]> = { 0: [1, 2], 1: [1, 0], 2: [0, 3], 3: [3, 2] }

const locs = result.objects.get([...result.objects.keys()][0]) ?? []
const blocked = new Uint8Array(SIZE * SIZE)
const solidTile = new Uint8Array(SIZE * SIZE)
const doorTiles = new Set<number>()
const doorIdSet = new Set((index.buildings?.doors ?? []).map((d) => d.id))
let cornerCount = 0, straightCount = 0, diagonalPosts = 0
const block = (x: number, y: number, d: number) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  blocked[x * SIZE + y] |= 1 << d
  const nx = x + DX[d], ny = y + DY[d]
  if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return
  blocked[nx * SIZE + ny] |= 1 << OPP[d]
}
for (const o of locs) {
  // LocEntry is a TUPLE: [objectId, type, rotation, x, y, plane]
  const [objectId, shape, rotation, x, y, plane] = o as unknown as number[]
  if (plane !== 0) continue
  if (shape === 0) { block(x, y, S0[rotation & 3]); straightCount++ }
  else if (shape === 2) { for (const d of S2[rotation & 3]) block(x, y, d); cornerCount++ }
  else if (shape === 9) solidTile[x * SIZE + y] = 1 // WALL_INTERACT: whole tile, as scanRooms treats it
  else if (shape === 1 || shape === 3) diagonalPosts++
  if (doorIdSet.has(objectId) && (shape === 0 || shape === 2)) doorTiles.add(x * SIZE + y)
}
console.log(`\nemitted: ${straightCount} straight, ${cornerCount} whole corners, `
  + `${diagonalPosts} corner posts (shape 1/3), ${doorTiles.size} door locs`)

// --- run the miner's own edge flood over what we just built -----------------
const outside = new Uint8Array(SIZE * SIZE)
const st: number[] = []
const seed = (x: number, y: number) => {
  const i = x * SIZE + y
  if (outside[i] || solidTile[i]) return
  outside[i] = 1; st.push(i)
}
for (let n = 0; n < SIZE; n++) { seed(0, n); seed(SIZE - 1, n); seed(n, 0); seed(n, SIZE - 1) }
while (st.length) {
  const i = st.pop()!
  const x = (i / SIZE) | 0, y = i % SIZE
  for (let d = 0; d < 4; d++) {
    if (blocked[i] & (1 << d)) continue
    const nx = x + DX[d], ny = y + DY[d]
    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
    const k = nx * SIZE + ny
    if (outside[k] || solidTile[k]) continue
    outside[k] = 1; st.push(k)
  }
}
const seen = new Uint8Array(SIZE * SIZE)
const rooms: number[][] = []
for (let s2 = 0; s2 < SIZE * SIZE; s2++) {
  if (outside[s2] || seen[s2] || solidTile[s2]) continue
  const room = [s2]; seen[s2] = 1; const stack = [s2]
  while (stack.length) {
    const i = stack.pop()!
    const x = (i / SIZE) | 0, y = i % SIZE
    for (let d = 0; d < 4; d++) {
      if (blocked[i] & (1 << d)) continue
      const nx = x + DX[d], ny = y + DY[d]
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
      const k = nx * SIZE + ny
      if (outside[k] || seen[k] || solidTile[k]) continue
      seen[k] = 1; room.push(k); stack.push(k)
    }
  }
  rooms.push(room)
}
// Per-building: does the room the builder claims actually seal? A total count
// hides which one leaked, and "5 built, 1 found" says nothing about why.
console.log('\nper-building seal check:')
for (const b of report.buildings) {
  const cx = b.x + Math.floor(b.w / 2), cy = b.y + Math.floor(b.h / 2)
  const start = cx * SIZE + cy
  const room = rooms.find((r) => r.includes(start))
  console.log(`  (${b.x},${b.y}) ${b.w}x${b.h} claims ${b.interior} tiles / ${b.walls} walls`
    + ` -> ${outside[start] ? 'LEAKS — centre reaches the outdoors' : `sealed, room of ${room?.length ?? 0}`}`)
}

console.log(`\nROUND TRIP: the miner finds ${rooms.length} enclosed rooms in what the builder made`)
console.log(`  room sizes: ${rooms.map((r) => r.length).sort((a, b) => b - a).join(', ')}`)

// --- draw one, so the shape is actually visible ----------------------------
if (rooms.length) {
  const room = rooms.slice().sort((a, b) => b.length - a.length)[0]
  let x0 = 99, y0 = 99, x1 = -1, y1 = -1
  for (const i of room) {
    const x = (i / SIZE) | 0, y = i % SIZE
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  console.log(`\nlargest room ${room.length} tiles, bbox ${x1 - x0 + 1}x${y1 - y0 + 1} at (${x0},${y0}):`)
  const inRoom = new Set(room)
  // two text rows per tile row: the north edges, then the tile + west edge
  for (let y = y1 + 1; y >= y0 - 1; y--) {
    let top = '', mid = ''
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const i = x * SIZE + y
      const b = x >= 0 && y >= 0 && x < SIZE && y < SIZE ? blocked[i] : 0
      top += (b & (1 << 1)) ? '+---' : '+   '
      mid += (b & (1 << 2)) ? '|' : ' '
      mid += inRoom.has(i) ? (doorTiles.has(i) ? ' D ' : ' . ') : '   '
    }
    console.log('  ' + top)
    console.log('  ' + mid)
  }
}
