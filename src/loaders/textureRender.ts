// A TypeScript port of cryogen's material renderer, so the editor can preview a
// texture live instead of waiting for a repack + re-dump.
//
// This mirrors the client's structure deliberately: every node owns an LRU cache of
// recently-produced ROWS (sized by `imageCacheCapacity`), and the graph is walked one
// row at a time. It is tempting to evaluate each node's full output once instead —
// simpler and faster — but that produces different pixels. A node hands out a
// reference to a cached row, and a later request to the same node can hand back the
// same buffer and overwrite it. getPixelsArgb takes the colour row first and the
// opacity row second, so the opacity chain routinely clobbers the colour row it is
// still holding. That aliasing is visible in the shipped textures, so it has to be
// reproduced. See textureCaches.ts.
//
// Everything is 12-bit fixed point (4096 == 1.0) and must reproduce Java's integer
// semantics: `>>` on negatives, truncating division (`idiv`), and 32-bit wraparound
// on the multiplications the noise hashes rely on.

import type { MaterialDefinition, TextureOperation } from './textures'
import { ColorImageCache, MonochromeImageCache } from './textureCaches'
import { rasterizeShapes } from './textureShapes'
import type { RasterShape } from './textureShapes'
import { JavaRandom, PALETTE_COS, PALETTE_SIN, boundedRandom, idiv, makeRaster, seededByteArrayCached } from './textureRaster'
import type { Raster } from './textureRaster'

export type Color = [Int32Array, Int32Array, Int32Array]

export type RenderDeps = {
  sprite: (id: number) => { pixels: Int32Array; width: number; height: number } | null
  material: (id: number) => { pixels: Int32Array; width: number; height: number } | null
}

const num = (op: TextureOperation, key: string, fallback = 0): number => {
  const v = op[key]
  return typeof v === 'number' ? v : fallback
}
const bool = (op: TextureOperation, key: string, fallback = false): boolean => {
  const v = op[key]
  return typeof v === 'boolean' ? v : fallback
}

type RowOp = {
  mono?: (c: Ctx, i: number, op: TextureOperation, y: number, out: Int32Array) => void
  color?: (c: Ctx, i: number, op: TextureOperation, y: number, out: Color) => void
}

const OPS: Record<number, RowOp> = {}

class Ctx {
  readonly ops: TextureOperation[]
  readonly edges: number[][]
  readonly monoCaches: (MonochromeImageCache | null)[]
  readonly colorCaches: (ColorImageCache | null)[]
  private readonly prepared = new Map<number, unknown>()

  readonly raster: Raster
  readonly deps: RenderDeps

  constructor(material: MaterialDefinition, raster: Raster, deps: RenderDeps) {
    this.raster = raster
    this.deps = deps
    this.ops = material.textureOperations ?? []
    this.edges = material.operationIndices ?? []
    this.monoCaches = new Array(this.ops.length).fill(null)
    this.colorCaches = new Array(this.ops.length).fill(null)

    // TextureOperation.createImageCache
    const { width, height } = raster
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i]
      const capacity = op.imageCacheCapacity === 255 ? height : op.imageCacheCapacity
      if (op.monochrome) this.monoCaches[i] = new MonochromeImageCache(capacity, height, width)
      else this.colorCaches[i] = new ColorImageCache(capacity, height, width)
    }
  }

  /** Per-op derived state (curve lookups, light vectors, noise tables), built once. */
  prep<T>(index: number, build: () => T): T {
    let value = this.prepared.get(index) as T | undefined
    if (value === undefined) {
      value = build()
      this.prepared.set(index, value)
    }
    return value
  }

  child(index: number, slot: number): number {
    const target = this.edges[index]?.[slot]
    if (target == null || target < 0 || target >= this.ops.length) {
      throw new Error(`node #${index} input ${slot} is not wired to a valid node`)
    }
    return target
  }

  childMono(index: number, slot: number, y: number): Int32Array {
    return this.mono(this.child(index, slot), y)
  }

  childColor(index: number, slot: number, y: number): Color {
    return this.color(this.child(index, slot), y)
  }

  mono(index: number, y: number): Int32Array {
    const op = this.ops[index]
    if (!op.monochrome) return this.color(index, y)[0]

    const cache = this.monoCaches[index]!
    const out = cache.getPalette(y)
    if (cache.dirty) {
      const impl = OPS[op.type]?.mono
      if (!impl) throw new Error(`op type ${op.type} has no monochrome evaluator`)
      impl(this, index, op, y, out)
    }
    return out
  }

  color(index: number, y: number): Color {
    const op = this.ops[index]
    if (op.monochrome) {
      const single = this.mono(index, y)
      return [single, single, single]
    }

    const cache = this.colorCaches[index]!
    const out = cache.getPalette(y)
    if (cache.dirty) {
      const impl = OPS[op.type]?.color
      if (!impl) throw new Error(`op type ${op.type} has no colour evaluator`)
      impl(this, index, op, y, out)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// 0: Monochrome Fill
OPS[0] = {
  mono: (c, _i, op, _y, out) => out.fill(num(op, 'fillValue', 4096), 0, c.raster.width),
}

// 1: Colour Fill — the cache stores a packed colour; the channels unpack from it.
OPS[1] = {
  color: (c, i, op, _y, out) => {
    const [r, g, b] = c.prep(i, () => {
      const packed = num(op, 'value')
      return [(packed & 0xff0000) >> 12, (packed & 0xff00) >> 4, (packed & 0xff) << 4]
    })
    out[0].fill(r, 0, c.raster.width)
    out[1].fill(g, 0, c.raster.width)
    out[2].fill(b, 0, c.raster.width)
  },
}

// 2 / 3: gradients
OPS[2] = { mono: (c, _i, _op, _y, out) => out.set(c.raster.horizontal) }
OPS[3] = { mono: (c, _i, _op, y, out) => out.fill(c.raster.vertical[y], 0, c.raster.width) }

// 5: Box Blur — running sums, wrapping on both axes.
function boxBlurRow(src: Int32Array, rx: number, scaleX: number, rowEnd: number, width: number, dst: Int32Array) {
  let sum = 0
  for (let x = -rx; x <= rx; x++) sum += src[x & rowEnd]
  for (let x = 0; x < width; x++) {
    dst[x] = (sum * scaleX) >> 16
    sum -= src[(x - rx) & rowEnd]
    sum += src[(x + 1 + rx) & rowEnd]
  }
}

OPS[5] = {
  mono: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const rx = num(op, 'radiusX', 1)
    const ry = num(op, 'radiusY', 1)
    const spanY = ry + ry + 1
    const scaleY = idiv(65536, spanY)
    const scaleX = idiv(65536, rx + rx + 1)

    const band: Int32Array[] = []
    for (let k = y - ry; k <= y + ry; k++) {
      const row = new Int32Array(width)
      boxBlurRow(c.childMono(i, 0, k & columnEnd), rx, scaleX, rowEnd, width, row)
      band.push(row)
    }
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = 0; k < spanY; k++) sum += band[k][x]
      out[x] = (sum * scaleY) >> 16
    }
  },
  color: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const rx = num(op, 'radiusX', 1)
    const ry = num(op, 'radiusY', 1)
    const spanY = ry + ry + 1
    const scaleY = idiv(65536, spanY)
    const scaleX = idiv(65536, rx + rx + 1)

    const band: Color[] = []
    for (let k = y - ry; k <= y + ry; k++) {
      const src = c.childColor(i, 0, k & columnEnd)
      const row: Color = [new Int32Array(width), new Int32Array(width), new Int32Array(width)]
      for (let ch = 0; ch < 3; ch++) boxBlurRow(src[ch], rx, scaleX, rowEnd, width, row[ch])
      band.push(row)
    }
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0
        for (let k = 0; k < spanY; k++) sum += band[k][ch][x]
        out[ch][x] = (sum * scaleY) >> 16
      }
    }
  },
}

// 6: Clamp
OPS[6] = {
  mono: (c, i, op, y, out) => {
    const min = num(op, 'minValue')
    const max = num(op, 'maxValue', 4096)
    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = src[x] < min ? min : Math.min(src[x], max)
  },
  color: (c, i, op, y, out) => {
    const min = num(op, 'minValue')
    const max = num(op, 'maxValue', 4096)
    const src = c.childColor(i, 0, y)
    for (let ch = 0; ch < 3; ch++) {
      for (let x = 0; x < c.raster.width; x++) {
        const v = src[ch][x]
        out[ch][x] = v < min ? min : Math.min(v, max)
      }
    }
  },
}

// 7: Combine
function blend(mode: number, a: number, b: number): number {
  switch (mode) {
    case 1: return b + a
    case 2: return a - b
    case 3: return (a * b) >> 12
    case 4: return b !== 0 ? idiv(a << 12, b) : 4096
    case 5: return 4096 - (((4096 - a) * (4096 - b)) >> 12)
    case 6: return b < 2048 ? (b * a) >> 11 : 4096 - (((4096 - a) * (4096 - b)) >> 11)
    case 7: return a === 4096 ? 4096 : idiv(b << 12, 4096 - a)
    case 8: return a === 0 ? 0 : 4096 - idiv((4096 - b) << 12, a)
    case 9: return Math.min(a, b)
    case 10: return Math.max(a, b)
    case 11: return a > b ? a - b : b - a
    case 12: return b + a - ((a * b) >> 11)
    default: return 0
  }
}

OPS[7] = {
  mono: (c, i, op, y, out) => {
    const mode = num(op, 'blendMode', 6)
    const a = c.childMono(i, 0, y)
    const b = c.childMono(i, 1, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = blend(mode, a[x], b[x])
  },
  color: (c, i, op, y, out) => {
    const mode = num(op, 'blendMode', 6)
    const a = c.childColor(i, 0, y)
    const b = c.childColor(i, 1, y)
    for (let ch = 0; ch < 3; ch++) {
      for (let x = 0; x < c.raster.width; x++) out[ch][x] = blend(mode, a[ch][x], b[ch][x])
    }
  },
}

// 8: Curve — remaps its input through a 257-entry lookup.
OPS[8] = {
  mono: (c, i, op, y, out) => {
    const lookup = c.prep(i, () => {
      const points = (op.controlPoints as number[][]) ?? [[0, 0], [4096, 4096]]
      const mode = num(op, 'interpolationMode')

      const first = points[0]
      const second = points[1]
      const penult = points[points.length - 2]
      const last = points[points.length - 1]
      const start = [first[0] - second[0] + first[0], first[1] - second[1] + first[1]]
      const end = [penult[0] - last[0] + penult[0], penult[1] - last[1] + penult[1]]
      const at = (k: number) => (k < 0 ? start : k >= points.length ? end : points[k])
      const clampShort = (v: number) => (v <= -32768 ? -32767 : v >= 32768 ? 32767 : v)

      const table = new Int32Array(257)
      for (let k = 0; k < 257; k++) {
        const input = k << 4
        let seg = 1
        while (seg < points.length - 1 && points[seg][0] <= input) seg++
        const a = points[seg - 1]
        const b = points[seg]
        const t = idiv((input - a[0]) << 12, b[0] - a[0])

        if (mode === 1) {
          const eased = (4096 - PALETTE_COS[(t >> 5) & 0xff]) >> 1
          table[k] = clampShort((eased * b[1] + (4096 - eased) * a[1]) >> 12)
        } else if (mode === 2) {
          const p0 = at(seg - 2)[1]
          const p1 = a[1]
          const p2 = b[1]
          const p3 = at(seg + 1)[1]
          const t2 = (t * t) >> 12
          const c3 = p1 + (p3 - p2 - p0)
          const c2 = p0 - p1 - c3
          const c1 = p2 - p0
          table[k] = clampShort(((t2 * ((c3 * t) >> 12)) >> 12) + ((c2 * t2) >> 12) + ((t * c1) >> 12) + p1)
        } else {
          table[k] = clampShort((t * b[1] + (4096 - t) * a[1]) >> 12)
        }
      }
      return table
    })

    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) {
      let k = src[x] >> 4
      if (k < 0) k = 0
      if (k > 256) k = 256
      out[x] = lookup[k]
    }
  },
}

// 9: Flip
OPS[9] = {
  mono: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const flipH = bool(op, 'mirrorHorizontally', true)
    const flipV = bool(op, 'mirrorVertically', true)
    const src = c.childMono(i, 0, flipV ? columnEnd - y : y)
    for (let x = 0; x < width; x++) out[x] = src[flipH ? rowEnd - x : x]
  },
  color: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const flipH = bool(op, 'mirrorHorizontally', true)
    const flipV = bool(op, 'mirrorVertically', true)
    const src = c.childColor(i, 0, flipV ? columnEnd - y : y)
    for (let x = 0; x < width; x++) {
      const sx = flipH ? rowEnd - x : x
      out[0][x] = src[0][sx]
      out[1][x] = src[1][sx]
      out[2][x] = src[2][sx]
    }
  },
}

// 10: Colour Gradient. A non-zero presetId means the client REBUILDS the stops from
// its own table and ignores any stored ones.
export const GRADIENT_PRESETS: Record<number, number[][]> = {
  1: [[0, 0, 0, 0], [4096, 4096, 4096, 4096]],
  2: [[0, 2650, 2602, 2361], [2867, 2313, 1799, 1558], [3072, 2618, 1734, 1413], [3276, 2296, 1220, 947], [3481, 2072, 963, 722], [3686, 2730, 2152, 1766], [3891, 2232, 1060, 915], [4096, 1686, 1413, 1140]],
  3: [[0, 0, 0, 4096], [663, 0, 4096, 4096], [1363, 0, 4096, 0], [2048, 4096, 4096, 0], [2727, 4096, 0, 0], [3411, 4096, 0, 4096], [4096, 0, 0, 4096]],
  4: [[0, 0, 0, 0], [1843, 0, 0, 1493], [2457, 0, 0, 2939], [2781, 0, 1124, 3565], [3481, 546, 3084, 4031], [4096, 4096, 4096, 4096]],
  5: [[0, 80, 192, 321], [155, 321, 449, 562], [389, 578, 690, 803], [671, 947, 995, 1140], [897, 1285, 1397, 1509], [1175, 1525, 1429, 1413], [1368, 1734, 1461, 1333], [1507, 1413, 1525, 1702], [1736, 1108, 1590, 2056], [2088, 1766, 2056, 2666], [2355, 2409, 2586, 3276], [2691, 3116, 3148, 3228], [3031, 3806, 3710, 3196], [3522, 3437, 3421, 3019], [3727, 3116, 3148, 3228], [4096, 2377, 2505, 2746]],
  6: [[2048, 0, 4096, 0], [2867, 4096, 4096, 0], [3276, 4096, 4096, 0], [4096, 4096, 0, 0]],
}

OPS[10] = {
  color: (c, i, op, y, out) => {
    const lookup = c.prep(i, () => {
      const presetId = num(op, 'presetId')
      const stops = presetId !== 0
        ? (GRADIENT_PRESETS[presetId] ?? GRADIENT_PRESETS[1])
        : ((op.colorStops as number[][]) ?? GRADIENT_PRESETS[1])

      const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
      const table = new Int32Array(257)
      if (!stops.length) return table

      for (let k = 0; k < 257; k++) {
        const input = k << 4
        let seg = 0
        while (seg < stops.length && input >= stops[seg][0]) seg++

        let r: number
        let g: number
        let b: number
        if (seg < stops.length) {
          const to = stops[seg]
          if (seg > 0) {
            const from = stops[seg - 1]
            const t = idiv((input - from[0]) << 12, to[0] - from[0])
            const inv = 4096 - t
            r = (t * to[1] + inv * from[1]) >> 12
            g = (t * to[2] + inv * from[2]) >> 12
            b = (t * to[3] + inv * from[3]) >> 12
          } else {
            r = to[1]; g = to[2]; b = to[3]
          }
        } else {
          const to = stops[stops.length - 1]
          r = to[1]; g = to[2]; b = to[3]
        }
        table[k] = (clamp255(r >> 4) << 16) | (clamp255(g >> 4) << 8) | clamp255(b >> 4)
      }
      return table
    })

    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) {
      let k = src[x] >> 4
      if (k < 0) k = 0
      if (k > 256) k = 256
      const rgb = lookup[k]
      out[0][x] = (rgb & 0xff0000) >> 12
      out[1][x] = (rgb & 0xff00) >> 4
      out[2][x] = (rgb & 0xff) << 4
    }
  },
}

// 11: Colourize — tints greys, passes the multiplier through for coloured input.
OPS[11] = {
  color: (c, i, op, y, out) => {
    const red = num(op, 'redMultiplier', 4096)
    const green = num(op, 'greenMultiplier', 4096)
    const blue = num(op, 'blueMultiplier', 4096)
    const src = c.childColor(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) {
      const r = src[0][x]
      const b = src[2][x]
      const g = src[1][x]
      if (r === b && g === b) {
        out[0][x] = (r * red) >> 12
        out[1][x] = (b * green) >> 12
        out[2][x] = (g * blue) >> 12
      } else {
        out[0][x] = red
        out[1][x] = green
        out[2][x] = blue
      }
    }
  },
}

// 12: Waveform
OPS[12] = {
  mono: (c, _i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const waveType = num(op, 'waveType')
    const waveShape = num(op, 'waveShape')
    const frequency = num(op, 'frequency', 1)

    const vy = vertical[y]
    const dy = (vy - 2048) >> 1
    for (let x = 0; x < width; x++) {
      const hx = horizontal[x]
      const dx = (hx - 2048) >> 1
      let v: number
      if (waveType === 0) {
        v = (hx - vy) * frequency
      } else {
        const dist = (dy * dy + dx * dx) >> 12
        v = Math.trunc(Math.sqrt(Math.fround(dist / 4096.0)) * 4096.0)
        v = Math.trunc(v * frequency * Math.PI)
      }
      v -= v & -4096
      if (waveShape === 0) v = (PALETTE_SIN[(v >> 4) & 0xff] + 4096) >> 1
      else if (waveShape === 2) {
        v -= 2048
        if (v < 0) v = -v
        v = (2048 - v) << 1
      }
      out[x] = v
    }
  },
}

// 13: Noise — a hash that relies on 32-bit overflow, hence Math.imul.
function hashNoise(x: number, y: number): number {
  let h = (Math.imul(y, 57) + x) | 0
  h ^= h << 1
  const scrambled = (Math.imul(Math.imul(Math.imul(h, h), 15731) + 789221, h) + 1376312589) | 0
  return 4096 - idiv(scrambled & 0x7fffffff, 262144)
}

OPS[13] = {
  mono: (c, _i, _op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const vy = vertical[y]
    for (let x = 0; x < width; x++) out[x] = hashNoise(horizontal[x], vy) % 4096
  },
}

// 14: Weave
OPS[14] = {
  mono: (c, _i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const thread = num(op, 'threadWidth', 585)
    const vy = vertical[y]
    for (let x = 0; x < width; x++) {
      const hx = horizontal[x]
      let v: number
      if (hx > thread && hx < 4096 - thread && vy > 2048 - thread && vy < thread + 2048) {
        v = 2048 - hx
        if (v < 0) v = -v
        out[x] = 4096 - idiv(v << 12, 2048 - thread)
      } else if (hx > 2048 - thread && hx < thread + 2048) {
        v = vy - 2048
        if (v < 0) v = -v
        v -= thread
        out[x] = idiv(v << 12, 2048 - thread)
      } else if (vy >= thread && vy <= 4096 - thread) {
        if (hx >= thread && hx <= 4096 - thread) out[x] = 0
        else {
          v = 2048 - vy
          if (v < 0) v = -v
          out[x] = 4096 - idiv(v << 12, 2048 - thread)
        }
      } else {
        v = hx - 2048
        if (v < 0) v = -v
        v -= thread
        out[x] = idiv(v << 12, 2048 - thread)
      }
    }
  },
}

// 15: Voronoi Noise
OPS[15] = {
  mono: (c, i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const cellsX = num(op, 'cellCountX', 5)
    const cellsY = num(op, 'cellCountY', 5)
    const metric = num(op, 'distanceMetric', 1)
    const mode = num(op, 'distanceOutputMode', 2)

    const { perm, points } = c.prep(i, () => {
      const seed = num(op, 'randomSeed')
      const jitter = num(op, 'pointJitter', 2048)
      const table = seededByteArrayCached(seed)
      const pts = new Int16Array(512)
      if (jitter > 0) {
        const random = new JavaRandom(seed)
        for (let k = 0; k < 512; k++) pts[k] = boundedRandom(random, jitter)
      }
      return { perm: table, points: pts }
    })

    const distance = (dx: number, dy: number): number => {
      switch (metric) {
        case 1: return (dy * dy + dx * dx) >> 12
        case 2: return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)
        case 3: return Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy)
        case 4: {
          const rx = Math.trunc(Math.sqrt(Math.fround((dx < 0 ? -dx : dx) / 4096.0)) * 4096.0)
          const ry = Math.trunc(Math.sqrt(Math.fround((dy < 0 ? -dy : dy) / 4096.0)) * 4096.0)
          const sum = rx + ry
          return (sum * sum) >> 12
        }
        case 5: return Math.trunc(Math.sqrt(Math.sqrt(Math.fround((dy * dy + dx * dx) / 1.6777216e7))) * 4096.0)
        default: return Math.trunc(Math.sqrt(Math.fround((dx * dx + dy * dy) / 1.6777216e7)) * 4096.0)
      }
    }

    const py = vertical[y] * cellsY + 2048
    const cy = py >> 12

    for (let x = 0; x < width; x++) {
      let f1 = 2147483647
      let f2 = 2147483647
      let f3 = 2147483647
      let f4 = 2147483647

      const px = horizontal[x] * cellsX + 2048
      const cx = px >> 12

      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const rowHash = perm[(gy >= cellsY ? gy - cellsY : gy) & 0xff] & 0xff
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          let k = 2 * (perm[(rowHash + (gx >= cellsX ? gx - cellsX : gx)) & 0xff] & 0xff)
          const dx = px - (points[k++] + (gx << 12))
          const dy = py - (points[k] + (gy << 12))
          const d = distance(dx, dy)

          if (d < f1) { f4 = f3; f3 = f2; f2 = f1; f1 = d }
          else if (d < f2) { f4 = f3; f3 = f2; f2 = d }
          else if (d < f3) { f4 = f3; f3 = d }
          else if (d < f4) { f4 = d }
        }
      }

      switch (mode) {
        case 0: out[x] = f1; break
        case 1: out[x] = f2; break
        case 2: out[x] = f2 - f1; break
        case 3: out[x] = f3; break
        case 4: out[x] = f4; break
      }
    }
  },
}

// 16: Herringbone
OPS[16] = {
  mono: (c, _i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const scaleX = num(op, 'scaleX', 1)
    const scaleY = num(op, 'scaleY', 1)
    const threshold = num(op, 'threshold', 204)

    for (let x = 0; x < width; x++) {
      const hx = horizontal[x]
      const vy = vertical[y]
      let cell = (hx * scaleX) >> 12
      const row = (vy * scaleY) >> 12
      const inX = (hx % idiv(4096, scaleX)) * scaleX
      const inY = (vy % idiv(4096, scaleY)) * scaleY

      let value = 4096
      let done = false
      if (inY < threshold) {
        for (cell -= row; cell < 0; cell += 4);
        while (cell > 3) cell -= 4
        if (cell !== 1 || inX < threshold) { value = 0; done = true }
      }
      if (!done && inX < threshold) {
        for (cell -= row; cell < 0; cell += 4);
        while (cell > 3) cell -= 4
        if (cell > 0) value = 0
      }
      out[x] = value
    }
  },
}

// 17: HSL Adjust
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const hi = Math.max(b, Math.max(r, g))
  const lo = Math.min(b, Math.min(r, g))
  const chroma = hi - lo

  const lightness = idiv(lo + hi, 2)
  let saturation = 0
  if (lightness > 0 && lightness < 4096) {
    saturation = idiv(chroma << 12, lightness <= 2048 ? lightness * 2 : 8192 - lightness * 2)
  }

  let hue = 0
  if (chroma > 0) {
    const dr = idiv((hi - r) << 12, chroma)
    const dg = idiv((hi - g) << 12, chroma)
    const db = idiv((hi - b) << 12, chroma)
    if (hi === r) hue = lo === g ? db + 20480 : 4096 - dg
    else if (hi === g) hue = b === lo ? dr + 4096 : 12288 - db
    else hue = lo === r ? dg + 12288 : 20480 - dr
    hue = idiv(hue, 6)
  }
  return [hue, saturation, lightness]
}

// The RGB output is STATEFUL, exactly as in cryogen where it lives in fields: the
// switch below has no default, so a hue of exactly 4096 (sextant 6) assigns nothing
// and the previous pixel's colour carries over. Same stickiness as Kaleidoscope.
class Hsl {
  red = 0
  green = 0
  blue = 0
}

function hslToRgbInt(o: Hsl, hue: number, saturation: number, lightness: number) {
  const hi = lightness <= 2048
    ? (lightness * (saturation + 4096)) >> 12
    : lightness + saturation - ((lightness * saturation) >> 12)

  if (hi <= 0) {
    // only reachable at black; the magic multiplier is an obfuscation artifact
    // darkan kept, and it yields 0 here either way
    o.blue = Math.imul(lightness, -680551435)
    o.red = lightness
    o.green = lightness
    return
  }

  const h = hue * 6
  const lo = lightness + lightness - hi
  const range = idiv((hi - lo) << 12, hi)
  const sextant = h >> 12
  const frac = h - (sextant << 12)
  const step = (frac * ((range * hi) >> 12)) >> 12
  const rising = lo + step
  const falling = hi - step

  switch (sextant) {
    case 0: o.red = hi; o.green = rising; o.blue = lo; break
    case 1: o.red = falling; o.green = hi; o.blue = lo; break
    case 2: o.red = lo; o.green = hi; o.blue = rising; break
    case 3: o.red = lo; o.green = falling; o.blue = hi; break
    case 4: o.red = rising; o.green = lo; o.blue = hi; break
    case 5: o.red = hi; o.green = lo; o.blue = falling; break
    // no default: the previous pixel's colour persists
  }
}

OPS[17] = {
  color: (c, i, op, y, out) => {
    const dh = num(op, 'hueAdjust')
    const ds = num(op, 'saturationAdjust')
    const dl = num(op, 'lightnessAdjust')
    const src = c.childColor(i, 0, y)
    const o = c.prep(i, () => new Hsl())

    for (let x = 0; x < c.raster.width; x++) {
      let [hue, saturation, lightness] = rgbToHsl(src[0][x], src[1][x], src[2][x])
      hue += dh
      saturation += ds
      lightness += dl

      while (hue < 0) hue += 4096
      while (hue > 4096) hue -= 4096
      if (saturation < 0) saturation = 0
      if (saturation > 4096) saturation = 4096
      if (lightness < 0) lightness = 0
      if (lightness > 4096) lightness = 4096

      hslToRgbInt(o, hue, saturation, lightness)
      out[0][x] = o.red
      out[1][x] = o.green
      out[2][x] = o.blue
    }
  },
}

// 18 / 39: Sprite and Tiled Sprite
function spriteOf(c: Ctx, op: TextureOperation) {
  return c.deps.sprite(num(op, 'spriteId', -1))
}

OPS[39] = {
  color: (c, _i, op, y, out) => {
    const { width, height } = c.raster
    const sprite = spriteOf(c, op)
    if (!sprite || sprite.width <= 0) return

    const { pixels, width: sw, height: sh } = sprite
    const base = (sh !== height ? idiv(sh * y, height) : y) * sw
    for (let x = 0; x < width; x++) {
      const sx = sw !== width ? idiv(x * sw, width) : x
      const rgb = pixels[base + sx] ?? 0
      out[2][x] = (rgb & 0xff) << 4
      out[1][x] = (rgb & 0xff00) >> 4
      out[0][x] = (rgb & 0xff0000) >> 12
    }
  },
}

OPS[18] = {
  color: (c, _i, op, y, out) => {
    const { width } = c.raster
    const sprite = spriteOf(c, op)
    if (!sprite || sprite.width <= 0) return

    const { pixels, width: sw, height: sh } = sprite
    const base = (y % sh) * sh
    for (let x = 0; x < width; x++) {
      const rgb = pixels[base + (x % sw)] ?? 0
      out[2][x] = (rgb & 0xff) << 4
      out[1][x] = (rgb & 0xff00) >> 4
      out[0][x] = (rgb & 0xff0000) >> 12
    }
  },
}

// 19: Polar Distortion. The mono and colour variants index the angle differently —
// that is faithful to cryogen, not a slip.
OPS[19] = {
  mono: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const strength = num(op, 'distortionStrength', 32768)
    const angleSrc = c.childMono(i, 1, y)
    const lengthSrc = c.childMono(i, 2, y)

    for (let x = 0; x < width; x++) {
      const angle = (angleSrc[x] >> 4) & 0xff
      const len = (strength * lengthSrc[x]) >> 12
      const dx = (PALETTE_COS[angle] * len) >> 12
      const dy = (PALETTE_SIN[angle] * len) >> 12
      const sx = (x + (dx >> 12)) & rowEnd
      const sy = ((dy >> 12) + y) & columnEnd
      out[x] = c.childMono(i, 0, sy)[sx]
    }
  },
  color: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const strength = num(op, 'distortionStrength', 32768)
    const angleSrc = c.childMono(i, 1, y)
    const lengthSrc = c.childMono(i, 2, y)

    for (let x = 0; x < width; x++) {
      const angle = ((angleSrc[x] * 255) >> 12) & 0xff
      const len = (strength * lengthSrc[x]) >> 12
      const dx = (PALETTE_COS[angle] * len) >> 12
      const dy = (PALETTE_SIN[angle] * len) >> 12
      const sx = (x + (dx >> 12)) & rowEnd
      const sy = ((dy >> 12) + y) & columnEnd
      const src = c.childColor(i, 0, sy)
      out[0][x] = src[0][sx]
      out[1][x] = src[1][sx]
      out[2][x] = src[2][sx]
    }
  },
}

// 20: Tile
OPS[20] = {
  mono: (c, i, op, y, out) => {
    const { width, height } = c.raster
    const tileW = idiv(width, num(op, 'tileCountX', 4))
    const tileH = idiv(height, num(op, 'tileCountY', 4))
    const src = c.childMono(i, 0, tileH > 0 ? idiv((y % tileH) * height, tileH) : 0)
    for (let x = 0; x < width; x++) {
      out[x] = src[tileW > 0 ? idiv((x % tileW) * width, tileW) : 0]
    }
  },
  color: (c, i, op, y, out) => {
    const { width, height } = c.raster
    const tileW = idiv(width, num(op, 'tileCountX', 4))
    const tileH = idiv(height, num(op, 'tileCountY', 4))
    const src = c.childColor(i, 0, tileH > 0 ? idiv((y % tileH) * height, tileH) : 0)
    for (let x = 0; x < width; x++) {
      const sx = tileW > 0 ? idiv((x % tileW) * width, tileW) : 0
      out[0][x] = src[0][sx]
      out[1][x] = src[1][sx]
      out[2][x] = src[2][sx]
    }
  },
}

// 21: Interpolate
OPS[21] = {
  mono: (c, i, _op, y, out) => {
    const a = c.childMono(i, 0, y)
    const b = c.childMono(i, 1, y)
    const w = c.childMono(i, 2, y)
    for (let x = 0; x < c.raster.width; x++) {
      const t = w[x]
      out[x] = t === 4096 ? a[x] : t === 0 ? b[x] : ((4096 - t) * b[x] + t * a[x]) >> 12
    }
  },
  color: (c, i, _op, y, out) => {
    const w = c.childMono(i, 2, y)
    const a = c.childColor(i, 0, y)
    const b = c.childColor(i, 1, y)
    for (let x = 0; x < c.raster.width; x++) {
      const t = w[x]
      if (t === 4096) {
        out[0][x] = a[0][x]; out[1][x] = a[1][x]; out[2][x] = a[2][x]
      } else if (t === 0) {
        out[0][x] = b[0][x]; out[1][x] = b[1][x]; out[2][x] = b[2][x]
      } else {
        const inv = 4096 - t
        out[0][x] = (t * a[0][x] + inv * b[0][x]) >> 12
        out[1][x] = (t * a[1][x] + inv * b[1][x]) >> 12
        out[2][x] = (t * a[2][x] + inv * b[2][x]) >> 12
      }
    }
  },
}

// 22: Invert
OPS[22] = {
  mono: (c, i, _op, y, out) => {
    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = 4096 - src[x]
  },
  color: (c, i, _op, y, out) => {
    const src = c.childColor(i, 0, y)
    for (let ch = 0; ch < 3; ch++) for (let x = 0; x < c.raster.width; x++) out[ch][x] = 4096 - src[ch][x]
  },
}

// 23: Kaleidoscope.
// Two details that look like slips but are load-bearing: cryogen narrows the angle to
// a FLOAT before comparing it to double bounds (and float(π) is slightly LARGER than
// double π, so a pixel at exactly ±π matches no branch), and the if-chain has no else,
// so when nothing matches the coordinates keep the PREVIOUS pixel's values.
class Fold {
  x = 0
  y = 0
}

OPS[23] = {
  mono: (c, i, _op, y, out) => {
    const { width, horizontal, vertical, rowEnd, columnEnd } = c.raster
    const fold = c.prep(i, () => new Fold())
    for (let x = 0; x < width; x++) {
      foldAt(fold, Math.fround(Math.atan2(horizontal[x] - 2048, vertical[y] - 2048)), x, y, width, c.raster.height)
      out[x] = c.childMono(i, 0, fold.y & columnEnd)[fold.x & rowEnd]
    }
  },
  color: (c, i, _op, y, out) => {
    const { width, horizontal, vertical, rowEnd, columnEnd } = c.raster
    const fold = c.prep(i, () => new Fold())
    for (let x = 0; x < width; x++) {
      foldAt(fold, Math.fround(Math.atan2(horizontal[x] - 2048, vertical[y] - 2048)), x, y, width, c.raster.height)
      const src = c.childColor(i, 0, fold.y & columnEnd)
      const sx = fold.x & rowEnd
      out[0][x] = src[0][sx]
      out[1][x] = src[1][sx]
      out[2][x] = src[2][sx]
    }
  },
}

function foldAt(f: Fold, a: number, x: number, y: number, width: number, height: number) {
  if (a >= -3.141592653589793 && a <= -2.356194490192345) { f.x = x; f.y = y }
  else if (a <= -1.5707963267948966 && a >= -2.356194490192345) { f.x = y; f.y = x }
  else if (a <= -0.7853981633974483 && a >= -1.5707963267948966) { f.x = width - y; f.y = x }
  else if (a <= 0 && a >= -0.7853981633974483) { f.x = x; f.y = height - y }
  else if (a >= 0 && a <= 0.7853981633974483) { f.x = width - x; f.y = height - y }
  else if (a >= 0.7853981633974483 && a <= 1.5707963267948966) { f.x = width - y; f.y = height - x }
  else if (a >= 1.5707963267948966 && a <= 2.356194490192345) { f.x = y; f.y = height - x }
  else if (a >= 2.356194490192345 && a <= 3.141592653589793) { f.x = width - x; f.y = y }
  // no else: the coordinates persist from the previous pixel
}

// 24: Monochrome
OPS[24] = {
  mono: (c, i, _op, y, out) => {
    const src = c.childColor(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = idiv(src[2][x] + src[1][x] + src[0][x], 3)
  },
}

// 25: Brightness
OPS[25] = {
  color: (c, i, op, y, out) => {
    const target = c.prep(i, () => {
      const packed = num(op, 'color')
      return [(packed & 0xff0000) << 4, (packed & 0xff00) >> 4, (packed & 0xff) >> 12]
    })
    const tolerance = num(op, 'colorTolerance', 409)
    const gains = [num(op, 'redBrightness', 4096), num(op, 'greenBrightness', 4096), num(op, 'blueBrightness', 4096)]
    const src = c.childColor(i, 0, y)

    for (let x = 0; x < c.raster.width; x++) {
      let within = true
      for (let ch = 0; ch < 3; ch++) {
        const delta = src[ch][x] - target[ch]
        if ((delta < 0 ? -delta : delta) > tolerance) { within = false; break }
      }
      for (let ch = 0; ch < 3; ch++) {
        out[ch][x] = within ? (src[ch][x] * gains[ch]) >> 12 : src[ch][x]
      }
    }
  },
}

// 26: Binary
OPS[26] = {
  mono: (c, i, op, y, out) => {
    const lower = num(op, 'lowerThreshold')
    const upper = num(op, 'upperThreshold', 4096)
    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = src[x] >= lower && src[x] <= upper ? 4096 : 0
  },
}

// 27: Square Waveform
OPS[27] = {
  mono: (c, i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const steps = num(op, 'stepCount', 10)
    const axis = num(op, 'waveAxis')

    const { stepStart, pulseEnd } = c.prep(i, () => {
      const duty = num(op, 'dutyCycle', 2048)
      const starts = new Int32Array(steps + 1)
      const ends = new Int32Array(steps + 1)
      const stepSize = idiv(4096, steps)
      const pulseSize = (stepSize * duty) >> 12
      let at = 0
      for (let s = 0; s < steps; s++) {
        starts[s] = at
        ends[s] = pulseSize + at
        at += stepSize
      }
      starts[steps] = 4096
      ends[steps] = ends[0] + 4096
      return { stepStart: starts, pulseEnd: ends }
    })

    const pulse = (coord: number) => {
      for (let s = 0; s < steps; s++) {
        if (coord >= stepStart[s] && coord < stepStart[s + 1]) return coord < pulseEnd[s] ? 4096 : 0
      }
      return 0
    }

    const vy = vertical[y]
    if (axis === 0) {
      out.fill(pulse(vy), 0, width)
      return
    }
    for (let x = 0; x < width; x++) {
      const hx = horizontal[x]
      let coord = 0
      if (axis === 1) coord = hx
      else if (axis === 2) coord = ((hx - (4096 - vy)) >> 1) + 2048
      else if (axis === 3) coord = ((hx - vy) >> 1) + 2048
      out[x] = pulse(coord)
    }
  },
}

// 31: Mandelbrot
OPS[31] = {
  mono: (c, _i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const zoom = num(op, 'zoom', 1365)
    const maxIterations = num(op, 'maxIterations', 20)
    const cx = num(op, 'centerX')
    const cy = num(op, 'centerY')

    for (let x = 0; x < width; x++) {
      const re0 = idiv(horizontal[x] << 12, zoom) + cx
      const im0 = idiv(vertical[y] << 12, zoom) + cy
      let re = re0
      let im = im0
      let re2 = (re0 * re0) >> 12
      let im2 = (im0 * im0) >> 12

      let n = 0
      for (; re2 + im2 < 16384 && n < maxIterations; n++) {
        im = ((re * im) >> 12) * 2 + im0
        re = re0 + (re2 - im2)
        re2 = (re * re) >> 12
        im2 = (im * im) >> 12
      }
      out[x] = n < maxIterations - 1 ? idiv(n << 12, maxIterations) : 0
    }
  },
}

// 32: Emboss
const NORMALIZE_TABLE = (() => {
  const table = new Int8Array(32896)
  let at = 0
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b <= a; b++) {
      table[at++] = Math.trunc(255.0 / Math.sqrt(Math.fround((b * b + a * a + 65535) / 65535.0)))
    }
  }
  return table
})()

OPS[32] = {
  mono: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd, scaledWidth } = c.raster
    const depth = num(op, 'embossDepth', 4096)

    const light = c.prep(i, () => {
      const azimuth = num(op, 'lightAzimuth', 3216)
      const elevation = num(op, 'lightElevation', 3216)
      const cosEl = Math.cos(Math.fround(elevation / 4096.0))
      const v = [
        Math.trunc(Math.sin(Math.fround(azimuth / 4096.0)) * cosEl * 4096.0),
        Math.trunc(Math.cos(Math.fround(azimuth / 4096.0)) * cosEl * 4096.0),
        Math.trunc(Math.sin(Math.fround(elevation / 4096.0)) * 4096.0),
      ]
      const lenSq = ((v[0] * v[0]) >> 12) + ((v[1] * v[1]) >> 12) + ((v[2] * v[2]) >> 12)
      const len = Math.trunc(Math.sqrt(lenSq >> 12) * 4096.0)
      if (len !== 0) for (let k = 0; k < 3; k++) v[k] = idiv(v[k] << 12, len)
      return v
    })

    const scaledDepth = (depth * scaledWidth) >> 12
    const above = c.childMono(i, 0, (y - 1) & columnEnd)
    const here = c.childMono(i, 0, y)
    const below = c.childMono(i, 0, (y + 1) & columnEnd)

    for (let x = 0; x < width; x++) {
      const gy = ((below[x] - above[x]) * scaledDepth) >> 12
      const gx = (scaledDepth * (here[(x - 1) & rowEnd] - here[(x + 1) & rowEnd])) >> 12

      let ax = gx >> 4
      let ay = gy >> 4
      if (ax < 0) ax = -ax
      if (ax > 255) ax = 255
      if (ay < 0) ay = -ay
      if (ay > 255) ay = 255

      const scale = NORMALIZE_TABLE[ax + ((ay * (ay + 1)) >> 1)] & 0xff
      const nx = (((gx * scale) >> 8) * light[0]) >> 12
      const ny = (light[1] * ((gy * scale) >> 8)) >> 12
      const nz = (((scale * 4096) >> 8) * light[2]) >> 12
      out[x] = nz + ny + nx
    }
  },
}

// 33 / 35: edge detectors
OPS[35] = {
  mono: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const strength = num(op, 'strength', 4096)
    const above = c.childMono(i, 0, (y - 1) & columnEnd)
    const here = c.childMono(i, 0, y)
    const below = c.childMono(i, 0, (y + 1) & columnEnd)

    for (let x = 0; x < width; x++) {
      const gy = (below[x] - above[x]) * strength
      const gx = (here[(x + 1) & rowEnd] - here[(x - 1) & rowEnd]) * strength
      const sx = gx >> 12
      const sy = gy >> 12
      const mag = Math.trunc(Math.sqrt(Math.fround((((sy * sy) >> 12) + ((sx * sx) >> 12) + 4096) / 4096.0)) * 4096.0)
      out[x] = 4096 - (mag !== 0 ? idiv(16777216, mag) : 0)
    }
  },
}

OPS[33] = {
  color: (c, i, op, y, out) => {
    const { width, rowEnd, columnEnd } = c.raster
    const strength = num(op, 'strength', 4096)
    const normalized = bool(op, 'normalized', true)
    const above = c.childMono(i, 0, (y - 1) & columnEnd)
    const here = c.childMono(i, 0, y)
    const below = c.childMono(i, 0, (y + 1) & columnEnd)

    for (let x = 0; x < width; x++) {
      const gy = (below[x] - above[x]) * strength
      const gx = (here[(x + 1) & rowEnd] - here[(x - 1) & rowEnd]) * strength
      const sx = gx >> 12
      const sy = gy >> 12
      const mag = Math.trunc(Math.sqrt(Math.fround((((sx * sx) >> 12) + ((sy * sy) >> 12) + 4096) / 4096.0)) * 4096.0)

      let r: number
      let g: number
      let b: number
      if (mag !== 0) {
        r = idiv(gx, mag)
        g = idiv(gy, mag)
        b = idiv(16777216, mag)
      } else {
        r = 0; g = 0; b = 0
      }
      if (normalized) {
        r = (r >> 1) + 2048
        g = (g >> 1) + 2048
        b = (b >> 1) + 2048
      }
      out[0][x] = r
      out[1][x] = g
      out[2][x] = b
    }
  },
}

// 30: Range
OPS[30] = {
  mono: (c, i, op, y, out) => {
    const offset = num(op, 'rangeOffset', 1024)
    const multiplier = num(op, 'rangeMax', 3072) - offset
    const src = c.childMono(i, 0, y)
    for (let x = 0; x < c.raster.width; x++) out[x] = ((multiplier * src[x]) >> 12) + offset
  },
  color: (c, i, op, y, out) => {
    const offset = num(op, 'rangeOffset', 1024)
    const multiplier = num(op, 'rangeMax', 3072) - offset
    const src = c.childColor(i, 0, y)
    for (let ch = 0; ch < 3; ch++) {
      for (let x = 0; x < c.raster.width; x++) out[ch][x] = ((multiplier * src[ch][x]) >> 12) + offset
    }
  },
}

// 34: Perlin Noise
const FADE_TABLE = (() => {
  const table = new Int32Array(4096)
  for (let t = 0; t < 4096; t++) {
    const t3 = (t * ((t * t) >> 12)) >> 12
    const a = t * 6 - 61440
    const b = ((t * a) >> 12) + 40960
    table[t] = (b * t3) >> 12
  }
  return table
})()

function perlin2d(x: number, y: number, rowA: number, rowB: number, fadeY: number, wrapX: number, noise: Int8Array): number {
  let x0 = x >> 12
  let x1 = x0 + 1
  if (x1 >= wrapX) x1 = 0
  x &= 0xfff
  x0 &= 0xff
  x1 &= 0xff

  const dx = x - 4096
  const dy = y - 4096
  const fadeX = FADE_TABLE[x]

  const grad = (hash: number, gx: number, gy: number) => {
    const h = hash & 0x3
    if (h <= 1) return h === 0 ? gy + gx : gy - gx
    return h === 2 ? gx - gy : -gx - gy
  }

  const a0 = grad(noise[rowA + x0], x, y)
  const b0 = grad(noise[rowA + x1], dx, y)
  const top = a0 + ((fadeX * (b0 - a0)) >> 12)

  const a1 = grad(noise[x0 + rowB], x, dy)
  const b1 = grad(noise[x1 + rowB], dx, dy)
  const bottom = a1 + ((fadeX * (b1 - a1)) >> 12)

  return top + ((fadeY * (bottom - top)) >> 12)
}

OPS[34] = {
  mono: (c, i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const scaleX = num(op, 'texCoordScaleX', 4)
    const scaleY = num(op, 'texCoordScaleY', 4)
    const fog = bool(op, 'useFogEffect', true)

    const { noise, steps, amps, octaves } = c.prep(i, () => {
      const amplitude = num(op, 'noiseAmplitude', 1638)
      const seed = num(op, 'randomSeed')
      const table = seededByteArrayCached(seed)
      let count = num(op, 'numNoiseSteps', 4)

      let mult: number[]
      if (amplitude > 0) {
        mult = []
        for (let o = 0; o < count; o++) {
          mult.push((Math.trunc(Math.pow(Math.fround(amplitude / 4096.0), o) * 4096.0) << 16) >> 16)
        }
      } else {
        mult = ((op.stepMultipliers as number[]) ?? []).slice(0, count)
      }
      const amplitudes: number[] = []
      for (let o = 0; o < count; o++) amplitudes.push(Math.trunc(Math.pow(2.0, o)))

      // postDecode trims trailing octaves whose multiplier is negligible
      for (let o = count - 1; o >= 1; o--) {
        const s = mult[o]
        if (s > 8 || s < -8) break
        count--
      }
      return { noise: table, steps: mult, amps: amplitudes, octaves: count }
    })

    if (!steps.length) return

    const octave = (o: number, accumulate: boolean, applyFog: boolean) => {
      const step = steps[o]
      const amp = amps[o] << 12
      const wrapY = (amp * scaleY) >> 12
      const wrapX = (amp * scaleX) >> 12

      let sy = (vertical[y] * scaleY * amp) >> 12
      let y0 = sy >> 12
      let y1 = y0 + 1
      if (y1 >= wrapY) y1 = 0
      sy &= 0xfff
      const fadeY = FADE_TABLE[sy]
      const rowA = noise[y0 & 0xff] & 0xff
      const rowB = noise[y1 & 0xff] & 0xff

      for (let x = 0; x < width; x++) {
        const sx = horizontal[x] * scaleX
        let v = perlin2d((amp * sx) >> 12, sy, rowA, rowB, fadeY, wrapX, noise)
        v = (step * v) >> 12
        const total = accumulate ? out[x] + v : v
        out[x] = applyFog ? (total >> 1) + 2048 : total
      }
    }

    if (octaves === 1) {
      octave(0, false, fog)
      return
    }
    const first = steps[0]
    if (first > 8 || first < -8) octave(0, false, false)
    for (let o = 1; o < octaves; o++) {
      const s = steps[o]
      if (s > 8 || s < -8) octave(o, true, fog && o === octaves - 1)
    }
  },
}

// 36: Texture — renders ANOTHER material and samples it.
OPS[36] = {
  color: (c, _i, op, y, out) => {
    const { width, height } = c.raster
    const nested = c.deps.material(num(op, 'materialId', -1))
    if (!nested || nested.width <= 0) return

    const { pixels, width: tw, height: th } = nested
    const base = (th !== height ? idiv(th * y, height) : y) * tw
    for (let x = 0; x < width; x++) {
      const sx = tw !== width ? idiv(x * tw, width) : x
      const rgb = pixels[base + sx] ?? 0
      out[2][x] = (rgb & 0xff) << 4
      out[1][x] = (rgb & 0xff00) >> 4
      out[0][x] = (rgb & 0xff0000) >> 12
    }
  },
}

// 37: unnamed interference pattern
OPS[37] = {
  mono: (c, _i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const p1x = num(op, 'pattern1OffsetX', 2048)
    const p1y = num(op, 'pattern1OffsetY')
    const p2x = num(op, 'pattern2OffsetX')
    const p2y = num(op, 'pattern2OffsetY', 2048)
    const freq = num(op, 'waveFrequency', 12288)
    const amp = num(op, 'waveAmplitude', 4096)
    const decay = num(op, 'waveDecay', 8192)

    const wave = (sum: number) => {
      const phase = (sum * freq) >> 12
      let v = PALETTE_COS[((phase * 255) >> 12) & 0xff]
      v = idiv(v << 12, freq)
      v = idiv(v << 12, decay)
      return (v * amp) >> 12
    }
    const bandA = (x: number, yy: number) => {
      const limit = wave(yy - x)
      return yy + x < limit && yy + x > -limit
    }
    const bandB = (x: number, yy: number) => {
      const limit = wave(yy + x)
      return yy - x < limit && yy - x > -limit
    }
    const wrap = (v: number) => (v < -2048 ? v + 4096 : v > 2048 ? v - 4096 : v)

    const dy = vertical[y] - 2048
    for (let x = 0; x < width; x++) {
      const dx = horizontal[x] - 2048
      const hit = bandA(wrap(dx + p1x), wrap(dy + p1y)) || bandB(wrap(dx + p2x), wrap(dy + p2y))
      out[x] = hit ? 4096 : 0
    }
  },
}

// 38: Line Noise — scatters Bresenham segments across the WHOLE tile at once, so it
// needs every row resident (getAllPaletteData).
OPS[38] = {
  mono: (c, i, op, y, _out) => {
    const cache = c.monoCaches[i]!
    const rows = cache.getAllPaletteData()
    void y

    const { width, height, rowEnd, columnEnd } = c.raster
    const seed = num(op, 'randomSeed')
    const lineCount = num(op, 'lineCount', 2000)
    const lineLength = num(op, 'lineLength', 16)
    const angleOffset = num(op, 'angleOffset')
    const angleSpread = num(op, 'angleSpread', 4096)

    const random = new JavaRandom(seed)
    const halfSpread = angleSpread >> 1

    for (let n = 0; n < lineCount; n++) {
      let angle = angleSpread > 0
        ? angleOffset + (boundedRandom(random, angleSpread) - halfSpread)
        : angleOffset
      angle = (angle >> 4) & 0xff

      let x0 = boundedRandom(random, width)
      let y0 = boundedRandom(random, height)
      let x1 = x0 + ((PALETTE_COS[angle] * lineLength) >> 12)
      let y1 = y0 + ((PALETTE_SIN[angle] * lineLength) >> 12)

      let dy = y1 - y0
      let dx = x1 - x0
      if (dx === 0 && dy === 0) continue
      if (dy < 0) dy = -dy
      if (dx < 0) dx = -dx

      const steep = dy > dx
      if (steep) {
        let t = x0; x0 = y0; y0 = t
        t = x1; x1 = y1; y1 = t
      }
      if (x0 > x1) {
        let t = x0; x0 = x1; x1 = t
        t = y0; y0 = y1; y1 = t
      }

      let yy = y0
      const run = x1 - x0
      let rise = y1 - y0
      let error = idiv(-run, 2)
      const ramp = idiv(2048, run)
      const start = 1024 - (boundedRandom(random, 4096) >> 2)
      const stepY = y0 < y1 ? 1 : -1
      if (rise < 0) rise = -rise

      for (let x = x0; x < x1; x++) {
        const value = start + ramp * (x - x0) + 1024
        // cryogen indexes [major][minor] in BOTH branches, which transposes the
        // result — consistent, and reproduced here on purpose
        const major = x & rowEnd
        const minor = yy & columnEnd
        if (steep) rows[minor][major] = value
        else rows[major][minor] = value

        error += rise
        if (error > 0) {
          error -= run
          yy += stepY
        }
      }
    }
  },
}

// 29: Rasterizer — draws vector shapes (lines/beziers/rects/ellipses) over the
// WHOLE tile at once, so like op 38 it needs every row resident. The mono path
// rasterizes the raw 24-bit shape colours straight into the palette rows
// (TextureOpRasterizer.getMonochromeOutput does exactly that); the colour path
// rasterizes into a scratch buffer and unpacks the channels.
OPS[29] = {
  mono: (c, i, op, y, _out) => {
    const rows = c.monoCaches[i]!.getAllPaletteData()
    void y
    rasterizeShapes((op.shapes as RasterShape[] | undefined) ?? [], rows, c.raster.width, c.raster.height)
  },
  color: (c, i, op, y, _out) => {
    const { width, height } = c.raster
    const scratch: Int32Array[] = []
    for (let k = 0; k < height; k++) scratch.push(new Int32Array(width))
    const palettes = c.colorCaches[i]!.getAllPalettes()
    void y
    rasterizeShapes((op.shapes as RasterShape[] | undefined) ?? [], scratch, width, height)
    for (let yy = 0; yy < height; yy++) {
      const src = scratch[yy]
      const [r, g, b] = palettes[yy]
      for (let x = 0; x < width; x++) {
        const v = src[x]
        b[x] = (v & 0xff) << 4
        g[x] = (v & 0xff00) >> 4
        r[x] = (v & 0xff0000) >> 12
      }
    }
  },
}

// 4: Bricks — a jittered brick grid, seeded off rowCount.
OPS[4] = {
  mono: (c, i, op, y, out) => {
    const { width, horizontal, vertical } = c.raster
    const columnsPerRow = num(op, 'columnsPerRow', 4)
    const rowCount = num(op, 'rowCount', 8)
    const verticalOffset = num(op, 'verticalOffset')
    const staggerAmount = num(op, 'staggerAmount', 1024)

    const grid = c.prep(i, () => {
      const random = new JavaRandom(rowCount)
      const halfMortar = idiv(num(op, 'mortarThickness', 81), 2)
      const columnWidth = idiv(4096, columnsPerRow)
      const rowHeight = idiv(4096, rowCount)
      const halfColumn = idiv(columnWidth, 2)
      const halfRow = idiv(rowHeight, 2)
      const columnWidthVariation = num(op, 'columnWidthVariation', 409)
      const rowHeightVariation = num(op, 'rowHeightVariation', 204)
      const brightnessVariation = num(op, 'brightnessVariation', 1024)

      const rowBoundaries = new Int32Array(rowCount + 1)
      const columnBoundaries: Int32Array[] = []
      const brickBrightness: Int32Array[] = []
      rowBoundaries[0] = 0

      for (let r = 0; r < rowCount; r++) {
        if (r > 0) {
          let h = rowHeight
          const jitter = ((boundedRandom(random, 4096) - 2048) * rowHeightVariation) >> 12
          h += (jitter * halfRow) >> 12
          rowBoundaries[r] = h + rowBoundaries[r - 1]
        }

        const cols = new Int32Array(columnsPerRow + 1)
        const bright = new Int32Array(columnsPerRow)
        cols[0] = 0
        for (let k = 0; k < columnsPerRow; k++) {
          if (k > 0) {
            let w = columnWidth
            const jitter = ((boundedRandom(random, 4096) - 2048) * columnWidthVariation) >> 12
            w += (jitter * halfColumn) >> 12
            cols[k] = cols[k - 1] + w
          }
          bright[k] = brightnessVariation > 0 ? 4096 - boundedRandom(random, brightnessVariation) : 4096
        }
        cols[columnsPerRow] = 4096
        columnBoundaries.push(cols)
        brickBrightness.push(bright)
      }
      rowBoundaries[rowCount] = 4096

      return { halfMortar, columnWidth, rowBoundaries, columnBoundaries, brickBrightness }
    })

    const { halfMortar, columnWidth, rowBoundaries, columnBoundaries, brickBrightness } = grid

    let vy = vertical[y] + verticalOffset
    while (vy < 0) vy += 4096
    while (vy > 4096) vy -= 4096

    let row = 0
    while (row < rowCount && vy >= rowBoundaries[row]) row++

    const band = row - 1
    const even = (row & 0x1) === 0
    const top = rowBoundaries[row]
    const bottom = rowBoundaries[row - 1]

    if (!(vy > bottom + halfMortar && vy < top - halfMortar)) {
      out.fill(0, 0, width)
      return
    }

    const stagger = even ? staggerAmount : -staggerAmount
    for (let x = 0; x < width; x++) {
      let hx = horizontal[x] + ((stagger * columnWidth) >> 12)
      while (hx < 0) hx += 4096
      while (hx > 4096) hx -= 4096

      let col = 0
      while (col < columnsPerRow && hx >= columnBoundaries[band][col]) col++

      const left = columnBoundaries[band][col - 1]
      const right = columnBoundaries[band][col]
      out[x] = hx > left + halfMortar && hx < right - halfMortar ? brickBrightness[band][col - 1] : 0
    }
  },
}

// 28: Irregular Bricks — lays courses of randomly-sized bricks across the WHOLE tile
// in one pass (getAllPaletteData), tracking the previous course so each new brick
// starts below whatever it overlaps.
OPS[28] = {
  mono: (c, i, op, _y, _out) => {
    const rows = c.monoCaches[i]!.getAllPaletteData()
    const { width, height, rowEnd } = c.raster

    const minW = (num(op, 'minBrickWidth', 1024) * width) >> 12
    const maxW = (num(op, 'maxBrickWidth', 2048) * width) >> 12
    const minH = (num(op, 'minBrickHeight', 409) * height) >> 12
    const maxH = (num(op, 'maxBrickHeight', 819) * height) >> 12
    if (maxH <= 1) return

    const cornerRadius = (idiv(width, 8) * num(op, 'offsetVariation', 1024)) >> 12
    const cornerMode = num(op, 'cornerMode')
    const heightVariation = num(op, 'heightVariationMultiplier', 1024)
    const brightnessVariation = num(op, 'brightnessVariation', 1024)
    const random = new JavaRandom(num(op, 'randomSeed'))

    const fill = (row: Int32Array, at: number, len: number, value: number) => {
      for (let k = 0; k < len; k++) row[at + k] = value
    }

    const drawBrick = (left: number, top: number, w: number, h: number) => {
      const brightness = brightnessVariation > 0 ? 4096 - boundedRandom(random, brightnessVariation) : 4096
      const jitter = (heightVariation * cornerRadius) >> 12
      const radius = cornerRadius - (jitter > 0 ? boundedRandom(random, jitter) : 0)
      if (left >= width) left -= width

      if (radius > 0) {
        if (h <= 0 || w <= 0) return
        const cornerW = Math.min(idiv(w, 2), radius)
        const cornerH = Math.min(idiv(h, 2), radius)
        const innerLeft = left + cornerW
        const innerW = w - cornerW * 2

        for (let r = 0; r < h; r++) {
          const row = rows[r + top]
          const fromTop = r
          const fromBottom = h - r - 1

          const edge = (limit: number) => {
            for (let k = 0; k < cornerW; k++) {
              const ramp = idiv(k * brightness, cornerW)
              const value = cornerMode === 0 ? (ramp * limit) >> 12 : Math.min(ramp, limit)
              row[(left + k) & rowEnd] = value
              row[(left + w - k - 1) & rowEnd] = value
            }
            if (innerW + innerLeft > width) {
              const head = width - innerLeft
              fill(row, innerLeft, head, limit)
              fill(row, 0, innerW - head, limit)
            } else {
              fill(row, innerLeft, innerW, limit)
            }
          }

          if (fromTop < cornerH) {
            edge(idiv(brightness * fromTop, cornerH))
          } else if (fromBottom < cornerH) {
            edge(idiv(brightness * fromBottom, cornerH))
          } else {
            for (let k = 0; k < cornerW; k++) {
              const value = idiv(k * brightness, cornerW)
              row[(left + k) & rowEnd] = value
              row[(left + w - k - 1) & rowEnd] = value
            }
            if (innerLeft + innerW > width) {
              const head = width - innerLeft
              fill(row, innerLeft, head, brightness)
              fill(row, 0, innerW - head, brightness)
            } else {
              fill(row, innerLeft, innerW, brightness)
            }
          }
        }
      } else if (left + w > width) {
        const head = width - left
        for (let r = 0; r < h; r++) {
          fill(rows[r + top], left, head, brightness)
          fill(rows[r + top], 0, w - head, brightness)
        }
      } else {
        for (let r = 0; r < h; r++) fill(rows[r + top], left, w, brightness)
      }
    }

    // the current and previous course, each entry [startX, endX, bottomY]
    const slots = idiv(width, minW) + 1
    let prev: number[][] = Array.from({ length: slots }, () => [0, 0, 0])
    let cur: number[][] = Array.from({ length: slots }, () => [0, 0, 0])

    let courseShift = 0
    let courseStart = 0
    let prevStart = 0
    let penX = 0
    let cursor = 0
    let firstCourse = true
    let reachedBottom = true
    let prevCount = 0
    let curCount = 0

    for (;;) {
      let w = minW + boundedRandom(random, maxW - minW)
      let h = minH + boundedRandom(random, maxH - minH)
      let right = w + penX
      if (right > width) {
        w = width - penX
        right = width
      }

      let top: number
      if (firstCourse) {
        top = 0
      } else {
        let probe = cursor
        let steps = 0
        let edge = right + courseShift
        if (edge < 0) edge += width
        if (edge > width) edge -= width

        for (;;) {
          const slot = prev[probe]
          if (edge >= slot[0] && edge <= slot[1]) {
            top = prev[cursor][2]
            if (probe !== cursor) {
              let leftEdge = penX + courseShift
              if (leftEdge < 0) leftEdge += width
              if (leftEdge > width) leftEdge -= width

              for (let k = 1; k <= steps; k++) {
                top = Math.max(top, prev[(k + cursor) % prevCount][2])
              }
              for (let k = 0; k <= steps; k++) {
                const other = prev[(k + cursor) % prevCount]
                const otherBottom = other[2]
                if (otherBottom === top) continue

                let from: number
                let to: number
                if (leftEdge < edge) {
                  from = Math.max(leftEdge, other[0])
                  to = Math.min(edge, other[1])
                } else if (other[0] === 0) {
                  from = 0
                  to = Math.min(edge, other[1])
                } else {
                  from = Math.max(leftEdge, other[0])
                  to = width
                }
                drawBrick(from + prevStart, otherBottom, to - from, top - otherBottom)
              }
            }
            cursor = probe
            break
          }
          probe++
          if (probe >= prevCount) probe = 0
          steps++
        }
      }

      if (top! + h > height) {
        h = height - top!
      } else {
        reachedBottom = false
      }

      if (right === width) {
        drawBrick(courseStart + penX, top!, w, h)
        if (reachedBottom) return
        reachedBottom = true

        const slot = cur[curCount++]
        slot[0] = penX
        slot[1] = right
        slot[2] = h + top!

        const swap = prev
        prev = cur
        cur = swap
        prevCount = curCount
        curCount = 0

        prevStart = courseStart
        courseStart = boundedRandom(random, width)
        courseShift = courseStart - prevStart
        penX = 0

        let probe = courseShift
        if (probe < 0) probe += width
        if (probe > width) probe -= width

        cursor = 0
        for (;;) {
          const slot2 = prev[cursor]
          if (probe >= slot2[0] && probe <= slot2[1]) {
            firstCourse = false
            break
          }
          cursor++
          if (cursor >= prevCount) cursor = 0
        }
      } else {
        const slot = cur[curCount++]
        slot[0] = penX
        slot[1] = right
        slot[2] = h + top!
        drawBrick(courseStart + penX, top!, w, h)
        penX = right
      }
    }
  },
}

// ---------------------------------------------------------------------------

/** Op types this renderer can evaluate. Anything else falls back to the dumped PNG. */
export const SUPPORTED = new Set(Object.keys(OPS).map(Number))

/**
 * Op types in this material that we can't evaluate — including inside any material
 * it NESTS via op 36. Without the recursive check a texture whose nested material
 * uses an unported op renders as a black square rather than falling back to the
 * dumped PNG, which is worse than showing nothing.
 */
export function unsupportedOps(
  material: MaterialDefinition,
  resolveNested?: (id: number) => MaterialDefinition | null,
  seen = new Set<number>(),
): number[] {
  const missing = new Set<number>()

  for (const op of material.textureOperations ?? []) {
    if (!SUPPORTED.has(op.type)) missing.add(op.type)

    if (op.type === 36 && resolveNested) {
      const id = typeof op.materialId === 'number' ? op.materialId : -1
      if (id < 0 || seen.has(id)) continue
      seen.add(id)
      const nested = resolveNested(id)
      if (nested) for (const t of unsupportedOps(nested, resolveNested, seen)) missing.add(t)
    }
  }
  return [...missing].sort((a, b) => a - b)
}

const brightnessCache = new Map<number, Int32Array>()

function brightnessTable(gamma: number): Int32Array {
  let table = brightnessCache.get(gamma)
  if (!table) {
    table = new Int32Array(256)
    for (let i = 0; i < 256; i++) table[i] = Math.min(255, Math.trunc(Math.pow(i / 255.0, gamma) * 255.0))
    brightnessCache.set(gamma, table)
  }
  return table
}

const clampByte = (v: number) => (v > 255 ? 255 : v < 0 ? 0 : v)

/**
 * MaterialDefinitions.getPixelsArgb — the path the dumper uses for <id>.png.
 *
 * Walks x from width-1 DOWN to 0 while advancing the write pointer forward, so the
 * stored image is horizontally mirrored. And note the colour row is fetched BEFORE
 * the opacity row: the opacity chain can evict the colour buffer we are holding, and
 * that artifact is part of the texture.
 */
export function renderMaterial(material: MaterialDefinition, size: number, deps: RenderDeps, gamma = 0.7): Int32Array {
  const ctx = new Ctx(material, makeRaster(size, size), deps)
  const ramp = brightnessTable(gamma)
  const out = new Int32Array(size * size)

  let write = 0
  for (let y = 0; y < size; y++) {
    const colour = ctx.color(material.opaqueOperationIndex, y)
    const opacity = ctx.mono(material.opacityOperationIndex, y)

    for (let x = size - 1; x >= 0; x--) {
      const r = ramp[clampByte(colour[0][x] >> 4)]
      const g = ramp[clampByte(colour[1][x] >> 4)]
      const b = ramp[clampByte(colour[2][x] >> 4)]
      const a = r === 0 && g === 0 && b === 0 ? 0 : clampByte(opacity[x] >> 4)
      out[write++] = b + (g << 8) + (a << 24) + (r << 16)
    }
  }
  return out
}

/** MaterialDefinitions.getPixelsRgb — how a material is sampled when another nests it. */
export function renderMaterialRgb(
  material: MaterialDefinition,
  size: number,
  deps: RenderDeps,
  gamma: number,
  writeReversed: boolean,
): Int32Array {
  const ctx = new Ctx(material, makeRaster(size, size), deps)
  const ramp = brightnessTable(gamma)
  const out = new Int32Array(size * size)

  let write = 0
  for (let y = 0; y < size; y++) {
    const colour = ctx.color(material.opaqueOperationIndex, y)
    if (writeReversed) write = y

    for (let x = 0; x < size; x++) {
      const r = ramp[clampByte(colour[0][x] >> 4)]
      const g = ramp[clampByte(colour[1][x] >> 4)]
      const b = ramp[clampByte(colour[2][x] >> 4)]
      let rgb = b + (g << 8) + (r << 16)
      if (rgb !== 0) rgb |= -16777216
      out[write++] = rgb
      if (writeReversed) write += size - 1
    }
  }
  return out
}

export { Ctx, OPS, num, bool, idiv }
