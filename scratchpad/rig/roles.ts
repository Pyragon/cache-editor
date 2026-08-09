/**
 * Does moving the built-in themes from species lists to ROLES change what they
 * plant, and how? Runs the real `buildPlan` from before and after the change
 * through the real `generate`, against the real cache, on the same seed and the
 * same mined index.
 *
 * NOTE: this entry needs a `src/procgen/plannerBefore.ts` to compare against,
 * which is deleted after each use (it is a snapshot, not a source file). To run
 * this again, recreate it from whichever revision is the "before":
 *
 *     git show <rev>:src/procgen/planner.ts > src/procgen/plannerBefore.ts
 *
 * ...then delete it again. The other entries have no such dependency.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { buildSceneryIndex, type SceneryIndex } from '../../src/procgen/scenery'
import { buildPlan, THEMES, DEFAULT_DIALS, type ThemeId } from '../../src/procgen/planner'
import { buildPlan as buildPlanBefore } from '../../src/procgen/plannerBefore'
import { generate } from '../../src/procgen/generate'
import { sanitizePlan } from '../../src/procgen/claude'
import type { ContextModel } from '../../src/procgen/context'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const AREA = { x0: 50, y0: 50, x1: 51, y1: 51 } // 2x2 regions
const SEED = 20260808

function speciesById(index: SceneryIndex) {
  const map = new Map<number, string>()
  for (const [species, entries] of Object.entries(index.species)) {
    for (const e of entries ?? []) map.set(e.id, species)
  }
  return map
}

type Run = { placements: number; mix: Map<string, number>; warnings: string[]; unresolved: string[] }

function run(
  make: typeof buildPlan, theme: ThemeId, index: SceneryIndex, model: ContextModel | null,
  byId: Map<number, string>,
): Run {
  const plan = sanitizePlan(make({ ...DEFAULT_DIALS, theme, seed: SEED }, AREA)).plan
  const res = generate(plan, index, model)
  const mix = new Map<string, number>()
  let placements = 0
  for (const locs of res.objects.values()) {
    for (const l of locs) {
      placements++
      // A placement is [objectId, type, rotation, x, y, plane]. Count the MIX
      // on plane 0 only: a tropical tree is four locs and an oak two, so
      // counting every loc over-represents multi-part species several times
      // over and says nothing about how many trees there actually are.
      if (l[5] !== 0) continue
      const s = byId.get(l[0]) ?? `?${l[0]}`
      mix.set(s, (mix.get(s) ?? 0) + 1)
    }
  }
  return { placements, mix, warnings: res.report.warnings, unresolved: res.report.unresolved }
}

function top(mix: Map<string, number>, n = 6) {
  const total = [...mix.values()].reduce((a, b) => a + b, 0) || 1
  return [...mix.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([s, c]) => `${s} ${Math.round((c / total) * 100)}%`)
    .join(', ')
}

async function main() {
  const root = dirHandle(CACHE)
  const t0 = Date.now()
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'),
    'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  console.log(`mine: ${((Date.now() - t0) / 1000).toFixed(1)}s, `
    + `${Object.keys(index.species).length} species, weighted=${index.weighted}, `
    + `context=${contextModel ? Object.keys(contextModel.objects).length : 0} objects`)
  const byId = speciesById(index)

  console.log('\n=== per theme: BEFORE (species lists) vs AFTER (roles) ===')
  for (const t of THEMES) {
    const b = run(buildPlanBefore as typeof buildPlan, t.id, index, contextModel, byId)
    const a = run(buildPlan, t.id, index, contextModel, byId)
    const a2 = run(buildPlan, t.id, index, contextModel, byId)
    const det = a.placements === a2.placements && top(a.mix, 999) === top(a2.mix, 999)
    console.log(`\n${t.id}  ${b.placements} -> ${a.placements} placements${det ? '' : '  *** NON-DETERMINISTIC ***'}`)
    console.log(`  before: ${top(b.mix)}`)
    console.log(`  after : ${top(a.mix)}`)
    if (a.unresolved.length) console.log(`  unresolved: ${a.unresolved.join(', ')}`)
    for (const w of a.warnings) console.log(`  warn: ${w}`)
    if (!a.placements) console.log('  *** THEME PLANTS NOTHING ***')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
