import { getEntryPath, resolveEntryHandle } from './entryOrder'

// ---------------------------------------------------------------------------
// Billboard-usage index: billboard type id -> the model ids that attach it.
//
// Same opt-in scan-once-per-session shape as animCompat.ts: the first
// BillboardViewer page to ask kicks off a scan of every models/<id>/model.dat
// (~40k binaries), then every page is served from this module-level cache.
// The parse is a light footer walk — it never decodes vertices/faces, just
// steps the decodeNewFormat (models.ts) offset chain far enough to reach the
// billboard chunk. Verified against darkan-bot-refactor Mesh.kt; old-format
// models (no 0xFFFF footer magic) predate billboards entirely.
// ---------------------------------------------------------------------------

export type BillboardUsageIndex = Map<number, number[]>

let cached: BillboardUsageIndex | null = null
let building: Promise<BillboardUsageIndex> | null = null

export function peekBillboardUsage(): BillboardUsageIndex | null {
  return cached
}

export function isBillboardUsageBuilding(): boolean {
  return building != null && cached == null
}

/** Drop the session cache so the next page shows the scan button again.
 *  Call this from any future code path that writes model binaries — today
 *  models are read-only in the editor, so the BillboardViewer's Rescan
 *  button (for after an external re-dump) is the only consumer. */
export function invalidateBillboardUsage(): void {
  cached = null
  building = null
}

function u16(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1]
}

/** Billboard type ids attached to one model binary, or null if the model is
 *  old-format / has no billboard flag / is malformed. */
function extractBillboardTypeIds(d: Uint8Array): number[] | null {
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
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    ids.push(u16(d, off)) // typeId; face/depth/distance not needed here
    off += 6
  }
  return ids
}

export function buildBillboardUsage(
  cacheRoot: FileSystemDirectoryHandle,
  onProgress: (done: number, total: number) => void,
): Promise<BillboardUsageIndex> {
  if (cached) return Promise.resolve(cached)
  if (building) return building
  building = (async () => {
    const modelsDir = await resolveEntryHandle(cacheRoot, getEntryPath('models'))
    if (!modelsDir) throw new Error('models entry not found in this cache')

    const modelIds: number[] = []
    for await (const handle of modelsDir.values()) {
      if (handle.kind !== 'directory' || !/^\d+$/.test(handle.name)) continue
      modelIds.push(parseInt(handle.name, 10))
    }
    modelIds.sort((a, b) => a - b)

    let done = 0
    const usage = new Map<number, number[]>()
    const CHUNK = 128
    for (let i = 0; i < modelIds.length; i += CHUNK) {
      const chunk = modelIds.slice(i, i + CHUNK)
      await Promise.all(chunk.map(async (modelId) => {
        try {
          const dir = await modelsDir.getDirectoryHandle(String(modelId))
          const file = await (await dir.getFileHandle('model.dat')).getFile()
          const typeIds = extractBillboardTypeIds(new Uint8Array(await file.arrayBuffer()))
          if (!typeIds) return
          for (const typeId of typeIds) {
            const list = usage.get(typeId)
            if (list) { if (!list.includes(modelId)) list.push(modelId) }
            else usage.set(typeId, [modelId])
          }
        } catch { /* missing/unreadable model.dat — skip */ }
      }))
      done += chunk.length
      onProgress(done, modelIds.length)
    }

    for (const list of usage.values()) list.sort((a, b) => a - b)
    cached = usage
    return usage
  })()
  building.catch(() => { building = null }) // allow retry after a failed scan
  return building
}
