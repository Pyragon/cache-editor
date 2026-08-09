/**
 * Is 29018 a COMPOSITION PIECE — something authored to sit in a row with copies
 * of itself, useless alone?
 *
 * It survives every statistical gate honestly: 7 of its 16 placements really are
 * on dirt, the ground our plan paints. So underlay cannot rule it out, and
 * §12a's lesson applies — "usage says the game places a thing, never that it
 * can stand on its own" (the same trap as the fishing ledges).
 *
 * The testable property: a piece that only reads as part of a group should be
 * placed ADJACENT TO ITSELF far more often than an ordinary standalone rock.
 */
import { promises as fs } from 'node:fs'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64
const WATCH = new Set([29018, 41582, 19205, 2509, 444, 445, 60271, 60272, 441, 10947, 5606, 5039])

async function main() {
  const names = new Map<number, string>()
  const odir = `${CACHE}/objects`
  const ofiles = await fs.readdir(odir)
  for (let i = 0; i < ofiles.length; i += 512) {
    await Promise.all(ofiles.slice(i, i + 512).map(async (f) => {
      if (!f.endsWith('.json')) return
      try {
        const d = JSON.parse(await fs.readFile(`${odir}/${f}`, 'utf8'))
        if (WATCH.has(d.id)) names.set(d.id, d.name as string)
      } catch { /* skip */ }
    }))
  }

  /** id -> { total, withSelfNeighbour } */
  const stat = new Map<number, { total: number; adj: number; runMax: number }>()
  const dir = `${CACHE}/maps`
  for (const f of (await fs.readdir(dir)).filter((n) => n.endsWith('.json'))) {
    let d: any
    try { d = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8')) } catch { continue }
    if (!d.objects?.length) continue
    /** id -> set of packed tiles, per plane */
    const byId = new Map<number, Set<number>>()
    for (const [id, , , x, y, plane] of d.objects as number[][]) {
      if (!WATCH.has(id)) continue
      const key = plane * 4096 + x * SIZE + y
      let s = byId.get(id)
      if (!s) { s = new Set(); byId.set(id, s) }
      s.add(key)
    }
    for (const [id, tiles] of byId) {
      let st = stat.get(id)
      if (!st) { st = { total: 0, adj: 0, runMax: 0 }; stat.set(id, st) }
      for (const t of tiles) {
        st.total++
        const x = ((t % 4096) / SIZE) | 0, y = t % SIZE, p = (t / 4096) | 0
        let touching = false
        for (let dx = -2; dx <= 2 && !touching; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            if (!dx && !dy) continue
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
            if (tiles.has(p * 4096 + nx * SIZE + ny)) { touching = true; break }
          }
        }
        if (touching) st.adj++
      }
      // longest run of this id in one region, as a cluster-size proxy
      st.runMax = Math.max(st.runMax, tiles.size)
    }
  }

  console.log('   id  placements  next-to-itself  biggest cluster in one region  name')
  const rows = [...stat.entries()].sort((a, b) => (b[1].adj / b[1].total) - (a[1].adj / a[1].total))
  for (const [id, s] of rows) {
    console.log(`${String(id).padStart(6)}  ${String(s.total).padStart(10)}  `
      + `${((s.adj / s.total) * 100).toFixed(1).padStart(13)}%  ${String(s.runMax).padStart(28)}  `
      + `${names.get(id) ?? '?'}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
