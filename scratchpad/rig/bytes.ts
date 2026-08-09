/**
 * Which underlay bytes are TEMPERATE ground in this cache, and which are jungle?
 *
 * The palette binds `grass`/`grassLush`/`grassDead`/`sand` by how PREVALENT a
 * material was in the 15-settlement survey — and that survey included Brimhaven,
 * which is on Karamja. So several "green" roles are bound to jungle materials,
 * and the roles conversion made that visible by asking the map what grows there.
 * This ranks every byte the model has evidence for.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { buildSceneryIndex, chooseScenery } from '../../src/procgen/scenery'
import { DEFAULT_PALETTE, materialByte, type PaletteRole } from '../../src/procgen/palette'
import { makeRng } from '../../src/procgen/rng'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const N = 1200
const JUNGLE = ['tree_tropical', 'plant_jungle', 'grass_jungle']

async function main() {
  const root = dirHandle(CACHE)
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  if (!contextModel) throw new Error('no context model')

  // how much evidence each underlay byte carries, straight off the model
  const evidence = new Map<number, number>()
  for (const oc of Object.values(contextModel.objects)) {
    for (const [bin, n] of Object.entries(oc.f.underlay ?? {})) {
      evidence.set(+bin, (evidence.get(+bin) ?? 0) + n)
    }
  }

  const bound = new Map<number, string>()
  for (const [name, defId] of Object.entries(DEFAULT_PALETTE) as [PaletteRole, number][]) {
    bound.set(materialByte(defId), name)
  }

  const rows: { byte: number; ev: number; jc: number; ju: number; top: string }[] = []
  for (const [byte, ev] of evidence) {
    if (ev < 200) continue
    const share = (role: 'canopy' | 'undergrowth') => {
      const rnd = makeRng(7)
      const counts = new Map<string, number>()
      for (let i = 0; i < N; i++) {
        const p = chooseScenery(index, { role }, rnd, contextModel,
          { underlay: byte, overlay: 0, slope: 1, height: 40, wall: 2 })
        if (p) counts.set(p.species, (counts.get(p.species) ?? 0) + 1)
      }
      const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1
      const j = JUNGLE.reduce((a, s) => a + (counts.get(s) ?? 0), 0) / total
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      return { j, top: top ? `${top[0]} ${Math.round((top[1] / total) * 100)}%` : '-' }
    }
    const c = share('canopy')
    const u = share('undergrowth')
    rows.push({ byte, ev, jc: c.j, ju: u.j, top: `${c.top} / ${u.top}` })
  }

  rows.sort((a, b) => (a.jc + a.ju) - (b.jc + b.ju))
  console.log('byte  evidence  jungle-canopy  jungle-under   top canopy / top undergrowth   [bound role]')
  for (const r of rows.slice(0, 24)) {
    console.log(`${String(r.byte).padStart(4)}  ${String(r.ev).padStart(8)}  `
      + `${String(Math.round(r.jc * 100)).padStart(12)}%  ${String(Math.round(r.ju * 100)).padStart(11)}%   `
      + `${r.top.padEnd(38)} ${bound.get(r.byte) ? `[${bound.get(r.byte)}]` : ''}`)
  }
  console.log('\n... worst (most jungle):')
  for (const r of rows.slice(-8)) {
    console.log(`${String(r.byte).padStart(4)}  ${String(r.ev).padStart(8)}  `
      + `${String(Math.round(r.jc * 100)).padStart(12)}%  ${String(Math.round(r.ju * 100)).padStart(11)}%   `
      + `${r.top.padEnd(38)} ${bound.get(r.byte) ? `[${bound.get(r.byte)}]` : ''}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
