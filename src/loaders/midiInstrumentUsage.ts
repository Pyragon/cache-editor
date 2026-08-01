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

export type InstrumentUse =
  | {
      kind: 'bank'
      /** patch key = the bank archive id */
      bank: number
      /** MIDI note numbers in that bank mapped to this instrument */
      notes: number[]
    }
  | {
      kind: 'object' | 'npc'
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

  for (const uses of index.values()) {
    uses.sort((a, b) => (a.kind === 'bank' && b.kind === 'bank' ? a.bank - b.bank : 0))
  }
  return index
}

// ---------------------------------------------------------------------------
// The ambient-sound half: object and NPC defs whose sound id points at index 14
// ---------------------------------------------------------------------------

export type DeepScan = { index: UsageIndex; objects: number; npcs: number }

const deepCache = new WeakMap<FileSystemDirectoryHandle, Promise<DeepScan>>()

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
  onProgress?: (done: number, total: number) => void,
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
  onProgress?: (done: number, total: number) => void,
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

  let objects = 0
  let npcs = 0
  let done = 0

  // Enumerate BOTH entries before reading any of them, so the reported total is
  // the real one from the first tick — counting per directory would make the
  // denominator jump partway through, which reads as the job getting bigger.
  const work: { entry: 'objects' | 'npcs'; dir: FileSystemDirectoryHandle; name: string }[] = []
  for (const entry of ['objects', 'npcs'] as const) {
    const dir = await resolveEntryHandle(root, getEntryPath(entry))
    if (!dir) continue
    for await (const handle of dir.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) work.push({ entry, dir, name: handle.name })
    }
  }
  const total = work.length
  onProgress?.(0, total)

  for (const { entry, dir, name } of work) {
    const defId = Number.parseInt(name, 10)
    let def: SoundDef
    try {
      def = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as SoundDef
    } catch {
      done++
      continue
    }
    if (entry === 'objects') {
      if (def.instrumentSoundEffect) {
        add(def.ambientSoundId, { kind: 'object', id: defId, field: 'ambientSoundId' })
        objects++
      }
      if (def.instrumentAmbientSound && Array.isArray(def.soundGroupIds)) {
        for (const g of def.soundGroupIds) add(g, { kind: 'object', id: defId, field: 'soundGroupIds' })
        objects++
      }
    } else if (def.instrumentSoundEffect) {
      for (const field of ['idleSoundEffect', 'walkingSoundEffect', 'runningSoundEffect', 'teleportSoundEffect'] as const) {
        add(def[field], { kind: 'npc', id: defId, field })
      }
      npcs++
    }
    if (++done % 250 === 0) onProgress?.(done, total)
  }

  onProgress?.(done, total)
  return { index, objects, npcs }
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
