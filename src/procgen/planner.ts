/**
 * The built-in planner: presets + dials → a `ProcPlan`.
 *
 * This exists so the generator is fully usable with NO API key. It emits the
 * exact same plan type the Claude layer does, which is the point of the plan
 * being the contract: the AI is a better planner, not a different pipeline.
 *
 * Its themes also double as worked examples for the Claude layer's prompt —
 * showing the model what a good plan looks like beats describing it.
 *
 * ## Everything here is measured
 *
 * The materials, densities, species weights and slope thresholds below come
 * from surveying the real map — 15 settlements and their surrounding
 * countryside, ~550k tiles, read straight out of the cache's own dumps. The
 * working, and the numbers, are in `docs/procgen-reference.md`. Where a value
 * looks oddly specific, that is why.
 *
 * Two findings shape almost every line of this file:
 *
 * 1. **Real ground is a blend.** No single underlay exceeds ~20% of any zone
 *    anywhere in the game. Painting one id per band is what made generated
 *    fields read as flat colour, so every band here mixes 4-6 relatives.
 * 2. **Real scenery is an order of magnitude sparser than it feels.** The
 *    densest place surveyed is Barbarian Village at 2.37 trees per 100 tiles.
 *    These themes used to ask for 12-36.
 */

import { makeRng } from './rng'
import { DEFAULT_PALETTE as PALETTE, type GroundPalette } from './palette'
import type {
  EnvironmentSpec, GroundBand, ProcPlan, ScatterRule, SceneryChoice, SpeciesPick, Zone,
} from './types'

// Ground-material roles and their per-cache binding live in `palette.ts` —
// they are cache data, not planner data, and the user rebinds them there.
export { DEFAULT_PALETTE } from './palette'
export type { GroundPalette } from './palette'

export type ThemeId =
  // invented themes, kept because they cover moods the real map has no single
  // example of
  | 'rolling_grass' | 'dense_forest' | 'gloomy_woods' | 'stony_highland'
  | 'mining_valley' | 'coastal' | 'village_in_forest' | 'wasteland'
  // derived from measured places
  | 'lumbridge_meadow' | 'varrock_town' | 'falador_stone' | 'draynor_lowland'
  | 'seers_farmland' | 'barbarian_wilds' | 'catherby_coast' | 'kharid_desert'
  | 'karamja_tropics' | 'fishing_village'

export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: 'rolling_grass', label: 'Rolling grass', blurb: 'Gentle hills, scattered oaks, a path or two.' },
  { id: 'dense_forest', label: 'Dense forest', blurb: 'Heavy tree cover with clearings and undergrowth.' },
  { id: 'gloomy_woods', label: 'Gloomy woods', blurb: 'Dead trees, stumps, fog and a dimmed sun.' },
  { id: 'stony_highland', label: 'Stony highland', blurb: 'Rocky ground, boulders, stone paths.' },
  { id: 'mining_valley', label: 'Mining valley', blurb: 'A pit of ore rocks, rubble and cart tracks.' },
  { id: 'coastal', label: 'Coastal', blurb: 'Water on one side, sand, reeds and palms.' },
  { id: 'village_in_forest', label: 'Village in forest', blurb: 'A town ringed by trees you cannot walk through.' },
  { id: 'wasteland', label: 'Wasteland', blurb: 'Burnt stumps, rubble, almost nothing alive.' },
  // --- measured from real places
  { id: 'lumbridge_meadow', label: 'Lumbridge meadow', blurb: 'Open low country, very sparse trees, packed-earth village core.' },
  { id: 'varrock_town', label: 'Varrock town', blurb: 'A large town on balanced green country; the biggest built footprint measured.' },
  { id: 'falador_stone', label: 'Falador stone', blurb: 'Pale paving and dense buildings on gentle relief.' },
  { id: 'draynor_lowland', label: 'Draynor lowland', blurb: 'Low, flat and damp. Willows near the water, almost no hills.' },
  { id: 'seers_farmland', label: 'Seers farmland', blurb: 'Wooded, flowered farmland - and the one place maples grow.' },
  { id: 'barbarian_wilds', label: 'Barbarian wilds', blurb: 'Rough dark earth and dead trees - two thirds of its trees are dead.' },
  { id: 'catherby_coast', label: 'Catherby coast', blurb: 'Flowered shore under high ground, with snow above the treeline.' },
  { id: 'kharid_desert', label: 'Al Kharid desert', blurb: 'Sand and rock, almost nothing growing, boulders everywhere.' },
  { id: 'karamja_tropics', label: 'Karamja tropics', blurb: 'Yellow-green jungle floor, sand shore, heavy undergrowth.' },
  { id: 'fishing_village', label: 'Fishing village', blurb: 'A small settlement on a shore, with jetties running out over the water.' },
]

export type PlannerDials = {
  theme: ThemeId
  seed: number
  /** 0..1 — how mountainous */
  relief: number
  /** 0..1 — how much stuff grows */
  density: number
  /** 0..1 — how built-up (zones with plots, paths, props) */
  settlement: number
  /** 0..1 — how much of the area ends up within reach of the path network */
  pathReach: number
  /** 0..1 — open-country path width; a settlement always widens on top of it */
  pathWidth: number
  /** 0..1 — how often a spur closes back onto the network instead of dead-ending */
  pathLoops: number
  /** 0..1 — how much path routes meander instead of running at their goal */
  wander: number
  /** the shape of the landmass; 'auto' lets the theme decide */
  landform: 'auto' | 'inland' | 'coast' | 'island' | 'lakes'
  palette: GroundPalette
}

export const DEFAULT_DIALS: Omit<PlannerDials, 'seed'> = {
  theme: 'rolling_grass',
  relief: 0.4,
  density: 0.5,
  settlement: 0.3,
  pathReach: 0.5,
  pathWidth: 0.25,
  pathLoops: 0.6,
  wander: 0.55,
  landform: 'auto',
  palette: PALETTE,
}

const pick = (...s: SpeciesPick[]): SpeciesPick[] => s

/**
 * Scale a theme's own measured density by the scenery dial. At the dial's
 * midpoint you get the number actually measured for that kind of place; the
 * ends are roughly half and one-and-a-half times it.
 */
const dens = (base: number, d: number) => +(base * (0.45 + d * 1.1)).toFixed(3)

/**
 * What a rule is FOR, rather than what it plants.
 *
 * These replaced the hand-written species mixes that used to live here (a
 * measured 51.6% plain tree / 20.9% dead / 11.4% oak woodland, a pooled
 * undergrowth mix, and a separate jungle floor). The mixes were real — they
 * came out of the 15-settlement survey — but they were a survey AVERAGE being
 * applied per tile, and a theme has not read the map. Writing
 * `species: ['tree_tropical']` is the author guessing the biome; writing
 * `role: 'canopy'` hands that question to the generator, which scores every
 * candidate by how often the real game plants it on ground like the tile being
 * planted. Underlay alone explains 34.5% of object identity, so getting the
 * GROUND bands right is what makes the vegetation follow. See
 * `docs/map-learning.md` §9a and `RoleId` in `types.ts`.
 *
 * Note what this deletes: `JUNGLE_UNDERGROWTH` existed only because pooling
 * jungle and temperate species and weighting them by GLOBAL frequency put
 * jungle grass on 77% of the grass in the game (§11). Context scoring is the
 * real fix for that, and with it the separate mix is redundant.
 *
 * What stays a theme's job is the BALANCE BETWEEN roles: "2.4 canopy and 1.6
 * deadwood per 100 tiles" is a statement about a place, and no amount of
 * reading the map supplies it. Which dead tree lands on which tile is not.
 */
const CANOPY: SceneryChoice = { role: 'canopy' }
const DEADWOOD: SceneryChoice = { role: 'deadwood' }
const UNDERGROWTH: SceneryChoice = { role: 'undergrowth' }
const LOOSE_STONE: SceneryChoice = { role: 'loose_stone' }

/**
 * Karamja's own ground, named outright.
 *
 * The palette's green roles were rebound to TEMPERATE materials once we
 * measured what the map actually grows on each one (`palette.ts`, and
 * `docs/map-learning.md` §12c) — so the palette no longer has a word for
 * jungle, and a theme that IS a biome has to supply its own.
 *
 * These are the exact ids the palette was wrongly bound to, which is not a
 * coincidence: they are Karamja's materials, and binding them to roles called
 * "grass" and "grassLush" is what put jungle across the whole game. Here they
 * are correct, and the colours match the theme's blurb — 47 is the bright
 * green, 48 the olive, 49 the yellow-olive of a jungle floor.
 *
 * Measured jungle share (canopy / undergrowth): 48 -> 30%/68%, 49 -> 13%/68%,
 * 50 -> 46%/64%, 62 -> 46%/52%.
 *
 * Hardcoded ids are a compromise. The proper fix is either jungle ROLES in the
 * palette or, better, an archetype supplying ground and species together from
 * real Karamja regions — see `docs/map-learning.md` §9a.
 */
const JUNGLE = { lush: 47, olive: 48, yellow: 49, sand: 61 }

/**
 * Open green country. Weights follow the measured open-zone mix (162 13.6%,
 * 48 11.1%, 160 10.7%, 163 5.9%, 62 5.5%), and later bands win, so this reads
 * general case first and exceptions after.
 *
 * The slope thresholds are the measured percentiles: p90 is 8 and p95 is 12,
 * so `minSlope: 6` is roughly the steepest sixth of the ground and
 * `minSlope: 11` the steepest twentieth — which is where the survey finds 62
 * taking over and the 81/82 rock overlays appearing.
 */
function meadowBands(p: GroundPalette): GroundBand[] {
  return [
    { underlay: [
      { underlayId: p.grassDark, weight: 5 },
      { underlayId: p.grass, weight: 4 },
      { underlayId: p.grassMid, weight: 4 },
      { underlayId: p.grassLush, weight: 2 },
      { underlayId: p.dirt, weight: 2 },
      { underlayId: p.mud, weight: 1 },
    ] },
    // hollows hold water and go dark
    { underlay: [
      { underlayId: p.mud, weight: 3 },
      { underlayId: p.grassDark, weight: 3 },
      { underlayId: p.dirt, weight: 2 },
    ], maxHeight: 0.18 },
    // ridges dry out and wear through
    { underlay: [
      { underlayId: p.grass, weight: 4 },
      { underlayId: p.grassMid, weight: 3 },
      { underlayId: p.grassDead, weight: 2 },
      { underlayId: p.dirt, weight: 2 },
    ], minHeight: 0.74 },
    { underlay: [
      { underlayId: p.grassDark, weight: 3 },
      { underlayId: p.grassMid, weight: 2 },
      { underlayId: p.mud, weight: 2 },
      { underlayId: p.dirt, weight: 2 },
    ], minSlope: 6 },
    { underlay: [
      { underlayId: p.mud, weight: 4 },
      { underlayId: p.dirt, weight: 2 },
      { underlayId: p.stone, weight: 1 },
    ], minSlope: 11, overlayId: p.rock },
  ]
}

/**
 * A settlement floor. Measured built-zone mix: 163 18.5%, 162 15.4%, 62 12.2%,
 * 48 10.7%, 160 9.9%, 63 8.2%, 49 6.8% — town earth leads but never dominates,
 * and the greens are still very much present between the buildings.
 */
function townGround(p: GroundPalette) {
  return [
    { underlayId: p.townEarth, weight: 5 },
    { underlayId: p.grassDark, weight: 4 },
    { underlayId: p.mud, weight: 3 },
    { underlayId: p.grass, weight: 3 },
    { underlayId: p.grassMid, weight: 3 },
    { underlayId: p.dirt, weight: 2 },
    { underlayId: p.grassDead, weight: 2 },
  ]
}

export function buildPlan(dials: PlannerDials, area: ProcPlan['area']): ProcPlan {
  const rnd = makeRng(dials.seed)
  const p = dials.palette
  const regionsW = area.x1 - area.x0 + 1
  const regionsH = area.y1 - area.y0 + 1
  const w = regionsW * 64
  const h = regionsH * 64
  const cx = Math.round(w / 2)
  const cy = Math.round(h / 2)
  /** scale features with the area so a 1×1 doesn't look like a flat plain */
  const featureScale = Math.max(18, Math.round(Math.min(w, h) / 3))
  const d = dials.density

  const zones: Zone[] = []
  const scatter: ScatterRule[] = []
  const barriers: ProcPlan['barriers'] = []
  const resources: ProcPlan['resources'] = []
  const props: ProcPlan['props'] = []
  const docks: ProcPlan['docks'] = []
  const buildings: ProcPlan['buildings'] = []
  let environment: EnvironmentSpec | undefined
  let ground = meadowBands(p)
  let ridged = false
  let amplitude = 20 + dials.relief * 120
  let waterLevel: number | undefined
  /** the theme's own idea of its landmass; the dial overrides it */
  let landform: 'inland' | 'coast' | 'island' | 'lakes' = 'inland'

  /**
   * Measured settlement footprint: `built` tiles are 4.1% of Lumbridge's
   * nine-region survey, 9.3% of Falador's, 10.7% of Varrock's. So a town is
   * about half a region to a region across, not the 18% of the whole area the
   * planner used to reserve.
   */
  const townRadius = Math.round(Math.min(w, h) * 0.13)
  const addTown = (kind: Zone['kind'] = 'village', radiusMul = 1) => {
    zones.push({
      id: 'town',
      kind,
      shape: { type: 'circle', cx, cy, radius: Math.round(townRadius * radiusMul) },
      flatten: 0.85,
      ground: townGround(p),
      // paved so a reserved plot is visible now, rather than an invisible
      // promise to a prefab system that doesn't exist yet
      plots: {
        count: Math.max(2, Math.round(4 + dials.settlement * 8)),
        minSize: 5, maxSize: 9, purpose: 'building', underlayId: p.gravel,
      },
    })
    // A reserved plot used to be an invisible promise to a prefab system that
    // did not exist. It is now a building: massing from the measured footprint
    // vocabulary, walls from a mined family, furniture by wall distance.
    buildings.push({ zoneId: 'town' })
  }

  /** trees + undergrowth at a measured per-100-tiles figure */
  const woodland = (
    treePer100: number,
    opts: {
      /** what the tree layer is; defaults to whatever belongs on this ground */
      canopy?: SceneryChoice
      /** multiplier on the measured ~1.0 undergrowth per 100 tiles */
      growth?: number
      floor?: SceneryChoice
      /**
       * Keep the undergrowth below a treeline. Two reasons, and they agree:
       * nothing much grows above the snow in the real map, and the context
       * model has ZERO undergrowth observations on snow (`docs/map-learning.md`
       * §12a) — so with no evidence it falls back to the global prior, which is
       * jungle-heavy, and a snowfield sprouts jungle grass. Themes that paint a
       * snow band set this to just under where that band starts.
       */
      floorMaxHeight?: number
    } = {},
  ) => {
    scatter.push(
      { ...(opts.canopy ?? CANOPY), density: dens(treePer100, d), clustering: 0.5, spacing: 2,
        avoid: ['path', 'plot'], maxSlope: 20 },
      { ...(opts.floor ?? UNDERGROWTH), density: dens(1.0 * (opts.growth ?? 1), d),
        clustering: 0.6, spacing: 1, avoid: ['path', 'plot'],
        ...(opts.floorMaxHeight !== undefined ? { maxHeight: opts.floorMaxHeight } : {}) },
    )
  }

  switch (dials.theme) {
    // ---------------------------------------------------------------- invented
    case 'dense_forest':
      // the densest place measured is 2.37 trees/100; a deliberate forest sits
      // just above it rather than at the old 14-36
      woodland(2.6, { growth: 1.6 })
      scatter.push({ ...DEADWOOD, density: dens(0.15, d), clustering: 0.4, spacing: 3,
        avoid: ['path', 'plot'] })
      break

    case 'gloomy_woods':
      amplitude = 20 + dials.relief * 80
      ground = [
        { underlay: [
          { underlayId: p.grassDead, weight: 4 },
          { underlayId: p.mud, weight: 3 },
          { underlayId: p.dirt, weight: 3 },
          { underlayId: p.grassDark, weight: 2 },
        ] },
        { underlay: [
          { underlayId: p.mud, weight: 5 },
          { underlayId: p.grassDead, weight: 2 },
          { underlayId: p.dirt, weight: 2 },
        ], maxHeight: 0.3 },
        { underlay: [
          { underlayId: p.mud, weight: 4 },
          { underlayId: p.dirt, weight: 2 },
          { underlayId: p.stone, weight: 1 },
        ], minSlope: 8, overlayId: p.rock },
      ]
      // the tree layer here IS dead wood — that is the theme, not a species list
      woodland(1.6, { canopy: DEADWOOD, growth: 0.7 })
      // halved from 0.2: the old rule was gravestones AND mushrooms, and the
      // mushrooms now come from the undergrowth role above
      scatter.push({ role: 'memorial', density: dens(0.1, d), clustering: 0.7, spacing: 2,
        avoid: ['path', 'plot'] })
      // the bit dials alone can't do: the PLACE gets darker, not just the props
      environment = {
        sunColour: 0x6a6f7a, sunAmbient: 0.75, sunLight: 0.5, sunBacklight: 0.25,
        fogColour: 0x40454e, fogDepth: 220,
      }
      break

    case 'stony_highland':
      ridged = true
      amplitude = 60 + dials.relief * 140
      ground = [
        { underlay: [
          { underlayId: p.stone, weight: 4 },
          { underlayId: p.mud, weight: 3 },
          { underlayId: p.dirt, weight: 2 },
          { underlayId: p.grassDark, weight: 2 },
        ] },
        { underlay: [
          { underlayId: p.grassDark, weight: 3 },
          { underlayId: p.grass, weight: 3 },
          { underlayId: p.stone, weight: 1 },
        ], maxSlope: 5, maxHeight: 0.5 },
        { underlay: [
          { underlayId: p.stone, weight: 4 },
          { underlayId: p.mud, weight: 2 },
        ], minSlope: 11, overlayId: p.rock },
        { underlay: [{ underlayId: p.snow, weight: 3 }, { underlayId: p.stone, weight: 2 }], minHeight: 0.88 },
      ]
      // stony, snow-capped ground picks its own conifers; the floor stops just
      // under the snow band this theme paints at 0.88
      woodland(0.5, { growth: 0.4, floorMaxHeight: 0.85 })
      scatter.push({ ...LOOSE_STONE, density: dens(0.5, d), clustering: 0.5, spacing: 2,
        avoid: ['path', 'plot'] })
      if (dials.settlement > 0.2) {
        addTown('town')
        props.push({ species: 'fountain', zoneId: 'town', pad: 3 })
        props.push({ species: 'statue', zoneId: 'town', x: cx + 8, y: cy + 6, pad: 2 })
      }
      break

    case 'mining_valley': {
      amplitude = 40 + dials.relief * 120
      ground = [
        { underlay: [
          { underlayId: p.dirt, weight: 4 },
          { underlayId: p.mud, weight: 3 },
          { underlayId: p.gravel, weight: 2 },
          { underlayId: p.stone, weight: 2 },
        ] },
        { underlay: [{ underlayId: p.stone, weight: 3 }, { underlayId: p.mud, weight: 2 }],
          minSlope: 9, overlayId: p.rock },
      ]
      const pitR = Math.round(Math.min(w, h) * 0.14)
      zones.push({
        id: 'pit', kind: 'mine',
        shape: { type: 'circle', cx, cy, radius: pitR },
        flatten: 0.6,
        ground: [
          { underlayId: p.gravel, weight: 4 },
          { underlayId: p.stone, weight: 3 },
          { underlayId: p.dirt, weight: 2 },
        ],
      })
      resources.push({
        zoneId: 'pit',
        // which seams this ground carries is the map's answer, not ours: the
        // executor samples the role down to 2-5 types, straddling the measured
        // median of 4 per site
        role: 'ore',
        // A real mining site carries 13-19 rocks (p25/p75, 20 sites measured),
        // median 4 of each type. The executor knots them into per-type pockets,
        // so this is the size of an ore BODY, not a fill for the whole pit.
        count: Math.round(13 + d * 14),
        depth: 26,
        rubble: true,
      })
      scatter.push(
        { ...LOOSE_STONE, density: dens(0.6, d), clustering: 0.6, spacing: 1, avoid: ['path'] },
        // `settlement_prop` is only allowed to scatter because the rule names a
        // zone — crates in a working pit read fine, crates in a meadow do not
        { role: 'settlement_prop', density: dens(0.15, d), clustering: 0.8, spacing: 2,
          avoid: ['path'], zoneId: 'pit' },
      )
      break
    }

    case 'coastal':
      landform = 'coast'
      amplitude = 20 + dials.relief * 70
      ground = [
        { underlay: [
          { underlayId: p.grassDark, weight: 4 },
          { underlayId: p.grass, weight: 4 },
          { underlayId: p.grassLush, weight: 1 },
        ] },
        // absolute depths now a landform is in play: sea sits at 0 and the
        // beach is the thin band just above it
        { underlay: [
          { underlayId: p.sand, weight: 5 },
          { underlayId: p.grassDead, weight: 1 },
        ], maxHeight: 0.16 },
        { underlay: [{ underlayId: p.sand, weight: 3 }, { underlayId: p.mud, weight: 1 }],
          maxHeight: 0.07, overlayId: p.water },
      ]
      woodland(0.9, { growth: 1.1 })
      // the damp margin just above the waterline
      scatter.push({ role: 'waterside', density: dens(0.8, d), clustering: 0.7, spacing: 1,
        minHeight: 0.07, maxHeight: 0.2 })
      docks.push({ count: 1 })
      break

    /**
     * The theme this whole line of work exists for. A coast, a small
     * settlement ON it, and jetties — "no docks on an island fishing village"
     * is the oldest fault in `docs/map-learning.md` §1.
     *
     * Deliberately small and low: real fishing settlements are a handful of
     * plots, not a town, and the sea has to be close enough that the dock lane
     * is a short walk rather than a road across the map.
     */
    case 'fishing_village':
      landform = 'coast'
      amplitude = 14 + dials.relief * 40
      ground = [
        { underlay: [
          { underlayId: p.grassDark, weight: 4 },
          { underlayId: p.grass, weight: 3 },
        ] },
        // The beach is a BAND, not a fringe: 77% sand at one tile from the
        // water, tapering to 34% at six. And the narrower the band the fewer
        // materials — a contrasting tile every sixth one is what put holes in
        // the shoreline last time.
        { underlay: [
          { underlayId: p.sand, weight: 8 },
          { underlayId: p.grassDead, weight: 1 },
        ], maxHeight: 0.18 },
        { underlay: [{ underlayId: p.sand }], maxHeight: 0.10 },
        { underlay: [{ underlayId: p.sand, weight: 3 }, { underlayId: p.mud, weight: 1 }],
          maxHeight: 0.06, overlayId: p.water },
      ]
      addTown('village', 0.75)
      woodland(0.5, { growth: 0.9 })
      scatter.push({ role: 'waterside', density: dens(1.1, d), clustering: 0.7, spacing: 1,
        minHeight: 0.06, maxHeight: 0.2 })
      // two or three jetties reads as a working waterfront; one reads as an
      // accident. Sizes are left unset ON PURPOSE so the generator samples the
      // measured distribution instead of taking a guess from here (§15).
      docks.push({ count: 2 + Math.round(dials.settlement * 2) })
      props.push({ role: 'settlement_prop', zoneId: 'town', pad: 1 })
      break

    case 'village_in_forest': {
      addTown()
      woodland(2.2, { growth: 1.2 })
      // the original ask: "surrounded by a forest ... so we are actually trapped"
      barriers.push({
        aroundZoneId: 'town', role: 'canopy',
        thickness: 3, offset: 4, gaps: 2, gapWidth: 7,
      })
      props.push({ species: 'well', zoneId: 'town', pad: 2 })
      break
    }

    case 'wasteland':
      amplitude = 30 + dials.relief * 90
      ground = [
        { underlay: [
          { underlayId: p.dirt, weight: 4 },
          { underlayId: p.grassDead, weight: 3 },
          { underlayId: p.mud, weight: 2 },
          { underlayId: p.gravel, weight: 1 },
        ] },
        { underlay: [{ underlayId: p.mud, weight: 3 }, { underlayId: p.dirt, weight: 1 }], maxHeight: 0.25 },
        { underlay: [{ underlayId: p.stone, weight: 3 }, { underlayId: p.mud, weight: 2 }],
          minSlope: 9, overlayId: p.rock },
      ]
      scatter.push(
        { ...DEADWOOD, density: dens(0.6, d), clustering: 0.6, spacing: 3, avoid: ['path'] },
        { ...LOOSE_STONE, density: dens(0.5, d), clustering: 0.5, spacing: 1, avoid: ['path'] },
      )
      environment = { sunColour: 0x8a7a63, sunAmbient: 0.95, fogColour: 0x6b6153, fogDepth: 320 }
      break

    // ------------------------------------------------------- measured places
    case 'lumbridge_meadow':
      // 0.64 trees/100 — the sparsest green place surveyed. 26% flat, height
      // range 49, and a town core that is 36% packed earth.
      amplitude = 20 + dials.relief * 60
      woodland(0.64, { growth: 0.4 })
      scatter.push({ ...LOOSE_STONE, density: dens(0.36, d), clustering: 0.4, spacing: 3,
        avoid: ['path', 'plot'] })
      if (dials.settlement > 0.15) addTown('village')
      break

    case 'varrock_town':
      // the biggest built footprint measured (10.7% of its nine regions), on
      // ordinary balanced green country, 1.30 trees/100
      amplitude = 20 + dials.relief * 60
      addTown('town', 1.5)
      woodland(1.30, { growth: 0.7 })
      props.push({ species: 'fountain', zoneId: 'town', pad: 3 })
      props.push({ species: 'signpost', zoneId: 'town', pad: 1 })
      break

    case 'falador_stone':
      // 0.56 buildings and 0.39 fences per 100 tiles — the most built-up of the
      // surveyed towns after Taverley, on gentle ground with pale paving
      amplitude = 25 + dials.relief * 75
      addTown('town', 1.3)
      woodland(0.91, { growth: 0.8 })
      // The survey measures 0.39 fences per 100 tiles here, but a fence in the
      // real map is a LINE around a field — scattering that rate as individual
      // posts just litters the countryside with orphaned railings. Enclosures
      // want the barrier mechanism (or a future field feature), not scatter.
      props.push({ species: 'statue', zoneId: 'town', pad: 2 })
      break

    case 'draynor_lowland':
      // lowest relief measured (p99 slope 16, range 51) and willow country
      amplitude = 12 + dials.relief * 45
      ground = [
        ...meadowBands(p).slice(0, 3),
        { underlay: [
          { underlayId: p.mud, weight: 4 },
          { underlayId: p.grassDark, weight: 3 },
          { underlayId: p.dirt, weight: 1 },
        ], maxHeight: 0.3 },
      ]
      // willows are not named here any more: this theme's whole identity is its
      // wet, low ground, and willow is what the map plants on wet, low ground.
      // If they stop appearing, the GROUND bands are what to look at.
      woodland(1.20, { growth: 0.8 })
      if (dials.settlement > 0.15) addTown('village', 0.8)
      break

    case 'seers_farmland':
      // 1.99 trees/100 and 0.53 fences/100 — wooded farmland. The only place
      // maple grows in any number (9.6% of its trees).
      amplitude = 25 + dials.relief * 85
      // One of the two places a species list is kept deliberately. Maple is 9.6%
      // of Seers' trees and ~1% of the map's, so it is exactly the kind of local
      // fact a global context model cannot recover — and this theme is NAMED
      // after it. `role` narrows rather than replaces, so context still ranks
      // the variants within these species.
      woodland(1.99, { canopy: { role: 'canopy', species: pick(
        { species: 'tree', weight: 8 }, { species: 'tree_oak', weight: 3 },
        { species: 'tree_maple', weight: 2 }, { species: 'tree_willow', weight: 1 }) } })
      // its 0.53 fences/100 are hedged FIELD BOUNDARIES, not loose posts — see
      // the note in `falador_stone`
      scatter.push(
        // likewise flowers: "flowered farmland" is the theme, at a measured rate
        { role: 'undergrowth', species: pick({ species: 'flowers' }),
          density: dens(0.59, d), clustering: 0.6, spacing: 1, avoid: ['path', 'plot'] },
      )
      if (dials.settlement > 0.2) addTown('village')
      break

    case 'barbarian_wilds':
      // 1.59 DEAD trees per 100 — two thirds of everything growing there — on
      // the roughest ground surveyed (62 is 26% of its built underlay)
      amplitude = 35 + dials.relief * 110
      ground = [
        { underlay: [
          { underlayId: p.mud, weight: 4 },
          { underlayId: p.grassDark, weight: 4 },
          { underlayId: p.grass, weight: 3 },
          { underlayId: p.grassMid, weight: 3 },
          { underlayId: p.dirt, weight: 2 },
        ] },
        { underlay: [{ underlayId: p.mud, weight: 4 }, { underlayId: p.dirt, weight: 2 }], maxHeight: 0.25 },
        { underlay: [
          { underlayId: p.mud, weight: 5 },
          { underlayId: p.dirt, weight: 2 },
          { underlayId: p.stone, weight: 1 },
        ], minSlope: 9, overlayId: p.rock },
      ]
      // Two thirds dead is the theme, and a ratio BETWEEN roles is exactly what
      // stays the plan's job — so it becomes two rules at measured densities
      // rather than one rule with dead trees weighted inside it.
      woodland(0.78, { growth: 0.5 })
      scatter.push({ ...DEADWOOD, density: dens(1.59, d), clustering: 0.5, spacing: 2,
        avoid: ['path', 'plot'], maxSlope: 20 })
      if (dials.settlement > 0.25) addTown('camp', 0.7)
      break

    case 'catherby_coast':
      // 0.86 flowers/100 and 0.44 fences/100 on the shore, with snow on the
      // high ground behind it (25 is 7% of its open underlay)
      landform = 'coast'
      amplitude = 45 + dials.relief * 120
      ground = [
        ...meadowBands(p).slice(0, 4),
        { underlay: [{ underlayId: p.sand, weight: 4 }, { underlayId: p.grassDead, weight: 1 }], maxHeight: 0.16 },
        { underlay: [{ underlayId: p.sand, weight: 3 }, { underlayId: p.mud }], maxHeight: 0.07, overlayId: p.water },
        { underlay: [{ underlayId: p.snow, weight: 4 }, { underlayId: p.stone, weight: 1 }], minHeight: 0.7 },
      ]
      // floor stops below the snow band this theme paints at 0.7
      woodland(1.23, { growth: 0.6, floorMaxHeight: 0.68 })
      scatter.push(
        // "flowered shore" is the theme, at its measured 0.86/100
        { role: 'undergrowth', species: pick({ species: 'flowers' }),
          density: dens(0.86, d), clustering: 0.6, spacing: 1, avoid: ['path', 'plot'], minHeight: 0.17 },
        { role: 'waterside',
          density: dens(0.3, d), clustering: 0.7, spacing: 1, minHeight: 0.22, maxHeight: 0.34 },
      )
      if (dials.settlement > 0.2) addTown('village', 0.8)
      break

    case 'kharid_desert':
      // 0.16 trees/100 — effectively nothing grows — but 0.64 rocks/100, the
      // highest measured anywhere
      amplitude = 30 + dials.relief * 110
      ground = [
        { underlay: [
          { underlayId: p.sand, weight: 5 },
          { underlayId: p.dirt, weight: 3 },
          { underlayId: p.grassDead, weight: 1 },
        ] },
        { underlay: [{ underlayId: p.sand, weight: 4 }, { underlayId: p.gravel, weight: 1 }], minHeight: 0.6 },
        { underlay: [{ underlayId: p.stone, weight: 3 }, { underlayId: p.dirt, weight: 2 }],
          minSlope: 9, overlayId: p.rock },
      ]
      scatter.push(
        { ...LOOSE_STONE, density: dens(0.64, d), clustering: 0.5, spacing: 2, avoid: ['path', 'plot'] },
        // 0.16/100 is about six trees a region. What kind is the sand's answer,
        // not ours — this is the theme most worth watching after the change,
        // because desert ground is where context has the least to go on.
        { ...CANOPY, density: dens(0.16, d), clustering: 0.6, spacing: 4, avoid: ['path', 'plot'] },
      )
      environment = { sunColour: 0xffe9b0, sunAmbient: 1.05, fogColour: 0xd8c69a, fogDepth: 420 }
      if (dials.settlement > 0.25) addTown('town', 0.9)
      break

    case 'karamja_tropics':
      // 3.79 PLANTS per 100 tiles, by far the heaviest undergrowth measured,
      // over a yellow-green floor with sand at the shore
      landform = 'coast'
      amplitude = 30 + dials.relief * 100
      // The only theme that names its own ground: the palette is temperate now,
      // so a jungle has to ask for jungle materials (see JUNGLE above).
      ground = [
        { underlay: [
          { underlayId: JUNGLE.yellow, weight: 4 },
          { underlayId: JUNGLE.lush, weight: 3 },
          { underlayId: JUNGLE.olive, weight: 2 },
          { underlayId: p.dirt, weight: 2 },
        ] },
        { underlay: [{ underlayId: JUNGLE.sand, weight: 4 }, { underlayId: JUNGLE.yellow, weight: 1 }], maxHeight: 0.16 },
        { underlay: [{ underlayId: JUNGLE.sand, weight: 3 }], maxHeight: 0.07, overlayId: p.water },
        { underlay: [{ underlayId: p.stone, weight: 2 }, { underlayId: p.mud, weight: 2 }],
          minSlope: 10, overlayId: p.rock },
      ]
      // The sharpest test of the whole idea: nothing here says "tropical" any
      // more. The jungle comes from the GROUND, via the context model — which is
      // the entire thesis, stated as a theme. If this stops being a jungle, the
      // ground bands above are what to look at, not the scatter rule.
      woodland(1.40, { growth: 3.8 })
      break

    case 'rolling_grass':
    default:
      // measured median across the surveyed places is about 1.0 trees/100
      woodland(0.95, { growth: 0.9 })
      scatter.push({ ...LOOSE_STONE, density: dens(0.13, d), clustering: 0.4, spacing: 3,
        avoid: ['path', 'plot'] })
      break
  }

  // a settlement anywhere means paths worth walking, and something at the centre
  if (dials.settlement > 0.35 && !zones.some((z) => z.id === 'town')
      && dials.theme !== 'mining_valley') {
    addTown()
  }

  const darkTheme = dials.theme === 'gloomy_woods' || dials.theme === 'wasteland'
  const form = dials.landform === 'auto' ? landform : dials.landform
  // With a landform the height field is ABSOLUTE (see buildHeights), so the
  // water level is a real depth rather than a percentile: sea sits at 0 and the
  // shoreline lands just above it. Percentile values like 0.3 would have
  // drowned the whole island.
  if ((form === 'coast' || form === 'island') && waterLevel === undefined) waterLevel = 0.06
  const settled = zones.length > 0
  // always a route through: zones get connected, and an unsettled area still
  // gets a road so it reads as somewhere people pass through (and so a dark
  // theme has something to line with lamps)
  const paths: ProcPlan['paths'] = {
    // The overlays that survive a long-and-thin search are PAVED roads — which
    // is why an unpaved woodland track drawn with one looked like tarmac. In
    // the real map a country track is bare brown UNDERLAY with no overlay at
    // all, and a town road is the paved overlay over town earth (57% of the
    // tiles under a real path overlay are that one material).
    // Paved inside a settlement, bare track outside it — decided per tile, not
    // per plan, so one village does not pave the whole countryside.
    overlayId: p.path,
    underlayId: p.townEarth,
    openUnderlayId: p.trackEarth,
    // 1..5 tiles across in open country. A settlement widens on top of this,
    // so the dial sets the TRACK and the road follows from it — rather than
    // the other way round, which would pave the woods to get a high street.
    width: 1 + Math.round(dials.pathWidth * 4),
    settlementWidth: 1 + Math.round(dials.pathWidth * 4) + (settled ? 2 : 1),
    connectZones: true,
    toAreaEdge: true,
    // Straight-across was the single worst tell that this was generated. A
    // surveyed road through a town still runs truer than a track in the middle
    // of nowhere, so a settlement damps the dial rather than ignoring it.
    wander: settled ? dials.wander * 0.6 : dials.wander,
    // Coverage alone decides how many spurs there are: it aims each one at
    // whatever is least served, which beats any fixed count. No `branches`
    // floor, or the reach dial could never reach zero and "trackless
    // wilderness" would be unreachable.
    coverage: dials.pathReach,
    // A village whose every lane stops dead reads as a diagram. Real
    // settlements loop: you can walk out one way and come back another.
    loops: dials.pathLoops,
    waysidePlots: settled ? 1 : 2,
    waysidePlotUnderlayId: p.gravel,
    // "lights along paths if we ask for it to be a darker area"
    lighting: darkTheme
      ? { role: 'light', every: 7, offset: 2, emitsLight: true, size2d: 2 }
      : undefined,
  }

  return {
    version: 1,
    description: THEMES.find((t) => t.id === dials.theme)?.label,
    seed: dials.seed,
    area,
    terrain: {
      baseHeight: 40,
      amplitude,
      featureScale,
      warp: 0.55,
      roughness: 0.45 + dials.relief * 0.3,
      ridged,
      waterLevel,
      landform: form,
      // sea to the east by default; the seed rotates it so a run of islands
      // doesn't all face the same way
      coastAngle: Math.round(rnd() * 360),
    },
    ground,
    zones: zones.length ? zones : undefined,
    paths,
    scatter,
    barriers: barriers.length ? barriers : undefined,
    resources: resources.length ? resources : undefined,
    props: props.length ? props : undefined,
    docks: docks.length ? docks : undefined,
    buildings: buildings.length ? buildings : undefined,
    environment,
    // keep the rng used so a future dial can jitter theme choices reproducibly
    ...(rnd() < -1 ? {} : {}),
  }
}
