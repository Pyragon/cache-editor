/**
 * ARCHETYPES — place types learned by clustering the real map's own regions.
 *
 * ## Why this exists
 *
 * A plan is authored either by a hand-written theme or by a language model
 * reading one line of description, and **neither has read the map**. Every
 * `underlayId`, species list and density baked into a plan is therefore a
 * guess overriding the one component that actually knows. Cody's point,
 * recorded in `docs/map-learning.md` §9a:
 *
 * > "A plan should really just tell the procgen the type of area... The procgen
 * > should then choose underlay materials related to the type of area, choose
 * > what material to use for the path, scatter trees and plants based on that
 * > area. We kinda defeat the purpose of the procgen if most things are decided
 * > by the plan, that doesn't have access to all the stuff we're making now."
 *
 * So: the plan says *what kind of place this is*; this module answers *what
 * that looks like in this cache*, from measurement.
 *
 * ## Why clusters and not a hand-written table
 *
 * A hand-written "town palette" is the same guess in a different file. Real
 * regions already carry the answer, and clustering them recovers recognisable
 * place types with no labelling at all — §9a's feasibility run produced a
 * cluster containing Varrock, another that is empty grassland at 19 scenery /
 * 7 walls, and a swampy unbuilt one.
 *
 * ## How a plan reaches one, with no labels
 *
 * The clusters come out unnamed, and naming them by hand would put the guess
 * straight back. Instead each `AreaType` is defined as a **target profile** on
 * interpretable, measured axes (how built-up, how vegetated, how wet, how
 * hilly), and matching picks the cluster nearest that profile. That is
 * deterministic, needs no labels, and works on any cache — including one whose
 * regions are nothing like Gielinor's.
 *
 * Nothing here is cached across users: every user mines their own cache
 * (§9, decided 2026-08-07), so this must stay cheap enough to run in a browser.
 */

import type { SpeciesId } from './types'

/** Tiles in a region — the density denominator, see `RegionSignature.tiles`. */
export const REGION_TILES = 64 * 64

/** One region, reduced to the numbers a place type is made of. */
export type RegionSignature = {
  region: number
  /**
   * plane-0 tiles that carried ground data at all.
   *
   * Used for the ground SHARES only, never as a density denominator.
   * Dividing placements by it inflated density 10-100x on regions that are
   * mostly dungeon or ocean — a region with 600 ground tiles and 500 objects
   * read as 83 per 100, against a real-world maximum of about 4 per 100
   * (`docs/procgen-reference.md`). Densities divide by `REGION_TILES` so they
   * mean the same thing everywhere and stay comparable to that survey.
   */
  tiles: number
  /** underlay material byte → tile count */
  underlay: Record<number, number>
  /** overlay material byte → tile count (byte 0, "no overlay", is excluded) */
  overlay: Record<number, number>
  /** share of tiles with no height step to any 4-neighbour */
  flat: number
  /** 90th-percentile slope in stored units */
  relief: number
  /**
   * EVERY plane-0 loc of shape 10/11/22 — which includes floor decoration (22)
   * and all indoor clutter, not just landscape.
   *
   * Named `scenery` for the loc CLASS, and that name is a trap: it runs 12-75
   * per 100 tiles, against the 15-settlement survey's "all landscape scenery,
   * buildings included, under 4 per 100". Two different populations, 10-20x
   * apart. `describeMine` prints it as `allLocs/100` and says so outright,
   * because a planner reading one as the other asks for a scatter density the
   * sanitizer then caps.
   */
  scenery: number
  /** wall placements (shapes 0-3, 9), any plane — the built-ness signal */
  walls: number
  /** species-matched plane-0 placements, by species */
  species: Partial<Record<SpeciesId, number>>
}

/** A learned place type: everything the generator needs to dress an area. */
export type Archetype = {
  id: number
  /** how many real regions fell into this cluster */
  regions: number
  /** example region ids, for the UI and for explaining a choice */
  examples: number[]
  /**
   * Every region in this cluster. Cheap (2,413 numbers across the whole model)
   * and it makes the result checkable rather than merely plausible — "did the
   * town cluster actually catch Varrock and Falador" is the only real test
   * that the clustering means anything.
   */
  regionIds: number[]
  /** underlay byte → share of ground, commonest first */
  ground: { byte: number; share: number }[]
  /** overlay byte → share of the tiles that HAVE an overlay */
  overlays: { byte: number; share: number }[]
  /** placements per 100 tiles */
  /** ALL plane-0 locs per 100 tiles, clutter included — see `scenery` above.
   *  Not a scatter density; presented to planners as `allLocs/100`. */
  sceneryPer100: number
  wallsPer100: number
  /** species → share of this cluster's species-matched placements */
  species: { species: SpeciesId; share: number }[]
  /** 0..1 share of dead-flat tiles */
  flat: number
  /** 90th-percentile slope, stored units */
  relief: number
}

export type ArchetypeModel = {
  version: 2
  fingerprint: string
  builtAt: number
  archetypes: Archetype[]
}

/**
 * The closed vocabulary a plan may ask for, each defined as a TARGET PROFILE
 * rather than a name pinned to a cluster.
 *
 * Axes are normalised 0..1 against the observed range across clusters, so the
 * profile means "the most built-up kind of place this cache has", not an
 * absolute count that would be meaningless in another dump.
 */
export type AreaType =
  | 'town' | 'village' | 'farmland' | 'forest' | 'wilds'
  | 'rocky' | 'wetland' | 'barren'

type Profile = {
  /** 0..1, how built-up — wall density, ranked against the other archetypes */
  built: number
  /**
   * 0..1, share of the named scenery that is actually GROWING.
   *
   * Not total scenery density, which was the first attempt and was wrong: a
   * town is thick with benches, crates and barrels, so by raw placement count
   * Ardougne looked more "vegetated" than open country and `town` matched the
   * wrong cluster. Measured off the species mix instead, so greenery means
   * greenery.
   */
  greenery: number
  /** 0..1, share of the named scenery that is trees */
  trees: number
  /**
   * 0..1, how hilly — the WEAKEST axis, and weighted lowest because of it.
   *
   * It is the 90th-percentile height step over stored heights, which picks up
   * the sharp steps at building foundations as readily as real terrain. So
   * heavily built regions read as "hilly": Varrock/Falador/Lumbridge's cluster
   * scores 0.85 relief, which is a fact about their buildings, not their
   * ground. Separating terrain relief from built relief needs the ground data
   * without the buildings on it, and is not done.
   */
  relief: number
}

/**
 * What each area type means on the measured axes. These are the ONE piece of
 * judgement left in the pipeline, and they are deliberately about shape rather
 * than content: "a town is the most built-up, least vegetated kind of place
 * this map has" is true of any RuneScape-like cache, whereas "a town is
 * underlay 163" is true only of this one.
 */
export const AREA_TYPE_PROFILES: Record<AreaType, Profile> = {
  town:     { built: 1.0, greenery: 0.2, trees: 0.08, relief: 0.3 },
  village:  { built: 0.6, greenery: 0.5, trees: 0.3, relief: 0.4 },
  farmland: { built: 0.3, greenery: 0.7, trees: 0.35, relief: 0.25 },
  forest:   { built: 0.05, greenery: 0.9, trees: 0.6, relief: 0.5 },
  wilds:    { built: 0.02, greenery: 0.6, trees: 0.45, relief: 0.7 },
  rocky:    { built: 0.1, greenery: 0.35, trees: 0.2, relief: 1.0 },
  wetland:  { built: 0.1, greenery: 0.85, trees: 0.3, relief: 0.1 },
  barren:   { built: 0.05, greenery: 0.15, trees: 0.1, relief: 0.3 },
}

export const AREA_TYPES = Object.keys(AREA_TYPE_PROFILES) as AreaType[]

const TREE_SPECIES = new Set<string>([
  'tree', 'tree_oak', 'tree_willow', 'tree_maple', 'tree_yew', 'tree_magic',
  'tree_evergreen', 'tree_palm', 'tree_tropical', 'tree_dead', 'tree_burnt',
])

/** Everything that GROWS — trees plus undergrowth. */
const GREEN_SPECIES = new Set<string>([
  ...TREE_SPECIES,
  'tree_stump', 'tree_fallen', 'bush', 'fern', 'plant', 'plant_jungle',
  'flowers', 'grass_tuft', 'grass_jungle', 'mushroom', 'reeds', 'nettles',
])

/** How many ground materials to keep per archetype. */
const GROUND_KEEP = 10
/** How many clusters. §9a proved k=8 produces recognisable types. */
const K = 8
/** k-means iterations; it converges long before this on 2.4k points. */
const ITERATIONS = 25
/** A cluster smaller than this is noise rather than a place type. */
const MIN_CLUSTER = 8

/**
 * Feature vector for clustering.
 *
 * Ground SHARES (not counts) so a region is compared by what it is made of,
 * rather than by how much of it carries data. Densities are log-compressed:
 * scenery counts are heavily skewed, and on a raw scale one dense region
 * dominates every distance in the space. §9a's feasibility run saturated its
 * density figures at a cap of 400 and flagged exactly this.
 */
function vectorFor(sig: RegionSignature, materials: number[]): number[] {
  const v: number[] = []
  const ground = Math.max(1, sig.tiles)
  for (const m of materials) v.push((sig.underlay[m] ?? 0) / ground)
  const per100 = (n: number) => Math.log1p((n / REGION_TILES) * 100)
  // weighted up: built-ness is the single most separating property of a place,
  // and without this it is one dimension among twelve ground shares
  v.push(per100(sig.walls) * 2)
  v.push(per100(sig.scenery) * 2)
  v.push(sig.flat)
  v.push(Math.log1p(sig.relief))
  return v
}

/** Deterministic RNG — clustering must give the same answer on every machine. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function dist2(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const t = a[i] - b[i]
    d += t * t
  }
  return d
}

/**
 * k-means with a k-means++ seeding, run on the region signatures.
 *
 * Deterministic throughout: the RNG is seeded from a constant and the input is
 * sorted by region id, so two users mining the same cache get the same
 * archetypes. That matters because a plan referring to "the town archetype"
 * must mean the same place on every machine.
 */
export function buildArchetypes(
  signatures: RegionSignature[],
  fingerprint: string,
): ArchetypeModel {
  // Regions with almost no ground data say nothing about what a place looks
  // like, and there are a lot of them (empty ocean and unused map).
  const sigs = signatures
    .filter((s) => s.tiles >= 512 && (s.scenery > 0 || s.walls > 0))
    .sort((a, b) => a.region - b.region)
  if (sigs.length < K * MIN_CLUSTER) {
    return { version: 2, fingerprint, builtAt: Date.now(), archetypes: [] }
  }

  // the materials worth comparing on: the commonest across the whole map
  const total = new Map<number, number>()
  for (const s of sigs) {
    for (const [b, n] of Object.entries(s.underlay)) {
      total.set(Number(b), (total.get(Number(b)) ?? 0) + n)
    }
  }
  const materials = [...total.entries()]
    .filter(([b]) => b !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([b]) => b)

  const points = sigs.map((s) => vectorFor(s, materials))
  const dim = points[0].length
  const rnd = lcg(0x5eed)

  // --- k-means++ seeding
  const centres: number[][] = [points[Math.floor(rnd() * points.length)].slice()]
  while (centres.length < K) {
    const d = points.map((p) => Math.min(...centres.map((c) => dist2(p, c))))
    const sum = d.reduce((a, b) => a + b, 0)
    if (sum <= 0) break
    let r = rnd() * sum
    let idx = 0
    for (let i = 0; i < d.length; i++) {
      r -= d[i]
      if (r <= 0) { idx = i; break }
    }
    centres.push(points[idx].slice())
  }

  let assign = new Array(points.length).fill(0)
  for (let it = 0; it < ITERATIONS; it++) {
    let moved = false
    for (let i = 0; i < points.length; i++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centres.length; c++) {
        const d = dist2(points[i], centres[c])
        if (d < bestD) { bestD = d; best = c }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true }
    }
    const sums = centres.map(() => new Array(dim).fill(0))
    const counts = centres.map(() => 0)
    for (let i = 0; i < points.length; i++) {
      counts[assign[i]]++
      const s = sums[assign[i]]
      for (let j = 0; j < dim; j++) s[j] += points[i][j]
    }
    for (let c = 0; c < centres.length; c++) {
      if (!counts[c]) continue
      for (let j = 0; j < dim; j++) centres[c][j] = sums[c][j] / counts[c]
    }
    if (!moved) break
  }

  // --- summarise each cluster from the REAL regions in it
  const archetypes: Archetype[] = []
  for (let c = 0; c < centres.length; c++) {
    const members = sigs.filter((_, i) => assign[i] === c)
    if (members.length < MIN_CLUSTER) continue
    const under = new Map<number, number>()
    const over = new Map<number, number>()
    const spec = new Map<SpeciesId, number>()
    let scenery = 0
    let walls = 0
    let flat = 0
    let relief = 0
    for (const m of members) {
      scenery += m.scenery
      walls += m.walls
      flat += m.flat
      relief += m.relief
      for (const [b, n] of Object.entries(m.underlay)) under.set(Number(b), (under.get(Number(b)) ?? 0) + n)
      for (const [b, n] of Object.entries(m.overlay)) over.set(Number(b), (over.get(Number(b)) ?? 0) + n)
      for (const [s, n] of Object.entries(m.species)) {
        spec.set(s as SpeciesId, (spec.get(s as SpeciesId) ?? 0) + (n as number))
      }
    }
    const regionTiles = members.length * REGION_TILES
    const underTotal = [...under.values()].reduce((a, b) => a + b, 0) || 1
    const overTotal = [...over.values()].reduce((a, b) => a + b, 0) || 1
    const specTotal = [...spec.values()].reduce((a, b) => a + b, 0) || 1
    archetypes.push({
      id: c,
      regions: members.length,
      examples: members.slice(0, 6).map((m) => m.region),
      regionIds: members.map((m) => m.region),
      ground: [...under.entries()].filter(([b]) => b !== 0)
        .sort((a, b) => b[1] - a[1]).slice(0, GROUND_KEEP)
        .map(([byte, n]) => ({ byte, share: n / underTotal })),
      overlays: [...over.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([byte, n]) => ({ byte, share: n / overTotal })),
      sceneryPer100: (scenery / regionTiles) * 100,
      wallsPer100: (walls / regionTiles) * 100,
      species: [...spec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([species, n]) => ({ species, share: n / specTotal })),
      flat: flat / members.length,
      relief: relief / members.length,
    })
  }
  archetypes.sort((a, b) => b.regions - a.regions)
  return { version: 2, fingerprint, builtAt: Date.now(), archetypes }
}

/** 0..1 position of `v` within the observed range of `all`. */
function norm(v: number, all: number[]): number {
  let lo = Infinity
  let hi = -Infinity
  for (const x of all) { if (x < lo) lo = x; if (x > hi) hi = x }
  if (!(hi > lo)) return 0
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
}

/** Where an archetype sits on the profile axes, relative to its siblings. */
export function profileOf(a: Archetype, all: Archetype[]): Profile {
  const share = (set: Set<string>) => a.species
    .filter((s) => set.has(s.species))
    .reduce((acc, s) => acc + s.share, 0)
  return {
    built: norm(Math.log1p(a.wallsPer100), all.map((x) => Math.log1p(x.wallsPer100))),
    greenery: share(GREEN_SPECIES),
    trees: share(TREE_SPECIES),
    relief: norm(a.relief, all.map((x) => x.relief)),
  }
}

/**
 * The archetype closest to what this area type means.
 *
 * `built` is weighted hardest because it is what most separates one kind of
 * place from another — a wood and a town differ far more in whether anyone
 * lives there than in how steep they are. `relief` is weighted lowest because
 * it is the least trustworthy axis (see `Profile.relief`).
 *
 * **This is the approximate, no-API-key path, and it is known to be imperfect.**
 * Checked against landmark regions, which the pipeline is never told about:
 * `village` correctly finds Draynor's cluster and `town` finds Ardougne's, but
 * the cluster holding Varrock, Falador AND Lumbridge is NOT what `town`
 * selects — it loses on the relief axis above. The clustering itself is sound
 * (those three landing together with no labels is the evidence); it is this
 * hand-written profile table that is the weak link, and it is the last piece
 * of guesswork left in the pipeline. The better route is to let a planner that
 * can read `describeArchetype` choose, which is what the digest is for.
 */
export function matchArchetype(model: ArchetypeModel | null, type: AreaType): Archetype | null {
  if (!model?.archetypes.length) return null
  const want = AREA_TYPE_PROFILES[type]
  const all = model.archetypes
  let best: Archetype | null = null
  let bestD = Infinity
  for (const a of all) {
    const p = profileOf(a, all)
    const d = 3 * (p.built - want.built) ** 2
      + 2 * (p.greenery - want.greenery) ** 2
      + 1.5 * (p.trees - want.trees) ** 2
      + 0.4 * (p.relief - want.relief) ** 2
    if (d < bestD) { bestD = d; best = a }
  }
  return best
}

/**
 * A one-line description of what an archetype actually is in this cache.
 * Used by the UI and by the digest handed to the planner — a plan author who
 * can see "town: 48% material 164, 3.1 walls/100" writes better plans than one
 * guessing at ids.
 */
/**
 * What this cache knows, as text a planner can read.
 *
 * This is the other half of §9a: a plan should stop deciding materials, AND the
 * thing authoring the plan should be told what the cache actually contains, so
 * an authored plan is informed rather than guessed. Deliberately compact —
 * it goes into a prompt, and a table of 2,413 regions would be useless there.
 *
 * Pair it with the ROLE vocabulary: between "here are the kinds of place this
 * cache has" and "here are the roles you can ask for", a planner never needs
 * to name an object id or an underlay id at all.
 */
export function describeMine(model: ArchetypeModel | null): string {
  if (!model?.archetypes.length) return 'No archetypes have been mined from this cache yet.'
  const all = model.archetypes
  const lines = [
    `This cache was mined into ${all.length} place types, clustered from its own regions.`,
    'Ground materials are underlay BYTES in this cache; you never need to name one —',
    'pick an area type and the generator takes the real palette from the map.',
    '',
    // These counts are EVERY plane-0 loc of shape 10/11/22, so they include
    // floor decoration and indoor clutter — which is why the "commonest" lists
    // below are full of benches, crates and barrels. They are 10-20x the
    // landscape-scenery density quoted earlier in this brief, and a planner that
    // read one as the other would ask for a density the sanitizer then caps.
    // Say so, rather than printing two numbers that share a word.
    'NOTE: `allLocs/100` below counts EVERY object on the ground — furniture,',
    'crates and floor decoration included, not just what grows. It runs 10-20x',
    'the landscape-scenery density quoted above and is NOT the number',
    '`scatter[].density` takes. Use it to judge how BUSY a place type is,',
    'and take scatter densities from the guidance above.',
    '',
  ]
  for (const a of all) {
    const p = profileOf(a, all)
    lines.push(
      `#${a.id}: ${a.regions} regions. built ${p.built.toFixed(2)}, greenery ${p.greenery.toFixed(2)},`
      + ` trees ${p.trees.toFixed(2)}, relief ${p.relief.toFixed(2)}.`
      + ` allLocs ${a.sceneryPer100.toFixed(2)}/100 tiles, walls ${a.wallsPer100.toFixed(2)}/100.`
      + ` commonest objects: ${a.species.slice(0, 5).map((s) => s.species).join(', ')}.`,
    )
  }
  lines.push('', 'Area types available, and the place type each currently resolves to:')
  for (const t of AREA_TYPES) {
    const a = matchArchetype(model, t)
    lines.push(`  ${t} -> #${a?.id ?? '-'}`)
  }
  return lines.join('\n')
}

export function describeArchetype(a: Archetype, all: Archetype[]): string {
  const p = profileOf(a, all)
  const ground = a.ground.slice(0, 3)
    .map((g) => `${g.byte}@${Math.round(g.share * 100)}%`).join(' ')
  const species = a.species.slice(0, 4).map((s) => s.species).join('/')
  return `${a.regions} regions | ground ${ground} | allLocs ${a.sceneryPer100.toFixed(2)}/100`
    + ` walls ${a.wallsPer100.toFixed(2)}/100 | built ${p.built.toFixed(2)} green ${p.greenery.toFixed(2)}`
    + ` trees ${p.trees.toFixed(2)} relief ${p.relief.toFixed(2)} | ${species}`
}
