/**
 * §8.1 — how does the cache represent an UPPER-STOREY FLOOR?
 *
 * Cody's position, and it is the right starting point: everything about what is
 * placed where, including planes 1-3, is in the cache; stairs-to-destination is
 * server logic we will never need. So this measures the cache first, and the
 * client is only consulted for whatever comes back unexplained (realistically,
 * the meaning of individual tile-flag bits, which data can never tell you).
 *
 * The decisive test is a CONTRAST: take tiles that are definitely part of an
 * upper storey (they carry a loc on that plane) against tiles on the same plane
 * that are open air, and see what the storey tiles carry that the air tiles do
 * not — underlay, overlay, a stored height, a flag bit.
 *
 * Region JSON is parsed properly here rather than regex-scraped. The scrape in
 * `scenery.ts` exists for speed over 2,413 files and carries a documented
 * escaping trap (Gson writes base64 `=` padding as an entity); a full parse has
 * no such failure mode, and correctness matters more than seconds for a one-off.
 */
import { promises as fs } from 'node:fs'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64
const PLANES = 4
const PLANE_TILES = SIZE * SIZE
const idx = (p: number, x: number, y: number) => p * PLANE_TILES + x * SIZE + y

/** loc `type` (shape) → placement slot; 0-3 and 9 are walls, 10-21 scenery/roof */
const isWall = (t: number) => (t >= 0 && t <= 3) || t === 9
const isRoof = (t: number) => t >= 12 && t <= 21

function b64(s: string | undefined, expect: number): Uint8Array | null {
  if (!s) return null
  try {
    const bin = Buffer.from(s, 'base64')
    return bin.length === expect ? new Uint8Array(bin) : null
  } catch { return null }
}

type Acc = {
  /** tiles on this plane carrying at least one loc */
  withLoc: number
  withLocUnderlay: number
  withLocOverlay: number
  withLocHeight: number
  withLocFlag: number
  /** tiles on this plane carrying no loc at all */
  noLoc: number
  noLocUnderlay: number
  noLocOverlay: number
  noLocHeight: number
  noLocFlag: number
  /** bit -> count, over all tiles on this plane */
  bits: number[]
  flagValues: Map<number, number>
  tiles: number
}

const blank = (): Acc => ({
  withLoc: 0, withLocUnderlay: 0, withLocOverlay: 0, withLocHeight: 0, withLocFlag: 0,
  noLoc: 0, noLocUnderlay: 0, noLocOverlay: 0, noLocHeight: 0, noLocFlag: 0,
  bits: new Array(8).fill(0), flagValues: new Map(), tiles: 0,
})

async function objectNames(): Promise<Map<number, string>> {
  const dir = `${CACHE}/objects`
  const names = new Map<number, string>()
  const files = await fs.readdir(dir)
  const CHUNK = 512
  for (let i = 0; i < files.length; i += CHUNK) {
    await Promise.all(files.slice(i, i + CHUNK).map(async (f) => {
      if (!f.endsWith('.json')) return
      try {
        const d = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8'))
        if (d.name && d.name !== 'null') names.set(d.id, d.name as string)
      } catch { /* skip */ }
    }))
  }
  return names
}

async function main() {
  console.log('reading object names...')
  const names = await objectNames()
  const stairIds = new Set<number>()
  for (const [id, n] of names) {
    if (/\b(stair|staircase|stairs|ladder|steps)\b/i.test(n)) stairIds.add(id)
  }
  console.log(`${names.size} named objects, ${stairIds.size} stair/ladder-like ids\n`)

  const acc = Array.from({ length: PLANES }, blank)
  /** stair loc at plane p: what does the tile directly above carry? */
  const above = {
    total: 0, hasLocAbove: 0, hasUnderlayAbove: 0, hasOverlayAbove: 0,
    hasHeightAbove: 0, hasFlagAbove: 0, topPlane: 0,
  }
  /** how often a plane-1 tile with a loc also has a plane-0 loc under it */
  let p1WithLoc = 0, p1OverP0Loc = 0

  const dir = `${CACHE}/maps`
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  let done = 0, withTerrain = 0
  for (const f of files) {
    let d: any
    try { d = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8')) } catch { continue }
    done++
    if (!d.hasTerrain) continue
    const under = b64(d.underlayIds, PLANES * PLANE_TILES)
    const over = b64(d.overlayIds, PLANES * PLANE_TILES)
    const flags = b64(d.tileFlags, PLANES * PLANE_TILES)
    const pres = b64(d.heightPresence, (PLANES * PLANE_TILES) / 8)
    if (!under || !over || !flags || !pres) continue
    withTerrain++

    const locAt: Set<number>[] = [new Set(), new Set(), new Set(), new Set()]
    for (const [, type, , x, y, plane] of (d.objects ?? []) as number[][]) {
      if (plane >= 0 && plane < PLANES) locAt[plane].add(x * SIZE + y)
      void type
    }

    for (let p = 0; p < PLANES; p++) {
      const a = acc[p]
      for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
          const i = idx(p, x, y)
          a.tiles++
          const fl = flags[i]
          if (fl) {
            a.flagValues.set(fl, (a.flagValues.get(fl) ?? 0) + 1)
            for (let b = 0; b < 8; b++) if (fl & (1 << b)) a.bits[b]++
          }
          const hasH = (pres[i >> 3] & (1 << (i & 7))) !== 0
          if (locAt[p].has(x * SIZE + y)) {
            a.withLoc++
            if (under[i]) a.withLocUnderlay++
            if (over[i]) a.withLocOverlay++
            if (hasH) a.withLocHeight++
            if (fl) a.withLocFlag++
            if (p === 1) { p1WithLoc++; if (locAt[0].has(x * SIZE + y)) p1OverP0Loc++ }
          } else {
            a.noLoc++
            if (under[i]) a.noLocUnderlay++
            if (over[i]) a.noLocOverlay++
            if (hasH) a.noLocHeight++
            if (fl) a.noLocFlag++
          }
        }
      }
    }

    // stair alignment: is there anything on the plane above a staircase?
    for (const [id, type, , x, y, plane] of (d.objects ?? []) as number[][]) {
      if (!stairIds.has(id)) continue
      void type
      above.total++
      const up = plane + 1
      if (up >= PLANES) { above.topPlane++; continue }
      const i = idx(up, x, y)
      if (locAt[up].has(x * SIZE + y)) above.hasLocAbove++
      if (under[i]) above.hasUnderlayAbove++
      if (over[i]) above.hasOverlayAbove++
      if ((pres[i >> 3] & (1 << (i & 7))) !== 0) above.hasHeightAbove++
      if (flags[i]) above.hasFlagAbove++
    }
  }

  const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : '-'
  console.log(`${done} regions read, ${withTerrain} with decodable terrain\n`)

  console.log('=== does a tile carrying a loc on plane N also carry TERRAIN there? ===')
  console.log('plane |   tiles w/loc  underlay  overlay   height    flag | tiles w/o loc  underlay  overlay   height    flag')
  for (let p = 0; p < PLANES; p++) {
    const a = acc[p]
    console.log(
      `  ${p}   | ${String(a.withLoc).padStart(12)}  ${pct(a.withLocUnderlay, a.withLoc).padStart(7)}  `
      + `${pct(a.withLocOverlay, a.withLoc).padStart(7)}  ${pct(a.withLocHeight, a.withLoc).padStart(7)}  `
      + `${pct(a.withLocFlag, a.withLoc).padStart(6)} | ${String(a.noLoc).padStart(12)}  `
      + `${pct(a.noLocUnderlay, a.noLoc).padStart(7)}  ${pct(a.noLocOverlay, a.noLoc).padStart(7)}  `
      + `${pct(a.noLocHeight, a.noLoc).padStart(7)}  ${pct(a.noLocFlag, a.noLoc).padStart(6)}`)
  }

  console.log('\n=== tileFlags bit census, share of all tiles on that plane ===')
  console.log('plane |    bit0    bit1    bit2    bit3    bit4    bit5    bit6    bit7')
  for (let p = 0; p < PLANES; p++) {
    const a = acc[p]
    console.log(`  ${p}   | ` + a.bits.map((n) => pct(n, a.tiles).padStart(7)).join(' '))
  }

  console.log('\n=== commonest whole tileFlags values, per plane ===')
  for (let p = 0; p < PLANES; p++) {
    const topv = [...acc[p].flagValues.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)
      .map(([v, n]) => `0x${v.toString(16)} (${n})`).join('  ')
    console.log(`  plane ${p}: ${topv || '(none)'}`)
  }

  console.log('\n=== the tile directly ABOVE a staircase/ladder ===')
  console.log(`  ${above.total} stair/ladder placements (${above.topPlane} on the top plane, skipped)`)
  const n = above.total - above.topPlane
  console.log(`  has a loc above:      ${pct(above.hasLocAbove, n)}`)
  console.log(`  has an underlay:      ${pct(above.hasUnderlayAbove, n)}`)
  console.log(`  has an overlay:       ${pct(above.hasOverlayAbove, n)}`)
  console.log(`  has a stored height:  ${pct(above.hasHeightAbove, n)}`)
  console.log(`  has a tile flag:      ${pct(above.hasFlagAbove, n)}`)

  console.log(`\n=== plane-1 tiles with a loc: ${pct(p1OverP0Loc, p1WithLoc)} also have a plane-0 loc beneath`)
  void isWall; void isRoof
}

main().catch((e) => { console.error(e); process.exit(1) })
