/**
 * The context model: what the real map plants WHERE.
 *
 * The frequency prior in `scenery.ts` answers "does the game use this object at
 * all". It cannot answer "does the game use it *here*", which is why a global
 * count put jungle grass on 77% of every tuft in the world and an indoor potted
 * plant on an open hillside. Those were patched with hand-written filters; this
 * replaces the guesswork with measurement.
 *
 * Shape: per-object histograms of the CONTEXT each placement sat in, plus the
 * frequency prior, combined at generation time as naive Bayes:
 *
 *     weight(object) = outdoorUses(object) x  P(bin_f | object)
 *
 * Storing P(context | object) as marginals keeps it small and dense. Storing
 * P(object | context) directly would need a row per context combination, and
 * with ~75k plane-0 placements spread over ~2.7k objects (about 28 examples
 * each) almost every row would be empty.
 *
 * Measured worth, over the whole map (see `docs/map-learning.md` §12) — mutual
 * information with object identity, and held-out accuracy of the combined model:
 *
 *   underlay 34.5% | overlay 19.4% | height 14.1% | slope 11.0% | wall 5.9%
 *   frequency alone: 11.5% top-1 / 21.4% top-5
 *   + context:       27.9% top-1 / 55.5% top-5
 *
 * A raw count of neighbouring locs measured 1.2% and is deliberately absent —
 * it would have to be by object CLASS to carry anything.
 */

/** Everything the model conditions on, in the units the cache itself stores. */
export type TileContext = {
  /** material byte (definition id + 1), exactly as `underlayIds` stores it */
  underlay: number
  /** material byte, 0 = no overlay */
  overlay: number
  /** stored-unit slope: biggest height step to a 4-neighbour */
  slope: number
  /** stored height byte */
  height: number
  /** 0 = wall within 1 tile, 1 = within 2, 2 = further */
  wall: number
}

export const FEATURES = ['underlay', 'overlay', 'slope', 'height', 'wall'] as const
export type FeatureId = (typeof FEATURES)[number]

/**
 * Bucket a context into the bins the model counts.
 *
 * This function is the CONTRACT between the scan and the generator: both must
 * bucket identically or the histograms describe one world and are queried about
 * another. Keep it the single source of truth — never inline an equivalent.
 */
export function binOf(feature: FeatureId, ctx: TileContext): number {
  switch (feature) {
    case 'underlay': return ctx.underlay & 0xff
    case 'overlay': return ctx.overlay & 0xff
    // percentile-ish steps: the real map is mostly flat, so the interesting
    // resolution is all at the bottom (42% of tiles are dead level)
    case 'slope': return ctx.slope === 0 ? 0 : ctx.slope <= 2 ? 1 : ctx.slope <= 5 ? 2 : ctx.slope <= 10 ? 3 : 4
    case 'height': return Math.min(9, Math.max(0, ctx.height) >> 3)
    case 'wall': return ctx.wall
  }
}

/**
 * How hard to temper the naive-Bayes product: the likelihood is `p^(1/T)`.
 *
 * T = 1 is the raw product — the correct posterior IF the five features were
 * independent. They are not (underlay, overlay, height and slope all move
 * together), so the product counts the same evidence several times over and is
 * overconfident. T is the correction for that redundancy, and it is MEASURED
 * rather than reasoned about.
 *
 * ## The measurement (2026-08-07, whole dump, `docs/map-learning.md` §12a)
 *
 * For each common ground material, compare the species mix we would plant on it
 * against the mix the real map actually has there, as total variation distance
 * — "what share of the mix is in the wrong place". Summed over canopy,
 * undergrowth and loose_stone:
 *
 *   T:      1      1.25    1.5     2       3       5
 *   TVD:    0.572  0.579   0.600   0.669   0.771   0.875
 *
 * **T = 5 — the geometric mean, which is what this used to be — is the WORST
 * of every value tried**, and it is worst by a wide margin. It diluted the one
 * feature that carries most of the signal (underlay, 34.5% of object identity)
 * to a fifth of its weight, so a jungle tree scored nearly as well on a
 * snowfield as an ordinary one. Measured directly: at T = 5 tropical trees were
 * 16-27% of the canopy on EVERY material, and jungle plants were the majority
 * of the undergrowth everywhere. That is the §11 biome-conflation trap
 * reappearing through the very mechanism meant to close it.
 *
 * ## Why the geometric mean was there, and why that reason did not hold
 *
 * §12 justified it as the cure for monoculture: "the best candidate took
 * 99-100% of the weight on every kind of ground". Re-measured, that is mostly
 * the FREQUENCY PRIOR, not the context product — `tree_oak` gives its top
 * variant 85% and `grass_tuft` 91% even at T = 5, because one variant genuinely
 * dominates real usage. What T actually costs is variant spread within a
 * species, and the cost is modest: `tree` runs 5.96 effective variants at T = 5
 * and 4.18 at T = 1.
 *
 * ## Why 1.5 rather than 1
 *
 * The optimum is flat between 1 and 1.5 (0.572 vs 0.600 combined), and 1.5 is
 * the best single value for `canopy` — the most visually dominant layer —
 * at 0.112 against 0.148 at T = 1, while keeping more variant spread (4.47
 * effective `tree` variants). Re-run the calibration if the feature set
 * changes: adding correlated features should raise T, adding independent ones
 * should lower it.
 */
export const CONTEXT_TEMPER = 1.5

export type ObjectContext = {
  /** plane-0 placements seen, i.e. the sample size behind these histograms */
  n: number
  /** feature → bin → how many of this object's placements sat in that bin */
  f: Partial<Record<FeatureId, Record<number, number>>>
}

export type ContextModel = {
  version: 3
  builtAt: number
  /** cache fingerprint, so a model is never used against another dump */
  fingerprint: string
  objects: Record<number, ObjectContext>
  /** feature → distinct bins observed, the Laplace denominator */
  bins: Partial<Record<FeatureId, number>>
}

export function emptyModel(fingerprint: string): ContextModel {
  return { version: 3, builtAt: Date.now(), fingerprint, objects: {}, bins: {} }
}

/** Record one real placement. Called once per candidate loc during the scan. */
export function observe(model: ContextModel, id: number, ctx: TileContext) {
  let o = model.objects[id]
  if (!o) model.objects[id] = (o = { n: 0, f: {} })
  o.n++
  for (const feature of FEATURES) {
    const bin = binOf(feature, ctx)
    const hist = o.f[feature] ?? (o.f[feature] = {})
    hist[bin] = (hist[bin] ?? 0) + 1
  }
}

/** Count distinct bins per feature; the denominator for Laplace smoothing. */
export function finalise(model: ContextModel) {
  for (const feature of FEATURES) {
    const seen = new Set<number>()
    for (const o of Object.values(model.objects)) {
      for (const k of Object.keys(o.f[feature] ?? {})) seen.add(Number(k))
    }
    model.bins[feature] = Math.max(1, seen.size)
  }
}

/**
 * How well this object fits this context, as a plain likelihood in 0..1.
 *
 * Laplace-smoothed so an unseen bin costs a lot without being fatal — a species
 * the plan explicitly asked for must still be placeable somewhere, even on
 * ground the real map never used it on.
 *
 * An object the model has never seen backs off to the SAME formula with n = 0,
 * i.e. `1/bins` per feature. It used to return 1, which was harmless while this
 * only ever ranked variants of one species — if every candidate was unseen they
 * all scored 1 and the frequency prior decided. Once candidates are scored
 * across species (`chooseScenery`), 1 is the maximum any object can score, so
 * "we know nothing about this" would outrank every well-fitted object in the
 * cache. The n = 0 backoff is the honest reading of the same smoothing: no
 * evidence lands mid-table, beating a proven-wrong fit and losing to a proven
 * right one.
 */
export function contextLikelihood(model: ContextModel | null, id: number, ctx: TileContext): number {
  if (!model) return 1
  const o = model.objects[id]
  let p = 1
  if (!o || o.n <= 0) {
    for (const feature of FEATURES) p *= 1 / (model.bins[feature] ?? 1)
    return Math.pow(p, 1 / CONTEXT_TEMPER)
  }
  for (const feature of FEATURES) {
    const bins = model.bins[feature] ?? 1
    const hist = o.f[feature]
    const seen = hist?.[binOf(feature, ctx)] ?? 0
    p *= (seen + 1) / (o.n + bins)
  }
  return Math.pow(p, 1 / CONTEXT_TEMPER)
}

/**
 * Has the real map ever placed this object on this GROUND MATERIAL?
 *
 * Plain evidence, deliberately not a probability. Two smoothed scorers were
 * tried against the "Ice covered boulder on a temperate shore" case and both
 * failed for the same root reason, which is worth recording so it is not tried
 * a third time:
 *
 * - **Laplace-to-uniform** (`(seen + 1) / (n + bins)`) *rewards* being poorly
 *   observed. With ~200 underlay bins an object with 9 placements scores
 *   `1/209` on ground it has never been seen on, while one with 336 placements
 *   scores `1/536` — the rarer object wins by 2.5x for knowing less.
 * - **Ratio to the object's own peak bin** does not separate them either: with
 *   9 observations the peak bin holds maybe 5, so an unseen bin still scores
 *   1/6. Measured, the ice boulders came out at affinity 0.41-0.45 against a
 *   legitimate boulder's 0.37-0.53 — overlapping, so no threshold exists.
 *
 * The information simply is not recoverable from 9 observations by any ratio.
 * What IS recoverable is the categorical fact: object 5037's nine placements are
 * on bytes 58 and 26, both snow. It has never been on grass, sand or town earth.
 * Underlay is the dominant signal (34.5% of object identity, §12), so "the map
 * has never put this here" is the strongest honest statement available, and it
 * is exactly what "rocks from similar areas" means.
 */
export function seenOnGround(model: ContextModel | null, id: number, ctx: TileContext): number {
  if (!model) return 1
  return model.objects[id]?.f.underlay?.[binOf('underlay', ctx)] ?? 0
}

/**
 * How many sightings on a material it takes to call it habitat rather than
 * accident.
 *
 * One is not enough, measured. Object 41582 is a snow-covered rock whose
 * underlay histogram is `26:21  58:4  27:1  163:1` — twenty-five of its
 * twenty-seven placements are on the two snow bytes, and a SINGLE stray on town
 * earth was enough to clear a `> 0` gate and put it on a lush green shore.
 *
 * Two separates it from every legitimate candidate with room to spare: on the
 * ground they are kept for, Boulder 19205 has 5, Rubble 2509 has 3, Boulder 445
 * has 2, Rock 441 has 7, Rock 442 has 4, Granite rocks 10947 has 5. A single
 * sighting is one region's accident; two is a pattern.
 */
export const MIN_GROUND_SIGHTINGS = 2
