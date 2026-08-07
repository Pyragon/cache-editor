/**
 * The built-in planner: presets + dials → a `ProcPlan`.
 *
 * This exists so the generator is fully usable with NO API key. It emits the
 * exact same plan type the Claude layer does, which is the point of the plan
 * being the contract: the AI is a better planner, not a different pipeline.
 *
 * Its themes also double as worked examples for the Claude layer's prompt —
 * showing the model what a good plan looks like beats describing it.
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
  | 'rolling_grass' | 'dense_forest' | 'gloomy_woods' | 'stony_highland'
  | 'mining_valley' | 'coastal' | 'village_in_forest' | 'wasteland'

export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: 'rolling_grass', label: 'Rolling grass', blurb: 'Gentle hills, scattered oaks, a path or two.' },
  { id: 'dense_forest', label: 'Dense forest', blurb: 'Heavy tree cover with clearings and undergrowth.' },
  { id: 'gloomy_woods', label: 'Gloomy woods', blurb: 'Dead trees, stumps, fog and a dimmed sun.' },
  { id: 'stony_highland', label: 'Stony highland', blurb: 'Varrock-ish: rocky ground, boulders, stone paths.' },
  { id: 'mining_valley', label: 'Mining valley', blurb: 'A pit of ore rocks, rubble and cart tracks.' },
  { id: 'coastal', label: 'Coastal', blurb: 'Water on one side, sand, reeds and palms.' },
  { id: 'village_in_forest', label: 'Village in forest', blurb: 'A town ringed by trees you cannot walk through.' },
  { id: 'wasteland', label: 'Wasteland', blurb: 'Burnt stumps, rubble, almost nothing alive.' },
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
  /** 0..1 — how much path routes meander instead of running at their goal */
  wander: number
  /** 0..1 — how much of the area ends up within reach of the path network */
  pathReach: number
  /** 0..1 — open-country path width; a settlement always widens on top of it */
  pathWidth: number
  /** 0..1 — how often a spur closes back onto the network instead of dead-ending */
  pathLoops: number
  palette: GroundPalette
}

export const DEFAULT_DIALS: Omit<PlannerDials, 'seed'> = {
  theme: 'rolling_grass',
  relief: 0.4,
  density: 0.5,
  settlement: 0.3,
  wander: 0.55,
  pathReach: 0.5,
  pathWidth: 0.25,
  pathLoops: 0.6,
  palette: PALETTE,
}

const pick = (...s: SpeciesPick[]): SpeciesPick[] => s

/**
 * Ground bands shared by the greener themes.
 *
 * Later bands win, so this reads general case first, exceptions after. The
 * point of banding on height as well as slope is that a single material over a
 * whole area reads as a painted plane no matter how good the heightmap is:
 * hollows want to look wet, tops want to look worn, and only the middle should
 * be plain grass.
 */
function greenBands(p: GroundPalette): GroundBand[] {
  return [
    { underlay: [{ underlayId: p.grass }] },
    // hollows collect water; ridges dry out and wear through to bare ground
    { underlay: [{ underlayId: p.mud, weight: 2 }, { underlayId: p.dirt, weight: 1 }], maxHeight: 0.2 },
    { underlay: [{ underlayId: p.grass, weight: 3 }, { underlayId: p.dirt, weight: 1 }], minHeight: 0.6 },
    { underlay: [{ underlayId: p.dirt, weight: 1 }, { underlayId: p.grass, weight: 2 }], minSlope: 12 },
    { underlay: [{ underlayId: p.stone }], minSlope: 26 },
    { underlay: [{ underlayId: p.stone, weight: 2 }, { underlayId: p.gravel, weight: 1 }], minHeight: 0.88 },
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

  const zones: Zone[] = []
  const scatter: ScatterRule[] = []
  const barriers: ProcPlan['barriers'] = []
  const resources: ProcPlan['resources'] = []
  const props: ProcPlan['props'] = []
  let environment: EnvironmentSpec | undefined
  let ground = greenBands(p)
  let ridged = false
  let amplitude = 20 + dials.relief * 120
  let waterLevel: number | undefined

  const townRadius = Math.round(Math.min(w, h) * 0.18)
  const addTown = (kind: Zone['kind'] = 'village') => {
    zones.push({
      id: 'town',
      kind,
      shape: { type: 'circle', cx, cy, radius: townRadius },
      flatten: 0.85,
      ground: [{ underlayId: p.dirt, weight: 3 }, { underlayId: p.gravel, weight: 1 }],
      // paved so a reserved plot is visible now, rather than an invisible
      // promise to a prefab system that doesn't exist yet
      plots: {
        count: Math.max(2, Math.round(4 + dials.settlement * 8)),
        minSize: 5, maxSize: 9, purpose: 'building', underlayId: p.gravel,
      },
    })
  }

  switch (dials.theme) {
    case 'dense_forest':
      scatter.push(
        { species: pick({ species: 'tree', weight: 3 }, { species: 'tree_oak', weight: 2 }, { species: 'tree_willow' }, { species: 'tree_maple' }),
          density: 14 + dials.density * 22, clustering: 0.5, spacing: 2, avoid: ['path', 'plot'], maxSlope: 24 },
        { species: pick({ species: 'fern', weight: 3 }, { species: 'bush', weight: 2 }, { species: 'plant' }, { species: 'mushroom' }),
          density: 10 + dials.density * 18, clustering: 0.6, spacing: 1, avoid: ['path', 'plot'] },
        { species: pick({ species: 'tree_stump' }, { species: 'tree_fallen' }),
          density: 1.5, clustering: 0.4, spacing: 3, avoid: ['path', 'plot'] },
      )
      break

    case 'gloomy_woods':
      amplitude = 20 + dials.relief * 80
      // nothing green: blighted grass over bare earth, mud in every hollow.
      // A gloomy place that is still carpeted in healthy grass reads as a
      // sunny field with dead props standing in it.
      ground = [
        { underlay: [{ underlayId: p.grassDead, weight: 3 }, { underlayId: p.dirt, weight: 2 }] },
        { underlay: [{ underlayId: p.mud, weight: 3 }, { underlayId: p.grassDead, weight: 1 }], maxHeight: 0.32 },
        { underlay: [{ underlayId: p.dirt, weight: 2 }, { underlayId: p.grassDead, weight: 1 }], minSlope: 12 },
        { underlay: [{ underlayId: p.stone }], minSlope: 26 },
      ]
      scatter.push(
        { species: pick({ species: 'tree_dead', weight: 5 }, { species: 'tree_burnt', weight: 2 }, { species: 'tree_stump', weight: 2 }, { species: 'tree_fallen' }),
          density: 12 + dials.density * 18, clustering: 0.55, spacing: 2, avoid: ['path', 'plot'] },
        { species: pick({ species: 'mushroom', weight: 2 }, { species: 'plant' }, { species: 'gravestone' }),
          density: 4 + dials.density * 6, clustering: 0.7, spacing: 2, avoid: ['path', 'plot'] },
      )
      // this is the bit dials alone can't do: the PLACE gets darker, not just
      // the props. Dim, cold sun and heavy near fog.
      environment = {
        sunColour: 0x6a6f7a,
        sunAmbient: 0.75,
        sunLight: 0.5,
        sunBacklight: 0.25,
        fogColour: 0x40454e,
        fogDepth: 220,
      }
      break

    case 'stony_highland':
      ridged = true
      amplitude = 60 + dials.relief * 140
      ground = [
        { underlay: [{ underlayId: p.stone, weight: 3 }, { underlayId: p.dirt, weight: 1 }] },
        { underlay: [{ underlayId: p.gravel, weight: 2 }, { underlayId: p.stone, weight: 1 }], maxSlope: 14 },
        { underlay: [{ underlayId: p.grass }], maxSlope: 8, maxHeight: 0.45 },
        { underlay: [{ underlayId: p.stone }], minSlope: 18, overlayId: p.rock },
      ]
      scatter.push(
        { species: pick({ species: 'rock_small', weight: 3 }, { species: 'rock_large', weight: 2 }, { species: 'boulder' }),
          density: 8 + dials.density * 14, clustering: 0.5, spacing: 2, avoid: ['path', 'plot'] },
        { species: pick({ species: 'tree_evergreen' }, { species: 'tree' }),
          density: 3 + dials.density * 6, clustering: 0.6, spacing: 3, avoid: ['path', 'plot'], maxSlope: 16 },
      )
      if (dials.settlement > 0.2) {
        addTown('town')
        props.push({ species: 'fountain', zoneId: 'town', pad: 3 })
        props.push({ species: 'statue', zoneId: 'town', x: cx + 8, y: cy + 6, pad: 2 })
      }
      break

    case 'mining_valley': {
      amplitude = 40 + dials.relief * 120
      ground = [
        { underlay: [{ underlayId: p.dirt, weight: 3 }, { underlayId: p.gravel, weight: 2 }] },
        { underlay: [{ underlayId: p.gravel, weight: 2 }, { underlayId: p.stone, weight: 1 }], minHeight: 0.6 },
        { underlay: [{ underlayId: p.stone }], minSlope: 16 },
      ]
      const pitR = Math.round(Math.min(w, h) * 0.16)
      zones.push({
        id: 'pit', kind: 'mine',
        shape: { type: 'circle', cx, cy, radius: pitR },
        flatten: 0.6,
        ground: [{ underlayId: p.gravel, weight: 3 }, { underlayId: p.stone, weight: 2 }, { underlayId: p.dirt, weight: 1 }],
      })
      resources.push({
        zoneId: 'pit',
        species: pick({ species: 'ore_copper', weight: 3 }, { species: 'ore_tin', weight: 3 }, { species: 'ore_iron', weight: 2 }, { species: 'ore_coal', weight: 2 }, { species: 'ore_clay' }, { species: 'ore_silver' }),
        count: Math.round(16 + dials.density * 34),
        depth: 26,
        rubble: true,
      })
      scatter.push(
        { species: pick({ species: 'rubble', weight: 3 }, { species: 'rock_small', weight: 2 }, { species: 'boulder' }),
          density: 6 + dials.density * 10, clustering: 0.6, spacing: 1, avoid: ['path'] },
        { species: pick({ species: 'crate' }, { species: 'barrel' }),
          density: 1, clustering: 0.8, spacing: 2, avoid: ['path'], zoneId: 'pit' },
      )
      break
    }

    case 'coastal':
      amplitude = 20 + dials.relief * 70
      waterLevel = 0.3
      ground = [
        { underlay: [{ underlayId: p.grass }] },
        { underlay: [{ underlayId: p.sand }], maxHeight: 0.4 },
        { underlay: [{ underlayId: p.mud, weight: 1 }, { underlayId: p.sand, weight: 3 }], maxHeight: 0.33 },
        { underlay: [{ underlayId: p.sand }], maxHeight: 0.3, overlayId: p.water },
      ]
      scatter.push(
        { species: pick({ species: 'tree_palm', weight: 2 }, { species: 'tree' }),
          density: 4 + dials.density * 8, clustering: 0.5, spacing: 3, avoid: ['path', 'water'], minHeight: 0.34 },
        { species: pick({ species: 'reeds', weight: 3 }, { species: 'grass_tuft' }),
          density: 8 + dials.density * 12, clustering: 0.7, spacing: 1, minHeight: 0.3, maxHeight: 0.38 },
      )
      break

    case 'village_in_forest': {
      addTown()
      scatter.push(
        { species: pick({ species: 'tree', weight: 3 }, { species: 'tree_oak', weight: 2 }, { species: 'tree_maple' }),
          density: 16 + dials.density * 20, clustering: 0.5, spacing: 2, avoid: ['path', 'plot', 'zone'], maxSlope: 24 },
        { species: pick({ species: 'fern', weight: 2 }, { species: 'bush' }, { species: 'flowers' }),
          density: 8 + dials.density * 10, clustering: 0.6, spacing: 1, avoid: ['path', 'plot'] },
      )
      // the ask: "surrounded by a forest ... so we are actually trapped"
      barriers.push({
        aroundZoneId: 'town',
        species: pick({ species: 'tree', weight: 3 }, { species: 'tree_oak', weight: 2 }),
        thickness: 3,
        offset: 4,
        gaps: 2,
        gapWidth: 7,
      })
      props.push({ species: 'well', zoneId: 'town', pad: 2 })
      break
    }

    case 'wasteland':
      amplitude = 30 + dials.relief * 90
      ground = [
        { underlay: [{ underlayId: p.dirt, weight: 4 }, { underlayId: p.grassDead, weight: 2 }, { underlayId: p.gravel, weight: 1 }] },
        { underlay: [{ underlayId: p.mud, weight: 2 }, { underlayId: p.dirt, weight: 1 }], maxHeight: 0.25 },
        { underlay: [{ underlayId: p.stone }], minSlope: 14 },
      ]
      scatter.push(
        { species: pick({ species: 'tree_burnt', weight: 3 }, { species: 'tree_stump', weight: 3 }, { species: 'tree_dead', weight: 2 }),
          density: 5 + dials.density * 8, clustering: 0.6, spacing: 3, avoid: ['path'] },
        { species: pick({ species: 'rubble', weight: 3 }, { species: 'rock_small' }),
          density: 6 + dials.density * 10, clustering: 0.5, spacing: 1, avoid: ['path'] },
      )
      environment = { sunColour: 0x8a7a63, sunAmbient: 0.95, fogColour: 0x6b6153, fogDepth: 320 }
      break

    case 'rolling_grass':
    default:
      scatter.push(
        { species: pick({ species: 'tree_oak', weight: 2 }, { species: 'tree', weight: 3 }, { species: 'tree_willow' }),
          density: 4 + dials.density * 10, clustering: 0.45, spacing: 3, avoid: ['path', 'plot'], maxSlope: 20 },
        { species: pick({ species: 'flowers', weight: 2 }, { species: 'grass_tuft', weight: 3 }, { species: 'bush' }),
          density: 6 + dials.density * 12, clustering: 0.5, spacing: 1, avoid: ['path', 'plot'] },
        { species: pick({ species: 'rock_small' }),
          density: 1.5, clustering: 0.4, spacing: 3, avoid: ['path', 'plot'] },
      )
      break
  }

  // a settlement anywhere means paths worth walking, and something at the centre
  if (dials.settlement > 0.35 && !zones.some((z) => z.id === 'town') && dials.theme !== 'mining_valley') {
    addTown()
  }

  const darkTheme = dials.theme === 'gloomy_woods' || dials.theme === 'wasteland'
  // always a route through: zones get connected, and an unsettled area still
  // gets a road so it reads as somewhere people pass through (and so a dark
  // theme has something to line with lamps)
  const settled = zones.length > 0
  const paths: ProcPlan['paths'] = {
        overlayId: p.path,
        // 1..5 tiles across in open country. A settlement widens on top of
        // this, so the dial sets the TRACK and the road follows from it —
        // rather than the other way round, which would pave the woods to get
        // a decent high street.
        width: 1 + Math.round(dials.pathWidth * 4),
        settlementWidth: 1 + Math.round(dials.pathWidth * 4) + (settled ? 2 : 1),
        connectZones: true,
        toAreaEdge: true,
        // Straight-across was the single worst tell that this was generated.
        // A surveyed road through a town still runs truer than a track in the
        // middle of nowhere, so a settlement damps the dial rather than
        // ignoring it.
        wander: settled ? dials.wander * 0.6 : dials.wander,
        // Coverage alone decides how many spurs there are: it aims each one
        // at whatever is least served, which beats any fixed count. No
        // `branches` floor, or the reach dial could never reach zero and
        // "trackless wilderness" would be unreachable.
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
