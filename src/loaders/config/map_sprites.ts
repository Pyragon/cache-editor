import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'
import { writeNewSprite } from '../spriteStore'
import type { SpriteMeta } from '../sprites'

export type MapSpriteDef = {
  id: number
  spriteId: number
  backgroundColour: number
  requiresUpscaling: boolean
}

export type MapSpriteData = {
  id: number
  mapSprite: MapSpriteDef
  // Handle to the top-level sprites/ entry so the viewer can preview the
  // referenced sprite (and re-load it live when spriteId is edited).
  spritesDir: FileSystemDirectoryHandle | null
  // Set by the viewer when the user uploads a replacement image. Uploads
  // never overwrite the existing sprite — the viewer allocates the next
  // free sprite id and saveItem creates the new sprite folder.
  sprite?: SpriteMeta | null
  spriteDirty?: boolean
  spritePng?: Blob | null
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    // spriteId -1 is a legitimate value for map sprites (several real
    // entries have none), so new items are saveable as-is.
    await writeJsonItem(dirHandle, id, { id, spriteId: -1, backgroundColour: 0, requiresUpscaling: false })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as MapSpriteDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const mapSprite = JSON.parse(await file.text()) as MapSpriteDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // no sprites entry in this dump — viewer falls back to no preview
      }
    }

    return { id: item.id, mapSprite, spritesDir } satisfies MapSpriteData
  },

  async saveItem(dirHandle, item, data) {
    const { mapSprite, sprite, spriteDirty, spritePng, spritesDir } = data as MapSpriteData

    // Create the new sprite first so the map sprite never points at an id
    // that failed to materialise.
    if (spriteDirty && sprite && spritesDir) {
      await writeNewSprite(spritesDir, mapSprite.spriteId, sprite, spritePng ?? null)
    }

    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(mapSprite, null, 2))
    await writable.close()
  },
}

export default loader
