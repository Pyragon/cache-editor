import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'

// Player "identikit" body parts (hair, torso, legs, etc.) — see darkan
// IdkType.kt. bodyModels merge into one composite mesh (renderBody);
// headModels (up to 5, -1 = none) merge into a separate composite for the
// character-select head preview (renderHead). Recolor/retexture pairs are
// applied across whichever composite mesh they belong to. `category` is
// opcode 1 — neither cryogen's original "unused" name nor darkan's IdkType.kt
// (which reads and discards the byte) is accurate; real cache data has 13
// distinct values with meaningful spread, most likely a body-part/category id
// the character-creation interface groups kits by (hair, jaw, torso, etc.).
export type IdentikitDef = {
  id: number
  category: number
  bodyModels?: number[]
  headModels: number[]
  originalColours?: number[]
  replacementColours?: number[]
  originalTextures?: number[]
  replacementTextures?: number[]
}

export type IdentikitData = {
  id: number
  def: IdentikitDef
  rootHandle?: FileSystemDirectoryHandle
}

function newDefaults(id: number): IdentikitDef {
  return { id, category: 0, headModels: [-1, -1, -1, -1, -1] }
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as IdentikitDef
    return { id: item.id, def, rootHandle } satisfies IdentikitData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as IdentikitData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, newDefaults(id))
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as IdentikitDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
