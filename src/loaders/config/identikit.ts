import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, writeJsonItem } from '../common'
import { LOOK_PART_LABELS, lookSlotFromCategory } from '../playerLook'

// Player "identikit" body parts (hair, torso, legs, etc.) — see darkan
// IdkType.kt. bodyModels merge into one composite mesh (renderBody);
// headModels (up to 5, -1 = none) merge into a separate composite for the
// character-select head preview (renderHead). Recolor/retexture pairs are
// applied across whichever composite mesh they belong to.
//
// `category` is opcode 1. The client reads and DISCARDS the byte
// (`IdkType.decode`), and cryogen called it `unused` — but it is neither
// unused nor opaque: `category = (female ? 7 : 0) + lookIndex`, encoding both
// the gender and which of the seven body parts the kit is for. Confirmed
// across all 651 dumped kits (categories 0-6 male, 7-13 female, category 8
// "female beard" correctly empty) and against the server's two stock looks.
// `lookSlotFromCategory` in playerLook.ts decodes it; EDITOR.md has the
// full write-up.
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

// A bare id tells you nothing about a kit, and the list is the only place you
// can compare them — so each row carries the gender and body part its
// `category` decodes to ("310 - Male Hair"). Reads every file, batched in
// parallel like the npcs/objects lists do; 651 files is small next to those.
const CATEGORY_REGEX = /"category"\s*:\s*(-?\d+)/

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    const ids: number[] = []
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (!isNaN(id)) ids.push(id)
      }
    }

    const CHUNK = 250
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const results = await Promise.all(chunk.map(async (id) => {
        try {
          const fileHandle = await dirHandle.getFileHandle(`${id}.json`)
          const text = await (await fileHandle.getFile()).text()
          const match = text.match(CATEGORY_REGEX)
          const slot = match ? lookSlotFromCategory(parseInt(match[1], 10)) : null
          if (!slot) return { id, name: String(id) }
          return { id, name: `${id} - ${slot.female ? 'Female' : 'Male'} ${LOOK_PART_LABELS[slot.part]}` }
        } catch {
          return { id, name: String(id) }
        }
      }))
      yield* results
    }
  },

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
