import { useEffect, useMemo, useRef, useState } from 'react'
import './SpriteBrowser.css'
import './MapSymbolPicker.css'

/** One pickable record: a `config/map_sprites` entry or a `config/areas` one. */
export type SymbolEntry = {
  id: number
  name?: string
  /** object URL of the resolved PNG, or null when there's nothing to draw */
  url: string | null
  /** why there's no image, when there isn't one */
  note?: string
}

export type SymbolKind = 'mapsprite' | 'mapicon' | 'cursor'

const TABLE: Record<SymbolKind, { dir: string; label: string; plural: string }> = {
  mapsprite: { dir: 'map_sprites', label: 'Map sprite', plural: 'Map sprites' },
  mapicon: { dir: 'areas', label: 'Map icon', plural: 'Map icons' },
  cursor: { dir: 'cursors', label: 'Cursor', plural: 'Cursors' },
}

/** Scan phase — listing the folder is its own wait on `areas` (73913 entries),
 *  so it reports separately instead of sitting on a bare "loading…".
 *  `startedAt` is stamped when the read phase begins, so the picker can turn
 *  the rate into a time remaining. */
type ScanProgress = { phase: 'listing' | 'reading'; done: number; total: number; startedAt: number }

/** An in-flight or finished scan, shared by every picker that wants it.
 *
 *  Progress deliberately lives HERE rather than in the effect that started the
 *  scan. Only the first mount creates it; later mounts reuse the promise, so a
 *  callback owned by the first effect leaves everyone else with no updates at
 *  all — which under StrictMode's mount/cleanup/mount is *every* render, since
 *  the creating effect is cleaned up immediately. Publishing to a listener set
 *  means whoever is on screen gets the counter, and `latest` lets a picker
 *  reopened mid-scan catch up instead of restarting at nothing. */
type ScanState = {
  promise: Promise<SymbolEntry[]>
  latest: ScanProgress | null
  listeners: Set<(p: ScanProgress) => void>
}

/** Scanned lists, kept for the session and keyed by the cache root.
 *
 *  Worth caching hard: `config/areas` is 73913 files in this dump — of which
 *  only 643 have an icon and 635 a name, the rest being empty placeholders —
 *  so the scan is slow but its result is small. The object URLs it produces
 *  live as long as the entry does (≈132 distinct icon sprites plus 106 map
 *  sprites), which is why nothing revokes them. */
const SCANS = new WeakMap<FileSystemDirectoryHandle, Partial<Record<SymbolKind, ScanState>>>()

async function spriteUrl(root: FileSystemDirectoryHandle, archive: number, cache: Map<number, string | null>): Promise<string | null> {
  if (cache.has(archive)) return cache.get(archive)!
  let url: string | null = null
  try {
    const dir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(archive))
    const png = await (await dir.getFileHandle(`${archive}_0.png`)).getFile()
    url = URL.createObjectURL(png)
  } catch { /* sprite not dumped */ }
  cache.set(archive, url)
  return url
}

async function scan(
  root: FileSystemDirectoryHandle,
  kind: SymbolKind,
  onProgress: (p: ScanProgress) => void,
): Promise<SymbolEntry[]> {
  const cfg = await root.getDirectoryHandle('config')
  const dir = await cfg.getDirectoryHandle(TABLE[kind].dir)
  const listStart = Date.now()
  const ids: number[] = []
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (!isNaN(id)) ids.push(id)
    // no total to divide by yet — the count IS the progress here
    if ((ids.length & 0x3ff) === 0) onProgress({ phase: 'listing', done: ids.length, total: 0, startedAt: listStart })
  }
  ids.sort((a, b) => a - b)

  const urls = new Map<number, string | null>()
  const out: SymbolEntry[] = []
  const readStart = Date.now()
  const CHUNK = 250
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await Promise.all(ids.slice(i, i + CHUNK).map(async (id): Promise<SymbolEntry | null> => {
      try {
        const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
        const def = JSON.parse(await file.text()) as {
          spriteId?: number
          defaultIconArchive?: number
          areaName?: string
          hotspotPointX?: number
          hotspotPointY?: number
        }
        if (kind === 'cursor') {
          const archive = def.spriteId ?? -1
          const url = archive >= 0 ? await spriteUrl(root, archive, urls) : null
          return {
            id,
            name: def.hotspotPointX || def.hotspotPointY ? `hotspot ${def.hotspotPointX ?? 0},${def.hotspotPointY ?? 0}` : undefined,
            url,
            note: archive < 0 ? 'no sprite' : url ? undefined : `sprite ${archive} not dumped`,
          }
        }
        if (kind === 'mapsprite') {
          // -1 here is the record's own "blank" (opcode 4), not a missing dump
          const archive = def.spriteId ?? -1
          if (archive < 0) return { id, url: null, note: 'no sprite' }
          const url = await spriteUrl(root, archive, urls)
          return { id, url, note: url ? undefined : `sprite ${archive} not dumped` }
        }
        const archive = def.defaultIconArchive ?? -1
        // areas is mostly empty placeholder records — only the ones with an
        // icon or a name are worth offering
        if (archive < 0 && !def.areaName) return null
        const url = archive >= 0 ? await spriteUrl(root, archive, urls) : null
        return {
          id,
          name: def.areaName,
          url,
          note: archive < 0 ? 'no icon' : url ? undefined : `icon ${archive} not dumped`,
        }
      } catch {
        return null
      }
    }))
    for (const r of rows) if (r) out.push(r)
    onProgress({ phase: 'reading', done: Math.min(i + CHUNK, ids.length), total: ids.length, startedAt: readStart })
  }
  return out
}

/** Modal thumbnail picker for the two map symbol tables, so a sprite or icon
 *  can be chosen by looking at it instead of by typing an id. */
export default function MapSymbolPicker({ root, kind, selectedId, onPick, onCancel }: {
  root: FileSystemDirectoryHandle
  kind: SymbolKind
  selectedId: number
  onPick: (id: number) => void
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [entries, setEntries] = useState<SymbolEntry[] | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => { dialogRef.current?.showModal() }, [])

  useEffect(() => {
    let cancelled = false
    let byKind = SCANS.get(root)
    if (!byKind) SCANS.set(root, byKind = {})
    let state = byKind[kind]
    if (!state) {
      const created: ScanState = { promise: null!, latest: null, listeners: new Set() }
      // publish to the shared state, never to this effect's closure — see
      // ScanState for why the creating effect must not own the callback
      created.promise = scan(root, kind, (p) => {
        created.latest = p
        for (const listener of created.listeners) listener(p)
      })
      byKind[kind] = state = created
    }
    const active = state
    active.listeners.add(setProgress)
    if (active.latest) setProgress(active.latest) // joined mid-scan: catch up now
    void active.promise.then((rows) => { if (!cancelled) { setEntries(rows); setProgress(null) } })
      .catch(() => { if (!cancelled) setEntries([]) })
    return () => {
      cancelled = true
      active.listeners.delete(setProgress)
    }
  }, [root, kind])

  const rows = useMemo(() => {
    if (!entries) return []
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => String(e.id).includes(q) || (e.name?.toLowerCase().includes(q) ?? false))
  }, [entries, filter])

  const { label, plural } = TABLE[kind]
  const pct = progress && progress.phase === 'reading' && progress.total > 0
    ? Math.floor((progress.done / progress.total) * 100)
    : null

  /** Time left at the rate so far. Only meaningful once enough of the read has
   *  happened for the rate to settle, so the first chunk doesn't quote a wild
   *  number off one sample. */
  const eta = useMemo(() => {
    if (!progress || progress.phase !== 'reading' || progress.total <= 0) return null
    const elapsed = Date.now() - progress.startedAt
    if (progress.done < 500 || elapsed < 1000) return null
    const remaining = ((progress.total - progress.done) / progress.done) * elapsed
    const secs = Math.ceil(remaining / 1000)
    if (secs < 60) return `~${secs}s left`
    return `~${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s left`
  }, [progress])

  return (
    <dialog ref={dialogRef} className="sprite-browser-dialog" onCancel={onCancel} onClose={onCancel}>
      <div className="sprite-browser-body">
        <span className="enum-title">{plural}</span>
        <input
          className="mapscene-loclist-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={kind === 'mapicon' ? 'filter by id or area name' : 'filter by id'}
          autoFocus
        />
        <span className="sprite-browser-status">
          {entries === null
            ? progress?.phase === 'listing'
              ? `Listing ${TABLE[kind].dir}… ${progress.done.toLocaleString()} files found`
              : pct !== null
                ? `Loaded ${progress!.done.toLocaleString()} / ${progress!.total.toLocaleString()} (${pct}%)${eta ? ` · ${eta}` : ''}`
                : 'opening…'
            : `${rows.length}${filter ? ` of ${entries.length}` : ''} record${rows.length === 1 ? '' : 's'}`}
          {kind === 'mapicon' && entries !== null && ' · only records with an icon or a name are listed'}
        </span>
        {entries === null && (
          <div className="symbol-scan-bar">
            {/* the listing pass has no denominator, so it animates instead */}
            <div
              className={`symbol-scan-fill${pct === null ? ' is-indeterminate' : ''}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
        )}
        <div className="sprite-browser-grid">
          <button
            type="button"
            className={`symbol-pick${selectedId < 0 ? ' active' : ''}`}
            onClick={() => onPick(-1)}
            title="Clear this field"
          >
            <span className="symbol-pick-empty">none</span>
            <span className="symbol-pick-id">-1</span>
          </button>
          {rows.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`symbol-pick${e.id === selectedId ? ' active' : ''}`}
              onClick={() => onPick(e.id)}
              title={`${label} ${e.id}${e.name ? ` — ${e.name}` : ''}${e.note ? ` · ${e.note}` : ''}`}
            >
              {e.url
                ? <img className="symbol-pick-img" src={e.url} alt="" />
                : <span className="symbol-pick-empty">{e.note ?? 'none'}</span>}
              <span className="symbol-pick-id">{e.id}</span>
              {e.name && <span className="symbol-pick-name">{e.name}</span>}
            </button>
          ))}
        </div>
        <div className="sprite-browser-actions">
          <button type="button" className="save-bar-discard" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </dialog>
  )
}
