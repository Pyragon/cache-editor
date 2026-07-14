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

  async saveItem(dirHandle, _item, data) {
    const fileHandle = await dirHandle.getFileHandle('huffman.json', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(data))
    await writable.close()
  },
}

export default loader
