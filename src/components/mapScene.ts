import * as THREE from 'three'
import type { MapTerrain } from '../loaders/maps'
import { SIZE, tileIndex } from '../loaders/maps'
import type { ModelData } from '../loaders/models'
import { hslToRgb, parseModel, applyRecolor, computeModelLitRgb, modelUpscale, upscaleModel, DEFAULT_MODEL_SUN, type ModelSun, type PointLight } from '../loaders/models'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { makeUVWriter } from './modelUVs'
import type { UVWriter } from './modelUVs'
import type { PosedVertices } from '../loaders/skeletalAnimation'

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

/** ColorUtil.blend — interpolate two packed HSL16 colours, factor 0-128. */
function blendHsl16(colorA: number, colorB: number, factor: number): number {
  if (colorA === colorB) return colorA
  const inv = 128 - factor
  const light = (inv * (colorA & 0x7f) + factor * (colorB & 0x7f)) >> 7
  const sat = (inv * (colorA & 0x380) + factor * (colorB & 0x380)) >> 7
  const hue = (inv * (colorA & 0xfc00) + factor * (colorB & 0xfc00)) >> 7
  return (hue & 0xfc00) | (sat & 0x380) | (light & 0x7f)
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Binary-alpha cutout for effectCombiner-1 materials: black texels → fully
 *  transparent, everything else opaque (client getTextureForMaterial). Turns an
 *  opaque foliage PNG into a see-through leaf/fence texture. */
function binaryAlphaTexture(bitmap: ImageBitmap): THREE.CanvasTexture {
  const w = bitmap.width, h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] < 8) d[i + 3] = 0 // near-black → transparent
  }
  ctx.putImageData(img, 0, 0)
  return new THREE.CanvasTexture(canvas)
}

/** Final per-vertex ground colour (GroundGL): two stages — (1) scale the tile
 *  colour's HSL lightness by `lightStrength/128` (ambient 74 minus static shadow,
 *  the source of the ground's shading), then (2) multiply the resulting RGB by
 *  the directional sun multiplier. Both clamped like the client. */
function litColor(hsl: number, mul: number): [number, number, number] {
  const rgb = hslToRgb(hsl)
  return [
    srgbToLinear(Math.min(1, (((rgb >> 16) & 0xff) / 255) * mul)),
    srgbToLinear(Math.min(1, (((rgb >> 8) & 0xff) / 255) * mul)),
    srgbToLinear(Math.min(1, ((rgb & 0xff) / 255) * mul)),
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

// MapLoader.OVERLAY_SHAPE_SUPPORTS_HEIGHT — per shape, which vertex ids (in
// UNROTATED shape space) belong to the overlay portion of the tile.
const OVERLAY_SHAPE_COVERS: boolean[][] = [
  [true, true, true, true, true, true, true, true, true, true, true, true, true],
  [true, true, true, false, false, false, true, true, false, false, false, false, true],
  [true, false, false, false, false, true, true, true, false, false, false, false, false],
  [false, false, true, true, true, true, false, false, false, false, false, false, false],
  [true, true, true, true, true, true, false, false, false, false, false, false, false],
  [true, true, true, false, false, true, true, true, false, false, false, false, false],
  [true, true, false, false, false, true, true, true, false, false, false, false, true],
  [true, true, false, false, false, false, false, true, false, false, false, false, false],
  [false, true, true, true, true, true, true, true, false, false, false, false, false],
  [true, false, false, false, true, true, true, true, true, true, false, false, false],
  [true, true, true, true, true, false, false, false, true, true, false, false, false],
  [true, true, true, false, false, false, false, false, false, false, true, true, false],
  [false, false, false, false, false, false, false, false, false, false, false, false, false],
  [true, true, true, true, true, true, true, true, true, true, true, true, true],
  [false, false, false, false, false, false, false, false, false, false, false, false, false],
]

/** Does a tile's overlay (shape+rotation) cover the tile corner? Corner ids
 *  in position space: 0=SW(0,0), 2=SE(512,0), 4=NE(512,512), 6=NW(0,512);
 *  the client's rotation algebra maps a position back to the unrotated
 *  vertex id as (corner + 2·rotation) & 7. */
function overlayCoversCorner(shape: number, rotation: number, cornerId: number): boolean {
  return OVERLAY_SHAPE_COVERS[shape]?.[(cornerId + 2 * rotation) & 0x7] === true
}

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
  /** layering priority for corner-colour blending between overlays. */
  slot?: number
}

export type SceneConfigs = {
  underlays: Map<number, FluJson>
  overlays: Map<number, FloJson>
}

/** Does this overlay's colour bleed into neighbouring ground vertices? */
function isCornerBlendable(flo: FloJson | undefined): boolean {
  return flo !== undefined && flo.blendsWithUnderlay === true
}

/** Client slot priority is a composite: (slot << 8) | overlayId (FloType.postDecode). */
function floSlotKey(flo: FloJson, id: number): number {
  return ((flo.slot ?? 8) << 8) | id
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

// The map dumper's hand-made 4×4 overlay pixel masks (cryogen-website
// MapImageDumper/MapConstants.TILE_SHAPES) — row-major with rows TOP-DOWN
// (canvas order), indexed by overlay shape 0-11; TILE_ROTATIONS permutes
// pixel indices per rotation. Missing shapes fall back to a full square.
const DUMP_TILE_SHAPES: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
]
const DUMP_TILE_ROTATIONS: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [12, 8, 4, 0, 13, 9, 5, 1, 14, 10, 6, 2, 15, 11, 7, 3],
  [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  [3, 7, 11, 15, 2, 6, 10, 14, 1, 5, 9, 13, 0, 4, 8, 12],
]

/** Map-style minimap ground for one region+plane, 4px per tile — ported from
 *  cryogen-website's MapImageDumper (the /map route): per-tile underlay RGBs
 *  box-blurred in plain RGB space (no lighting/shadows/HSL — the clean
 *  classic map look, with no quantisation steps to see), then overlays
 *  painted flat through the dumper's hand-made pixel masks. Bridge tiles
 *  (linked/visible-below on the plane above) draw the plane-above overlay.
 *  `blurred` comes from SceneMosaic.underlayRgbBlurFor (cross-region, so no
 *  seams at region borders). 256×256 RGBA. */
export async function renderMinimapGround(
  terrain: MapTerrain,
  configs: SceneConfigs,
  plane: number,
  blurred: Int32Array,
  assets: LocAssets,
): Promise<Uint8ClampedArray> {
  const W = SIZE * 4
  const out = new Uint8ClampedArray(W * W * 4)

  // per-overlay colour — the dumper's getOverlayRGB rule: colorRgb unless
  // invalid (absent/0/-1/magenta), else minimapColorRgb; the texture's
  // average colour only when still unresolved
  const invalidCol = (c: number | undefined): boolean => c === undefined || c === 0 || c === -1 || c === NO_COLOR
  const overlayCol = new Map<number, number>()
  const overlayIdsUsed = new Set<number>()
  for (let i = 0; i < terrain.overlayIds.length; i++) {
    const id = terrain.overlayIds[i] & 0xff
    if (id !== 0) overlayIdsUsed.add(id)
  }
  for (const id of overlayIdsUsed) {
    const flo = configs.overlays.get(id - 1)
    let col = !flo || invalidCol(flo.colorRgb) ? (flo?.minimapColorRgb ?? -1) : flo.colorRgb!
    if (invalidCol(col)) col = 0
    if (col === 0 && flo?.texture !== undefined && flo.texture >= 0) {
      const meta = await assets.getMaterialMeta(flo.texture)
      if (meta && meta.avgRgb !== -1) col = meta.avgRgb
    }
    overlayCol.set(id, col)
  }

  // ground: the blurred underlay colour, flat per tile (empty tiles stay black)
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const rgb = blurred[x * SIZE + y]
      const rowBase = (SIZE - 1 - y) * 4 // north up
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const o = ((rowBase + py) * W + x * 4 + px) * 4
          if (rgb >= 0) {
            out[o] = (rgb >> 16) & 0xff
            out[o + 1] = (rgb >> 8) & 0xff
            out[o + 2] = rgb & 0xff
          }
          out[o + 3] = 255
        }
      }
    }
  }

  // overlays through the dumper masks (rows are canvas top-down)
  const drawOverlay = (x: number, y: number, p: number) => {
    const idx = tileIndex(p, x, y)
    const overlayId = terrain.overlayIds[idx] & 0xff
    if (overlayId === 0) return
    const col = overlayCol.get(overlayId) ?? 0
    // fully colourless overlays (e.g. the invisible plane-1 marker overlay
    // 42, all channels magenta) — the dumper paints these black, but the
    // ground showing through is what the client does
    if (col === 0) return
    const shapeRot = terrain.overlayShapeRot[idx] & 0xff
    const shapeMask = DUMP_TILE_SHAPES[shapeRot >> 2]
    const rotIdx = DUMP_TILE_ROTATIONS[shapeRot & 0x3]
    const rowBase = (SIZE - 1 - y) * 4
    for (let si = 0; si < 16; si++) {
      if (shapeMask !== undefined && shapeMask[rotIdx[si]] === 0) continue
      const o = ((rowBase + (si >> 2)) * W + x * 4 + (si & 0x3)) * 4
      out[o] = (col >> 16) & 0xff
      out[o + 1] = (col >> 8) & 0xff
      out[o + 2] = col & 0xff
      out[o + 3] = 255
    }
  }
  // linked below (0x2, bridges) or visible below (0x8)
  const belowFlagged = (p: number, x: number, y: number) => (terrain.tileFlags[tileIndex(p, x, y)] & 0xa) !== 0
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (plane === 0 || !belowFlagged(plane, x, y)) drawOverlay(x, y, plane)
      if (plane < 3 && belowFlagged(plane + 1, x, y)) drawOverlay(x, y, plane + 1)
    }
  }
  return out
}

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

/** Per-vertex water depth grid from the underwater ("um") terrain: the um
 *  explicit-height value (client units, heightValue*32) at each vertex corner,
 *  0 where absent. This is the riverbed's downward offset from the water
 *  surface — the client's texcoord0.z that drives shoreFactor. */
export function computeWaterDepth(underwater: MapTerrain): Int32Array[] {
  const presence = underwater.heightPresence
  const values = underwater.heightValue
  const planes: Int32Array[] = []
  for (let plane = 0; plane < 4; plane++) {
    const depth = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const tx = Math.min(x, SIZE - 1)
        const ty = Math.min(y, SIZE - 1)
        const idx = tileIndex(plane, tx, ty)
        const hasHeight = (presence[idx >> 3] & (1 << (idx & 0x7))) !== 0
        // um heights are stored positive = downward depth (client i_13*8 << 2).
        depth[x * VERTS + y] = hasHeight ? ((values[idx] & 0xff) * 8) << 2 : 0
      }
    }
    planes.push(depth)
  }
  return planes
}

/** Riverbed vertex heights = surface height + water depth (deeper = more
 *  positive in the decode convention, i.e. lower once rendered as Y = -h).
 *  Feeding these to buildTerrainMesh with the underwater terrain draws the
 *  submerged bed beneath the transparent water. */
export function computeRiverbedHeights(surface: Int32Array[], depth: Int32Array[]): Int32Array[] {
  return surface.map((plane, p) => {
    const out = new Int32Array(plane.length)
    for (let i = 0; i < plane.length; i++) out[i] = plane[i] + depth[p][i]
    return out
  })
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

/** Region sun parameters (from the map environment tail), client defaults. */
export type SunConfig = {
  /** RS-space direction, environment `sunPosition` (client shifts <<2). */
  x: number
  y: number
  z: number
  /** environment sunAmbient — client: intensity = (0.7 + brightness·0.1) · ambient · 65535 */
  ambient: number
}

export const DEFAULT_SUN: SunConfig = { x: -50, y: -60, z: -50, ambient: 1.1523438 }

// HD ground lighting — the client (OpenGLGround) uploads a per-vertex surface
// NORMAL (from the height gradient) and lights it with the SAME scene shader as
// models: the half-Lambert of the dumped "Model" GLSL. So the ground light is a
// float multiplier per vertex, `hl·(sunColour + 0.5·ambient) + 0.5·ambient`, with
// `hl = clamp(dot(groundNormal, sunDir)·0.5 + 0.5, 0, 1)`. Static shadows are a
// separate multiply (baked into the client's ground vertex colour). Gray sun/
// ambient (DEFAULT_MODEL_SUN) so a single scalar multiplier suffices for terrain.
const GROUND_SUN_GRAY = (DEFAULT_MODEL_SUN.sunColour[0] + DEFAULT_MODEL_SUN.sunColour[1] + DEFAULT_MODEL_SUN.sunColour[2]) / 3
const GROUND_AMB_GRAY = (DEFAULT_MODEL_SUN.ambientColour[0] + DEFAULT_MODEL_SUN.ambientColour[1] + DEFAULT_MODEL_SUN.ambientColour[2]) / 3
function computeVertexLightGrid(heights: Int32Array, verts: number, _sun: SunConfig = DEFAULT_SUN): Float32Array {
  const sl = Math.hypot(DEFAULT_MODEL_SUN.dir[0], DEFAULT_MODEL_SUN.dir[1], DEFAULT_MODEL_SUN.dir[2]) || 1
  const sdx = DEFAULT_MODEL_SUN.dir[0] / sl, sdy = DEFAULT_MODEL_SUN.dir[1] / sl, sdz = DEFAULT_MODEL_SUN.dir[2] / sl
  const light = new Float32Array(verts * verts)
  for (let x = 0; x < verts; x++) {
    for (let y = 0; y < verts; y++) {
      // client computes 1..size-1 only; clamp neighbours so edges get lit too
      const xm = Math.max(x - 1, 0), xp = Math.min(x + 1, verts - 1)
      const ym = Math.max(y - 1, 0), yp = Math.min(y + 1, verts - 1)
      const dhx = heights[xp * verts + y] - heights[xm * verts + y]
      const dhy = heights[x * verts + yp] - heights[x * verts + ym]
      // GL ground normal from the height surface (positions are (x, −h, −y)):
      // n = normalize(dhx, 1024, −dhy) → flat ground points +y (up).
      const len = Math.hypot(dhx, 1024, dhy) || 1
      const nx = dhx / len, ny = 1024 / len, nz = -dhy / len
      const hl = Math.min(1, Math.max(0, (sdx * nx + sdy * ny + sdz * nz) * 0.5 + 0.5))
      light[x * verts + y] = hl * (GROUND_SUN_GRAY + GROUND_AMB_GRAY * 0.5) + GROUND_AMB_GRAY * 0.5
    }
  }
  return light
}

function computeVertexLight(heights: Int32Array): Float32Array {
  return computeVertexLightGrid(heights, VERTS)
}

/** Bilinear brightness multiplier at 512-scale coords (GL ground vertex light). */
function lightAt(light: Float32Array, sceneX: number, sceneY: number): number {
  const tileX = Math.min(sceneX >> 9, VERTS - 2)
  const tileY = Math.min(sceneY >> 9, VERTS - 2)
  const offX = sceneX & 511
  const offY = sceneY & 511
  const la = light[(tileX + 1) * VERTS + tileY] * offX + light[tileX * VERTS + tileY] * (512 - offX)
  const lb = light[tileX * VERTS + tileY + 1] * (512 - offX) + light[(tileX + 1) * VERTS + tileY + 1] * offX
  return (la * (512 - offY) + lb * offY) / (512 * 512)
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
  private lights: Float32Array[] = []
  private sliceCache = new Map<string, { heights: Int32Array[]; lights: Float32Array[] }>()
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
    sun: SunConfig = DEFAULT_SUN,
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
      this.lights.push(computeVertexLightGrid(h, MVERTS, sun))
    }
  }

  /** 65×65 per-plane height slices for one region (region-local layout). */
  slicesFor(dx: number, dy: number): { heights: Int32Array[]; lights: Float32Array[] } {
    const key = `${dx},${dy}`
    let cached = this.sliceCache.get(key)
    if (cached) return cached
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const heights: Int32Array[] = []
    const lights: Float32Array[] = []
    for (let plane = 0; plane < 4; plane++) {
      const h = new Int32Array(VERTS * VERTS)
      const l = new Float32Array(VERTS * VERTS)
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

  /** Cross-region 11×11 blurred underlay palette for one region+plane.
   *  65×65 (VERTS²): entry [x][y] is the blur centred on tile (x, y), with
   *  the 65th row/column sampled from the neighbouring region — tile corner
   *  vertices blend between the palettes of the 4 tiles meeting there
   *  (addUnderlayTiles), so consumers need one tile beyond the region. */
  paletteFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const palette = new Int32Array(VERTS * VERTS).fill(-1)
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
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
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
          palette[x * VERTS + y] = packBlurredHsl(
            Math.trunc((hue * 256) / div),
            Math.trunc(sat / n),
            Math.trunc(light / n),
          )
        }
      }
    }
    return palette
  }

  /** Cross-region blendable-overlay corner field (VERTS²): for each tile
   *  corner, the id of the highest-slot `blendsWithUnderlay` overlay whose
   *  shape covers that corner among the 4 tiles meeting there, or -1. Ground
   *  vertices at these corners take the overlay's colour instead of the
   *  blurred palette (the client's calculateOverlayDisplay slot machinery) —
   *  this is what melts roads/mud patches into the surrounding ground. */
  overlayCornerFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(VERTS * VERTS).fill(-1)
    const tileAt = (gx: number, gy: number): number => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return 0
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return 0
      const idx = tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)
      const oid = terrain.overlayIds[idx] & 0xff
      if (oid === 0) return 0
      // pack id + shapeRot so the caller-side check has both
      return oid | ((terrain.overlayShapeRot[idx] & 0xff) << 8)
    }
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const gx = baseX + x
        const gy = baseY + y
        let best = -1
        let bestSlot = -Infinity
        // (tile dx, tile dy, corner id of this vertex within that tile)
        const candidates: [number, number, number][] = [
          [gx - 1, gy - 1, 4], // vertex is that tile's NE corner
          [gx, gy - 1, 6],     // NW
          [gx - 1, gy, 2],     // SE
          [gx, gy, 0],         // SW
        ]
        for (const [tx, ty, corner] of candidates) {
          const packed = tileAt(tx, ty)
          if (packed === 0) continue
          const oid = packed & 0xff
          const flo = this.configs.overlays.get(oid - 1)
          if (!flo || !isCornerBlendable(flo)) continue
          const shapeRot = packed >> 8
          if (!overlayCoversCorner(shapeRot >> 2, shapeRot & 0x3, corner)) continue
          const slot = floSlotKey(flo, oid)
          if (slot >= bestSlot) {
            bestSlot = slot
            best = oid
          }
        }
        out[x * VERTS + y] = best
      }
    }
    return out
  }

  /** Per-tile underlay RGB box-blurred in plain RGB space — the map dumper's
   *  blendUnderlay (cryogen-website MapImageDumper), with its exact window
   *  (canvas [-3,+2] each axis → tile x [-3,+2], tile y [-2,+3]) and its
   *  skip-empties rule, but sampling neighbour regions through the mosaic so
   *  region borders don't seam. -1 = tile has no underlay (stays black). */
  underlayRgbBlurFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(SIZE * SIZE).fill(-1)
    const rgbCache = new Map<number, number>()
    const rgbAt = (gx: number, gy: number): number => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return -1
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return -1
      const id = terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
      if (id === 0) return -1
      let c = rgbCache.get(id)
      if (c === undefined) {
        c = this.configs.underlays.get(id - 1)?.rgb ?? -1
        rgbCache.set(id, c)
      }
      return c
    }
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        // (the dumper skips tiles with no own underlay, leaving black
        // pinholes under some trees — averaging the window regardless fills
        // them with the surrounding ground instead)
        let r = 0, g = 0, b = 0, n = 0
        for (let ox = -3; ox <= 2; ox++) {
          for (let oy = -2; oy <= 3; oy++) {
            const c = rgbAt(baseX + x + ox, baseY + y + oy)
            if (c === -1) continue
            r += (c >> 16) & 0xff
            g += (c >> 8) & 0xff
            b += c & 0xff
            n++
          }
        }
        if (n > 0) out[x * SIZE + y] = (Math.trunc(r / n) << 16) | (Math.trunc(g / n) << 8) | Math.trunc(b / n)
      }
    }
    return out
  }

  /** Cross-region per-tile underlay ids at 65×65 (the 65th row/column from
   *  the neighbouring region) — each terrain vertex renders the TEXTURE of
   *  the tile whose origin sits at that corner (addUnderlayTiles), which the
   *  splatting passes crossfade between. */
  underlayCornerFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const gx = Math.min(baseX + x, MOSAIC - 1)
        const gy = Math.min(baseY + y, MOSAIC - 1)
        const rdx = Math.floor(gx / SIZE)
        const rdy = Math.floor(gy / SIZE)
        const terrain = this.regions[rdx]?.[rdy]
        out[x * VERTS + y] = terrain
          ? terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
          : 0
      }
    }
    return out
  }
}

/** Single-region fallback of SceneMosaic.underlayCornerFor (edges clamp). */
function computeUnderlayCornerIds(terrain: MapTerrain, plane: number): Int32Array {
  const out = new Int32Array(VERTS * VERTS)
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      const tx = Math.min(x, SIZE - 1)
      const ty = Math.min(y, SIZE - 1)
      out[x * VERTS + y] = terrain.underlayIds[tileIndex(plane, tx, ty)] & 0xff
    }
  }
  return out
}

/** Single-region fallback of SceneMosaic.overlayCornerFor (edges clamp). */
function computeOverlayCorners(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const out = new Int32Array(VERTS * VERTS).fill(-1)
  const tileAt = (tx: number, ty: number): number => {
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return 0
    const idx = tileIndex(plane, tx, ty)
    const oid = terrain.overlayIds[idx] & 0xff
    if (oid === 0) return 0
    return oid | ((terrain.overlayShapeRot[idx] & 0xff) << 8)
  }
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      let best = -1
      let bestSlot = -Infinity
      const candidates: [number, number, number][] = [
        [x - 1, y - 1, 4],
        [x, y - 1, 6],
        [x - 1, y, 2],
        [x, y, 0],
      ]
      for (const [tx, ty, corner] of candidates) {
        const packed = tileAt(tx, ty)
        if (packed === 0) continue
        const oid = packed & 0xff
        const flo = configs.overlays.get(oid - 1)
        if (!flo || !isCornerBlendable(flo)) continue
        const shapeRot = packed >> 8
        if (!overlayCoversCorner(shapeRot >> 2, shapeRot & 0x3, corner)) continue
        const slot = floSlotKey(flo, oid)
        if (slot >= bestSlot) {
          bestSlot = slot
          best = oid
        }
      }
      out[x * VERTS + y] = best
    }
  }
  return out
}

/** MapLoader.calculateUnderlayPalette — 11×11 box-blurred underlay HSL16 per
 *  tile, 65×65 (VERTS²) like SceneMosaic.paletteFor; the 65th row/column
 *  reuses the edge tiles (no neighbour region in this fallback path). */
function computeUnderlayPalette(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const palette = new Int32Array(VERTS * VERTS).fill(-1)
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
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      acc.hue = 0; acc.sat = 0; acc.light = 0; acc.div = 0; acc.n = 0
      for (let dx = -5; dx <= 5; dx++) {
        const cx = Math.min(x, SIZE - 1) + dx
        if (cx < 0 || cx >= SIZE) continue
        for (let dy = -5; dy <= 5; dy++) {
          const cy = Math.min(y, SIZE - 1) + dy
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
        palette[x * VERTS + y] = packBlurredHsl(
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
export function isWaterMaterial(meta: MaterialMeta): boolean {
  if (meta.detailsOnly || meta.colorHsl < 0) return false
  const hue = (meta.colorHsl >> 10) & 0x3f
  return hue >= 34 && hue <= 45
}

type Bucket = { positions: number[]; colors: number[]; uvs: number[]; owners: number[]; alphas: number[]; depths: number[] }

// blend buckets (terrain texture splatting) share the map under offset keys
const BLEND_KEY = 1 << 20
// Loc faces the client counts as transparent (`faceAlpha != 0 || blendType != 0`).
// The client's baked sort key is priority → transparent-flag → texture, with
// opaque ALWAYS before transparent (MeshRasterizer_Sub3's ctor). Buckets are
// emitted in ascending key order, so this reproduces the opaque-before-
// transparent half — the part that's meaningful here.
// `facePriorities` IS in the key: transparent loc faces are accumulated per loc
// (one mesh per loc, like the client), so priority orders faces within a single
// model — exactly what the client uses it for.
const TRANS_KEY = 1 << 22
const TRANS_PRIORITY_STEP = 1 << 12 // > any texture id (~2600)
/** Transparent faces a loc needs before it earns its own sortable mesh. */
const TRANSPARENT_OWN_MESH_FACES = 100

class BucketSet {
  buckets = new Map<number, Bucket>()

  get(textureId: number): Bucket {
    let b = this.buckets.get(textureId)
    if (!b) this.buckets.set(textureId, (b = { positions: [], colors: [], uvs: [], owners: [], alphas: [], depths: [] }))
    return b
  }

  /** Transparent crossfade pass for terrain texture splatting: same geometry,
   *  per-vertex alpha fades this texture over the base pass. */
  getBlend(textureId: number): Bucket {
    return this.get(BLEND_KEY + textureId)
  }

  /** A loc face the client treats as transparent — ordered by face priority,
   *  then texture, after every opaque face. */
  getTransparent(textureId: number, priority = 0): Bucket {
    return this.get(TRANS_KEY + (priority & 0xff) * TRANS_PRIORITY_STEP + textureId + 1)
  }

  hasAny(): boolean {
    for (const b of this.buckets.values()) if (b.positions.length > 0) return true
    return false
  }

  faceCount(): number {
    let n = 0
    for (const b of this.buckets.values()) n += b.positions.length / 9
    return n
  }

  /** Fold another set's buckets into this one (same keys concatenate). */
  mergeFrom(other: BucketSet) {
    for (const [key, src] of other.buckets) {
      if (src.positions.length === 0) continue
      const dst = this.get(key)
      for (const v of src.positions) dst.positions.push(v)
      for (const v of src.colors) dst.colors.push(v)
      for (const v of src.uvs) dst.uvs.push(v)
      for (const v of src.owners) dst.owners.push(v)
      for (const v of src.alphas) dst.alphas.push(v)
      for (const v of src.depths) dst.depths.push(v)
    }
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
    // Locs bake their lit colour but not the detail-map normalisation the
    // terrain path does inline — set true so greyscale detail maps (tree leaves,
    // bark) don't darken the baked colour (255/avgLuma, same as emitTri).
    boostDetailMaps = false,
    // Which buckets to emit. The client draws opaque objects, then the ground,
    // then transparent objects (SceneObjectManager.method3441), so locs are
    // built as two meshes that the scene gives different renderOrders.
    select: 'all' | 'opaque' | 'transparent' = 'all',
    // Shared per-texture materials. With one mesh per transparent loc there are
    // hundreds of meshes drawing the same few leaf textures — reusing the
    // material keeps GPU state changes (and allocation) down.
    materialCache?: Map<number, THREE.Material>,
  ): Promise<THREE.Mesh | null> {
    const entries = [...this.buckets.entries()].filter(([key, b]) => {
      if (b.positions.length === 0) return false
      if (select === 'opaque') return key < TRANS_KEY
      if (select === 'transparent') return key >= TRANS_KEY
      return true
    })
      // ascending key = opaque buckets, then crossfade, then transparent
      .sort(([a], [b]) => a - b)
    if (entries.length === 0) return null
    let total = 0
    for (const [, b] of entries) total += b.positions.length / 3
    const positions = new Float32Array(total * 3)
    const colors = new Float32Array(total * 4).fill(1)
    const uvs = new Float32Array(total * 2)
    const owners = new Int32Array(total / 3)
    // Per-vertex water depth (0 for non-water verts) — drives the water
    // surface shader's shore/transparency fade. Only populated when the caller
    // passed a depth grid and the vertex belongs to a water material.
    const waterDepth = new Float32Array(total)
    let anyDepth = false
    const geometry = new THREE.BufferGeometry()
    const materials: THREE.Material[] = []
    let vert = 0
    for (const [key, b] of entries) {
      const trans = key >= TRANS_KEY
      const blend = !trans && key >= BLEND_KEY
      const textureId = trans
        ? ((key - TRANS_KEY) % TRANS_PRIORITY_STEP) - 1
        : blend ? key - BLEND_KEY : key
      const count = b.positions.length / 3
      positions.set(b.positions, vert * 3)
      // Fetch material meta up front so the detail-map boost can scale the
      // baked colours as they're copied (leaves/bark greyscale-neutralised).
      const meta = textureId >= 0 && getMeta ? await getMeta(textureId) : null
      const boost = boostDetailMaps && meta?.detailsOnly ? 255 / meta.avgLuma : 1
      for (let i = 0; i < count; i++) {
        colors[(vert + i) * 4] = b.colors[i * 3] * boost
        colors[(vert + i) * 4 + 1] = b.colors[i * 3 + 1] * boost
        colors[(vert + i) * 4 + 2] = b.colors[i * 3 + 2] * boost
        if (b.alphas.length > 0) colors[(vert + i) * 4 + 3] = b.alphas[i]
      }
      if (b.depths.length > 0) {
        waterDepth.set(b.depths, vert)
        anyDepth = true
      }
      uvs.set(b.uvs, vert * 2)
      owners.set(b.owners, vert / 3)
      geometry.addGroup(vert, count, materials.length)
      const cached = materialCache?.get(key)
      if (cached) {
        materials.push(cached)
        vert += count
        continue
      }
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      if (blend) {
        // terrain crossfade pass: coplanar with its base face (depthFunc
        // LEQUAL), alpha-faded per vertex, never writes depth
        material.transparent = true
        material.depthWrite = false
      } else if (trans) {
        // Client-transparent loc faces: blended, depth-TESTED against the opaque
        // scene but not depth-WRITING. Writing depth makes leaf faces inside one
        // merged mesh reject each other — the winner depends on bucket order, so
        // fronds pop in and out as the camera turns (willow-over-water showed the
        // water through the canopy). The client can't hit that: its alpha test is
        // a no-op (ALPHAREF=0/GREATEREQUAL, set once in DirectXRenderer init and
        // never changed), so it is pure ordered blending. Correct compositing
        // against the ground comes from pass order (renderOrder), not depth.
        material.transparent = true
        material.depthWrite = false
      }
      if (textureId >= 0) {
        const texture = await getTexture(textureId)
        if (texture) {
          // each animated material needs its own texture instance so offsets
          // don't leak across materials sharing a cached THREE.Texture
          const animated = meta && (meta.speedU !== 0 || meta.speedV !== 0 || isWaterMaterial(meta))
          material.map = animated ? texture.clone() : texture
          // Cutouts get a hard 0.35 threshold; the crossfade pass must keep
          // drawing at any alpha (0). Blended loc faces still need a small
          // cutoff — with depthWrite on, a fully-clear texel would otherwise
          // write depth and punch a hole through whatever is behind it.
          // cutouts keep the hard 0.35 threshold; crossfade and blended loc
          // faces draw at any alpha (the client's alpha test never rejects)
          material.alphaTest = blend || trans ? 0 : 0.35
          // HDR overbright: push the material past 1.0 so the bloom pass sees it.
          // Recorded in userData too — the scene's sun tint re-writes material.color
          // and must multiply by this rather than overwrite it.
          if (meta && meta.hdrMultiplier > 1) {
            material.userData.hdrMultiplier = meta.hdrMultiplier
            material.color.setScalar(meta.hdrMultiplier)
          }
          material.needsUpdate = true
          if (meta && (meta.speedU !== 0 || meta.speedV !== 0)) {
            material.userData.scroll = { u: meta.speedU, v: meta.speedV }
          } else if (meta && isWaterMaterial(meta)) {
            material.userData.water = true
          }
        }
      }
      materialCache?.set(key, material)
      materials.push(material)
      vert += count
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    if (anyDepth) geometry.setAttribute('waterDepth', new THREE.BufferAttribute(waterDepth, 1))
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
  pre?: { lights: Float32Array[]; shadows?: Float32Array[]; palettes: Int32Array[]; overlayCorners?: Int32Array[]; underlayCorners?: Int32Array[] },
  // Per-plane water-depth grids (VERTS×VERTS, client units) — riverbed minus
  // surface height. When present, water-material vertices get a `waterDepth`
  // attribute for the shore/transparency fade.
  waterDepthAll?: Int32Array[],
): Promise<THREE.Mesh | null> {
  const lightCache: (Float32Array | null)[] = [null, null, null, null]
  const paletteCache: (Int32Array | null)[] = [null, null, null, null]
  const cornerCache: (Int32Array | null)[] = [null, null, null, null]
  const fluCornerCache: (Int32Array | null)[] = [null, null, null, null]
  const lightOf = (dp: number) =>
    (lightCache[dp] ??= pre?.lights?.[dp] ?? computeVertexLight(heightsAll[dp]))
  // Blurred static-shadow grid per plane (0 = no shadow). Subtracted from the
  // GroundGL base strength; empty when no locs have been built yet.
  const shadowOf = (dp: number): Float32Array | null => pre?.shadows?.[dp] ?? null
  const paletteOf = (dp: number) =>
    (paletteCache[dp] ??= pre?.palettes?.[dp] ?? computeUnderlayPalette(terrain, dp, configs))
  const cornersOf = (dp: number) =>
    (cornerCache[dp] ??= pre?.overlayCorners?.[dp] ?? computeOverlayCorners(terrain, dp, configs))
  const fluCornersOf = (dp: number) =>
    (fluCornerCache[dp] ??= pre?.underlayCorners?.[dp] ?? computeUnderlayCornerIds(terrain, dp))
  const buckets = new BucketSet()
  // lighting-only tint for self-coloured textures (water etc.): the scene light
  // multiplier as a grey the texture multiplies.
  const neutral = (mul: number): [number, number, number] => {
    const c = srgbToLinear(Math.min(1, mul))
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
  const metas = new Map<number, MaterialMeta | null>()
  await Promise.all([...usedTextureIds].map(async (id) => metas.set(id, await assets.getMaterialMeta(id))))

  // corner-override colour per blendable overlay id (keyed by raw 1-based id):
  // the tile colour, or the texture's average colour for texture-only
  // overlays (the client's getOverlayColorHsl equivalent)
  const overlayCornerHsl = new Map<number, number>()
  for (const [key, flo] of configs.overlays) {
    if (!isCornerBlendable(flo)) continue
    let hsl = floTileHsl(flo)
    if (hsl === -1 && flo.texture !== undefined && flo.texture >= 0) {
      const meta = metas.get(flo.texture)
      if (meta && meta.avgRgb !== -1) hsl = rgbToHsl16(meta.avgRgb)
    }
    if (hsl !== -1) overlayCornerHsl.set(key + 1, hsl)
  }

  function emitTile(plane: number, x: number, y: number) {
      const heights = heightsAll[plane]
      const light = lightOf(plane)
      const shadow = shadowOf(plane)
      const palette = paletteOf(plane)
      const ocorners = cornersOf(plane)
      const fcorners = fluCornersOf(plane)
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
      const underlayHsl = underlayId !== 0 ? palette[x * VERTS + y] : -1
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

      // Corner-blended underlay colour (addUnderlayTiles): a vertex at a tile
      // corner takes the blurred palette of the tile whose origin sits there —
      // unless a blendable overlay covers that corner, in which case the
      // overlay's colour wins (calculateOverlayDisplay slot machinery; this
      // feathers roads/mud into the surrounding ground). Mid-tile vertices
      // bilinearly blend the 4 corner colours. Gouraud interpolation between
      // those vertices is what makes ground colours flow smoothly across
      // tiles instead of rendering per-tile patches.
      const palAt = (tx: number, ty: number): number => {
        const p = palette[tx * VERTS + ty]
        return p !== -1 ? p : underlayHsl
      }
      const cornerBaseHsl = (tx: number, ty: number): number => {
        const ov = ocorners[tx * VERTS + ty]
        if (ov > 0) {
          const h = overlayCornerHsl.get(ov)
          if (h !== undefined) return h
        }
        return palAt(tx, ty)
      }
      // Exact corners take the override-or-palette colour; every other
      // position blends the pure PALETTE only (the client's 6-vertex splits
      // give edge midpoints the palette colour, so a neighbouring overlay's
      // colour reaches only half a tile — full-quad interpolation would
      // flood whole tiles with road colour)
      const underlayVertexHsl = (px: number, py: number): number => {
        if (px === 0 && py === 0) return cornerBaseHsl(x, y)
        if (px === 0 && py === 512) return cornerBaseHsl(x, y + 1)
        if (px === 512 && py === 512) return cornerBaseHsl(x + 1, y + 1)
        if (px === 512 && py === 0) return cornerBaseHsl(x + 1, y)
        const fx = px >> 2 // 0-128 blend factor, like sizeX << 7 >> 9
        const fy = py >> 2
        return blendHsl16(
          blendHsl16(palAt(x, y), palAt(x + 1, y), fx),
          blendHsl16(palAt(x, y + 1), palAt(x + 1, y + 1), fx),
          fy,
        )
      }
      // Blendable overlay faces keep their own colour except at corners a
      // (possibly different, higher-slot) blendable overlay covers — the
      // cross-overlay gradient between adjacent mud/dirt/path tiles.
      const overlayVertexHsl = (px: number, py: number, own: number): number => {
        const cx = px === 0 ? x : px === 512 ? x + 1 : -1
        const cy = py === 0 ? y : py === 512 ? y + 1 : -1
        if (cx < 0 || cy < 0) return own
        const ov = ocorners[cx * VERTS + cy]
        if (ov > 0) {
          const h = overlayCornerHsl.get(ov)
          if (h !== undefined) return h
        }
        return own
      }

      // mode: 0 = flat (non-blendable overlay), 1 = underlay corner blend,
      // 2 = blendable overlay (own colour + cross-overlay corner overrides).
      // `alphas` puts the triangle in a transparent crossfade bucket instead
      // (terrain texture splatting between adjacent underlay textures).
      const emitTri = (pts: [number, number][], hsl: number, textureId: number, texScale: number, mode: number, alphas?: [number, number, number]) => {
        const meta = textureId >= 0 ? metas.get(textureId) : null
        const bucket = alphas ? buckets.getBlend(textureId) : buckets.get(textureId)
        bucket.owners.push(x * SIZE + y) // tile index, for terrain picking
        // detail maps modulate the tile colour; normalise by the map's own
        // average so the modulation is brightness-neutral
        const boost = textureId >= 0 && meta?.detailsOnly && hsl !== -1 ? 255 / meta.avgLuma : 1
        const useTint = textureId < 0 || (meta?.detailsOnly === true && hsl !== -1)
        // water tiles carry a per-vertex depth (surface→riverbed height gap, in
        // client units) so the water shader can fade to transparent at shallow
        // shores. Non-water buckets leave depths empty (default 0 in toMesh).
        const isWater = meta ? isWaterMaterial(meta) : false
        for (let vi = 0; vi < 3; vi++) {
          const [px, py] = pts[vi]
          const sceneX = (x << 9) + px
          const sceneY = (y << 9) + py
          const h = averageHeight(heights, sceneX, sceneY)
          bucket.positions.push(sceneX, -h, -sceneY)
          if (isWater) {
            bucket.depths.push(waterDepthAll ? averageHeight(waterDepthAll[plane], sceneX, sceneY) : 0)
          }
          // Scene-shader half-Lambert light (from the ground normal) × the static
          // shadow (baked into the client's ground vertex colour). One multiplier.
          const sceneLight = Math.max(0, lightAt(light, sceneX, sceneY))
          const shadowVal = shadow ? lightAt(shadow, sceneX, sceneY) : 0
          const shadowFactor = Math.max(0, 1 - shadowVal / 128)
          const mul = sceneLight * shadowFactor
          const vHsl = hsl === -1 ? hsl
            : mode === 1 ? underlayVertexHsl(px, py)
            : mode === 2 ? overlayVertexHsl(px, py, hsl)
            : hsl
          let rgb: [number, number, number]
          if (useTint && vHsl !== -1) rgb = litColor(vHsl, mul)
          else rgb = neutral(mul)
          bucket.colors.push(rgb[0] * boost, rgb[1] * boost, rgb[2] * boost)
          if (alphas) bucket.alphas.push(alphas[vi])
          // world-planar UVs: one repeat per `texScale` scene units
          bucket.uvs.push(sceneX / texScale, sceneY / texScale)
        }
      }
      const emitFace = (a: number, b: number, c: number, hsl: number, textureId: number, texScale: number, mode: number) =>
        emitTri([[vx(a), vy(a)], [vx(b), vy(b)], [vx(c), vy(c)]], hsl, textureId, texScale, mode)

      let faceIdx = 0
      const overlayMode = flo !== undefined && isCornerBlendable(flo) ? 2 : 0
      for (let i = 0; i < overlayFaces; i++, faceIdx++) {
        if (hasOverlay) {
          emitFace(va[faceIdx], vb[faceIdx], vc[faceIdx], overlayHsl, overlayTexture, flo?.textureScale || 512, overlayMode)
        }
      }
      // Underlay faces render per-vertex corner TEXTURES (addUnderlayTiles):
      // each vertex takes the texture of the tile whose origin sits at its
      // corner. Uniform faces go straight to that texture's bucket; mixed
      // faces draw the own texture as an opaque base plus one transparent
      // crossfade pass per neighbouring texture — the client's ground
      // texture splatting, which removes hard texture seams at tile edges.
      const cornerFluAt = (px: number, py: number): number => {
        const tx = px < 256 ? x : x + 1
        const ty = py < 256 ? y : y + 1
        const id = fcorners[tx * VERTS + ty]
        return id !== 0 ? id : underlayId
      }
      const texOfFlu = (id: number): number => {
        const f = configs.underlays.get(id - 1)
        return f?.texture !== undefined && f.texture >= 0 ? f.texture : -1
      }
      // Any blendable-overlay override on this tile's corners? Then the
      // client subdivides the ground faces (its 6-vertex fans) so the
      // overlay colour fades out by the tile midpoints — emulate with a
      // midpoint split of each triangle.
      const hasOverride = ocorners[x * VERTS + y] > 0 || ocorners[(x + 1) * VERTS + y] > 0
        || ocorners[x * VERTS + y + 1] > 0 || ocorners[(x + 1) * VERTS + y + 1] > 0
      for (let i = 0; i < underlayFaces; i++, faceIdx++) {
        if (!hasUnderlay) continue
        const A = va[faceIdx], B = vb[faceIdx], C = vc[faceIdx]
        const pa: [number, number] = [vx(A), vy(A)]
        const pb: [number, number] = [vx(B), vy(B)]
        const pc: [number, number] = [vx(C), vy(C)]
        let tris: [number, number][][]
        if (hasOverride) {
          const mid = (p: [number, number], q: [number, number]): [number, number] =>
            [(p[0] + q[0]) >> 1, (p[1] + q[1]) >> 1]
          const ab = mid(pa, pb), bc = mid(pb, pc), ca = mid(pc, pa)
          tris = [[pa, ab, ca], [ab, pb, bc], [ca, bc, pc], [ab, bc, ca]]
        } else {
          tris = [[pa, pb, pc]]
        }
        for (const tri of tris) {
          const flus = tri.map(([px, py]) => cornerFluAt(px, py))
          const texes = flus.map(texOfFlu)
          if (texes[0] === texes[1] && texes[0] === texes[2]) {
            const f = flus[0] === underlayId ? flu : configs.underlays.get(flus[0] - 1)
            emitTri(tri, underlayHsl, texes[0], f?.scale || 512, 1)
          } else {
            emitTri(tri, underlayHsl, underlayTexture, flu?.scale || 512, 1)
            const done = new Set<number>([underlayTexture])
            for (let vi = 0; vi < 3; vi++) {
              const t = texes[vi]
              if (t < 0 || done.has(t)) continue
              done.add(t)
              const f = configs.underlays.get(flus[vi] - 1)
              emitTri(tri, underlayHsl, t, f?.scale || 512, 1,
                [texes[0] === t ? 1 : 0, texes[1] === t ? 1 : 0, texes[2] === t ? 1 : 0])
            }
          }
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
  /** How far a wall pushes the decorations hanging on it (default 64). Read off
   *  the WALL, not the decoration — see buildLocsMesh's wallDisplacement. */
  decorDisplacement?: number
  originalColors?: number[]
  modifiedColors?: number[]
  // Loc texture-swap fields as named in the dumped object JSON (ObjectViewer /
  // objects.ts loader use the same). Reading them as *TextureIds silently
  // disabled all loc retexturing — trees kept their base leaf textures.
  originalTextures?: number[]
  modifiedTextures?: number[]
  name?: string
  options?: (string | null)[]
  staticShadow?: boolean
  soundId?: number
  ambientSoundId?: number
  soundGroupIds?: number[]
  mapCategoryId?: number
  /** config/map_sprites id — the "mapscene" symbol drawn on the minimap. */
  mapSpriteId?: number
  mapSpriteRotation?: number
  flipMapSprite?: boolean
  /** Ground-contour ("hillskew") mode — 0 none, 1 follow ground, 2 partial,
   *  4/5 stretch to the next plane (bridges/raised floors). */
  groundContourType?: number
  groundContourModifier?: number
  /** ModelSM lighting: model ambient = 64 + this, contrast = 850 + this. */
  ambient?: number
  contrast?: number
  /** Sequence ids this loc idles through (ObjectType animation array) — e.g. a
   *  waving flag. Empty/absent = static. The scene animates these. */
  animations?: number[]
}

export type MaterialMeta = {
  detailsOnly: boolean
  avgLuma: number
  /** average opaque RGB of the texture PNG (-1 if unreadable) — the minimap
   *  colour for texture-only overlays, like the client's getMaterialColor */
  avgRgb: number
  speedU: number
  speedV: number
  colorHsl: number
  /** Material alpha mode (client anInt1226): 0 = opaque, 1 = binary alpha
   *  (black texels → transparent, foliage/fence cutouts), 2 = per-pixel alpha
   *  from an opacity op the dump doesn't bake. */
  effectCombiner: number
  /** Overbright multiplier for `hdr` materials. The client uploads these as FLOAT
   *  textures (`Class66` -> `renderMaterialPixelsF`) and scales colour by
   *  `1 + hdrOp*31/4096` — up to 32x — which is what makes flames glow once bloom
   *  picks them up. Our 8-bit PNG can't hold that, so the scalar is applied to the
   *  material instead. 1 = not HDR / not recoverable. */
  hdrMultiplier: number
}

/** distinct texture ids per model — a model is reused across many placements */
const modelTextureIds = new WeakMap<ModelData, number[]>()

export class LocAssets {
  private root: FileSystemDirectoryHandle
  private defs = new Map<number, Promise<ObjectDefJson | null>>()
  private models = new Map<number, Promise<ModelData | null>>()
  private textures = new Map<number, Promise<THREE.Texture | null>>()
  private materialMeta = new Map<number, Promise<MaterialMeta | null>>()
  /** blendType (= texture-def effectCombiner) per texture, filled as metas
   *  resolve — lets the synchronous face loop classify transparency. */
  private blendTypes = new Map<number, number>()
  /** overbright multiplier per texture, filled as metas resolve */
  private hdrMults = new Map<number, number>()
  // single-flight directory resolution: cache the PROMISE, not the result —
  // dozens of parallel first calls must not each re-resolve the folder
  private objectsDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private modelsDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private texturesDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private textureDefsDirP: Promise<FileSystemDirectoryHandle | null> | undefined

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  private texturesDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.texturesDirP) {
      this.texturesDirP = this.root.getDirectoryHandle('textures').catch(() => null)
    }
    return this.texturesDirP
  }

  private textureDefsDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.textureDefsDirP) {
      this.textureDefsDirP = this.root.getDirectoryHandle('texture_definitions').catch(() => null)
    }
    return this.textureDefsDirP
  }

  async dispose() {
    for (const p of this.textures.values()) {
      const texture = await p.catch(() => null)
      texture?.dispose()
    }
    this.textures.clear()
  }

  /** Cached blendType for a texture (0 = opaque, 1 = binary cutout, 2 = smooth
   *  alpha). Synchronous — `primeBlendTypes` must have run for this id. */
  blendTypeOf(id: number): number {
    return this.blendTypes.get(id) ?? 0
  }

  /** Cached HDR overbright multiplier (1 = not HDR). Sync — needs primeBlendTypes. */
  hdrMultiplierOf(id: number): number {
    return this.hdrMults.get(id) ?? 1
  }

  /** Resolve (and cache) the blendType of every texture a model uses, so the
   *  synchronous face loop can classify transparency the way the client does. */
  async primeBlendTypes(model: ModelData): Promise<void> {
    const tex = model.faceTextures
    if (!tex) return
    let ids = modelTextureIds.get(model)
    if (!ids) {
      const set = new Set<number>()
      for (let f = 0; f < model.faceCount; f++) {
        const t = tex[f]
        if (t >= 0) set.add(t)
      }
      modelTextureIds.set(model, (ids = [...set]))
    }
    for (const id of ids) {
      if (!this.blendTypes.has(id)) await this.getMaterialMeta(id)
    }
  }

  /** textures/<id>/<id>.png as a repeating sRGB THREE texture. */
  getTexture(id: number): Promise<THREE.Texture | null> {
    let p = this.textures.get(id)
    if (!p) {
      p = (async () => {
        try {
          const texturesDir = await this.texturesDir()
          if (!texturesDir) return null
          const dir = await texturesDir.getDirectoryHandle(String(id))
          const file = await (await dir.getFileHandle(`${id}.png`)).getFile()
          const bitmap = await createImageBitmap(file)
          // effectCombiner 1 materials (leaf/foliage/fence cutouts) carry their
          // shape as black texels the client turns transparent (binary alpha).
          // Our dumped PNGs are opaque, so derive that alpha here, else the
          // canopy renders as a solid dark mass instead of see-through leaves.
          const combiner = (await this.getMaterialMeta(id))?.effectCombiner ?? 0
          const texture = combiner === 1 ? binaryAlphaTexture(bitmap) : new THREE.Texture(bitmap)
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
          let effectCombiner = 0
          let isHdr = false
          let hdrMultiplier = 1
          try {
            const defsDir = await this.textureDefsDir()
            if (!defsDir) throw new Error('no texture_definitions')
            const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
            const def = JSON.parse(await file.text())
            detailsOnly = def.detailsOnly === true
            speedU = def.textureSpeedU ?? 0
            speedV = def.textureSpeedV ?? 0
            colorHsl = def.colorHsl ?? -1
            effectCombiner = def.effectCombiner ?? 0
            isHdr = def.hdr === true
          } catch { /* definition missing — treat as self-coloured */ }
          if (isHdr) {
            // The overbright factor lives in the material op graph, not the
            // texture def. Only a constant-fill op gives a single scalar (87 of
            // the 367 hdr materials); the rest are real op graphs whose per-pixel
            // HDR channel we don't evaluate yet, so they stay at 1.
            try {
              const texturesDir = await this.texturesDir()
              const dir = await texturesDir!.getDirectoryHandle(String(id))
              const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
              const mat = JSON.parse(await file.text())
              const op = mat.hdrOperationIndex != null ? mat.textureOperations?.[mat.hdrOperationIndex] : null
              if (op && op.type === 0 && typeof op.fillValue === 'number') {
                hdrMultiplier = 1 + (op.fillValue * 31) / 4096
              }
            } catch { /* no op graph — leave at 1 */ }
          }
          let avgLuma = 128
          let avgRgb = -1
          try {
            const texturesDir = await this.texturesDir()
            if (!texturesDir) throw new Error('no textures')
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
            let sum = 0, n = 0, sr = 0, sg = 0, sb = 0
            for (let i = 0; i < px.length; i += 4) {
              if (px[i + 3] === 0) continue
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3
              sr += px[i]
              sg += px[i + 1]
              sb += px[i + 2]
              n++
            }
            if (n > 0) {
              avgLuma = sum / n
              avgRgb = (Math.round(sr / n) << 16) | (Math.round(sg / n) << 8) | Math.round(sb / n)
            }
          } catch { /* keep default */ }
          this.blendTypes.set(id, effectCombiner)
          this.hdrMults.set(id, hdrMultiplier)
          return { detailsOnly, avgLuma: Math.max(32, avgLuma), avgRgb, speedU, speedV, colorHsl, effectCombiner, hdrMultiplier }
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
          if (!this.objectsDirP) {
            this.objectsDirP = resolveEntryHandle(this.root, getEntryPath('objects'))
          }
          const objectsDir = await this.objectsDirP
          if (!objectsDir) return null
          const file = await (await objectsDir.getFileHandle(`${id}.json`)).getFile()
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
          if (!this.modelsDirP) {
            this.modelsDirP = resolveEntryHandle(this.root, getEntryPath('models'))
          }
          const modelsDir = await this.modelsDirP
          if (!modelsDir) return null
          const sub = await modelsDir.getDirectoryHandle(String(id))
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

// Ground-contour ("hillskew") for locs — port of ModelSM.contourToGround. RS
// loc models can be deformed so their vertices follow the terrain: paths/floors
// hug the ground (type 1/2), and — crucially for bridges/raised buildings —
// their tops stretch up to the NEXT plane's heightmap (type 4/5). Without it a
// bridge stays flat (its stone arch sinks under the water surface and is
// occluded) and hillside decorations float. Returns a contoured copy of the
// model's vertexY (RS units, relative to the tile so the render matrix's
// −avgHeight translate still applies), or null if the contour can't run.
//
// heights/nextHeights are VERTS×VERTS RS height grids (heights[x*VERTS+y]);
// worldX/Z are fine scene coords (512/tile). Only upscale-1 (v13+) models are
// contoured — pre-v13 upscaling would need the ground terms upscaled too, and
// no map loc in the dump uses both.
function contourVertexY(
  model: ModelData,
  contourType: number,
  contourModifier: number,
  heights: Int32Array,
  nextHeights: Int32Array | undefined,
  sceneX: number,
  sceneY: number,
  avgHeight: number,
): Int32Array | null {
  if (model.version < 13) return null
  const { vertexCount, vertexX, vertexY, vertexZ } = model
  // interpolated ground height at a fine world position (MeshRasterizer bilerp)
  const groundAt = (h: Int32Array, wx: number, wz: number): number | null => {
    const tx = wx >> 9, tz = wz >> 9
    if (tx < 0 || tz < 0 || tx >= VERTS - 1 || tz >= VERTS - 1) return null
    const rx = wx & 511, rz = wz & 511
    const a = (h[tx * VERTS + tz] * (512 - rx) + rx * h[(tx + 1) * VERTS + tz]) >> 9
    const b = (h[tx * VERTS + tz + 1] * (512 - rx) + rx * h[(tx + 1) * VERTS + tz + 1]) >> 9
    return (a * (512 - rz) + b * rz) >> 9
  }
  const out = new Int32Array(vertexCount)
  let minY = 0, maxY = 0
  for (let v = 0; v < vertexCount; v++) { if (vertexY[v] < minY) minY = vertexY[v]; if (vertexY[v] > maxY) maxY = vertexY[v] }

  for (let v = 0; v < vertexCount; v++) {
    const wx = sceneX + vertexX[v]
    const wz = sceneY + vertexZ[v]
    let ny = vertexY[v]
    if (contourType === 1) {
      const g = groundAt(heights, wx, wz)
      if (g !== null) ny = g + vertexY[v] - avgHeight
    } else if (contourType === 2) {
      if (minY !== 0) {
        const frac = (vertexY[v] << 16) / minY
        if (frac < contourModifier) {
          const g = groundAt(heights, wx, wz)
          if (g !== null) ny = vertexY[v] + ((g - avgHeight) * (contourModifier - frac)) / contourModifier
        }
      }
    } else if ((contourType === 4 || contourType === 5) && nextHeights) {
      const gn = groundAt(nextHeights, wx, wz)
      if (gn === null) return null
      if (contourType === 4) {
        ny = vertexY[v] + (maxY - minY) + (gn - avgHeight)
      } else {
        const g = groundAt(heights, wx, wz)
        if (g === null) return null
        const sizeY = maxY - minY
        if (sizeY === 0) return null
        ny = (((g - gn - contourModifier) * ((vertexY[v] << 8) / sizeY)) >> 8) - (avgHeight - g)
      }
    }
    out[v] = Math.round(ny)
  }
  return out
}

/** Accumulates transformed model triangles into texture buckets. */
class ModelAccumulator {
  buckets = new BucketSet()
  private uvWriters = new WeakMap<ModelData, UVWriter>()
  private uvScratch = new Float32Array(6)

  addModel(
    model: ModelData,
    matrix: THREE.Matrix4,
    owner = -1,
    light?: { sun?: ModelSun; points?: PointLight[] },
    blendTypeOf?: (texId: number) => number,
    hdrOf?: (texId: number) => number,
    // Transparent faces go here instead of the shared buckets — the client
    // renders one mesh per loc so its faces can be ordered and depth-sorted as
    // a unit. Opaque faces always stay merged (order-independent).
    transparentTarget?: BucketSet,
  ) {
    const upscale = modelUpscale(model)
    const v = new THREE.Vector3()
    let uvWriter = this.uvWriters.get(model)
    if (!uvWriter) this.uvWriters.set(model, (uvWriter = makeUVWriter(model)))
    // Client "Model" shader lighting (dumped GLSL): per-vertex half-Lambert in
    // WORLD space, so lighting depends on the loc's rotation — computed per
    // placement (the world normal matrix isn't shared across placements).
    const normalMat = new THREE.Matrix3().getNormalMatrix(matrix).elements
    const points = light?.points?.length
      ? { lights: light.points, matrix: matrix.elements, upscale }
      : undefined
    const lit = computeModelLitRgb(model, normalMat, light?.sun, points)
    if (hdrOf) unlitHdrFaces(model, lit, hdrOf)
    for (let f = 0; f < model.faceCount; f++) {
      if (model.faceAlpha[f] === -1) continue
      const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
      if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
      const textureId = model.faceTextures?.[f] ?? -1
      // Client transparency test (MeshRasterizer_Sub3 ctor):
      // faceAlpha != 0 || blendType != 0. Transparent faces are ordered after
      // every opaque one, by face priority — the client's baked draw order.
      const transparent = blendTypeOf
        ? model.faceAlpha[f] !== 0 || (textureId >= 0 && blendTypeOf(textureId) !== 0)
        : false
      const bucket = transparent
        ? (transparentTarget ?? this.buckets).getTransparent(textureId, model.facePriorities?.[f] ?? model.priority)
        : this.buckets.get(textureId)
      bucket.owners.push(owner)
      if (textureId >= 0) {
        uvWriter(f, ia, ib, ic, this.uvScratch, 0)
        bucket.uvs.push(...this.uvScratch)
      } else {
        bucket.uvs.push(0, 0, 0, 0, 0, 0)
      }
      // face colour tints the material texture — the dumped material PNGs are
      // (mostly) greyscale detail maps the client multiplies by face colour. The
      // lit colour is per-vertex so untextured scenery gets smooth Gouraud shading.
      const corners = [ia, ib, ic]
      for (let k = 0; k < 3; k++) {
        const base = (f * 3 + k) * 3
        const vi = corners[k]
        v.set(model.vertexX[vi] * upscale, -model.vertexY[vi] * upscale, -model.vertexZ[vi] * upscale)
        v.applyMatrix4(matrix)
        bucket.positions.push(v.x, v.y, v.z)
        bucket.colors.push(lit[base], lit[base + 1], lit[base + 2])
      }
    }
  }
}


/** Emissive (HDR) faces are not directionally shaded.
 *
 *  Measured on the Lumbridge fireplace (model 35878, texture 110): Gouraud
 *  shading spread its flame faces over a 16x range (max-channel 0.062 .. 1.000).
 *  After the 4.03x overbright that leaves the bright faces clipping to pale
 *  yellow but the dark ones at ~0.25 — nowhere near overbright — which is
 *  exactly the orange band the client doesn't have. The client's flame is
 *  uniformly bright, so these faces take their colour at full value and skip the
 *  directional term entirely. */
function unlitHdrFaces(model: ModelData, lit: Float32Array, hdrOf: (texId: number) => number) {
  const tex = model.faceTextures
  if (!tex) return
  for (let f = 0; f < model.faceCount; f++) {
    const t = tex[f]
    if (t < 0 || hdrOf(t) <= 1) continue
    const rgb = hslToRgb(model.faceColor[f] & 0xffff)
    const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
    const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
    const b = srgbToLinear((rgb & 0xff) / 255)
    for (let k = 0; k < 3; k++) {
      const base = (f * 3 + k) * 3
      lit[base] = r; lit[base + 1] = g; lit[base + 2] = b
    }
  }
}

/** A placed loc that idles through a sequence (e.g. a waving flag) — kept out
 *  of the merged static loc mesh so the scene can pose it per frame. `matrix`
 *  is the region-local placement transform; `model` already has recolour /
 *  ground-contour applied and retains its vertexSkins for the pose math. */
export type AnimatedLoc = {
  model: ModelData
  matrix: THREE.Matrix4
  animationId: number
  owner: LocRef
  /** the region point lights this placement is lit by (already picked, ≤4) */
  points?: PointLight[]
}

/** A built animatable loc: its three.js mesh (geometry in model-local space —
 *  the caller sets `mesh.matrix` to the placement transform) plus an `update`
 *  that rewrites the position buffer from a posed animation frame. */
export type AnimatedLocMesh = {
  mesh: THREE.Mesh
  update: (posed: PosedVertices) => void
}

/** Build a single-model animatable mesh (mirrors ModelViewer's non-indexed
 *  per-face buffer + ModelAccumulator's map-scene coord/upscale/lighting), and
 *  return an in-place per-frame position updater. Geometry is in model-local
 *  flipped space (x, −y, −z)·upscale so the caller can drive it with the
 *  placement matrix as the mesh transform and re-pose cheaply without a
 *  per-vertex matrix multiply. Lighting is baked once from the placement's
 *  world-normal matrix (a waving flag's Gouraud shading barely shifts). */
export async function buildAnimatedLocMesh(
  model: ModelData,
  matrix: THREE.Matrix4,
  assets: LocAssets,
  sun?: ModelSun,
  owner?: LocRef,
  pointLights?: PointLight[],
): Promise<AnimatedLocMesh | null> {
  const upscale = modelUpscale(model)
  const uvWriter = makeUVWriter(model)
  const normalMat = new THREE.Matrix3().getNormalMatrix(matrix).elements
  const lit = computeModelLitRgb(model, normalMat, sun,
    pointLights?.length ? { lights: pointLights, matrix: matrix.elements, upscale } : undefined)
  await assets.primeBlendTypes(model)
  unlitHdrFaces(model, lit, (t) => assets.hdrMultiplierOf(t))

  // bucket faces by texture id (skip fully-transparent / degenerate faces)
  const buckets = new Map<number, number[]>()
  for (let f = 0; f < model.faceCount; f++) {
    if (model.faceAlpha[f] === -1) continue
    const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
    if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
    const tex = model.faceTextures?.[f] ?? -1
    const arr = buckets.get(tex)
    if (arr) arr.push(f)
    else buckets.set(tex, [f])
  }
  const order = [...buckets.keys()].sort((a, b) => a - b)
  const validFaces = order.reduce((n, t) => n + buckets.get(t)!.length, 0)
  if (validFaces === 0) return null

  const positions = new Float32Array(validFaces * 9)
  // RGBA: the alpha channel carries the type-5 face-alpha animation
  // (1 = opaque; stays 1 until a frame drives it)
  const colors = new Float32Array(validFaces * 12)
  const uvs = new Float32Array(validFaces * 6)
  const cornerVertex = new Int32Array(validFaces * 3)
  // model face each rendered corner came from (faces are reordered by texture
  // bucket) so the per-frame update can address type-5 face effects
  const cornerFace = new Int32Array(validFaces * 3)
  // material index per rendered face — type-5 alpha is applied PER MATERIAL, so a
  // flame texture can blend while the same model's stone stays opaque
  const faceMat = new Int32Array(validFaces)
  const scratch = new Float32Array(6)
  const geometry = new THREE.BufferGeometry()
  const materials: THREE.Material[] = []
  let vert = 0
  for (const tex of order) {
    const faces = buckets.get(tex)!
    geometry.addGroup(vert, faces.length * 3, materials.length)
    for (const f of faces) {
      const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
      const corners = [ia, ib, ic]
      if (tex >= 0) { uvWriter(f, ia, ib, ic, scratch, 0); uvs.set(scratch, vert * 2) }
      for (let k = 0; k < 3; k++) {
        const vi = corners[k]
        const p = (vert + k) * 3
        positions[p] = model.vertexX[vi] * upscale
        positions[p + 1] = -model.vertexY[vi] * upscale
        positions[p + 2] = -model.vertexZ[vi] * upscale
        const lb = (f * 3 + k) * 3
        const pc = (vert + k) * 4
        colors[pc] = lit[lb]; colors[pc + 1] = lit[lb + 1]; colors[pc + 2] = lit[lb + 2]; colors[pc + 3] = 1
        cornerVertex[vert + k] = vi
        cornerFace[vert + k] = f
      }
      faceMat[vert / 3] = materials.length
      vert += 3
    }
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    if (tex >= 0) {
      const texture = await assets.getTexture(tex)
      if (texture) {
        material.map = texture
        // blendType != 0 = the client's transparent test. Blend, but keep
        // depthWrite ON (the DirectX path never drops z-write per model) with a
        // small cutoff so fully-clear texels don't write depth.
        const tmeta = await assets.getMaterialMeta(tex)
        const blendType = tmeta?.effectCombiner ?? 0
        material.userData.blendType = blendType
        if (tmeta && tmeta.hdrMultiplier > 1) {
          material.userData.hdrMultiplier = tmeta.hdrMultiplier
          material.color.setScalar(tmeta.hdrMultiplier)
        }
        material.needsUpdate = true
      }
    }
    materials.push(material)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  // Rest-pose bounding sphere, padded so gentle animation never exceeds it —
  // lets three.js frustum-cull the DRAW of off-screen animated locs (we don't
  // recompute bounds per frame). frustumCulled stays at its default (true).
  geometry.computeBoundingSphere()
  if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.5
  const mesh = new THREE.Mesh(geometry, materials)
  // Transparent-sort key: the client sorts an object by the view depth of its
  // vertical CENTRE (base + half the model height), not its origin — so record
  // the local centre-Y offset for the renderer's transparent sort to apply.
  geometry.computeBoundingBox()
  if (geometry.boundingBox) {
    mesh.userData.sortCentreY = (geometry.boundingBox.min.y + geometry.boundingBox.max.y) / 2
  }
  // Click-picking, same convention as the merged loc mesh: faceIndex indexes
  // triangleOwners, which indexes locs. Every triangle here belongs to the one
  // loc, so owners is all-zero and locs holds a single entry — resolveLocAt
  // needs no special case. animatedLoc marks the geometry as deforming, which
  // the highlight uses to follow the pose instead of snapshotting it.
  if (owner) {
    mesh.userData.locs = [owner]
    mesh.userData.triangleOwners = new Int32Array(validFaces)
    mesh.userData.animatedLoc = true
  }
  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute
  // Which materials are currently blended for a type-5 alpha animation. Applied
  // PER MATERIAL: flipping the whole mesh made the fireplace's opaque STONE stop
  // writing depth, so its own back faces painted over its front faces (and over
  // the logs). Only the material whose faces the animation actually fades — the
  // flame texture — may blend; everything else keeps depthWrite and stays opaque.
  const matBlended: boolean[] = materials.map(() => false)
  const setMatBlended = (mi: number, on: boolean) => {
    if (matBlended[mi] === on) return
    matBlended[mi] = on
    const mm = materials[mi] as THREE.MeshBasicMaterial
    if (on) {
      mm.transparent = true
      mm.depthWrite = false
      mm.alphaTest = 0
    } else {
      mm.transparent = mm.userData.blendType === 2
      mm.depthWrite = mm.userData.blendType !== 2
      mm.alphaTest = mm.userData.baseAlphaTest ?? 0
    }
    mm.needsUpdate = true
  }
  const matNeedsBlend: boolean[] = materials.map(() => false)

  const update = (posed: PosedVertices) => {
    if (posed.x.length !== model.vertexCount) return
    const X = posed.x, Y = posed.y, Z = posed.z
    for (let i = 0; i < cornerVertex.length; i++) {
      const v = cornerVertex[i]
      positions[i * 3] = X[v] * upscale
      positions[i * 3 + 1] = -Y[v] * upscale
      positions[i * 3 + 2] = -Z[v] * upscale
    }
    positionAttr.needsUpdate = true

    // Type-5 face alpha: RS stores 0 = opaque … 255 = invisible, GL opacity is
    // the complement. Only materials that actually get a faded face blend.
    const pa = posed.faceAlpha
    matNeedsBlend.fill(false)
    if (pa) {
      for (let i = 0; i < cornerFace.length; i++) {
        const a = pa[cornerFace[i]] & 0xff
        colors[i * 4 + 3] = (255 - a) / 255
        if (a !== 0) matNeedsBlend[faceMat[(i / 3) | 0]] = true
      }
    } else {
      for (let i = 0; i < cornerFace.length; i++) colors[i * 4 + 3] = 1
    }
    for (let mi = 0; mi < materials.length; mi++) setMatBlended(mi, matNeedsBlend[mi])
    colorAttr.needsUpdate = true
  }

  return { mesh, update }
}

// Which way a wall decoration is pushed off its wall, per rotation — the
// client's own tables (Class329_Sub1.anIntArray7724/7720 for the straight
// decorations, 7721/7713 for the diagonal ones), in RS x/z.
const DECOR_DX = [1, 0, -1, 0]
const DECOR_DZ = [0, -1, 0, 1]
const DECOR_DIAG_DX = [1, -1, -1, 1]
const DECOR_DIAG_DZ = [-1, -1, 1, 1]

/** An invisible utility loc (sound emitter / map-icon anchor) worth showing
 *  as an editor marker instead of its teal quad. Scene-local coordinates. */
export type MarkerInfo = {
  x: number
  y: number
  z: number
  objectId: number
  kind: 'sound' | 'mapicon' | 'mapsprite' | 'barrier' | 'other'
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
  mapsprite: 0x3ad0c8, // teal — minimap "mapscene" sprite anchors
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

/** One `lights[]` record — the client's `Class287` constructor, field for field. */
export type RegionLight = {
  /** the light's own plane; `grows*` extend the range it registers on */
  plane: number
  growsUpwards: boolean
  growsDownwards: boolean
  /** region-local world units (the record stores `u16 << 2`) */
  x: number
  z: number
  /** height, world units */
  y: number
  size2d: number
  /** Per-tile-row spans of the light's footprint: `s >>> 8` is the row's x
   *  offset, `s & 0xff` its length. `size2d*2+1` entries. NOT a radius — the
   *  client only uses these to register the light into its per-tile grid. */
  ranges: number[]
  /** packed HSV (not HSL) — see `lightHsvToHsl16` */
  colorHsl: number
  /** flicker preset 0-30, or 31 = "use `lightTypeId`" (config/light_intensities) */
  type: number
  /** flicker phase offset, `(packed & 0xe0) << 3` */
  rotationOffset: number
  lightTypeId?: number
}

// SceneObjectManager.anInt2592 / anInt2594 — the scene's tile shift and half-tile.
const LIGHT_TILE_SHIFT = 9
const LIGHT_HALF_TILE = (1 << LIGHT_TILE_SHIFT) >> 1

/**
 * `VarDefinitions.method6362` — a light's stored colour is packed HSV, and the
 * client converts it to the standard HSL16 palette index before the lookup in
 * `Class335.HSL_TO_RGB`. Straight `hslToRgb(colorHsl)` gives the wrong colour.
 */
export function lightHsvToHsl16(hsv: number): number {
  const hue = (hsv >> 10) & 0x3f
  const value = hsv & 0x7f
  let sat = (hsv >> 3) & 0x70
  sat = value <= 64 ? (value * sat) >> 7 : (sat * (127 - value)) >> 7
  const sum = sat + value
  const s = sum !== 0 ? ((sat << 8) / sum) | 0 : sat << 1
  return ((hue << 10) | ((s >> 4) << 7) | sum) & 0xffff
}

/** A light's reach in world units — `Class287` line 52. */
export function lightRadius(rec: RegionLight): number {
  return (rec.size2d << LIGHT_TILE_SHIFT) + LIGHT_HALF_TILE
}

/** A light's rendered colour from its stored `colorHsl` (packed HSV -> HSL16
 *  -> palette RGB). */
export function lightRgb(colorHsl: number): number {
  return hslToRgb(lightHsvToHsl16(colorHsl))
}

/**
 * Where a light record sits in scene space. Its stored `y` is a height ABOVE
 * its tile, not a render coordinate: Class329_Sub1 repositions the light to
 * `tileHeights[plane][tx][tz] - y`. Terrain heights are negative-up, so
 * scene y = -(ground - y) = -ground + y.
 */
export function lightScenePos(rec: RegionLight, heightsAll: Int32Array[]): { x: number; y: number; z: number; ground: number } {
  const tx = Math.min(Math.max(rec.x >> LIGHT_TILE_SHIFT, 0), VERTS - 1)
  const tz = Math.min(Math.max(rec.z >> LIGHT_TILE_SHIFT, 0), VERTS - 1)
  const ground = heightsAll[Math.min(Math.max(rec.plane, 0), heightsAll.length - 1)]?.[tx * VERTS + tz] ?? 0
  // world -> scene, the same flip loc placements use
  return { x: rec.x, y: -ground + rec.y, z: -rec.z, ground: -ground }
}

/**
 * Footprint spans for a light of the given `size2d`, as the editor writes them
 * when a light is created or resized: one row per tile of the bounding box,
 * each covering the full width (`offset 0, length size2d*2+1`).
 *
 * The real records carry hand-authored shapes — some are full squares like
 * this, others carve out a rough circle (e.g. size2d 3 dumps as
 * `[0, 261 x5, 0]` = a 5-wide band inside a 7x7 box). The client only uses
 * them to decide which tiles the light registers on, so a full box is the
 * safe, maximal choice; existing records keep whatever they already had.
 */
export function lightRangesFor(size2d: number): number[] {
  const rows = size2d * 2 + 1
  return new Array(rows).fill(rows)
}

/** Per-tile point lights for a region, mirroring the client's tile grid. */
export type LightGrid = {
  /** The ≤4 lights the client would bind for an object covering these tiles. */
  at(plane: number, x0: number, y0: number, x1: number, y1: number): PointLight[]
  /** how many light records went in (0 = nothing to bake) */
  count: number
}

const NO_LIGHTS: PointLight[] = []

/**
 * Build the region's point-light lookup, following `Class287` +
 * `SceneObjectManager.method3441`:
 *
 *  - radius  = `(size2d << 9) + 256` world units (`Class287` line 52)
 *  - colour  = HSV -> HSL16 -> palette
 *  - footprint = one tile row per `ranges[]` entry, registered on every plane
 *    from the light's own up/down to the ones its grow flags reach
 *
 * The client caps each tile at 4 lights (its grid packs four 16-bit ids into a
 * long), and an object takes the first 4 distinct lights across its footprint.
 *
 * Intensity is baked at 1.0, which is what the client uses with "Flickering
 * effects" off — every built-in preset has `ticker + surrounding == 2048`, so
 * the unflickered value is exactly 1.0. Animating it would need the lights as
 * shader uniforms rather than baked vertex colours.
 */
export function buildLightGrid(
  regionLights: RegionLight[] | undefined,
  heightsAll: Int32Array[],
  planeCount = 4,
): LightGrid {
  if (!regionLights?.length) return { at: () => NO_LIGHTS, count: 0 }
  const cells: (PointLight[] | undefined)[] = new Array(planeCount * SIZE * SIZE)
  let count = 0

  for (const rec of regionLights) {
    if (!rec.ranges?.length) continue
    const radius = lightRadius(rec)
    const rgb = lightRgb(rec.colorHsl)
    const pos = lightScenePos(rec, heightsAll)
    const light: PointLight = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      radiusSq: radius * radius,
      r: ((rgb >> 16) & 0xff) / 255,
      g: ((rgb >> 8) & 0xff) / 255,
      b: (rgb & 0xff) / 255,
    }
    count++

    const p0 = rec.growsDownwards ? 0 : rec.plane
    const p1 = rec.growsUpwards ? planeCount - 1 : rec.plane
    const rowBase = (rec.z - radius + LIGHT_HALF_TILE) >> LIGHT_TILE_SHIFT
    const colBase = (rec.x - radius + LIGHT_HALF_TILE) >> LIGHT_TILE_SHIFT
    for (let p = Math.max(p0, 0); p <= Math.min(p1, planeCount - 1); p++) {
      for (let row = 0; row < rec.ranges.length; row++) {
        const ty = rowBase + row
        if (ty < 0 || ty >= SIZE) continue
        // Class287 clamps each span into the footprint as it decodes; cryogen
        // dumps the raw shorts, so apply it here.
        const span = rec.ranges[row]
        const rows = rec.ranges.length
        const offset = Math.min(span >>> 8, rows - 1)
        const length = Math.min(span & 0xff, rows - offset)
        const from = Math.max(colBase + offset, 0)
        const to = Math.min(colBase + offset + length - 1, SIZE - 1)
        for (let tx = from; tx <= to; tx++) {
          const key = (p * SIZE + tx) * SIZE + ty
          const list = cells[key] ?? (cells[key] = [])
          if (list.length < 4) list.push(light)
        }
      }
    }
  }

  return {
    count,
    at(plane, x0, y0, x1, y1) {
      if (plane < 0 || plane >= planeCount) return NO_LIGHTS
      let out: PointLight[] | null = null
      for (let tx = Math.max(x0, 0); tx <= Math.min(x1, SIZE - 1); tx++) {
        for (let ty = Math.max(y0, 0); ty <= Math.min(y1, SIZE - 1); ty++) {
          const list = cells[(plane * SIZE + tx) * SIZE + ty]
          if (!list) continue
          for (const l of list) {
            if (!out) out = []
            else if (out.includes(l)) continue
            out.push(l)
            if (out.length === 4) return out
          }
        }
      }
      return out ?? NO_LIGHTS
    },
  }
}

/**
 * Editor gizmos for a region's point lights: a floating diamond in the light's
 * own colour, a stem down to the ground, and a ring at its radius.
 *
 * These DO depth-test (they just don't write depth). An earlier version drew
 * them x-ray so a light buried inside the loc it lights stayed reachable — but
 * picking raycasts geometry, not the depth buffer, so `pickLight` finds an
 * occluded light either way, and a solid flame-orange octahedron shining
 * through the floor reads as stray scene geometry. Only the SELECTED light's
 * ring and stalk stay x-ray, so you can always see what you have in hand.
 *
 * `indices` are positions in the region's `lights[]` array; the diamonds mesh
 * carries them so a raycast (8 triangles per diamond -> `faceIndex >> 3`)
 * resolves back to the record being edited.
 */
export function buildLightsMesh(
  lights: RegionLight[],
  heightsAll: Int32Array[],
  indices: number[],
): THREE.Group | null {
  if (indices.length === 0) return null
  const SIZE_U = 44
  const ORDER = 4000
  const group = new THREE.Group()
  const o = [
    [SIZE_U, 0, 0], [-SIZE_U, 0, 0], [0, SIZE_U, 0], [0, -SIZE_U, 0], [0, 0, SIZE_U], [0, 0, -SIZE_U],
  ]
  const faces = [
    [2, 0, 4], [2, 4, 1], [2, 1, 5], [2, 5, 0],
    [3, 4, 0], [3, 1, 4], [3, 5, 1], [3, 0, 5],
  ]
  const positions: number[] = []
  const colors: number[] = []
  const stems: number[] = []
  const stemColors: number[] = []
  const rings: number[] = []
  const ringColors: number[] = []
  const RING_SEGMENTS = 24

  for (const index of indices) {
    const rec = lights[index]
    if (!rec) continue
    const p = lightScenePos(rec, heightsAll)
    const rgb = lightRgb(rec.colorHsl)
    // gizmos are tint-only overlays, so keep them readable even for a very
    // dark light colour: lift the floor without washing out the hue
    const r = Math.max(((rgb >> 16) & 0xff) / 255, 0.15)
    const g = Math.max(((rgb >> 8) & 0xff) / 255, 0.15)
    const b = Math.max((rgb & 0xff) / 255, 0.15)
    for (const [a, b2, c] of faces) {
      for (const vi of [a, b2, c]) {
        positions.push(p.x + o[vi][0], p.y + o[vi][1], p.z + o[vi][2])
        colors.push(r, g, b)
      }
    }
    stems.push(p.x, p.y, p.z, p.x, p.ground, p.z)
    for (let i = 0; i < 2; i++) stemColors.push(r, g, b)
    // radius ring at the light's own height — how far it actually reaches
    const radius = lightRadius(rec)
    for (let s = 0; s < RING_SEGMENTS; s++) {
      const a0 = (s / RING_SEGMENTS) * Math.PI * 2
      const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2
      rings.push(
        p.x + Math.cos(a0) * radius, p.y, p.z + Math.sin(a0) * radius,
        p.x + Math.cos(a1) * radius, p.y, p.z + Math.sin(a1) * radius,
      )
      for (let i = 0; i < 2; i++) ringColors.push(r, g, b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  const diamonds = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, depthWrite: false, fog: false,
  }))
  diamonds.renderOrder = ORDER
  diamonds.userData.lights = lights
  diamonds.userData.lightIndices = indices
  group.add(diamonds)

  const stemGeometry = new THREE.BufferGeometry()
  stemGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stems), 3))
  stemGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(stemColors), 3))
  const stemLines = new THREE.LineSegments(stemGeometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
  }))
  stemLines.renderOrder = ORDER
  group.add(stemLines)

  const ringGeometry = new THREE.BufferGeometry()
  ringGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rings), 3))
  ringGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ringColors), 3))
  const ringLines = new THREE.LineSegments(ringGeometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, fog: false,
  }))
  ringLines.renderOrder = ORDER
  group.add(ringLines)

  return group
}

/** Region environment JSON (map_environments/<regionId>.json — the terrain
 *  archive's environment tail, dumped by cryogen MapEnvironmentDumper). */
export type RegionEnvironment = {
  environment?: {
    flags: number
    sunColour?: number
    sunAmbient?: number
    sunLight?: number
    sunBacklight?: number
    sunPosition?: [number, number, number]
    fogColour?: number
    fogDepth?: number
    cubeTexture?: number[]
  }
  skybox?: { id: number; x: number; y: number; z: number; rotation: number }
  lights?: RegionLight[]
  /** Bloom filter parameters for this region (map-environment opcode 2 ->
   *  darkan `Atmosphere`). Each is a byte * 8/255, so 0..8. They feed the
   *  FilterBloom `params` uniform: threshold = params.x, strength = params.y,
   *  whitePoint = params.z. Absent for regions that don't override the
   *  defaults of 1.0 / 0.25 / 1.0. */
  hdr?: { whitePoint: number; bloomStrength: number; bloomThreshold: number }
  /** Static lighting grid (opcode 129), carried verbatim as base64 by the
   *  dumper — we don't render it, and must not lose it on save. */
  lightingGrid?: string
  /** The order this region's tail listed its opcodes in. The cache isn't
   *  consistently ascending, and cryogen re-emits in this order so an unedited
   *  region repacks to identical bytes. Opaque here — pass it through. */
  opcodeOrder?: number[]
  /** Legacy marker from the first environment dump (grid present but its bytes
   *  not recorded). cryogen refuses to pack such a file; kept on the type so a
   *  save round-trips it instead of quietly dropping the warning flag. */
  hasLightingGrid?: boolean
  regionX?: number
  regionY?: number
}

export async function loadRegionEnvironment(
  rootHandle: FileSystemDirectoryHandle,
  regionId: number,
): Promise<RegionEnvironment | null> {
  try {
    const dir = await rootHandle.getDirectoryHandle('map_environments')
    const file = await (await dir.getFileHandle(`${regionId}.json`)).getFile()
    return JSON.parse(await file.text()) as RegionEnvironment
  } catch {
    return null
  }
}

/**
 * Write a region's environment JSON back, creating the folder/file if the dump
 * doesn't have one yet (a region can have lights added where it had no
 * environment tail at all).
 *
 * NOTE: cryogen dumps map_environments as read-only editor data — its map
 * repacker re-encodes only the tile section, so edits here reach the dump but
 * not the packed cache until the dumper learns to round-trip the tail.
 */
export async function saveRegionEnvironment(
  rootHandle: FileSystemDirectoryHandle,
  regionId: number,
  env: RegionEnvironment,
): Promise<void> {
  const dir = await rootHandle.getDirectoryHandle('map_environments', { create: true })
  const fileHandle = await dir.getFileHandle(`${regionId}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(env))
  await writable.close()
}

/** The region's sky dome (config/skyboxes → archiveId model, textured with
 *  its own sky/cloud materials), built for rendering around the camera. */
export async function buildSkyboxMesh(
  rootHandle: FileSystemDirectoryHandle,
  assets: LocAssets,
  skyboxId: number,
  rotation: number,
): Promise<THREE.Mesh | null> {
  try {
    const configDir = await rootHandle.getDirectoryHandle('config')
    const dir = await configDir.getDirectoryHandle('skyboxes')
    const file = await (await dir.getFileHandle(`${skyboxId}.json`)).getFile()
    const def = JSON.parse(await file.text()) as { archiveId?: number }
    if (def.archiveId === undefined || def.archiveId < 0) return null
    const model = await assets.getModel(def.archiveId)
    if (!model) return null

    const acc = new ModelAccumulator()
    acc.addModel(model, new THREE.Matrix4())
    const mesh = await acc.buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true)
    if (!mesh) return null
    for (const m of mesh.material as THREE.MeshBasicMaterial[]) {
      m.fog = false // the dome must not be fogged out
      m.depthWrite = false
      m.side = THREE.DoubleSide
      // sky textures draw untinted — the dome model's face colours are junk
      // (they'd tint the clouds green); untextured faces keep vertex colours
      if (m.map) m.vertexColors = false
      m.needsUpdate = true
    }
    mesh.renderOrder = -1000
    mesh.frustumCulled = false
    // skybox rotation is in 16384ths of a turn like everything else
    mesh.rotation.y = -(rotation / 16384) * Math.PI * 2
    return mesh
  } catch {
    return null
  }
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
  lightGrid?: LightGrid,
): Promise<{ mesh: THREE.Mesh | null; transparentLocs: THREE.Mesh[]; markers: MarkerInfo[]; shadows: Uint8Array; animated: AnimatedLoc[] }> {
  const acc = new ModelAccumulator()
  const markers: MarkerInfo[] = []
  const locRefs: LocRef[] = []
  // locs with an idle sequence (waving flags etc.) — collected out of the merged
  // static mesh so the scene can pose them per frame.
  const animated: AnimatedLoc[] = []
  // one mesh per loc that has transparent faces + the materials they share
  const transparentLocs: THREE.Mesh[] = []
  const transMaterials = new Map<number, THREE.Material>()
  // small transparent locs (ground clutter) share one mesh — see the threshold
  const sharedTrans = new BucketSet()
  // SceneGraph static shadows: values SUBTRACTED from the vertex lights.
  // Walls darken their edge's two corners by 50; scenery darkens every
  // footprint corner by the model's shadow displacement (size2d/4, clamped
  // 30 — which virtually all scenery hits, so we use the clamp).
  const shadows = new Uint8Array(VERTS * VERTS)
  const setShadow = (vx: number, vy: number, d: number) => {
    if (vx < 0 || vy < 0 || vx >= VERTS || vy >= VERTS) return
    if (shadows[vx * VERTS + vy] < d) shadows[vx * VERTS + vy] = d
  }
  // bridge columns shift down one render plane (deck = ground level)
  const planeObjects = objects.filter(([, , , x, y, p]) => {
    const bridge = x >= 0 && y >= 0 && x < SIZE && y < SIZE && isBridgeTile(terrain, x, y)
    return (bridge ? Math.max(p - 1, 0) : p) === renderPlane
  })

  // Wall decorations are pushed away from the wall they hang on by that WALL's
  // `decorDisplacement` (Class329_Sub1.method12465 reads it off getWall for the
  // decoration's own tile). Only walls — shapes 0-3, the ones the client files
  // under method3395 — are wall nodes, and only non-default values are worth
  // storing: with no wall the client falls back to 64, which is the default.
  const wallDisplacement = new Map<number, number>()
  for (const [objectId, shape, , x, y] of planeObjects) {
    if (shape > 3 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
    const dd = (await assets.getDef(objectId))?.decorDisplacement
    if (dd !== undefined && dd !== 64) wallDisplacement.set(x * SIZE + y, dd)
  }

  let done = 0
  for (const [objectId, shape, rotation, x, y, decodedPlane] of planeObjects) {
    const heights = heightsAll[decodedPlane]
    done++
    if (onProgress && done % 64 === 0) onProgress(done, planeObjects.length)
    const def = await assets.getDef(objectId)
    if (!def || !def.objectModelIds || def.objectModelIds.length === 0) continue
    const isAnimated = (def.animations?.length ?? 0) > 0

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

    if (def.staticShadow !== false) {
      if (shape <= 3) {
        // straight/corner walls: two corners of the wall's edge, 50
        if (rotation === 0) { setShadow(x, y, 50); setShadow(x, y + 1, 50) }
        else if (rotation === 1) { setShadow(x, y + 1, 50); setShadow(x + 1, y + 1, 50) }
        else if (rotation === 2) { setShadow(x + 1, y, 50); setShadow(x + 1, y + 1, 50) }
        else { setShadow(x, y, 50); setShadow(x + 1, y, 50) }
      } else if (shape >= 9 && shape <= 11) {
        // interactive scenery: whole footprint, shadow displacement 30
        for (let dx = 0; dx <= sizeX; dx++) {
          for (let dy = 0; dy <= sizeY; dy++) setShadow(x + dx, y + dy, 30)
        }
      }
    }
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
    // the ≤4 region lights this placement is bound to, picked over its footprint
    // exactly as GraphNode_Sub1_Sub1.method13036 does
    const points = lightGrid?.count
      ? lightGrid.at(decodedPlane, x, y, x + sizeX - 1, y + sizeY - 1)
      : undefined

    // `ObjectDefinition.method7971` applies, in model space and this order:
    // mirror (negate RS z, `wa`) → the rotation≥4 extras → rotate 90°·r
    // (`S(4096·r)`; RS x'=x·cos+z·sin ⇒ three −θ) → scale (resize) → translate
    // (offsetX/Y/Z). `variant` is that rotation≥4 branch:
    //   'decor'  shape 4 with rotation>3 — an extra 45° THEN a (180, 0, -180)
    //            model-space shift, which is how the client builds every
    //            diagonal wall decoration (types 6/7/8).
    //   'rot45'  shape 10 with rotation>3 — `method8012`'s `f(2048)`, the extra
    //            45° diagonal scenery (type 11) is drawn with, and no shift.
    // `offX/offZ` is the world-space displacement the scene node adds on top
    // (GraphNode_Sub1_Sub4_Sub1.method12990's `method5219`).
    type Piece = { rot: number; mirror: boolean; variant: 'plain' | 'decor' | 'rot45'; offX: number; offZ: number }
    const inverted = def.inverted ?? false
    const piece = (rot: number, variant: Piece['variant'] = 'plain', offX = 0, offZ = 0, mirror = inverted): Piece =>
      ({ rot, mirror, variant, offX, offZ })
    // the wall's displacement, defaulting to 64 exactly as the client does
    const wallDisp = wallDisplacement.get(x * SIZE + y) ?? 64
    const straightOff = wallDisp + 1
    const diagonalOff = (wallDisp >> 1) + 1
    let pieces: Piece[]
    if (shape === 2) {
      // whole-corner wall: two pieces, the first from the mirrored model
      // (rotation+4), the second rotated one step on (method12464)
      pieces = [piece(rotation, 'plain', 0, 0, true), piece((rotation + 1) & 0x3)]
    } else if (shape === 5) {
      pieces = [piece(rotation, 'plain', straightOff * DECOR_DX[rotation], straightOff * DECOR_DZ[rotation])]
    } else if (shape === 6) {
      pieces = [piece(rotation, 'decor', diagonalOff * DECOR_DIAG_DX[rotation], diagonalOff * DECOR_DIAG_DZ[rotation])]
    } else if (shape === 7) {
      pieces = [piece((rotation + 2) & 0x3, 'decor')]
    } else if (shape === 8) {
      // in-wall diagonal decoration: displaced outer piece + inner piece
      pieces = [
        piece(rotation, 'decor', diagonalOff * DECOR_DIAG_DX[rotation], diagonalOff * DECOR_DIAG_DZ[rotation]),
        piece((rotation + 2) & 0x3, 'decor'),
      ]
    } else if (shape === 11) {
      pieces = [piece(rotation, 'rot45')]
    } else {
      pieces = [piece(rotation)]
    }

    let markerModels = 0
    let markerIsBarrier = false
    // this loc's transparent faces — becomes its own mesh, like the client
    const locTrans = new BucketSet()
    for (const piece of pieces) {
      // the decoration displacement is a world-space shift of the placement
      // (RS x/z → scene x/−z), so it rides on the tile-centre translate
      const matrix = new THREE.Matrix4().makeTranslation(
        sceneX + piece.offX, -avgHeight, -(sceneY + piece.offZ))
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
      // rotation≥4 extras, applied BEFORE the 90° steps (the shift isn't
      // rotation-symmetric, so the order is load-bearing)
      if (piece.variant !== 'plain') {
        if (piece.variant === 'decor') {
          // `ia(180, 0, -180)` in RS model space — scene z is flipped
          matrix.multiply(new THREE.Matrix4().makeTranslation(180, 0, 180))
        }
        matrix.multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 4))
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
        if (def.originalColors?.length || def.originalTextures?.length) {
          // applyRecolor mutates faceColor AND faceTextures — copy both so the
          // swap doesn't leak into the shared cached model (other locs reuse it).
          m = { ...model, faceColor: model.faceColor.slice(), faceTextures: model.faceTextures?.slice() ?? null }
          applyRecolor(m, def.originalColors ?? [], def.modifiedColors ?? [], def.originalTextures ?? [], def.modifiedTextures ?? [])
        }
        // Ground-contour ("hillskew"): deform the model to follow the terrain /
        // stretch up to the next plane (bridges, hillside floors, raised
        // buildings). The render matrix still applies its −avgHeight translate,
        // so the contoured vertexY stays tile-relative.
        const contourType = def.groundContourType ?? 0
        if (contourType !== 0) {
          const contoured = contourVertexY(m, contourType, def.groundContourModifier ?? 0, heights, heightsAll[decodedPlane + 1], sceneX, sceneY, avgHeight)
          if (contoured) m = { ...m, vertexY: contoured }
        }
        if (isAnimated) {
          // keep out of the merged static mesh; the scene poses it per frame.
          // The <<2 is baked in FIRST, exactly where the client does it
          // (RSMesh.upscale before the frame is applied) — otherwise every
          // frame translation lands 4x too far on a pre-13 mesh.
          animated.push({
            model: upscaleModel(m),
            matrix: matrix.clone(),
            animationId: def.animations![0],
            owner: { objectId, shape, rotation, x, y, plane: decodedPlane },
            points,
          })
        } else {
          // resolve this model's texture blendTypes so addModel can split
          // opaque vs transparent faces synchronously
          await assets.primeBlendTypes(m)
          acc.addModel(m, matrix, locRefs.length, points ? { points } : undefined, (t) => assets.blendTypeOf(t), (t) => assets.hdrMultiplierOf(t), locTrans)
        }
      }
    }
    // One mesh per transparent loc (the client's unit), recentred so its origin
    // IS the model centre — that makes three.js's frustum cull tight and its
    // per-object depth key exactly the client's (method3421 projects the centre).
    //
    // ...but only for locs big enough for ordering to be visible. Measured on
    // region 12850 plane 0: of 2073 transparent placements, 1560 sit in the
    // 21-100 face range (ground clutter — flowers, small bushes) and only ~195
    // exceed 100 faces, which is where the actual trees live (oak 738, willow
    // 670, mid trees 260-280). Giving every one its own mesh cost ~2000 draw
    // calls at 35fps; the clutter is small enough that a shared mesh's single
    // sort position is imperceptible, so it merges.
    if (locTrans.faceCount() > TRANSPARENT_OWN_MESH_FACES) {
      const lm = await locTrans.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'transparent', transMaterials)
      if (lm) {
        lm.geometry.computeBoundingBox()
        const bb = lm.geometry.boundingBox
        if (bb) {
          const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2
          lm.geometry.translate(-cx, -cy, -cz)
          lm.position.set(cx, cy, cz)
        }
        lm.geometry.computeBoundingSphere()
        lm.userData.locs = locRefs
        lm.userData.locIndex = locRefs.length
        transparentLocs.push(lm)
      }
    } else if (locTrans.hasAny()) {
      sharedTrans.mergeFrom(locTrans)
    }
    locRefs.push({ objectId, shape, rotation, x, y, plane: decodedPlane })

    if (markerModels > 0) {
      const kind: MarkerInfo['kind'] =
        def.soundId !== undefined || def.ambientSoundId !== undefined || (def.soundGroupIds?.length ?? 0) > 0
          ? 'sound'
          : def.mapCategoryId !== undefined && def.mapCategoryId >= 0
            ? 'mapicon'
            : def.mapSpriteId !== undefined && def.mapSpriteId >= 0
              ? 'mapsprite'
              : markerIsBarrier
                ? 'barrier'
                : 'other'
      markers.push({ x: sceneX, y: -avgHeight, z: -sceneY, objectId, kind, tileX: x, tileY: y })
    }
  }
  // Opaque locs stay merged (order-independent). Transparent ones are the
  // per-loc meshes collected above, drawn after the ground.
  const mesh = await acc.buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'opaque')
  if (mesh) mesh.userData.locs = locRefs
  if (sharedTrans.hasAny()) {
    const sm = await sharedTrans.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'transparent', transMaterials)
    if (sm) {
      sm.userData.locs = locRefs
      transparentLocs.push(sm)
    }
  }
  return { mesh, transparentLocs, markers, shadows, animated }
}
