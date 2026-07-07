import type { CacheLoader, LoadedItem } from './types'

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.cs2')) {
        const id = parseInt(handle.name.slice(0, -4), 10)
        if (!isNaN(id)) yield { id, name: String(id) } satisfies LoadedItem
      }
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.cs2`)
    const file = await fileHandle.getFile()
    return file.text()
  },
}

export default loader
