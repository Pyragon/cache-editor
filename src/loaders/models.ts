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

  smart2(): number {
    const b = this.buf[this.pos]
    if (b < 128) { this.pos++; return b }
    return this.u16() - 0x8000
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
  if (hasFaceTextures === 1) off += faceCount * 2  // face textures (not decoded here)
  off += textureIndices                             // texture positions (not decoded here)
  const faceColorOff = off
  off += faceCount * 2
  const vertXOffset = off
  off += modelVerticesX
  const vertYOffset = off
  off += modelVerticesY
  const vertZOffset = off

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

  for (let face = 0; face < faceCount; face++) {
    faceColor[face] = faceColorReader.u16()
    if (faceTypeReader) faceType![face] = faceTypeReader.s8()
    if (facePriReader) facePriorities![face] = facePriReader.s8()
    if (faceAlphaReader) faceAlpha[face] = faceAlphaReader.s8()
  }

  // Decode face indices
  decodeFaceIndices(
    new BinReader(data).at(faceIndexValOff),
    new BinReader(data).at(faceTypeOff),
    faceCount, triangleX, triangleY, triangleZ,
  )

  void version

  return {
    vertexCount, faceCount,
    vertexX, vertexY, vertexZ,
    triangleX, triangleY, triangleZ,
    faceColor, faceAlpha,
    priority: modelPriority === 255 ? 0 : modelPriority,
    facePriorities,
    faceType,
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
  const vc             = r.u16()
  const fc             = r.u16()
  const texFaceCount   = r.u8()
  const i_9            = r.u8()
  const modelPriority  = r.u8()
  const hasFaceAlphas  = r.u8()
  const hasFaceSkins   = r.u8()
  const hasVertexSkins = r.u8()
  const i_14           = r.u16()
  const i_15           = r.u16()
  r.u16() // modelVerticesZ size (not needed explicitly)
  const i_17           = r.u16()

  // Compute buffer offsets
  let off = vc                           // vertex flags start at 0, first vc bytes
  const faceTypeOff = off; off += fc    // face index type bytes (one per face)
  const facePriOff = off
  if (modelPriority === 255) off += fc
  if (hasFaceSkins === 1) off += fc     // face skins (not decoded here)
  const faceRenderTypeOff = off
  if (i_9 === 1) off += fc
  const vertSkinsOff = off
  if (hasVertexSkins === 1) off += vc
  const faceAlphaOff = off
  if (hasFaceAlphas === 1) off += fc
  const faceIndexValOff = off; off += i_17
  const faceColorOff = off; off += fc * 2
  off += texFaceCount * 6               // textured triangle coords (not decoded here)
  const vertXOff = off; off += i_14
  const vertYOff = off; off += i_15
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
  const faceType = i_9 === 1 ? new Int8Array(fc) : null

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
  const faceTypeReader  = i_9 === 1 ? new BinReader(data).at(faceRenderTypeOff) : null
  const facePriReader   = modelPriority === 255 ? new BinReader(data).at(facePriOff) : null
  const faceAlphaReader = hasFaceAlphas === 1 ? new BinReader(data).at(faceAlphaOff) : null

  for (let face = 0; face < fc; face++) {
    faceColor[face] = faceColorReader.u16()
    if (faceTypeReader) faceType![face] = faceTypeReader.s8()
    if (facePriReader) facePriorities![face] = facePriReader.s8()
    if (faceAlphaReader) faceAlpha[face] = faceAlphaReader.s8()
  }

  // Decode face indices
  decodeFaceIndices(
    new BinReader(data).at(faceIndexValOff),
    new BinReader(data).at(faceTypeOff),
    fc, triangleX, triangleY, triangleZ,
  )

  return {
    vertexCount: vc, faceCount: fc,
    vertexX, vertexY, vertexZ,
    triangleX, triangleY, triangleZ,
    faceColor, faceAlpha,
    priority: modelPriority === 255 ? 0 : modelPriority,
    facePriorities,
    faceType,
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

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const fileHandle = await subHandle.getFileHandle('model.dat')
    const file = await fileHandle.getFile()
    const buf = await file.arrayBuffer()
    return parseModel(new Uint8Array(buf), item.id)
  },
}

export default loader
