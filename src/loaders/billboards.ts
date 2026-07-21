import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'

// Fields per darkan-bot-refactor BillboardType.kt (flat <id>.json dump).
export type BillboardDef = {
  id?: number
  materialId: number
  size2d: number
  size3d: number
  shape: number
  blendType: number
  stationary: boolean
  hasUid: boolean
}

export type BillboardData = {
  id: number
  def: BillboardDef
  texturesDir: FileSystemDirectoryHandle | null
  /** Cache root, for the session-wide used-by-models scan (billboardUsage.ts). */
  rootHandle: FileSystemDirectoryHandle | null
}

const NEW_BILLBOARD_DEFAULTS: Omit<BillboardDef, 'id'> = {
  materialId: -1,
  size2d: 64,
  size3d: 64,
  shape: 2,
  blendType: 1,
  stationary: false,
  hasUid: false,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as BillboardDef

    let texturesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        texturesDir = await rootHandle.getDirectoryHandle('textures')
      } catch {
        // no textures entry in this dump — material preview unavailable
      }
    }

    return { id: item.id, def, texturesDir, rootHandle: rootHandle ?? null } satisfies BillboardData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as BillboardData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_BILLBOARD_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as BillboardDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
