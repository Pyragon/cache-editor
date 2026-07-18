import { makeJsonDefLoader } from './common'
import type { JsonDefData } from './common'

// Index 15 ("sound effects midi") is neither the sound_effects
// additive-synthesis format nor the music/music2 compact-MIDI event
// stream — despite the name, it's a SoundFont/DLS-style instrument bank
// keyed by MIDI program-change number. Each archive maps the 128-note
// keyboard to "zones" (amplitude envelope, continuous decay, vibrato LFO),
// with per-note tuning, choke/exclusive-class group, pan, and volume. The
// actual PCM samples aren't stored here — `sampleCode` cross-references
// either the sound_effects or midi_instruments index (see resolveSample
// below), matching the client's Node_Sub14.method12216.
//
// Traced via darkan-game-client: Class42_Sub1.method14563 ->
// Static.method2084 -> Node_Sub15_Sub2.method15182 ->
// PlaySoundJingleCutsceneAction.method14676 -> Node_Sub14's byte[]
// constructor (the zone struct is Class110). Ported to
// com.cryo.cache.loaders.sound.SoundEffectMidi in cryogen — 246/246
// archives round-trip byte-identical.
export type SoundEffectMidiZone = {
  /** X,Y breakpoint pairs (Y in 0..255-ish, X = time). Absent = no sustain envelope. */
  sustainEnvelope?: number[]
  /** X,Y breakpoint pairs; Y[0] defaults to 64 (unity) when present. Absent = no release envelope. */
  releaseEnvelope?: number[]
  /** Envelope1 (sustainEnvelope) playback rate, only meaningful when sustainEnvelope is set. */
  sustainRate: number
  /** Continuous decay/damping rate, applied regardless of the envelope curves. */
  decayRate: number
  /** Envelope2 (releaseEnvelope) playback rate, only meaningful when releaseEnvelope is set. */
  releaseRate: number
  /** Rate exponent for the decayRate accumulator, only meaningful when decayRate > 0. */
  decayRateScale: number
  /** Vibrato LFO rate (phase increment per frame). */
  vibratoRate: number
  /** Vibrato depth, only meaningful when vibratoRate > 0. */
  vibratoDepth: number
  /** Vibrato fade-in/delay length, only meaningful when vibratoDepth > 0. */
  vibratoDelay: number
}

export type SoundEffectMidiDef = {
  id: number
  /** Per-note (0-127) raw sample cross-reference; 0 = unmapped. See resolveSample(). */
  sampleCode: number[]
  /** Per-note cumulative delta stream feeding the packed tuning value (low-order pass). */
  tuningCoarse: number[]
  /** Per-note cumulative delta stream feeding the packed tuning value (high-order pass, wraps intentionally). */
  tuningFine: number[]
  /** Per-note exclusive-class/choke group id, -1 = none. Only meaningful where sampleCode != 0. */
  chokeGroup: number[]
  /** Per-note pan, pre-global-curve. Only meaningful where sampleCode != 0. */
  pan: number[]
  /** Per-note volume, pre-global-curve. Only meaningful where sampleCode != 0. */
  volume: number[]
  /** Per-note index into `zones`, -1 = none. Only meaningful where sampleCode != 0. */
  zoneIndex: number[]
  /** Global instrument gain, 1..256. */
  globalGain: number
  /** Raw keyboard-wide volume curve (X,Y breakpoint pairs) baked into `volume` at runtime by the client. */
  volumeCurve?: number[]
  /** Raw keyboard-wide pan curve (X,Y breakpoint pairs) baked into `pan` at runtime by the client. */
  panCurve?: number[]
  zones: SoundEffectMidiZone[]
}

export type SoundEffectMidiData = JsonDefData<SoundEffectMidiDef>

// Mirrors Node_Sub14.method12216: code-1, bit0 selects the source index,
// the rest (>>2) is the id within that index.
export function resolveSample(sampleCode: number): { entry: 'sound_effects' | 'midi_instruments'; id: number } | null {
  if (sampleCode === 0) return null
  const code = sampleCode - 1
  return {
    entry: (code & 0x1) === 0 ? 'sound_effects' : 'midi_instruments',
    id: code >> 2,
  }
}

// Groups consecutive notes sharing every field into note-range rows —
// the raw per-note arrays are almost always run-length-friendly in
// practice (that's exactly what the archive format itself encodes).
export type SoundEffectMidiNoteRange = {
  lowNote: number
  highNote: number
  sampleCode: number
  chokeGroup: number
  pan: number
  volume: number
  zoneIndex: number
}

export function groupNoteRanges(def: SoundEffectMidiDef): SoundEffectMidiNoteRange[] {
  const ranges: SoundEffectMidiNoteRange[] = []
  for (let note = 0; note < 128; note++) {
    const row: SoundEffectMidiNoteRange = {
      lowNote: note,
      highNote: note,
      sampleCode: def.sampleCode[note] ?? 0,
      chokeGroup: def.chokeGroup[note] ?? -1,
      pan: def.pan[note] ?? 0,
      volume: def.volume[note] ?? 0,
      zoneIndex: def.zoneIndex[note] ?? -1,
    }
    const prev = ranges[ranges.length - 1]
    if (
      prev &&
      prev.sampleCode === row.sampleCode &&
      prev.chokeGroup === row.chokeGroup &&
      prev.pan === row.pan &&
      prev.volume === row.volume &&
      prev.zoneIndex === row.zoneIndex
    ) {
      prev.highNote = note
    } else {
      ranges.push(row)
    }
  }
  return ranges
}

export default makeJsonDefLoader<SoundEffectMidiDef>((id) => ({
  id,
  sampleCode: new Array(128).fill(0),
  tuningCoarse: new Array(128).fill(0),
  tuningFine: new Array(128).fill(0),
  chokeGroup: new Array(128).fill(-1),
  pan: new Array(128).fill(64),
  volume: new Array(128).fill(32),
  zoneIndex: new Array(128).fill(-1),
  globalGain: 41,
  zones: [],
}))
