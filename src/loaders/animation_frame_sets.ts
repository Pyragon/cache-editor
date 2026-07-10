import type { CacheLoader } from './types'
import { streamDirItems } from './common'

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const entries: string[] = []
    for await (const handle of subHandle.values()) entries.push(handle.name)
    return { id: item.id, entries }
  },
}

export default loader
