import type { CacheLoader, LoadedItem } from './types'

// Filenames aren't purely numeric — they're "<id> - <description>.json" —
// so items are keyed by the full stem rather than `${id}.json`.
const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const stem = handle.name.slice(0, -5)
        const id = parseInt(stem, 10)
        if (!isNaN(id)) yield { id, name: stem } satisfies LoadedItem
      }
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text())
  },
}

export default loader
