import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { indexEntries, readPooled, throttleProgress } from './scan'
import type { ScanReporter } from './scan'
import type { VarbitDef } from './varbits'

// ---------------------------------------------------------------------------
// Which bits of which varp are already spoken for.
//
// A varp is one 32-bit int and a varbit is a slice of it, so the only way to
// add a varbit safely is to know what already claims those bits — nothing in
// the cache records the reverse mapping, and two varbits overlapping the same
// bits corrupt each other silently. One pass over every varbit (~12k files)
// builds it, then it is served from this module-level cache.
//
// It also counts the varps, because that count is load-bearing: the client
// sizes its value array as `IntArray(TypeLists.VAR.size)` where size is the
// FILE COUNT of the vars config archive (darkan VarpTypeList). A varbit whose
// baseVar is >= that count indexes past the end of the array.
// ---------------------------------------------------------------------------

/** One varbit's claim on a varp's bits. */
export type VarbitUse = { id: number; startBit: number; endBit: number }

export type VarbitIndex = {
  /** varp id -> the varbits packed into it, ascending by startBit. */
  byBaseVar: Map<number, VarbitUse[]>
  varbitCount: number
  /** Highest varbit id present, so the next free one is this + 1. */
  maxVarbitId: number
  /** Number of varp FILES — this is what bounds the client's value array. */
  varpCount: number
  maxVarpId: number
  /** Missing varp ids below the highest. A gap makes varpCount smaller than
   *  maxVarpId + 1, so the top varps fall off the end of the value array. */
  varpGaps: number[]
}

let cached: VarbitIndex | null = null
let building: Promise<VarbitIndex> | null = null

export function peekVarbitIndex(): VarbitIndex | null {
  return cached
}

/** Drop the session cache — after saving or creating a varbit or varp. */
export function invalidateVarbitIndex(): void {
  cached = null
  building = null
}

type JsonFile = { id: number; handle: FileSystemFileHandle }

function jsonFile(handle: FileSystemHandle): JsonFile | null {
  if (handle.kind !== 'file' || !handle.name.endsWith('.json')) return null
  const id = parseInt(handle.name.slice(0, -5), 10)
  return isNaN(id) ? null : { id, handle: handle as FileSystemFileHandle }
}

export function buildVarbitIndex(
  cacheRoot: FileSystemDirectoryHandle,
  onProgress: ScanReporter,
): Promise<VarbitIndex> {
  if (cached) return Promise.resolve(cached)
  if (building) return building
  building = (async () => {
    const varbitsDir = await resolveEntryHandle(cacheRoot, getEntryPath('varbits'))
    const varsDir = await resolveEntryHandle(cacheRoot, getEntryPath('config_vars'))
    if (!varbitsDir) throw new Error('varbits entry not found in this cache')

    const emit = throttleProgress(onProgress)
    const varbitFiles = await indexEntries([varbitsDir], jsonFile, emit)
    // Varps only need COUNTING, not reading — the directory walk is the whole job.
    const varpFiles = await indexEntries([varsDir], jsonFile, emit)

    const byBaseVar = new Map<number, VarbitUse[]>()
    let maxVarbitId = -1
    await readPooled(varbitFiles, async (f) => {
      const def = JSON.parse(await (await f.handle.getFile()).text()) as VarbitDef
      if (f.id > maxVarbitId) maxVarbitId = f.id
      let list = byBaseVar.get(def.baseVar)
      if (!list) byBaseVar.set(def.baseVar, list = [])
      list.push({ id: f.id, startBit: def.startBit, endBit: def.endBit })
    }, emit)

    for (const list of byBaseVar.values()) {
      list.sort((a, b) => a.startBit - b.startBit || a.id - b.id)
    }

    const varpIds = varpFiles.map((f) => f.id).sort((a, b) => a - b)
    const maxVarpId = varpIds.length > 0 ? varpIds[varpIds.length - 1] : -1
    const present = new Set(varpIds)
    const varpGaps: number[] = []
    for (let i = 0; i < maxVarpId; i++) if (!present.has(i)) varpGaps.push(i)

    cached = {
      byBaseVar,
      varbitCount: varbitFiles.length,
      maxVarbitId,
      varpCount: varpFiles.length,
      maxVarpId,
      varpGaps,
    }
    return cached
  })()
  building.catch(() => { building = null })
  return building
}

/** A varp's 32 bits, each either free or claimed by a varbit. */
export function bitOwners(uses: VarbitUse[] | undefined): (VarbitUse | null)[] {
  const owners: (VarbitUse | null)[] = new Array(32).fill(null)
  for (const use of uses ?? []) {
    for (let b = Math.max(0, use.startBit); b <= Math.min(31, use.endBit); b++) {
      owners[b] = use
    }
  }
  return owners
}

/** Bits needed to hold 0..maxValue. */
export function bitsFor(maxValue: number): number {
  if (maxValue <= 0) return 1
  return Math.max(1, Math.ceil(Math.log2(maxValue + 1)))
}

/** The client's own mask: BIT_MASKS[end - start] = 2^(end-start+1) − 1. */
export function varbitMask(startBit: number, endBit: number): number {
  const width = endBit - startBit + 1
  if (width <= 0 || width > 32) return 0
  return width === 32 ? -1 : (1 << width) - 1
}
