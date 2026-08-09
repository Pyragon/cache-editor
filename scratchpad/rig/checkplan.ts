/**
 * Run an authored procgen/plan.json through the real sanitizer and generator
 * before handing it over, so a plan is never given to someone untested.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex } from '../../src/procgen/scenery'
import { generate } from '../../src/procgen/generate'
import { sanitizePlan } from '../../src/procgen/claude'
import type { ProcPlan } from '../../src/procgen/types'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const PLAN = `${CACHE}/procgen/plan.json`

async function main() {
  const root = dirHandle(CACHE)
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  const byId = new Map<number, string>()
  for (const [sp, entries] of Object.entries(index.species)) {
    for (const e of entries ?? []) byId.set(e.id, sp)
  }

  const raw = JSON.parse(await fs.readFile(PLAN, 'utf8')) as ProcPlan
  const { plan, notes } = sanitizePlan(raw)
  console.log(`plan: ${plan.description}`)
  for (const n of notes) console.log(`  SANITIZER: ${n}`)

  const run = () => generate(plan, index, contextModel)
  const a = run()
  const b = run()

  let placements = 0, water = 0, uw = 0
  const mix = new Map<string, number>()
  const planes = [0, 0, 0, 0]
  for (const locs of a.objects.values()) {
    for (const l of locs) {
      placements++
      planes[l[5]]++
      if (l[5] !== 0) continue
      const s = byId.get(l[0]) ?? `?${l[0]}`
      mix.set(s, (mix.get(s) ?? 0) + 1)
    }
  }
  // The reported bug: a route ran out to sea. Water overwrites the path OVERLAY
  // during the ground paint, so what shows is the path's bare underlay under a
  // water tile — the brown stair-step triangles in the screenshot. Count them.
  const waterByte = 111 + 1
  const trackByte = (raw.paths?.openUnderlayId ?? -1) + 1
  const townByte = (raw.paths?.underlayId ?? -1) + 1
  let pathInWater = 0
  for (const t of a.terrain.values()) {
    for (let i = 0; i < t.overlayIds.length; i++) {
      if (t.overlayIds[i] !== waterByte) continue
      water++
      if (t.underlayIds[i] === trackByte || t.underlayIds[i] === townByte) pathInWater++
    }
  }
  uw = a.underwater.size
  console.log(`\nPATH TILES IN WATER: ${pathInWater}  ${pathInWater === 0 ? '(clean)' : '*** STILL ROUTING INTO THE SEA ***'}`)

  console.log(`\nregions ${a.report.regions}  placements ${placements}  canopies ${a.report.canopies ?? 0}`)
  console.log(`planes: p0 ${planes[0]}  p1 ${planes[1]}  p2 ${planes[2]}  p3 ${planes[3]}`)
  console.log(`water overlay tiles ${water}   underwater layers written ${uw}`)
  console.log(`zones: ${a.report.zones.map((z) => `${z.id}(${z.kind}) ${z.tiles}t`).join(', ')}`)
  console.log(`plots: ${a.report.plots.length}`)
  if (a.report.unresolved.length) console.log(`UNRESOLVED: ${a.report.unresolved.join(', ')}`)
  for (const w of a.report.warnings) console.log(`  WARN: ${w}`)

  const total = [...mix.values()].reduce((x, y) => x + y, 0) || 1
  console.log('\nplane-0 species mix:')
  console.log('  ' + [...mix.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([s, c]) => `${s} ${Math.round((c / total) * 100)}%`).join(', '))

  // Does the SHORE actually get a shore? Every land tile touching water should
  // carry the beach material; a height-windowed band cannot guarantee that,
  // because the landform mask clamps `norm` to 0 outside the landmass and the
  // coast can step straight from inland height to sea.
  {
    const W2 = (plan.area.x1 - plan.area.x0 + 1) * 64
    const H2 = (plan.area.y1 - plan.area.y0 + 1) * 64
    const und = new Uint8Array(W2 * H2)
    const ovr = new Uint8Array(W2 * H2)
    for (const [rid, t] of a.terrain) {
      const rx = ((rid >> 8) & 0xff) - plan.area.x0
      const ry = (rid & 0xff) - plan.area.y0
      for (let x = 0; x < 64; x++) {
        for (let y = 0; y < 64; y++) {
          und[(rx * 64 + x) * H2 + (ry * 64 + y)] = t.underlayIds[x * 64 + y]
          ovr[(rx * 64 + x) * H2 + (ry * 64 + y)] = t.overlayIds[x * 64 + y]
        }
      }
    }
    const beachByte = 61 + 1
    const waterByte = 111 + 1
    let shoreTiles = 0
    const got = new Map<number, number>()
    for (let x = 0; x < W2; x++) {
      for (let y = 0; y < H2; y++) {
        const i = x * H2 + y
        if (ovr[i] === waterByte) continue
        let touchesSea = false
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) continue
          if (ovr[nx * H2 + ny] === waterByte) { touchesSea = true; break }
        }
        if (!touchesSea) continue
        shoreTiles++
        got.set(und[i], (got.get(und[i]) ?? 0) + 1)
      }
    }
    const beach = got.get(beachByte) ?? 0
    console.log(`\nSHORE: ${shoreTiles} land tiles touch the sea; ${beach} carry the beach material `
      + `= ${((beach / (shoreTiles || 1)) * 100).toFixed(1)}%`)
    console.log('  what the rest got (underlay byte x count): '
      + [...got.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8).map(([b, c]) => `${b}:${c}`).join('  '))

    // How WIDE is the beach? A one-tile fringe reads as land dropping straight
    // into the sea, however well that single row is painted.
    const dist = new Int32Array(W2 * H2).fill(-1)
    const q: number[] = []
    for (let i = 0; i < dist.length; i++) if (ovr[i] === waterByte) { dist[i] = 0; q.push(i) }
    for (let h = 0; h < q.length; h++) {
      const cur = q[h], cx = Math.floor(cur / H2), cy = cur % H2
      if (dist[cur] > 6) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) continue
        const ni = nx * H2 + ny
        if (dist[ni] !== -1) continue
        dist[ni] = dist[cur] + 1
        q.push(ni)
      }
    }
    const at: { n: number; sand: number }[] = Array.from({ length: 7 }, () => ({ n: 0, sand: 0 }))
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i]
      if (d < 1 || d > 6) continue
      at[d].n++
      if (und[i] === beachByte) at[d].sand++
    }
    console.log('  beach width — share carrying sand, by tiles from the water:')
    console.log('    ' + at.slice(1).map((s, i) => `d${i + 1} ${((s.sand / (s.n || 1)) * 100).toFixed(0)}%`).join('  '))
  }

  // A coarse land map, because zone centres were being chosen blind. The plan's
  // coordinates are area-relative tiles with (0,0) at the SOUTH-WEST, so this
  // prints north at the top to match how it is looked at.
  const W = (plan.area.x1 - plan.area.x0 + 1) * 64
  const H = (plan.area.y1 - plan.area.y0 + 1) * 64
  const wet = new Uint8Array(W * H)
  for (const [rid, t] of a.terrain) {
    const rx = ((rid >> 8) & 0xff) - plan.area.x0
    const ry = (rid & 0xff) - plan.area.y0
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        if (t.overlayIds[x * 64 + y] === 112) wet[(rx * 64 + x) * H + (ry * 64 + y)] = 1
      }
    }
  }
  console.log('\nland map (# land, ~ sea), 8-tile cells, north at top:')
  for (let cy = H / 8 - 1; cy >= 0; cy--) {
    let row = ''
    for (let cx = 0; cx < W / 8; cx++) {
      let w = 0
      for (let x = cx * 8; x < cx * 8 + 8; x++) for (let y = cy * 8; y < cy * 8 + 8; y++) w += wet[x * H + y]
      row += w > 32 ? '~' : w > 6 ? '+' : '#'
    }
    console.log(`  y=${String(cy * 8).padStart(3)} ${row}`)
  }
  console.log(`        ${Array.from({ length: W / 8 }, (_, i) => (i % 10 === 0 ? '|' : ' ')).join('')}`)
  console.log(`        x=0, each cell 8 tiles`)

  // determinism
  let same = a.report.placements === b.report.placements
  for (const [id, locs] of a.objects) {
    const other = b.objects.get(id)
    if (!other || other.length !== locs.length) { same = false; break }
  }
  console.log(`\ndeterministic across two runs: ${same ? 'YES' : 'NO ***'}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
