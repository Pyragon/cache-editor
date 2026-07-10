import type { CacheLoader } from '../types'
import { streamDirItems } from '../common'

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const fileHandle = await subHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text())
  },
}

export default loader
