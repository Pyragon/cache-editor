import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'
import { writePendingSprites } from '../spriteStore'
import type { PendingSprites } from '../spriteStore'

// Fields per darkan-bot-refactor HitbarType.kt (flat <id>.json dump).
export type HitbarDef = {
  id?: number
  hitbarAlpha: number
  priority: number
  fadeStartOffset: number
  fadeOutDuration: number
  animationStepSize: number
  greenBarSpriteId: number
  redBarSpriteId: number
  pGreenBarSpriteId: number
  pRedBarSpriteId: number
  unused?: number
  unused2?: number
}

export type HitbarData = {
  id: number
  hitbar: HitbarDef
  spritesDir: FileSystemDirectoryHandle | null
  // Uploads staged by the viewer — written by saveItem, so Discard drops them.
  // Uploads always allocate a fresh sprite id (sprites are shared, so an
  // existing one is never overwritten).
  pendingSprites?: PendingSprites
}

const NEW_HITBAR_DEFAULTS: Omit<HitbarDef, 'id'> = {
  hitbarAlpha: 255,
  priority: 255,
  fadeStartOffset: -1,
  fadeOutDuration: 70,
  animationStepSize: 1,
  greenBarSpriteId: -1,
  redBarSpriteId: -1,
  pGreenBarSpriteId: -1,
  pRedBarSpriteId: -1,
  unused: 0,
  unused2: 0,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const hitbar = JSON.parse(await file.text()) as HitbarDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // no sprites entry in this dump — preview unavailable
      }
    }

    return { id: item.id, hitbar, spritesDir } satisfies HitbarData
  },

  async saveItem(dirHandle, item, data) {
    const { hitbar, spritesDir, pendingSprites } = data as HitbarData
    // Create the sprites first so the definition never points at an id that
    // failed to materialise.
    await writePendingSprites(spritesDir, pendingSprites)
    await writeJsonItem(dirHandle, item.id, hitbar)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_HITBAR_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as HitbarDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
