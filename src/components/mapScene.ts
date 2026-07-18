import * as THREE from 'three'
import type { MapTerrain } from '../loaders/maps'
import { SIZE, tileIndex } from '../loaders/maps'
import type { ModelData } from '../loaders/models'
import { hslToRgb, parseModel, applyRecolor } from '../loaders/models'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { makeUVWriter } from './modelUVs'
import type { UVWriter } from './modelUVs'

// Builds a Three.js scene for one map region, ported from the darkan client
// scene pipeline (MapLoader/SceneGraph/GroundSM in darkan-bot-refactor and the
// matching darkan-game-client decompile):
// - tile heights incl. the plane-0 Perlin default (TileUtils.calculateTileheight,
//   preserving the shipped quirk that the 65536-based cosine interpolation reads
//   Trig's 16384-amplitude table)
// - underlay colours via the client's 11×11 HSL box blur (calculateUnderlayPalette)
// - the 13 overlay tile shapes with rotation (SHAPE_VERTEX_* + tileSizeDeltas)
// - slope-directional vertex lighting (GroundSM init) baked into vertex colours
// - locs placed per SceneGraph.addObject (average height over the loc footprint,
//   rotation-swapped sizes), models merged into one geometry per plane.
// RS scene space → three: x stays, y (down) → -y, tile "north" y-axis → -z.

// ---------------------------------------------------------------------------
// Client colour math (ColorUtil + FluType.calculateHsl16)
// ---------------------------------------------------------------------------

/** ColorUtil.rgbToHsl24 — 24-bit RGB → packed HSL16 (used by flo tile colours). */
export function rgbToHsl16(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 256.0
  const g = ((rgb >> 8) & 0xff) / 256.0
  const b = (rgb & 0xff) / 256.0
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let hue = 0
  let sat = 0
  const light = (max + min) / 2.0
  if (max !== min) {
    sat = light < 0.5 ? (max - min) / (max + min) : (max - min) / (2.0 - max - min)
    if (r === max) hue = (g - b) / (max - min)
    else if (g === max) hue = 2.0 + (b - r) / (max - min)
    else hue = 4.0 + (r - g) / (max - min)
  }
  hue /= 6.0
  const h = Math.trunc(256.0 * hue)
  let s = Math.min(255, Math.max(0, Math.trunc(sat * 256.0)))
  const l = Math.min(255, Math.max(0, Math.trunc(light * 256.0)))
  if (l > 243) s >>= 4
  else if (l > 217) s >>= 3
  else if (l > 192) s >>= 2
  else if (l > 179) s >>= 1
  return (((h & 0xff) >> 2) << 10) + (l >> 1) + ((s >> 5) << 7)
}

/** FluType.calculateHsl16 — underlay rgb → blur accumulator components. */
export function fluComponents(rgb: number): { hue: number; saturation: number; lightness: number; divisor: number } {
  const r = ((rgb >> 16) & 0xff) / 256.0
  const g = ((rgb >> 8) & 0xff) / 256.0
  const b = (rgb & 0xff) / 256.0
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let hue = 0
  let sat = 0
  const light = (max + min) / 2.0
  if (max !== min) {
    sat = light < 0.5 ? (max - min) / (max + min) : (max - min) / (2.0 - max - min)
    if (r === max) hue = (g - b) / (max - min)
    else if (g === max) hue = 2.0 + (b - r) / (max - min)
    else hue = (r - g) / (max - min) + 4.0
  }
  hue /= 6.0
  const saturation = Math.min(255, Math.max(0, Math.trunc(sat * 256.0)))
  const lightness = Math.min(255, Math.max(0, Math.trunc(light * 256.0)))
  let divisor = light > 0.5 ? Math.trunc(sat * (1.0 - light) * 512.0) : Math.trunc(sat * light * 512.0)
  if (divisor < 1) divisor = 1
  return { hue: Math.trunc(hue * divisor), saturation, lightness, divisor }
}

/** ColorUtil.hsl16to24 — blurred components → packed HSL16 (name is Jagex's). */
function packBlurredHsl(hue: number, saturation: number, lightness: number): number {
  let s = saturation
  if (lightness > 243) s >>= 4
  else if (lightness > 217) s >>= 3
  else if (lightness > 192) s >>= 2
  else if (lightness > 179) s >>= 1
  return (((hue & 0xff) >> 2) << 10) + (lightness >> 1) + ((s >> 5) << 7)
}

/** ColorUtil.adjustHsv — remaps packed colour before lighting. */
function adjustHsv(packed: number): number {
  const hue = (packed >> 10) & 0x3f
  const saturation = (packed >> 3) & 0x70
  const value = packed & 0x7f
  const chroma = value <= 64 ? (value * saturation) >> 7 : (saturation * (127 - value)) >> 7
  const brightness = chroma + value
  const newSaturation = brightness !== 0 ? Math.trunc((chroma << 8) / brightness) : chroma << 1
  return (hue << 10) | ((newSaturation >> 4) << 7) | brightness
}

/** ColorUtil.repackHsl — scales lightness by a 0-127 light level. */
function repackHsl(hsl: number, light: number): number {
  let l = ((hsl & 0x7f) * light) >> 7
  if (l < 2) l = 2
  else if (l > 126) l = 126
  return (hsl & 0xff80) + l
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Final per-vertex colour: client-lit HSL16 → linear RGB floats. */
function litColor(hsl: number, light: number): [number, number, number] {
  const rgb = hslToRgb(repackHsl(adjustHsv(hsl), light))
  return [
    srgbToLinear(((rgb >> 16) & 0xff) / 255),
    srgbToLinear(((rgb >> 8) & 0xff) / 255),
    srgbToLinear((rgb & 0xff) / 255),
  ]
}

// ---------------------------------------------------------------------------
// Terrain default-height noise (TileUtils / Class159 / Class430)
// ---------------------------------------------------------------------------

// Trig.COSINE has 16384 entries at amplitude 16384, but the interpolation
// subtracts it from 65536 — an authentic client quirk, kept verbatim.
const NOISE_STEP = 3.834951969714103e-4
const COS16K = new Int32Array(16384)
for (let i = 0; i < 16384; i++) COS16K[i] = Math.trunc(16384.0 * Math.cos(i * NOISE_STEP))

function randomNoise(x: number, y: number): number {
  let n = (Math.imul(y, 57) + x) | 0
  n ^= n << 13
  const value = (Math.imul(n, Math.imul(Math.imul(n, n), 15731) + 789221) + 1376312589) & 0x7fffffff
  return (value >> 19) & 0xff
}

function noiseWeighedSum(x: number, y: number): number {
  const corners = randomNoise(x - 1, y - 1) + randomNoise(x + 1, y - 1) + randomNoise(x - 1, y + 1) + randomNoise(x + 1, y + 1)
  const sides = randomNoise(x - 1, y) + randomNoise(x + 1, y) + randomNoise(x, y - 1) + randomNoise(x, y + 1)
  const center = randomNoise(x, y)
  return Math.trunc(corners / 16) + Math.trunc(sides / 8) + Math.trunc(center / 4)
}

function cosInterpolate(a: number, b: number, angle: number, freq: number): number {
  const cos = (65536 - COS16K[Math.trunc((angle * 8192) / freq)]) >> 1
  return (((65536 - cos) * a) >> 16) + ((cos * b) >> 16)
}

function perlinNoise(x: number, y: number, freq: number): number {
  const adjX = Math.trunc(x / freq)
  const angleX = x & (freq - 1)
  const adjY = Math.trunc(y / freq)
  const angleY = y & (freq - 1)
  const base = noiseWeighedSum(adjX, adjY)
  const east = noiseWeighedSum(adjX + 1, adjY)
  const south = noiseWeighedSum(adjX, adjY + 1)
  const southEast = noiseWeighedSum(adjX + 1, adjY + 1)
  const north = cosInterpolate(base, east, angleX, freq)
  const southI = cosInterpolate(south, southEast, angleX, freq)
  return cosInterpolate(north, southI, angleY, freq)
}

export function calculateTileHeight(x: number, y: number): number {
  let height =
    perlinNoise(45365 + x, y + 91923, 4) - 128 +
    ((perlinNoise(x + 10294, 37821 + y, 2) - 128) >> 1) +
    ((perlinNoise(x, y, 1) - 128) >> 2)
  height = Math.trunc(height * 0.3) + 35
  if (height < 10) height = 10
  else if (height > 60) height = 60
  return height
}

// ---------------------------------------------------------------------------
// Tile shape tables (MapLoader companion)
// ---------------------------------------------------------------------------

const OVERLAY_FACE_COUNT = [2, 1, 1, 1, 2, 2, 2, 1, 3, 3, 3, 2, 0, 4, 0]
const UNDERLAY_FACE_COUNT = [0, 1, 2, 2, 1, 1, 2, 3, 1, 3, 3, 4, 2, 0, 4]
const SHAPE_VERTEX_A = [
  [0, 2], [0, 2], [0, 0, 2], [2, 0, 0], [0, 2, 0], [0, 0, 2], [0, 5, 1, 4],
  [0, 4, 4, 4], [4, 4, 4, 0], [6, 6, 6, 2, 2, 2], [2, 2, 2, 6, 6, 6],
  [0, 11, 6, 6, 6, 4], [0, 2], [0, 4, 4, 4], [0, 4, 4, 4],
]
const SHAPE_VERTEX_B = [
  [2, 4], [2, 4], [5, 2, 4], [4, 5, 2], [2, 4, 5], [5, 2, 4], [1, 6, 2, 5],
  [1, 6, 7, 1], [6, 7, 1, 1], [0, 8, 9, 8, 9, 4], [8, 9, 4, 0, 8, 9],
  [2, 10, 0, 10, 11, 11], [2, 4], [1, 6, 7, 1], [1, 6, 7, 1],
]
const SHAPE_VERTEX_C = [
  [6, 6], [6, 6], [6, 5, 5], [5, 6, 5], [5, 5, 6], [6, 5, 5], [5, 0, 4, 1],
  [7, 7, 1, 2], [7, 1, 2, 7], [8, 9, 4, 0, 8, 9], [0, 8, 9, 8, 9, 4],
  [11, 0, 10, 11, 4, 2], [6, 6], [7, 7, 1, 2], [7, 7, 1, 2],
]
// Vertex index → position within the 512-unit tile (0-7 perimeter ring from
// the SW corner, 8-11 interior, 12 centre).
const VERTEX_DELTA_X = [0, 256, 512, 512, 512, 256, 0, 0, 128, 256, 128, 384, 256]
const VERTEX_DELTA_Y = [0, 0, 0, 256, 512, 512, 512, 256, 256, 384, 128, 128, 256]

// ---------------------------------------------------------------------------
// Config inputs
// ---------------------------------------------------------------------------

export type FluJson = { id: number; rgb?: number; texture?: number; scale?: number }
export type FloJson = {
  id: number
  colorRgb?: number
  texture?: number
  textureScale?: number
  minimapColorRgb?: number
  waterColor?: number
  blendsWithUnderlay?: boolean
}

export type SceneConfigs = {
  underlays: Map<number, FluJson>
  overlays: Map<number, FloJson>
}

export async function loadSceneConfigs(rootHandle: FileSystemDirectoryHandle): Promise<SceneConfigs> {
  async function loadDir(name: string): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>()
    try {
      const configDir = await rootHandle.getDirectoryHandle('config')
      const dir = await configDir.getDirectoryHandle(name)
      const reads: Promise<void>[] = []
      for await (const handle of dir.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (isNaN(id)) continue
        reads.push((async () => {
          try {
            out.set(id, JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()))
          } catch { /* skip unreadable */ }
        })())
      }
      await Promise.all(reads)
    } catch { /* entry not dumped */ }
    return out
  }
  const [underlays, overlays] = await Promise.all([loadDir('underlays'), loadDir('overlays')])
  return { underlays: underlays as Map<number, FluJson>, overlays: overlays as Map<number, FloJson> }
}

// The magic RGB that means "no colour" for flo colours (16711935 = pure magenta).
const NO_COLOR = 16711935

function floTileHsl(flo: FloJson | undefined): number {
  if (!flo) return -1
  // minimapColorRgb is deliberately NOT a fallback: overlays with no tile
  // colour and no texture are invisible in the main view (e.g. bridge decks,
  // where the bridge MODEL provides the visible surface) — the minimap colour
  // only paints the minimap.
  if (flo.colorRgb !== undefined && flo.colorRgb !== NO_COLOR) return rgbToHsl16(flo.colorRgb)
  return -1
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

const VERTS = SIZE + 1 // 65 vertices per axis

/** Per-plane 65×65 vertex heights in RS units (negative = up). MapLoader.decodeTile. */
export function computeHeights(terrain: MapTerrain, regionX: number, regionY: number): Int32Array[] {
  const planes: Int32Array[] = []
  const presence = terrain.heightPresence
  const values = terrain.heightValue
  for (let plane = 0; plane < 4; plane++) {
    const heights = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        // vertex (x, y) is decoded from tile (x, y); the 65th row/column comes
        // from the neighbouring region in the client — approximate by
        // duplicating the edge tile (the noise path stays exact, it's global)
        const tx = Math.min(x, SIZE - 1)
        const ty = Math.min(y, SIZE - 1)
        const idx = tileIndex(plane, tx, ty)
        const hasHeight = (presence[idx >> 3] & (1 << (idx & 0x7))) !== 0
        let h: number
        if (hasHeight) {
          let v = values[idx] & 0xff
          if (v === 1) v = 0
          if (plane === 0) h = -((v * 8) << 2)
          else h = planes[plane - 1][x * VERTS + y] - ((v * 8) << 2)
        } else if (plane === 0) {
          const absX = regionX * 64 + x
          const absY = regionY * 64 + y
          h = -calculateTileHeight(absX + 932731, absY + 556238) * 8 << 2
        } else {
          h = planes[plane - 1][x * VERTS + y] - 960
        }
        heights[x * VERTS + y] = h
      }
    }
    planes.push(heights)
  }
  return planes
}

/** Ground.getAverageHeight — bilinear height at 512-scale scene coords. */
export function averageHeight(heights: Int32Array, sceneX: number, sceneY: number): number {
  const tileX = sceneX >> 9
  const tileY = sceneY >> 9
  if (tileX < 0 || tileY < 0 || tileX > VERTS - 2 || tileY > VERTS - 2) {
    const cx = Math.min(Math.max(tileX, 0), VERTS - 1)
    const cy = Math.min(Math.max(tileY, 0), VERTS - 1)
    return heights[cx * VERTS + cy]
  }
  const offX = sceneX & 511
  const offY = sceneY & 511
  const h1 = (heights[tileX * VERTS + tileY] * (512 - offX) + offX * heights[(tileX + 1) * VERTS + tileY]) >> 9
  const h2 = (heights[tileX * VERTS + tileY + 1] * (512 - offX) + heights[(tileX + 1) * VERTS + tileY + 1] * offX) >> 9
  return (h2 * offY + h1 * (512 - offY)) >> 9
}

// ---------------------------------------------------------------------------
// Terrain geometry
// ---------------------------------------------------------------------------

/** GroundSM init — slope-directional light per vertex, 2..126, over an
 *  arbitrary square vertex grid. */
function computeVertexLightGrid(heights: Int32Array, verts: number): Uint8Array {
  // client defaults: lightIntensity 75518, sun dir (-50,-60,-50) << 2 normalised ×65535
  const baseLight = 75518 >> 9
  const mag = Math.sqrt(200 * 200 + 240 * 240 + 200 * 200)
  const lightX = Math.trunc((-200 * 65535) / mag)
  const lightY = Math.trunc((-240 * 65535) / mag)
  const lightZ = Math.trunc((-200 * 65535) / mag)
  const light = new Uint8Array(verts * verts).fill(84)
  for (let x = 0; x < verts; x++) {
    for (let y = 0; y < verts; y++) {
      // client computes 1..size-1 only; clamp neighbours so edges get lit too
      const xm = Math.max(x - 1, 0), xp = Math.min(x + 1, verts - 1)
      const ym = Math.max(y - 1, 0), yp = Math.min(y + 1, verts - 1)
      const dhx = heights[xp * verts + y] - heights[xm * verts + y]
      const dhy = heights[x * verts + yp] - heights[x * verts + ym]
      const len = Math.trunc(Math.sqrt(512 * 512 + dhx * dhx + dhy * dhy))
      const nx = Math.trunc((dhx << 8) / len)
      const ny = Math.trunc((512 * -512) / len)
      const nz = Math.trunc((dhy << 8) / len)
      let l = baseLight + ((lightX * nx + lightY * ny + lightZ * nz) >> 17)
      l >>= 1
      if (l < 2) l = 2
      else if (l > 126) l = 126
      light[x * verts + y] = l
    }
  }
  return light
}

function computeVertexLight(heights: Int32Array): Uint8Array {
  return computeVertexLightGrid(heights, VERTS)
}

/** Bilinear light at 512-scale coords (GroundSM.calculateBlockTiles vertex light). */
function lightAt(light: Uint8Array, sceneX: number, sceneY: number): number {
  const tileX = Math.min(sceneX >> 9, VERTS - 2)
  const tileY = Math.min(sceneY >> 9, VERTS - 2)
  const offX = sceneX & 511
  const offY = sceneY & 511
  const la = light[(tileX + 1) * VERTS + tileY] * offX + light[tileX * VERTS + tileY] * (512 - offX)
  const lb = light[tileX * VERTS + tileY + 1] * (512 - offX) + light[(tileX + 1) * VERTS + tileY + 1] * offX
  return (la * (512 - offY) + lb * offY) >> 18
}

// ---------------------------------------------------------------------------
// Cross-region mosaic: heights, lighting and underlay blur computed over the
// whole 3×3 neighbourhood in one grid, then sliced per region — adjacent
// slices share identical boundary values, so region seams vanish.
// ---------------------------------------------------------------------------

const MOSAIC = 3 * SIZE // 192 tiles across the 3×3
const MVERTS = MOSAIC + 1

export class SceneMosaic {
  private heights: Int32Array[] = [] // per plane, MVERTS²
  private lights: Uint8Array[] = []
  private sliceCache = new Map<string, { heights: Int32Array[]; lights: Uint8Array[] }>()
  /** regions[dx+1][dy+1]; null when that neighbour isn't dumped. */
  private regions: (MapTerrain | null)[][]
  private regionX: number
  private regionY: number
  private configs: SceneConfigs

  constructor(
    regions: (MapTerrain | null)[][],
    regionX: number,
    regionY: number,
    configs: SceneConfigs,
  ) {
    this.regions = regions
    this.regionX = regionX
    this.regionY = regionY
    this.configs = configs
    for (let plane = 0; plane < 4; plane++) {
      const h = new Int32Array(MVERTS * MVERTS)
      const prev = plane > 0 ? this.heights[plane - 1] : null
      for (let gx = 0; gx < MVERTS; gx++) {
        for (let gy = 0; gy < MVERTS; gy++) {
          const tx = Math.min(gx, MOSAIC - 1)
          const ty = Math.min(gy, MOSAIC - 1)
          const rdx = Math.floor(tx / SIZE)
          const rdy = Math.floor(ty / SIZE)
          const terrain = this.regions[rdx]?.[rdy]
          let presence = false
          let value = 0
          if (terrain) {
            const idx = tileIndex(plane, tx - rdx * SIZE, ty - rdy * SIZE)
            presence = (terrain.heightPresence[idx >> 3] & (1 << (idx & 0x7))) !== 0
            value = terrain.heightValue[idx] & 0xff
          }
          let out: number
          if (presence) {
            if (value === 1) value = 0
            out = plane === 0 ? -((value * 8) << 2) : prev![gx * MVERTS + gy] - ((value * 8) << 2)
          } else if (plane === 0) {
            const absX = (this.regionX - 1) * 64 + gx
            const absY = (this.regionY - 1) * 64 + gy
            out = -calculateTileHeight(absX + 932731, absY + 556238) * 8 << 2
          } else {
            out = prev![gx * MVERTS + gy] - 960
          }
          h[gx * MVERTS + gy] = out
        }
      }
      this.heights.push(h)
      this.lights.push(computeVertexLightGrid(h, MVERTS))
    }
  }

  /** 65×65 per-plane height slices for one region (region-local layout). */
  slicesFor(dx: number, dy: number): { heights: Int32Array[]; lights: Uint8Array[] } {
    const key = `${dx},${dy}`
    let cached = this.sliceCache.get(key)
    if (cached) return cached
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const heights: Int32Array[] = []
    const lights: Uint8Array[] = []
    for (let plane = 0; plane < 4; plane++) {
      const h = new Int32Array(VERTS * VERTS)
      const l = new Uint8Array(VERTS * VERTS)
      for (let x = 0; x < VERTS; x++) {
        for (let y = 0; y < VERTS; y++) {
          h[x * VERTS + y] = this.heights[plane][(baseX + x) * MVERTS + baseY + y]
          l[x * VERTS + y] = this.lights[plane][(baseX + x) * MVERTS + baseY + y]
        }
      }
      heights.push(h)
      lights.push(l)
    }
    cached = { heights, lights }
    this.sliceCache.set(key, cached)
    return cached
  }

  /** Cross-region 11×11 blurred underlay palette for one region+plane. */
  paletteFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const palette = new Int32Array(SIZE * SIZE).fill(-1)
    const fluCache = new Map<number, { hue: number; saturation: number; lightness: number; divisor: number }>()
    const compAt = (gx: number, gy: number) => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return null
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return null
      const id = terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
      if (id === 0) return null
      let c = fluCache.get(id)
      if (!c) {
        const flu = this.configs.underlays.get(id - 1)
        c = fluComponents(flu?.rgb ?? 0)
        fluCache.set(id, c)
      }
      return c
    }
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        let hue = 0, sat = 0, light = 0, div = 0, n = 0
        for (let ox = -5; ox <= 5; ox++) {
          for (let oy = -5; oy <= 5; oy++) {
            const c = compAt(baseX + x + ox, baseY + y + oy)
            if (c) {
              hue += c.hue
              sat += c.saturation
              light += c.lightness
              div += c.divisor
              n++
            }
          }
        }
        if (div > 0 && n > 0) {
          palette[x * SIZE + y] = packBlurredHsl(
            Math.trunc((hue * 256) / div),
            Math.trunc(sat / n),
            Math.trunc(light / n),
          )
        }
      }
    }
    return palette
  }
}

/** MapLoader.calculateUnderlayPalette — 11×11 box-blurred underlay HSL16 per tile. */
function computeUnderlayPalette(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const palette = new Int32Array(SIZE * SIZE).fill(-1)
  type Acc = { hue: number; sat: number; light: number; div: number; n: number }
  // Precompute per-tile components
  const comp: ({ hue: number; saturation: number; lightness: number; divisor: number } | null)[] = new Array(SIZE * SIZE).fill(null)
  const fluCache = new Map<number, { hue: number; saturation: number; lightness: number; divisor: number }>()
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const id = terrain.underlayIds[tileIndex(plane, x, y)] & 0xff
      if (id > 0) {
        let c = fluCache.get(id)
        if (!c) {
          const flu = configs.underlays.get(id - 1)
          c = fluComponents(flu?.rgb ?? 0)
          fluCache.set(id, c)
        }
        comp[x * SIZE + y] = c
      }
    }
  }
  // Direct 11×11 window sum (simple; 64×64 region is small enough)
  const acc: Acc = { hue: 0, sat: 0, light: 0, div: 0, n: 0 }
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      acc.hue = 0; acc.sat = 0; acc.light = 0; acc.div = 0; acc.n = 0
      for (let dx = -5; dx <= 5; dx++) {
        const cx = x + dx
        if (cx < 0 || cx >= SIZE) continue
        for (let dy = -5; dy <= 5; dy++) {
          const cy = y + dy
          if (cy < 0 || cy >= SIZE) continue
          const c = comp[cx * SIZE + cy]
          if (c) {
            acc.hue += c.hue
            acc.sat += c.saturation
            acc.light += c.lightness
            acc.div += c.divisor
            acc.n++
          }
        }
      }
      if (acc.div > 0 && acc.n > 0) {
        palette[x * SIZE + y] = packBlurredHsl(
          Math.trunc((acc.hue * 256) / acc.div),
          Math.trunc(acc.sat / acc.n),
          Math.trunc(acc.light / acc.n),
        )
      }
    }
  }
  return palette
}

// ---------------------------------------------------------------------------
// Texture-bucketed geometry assembly
// ---------------------------------------------------------------------------

/** Still water (rivers/sea): a self-coloured blue material with no scroll —
 *  the client animates these with its rippling-water effect; the viewer uses
 *  a gentle UV drift instead. Blue band of the 6-bit HSL16 hue wheel. */
function isWaterMaterial(meta: MaterialMeta): boolean {
  if (meta.detailsOnly || meta.colorHsl < 0) return false
  const hue = (meta.colorHsl >> 10) & 0x3f
  return hue >= 34 && hue <= 45
}

type Bucket = { positions: number[]; colors: number[]; uvs: number[]; owners: number[] }

class BucketSet {
  buckets = new Map<number, Bucket>()

  get(textureId: number): Bucket {
    let b = this.buckets.get(textureId)
    if (!b) this.buckets.set(textureId, (b = { positions: [], colors: [], uvs: [], owners: [] }))
    return b
  }

  /** One mesh with a material group per texture (index -1 = plain vertex
   *  colours). Per-triangle owner ids (whatever the producer pushed) end up
   *  in mesh.userData.triangleOwners, aligned with raycast faceIndex.
   *  Materials with a UV scroll speed get userData.scroll (client convention:
   *  offset = seconds*speed/64); still-water materials (blue-hued,
   *  non-detail, no scroll) get userData.water for the ripple drift. */
  async toMesh(
    getTexture: (id: number) => Promise<THREE.Texture | null>,
    getMeta?: (id: number) => Promise<MaterialMeta | null>,
  ): Promise<THREE.Mesh | null> {
    const entries = [...this.buckets.entries()].filter(([, b]) => b.positions.length > 0)
    if (entries.length === 0) return null
    let total = 0
    for (const [, b] of entries) total += b.positions.length / 3
    const positions = new Float32Array(total * 3)
    const colors = new Float32Array(total * 3)
    const uvs = new Float32Array(total * 2)
    const owners = new Int32Array(total / 3)
    const geometry = new THREE.BufferGeometry()
    const materials: THREE.Material[] = []
    let vert = 0
    for (const [textureId, b] of entries) {
      const count = b.positions.length / 3
      positions.set(b.positions, vert * 3)
      colors.set(b.colors, vert * 3)
      uvs.set(b.uvs, vert * 2)
      owners.set(b.owners, vert / 3)
      geometry.addGroup(vert, count, materials.length)
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      if (textureId >= 0) {
        const texture = await getTexture(textureId)
        if (texture) {
          // each animated material needs its own texture instance so offsets
          // don't leak across materials sharing a cached THREE.Texture
          const meta = getMeta ? await getMeta(textureId) : null
          const animated = meta && (meta.speedU !== 0 || meta.speedV !== 0 || isWaterMaterial(meta))
          material.map = animated ? texture.clone() : texture
          // foliage/fence textures use hard alpha cutouts
          material.alphaTest = 0.35
          material.needsUpdate = true
          if (meta && (meta.speedU !== 0 || meta.speedV !== 0)) {
            material.userData.scroll = { u: meta.speedU, v: meta.speedV }
          } else if (meta && isWaterMaterial(meta)) {
            material.userData.water = true
          }
        }
      }
      materials.push(material)
      vert += count
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    const mesh = new THREE.Mesh(geometry, materials)
    mesh.userData.triangleOwners = owners
    return mesh
  }
}

/** Bridge flag: tile columns marked 0x2 on decoded plane 1 shift down one
 *  render plane (Scene.linkBelow) — the deck decoded on plane 1 IS ground
 *  level, with the river decoded on plane 0 underneath it. */
export function isBridgeTile(terrain: MapTerrain, x: number, y: number): boolean {
  return (terrain.tileFlags[tileIndex(1, x, y)] & 0x2) !== 0
}

/** One RENDER plane's terrain as a textured, vertex-lit mesh (addRegularTile
 *  port + the client's bridge plane-shift). `pre` supplies mosaic-computed
 *  lighting/palettes per decoded plane (seam-free across regions); without it
 *  they're computed for this region alone. */
export async function buildTerrainMesh(
  terrain: MapTerrain,
  renderPlane: number,
  heightsAll: Int32Array[],
  configs: SceneConfigs,
  assets: LocAssets,
  pre?: { lights: Uint8Array[]; palettes: Int32Array[] },
): Promise<THREE.Mesh | null> {
  const lightCache: (Uint8Array | null)[] = [null, null, null, null]
  const paletteCache: (Int32Array | null)[] = [null, null, null, null]
  const lightOf = (dp: number) =>
    (lightCache[dp] ??= pre?.lights?.[dp] ?? computeVertexLight(heightsAll[dp]))
  const paletteOf = (dp: number) =>
    (paletteCache[dp] ??= pre?.palettes?.[dp] ?? computeUnderlayPalette(terrain, dp, configs))
  const buckets = new BucketSet()
  // lighting-only tint for self-coloured textures (water etc.)
  const neutral = (l: number): [number, number, number] => {
    const c = srgbToLinear(Math.min(1, (l * 2) / 255))
    return [c, c, c]
  }

  // Material metadata for every texture this plane can reference, fetched up
  // front: detailsOnly maps get tinted by the tile colour (brightness-
  // normalised by the map's average luma so the tint's own brightness is
  // preserved — the client layers detail maps neutrally in HD); textures
  // that aren't detail maps carry their own colour and only take lighting.
  const usedTextureIds = new Set<number>()
  for (const flo of configs.overlays.values()) if (flo.texture !== undefined && flo.texture >= 0) usedTextureIds.add(flo.texture)
  for (const flu of configs.underlays.values()) if (flu.texture !== undefined && flu.texture >= 0) usedTextureIds.add(flu.texture)
  const metas = new Map<number, { detailsOnly: boolean; avgLuma: number } | null>()
  await Promise.all([...usedTextureIds].map(async (id) => metas.set(id, await assets.getMaterialMeta(id))))

  function emitTile(plane: number, x: number, y: number) {
      const heights = heightsAll[plane]
      const light = lightOf(plane)
      const palette = paletteOf(plane)
      const idx = tileIndex(plane, x, y)
      const overlayId = terrain.overlayIds[idx] & 0xff
      const underlayId = terrain.underlayIds[idx] & 0xff
      const shapeRot = terrain.overlayShapeRot[idx] & 0xff
      let shape = shapeRot >> 2
      const rotation = shapeRot & 0x3
      const flo = overlayId !== 0 ? configs.overlays.get(overlayId - 1) : undefined
      const flu = underlayId !== 0 ? configs.underlays.get(underlayId - 1) : undefined
      if (shape === 0 && !flo) shape = 12
      const overlayTexture = flo?.texture !== undefined && flo.texture >= 0 ? flo.texture : -1
      const underlayTexture = flu?.texture !== undefined && flu.texture >= 0 ? flu.texture : -1
      const overlayHsl = floTileHsl(flo)
      const underlayHsl = underlayId !== 0 ? palette[x * SIZE + y] : -1
      const hasOverlay = flo !== undefined && (overlayHsl !== -1 || overlayTexture !== -1)
      const hasUnderlay = underlayId !== 0 && (underlayHsl !== -1 || underlayTexture !== -1)
      if (!hasOverlay && !hasUnderlay) return

      const overlayFaces = OVERLAY_FACE_COUNT[shape]
      const underlayFaces = UNDERLAY_FACE_COUNT[shape]
      const va = SHAPE_VERTEX_A[shape]
      const vb = SHAPE_VERTEX_B[shape]
      const vc = SHAPE_VERTEX_C[shape]

      // vertex position within tile, rotated (addRegularTile sizesX/sizesY)
      const vx = (v: number): number => {
        const dx = VERTEX_DELTA_X[v]
        const dy = VERTEX_DELTA_Y[v]
        if (rotation === 0) return dx
        if (rotation === 1) return dy
        if (rotation === 2) return 512 - dx
        return 512 - dy
      }
      const vy = (v: number): number => {
        const dx = VERTEX_DELTA_X[v]
        const dy = VERTEX_DELTA_Y[v]
        if (rotation === 0) return dy
        if (rotation === 1) return 512 - dx
        if (rotation === 2) return 512 - dy
        return dx
      }

      const emitFace = (a: number, b: number, c: number, hsl: number, textureId: number, texScale: number) => {
        const meta = textureId >= 0 ? metas.get(textureId) : null
        const bucket = buckets.get(textureId)
        bucket.owners.push(x * SIZE + y) // tile index, for terrain picking
        // detail maps modulate the tile colour; normalise by the map's own
        // average so the modulation is brightness-neutral
        const boost = textureId >= 0 && meta?.detailsOnly && hsl !== -1 ? 255 / meta.avgLuma : 1
        const useTint = textureId < 0 || (meta?.detailsOnly === true && hsl !== -1)
        for (const v of [a, b, c]) {
          const sceneX = (x << 9) + vx(v)
          const sceneY = (y << 9) + vy(v)
          const h = averageHeight(heights, sceneX, sceneY)
          bucket.positions.push(sceneX, -h, -sceneY)
          const l = Math.max(2, lightAt(light, sceneX, sceneY))
          let rgb: [number, number, number]
          if (useTint && hsl !== -1) rgb = litColor(hsl, l)
          else rgb = neutral(l)
          bucket.colors.push(rgb[0] * boost, rgb[1] * boost, rgb[2] * boost)
          // world-planar UVs: one repeat per `texScale` scene units
          bucket.uvs.push(sceneX / texScale, sceneY / texScale)
        }
      }

      let faceIdx = 0
      for (let i = 0; i < overlayFaces; i++, faceIdx++) {
        if (hasOverlay) {
          emitFace(va[faceIdx], vb[faceIdx], vc[faceIdx], overlayHsl, overlayTexture, flo?.textureScale || 512)
        }
      }
      for (let i = 0; i < underlayFaces; i++, faceIdx++) {
        if (hasUnderlay) {
          emitFace(va[faceIdx], vb[faceIdx], vc[faceIdx], underlayHsl, underlayTexture, flu?.scale || 512)
        }
      }
  }

  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (isBridgeTile(terrain, x, y)) {
        // bridge column: decoded plane renderPlane+1 draws here; render plane
        // 0 also keeps the decoded-0 river underneath the deck
        if (renderPlane === 0) emitTile(0, x, y)
        if (renderPlane + 1 < 4) emitTile(renderPlane + 1, x, y)
      } else {
        emitTile(renderPlane, x, y)
      }
    }
  }

  const mesh = await buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id))
  if (mesh) mesh.userData.isTerrain = true
  return mesh
}

// ---------------------------------------------------------------------------
// Locs
// ---------------------------------------------------------------------------

export type ObjectDefJson = {
  id: number
  shapes?: number[]
  objectModelIds?: number[][]
  sizeX?: number
  sizeY?: number
  scaleX?: number
  scaleY?: number
  scaleZ?: number
  offsetX?: number
  offsetY?: number
  offsetZ?: number
  inverted?: boolean
  originalColors?: number[]
  modifiedColors?: number[]
  originalTextureIds?: number[]
  modifiedTextureIds?: number[]
  name?: string
  soundId?: number
  ambientSoundId?: number
  soundGroupIds?: number[]
  mapCategoryId?: number
}

export type MaterialMeta = {
  detailsOnly: boolean
  avgLuma: number
  speedU: number
  speedV: number
  colorHsl: number
}

export class LocAssets {
  private root: FileSystemDirectoryHandle
  private defs = new Map<number, Promise<ObjectDefJson | null>>()
  private models = new Map<number, Promise<ModelData | null>>()
  private textures = new Map<number, Promise<THREE.Texture | null>>()
  private materialMeta = new Map<number, Promise<MaterialMeta | null>>()
  private objectsDir: FileSystemDirectoryHandle | null | undefined
  private modelsDir: FileSystemDirectoryHandle | null | undefined

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  async dispose() {
    for (const p of this.textures.values()) {
      const texture = await p.catch(() => null)
      texture?.dispose()
    }
    this.textures.clear()
  }

  /** textures/<id>/<id>.png as a repeating sRGB THREE texture. */
  getTexture(id: number): Promise<THREE.Texture | null> {
    let p = this.textures.get(id)
    if (!p) {
      p = (async () => {
        try {
          const texturesDir = await this.root.getDirectoryHandle('textures')
          const dir = await texturesDir.getDirectoryHandle(String(id))
          const file = await (await dir.getFileHandle(`${id}.png`)).getFile()
          const bitmap = await createImageBitmap(file)
          const texture = new THREE.Texture(bitmap)
          texture.wrapS = THREE.RepeatWrapping
          texture.wrapT = THREE.RepeatWrapping
          texture.colorSpace = THREE.SRGBColorSpace
          texture.needsUpdate = true
          return texture
        } catch {
          return null
        }
      })()
      this.textures.set(id, p)
    }
    return p
  }

  /** Material metadata: detailsOnly (greyscale detail map tinted by the tile
   *  colour) vs self-coloured, the PNG's average luma for brightness
   *  normalisation, UV scroll speed (waterfalls/lava — client scrolls
   *  offset = seconds*speed/64), and the material's average HSL (used to
   *  recognise still water for the ripple drift). */
  getMaterialMeta(id: number): Promise<MaterialMeta | null> {
    let p = this.materialMeta.get(id)
    if (!p) {
      p = (async () => {
        try {
          let detailsOnly = false
          let speedU = 0
          let speedV = 0
          let colorHsl = -1
          try {
            const defsDir = await this.root.getDirectoryHandle('texture_definitions')
            const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
            const def = JSON.parse(await file.text())
            detailsOnly = def.detailsOnly === true
            speedU = def.textureSpeedU ?? 0
            speedV = def.textureSpeedV ?? 0
            colorHsl = def.colorHsl ?? -1
          } catch { /* definition missing — treat as self-coloured */ }
          let avgLuma = 128
          try {
            const texturesDir = await this.root.getDirectoryHandle('textures')
            const dir = await texturesDir.getDirectoryHandle(String(id))
            const file = await (await dir.getFileHandle(`${id}.png`)).getFile()
            const bitmap = await createImageBitmap(file)
            const size = 16
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(bitmap, 0, 0, size, size)
            bitmap.close()
            const px = ctx.getImageData(0, 0, size, size).data
            let sum = 0, n = 0
            for (let i = 0; i < px.length; i += 4) {
              if (px[i + 3] === 0) continue
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3
              n++
            }
            if (n > 0) avgLuma = sum / n
          } catch { /* keep default */ }
          return { detailsOnly, avgLuma: Math.max(32, avgLuma), speedU, speedV, colorHsl }
        } catch {
          return null
        }
      })()
      this.materialMeta.set(id, p)
    }
    return p
  }

  async getDef(id: number): Promise<ObjectDefJson | null> {
    let p = this.defs.get(id)
    if (!p) {
      p = (async () => {
        try {
          if (this.objectsDir === undefined) {
            this.objectsDir = await resolveEntryHandle(this.root, getEntryPath('objects'))
          }
          if (!this.objectsDir) return null
          const file = await (await this.objectsDir.getFileHandle(`${id}.json`)).getFile()
          return JSON.parse(await file.text()) as ObjectDefJson
        } catch {
          return null
        }
      })()
      this.defs.set(id, p)
    }
    return p
  }

  async getModel(id: number): Promise<ModelData | null> {
    let p = this.models.get(id)
    if (!p) {
      p = (async () => {
        try {
          if (this.modelsDir === undefined) {
            this.modelsDir = await resolveEntryHandle(this.root, getEntryPath('models'))
          }
          if (!this.modelsDir) return null
          const sub = await this.modelsDir.getDirectoryHandle(String(id))
          const file = await (await sub.getFileHandle('model.dat')).getFile()
          return parseModel(new Uint8Array(await file.arrayBuffer()), id)
        } catch {
          return null
        }
      })()
      this.models.set(id, p)
    }
    return p
  }
}

// Marker locs use tiny models painted entirely in one sentinel colour:
// teal HSL16 29113 (ambient-sound emitters, map-icon anchors) or green 20287
// (invisible barrier walls, e.g. bridge edges). No hide flag exists in the
// mesh or the def; the shipped client simply never shows them. Their quads
// are replaced with floating editor markers (MarkerInfo/buildMarkersMesh).
const MARKER_HSLS = new Set([29113, 20287])
const BARRIER_HSL = 20287
function isMarkerModel(model: ModelData): boolean {
  if (model.faceCount === 0 || model.faceCount > 4) return false
  for (let f = 0; f < model.faceCount; f++) {
    if (!MARKER_HSLS.has(model.faceColor[f] & 0xffff)) return false
  }
  return true
}

/** Accumulates transformed model triangles into texture buckets. */
class ModelAccumulator {
  buckets = new BucketSet()
  private uvWriters = new WeakMap<ModelData, UVWriter>()
  private uvScratch = new Float32Array(6)

  addModel(model: ModelData, matrix: THREE.Matrix4, owner = -1) {
    const upscale = model.version < 13 ? 4 : 1
    const v = new THREE.Vector3()
    let uvWriter = this.uvWriters.get(model)
    if (!uvWriter) this.uvWriters.set(model, (uvWriter = makeUVWriter(model)))
    for (let f = 0; f < model.faceCount; f++) {
      if (model.faceAlpha[f] === -1) continue
      const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
      if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
      const textureId = model.faceTextures?.[f] ?? -1
      const bucket = this.buckets.get(textureId)
      bucket.owners.push(owner)
      if (textureId >= 0) {
        uvWriter(f, ia, ib, ic, this.uvScratch, 0)
        bucket.uvs.push(...this.uvScratch)
      } else {
        bucket.uvs.push(0, 0, 0, 0, 0, 0)
      }
      // face colour tints the material texture — the dumped material PNGs are
      // (mostly) greyscale detail maps the client multiplies by face HSL
      const rgb = hslToRgb(model.faceColor[f] & 0xffff)
      const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
      const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
      const b = srgbToLinear((rgb & 0xff) / 255)
      for (const vi of [ia, ib, ic]) {
        v.set(model.vertexX[vi] * upscale, -model.vertexY[vi] * upscale, -model.vertexZ[vi] * upscale)
        v.applyMatrix4(matrix)
        bucket.positions.push(v.x, v.y, v.z)
        bucket.colors.push(r, g, b)
      }
    }
  }
}

/** An invisible utility loc (sound emitter / map-icon anchor) worth showing
 *  as an editor marker instead of its teal quad. Scene-local coordinates. */
export type MarkerInfo = {
  x: number
  y: number
  z: number
  objectId: number
  kind: 'sound' | 'mapicon' | 'barrier' | 'other'
  tileX: number
  tileY: number
}

/** One placed loc in a merged mesh, for click-picking via triangleOwners. */
export type LocRef = {
  objectId: number
  shape: number
  rotation: number
  x: number
  y: number
  plane: number
}

export const MARKER_COLORS: Record<MarkerInfo['kind'], number> = {
  sound: 0xff9d3a, // orange — ambient sound emitters
  mapicon: 0xb47aff, // violet — map icon anchors
  barrier: 0xff5a5a, // red — invisible barrier walls
  other: 0xe8e8e8,
}

/** Floating diamond per marker (one merged mesh per kind), plus a thin stem
 *  down to the ground so the anchor tile is obvious. */
export function buildMarkersMesh(markers: MarkerInfo[]): THREE.Group | null {
  if (markers.length === 0) return null
  const group = new THREE.Group()
  const SIZE_U = 52
  const FLOAT = 140
  // octahedron vertex/face template
  const o = [
    [SIZE_U, 0, 0], [-SIZE_U, 0, 0], [0, SIZE_U, 0], [0, -SIZE_U, 0], [0, 0, SIZE_U], [0, 0, -SIZE_U],
  ]
  const faces = [
    [2, 0, 4], [2, 4, 1], [2, 1, 5], [2, 5, 0],
    [3, 4, 0], [3, 1, 4], [3, 5, 1], [3, 0, 5],
  ]
  const byKind = new Map<MarkerInfo['kind'], MarkerInfo[]>()
  for (const m of markers) {
    let arr = byKind.get(m.kind)
    if (!arr) byKind.set(m.kind, (arr = []))
    arr.push(m)
  }
  for (const [kind, list] of byKind) {
    const positions: number[] = []
    for (const m of list) {
      const cy = m.y + FLOAT
      for (const [a, b, c] of faces) {
        positions.push(
          m.x + o[a][0], cy + o[a][1], m.z + o[a][2],
          m.x + o[b][0], cy + o[b][1], m.z + o[b][2],
          m.x + o[c][0], cy + o[c][1], m.z + o[c][2],
        )
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    const diamonds = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: MARKER_COLORS[kind] }))
    // 8 triangles per diamond → raycast faceIndex >> 3 indexes this list
    diamonds.userData.markers = list
    group.add(diamonds)

    const stems: number[] = []
    for (const m of list) stems.push(m.x, m.y, m.z, m.x, m.y + FLOAT, m.z)
    const stemGeometry = new THREE.BufferGeometry()
    stemGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stems), 3))
    group.add(new THREE.LineSegments(stemGeometry, new THREE.LineBasicMaterial({ color: MARKER_COLORS[kind], transparent: true, opacity: 0.6 })))
  }
  return group
}

/** A terrain-following outline around one region's perimeter (plane-0
 *  heights), floated slightly above ground — shows where regions meet. */
export function buildRegionOutline(heights: Int32Array, color = 0x2f8fff): THREE.Line {
  const LIFT = 24
  const points: number[] = []
  const push = (tx: number, ty: number) => {
    points.push(tx * 512, -heights[tx * VERTS + ty] + LIFT, -(ty * 512))
  }
  for (let x = 0; x <= SIZE; x++) push(x, 0)
  for (let y = 1; y <= SIZE; y++) push(SIZE, y)
  for (let x = SIZE - 1; x >= 0; x--) push(x, SIZE)
  for (let y = SIZE - 1; y >= 0; y--) push(0, y)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }))
}

/** All placed locs of one plane merged into one textured mesh. */
export async function buildLocsMesh(
  terrain: MapTerrain,
  objects: [number, number, number, number, number, number][],
  renderPlane: number,
  heightsAll: Int32Array[],
  assets: LocAssets,
  onProgress?: (done: number, total: number) => void,
): Promise<{ mesh: THREE.Mesh | null; markers: MarkerInfo[] }> {
  const acc = new ModelAccumulator()
  const markers: MarkerInfo[] = []
  const locRefs: LocRef[] = []
  // bridge columns shift down one render plane (deck = ground level)
  const planeObjects = objects.filter(([, , , x, y, p]) => {
    const bridge = x >= 0 && y >= 0 && x < SIZE && y < SIZE && isBridgeTile(terrain, x, y)
    return (bridge ? Math.max(p - 1, 0) : p) === renderPlane
  })
  let done = 0
  for (const [objectId, shape, rotation, x, y, decodedPlane] of planeObjects) {
    const heights = heightsAll[decodedPlane]
    done++
    if (onProgress && done % 64 === 0) onProgress(done, planeObjects.length)
    const def = await assets.getDef(objectId)
    if (!def || !def.objectModelIds || def.objectModelIds.length === 0) continue

    // model list for this loc shape (ObjectType: shapes[] parallel to objectModelIds[])
    let shapeIdx = def.shapes ? def.shapes.indexOf(shape) : -1
    if (shapeIdx === -1) {
      // wall decorations reuse shape 4's models for 5-8, and everything falls
      // back to the first entry rather than vanishing
      if (def.shapes && shape >= 5 && shape <= 8) shapeIdx = def.shapes.indexOf(4)
      if (shapeIdx === -1) shapeIdx = 0
    }
    const modelIds = def.objectModelIds[Math.min(shapeIdx, def.objectModelIds.length - 1)]
    if (!modelIds || modelIds.length === 0) continue

    // SceneGraph.addObject: swap footprint for rotations 1/3, centre + average height
    const sizeX = (rotation === 1 || rotation === 3 ? def.sizeY : def.sizeX) ?? 1
    const sizeY = (rotation === 1 || rotation === 3 ? def.sizeX : def.sizeY) ?? 1
    const xA = x + (sizeX >> 1)
    const xB = x + ((sizeX + 1) >> 1)
    const yA = y + (sizeY >> 1)
    const yB = y + ((sizeY + 1) >> 1)
    // clamped: border-ring locs from neighbour regions sit at tile -1 / 64
    const hAt = (tx: number, ty: number) =>
      heights[Math.min(Math.max(tx, 0), VERTS - 1) * VERTS + Math.min(Math.max(ty, 0), VERTS - 1)]
    const avgHeight = (hAt(xA, yA) + hAt(xB, yA) + hAt(xA, yB) + hAt(xB, yB)) >> 2
    const sceneX = (x << 9) + (sizeX << 8)
    const sceneY = (y << 9) + (sizeY << 8)

    // ObjectType.getStationaryModel applies, in model space and this order:
    // mirror (negate RS z) → rotate 90°·r (RS x'=x·cos+z·sin ⇒ three −θ) →
    // scale (resizeX/Y/Z) → translate (offsetX/Y/Z). A whole-corner wall
    // (shape 2) is TWO pieces: mirrored at `rotation`, plain at `rotation+1`.
    const pieces: { rot: number; mirror: boolean }[] =
      shape === 2
        ? [{ rot: rotation, mirror: true }, { rot: (rotation + 1) & 0x3, mirror: false }]
        : [{ rot: rotation, mirror: def.inverted ?? false }]

    let markerModels = 0
    let markerIsBarrier = false
    for (const piece of pieces) {
      const matrix = new THREE.Matrix4().makeTranslation(sceneX, -avgHeight, -sceneY)
      if (def.offsetX || def.offsetY || def.offsetZ) {
        matrix.multiply(new THREE.Matrix4().makeTranslation(def.offsetX ?? 0, -(def.offsetY ?? 0), -(def.offsetZ ?? 0)))
      }
      const scaleX = (def.scaleX ?? 128) / 128
      const scaleY = (def.scaleY ?? 128) / 128
      const scaleZ = (def.scaleZ ?? 128) / 128
      if (scaleX !== 1 || scaleY !== 1 || scaleZ !== 1) {
        matrix.multiply(new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ))
      }
      if (piece.rot !== 0) {
        matrix.multiply(new THREE.Matrix4().makeRotationY(-(piece.rot * Math.PI) / 2))
      }
      if (piece.mirror) {
        matrix.multiply(new THREE.Matrix4().makeScale(1, 1, -1))
      }

      for (const modelId of modelIds) {
        const model = await assets.getModel(modelId)
        if (!model) continue
        if (isMarkerModel(model)) {
          markerModels++
          if ((model.faceColor[0] & 0xffff) === BARRIER_HSL) markerIsBarrier = true
          continue
        }
        let m = model
        if (def.originalColors?.length || def.originalTextureIds?.length) {
          // applyRecolor mutates — work on a shallow copy of the colour array
          m = { ...model, faceColor: model.faceColor.slice() }
          applyRecolor(m, def.originalColors ?? [], def.modifiedColors ?? [], def.originalTextureIds ?? [], def.modifiedTextureIds ?? [])
        }
        acc.addModel(m, matrix, locRefs.length)
      }
    }
    locRefs.push({ objectId, shape, rotation, x, y, plane: decodedPlane })

    if (markerModels > 0) {
      const kind: MarkerInfo['kind'] =
        def.soundId !== undefined || def.ambientSoundId !== undefined || (def.soundGroupIds?.length ?? 0) > 0
          ? 'sound'
          : def.mapCategoryId !== undefined && def.mapCategoryId >= 0
            ? 'mapicon'
            : markerIsBarrier
              ? 'barrier'
              : 'other'
      markers.push({ x: sceneX, y: -avgHeight, z: -sceneY, objectId, kind, tileX: x, tileY: y })
    }
  }
  const mesh = await acc.buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id))
  if (mesh) mesh.userData.locs = locRefs
  return { mesh, markers }
}
