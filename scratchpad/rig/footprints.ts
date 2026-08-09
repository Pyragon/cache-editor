/**
 * §8.3 — the FOOTPRINT VOCABULARY. What shapes are real buildings, and how do
 * those shapes compose?
 *
 * This is what layer 1 needs. §6's warning is the reason it exists: growing a
 * building by "place a wall next to another, maybe diagonal" is local accretion,
 * and local accretion makes amoebas. Real RS buildings are rectilinear masses
 * with wings, and that comes from a GLOBAL decision — so layer 1 has to sample
 * from a measured vocabulary of rectangles rather than grow one tile at a time.
 *
 * A building here is a connected wall component that ENCLOSES something. That
 * filter matters: §7 counted 27,625 wall components, but 10,755 of them are
 * fence ends and fragments. Requiring at least one enclosed interior tile keeps
 * buildings and drops field boundaries.
 *
 * Footprint = the component's wall tiles + every interior pocket it encloses.
 * Decomposition is greedy maximal-rectangle: take the biggest all-footprint
 * rectangle, remove it, repeat. Greedy is not the minimum partition, but it is
 * stable and it answers the question layer 1 actually asks — "what is the core
 * mass, and what gets added to it".
 */
import { promises as fs } from 'node:fs'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64
const PLANE_TILES = SIZE * SIZE
const isWall = (t: number) => (t >= 0 && t <= 3) || t === 9

type Rect = { x: number; y: number; w: number; h: number }

/** largest all-set rectangle in a binary mask, histogram + stack per row */
function largestRect(mask: Uint8Array, W: number, H: number): Rect | null {
  const heights = new Int32Array(W)
  let best: Rect | null = null
  let bestArea = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) heights[x] = mask[x * H + y] ? heights[x] + 1 : 0
    const stack: number[] = []
    for (let x = 0; x <= W; x++) {
      const cur = x === W ? 0 : heights[x]
      while (stack.length && heights[stack[stack.length - 1]] >= cur) {
        const top = stack.pop()!
        const h = heights[top]
        const left = stack.length ? stack[stack.length - 1] + 1 : 0
        const w = x - left
        if (h > 0 && w * h > bestArea) {
          bestArea = w * h
          best = { x: left, y: y - h + 1, w, h }
        }
      }
      stack.push(x)
    }
  }
  return best
}

function decompose(mask: Uint8Array, W: number, H: number, total: number) {
  const work = mask.slice()
  const rects: Rect[] = []
  let covered = 0
  // stop at 8 rectangles or when what is left is scraps: a long tail of 1-tile
  // rectangles says nothing about massing and would dominate the counts
  while (rects.length < 8) {
    const r = largestRect(work, W, H)
    if (!r || r.w * r.h < 2) break
    rects.push(r)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) work[x * H + y] = 0
    covered += r.w * r.h
    if (covered / total >= 0.95) break
  }
  return { rects, covered }
}

function pctl(a: number[], p: number) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  const areaOf: number[] = []
  const fill: number[] = []
  const rectCount = new Map<number, number>()
  const bbox = new Map<string, number>()
  const primary = new Map<string, number>()
  const primaryShare: number[] = []
  const aspect: number[] = []
  /** how the SECOND rectangle sits against the first, for 2-rect buildings */
  const align = { flushCorner: 0, flushBoth: 0, centred: 0, offset: 0, total: 0 }
  let buildings = 0, coverage95 = 0, dropped = 0
  const interiorSize: number[] = []

  const dir = `${CACHE}/maps`
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    let d: any
    try { d = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8')) } catch { continue }
    if (!d.hasTerrain || !d.objects?.length) continue

    const wall = new Uint8Array(PLANE_TILES)
    for (const [, type, , x, y, plane] of d.objects as number[][]) {
      if (plane !== 0 || x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
      if (isWall(type)) wall[x * SIZE + y] = 1
    }

    // outside flood (4-conn) → interior pockets
    const outside = new Uint8Array(PLANE_TILES)
    const st: number[] = []
    const push = (x: number, y: number) => {
      const i = x * SIZE + y
      if (outside[i] || wall[i]) return
      outside[i] = 1; st.push(i)
    }
    for (let n = 0; n < SIZE; n++) { push(0, n); push(SIZE - 1, n); push(n, 0); push(n, SIZE - 1) }
    while (st.length) {
      const i = st.pop()!, x = (i / SIZE) | 0, y = i % SIZE
      if (x > 0) push(x - 1, y); if (x < SIZE - 1) push(x + 1, y)
      if (y > 0) push(x, y - 1); if (y < SIZE - 1) push(x, y + 1)
    }

    // wall components (8-conn), labelled so a pocket can name its owner
    const compId = new Int32Array(PLANE_TILES).fill(-1)
    const comps: number[][] = []
    const compBorder: boolean[] = []
    for (let s = 0; s < PLANE_TILES; s++) {
      if (!wall[s] || compId[s] >= 0) continue
      const id = comps.length
      const comp: number[] = [s]; compId[s] = id
      const stack = [s]
      let touchesBorder = false
      while (stack.length) {
        const j = stack.pop()!, x = (j / SIZE) | 0, y = j % SIZE
        if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) touchesBorder = true
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          const k = nx * SIZE + ny
          if (wall[k] && compId[k] < 0) { compId[k] = id; comp.push(k); stack.push(k) }
        }
      }
      comps.push(comp); compBorder.push(touchesBorder)
    }

    // Each interior pocket belongs to the component that SOLELY bounds it.
    // Absorbing every adjacent pocket was the bug: a town wall then swallows the
    // courtyard it shares with the houses inside it, and one "building" comes
    // out 60x60. A pocket bounded by two components is shared ground and
    // belongs to neither.
    const pocketOf = new Int32Array(PLANE_TILES).fill(-1)
    const owned = new Map<number, number[]>()
    for (let s = 0; s < PLANE_TILES; s++) {
      if (wall[s] || outside[s] || pocketOf[s] >= 0) continue
      const tiles: number[] = [s]; pocketOf[s] = 1
      const stack = [s]
      const bounds = new Set<number>()
      while (stack.length) {
        const j = stack.pop()!, x = (j / SIZE) | 0, y = j % SIZE
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          const k = nx * SIZE + ny
          if (wall[k]) { bounds.add(compId[k]); continue }
          if (!outside[k] && pocketOf[k] < 0 && Math.abs(dx) + Math.abs(dy) === 1) {
            pocketOf[k] = 1; tiles.push(k); stack.push(k)
          }
        }
      }
      if (bounds.size !== 1) continue
      const c = [...bounds][0]
      const cur = owned.get(c)
      if (cur) cur.push(...tiles); else owned.set(c, tiles)
    }

    for (let id = 0; id < comps.length; id++) {
      if (compBorder[id]) continue
      const comp = comps[id]
      const inner = owned.get(id)
      // a building ENCLOSES something; a fence line does not
      if (!inner?.length) continue
      // ...and a building's interior is proportional to its wall. A ring of 200
      // wall tiles around 3,000 empty ones is a town wall or a cave system, not
      // a building. Real houses run well under 6.
      if (inner.length / comp.length > 6) { dropped++; continue }
      const foot = new Set<number>([...comp, ...inner])
      if (foot.size < 6) continue
      buildings++
      interiorSize.push(inner.length)

      let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1
      for (const j of foot) {
        const x = (j / SIZE) | 0, y = j % SIZE
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
      const W = maxX - minX + 1, H = maxY - minY + 1
      const mask = new Uint8Array(W * H)
      for (const j of foot) {
        const x = ((j / SIZE) | 0) - minX, y = (j % SIZE) - minY
        mask[x * H + y] = 1
      }
      areaOf.push(foot.size)
      fill.push(foot.size / (W * H))
      const lo = Math.min(W, H), hi = Math.max(W, H)
      bbox.set(`${lo}x${hi}`, (bbox.get(`${lo}x${hi}`) ?? 0) + 1)
      aspect.push(hi / lo)

      const { rects, covered } = decompose(mask, W, H, foot.size)
      rectCount.set(rects.length, (rectCount.get(rects.length) ?? 0) + 1)
      if (covered / foot.size >= 0.95) coverage95++
      if (rects.length) {
        const r0 = rects[0]
        const rlo = Math.min(r0.w, r0.h), rhi = Math.max(r0.w, r0.h)
        primary.set(`${rlo}x${rhi}`, (primary.get(`${rlo}x${rhi}`) ?? 0) + 1)
        primaryShare.push((r0.w * r0.h) / foot.size)
      }
      if (rects.length === 2) {
        const [a, b] = rects
        align.total++
        // does the wing share a full edge span with the core, and is it flush
        // at one end, both ends, or floating in the middle?
        const sameX = b.x === a.x, sameXend = b.x + b.w === a.x + a.w
        const sameY = b.y === a.y, sameYend = b.y + b.h === a.y + a.h
        const flushX = sameX || sameXend, flushY = sameY || sameYend
        if ((sameX && sameXend) || (sameY && sameYend)) align.flushBoth++
        else if (flushX || flushY) align.flushCorner++
        else if (b.x > a.x && b.x + b.w < a.x + a.w) align.centred++
        else if (b.y > a.y && b.y + b.h < a.y + a.h) align.centred++
        else align.offset++
      }
    }
  }

  console.log(`${buildings} enclosing buildings on plane 0 (${dropped} dropped as compounds: interior/wall > 6)\n`)

  // §6 measured 1,190 buildings with a resolvable interior at a MEDIAN OF 36
  // interior tiles. That is the calibration target for this extractor — the
  // first version of it reported a median footprint of 178 and 593 buildings at
  // exactly 14x14, which is what a leaking flood fill looks like.
  console.log('=== interior size (calibration: §6 measured median 36) ===')
  console.log(`  p25 ${pctl(interiorSize, 25)}  p50 ${pctl(interiorSize, 50)}  `
    + `p75 ${pctl(interiorSize, 75)}  p90 ${pctl(interiorSize, 90)} tiles`)

  console.log('\n=== footprint area (walls + interior) ===')
  console.log(`  p10 ${pctl(areaOf, 10)}  p25 ${pctl(areaOf, 25)}  p50 ${pctl(areaOf, 50)}  `
    + `p75 ${pctl(areaOf, 75)}  p90 ${pctl(areaOf, 90)}  p99 ${pctl(areaOf, 99)} tiles`)

  console.log('\n=== how RECTANGULAR is a footprint? (footprint area / bounding box area) ===')
  const f = (p: number) => pctl(fill, p).toFixed(2)
  console.log(`  p10 ${f(10)}  p25 ${f(25)}  p50 ${f(50)}  p75 ${f(75)}  p90 ${f(90)}`)
  console.log(`  exactly 1.00 (a plain rectangle): ${(fill.filter((v) => v >= 0.999).length / fill.length * 100).toFixed(1)}%`)
  console.log(`  >= 0.90:                          ${(fill.filter((v) => v >= 0.90).length / fill.length * 100).toFixed(1)}%`)

  console.log('\n=== greedy rectangle decomposition ===')
  const totalB = [...rectCount.values()].reduce((a, b) => a + b, 0)
  for (const n of [...rectCount.keys()].sort((a, b) => a - b)) {
    console.log(`  ${n} rect${n === 1 ? ' ' : 's'}: ${String(rectCount.get(n)).padStart(6)}  ${((rectCount.get(n)! / totalB) * 100).toFixed(1)}%`)
  }
  console.log(`  reached 95% coverage within 8 rects: ${((coverage95 / totalB) * 100).toFixed(1)}%`)
  console.log(`  primary rect as a share of the footprint: p25 ${pctl(primaryShare, 25).toFixed(2)}  `
    + `p50 ${pctl(primaryShare, 50).toFixed(2)}  p75 ${pctl(primaryShare, 75).toFixed(2)}`)

  console.log('\n=== commonest bounding boxes (short x long) ===')
  console.log('  ' + [...bbox.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => `${k} x${n}`).join('   '))
  console.log(`  aspect ratio (long/short): p50 ${pctl(aspect, 50).toFixed(2)}  p90 ${pctl(aspect, 90).toFixed(2)}`)

  console.log('\n=== commonest PRIMARY rectangle (the core mass) ===')
  console.log('  ' + [...primary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => `${k} x${n}`).join('   '))

  console.log('\n=== how a WING sits against the core (2-rect buildings) ===')
  const t = align.total || 1
  console.log(`  ${align.total} two-rect buildings`)
  console.log(`  flush at BOTH ends (full-width extension): ${((align.flushBoth / t) * 100).toFixed(1)}%`)
  console.log(`  flush at ONE end (corner-aligned wing):    ${((align.flushCorner / t) * 100).toFixed(1)}%`)
  console.log(`  centred on the core:                       ${((align.centred / t) * 100).toFixed(1)}%`)
  console.log(`  offset / overhanging:                      ${((align.offset / t) * 100).toFixed(1)}%`)
}

main().catch((e) => { console.error(e); process.exit(1) })
