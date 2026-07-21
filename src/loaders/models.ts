import type { CacheLoader } from './types'
import { streamDirItems } from './common'
import { loadMaterialPng, loadProducer, loadTypes } from './particles'

// ---------------------------------------------------------------------------
// HSL → RGB lookup table — the RT5 engine's mesh palette, ported from the 727
// client (Class540.anIntArray7136, built in CutsceneCameraMovement.method1365).
// This is a true HSL-triangle conversion, NOT the HSV-style table in cryogen's
// Utilities.HSL_2_RGB — the two differ in saturation shape (verified against
// in-game inventory renders: the HSV table reads visibly washed out). The
// client jitters gamma by ±0.015 per palette build; we use a fixed 0.7.
// ---------------------------------------------------------------------------

const HSL_2_RGB = new Int32Array(65536)
;(function buildHslTable() {
  const d = 0.7
  for (let i = 0; i < 65536; i++) {
    const hue = ((i >> 10) & 0x3f) / 64.0 + 0.0078125
    const sat = 0.0625 + ((i >> 7) & 0x7) / 8.0
    const lum = (i & 0x7f) / 128.0
    let r = lum, g = lum, b = lum
    if (sat !== 0.0) {
      const q = lum < 0.5 ? lum * (1.0 + sat) : lum + sat - lum * sat
      const p = 2.0 * lum - q
      const channel = (t: number): number => {
        if (t > 1.0) t--
        else if (t < 0.0) t++
        if (t * 6.0 < 1.0) return p + (q - p) * 6.0 * t
        if (t * 2.0 < 1.0) return q
        if (t * 3.0 < 2.0) return p + (q - p) * 6.0 * (2.0 / 3.0 - t)
        return p
      }
      r = channel(hue + 1.0 / 3.0)
      g = channel(hue)
      b = channel(hue - 1.0 / 3.0)
    }
    HSL_2_RGB[i] = (Math.trunc(Math.pow(r, d) * 256.0) << 16)
                 | (Math.trunc(Math.pow(g, d) * 256.0) << 8)
                 |  Math.trunc(Math.pow(b, d) * 256.0)
  }
})()

export function hslToRgb(hsl: number): number {
  return HSL_2_RGB[hsl & 0xFFFF] & 0xFFFFFF
}

// Exact analytic inverse of the palette above, ported from darkan
// ColorUtil.rgbToHsl24 (used by map underlay/overlay tile colours, which
// store raw 24-bit RGB and convert to this packed HSL16 form at render
// time). O(1) — unlike a nearest-match table search, this is cheap enough to
// call per map tile.
export function rgb24ToHsl16(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 256.0
  const g = ((rgb >> 8) & 0xff) / 256.0
  const b = (rgb & 0xff) / 256.0
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let hue = 0.0
  let sat = 0.0
  const lightness = (max + min) / 2.0
  if (max !== min) {
    sat = lightness < 0.5 ? (max - min) / (max + min) : (max - min) / (2.0 - max - min)
    if (r === max) hue = (g - b) / (max - min)
    else if (g === max) hue = 2.0 + (b - r) / (max - min)
    else hue = 4.0 + (r - g) / (max - min)
  }
  hue /= 6.0
  const hueInt = Math.trunc(256.0 * hue)
  let satInt = Math.trunc(sat * 256.0)
  let lightInt = Math.trunc(lightness * 256.0)
  if (satInt < 0) satInt = 0
  else if (satInt > 255) satInt = 255
  if (lightInt < 0) lightInt = 0
  else if (lightInt > 255) lightInt = 255
  if (lightInt > 243) satInt >>= 4
  else if (lightInt > 217) satInt >>= 3
  else if (lightInt > 192) satInt >>= 2
  else if (lightInt > 179) satInt >>= 1
  return (((hueInt & 0xff) >> 2) << 10) + (lightInt >> 1) + ((satInt >> 5) << 7)
}

// Raw 24-bit RGB (as stored in underlay/overlay defs) → CSS colour, through
// the same lossy HSL16 palette quantisation the client actually renders
// with — so the preview matches in-game, not just the raw uploaded colour.
export function rgbToRenderedHex(rgb: number): string {
  const quantised = hslToRgb(rgb24ToHsl16(rgb))
  return `#${quantised.toString(16).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelData = {
  id: number
  /** Mesh format version. Pre-13 meshes store coordinates at 1× — the client
   *  upscales them <<2 into the version-13+ fixed-point space before
   *  rendering (RSMesh.upscale / darkan Mesh.upscale). */
  version: number
  vertexCount: number
  faceCount: number
  vertexX: Int32Array
  vertexY: Int32Array
  vertexZ: Int32Array
  triangleX: Int16Array
  triangleY: Int16Array
  triangleZ: Int16Array
  faceColor: Uint16Array   // packed HSL
  faceAlpha: Int8Array     // 0 = opaque
  priority: number
  facePriorities: Int8Array | null
  faceType: Int8Array | null
  faceTextures: Int32Array | null  // texture id per face, -1 = untextured
  texturePos: Int16Array | null    // per-face index into the texture mappings, -1 = use the face's own corners
  // Texture mapping type per entry: 0 = flat (PNM triangle), 1 = cylinder,
  // 2 = cube, 3 = sphere.
  textureRenderTypes: Int8Array | null
  // Type 0 mappings: vertex indices defining the texture plane. P is the
  // texture origin, M the end of the U axis, N the end of the V axis.
  textureP: Int32Array | null
  textureM: Int32Array | null
  textureN: Int32Array | null
  // Type 1-3 mappings: projection normal, scale, and rotation.
  textureNormalX: Int16Array | null
  textureNormalY: Int16Array | null
  textureNormalZ: Int16Array | null
  textureScaleX: Int32Array | null
  textureScaleY: Int32Array | null
  textureScaleZ: Int32Array | null
  textureRotation: Uint8Array | null
  textureDirection: Int8Array | null  // UV axis swizzle, 0-3
  textureSpeed: Int8Array | null      // UV scroll offset, applied as byte / 256
  // Cube (type 2) U/V translate, applied as byte / 256.
  textureTransU: Int8Array | null
  textureTransV: Int8Array | null
  textures: Map<number, Blob>      // texture id → rendered material PNG
  // texture id → the material's UV scroll, in 64ths of a repeat per second (the
  // fire cape's flow: OpenGlToolkit scrolls offset = seconds * speed / 64). Only
  // materials that actually move have an entry.
  textureSpeeds: Map<number, { u: number; v: number }>
  // Billboard attachments (darkan Mesh.kt: u8 count, then u16 typeId,
  // u16 face, u8 depth, s8 distance per entry; gated by footer flag 0x4).
  billboards: ModelBillboard[] | null
  // billboard type id → its config + rendered material PNG, resolved by the loader.
  billboardTypes: Map<number, { def: BillboardTypeDef; material: Blob | null }>
  // Particle emitters (darkan Mesh.kt, footer flag 0x2): each binds a producer to
  // one face of the mesh; particles spawn from random points on that triangle.
  emitters: ModelEmitter[] | null
  // producer id → everything the viewer needs to run it, resolved by the loader.
  emitterProducers: Map<number, EmitterProducer>
  // Effectors (same footer flag, second list) and their resolved particle types.
  effectors: ModelEffector[] | null
  effectorTypes: Map<number, EffectorType>
  // Per-vertex bone-group id (darkan Mesh.kt vertexSkinBuf) — animation frame
  // bases index vertex groups by these ids via their `labels` arrays. Absent
  // on models with no skeletal animation (most static scenery).
  vertexSkins: Uint8Array | null
  // Per-face group label (darkan Mesh.kt faceGroups) — the type 5 (alpha) and
  // 7 (colour) animation transforms address face groups by these. −1 =
  // unlabelled (the client's merge default for parts without face skins).
  faceSkins: Int16Array | null
}

// Structural mirror of ParticleType (see loaders/particles.ts) — everything the
// effector attraction math reads.
export type EffectorType = {
  id: number
  offsetX: number
  offsetY: number
  offsetZ: number
  currentOffset: number
  sizeMultiplier: number
  type: number
  particleHandlingType: number
  verticeCalculationType: number
  zan: number
  size3d: number
  uid: number
}

export type ModelEmitter = {
  producerId: number
  face: number
}

// An effective vertex: binds a particle TYPE (archive 1) to one vertex, where it
// pulls/pushes nearby particles whose producer lists that type in particleFileIds2
// or effectiveVertexUids.
export type ModelEffector = {
  effectId: number
  vertex: number
}

// Kept structural (like BillboardTypeDef) to avoid making every ModelData consumer
// depend on the particles loader. `producer` is the full ParticleProducer JSON.
export type EmitterProducer = {
  producer: Record<string, unknown>
  types: EffectorType[]
  material: Blob | null
}

export type ModelBillboard = {
  typeId: number
  face: number
  depth: number
  distance: number
}

// Mirrors BillboardDef in loaders/billboards.ts (kept structural to avoid a cycle).
export type BillboardTypeDef = {
  materialId: number
  size2d: number
  size3d: number
  shape: number
  blendType: number
  stationary: boolean
  hasUid: boolean
}

// ---------------------------------------------------------------------------
// Binary reader
// ---------------------------------------------------------------------------

class BinReader {
  private buf: Uint8Array
  pos = 0

  constructor(buf: Uint8Array) { this.buf = buf }

  at(offset: number): this { this.pos = offset; return this }

  u8()  { return this.buf[this.pos++] }
  s8()  { const b = this.buf[this.pos++]; return b > 127 ? b - 256 : b }
  u16() { return (this.buf[this.pos++] << 8) | this.buf[this.pos++] }
  s16() { const n = this.u16(); return n >= 0x8000 ? n - 0x10000 : n }
  u24() { return (this.buf[this.pos++] << 16) | (this.buf[this.pos++] << 8) | this.buf[this.pos++] }

  // Java InputStream.readUnsignedSmart2: byte < 128 → byte - 64, else u16 - 49152
  smart2(): number {
    const b = this.buf[this.pos]
    if (b < 128) { this.pos++; return b - 64 }
    return this.u16() - 49152
  }
}

// ---------------------------------------------------------------------------
// Decode helpers
// ---------------------------------------------------------------------------

function toShort(n: number): number {
  n = n & 0xFFFF
  return n >= 0x8000 ? n - 0x10000 : n
}

function decodeFaceIndices(
  valueReader: BinReader,
  typeReader: BinReader,
  faceCount: number,
  triangleX: Int16Array,
  triangleY: Int16Array,
  triangleZ: Int16Array,
) {
  let x = 0, y = 0, z = 0, prevZ = 0
  for (let face = 0; face < faceCount; face++) {
    const type = typeReader.u8()
    if (type === 1) {
      x = toShort(valueReader.smart2() + prevZ)
      y = toShort(valueReader.smart2() + x)
      z = toShort(valueReader.smart2() + y)
      prevZ = z
    } else if (type === 2) {
      y = z
      z = toShort(valueReader.smart2() + prevZ)
      prevZ = z
    } else if (type === 3) {
      x = z
      z = toShort(valueReader.smart2() + prevZ)
      prevZ = z
    } else if (type === 4) {
      const tmp = x; x = y; y = tmp
      z = toShort(valueReader.smart2() + prevZ)
      prevZ = z
    }
    triangleX[face] = x
    triangleY[face] = y
    triangleZ[face] = z
  }
}

function decodeVertices(
  flagReader: BinReader,
  xReader: BinReader,
  yReader: BinReader,
  zReader: BinReader,
  skinReader: BinReader | null,
  vertexCount: number,
  vertexX: Int32Array,
  vertexY: Int32Array,
  vertexZ: Int32Array,
  vertexSkins: Uint8Array | null,
) {
  let bx = 0, by = 0, bz = 0
  for (let v = 0; v < vertexCount; v++) {
    const flags = flagReader.u8()
    if (flags & 0x1) bx += xReader.smart2()
    if (flags & 0x2) by += yReader.smart2()
    if (flags & 0x4) bz += zReader.smart2()
    vertexX[v] = bx
    vertexY[v] = by
    vertexZ[v] = bz
    if (vertexSkins) vertexSkins[v] = skinReader!.u8()
  }
}

// ---------------------------------------------------------------------------
// New format decode (last 2 bytes == 0xFF,0xFF)
// ---------------------------------------------------------------------------

function decodeNewFormat(data: Uint8Array): Omit<ModelData, 'id'> {
  const r = new BinReader(data)
  r.at(data.length - 23)

  const vertexCount = r.u16()
  const faceCount = r.u16()
  const texturedFaceCount = r.u8()
  const flags = r.u8()
  const hasFaceRenderTypes = (flags & 0x1) !== 0
  const hasVersion         = (flags & 0x8) !== 0

  let version = 12
  if (hasVersion) {
    r.at(data.length - 23 + 6 - 7) // offset rewind as Java does
    version = r.u8()
    r.at(data.length - 23 + 6)     // restore
  }

  const modelPriority  = r.u8()
  const hasFaceAlpha   = r.u8()
  const hasFaceSkins   = r.u8()
  const hasFaceTextures = r.u8()
  const hasVertexSkins  = r.u8()
  const modelVerticesX  = r.u16()
  const modelVerticesY  = r.u16()
  const modelVerticesZ  = r.u16()
  const faceIndices     = r.u16()
  const textureIndices  = r.u16()

  // Texture render types live at the very start of the buffer, one byte per
  // textured face. Only type 0 (simple PNM triangle) is decoded here.
  const textureRenderTypes = new Int8Array(texturedFaceCount)
  if (texturedFaceCount > 0) {
    const trt = new BinReader(data).at(0)
    for (let i = 0; i < texturedFaceCount; i++) textureRenderTypes[i] = trt.s8()
  }

  // Compute buffer offsets (mirrors Java layout)
  let off = texturedFaceCount
  const flagBufferOffset = off
  off += vertexCount
  const faceRenderTypeOff = off
  if (hasFaceRenderTypes) off += faceCount
  const faceTypeOff = off       // face index type bytes (one per face)
  off += faceCount
  const facePriOff = off
  if (modelPriority === 255) off += faceCount
  const faceSkinsOff = off
  if (hasFaceSkins === 1) off += faceCount
  const vertSkinsOffset = off
  if (hasVertexSkins === 1) off += vertexCount
  const faceAlphaOff = off
  if (hasFaceAlpha === 1) off += faceCount
  const faceIndexValOff = off   // face index value smarts
  off += faceIndices
  const faceTexturesOff = off
  if (hasFaceTextures === 1) off += faceCount * 2
  const texturePosOff = off
  off += textureIndices
  const faceColorOff = off
  off += faceCount * 2
  const vertXOffset = off
  off += modelVerticesX
  const vertYOffset = off
  off += modelVerticesY
  const vertZOffset = off
  off += modelVerticesZ
  const texPnmOffset = off      // simple (type 0) texture triangles, 3 × u16 each
  let textureEndOff = texPnmOffset  // start of the trailing particle/billboard chunks

  // Allocate arrays
  const vertexX = new Int32Array(vertexCount)
  const vertexY = new Int32Array(vertexCount)
  const vertexZ = new Int32Array(vertexCount)
  const triangleX = new Int16Array(faceCount)
  const triangleY = new Int16Array(faceCount)
  const triangleZ = new Int16Array(faceCount)
  const faceColor = new Uint16Array(faceCount)
  const faceAlpha = new Int8Array(faceCount)
  const facePriorities = modelPriority === 255 ? new Int8Array(faceCount) : null
  const faceType = hasFaceRenderTypes ? new Int8Array(faceCount) : null
  const faceTextures = hasFaceTextures === 1 ? new Int32Array(faceCount) : null
  const texturePos = hasFaceTextures === 1 && texturedFaceCount > 0 ? new Int16Array(faceCount) : null
  const vertexSkins = hasVertexSkins === 1 ? new Uint8Array(vertexCount) : null
  // −1 = unlabelled, matching the client's merge default (Mesh.kt writes −1
  // for faces from parts without skins; createFaceGroups skips group < 0)
  const faceSkins = hasFaceSkins === 1 ? new Int16Array(faceCount) : null

  // Decode vertices
  decodeVertices(
    new BinReader(data).at(flagBufferOffset),
    new BinReader(data).at(vertXOffset),
    new BinReader(data).at(vertYOffset),
    new BinReader(data).at(vertZOffset),
    hasVertexSkins === 1 ? new BinReader(data).at(vertSkinsOffset) : null,
    vertexCount, vertexX, vertexY, vertexZ, vertexSkins,
  )

  // Decode face attributes
  const faceColorReader = new BinReader(data).at(faceColorOff)
  const faceTypeReader  = hasFaceRenderTypes ? new BinReader(data).at(faceRenderTypeOff) : null
  const facePriReader   = modelPriority === 255 ? new BinReader(data).at(facePriOff) : null
  const faceSkinsReader = faceSkins ? new BinReader(data).at(faceSkinsOff) : null
  const faceAlphaReader = hasFaceAlpha === 1 ? new BinReader(data).at(faceAlphaOff) : null
  const faceTexReader   = faceTextures ? new BinReader(data).at(faceTexturesOff) : null
  const texPosReader    = texturePos ? new BinReader(data).at(texturePosOff) : null

  for (let face = 0; face < faceCount; face++) {
    faceColor[face] = faceColorReader.u16()
    if (faceTypeReader) faceType![face] = faceTypeReader.s8()
    if (facePriReader) facePriorities![face] = facePriReader.s8()
    if (faceSkinsReader) faceSkins![face] = faceSkinsReader.u8()
    if (faceAlphaReader) faceAlpha[face] = faceAlphaReader.s8()
    if (faceTexReader) faceTextures![face] = faceTexReader.u16() - 1
    if (texPosReader) {
      texturePos![face] = faceTextures![face] !== -1 ? texPosReader.u8() - 1 : -1
    }
  }

  // Decode face indices
  decodeFaceIndices(
    new BinReader(data).at(faceIndexValOff),
    new BinReader(data).at(faceTypeOff),
    faceCount, triangleX, triangleY, triangleZ,
  )

  // Decode texture mappings. Type 0 entries hold a P/M/N vertex triangle;
  // types 1-3 hold a projection: normal (3 × s16), scale (width depends on
  // model version), rotation byte, direction byte, and UV animation speed —
  // the last two are not needed for static rendering.
  let textureP: Int32Array | null = null
  let textureM: Int32Array | null = null
  let textureN: Int32Array | null = null
  let textureNormalX: Int16Array | null = null
  let textureNormalY: Int16Array | null = null
  let textureNormalZ: Int16Array | null = null
  let textureScaleX: Int32Array | null = null
  let textureScaleY: Int32Array | null = null
  let textureScaleZ: Int32Array | null = null
  let textureRotation: Uint8Array | null = null
  let textureDirection: Int8Array | null = null
  let textureSpeed: Int8Array | null = null
  let textureTransU: Int8Array | null = null
  let textureTransV: Int8Array | null = null
  if (texturedFaceCount > 0) {
    textureP = new Int32Array(texturedFaceCount)
    textureM = new Int32Array(texturedFaceCount)
    textureN = new Int32Array(texturedFaceCount)
    textureNormalX = new Int16Array(texturedFaceCount)
    textureNormalY = new Int16Array(texturedFaceCount)
    textureNormalZ = new Int16Array(texturedFaceCount)
    textureScaleX = new Int32Array(texturedFaceCount)
    textureScaleY = new Int32Array(texturedFaceCount)
    textureScaleZ = new Int32Array(texturedFaceCount)
    textureRotation = new Uint8Array(texturedFaceCount)
    textureDirection = new Int8Array(texturedFaceCount)
    textureSpeed = new Int8Array(texturedFaceCount)
    textureTransU = new Int8Array(texturedFaceCount)
    textureTransV = new Int8Array(texturedFaceCount)

    let simpleCount = 0, complexCount = 0, type2Count = 0
    for (let i = 0; i < texturedFaceCount; i++) {
      const type = textureRenderTypes[i] & 0xFF
      if (type === 0) simpleCount++
      else if (type >= 1 && type <= 3) {
        complexCount++
        if (type === 2) type2Count++
      }
    }
    const scaleBytes = version >= 15 ? 9 : version === 14 ? 7 : 6

    const normalsOff   = texPnmOffset + simpleCount * 6
    const scalesOff    = normalsOff + complexCount * 6
    const rotationsOff = scalesOff + complexCount * scaleBytes
    const directionsOff = rotationsOff + complexCount
    const speedsOff    = directionsOff + complexCount

    const simple     = new BinReader(data).at(texPnmOffset)
    const normals    = new BinReader(data).at(normalsOff)
    const scales     = new BinReader(data).at(scalesOff)
    const rotations  = new BinReader(data).at(rotationsOff)
    const directions = new BinReader(data).at(directionsOff)
    const speeds     = new BinReader(data).at(speedsOff)

    for (let i = 0; i < texturedFaceCount; i++) {
      const type = textureRenderTypes[i] & 0xFF
      if (type === 0) {
        textureP[i] = simple.u16()
        textureM[i] = simple.u16()
        textureN[i] = simple.u16()
      } else if (type <= 3) {
        textureNormalX[i] = normals.s16()
        textureNormalY[i] = normals.s16()
        textureNormalZ[i] = normals.s16()
        if (version >= 15) {
          textureScaleX[i] = scales.u24()
          textureScaleY[i] = scales.u24()
          textureScaleZ[i] = scales.u24()
        } else if (version === 14) {
          textureScaleX[i] = scales.u16()
          textureScaleY[i] = scales.u24()
          textureScaleZ[i] = scales.u16()
        } else {
          textureScaleX[i] = scales.u16()
          textureScaleY[i] = scales.u16()
          textureScaleZ[i] = scales.u16()
        }
        textureRotation[i] = rotations.u8()
        textureDirection[i] = directions.s8()
        textureSpeed[i] = speeds.s8()
        if (type === 2) {
          textureTransU[i] = speeds.s8()
          textureTransV[i] = speeds.s8()
        }
      }
    }
    textureEndOff = speedsOff + complexCount + 2 * type2Count
  }

  // Particle emitters/effectors (flag 0x2) then billboards (flag 0x4) trail the
  // texture data — darkan Mesh.kt reads them sequentially from there. Previously
  // emitters were only SKIPPED, and only when the billboard flag was also set, so a
  // model with emitters but no billboards lost them entirely.
  let billboards: ModelBillboard[] | null = null
  let emitters: ModelEmitter[] | null = null
  let effectors: ModelEffector[] | null = null
  if ((flags & 0x2) !== 0 || (flags & 0x4) !== 0) {
    try {
      const footerStart = data.length - 23
      const tail = new BinReader(data).at(textureEndOff)
      if ((flags & 0x2) !== 0) {
        const emitterCount = tail.u8()
        if (emitterCount > 0) {
          emitters = []
          for (let i = 0; i < emitterCount; i++) {
            emitters.push({ producerId: tail.u16(), face: tail.u16() })
          }
        }
        const effectorCount = tail.u8()
        if (effectorCount > 0) {
          effectors = []
          for (let i = 0; i < effectorCount; i++) {
            effectors.push({ effectId: tail.u16(), vertex: tail.u16() })
          }
        }
      }
      if ((flags & 0x4) !== 0) {
        const count = tail.u8()
        if (count > 0 && tail.pos + count * 6 <= footerStart) {
          billboards = []
          for (let i = 0; i < count; i++) {
            billboards.push({ typeId: tail.u16(), face: tail.u16(), depth: tail.u8(), distance: tail.s8() })
          }
        }
      }
    } catch {
      // malformed/unexpected tail — model still renders, just without attachments
      emitters = null
      effectors = null
      billboards = null
    }
  }

  return {
    version,
    vertexCount, faceCount,
    vertexX, vertexY, vertexZ,
    triangleX, triangleY, triangleZ,
    faceColor, faceAlpha,
    priority: modelPriority === 255 ? 0 : modelPriority,
    facePriorities,
    faceType,
    faceTextures, texturePos,
    textureRenderTypes: texturedFaceCount > 0 ? textureRenderTypes : null,
    textureP, textureM, textureN,
    textureNormalX, textureNormalY, textureNormalZ,
    textureScaleX, textureScaleY, textureScaleZ,
    textureRotation, textureDirection, textureSpeed,
    textureTransU, textureTransV,
    textures: new Map(),
    textureSpeeds: new Map(),
    billboards,
    billboardTypes: new Map(),
    emitters,
    emitterProducers: new Map(),
    effectors,
    effectorTypes: new Map(),
    vertexSkins,
    faceSkins,
  }
}

// ---------------------------------------------------------------------------
// Old format decode
// ---------------------------------------------------------------------------

function decodeOldFormat(data: Uint8Array): Omit<ModelData, 'id'> {
  // Header: last 18 bytes
  // 2+2+1+1+1+1+1+1+2+2+2+2 = 18 bytes
  const r = new BinReader(data)
  r.at(data.length - 18)
  const vc                = r.u16()
  const fc                = r.u16()
  const texFaceCount      = r.u8()
  // When 1, each face has an info byte: bit 0 = render type, bit 1 = textured
  // (texture id is then carried in the faceColor slot), bits 2+ = texture pos.
  const hasFaceInfo       = r.u8()
  const modelPriority     = r.u8()
  const hasFaceAlphas     = r.u8()
  const hasFaceSkins      = r.u8()
  const hasVertexSkins    = r.u8()
  const vertXDataSize     = r.u16()
  const vertYDataSize     = r.u16()
  r.u16() // vertZDataSize — nothing after the Z deltas, so no offset needs it
  const faceIndexDataSize = r.u16()

  // Compute buffer offsets
  let off = vc                           // vertex flags start at 0, first vc bytes
  const faceTypeOff = off; off += fc    // face index type bytes (one per face)
  const facePriOff = off
  if (modelPriority === 255) off += fc
  const faceSkinsOff = off
  if (hasFaceSkins === 1) off += fc
  const faceInfoOff = off
  if (hasFaceInfo === 1) off += fc
  const vertSkinsOff = off
  if (hasVertexSkins === 1) off += vc
  const faceAlphaOff = off
  if (hasFaceAlphas === 1) off += fc
  const faceIndexValOff = off; off += faceIndexDataSize
  const faceColorOff = off; off += fc * 2
  const texPnmOff = off; off += texFaceCount * 6  // texture triangles, 3 × u16 each
  const vertXOff = off; off += vertXDataSize
  const vertYOff = off; off += vertYDataSize
  const vertZOff = off

  // Allocate arrays
  const vertexX = new Int32Array(vc)
  const vertexY = new Int32Array(vc)
  const vertexZ = new Int32Array(vc)
  const triangleX = new Int16Array(fc)
  const triangleY = new Int16Array(fc)
  const triangleZ = new Int16Array(fc)
  const faceColor = new Uint16Array(fc)
  const faceAlpha = new Int8Array(fc)
  const facePriorities = modelPriority === 255 ? new Int8Array(fc) : null
  const faceType = hasFaceInfo === 1 ? new Int8Array(fc) : null
  const faceTextures = hasFaceInfo === 1 ? new Int32Array(fc) : null
  const texturePos = hasFaceInfo === 1 ? new Int16Array(fc) : null
  const vertexSkins = hasVertexSkins === 1 ? new Uint8Array(vc) : null
  const faceSkins = hasFaceSkins === 1 ? new Int16Array(fc) : null

  // Decode vertices
  decodeVertices(
    new BinReader(data).at(0),
    new BinReader(data).at(vertXOff),
    new BinReader(data).at(vertYOff),
    new BinReader(data).at(vertZOff),
    hasVertexSkins === 1 ? new BinReader(data).at(vertSkinsOff) : null,
    vc, vertexX, vertexY, vertexZ, vertexSkins,
  )

  // Decode face attributes
  const faceColorReader = new BinReader(data).at(faceColorOff)
  const faceInfoReader  = hasFaceInfo === 1 ? new BinReader(data).at(faceInfoOff) : null
  const facePriReader   = modelPriority === 255 ? new BinReader(data).at(facePriOff) : null
  const faceSkinsReader = faceSkins ? new BinReader(data).at(faceSkinsOff) : null
  const faceAlphaReader = hasFaceAlphas === 1 ? new BinReader(data).at(faceAlphaOff) : null

  let anyTextured = false
  for (let face = 0; face < fc; face++) {
    faceColor[face] = faceColorReader.u16()
    if (faceInfoReader) {
      const info = faceInfoReader.u8()
      faceType![face] = info & 0x1
      if (info & 0x2) {
        texturePos![face] = info >> 2
        faceTextures![face] = faceColor[face]
        faceColor[face] = 127
        anyTextured = true
      } else {
        texturePos![face] = -1
        faceTextures![face] = -1
      }
    }
    if (facePriReader) facePriorities![face] = facePriReader.s8()
    if (faceSkinsReader) faceSkins![face] = faceSkinsReader.u8()
    if (faceAlphaReader) faceAlpha[face] = faceAlphaReader.s8()
  }

  // Decode face indices
  decodeFaceIndices(
    new BinReader(data).at(faceIndexValOff),
    new BinReader(data).at(faceTypeOff),
    fc, triangleX, triangleY, triangleZ,
  )

  // Decode texture triangles (old format is always the simple type)
  let textureP: Int32Array | null = null
  let textureM: Int32Array | null = null
  let textureN: Int32Array | null = null
  if (texFaceCount > 0) {
    textureP = new Int32Array(texFaceCount)
    textureM = new Int32Array(texFaceCount)
    textureN = new Int32Array(texFaceCount)
    const pnm = new BinReader(data).at(texPnmOff)
    for (let i = 0; i < texFaceCount; i++) {
      textureP[i] = pnm.u16()
      textureM[i] = pnm.u16()
      textureN[i] = pnm.u16()
    }
  }

  // A texture pos pointing at a triangle identical to the face's own corners
  // is redundant — normalise it to -1, as the client does.
  if (texturePos && textureP && textureM && textureN) {
    for (let face = 0; face < fc; face++) {
      const pos = texturePos[face] & 0xFF
      if (pos !== 255 &&
          triangleX[face] === textureP[pos] &&
          triangleY[face] === textureM[pos] &&
          triangleZ[face] === textureN[pos]) {
        texturePos[face] = -1
      }
    }
  }

  return {
    version: 12, // the old format predates the version byte — always pre-13 scale
    vertexCount: vc, faceCount: fc,
    vertexX, vertexY, vertexZ,
    triangleX, triangleY, triangleZ,
    faceColor, faceAlpha,
    priority: modelPriority === 255 ? 0 : modelPriority,
    facePriorities,
    faceType,
    faceTextures: anyTextured ? faceTextures : null,
    texturePos: anyTextured ? texturePos : null,
    textureRenderTypes: null, // old format mappings are always type 0
    textureP, textureM, textureN,
    textureNormalX: null, textureNormalY: null, textureNormalZ: null,
    textureScaleX: null, textureScaleY: null, textureScaleZ: null,
    textureRotation: null, textureDirection: null, textureSpeed: null,
    textureTransU: null, textureTransV: null,
    textures: new Map(),
    textureSpeeds: new Map(),
    billboards: null, // old-format models predate billboards
    billboardTypes: new Map(),
    emitters: null, // …and particle emitters
    emitterProducers: new Map(),
    effectors: null,
    effectorTypes: new Map(),
    vertexSkins,
    faceSkins,
  }
}

// ---------------------------------------------------------------------------
// Parse entry point
// ---------------------------------------------------------------------------

export function parseModel(data: Uint8Array, id: number): ModelData {
  const isNew = data[data.length - 1] === 0xFF && data[data.length - 2] === 0xFF
  const parsed = isNew ? decodeNewFormat(data) : decodeOldFormat(data)
  return { id, ...parsed }
}

// ---------------------------------------------------------------------------
// Multi-model merge (identikit body/head composites, player equipment) —
// ports cryogen's RSMesh(RSMesh[], size) constructor, used by
// IdentiKitDefinitions.renderBody()/renderHead(). The Java version also
// deduplicates shared vertices across sub-meshes (addVertexToMesh) for
// skeletal-animation correctness, but ModelViewer already flattens every
// face to its own 3 corners (no shared/indexed vertex buffer reaches
// Three.js), so a plain concatenation with index-offsetting renders
// identically without that complexity.
export function mergeModels(models: ModelData[]): ModelData {
  let vertexCount = 0, faceCount = 0, texturedFaceCount = 0
  for (const m of models) { vertexCount += m.vertexCount; faceCount += m.faceCount; texturedFaceCount += m.textureRenderTypes?.length ?? 0 }

  const vertexX = new Int32Array(vertexCount)
  const vertexY = new Int32Array(vertexCount)
  const vertexZ = new Int32Array(vertexCount)
  const triangleX = new Int16Array(faceCount)
  const triangleY = new Int16Array(faceCount)
  const triangleZ = new Int16Array(faceCount)
  const faceColor = new Uint16Array(faceCount)
  const faceAlpha = new Int8Array(faceCount)

  const anyFacePriorities = models.some((m) => m.facePriorities)
  const facePriorities = anyFacePriorities ? new Int8Array(faceCount) : null
  const anyFaceType = models.some((m) => m.faceType)
  const faceType = anyFaceType ? new Int8Array(faceCount) : null
  const anyFaceTextures = models.some((m) => m.faceTextures)
  const faceTextures = anyFaceTextures ? new Int32Array(faceCount).fill(-1) : null
  const anyTexturePos = models.some((m) => m.texturePos)
  const texturePos = anyTexturePos ? new Int16Array(faceCount).fill(-1) : null
  const anyVertexSkins = models.some((m) => m.vertexSkins)
  const vertexSkins = anyVertexSkins ? new Uint8Array(vertexCount) : null
  const anyFaceSkins = models.some((m) => m.faceSkins)
  // −1 for faces from parts without skins, per Mesh.kt's merge
  const faceSkins = anyFaceSkins ? new Int16Array(faceCount).fill(-1) : null

  const textureRenderTypes = texturedFaceCount > 0 ? new Int8Array(texturedFaceCount) : null
  const textureP = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureM = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureN = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureNormalX = texturedFaceCount > 0 ? new Int16Array(texturedFaceCount) : null
  const textureNormalY = texturedFaceCount > 0 ? new Int16Array(texturedFaceCount) : null
  const textureNormalZ = texturedFaceCount > 0 ? new Int16Array(texturedFaceCount) : null
  const textureScaleX = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureScaleY = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureScaleZ = texturedFaceCount > 0 ? new Int32Array(texturedFaceCount) : null
  const textureRotation = texturedFaceCount > 0 ? new Uint8Array(texturedFaceCount) : null
  const textureDirection = texturedFaceCount > 0 ? new Int8Array(texturedFaceCount) : null
  const textureSpeed = texturedFaceCount > 0 ? new Int8Array(texturedFaceCount) : null
  const textureTransU = texturedFaceCount > 0 ? new Int8Array(texturedFaceCount) : null
  const textureTransV = texturedFaceCount > 0 ? new Int8Array(texturedFaceCount) : null

  const textures = new Map<number, Blob>()
  const textureSpeeds = new Map<number, { u: number; v: number }>()
  const billboards: ModelBillboard[] = []
  const billboardTypes = new Map<number, { def: BillboardTypeDef; material: Blob | null }>()
  const emitters: ModelEmitter[] = []
  const emitterProducers = new Map<number, EmitterProducer>()
  const effectors: ModelEffector[] = []
  const effectorTypes = new Map<number, EffectorType>()

  let vOff = 0, fOff = 0, tOff = 0
  for (const m of models) {
    for (let v = 0; v < m.vertexCount; v++) {
      vertexX[vOff + v] = m.vertexX[v]
      vertexY[vOff + v] = m.vertexY[v]
      vertexZ[vOff + v] = m.vertexZ[v]
      if (vertexSkins) vertexSkins[vOff + v] = m.vertexSkins?.[v] ?? 0
    }
    for (let f = 0; f < m.faceCount; f++) {
      triangleX[fOff + f] = m.triangleX[f] + vOff
      triangleY[fOff + f] = m.triangleY[f] + vOff
      triangleZ[fOff + f] = m.triangleZ[f] + vOff
      faceColor[fOff + f] = m.faceColor[f]
      faceAlpha[fOff + f] = m.faceAlpha[f]
      if (faceSkins && m.faceSkins) faceSkins[fOff + f] = m.faceSkins[f]
      if (facePriorities) facePriorities[fOff + f] = m.facePriorities?.[f] ?? m.priority
      if (faceType) faceType[fOff + f] = m.faceType?.[f] ?? 0
      if (faceTextures && m.faceTextures) faceTextures[fOff + f] = m.faceTextures[f]
      if (texturePos && m.texturePos) {
        const pos = m.texturePos[f]
        texturePos[fOff + f] = pos >= 0 ? pos + tOff : -1
      }
    }
    if (m.textureRenderTypes) {
      for (let t = 0; t < m.textureRenderTypes.length; t++) {
        textureRenderTypes![tOff + t] = m.textureRenderTypes[t]
        textureP![tOff + t] = (m.textureP?.[t] ?? 0) + vOff
        textureM![tOff + t] = (m.textureM?.[t] ?? 0) + vOff
        textureN![tOff + t] = (m.textureN?.[t] ?? 0) + vOff
        textureNormalX![tOff + t] = m.textureNormalX?.[t] ?? 0
        textureNormalY![tOff + t] = m.textureNormalY?.[t] ?? 0
        textureNormalZ![tOff + t] = m.textureNormalZ?.[t] ?? 0
        textureScaleX![tOff + t] = m.textureScaleX?.[t] ?? 0
        textureScaleY![tOff + t] = m.textureScaleY?.[t] ?? 0
        textureScaleZ![tOff + t] = m.textureScaleZ?.[t] ?? 0
        textureRotation![tOff + t] = m.textureRotation?.[t] ?? 0
        textureDirection![tOff + t] = m.textureDirection?.[t] ?? 0
        textureSpeed![tOff + t] = m.textureSpeed?.[t] ?? 0
        textureTransU![tOff + t] = m.textureTransU?.[t] ?? 0
        textureTransV![tOff + t] = m.textureTransV?.[t] ?? 0
      }
    }
    for (const [id, blob] of m.textures) textures.set(id, blob)
    for (const [id, speed] of m.textureSpeeds) textureSpeeds.set(id, speed)
    if (m.billboards) for (const b of m.billboards) billboards.push({ ...b, face: b.face + fOff })
    for (const [id, info] of m.billboardTypes) billboardTypes.set(id, info)
    if (m.emitters) for (const e of m.emitters) emitters.push({ ...e, face: e.face + fOff })
    for (const [id, info] of m.emitterProducers) emitterProducers.set(id, info)
    if (m.effectors) for (const e of m.effectors) effectors.push({ ...e, vertex: e.vertex + vOff })
    for (const [id, type] of m.effectorTypes) effectorTypes.set(id, type)

    vOff += m.vertexCount
    fOff += m.faceCount
    tOff += m.textureRenderTypes?.length ?? 0
  }

  return {
    id: models[0]?.id ?? -1,
    // max of the parts: a merged mesh containing any v13+ part must not be
    // upscaled again by a consumer (mixed-version merges are inconsistent
    // regardless — the client upscales each part before combining)
    version: models.reduce((v, m) => Math.max(v, m.version), 12),
    vertexCount, faceCount,
    vertexX, vertexY, vertexZ,
    triangleX, triangleY, triangleZ,
    faceColor, faceAlpha,
    priority: models[0]?.priority ?? 0,
    facePriorities, faceType,
    faceTextures, texturePos,
    textureRenderTypes, textureP, textureM, textureN,
    textureNormalX, textureNormalY, textureNormalZ,
    textureScaleX, textureScaleY, textureScaleZ,
    textureRotation, textureDirection, textureSpeed,
    textureTransU, textureTransV,
    textures, textureSpeeds,
    billboards: billboards.length > 0 ? billboards : null,
    billboardTypes,
    emitters: emitters.length > 0 ? emitters : null,
    emitterProducers,
    effectors: effectors.length > 0 ? effectors : null,
    effectorTypes,
    vertexSkins,
    faceSkins,
  }
}

// Exact-match face recolour/retexture, in place — ports RSMesh.recolour()/
// retexture() (identikits apply these across the merged body/head mesh).
export function applyRecolor(model: ModelData, recolorFrom: number[], recolorTo: number[], retextureFrom: number[], retextureTo: number[]): void {
  for (let f = 0; f < model.faceCount; f++) {
    const hsl = model.faceColor[f]
    const idx = recolorFrom.indexOf(hsl)
    if (idx >= 0) model.faceColor[f] = recolorTo[idx]
  }
  if (model.faceTextures) {
    for (let f = 0; f < model.faceCount; f++) {
      const tex = model.faceTextures[f]
      const idx = retextureFrom.indexOf(tex)
      if (idx >= 0) model.faceTextures[f] = retextureTo[idx]
    }
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const fileHandle = await subHandle.getFileHandle('model.dat')
    const file = await fileHandle.getFile()
    const buf = await file.arrayBuffer()
    const model = parseModel(new Uint8Array(buf), item.id)

    // Load the rendered material PNG for each texture the model references.
    if (model.faceTextures && rootHandle) {
      const ids = new Set<number>()
      for (const id of model.faceTextures) if (id >= 0) ids.add(id)
      let texturesDir: FileSystemDirectoryHandle | null = null
      try {
        texturesDir = await rootHandle.getDirectoryHandle('textures')
      } catch {
        // no textures entry in this cache dump
      }
      if (texturesDir) {
        await Promise.all([...ids].map(async (id) => {
          try {
            const dir = await texturesDir.getDirectoryHandle(String(id))
            const png = await (await dir.getFileHandle(`${id}.png`)).getFile()
            model.textures.set(id, png)
          } catch {
            // missing texture — face falls back to its flat colour
          }
        }))
      }

      // The material's UV scroll speeds, so animated textures (the fire cape's
      // flowing lava) move in the viewer like they do in the client.
      let defsDir: FileSystemDirectoryHandle | null = null
      try { defsDir = await rootHandle.getDirectoryHandle('texture_definitions') } catch { /* not dumped */ }
      if (defsDir) {
        await Promise.all([...ids].map(async (id) => {
          try {
            const file = await (await defsDir!.getFileHandle(`${id}.json`)).getFile()
            const def = JSON.parse(await file.text())
            const u = def.textureSpeedU ?? 0
            const v = def.textureSpeedV ?? 0
            if (u !== 0 || v !== 0) model.textureSpeeds.set(id, { u, v })
          } catch {
            // no definition — texture stays still
          }
        }))
      }
    }

    // Resolve each emitter's producer: the producer JSON, the motion types its
    // particles inherit, and the material PNG they're drawn with.
    if (model.emitters && rootHandle) {
      let particlesDir: FileSystemDirectoryHandle | null = null
      try { particlesDir = await rootHandle.getDirectoryHandle('particles') } catch { /* not dumped */ }
      if (particlesDir) {
        const producerIds = new Set(model.emitters.map((e) => e.producerId))
        await Promise.all([...producerIds].map(async (producerId) => {
          const producer = await loadProducer(particlesDir!, producerId)
          if (!producer) return
          const types = await loadTypes(particlesDir!, producer.particleFileIds ?? [])
          const material = await loadMaterialPng(rootHandle, producer.materialId)
          model.emitterProducers.set(producerId, {
            producer: producer as unknown as Record<string, unknown>,
            types: [...types.values()],
            material,
          })
        }))

        // Effectors resolve to particle types too (their effectId IS a type id).
        if (model.effectors) {
          const effectIds = [...new Set(model.effectors.map((e) => e.effectId))]
          const types = await loadTypes(particlesDir, effectIds)
          for (const [id, type] of types) model.effectorTypes.set(id, type as EffectorType)
        }
      }
    }

    // Resolve billboard configs + their material PNGs for the attachments.
    if (model.billboards && rootHandle) {
      let billboardsDir: FileSystemDirectoryHandle | null = null
      let texturesDir: FileSystemDirectoryHandle | null = null
      try { billboardsDir = await rootHandle.getDirectoryHandle('billboards') } catch { /* not dumped */ }
      try { texturesDir = await rootHandle.getDirectoryHandle('textures') } catch { /* not dumped */ }
      if (billboardsDir) {
        const typeIds = new Set(model.billboards.map((b) => b.typeId))
        await Promise.all([...typeIds].map(async (typeId) => {
          try {
            const defFile = await (await billboardsDir!.getFileHandle(`${typeId}.json`)).getFile()
            const def = JSON.parse(await defFile.text())
            let material: Blob | null = null
            if (texturesDir && def.materialId >= 0) {
              try {
                const dir = await texturesDir.getDirectoryHandle(String(def.materialId))
                material = await (await dir.getFileHandle(`${def.materialId}.png`)).getFile()
              } catch { /* missing material */ }
            }
            model.billboardTypes.set(typeId, { def, material })
          } catch { /* missing billboard def — attachment is skipped by the viewer */ }
        }))
      }
    }

    return model
  },
}

export default loader
