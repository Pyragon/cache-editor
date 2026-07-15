import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems } from './common'
import { loadMaterial, loadTextureDef, loadTexturePng, resolveSpritesDir, saveTextureData, writeTextureDef } from './textures'
import type { MaterialDefinition, TextureData, TextureDefinition } from './textures'

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
    let material: MaterialDefinition | null = null
    let texturesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        texturesDir = await rootHandle.getDirectoryHandle('textures')
        png = await loadTexturePng(texturesDir, item.id)
        material = await loadMaterial(texturesDir, item.id)
      } catch {
        // textures not dumped — viewer shows the fields without image or ops
      }
    }

    const spritesDir = await resolveSpritesDir(rootHandle)
    return { id: item.id, png, def, defsDir: dirHandle, material, texturesDir, spritesDir } satisfies TextureData
  },

  saveItem: (_dirHandle, _item, data) => saveTextureData(data as TextureData),

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
