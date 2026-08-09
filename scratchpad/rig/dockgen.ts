/**
 * DOCKS end to end: mine the real cache, then build a fishing village and check
 * a jetty actually came out of it.
 *
 * Goes through the REAL `buildSceneryIndex`, `buildPlan`, `sanitizePlan` and
 * `generate` — not a reimplementation. `docs/map-learning.md` §11 is the reason
 * that matters: five attempts at the canopy height each "passed" a check that
 * tested something other than what the renderer calls.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { buildSceneryIndex } from '../../src/procgen/scenery'
import { tileIndex } from '../../src/loaders/maps'
import { buildPlan, DEFAULT_DIALS, THEMES, type ThemeId } from '../../src/procgen/planner'
import { generate } from '../../src/procgen/generate'
import { sanitizePlan } from '../../src/procgen/claude'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const AREA = { x0: 50, y0: 50, x1: 51, y1: 51 } // 2x2 regions
const SEED = 20260809

async function main() {
  const root = dirHandle(CACHE)
  const t0 = Date.now()
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'),
    'rig-docks',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  console.log(`mine: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

  const dm = index.docks
  if (!dm) { console.log('NO DOCK MODEL MINED — everything below is moot'); return }
  console.log('=== the mined dock model ===')
  console.log(`  piers ${dm.piers}   bare rate ${(dm.bareRate * 100).toFixed(0)}%`)
  console.log(`  families ${dm.families.length}   parts ${Object.keys(dm.parts).length}   trim ${dm.trim.length}`)
  const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1] }
  console.log(`  walkway widths: median ${med(dm.widths)}  range ${Math.min(...dm.widths)}-${Math.max(...dm.widths)}`)
  console.log(`  lengths:        median ${med(dm.lengths)}  range ${Math.min(...dm.lengths)}-${Math.max(...dm.lengths)}`)
  console.log('  top families:')
  for (const f of dm.families.slice(0, 6)) {
    console.log(`    x${String(f.piers).padStart(2)} piers, ${String(f.tiles).padStart(4)} tiles  [${f.ids.length}] ${f.ids.join(',')}`)
  }
  console.log('  most positional parts (edge share):')
  const parts = Object.values(dm.parts).filter((p) => p.n >= 20).sort((a, b) => b.n - a.n)
  for (const p of parts.slice(0, 8)) {
    console.log(`    ${String(p.id).padStart(6)}  n ${String(p.n).padStart(5)}  edge ${String(Math.round((p.edge / p.n) * 100)).padStart(3)}%`)
  }
  console.log(`  serialised: ${(JSON.stringify(dm).length / 1024).toFixed(1)} KB`)
  console.log(`  whole index: ${(JSON.stringify(index).length / 1024).toFixed(1)} KB`)

  // --- build a fishing village -------------------------------------------
  console.log('\n=== fishing_village ===')
  const built = sanitizePlan(buildPlan({ ...DEFAULT_DIALS, theme: 'fishing_village', seed: SEED }, AREA))
  if (built.notes.length) console.log('  sanitizer:', built.notes.join(' | '))
  const res = generate(built.plan, index, contextModel)
  console.log(`  placements ${res.report.placements}   docks ${res.report.docks.length}`)
  for (const d of res.report.docks) {
    console.log(`    jetty at (${d.x},${d.y}) dir ${d.dir}  ${d.width} wide x ${d.length} out, ${d.tiles} deck tiles`)
  }
  if (res.report.warnings.length) console.log('  warnings:', res.report.warnings.join(' | '))

  // what the deck is actually made of
  const deckIds = new Set(dm.families.flatMap((f) => f.ids))
  const emitted = new Map<number, number>()
  const trimEmitted = new Map<string, number>()
  const trimIds = new Set(dm.trim.map((t) => t.id))
  for (const locs of res.objects.values()) {
    for (const l of locs) {
      if (deckIds.has(l[0]) && l[1] === 22) emitted.set(l[0], (emitted.get(l[0]) ?? 0) + 1)
      else if (trimIds.has(l[0])) trimEmitted.set(`${l[0]}|${l[1]}`, (trimEmitted.get(`${l[0]}|${l[1]}`) ?? 0) + 1)
    }
  }
  console.log(`  deck locs emitted: ${[...emitted.values()].reduce((a, b) => a + b, 0)}`
    + `  from ${emitted.size} ids -> ${[...emitted.entries()].map(([k, v]) => `${k} x${v}`).join(', ') || '(none)'}`)
  console.log(`  trim locs emitted: ${[...trimEmitted.values()].reduce((a, b) => a + b, 0)}`
    + `  ${[...trimEmitted.entries()].map(([k, v]) => `${k} x${v}`).join(', ') || '(none)'}`)

  // --- the invariant that matters: is the deck OVER WATER? ----------------
  // A jetty on dry land is the failure this whole exercise is about, and it
  // would look plausible in a placement count.
  // NOT "every plank must be over water" — that was the first pass criterion
  // here and it is WRONG. §15 measured the over-water share of a real pier at
  // p50 0.97 and p25 0.69, with only 43% entirely over water: a pier has an
  // apron where it meets the shore. Testing for 100% would have driven a fix
  // for something the map does on purpose. The real invariant is that a jetty
  // is mostly over water, so compare against the measured p25.
  const { deckOnWater, deckOnLand } = auditDeckWater(res, deckIds)
  const share = deckOnWater / Math.max(1, deckOnWater + deckOnLand)
  console.log(`\n  deck tiles over water: ${deckOnWater}   over land: ${deckOnLand}`
    + `   share ${share.toFixed(2)} (real p50 0.97, p25 0.69)`)
  console.log(share >= 0.69 ? '  OK — decks sit over water' : '  *** FAIL: jetties are on the beach ***')

  // --- determinism ---------------------------------------------------------
  const again = generate(built.plan, index, contextModel)
  const a = JSON.stringify([...res.objects.entries()])
  const b = JSON.stringify([...again.objects.entries()])
  console.log(`  deterministic: ${a === b ? 'yes' : '*** NO ***'}`)

  // --- buildings ------------------------------------------------------------
  const bm = index.buildings
  console.log('\n=== the mined building model ===')
  if (!bm) console.log('  NONE MINED')
  else {
    console.log(`  buildings ${bm.buildings}  families ${bm.families.length}  parts ${Object.keys(bm.parts).length}`
      + `  doors ${bm.doors.length}  furniture ${bm.furniture.length}`)
    console.log(`  top families: ${bm.families.slice(0, 4).map((f) => `[${f.ids.length}] x${f.buildings}`).join('  ')}`)
    console.log(`  doors: ${bm.doors.slice(0, 5).map((d) => `${d.id} x${d.n}`).join(', ')}`)
    console.log(`  serialised: ${(JSON.stringify(bm).length / 1024).toFixed(1)} KB`)
  }

  const vp = sanitizePlan(buildPlan({ ...DEFAULT_DIALS, theme: 'village_in_forest', seed: SEED }, AREA))
  const vr = generate(vp.plan, index, contextModel)
  console.log('\n=== village_in_forest: synthesised buildings ===')
  console.log(`  plots ${vr.report.plots.length}  buildings ${vr.report.buildings.length}`)
  for (const b of vr.report.buildings.slice(0, 8)) {
    console.log(`    ${b.w}x${b.h} at (${b.x},${b.y})  ${b.walls} walls, ${b.interior} interior, ${b.furniture} furniture`)
  }
  auditBuildings(vr, bm)

  // --- every theme still generates ----------------------------------------
  console.log('\n=== regression: all themes ===')
  let bad = 0
  for (const t of THEMES) {
    const p = sanitizePlan(buildPlan({ ...DEFAULT_DIALS, theme: t.id as ThemeId, seed: SEED }, AREA)).plan
    const r = generate(p, index, contextModel)
    const flag = r.report.placements === 0 ? ' *** EMPTY ***' : ''
    if (flag) bad++
    const dk = r.report.docks.length ? `  docks ${r.report.docks.length}` : ''
    console.log(`  ${t.id.padEnd(18)} ${String(r.report.placements).padStart(5)} placements${dk}${flag}`)
  }
  console.log(bad ? `  *** ${bad} theme(s) produced nothing ***` : '  all themes generate')
}

/**
 * The structural checks §6 says are non-negotiable. "Imperfect is acceptable"
 * is a licence to ship rough output, NOT broken output — a building with no
 * door is not something you fix by hand across hundreds of them.
 */
function auditBuildings(
  res: ReturnType<typeof generate>,
  bm: NonNullable<ReturnType<typeof buildSceneryIndex> extends Promise<infer R> ? R : never>['index']['buildings'],
) {
  if (!bm) return
  const doorIds = new Set(bm.doors.map((d) => d.id))
  const wallIds = new Set(Object.keys(bm.parts).map(Number))
  const furnIds = new Set(bm.furniture.map((f) => f.id))
  let walls = 0, doors = 0, furniture = 0
  const badRot = new Map<number, number>()
  for (const locs of res.objects.values()) {
    for (const l of locs) {
      const [id, shape, rot] = l
      const isWallShape = (shape >= 0 && shape <= 3) || shape === 9
      if (isWallShape && (wallIds.has(id) || doorIds.has(id))) {
        walls++
        if (doorIds.has(id)) doors++
        if (rot < 0 || rot > 3) badRot.set(id, (badRot.get(id) ?? 0) + 1)
      } else if (furnIds.has(id)) furniture++
    }
  }
  console.log(`  emitted: ${walls} wall locs (${doors} doors), ${furniture} furniture locs`)
  const perBuilding = res.report.buildings.length
  const noDoor = perBuilding && doors < perBuilding
  console.log(`  every building has a door: ${noDoor ? `*** NO — ${doors} doors for ${perBuilding} buildings ***` : 'yes'}`)
  console.log(`  rotations in range 0-3: ${badRot.size ? '*** NO ***' : 'yes'}`)
  // A gap in the perimeter is a hole in the building and is invisible in a
  // placement count. The GENERATOR knows when it could not place a piece, so
  // ask it rather than re-deriving a perimeter formula here — the first version
  // of this check used `2*(w+h)-4`, which is only right for a plain rectangle
  // and reported false failures on every footprint with a wing.
  const gaps = res.report.warnings.filter((w) => w.includes('missing'))
  console.log(`  perimeters complete: ${gaps.length ? `*** ${gaps.length} building(s) with gaps ***` : 'yes'}`)
  for (const g of gaps.slice(0, 3)) console.log(`    ${g}`)
}

/** Re-derive the water mask from the emitted terrain and check every plank. */
function auditDeckWater(
  res: ReturnType<typeof generate>, deckIds: Set<number>,
) {
  // WATER_OVERLAYS is the mine's definition; the generator paints its water
  // band with the palette's water overlay, so read the terrain it wrote rather
  // than trusting either constant.
  let deckOnWater = 0
  let deckOnLand = 0
  for (const [regionId, locs] of res.objects) {
    const terrain = res.terrain.get(regionId)
    const uw = res.underwater.get(regionId)
    if (!terrain) continue
    for (const l of locs) {
      if (!deckIds.has(l[0]) || l[1] !== 22) continue
      // `tileIndex(plane, x, y) = plane*4096 + x*64 + y` (loaders/maps.ts:76)
      const ti = tileIndex(0, l[3], l[4])
      // The underwater layer is written for exactly the water tiles, so its
      // presence bitmask IS the water mask the generator believed in — a
      // better check than re-deriving one, because it catches the generator
      // disagreeing with itself.
      const wet = !!uw && !!(uw.heightPresence[ti >> 3] & (1 << (ti & 7)))
      if (wet) deckOnWater++
      else deckOnLand++
    }
  }
  return { deckOnWater, deckOnLand }
}

main().catch((e) => { console.error(e); process.exit(1) })
