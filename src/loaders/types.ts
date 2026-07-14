export type LoadedItem = {
  id: number
  name: string
}

export type QuestServerData = {
  startNpc: number
  startLocation: { x: number; y: number; plane: number }
  slotId: number
  prereqQuestIds: number[]
  skillReqs: [number, number][]
}

export type CacheLoader = {
  noPanel?: boolean
  // rootHandle is passed for entries whose item list spans more than their own
  // folder (fonts joins fonts/metrics with fonts/glyphs).
  streamItems: (dirHandle: FileSystemDirectoryHandle, rootHandle?: FileSystemDirectoryHandle) => AsyncGenerator<LoadedItem>
  loadItem: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem, rootHandle?: FileSystemDirectoryHandle) => Promise<unknown>
  saveItem?: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem, data: unknown) => Promise<void>
  // Optional item-list CRUD — entries without these render the Add/Remove/
  // Clone panel buttons disabled.
  createItem?: (dirHandle: FileSystemDirectoryHandle) => Promise<LoadedItem>
  deleteItem?: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem) => Promise<void>
  cloneItem?: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem) => Promise<LoadedItem>
}
