import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { LOOK_PART_COUNT, lookSlotFromCategory } from './playerLook'

// Which identikits exist for each (gender, body part), for the look pickers.
//
// The kit's `category` byte is the only thing that says what a kit is for —
// `category = (female ? 7 : 0) + partIndex`, see playerLook.ts. Reading it
// means opening every file, so the whole index is built once per cache root
// and cached; 651 files is small, and the same scan already backs the sidebar
// list. Read with a regex rather than JSON.parse for the same reason the
// npcs/objects loaders do: only one number is wanted out of each file.

const CATEGORY_REGEX = /"category"\s*:\s*(-?\d+)/

/** `key(female, part)` -> ascending kit ids. */
export type IdentikitIndex = Map<string, number[]>

export const identikitIndexKey = (female: boolean, part: number) => `${female ? 'f' : 'm'}${part}`

/** Next/previous kit within one part's list, wrapping at the ends.
 *
 *  Stepping the raw id by ±1 walks straight out of the category — the stock
 *  beard 16 is two above torso 18 — so the steppers move through this list
 *  instead, the same candidates the Browse picker offers. `from` need not be
 *  in the list (it can be -1, or hand-typed). */
export function stepIdentikit(list: number[] | undefined, from: number, direction: 1 | -1): number {
  if (!list || list.length === 0) return from
  if (direction === 1) return list.find((id) => id > from) ?? list[0]
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] < from) return list[i]
  }
  return list[list.length - 1]
}

const cache = new WeakMap<FileSystemDirectoryHandle, Promise<IdentikitIndex>>()

export function loadIdentikitIndex(rootHandle: FileSystemDirectoryHandle): Promise<IdentikitIndex> {
  const hit = cache.get(rootHandle)
  if (hit) return hit
  const pending = readIdentikitIndex(rootHandle)
  cache.set(rootHandle, pending)
  return pending
}

async function readIdentikitIndex(rootHandle: FileSystemDirectoryHandle): Promise<IdentikitIndex> {
  const index: IdentikitIndex = new Map()
  for (const female of [false, true]) {
    for (let part = 0; part < LOOK_PART_COUNT; part++) index.set(identikitIndexKey(female, part), [])
  }

  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('config_identikit'))
    if (!dir) return index

    const ids: number[] = []
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (!isNaN(id)) ids.push(id)
    }

    const CHUNK = 250
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await Promise.all(ids.slice(i, i + CHUNK).map(async (id) => {
        try {
          const text = await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text()
          const match = text.match(CATEGORY_REGEX)
          return match ? { id, category: parseInt(match[1], 10) } : null
        } catch {
          return null
        }
      }))
      for (const row of rows) {
        if (!row) continue
        const slot = lookSlotFromCategory(row.category)
        if (!slot) continue
        index.get(identikitIndexKey(slot.female, slot.part))?.push(row.id)
      }
    }

    for (const list of index.values()) list.sort((a, b) => a - b)
  } catch {
    // entry missing — every list stays empty and the picker says so
  }
  return index
}
