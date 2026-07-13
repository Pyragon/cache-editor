import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'

// Fields per darkan-bot-refactor HitSplatType.kt (flat <id>.json dump).
// Sprite names follow kt's getter semantics: A=left cap, B=inner left,
// C=middle fill, D=right cap.
export type HitsplatDef = {
  id?: number
  fontId: number
  color: number
  hasColor: boolean
  scrollOffsetX: number
  cyclesVisible: number
  scrollOffsetY: number
  fadeStartCycle: number
  displayType: number
  textOffsetY: number
  leftCapSpriteId: number
  innerLeftSpriteId: number
  middleFillSpriteId: number
  rightCapSpriteId: number
  placementExampleString: string
}

export type HitsplatData = {
  id: number
  hitsplat: HitsplatDef
  spritesDir: FileSystemDirectoryHandle | null
}

const NEW_HITSPLAT_DEFAULTS: Omit<HitsplatDef, 'id'> = {
  fontId: -1,
  color: 16777215,
  hasColor: false,
  scrollOffsetX: 0,
  cyclesVisible: 70,
  scrollOffsetY: 0,
  fadeStartCycle: -1,
  displayType: -1,
  textOffsetY: 0,
  leftCapSpriteId: -1,
  innerLeftSpriteId: -1,
  middleFillSpriteId: -1,
  rightCapSpriteId: -1,
  placementExampleString: '',
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const hitsplat = JSON.parse(await file.text()) as HitsplatDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // no sprites entry in this dump — preview unavailable
      }
    }

    return { id: item.id, hitsplat, spritesDir } satisfies HitsplatData
  },

  async saveItem(dirHandle, item, data) {
    const { hitsplat } = data as HitsplatData
    await writeJsonItem(dirHandle, item.id, hitsplat)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_HITSPLAT_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as HitsplatDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
