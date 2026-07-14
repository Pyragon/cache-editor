import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems } from './common'
import { resolveQuickChatDirs, saveMessage } from './quick_chat'
import type { QcMessageDef, QuickChatData } from './quick_chat'

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as QcMessageDef

    const { menusDir, messagesDir } = await resolveQuickChatDirs(rootHandle)
    return {
      kind: 'message', id: item.id, def,
      menusDir, messagesDir: messagesDir ?? dirHandle,
    } satisfies QuickChatData
  },

  async saveItem(dirHandle, _item, data) {
    const { def } = data as QuickChatData
    await saveMessage(dirHandle, def as QcMessageDef)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await saveMessage(dirHandle, { id, message: ['New message'], searchable: true })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as QcMessageDef

    const id = await nextFreeJsonId(dirHandle)
    await saveMessage(dirHandle, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
