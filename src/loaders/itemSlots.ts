import { getEntryPath, resolveEntryHandle } from './entryOrder'

// Which items may be equipped where, resolved lazily.
//
// An item def's `wearPos` IS the equipment slot index — verified against the
// dump 2026-07-29: wearPos 0 "Kyatt hat", 1 "Spotted cape", 2 "Brass
// necklace", 3 "Butterfly net", 4 "Kyatt top", 7 "Kyatt legs", 9 "Gloves of
// silence", 10 "Runner boots", 12 "Beacon ring" — darkan's `Equipment`
// numbering. `wearPos2`/`wearPos3` are the slots an item COVERS (the hat hides
// hair, the top hides arms), not extra places it can go, so only `wearPos`
// decides what fits.
//
// Building the full 25,358-item index up front took long enough to be
// noticeable, and almost none of it is ever needed. Instead: enumerate the ids
// once (directory listing, no file reads), then read one def at a time and
// cache it. Stepping walks that id list until it finds a fit, so the cost is
// proportional to how far you step rather than to the size of the cache.

const WEAR_POS_REGEX = /"wearPos"\s*:\s*(-?\d+)/
const WEAR_POS2_REGEX = /"wearPos2"\s*:\s*(-?\d+)/
const WEAR_POS3_REGEX = /"wearPos3"\s*:\s*(-?\d+)/
const NAME_REGEX = /"name"\s*:\s*"([^"]*)"/

/** How many ids a single step will probe before giving up, so a slot with no
 *  items can't walk the whole cache. */
const MAX_STEP_PROBES = 4000

export type ItemBrief = {
  wearPos: number
  name: string
  /** Slots this item COVERS — `wearPos2`/`wearPos3`. This is the client's
   *  `isEquipType(n)` test and the whole of its hide system: 904 items cover
   *  arms (6), 1040 cover hair (8), 545 cover beard (11) and 567 cover shield
   *  (5, the two-handers). */
  covers: number[]
}

type RootCache = {
  ids: Promise<number[]> | null
  briefs: Map<number, ItemBrief | null>
  pending: Map<number, Promise<ItemBrief | null>>
}

const roots = new WeakMap<FileSystemDirectoryHandle, RootCache>()

function cacheFor(rootHandle: FileSystemDirectoryHandle): RootCache {
  let entry = roots.get(rootHandle)
  if (!entry) {
    entry = { ids: null, briefs: new Map(), pending: new Map() }
    roots.set(rootHandle, entry)
  }
  return entry
}

async function itemsDir(rootHandle: FileSystemDirectoryHandle) {
  return resolveEntryHandle(rootHandle, getEntryPath('items'))
}

/** Every item id, ascending. Enumeration only — no file contents read. */
export function loadItemIds(rootHandle: FileSystemDirectoryHandle): Promise<number[]> {
  const entry = cacheFor(rootHandle)
  if (entry.ids) return entry.ids
  entry.ids = (async () => {
    try {
      const dir = await itemsDir(rootHandle)
      if (!dir) return []
      const ids: number[] = []
      for await (const handle of dir.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (!isNaN(id)) ids.push(id)
      }
      return ids.sort((a, b) => a - b)
    } catch {
      return []
    }
  })()
  return entry.ids
}

/** Cached answer if we already read this item, else undefined. */
export function peekItem(rootHandle: FileSystemDirectoryHandle, id: number): ItemBrief | null | undefined {
  return cacheFor(rootHandle).briefs.get(id)
}

/** One item's slot and name; null when it doesn't exist or isn't equipable. */
export function getItem(rootHandle: FileSystemDirectoryHandle, id: number): Promise<ItemBrief | null> {
  const entry = cacheFor(rootHandle)
  const cached = entry.briefs.get(id)
  if (cached !== undefined) return Promise.resolve(cached)
  const inFlight = entry.pending.get(id)
  if (inFlight) return inFlight

  const task = (async (): Promise<ItemBrief | null> => {
    try {
      if (id < 0) return null
      const dir = await itemsDir(rootHandle)
      if (!dir) return null
      const text = await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text()
      const pos = text.match(WEAR_POS_REGEX)
      if (!pos) return null
      const covers: number[] = []
      for (const rx of [WEAR_POS2_REGEX, WEAR_POS3_REGEX]) {
        const m = text.match(rx)
        if (m) {
          const v = parseInt(m[1], 10)
          if (v >= 0) covers.push(v)
        }
      }
      return { wearPos: parseInt(pos[1], 10), name: text.match(NAME_REGEX)?.[1] ?? '', covers }
    } catch {
      return null
    }
  })()
  entry.pending.set(id, task)
  task.then((brief) => {
    entry.briefs.set(id, brief)
    entry.pending.delete(id)
  })
  return task
}

/** Walk the id list from `from` in `direction` until an item fits `slot`.
 *  Wraps once so stepping never dead-ends; -1 when nothing fits within
 *  MAX_STEP_PROBES. */
export async function findSlotItem(
  rootHandle: FileSystemDirectoryHandle,
  slot: number,
  from: number,
  direction: 1 | -1,
): Promise<number> {
  const ids = await loadItemIds(rootHandle)
  if (ids.length === 0) return -1

  // Where `from` sits in the list — it need not be a real id (it can be -1, or
  // something typed by hand).
  let cursor = lowerBound(ids, from)
  if (direction === 1) {
    if (cursor < ids.length && ids[cursor] <= from) cursor++
  } else {
    cursor--
    if (cursor >= ids.length) cursor = ids.length - 1
  }

  for (let probes = 0; probes < Math.min(MAX_STEP_PROBES, ids.length); probes++) {
    if (cursor < 0) cursor = ids.length - 1
    if (cursor >= ids.length) cursor = 0
    const id = ids[cursor]
    const brief = await getItem(rootHandle, id)
    if (brief?.wearPos === slot) return id
    cursor += direction
  }
  return -1
}

/** First index whose value is >= target. */
function lowerBound(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
