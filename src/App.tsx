import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getLoader } from './loaders'
import type { LoadedItem, QuestServerData } from './loaders'
import HuffmanViewer from './components/HuffmanViewer'
import type { HuffmanData } from './components/HuffmanViewer'
import QuestViewer from './components/QuestViewer'
import type { QuestData } from './components/QuestViewer'
import SpriteViewer from './components/SpriteViewer'
import type { SpriteData } from './loaders/sprites'
import ModelViewer from './components/ModelViewer'
import type { ModelData } from './loaders/models'
import NativeLibrariesViewer from './components/NativeLibrariesViewer'
import type { NativeLibrariesData } from './loaders/native_libraries'

type QuestContent = { quest: QuestData; server: QuestServerData | null }
import './App.css'

type CacheEntry = { id: number; name: string }

async function readCacheDir(dirHandle: FileSystemDirectoryHandle): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = []
  let entryId = 1
  for await (const handle of dirHandle.values()) {
    if (handle.kind !== 'directory') continue
    entries.push({ id: entryId++, name: handle.name })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
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

  const loadVersion = useRef(0)
  const itemListRef = useRef<HTMLUListElement>(null)

  const selectedEntry = entries.find((e) => e.id === selectedEntryId) ?? null
  const selectedItem = activeItems.find((i) => i.id === selectedItemId) ?? null
  const currentLoader = selectedEntry ? getLoader(selectedEntry.name) : null
  const noPanel = currentLoader?.noPanel ?? false

  const questContent = selectedEntry?.name === 'quests' && selectedItemContent != null
    ? selectedItemContent as QuestContent
    : null

  const spriteContent = selectedEntry?.name === 'sprites' && selectedItemContent != null
    ? selectedItemContent as SpriteData
    : null

  const modelContent = selectedEntry?.name === 'models' && selectedItemContent != null
    ? selectedItemContent as ModelData
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

  useEffect(() => {
    if (/^\d+$/.test(filter)) {
      const num = parseInt(filter, 10)
      const idx = filteredItems.findIndex((item) => item.id === num)
      if (idx !== -1) {
        setSelectedItemId(filteredItems[idx].id)
        virtualizer.scrollToIndex(idx, { align: 'center' })
      }
    }
  }, [filter, filteredItems, virtualizer])

  useEffect(() => {
    if (!selectedItem || !cacheHandle || !selectedEntry) {
      setSelectedItemContent(null)
      return
    }
    const loader = getLoader(selectedEntry.name)
    if (!loader) return
    let cancelled = false
    async function load() {
      const entryHandle = await cacheHandle!.getDirectoryHandle(selectedEntry!.name)
      const content = await loader!.loadItem(entryHandle, selectedItem!, cacheHandle!)
      if (!cancelled) setSelectedItemContent(content)
    }
    load()
    return () => { cancelled = true }
  }, [selectedItemId, selectedEntry?.name, cacheHandle])

  async function handleSaveItem(data: unknown) {
    if (!cacheHandle || !selectedEntry || !selectedItem) return
    const loader = getLoader(selectedEntry.name)
    if (!loader?.saveItem) return
    const entryHandle = await cacheHandle.getDirectoryHandle(selectedEntry.name)
    await loader.saveItem(entryHandle, selectedItem, data)
    if (selectedEntry.name === 'quests') {
      setSelectedItemContent(data as QuestContent)
    } else {
      setSelectedItemContent(data)
    }
  }

  async function loadEntryItems(handle: FileSystemDirectoryHandle, entry: CacheEntry, version: number) {
    const loader = getLoader(entry.name)
    if (!loader) {
      setIsLoading(false)
      return
    }

    const entryHandle = await handle.getDirectoryHandle(entry.name)

    if (loader.noPanel) {
      const content = await loader.loadItem(entryHandle, { id: 0, name: entry.name }, handle)
      if (loadVersion.current !== version) return
      setActiveContent(content)
      setIsLoading(false)
      return
    }

    const buffer: LoadedItem[] = []

    for await (const item of loader.streamItems(entryHandle)) {
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
    if (!entry) return

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

      const first = loaded[0]
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
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={entry.id === selectedEntryId ? 'active' : ''}
                  onClick={() => handleSelectEntry(entry.id)}
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div id="right-section">
        {selectedEntry && !noPanel && (
          <aside id="item-list-panel">
            <div className="panel-header">
              <h2>{selectedEntry.name}</h2>
              <div className="panel-actions">
                <button type="button" className="panel-action-btn">Add</button>
                <button type="button" className="panel-action-btn">Remove</button>
                <button type="button" className="panel-action-btn">Clone</button>
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
                        onClick={() => setSelectedItemId(item.id)}
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
            {isLoading ? (
              <p className="loading-text">
                {loadCount > 0
                  ? `Loading… ${loadCount.toLocaleString()} items found so far`
                  : 'Loading…'}
              </p>
            ) : activeContent != null ? (
              selectedEntry?.name === 'huffman'
                ? <HuffmanViewer data={activeContent as HuffmanData} />
                : selectedEntry?.name === 'native_libraries'
                ? <NativeLibrariesViewer data={activeContent as NativeLibrariesData} />
                : <pre className="content-json">{JSON.stringify(activeContent, null, 2)}</pre>
            ) : selectedItemContent != null ? (
              questContent != null
                ? <QuestViewer data={questContent.quest} serverData={questContent.server ?? undefined} onSave={(quest, server) => handleSaveItem({ quest, server })} />
                : spriteContent != null
                ? <SpriteViewer data={spriteContent} onSave={(d) => handleSaveItem(d)} />
                : modelContent != null
                ? <ModelViewer data={modelContent} />
                : <pre className="content-json">{JSON.stringify(selectedItemContent, null, 2)}</pre>
            ) : selectedItem ? (
              <p className="loading-text">Loading…</p>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
