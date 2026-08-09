/**
 * What does the real map actually GROW on each ground role our palette binds?
 *
 * The roles conversion leaked jungle into every temperate theme. The competing
 * explanations are "the `canopy`/`undergrowth` roles are too broad" and "the
 * ground bytes we bind those themes to are jungle ground in this cache". This
 * distinguishes them, measured through the real `chooseScenery`.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { buildSceneryIndex, chooseScenery } from '../../src/procgen/scenery'
import { DEFAULT_PALETTE, materialByte, type PaletteRole } from '../../src/procgen/palette'
import { makeRng } from '../../src/procgen/rng'
import type { RoleId } from '../../src/procgen/types'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const N = 4000

async function main() {
  const root = dirHandle(CACHE)
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )

  for (const role of ['canopy', 'undergrowth'] as RoleId[]) {
    console.log(`\n=== ${role}: what the map grows on each bound ground role ===`)
    for (const [name, defId] of Object.entries(DEFAULT_PALETTE) as [PaletteRole, number][]) {
      if (['path', 'pathDirt', 'water', 'rock'].includes(name)) continue // overlays
      const rnd = makeRng(99)
      const counts = new Map<string, number>()
      for (let i = 0; i < N; i++) {
        const p = chooseScenery(index, { role }, rnd, contextModel, {
          underlay: materialByte(defId), overlay: 0, slope: 1, height: 40, wall: 2,
        })
        if (p) counts.set(p.species, (counts.get(p.species) ?? 0) + 1)
      }
      const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1
      const jungle = ['tree_tropical', 'plant_jungle', 'grass_jungle'].reduce(
        (a, s) => a + (counts.get(s) ?? 0), 0)
      const topN = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([s, c]) => `${s} ${Math.round((c / total) * 100)}%`).join(', ')
      console.log(`  ${name.padEnd(10)} byte ${String(materialByte(defId)).padStart(3)}  `
        + `JUNGLE ${String(Math.round((jungle / total) * 100)).padStart(3)}%  |  ${topN}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
