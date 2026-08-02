// Leak instrumentation.
//
// The spot-animation page OOM'd Opera twice with no single obvious cause, and
// the reason it's hard to see is that the two resources most likely to be
// responsible — WebGL contexts and ImageBitmaps — both hold memory OUTSIDE the
// JS heap. They don't show up in a heap snapshot and they barely move
// `usedJSHeapSize`, so a tab can be sitting on gigabytes of them while the heap
// graph looks flat. Counting them by hand is the only way to see them.
//
// `window.__mem()` dumps a snapshot on demand. Nothing here samples or logs on
// a timer any more — see the note at the bottom.

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
// `window.__mem()` stays as an on-demand snapshot — it costs nothing until
// it's called. The crash-surviving trail that used to sit here (a 10s
// localStorage sample loop, its page-load marker, and the heap-climbing
// console warning) is gone: it was written to chase two specific OOMs, those
// are fixed, and a background timer writing to disk every 10 seconds is not
// something to leave running for months. Bring it back from git history if a
// leak turns up again — the counters and releaseBitmap() below it, which do
// real work, never went anywhere.
if (typeof window !== 'undefined') {
  const w = window as unknown as { __mem: () => Record<string, number | null> }
  w.__mem = () => {
    const snap = memSnapshot()
    console.table(snap)
    return snap
  }
}
