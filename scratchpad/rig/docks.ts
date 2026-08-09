/**
 * DOCKS — what is a RuneScape pier actually made of?
 *
 * "No docks" has been the headline fault of the generated fishing village since
 * `docs/map-learning.md` §1, and every attempt at it so far failed the same way:
 * §4 measured waterside OBJECTS by name and never measured a pier as a
 * STRUCTURE. That is how `fishing_ledge` got shipped and then pulled again
 * (§12a) — 185 placements, 100% on the ground, every statistical test passed,
 * and it is dock TRIM authored to sit on a deck that was not there.
 *
 * This is the structural pass, the same job §14 did for building footprints.
 *
 * WHAT WATER IS. An overlay is water if the underwater ("um") terrain is
 * authored beneath it. Measured over all 2,413 regions that picks out overlay
 * 112 with no ambiguity — 1,406,704 tiles at 94.8% underwater-height presence,
 * against 73% for the next candidate and 2.5% for bare ground. 112 alone is 96%
 * of all water in the cache, and its count in Port Sarim (2,333) independently
 * reproduces the figure `docs/procgen.md` §6 recorded when the underwater layer
 * was ported. The secondary set costs nothing and covers the icy/foul waters.
 *
 * NOT the renderer's `isWaterMaterial` (mapScene.ts:1438). That is a hue test on
 * the texture, used to decide what to ANIMATE, and it does not select 112 at
 * all — it finds 9 overlays covering a rounding error of the map. Reusing it
 * here looked obviously right and measured wrong.
 *
 * WHAT A DOCK IS. Confirmed by looking at Port Sarim (12081/12082) before
 * theorising: a pier is LOCS OVER WATER, not raised terrain. The deck is a
 * carpet of type-22 ground decoration laid on water tiles — 471 placements of
 * one id in region 12082 alone — and the terrain underneath is untouched sea.
 *
 * So a dock = a connected run of DECK tiles standing over at least one water
 * tile. Growing the component over deck rather than over water is deliberate:
 * it keeps the landward apron, which is where the pier meets the shore and
 * therefore the join the generator has to reproduce.
 */
import { promises as fs } from 'node:fs'

const CACHE = 'D:/workspace/github/cryogen-cache/unpacked'
const SIZE = 64
const TILES = SIZE * SIZE
const PLANES = 4

/** Overlays with the underwater layer beneath them. 112 alone is 96%. */
const WATER = new Set([112, 215, 200, 169, 85, 138, 196, 216, 231, 6, 114, 235, 129, 214, 189])

/** A pier is at least a few planks; two tiles is a step down to a boat. */
const MIN_DECK_TILES = 3

/**
 * Ship vocabulary. Used only to SEPARATE moored vessels from piers in the
 * report — never to identify a deck. A hulk is a deck over water too, and
 * without this the geometry stats describe boats.
 */
const SHIP_WORDS = /ship|mast|figurehead|rope|wheel|anchor|gangplank/i

type Def = { id: number; name: string; lift: number; obstructs: boolean }

/**
 * A deck plank is a ground decoration that OBSTRUCTS THE GROUND — the flag that
 * makes a type-22 replace the terrain under it rather than lie on it, which is
 * exactly what a plank does over open sea.
 *
 * It is NOT "a ground decoration lifted clear of the water". That was the first
 * cutoff tried here (`offsetY <= -200`, taken from Port Sarim's 64496 at -904)
 * and it found FOUR deck ids and 14 docks in the entire map. Only the Port Sarim
 * family is authored with an `offsetY` lift; the commonest decks in the cache —
 * 56924 (1,082 placements), 9453 (351, across 23 regions), 9454 (279, 22
 * regions) — all sit at `offsetY: 0` and carry their height IN THE MODEL.
 *
 * That is §11's canopy lesson arriving a second time: a per-object offset is one
 * of several ways the map raises a thing, and picking the one the first example
 * happened to use silently deletes everything authored the other way.
 *
 * The flag also excludes the water DECALS sharing shape 22 — lily pads, foam and
 * ripples (21135, 21136, 754) are all `obstructsGround: false`.
 */
const isDeckDef = (d: Def) => d.obstructs

const isWall = (t: number) => (t >= 0 && t <= 3) || t === 9
const isGroundDecor = (t: number) => t === 22

function pctl(a: number[], p: number) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

/**
 * Pull one base64 channel out of the region text.
 *
 * Textual rather than a full parse, and the capture is still JSON-ESCAPED —
 * Gson writes `=` padding as `&#x3d;`, which base64 decoding silently mangles.
 * `docs/map-learning.md` §12 records what that cost the last time it shipped.
 * Unescape via JSON.parse, then validate the decoded length.
 */
function channel(text: string, field: string, expect: number): Uint8Array | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(text)
  if (!m?.[1]) return null
  let b64: string
  try { b64 = JSON.parse(`"${m[1]}"`) as string } catch { return null }
  const buf = Buffer.from(b64, 'base64')
  return buf.length === expect ? new Uint8Array(buf) : null
}

/** The objects array only, so a 200 KB region isn't fully parsed for its channels. */
function objectsOf(text: string): number[][] {
  const i = text.indexOf('"objects"')
  if (i < 0) return []
  const s = text.indexOf('[', i)
  if (s < 0) return []
  let depth = 0
  for (let k = s; k < text.length; k++) {
    const c = text[k]
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(text.slice(s, k + 1)) as number[][] } catch { return [] }
    }
  }
  return []
}

type Pier = {
  region: string
  tiles: number
  water: number
  w: number
  h: number
  long: number
  short: number
  fill: number
  /** median contiguous run along the narrower axis — the walkway width */
  walkway: number
  shore: number
  border: boolean
  deckIds: Set<number>
  carried: { id: number; shape: number; edge: number }[]
}

async function main() {
  const dir = `${CACHE}/maps`
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))

  // -----------------------------------------------------------------------
  // Pass A — cache the water regions and collect deck candidates. Bounds the
  // def reads to a few hundred files instead of the whole 74k object table.
  // -----------------------------------------------------------------------
  const regions = new Map<string, { ov: Uint8Array; objects: number[][] }>()
  const candidates = new Set<number>()
  for (const f of files) {
    const text = await fs.readFile(`${dir}/${f}`, 'utf8')
    const ov = channel(text, 'overlayIds', TILES * PLANES)
    if (!ov) continue
    let anyWater = false
    for (let i = 0; i < TILES; i++) if (WATER.has(ov[i])) { anyWater = true; break }
    if (!anyWater) continue
    const objects = objectsOf(text)
    if (!objects.length) continue
    regions.set(f, { ov, objects })
    for (const [id, shape, , x, y, plane] of objects) {
      if (plane !== 0 || !isGroundDecor(shape)) continue
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
      if (WATER.has(ov[x * SIZE + y])) candidates.add(id)
    }
  }

  const defs = new Map<number, Def>()
  for (const id of candidates) {
    try {
      const j = JSON.parse(await fs.readFile(`${CACHE}/objects/${id}.json`, 'utf8'))
      defs.set(id, {
        id,
        name: j.name && j.name !== 'null' ? j.name : '',
        // the renderer negates it (mapScene.ts:4274), so positive here = raised
        lift: -(j.offsetY ?? 0),
        obstructs: j.obstructsGround === true,
      })
    } catch { /* no def: cannot be a deck */ }
  }
  const deckIds = new Set([...candidates].filter((id) => { const d = defs.get(id); return d && isDeckDef(d) }))
  const nameOf = (id: number) => defs.get(id)?.name || '(unnamed)'

  /**
   * Trim ids need defs too, and they are NOT deck candidates — the first run of
   * this file only loaded defs for ground decorations on water, so every trim
   * name printed "(unnamed)" and the ship/pier split silently matched nothing
   * (0 vessels flagged where an earlier pass found 22). A name lookup that
   * quietly returns a default is exactly the kind of failure that reads as a
   * finding, so the defs are filled in before anything is reported.
   */
  async function loadDefs(ids: Iterable<number>) {
    for (const id of ids) {
      if (defs.has(id)) continue
      try {
        const j = JSON.parse(await fs.readFile(`${CACHE}/objects/${id}.json`, 'utf8'))
        defs.set(id, {
          id,
          name: j.name && j.name !== 'null' ? j.name : '',
          lift: -(j.offsetY ?? 0),
          obstructs: j.obstructsGround === true,
        })
      } catch { defs.set(id, { id, name: '', lift: 0, obstructs: false }) }
    }
  }

  console.log(`${regions.size} water regions cached; ${candidates.size} ground decorations stand on water`)
  console.log(`${deckIds.size} of them are DECK ids (they obstruct the ground)\n`)

  // -----------------------------------------------------------------------
  // Pass B — components
  // -----------------------------------------------------------------------
  const piers: Pier[] = []
  const vessels: Pier[] = []
  /** per deck id: how positional is it? edge vs interior, and its rotations */
  const deckPos = new Map<number, { n: number; edge: number; rot: number[] }>()

  for (const [f, { ov, objects }] of regions) {
    const deck = new Uint8Array(TILES)
    const water = new Uint8Array(TILES)
    const at = new Map<number, number[][]>()
    for (let i = 0; i < TILES; i++) if (WATER.has(ov[i])) water[i] = 1
    let anyDeck = false
    for (const o of objects) {
      const [id, , , x, y, plane] = o
      if (plane !== 0 || x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
      const i = x * SIZE + y
      let l = at.get(i)
      if (!l) at.set(i, (l = []))
      l.push(o)
      if (deckIds.has(id)) { deck[i] = 1; anyDeck = true }
    }
    if (!anyDeck) continue

    const seen = new Uint8Array(TILES)
    for (let s = 0; s < TILES; s++) {
      if (!deck[s] || seen[s]) continue
      const comp: number[] = [s]
      seen[s] = 1
      const stack = [s]
      let border = false
      while (stack.length) {
        const j = stack.pop()!
        const x = (j / SIZE) | 0, y = j % SIZE
        if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) border = true
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          const k = nx * SIZE + ny
          if (deck[k] && !seen[k]) { seen[k] = 1; comp.push(k); stack.push(k) }
        }
      }
      if (comp.length < MIN_DECK_TILES) continue
      const overWater = comp.filter((j) => water[j]).length
      // a raised walkway wholly on land is a boardwalk or a stair landing
      if (!overWater) continue
      const set = new Set(comp)

      // shore contact: a deck tile 4-adjacent to DRY ground that is not deck.
      // A structure with none of these starts in open water — a moored vessel
      // or a platform, not a jetty.
      let shore = 0
      for (const j of comp) {
        const x = (j / SIZE) | 0, y = j % SIZE
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          const k = nx * SIZE + ny
          if (!set.has(k) && !water[k]) { shore++; break }
        }
      }

      // walkway width: median contiguous run along each axis, take the narrower.
      // A bounding box says a T-headed pier is 14 wide; what the generator needs
      // is that you walk down it two abreast.
      const runsAlong = (byRow: boolean) => {
        const out: number[] = []
        for (let a = 0; a < SIZE; a++) {
          let run = 0
          for (let b = 0; b < SIZE; b++) {
            if (set.has(byRow ? a * SIZE + b : b * SIZE + a)) run++
            else { if (run) out.push(run); run = 0 }
          }
          if (run) out.push(run)
        }
        return out
      }
      const walkway = Math.min(pctl(runsAlong(true), 50), pctl(runsAlong(false), 50))

      let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1
      for (const j of comp) {
        const x = (j / SIZE) | 0, y = j % SIZE
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
      const W = maxX - minX + 1, H = maxY - minY + 1

      const ids = new Set<number>()
      const carried: Pier['carried'] = []
      for (const j of comp) {
        const x = (j / SIZE) | 0, y = j % SIZE
        let edge = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || !set.has(nx * SIZE + ny)) { edge = 1; break }
        }
        for (const [id, shape, rot] of at.get(j) ?? []) {
          if (deckIds.has(id)) {
            ids.add(id)
            let p = deckPos.get(id)
            if (!p) deckPos.set(id, (p = { n: 0, edge: 0, rot: [0, 0, 0, 0] }))
            p.n++
            p.edge += edge
            p.rot[rot & 3]++
            continue
          }
          carried.push({ id, shape, edge })
        }
      }

      const rec: Pier = {
        region: f.replace('.json', ''), tiles: comp.length, water: overWater,
        w: W, h: H, long: Math.max(W, H), short: Math.min(W, H),
        fill: comp.length / (W * H), walkway, shore, border, deckIds: ids, carried,
      }
      if (shore > 0) piers.push(rec); else vessels.push(rec)
    }
  }

  await loadDefs([...piers, ...vessels].flatMap((r) => r.carried.map((c) => c.id)))

  const shipish = (r: Pier) => r.carried.some((c) => SHIP_WORDS.test(nameOf(c.id)))
  console.log(`=== ${piers.length + vessels.length} deck structures over water ===`)
  console.log(`  shore-attached PIERS:            ${piers.length}  (${piers.filter(shipish).length} carry ship vocabulary)`)
  console.log(`  free-floating vessels/platforms: ${vessels.length}  (${vessels.filter(shipish).length} carry ship vocabulary)`)
  console.log('  A moored hulk is a deck over water too — without the split the geometry describes boats.')

  const P = piers.filter((r) => !r.border && !shipish(r))
  console.log(`\n=== ${P.length} clean piers (region-border and ship-carrying excluded) ===`)
  const q = (f: (r: Pier) => number, d = 0) => `p25 ${pctl(P.map(f), 25).toFixed(d)}  p50 ${pctl(P.map(f), 50).toFixed(d)}  p75 ${pctl(P.map(f), 75).toFixed(d)}  p90 ${pctl(P.map(f), 90).toFixed(d)}`
  console.log(`  deck tiles:   ${q((r) => r.tiles)}`)
  console.log(`  long side:    ${q((r) => r.long)}`)
  console.log(`  short side:   ${q((r) => r.short)}`)
  console.log(`  fill ratio:   ${q((r) => r.fill, 2)}`)
  console.log(`  shore join:   ${q((r) => r.shore)}   (deck tiles touching dry land)`)

  console.log('\n=== WALKWAY WIDTH — the number layer 1 needs ===')
  console.log(`  ${q((r) => r.walkway)}`)
  const wh = new Map<number, number>()
  for (const r of P) wh.set(r.walkway, (wh.get(r.walkway) ?? 0) + 1)
  console.log('  ' + [...wh.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} wide x${v}`).join('   '))
  console.log(`  1-2 tiles wide: ${((P.filter((r) => r.walkway <= 2).length / P.length) * 100).toFixed(0)}% of piers`)

  console.log('\n=== how much of a pier is over water ===')
  console.log(`  ${q((r) => r.water / r.tiles, 2)}`)
  console.log(`  entirely over water: ${((P.filter((r) => r.water === r.tiles).length / P.length) * 100).toFixed(0)}%`)

  console.log('\n=== DECK FAMILIES — the ids that co-occur in one pier ===')
  console.log('  A dock STYLE is a family, not an id. Picking one id and tiling it is')
  console.log('  the dock equivalent of a house built from twelve wall styles (§5).')
  const fam = new Map<string, number>()
  for (const r of P) {
    const k = [...r.deckIds].sort((a, b) => a - b).join(',')
    fam.set(k, (fam.get(k) ?? 0) + 1)
  }
  console.log(`  deck ids per pier: ${q((r) => r.deckIds.size)}   single-id ${((P.filter((r) => r.deckIds.size === 1).length / P.length) * 100).toFixed(0)}%`)
  for (const [k, n] of [...fam.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  x${String(n).padStart(3)}  [${k.split(',').length}] ${k}`)
  }

  console.log('\n=== are deck ids POSITIONAL? (edge pieces vs interchangeable planks) ===')
  console.log('      id      n   % on an EDGE tile   rotations 0/1/2/3')
  const pos = [...deckPos.entries()].filter(([, v]) => v.n >= 20).sort((a, b) => b[1].n - a[1].n)
  for (const [id, v] of pos.slice(0, 16)) {
    console.log(`  ${String(id).padStart(6)} ${String(v.n).padStart(6)}          ${String(Math.round((v.edge / v.n) * 100)).padStart(3)}%       ${v.rot.map((r) => Math.round((r / v.n) * 100) + '%').join(' ')}`)
  }

  console.log('\n=== TRIM — what a pier carries besides its deck ===')
  console.log(`  piers carrying NOTHING at all: ${((P.filter((r) => !r.carried.length).length / P.length) * 100).toFixed(0)}%`)
  const railing = P.filter((r) => r.carried.some((c) => isWall(c.shape)))
  console.log(`  piers with a railing (wall shapes 0-3/9): ${((railing.length / P.length) * 100).toFixed(0)}%`)
  const tr = new Map<string, { n: number; edge: number; piers: Set<number> }>()
  P.forEach((r, i) => {
    for (const c of r.carried) {
      const k = `${c.id}|${c.shape}`
      let v = tr.get(k)
      if (!v) tr.set(k, (v = { n: 0, edge: 0, piers: new Set() }))
      v.n++
      v.edge += c.edge
      v.piers.add(i)
    }
  })
  console.log('       id shape      n   %edge  piers  name')
  for (const [k, v] of [...tr.entries()].sort((a, b) => b[1].piers.size - a[1].piers.size).slice(0, 20)) {
    const [id, shape] = k.split('|')
    console.log(`  ${id.padStart(7)} ${shape.padStart(5)}  ${String(v.n).padStart(5)}   ${String(Math.round((v.edge / v.n) * 100)).padStart(3)}%   ${String(v.piers.size).padStart(4)}  ${nameOf(+id)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
