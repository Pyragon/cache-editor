/**
 * Generate the REAL planning brief offline, exactly as the Plan tab would.
 *
 * `planningBrief()` is the same text the API layer sends as its system prompt,
 * so this is the single source of truth about what a planner is supposed to
 * know about this cache — resolved species, ground roles as bound, the role
 * vocabulary, and the mined place types. Writing a plan without reading it means
 * writing against recollection instead of against the cache.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex } from '../../src/procgen/scenery'
import { planningBrief, PROCGEN_DIR, BRIEF_FILE, PLAN_FILE } from '../../src/procgen/claude'
import { DEFAULT_PALETTE } from '../../src/procgen/palette'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
// 1x1. The brief states its own area size, so this must match the area being
// planned or every coordinate instruction in it is for the wrong map.
const AREA = { x0: 0, y0: 0, x1: 0, y1: 0 }

/** Kept verbatim in step with `GeneratePanel.tsx`. */
const PLAN_INSTRUCTION = 'Reply with a single ProcPlan JSON object and nothing else.'

async function main() {
  const root = dirHandle(CACHE)
  // The areas and models folders are NOT optional here. Without them the mine
  // learns from dungeons, minigames and test areas (`worldAreas.ts`) and keeps
  // the invisible marker anchors (`markers.ts`) — so the place types printed in
  // the brief would describe a corpus the generator no longer uses. A brief
  // that disagrees with the mine is worse than no brief.
  const { index, archetypes } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
    undefined,
    await root.getDirectoryHandle('map_areas'),
    await root.getDirectoryHandle('models'),
  )
  const available = (Object.entries(index.species) as [string, { id: number }[] | undefined][])
    .filter(([, l]) => l && l.length > 0)
    .map(([n]) => n)

  // The palette the app would use with nothing bound for this cache. If Cody
  // has bound materials by hand, his brief differs here and his is the truth.
  const brief = planningBrief(AREA, { availableSpecies: available, palette: DEFAULT_PALETTE, archetypes })
  await fs.mkdir(`${CACHE}/${PROCGEN_DIR}`, { recursive: true })
  // The panel appends the reply instruction when it writes the file
  // (GeneratePanel.tsx). Without this the rig's brief is missing the only two
  // lines that tell the planner what to DO, and it silently differs from the
  // one the app produces.
  const text = `${brief}

${PLAN_INSTRUCTION}
Write it to \`${PLAN_FILE}\` beside this file.
`
  await fs.writeFile(`${CACHE}/${PROCGEN_DIR}/${BRIEF_FILE}`, text)
  console.log(`wrote ${PROCGEN_DIR}/${BRIEF_FILE}, ${(brief.length / 1024).toFixed(1)} KB\n`)
  console.log(text)
}

main().catch((e) => { console.error(e); process.exit(1) })
