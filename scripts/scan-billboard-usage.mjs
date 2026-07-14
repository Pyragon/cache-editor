// Scans every model in the cache dump for billboard attachments and writes
// public/billboard_usage.json mapping billboard type id -> model ids that use
// it. The BillboardViewer shows this as a "Used by models" list.
//
//   node scripts/scan-billboard-usage.mjs [modelsDir] [outFile]
//
// Parse math mirrors src/loaders/models.ts decodeNewFormat (verified against
// darkan-bot-refactor Mesh.kt); old-format models predate billboards.
import fs from 'node:fs'
import path from 'node:path'

const MODELS_DIR = process.argv[2] ?? 'D:/workspace/github/cryogen-cache/unpacked/models'
const OUT_FILE = process.argv[3] ?? path.join(import.meta.dirname, '..', 'public', 'billboard_usage.json')

function u16(d, o) { return (d[o] << 8) | d[o + 1] }

function extractBillboards(d) {
  if (d.length < 26 || d[d.length - 1] !== 0xFF || d[d.length - 2] !== 0xFF) return null // old format
  const foot = d.length - 23
  const vertexCount = u16(d, foot)
  const faceCount = u16(d, foot + 2)
  const texFaceCount = d[foot + 4]
  const flags = d[foot + 5]
  if ((flags & 0x4) === 0) return null

  const hasFaceRenderTypes = (flags & 0x1) !== 0
  const version = (flags & 0x8) !== 0 ? d[d.length - 24] : 12
  const modelPriority = d[foot + 6]
  const hasFaceAlpha = d[foot + 7]
  const hasFaceSkins = d[foot + 8]
  const hasFaceTextures = d[foot + 9]
  const hasVertexSkins = d[foot + 10]
  const modelVerticesX = u16(d, foot + 11)
  const modelVerticesY = u16(d, foot + 13)
  const modelVerticesZ = u16(d, foot + 15)
  const faceIndices = u16(d, foot + 17)
  const textureIndices = u16(d, foot + 19)

  // Offset chain, mirroring decodeNewFormat
  let off = texFaceCount
  off += vertexCount
  if (hasFaceRenderTypes) off += faceCount
  off += faceCount
  if (modelPriority === 255) off += faceCount
  if (hasFaceSkins === 1) off += faceCount
  if (hasVertexSkins === 1) off += vertexCount
  if (hasFaceAlpha === 1) off += faceCount
  off += faceIndices
  if (hasFaceTextures === 1) off += faceCount * 2
  off += textureIndices
  off += faceCount * 2
  off += modelVerticesX + modelVerticesY + modelVerticesZ

  // Texture chunk sizes by render type
  if (texFaceCount > 0) {
    let simple = 0, complex = 0, type2 = 0
    for (let i = 0; i < texFaceCount; i++) {
      const type = d[i] & 0xFF
      if (type === 0) simple++
      else if (type >= 1 && type <= 3) { complex++; if (type === 2) type2++ }
    }
    const scaleBytes = version >= 15 ? 9 : version === 14 ? 7 : 6
    off += simple * 6 + complex * (6 + scaleBytes + 3) + type2 * 2
  }

  if ((flags & 0x2) !== 0) { // skip particle emitters + effectors
    const emitters = d[off]; off += 1 + emitters * 4
    const effectors = d[off]; off += 1 + effectors * 4
  }

  const count = d[off]; off += 1
  if (count === 0 || off + count * 6 > foot) return null
  const ids = []
  for (let i = 0; i < count; i++) {
    ids.push(u16(d, off)) // typeId; face/depth/distance not needed here
    off += 6
  }
  return ids
}

const usage = new Map() // billboardId -> Set(modelId)
let scanned = 0, withBillboards = 0, failed = 0

for (const name of fs.readdirSync(MODELS_DIR)) {
  if (!/^\d+$/.test(name)) continue
  const file = path.join(MODELS_DIR, name, 'model.dat')
  if (!fs.existsSync(file)) continue
  scanned++
  try {
    const typeIds = extractBillboards(fs.readFileSync(file))
    if (!typeIds) continue
    withBillboards++
    const modelId = parseInt(name, 10)
    for (const typeId of typeIds) {
      if (!usage.has(typeId)) usage.set(typeId, new Set())
      usage.get(typeId).add(modelId)
    }
  } catch {
    failed++
  }
}

const out = {}
for (const [typeId, models] of [...usage.entries()].sort((a, b) => a[0] - b[0])) {
  out[typeId] = [...models].sort((a, b) => a - b)
}
fs.writeFileSync(OUT_FILE, JSON.stringify(out))
console.log(`${scanned} models scanned, ${withBillboards} with billboards, ${failed} parse failures`)
console.log(`${Object.keys(out).length} billboard types referenced -> ${OUT_FILE}`)
