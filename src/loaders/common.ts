import type { CacheLoader, LoadedItem } from './types'

export async function* streamJsonItems(dirHandle: FileSystemDirectoryHandle): AsyncGenerator<LoadedItem> {
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'file' && handle.name.endsWith('.json')) {
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (!isNaN(id)) yield { id, name: String(id) }
    }
  }
}

export async function* streamDirItems(dirHandle: FileSystemDirectoryHandle): AsyncGenerator<LoadedItem> {
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'directory') {
      const id = parseInt(handle.name, 10)
      if (!isNaN(id)) yield { id, name: String(id) }
    }
  }
}

export async function loadJsonItem(dirHandle: FileSystemDirectoryHandle, item: LoadedItem): Promise<unknown> {
  const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
  const file = await fileHandle.getFile()
  return JSON.parse(await file.text())
}

export async function nextFreeJsonId(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let maxId = -1
  for await (const handle of dirHandle.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (!isNaN(id) && id > maxId) maxId = id
  }
  return maxId + 1
}

export async function writeJsonItem(dirHandle: FileSystemDirectoryHandle, id: number, content: unknown): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(`${id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(content, null, 2))
  await writable.close()
}

export async function deleteJsonItem(dirHandle: FileSystemDirectoryHandle, id: number): Promise<void> {
  await dirHandle.removeEntry(`${id}.json`)
}

// For entries dumped as `<id>/<fixedFileName>` (e.g. cursors/0/cursor.json).
export function makeFixedFileLoader(fixedFileName: string): CacheLoader {
  return {
    streamItems: streamDirItems,
    async loadItem(dirHandle, item) {
      const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
      const fileHandle = await subHandle.getFileHandle(fixedFileName)
      const file = await fileHandle.getFile()
      return JSON.parse(await file.text())
    },
  }
}
