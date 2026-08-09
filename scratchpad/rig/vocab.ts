/**
 * VOCABULARY AUDIT — what does the mine actually choose, after the overworld
 * filter and the spread-based ranking?
 *
 * Written 2026-08-09 against Cody's report that generated buildings were made
 * of dungeon masonry, half the doors were object 3626, and a jetty came out as
 * red slabs plus a map-link anchor.
 *
 * The offline measurement that found the cause is in the scratchpad, but a
 * measurement is not a verification: this runs the REAL `buildSceneryIndex`
 * through the same arguments the panel passes, so what it prints is what the
 * generator will use. Same lesson as §11 — verify through the function that
 * ships, not a reimplementation of it.
 *
 * Set VOCAB_UNFILTERED=1 to omit the areas folder and see the before picture.
 */
import { dirHandle, installShims } from './shim'
import { buildSceneryIndex } from '../../src/procgen/scenery'
import { loadWorldAreas, classifyRegion } from '../../src/procgen/worldAreas'
import { findMarkerObjects, flattenModelIds } from '../../src/procgen/markers'
import { pickWallFamily } from '../../src/procgen/buildings'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'

installShims()

const objectsDir = dirHandle(`${CACHE}/objects`)
const mapsDir = dirHandle(`${CACHE}/maps`)
const areasDir = dirHandle(`${CACHE}/map_areas`)
const modelsDir = dirHandle(`${CACHE}/models`)
const filtered = !process.env.VOCAB_UNFILTERED

/** object id -> name, read straight from the dump for reporting */
const names = new Map<number, string>()
async function nameOf(id: number): Promise<string> {
  if (names.has(id)) return names.get(id)!
  try {
    const t = await (await dirHandle(`${CACHE}/objects`).getFileHandle(`${id}.json`)).getFile()
    const d = JSON.parse(await t.text())
    names.set(id, d.name ?? 'null')
  } catch { names.set(id, '?') }
  return names.get(id)!
}

const areas = await loadWorldAreas(areasDir)
console.log(`world areas: ${areas?.areas.length ?? 0}, surface regions ${areas?.surface.size ?? 0}`)

console.log(`\nbuilding index (${filtered ? 'OVERWORLD ONLY' : 'WHOLE DUMP'})…`)
const t0 = Date.now()
const built = await buildSceneryIndex(
  objectsDir,
  'rig',
  undefined,
  undefined,
  undefined,
  mapsDir,
  undefined,
  filtered ? areasDir : null,
  modelsDir,
)
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`BUILDINGS MINED: ${built.index.buildings?.buildings ?? 0}`)
console.log(`corpus: filtered=${built.corpus.filtered} surface=${built.corpus.surface} `
  + `skipped=${built.corpus.skipped} MARKERS DROPPED=${built.corpus.markersDropped}\n`)

// Independent census: does the marker rule fire at all, and on what? A filter
// that silently matches nothing looks exactly like a clean pass, and a
// `parseModel` that threw on every file would produce precisely that.
{
  const objs = dirHandle(`${CACHE}/objects`)
  const WALLS = new Set([0, 1, 2, 3, 9])
  const modelIds = new Map<number, number[]>()
  const wallish: number[] = []
  for await (const h of objs.values()) {
    if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
    const id = parseInt(h.name.slice(0, -5), 10)
    if (Number.isNaN(id)) continue
    let d: any
    try { d = JSON.parse(await (await h.getFile()).text()) } catch { continue }
    if (!d.objectModelIds || !d.shapes?.some((sh: number) => WALLS.has(sh))) continue
    modelIds.set(id, flattenModelIds(d.objectModelIds))
    wallish.push(id)
  }
  const found = await findMarkerObjects(modelsDir, modelIds, wallish)
  console.log(`marker census: ${wallish.length} wall-capable objects, ${found.size} are pure marker anchors`)
  console.log(`  e.g. ${[...found].slice(0, 12).join(', ')}\n`)
}

const bm = built.index.buildings
const dm = built.index.docks

console.log('=== WALL FAMILIES (as pickWallFamily weights them) ===')
for (const f of (bm?.families ?? []).slice(0, 8)) {
  const ns = await Promise.all(f.ids.slice(0, 4).map(nameOf))
  const doors = Object.keys(f.doors)
  console.log(`  ${String(f.buildings).padStart(4)} bld / ${String(f.regions).padStart(3)} reg  `
    + `${String(f.ids.length).padStart(2)} ids: ${f.ids.slice(0, 6).join(',')}${f.ids.length > 6 ? '…' : ''}  (${ns.join(', ')})`)
  console.log(`        doors: ${doors.length ? doors.join(',') : 'none'}`)
}

console.log('\n=== DOORS (as pickDoorId weights them) ===')
for (const d of bm?.doors ?? []) {
  console.log(`  ${String(d.id).padStart(6)}  ${(await nameOf(d.id)).padEnd(20)} `
    + `${String(d.n).padStart(5)} n / ${String(d.regions).padStart(3)} reg`)
}

// --- end-to-end: are wall ids actually IN the context model, and does the
// family pick change with the ground? A context-conditioned picker returning
// the same family everywhere is the same silent no-op the marker filter
// shipped as first time round.
{
  const cm = built.contextModel
  const famIds = [...new Set((bm?.families ?? []).flatMap((f) => f.ids))]
  const known = famIds.filter((id) => cm?.objects[id])
  console.log(`\ncontext coverage: ${known.length}/${famIds.length} wall-family ids observed`)

  const mkCtx = (underlay: number) => ({ underlay, overlay: 0, height: 40, slope: 2, wall: 0 })
  const tally = (label: string, ctx: any) => {
    const counts = new Map<string, number>()
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 400; i++) {
      const f = pickWallFamily(bm, rnd, cm, ctx)
      if (f) { const k = f.ids.join(','); counts.set(k, (counts.get(k) ?? 0) + 1) }
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)
    console.log(`  ${label.padEnd(20)} -> ${top.map(([k, n]) => `[${k}] ${Math.round(n / 4)}%`).join('   ')}`)
  }
  tally('sand 61 (shore)', mkCtx(61))
  tally('town earth 163', mkCtx(163))
  tally('underlay 100', mkCtx(100))
  tally('snow 25', mkCtx(25))
}

console.log('\n=== DOCK FAMILIES ===')
console.log(`  piers mined ${dm?.piers ?? 0}, bare rate ${(dm?.bareRate ?? 0).toFixed(2)}`)
for (const f of (dm?.families ?? []).slice(0, 8)) {
  const ns = await Promise.all(f.ids.slice(0, 4).map(nameOf))
  console.log(`  ${String(f.piers).padStart(3)} piers / ${String(f.tiles).padStart(5)} tiles  ids ${f.ids.join(',')}  (${ns.join(', ')})`)
}
console.log('\n=== DOCK TRIM ===')
for (const t of (dm?.trim ?? []).slice(0, 10)) {
  console.log(`  ${String(t.id).padStart(6)}  ${(await nameOf(t.id)).padEnd(24)} shape ${t.shape}  ${String(t.n).padStart(4)} n / ${String(t.piers).padStart(3)} piers`)
}

console.log('\n=== INTERIOR VOCABULARY (ranked by distinct buildings) ===')
const furn = bm?.furniture ?? []
for (const cls of ['freestanding', 'wallDecor', 'floor'] as const) {
  const pool = furn.filter((e) => e.cls === cls && !e.role)
  console.log(`  -- ${cls} (${pool.length} kept, fixtures excluded) --`)
  for (const e of pool.slice(0, 10)) {
    const dt = e.d.reduce((a, b) => a + b, 0) || 1
    console.log(`    ${String(e.id).padStart(6)} sh${String(e.shape).padStart(3)} `
      + `${String(e.buildings).padStart(3)}b n${String(e.n).padStart(5)}  `
      + `d[${e.d.map((v) => Math.round((v / dt) * 100)).join('/')}]  ${await nameOf(e.id)}`)
  }
}
const fixtures = furn.filter((e) => e.role)
console.log(`\n  -- PURPOSE FIXTURES: ${fixtures.length} kept, NEVER placed --`)
for (const e of fixtures) {
  console.log(`    ${String(e.id).padStart(6)} ${String(e.role).padEnd(9)} ${String(e.buildings).padStart(3)}b  ${await nameOf(e.id)}`)
}
console.log('\n  building purposes mined:', JSON.stringify(bm?.roles ?? {}))
console.log(`  roof-shaped entries surviving into furniture: `
  + `${furn.filter((e) => e.shape >= 12 && e.shape <= 21).length} (must be 0)`)

// Sanity: is anything in the chosen vocabulary from a non-surface region only?
if (areas) {
  const suspects = [...(bm?.doors ?? []).map((d) => d.id), ...(dm?.families ?? []).flatMap((f) => f.ids)]
  console.log(`\nchosen vocabulary ids: ${suspects.length} (classify spot-check: `
    + `${classifyRegion(areas, 12081)} for Port Sarim 12081)`)
}
