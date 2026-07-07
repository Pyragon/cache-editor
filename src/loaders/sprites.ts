import type { CacheLoader } from './types'
import { streamDirItems } from './common'

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const frames: unknown[] = []
    for await (const handle of subHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const file = await (handle as FileSystemFileHandle).getFile()
        frames.push(JSON.parse(await file.text()))
      }
    }
    return { id: item.id, frames }
  },
}

export default loader
