import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'

// Fields per darkan-bot-refactor SkyboxType.kt (flat <id>.json dump).
export type SkyboxDef = {
  id?: number
  materialId: number
  defaultSunIndex: number
  archiveId: number
  backgroundMode: number
  sunDefinitionIds?: number[]
}

export type SkyboxData = {
  id: number
  def: SkyboxDef
  texturesDir: FileSystemDirectoryHandle | null
}

const NEW_SKYBOX_DEFAULTS: Omit<SkyboxDef, 'id'> = {
  materialId: -1,
  defaultSunIndex: -1,
  archiveId: -1,
  backgroundMode: 0,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as SkyboxDef

    let texturesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        texturesDir = await rootHandle.getDirectoryHandle('textures')
      } catch {
        // no textures entry in this dump — material preview unavailable
      }
    }

    return { id: item.id, def, texturesDir } satisfies SkyboxData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as SkyboxData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_SKYBOX_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as SkyboxDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
