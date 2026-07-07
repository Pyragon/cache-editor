import type { CacheLoader, LoadedItem } from './types'

const loader: CacheLoader = {
  noPanel: true,
  async *streamItems(_dirHandle) {
    yield { id: 0, name: 'huffman' } satisfies LoadedItem
  },

  async loadItem(dirHandle, _item) {
    const fileHandle = await dirHandle.getFileHandle('huffman.json')
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text())
  },
}

export default loader
