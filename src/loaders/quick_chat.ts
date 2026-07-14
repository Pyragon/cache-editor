// Shared types/helpers for the combined quick chat editor. Menus live in
// quick_chat/menus ("<id> - <Name>.json"), messages in quick_chat/messages
// ("<id>.json"); both loaders hand the viewer both folders so it can navigate
// menu → submenu → message while saving each node to its own folder.
// Field names verified against darkan-bot-refactor QuickchatMessageType.kt /
// QuickChatCategoryType.kt (cryogen QCMesDefinitions / QCCategoryDefinitions
// already match; cryogen dumps value types as enum names, which we keep).

export type QcMessageDef = {
  id: number
  message: string[]
  responses?: number[]
  types?: string[]
  configs?: number[][]
  searchable: boolean
}

export type QcMenuDef = {
  id: number
  name: string
  messages?: number[]
  messageHotkeys?: string[]
  subCategories?: number[]
  subCategoryHotkeys?: string[]
}

export type QcKind = 'menu' | 'message'

export type QuickChatData = {
  kind: QcKind
  id: number
  def: QcMenuDef | QcMessageDef
  // Menu dump filename stem ("<id> - <Name>"), needed to rename on save.
  fileName?: string
  menusDir: FileSystemDirectoryHandle | null
  messagesDir: FileSystemDirectoryHandle | null
}

// Menu refs to messages/submenus carry a flag bit (cryogen QCCategoryDefinitions
// ORs 0x8000 in on decode) — the real file id is ref & 0x7fff.
export const QC_REF_FLAG = 0x8000
export function qcRefId(ref: number): number {
  return ref >= QC_REF_FLAG ? ref & 0x7fff : ref
}

export async function resolveQuickChatDirs(rootHandle: FileSystemDirectoryHandle | undefined): Promise<{
  menusDir: FileSystemDirectoryHandle | null
  messagesDir: FileSystemDirectoryHandle | null
}> {
  let menusDir: FileSystemDirectoryHandle | null = null
  let messagesDir: FileSystemDirectoryHandle | null = null
  if (rootHandle) {
    try {
      const qcDir = await rootHandle.getDirectoryHandle('quick_chat')
      menusDir = await qcDir.getDirectoryHandle('menus').catch(() => null)
      messagesDir = await qcDir.getDirectoryHandle('messages').catch(() => null)
    } catch {
      // no quick_chat entry — cross-navigation unavailable
    }
  }
  return { menusDir, messagesDir }
}

export async function findMenuFileStem(menusDir: FileSystemDirectoryHandle, id: number): Promise<string | null> {
  for await (const handle of menusDir.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const match = handle.name.match(/^(\d+) - .*\.json$/)
    if (match && parseInt(match[1], 10) === id) return handle.name.slice(0, -5)
  }
  return null
}

export async function loadMenu(menusDir: FileSystemDirectoryHandle, id: number): Promise<{ def: QcMenuDef; fileName: string } | null> {
  const stem = await findMenuFileStem(menusDir, id)
  if (stem == null) return null
  const fileHandle = await menusDir.getFileHandle(`${stem}.json`)
  const file = await fileHandle.getFile()
  return { def: JSON.parse(await file.text()) as QcMenuDef, fileName: stem }
}

export async function loadMessage(messagesDir: FileSystemDirectoryHandle, id: number): Promise<QcMessageDef | null> {
  try {
    const fileHandle = await messagesDir.getFileHandle(`${id}.json`)
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text()) as QcMessageDef
  } catch {
    return null
  }
}

// Writes a menu as "<id> - <name>.json", dropping the previous file when the
// name changed. Returns the new filename stem.
export async function saveMenu(menusDir: FileSystemDirectoryHandle, def: QcMenuDef, previousStem?: string): Promise<string> {
  const stem = `${def.id} - ${def.name}`
  const fileHandle = await menusDir.getFileHandle(`${stem}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(def, null, 2))
  await writable.close()
  if (previousStem && previousStem !== stem) {
    try {
      await menusDir.removeEntry(`${previousStem}.json`)
    } catch {
      // old file already gone
    }
  }
  return stem
}

export async function saveMessage(messagesDir: FileSystemDirectoryHandle, def: QcMessageDef): Promise<void> {
  const fileHandle = await messagesDir.getFileHandle(`${def.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(def, null, 2))
  await writable.close()
}
