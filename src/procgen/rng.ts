/**
 * Seeded randomness and value noise for the generator.
 *
 * Everything here is deterministic and dependency-free: the same seed produces
 * the same landscape on any machine, which is the whole premise of the plan
 * (re-running a plan must not quietly produce a different place).
 *
 * Value noise rather than simplex — it is a fraction of the code, has no
 * patent/attribution baggage, and once domain-warped and octaved it is
 * indistinguishable for terrain at this scale.
 */

/** mulberry32 — small, fast, good enough for placement decisions. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic hash of a 2D lattice point, in [0,1). */
function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Value noise in [-1,1]. */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = fade(xf)
  const v = fade(yf)
  const n00 = hash2(seed, xi, yi)
  const n10 = hash2(seed, xi + 1, yi)
  const n01 = hash2(seed, xi, yi + 1)
  const n11 = hash2(seed, xi + 1, yi + 1)
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 2 - 1
}

export type FbmOptions = {
  octaves?: number
  /** amplitude falloff per octave */
  gain?: number
  /** frequency growth per octave */
  lacunarity?: number
  /** ridged noise folds the signal, producing crests instead of blobs */
  ridged?: boolean
}

/** Fractal noise in roughly [-1,1] (ridged: [0,1]). */
export function fbm(seed: number, x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 4
  const gain = opts.gain ?? 0.5
  const lac = opts.lacunarity ?? 2
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    let n = noise2(seed + o * 1013, x * freq, y * freq)
    if (opts.ridged) n = 1 - Math.abs(n)
    sum += n * amp
    norm += amp
    amp *= gain
    freq *= lac
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Domain-warped fbm. Warping is what stops terrain looking like noise: it
 * bends the field along itself, giving valleys that meander instead of
 * radiating from a grid.
 */
export function warpedFbm(
  seed: number,
  x: number,
  y: number,
  warp: number,
  opts: FbmOptions = {},
): number {
  if (warp <= 0) return fbm(seed, x, y, opts)
  const wx = fbm(seed + 7717, x, y, { octaves: 2 })
  const wy = fbm(seed + 3313, x + 5.2, y + 1.3, { octaves: 2 })
  return fbm(seed, x + wx * warp, y + wy * warp, opts)
}

/** Smooth 0→1 ramp between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Weighted pick; weights default to 1. Returns null for an empty list. */
export function pickWeighted<T extends { weight?: number }>(list: T[], rnd: () => number): T | null {
  if (!list.length) return null
  let total = 0
  for (const item of list) total += item.weight ?? 1
  if (total <= 0) return list[0]
  let r = rnd() * total
  for (const item of list) {
    r -= item.weight ?? 1
    if (r <= 0) return item
  }
  return list[list.length - 1]
}
