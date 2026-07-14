import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems } from './common'
import { loadTextureDef, loadTexturePng, writeTextureDef } from './textures'
import type { TextureData, TextureDefinition } from './textures'

// texture_definitions/<id>.json — one file per material, dumped from the
// single parallel-array blob in the TEXTURE_DEFINITIONS index (cryogen
// TextureDefinitions.parseTextureDefs). Shares the textures entry's id space
// and viewer; see loaders/textures.ts for the shared TextureData shape.
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
    const def = await loadTextureDef(dirHandle, item.id)

    let png: Blob | null = null
    if (rootHandle) {
      try {
        const texturesDir = await rootHandle.getDirectoryHandle('textures')
        png = await loadTexturePng(texturesDir, item.id)
      } catch {
        // textures not dumped — viewer shows the fields without the image
      }
    }

    return { id: item.id, png, def, defsDir: dirHandle } satisfies TextureData
  },

  async saveItem(dirHandle, _item, data) {
    const { def } = data as TextureData
    if (!def) return
    await writeTextureDef(dirHandle, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeTextureDef(dirHandle, { id, ...NEW_DEFINITION_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const source = await loadTextureDef(dirHandle, item.id)
    const id = await nextFreeJsonId(dirHandle)
    await writeTextureDef(dirHandle, { ...(source ?? NEW_DEFINITION_DEFAULTS), id })
    return { id, name: String(id) }
  },
}

export default loader
