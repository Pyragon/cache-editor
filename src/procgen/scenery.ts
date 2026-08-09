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

import type { RoleId, SceneryChoice, SpeciesId, SpeciesPick } from './types'
import { calculateTileHeight } from '../components/terrainNoise'
import {
  contextLikelihood, emptyModel, finalise, MIN_GROUND_SIGHTINGS, observe, seenOnGround,
  type ContextModel, type TileContext,
} from './context'
import { saveArchetypes, saveContextModel } from './modelStore'
import { buildArchetypes, type ArchetypeModel, type RegionSignature } from './archetypes'
import { emptyDockModel, finaliseDocks, observeDocks, type DockModel } from './docks'
import { loadWorldAreas } from './worldAreas'
import { emptyTemplateModel, finaliseTemplates, observeTemplates, type TemplateModel } from './templates'
import { dropMarkerObjects, findMarkerObjects, flattenModelIds } from './markers'
import {
  emptyBuildingModel, finaliseBuildings, observeBuildings, WALL_SHAPES as BUILDING_WALL_SHAPES,
  type BuildingModel,
} from './buildings'

/** id → name, only for entries a species pattern matched. */
export type SceneryIndex = {
  /** cache fingerprint this was built from */
  fingerprint: string
  builtAt: number
  species: Partial<Record<SpeciesId, SceneryEntry[]>>
  /** false when the maps folder couldn't be read, so `uses` is meaningless */
  weighted?: boolean
  /**
   * Ground object id → the locs the game stacks ABOVE it, lowest first.
   *
   * Multi-part trees: an oak is a trunk (#38731) on plane 0 with its canopy
   * (#38736) on plane 1; a tropical tree is three locs — stump 1326, trunk
   * 1327, crown 1328. Emitting only the ground part gives a wood of bare
   * poles. Measured from the real map, which stacks them at the same tile with
   * the SAME shape and the same rotation (99.3% of 2,439 oak pairs).
   */
  canopies?: Record<number, CanopyLayer[]>
  /**
   * The dock vocabulary, mined in the same pass (§15). Carried by ID because
   * most dock parts are UNNAMED, so nothing in the species vocabulary can
   * reach them — which is exactly why generated fishing villages have never
   * had a waterfront.
   */
  docks?: DockModel
  /**
   * The building vocabulary, mined in the same pass: wall material families,
   * which shapes each wall id can be drawn as, real doors, and furniture by
   * distance to the nearest wall. Carried by ID for the same reason docks are.
   */
  buildings?: BuildingModel
  /**
   * Real buildings lifted from the map — footprint, every wall loc, doors,
   * classified by purpose. The prefab path replays these; see `templates.ts`
   * for why synthesis alone was not enough.
   */
  templates?: TemplateModel
}

/**
 * One level of a multi-part tree, in order: index 0 is plane 1, index 1 is
 * plane 2, and so on. A tropical tree is THREE locs — stump 1326 on plane 0,
 * trunk 1327 on plane 1, crown 1328 on plane 2 (59% of them) — so a single
 * partner could only ever build two thirds of one. Oak, yew and evergreen
 * stop at one layer.
 *
 * `size` is the loc's footprint (max of sizeX/sizeY), because the renderer
 * samples its height at vertices derived from that footprint — `x + (size>>1)`
 * and `x + ((size+1)>>1)` — not at the loc's own tile. An oak canopy is 3x3
 * and samples x+1/x+2; a tropical is 1x1 and samples x/x+1.
 *
 * `lift` is the height BYTE to store on that plane, or -1 to leave it unset.
 * It is species-specific: unset leaves the renderer's default of a full storey
 * (960) below the plane beneath, which is right for a tropical tree at every
 * level and badly wrong for an oak (72% store byte 1 — plane 1 flush with the
 * ground, its canopy model carrying its own height). Heights are cumulative,
 * so each layer stacks on the one below.
 */
export type CanopyLayer = { id: number; lift: number; size: number }

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
  /**
   * Fraction of placements with another copy of the SAME object within 2 tiles
   * — i.e. how much this thing only ever appears as part of a group.
   *
   * This is the measurable form of a lesson §12a paid for twice: usage says the
   * game places a thing, never that it can stand on its own. A "Fishing ledge"
   * passed every statistical test and was dock trim with no dock. Object 29018
   * did the same — 7 of its 16 placements are genuinely on dirt, so no
   * context gate can touch it, but it is **87.5% self-adjacent**: a flat slab
   * authored to sit in a row making a formation, useless alone.
   *
   * Measured separation is wide: standalone rock runs 0-46% (Boulder 19205 0%,
   * Rock 60271/60272 0%, Boulder 444 45.8%) while composition pieces run 82%+
   * (Rubble 2509 82.4%, 29018 87.5%, Granite rocks 10947 100%).
   */
  grouped: number
}

/**
 * At or above this share of self-adjacent placements, an object is a piece of a
 * COMPOSITION rather than a thing — it is authored to sit in a run with copies
 * of itself and reads as debris alone. Scatter places singletons, so these are
 * dropped from the pool.
 *
 * Measured separation is wide and the cutoff sits in the middle of it:
 * standalone rock runs 0-46% (Boulder 19205 0%, Rock 60271/60272 0%, Rock 441
 * 31%, Boulder 444 45.8%), composition pieces 82%+ (Rubble 2509 82.4%, Rocks
 * 29018 87.5%, Granite rocks 10947 100%).
 *
 * Rubble at 82.4% is a deliberate casualty: it does genuinely come in patches,
 * and a single scattered piece of it is no better than a single slab. If
 * clustered placement ever lands, these become candidates for it rather than
 * exclusions.
 */
const GROUPED_CUTOFF = 0.65

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

/**
 * BUMP THIS whenever the stored shape changes.
 *
 * v11 added `grouped` (self-adjacency), which a cached v10 index reports as
 * undefined for every entry — so the composition-piece filter would silently
 * pass everything and 29018 would come straight back.
 * v10 dropped `fishing_ledge` and `fishing_spot`; a cached v9 index still
 * lists them, and the brief offers whatever the index has.
 * v9 made `well` an EXACT name match, so a cached v8 index keeps its Magic
 * wells and Oil Wells forever without this.
 * v8 added the waterside species (`fishing_ledge`, `fishing_spot`, `nettles`),
 * which a cached v7 index has no entries for — so the `waterside` role would
 * resolve to nothing at all until a rescan.
 * v2 added `uses`; v3 changed `canopies` from a bare id to `{ id, lift }`; v4
 * because v3 recorded `lift: -1` for everything — `readChannel` was failing on
 * 1,676 of 1,677 regions and the wrong answer was already cached; v5 added
 * the canopy's footprint `size`, without which big canopies float; v6 made
 * `canopies` a STACK, because a tropical tree is three locs, not two; v7
 * appends the tropical crown (CROWN_BY_TOP_NAME).
 * Missing the v3 bump shipped a real bug: the cached v2 payload still held
 * plain numbers, so `canopy.id` read `undefined` and every tree emitted a loc
 * with no object id — canopies silently vanished. The fingerprint is stable by
 * design now (it identifies the cache, not its contents), so it no longer
 * launders schema changes the way the old region-count key accidentally did.
 * Nothing else will catch this for you.
 */
// v12: the index now carries the mined DOCK model (§15). Bumping this is not
// optional on a stored-shape change — missing it has already shipped one silent
// bug, where an old index satisfied the "do we have one?" check and the new
// field was simply never there.
//
// v21: corner capture narrowed — a diagonal tile contributes a corner post and
// nothing else. A v20 template carries whatever unrelated wall stood diagonally
// off a straight run, replayed as a panel jutting out of the corner.
//
// v21: corner-post capture is restricted to shapes 1/3 on diagonal tiles — a
// v20 template carries whatever unrelated wall stood diagonally off a straight
// run, which replayed as a panel jutting out of the corner.
//
// v20: templates capture their corner posts (8-neighbourhood) and their stored
// box now covers the walls, not just the interior. A v19 template is missing
// every corner and understates its own size by two tiles in each axis.
//
// v19: templates carry their own CONTENTS. A v18 template has walls only, and
// stamping one ran the furniture scatter over the interior instead.
//
// v18: templates are gated on self-enclosure — a v17 index carries the 43%
// that cannot seal their own tiles.
//
// v17: template purposes changed — `kitchen` folded into `house`, and `tower`
// re-derived (a v16 index has 286 of 667 buildings mislabelled as towers).
//
// v16: the index carries mined BUILDING TEMPLATES (`templates.ts`) — real
// buildings with their real walls, classified by purpose. A v15 index has none.
//
// v15: interior objects are CLASSIFIED (floor / wallDecor / freestanding, with
// roofs excluded and purpose fixtures tagged), and ranked by distinct buildings
// rather than raw placements. A v14 `Furniture` entry has none of those fields.
//
// v14: buildings are detected by an EDGE flood matching the client's own wall
// clipping, which finds 969 buildings where the tile flood found 387 and gives
// families a median of 5 wall ids instead of 1. Every stored family is a
// different shape of object, and the ground histograms they carried are gone —
// wall context now lives in the shared context model, bumped to v3 alongside.
//
// v13: the mine is now RESTRICTED TO THE OVERWORLD (`worldAreas.ts`). This is a
// corpus change rather than a schema change, and it needs the bump just as
// badly: a cached v12 index is byte-valid and completely wrong, having learned
// its doors, decks and wall families from dungeons and test areas. Context
// models and archetypes are versioned separately (`modelStore.ts`) and were
// bumped alongside for the same reason — they are mined from the same walk.
const STORAGE_KEY = 'cache-editor:scenery-index:v21'

/**
 * How each species is recognised. `any` terms must all appear (in order-free
 * fashion) and `not` terms must not; the first pattern to match wins, so more
 * specific species are listed before their generic parents in SPECIES_ORDER.
 *
 * These are matched against the LOWERCASED object name. Kept deliberately
 * conservative — a wrong match plants the wrong thing across a whole forest,
 * and a missed species just means that species is unavailable and is reported.
 */
/**
 * `exact` means the WHOLE name must be the terms joined, not merely contain
 * them (a trailing plural 's' is still allowed).
 *
 * Word matching is not enough when the qualifier changes what the object IS.
 * `well` is the case that forced this: sorted by real outdoor usage the species
 * resolved to **Magic well, Magic well, Oil Well** ahead of every plain Well,
 * and the same rule also matched "Well stacked rocks". A Magic well's model is
 * a pipe — asking for a well and getting one is not a near miss, it is a
 * different object. Cody, 2026-08-07: "let's just make sure our 'wells' are
 * just objects named 'well'".
 *
 * Use it sparingly: it is right when a qualifier makes the object something
 * else, and wrong for the ordinary case where a qualifier is just a variant
 * ("Diseased oak" is still an oak).
 */
type SpeciesPattern = { all: string[]; not?: string[]; exact?: boolean }

const PATTERNS: Record<SpeciesId, SpeciesPattern[]> = {
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
  nettles: [{ all: ['nettle'] }],
  // `fishing_ledge` / `fishing_spot` used to live here. Removed 2026-08-07 —
  // see the note on `SpeciesId` in `types.ts`. A fishing spot is an NPC in this
  // game, and a fishing ledge is dock trim with no dock under it.

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
  // exact: "Magic well" and "Oil Well" are pipes and derricks, not wells, and
  // both outranked every real one on usage. 18 objects are named exactly
  // "Well", so this stays well supplied.
  well: [{ all: ['well'], exact: true }],
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
 * Which species can fill each ROLE.
 *
 * A role is what a plan should name instead of a species — see `RoleId` in
 * `types.ts` for why. Membership is deliberately generous: the point is to hand
 * the whole plausible vocabulary to the scorer and let the MAP decide which
 * member belongs on this ground, rather than deciding it here from intuition.
 * Narrowing a role by hand would put back exactly the guess roles exist to
 * remove.
 *
 * Note what this means for `canopy`: jungle and temperate trees are in the same
 * role and compete on every tile. That is only safe because the context model
 * exists — scored on global frequency alone, tropical trees would take about a
 * third of every wood in the game (`docs/map-learning.md` §11).
 */
export const ROLE_SPECIES: Record<RoleId, SpeciesId[]> = {
  canopy: [
    'tree', 'tree_oak', 'tree_willow', 'tree_maple', 'tree_yew', 'tree_magic',
    'tree_evergreen', 'tree_palm', 'tree_tropical',
  ],
  deadwood: ['tree_dead', 'tree_burnt', 'tree_fallen', 'tree_stump'],
  undergrowth: [
    'bush', 'fern', 'plant', 'plant_jungle', 'flowers', 'grass_tuft',
    'grass_jungle', 'mushroom', 'reeds', 'nettles',
  ],
  loose_stone: ['rock_small', 'rock_large', 'boulder', 'rubble', 'stalagmite'],
  ore: [
    'ore_copper', 'ore_tin', 'ore_iron', 'ore_coal', 'ore_silver', 'ore_gold',
    'ore_mithril', 'ore_adamant', 'ore_rune', 'ore_clay', 'ore_essence',
  ],
  enclosure: ['fence', 'fence_gate', 'hedge', 'wall_stone'],
  settlement_prop: ['crate', 'barrel', 'bench', 'well', 'signpost', 'statue', 'fountain', 'campfire'],
  light: ['torch', 'lantern', 'lamp_post', 'candles'],
  memorial: ['gravestone'],
  // Now the damp MARGIN rather than a waterfront: the two fishing objects that
  // made it more than that turned out to be unplaceable on their own. Anything
  // that reads as a built waterfront needs the structural work, not a role.
  waterside: ['reeds', 'nettles'],
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
  const lower = name.toLowerCase().trim()
  for (const species of SPECIES_ORDER) {
    for (const pat of PATTERNS[species]) {
      if (pat.exact) {
        const want = pat.all.join(' ')
        if (lower !== want && lower !== `${want}s`) continue
        return species
      }
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
    // Structural check as well as the version key, because getting this wrong
    // is invisible: a stale canopy shape doesn't throw, it just silently stops
    // producing foliage. Cheap to verify, and a rebuild is the safe answer.
    for (const layers of Object.values(parsed.canopies ?? {})) {
      if (!Array.isArray(layers) || !layers.length) return null
      for (const l of layers) {
        if (typeof l?.id !== 'number' || typeof l?.lift !== 'number' || typeof l?.size !== 'number') return null
      }
    }
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

const MAP_SIZE = 64
const MAP_TILES = 4 * MAP_SIZE * MAP_SIZE

/**
 * Pull one base64 terrain channel straight out of the region text.
 *
 * Textual, to avoid a full `JSON.parse` of a file that is mostly channels we
 * don't want — but that means the captured value is still **JSON-escaped**,
 * and it must be unescaped before it is base64 at all.
 *
 * Gson's HTML-safe encoder writes base64 `=` padding as `=`, so 1,676 of
 * the 1,677 regions carrying plane-1 objects end `...AAAA==`. Handing
 * that to `atob` throws. This was shipped once: the failure was total and
 * completely silent — `lift` fell back to "unknown" for every species, every
 * canopy lost its height, and the only symptom was foliage hovering a storey
 * above its trunk. Verifying with `JSON.parse` in a test and shipping a regex
 * is exactly how it got through, because the two differ *only* on escaping.
 *
 * The length check stays: `atob` also tolerates some junk silently, and a
 * short array here is worse than none.
 */
function readChannel(text: string, field: string, expect: number): Uint8Array | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(text)
  if (!m?.[1]) return null
  let b64: string
  try {
    // safe to wrap: base64 never contains a quote, so the capture can't have
    // been cut short by an escaped one
    b64 = JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
  // some dumps HTML-entity-encode instead; harmless when they don't
  b64 = b64.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
  try {
    const bin = atob(b64)
    if (bin.length !== expect) return null
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export type PlacementStat = {
  uses: number
  nearWall: number
  ground: number
  /** placements with another copy of the SAME object within 2 tiles */
  selfAdj: number
  /** plane (1..3) → object ids seen directly above this one, and how often */
  above: Map<number, Map<number, number>>
  /**
   * plane (1..3) → how high that plane sat at those tiles: the stored height
   * byte, or -1 when the region stored none (which the renderer treats as a
   * full storey up). Heights are cumulative, so plane 2 stacks on plane 1.
   */
  lift: Map<number, Map<number, number>>
}

/** Below this pair rate, a plane-1 neighbour is a coincidence, not a canopy. */
const CANOPY_MIN_RATE = 0.5

/**
 * Extra top segment to append to a measured stack, keyed by the name of the
 * stack's own top segment. A DELIBERATE deviation from the map — see the block
 * in `buildSceneryIndex` for the measurement that says the map doesn't do this.
 * Name-driven rather than id-driven so it survives a different dump.
 */
const CROWN_BY_TOP_NAME: Record<string, string> = {
  'tropical tree': 'tropical leaves',
}

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
  /** filled in as we go: what CONTEXT the map places each candidate in */
  model?: ContextModel,
  /**
   * filled in as we go: one signature per region, for the archetype clustering.
   * Collected in THIS pass for the same reason the context model is — reading
   * 2,413 region files is the expensive part, and a third walk over the same
   * bytes to learn a third thing about them would be the wrong trade.
   */
  signatures?: RegionSignature[],
  /** object id → species, so a signature can carry a species mix */
  speciesOf?: Map<number, SpeciesId>,
  /**
   * filled in as we go: the dock model (§15). Same reasoning as the context
   * model and the archetype signatures — the region files are already open.
   */
  docks?: { model: DockModel; deckIds: Set<number> },
  /** filled in as we go: the building model (walls, doors, furniture) */
  buildings?: {
    model: BuildingModel; doorIds: Set<number>; nameOf: (id: number) => string | undefined
    templates: TemplateModel
  },
  /**
   * Only mine these region ids — the overworld, per `worldAreas.ts`. Omitting
   * it mines the whole dump, which is how a door used 1,459 times in a single
   * unlisted region became the door on every synthesised house. Callers that
   * cannot build the set must say so rather than quietly passing undefined.
   */
  regionFilter?: Set<number> | null,
): Promise<Map<number, PlacementStat>> {
  const counts = new Map<number, PlacementStat>()
  const tally = (m: Map<number, Map<number, number>>, plane: number, v: number) => {
    let inner = m.get(plane)
    if (!inner) m.set(plane, (inner = new Map()))
    inner.set(v, (inner.get(v) ?? 0) + 1)
  }
  const bump = (
    id: number, wall: boolean, plane: number,
    /** plane (1..3) → the loc stacked there, and that plane's stored height */
    stack: { plane: number; above: number; lift: number }[],
    /** another copy of this same object sits within 2 tiles */
    grouped: boolean,
  ) => {
    let s = counts.get(id)
    if (!s) counts.set(id, (s = { uses: 0, nearWall: 0, ground: 0, selfAdj: 0, above: new Map(), lift: new Map() }))
    s.uses++
    if (wall) s.nearWall++
    if (grouped) s.selfAdj++
    if (plane === 0) {
      s.ground++
      for (const l of stack) {
        tally(s.above, l.plane, l.above)
        tally(s.lift, l.plane, l.lift)
      }
    }
  }
  /** the region id a map file is for, or NaN if the name isn't one */
  const ridOf = (name: string) => parseInt(name.slice(0, -5), 10)
  const mines = (name: string) => {
    if (!regionFilter) return true
    const rid = ridOf(name)
    return !Number.isNaN(rid) && regionFilter.has(rid)
  }

  let total = 0
  for await (const h of mapsDir.values()) {
    if (signal?.cancelled) return counts
    if (h.kind === 'file' && h.name.endsWith('.json') && mines(h.name)) total++
  }

  let done = 0
  let lastTick = 0
  for await (const h of mapsDir.values()) {
    if (signal?.cancelled) break
    if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
    // Skipped BEFORE the file is opened: reading 2,413 regions to discard
    // 1,800 of them is most of the index build's cost.
    if (!mines(h.name)) continue
    done++
    try {
      const text = await (await (h as FileSystemFileHandle).getFile()).text()
      const objs = readPlacements(text)
      if (objs?.length) {
        // wall tiles keyed per plane, so a ground-floor object isn't called
        // "indoors" by a wall directly above it
        const walls = new Set<number>()
        // what sits on planes 1-3 at each tile, for multi-part trees
        const above: Map<number, number>[] = [new Map(), new Map(), new Map()]
        // Tiles occupied by each candidate object, so a placement can be asked
        // whether it stands alone or is part of a run of its own kind.
        const own = new Map<number, Set<number>>()
        for (const o of objs) {
          if (WALL_SHAPES.has(o[1])) walls.add((o[5] << 16) | (o[3] << 8) | o[4])
          if (o[5] >= 1 && o[5] <= 3) above[o[5] - 1].set((o[3] << 8) | o[4], o[0])
          if (wanted.has(o[0])) {
            let s = own.get(o[0])
            if (!s) own.set(o[0], (s = new Set()))
            s.add((o[5] << 16) | (o[3] << 8) | o[4])
          }
        }
        const isGrouped = (id: number, x: number, y: number, plane: number) => {
          const s = own.get(id)
          if (!s || s.size < 2) return false
          for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
              if (!dx && !dy) continue
              const nx = x + dx, ny = y + dy
              if (nx < 0 || ny < 0 || nx > 63 || ny > 63) continue
              if (s.has((plane << 16) | (nx << 8) | ny)) return true
            }
          }
          return false
        }
        // Heights are needed for the canopy lift AND for the context model's
        // height/slope features, so decode whenever either wants them.
        const anyUpper = above.some((m) => m.size > 0)
        const wantGround = !!model || !!signatures
        const hv = anyUpper || wantGround ? readChannel(text, 'heightValue', MAP_TILES) : null
        const hp = anyUpper || wantGround ? readChannel(text, 'heightPresence', MAP_TILES / 8) : null
        const und = wantGround ? readChannel(text, 'underlayIds', MAP_TILES) : null
        const ovl = wantGround || docks ? readChannel(text, 'overlayIds', MAP_TILES) : null
        // --- docks (§15): piers are locs over water, so this needs the plane-0
        // overlay slice and the raw placements, both already in hand.
        if (docks && ovl) {
          observeDocks(docks.model, docks.deckIds, ovl.subarray(0, MAP_SIZE * MAP_SIZE), objs)
        }
        // Region coords come from the FILENAME. They matter because a tile with
        // no stored height is not flat — it falls back to the client's terrain
        // noise, which is a function of world position.
        const rid = parseInt(h.name.slice(0, -5), 10)
        const rx = (rid >> 8) & 0xff
        const ry = rid & 0xff
        const heightAt = (x: number, y: number): number => {
          if (x < 0 || y < 0 || x > 63 || y > 63) return 0
          const ti = x * MAP_SIZE + y
          if (hv && hp && (hp[ti >> 3] & (1 << (ti & 0x7)))) {
            const v = hv[ti]
            return v === 1 ? 0 : v
          }
          return calculateTileHeight(rx * MAP_SIZE + x + 932731, ry * MAP_SIZE + y + 556238)
        }
        // --- buildings (§16): enclosed interiors, and the walls that seal them.
        // Runs here rather than above because the context observation needs
        // `heightAt`, and a wall belongs in the SAME context model as scenery —
        // "what does the real map put on ground like this" is one question, and
        // asking it twice with two mechanisms is how they drift apart.
        if (buildings) {
          observeBuildings(
            buildings.model, objs, (id) => buildings.doorIds.has(id),
            und ? und.subarray(0, MAP_SIZE * MAP_SIZE) : null,
            model && und && ovl
              ? (ids, ring) => {
                  if (!ring.length) return
                  // The ring is the COUNTRY the building stands in, so the
                  // context recorded for its walls is the modal ground around
                  // it — not the floor under it, which is town earth in every
                  // biome and would tell us nothing about where we are.
                  const uc = new Map<number, number>()
                  const oc = new Map<number, number>()
                  let hSum = 0
                  for (const ti of ring) {
                    uc.set(und[ti], (uc.get(und[ti]) ?? 0) + 1)
                    oc.set(ovl[ti], (oc.get(ovl[ti]) ?? 0) + 1)
                    hSum += heightAt((ti / MAP_SIZE) | 0, ti % MAP_SIZE)
                  }
                  const modal = (m: Map<number, number>) => {
                    let best = 0, bestN = -1
                    for (const [v, c] of m) if (c > bestN) { bestN = c; best = v }
                    return best
                  }
                  const cx = (ring[0] / MAP_SIZE) | 0, cy = ring[0] % MAP_SIZE
                  const hc = Math.round(hSum / ring.length)
                  const ctx = {
                    underlay: modal(uc),
                    overlay: modal(oc),
                    height: hc,
                    slope: Math.max(
                      Math.abs(hc - heightAt(cx + 1, cy)), Math.abs(hc - heightAt(cx - 1, cy)),
                      Math.abs(hc - heightAt(cx, cy + 1)), Math.abs(hc - heightAt(cx, cy - 1)),
                    ),
                    // a wall is by definition against a wall
                    wall: 0,
                  }
                  for (const id of ids) observe(model, id, ctx)
                }
              : undefined,
            // names, so a bank booth or an altar is classified as a PURPOSE
            // fixture rather than dropped into the generic furniture pool
            buildings.nameOf,
          )
          // Templates are a SECOND reading of the same region: the family mine
          // works room by room, a template is a whole merged building.
          observeTemplates(
            buildings.templates, objs, rid, buildings.nameOf,
            (id) => buildings.doorIds.has(id),
          )
        }

        // --- one region signature, for the archetype clustering
        if (signatures && und) {
          const sig: RegionSignature = {
            region: rid, tiles: 0, underlay: {}, overlay: {},
            flat: 0, relief: 0, scenery: 0, walls: 0, species: {},
          }
          for (let x = 0; x < MAP_SIZE; x++) {
            for (let y = 0; y < MAP_SIZE; y++) {
              const ti = x * MAP_SIZE + y
              const u = und[ti]
              if (!u) continue // no underlay = the region doesn't cover this tile
              sig.tiles++
              sig.underlay[u] = (sig.underlay[u] ?? 0) + 1
              const ov = ovl ? ovl[ti] : 0
              if (ov) sig.overlay[ov] = (sig.overlay[ov] ?? 0) + 1
            }
          }
          // Slope stats come from STORED heights only — deliberately. Filling
          // in the procedural fallback would mean ~4,096 terrain-noise
          // evaluations per region (about 10M across the map) to refine two
          // axes that carry the least weight in matching. Regions that store
          // no heights simply report flat/relief 0 and contribute nothing here.
          if (hv && hp) {
            const at = (x: number, y: number): number | null => {
              if (x < 0 || y < 0 || x > 63 || y > 63) return null
              const ti = x * MAP_SIZE + y
              if (!(hp[ti >> 3] & (1 << (ti & 0x7)))) return null
              const v = hv[ti]
              return v === 1 ? 0 : v
            }
            const slopes: number[] = []
            for (let x = 0; x < MAP_SIZE; x++) {
              for (let y = 0; y < MAP_SIZE; y++) {
                const h = at(x, y)
                if (h === null) continue
                let s = 0
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                  const n = at(x + dx, y + dy)
                  if (n !== null) s = Math.max(s, Math.abs(h - n))
                }
                slopes.push(s)
              }
            }
            if (slopes.length) {
              slopes.sort((a, b) => a - b)
              sig.flat = slopes.filter((s) => s === 0).length / slopes.length
              sig.relief = slopes[Math.min(slopes.length - 1, Math.floor(slopes.length * 0.9))]
            }
          }
          for (const o of objs) {
            if (WALL_SHAPES.has(o[1])) sig.walls++
            else if (o[5] === 0 && (o[1] === 10 || o[1] === 11 || o[1] === 22)) sig.scenery++
            if (o[5] === 0) {
              const sp = speciesOf?.get(o[0])
              if (sp) sig.species[sp] = (sig.species[sp] ?? 0) + 1
            }
          }
          signatures.push(sig)
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
          // everything stacked directly above this tile, with each plane's
          // stored height. Stops at the first empty plane: a gap means the
          // thing higher up belongs to something else, not to this tree.
          const stack: { plane: number; above: number; lift: number }[] = []
          if (o[5] === 0) {
            const key = (o[3] << 8) | o[4]
            for (let pl = 1; pl <= 3; pl++) {
              const id = above[pl - 1].get(key)
              if (id === undefined) break
              let lift = -1
              if (hv && hp) {
                const ti = pl * MAP_SIZE * MAP_SIZE + o[3] * MAP_SIZE + o[4]
                if (hp[ti >> 3] & (1 << (ti & 0x7))) lift = hv[ti]
              }
              stack.push({ plane: pl, above: id, lift })
            }
          }
          bump(o[0], near, o[5], stack, isGrouped(o[0], o[3], o[4], o[5]))
          // Ground placements only: everything the generator plants sits on
          // plane 0, and an upper-storey loc's context describes a building
          // interior we would only be able to mimic by accident.
          if (model && o[5] === 0 && und && ovl) {
            const x = o[3]
            const y = o[4]
            const ti = x * MAP_SIZE + y
            const hc = heightAt(x, y)
            observe(model, o[0], {
              underlay: und[ti],
              overlay: ovl[ti],
              height: hc,
              slope: Math.max(
                Math.abs(hc - heightAt(x + 1, y)), Math.abs(hc - heightAt(x - 1, y)),
                Math.abs(hc - heightAt(x, y + 1)), Math.abs(hc - heightAt(x, y - 1)),
              ),
              // same 2-tile test the indoor share uses, but graded, so the
              // model can tell "against a wall" from "in a courtyard"
              wall: near
                ? (walls.has((0 << 16) | ((x - 1) << 8) | y) || walls.has((0 << 16) | ((x + 1) << 8) | y)
                  || walls.has((0 << 16) | (x << 8) | (y - 1)) || walls.has((0 << 16) | (x << 8) | (y + 1))
                  || walls.has((0 << 16) | (x << 8) | y) ? 0 : 1)
                : 2,
            })
          }
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
  /**
   * The world map's own area definitions (`map_areas/`). Restricts every mined
   * vocabulary to the RuneScape Surface. Without it the mine learns from
   * dungeons, minigames and test areas as if they were the overworld — see
   * `worldAreas.ts` for what that actually produced.
   */
  areasDir?: FileSystemDirectoryHandle | null,
  /**
   * The models folder. Used only to decode the few hundred structural
   * candidates and drop the invisible marker anchors the client never draws
   * (`markers.ts`). Omitted = barrier walls stay in the wall vocabulary.
   */
  modelsDir?: FileSystemDirectoryHandle | null,
): Promise<{
  index: SceneryIndex
  contextModel: ContextModel | null
  archetypes: ArchetypeModel | null
  /** what the region filter did, so the UI can report it honestly */
  corpus: { surface: number; skipped: number; filtered: boolean; markersDropped: number }
}> {
  const species: SceneryIndex['species'] = {}
  let done = 0
  let found = 0
  const stats: ScanStats = { entries: 0, jsonFiles: 0, named: 0, placeable: 0, matched: 0, cancelled: false }
  /** object id → footprint size, needed to place a canopy's plane-1 height */
  const footprint = new Map<number, number>()
  /** object id → name, for the name-driven crown rule */
  const namesById = new Map<number, string>()
  /** ids that could be a dock deck — confirmed against the map in the scan */
  const deckCandidates = new Set<number>()
  /** wall-capable ids the player can Open, i.e. doors */
  const doorCandidates = new Set<number>()
  /**
   * Model ids per object, kept ONLY for the structural vocabularies (walls,
   * decks, doors). They are what `markers.ts` decodes to spot the invisible
   * anchors the client never draws — barrier walls were being built into
   * houses. Kept for these and not for scenery because scenery goes through
   * the name vocabulary, which an unnamed anchor can never reach anyway.
   */
  const modelIdsOf = new Map<number, number[]>()

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
      const def = JSON.parse(text) as {
        name?: string; objectModelIds?: unknown; shapes?: number[]
        sizeX?: number; sizeY?: number; obstructsGround?: boolean
        options?: (string | null)[]
      }
      // --- deck candidates, BEFORE the scenery filter ----------------------
      // A deck plank is a ground decoration that OBSTRUCTS the ground (§15).
      // This has to run above `isPlaceableScenery` because that rejects
      // `name === 'null'` and MOST DOCK PARTS ARE UNNAMED — 64496, 9453, 9454
      // and the whole 56916-56931 family. That is the same reason the species
      // vocabulary can never find a pier: it matches on name substrings, so it
      // reaches "Fishing ledge" (trim) and nothing a deck is made of.
      if (def.obstructsGround === true && def.objectModelIds
        && (!def.shapes || def.shapes.some((s) => s === 22))) {
        deckCandidates.add(id)
      }
      // A real door: a wall-capable object the player can Open. Collected here
      // for the same reason deck ids are — many are named 'null', and the ones
      // that are not ('Wall', 'Door', 'Large door') are not reachable through
      // the species vocabulary either.
      if (def.options?.some((o) => typeof o === 'string' && /^open$/i.test(o))
        && def.shapes?.some((sh) => BUILDING_WALL_SHAPES.has(sh))) {
        doorCandidates.add(id)
      }
      // Anything that could end up as a wall, a deck or a door needs its model
      // list kept so the marker filter can judge it later.
      if (def.objectModelIds
        && (deckCandidates.has(id) || doorCandidates.has(id)
          || def.shapes?.some((sh) => BUILDING_WALL_SHAPES.has(sh)))) {
        modelIdsOf.set(id, flattenModelIds(def.objectModelIds))
      }
      if (!isPlaceableScenery(def)) continue
      stats.placeable++
      // Footprint, kept for EVERY placeable object rather than only matched
      // ones: a canopy is discovered later from map data, and its height has
      // to be written at vertices derived from its size.
      footprint.set(id, Math.max(1, def.sizeX ?? 1, def.sizeY ?? 1))
      namesById.set(id, def.name!)
      const match = matchSpecies(def.name!)
      if (!match) continue
      stats.matched++
      const list = species[match] ?? (species[match] = [])
      list.push({ id, name: def.name!, uses: 0, indoor: 0, ground: 1, grouped: 0 })
      found++
    } catch { /* unreadable object — skip */ }
    await tick()
  }

  // --- the frequency prior -------------------------------------------------
  // Ask the real map how often it places each candidate. Without this the only
  // signal is the name, which is how a tropical stump ended up on a snowy
  // island and how three objects that exist nowhere in the game got planted.
  let weighted = false
  const canopies: Record<number, CanopyLayer[]> = {}
  // resolve the crown rule's NAMES to this cache's ids, lowest id wins
  const crownFor = new Map<string, number>()
  for (const [topName, crownName] of Object.entries(CROWN_BY_TOP_NAME)) {
    let best = -1
    for (const [id, n] of namesById) {
      if (n.toLowerCase() === crownName && (best < 0 || id < best)) best = id
    }
    if (best >= 0) crownFor.set(topName, best)
  }
  // Built in the SAME pass as the frequency counts. Reading 2,413 region files
  // is the expensive part of indexing; doing it twice to learn two things about
  // the same placements would be the wrong trade entirely.
  const contextModel = emptyModel(fingerprint)
  const signatures: RegionSignature[] = []
  const dockModel = emptyDockModel(fingerprint)
  const buildingModel = emptyBuildingModel(fingerprint)
  const templateModel = emptyTemplateModel(fingerprint)
  // The overworld region set, read before the map walk so it can filter it.
  const worldAreas = await loadWorldAreas(areasDir)
  const corpus = { surface: worldAreas?.surface.size ?? 0, skipped: 0, filtered: !!worldAreas, markersDropped: 0 }
  if (mapsDir && !cancelled && !signal?.cancelled) {
    const wanted = new Set<number>()
    const speciesOf = new Map<number, SpeciesId>()
    for (const key of Object.keys(species) as SpeciesId[]) {
      for (const e of species[key]!) { wanted.add(e.id); speciesOf.set(e.id, key) }
    }
    if (worldAreas) {
      for await (const h of mapsDir.values()) {
        if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
        const rid = parseInt(h.name.slice(0, -5), 10)
        if (!Number.isNaN(rid) && !worldAreas.surface.has(rid)) corpus.skipped++
      }
    }
    try {
      const counts = await countPlacements(
        mapsDir, wanted, onCountProgress, signal, contextModel, signatures, speciesOf,
        { model: dockModel, deckIds: deckCandidates },
        {
          model: buildingModel, doorIds: doorCandidates,
          nameOf: (id) => namesById.get(id), templates: templateModel,
        },
        worldAreas?.surface ?? null,
      )
      for (const key of Object.keys(species) as SpeciesId[]) {
        for (const e of species[key]!) {
          const s = counts.get(e.id)
          e.uses = s?.uses ?? 0
          e.indoor = s && s.uses ? s.nearWall / s.uses : 0
          e.ground = s && s.uses ? s.ground / s.uses : 1
          e.grouped = s && s.uses ? s.selfAdj / s.uses : 0
          // The commonest thing the game puts directly above this one. Only a
          // canopy if it happens most of the time — a tree standing under a
          // bridge once must not teach us that trees carry bridges.
          if (s && s.ground > 0) {
            // Walk upward until a plane isn't reliably occupied. A tropical
            // tree carries plane 1 always and plane 2 in 59% of cases.
            const layers: CanopyLayer[] = []
            for (let pl = 1; pl <= 3; pl++) {
              const seen = s.above.get(pl)
              if (!seen) break
              let bestId = 0
              let bestN = 0
              for (const [id, n] of seen) if (n > bestN) { bestId = id; bestN = n }
              if (bestN / s.ground < CANOPY_MIN_RATE) break
              // how high the game puts that plane — the modal value, since it
              // splits cleanly by species (oak/yew/evergreen store byte 1 =
              // flush; tropical stores nothing = a storey up, at every level)
              let lift = -1
              let liftN = 0
              for (const [v, n] of s.lift.get(pl) ?? []) if (n > liftN) { lift = v; liftN = n }
              // the layer's own footprint, falling back to the trunk's (they
              // match on every measured pair) and finally to 1
              layers.push({ id: bestId, lift, size: footprint.get(bestId) ?? footprint.get(e.id) ?? 1 })
            }
            // --- deliberate deviation from the map, by request ---------------
            // Cody wants tropical trees topped out: trunk -> trunk -> trunk ->
            // crown. The MODELS stack that way, but the map does NOT build the
            // column: "Tropical leaves" has 1,248 placements, all on planes 2
            // and 3, and its two commonest columns are `-/-/-/[1329]` (252) and
            // `-/-/[1329]/-` (201) — sitting alone with no trunk beneath. It is
            // area canopy hung over jungle, not a fourth tree segment (20%
            // exclusivity over 77 different ground objects, against 96% for the
            // real parts). Added anyway because it is his call and it reads
            // better; delete this block to go back to what the map does.
            const top = layers[layers.length - 1]
            if (top && crownFor.size) {
              const crown = crownFor.get((namesById.get(top.id) ?? '').toLowerCase())
              if (crown !== undefined && crown !== top.id) {
                layers.push({ id: crown, lift: -1, size: footprint.get(crown) ?? top.size })
              }
            }
            if (layers.length) canopies[e.id] = layers
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
  const kept: Record<number, CanopyLayer[]> = {}
  for (const key of Object.keys(species) as SpeciesId[]) {
    for (const e of species[key]!) if (canopies[e.id]) kept[e.id] = canopies[e.id]
  }
  // Docks ride along on the index rather than going to IndexedDB with the
  // context model: after pruning it is a couple of dozen families and parts,
  // kilobytes not megabytes.
  // --- purge the invisible anchors BEFORE either model is finalised ---------
  // Order matters: finalise sorts and truncates to the top N, so a marker left
  // in until afterwards has already taken a slot a real wall should have had.
  if (weighted) {
    const structural = new Set<number>([
      ...Object.keys(buildingModel.parts).map(Number),
      ...buildingModel.doors.map((d) => d.id),
      ...Object.keys(dockModel.parts).map(Number),
      ...dockModel.trim.map((t) => t.id),
    ])
    const markers = await findMarkerObjects(modelsDir, modelIdsOf, structural)
    if (markers.size) {
      corpus.markersDropped = markers.size
      dropMarkerObjects(buildingModel, dockModel, markers)
    }
  }
  if (weighted && dockModel.piers) finaliseDocks(dockModel)
  if (weighted && buildingModel.buildings) finaliseBuildings(buildingModel)
  if (weighted && templateModel.templates.length) finaliseTemplates(templateModel)
  const index: SceneryIndex = {
    fingerprint, builtAt: Date.now(), species, weighted, canopies: kept,
    docks: weighted && dockModel.piers ? dockModel : undefined,
    buildings: weighted && buildingModel.buildings ? buildingModel : undefined,
    templates: weighted && templateModel.templates.length ? templateModel : undefined,
  }
  // Never cache a scan that was interrupted or matched nothing. The panel
  // cancels on unmount, so a single aborted first attempt used to write an
  // empty index that then satisfied every later "do we have one?" check.
  if (!cancelled && Object.keys(species).length) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
    } catch { /* quota — the index still works for this session */ }
  }
  // The context model goes to IndexedDB, not localStorage: it is per-object
  // histograms over thousands of objects and runs to megabytes.
  if (weighted && !cancelled && Object.keys(contextModel.objects).length) {
    finalise(contextModel)
    void saveContextModel(contextModel)
  }
  // Archetypes are clustered from the signatures the same pass collected, so
  // "what kind of places does this cache have" costs no extra reads.
  let archetypes: ArchetypeModel | null = null
  if (!cancelled && signatures.length) {
    archetypes = buildArchetypes(signatures, fingerprint)
    if (archetypes.archetypes.length) void saveArchetypes(archetypes)
    else archetypes = null
  }
  stats.cancelled = cancelled
  onStats?.(stats)
  await tick(true)
  return {
    index,
    contextModel: weighted && !cancelled ? contextModel : null,
    archetypes,
    corpus,
  }
}

/** Resolve a species to a concrete object id, or null when the cache has none. */
export function resolveSpecies(
  index: SceneryIndex | null,
  species: SpeciesId,
  rnd: () => number,
  /** what the real map plants where; omitted = frequency prior only */
  model?: ContextModel | null,
  /** the tile being planted, in the cache's own units */
  ctx?: TileContext | null,
): number | null {
  const list = index?.species[species]
  if (!list?.length) return null
  // With a context model, weight each variant by how often the real map plants
  // it in ground like THIS — the thing global frequency cannot know. Without
  // one, this collapses to the frequency-only behaviour below.
  if (model && ctx && list.length > 1) {
    const w = list.map((e) => outdoorUses(e) * contextLikelihood(model, e.id, ctx))
    let total = 0
    for (const v of w) total += v
    if (total > 0) {
      let r = rnd() * total
      for (let i = 0; i < list.length; i++) {
        r -= w[i]
        if (r < 0) return list[i].id
      }
      return list[list.length - 1].id
    }
  }
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

/** What a scatter site resolved to: the object, and which species it came from. */
export type SceneryPick = { id: number; species: SpeciesId }

/**
 * Choose WHAT TO PLANT on one tile, scoring the whole (species, variant) space
 * in a single pass.
 *
 * ## Why this replaced pick-species-then-pick-variant
 *
 * The old path ran `pickWeighted(picks)` on the plan's weights and only THEN
 * let context choose among that species' variants. So context could pick a
 * different oak, but it could never say "not an oak" — a plan asking for
 * tropical trees on a temperate hillside got tropical trees, and the one
 * component that has actually read the map had no vote on the question that
 * matters most. Cody spotted this; `docs/map-learning.md` §10a records it.
 *
 * Here every candidate in every offered species competes at once, weighted by
 *
 *     species prior  x  outdoor uses  x  context likelihood
 *
 * ## The two priors, and why they are not the same
 *
 * - **A plan naming species** keeps its weights meaningful. If it says 70% oak
 *   / 30% dead, that ratio must survive, so each species' frequency mass is
 *   NORMALISED away and only its *average* context fit modulates the weight.
 *   Otherwise a species that happens to have twenty common variants would drown
 *   one that has a single rare variant, and the plan's numbers would be
 *   decoration.
 * - **A plan naming a role** hands the decision over entirely: the prior is the
 *   species' own real outdoor usage, so the map's own mix decides. That reduces
 *   to flat scoring across every (species, variant) pair, which is exactly what
 *   "let the generator supply the vocabulary" means.
 *
 * Both are the same arithmetic with a different prior, which is why they live
 * in one function rather than two that can drift apart.
 */
export function chooseScenery(
  index: SceneryIndex | null,
  choice: SceneryChoice,
  rnd: () => number,
  /** what the real map plants where; omitted = frequency prior only */
  model?: ContextModel | null,
  /** the tile being planted, in the cache's own units */
  ctx?: TileContext | null,
  /** species the plan asked for that this cache can't supply, collected */
  missing?: Set<SpeciesId>,
): SceneryPick | null {
  if (!index) return null
  const planned = choice.species?.length ? choice.species : null
  let list: SpeciesPick[]
  if (planned) {
    // Both given: the role NARROWS the explicit list rather than replacing it.
    // A role that excludes everything asked for is a plan bug, and planting
    // nothing would hide it — so fall back to honouring what was asked.
    const inRole = choice.role
      ? planned.filter((p) => ROLE_SPECIES[choice.role!].includes(p.species))
      : planned
    list = inRole.length ? inRole : planned
  } else if (choice.role) {
    list = ROLE_SPECIES[choice.role].map((species) => ({ species }))
  } else {
    return null
  }

  const fit = (id: number) => (model && ctx ? contextLikelihood(model, id, ctx) : 1)
  // Has the map ever put this object on THIS ground material? Likelihood alone
  // cannot answer it — it rewards being poorly observed — so an object seen
  // nine times, all on snow, outscored ordinary rock on a temperate shore. See
  // `seenOnGround` for the two smoothed scorers that failed first.
  const habitable = (id: number) =>
    !model || !ctx || seenOnGround(model, id, ctx) >= MIN_GROUND_SIGHTINGS
  /** a piece that only ever appears in a run of its own kind — never a singleton */
  const standalone = (e: SceneryEntry) => (e.grouped ?? 0) < GROUPED_CUTOFF
  const groups: { species: SpeciesId; prior: number; variants: { id: number; w: number }[] }[] = []
  let totalPrior = 0
  // Gate the WHOLE offered pool first, so "did anything survive" is asked once
  // across every species rather than per species — otherwise a species whose
  // every member is off-habitat would still field a candidate.
  const gated = new Set<number>()
  for (const p of list) {
    for (const e of index.species[p.species] ?? []) if (habitable(e.id) && standalone(e)) gated.add(e.id)
  }
  const anyHabitable = gated.size > 0
  for (const p of list) {
    const entries = index.species[p.species]
    if (!entries?.length) {
      // Only a plan that NAMED the species is missing something; a role simply
      // draws on whatever this cache happens to have.
      if (planned) missing?.add(p.species)
      continue
    }
    const usable = anyHabitable ? entries.filter((e) => gated.has(e.id)) : entries
    if (!usable.length) continue
    let variants = usable.map((e) => ({ id: e.id, w: outdoorUses(e) * fit(e.id) }))
    let mass = 0
    let uses = 0
    // `usable`, not `entries` — the two diverge once the affinity gate drops a
    // variant, and indexing the wrong one silently pairs a weight with another
    // object's usage count.
    for (let i = 0; i < variants.length; i++) { mass += variants[i].w; uses += outdoorUses(usable[i]) }
    if (mass <= 0) {
      // No outdoor usage at all for this species — which is what an index built
      // without map access looks like (`weighted` false). Fall back to context
      // alone, treating every variant as equally used, so an unweighted index
      // still resolves instead of silently planting nothing.
      variants = usable.map((e) => ({ id: e.id, w: fit(e.id) }))
      mass = 0
      for (const v of variants) mass += v.w
      uses = variants.length
    }
    if (mass <= 0) continue
    const prior = planned ? (p.weight ?? 1) * (mass / uses) : mass
    if (prior <= 0) continue
    groups.push({ species: p.species, prior, variants })
    totalPrior += prior
  }
  if (!groups.length || totalPrior <= 0) return null

  let r = rnd() * totalPrior
  let group = groups[groups.length - 1]
  for (const g of groups) {
    r -= g.prior
    if (r < 0) { group = g; break }
  }
  let mass = 0
  for (const v of group.variants) mass += v.w
  let vr = rnd() * mass
  for (const v of group.variants) {
    vr -= v.w
    if (vr < 0) return { id: v.id, species: group.species }
  }
  return { id: group.variants[group.variants.length - 1].id, species: group.species }
}

/** Species the plan asked for that this cache can't supply. */
export function missingSpecies(index: SceneryIndex | null, wanted: Iterable<SpeciesId>): SpeciesId[] {
  const out: SpeciesId[] = []
  for (const s of wanted) if (!index?.species[s]?.length) out.push(s)
  return out
}

/** Every species the vocabulary knows, for the UI and the Claude context doc. */
export const ALL_SPECIES = SPECIES_ORDER
