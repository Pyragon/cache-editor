/**
 * Resolving the plan's SPECIES vocabulary to real object ids in the opened
 * cache.
 *
 * The plan deliberately never contains object ids. Ids differ between caches
 * and revisions, they mean nothing to a language model, and a plan that said
 * `1276` would be unreadable and unportable. It says `tree_oak`, and this
 * matches that against the cache's own object names.
 *
 * The catch: `objects/` is ~74k individual json files and nothing in the dump
 * indexes them by name, so the first resolve has to read them. That happens
 * ONCE per cache, with progress, and the (small) result is cached in
 * localStorage — we keep only the handful of ids per species we matched, not
 * the 74k names.
 */

import type { SpeciesId } from './types'

/** id → name, only for entries a species pattern matched. */
export type SceneryIndex = {
  /** cache fingerprint this was built from */
  fingerprint: string
  builtAt: number
  species: Partial<Record<SpeciesId, SceneryEntry[]>>
  /** false when the maps folder couldn't be read, so `uses` is meaningless */
  weighted?: boolean
  /**
   * Ground object id → the plane-1 loc the game pairs it with.
   *
   * Two-part trees: an oak is a trunk (#38731) on plane 0 with its canopy
   * (#38736) directly above on plane 1. Emitting only the trunk gives a wood
   * of bare poles. Measured from the real map, which pairs them at 97-100%,
   * always at the same tile with the SAME shape and the same rotation (99.3%).
   */
  canopies?: Record<number, number>
}

/**
 * `uses` is how many times the REAL map places this object — the single most
 * important field here. Matching on names alone happily selects objects the
 * game never places at all: of nine ids the old picker chose, five (three
 * "Torch"es, "Beanstump", "Ivy stump", a "Rock") appear NOWHERE in the map,
 * and 20,329 of the cache's 73,913 objects are never placed anywhere. See
 * `docs/map-learning.md` §4.
 */
export type SceneryEntry = {
  id: number
  name: string
  uses: number
  /**
   * Fraction of those placements sitting within 2 tiles of a wall — a proxy
   * for "this is furniture, not landscape". Frequency alone is context-blind
   * and picks the globally commonest variant, which for `plant` is the indoor
   * "Potted Plant" (8,562 uses, 84% indoor) and for `torch` is three torches
   * that are 88-100% indoor. Measured, not guessed. A stopgap until the full
   * context model lands — see `docs/map-learning.md` §5.
   */
  indoor: number
  /**
   * Fraction of placements the game puts on plane 0 — i.e. on the ground.
   *
   * Two-part trees are why this exists. An oak is a TRUNK on plane 0 (#38731)
   * and a separate CANOPY on plane 1 (#38736), both named "Oak" and on
   * adjacent ids. Frequency alone can't tell them apart, so the prior happily
   * picked the canopy for oak, yew, evergreen, willow and tropical tree, and
   * planted foliage on the ground with no trunk under it.
   */
  ground: number
}

/** At or above this, an object is furniture and never goes in open country. */
const INDOOR_CUTOFF = 0.8
/** Below this share on plane 0, an object is a canopy or an upper storey. */
const GROUND_CUTOFF = 0.5

/**
 * Roughly how many times the map places this OUT in the open — the number the
 * generator actually cares about, since everything it plants today is outdoors.
 * Keeps a variant that is common but mostly indoors from swamping one that is
 * rarer but genuinely a landscape object.
 */
function outdoorUses(e: SceneryEntry): number {
  return e.uses * (1 - e.indoor)
}

// v2 added `uses`; a v1 payload has no frequency data and must be rebuilt
const STORAGE_KEY = 'cache-editor:scenery-index:v2'

/**
 * How each species is recognised. `any` terms must all appear (in order-free
 * fashion) and `not` terms must not; the first pattern to match wins, so more
 * specific species are listed before their generic parents in SPECIES_ORDER.
 *
 * These are matched against the LOWERCASED object name. Kept deliberately
 * conservative — a wrong match plants the wrong thing across a whole forest,
 * and a missed species just means that species is unavailable and is reported.
 */
const PATTERNS: Record<SpeciesId, { all: string[]; not?: string[] }[]> = {
  // --- trees. Order matters: 'dead tree' must beat 'tree'.
  tree_dead: [{ all: ['dead tree'] }, { all: ['dead', 'tree'], not: ['stump'] }],
  tree_burnt: [{ all: ['burnt', 'tree'] }, { all: ['charred', 'tree'] }],
  tree_stump: [{ all: ['stump'] }],
  tree_fallen: [{ all: ['fallen', 'tree'] }, { all: ['broken', 'tree'] }, { all: ['log'], not: ['logs', 'balance'] }],
  tree_oak: [{ all: ['oak'], not: ['door', 'chair', 'table', 'bed', 'cabinet', 'plank', 'bench', 'shelves', 'larder', 'dresser'] }],
  tree_willow: [{ all: ['willow'], not: ['branch'] }],
  tree_maple: [{ all: ['maple'], not: ['branch'] }],
  tree_yew: [{ all: ['yew'], not: ['branch'] }],
  tree_magic: [{ all: ['magic tree'] }, { all: ['magical', 'tree'] }],
  tree_evergreen: [{ all: ['evergreen'] }, { all: ['pine'], not: ['pineapple'] }],
  tree_palm: [{ all: ['palm'] }],
  tree_tropical: [{ all: ['tropical', 'tree'] }, { all: ['jungle', 'tree'] }],
  tree: [{ all: ['tree'], not: ['dead', 'stump', 'burnt', 'fallen', 'broken', 'magic', 'palm', 'evergreen', 'tropical', 'jungle'] }],

  // --- undergrowth
  bush: [{ all: ['bush'], not: ['jungle'] }],
  fern: [{ all: ['fern'] }],
  plant_jungle: [{ all: ['jungle', 'plant'] }],
  plant: [{ all: ['plant'], not: ['pot', 'jungle'] }],
  flowers: [{ all: ['flower'] }],
  reeds: [{ all: ['reed'] }, { all: ['bulrush'] }],
  grass_jungle: [{ all: ['jungle', 'grass'] }],
  grass_tuft: [{ all: ['grass'], not: ['grassland', 'jungle'] }],
  mushroom: [{ all: ['mushroom'] }, { all: ['toadstool'] }],

  // --- stone
  rock_small: [{ all: ['rocks'], not: ['ore', 'rune', 'mithril', 'adamant'] }, { all: ['small', 'rock'] }],
  rock_large: [{ all: ['large', 'rock'] }, { all: ['rock'], not: ['ore', 'rocks', 'small'] }],
  boulder: [{ all: ['boulder'] }],
  rubble: [{ all: ['rubble'] }, { all: ['debris'] }],
  stalagmite: [{ all: ['stalagmite'] }, { all: ['stalactite'] }],

  // --- ore. In this cache ore nodes are usually literally "<metal> rocks".
  ore_copper: [{ all: ['copper', 'rock'] }],
  ore_tin: [{ all: ['tin', 'rock'] }],
  ore_iron: [{ all: ['iron', 'rock'] }],
  ore_coal: [{ all: ['coal', 'rock'] }],
  ore_silver: [{ all: ['silver', 'rock'] }],
  ore_gold: [{ all: ['gold', 'rock'] }],
  ore_mithril: [{ all: ['mithril', 'rock'] }],
  // the cache spells it "Adamantite ore rocks", which the adamant pattern
  // cannot reach now that matching is word-anchored
  ore_adamant: [{ all: ['adamant', 'rock'] }, { all: ['adamantite', 'rock'] }],
  ore_rune: [{ all: ['rune', 'rock'] }, { all: ['runite', 'rock'] }],
  ore_clay: [{ all: ['clay', 'rock'] }],
  ore_essence: [{ all: ['essence', 'rock'] }, { all: ['rune essence'] }],

  // --- built
  fountain: [{ all: ['fountain'] }],
  well: [{ all: ['well'], not: ['wellington', 'farewell'] }],
  statue: [{ all: ['statue'] }],
  signpost: [{ all: ['signpost'] }, { all: ['sign post'] }],
  crate: [{ all: ['crate'] }],
  barrel: [{ all: ['barrel'] }],
  bench: [{ all: ['bench'] }],
  fence: [{ all: ['fence'], not: ['gate', 'broken'] }],
  fence_gate: [{ all: ['gate'], not: ['gateway'] }],
  wall_stone: [{ all: ['stone', 'wall'] }],
  hedge: [{ all: ['hedge'] }],
  gravestone: [{ all: ['gravestone'] }, { all: ['grave'], not: ['gravel'] }, { all: ['tombstone'] }],
  campfire: [{ all: ['campfire'] }, { all: ['fire'], not: ['fireplace', 'firepit'] }],

  // --- lights
  torch: [{ all: ['torch'], not: ['torchlight'] }],
  lantern: [{ all: ['lantern'] }],
  candles: [{ all: ['candle'] }],
  lamp_post: [{ all: ['lamp'] }],
}

/**
 * Specific → generic, so `tree` doesn't swallow `tree_oak`. Ore is listed
 * BEFORE plain rock for the same reason: "Coal rocks" and "Clay rocks" are ore
 * nodes, and the generic `rocks` pattern was claiming them (the others only
 * escaped because "<metal> ore rocks" trips its `ore` exclusion).
 */
const ORE_FIRST: SpeciesId[] = [
  'ore_copper', 'ore_tin', 'ore_iron', 'ore_coal', 'ore_silver',
  // essence BEFORE rune: "Rune essence rock" is essence, and the rune
  // pattern would otherwise claim it
  'ore_gold', 'ore_mithril', 'ore_adamant', 'ore_essence', 'ore_rune', 'ore_clay',
]
const SPECIES_ORDER = [
  ...ORE_FIRST,
  ...(Object.keys(PATTERNS) as SpeciesId[]).filter((s) => !ORE_FIRST.includes(s)),
]

/**
 * A placeable object is a SCENERY placement (slot 2), has a model, and isn't
 * one of the thousands of nameless utility markers. Checking this here keeps
 * the generator from planting an invisible sound emitter that happens to be
 * called "Tree".
 */
function isPlaceableScenery(def: {
  name?: string
  objectModelIds?: unknown
  shapes?: number[]
}): boolean {
  if (!def.name || def.name === 'null') return false
  if (!def.objectModelIds) return false
  // shape 10/11 = the ordinary scenery shapes; 22 is floor decoration.
  // Absent shapes means the default (10), which is fine.
  if (def.shapes && !def.shapes.some((s) => s === 10 || s === 11 || s === 22)) return false
  return true
}

/**
 * Whole-word containment. Plain `includes` was quietly catastrophic here:
 * "Consecrated pet house" contains "crate", "Jewellery box" contains "well",
 * "Timber defence" contains "fence" and "Engraved sarcophagus" contains
 * "grave" — all of which the generator would happily have planted.
 */
const termCache = new Map<string, RegExp>()
function hasWord(haystack: string, term: string): boolean {
  let re = termCache.get(term)
  if (!re) {
    // Every term above is plain lowercase letters and spaces, so nothing
    // needs escaping. Anchored on non-letters rather than a word boundary,
    // which misbehaves for multi-word terms - and 'well' must not match
    // inside 'Jewellery'.
    // optional trailing 's' so 'rock' still matches "Coal rocks" and 'reed'
    // matches "Reeds" - requiring an exact word broke every plural name
    re = new RegExp(`(^|[^a-z])${term}s?($|[^a-z])`, 'i')
    termCache.set(term, re)
  }
  return re.test(haystack)
}

function matchSpecies(name: string): SpeciesId | null {
  const lower = name.toLowerCase()
  for (const species of SPECIES_ORDER) {
    for (const pat of PATTERNS[species]) {
      if (!pat.all.every((t) => hasWord(lower, t))) continue
      if (pat.not?.some((t) => hasWord(lower, t))) continue
      return species
    }
  }
  return null
}

export function loadCachedIndex(fingerprint: string): SceneryIndex | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SceneryIndex
    if (parsed.fingerprint !== fingerprint) return null
    // An index with nothing in it is WORSE than none: the caller short-circuits
    // on "we already have one", so an empty cache disables scenery for good,
    // with no rescan and no symptom beyond a list of unmatched species. Treat
    // it as absent so the next generate rebuilds it.
    if (!Object.keys(parsed.species ?? {}).length) return null
    return parsed
  } catch {
    return null
  }
}

/** Throw away the cached index, so the next generate rescans. */
export function clearCachedIndex() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage blocked */ }
}

/** How many species an index actually resolved, for the UI to report. */
export function indexSpeciesCount(index: SceneryIndex | null): number {
  return index ? Object.keys(index.species).length : 0
}

/**
 * Scan the objects dump and keep what the species vocabulary recognises.
 *
 * This reads every object file, which is slow (tens of thousands of small
 * reads) — hence the cache. `onProgress` is called often enough to drive a
 * bar; the scan yields to the event loop periodically so the UI stays alive.
 */
/** What the scan actually saw — so "no scenery" can be told apart from "no files". */
export type ScanStats = {
  /** every directory entry, of any kind */
  entries: number
  /** entries that were <number>.json files */
  jsonFiles: number
  /** files whose text contained a name at all */
  named: number
  /** definitions that passed the placeable-scenery test */
  placeable: number
  /** definitions whose name matched a species */
  matched: number
  cancelled: boolean
}

/**
 * Pull the `objects` array out of a region file without parsing the rest.
 *
 * A map region is mostly base64 terrain blobs, so a full `JSON.parse` spends
 * nearly all its time on fields we don't want. The objects array is an array of
 * six-number arrays, so it ends at the first `]]`. That's a textual shortcut,
 * hence the shape check — anything unexpected falls back to a real parse rather
 * than silently producing a wrong (and invisibly wrong) frequency table.
 */
function readPlacements(text: string): number[][] | null {
  const at = text.indexOf('"objects"')
  if (at < 0) return null
  const open = text.indexOf('[', at)
  if (open < 0) return null
  if (text[open + 1] === ']') return []
  const close = text.indexOf(']]', open)
  if (close > open) {
    try {
      const arr = JSON.parse(text.slice(open, close + 2)) as number[][]
      if (Array.isArray(arr) && arr.every((o) => Array.isArray(o) && o.length >= 6)) return arr
    } catch { /* fall through to the honest parse */ }
  }
  try {
    return (JSON.parse(text) as { objects?: number[][] }).objects ?? []
  } catch {
    return null
  }
}

/** loc shapes that are a wall, for the indoor/outdoor test */
const WALL_SHAPES = new Set([0, 1, 2, 3, 9])

export type PlacementStat = {
  uses: number
  nearWall: number
  ground: number
  /** plane-1 object ids seen directly above this one, and how often */
  above: Map<number, number>
}

/** Below this pair rate, a plane-1 neighbour is a coincidence, not a canopy. */
const CANOPY_MIN_RATE = 0.5

/**
 * Count how often the real map places each of `wanted`, and how often it does
 * so beside a wall.
 *
 * This reads every region file, which is the expensive part of indexing — but
 * it is what turns "an object whose name contains 'torch'" into "an object the
 * game actually uses, outdoors". Counts only the ids we care about, so memory
 * stays flat regardless of how big the map is.
 */
export async function countPlacements(
  mapsDir: FileSystemDirectoryHandle,
  wanted: Set<number>,
  onProgress?: (done: number, total: number) => void,
  signal?: { cancelled: boolean },
): Promise<Map<number, PlacementStat>> {
  const counts = new Map<number, PlacementStat>()
  const bump = (id: number, wall: boolean, plane: number, above: number | undefined) => {
    let s = counts.get(id)
    if (!s) counts.set(id, (s = { uses: 0, nearWall: 0, ground: 0, above: new Map() }))
    s.uses++
    if (wall) s.nearWall++
    if (plane === 0) {
      s.ground++
      if (above !== undefined) s.above.set(above, (s.above.get(above) ?? 0) + 1)
    }
  }
  let total = 0
  for await (const h of mapsDir.values()) {
    if (signal?.cancelled) return counts
    if (h.kind === 'file' && h.name.endsWith('.json')) total++
  }

  let done = 0
  let lastTick = 0
  for await (const h of mapsDir.values()) {
    if (signal?.cancelled) break
    if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
    done++
    try {
      const text = await (await (h as FileSystemFileHandle).getFile()).text()
      const objs = readPlacements(text)
      if (objs?.length) {
        // wall tiles keyed per plane, so a ground-floor object isn't called
        // "indoors" by a wall directly above it
        const walls = new Set<number>()
        // what sits on plane 1 at each tile, for the two-part-tree pairing
        const above = new Map<number, number>()
        for (const o of objs) {
          if (WALL_SHAPES.has(o[1])) walls.add((o[5] << 16) | (o[3] << 8) | o[4])
          if (o[5] === 1) above.set((o[3] << 8) | o[4], o[0])
        }
        for (const o of objs) {
          if (!wanted.has(o[0])) continue
          let near = false
          for (let dx = -2; dx <= 2 && !near; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
              const x = o[3] + dx
              const y = o[4] + dy
              if (x < 0 || y < 0 || x > 63 || y > 63) continue
              if (walls.has((o[5] << 16) | (x << 8) | y)) { near = true; break }
            }
          }
          bump(o[0], near, o[5], o[5] === 0 ? above.get((o[3] << 8) | o[4]) : undefined)
        }
      }
    } catch { /* unreadable region — skip */ }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - lastTick >= 120) {
      lastTick = now
      onProgress?.(done, total)
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  onProgress?.(done, total)
  return counts
}

export async function buildSceneryIndex(
  objectsDir: FileSystemDirectoryHandle,
  fingerprint: string,
  /** `total` is 0 during the counting pass, then the real file count */
  onProgress?: (done: number, found: number, total: number) => void,
  signal?: { cancelled: boolean },
  onStats?: (stats: ScanStats) => void,
  /** the maps folder, for the frequency prior. Omitted = names only. */
  mapsDir?: FileSystemDirectoryHandle | null,
  onCountProgress?: (done: number, total: number) => void,
): Promise<SceneryIndex> {
  const species: SceneryIndex['species'] = {}
  let done = 0
  let found = 0
  const stats: ScanStats = { entries: 0, jsonFiles: 0, named: 0, placeable: 0, matched: 0, cancelled: false }

  // Count first, so the scan can report a real fraction. Listing names is far
  // cheaper than opening files, and this runs once per cache — reporting
  // "50,000 objects" with no denominator tells you nothing about how long is
  // left, which is the only thing a progress readout is for.
  let total = 0
  for await (const handle of objectsDir.values()) {
    if (signal?.cancelled) break
    if (handle.kind === 'file' && handle.name.endsWith('.json')) total++
    if ((total & 0xfff) === 0) {
      onProgress?.(0, 0, 0)
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // Throttle by TIME, not by file count. At 1 update per 1024 files the rate
  // swings with how fast the disk is answering, so the readout jumped in
  // thousands; a fixed interval also guarantees the browser gets to paint.
  let lastTick = 0
  const tick = async (force = false) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!force && now - lastTick < 120) return
    lastTick = now
    onProgress?.(done, found, total)
    await new Promise((r) => setTimeout(r, 0))
  }

  let cancelled = false
  for await (const handle of objectsDir.values()) {
    stats.entries++
    if (signal?.cancelled) { cancelled = true; break }
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (Number.isNaN(id)) continue
    done++
    stats.jsonFiles++
    try {
      const text = await (await (handle as FileSystemFileHandle).getFile()).text()
      // cheap pre-filter: skip the parse entirely for the ~90% of objects
      // whose name can't match anything in the vocabulary
      if (!text.includes('"name"')) continue
      stats.named++
      const def = JSON.parse(text) as { name?: string; objectModelIds?: unknown; shapes?: number[] }
      if (!isPlaceableScenery(def)) continue
      stats.placeable++
      const match = matchSpecies(def.name!)
      if (!match) continue
      stats.matched++
      const list = species[match] ?? (species[match] = [])
      list.push({ id, name: def.name!, uses: 0, indoor: 0, ground: 1 })
      found++
    } catch { /* unreadable object — skip */ }
    await tick()
  }

  // --- the frequency prior -------------------------------------------------
  // Ask the real map how often it places each candidate. Without this the only
  // signal is the name, which is how a tropical stump ended up on a snowy
  // island and how three objects that exist nowhere in the game got planted.
  let weighted = false
  const canopies: Record<number, number> = {}
  if (mapsDir && !cancelled && !signal?.cancelled) {
    const wanted = new Set<number>()
    for (const key of Object.keys(species) as SpeciesId[]) {
      for (const e of species[key]!) wanted.add(e.id)
    }
    try {
      const counts = await countPlacements(mapsDir, wanted, onCountProgress, signal)
      for (const key of Object.keys(species) as SpeciesId[]) {
        for (const e of species[key]!) {
          const s = counts.get(e.id)
          e.uses = s?.uses ?? 0
          e.indoor = s && s.uses ? s.nearWall / s.uses : 0
          e.ground = s && s.uses ? s.ground / s.uses : 1
          // The commonest thing the game puts directly above this one. Only a
          // canopy if it happens most of the time — a tree standing under a
          // bridge once must not teach us that trees carry bridges.
          if (s && s.ground > 0) {
            let bestId = 0
            let bestN = 0
            for (const [id, n] of s.above) if (n > bestN) { bestId = id; bestN = n }
            if (bestN / s.ground >= CANOPY_MIN_RATE) canopies[e.id] = bestId
          }
        }
      }
      weighted = !signal?.cancelled
    } catch { /* no maps folder, or unreadable — fall back to names alone */ }
  }

  for (const key of Object.keys(species) as SpeciesId[]) {
    let list = species[key]!
    if (weighted) {
      // Drop what the game never places, then what it only places indoors —
      // each only if something survives. A species the map genuinely never
      // uses outdoors stays as-is rather than silently vanishing from the
      // vocabulary, so a plan asking for it still gets something and the
      // shortfall is visible instead of mysterious.
      const used = list.filter((e) => e.uses > 0)
      if (used.length) list = used
      // Canopies before furniture: an oak canopy is 0% ground and 0% indoor,
      // so filtering by indoor share alone would keep it.
      const onGround = list.filter((e) => e.ground >= GROUND_CUTOFF)
      if (onGround.length) list = onGround
      const outdoor = list.filter((e) => e.indoor < INDOOR_CUTOFF)
      if (outdoor.length) list = outdoor
    }
    // Commonest first. This also subsumes the old heuristic: we used to prefer
    // the shortest name to get "Oak" rather than "Diseased Oak", which was a
    // proxy for "the ordinary one" — real usage measures that directly. Name
    // length stays as the tiebreak for unweighted or all-zero lists.
    list.sort((a, b) => outdoorUses(b) - outdoorUses(a)
      || a.name.length - b.name.length
      || a.name.localeCompare(b.name))
    species[key] = list.slice(0, 8)
  }

  // keep only the canopies of ids that survived pruning, so the stored map
  // stays a handful of entries rather than one per candidate
  const kept: Record<number, number> = {}
  for (const key of Object.keys(species) as SpeciesId[]) {
    for (const e of species[key]!) if (canopies[e.id]) kept[e.id] = canopies[e.id]
  }
  const index: SceneryIndex = {
    fingerprint, builtAt: Date.now(), species, weighted, canopies: kept,
  }
  // Never cache a scan that was interrupted or matched nothing. The panel
  // cancels on unmount, so a single aborted first attempt used to write an
  // empty index that then satisfied every later "do we have one?" check.
  if (!cancelled && Object.keys(species).length) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
    } catch { /* quota — the index still works for this session */ }
  }
  stats.cancelled = cancelled
  onStats?.(stats)
  await tick(true)
  return index
}

/** Resolve a species to a concrete object id, or null when the cache has none. */
export function resolveSpecies(
  index: SceneryIndex | null,
  species: SpeciesId,
  rnd: () => number,
): number | null {
  const list = index?.species[species]
  if (!list?.length) return null
  // Pick in proportion to how often the REAL map uses each variant. The map's
  // own mix is the target, so a variant it places a thousand times should show
  // up a thousand times as often as one it places once — not equally, which is
  // what uniform choice did, and why a quest-prop "Beanstump" was as likely as
  // the ordinary stump.
  let total = 0
  for (const e of list) total += outdoorUses(e)
  if (total <= 0) return list[Math.floor(rnd() * list.length) % list.length].id
  let r = rnd() * total
  for (const e of list) {
    r -= outdoorUses(e)
    if (r < 0) return e.id
  }
  return list[list.length - 1].id
}

/** Species the plan asked for that this cache can't supply. */
export function missingSpecies(index: SceneryIndex | null, wanted: Iterable<SpeciesId>): SpeciesId[] {
  const out: SpeciesId[] = []
  for (const s of wanted) if (!index?.species[s]?.length) out.push(s)
  return out
}

/** Every species the vocabulary knows, for the UI and the Claude context doc. */
export const ALL_SPECIES = SPECIES_ORDER
