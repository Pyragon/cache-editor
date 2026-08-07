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
  species: Partial<Record<SpeciesId, { id: number; name: string }[]>>
}

const STORAGE_KEY = 'cache-editor:scenery-index'

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
  tree: [{ all: ['tree'], not: ['dead', 'stump', 'burnt', 'fallen', 'broken', 'magic', 'palm', 'evergreen'] }],

  // --- undergrowth
  bush: [{ all: ['bush'] }],
  fern: [{ all: ['fern'] }],
  plant: [{ all: ['plant'], not: ['pot'] }],
  flowers: [{ all: ['flower'] }],
  reeds: [{ all: ['reed'] }, { all: ['bulrush'] }],
  grass_tuft: [{ all: ['grass'], not: ['grassland'] }],
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
    return parsed.fingerprint === fingerprint ? parsed : null
  } catch {
    return null
  }
}

/**
 * Scan the objects dump and keep what the species vocabulary recognises.
 *
 * This reads every object file, which is slow (tens of thousands of small
 * reads) — hence the cache. `onProgress` is called often enough to drive a
 * bar; the scan yields to the event loop periodically so the UI stays alive.
 */
export async function buildSceneryIndex(
  objectsDir: FileSystemDirectoryHandle,
  fingerprint: string,
  onProgress?: (done: number, found: number) => void,
  signal?: { cancelled: boolean },
): Promise<SceneryIndex> {
  const species: SceneryIndex['species'] = {}
  let done = 0
  let found = 0

  for await (const handle of objectsDir.values()) {
    if (signal?.cancelled) break
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (Number.isNaN(id)) continue
    done++
    try {
      const text = await (await (handle as FileSystemFileHandle).getFile()).text()
      // cheap pre-filter: skip the parse entirely for the ~90% of objects
      // whose name can't match anything in the vocabulary
      if (!text.includes('"name"')) continue
      const def = JSON.parse(text) as { name?: string; objectModelIds?: unknown; shapes?: number[] }
      if (!isPlaceableScenery(def)) continue
      const match = matchSpecies(def.name!)
      if (!match) continue
      const list = species[match] ?? (species[match] = [])
      list.push({ id, name: def.name! })
      found++
    } catch { /* unreadable object — skip */ }
    if (onProgress && (done & 0x3ff) === 0) {
      onProgress(done, found)
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // Prefer the ORDINARY member of a species. A cache has one "Oak" and a
  // dozen "Diseased Oak"/"Evil oak tree"/"Carved oak bench"-ish variants, and
  // a forest of diseased oaks is not what "oak" meant. Shorter, plainer names
  // sort first, then we keep a handful for variety.
  for (const key of Object.keys(species) as SpeciesId[]) {
    const list = species[key]!
    list.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
    species[key] = list.slice(0, 8)
  }

  const index: SceneryIndex = { fingerprint, builtAt: Date.now(), species }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
  } catch { /* quota — the index still works for this session */ }
  onProgress?.(done, found)
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
  return list[Math.floor(rnd() * list.length) % list.length].id
}

/** Species the plan asked for that this cache can't supply. */
export function missingSpecies(index: SceneryIndex | null, wanted: Iterable<SpeciesId>): SpeciesId[] {
  const out: SpeciesId[] = []
  for (const s of wanted) if (!index?.species[s]?.length) out.push(s)
  return out
}

/** Every species the vocabulary knows, for the UI and the Claude context doc. */
export const ALL_SPECIES = SPECIES_ORDER
