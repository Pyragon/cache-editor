import type { CacheLoader, LoadedItem } from './types'
import { resolveQuickChatDirs, saveMenu } from './quick_chat'
import type { QcMenuDef, QuickChatData } from './quick_chat'

async function nextFreeId(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let maxId = -1
  for await (const handle of dirHandle.values()) {
    const match = handle.name.match(/^(\d+) - /)
    if (match) maxId = Math.max(maxId, parseInt(match[1], 10))
  }
  return maxId + 1
}

const loader: CacheLoader = {
  // Menu dumps are named "<id> - <Name>.json".
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      // (.*) not (.+) — tolerate empty names like map_areas' "44 - .json"
      const match = handle.name.match(/^(\d+) - (.*)\.json$/)
      if (!match) continue
      yield { id: parseInt(match[1], 10), name: `${match[1]} - ${match[2]}` } satisfies LoadedItem
    }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as QcMenuDef

    const { menusDir, messagesDir } = await resolveQuickChatDirs(rootHandle)
    return {
      kind: 'menu', id: item.id, def, fileName: item.name,
      menusDir: menusDir ?? dirHandle, messagesDir,
    } satisfies QuickChatData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as QuickChatData
    await saveMenu(dirHandle, def as QcMenuDef, item.name)
  },

  async createItem(dirHandle) {
    const id = await nextFreeId(dirHandle)
    const def: QcMenuDef = { id, name: `Menu ${id}` }
    const stem = await saveMenu(dirHandle, def)
    return { id, name: stem }
  },

  async deleteItem(dirHandle, item) {
    await dirHandle.removeEntry(`${item.name}.json`)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as QcMenuDef

    const id = await nextFreeId(dirHandle)
    const stem = await saveMenu(dirHandle, { ...source, id })
    return { id, name: stem }
  },
}

export default loader
