import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// ---------------------------------------------------------------------------
// HSL → RGB lookup table (mirrors Java Utilities.HSL_2_RGB)
// ---------------------------------------------------------------------------

const HSL_2_RGB = new Int32Array(65536)
;(function buildHslTable() {
  const d = 0.7
  let i = 0
  for (let i1 = 0; i1 < 512; i1++) {
    const h = ((i1 >> 3) / 64.0 + 0.0078125) * 360.0
    const s = 0.0625 + (i1 & 7) / 8.0
    for (let i2 = 0; i2 < 128; i2++) {
      const v = i2 / 128.0
      let r = 0, g = 0, b = 0
      const hSect = h / 60.0
      const sector = Math.floor(hSect) % 6
      const f = hSect - Math.floor(hSect)
      const p = v * (1 - s)
      const q = v * (1 - f * s)
      const t = v * (1 - (1 - f) * s)
      if      (sector === 0) { r = v; g = t; b = p }
      else if (sector === 1) { r = q; g = v; b = p }
      else if (sector === 2) { r = p; g = v; b = t }
      else if (sector === 3) { r = p; g = q; b = v }
      else if (sector === 4) { r = t; g = p; b = v }
      else                   { r = v; g = p; b = q }
      HSL_2_RGB[i++] = (Math.pow(r, d) * 256 | 0) << 16
                     | (Math.pow(g, d) * 256 | 0) << 8
                     | (Math.pow(b, d) * 256 | 0)
    }
  }
})()

export function hslToRgb(hsl: number): number {
  return HSL_2_RGB[hsl & 0xFFFF] & 0xFFFFFF
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelData = {
  id: number
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
    skinReader?.u8()
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
  if (hasFaceSkins === 1) off += faceCount   // face skins (not decoded here)
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

  // Decode vertices
  decodeVertices(
    new BinReader(data).at(flagBufferOffset),
    new BinReader(data).at(vertXOffset),
    new BinReader(data).at(vertYOffset),
    new BinReader(data).at(vertZOffset),
    hasVertexSkins === 1 ? new BinReader(data).at(vertSkinsOffset) : null,
    vertexCount, vertexX, vertexY, vertexZ,
  )

  // Decode face attributes
  const faceColorReader = new BinReader(data).at(faceColorOff)
  const faceTypeReader  = hasFaceRenderTypes ? new BinReader(data).at(faceRenderTypeOff) : null
  const facePriReader   = modelPriority === 255 ? new BinReader(data).at(facePriOff) : null
  const faceAlphaReader = hasFaceAlpha === 1 ? new BinReader(data).at(faceAlphaOff) : null
  const faceTexReader   = faceTextures ? new BinReader(data).at(faceTexturesOff) : null
  const texPosReader    = texturePos ? new BinReader(data).at(texturePosOff) : null

  for (let face = 0; face < faceCount; face++) {
    faceColor[face] = faceColorReader.u16()
    if (faceTypeReader) faceType![face] = faceTypeReader.s8()
    if (facePriReader) facePriorities![face] = facePriReader.s8()
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

    let simpleCount = 0, complexCount = 0
    for (let i = 0; i < texturedFaceCount; i++) {
      const type = textureRenderTypes[i] & 0xFF
      if (type === 0) simpleCount++
      else if (type >= 1 && type <= 3) complexCount++
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
  }

  return {
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
  if (hasFaceSkins === 1) off += fc     // face skins (not decoded here)
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

  // Decode vertices
  decodeVertices(
    new BinReader(data).at(0),
    new BinReader(data).at(vertXOff),
    new BinReader(data).at(vertYOff),
    new BinReader(data).at(vertZOff),
    hasVertexSkins === 1 ? new BinReader(data).at(vertSkinsOff) : null,
    vc, vertexX, vertexY, vertexZ,
  )

  // Decode face attributes
  const faceColorReader = new BinReader(data).at(faceColorOff)
  const faceInfoReader  = hasFaceInfo === 1 ? new BinReader(data).at(faceInfoOff) : null
  const facePriReader   = modelPriority === 255 ? new BinReader(data).at(facePriOff) : null
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
    }

    return model
  },
}

export default loader
