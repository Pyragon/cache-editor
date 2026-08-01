// "Where is this ground material actually used?" — a world-wide index of which
// regions reference each underlay / overlay definition, and how many tiles.
//
// There is no index for this in the cache: the only way to know is to read
// every region's per-tile channels. That is ~2,400 files, so the scan is
// explicitly user-triggered, reports progress, and its result is cached in
// IndexedDB until the user asks for a rescan.
//
// Two things keep it affordable:
//  - only the `underlayIds` / `overlayIds` channels are needed, and cryogen
//    writes them near the top of each JSON (Gson emits fields in declaration
//    order), so the scan reads the first slice of each file rather than all of
//    it — a region JSON is ~340 KB, the two channels are ~44 KB.
//  - counting runs straight off the atob'd binary string, so no per-region
//    typed arrays are allocated.
import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { indexEntries, readPooled, throttleProgress } from './scan'
import type { ScanReporter } from './scan'

/** One region's use of a definition. */
export type UsageRegion = { region: number; rx: number; ry: number; tiles: number }

/** Totals are over the WHOLE world; `top` is capped (see TOP_REGIONS) so the
 *  cached index stays small. The UI shows the cap explicitly rather than
 *  implying `top` is everything. */
export type UsageEntry = { totalTiles: number; regionCount: number; top: UsageRegion[] }

export type GroundUsage = {
  scannedAt: number
  /** How many region files the scan actually read. */
  regions: number
  /** Regions that could not be read or had no readable channels. */
  skipped: number
  underlay: Record<number, UsageEntry>
  overlay: Record<number, UsageEntry>
}

/** Per definition, how many regions to remember by name. */
export const TOP_REGIONS = 250

/** How much of each region JSON to read before falling back to the whole file. */
const HEAD_BYTES = 96 * 1024

const DB_NAME = 'cache-editor-ground-usage'
const STORE = 'usage'
// Bump when the scan's output could differ for the same cache, so a stale index
// is dropped rather than silently trusted. v1 indexes are wrong: they were built
// before the JSON-escaping fix in `channel()` and are missing ~all regions.
const KEY = 'v2'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function loadCachedUsage(): Promise<GroundUsage | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<GroundUsage | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as GroundUsage) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

async function storeUsage(usage: GroundUsage): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(usage, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* a full or blocked IndexedDB just means "scan again next time" */
  } finally {
    db.close()
  }
}

export async function clearCachedUsage(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}

/**
 * Pull one base64 channel out of raw JSON text without parsing it.
 *
 * The token has to be un-escaped, because the dump is NOT consistently escaped:
 * some regions were written with Gson's HTML escaping on, which emits base64
 * padding `=` as `=` (region 10023 is escaped, 12850 is not). The raw token
 * then ends `...AAAA==`, and the browser's `atob` rejects it outright
 * — which silently dropped the whole region and made nearly every material look
 * unused. Node's `Buffer.from(s, 'base64')` ignores invalid characters instead
 * of throwing, so a Node-side check does NOT reproduce this.
 */
function channel(text: string, key: string): string | null {
  const at = text.indexOf(`"${key}":"`)
  if (at === -1) return null
  const from = at + key.length + 4
  // Base64 never contains a quote or a backslash-escaped quote, so the next
  // quote is always the true end of the value.
  const end = text.indexOf('"', from)
  if (end === -1) return null
  const token = text.slice(from, end)
  if (!token.includes('\\')) return token
  try {
    // Exactly what a JSON parse of this string would produce.
    return JSON.parse(`"${token}"`) as string
  } catch {
    return null
  }
}

/** Tally per-tile ids straight off the decoded binary string. Ids are stored
 *  as "definition id + 1", so byte 0 means "no material on this tile".
 *  Returns false if the channel could not be decoded, so the caller can report
 *  it rather than quietly reporting "unused". */
function tally(b64: string, into: Map<number, number>): boolean {
  if (b64 === '') return true
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    return false
  }
  for (let i = 0; i < bin.length; i++) {
    const v = bin.charCodeAt(i)
    if (v !== 0) into.set(v - 1, (into.get(v - 1) ?? 0) + 1)
  }
  return true
}

type Accum = Map<number, { totalTiles: number; regionCount: number; top: UsageRegion[] }>

function record(accum: Accum, id: number, region: UsageRegion): void {
  let e = accum.get(id)
  if (!e) {
    e = { totalTiles: 0, regionCount: 0, top: [] }
    accum.set(id, e)
  }
  e.totalTiles += region.tiles
  e.regionCount++
  e.top.push(region)
}

function finish(accum: Accum): Record<number, UsageEntry> {
  const out: Record<number, UsageEntry> = {}
  for (const [id, e] of accum) {
    e.top.sort((a, b) => b.tiles - a.tiles || a.region - b.region)
    out[id] = { totalTiles: e.totalTiles, regionCount: e.regionCount, top: e.top.slice(0, TOP_REGIONS) }
  }
  return out
}

export type { ScanProgress } from './scan'

/**
 * Reads every region dump and builds the usage index. `onProgress` fires as
 * files complete so the caller can show a bar; `signal` aborts a scan the user
 * navigated away from.
 */
export async function scanGroundUsage(
  rootHandle: FileSystemDirectoryHandle,
  onProgress?: ScanReporter,
  signal?: AbortSignal,
): Promise<GroundUsage> {
  const mapsDir = await resolveEntryHandle(rootHandle, getEntryPath('maps'))
  if (!mapsDir) throw new Error('This cache has no maps/ dump, so usage cannot be scanned.')

  const emit = throttleProgress(onProgress)
  const files = await indexEntries(
    [mapsDir],
    (handle) => (handle.kind === 'file' && handle.name.endsWith('.json') ? handle as FileSystemFileHandle : null),
    emit,
  )
  files.sort((a, b) => a.name.localeCompare(b.name))

  const underlay: Accum = new Map()
  const overlay: Accum = new Map()
  let skipped = 0

  async function scanOne(handle: FileSystemFileHandle): Promise<void> {
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (isNaN(id)) { skipped++; return }
    try {
      const file = await handle.getFile()
      // Head slice first; only re-read in full if the layout surprises us.
      let text = await file.slice(0, HEAD_BYTES).text()
      let u = channel(text, 'underlayIds')
      let o = channel(text, 'overlayIds')
      if (u === null || o === null) {
        text = await file.text()
        u = channel(text, 'underlayIds')
        o = channel(text, 'overlayIds')
      }
      if (u === null && o === null) { skipped++; return }

      const rx = (id >> 8) & 0xff
      const ry = id & 0xff
      const uCounts = new Map<number, number>()
      const oCounts = new Map<number, number>()
      // A channel that won't decode must be reported, not treated as "this
      // region uses nothing" — that reads identically to a genuinely empty
      // region and is how the escaping bug above hid for a whole build.
      const ok = (u === null || tally(u, uCounts)) && (o === null || tally(o, oCounts))
      if (!ok) { skipped++; return }
      for (const [defId, tiles] of uCounts) record(underlay, defId, { region: id, rx, ry, tiles })
      for (const [defId, tiles] of oCounts) record(overlay, defId, { region: id, rx, ry, tiles })
    } catch {
      skipped++
    }
  }

  // Eight in flight, not the shared default of 32: region dumps are far larger
  // than the def files that default was tuned on, and queuing 2,400 of them
  // makes the browser thrash rather than go faster.
  await readPooled(files, scanOne, emit, { concurrency: 8, signal })

  const usage: GroundUsage = {
    scannedAt: Date.now(),
    regions: files.length - skipped,
    skipped,
    underlay: finish(underlay),
    overlay: finish(overlay),
  }
  await storeUsage(usage)
  return usage
}
