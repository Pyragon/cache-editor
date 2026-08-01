// Resolving a song's instruments out of the cache.
//
// A `.mid` is a score with no audio in it, and browsers ship no MIDI synth, so
// playing one means supplying the instruments ourselves. The client renders
// music from its OWN sample bank, which is in this cache — so this module
// walks the client's chain rather than substituting a General MIDI soundfont:
//
//   program + bank select  ->  patch key
//   patch key              ->  sound_effects_midi/<key>.json   (the bank)
//   bank note              ->  midi_instruments/<id> | sound_effects/<id>
//
// That last fork is lopsided: of the 23,153 mapped note slots across the 247
// banks, 23,139 point at midi_instruments and only 14 at sound_effects — the
// same index 4 that loc/NPC ambient sounds come from. Those 14 are percussion
// one-shots (note 27 -> sfx 3452 in nine drum kits; bank 184 notes 96/97; bank
// 291 notes 52/53/55), and exactly 9 of the 1,662 songs ever strike one. The
// sound_effects branch below is real but rare — don't let it imply the two
// sample indices are comparable sources.
//
// Full trace, including the field-name traps, in docs/music-synth.md.
import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { resolveSample } from './sound_effects_midi'
import type { SoundEffectMidiDef, SoundEffectMidiZone } from './sound_effects_midi'
import type { SoundEffectDef } from './sound_effects'
import { SAMPLE_RATE as SFX_SAMPLE_RATE, mixToFloat } from './soundSynth'

/** One playable note slot of a bank. */
export type BankNote = {
  sampleCode: number
  /**
   * Signed 16-bit, assembled exactly as `MusicPatch` does:
   * `coarse + (fine << 8) + ((sampleCode - 1 & 2) << 14)`.
   * A NEGATIVE value is the client's loop flag — `MusicPatchPcmStream` tests
   * `pitchOffset[note] < 0` to call `setNumLoops(-1)`.
   */
  pitchOffset: number
  volume: number
  pan: number
  chokeGroup: number
  zone: SoundEffectMidiZone | null
}

export type LoadedBank = {
  key: number
  globalGain: number
  /** 128 slots; null where the bank maps no sample. */
  notes: (BankNote | null)[]
}

/** A decoded instrument sample, ready for the worklet. */
export type LoadedSample = {
  /** mono, -1..1 */
  data: Float32Array
  sampleRate: number
  /** loop region in samples; loopEnd <= loopStart means "no loop" */
  loopStart: number
  loopEnd: number
}

/**
 * `MidiPcmStream` builds the patch key as `program + bankSelect`, where
 * bankSelect is `(CC0 << 14) + (CC32 << 7)` and channel 9 defaults to 128.
 */
export function patchKey(program: number, bankSelect: number): number {
  return program + bankSelect
}

/** `MusicPatch:149/157/177` — the three passes that assemble the tuning short. */
function pitchOffsetFor(def: SoundEffectMidiDef, note: number): number {
  const coarse = def.tuningCoarse[note] ?? 0
  const fine = def.tuningFine[note] ?? 0
  const code = def.sampleCode[note] ?? 0
  const packed = (coarse + (fine << 8) + (((code - 1) & 0x2) << 14)) & 0xffff
  // stored as a Java short — the sign is load-bearing (it is the loop flag)
  return packed >= 0x8000 ? packed - 0x10000 : packed
}

/**
 * `MidiPcmStream:209` —
 * `notePitchAdjustment = (note << 8) - (pitchOffset & 0x7fff)`.
 * Units are 1/256 of a semitone (see `calculatePitch`, which raises 2 to
 * `pitch / 3072`).
 */
export function notePitchAdjustment(note: number, pitchOffset: number): number {
  return (note << 8) - (pitchOffset & 0x7fff)
}

export function bankFromDef(def: SoundEffectMidiDef, key: number): LoadedBank {
  const notes: (BankNote | null)[] = []
  for (let note = 0; note < 128; note++) {
    const sampleCode = def.sampleCode[note] ?? 0
    if (sampleCode === 0) { notes.push(null); continue }
    const zoneIndex = def.zoneIndex[note] ?? -1
    notes.push({
      sampleCode,
      pitchOffset: pitchOffsetFor(def, note),
      volume: def.volume[note] ?? 0,
      pan: def.pan[note] ?? 64,
      chokeGroup: def.chokeGroup[note] ?? -1,
      zone: zoneIndex >= 0 ? (def.zones[zoneIndex] ?? null) : null,
    })
  }
  return { key, globalGain: def.globalGain ?? 41, notes }
}

/** Reads and caches instrument banks by patch key. */
export class MusicBankLoader {
  private root: FileSystemDirectoryHandle
  private banks = new Map<number, Promise<LoadedBank | null>>()
  private samples = new Map<string, Promise<LoadedSample | null>>()
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle | null>>()

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  private dir(entry: string): Promise<FileSystemDirectoryHandle | null> {
    let p = this.dirs.get(entry)
    if (!p) {
      p = resolveEntryHandle(this.root, getEntryPath(entry)).catch(() => null)
      this.dirs.set(entry, p)
    }
    return p
  }

  bank(key: number): Promise<LoadedBank | null> {
    let p = this.banks.get(key)
    if (!p) {
      p = (async () => {
        const dir = await this.dir('sound_effects_midi')
        if (!dir) return null
        try {
          const file = await (await dir.getFileHandle(`${key}.json`)).getFile()
          return bankFromDef(JSON.parse(await file.text()) as SoundEffectMidiDef, key)
        } catch {
          return null // the song asks for banks this dump doesn't have
        }
      })()
      this.banks.set(key, p)
    }
    return p
  }

  /**
   * Decode one sample. `midi_instruments` entries are already real Ogg Vorbis
   * (cryogen reconstructs them on dump), so the browser decodes them natively;
   * `sound_effects` entries are the additive-synthesis format and are rendered
   * by our existing port.
   *
   * There are 16,824 instruments — these are fetched lazily per song and
   * cached, never preloaded.
   */
  sample(sampleCode: number, ctx: BaseAudioContext): Promise<LoadedSample | null> {
    const ref = resolveSample(sampleCode)
    if (!ref) return Promise.resolve(null)
    const cacheKey = `${ref.entry}:${ref.id}`
    let p = this.samples.get(cacheKey)
    if (!p) {
      p = (ref.entry === 'midi_instruments'
        ? this.loadInstrument(ref.id, ctx)
        : this.loadSoundEffect(ref.id)
      ).catch(() => null)
      this.samples.set(cacheKey, p)
    }
    return p
  }

  private async loadInstrument(id: number, ctx: BaseAudioContext): Promise<LoadedSample | null> {
    const dir = await this.dir('midi_instruments')
    if (!dir) return null
    const sub = await dir.getDirectoryHandle(String(id))

    let loopStart = 0
    let loopEnd = 0
    let declaredRate = 0
    try {
      const meta = JSON.parse(await (await (await sub.getFileHandle('data.json')).getFile()).text()) as
        { samplingRate?: number; loopStart?: number; loopEnd?: number }
      loopStart = meta.loopStart ?? 0
      loopEnd = meta.loopEnd ?? 0
      declaredRate = meta.samplingRate ?? 0
    } catch { /* metadata is optional — the ogg still plays */ }

    const oggFile = await (await sub.getFileHandle('sound.ogg')).getFile()
    const decoded = await ctx.decodeAudioData(await oggFile.arrayBuffer())
    // instruments are mono in the cache; if a decoder hands back stereo, take
    // the left channel rather than averaging (averaging would comb-filter)
    const data = decoded.getChannelData(0)
    return {
      data: new Float32Array(data),
      // trust the dump's declared rate: decodeAudioData resamples to the
      // context rate, so decoded.sampleRate is the CONTEXT's, not the file's
      sampleRate: decoded.sampleRate,
      // ...which means the loop points, expressed in original samples, have to
      // be scaled by however much the decode resampled
      loopStart: declaredRate > 0 ? Math.round(loopStart * (decoded.sampleRate / declaredRate)) : loopStart,
      loopEnd: declaredRate > 0 ? Math.round(loopEnd * (decoded.sampleRate / declaredRate)) : loopEnd,
    }
  }

  private async loadSoundEffect(id: number): Promise<LoadedSample | null> {
    const dir = await this.dir('sound_effects')
    if (!dir) return null
    const sub = await dir.getDirectoryHandle(String(id))
    const def = JSON.parse(await (await (await sub.getFileHandle(`${id}.json`)).getFile()).text()) as SoundEffectDef
    const data = mixToFloat(def)
    return { data, sampleRate: SFX_SAMPLE_RATE, loopStart: 0, loopEnd: 0 }
  }
}
