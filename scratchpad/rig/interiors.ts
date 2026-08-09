/**
 * What does the INTERIOR of an upper storey actually carry?
 *
 * §13 left one sub-question: only 17.3% of plane-1 loc tiles have an overlay,
 * but that population includes walls and roofs, which need no floor. So the
 * measurement has to isolate tiles that are genuinely *inside* a building.
 *
 * Three competing hypotheses for what a player stands on upstairs:
 *   H1  overlay terrain painted on that plane
 *   H2  a floor LOC (floor decoration, type 22, or ordinary scenery)
 *   H3  the roof of the storey below (roof locs, types 12-21)
 *
 * Method: walls occupy tiles (the same approximation §5/§7 used to measure the
 * wall grammar, kept for consistency), flood the OUTSIDE in from the region
 * border with 4-connectivity — so a diagonal wall run still seals — and
 * whatever is left unreached and not itself a wall is interior.
 *
 * Buildings crossing a region edge are counted but flagged: their ring is
 * incomplete in this region, so their "interior" can leak to the outside.
 */
import { promises as fs } from 'node:fs'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64
const PLANES = 4
const PLANE_TILES = SIZE * SIZE
const idx = (p: number, x: number, y: number) => p * PLANE_TILES + x * SIZE + y

const isWall = (t: number) => (t >= 0 && t <= 3) || t === 9
const isRoof = (t: number) => t >= 12 && t <= 21
const isFloorDecor = (t: number) => t === 22
const isScenery = (t: number) => t >= 10 && t <= 11

function b64(s: string | undefined, expect: number): Uint8Array | null {
  if (!s) return null
  try {
    const b = Buffer.from(s, 'base64')
    return b.length === expect ? new Uint8Array(b) : null
  } catch { return null }
}

type Acc = {
  interior: number
  overlay: number
  underlay: number
  height: number
  flag: number
  anyLoc: number
  floorDecor: number
  scenery: number
  roofHere: number
  /** for plane>0: interior tile that is also interior on the plane below */
  containedBelow: number
  /** for plane>0: interior tile with a roof loc on the plane BELOW (H3) */
  roofBelow: number
  overlayIds: Map<number, number>
}

const blank = (): Acc => ({
  interior: 0, overlay: 0, underlay: 0, height: 0, flag: 0, anyLoc: 0,
  floorDecor: 0, scenery: 0, roofHere: 0, containedBelow: 0, roofBelow: 0,
  overlayIds: new Map(),
})

/**
 * Pocket size buckets. §6 measured a real building interior at a median of 36
 * tiles, so 9-40 and 41-120 are where actual rooms and halls live; 121+ is a
 * courtyard, a walled compound, or a leak through an incomplete ring.
 */
const BUCKETS = ['1-8 (closet/nook)', '9-40 (room)', '41-120 (hall)', '121+ (compound/leak)']
const bucketOf = (n: number) => (n <= 8 ? 0 : n <= 40 ? 1 : n <= 120 ? 2 : 3)

/** 4-connected flood of the outside; returns interior mask */
function interiorMask(wall: Uint8Array): Uint8Array {
  const outside = new Uint8Array(PLANE_TILES)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const i = x * SIZE + y
    if (outside[i] || wall[i]) return
    outside[i] = 1
    stack.push(i)
  }
  for (let n = 0; n < SIZE; n++) { push(0, n); push(SIZE - 1, n); push(n, 0); push(n, SIZE - 1) }
  while (stack.length) {
    const i = stack.pop()!
    const x = (i / SIZE) | 0, y = i % SIZE
    if (x > 0) push(x - 1, y)
    if (x < SIZE - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < SIZE - 1) push(x, y + 1)
  }
  const inner = new Uint8Array(PLANE_TILES)
  for (let i = 0; i < PLANE_TILES; i++) if (!outside[i] && !wall[i]) inner[i] = 1
  return inner
}

async function main() {
  const overlayDefs = new Map<number, { rgb: number; tex: number }>()
  const odir = `${CACHE}/config/overlays`
  for (const f of await fs.readdir(odir)) {
    if (!f.endsWith('.json')) continue
    try {
      const d = JSON.parse(await fs.readFile(`${odir}/${f}`, 'utf8'))
      overlayDefs.set(d.id, { rgb: d.rgb ?? d.primaryRgb ?? 0, tex: d.texture ?? -1 })
    } catch { /* skip */ }
  }

  const acc = Array.from({ length: PLANES }, () => BUCKETS.map(blank))
  let regions = 0
  /** buildings = connected wall components, per plane, ignoring border-touchers */
  const buildings = [0, 0, 0, 0]

  const dir = `${CACHE}/maps`
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    let d: any
    try { d = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8')) } catch { continue }
    if (!d.hasTerrain) continue
    const over = b64(d.overlayIds, PLANES * PLANE_TILES)
    const under = b64(d.underlayIds, PLANES * PLANE_TILES)
    const flags = b64(d.tileFlags, PLANES * PLANE_TILES)
    const pres = b64(d.heightPresence, (PLANES * PLANE_TILES) / 8)
    if (!over || !under || !flags || !pres) continue
    regions++

    const wall: Uint8Array[] = []
    const locAny: Uint8Array[] = []
    const locFloor: Uint8Array[] = []
    const locScen: Uint8Array[] = []
    const locRoof: Uint8Array[] = []
    for (let p = 0; p < PLANES; p++) {
      wall.push(new Uint8Array(PLANE_TILES)); locAny.push(new Uint8Array(PLANE_TILES))
      locFloor.push(new Uint8Array(PLANE_TILES)); locScen.push(new Uint8Array(PLANE_TILES))
      locRoof.push(new Uint8Array(PLANE_TILES))
    }
    for (const [, type, , x, y, plane] of (d.objects ?? []) as number[][]) {
      if (plane < 0 || plane >= PLANES || x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
      const i = x * SIZE + y
      locAny[plane][i] = 1
      if (isWall(type)) wall[plane][i] = 1
      if (isRoof(type)) locRoof[plane][i] = 1
      if (isFloorDecor(type)) locFloor[plane][i] = 1
      if (isScenery(type)) locScen[plane][i] = 1
    }

    const inner: Uint8Array[] = []
    for (let p = 0; p < PLANES; p++) {
      inner.push(interiorMask(wall[p]))
      // count wall components not touching the border
      const seen = new Uint8Array(PLANE_TILES)
      for (let i = 0; i < PLANE_TILES; i++) {
        if (!wall[p][i] || seen[i]) continue
        let touches = false
        const st = [i]; seen[i] = 1; let n = 0
        while (st.length) {
          const j = st.pop()!; n++
          const x = (j / SIZE) | 0, y = j % SIZE
          if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) touches = true
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
            const k = nx * SIZE + ny
            if (wall[p][k] && !seen[k]) { seen[k] = 1; st.push(k) }
          }
        }
        if (!touches && n >= 4) buildings[p]++
      }
    }

    for (let p = 0; p < PLANES; p++) {
      // Label each interior POCKET so a 12-tile room is not pooled with a
      // castle courtyard. The first pass averaged 79 interior tiles per
      // building against §6's measured median of 36, which is the signature of
      // compounds and courtyards being counted as "inside".
      const pocket = new Int32Array(PLANE_TILES).fill(-1)
      const sizes: number[] = []
      for (let s = 0; s < PLANE_TILES; s++) {
        if (!inner[p][s] || pocket[s] >= 0) continue
        const id = sizes.length
        const st = [s]; pocket[s] = id; let n = 0
        while (st.length) {
          const j = st.pop()!; n++
          const x = (j / SIZE) | 0, y = j % SIZE
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
            const k = nx * SIZE + ny
            if (inner[p][k] && pocket[k] < 0) { pocket[k] = id; st.push(k) }
          }
        }
        sizes.push(n)
      }

      for (let t = 0; t < PLANE_TILES; t++) {
        if (!inner[p][t]) continue
        const a = acc[p][bucketOf(sizes[pocket[t]])]
        const x = (t / SIZE) | 0, y = t % SIZE
        const i = idx(p, x, y)
        a.interior++
        if (over[i]) { a.overlay++; a.overlayIds.set(over[i], (a.overlayIds.get(over[i]) ?? 0) + 1) }
        if (under[i]) a.underlay++
        if ((pres[i >> 3] & (1 << (i & 7))) !== 0) a.height++
        if (flags[i]) a.flag++
        if (locAny[p][t]) a.anyLoc++
        if (locFloor[p][t]) a.floorDecor++
        if (locScen[p][t]) a.scenery++
        if (locRoof[p][t]) a.roofHere++
        if (p > 0) {
          // "Contained" must include sitting over the WALL below, not just over
          // the room below. A storey's outer ring sits directly on the wall
          // beneath it, which is containment, not overhang — scoring it as
          // overhang inflated the rate by roughly half.
          if (inner[p - 1][t] || wall[p - 1][t]) a.containedBelow++
          if (locRoof[p - 1][t]) a.roofBelow++
        }
      }
    }
  }

  const pct = (n: number, dn: number) => dn ? `${((n / dn) * 100).toFixed(1)}%` : '-'
  console.log(`${regions} regions\n`)
  console.log('buildings (enclosed wall components, >=4 tiles, not touching a region edge):')
  console.log(`  plane 0 ${buildings[0]}   plane 1 ${buildings[1]}   plane 2 ${buildings[2]}   plane 3 ${buildings[3]}\n`)

  console.log('=== INTERIOR tiles by pocket size: what do they carry on their OWN plane? ===')
  for (let p = 0; p < PLANES; p++) {
    console.log(`plane ${p}`)
    console.log('  pocket size            interior  overlay underlay   height     flag |  any loc floordec  scenery')
    for (let b = 0; b < BUCKETS.length; b++) {
      const a = acc[p][b]
      if (!a.interior) continue
      console.log(`  ${BUCKETS[b].padEnd(20)} ${String(a.interior).padStart(9)}  ${pct(a.overlay, a.interior).padStart(7)} `
        + `${pct(a.underlay, a.interior).padStart(8)} ${pct(a.height, a.interior).padStart(8)} `
        + `${pct(a.flag, a.interior).padStart(8)} | ${pct(a.anyLoc, a.interior).padStart(8)} `
        + `${pct(a.floorDecor, a.interior).padStart(8)} ${pct(a.scenery, a.interior).padStart(8)}`)
    }
  }

  console.log('\n=== upper-storey interiors vs the storey below ===')
  for (let p = 1; p < PLANES; p++) {
    for (let b = 0; b < BUCKETS.length; b++) {
      const a = acc[p][b]
      if (!a.interior) continue
      console.log(`  plane ${p} ${BUCKETS[b].padEnd(20)}: ${pct(a.containedBelow, a.interior).padStart(6)} over a plane-${p - 1} interior `
        + `(overhang ${pct(a.interior - a.containedBelow, a.interior)}), roof below ${pct(a.roofBelow, a.interior)}`)
    }
  }

  console.log('\n=== commonest overlay on a ROOM floor (9-120 tile pockets) ===')
  for (const p of [0, 1, 2]) {
    const merged = new Map<number, number>()
    for (const b of [1, 2]) for (const [id, n] of acc[p][b].overlayIds) merged.set(id, (merged.get(id) ?? 0) + n)
    const top = [...merged.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
    console.log(`  plane ${p}: ` + top.map(([id, n]) => {
      const def = overlayDefs.get(id - 1)
      return `${id}${def ? `(#${(def.rgb >>> 0).toString(16).padStart(6, '0')}${def.tex >= 0 ? ` tex${def.tex}` : ''})` : ''} x${n}`
    }).join('  '))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
