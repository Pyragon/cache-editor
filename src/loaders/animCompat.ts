import { getEntryPath, resolveEntryHandle } from './entryOrder'

// ---------------------------------------------------------------------------
// Animation-compatibility index.
//
// "Which models does this animation fit" is decided by the frame BASE (the
// skeleton): a sequence's frame sets each carry a frameBaseId, whose transform
// slots address vertex-group labels, and a model fits when its vertexSkins
// labels are laid out for that base. Rather than parsing every model binary,
// this index derives fit from the client's own pairings:
//   - spot anims pair a model with a sequence directly, and
//   - NPCs pair a model set with a BAS (whose sequences share the skeleton).
// One scan reads animations (17k), the first frame of every frame set (4k),
// bas (2.5k), npcs (15.7k) and spot anims (3.2k) — ~43k JSONs, tens of
// seconds — then everything is served from this module-level cache.
// ---------------------------------------------------------------------------

export type NpcUse = { id: number; name: string; modelIds: number[]; basId: number }
export type SpotUse = { id: number; modelId: number; sequenceId: number }
export type ItemUse = { id: number; name: string }

/** Item param (clientScriptData) key holding the weapon's render anim (BAS)
 *  id — the server feeds this into the player appearance; 1426 is the
 *  implicit default stance for items without it. */
export const RENDER_ANIM_PARAM = '644'
export const DEFAULT_PLAYER_BAS = 1426

export type AnimCompatIndex = {
  /** sequence id -> frame base (skeleton) id, -1 when the sequence has no frames. */
  seqBase: Map<number, number>
  /** frame base id -> sequence ids rigged against it. */
  baseSeqs: Map<number, number[]>
  /** bas id -> NPCs whose render anim it is. */
  npcsByBas: Map<number, NpcUse[]>
  /** frame base id -> NPCs whose BAS contains a sequence on that skeleton. */
  npcsByBase: Map<number, NpcUse[]>
  /** frame base id -> spot anims whose sequence is on that skeleton. */
  spotsByBase: Map<number, SpotUse[]>
  /** bas id -> items whose render-anim param (weapon stance) names it. */
  itemsByBas: Map<number, ItemUse[]>
}

// All BAS fields holding a sequence id (randomStandSequences handled apart).
const BAS_SEQ_FIELDS = [
  'standAnimation', 'walkAnimation', 'runningAnimation', 'teleportingAnimation',
  'standTurnCcwSequence', 'standTurnCwSequence',
  'walkDir1', 'walkDir2', 'walkDir3', 'walkTurnCcwSequence', 'walkTurnCwSequence',
  'runDir1', 'runDir2', 'runDir3', 'runTurnCcwSequence', 'runTurnCwSequence',
  'teleDir1', 'teleDir2', 'teleDir3', 'teleTurnCcwSequence', 'teleTurnCwSequence',
] as const

let cached: AnimCompatIndex | null = null
let building: Promise<AnimCompatIndex> | null = null

export function peekAnimCompatIndex(): AnimCompatIndex | null {
  return cached
}

export function isAnimCompatBuilding(): boolean {
  return building != null && cached == null
}

/** Drop the session cache — App calls this after saving any def type the
 *  index reads (animations, frame sets, bas, npcs, spot anims, items), so
 *  the Used By / fit tables offer a fresh scan instead of stale rows. */
export function invalidateAnimCompatIndex(): void {
  cached = null
  building = null
}

async function listJsonIds(dir: FileSystemDirectoryHandle): Promise<number[]> {
  const ids: number[] = []
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const id = parseInt(handle.name.slice(0, -5), 10)
    if (!isNaN(id)) ids.push(id)
  }
  return ids.sort((a, b) => a - b)
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  const file = await (await dir.getFileHandle(name)).getFile()
  return JSON.parse(await file.text())
}

/** Chunked parallel scan over `<id>.json` files with progress reporting. */
async function scanJsons(
  dir: FileSystemDirectoryHandle,
  ids: number[],
  each: (id: number, json: unknown) => void,
  tick: (count: number) => void,
): Promise<void> {
  const CHUNK = 128
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    await Promise.all(chunk.map(async (id) => {
      try {
        each(id, await readJson(dir, `${id}.json`))
      } catch { /* unreadable file — skip */ }
    }))
    tick(chunk.length)
  }
}

export function buildAnimCompatIndex(
  cacheRoot: FileSystemDirectoryHandle,
  onProgress: (done: number, total: number) => void,
): Promise<AnimCompatIndex> {
  if (cached) return Promise.resolve(cached)
  if (building) return building
  building = (async () => {
    const animationsDir = await resolveEntryHandle(cacheRoot, getEntryPath('animations'))
    const frameSetsDir = await resolveEntryHandle(cacheRoot, getEntryPath('animation_frame_sets'))
    const basDir = await resolveEntryHandle(cacheRoot, getEntryPath('config_bas'))
    const npcsDir = await resolveEntryHandle(cacheRoot, getEntryPath('npcs'))
    const spotsDir = await resolveEntryHandle(cacheRoot, getEntryPath('spot_animations'))
    const itemsDir = await resolveEntryHandle(cacheRoot, getEntryPath('items'))
    if (!animationsDir || !frameSetsDir) throw new Error('animations / frame_sets entries not found in this cache')

    const animIds = await listJsonIds(animationsDir)
    const basIds = basDir ? await listJsonIds(basDir) : []
    const npcIds = npcsDir ? await listJsonIds(npcsDir) : []
    const spotIds = spotsDir ? await listJsonIds(spotsDir) : []
    const itemIds = itemsDir ? await listJsonIds(itemsDir) : []

    // frame set count only becomes known after phase 1, so estimate it into
    // the total up front (revised down if fewer distinct sets exist)
    let done = 0
    let total = animIds.length + basIds.length + npcIds.length + spotIds.length + itemIds.length
    const tick = (n: number) => { done += n; onProgress(done, total) }

    // 1. sequence -> its first frame set
    const seqFirstSet = new Map<number, number>()
    await scanJsons(animationsDir, animIds, (id, json) => {
      const def = json as { frameSetIds?: number[] }
      const first = def.frameSetIds?.[0]
      seqFirstSet.set(id, first != null && first >= 0 ? first : -1)
    }, tick)

    // 2. frame set -> frame base (read one frame file per distinct set)
    const distinctSets = [...new Set([...seqFirstSet.values()].filter((s) => s >= 0))]
    total += distinctSets.length
    onProgress(done, total)
    const setBase = new Map<number, number>()
    const CHUNK = 128
    for (let i = 0; i < distinctSets.length; i += CHUNK) {
      const chunk = distinctSets.slice(i, i + CHUNK)
      await Promise.all(chunk.map(async (setId) => {
        try {
          const setDir = await frameSetsDir.getDirectoryHandle(String(setId))
          // Direct lookups first: 99% of sets contain frame 0 (or 1), and
          // enumerating these folders is what made this phase crawl — each
          // holds up to hundreds of .dat/.json pairs.
          let frame: { frameBaseId?: number } | null = null
          for (const name of ['0.json', '1.json']) {
            try {
              frame = JSON.parse(await (await (await setDir.getFileHandle(name)).getFile()).text())
              break
            } catch { /* not this file id — keep trying */ }
          }
          if (!frame) {
            for await (const handle of setDir.values()) {
              if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
              frame = JSON.parse(await (await handle.getFile()).text())
              break
            }
          }
          if (frame?.frameBaseId != null) setBase.set(setId, frame.frameBaseId)
        } catch { /* missing set dir — leave unmapped */ }
      }))
      tick(chunk.length)
    }

    const seqBase = new Map<number, number>()
    const baseSeqs = new Map<number, number[]>()
    for (const [seq, set] of seqFirstSet) {
      const base = set >= 0 ? (setBase.get(set) ?? -1) : -1
      seqBase.set(seq, base)
      if (base >= 0) {
        let list = baseSeqs.get(base)
        if (!list) baseSeqs.set(base, list = [])
        list.push(seq)
      }
    }

    // 3. bas -> distinct sequence ids -> distinct skeleton bases
    const basBases = new Map<number, Set<number>>()
    if (basDir) {
      await scanJsons(basDir, basIds, (id, json) => {
        const def = json as Record<string, unknown> & { randomStandSequences?: number[] }
        const seqs = new Set<number>()
        for (const field of BAS_SEQ_FIELDS) {
          const value = def[field]
          if (typeof value === 'number' && value >= 0) seqs.add(value)
        }
        for (const seq of def.randomStandSequences ?? []) {
          if (seq >= 0) seqs.add(seq)
        }
        const bases = new Set<number>()
        for (const seq of seqs) {
          const base = seqBase.get(seq)
          if (base != null && base >= 0) bases.add(base)
        }
        basBases.set(id, bases)
      }, tick)
    }

    // 4. npcs
    const npcsByBas = new Map<number, NpcUse[]>()
    const npcsByBase = new Map<number, NpcUse[]>()
    if (npcsDir) {
      await scanJsons(npcsDir, npcIds, (id, json) => {
        const def = json as { name?: string; modelIds?: number[]; basId?: number }
        const basId = def.basId ?? -1
        if (basId < 0) return
        const use: NpcUse = { id, name: def.name ?? 'null', modelIds: def.modelIds ?? [], basId }
        let list = npcsByBas.get(basId)
        if (!list) npcsByBas.set(basId, list = [])
        list.push(use)
        for (const base of basBases.get(basId) ?? []) {
          let baseList = npcsByBase.get(base)
          if (!baseList) npcsByBase.set(base, baseList = [])
          baseList.push(use)
        }
      }, tick)
    }

    // 5. spot anims
    const spotsByBase = new Map<number, SpotUse[]>()
    if (spotsDir) {
      await scanJsons(spotsDir, spotIds, (id, json) => {
        const def = json as { modelId?: number; sequenceId?: number }
        const seq = def.sequenceId ?? -1
        if (seq < 0) return
        const base = seqBase.get(seq)
        if (base == null || base < 0) return
        let list = spotsByBase.get(base)
        if (!list) spotsByBase.set(base, list = [])
        list.push({ id, modelId: def.modelId ?? -1, sequenceId: seq })
      }, tick)
    }

    // 6. items — the render-anim param is the weapon-stance BAS reference
    const itemsByBas = new Map<number, ItemUse[]>()
    if (itemsDir) {
      await scanJsons(itemsDir, itemIds, (id, json) => {
        const def = json as { name?: string; clientScriptData?: Record<string, unknown>; params?: Record<string, unknown> }
        const params = def.clientScriptData ?? def.params
        const bas = params?.[RENDER_ANIM_PARAM]
        if (typeof bas !== 'number' || bas < 0) return
        let list = itemsByBas.get(bas)
        if (!list) itemsByBas.set(bas, list = [])
        list.push({ id, name: def.name ?? 'null' })
      }, tick)
    }

    for (const list of npcsByBase.values()) list.sort((a, b) => a.id - b.id)
    for (const list of npcsByBas.values()) list.sort((a, b) => a.id - b.id)
    for (const list of spotsByBase.values()) list.sort((a, b) => a.id - b.id)
    for (const list of itemsByBas.values()) list.sort((a, b) => a.id - b.id)

    cached = { seqBase, baseSeqs, npcsByBas, npcsByBase, spotsByBase, itemsByBas }
    return cached
  })()
  building.catch(() => { building = null })
  return building
}
