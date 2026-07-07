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
  streamItems: (dirHandle: FileSystemDirectoryHandle) => AsyncGenerator<LoadedItem>
  loadItem: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem, rootHandle?: FileSystemDirectoryHandle) => Promise<unknown>
  saveItem?: (dirHandle: FileSystemDirectoryHandle, item: LoadedItem, data: unknown) => Promise<void>
}
