// Leak instrumentation.
//
// The spot-animation page OOM'd Opera twice with no single obvious cause, and
// the reason it's hard to see is that the two resources most likely to be
// responsible — WebGL contexts and ImageBitmaps — both hold memory OUTSIDE the
// JS heap. They don't show up in a heap snapshot and they barely move
// `usedJSHeapSize`, so a tab can be sitting on gigabytes of them while the heap
// graph looks flat. Counting them by hand is the only way to see them.
//
// `window.__mem()` dumps a snapshot on demand. Past MEM_WARN_MB the module also
// logs one automatically every MEM_STEP_MB climbed, so a session that's growing
// leaves a trail in the console without anyone having to sit and watch it.

const counters: Record<string, number> = {}

/** Increment (or decrement, with a negative delta) a live-resource counter. */
export function memCount(key: string, delta = 1): void {
  counters[key] = (counters[key] ?? 0) + delta
}

/** Report an absolute value, for things that are already a collection size. */
export function memSet(key: string, value: number): void {
  counters[key] = value
}

type HeapInfo = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }

function heap(): HeapInfo | null {
  return (performance as Performance & { memory?: HeapInfo }).memory ?? null
}

export function memSnapshot(): Record<string, number | null> {
  const m = heap()
  return {
    heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null,
    heapLimitMB: m ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
    ...counters,
  }
}

/**
 * Record a newly decoded bitmap. Counting them isn't enough: one 2048² texture
 * is 16 MB and a hundred 64² ones are 1.6 MB, so a flat count can hide (or
 * fake) a problem. `imageBitmapMB` is the number that actually matters, since
 * bitmap pixels live in external renderer memory and never show up in
 * `usedJSHeapSize`.
 */
export function trackBitmap(bitmap: ImageBitmap): void {
  memCount('imageBitmaps')
  counters.imageBitmapMB = round1((counters.imageBitmapMB ?? 0) + bitmapMB(bitmap))
}

function bitmapMB(bitmap: ImageBitmap): number {
  return (bitmap.width * bitmap.height * 4) / 1048576
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Close an ImageBitmap and keep the live count honest. Safe on null/undefined
 *  and on anything that isn't a bitmap, so call sites don't need to check.
 *  three's `texture.dispose()` frees the GPU copy but NEVER closes the bitmap
 *  it was uploaded from — that has to happen here. */
export function releaseBitmap(image: unknown): void {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    // read the size BEFORE close(), which zeroes the dimensions
    const mb = bitmapMB(image)
    image.close()
    memCount('imageBitmaps', -1)
    counters.imageBitmapMB = round1(Math.max(0, (counters.imageBitmapMB ?? 0) - mb))
  }
}

const MEM_WARN_MB = 900
const MEM_STEP_MB = 250
let nextWarnMB = MEM_WARN_MB

// --- Crash-surviving trail ---------------------------------------------------
//
// An OOM kills the renderer process outright, so `__mem()` is gone exactly when
// you most want to read it — there's no "after" to run it in, and the console
// context goes with the page. The trail therefore has to live somewhere the
// BROWSER process owns, which means localStorage: it's written synchronously
// and is already on disk by the time the renderer dies, so whatever landed
// before the crash is still there on the next load.
//
// After a crash: reload and run `__memLog()`.

const LOG_KEY = 'cacheEditor.memLog'
// 10s, not 30: the first captured crash happened within 37s of the last sample,
// so a third of the run that mattered was invisible.
const LOG_INTERVAL_MS = 10_000
/** ~1 hour at one entry per 10s. Bounded, since an unbounded growth log during
 *  a memory investigation would be its own joke. */
const LOG_CAP = 360

type LogEntry = Record<string, number | string | null>

function readLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLog(entries: LogEntry[]): void {
  // On QuotaExceededError, keep halving from the END until something fits. A
  // single retry isn't enough: if the halved slice is still over quota that
  // write fails too, leaving the PREVIOUS value in place — so the trail would
  // silently freeze at stale data and read like the tab stopped growing, which
  // is precisely the wrong conclusion. The newest samples matter most, so they
  // are the ones kept.
  let keep = entries.length
  while (keep > 0) {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-keep)))
      return
    } catch {
      keep = Math.floor(keep / 2)
    }
  }
  // Nothing fits, or storage is unavailable (private mode). Drop the stale
  // value rather than leave a misleading one behind.
  try { localStorage.removeItem(LOG_KEY) } catch { /* nothing more to try */ }
}

/** Free-text marker written alongside each sample, so the trail says WHERE the
 *  memory went, not just that it went. Set from the UI as the view changes. */
let currentLabel = ''
export function memLabel(label: string): void {
  currentLabel = label
}

/** Peak heap seen between persists — the 5s warning tick feeds this, so a spike
 *  that lands between two 30s samples still shows up rather than vanishing. */
let peakMB = 0

if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __mem: () => Record<string, number | null>
    __memLog: () => LogEntry[]
    __memClear: () => void
  }

  w.__mem = () => {
    const snap = memSnapshot()
    console.table(snap)
    return snap
  }

  w.__memLog = () => {
    const entries = readLog()
    if (entries.length === 0) {
      console.info('[memory] no trail recorded yet.')
      return entries
    }
    // console.table is nice to click through but its object preview truncates
    // after a few properties, so pasting it elsewhere silently drops the very
    // columns worth reading. Print a plain-text table too — that copies whole.
    const columns: string[] = []
    for (const e of entries) for (const k of Object.keys(e)) if (!columns.includes(k)) columns.push(k)
    const width = (c: string) => Math.max(c.length, ...entries.map((e) => String(e[c] ?? '').length))
    const widths = Object.fromEntries(columns.map((c) => [c, width(c)]))
    const row = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[columns[i]])).join('  ')
    const text = [
      row(columns),
      row(columns.map((c) => '-'.repeat(widths[c]))),
      ...entries.map((e) => row(columns.map((c) => String(e[c] ?? '')))),
    ].join('\n')
    console.log(text)
    console.table(entries)
    return entries
  }

  w.__memClear = () => {
    try { localStorage.removeItem(LOG_KEY) } catch { /* nothing to clear */ }
    console.info('[memory] trail cleared.')
  }

  // A load marker separates runs, so after a crash the entries immediately
  // BEFORE the newest marker are the last thing the dead tab recorded.
  const previous = readLog()
  if (previous.length > 0) {
    const lastHeap = previous[previous.length - 1]?.heapMB
    console.info(
      `[memory] ${previous.length} sample(s) recorded before this load`
      + (typeof lastHeap === 'number' ? ` (last heap ${lastHeap} MB)` : '')
      + ' — run __memLog() to see them, __memClear() to reset.',
    )
  }
  writeLog([...previous, { t: new Date().toISOString(), event: 'page load' }].slice(-LOG_CAP))

  setInterval(() => {
    const snap = memSnapshot()
    const entry: LogEntry = { t: new Date().toISOString(), ...snap }
    if (peakMB > 0) entry.peakHeapMB = Math.round(peakMB)
    if (currentLabel) entry.at = currentLabel
    writeLog([...readLog(), entry].slice(-LOG_CAP))
    peakMB = 0
  }, LOG_INTERVAL_MS)

  if (heap()) {
    setInterval(() => {
      const m = heap()!
      const usedMB = m.usedJSHeapSize / 1048576
      if (usedMB > peakMB) peakMB = usedMB
      if (usedMB >= nextWarnMB) {
        // Round up to the next step so a plateau doesn't re-log every tick.
        nextWarnMB = Math.ceil((usedMB + 1) / MEM_STEP_MB) * MEM_STEP_MB
        console.warn('[memory] heap climbing —', memSnapshot())
      }
    }, 5000)
  }
}
