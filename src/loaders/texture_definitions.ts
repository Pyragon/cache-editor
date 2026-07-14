import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'
import type { TextureDefinition } from './textures'

// texture_definitions/<id>.json — one file per material, dumped from the
// single parallel-array blob in the TEXTURE_DEFINITIONS index (cryogen
// TextureDefinitions.parseTextureDefs). Same id space as the textures entry.
export type TextureDefinitionData = {
  id: number
  def: TextureDefinition
  texturesDir: FileSystemDirectoryHandle | null
}

const NEW_DEFINITION_DEFAULTS: Omit<TextureDefinition, 'id'> = {
  detailsOnly: false,
  isHalfSize: false,
  skipTriangles: false,
  brightness: 0,
  alpha: 0,
  effectId: 0,
  effectParam1: 0,
  effectParam2: 0,
  colorHsl: 0,
  textureSpeedU: 0,
  textureSpeedV: 0,
  aBool2087: false,
  isBrickTile: false,
  mipmapping: 0,
  repeatS: false,
  repeatT: false,
  hdr: false,
  combineMode: 0,
  effectCombiner: 0,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as TextureDefinition

    let texturesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        texturesDir = await rootHandle.getDirectoryHandle('textures')
      } catch {
        // no textures entry in this dump — material preview unavailable
      }
    }

    return { id: item.id, def, texturesDir } satisfies TextureDefinitionData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as TextureDefinitionData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_DEFINITION_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as TextureDefinition

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
