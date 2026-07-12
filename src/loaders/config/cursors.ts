import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'
import { writeNewSprite } from '../spriteStore'
import type { SpriteMeta } from '../sprites'

export type CursorDef = {
  id: number
  hotspotPointX: number
  hotspotPointY: number
  spriteId: number
}

export type CursorData = {
  id: number
  cursor: CursorDef
  // Handle to the top-level sprites/ entry so the viewer can preview the
  // referenced sprite (and re-load it live when spriteId is edited).
  spritesDir: FileSystemDirectoryHandle | null
  // Set by the viewer when the user uploads a replacement image. Uploads
  // never overwrite the existing sprite (other cache entries may reference
  // it) — instead the viewer allocates the next free sprite id, points
  // cursor.spriteId at it, and saveItem creates the new sprite folder here
  // ({id}.json plus the {id}_0.png the dumper writes alongside it).
  sprite?: SpriteMeta | null
  spriteDirty?: boolean
  spritePng?: Blob | null
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    // spriteId -1 deliberately fails the viewer's save validation until the
    // user points the new cursor at a real sprite.
    await writeJsonItem(dirHandle, id, { id, hotspotPointX: 0, hotspotPointY: 0, spriteId: -1 })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as CursorDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const cursor = JSON.parse(await file.text()) as CursorDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // no sprites entry in this dump — viewer falls back to no preview
      }
    }

    return { id: item.id, cursor, spritesDir } satisfies CursorData
  },

  async saveItem(dirHandle, item, data) {
    const { cursor, sprite, spriteDirty, spritePng, spritesDir } = data as CursorData

    // Create the new sprite first so the cursor never points at an id that
    // failed to materialise.
    if (spriteDirty && sprite && spritesDir) {
      await writeNewSprite(spritesDir, cursor.spriteId, sprite, spritePng ?? null)
    }

    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(cursor, null, 2))
    await writable.close()
  },
}

export default loader
