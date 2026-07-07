import type { CacheLoader } from './types'
import { streamDirItems } from './common'

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const components: unknown[] = []
    const componentsHandle = await subHandle.getDirectoryHandle('components')
    for await (const handle of componentsHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const file = await (handle as FileSystemFileHandle).getFile()
        components.push(JSON.parse(await file.text()))
      }
    }
    return { id: item.id, components }
  },
}

export default loader
