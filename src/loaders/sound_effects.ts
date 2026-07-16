import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// One folder per sound effect (IndexType.SOUND_EFFECTS), holding <id>.json
// (the decoded synthesis data — matches cryogen SoundEffect/Instrument/
// Envelope/Filter field-for-field) and a rendered <id>.wav preview (the
// client's own additive-synthesis engine, rendered server-side at dump time —
// editing fields here does NOT regenerate the WAV; it goes stale until the
// next dump. A live in-browser resynthesis port is a future improvement,
// see TODO).
export type EnvelopeDef = {
  form: number
  start: number
  end: number
  numPhases: number
  phaseDuration: number[]
  phasePeak: number[]
}

export type FilterDef = {
  /** [dir] pair count, 0-4 each. */
  numPairs: [number, number]
  /** [dir][0|1][term]. */
  pairPhase: number[][][]
  pairMagnitude: number[][][]
  unity: [number, number]
  /** Raw decoded bitmask — which [dir][term] pairs have a distinct end-of-envelope value. Not hand-edited. */
  migrated: number
}

export type InstrumentDef = {
  pitch: EnvelopeDef
  volume: EnvelopeDef
  pitchModifier: EnvelopeDef | null
  pitchModifierAmplitude: EnvelopeDef | null
  volumeMultiplier: EnvelopeDef | null
  volumeAmplitude: EnvelopeDef | null
  release: EnvelopeDef | null
  attack: EnvelopeDef | null
  delayTime: number
  delayDecay: number
  duration: number
  offset: number
  filter: FilterDef
  filterEnvelope: EnvelopeDef
  /** Up to 5 additive oscillators. */
  oscillatorVolume: number[]
  oscillatorPitch: number[]
  oscillatorDelays: number[]
}

export type SoundEffectDef = {
  /** Up to 10 simultaneous instrument voices; holes are null. */
  instruments: (InstrumentDef | null)[]
  loopBegin: number
  loopEnd: number
}

export type SoundEffectData = {
  id: number
  def: SoundEffectDef
  /** Object URL for the dumped WAV preview, or null if it wasn't dumped. */
  wavUrl: string | null
}

function emptyEnvelope(): EnvelopeDef {
  return { form: 1, start: 0, end: 0, numPhases: 2, phaseDuration: [0, 65535], phasePeak: [0, 65535] }
}

function emptyFilter(): FilterDef {
  return {
    numPairs: [0, 0],
    pairPhase: [[[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0]]],
    pairMagnitude: [[[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0]]],
    unity: [0, 0],
    migrated: 0,
  }
}

export function emptyInstrument(): InstrumentDef {
  return {
    pitch: emptyEnvelope(),
    volume: emptyEnvelope(),
    pitchModifier: null,
    pitchModifierAmplitude: null,
    volumeMultiplier: null,
    volumeAmplitude: null,
    release: null,
    attack: null,
    delayTime: 0,
    delayDecay: 0,
    duration: 500,
    offset: 0,
    filter: emptyFilter(),
    filterEnvelope: emptyEnvelope(),
    oscillatorVolume: [0, 0, 0, 0, 0],
    oscillatorPitch: [0, 0, 0, 0, 0],
    oscillatorDelays: [0, 0, 0, 0, 0],
  }
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const jsonHandle = await subHandle.getFileHandle(`${item.id}.json`)
    const file = await jsonHandle.getFile()
    const def = JSON.parse(await file.text()) as SoundEffectDef

    let wavUrl: string | null = null
    try {
      const wavHandle = await subHandle.getFileHandle(`${item.id}.wav`)
      const wavFile = await wavHandle.getFile()
      wavUrl = URL.createObjectURL(wavFile)
    } catch {
      // no dumped preview
    }

    return { id: item.id, def, wavUrl } satisfies SoundEffectData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as SoundEffectData
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id), { create: true })
    const jsonHandle = await subHandle.getFileHandle(`${item.id}.json`, { create: true })
    const writable = await jsonHandle.createWritable()
    await writable.write(JSON.stringify(def))
    await writable.close()
  },
}

export default loader
