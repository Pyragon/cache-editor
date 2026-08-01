// Shared machinery for the "read a large slice of the cache" scans.
//
// Several panels build a reverse index by walking tens of thousands of dumped
// files — billboard usage over ~74k models, animation compatibility over five
// entries, ground usage over every region, instrument usage over ~90k defs.
// They had each grown their own loop, and each had the same three problems:
//
//  1. **The listing phase was invisible.** Enumerating a directory of 74,000
//     entries takes real time, and reporting "0 / 0" (or nothing) throughout
//     reads as a hung button. Progress here has two phases for that reason:
//     `indexing` counts files found, with no denominator because none exists
//     yet, then `reading` counts files processed against the real total.
//
//  2. **Handles were thrown away and re-derived.** `dir.values()` already
//     yields the handle; calling `getFileHandle(name)` afterwards is a second
//     round-trip for every file. At this scale that is tens of thousands of
//     pointless calls.
//
//  3. **Progress was tied to item counts** (every 16, every 128), so its rate
//     depended on how fast the scan happened to run. It is time-based here:
//     ~10 updates a second regardless, which both looks continuous and keeps
//     React out of the hot loop.
export type ScanPhase = 'indexing' | 'reading'

export type ScanProgress = {
  phase: ScanPhase
  /** files found so far while indexing; files processed while reading */
  done: number
  /** 0 while indexing — the total isn't knowable until the walk finishes */
  total: number
}

export type ScanReporter = (p: ScanProgress) => void

/**
 * Reads in flight at once. The work is pure I/O, so a serial loop mostly waits.
 * Measured over 4,000 real defs and projected to ~90k: serial 16.4s, 8-wide
 * 4.3s, 32-wide 4.0s, 64-wide 3.9s — about 4x, flat past 8. 32 takes the last
 * couple of percent without piling on open handles.
 *
 * A rolling pool rather than fixed batches: with `Promise.all` over chunks, one
 * slow file holds up everything behind it until the chunk drains.
 */
export const SCAN_CONCURRENCY = 32

/** ~10 updates a second. Enough to look continuous, few enough that rendering
 *  costs nothing next to the scan. */
export const PROGRESS_INTERVAL_MS = 100

/** Wraps a reporter so it fires at most every PROGRESS_INTERVAL_MS, except when
 *  forced (phase changes and completion must always land). */
export function throttleProgress(onProgress?: ScanReporter) {
  let last = 0
  return (p: ScanProgress, force = false) => {
    if (!onProgress) return
    const now = performance.now()
    if (!force && now - last < PROGRESS_INTERVAL_MS) return
    last = now
    onProgress(p)
  }
}

/**
 * Walk directories and keep the handles, reporting an `indexing` count.
 *
 * `accept` decides what counts and is given the handle, so a caller can filter
 * on kind and name without a second pass.
 */
export async function indexEntries<T>(
  dirs: (FileSystemDirectoryHandle | null | undefined)[],
  accept: (handle: FileSystemHandle, dirIndex: number) => T | null,
  emit: (p: ScanProgress, force?: boolean) => void,
): Promise<T[]> {
  const found: T[] = []
  emit({ phase: 'indexing', done: 0, total: 0 }, true)
  // one call across every directory, so the count is cumulative — walking them
  // separately would restart it at zero each time
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    if (!dir) continue
    for await (const handle of dir.values()) {
      const item = accept(handle, i)
      if (item == null) continue
      found.push(item)
      emit({ phase: 'indexing', done: found.length, total: 0 })
    }
  }
  return found
}

/**
 * Run `read` over every item with a bounded rolling pool, reporting `reading`
 * progress. A throwing `read` is swallowed per item — one unreadable file must
 * not abandon a scan of ninety thousand. An aborted `signal` does stop it,
 * since that is the user leaving.
 *
 * `concurrency` is worth overriding for big files: the default suits small defs,
 * while region dumps are large enough that fewer in flight reads better.
 */
export async function readPooled<T>(
  items: T[],
  read: (item: T) => Promise<void>,
  emit: (p: ScanProgress, force?: boolean) => void,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const { concurrency = SCAN_CONCURRENCY, signal } = opts
  const total = items.length
  let done = 0
  emit({ phase: 'reading', done: 0, total }, true)

  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
      const i = next++
      if (i >= total) return
      try {
        await read(items[i])
      } catch {
        // skip this one, keep scanning
      }
      done++
      emit({ phase: 'reading', done, total })
    }
  }))

  emit({ phase: 'reading', done, total }, true)
}

/** Progress text every scanning UI can share, so they read the same way. */
export function scanLabel(p: ScanProgress | null, noun = 'files'): string | null {
  if (!p) return null
  if (p.phase === 'indexing') return `Indexing ${p.done.toLocaleString()} ${noun}…`
  return `Searched ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
}
