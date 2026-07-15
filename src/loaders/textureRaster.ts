// Port of cryogen's TextureRaster: the per-dimension lookup tables every texture
// operation reads from. Values are 12-bit fixed point (4096 == 1.0).
//
// Java ints wrap at 32 bits and its `/` truncates toward zero; several ops rely on
// both (the noise hashes overflow deliberately). JS numbers do neither, so anything
// that can overflow goes through Math.imul / `| 0`, and integer division through
// `idiv`. Getting this wrong produces subtly wrong pixels rather than an error.

export type Raster = {
  width: number
  height: number
  /** width - 1 and height - 1; ops use these as wrap masks */
  rowEnd: number
  columnEnd: number
  scaledWidth: number
  horizontal: Int32Array
  vertical: Int32Array
}

/** Java's integer division: truncates toward zero, not toward -Infinity. */
export function idiv(a: number, b: number): number {
  return (a / b) | 0
}

export function makeRaster(width: number, height: number): Raster {
  const horizontal = new Int32Array(width)
  for (let i = 0; i < width; i++) horizontal[i] = idiv(i << 12, width)

  let vertical: Int32Array
  if (width === height) {
    vertical = horizontal
  } else {
    vertical = new Int32Array(height)
    for (let i = 0; i < height; i++) vertical[i] = idiv(i << 12, height)
  }

  return {
    width,
    height,
    rowEnd: width - 1,
    columnEnd: height - 1,
    scaledWidth: width * 32,
    horizontal,
    vertical,
  }
}

// 256-entry sine/cosine palettes over a full turn, in 12-bit fixed point.
export const PALETTE_SIN = new Int32Array(256)
export const PALETTE_COS = new Int32Array(256)
for (let i = 0; i < 256; i++) {
  const angle = 6.283185307179586 * (i / 255.0)
  PALETTE_SIN[i] = Math.trunc(Math.sin(angle) * 4096.0)
  PALETTE_COS[i] = Math.trunc(Math.cos(angle) * 4096.0)
}

// java.util.Random, needed because several ops seed it and the exact sequence is
// part of the texture (brick jitter, noise permutations). A faithful LCG port.
const MULTIPLIER = 0x5deece66dn
const ADDEND = 0xbn
const MASK = (1n << 48n) - 1n

export class JavaRandom {
  private seed: bigint

  constructor(seed: number) {
    this.seed = (BigInt(seed) ^ MULTIPLIER) & MASK
  }

  private next(bits: number): number {
    this.seed = (this.seed * MULTIPLIER + ADDEND) & MASK
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }

  /** Random.nextInt() — the raw signed 32-bit draw. */
  nextInt(): number {
    return this.next(32)
  }
}

/**
 * cryogen TextureOpBricks.boundedRandom. NOT Random.nextInt(bound): it draws the
 * raw 32-bit value and maps it itself, so the sequence differs from Java's own
 * bounded nextInt and the textures depend on this exact one.
 *
 * The non-power-of-two path's rejection threshold is `Integer.MIN_VALUE - k`,
 * which UNDERFLOWS to a large positive int in Java — `| 0` reproduces that wrap.
 */
export function boundedRandom(random: JavaRandom, bound: number): number {
  if (bound <= 0) return 0

  // power of two: take the high 32 bits of (unsigned draw * bound)
  if (bound === (bound & -bound)) {
    const draw = random.nextInt() >>> 0
    return Number((BigInt(draw) * BigInt(bound)) >> 32n)
  }

  const limit = (-2147483648 - Number(4294967296n % BigInt(bound))) | 0
  let draw: number
  do {
    draw = random.nextInt()
  } while (draw >= limit)

  // cryogen method5360: a branchless positive modulo
  const adjust = (draw >> 31) & (bound - 1)
  return ((draw + (draw >>> 31)) % bound) + adjust
}

/**
 * cryogen TextureRaster.generateRandomlySeededByteArray — a 512-byte permutation
 * table, mirrored in its second half, used by the noise ops.
 */
export function seededByteArray(seed: number): Int8Array {
  const bytes = new Int8Array(512)
  const random = new JavaRandom(seed)
  for (let i = 0; i < 255; i++) bytes[i] = i

  for (let i = 0; i < 255; i++) {
    const target = 255 - i
    const swap = boundedRandom(random, target)
    const held = bytes[swap]
    bytes[swap] = bytes[target]
    bytes[target] = held
    bytes[511 - i] = held
  }
  return bytes
}

const seededCache = new Map<number, Int8Array>()

export function seededByteArrayCached(seed: number): Int8Array {
  let bytes = seededCache.get(seed)
  if (!bytes) {
    bytes = seededByteArray(seed)
    seededCache.set(seed, bytes)
  }
  return bytes
}
