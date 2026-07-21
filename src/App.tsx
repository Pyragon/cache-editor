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
import type { ModelDisplayParams } from './components/ModelViewer'
import type { ModelData } from './loaders/models'
import TextureViewer from './components/TextureViewer'
import ParticleViewer from './components/ParticleViewer'
import type { TextureData } from './loaders/textures'
import ModelPreviewModal from './components/ModelPreviewModal'
import { resolveRetextureAssets } from './components/modelDisplay'
import { invalidateAnimCompatIndex } from './loaders/animCompat'
import { invalidateNpcIcon } from './components/npcSnapshot'
import type { ParticleData } from './loaders/particles'
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
import BasViewer from './components/BasViewer'
import HitbarViewer from './components/HitbarViewer'
import LightIntensityViewer from './components/LightIntensityViewer'
import VarcViewer from './components/VarcViewer'
import type { VarcData } from './loaders/config/varc'
import VarcStringViewer from './components/VarcStringViewer'
import type { VarcStringData } from './loaders/config/varc_string'
import ClanVarViewer from './components/ClanVarViewer'
import UnderlayViewer from './components/UnderlayViewer'
import type { UnderlayData } from './loaders/config/underlays'
import OverlayViewer from './components/OverlayViewer'
import type { OverlayData } from './loaders/config/overlays'
import MapViewer from './components/MapViewer'
import type { WorldMapData } from './loaders/maps'
import GameTipViewer from './components/GameTipViewer'
import type { GameTipData } from './loaders/game_tips'
import InterfaceViewer from './components/InterfaceViewer'
import type { InterfaceData } from './loaders/interfaces'
import SoundEffectViewer from './components/SoundEffectViewer'
import type { SoundEffectData } from './loaders/sound_effects'
import MidiInstrumentViewer from './components/MidiInstrumentViewer'
import type { MidiInstrumentData } from './loaders/midi_instruments'
import MusicViewer from './components/MusicViewer'
import type { MusicData } from './loaders/music'
import SoundEffectMidiViewer from './components/SoundEffectMidiViewer'
import type { SoundEffectMidiData } from './loaders/sound_effects_midi'
import IdentikitViewer from './components/IdentikitViewer'
import type { IdentikitData } from './loaders/config/identikit'
import AnimationViewer from './components/AnimationViewer'
import type { AnimationData } from './loaders/animations'
import AnimationFrameBaseViewer from './components/AnimationFrameBaseViewer'
import type { AnimationFrameBaseData } from './loaders/animation_frame_bases'
import AnimationFrameSetViewer from './components/AnimationFrameSetViewer'
import type { AnimationFrameSetData } from './loaders/animation_frame_sets'
import SpotAnimationViewer from './components/SpotAnimationViewer'
import type { SpotAnimationData } from './loaders/spot_animations'
import type { ClanVarData } from './loaders/config/clan_var'
import type { ClanVarSettingsData } from './loaders/config/clan_var_settings'
import type { LightIntensityData } from './loaders/config/light_intensities'
import type { BasData } from './loaders/config/bas'
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
import { WriteCapture, downloadCaptured, dropToDirectoryHandle } from './loaders/dropFs'

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
  'config_hitbars', 'config_hitsplats', 'config_skybox', 'config_map_areas', 'config_light_intensities', 'config_bas',
  'config_varc', 'config_varc_string', 'config_clan_var', 'config_clan_var_settings',
  'items', 'objects', 'npcs', 'varbits', 'defaults', 'billboards', 'map_areas', 'quick_chat_messages', 'quick_chat_menus',
  'sprites', 'models', 'textures', 'texture_definitions', 'enums', 'huffman', 'native_libraries', 'font_metrics',
  'particles', 'game_tips', 'config_underlays', 'config_overlays', 'maps', 'interfaces', 'sound_effects', 'midi_instruments',
  'music', 'music2', 'sound_effects_midi', 'config_identikit',
  'animations', 'animation_frame_bases', 'animation_frame_sets', 'spot_animations',
])

// Feature-complete entries — rendered green in the sidebar. Only entries
// the user has manually reviewed and signed off go in here.
const DONE_ENTRIES = new Set([
  'config_cursors', 'config_hitbars', 'config_inventories', 'config_params', 'config_structs', 'config_vars', 'defaults', 'huffman', 'native_libraries', 'varbits',
  'quick_chat_messages', 'quick_chat_menus', 'billboards', 'map_areas', 'config_map_areas', 'config_skybox', 'config_hitsplats', 'enums', 'font_metrics', 'sprites', 'config_map_sprites',
  'particles', 'textures', 'texture_definitions', 'items', 'config_light_intensities',
  'config_varc', 'config_varc_string', 'config_clan_var', 'config_clan_var_settings', 'config_quests', 'game_tips',
  'config_bas',
])

function unavailableReason(name: string): string {
  return EMPTY_ENTRIES[name] ?? 'Not in this dump — cryogen has no dumper for this entry yet (the cache itself may still hold data)'
}

function entryStatusClass(entry: CacheEntry): string {
  if (!entry.available) return 'unavailable'
  if (DONE_ENTRIES.has(entry.name)) return 'done'
  if (!SPECIALIZED_ENTRIES.has(entry.name)) return 'generic'
  return ''
}

const ENTRY_LABEL_OVERRIDES: Record<string, string> = {
  bas: 'BAS',
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
  config_objects: 'Empty in this cache — object definitions moved to the top-level objects index long before rev 727.',
  config_enums: 'Empty in this cache — enum definitions moved to the top-level enums index long before rev 727.',
  config_npcs: 'Empty in this cache — NPC definitions moved to the top-level npcs index long before rev 727.',
  config_items: 'Empty in this cache — item definitions moved to the top-level items index long before rev 727.',
  config_varbits: 'Empty in this cache — varbit definitions moved to the top-level varbits index long before rev 727.',
  config_animations: 'Empty in this cache — animation definitions moved to the top-level animations index long before rev 727.',
  config_spot_anims: 'Empty in this cache — spot animation definitions moved to the top-level spot_animations index long before rev 727.',
}

// Add / Remove / Clone write to disk straight away rather than going through
// saveItem, so unlike an edit they can't be turned into a download: Remove has no
// browser API at all outside Chromium, and a created file wouldn't be on disk for the
// item list to read back.
// Shown in every "that isn't a cache folder" modal. The unpacked cache isn't something
// you download — it's produced by cryogen's CacheBuilder — and that's the bit people
// get stuck on, so it gets spelled out rather than assumed.
const UnpackedFolderHelp = () => (
  <>
    <p className="folder-help-para">
      The editor works against an <strong>unpacked</strong> cache: a folder of folders, one per cache
      index. It isn't the packed cache (<code>main_file_cache.dat2</code> and friends) and it isn't a
      download — you generate it yourself.
    </p>
    <p className="folder-help-para">
      Run <strong><code>CacheBuilder</code></strong> in the cryogen repo. It reads your packed cache and
      writes the unpacked one out to the path in <code>CacheBuilder.UNPACKED_PATH</code>:
    </p>
    <pre className="folder-help-tree">{`cryogen-cache/
├── packed/            (the .dat2 / .idx files CacheBuilder reads)
└── unpacked/          ← open this
    ├── items/
    ├── models/
    ├── particles/
    ├── textures/
    └── …`}</pre>
    <p className="folder-help-para">
      You can pick either <code>unpacked/</code> itself or its parent — if the folder you choose contains
      an <code>unpacked/</code> subfolder, the editor steps into it for you.
    </p>
  </>
)

const CRUD_UNAVAILABLE =
  'Not available in a dragged-in folder — this browser can only read it. Editing an existing item still works (it downloads).'

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

  // Firefox has no folder picker, but it can read a folder that's dragged in. Such a
  // session can't write back, so saves download instead — `isDownloadMode` is what the
  // save bars and the banner key off.
  const canPickFolder = typeof window.showDirectoryPicker === 'function'
  const [isDownloadMode, setIsDownloadMode] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  /** Non-null while a chosen folder is being scanned, before the sidebar exists. */
  const [openingStage, setOpeningStage] = useState<string | null>(null)
  const [downloadNotice, setDownloadNotice] = useState('')
  const writeCapture = useRef(new WriteCapture())

  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null)
  const [activeItems, setActiveItems] = useState<LoadedItem[]>([])
  const [activeContent, setActiveContent] = useState<unknown>(null)
  const [selectedItemContent, setSelectedItemContent] = useState<unknown>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadCount, setLoadCount] = useState(0)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  // Inventory-icon pose for the model viewer, set when arriving via an item's
  // "View Model" link and cleared again by any manual navigation.
  const [modelDisplay, setModelDisplay] = useState<ModelDisplayParams | null>(null)
  // Item "View Model" preview modal (posed when display params are present).
  const [itemModelPreview, setItemModelPreview] = useState<{ modelId: number; display: ModelDisplayParams | null } | null>(null)
  const [filter, setFilter] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [isContentDirty, setIsContentDirty] = useState(false)
  const { confirm: confirmDialog, dialog: confirmDialogElement } = useConfirm()

  // An item created via Add that hasn't been saved yet — navigating away
  // from it deletes it again instead of leaving a half-configured file.
  // A just-Added/Cloned item. `content` staged means it exists ONLY in memory
  // — nothing is on disk until the user saves (an abandoned defaults file
  // would otherwise repack into the cache via cryogen's getActions).
  const pendingNewRef = useRef<{ entryName: string; item: LoadedItem; content?: unknown } | null>(null)
  // State mirror of pendingNewRef, so the "not saved yet" banner re-renders.
  const [pendingNew, setPendingNew] = useState<{ entry: string; id: number } | null>(null)

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

  const particleContent = selectedEntry?.name === 'particles' && selectedItemContent != null
    ? selectedItemContent as ParticleData
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

  const basContent = selectedEntry?.name === 'config_bas' && selectedItemContent != null
    ? selectedItemContent as BasData
    : null

  const lightIntensityContent = selectedEntry?.name === 'config_light_intensities' && selectedItemContent != null
    ? selectedItemContent as LightIntensityData
    : null

  const varcContent = selectedEntry?.name === 'config_varc' && selectedItemContent != null
    ? selectedItemContent as VarcData
    : null

  const varcStringContent = selectedEntry?.name === 'config_varc_string' && selectedItemContent != null
    ? selectedItemContent as VarcStringData
    : null

  const clanVarContent = selectedEntry?.name === 'config_clan_var' && selectedItemContent != null
    ? selectedItemContent as ClanVarData
    : null

  const clanVarSettingsContent = selectedEntry?.name === 'config_clan_var_settings' && selectedItemContent != null
    ? selectedItemContent as ClanVarSettingsData
    : null

  const underlayContent = selectedEntry?.name === 'config_underlays' && selectedItemContent != null
    ? selectedItemContent as UnderlayData
    : null

  const overlayContent = selectedEntry?.name === 'config_overlays' && selectedItemContent != null
    ? selectedItemContent as OverlayData
    : null


  const gameTipContent = selectedEntry?.name === 'game_tips' && selectedItemContent != null
    ? selectedItemContent as GameTipData
    : null

  const interfaceContent = selectedEntry?.name === 'interfaces' && selectedItemContent != null
    ? selectedItemContent as InterfaceData
    : null

  const soundEffectContent = selectedEntry?.name === 'sound_effects' && selectedItemContent != null
    ? selectedItemContent as SoundEffectData
    : null

  const midiInstrumentContent = selectedEntry?.name === 'midi_instruments' && selectedItemContent != null
    ? selectedItemContent as MidiInstrumentData
    : null

  const musicContent = (selectedEntry?.name === 'music' || selectedEntry?.name === 'music2') && selectedItemContent != null
    ? selectedItemContent as MusicData
    : null

  const soundEffectMidiContent = selectedEntry?.name === 'sound_effects_midi' && selectedItemContent != null
    ? selectedItemContent as SoundEffectMidiData
    : null

  const identikitContent = selectedEntry?.name === 'config_identikit' && selectedItemContent != null
    ? selectedItemContent as IdentikitData
    : null

  const animationContent = selectedEntry?.name === 'animations' && selectedItemContent != null
    ? selectedItemContent as AnimationData
    : null

  const animationFrameBaseContent = selectedEntry?.name === 'animation_frame_bases' && selectedItemContent != null
    ? selectedItemContent as AnimationFrameBaseData
    : null

  const animationFrameSetContent = selectedEntry?.name === 'animation_frame_sets' && selectedItemContent != null
    ? selectedItemContent as AnimationFrameSetData
    : null

  const spotAnimationContent = selectedEntry?.name === 'spot_animations' && selectedItemContent != null
    ? selectedItemContent as SpotAnimationData
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
  const handleSelectItemRef = useRef<(id: number) => Promise<boolean>>(async () => false)
  handleSelectItemRef.current = handleSelectItem

  // filteredItems is rebuilt every render; hold it in a ref so the
  // selection-scroll effect can read it without depending on its identity.
  const filteredItemsRef = useRef(filteredItems)
  filteredItemsRef.current = filteredItems

  // Auto-select on numeric filters — keyed to the filter text and the loaded
  // list (which covers "id typed while the entry was still streaming"), NOT to
  // filteredItems: that array is rebuilt with a fresh identity every render,
  // so depending on it re-fired this after every click and stomped any manual
  // selection while an id filter was active.
  useEffect(() => {
    if (/^\d+$/.test(filter)) {
      const num = parseInt(filter, 10)
      const items = filteredItemsRef.current
      const idx = items.findIndex((item) => item.id === num)
      if (idx !== -1) {
        handleSelectItemRef.current(items[idx].id)
        virtualizer.scrollToIndex(idx, { align: 'center' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, activeItems, virtualizer])

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
    // Staged new items have no file yet - their content lives on the ref.
    const pending = pendingNewRef.current
    if (pending && pending.content !== undefined
        && pending.entryName === selectedEntry.name && pending.item.id === selectedItem.id) {
      setSelectedItemContent(pending.content)
      return
    }
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

    // These def types feed the session-wide anim-compat index (BAS/animation
    // Used By and fit tables) — drop it so the tables offer a fresh rescan
    // instead of serving stale rows.
    if (['animations', 'animation_frame_sets', 'config_bas', 'npcs', 'spot_animations', 'items'].includes(selectedEntry.name)) {
      invalidateAnimCompatIndex()
    }
    // The sidebar snapshot icon reflects the def — regenerate after a save.
    if (selectedEntry.name === 'npcs') invalidateNpcIcon(selectedItem.id)

    // In a dropped (Firefox) session nothing reached disk — the shim collected the
    // bytes instead. Hand them over as a download; several files become one zip whose
    // paths mirror the cache, so a texture save (which writes both
    // texture_definitions/<id>.json and textures/<id>/<id>.json) still lands correctly.
    if (writeCapture.current.size > 0) {
      const files = writeCapture.current.take()
      setDownloadNotice(await downloadCaptured(files, `${selectedEntry.name}-${selectedItem.id}`))
    }

    if (selectedEntry.name === 'config_quests') {
      setSelectedItemContent(data as QuestContent)
    } else {
      setSelectedItemContent(data)
    }
    // A saved new item is a keeper.
    if (pendingNewRef.current?.item.id === selectedItem.id && pendingNewRef.current.entryName === selectedEntry.name) {
      pendingNewRef.current = null
      setPendingNew(null)
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

  // Drops the never-saved Add-ed/Cloned item (if any): out of the item list,
  // and off disk only in the fallback case where it was actually written
  // (staged items never were).
  async function discardPendingNew() {
    const pending = pendingNewRef.current
    if (!pending || !cacheHandle) return
    pendingNewRef.current = null
    setPendingNew(null)

    if (pending.entryName === selectedEntry?.name) {
      setActiveItems((prev) => prev.filter((i) => i.id !== pending.item.id))
    }
    if (pending.content !== undefined) return // in-memory only, nothing on disk
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

  async function handleSelectItem(id: number): Promise<boolean> {
    if (id === selectedItemId) return true
    if (!(await confirmLeaveItem())) return false
    if (pendingNewRef.current?.item.id !== id || pendingNewRef.current?.entryName !== selectedEntry?.name) {
      void discardPendingNew()
    }
    setModelDisplay(null)
    setSelectedItemId(id)
    return true
  }

  // Stages a new/cloned item in memory: the loader writes its defaults (it
  // owns that knowledge), we load them, then take the file straight back off
  // disk - nothing persists until the user saves.
  async function stagePendingItem(
    loader: NonNullable<ReturnType<typeof getLoader>>,
    entryHandle: FileSystemDirectoryHandle,
    item: LoadedItem,
  ) {
    let content: unknown
    if (loader.deleteItem && loader.saveItem) {
      try {
        content = await loader.loadItem(entryHandle, item, cacheHandle ?? undefined)
        await loader.deleteItem(entryHandle, item)
      } catch {
        content = undefined // staging failed - fall back to the on-disk flow
      }
    }
    pendingNewRef.current = { entryName: selectedEntry!.name, item, content }
    setPendingNew({ entry: selectedEntry!.name, id: item.id })
    setActiveItems((prev) => [...prev, item].sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)))
    setSelectedItemId(item.id)
    if (content !== undefined) setSelectedItemContent(content)
  }

  async function handleAddItem() {
    const loader = selectedEntry ? getLoader(selectedEntry.name) : null
    const entryHandle = await currentEntryHandle()
    if (!loader?.createItem || !entryHandle) return
    if (!(await confirmLeaveItem())) return
    await discardPendingNew()
    const item = await loader.createItem(entryHandle)
    await stagePendingItem(loader, entryHandle, item)
  }

  // The banner's Discard: drop the staged item and select a neighbour.
  async function handleDiscardPendingNew() {
    const pending = pendingNewRef.current
    if (!pending) return
    setIsContentDirty(false)
    const removedId = pending.item.id
    await discardPendingNew()
    setActiveItems((prev) => {
      const idx = prev.findIndex((i) => i.id === removedId)
      const next = prev.filter((i) => i.id !== removedId)
      setSelectedItemId(next[Math.min(Math.max(idx, 0), next.length - 1)]?.id ?? null)
      return next
    })
  }

  // "New from image" in the texture viewer wrote its files itself — surface
  // the new id in the sidebar list and jump to it (unless unsaved edits on the
  // current item make the user decline the jump; the files exist either way).
  async function handleTextureCreated(id: number) {
    setActiveItems((prev) => {
      if (prev.some((i) => i.id === id)) return prev
      return [...prev, { id, name: String(id) }].sort((a, b) => a.id - b.id || a.name.localeCompare(b.name))
    })
    if (!(await confirmLeaveItem())) return
    void discardPendingNew()
    setSelectedItemId(id)
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
    let onDisk = true
    if (pendingNewRef.current?.item.id === selectedItem.id && pendingNewRef.current.entryName === selectedEntry!.name) {
      onDisk = pendingNewRef.current.content === undefined
      pendingNewRef.current = null
      setPendingNew(null)
    }
    if (onDisk) await loader.deleteItem(entryHandle, selectedItem)
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
    // A staged new item has no file for cloneItem to read.
    if (pendingNewRef.current?.item.id === selectedItem.id
        && pendingNewRef.current.entryName === selectedEntry!.name
        && pendingNewRef.current.content !== undefined) {
      await confirmDialog('Save the new item first - it only exists in the editor until then.', {
        title: 'Nothing to clone yet', acknowledge: true, confirmLabel: 'Got it',
      })
      return
    }
    if (!(await confirmLeaveItem())) return
    const item = await loader.cloneItem(entryHandle, selectedItem)
    await discardPendingNew()
    await stagePendingItem(loader, entryHandle, item)
  }

  async function loadEntryItems(handle: FileSystemDirectoryHandle, entry: CacheEntry, version: number, selectId?: number) {
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
    const preselect = selectId != null && buffer.some((i) => i.id === selectId) ? selectId : buffer[0]?.id ?? null
    setSelectedItemId(preselect)
    setLoadCount(0)
    setIsLoading(false)
  }

  async function handleSelectEntry(id: number, selectId?: number): Promise<boolean> {
    const entry = entries.find((e) => e.id === id)
    if (!entry || !entry.available) return false
    if (entry.id !== selectedEntryId && !(await confirmLeaveItem())) return false
    await discardPendingNew()

    const version = ++loadVersion.current
    setModelDisplay(null)
    setSelectedEntryId(id)
    setActiveItems([])
    setActiveContent(null)
    setSelectedItemContent(null)
    setSelectedItemId(null)
    setFilter('')
    setIsLoading(true)
    setLoadCount(0)

    if (cacheHandle) await loadEntryItems(cacheHandle, entry, version, selectId)
    return true
  }

  // Cross-entry id links (e.g. an item's modelId → the model viewer): jump to
  // the target entry with that item preselected. Same-entry jumps skip the
  // list reload. If the id doesn't exist in the target's list, the entry still
  // opens on its first item — same as clicking it in the sidebar. Returns
  // false when the user cancelled on the unsaved-changes prompt.
  async function handleNavigateToItem(entryName: string, itemId: number): Promise<boolean> {
    const entry = entries.find((e) => e.name === entryName)
    if (!entry?.available) return false
    if (entry.id === selectedEntryId) return handleSelectItem(itemId)
    return handleSelectEntry(entry.id, itemId)
  }

  // --- Browser history: back/forward re-selects the previously viewed
  // entry/item. Selections push a {entryId, itemId} state; popstate restores
  // through the normal handlers so the unsaved-changes guard still applies —
  // a refused prompt re-pushes the on-screen location so the stack stays
  // consistent with what's shown.
  const historyRestoringRef = useRef(false)
  const handleSelectEntryRef = useRef<(id: number, selectId?: number) => Promise<boolean>>(async () => false)
  handleSelectEntryRef.current = handleSelectEntry
  const selectionRef = useRef<{ entryId: number | null; itemId: number | null }>({ entryId: null, itemId: null })
  selectionRef.current = { entryId: selectedEntryId, itemId: selectedItemId }

  useEffect(() => {
    if (!cacheHandle || historyRestoringRef.current) return
    const next = { entryId: selectedEntryId, itemId: selectedItemId }
    const state = window.history.state as typeof next | null
    if (state == null) {
      window.history.replaceState(next, '')
      return
    }
    if (state.entryId === next.entryId && state.itemId === next.itemId) return
    window.history.pushState(next, '')
  }, [cacheHandle, selectedEntryId, selectedItemId])

  useEffect(() => {
    function onPop(e: PopStateEvent) {
      const state = e.state as { entryId?: number | null; itemId?: number | null } | null
      if (!state || state.entryId == null) return
      historyRestoringRef.current = true
      ;(async () => {
        let ok = false
        try {
          if (state.entryId === selectionRef.current.entryId) {
            ok = state.itemId != null ? await handleSelectItemRef.current(state.itemId) : true
          } else {
            ok = await handleSelectEntryRef.current(state.entryId!, state.itemId ?? undefined)
          }
        } finally {
          // cleared a tick later so the push-effect skips the restore's own
          // selection updates
          setTimeout(() => { historyRestoringRef.current = false }, 0)
        }
        if (!ok) {
          window.history.pushState({ ...selectionRef.current }, '')
        }
      })()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // An item's "View Model": open the model in a preview modal (posed with the
  // item's inventory-icon display params when given) instead of navigating
  // away from the item — the modal offers "Open in Models" for the full page.
  async function handleOpenItemModel(id: number, display?: ModelDisplayParams) {
    const enriched = display && cacheHandle ? await resolveRetextureAssets(cacheHandle, display) : display ?? null
    setItemModelPreview({ modelId: id, display: enriched })
  }

  // The modal's escape hatch: real navigation to the models page, posed like
  // the modal was (set after navigating — navigation clears any previous pose).
  async function handleOpenPreviewInModels() {
    const preview = itemModelPreview
    if (!preview) return
    setItemModelPreview(null)
    if (!(await handleNavigateToItem('models', preview.modelId))) return
    if (preview.display) setModelDisplay(preview.display)
  }

  // Folder problems are modal rather than a line of text in the sidebar: they always
  // mean the same thing (this isn't an unpacked cache), and the explanation of what one
  // is doesn't fit on a line. Not awaited, so the loading overlay can clear behind it.
  function showFolderProblem(title: string, lead: string) {
    void confirmDialog(
      <>
        <p className="folder-help-lead">{lead}</p>
        <UnpackedFolderHelp />
      </>,
      { title, acknowledge: true, confirmLabel: 'Got it' },
    )
  }

  // Everything past the picker is shared by both routes: the real handle and the
  // dropped-folder shim expose the same interface.
  async function adoptCacheRoot(dirHandle: FileSystemDirectoryHandle) {
    // Resolving the ~50 entry folders takes a beat (longer over the drag-and-drop
    // shim, which reads a directory at a time), and until it finishes the sidebar is
    // still empty — so cover the whole scan rather than leaving the UI looking dead.
    setOpeningStage('Opening cache folder…')
    try {
      let targetHandle = dirHandle
      try {
        targetHandle = await dirHandle.getDirectoryHandle('unpacked')
      } catch {
        // no unpacked subfolder, use the opened folder directly
      }

      for await (const handle of targetHandle.values()) {
        if (handle.kind === 'file') {
          showFolderProblem(
            'That doesn\'t look like a cache folder',
            `“${targetHandle.name}” has loose files in it. An unpacked cache contains only folders — one per cache index.`,
          )
          return
        }
      }

      setOpeningStage('Reading cache entries…')
      const loaded = await readCacheDir(targetHandle)

      // Previously a silent return: you'd pick the wrong folder and simply nothing
      // would happen, with no clue why.
      if (!loaded.some((e) => e.available)) {
        showFolderProblem(
          'No cache entries in that folder',
          `Nothing in “${targetHandle.name}” matches a known cache index, so there's nothing to edit.`,
        )
        return
      }

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

      // From here the sidebar is populated and the content panel's own "Loading…"
      // takes over the item stream, so the overlay's job is done.
      setSelectedEntryId(first.id)
      setIsLoading(true)
      setLoadCount(0)
      setOpeningStage(null)
      await loadEntryItems(targetHandle, first, version)
      return
    } finally {
      setOpeningStage(null)
    }
  }

  async function handleDropCache(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    if (canPickFolder) return

    const item = e.dataTransfer.items[0]
    if (!item) return

    const root = dropToDirectoryHandle(item, writeCapture.current)
    if (!root) {
      showFolderProblem(
        'That wasn\'t a folder',
        'Drag the unpacked cache folder itself, not a file or a selection of files from inside it.',
      )
      return
    }

    setIsDownloadMode(true)
    try {
      await adoptCacheRoot(root)
    } catch (err) {
      showFolderProblem(
        'Couldn\'t read that folder',
        err instanceof Error ? err.message : 'The folder couldn\'t be read.',
      )
    }
  }

  // Tracking the drag overlay on the app div doesn't work: dragenter/dragleave fire
  // for every child the cursor crosses, and dragging back OUT of the window doesn't
  // reliably fire dragleave on the div at all — so the overlay would get stuck on.
  // Counting enters against leaves at the window level is the reliable way, with
  // dragend/drop forcing it back to zero in case a leave goes missing.
  useEffect(() => {
    if (canPickFolder) return

    let depth = 0
    const show = () => setIsDragging(true)
    const reset = () => {
      depth = 0
      setIsDragging(false)
    }

    const onEnter = (e: DragEvent) => {
      e.preventDefault()
      depth++
      show()
    }
    // dragover must be prevented or the browser refuses the drop and opens the file
    const onOver = (e: DragEvent) => e.preventDefault()
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDragging(false)
    }

    // Also swallow a drop that lands outside the app div — otherwise the browser
    // navigates away and opens the dropped folder.
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      reset()
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)

    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canPickFolder])

  async function handleOpenCache() {
    // The File System Access API is Chromium-only (Chrome, Edge, Brave, Opera — on
    // Windows, Linux and macOS alike). Firefox doesn't implement it, and without this
    // check the missing function threw a TypeError that landed in the "user cancelled"
    // catch below, so the button silently did nothing. Firefox can still READ a folder
    // if it's dragged in, so point it that way rather than turning it away.
    if (!canPickFolder) {
      void confirmDialog(
        <>
          <p className="folder-help-lead">
            This browser has no folder picker. That needs the File System Access API, which only Chromium
            browsers implement — Chrome, Edge, Brave and Opera, on Linux, macOS and Windows alike.
          </p>
          <p className="folder-help-para">
            You can still <strong>drag your unpacked cache folder onto this window</strong>. Everything is
            browsable that way, but saves will <strong>download</strong> the changed files instead of writing
            them back, because Firefox has no way to write into a folder you picked.
          </p>
          <UnpackedFolderHelp />
        </>,
        { title: 'Drag the folder in instead', acknowledge: true, confirmLabel: 'Got it' },
      )
      return
    }

    try {
      await adoptCacheRoot(await window.showDirectoryPicker!({ mode: 'readwrite' }))
    } catch (e) {
      // Dismissing the picker throws AbortError — that's not a failure. Anything
      // else is, and used to be swallowed here.
      if (e instanceof DOMException && e.name === 'AbortError') return
      showFolderProblem(
        'Couldn\'t open that folder',
        e instanceof Error ? e.message : 'The folder couldn\'t be opened.',
      )
    }
  }

  return (
    <div
      id="app"
      data-download-mode={isDownloadMode ? 'true' : undefined}
      onDrop={handleDropCache}
    >
      {isDragging && !canPickFolder && (
        <div className="drop-overlay">
          <p>Drop your <strong>unpacked</strong> cache folder here</p>
        </div>
      )}

      {openingStage && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-overlay-body">
            <span className="loading-spinner" aria-hidden="true" />
            <p className="loading-overlay-stage">{openingStage}</p>
            <p className="loading-overlay-hint">
              A full cache is around a million files, so the first scan can take a moment.
            </p>
          </div>
        </div>
      )}

      <aside id="sidebar">
        <div className="sidebar-header">
          <h1>Cryo Cache Editor</h1>
          <button type="button" className="open-cache-btn" onClick={handleOpenCache}>
            {dirName ? `📁 ${dirName}` : canPickFolder ? 'Open Cache' : 'Drag your cache folder in'}
          </button>

          {isDownloadMode && (
            <p className="download-mode-note">
              Read-only session — this browser can't write to the folder. Saves will
              download the changed files instead.
            </p>
          )}
          {downloadNotice && (
            <p className="download-notice">
              {downloadNotice}
              <button type="button" className="download-notice-close" onClick={() => setDownloadNotice('')}>×</button>
            </p>
          )}
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
                  disabled={!currentLoader?.createItem || isDownloadMode}
                  title={isDownloadMode ? CRUD_UNAVAILABLE : undefined}
                  onClick={handleAddItem}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="panel-action-btn"
                  disabled={!currentLoader?.deleteItem || !selectedItem || isDownloadMode}
                  title={isDownloadMode ? CRUD_UNAVAILABLE : undefined}
                  onClick={handleRemoveItem}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="panel-action-btn"
                  disabled={!currentLoader?.cloneItem || !selectedItem || isDownloadMode}
                  title={isDownloadMode ? CRUD_UNAVAILABLE : undefined}
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
                : selectedEntry?.name === 'maps'
                ? <MapViewer world={activeContent as WorldMapData} onDirtyChange={setIsContentDirty} />
                : <pre className="content-json">{JSON.stringify(activeContent, null, 2)}</pre>
            ) : selectedItemContent != null ? (
              <>
              {pendingNew && selectedEntry?.name === pendingNew.entry && selectedItemId === pendingNew.id && (
                <div className="pending-new-bar">
                  <span className="pending-new-label">
                    New item {pendingNew.id} exists only in the editor until you save it.
                  </span>
                  <button type="button" className="save-bar-discard" onClick={handleDiscardPendingNew}>
                    Discard
                  </button>
                  {!isContentDirty && (
                    <button type="button" className="save-bar-save" onClick={() => handleSaveItem(selectedItemContent)}>
                      Save
                    </button>
                  )}
                </div>
              )}
              {questContent != null
                ? <QuestViewer data={questContent.quest} serverData={questContent.server ?? undefined} onSave={(quest, server) => handleSaveItem({ quest, server })} onDirtyChange={setIsContentDirty} />
                : spriteContent != null
                ? <SpriteViewer data={spriteContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : modelContent != null
                ? <ModelViewer data={modelContent} display={modelDisplay} />
                : textureContent != null
                ? <TextureViewer data={textureContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onCreated={handleTextureCreated} />
                : particleContent != null
                ? <ParticleViewer data={particleContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : enumContent != null
                ? <EnumViewer data={enumContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : cursorContent != null
                ? <CursorViewer data={cursorContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : mapSpriteContent != null
                ? <MapSpriteViewer data={mapSpriteContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenObject={(id) => handleNavigateToItem('objects', id)} />
                : itemContent != null
                ? <ItemViewer data={itemContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenModel={handleOpenItemModel} onOpenCursor={(id) => handleNavigateToItem('config_cursors', id)} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : objectContent != null
                ? <ObjectViewer data={objectContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : npcContent != null
                ? <NpcViewer data={npcContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
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
                : basContent != null
                ? <BasViewer data={basContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenAnimation={(id) => handleNavigateToItem('animations', id)} cacheRoot={cacheHandle} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : lightIntensityContent != null
                ? <LightIntensityViewer data={lightIntensityContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : varcContent != null
                ? <VarcViewer data={varcContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : varcStringContent != null
                ? <VarcStringViewer data={varcStringContent} />
                : clanVarContent != null
                ? <ClanVarViewer data={clanVarContent} title="Clan Var" onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenVar={(id) => handleNavigateToItem('config_clan_var', id)} />
                : clanVarSettingsContent != null
                ? <ClanVarViewer data={clanVarSettingsContent} title="Clan Setting" onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenVar={(id) => handleNavigateToItem('config_clan_var_settings', id)} />
                : underlayContent != null
                ? <UnderlayViewer data={underlayContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : overlayContent != null
                ? <OverlayViewer data={overlayContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : gameTipContent != null
                ? <GameTipViewer data={gameTipContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onOpenTip={(id) => handleNavigateToItem('game_tips', id)} />
                : interfaceContent != null
                ? <InterfaceViewer data={interfaceContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : soundEffectContent != null
                ? <SoundEffectViewer data={soundEffectContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : midiInstrumentContent != null
                ? <MidiInstrumentViewer data={midiInstrumentContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : musicContent != null
                ? <MusicViewer data={musicContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : soundEffectMidiContent != null
                ? <SoundEffectMidiViewer data={soundEffectMidiContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : identikitContent != null
                ? <IdentikitViewer data={identikitContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : animationContent != null
                ? <AnimationViewer data={animationContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : animationFrameBaseContent != null
                ? <AnimationFrameBaseViewer data={animationFrameBaseContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : animationFrameSetContent != null
                ? <AnimationFrameSetViewer data={animationFrameSetContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : spotAnimationContent != null
                ? <SpotAnimationViewer data={spotAnimationContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
                : hitsplatContent != null
                ? <HitsplatViewer data={hitsplatContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : defaultsContent != null
                ? <DefaultsViewer data={defaultsContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} />
                : billboardContent != null
                ? <BillboardViewer data={billboardContent} onSave={(d) => handleSaveItem(d)} onDirtyChange={setIsContentDirty} onNavigate={(entryName, id) => handleNavigateToItem(entryName, id)} />
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
                : <pre className="content-json">{JSON.stringify(selectedItemContent, null, 2)}</pre>}
              </>
            ) : selectedItem ? (
              <p className="loading-text">Loading…</p>
            ) : null}
          </div>
          </div>
        </main>
      </div>
      {confirmDialogElement}
      {itemModelPreview && cacheHandle && (
        <ModelPreviewModal
          title={`Model ${itemModelPreview.modelId}${itemModelPreview.display ? ` — ${itemModelPreview.display.label}` : ''}`}
          modelIds={[itemModelPreview.modelId]}
          display={itemModelPreview.display}
          rootHandle={cacheHandle}
          openLabel="Open in Models"
          onOpen={handleOpenPreviewInModels}
          onClose={() => setItemModelPreview(null)}
        />
      )}
    </div>
  )
}

export default App
