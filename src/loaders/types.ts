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
  /** The quest-start-interface struct backing this data (CONFIG archive 26). */
  structId: number
  /** Struct keys 845/846 — the interface's own name + sort name. */
  structName: string
  structSortName: string
  /** Journal texts, struct keys 948–951. */
  journal: {
    startHint: string
    requiredItems: string
    enemiesToDefeat: string
    rewards: string
  }
  /** Every other struct key the dedicated fields don't manage, editable raw. */
  extraValues: [key: number, value: string | number][]
  /** Read-only: max level per skill over this quest and its whole prereq tree. */
  preReqSkillReqs: [number, number][]
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
