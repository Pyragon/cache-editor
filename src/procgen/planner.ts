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
  EnvironmentSpec, GroundBand, ProcPlan, ScatterRule, SpeciesPick, Zone,
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
  | 'karamja_tropics'

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
 * The measured woodland species mix: plain tree 51.6%, dead 20.9%, oak 11.4%,
 * evergreen 7.9%, willow 3.6%, stump 1.8%, maple 1.3%, yew 1.1%. Yew and maple
 * are genuinely rare in the game — a wood full of them is wrong.
 */
const WOODLAND = pick(
  { species: 'tree', weight: 13 },
  { species: 'tree_oak', weight: 3 },
  { species: 'tree_evergreen', weight: 2 },
  { species: 'tree_willow', weight: 1 },
)

/** Undergrowth, measured pooled at ~1.0 per 100 tiles across all places. */
const UNDERGROWTH = pick(
  { species: 'plant', weight: 5 },
  { species: 'flowers', weight: 2 },
  { species: 'mushroom', weight: 1 },
  { species: 'bush', weight: 1 },
  { species: 'fern', weight: 1 },
)

/**
 * Jungle floor. Its own mix because jungle plants and grass are now separate
 * species: Karamja is dense enough in the real map that pooling them with the
 * generic buckets and weighting by real usage put jungle grass on 77% of every
 * grass tuft in the game, snowfields included.
 */
const JUNGLE_UNDERGROWTH = pick(
  { species: 'plant_jungle', weight: 5 },
  { species: 'grass_jungle', weight: 3 },
  { species: 'bush', weight: 1 },
  { species: 'fern', weight: 1 },
)

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
  }

  /** trees + undergrowth at a measured per-100-tiles figure */
  const woodland = (
    treePer100: number, mix: SpeciesPick[] = WOODLAND, growth = 1,
    floor: SpeciesPick[] = UNDERGROWTH,
  ) => {
    scatter.push(
      { species: mix, density: dens(treePer100, d), clustering: 0.5, spacing: 2,
        avoid: ['path', 'plot'], maxSlope: 20 },
      { species: floor, density: dens(1.0 * growth, d), clustering: 0.6, spacing: 1,
        avoid: ['path', 'plot'] },
    )
  }

  switch (dials.theme) {
    // ---------------------------------------------------------------- invented
    case 'dense_forest':
      // the densest place measured is 2.37 trees/100; a deliberate forest sits
      // just above it rather than at the old 14-36
      woodland(2.6, pick(
        { species: 'tree', weight: 10 },
        { species: 'tree_oak', weight: 4 },
        { species: 'tree_willow', weight: 2 },
        { species: 'tree_maple', weight: 1 },
      ), 1.6)
      scatter.push({ species: pick({ species: 'tree_stump' }, { species: 'tree_fallen' }),
        density: dens(0.15, d), clustering: 0.4, spacing: 3, avoid: ['path', 'plot'] })
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
      woodland(1.6, pick(
        { species: 'tree_dead', weight: 8 },
        { species: 'tree_stump', weight: 3 },
        { species: 'tree_fallen', weight: 2 },
        { species: 'tree_burnt', weight: 1 },
      ), 0.7)
      scatter.push({ species: pick({ species: 'gravestone' }, { species: 'mushroom' }),
        density: dens(0.2, d), clustering: 0.7, spacing: 2, avoid: ['path', 'plot'] })
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
      woodland(0.5, pick({ species: 'tree_evergreen', weight: 3 }, { species: 'tree' }), 0.4)
      scatter.push({ species: pick(
        { species: 'rock_small', weight: 3 }, { species: 'rock_large', weight: 2 }, { species: 'boulder' }),
        density: dens(0.5, d), clustering: 0.5, spacing: 2, avoid: ['path', 'plot'] })
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
        species: pick(
          { species: 'ore_copper', weight: 3 }, { species: 'ore_tin', weight: 3 },
          { species: 'ore_iron', weight: 2 }, { species: 'ore_coal', weight: 2 },
          { species: 'ore_clay' }, { species: 'ore_silver' }),
        // A real mining site carries 13-19 rocks (p25/p75, 20 sites measured),
        // median 4 of each type. The executor knots them into per-type pockets,
        // so this is the size of an ore BODY, not a fill for the whole pit.
        count: Math.round(13 + d * 14),
        depth: 26,
        rubble: true,
      })
      scatter.push(
        { species: pick({ species: 'rubble', weight: 3 }, { species: 'rock_small', weight: 2 }, { species: 'boulder' }),
          density: dens(0.6, d), clustering: 0.6, spacing: 1, avoid: ['path'] },
        { species: pick({ species: 'crate' }, { species: 'barrel' }),
          density: dens(0.15, d), clustering: 0.8, spacing: 2, avoid: ['path'], zoneId: 'pit' },
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
      woodland(0.9, pick({ species: 'tree', weight: 3 }, { species: 'tree_willow', weight: 2 }, { species: 'tree_oak' }), 1.1)
      scatter.push({ species: pick({ species: 'reeds', weight: 3 }, { species: 'grass_tuft' }),
        density: dens(0.8, d), clustering: 0.7, spacing: 1, minHeight: 0.07, maxHeight: 0.2 })
      break

    case 'village_in_forest': {
      addTown()
      woodland(2.2, WOODLAND, 1.2)
      // the original ask: "surrounded by a forest ... so we are actually trapped"
      barriers.push({
        aroundZoneId: 'town',
        species: pick({ species: 'tree', weight: 3 }, { species: 'tree_oak', weight: 2 }),
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
        { species: pick({ species: 'tree_burnt', weight: 3 }, { species: 'tree_stump', weight: 3 }, { species: 'tree_dead', weight: 2 }),
          density: dens(0.6, d), clustering: 0.6, spacing: 3, avoid: ['path'] },
        { species: pick({ species: 'rubble', weight: 3 }, { species: 'rock_small' }),
          density: dens(0.5, d), clustering: 0.5, spacing: 1, avoid: ['path'] },
      )
      environment = { sunColour: 0x8a7a63, sunAmbient: 0.95, fogColour: 0x6b6153, fogDepth: 320 }
      break

    // ------------------------------------------------------- measured places
    case 'lumbridge_meadow':
      // 0.64 trees/100 — the sparsest green place surveyed. 26% flat, height
      // range 49, and a town core that is 36% packed earth.
      amplitude = 20 + dials.relief * 60
      woodland(0.64, pick(
        { species: 'tree', weight: 7 }, { species: 'tree_oak', weight: 1 }, { species: 'tree_willow', weight: 1 }), 0.4)
      scatter.push({ species: pick({ species: 'rock_small' }),
        density: dens(0.36, d), clustering: 0.4, spacing: 3, avoid: ['path', 'plot'] })
      if (dials.settlement > 0.15) addTown('village')
      break

    case 'varrock_town':
      // the biggest built footprint measured (10.7% of its nine regions), on
      // ordinary balanced green country, 1.30 trees/100
      amplitude = 20 + dials.relief * 60
      addTown('town', 1.5)
      woodland(1.30, pick(
        { species: 'tree', weight: 9 }, { species: 'tree_oak', weight: 2 }, { species: 'tree_yew', weight: 1 }), 0.7)
      props.push({ species: 'fountain', zoneId: 'town', pad: 3 })
      props.push({ species: 'signpost', zoneId: 'town', pad: 1 })
      break

    case 'falador_stone':
      // 0.56 buildings and 0.39 fences per 100 tiles — the most built-up of the
      // surveyed towns after Taverley, on gentle ground with pale paving
      amplitude = 25 + dials.relief * 75
      addTown('town', 1.3)
      woodland(0.91, WOODLAND, 0.8)
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
      woodland(1.20, pick(
        { species: 'tree', weight: 8 }, { species: 'tree_willow', weight: 3 },
        { species: 'tree_oak', weight: 2 }, { species: 'tree_dead', weight: 2 }), 0.8)
      if (dials.settlement > 0.15) addTown('village', 0.8)
      break

    case 'seers_farmland':
      // 1.99 trees/100 and 0.53 fences/100 — wooded farmland. The only place
      // maple grows in any number (9.6% of its trees).
      amplitude = 25 + dials.relief * 85
      woodland(1.99, pick(
        { species: 'tree', weight: 8 }, { species: 'tree_oak', weight: 3 },
        { species: 'tree_maple', weight: 2 }, { species: 'tree_willow', weight: 1 }), 1.0)
      // its 0.53 fences/100 are hedged FIELD BOUNDARIES, not loose posts — see
      // the note in `falador_stone`
      scatter.push(
        { species: pick({ species: 'flowers' }),
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
      woodland(2.37, pick(
        { species: 'tree_dead', weight: 8 },
        { species: 'tree', weight: 3 },
        { species: 'tree_stump', weight: 2 },
        { species: 'tree_oak', weight: 1 }), 0.5)
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
      woodland(1.23, WOODLAND, 0.6)
      scatter.push(
        { species: pick({ species: 'flowers' }),
          density: dens(0.86, d), clustering: 0.6, spacing: 1, avoid: ['path', 'plot'], minHeight: 0.17 },
        { species: pick({ species: 'reeds' }),
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
        { species: pick({ species: 'rock_small', weight: 3 }, { species: 'boulder', weight: 2 }, { species: 'rock_large' }),
          density: dens(0.64, d), clustering: 0.5, spacing: 2, avoid: ['path', 'plot'] },
        { species: pick({ species: 'tree_dead', weight: 2 }, { species: 'tree_palm' }),
          density: dens(0.16, d), clustering: 0.6, spacing: 4, avoid: ['path', 'plot'] },
      )
      environment = { sunColour: 0xffe9b0, sunAmbient: 1.05, fogColour: 0xd8c69a, fogDepth: 420 }
      if (dials.settlement > 0.25) addTown('town', 0.9)
      break

    case 'karamja_tropics':
      // 3.79 PLANTS per 100 tiles, by far the heaviest undergrowth measured,
      // over a yellow-green floor with sand at the shore
      landform = 'coast'
      amplitude = 30 + dials.relief * 100
      ground = [
        { underlay: [
          { underlayId: p.grassDead, weight: 4 },
          { underlayId: p.grassLush, weight: 3 },
          { underlayId: p.grass, weight: 2 },
          { underlayId: p.dirt, weight: 2 },
        ] },
        { underlay: [{ underlayId: p.sand, weight: 4 }, { underlayId: p.grassDead, weight: 1 }], maxHeight: 0.16 },
        { underlay: [{ underlayId: p.sand, weight: 3 }], maxHeight: 0.07, overlayId: p.water },
        { underlay: [{ underlayId: p.stone, weight: 2 }, { underlayId: p.mud, weight: 2 }],
          minSlope: 10, overlayId: p.rock },
      ]
      woodland(1.40, pick(
        { species: 'tree_tropical', weight: 7 }, { species: 'tree', weight: 3 },
        { species: 'tree_palm', weight: 2 }, { species: 'tree_oak', weight: 1 },
      ), 3.8, JUNGLE_UNDERGROWTH)
      break

    case 'rolling_grass':
    default:
      // measured median across the surveyed places is about 1.0 trees/100
      woodland(0.95, pick(
        { species: 'tree', weight: 9 }, { species: 'tree_oak', weight: 3 }, { species: 'tree_willow', weight: 1 }), 0.9)
      scatter.push({ species: pick({ species: 'rock_small' }),
        density: dens(0.13, d), clustering: 0.4, spacing: 3, avoid: ['path', 'plot'] })
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
      ? { species: pick({ species: 'lantern', weight: 2 }, { species: 'torch' }), every: 7, offset: 2, emitsLight: true, size2d: 2 }
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
    environment,
    // keep the rng used so a future dial can jitter theme choices reproducibly
    ...(rnd() < -1 ? {} : {}),
  }
}
