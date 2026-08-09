/**
 * The generation PLAN — the contract between whatever decides what a place
 * should be like and the deterministic code that builds it.
 *
 * ## Why a plan, and not "dials"
 *
 * The original design (docs/procgen.md phase 3) had Claude filling in the same
 * knobs the sliders edit. That is enough for "snowier" or "more mountainous",
 * and nowhere near enough for what was actually asked for:
 *
 *   - "a small town surrounded by forest, with barriers so you're trapped"
 *   - "a gloomy area" → dead trees specifically, and a dimmer SUN
 *   - "lights along the paths"
 *   - "a mine", "a stony area like Varrock", "a fountain"
 *
 * None of those are magnitudes. They are *relationships between features* —
 * a ring that follows a zone's boundary, a species chosen by mood, lamps
 * spaced along a path network, an environment record written to match. No
 * scalar knob expresses "impassable except for two gaps".
 *
 * The other extreme — having Claude emit tiles — is worse: megabytes of output,
 * no determinism, and nothing stops it producing an unrenderable region.
 *
 * So the plan sits in between. It is a small, closed vocabulary of ENTITIES
 * (zones, scatter rules, barrier rings, path networks, resource nodes, prop
 * placements, an environment override). Claude chooses the structure — which
 * zones exist, what grows where, where the walls go — and the generator turns
 * that into tiles deterministically. Same plan + same seed = same region,
 * every time, with or without a network connection.
 *
 * The important consequence: the built-in planner emits the SAME plan type
 * from presets and dials. The AI layer is not a separate code path, it is just
 * a better planner. Everything works with no API key.
 *
 * A plan is also plain JSON — reviewable before it is applied, editable by
 * hand, diffable, and storable next to the region it produced.
 */

/** Inclusive rectangle of REGIONS (region coords, 0-255). */
export type PlanArea = { x0: number; y0: number; x1: number; y1: number }

/**
 * A scenery kind, named rather than numbered. Object ids differ between caches
 * and mean nothing to a language model, so the plan speaks in species and
 * `scenery.ts` resolves them against the opened cache by name.
 */
export type SpeciesId =
  // trees
  | 'tree' | 'tree_oak' | 'tree_willow' | 'tree_maple' | 'tree_yew' | 'tree_magic'
  | 'tree_dead' | 'tree_burnt' | 'tree_stump' | 'tree_fallen' | 'tree_evergreen' | 'tree_palm'
  // Jungle/tropical variants are their own species, not members of the generic
  // buckets. Karamja is dense enough that weighting by real usage made tropical
  // trees ~30% of ALL trees and jungle grass 77% of all grass tufts — so a
  // snowfield grew jungle. See `docs/map-learning.md`.
  | 'tree_tropical'
  // undergrowth
  | 'bush' | 'fern' | 'plant' | 'flowers' | 'reeds' | 'grass_tuft' | 'mushroom'
  | 'grass_jungle' | 'plant_jungle' | 'nettles'
  // NOTE on the waterfront: `fishing_spot` and `fishing_ledge` were added here
  // and then REMOVED 2026-08-07 after Cody looked at them in the scene. Passing
  // the placement tests is not the same as being placeable on its own:
  //   - a fishing spot in RuneScape is an NPC, not scenery, so a scenery object
  //     named "Fishing spot" is never what a waterfront wants;
  //   - "Fishing ledge" is a slab of concrete authored to sit ON an existing
  //     dock, so standing alone at a shoreline it reads as debris.
  // Both looked like good candidates on the numbers (185 placements, 100% on
  // the ground, rarely near a wall) — which is the lesson: usage statistics say
  // the game places a thing, not that it can stand by itself. A real waterfront
  // is a multi-tile STRUCTURE (`docs/map-learning.md` §5), not a scatter rule.
  // stone
  | 'rock_small' | 'rock_large' | 'boulder' | 'rubble' | 'stalagmite'
  // ore-bearing
  | 'ore_copper' | 'ore_tin' | 'ore_iron' | 'ore_coal' | 'ore_silver'
  | 'ore_gold' | 'ore_mithril' | 'ore_adamant' | 'ore_rune' | 'ore_clay' | 'ore_essence'
  // built things
  | 'fountain' | 'well' | 'statue' | 'signpost' | 'crate' | 'barrel' | 'bench'
  | 'fence' | 'fence_gate' | 'wall_stone' | 'hedge' | 'gravestone' | 'campfire'
  // lights
  | 'torch' | 'lantern' | 'candles' | 'lamp_post'

/** One species with a relative weight inside a pick list. */
export type SpeciesPick = { species: SpeciesId; weight?: number }

/**
 * What a scatter rule is FOR, as opposed to what it plants.
 *
 * A role is the preferred way to write a rule, and species lists are the
 * escape hatch. The reason is that a plan is authored either by a hand-written
 * theme or by a language model reading a one-line description, and **neither
 * has read the map**. Writing `species: ['tree_tropical']` forces the author to
 * guess the biome; naming the role `canopy` lets the generator answer from
 * measurement — every species in the role competes, scored by how often the
 * real game plants it on ground like this one.
 *
 * This works because the plan already paints the ground, and **underlay is by
 * far the strongest predictor of what grows on it (34.5% of object identity,
 * `docs/map-learning.md` §12)**. Get the ground right and the vegetation
 * follows by itself, which is exactly what the real map does.
 *
 * Roles are only safe BECAUSE the context model exists. A role scored on global
 * frequency alone would walk straight back into the biome-conflation trap
 * (§11): jungle grass is 77% of all grass tufts in the game, so `undergrowth`
 * would carpet a snowfield in jungle. Context is what stops that.
 */
export type RoleId =
  /** the tree layer — whatever kind of tree belongs on this ground */
  | 'canopy'
  /** dead, burnt, fallen, stumps: the things a bleak or logged place has */
  | 'deadwood'
  /** bushes, ferns, plants, flowers, reeds, tufts, mushrooms */
  | 'undergrowth'
  /** rocks, boulders, rubble — scenery stone, not ore */
  | 'loose_stone'
  /** ore-bearing nodes, for mines and quarries */
  | 'ore'
  /** fences, gates, hedges, low stone walls — the things that divide land */
  | 'enclosure'
  /** crates, barrels, benches, wells, signposts, statues, fountains */
  | 'settlement_prop'
  /** torches, lanterns, lamp posts, candles */
  | 'light'
  /** gravestones, for graveyards */
  | 'memorial'
  /** reeds and the waterside vocabulary */
  | 'waterside'

/**
 * What to plant: a ROLE (preferred — the generator picks from the map) or an
 * explicit species list (an override, when the plan really does mean that one
 * thing). Giving both narrows the role to those species while keeping the
 * context scoring.
 */
export type SceneryChoice = {
  role?: RoleId
  species?: SpeciesPick[]
}

/** What a zone is FOR. Drives defaults, and is what a prefab stamper reads later. */
export type ZoneKind =
  | 'town' | 'village' | 'plaza' | 'farm' | 'forest' | 'grove' | 'wilds'
  | 'quarry' | 'mine' | 'graveyard' | 'camp' | 'ruins' | 'water' | 'swamp' | 'wasteland'

/**
 * A named area within the plan. Circles keep plans small and readable and
 * blend naturally; rects exist because towns and farms read better squared off.
 */
export type Zone = {
  id: string
  kind: ZoneKind
  /** Tile coords are AREA-relative: (0,0) is the SW corner of area.x0/y0. */
  shape:
    | { type: 'circle'; cx: number; cy: number; radius: number }
    | { type: 'rect'; x: number; y: number; w: number; h: number }
  /** Flatten the ground under it — towns want it, forests don't. 0..1 strength. */
  flatten?: number
  /** Override the ground palette inside this zone (a stony plaza, a scorched waste). */
  ground?: WeightedUnderlay[]
  /** Plot hints for the prefab system: how many building pads, and how big.
   *  `underlayId` paves the pad so a reserved plot is VISIBLE — until the
   *  prefab system exists, an unpaved plot is an invisible promise. */
  plots?: {
    count: number
    minSize?: number
    maxSize?: number
    purpose?: string
    underlayId?: number
    /**
     * What the notable buildings in this zone are, e.g.
     * `["church", "bank", "pub"]`.
     *
     * Assigned to the LARGEST plots first, because a church needs the room and
     * a village's civic buildings sit on its best ground. Plots past the end of
     * the list get no purpose and take whatever template fits — which is what
     * makes the rest of the settlement houses rather than a row of banks.
     *
     * Only the prefab path can honour these; synthesis has no notion of what a
     * building is for.
     */
    purposes?: string[]
  }
}

export type WeightedUnderlay = { underlayId: number; weight?: number }

/** Ground painting rule, applied in order; later bands win where they match. */
export type GroundBand = {
  underlay: WeightedUnderlay[]
  /** normalized height 0..1 over the area's own range */
  minHeight?: number
  maxHeight?: number
  /** tile slope in stored height units */
  minSlope?: number
  maxSlope?: number
  /** restrict to a zone */
  zoneId?: string
  /** an overlay laid on top (rock shelves, water) rather than an underlay */
  overlayId?: number
}

/**
 * Where things grow. This is the workhorse for trees/rocks/plants: a rule says
 * WHAT, WHERE, HOW DENSELY and WHAT TO AVOID, and the generator does Poisson-ish
 * placement with clustering so results don't look like a grid.
 */
export type ScatterRule = {
  id?: string
  /** what to plant — a role (preferred) and/or an explicit species list */
  role?: RoleId
  species?: SpeciesPick[]
  /** zone id, or omitted for the whole area */
  zoneId?: string
  /** placements per 100 tiles of eligible ground */
  density: number
  /** 0 = even, 1 = heavily clumped into copses */
  clustering?: number
  /** minimum tiles between two placements */
  spacing?: number
  /** don't place on these. `zone` means EVERY zone; for "everywhere except the
   *  quarry" use `avoidZoneIds` instead */
  avoid?: ('path' | 'plot' | 'water' | 'zone' | 'barrier')[]
  /** zones this rule must stay OUT of, by id. Without it a forest rule happily
   *  fills a mine pit with trees and mushrooms — the only controls were "this
   *  one zone only" or "no zones at all", neither of which is what a wood
   *  growing around a quarry needs. */
  avoidZoneIds?: string[]
  /** only place where the ground qualifies */
  maxSlope?: number
  minHeight?: number
  maxHeight?: number
  /** rotate randomly (most scenery), or keep a fixed rotation */
  randomRotation?: boolean
}

/**
 * An impassable ring following a zone's boundary — "a forest you can't walk
 * out of". Gaps are deliberate: a ring with no way through is a bug, not a
 * feature, so the default leaves openings and the path network aims at them.
 */
export type BarrierRing = {
  /** the zone whose edge it hugs */
  aroundZoneId: string
  role?: RoleId
  species?: SpeciesPick[]
  /** rings of scenery, in tiles */
  thickness?: number
  /** how many ways through */
  gaps?: number
  gapWidth?: number
  /** grow it outside the zone edge rather than on it */
  offset?: number
}

/** Lamps/torches spaced along the path network. */
export type PathLighting = {
  role?: RoleId
  species?: SpeciesPick[]
  /** tiles between lights */
  every: number
  /** offset from the path centre line, in tiles */
  offset?: number
  /** also write a point light record into the region environment */
  emitsLight?: boolean
  /** packed HSL for the emitted light (see the lights editor) */
  colorHsl?: number
  /** light reach, in the record's own size2d units */
  size2d?: number
}

export type PathSpec = {
  /** overlay painted along the route. Optional: a country track in the real
   *  map is an UNDERLAY with no overlay at all — the overlays that survived a
   *  long-and-thin search are paved roads, which is why an unpaved woodland
   *  track drawn with one looked like tarmac. */
  overlayId?: number
  /** underlay under the PAVED part of the route. Measured: 57% of the tiles
   *  under a real path overlay are town earth. */
  underlayId?: number
  /** underlay for the route where it runs OUTSIDE a zone, drawn with no
   *  overlay at all — which is what a country track is in the real map. */
  openUnderlayId?: number
  /** tiles across in open country */
  width?: number
  /** tiles across INSIDE a zone — a road is only wide where the traffic and
   *  the building plots are. Defaults to `width` + 2. */
  settlementWidth?: number
  /** connect every zone that wants connecting, and optionally the area edge */
  connectZones?: boolean
  toAreaEdge?: boolean
  /**
   * 0..1 — how much a route is allowed to meander. 0 routes straight at the
   * goal, which is what a road looks like only where somebody surveyed it.
   * Real tracks follow the ground, so this biases the route cost with a smooth
   * noise field: the path finds a channel through it and snakes.
   */
  wander?: number
  /**
   * Spurs off the trunk network. A single road crossing an area reads as a
   * seam; branches are what make it a place people move around in. Each spur
   * leaves an existing route and ends somewhere worth going.
   *
   * A floor, not a cap — `coverage` may add more.
   */
  branches?: number
  /**
   * 0..1 — how much of the area ends up WITHIN REACH of the network, as
   * opposed to how much the routes bend (`wander`) or how many there are
   * (`branches`).
   *
   * This is the difference between a road that clips one corner and one that
   * serves the whole place, and neither of the other two dials can express it:
   * a heavily-wandering route with three branches can still leave half the
   * area untouched if they all happen to head the same way. Spurs are aimed at
   * whatever is currently FURTHEST from any path, so coverage is measured
   * rather than hoped for.
   *
   * 0 leaves the through-route alone — which is what wilderness should be.
   */
  coverage?: number
  /**
   * 0..1 — how often a spur, having reached where it was going, carries on and
   * closes back onto the network somewhere else instead of stopping dead.
   *
   * A place where every lane is a dead end reads as a diagram of a settlement
   * rather than one: real villages loop, and you can leave by one lane and come
   * back along another. The return leg is routed away from the outbound one, or
   * it would simply retrace it — the cheapest path back along a road is that
   * same road.
   */
  loops?: number
  /**
   * Flat, path-adjacent pads at the end of a spur — the wayside equivalent of
   * a town's building plots, so an unsettled area still has somewhere a shop
   * or a shrine could be stamped later.
   */
  waysidePlots?: number
  /** underlay the wayside pads are paved with, so the intent is visible */
  waysidePlotUnderlayId?: number
  lighting?: PathLighting
}

/** A cluster of ore/rock nodes — "an area with resources, like a mine". */
export type ResourceNode = {
  zoneId: string
  role?: RoleId
  species?: SpeciesPick[]
  count: number
  /** dig the ground down so it reads as a pit rather than a field of rocks */
  depth?: number
  /** ring the pit with rubble */
  rubble?: boolean
}

/** One deliberately placed thing — a fountain in a plaza, a statue, a well. */
export type PropPlacement = {
  role?: RoleId
  species?: SpeciesId
  /** centre of a zone, or explicit area-relative tiles */
  zoneId?: string
  x?: number
  y?: number
  rotation?: number
  /** clear and flatten a pad around it */
  pad?: number
}

/**
 * Environment overrides written to `maps/environments/<id>.json` for every
 * region in the area. This is how "a gloomy area" actually becomes gloomy
 * rather than just having dead trees in it.
 */
export type EnvironmentSpec = {
  sunColour?: number
  sunAmbient?: number
  sunLight?: number
  sunBacklight?: number
  sunPosition?: [number, number, number]
  fogColour?: number
  fogDepth?: number
  skyboxId?: number
}

export type TerrainSpec = {
  /** stored height units at sea/base level */
  baseHeight?: number
  /** peak-to-trough, in stored height units */
  amplitude: number
  /** tiles per feature — bigger = broader hills */
  featureScale: number
  /** domain warp strength, 0..1; breaks up the noise's grid feel */
  warp?: number
  /** extra octaves of detail, 0..1 */
  roughness?: number
  /** ridged noise reads as mountain chains rather than rolling hills */
  ridged?: boolean
  /** normalized height below which water overlay is painted */
  waterLevel?: number
  /**
   * The SHAPE of the landmass, as opposed to its texture.
   *
   * Without this, `waterLevel` is just a percentile of fractal noise, and
   * fractal basins are scattered — so "coastal" produced up to 23 disconnected
   * ponds and a water share that swung from 3% to 25% between seeds of the
   * same theme. That is a marsh, not a shore, and an island cannot be
   * expressed at all because nothing pushes water to the OUTSIDE.
   *
   * `coast` biases the land along `coastAngle`; `island` biases it radially.
   * The noise still perturbs the result, so the shoreline wanders rather than
   * being a clean line or circle.
   */
  landform?: 'inland' | 'coast' | 'island' | 'lakes'
  /**
   * Degrees; the bearing the LAND lies toward for `coast`, so the sea is on the
   * opposite side. 0 = land to the east and open sea to the WEST.
   *
   * The name says coast and the old comment said "the direction the open sea
   * lies in", which is the exact opposite of what it does: the mask projects
   * along `(cos, sin)` and treats a large projection as inland. Measured on a
   * 2x2 with `coastAngle: 0` — every tile below x = 32 is sea and everything
   * east of it is land. The behaviour is left alone rather than flipped
   * because every shipped theme's shoreline is built on it; only the
   * description was wrong.
   */
  coastAngle?: number
}

/**
 * A jetty running out over water.
 *
 * The plan says how many and roughly what size; it never names deck object ids,
 * because the DECK VOCABULARY IS MINED (§15) and most of it is unnamed in the
 * cache. That is the §9a split holding: intent here, vocabulary in the
 * generator.
 *
 * Every dimension is optional, and omitting it is the better default — the
 * generator then samples the measured distribution (walkway width p50 2, with
 * 71% of real piers at 1-2 tiles; long side p50 11) instead of taking a guess
 * from a planner that has not read the map.
 */
export type DockSpec = {
  /** how many jetties to build along the shore */
  count: number
  /**
   * Build near this zone if it reaches the water. Omitted = anywhere on the
   * area's shoreline with enough open water in front of it.
   */
  nearZoneId?: string
  /** deck tiles across. Omit to sample the measured 1-2. Clamped to 1-4. */
  width?: number
  /** how far out over the water. Omit to sample the measured ~11. */
  length?: number
  /**
   * Chance a jetty gets a widened head at its seaward end (a T or an L).
   * Defaults to a modest rate; real piers are mostly plain runs.
   */
  headChance?: number
  /**
   * 0..1 — how heavily to trim the deck with barrels, railings and ladders.
   * Defaults to the measured rate, and the measurement is a warning: **43% of
   * real piers carry NOTHING at all.** A dock loaded with clutter is the
   * generated tell.
   */
  trim?: number
  /**
   * Named cargo standing ON the deck — crates and barrels on a working pier.
   *
   * This is the one place a plan may name what goes on a jetty, and it exists
   * because `trim` cannot express it. Trim is the MINED vocabulary: ids lifted
   * off real piers, most of them unnamed in the cache (§15), positional, and
   * placed on edge tiles against the outward normal. It reproduces what the map
   * puts on a pier, which is railings and ladders — there is no way to ask it
   * for a crate, and `scatter` cannot reach the deck either because deck tiles
   * are flagged `isDeck` precisely so the ground paint and the scatter rules
   * leave them alone.
   *
   * So the split is: `trim` is the map's answer to "what dresses a pier", and
   * this is the plan's answer to "what is this pier WORKING with". A tile that
   * took mined trim never also takes cargo — one thing per deck tile.
   *
   * `density` is placements per 100 DECK tiles, not per 100 ground tiles, and
   * the landscape sparsity guidance does not apply: a pier is 20-odd tiles, so
   * the default of 12 is about two or three pieces on a jetty. Treat 40+ as a
   * deck you cannot walk down.
   */
  deckClutter?: {
    role?: RoleId
    species?: SpeciesPick[]
    /** placements per 100 deck tiles. Default 12. */
    density?: number
  }
}

/**
 * Put buildings on the plots a zone reserves.
 *
 * There is deliberately no way to describe a LAYOUT here. The massing comes
 * from the measured footprint vocabulary (§14), the walls from a mined material
 * family, and the furniture from the measured wall-distance distributions (§6)
 * — Cody asked three times for buildings deduced from the corpus rather than
 * stamped from prefabs, so a plan says "build on the plots", not "build this".
 */
export type BuildingSpec = {
  /** only build on plots of this zone; omitted = every plot */
  zoneId?: string
  /** 0..1 share of available plots that get a building. Default 1. */
  fill?: number
  /** 0..1 how heavily to furnish interiors. Default follows the measurement. */
  furnish?: number
  /**
   * Where a building's SHAPE comes from.
   *
   * - `prefab` (default) replays a real building measured off the map —
   *   footprint, every wall loc, its doors — with this area's masonry
   *   substituted in. It cannot invent anything the game does not contain,
   *   which is the point.
   * - `synthesise` samples a footprint and lays walls by rule. It can produce
   *   anything, including shapes no RuneScape building has ever had.
   *
   * Both are kept because they fail in opposite directions. Synthesis was the
   * original design and spent two days producing rooms two people could stand
   * in, because its massing was never actually mined — see `templates.ts`.
   */
  mode?: 'prefab' | 'synthesise'
  /**
   * Repaint a stamped building's walls in the area's own masonry family.
   *
   * OFF by default, and it should usually stay off. It defeats the point of
   * choosing the template in the first place: selection scores a template by
   * its wall ids to find one that belongs on this ground, and this then
   * discards those ids. It also repaints every wall-SHAPED loc rather than the
   * shell alone, so interior fittings — a fireplace surround, a banister — come
   * out clad in exterior wall panels.
   *
   * Kept because it is the only way to force a consistent look across a
   * settlement built from templates of mixed origin.
   */
  restyle?: boolean
  /**
   * Ask for a particular kind of building — 'house', 'church', 'bank',
   * 'castle', 'forge', 'pub', 'workshop', 'hall', 'tower', 'shed', 'store',
   * 'kitchen'. Omitted lets the generator take whatever fits the plot.
   *
   * Only meaningful with `mode: 'prefab'`: synthesis has no notion of purpose.
   */
  purpose?: string
}

export type ProcPlan = {
  version: 1
  /** free text, for the UI and for a follow-up turn to refer back to */
  description?: string
  seed: number
  area: PlanArea
  terrain: TerrainSpec
  ground: GroundBand[]
  zones?: Zone[]
  paths?: PathSpec
  scatter?: ScatterRule[]
  barriers?: BarrierRing[]
  resources?: ResourceNode[]
  props?: PropPlacement[]
  /** jetties over the water. Needs a shoreline — see `TerrainSpec.landform`. */
  docks?: DockSpec[]
  /** buildings on the plots a zone reserves */
  buildings?: BuildingSpec[]
  environment?: EnvironmentSpec
  /**
   * Regions whose existing content must be preserved and blended toward,
   * rather than overwritten (the single-region regenerate flow).
   */
  preserveRegions?: number[]
}

/** Everything a generation produced, ready for the normal draft/save path. */
export type GenerationResult = {
  /**
   * The underwater ("um") layer, per region — the riverbed under the water
   * overlay. Not decoration: the water shader's alpha is derived ENTIRELY from
   * depth (`shore` and `depthFade` both come from it), so water with no
   * underwater layer renders at alpha 0 and you see through the sea to the
   * skybox. The real map pairs them everywhere — Port Sarim has 2,333 water
   * tiles and 2,279 underwater heights.
   */
  underwater: Map<number, import('../loaders/maps').MapTerrain>
  /** region id → its new terrain */
  terrain: Map<number, import('../loaders/maps').MapTerrain>
  /** region id → its new placements */
  objects: Map<number, import('../loaders/maps').LocEntry[]>
  /** region id → environment record patch (only when the plan sets one) */
  environment: Map<number, EnvironmentSpec & { lights?: unknown[] }>
  /** what got made, for the UI to report and for prefabs to consume later */
  report: {
    regions: number
    placements: number
    /** plane-1 canopy locs emitted alongside two-part trees */
    canopies?: number
    zones: { id: string; kind: ZoneKind; tiles: number }[]
    plots: { zoneId: string; x: number; y: number; w: number; h: number; purpose?: string }[]
    /** jetties built, anchored at (x,y) on the shore and running out along `dir` */
    docks: { x: number; y: number; dir: number; tiles: number; length: number; width: number }[]
    /** buildings synthesised, with their footprint and interior size */
    buildings: {
      x: number; y: number; w: number; h: number
      walls: number; interior: number; furniture: number
      /** prefab only: what kind it is and which region it was lifted from, so
       *  an out-of-place building can be traced to a real one on the map */
      purpose?: string
      from?: number
    }[]
    unresolved: SpeciesId[]
    warnings: string[]
  }
}
