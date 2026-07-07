import type { CacheLoader } from './types'
import { streamDirItems } from './common'

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const fileHandle = await subHandle.getFileHandle('model.dat')
    const file = await fileHandle.getFile()
    return { id: item.id, size: file.size, type: 'model.dat' }
  },
}

export default loader
