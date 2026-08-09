/**
 * Why does an "Ice covered boulder" get planted on a temperate shore?
 *
 * The context model is supposed to stop exactly this. Rather than theorise,
 * score the real `loose_stone` candidates on the ground this plan actually
 * paints and show, per candidate: how often the map places it outdoors, how many
 * observations the context model has for it, what it scores here, and what share
 * of the draw it therefore takes.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex, chooseScenery, ROLE_SPECIES } from '../../src/procgen/scenery'
import { contextLikelihood, seenOnGround, type TileContext } from '../../src/procgen/context'
import { makeRng } from '../../src/procgen/rng'
import type { RoleId } from '../../src/procgen/types'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
/** the underlays this plan paints, as BYTES (definition id + 1) */
const GROUND: [string, number][] = [['grass 160', 161], ['sand 61', 62], ['townEarth 163', 164]]
const ROLES: RoleId[] = ['loose_stone', 'canopy']

async function main() {
  const root = dirHandle(CACHE)
  const { index, contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  if (!contextModel) throw new Error('no context model')

  const names = new Map<number, string>()
  const odir = `${CACHE}/objects`
  const files = await fs.readdir(odir)
  for (let i = 0; i < files.length; i += 512) {
    await Promise.all(files.slice(i, i + 512).map(async (f) => {
      if (!f.endsWith('.json')) return
      try {
        const d = JSON.parse(await fs.readFile(`${odir}/${f}`, 'utf8'))
        if (d.name) names.set(d.id, d.name as string)
      } catch { /* skip */ }
    }))
  }

  for (const role of ROLES) {
    for (const [label, byte] of GROUND) {
      const ctx: TileContext = { underlay: byte, overlay: 0, slope: 1, height: 40, wall: 2 }
      const rows: { id: number; sp: string; uses: number; n: number; fit: number; w: number }[] = []
      for (const sp of ROLE_SPECIES[role]) {
        for (const e of index.species[sp] ?? []) {
          const uses = Math.max(0, Math.round(e.uses * (1 - (e.indoor ?? 0))))
          const fit = contextLikelihood(contextModel, e.id, ctx)
          rows.push({ id: e.id, sp, uses, n: contextModel.objects[e.id]?.n ?? 0, fit, w: uses * fit })
        }
      }
      rows.sort((a, b) => b.w - a.w)
      // What SHIPS is chooseScenery, gate included — so sample that rather than
      // re-deriving a ranking the generator never uses.
      const rnd = makeRng(11)
      const drawn = new Map<number, number>()
      const N = 4000
      for (let i = 0; i < N; i++) {
        const p = chooseScenery(index, { role }, rnd, contextModel, ctx)
        if (p) drawn.set(p.id, (drawn.get(p.id) ?? 0) + 1)
      }
      const dtot = [...drawn.values()].reduce((a, b) => a + b, 0) || 1
      console.log(`\n=== ${role} on ${label} ===`)
      console.log('   drawn  id     outdoorUses   obs  seenHere   name')
      for (const [id, c] of [...drawn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        const r = rows.find((x) => x.id === id)
        console.log(`  ${((c / dtot) * 100).toFixed(1).padStart(5)}%  ${String(id).padStart(6)}  `
          + `${String(r?.uses ?? 0).padStart(9)}  ${String(r?.n ?? 0).padStart(6)}  `
          + `${String(seenOnGround(contextModel, id, ctx)).padStart(7)}   ${names.get(id) ?? '?'}`)
      }
      const iceDrawn = [5037, 5038, 5039].reduce((a, id) => a + (drawn.get(id) ?? 0), 0)
      console.log(`  -> ICE BOULDERS (5037/5038/5039) drawn ${iceDrawn}/${N} = ${((iceDrawn / dtot) * 100).toFixed(2)}%`
        + `   seenHere ${[5037, 5038, 5039].map((id) => String(seenOnGround(contextModel, id, ctx))).join(' / ')}`)
    }
  }

  // what ground does the map ACTUALLY put 5037 on?
  const o = contextModel.objects[5037]
  if (o) {
    const hist = Object.entries(o.f.underlay ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`\n5037 real underlay histogram (n=${o.n}): `
      + hist.map(([b, c]) => `byte ${b} x${c}`).join(', '))
  } else {
    console.log('\n5037 has NO entry in the context model at all')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
