/**
 * Candidates for rebinding the ground palette.
 *
 * §12c measured that five palette roles are bound to Karamja materials. Picking
 * replacements by jungle share ALONE would wreck the palette, because each role
 * also has to LOOK like its name — `grassDead` is a dry yellow-olive, `sand` is
 * pale, `trackEarth` is a worn brown. So this reports, for every underlay
 * definition, its real rgb/texture next to its jungle share and how much
 * evidence the map carries for it, and scores candidates per role on colour
 * distance to the role's current (intended) colour.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex, chooseScenery } from '../../src/procgen/scenery'
import { DEFAULT_PALETTE, materialByte, type PaletteRole } from '../../src/procgen/palette'
import { makeRng } from '../../src/procgen/rng'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const N = 800
const JUNGLE = ['tree_tropical', 'plant_jungle', 'grass_jungle']

/** roles to rebind, and what they are SUPPOSED to look like */
const WANTED: PaletteRole[] = ['grass', 'grassLush', 'grassMid', 'grassDark', 'grassDead', 'trackEarth', 'sand', 'dirt', 'mud']

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
const rgbOf = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255]
function dist(a: number, b: number) {
  const [r1, g1, b1] = rgbOf(a); const [r2, g2, b2] = rgbOf(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

async function main() {
  const root = dirHandle(CACHE)
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  if (!contextModel) throw new Error('no context model')

  const defs = new Map<number, { rgb: number; texture: number }>()
  const dir = `${CACHE}/config/underlays`
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue
    const d = JSON.parse(await fs.readFile(`${dir}/${name}`, 'utf8'))
    defs.set(d.id, { rgb: d.rgb ?? 0, texture: d.texture ?? -1 })
  }

  const evidence = new Map<number, number>()
  for (const oc of Object.values(contextModel.objects)) {
    for (const [bin, n] of Object.entries(oc.f.underlay ?? {})) {
      evidence.set(+bin, (evidence.get(+bin) ?? 0) + n)
    }
  }

  const jungleShare = (byte: number) => {
    let j = 0, t = 0
    for (const role of ['canopy', 'undergrowth'] as const) {
      const rnd = makeRng(7)
      for (let i = 0; i < N; i++) {
        const p = chooseScenery(index, { role }, rnd, contextModel,
          { underlay: byte, overlay: 0, slope: 1, height: 40, wall: 2 })
        if (!p) continue
        t++
        if (JUNGLE.includes(p.species)) j++
      }
    }
    return t ? j / t : 1
  }

  // score every def once
  type Cand = { id: number; rgb: number; tex: number; ev: number; j: number }
  const cands: Cand[] = []
  for (const [id, d] of defs) {
    const ev = evidence.get(materialByte(id)) ?? 0
    if (ev < 150) continue // too little evidence to trust, and to steer selection
    cands.push({ id, rgb: d.rgb, tex: d.texture, ev, j: jungleShare(materialByte(id)) })
  }
  console.log(`${cands.length} underlays with >=150 observations\n`)

  for (const role of WANTED) {
    const cur = DEFAULT_PALETTE[role]
    const curDef = defs.get(cur)
    const curJ = cands.find((c) => c.id === cur)
    console.log(`${role}  currently ${cur} ${hex(curDef?.rgb ?? 0)} tex ${curDef?.texture}`
      + `  jungle ${curJ ? Math.round(curJ.j * 100) + '%' : 'n/a'}`)
    const ranked = cands
      .filter((c) => dist(c.rgb, curDef?.rgb ?? 0) < 70) // must still LOOK like the role
      .sort((a, b) => (a.j - b.j) || (b.ev - a.ev))
      .slice(0, 5)
    for (const c of ranked) {
      console.log(`    ${String(c.id).padStart(4)} ${hex(c.rgb)} tex ${String(c.tex).padStart(4)}`
        + `  jungle ${String(Math.round(c.j * 100)).padStart(3)}%  ev ${String(c.ev).padStart(6)}`
        + `  dE ${Math.round(dist(c.rgb, curDef?.rgb ?? 0))}`)
    }
    console.log()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
