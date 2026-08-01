// What references a given midi_instruments sample.
//
// There are two entirely separate ways in, and missing either one makes an
// instrument look dead when it isn't:
//
//  1. **Instrument banks.** `sound_effects_midi` maps notes to samples, and the
//     music sequencer reaches those through program + bank select.
//
//  2. **Ambient sounds, bypassing MIDI completely.** An object or NPC's sound
//     id is looked up in `sound_effects` (index 4) *or* in `midi_instruments`
//     (index 14) depending on a flag on the def — object opcodes 168/169
//     (`instrumentSoundEffect` / `instrumentAmbientSound`) and NPC opcode 162.
//     See `SoundEffectPlayer:233/268` and `AreaSoundPlayer:67`: same id, two
//     different indices, chosen by that boolean.
//
// Banks are scanned automatically — 247 files. Objects and NPCs are ~90,000
// files between them, far too many to read on every selection, so that pass is
// on demand.
import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { resolveSample } from './sound_effects_midi'
import type { SoundEffectMidiDef } from './sound_effects_midi'
import { indexEntries, readPooled, throttleProgress } from './scan'
import type { ScanProgress } from './scan'

export type InstrumentUse =
  | {
      kind: 'bank'
      /** patch key = the bank archive id */
      bank: number
      /** MIDI note numbers in that bank mapped to this instrument */
      notes: number[]
    }
  | {
      kind: 'object' | 'npc' | 'cutscene'
      id: number
      /** which def field points here */
      field: string
    }

/** instrument id -> everything that references it */
export type UsageIndex = Map<number, InstrumentUse[]>

const cache = new WeakMap<FileSystemDirectoryHandle, Promise<UsageIndex>>()

export function instrumentUsage(root: FileSystemDirectoryHandle): Promise<UsageIndex> {
  let p = cache.get(root)
  if (!p) {
    p = build(root).catch((e) => {
      // don't cache a failure — a transient permission prompt shouldn't make
      // the panel permanently empty for the rest of the session
      cache.delete(root)
      throw e
    })
    cache.set(root, p)
  }
  return p
}

async function build(root: FileSystemDirectoryHandle): Promise<UsageIndex> {
  const index: UsageIndex = new Map()
  const dir = await resolveEntryHandle(root, getEntryPath('sound_effects_midi'))
  if (!dir) return index

  const names: string[] = []
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.json')) names.push(entry.name)
  }

  for (const name of names) {
    const bank = Number.parseInt(name, 10)
    if (!Number.isFinite(bank)) continue
    let def: SoundEffectMidiDef
    try {
      def = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as SoundEffectMidiDef
    } catch {
      continue // a bank this dump doesn't have shouldn't sink the whole index
    }
    // one entry per (instrument, bank), collecting the notes — a drum kit maps
    // the same sample across a run of keys and listing it once per key is noise
    const perInstrument = new Map<number, number[]>()
    for (let note = 0; note < 128; note++) {
      const code = def.sampleCode?.[note] ?? 0
      if (!code) continue
      const ref = resolveSample(code)
      if (!ref || ref.entry !== 'midi_instruments') continue
      const notes = perInstrument.get(ref.id)
      if (notes) notes.push(note)
      else perInstrument.set(ref.id, [note])
    }
    for (const [id, notes] of perInstrument) {
      const use: InstrumentUse = { kind: 'bank', bank, notes }
      const uses = index.get(id)
      if (uses) uses.push(use)
      else index.set(id, [use])
    }
  }

  // Cutscenes reach this index too, and there are only 16 of them, so they go
  // in the automatic pass rather than behind the objects/NPCs scan. A
  // PLAY_VORBIS action's soundId is an index-14 sample: the client builds an
  // AreaSound of type 2, which `spoken()` routes to Resource.MIDI_INSTRUMENT
  // (AreaSoundPlayer:67) — "vorbis" is the format, not an index.
  const cutscenesDir = await resolveEntryHandle(root, getEntryPath('cutscenes'))
  if (cutscenesDir) {
    for await (const handle of cutscenesDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const cutsceneId = Number.parseInt(handle.name, 10)
      try {
        const def = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as
          { actions?: { type?: string; fields?: Record<string, number> }[] }
        for (const action of def.actions ?? []) {
          if (action.type !== 'PLAY_VORBIS') continue
          const id = action.fields?.soundId
          if (id == null || id < 0) continue
          const use: InstrumentUse = { kind: 'cutscene', id: cutsceneId, field: 'PLAY_VORBIS' }
          const uses = index.get(id)
          // one entry per cutscene, however many times it plays the sample
          if (uses) { if (!uses.some((u) => u.kind === 'cutscene' && u.id === cutsceneId)) uses.push(use) }
          else index.set(id, [use])
        }
      } catch { /* unreadable cutscene — skip */ }
    }
  }

  for (const uses of index.values()) {
    uses.sort((a, b) => (a.kind === 'bank' && b.kind === 'bank' ? a.bank - b.bank : 0))
  }
  return index
}

// ---------------------------------------------------------------------------
// The ambient-sound half: object and NPC defs whose sound id points at index 14
// ---------------------------------------------------------------------------

export type DeepScan = {
  index: UsageIndex
  /** defs read, so the UI can say what the scan actually covered */
  scanned: number
}

/** Has the deep scan already run for this cache? Lets a remounted viewer show
 *  the full picture instead of offering a button that would return instantly. */
export function deepScanReady(root: FileSystemDirectoryHandle): boolean {
  return deepCache.has(root)
}

const deepCache = new WeakMap<FileSystemDirectoryHandle, Promise<DeepScan>>()

/**
 * Called while the scan runs.
 *
 * Two phases, because listing the defs is itself slow enough to sit through:
 * every directory entry has to be walked before the first file can be read, and
 * reporting "0 / …" through all of it looks stalled.
 *
 * `index` is the LIVE index, still filling — read from it to show results as
 * they arrive rather than only at the end.
 */
/** The shared scan progress plus the LIVE index — read from it to show results
 *  as they arrive rather than only at the end. */
export type InstrumentScanProgress = (p: ScanProgress & { index: UsageIndex }) => void

/**
 * Fold object and NPC ambient sounds into the index.
 *
 * Only defs with the instrument flag set count: without it the very same id
 * means a `sound_effects` entry instead, so counting them all would invent
 * references that don't exist.
 *
 * Reads every object and NPC in the cache (~90k files), so it is explicit
 * rather than automatic, and cached for the session once run.
 */
export function deepInstrumentUsage(
  root: FileSystemDirectoryHandle,
  onProgress?: InstrumentScanProgress,
): Promise<DeepScan> {
  let p = deepCache.get(root)
  if (!p) {
    p = buildDeep(root, onProgress).catch((e) => { deepCache.delete(root); throw e })
    deepCache.set(root, p)
  }
  return p
}

type SoundDef = {
  instrumentSoundEffect?: boolean
  instrumentAmbientSound?: boolean
  ambientSoundId?: number
  soundGroupIds?: number[]
  idleSoundEffect?: number
  walkingSoundEffect?: number
  runningSoundEffect?: number
  teleportSoundEffect?: number
}

async function buildDeep(
  root: FileSystemDirectoryHandle,
  onProgress?: InstrumentScanProgress,
): Promise<DeepScan> {
  // start from the bank index so the result is the complete picture
  const base = await instrumentUsage(root)
  const index: UsageIndex = new Map()
  for (const [id, uses] of base) index.set(id, [...uses])

  const add = (id: number | undefined, use: InstrumentUse) => {
    if (id == null || id < 0) return
    const uses = index.get(id)
    if (uses) uses.push(use)
    else index.set(id, [use])
  }

  const emit = throttleProgress(onProgress && ((p) => onProgress({ ...p, index })))

  const objectsDir = await resolveEntryHandle(root, getEntryPath('objects'))
  const npcsDir = await resolveEntryHandle(root, getEntryPath('npcs'))
  const work = await indexEntries(
    [objectsDir, npcsDir],
    (handle, dirIndex) => (handle.kind === 'file' && handle.name.endsWith('.json')
      ? { entry: dirIndex === 0 ? ('objects' as const) : ('npcs' as const), handle: handle as FileSystemFileHandle }
      : null),
    emit,
  )

  await readPooled(work, async ({ entry, handle }) => {
    const defId = Number.parseInt(handle.name, 10)
    const def = JSON.parse(await (await handle.getFile()).text()) as SoundDef
    if (entry === 'objects') {
      if (def.instrumentSoundEffect) {
        add(def.ambientSoundId, { kind: 'object', id: defId, field: 'ambientSoundId' })
      }
      if (def.instrumentAmbientSound && Array.isArray(def.soundGroupIds)) {
        for (const g of def.soundGroupIds) add(g, { kind: 'object', id: defId, field: 'soundGroupIds' })
      }
    } else if (def.instrumentSoundEffect) {
      for (const field of ['idleSoundEffect', 'walkingSoundEffect', 'runningSoundEffect', 'teleportSoundEffect'] as const) {
        add(def[field], { kind: 'npc', id: defId, field })
      }
    }
  }, emit)

  const total = work.length
  return { index, scanned: total }
}

/** "27", "36-40", "36-40, 52" — drum kits map long runs of consecutive keys. */
export function formatNotes(notes: number[]): string {
  const runs: string[] = []
  let start = notes[0]
  let prev = notes[0]
  for (let i = 1; i <= notes.length; i++) {
    const n = notes[i]
    if (n === prev + 1) { prev = n; continue }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`)
    start = prev = n
  }
  return runs.join(', ')
}

/** The client addresses banks as `program + (CC32 << 7)`; CC0 is never used. */
export function bankAddress(bank: number): string {
  return `CC32 ${bank >> 7}, program ${bank & 0x7f}`
}
