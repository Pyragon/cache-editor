import type { CacheLoader, LoadedItem } from './types'

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    const dirs: string[] = []
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'directory') dirs.push(handle.name)
    }
    dirs.sort((a, b) => a.localeCompare(b))
    let id = 1
    for (const name of dirs) yield { id: id++, name } satisfies LoadedItem
  },

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(item.name)
    const entries: string[] = []
    for await (const handle of subHandle.values()) entries.push(handle.name)
    return { subfolder: item.name, entries }
  },
}

export default loader
