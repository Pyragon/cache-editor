/**
 * 41582 (a snow-covered rock) and 29018 (a flat sandy slab) still reach a lush
 * green shore. Both cleared the `seenOnGround` gate, which only asks for ONE
 * placement on the tile's underlay — and one sighting out of twenty-seven is
 * noise, not habitat.
 *
 * Print the full underlay histogram for the offenders next to the candidates
 * that legitimately belong, so a threshold is chosen from the separation that
 * actually exists rather than from taste.
 */
import { installShims, dirHandle } from './shim'
installShims()

import { promises as fs } from 'node:fs'
import { buildSceneryIndex } from '../../src/procgen/scenery'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
/** the underlay BYTES this plan paints on land */
const OURS = [161, 160, 163, 164, 93, 64, 10, 62, 50, 55]
const OFFENDERS = [41582, 29018, 5037, 5038, 5039]
const LEGIT = [19205, 2509, 444, 445, 60271, 60272, 441, 442, 10947, 5606]

async function main() {
  const root = dirHandle(CACHE)
  const { contextModel } = await buildSceneryIndex(
    await root.getDirectoryHandle('objects'), 'rig',
    undefined, undefined, undefined,
    await root.getDirectoryHandle('maps'),
  )
  if (!contextModel) throw new Error('no model')

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

  const show = (title: string, ids: number[]) => {
    console.log(`\n=== ${title} ===`)
    for (const id of ids) {
      const o = contextModel.objects[id]
      if (!o) { console.log(`  ${id} — not in model`); continue }
      const h = Object.entries(o.f.underlay ?? {}).map(([b, c]) => [+b, c] as const)
        .sort((a, b) => b[1] - a[1])
      const onOurs = h.filter(([b]) => OURS.includes(b)).reduce((a, [, c]) => a + c, 0)
      const share = onOurs / o.n
      console.log(`  ${String(id).padStart(6)} n=${String(o.n).padStart(4)} `
        + `onOurGround ${String(onOurs).padStart(3)} = ${(share * 100).toFixed(1).padStart(5)}%  `
        + `${names.get(id) ?? '?'}`)
      console.log(`         ${h.slice(0, 8).map(([b, c]) => `${b}:${c}`).join('  ')}`)
    }
  }
  show('OFFENDERS — reported wrong for a lush green shore', OFFENDERS)
  show('LEGITIMATE — the ones that should survive', LEGIT)

  // what share-threshold separates the two groups on OUR ground?
  console.log('\n=== separation on our ground (share of the object\'s placements) ===')
  for (const [label, ids] of [['offender', OFFENDERS], ['legit', LEGIT]] as const) {
    const shares = ids.map((id) => {
      const o = contextModel.objects[id]
      if (!o) return null
      const on = Object.entries(o.f.underlay ?? {})
        .filter(([b]) => OURS.includes(+b)).reduce((a, [, c]) => a + c, 0)
      return on / o.n
    }).filter((v): v is number => v !== null).sort((a, b) => a - b)
    console.log(`  ${label.padEnd(9)}: ${shares.map((s) => (s * 100).toFixed(1) + '%').join('  ')}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
