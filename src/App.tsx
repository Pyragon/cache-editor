import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ENTRY_ORDER, getEntryPath, getLoader, resolveEntryHandle } from './loaders'
import type { LoadedItem, QuestServerData } from './loaders'
import HuffmanViewer from './components/HuffmanViewer'
import type { HuffmanData } from './components/HuffmanViewer'
import QuestViewer from './components/QuestViewer'
import type { QuestData } from './components/QuestViewer'
import SpriteViewer from './components/SpriteViewer'
import type { SpriteData } from './loaders/sprites'
import ModelViewer from './components/ModelViewer'
import type { ModelData } from './loaders/models'
import TextureViewer from './components/TextureViewer'
import type { TextureData } from './loaders/textures'
import NativeLibrariesViewer from './components/NativeLibrariesViewer'
import type { NativeLibrariesData } from './loaders/native_libraries'
import EnumViewer from './components/EnumViewer'
import type { EnumData } from './loaders/enums'
import CursorViewer from './components/CursorViewer'
import type { CursorData } from './loaders/config/cursors'
import MapSpriteViewer from './components/MapSpriteViewer'
import type { MapSpriteData } from './loaders/config/map_sprites'
import ItemViewer from './components/ItemViewer'
import type { ItemData } from './loaders/items'
import ObjectViewer from './components/ObjectViewer'
import type { ObjectData } from './loaders/objects'
import NpcViewer from './components/NpcViewer'
import type { NpcData } from './loaders/npcs'
import VarbitViewer from './components/VarbitViewer'
import type { VarbitData } from './loaders/varbits'
import StructViewer from './components/StructViewer'
import type { StructData } from './loaders/config/structs'
import ParamViewer from './components/ParamViewer'
import type { ParamData } from './loaders/config/params'
import VarViewer from './components/VarViewer'
import type { VarData } from './loaders/config/vars'
import InventoryViewer from './components/InventoryViewer'
import type { InventoryData } from './loaders/config/inventories'
import HitbarViewer from './components/HitbarViewer'
import type { HitbarData } from './loaders/config/hitbars'
import HitsplatViewer from './components/HitsplatViewer'
import type { HitsplatData } from './loaders/config/hitsplats'
import DefaultsViewer from './components/DefaultsViewer'
import type { DefaultsData } from './loaders/defaults'
import BillboardViewer from './components/BillboardViewer'
import type { BillboardData } from './loaders/billboards'
import SkyboxViewer from './components/SkyboxViewer'
import type { SkyboxData } from './loaders/config/skyboxes'
import MapAreaViewer from './components/MapAreaViewer'
import type { MapAreaData } from './loaders/map_areas'
import AreaViewer from './components/AreaViewer'
import type { AreaData } from './loaders/config/map_areas'
import FontViewer from './components/FontViewer'
import type { FontData } from './loaders/font_metrics'
import QuickChatViewer from './components/QuickChatViewer'
import type { QuickChatData } from './loaders/quick_chat'
import { useConfirm } from './components/useConfirm'

type QuestContent = { quest: QuestData; server: QuestServerData | null }
import './App.css'

type CacheEntry = { id: number; name: string; available: boolean; group?: string }

type SidebarRow =
  | { type: 'entry'; entry: CacheEntry }
  | { type: 'group'; groupName: string; members: CacheEntry[] }

const GROUP_LABELS: Record<string, string> = {
  config: 'Config',
}

// Entries with a dedicated viewer component — everything else that resolves
// falls back to the raw-JSON `<pre>` display, which gets a distinct sidebar
// treatment ("dumped but not implemented" rather than "not dumped at all").
const SPECIALIZED_ENTRIES = new Set([
  'config_quests', 'config_cursors', 'config_map_sprites', 'config_structs', 'config_params', 'config_vars', 'config_inventories',
  'config_hitbars', 'config_hitsplats', 'config_skybox', 'config_map_areas',
  'items', 'objects', 'npcs', 'varbits', 'defaults', 'billboards', 'map_areas', 'quick_chat_messages', 'quick_chat_menus',
  'sprites', 'models', 'textures', 'texture_definitions', 'enums', 'huffman', 'native_libraries', 'font_metrics',
])

// Feature-complete entries — rendered green in the sidebar. Only entries
// the user has manually reviewed and signed off go in here.
const DONE_ENTRIES = new Set([
  'config_cursors', 'config_hitbars', 'config_inventories', 'config_params', 'config_structs', 'config_vars', 'defaults', 'huffman', 'native_libraries', 'varbits',
  'quick_chat_messages', 'quick_chat_menus', 'billboards', 'map_areas', 'config_map_areas', 'config_skybox', 'config_hitsplats', 'enums', 'font_metrics',
])

function unavailableReason(name: string): string {
  return EMPTY_ENTRIES[name] ?? 'No data found for this cache entry'
}

function entryStatusClass(entry: CacheEntry): string {
  if (!entry.available) return 'unavailable'
  if (DONE_ENTRIES.has(entry.name)) return 'done'
  if (!SPECIALIZED_ENTRIES.has(entry.name)) return 'generic'
  return ''
}

const ENTRY_LABEL_OVERRIDES: Record<string, string> = {
  cs2: 'CS2',
  music2: 'Music 2',
  midi: 'MIDI',
  npcs: 'NPCs',
}

// Entries whose sidebar label differs from their key. font_metrics is now a
// full Fonts page (metrics + glyphs from the font sprite archives), so the
// old metrics-only name would undersell it.
const ENTRY_NAME_OVERRIDES: Record<string, string> = {
  font_metrics: 'Fonts',
}

function formatEntryLabel(name: string): string {
  const override = ENTRY_NAME_OVERRIDES[name]
  if (override) return override

  // Config sub-entries are keyed `config_<name>` but display as just the
  // sub-entry name (they already live under the "Config" group).
  return name
    .replace(/^config_/, '')
    .split('_')
    .map((word) => ENTRY_LABEL_OVERRIDES[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function buildSidebarRows(entries: CacheEntry[]): SidebarRow[] {
  const rows: SidebarRow[] = []
  const seenGroups = new Set<string>()
  for (const entry of entries) {
    if (entry.group) {
      if (seenGroups.has(entry.group)) continue
      seenGroups.add(entry.group)
      rows.push({ type: 'group', groupName: entry.group, members: entries.filter((e) => e.group === entry.group) })
    } else {
      rows.push({ type: 'entry', entry })
    }
  }
  return rows
}

// Entries whose folder exists but is always empty, because the cache index
// itself holds no data — a re-dump recreates the (empty) folder, so "the
// folder resolved" isn't enough to call them available. Declared rather than
// detected: checking emptiness means enumerating every entry's directory,
// which is very slow on the big ones (models, sprites, items).
const EMPTY_ENTRIES: Record<string, string> = {
  config_sun: 'No data — the sun index is empty in this cache (rev 727 ships no sun definitions).',
}

async function readCacheDir(dirHandle: FileSystemDirectoryHandle): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = []
  let entryId = 1

  const known = new Set(ENTRY_ORDER.map((def) => def.path[0]))
  for (const def of ENTRY_ORDER) {
    const handle = await resolveEntryHandle(dirHandle, def.path)
    const available = handle != null && !(def.name in EMPTY_ENTRIES)
    entries.push({ id: entryId++, name: def.name, available, group: def.group })
  }

  // Anything present on disk but not covered by the canonical order (custom
  // or not-yet-catalogued entries) still shows up, appended alphabetically.
  const leftovers: string[] = []
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'directory' && !known.has(handle.name)) leftovers.push(handle.name)
  }
  leftovers.sort((a, b) => a.localeCompare(b))
  for (const name of leftovers) entries.push({ id: entryId++, name, available: true })

  return entries
}

function App() {
  const [cacheHandle, setCacheHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [entries, setEntries] = useState<CacheEntry[]>([])
  const [dirName, setDirName] = useState<string | null>(null)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null)
  const [activeItems, setActiveItems] = useState<LoadedItem[]>([])
  const [activeContent, setActiveContent] = useState<unknown>(null)
  const [selectedItemContent, setSelectedItemContent] = useState<unknown>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadCount, setLoadCount] = useState(0)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [isContentDirty, setIsContentDirty] = useState(false)
  const { confirm: confirmDialog, dialog: confirmDialogElement } = useConfirm()

  // An item created via Add that hasn't been saved yet — navigating away
  // from it deletes it again instead of leaving a half-configured file.
  const pendingNewRef = useRef<{ entryName: string; item: LoadedItem } | null>(null)

  // Warn before the tab closes/reloads with unsaved changes. (The browser
  // shows its own generic message; the returnValue text isn't displayed.)
  useEffect(() => {
    if (!isContentDirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isContentDirty])

  const loadVersion = useRef(0)
  const itemListRef = useRef<HTMLUListElement>(null)
  const contentPanelRef = useRef<HTMLDivElement>(null)

  // Reset the details scroll to the top when a different item is selected,
  // so a new item doesn't inherit the previous one's scroll position.
  useEffect(() => {
    contentPanelRef.current?.scrollTo({ top: 0 })
  }, [selectedItemId, selectedEntryId])

  const selectedEntry = entries.find((e) => e.id === selectedEntryId) ?? null
  const selectedItem = activeItems.find((i) => i.id === selectedItemId) ?? null
  const currentLoader = selectedEntry ? getLoader(selectedEntry.name) : null
  const noPanel = currentLoader?.noPanel ?? false

  const sidebarRows = useMemo(() => buildSidebarRows(entries), [entries])

  const questContent = selectedEntry?.name === 'config_quests' && selectedItemContent != null
    ? selectedItemContent as QuestContent
    : null

  const spriteContent = selectedEntry?.name === 'sprites' && selectedItemContent != null
    ? selectedItemContent as SpriteData
    : null

  const modelContent = selectedEntry?.name === 'models' && selectedItemContent != null
    ? selectedItemContent as ModelData
    : null

  const textureContent = (selectedEntry?.name === 'textures' || selectedEntry?.name === 'texture_definitions') && selectedItemContent != null
    ? selectedItemContent as TextureData
    : null

  const enumContent = selectedEntry?.name === 'enums' && selectedItemContent != null
    ? selectedItemContent as EnumData
    : null

  const cursorContent = selectedEntry?.name === 'config_cursors' && selectedItemContent != null
    ? selectedItemContent as CursorData
    : null

  const mapSpriteContent = selectedEntry?.name === 'config_map_sprites' && selectedItemContent != null
    ? selectedItemContent as MapSpriteData
    : null

  const itemContent = selectedEntry?.name === 'items' && selectedItemContent != null
    ? selectedItemContent as ItemData
    : null

  const objectContent = selectedEntry?.name === 'objects' && selectedItemContent != null
    ? selectedItemContent as ObjectData
    : null

  const npcContent = selectedEntry?.name === 'npcs' && selectedItemContent != null
    ? selectedItemContent as NpcData
    : null

  const varbitContent = selectedEntry?.name === 'varbits' && selectedItemContent != null
    ? selectedItemContent as VarbitData
    : null

  const structContent = selectedEntry?.name === 'config_structs' && selectedItemContent != null
    ? selectedItemContent as StructData
    : null

  const paramContent = selectedEntry?.name === 'config_params' && selectedItemContent != null
    ? selectedItemContent as ParamData
    : null

  const varContent = selectedEntry?.name === 'config_vars' && selectedItemContent != null
    ? selectedItemContent as VarData
    : null

  const inventoryContent = selectedEntry?.name === 'config_inventories' && selectedItemContent != null
    ? selectedItemContent as InventoryData
    : null

  const hitbarContent = selectedEntry?.name === 'config_hitbars' && selectedItemContent != null
    ? selectedItemContent as HitbarData
    : null

  const hitsplatContent = selectedEntry?.name === 'config_hitsplats' && selectedItemContent != null
    ? selectedItemContent as HitsplatData
    : null

  const defaultsContent = selectedEntry?.name === 'defaults' && selectedItemContent != null
    ? selectedItemContent as DefaultsData
    : null

  const billboardContent = selectedEntry?.name === 'billboards' && selectedItemContent != null
    ? selectedItemContent as BillboardData
    : null

  const skyboxContent = selectedEntry?.name === 'config_skybox' && selectedItemContent != null
    ? selectedItemContent as SkyboxData
    : null

  const mapAreaContent = selectedEntry?.name === 'map_areas' && selectedItemContent != null
    ? selectedItemContent as MapAreaData
    : null

  const areaContent = selectedEntry?.name === 'config_map_areas' && selectedItemContent != null
    ? selectedItemContent as AreaData
    : null

  const fontContent = selectedEntry?.name === 'font_metrics' && selectedItemContent != null
    ? selectedItemContent as FontData
    : null

  const quickChatContent = (selectedEntry?.name === 'quick_chat_messages' || selectedEntry?.name === 'quick_chat_menus') && selectedItemContent != null
    ? selectedItemContent as QuickChatData
    : null

  const filteredItems = activeItems.filter((item) =>
    item.name.toLowerCase().includes(filter.toLowerCase())
  )

  const virtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => itemListRef.current,
    estimateSize: () => 36,
    overscan: 10,
  })

  // Ref keeps the effect below honest without re-running it every render
  // (handleSelectItem closes over fresh state each render).
  const handleSelectItemRef = useRef<(id: number) => void>(() => {})
  handleSelectItemRef.current = handleSelectItem

  // filteredItems is rebuilt every render; hold it in a ref so the
  // selection-scroll effect can read it without depending on its identity.
  const filteredItemsRef = useRef(filteredItems)
  filteredItemsRef.current = filteredItems

  useEffect(() => {
    if (/^\d+$/.test(filter)) {
      const num = parseInt(filter, 10)
      const idx = filteredItems.findIndex((item) => item.id === num)
      if (idx !== -1) {
        handleSelectItemRef.current(filteredItems[idx].id)
        virtualizer.scrollToIndex(idx, { align: 'center' })
      }
    }
  }, [filter, filteredItems, virtualizer])

  // Keep the selected row in view when it's changed programmatically
  // (Add / Clone appends off-screen, Remove auto-selects a neighbour).
  // align 'auto' only scrolls when the row is actually out of view, so
  // plain clicks on already-visible rows aren't disturbed.
  useEffect(() => {
    if (selectedItemId == null) return
    const idx = filteredItemsRef.current.findIndex((i) => i.id === selectedItemId)
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [selectedItemId, virtualizer])

  useEffect(() => {
    if (!selectedItem || !cacheHandle || !selectedEntry) {
      setSelectedItemContent(null)
      return
    }
    const loader = getLoader(selectedEntry.name)
    if (!loader) return
    let cancelled = false
    async function load() {
      const entryHandle = await resolveEntryHandle(cacheHandle!, getEntryPath(selectedEntry!.name))
      if (!entryHandle) return
      const content = await loader!.loadItem(entryHandle, selectedItem!, cacheHandle!)
      if (!cancelled) setSelectedItemContent(content)
    }
    load()
    return () => { cancelled = true }
  }, [selectedItem, selectedEntry, cacheHandle])

  async function handleSaveItem(data: unknown) {
    if (!cacheHandle || !selectedEntry || !selectedItem) return
    const loader = getLoader(selectedEntry.name)
    if (!loader?.saveItem) return
    const entryHandle = await resolveEntryHandle(cacheHandle, getEntryPath(selectedEntry.name))
    if (!entryHandle) return
    await loader.saveItem(entryHandle, selectedItem, data)
    if (selectedEntry.name === 'config_quests') {
      setSelectedItemContent(data as QuestContent)
    } else {
      setSelectedItemContent(data)
    }
    // A saved new item is a keeper.
    if (pendingNewRef.current?.item.id === selectedItem.id && pendingNewRef.current.entryName === selectedEntry.name) {
      pendingNewRef.current = null
    }
  }

  // Save path for noPanel entries (single-blob, no item list — e.g. huffman).
  async function handleSaveNoPanel(data: unknown) {
    if (!cacheHandle || !selectedEntry) return
    const loader = getLoader(selectedEntry.name)
    if (!loader?.saveItem) return
    const entryHandle = await resolveEntryHandle(cacheHandle, getEntryPath(selectedEntry.name))
    if (!entryHandle) return
    await loader.saveItem(entryHandle, { id: 0, name: selectedEntry.name }, data)
    setActiveContent(data)
  }

  async function currentEntryHandle(): Promise<FileSystemDirectoryHandle | null> {
    if (!cacheHandle || !selectedEntry) return null
    return resolveEntryHandle(cacheHandle, getEntryPath(selectedEntry.name))
  }

  // Deletes the never-saved Add-ed item (if any) from disk and, when we're
  // still on its entry, from the item list.
  async function discardPendingNew() {
    const pending = pendingNewRef.current
    if (!pending || !cacheHandle) return
    pendingNewRef.current = null

    if (pending.entryName === selectedEntry?.name) {
      setActiveItems((prev) => prev.filter((i) => i.id !== pending.item.id))
    }
    const loader = getLoader(pending.entryName)
    if (!loader?.deleteItem) return
    const entryHandle = await resolveEntryHandle(cacheHandle, getEntryPath(pending.entryName))
    if (!entryHandle) return
    try {
      await loader.deleteItem(entryHandle, pending.item)
    } catch {
      // already gone — nothing to clean up
    }
  }

  // Central navigation guard: prompts on unsaved changes and cleans up a
  // never-saved added item. Returns false when the user cancels.
  async function confirmLeaveItem(): Promise<boolean> {
    if (isContentDirty) {
      const ok = await confirmDialog('You have unsaved changes. Discard them and continue?', {
        title: 'Unsaved changes',
        confirmLabel: 'Discard',
        danger: true,
      })
      if (!ok) return false
    }
    setIsContentDirty(false)
    return true
  }

  async function handleSelectItem(id: number) {
    if (id === selectedItemId) return
    if (!(await confirmLeaveItem())) return
    if (pendingNewRef.current?.item.id !== id || pendingNewRef.current?.entryName !== selectedEntry?.name) {
      void discardPendingNew()
    }
    setSelectedItemId(id)
  }

  async function handleAddItem() {
    const loader = selectedEntry ? getLoader(selectedEntry.name) : null
    const entryHandle = await currentEntryHandle()
    if (!loader?.createItem || !entryHandle) return
    if (!(await confirmLeaveItem())) return
    await discardPendingNew()
    const item = await loader.createItem(entryHandle)
    pendingNewRef.current = { entryName: selectedEntry!.name, item }
    setActiveItems((prev) => [...prev, item].sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)))
    setSelectedItemId(item.id)
  }

  async function handleRemoveItem() {
    const loader = selectedEntry ? getLoader(selectedEntry.name) : null
    const entryHandle = await currentEntryHandle()
    if (!loader?.deleteItem || !entryHandle || !selectedItem) return
    const ok = await confirmDialog(
      `Delete ${selectedItem.name} from ${selectedEntry!.name}? This removes the file from disk.`,
      { title: 'Delete item', confirmLabel: 'Delete', danger: true },
    )
    if (!ok) return
    if (pendingNewRef.current?.item.id === selectedItem.id && pendingNewRef.current.entryName === selectedEntry!.name) {
      pendingNewRef.current = null
    }
    await loader.deleteItem(entryHandle, selectedItem)
    const removedId = selectedItem.id
    setIsContentDirty(false)
    setActiveItems((prev) => {
      const next = prev.filter((i) => i.id !== removedId)
      const idx = prev.findIndex((i) => i.id === removedId)
      setSelectedItemId(next[Math.min(idx, next.length - 1)]?.id ?? null)
      return next
    })
  }

  async function handleCloneItem() {
    const loader = selectedEntry ? getLoader(selectedEntry.name) : null
    const entryHandle = await currentEntryHandle()
    if (!loader?.cloneItem || !entryHandle || !selectedItem) return
    if (!(await confirmLeaveItem())) return
    // Clone before discarding a pending new item — the source could BE the
    // pending item, and it has to still exist on disk to be read.
    const item = await loader.cloneItem(entryHandle, selectedItem)
    await discardPendingNew()
    setActiveItems((prev) => [...prev, item].sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)))
    setSelectedItemId(item.id)
  }

  async function loadEntryItems(handle: FileSystemDirectoryHandle, entry: CacheEntry, version: number) {
    const loader = getLoader(entry.name)
    if (!loader) {
      setIsLoading(false)
      return
    }

    const entryHandle = await resolveEntryHandle(handle, getEntryPath(entry.name))
    if (!entryHandle) {
      setIsLoading(false)
      return
    }

    if (loader.noPanel) {
      const content = await loader.loadItem(entryHandle, { id: 0, name: entry.name }, handle)
      if (loadVersion.current !== version) return
      setActiveContent(content)
      setIsLoading(false)
      return
    }

    const buffer: LoadedItem[] = []

    for await (const item of loader.streamItems(entryHandle, handle)) {
      if (loadVersion.current !== version) return
      buffer.push(item)
      if (buffer.length % 5000 === 0) setLoadCount(buffer.length)
    }

    if (loadVersion.current !== version) return

    buffer.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name))
    setActiveItems(buffer)
    setSelectedItemId(buffer[0]?.id ?? null)
    setLoadCount(0)
    setIsLoading(false)
  }

  async function handleSelectEntry(id: number) {
    const entry = entries.find((e) => e.id === id)
    if (!entry || !entry.available) return
    if (entry.id !== selectedEntryId && !(await confirmLeaveItem())) return
    await discardPendingNew()

    const version = ++loadVersion.current
    setSelectedEntryId(id)
    setActiveItems([])
    setActiveContent(null)
    setSelectedItemContent(null)
    setSelectedItemId(null)
    setFilter('')
    setIsLoading(true)
    setLoadCount(0)

    if (cacheHandle) await loadEntryItems(cacheHandle, entry, version)
  }

  async function handleOpenCache() {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setCacheError(null)

      let targetHandle = dirHandle
      try {
        targetHandle = await dirHandle.getDirectoryHandle('unpacked')
      } catch {
        // no unpacked subfolder, use the opened folder directly
      }

      for await (const handle of targetHandle.values()) {
        if (handle.kind === 'file') {
          setCacheError('Please open your unpacked cache folder — the selected folder contains files, not just cache entries.')
          return
        }
      }

      const loaded = await readCacheDir(targetHandle)
      if (loaded.length === 0) return

      const version = ++loadVersion.current
      setCacheHandle(targetHandle)
      setEntries(loaded)
      setDirName(targetHandle.name)
      setActiveItems([])
      setActiveContent(null)
      setSelectedItemId(null)
      setFilter('')

      const first = loaded.find((e) => e.available)
      if (!first) return
      setSelectedEntryId(first.id)
      setIsLoading(true)
      setLoadCount(0)
      await loadEntryItems(targetHandle, first, version)
    } catch {
      // user cancelled
    }
  }

  return (
    <div id="app">
      <aside id="sidebar">
        <div className="sidebar-header">
          <h1>Cryo Cache Editor</h1>
          <button type="button" className="open-cache-btn" onClick={handleOpenCache}>
            {dirName ? `📁 ${dirName}` : 'Open Cache'}
          </button>
          {cacheError && <p className="cache-error">{cacheError}</p>}
        </div>
        {entries.length === 0 ? (
          <p className="sidebar-empty">Open a cache folder to begin.</p>
        ) : (
          <ul className="item-list">
            {sidebarRows.map((row) => {
              if (row.type === 'entry') {
                const entry = row.entry
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={[
                        entry.id === selectedEntryId ? 'active' : '',
                        entryStatusClass(entry),
                      ].join(' ').trim()}
                      disabled={!entry.available}
                      title={entry.available ? undefined : unavailableReason(entry.name)}
                      onClick={() => handleSelectEntry(entry.id)}
                    >
                      {formatEntryLabel(entry.name)}
                    </button>
                  </li>
                )
              }

              const { groupName, members } = row
              const isActiveGroup = selectedEntry?.group === groupName
              const anyAvailable = members.some((m) => m.available)
              const anySpecializedAvailable = members.some((m) => m.available && SPECIALIZED_ENTRIES.has(m.name))
              // Collapsible even while a member is selected — the toggle
              // keeps its 'active' highlight so it's clear where the
              // focused entry lives.
              const isOpen = openGroups.has(groupName)

              return (
                <li key={`group-${groupName}`} className="sidebar-group">
                  <button
                    type="button"
                    className={[
                      'sidebar-group-toggle',
                      isActiveGroup ? 'active' : '',
                      !anyAvailable ? 'unavailable' : !anySpecializedAvailable ? 'generic' : '',
                    ].join(' ').trim()}
                    disabled={!anyAvailable}
                    title={anyAvailable ? undefined : 'No data found for this cache entry'}
                    onClick={() => {
                      setOpenGroups((prev) => {
                        const next = new Set(prev)
                        if (next.has(groupName)) next.delete(groupName)
                        else next.add(groupName)
                        return next
                      })
                    }}
                  >
                    <span>{GROUP_LABELS[groupName] ?? formatEntryLabel(groupName)}</span>
                    <span className={`sidebar-group-arrow${isOpen ? ' open' : ''}`}>▸</span>
                  </button>
                  {isOpen && (
                    <ul className="sidebar-group-members">
                      {members.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            className={[
                              m.id === selectedEntryId ? 'active' : '',
                              entryStatusClass(m),
                            ].join(' ').trim()}
                            disabled={!m.available}
                            title={m.available ? undefined : unavailableReason(m.name)}
                            onClick={() => handleSelectEntry(m.id)}
                          >
                            {formatEntryLabel(m.name.replace(/^config_/, ''))}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <div id="right-section">
        {selectedEntry && !noPanel && (
          <aside id="item-list-panel">
            <div className="panel-header">
              <h2>{formatEntryLabel(selectedEntry.name)}</h2>
              <div className="panel-actions">
                <button
                  type="button"
                  className="panel-action-btn"
                  disabled={!currentLoader?.createItem}
                  onClick={handleAddItem}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="panel-action-btn"
                  disabled={!currentLoader?.deleteItem || !selectedItem}
                  onClick={handleRemoveItem}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="panel-action-btn"
                  disabled={!currentLoader?.cloneItem || !selectedItem}
                  onClick={handleCloneItem}
                >
                  Clone
                </button>
              </div>
              <input
                className="item-filter"
                type="text"
                placeholder="Search or jump to #..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul ref={itemListRef} className="item-list">
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((vItem) => {
                  const item = filteredItems[vItem.index]
                  return (
                    <li
                      key={vItem.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${vItem.size}px`,
                        transform: `translateY(${vItem.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        className={item.id === selectedItem?.id ? 'active' : ''}
                        title={item.name}
                        onClick={() => handleSelectItem(item.id)}
                      >
                        {item.name}
                      </button>
                    </li>
                  )
                })}
              </div>
            </ul>
          </aside>
        )}

        <main id="content">
          <div className="content-panel">
          <div className="content-panel-scroll" ref={contentPanelRef}>
            {isLoading ? (
              <p className="loading-text">
                {loadCount > 0
                  ? `Loading… ${loadCount.toLocaleString()} items found so far`
                  : 'Loading…'}
              </p>
            ) : activeContent != null ? (
              selectedEntry?.name === 'huffman'
                ? <HuffmanViewer data={activeContent as HuffmanData} onSave={handleSaveNoPanel} />
                : selectedEntry?.name === 'native_libraries'
                ? <NativeLibrariesViewer data={activeContent as NativeLibrariesData} />
                : <pre className="content-json">{JSON.stringify(activeContent, null, 2)}</pre>
            ) : selectedItemContent != null ? (
              questContent != null
                ? <QuestViewer data={questContent.quest} serverData={questContent.server ?? undefined} onSave={(quest, server) => handleSaveItem({ quest, server })} onDirtyChange={setIsContentDirty} />
                : spriteContent != null
                ? <SpriteViewer data={spriteContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : modelContent != null
                ? <ModelViewer data={modelContent} />
                : textureContent != null
                ? <TextureViewer data={textureContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : enumContent != null
                ? <EnumViewer data={enumContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : cursorContent != null
                ? <CursorViewer data={cursorContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : mapSpriteContent != null
                ? <MapSpriteViewer data={mapSpriteContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : itemContent != null
                ? <ItemViewer data={itemContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : objectContent != null
                ? <ObjectViewer data={objectContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : npcContent != null
                ? <NpcViewer data={npcContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : varbitContent != null
                ? <VarbitViewer data={varbitContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : structContent != null
                ? <StructViewer data={structContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : paramContent != null
                ? <ParamViewer data={paramContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : varContent != null
                ? <VarViewer data={varContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : inventoryContent != null
                ? <InventoryViewer data={inventoryContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : hitbarContent != null
                ? <HitbarViewer data={hitbarContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : hitsplatContent != null
                ? <HitsplatViewer data={hitsplatContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : defaultsContent != null
                ? <DefaultsViewer data={defaultsContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : billboardContent != null
                ? <BillboardViewer data={billboardContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : skyboxContent != null
                ? <SkyboxViewer data={skyboxContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : mapAreaContent != null
                ? <MapAreaViewer data={mapAreaContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : areaContent != null
                ? <AreaViewer data={areaContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : fontContent != null
                ? <FontViewer data={fontContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : quickChatContent != null
                ? <QuickChatViewer data={quickChatContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : <pre className="content-json">{JSON.stringify(selectedItemContent, null, 2)}</pre>
            ) : selectedItem ? (
              <p className="loading-text">Loading…</p>
            ) : null}
          </div>
          </div>
        </main>
      </div>
      {confirmDialogElement}
    </div>
  )
}

export default App
