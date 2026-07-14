import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// Field names per darkan-bot-refactor MaterialType.kt (isHalfSize kept over
// darkan's "isSmall"; aBool2087 is unidentified in darkan too).
export type TextureDefinition = {
  id: number
  detailsOnly: boolean
  isHalfSize: boolean
  skipTriangles: boolean
  brightness: number
  alpha: number
  effectId: number
  effectParam1: number
  effectParam2: number
  colorHsl: number
  textureSpeedU: number
  textureSpeedV: number
  aBool2087: boolean
  isBrickTile: boolean
  mipmapping: number
  repeatS: boolean
  repeatT: boolean
  hdr: boolean
  combineMode: number
  effectCombiner: number
}

// The `textures` and `texture_definitions` entries are two halves of the same
// thing (same id space: the rendered material PNG and the fields that produced
// it), so both loaders return this shape and open the same viewer. Edits always
// save to texture_definitions/<id>.json, wherever you opened it from.
export type TextureData = {
  id: number
  png: Blob | null
  def: TextureDefinition | null
  defsDir: FileSystemDirectoryHandle | null
}

export async function loadTexturePng(
  texturesDir: FileSystemDirectoryHandle,
  id: number,
): Promise<Blob | null> {
  try {
    const subHandle = await texturesDir.getDirectoryHandle(String(id))
    return await (await subHandle.getFileHandle(`${id}.png`)).getFile()
  } catch {
    return null
  }
}

export async function loadTextureDef(
  defsDir: FileSystemDirectoryHandle,
  id: number,
): Promise<TextureDefinition | null> {
  try {
    const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
    return JSON.parse(await file.text()) as TextureDefinition
  } catch {
    return null
  }
}

export async function writeTextureDef(
  defsDir: FileSystemDirectoryHandle,
  def: TextureDefinition,
): Promise<void> {
  const fileHandle = await defsDir.getFileHandle(`${def.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(def, null, 2))
  await writable.close()
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const png = await loadTexturePng(dirHandle, item.id)

    let defsDir: FileSystemDirectoryHandle | null = null
    let def: TextureDefinition | null = null
    if (rootHandle) {
      try {
        defsDir = await rootHandle.getDirectoryHandle('texture_definitions')
        def = await loadTextureDef(defsDir, item.id)
      } catch {
        // texture_definitions not dumped — viewer renders the image only
      }
    }

    return { id: item.id, png, def, defsDir } satisfies TextureData
  },

  // Edits belong to the definition, so they save to texture_definitions/,
  // not into this entry's own folder.
  async saveItem(_dirHandle, _item, data) {
    const { def, defsDir } = data as TextureData
    if (!def || !defsDir) return
    await writeTextureDef(defsDir, def)
  },
}

export default loader
