import type { CacheLoader, LoadedItem } from './types'

export type NativeLibEntry =
  | { kind: 'file'; name: string; size: number; handle: FileSystemFileHandle }
  | { kind: 'directory'; name: string; handle: FileSystemDirectoryHandle }

export type NativeLibrariesData = {
  root: FileSystemDirectoryHandle
}

export async function listNativeLibDir(dirHandle: FileSystemDirectoryHandle): Promise<NativeLibEntry[]> {
  const entries: NativeLibEntry[] = []

  for await (const handle of dirHandle.values()) {
    if (handle.name.startsWith('.')) continue

    if (handle.kind === 'directory') {
      entries.push({ kind: 'directory', name: handle.name, handle })
    } else {
      const file = await handle.getFile()
      entries.push({ kind: 'file', name: handle.name, size: file.size, handle })
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

const loader: CacheLoader = {
  noPanel: true,

  async *streamItems(_dirHandle) {
    yield { id: 0, name: 'native_libraries' } satisfies LoadedItem
  },

  async loadItem(dirHandle) {
    return { root: dirHandle } satisfies NativeLibrariesData
  },
}

export default loader
