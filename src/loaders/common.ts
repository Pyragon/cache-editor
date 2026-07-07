import type { LoadedItem } from './types'

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
