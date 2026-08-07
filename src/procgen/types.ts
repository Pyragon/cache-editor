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
  // undergrowth
  | 'bush' | 'fern' | 'plant' | 'flowers' | 'reeds' | 'grass_tuft' | 'mushroom'
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
  plots?: { count: number; minSize?: number; maxSize?: number; purpose?: string; underlayId?: number }
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
  species: SpeciesPick[]
  /** zone id, or omitted for the whole area */
  zoneId?: string
  /** placements per 100 tiles of eligible ground */
  density: number
  /** 0 = even, 1 = heavily clumped into copses */
  clustering?: number
  /** minimum tiles between two placements */
  spacing?: number
  /** don't place on these */
  avoid?: ('path' | 'plot' | 'water' | 'zone' | 'barrier')[]
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
  species: SpeciesPick[]
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
  species: SpeciesPick[]
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
  /** overlay painted along the route */
  overlayId: number
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
  species: SpeciesPick[]
  count: number
  /** dig the ground down so it reads as a pit rather than a field of rocks */
  depth?: number
  /** ring the pit with rubble */
  rubble?: boolean
}

/** One deliberately placed thing — a fountain in a plaza, a statue, a well. */
export type PropPlacement = {
  species: SpeciesId
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
  environment?: EnvironmentSpec
  /**
   * Regions whose existing content must be preserved and blended toward,
   * rather than overwritten (the single-region regenerate flow).
   */
  preserveRegions?: number[]
}

/** Everything a generation produced, ready for the normal draft/save path. */
export type GenerationResult = {
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
    zones: { id: string; kind: ZoneKind; tiles: number }[]
    plots: { zoneId: string; x: number; y: number; w: number; h: number; purpose?: string }[]
    unresolved: SpeciesId[]
    warnings: string[]
  }
}
