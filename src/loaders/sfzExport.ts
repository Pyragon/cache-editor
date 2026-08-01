// Exporting the cache's instrument banks as an SFZ pack.
//
// ⚠️ NOT WIRED TO ANY UI (2026-07-31). The export buttons were pulled from
// MusicViewer and SoundEffectViewer pending input from someone who actually
// composes — the open question is what a useful export looks like in practice,
// not whether the mapping is right. The module is kept because the hard part
// (the mapping below) is verified against the real dump; re-adding a button is
// a few lines. See TODO.md and docs/music-synth.md.
//
// A song downloaded from the music viewer is a real, standard MIDI file, so any
// DAW opens it — but it plays through that DAW's General MIDI soundfont and
// sounds nothing like the game. This module closes that gap: it writes the
// cache's own banks out as SFZ instruments plus the samples they reference, so
// the song can be edited in Reaper/LMMS/MuseScore with the real instruments and
// uploaded straight back.
//
// SFZ rather than SF2, for three reasons: it reads `.ogg` directly (the
// referenced instruments are ~52 MB as ogg vs ~463 MB decoded to PCM), it is
// plain text so there is nothing to get subtly wrong in a binary writer, and it
// is not boxed into SF2's fixed DAHDSR envelope shape.
//
// ## Bank addressing
//
// The client keys patches on `program + (CC0 << 14) + (CC32 << 7)`. Across every
// song in the cache CC0 is always 0, so the space is really 14 banks (CC32 0-13)
// of 128 programs. Each bank archive becomes one `<key>.sfz`; the README written
// alongside explains the CC32/program split, since SFZ has no bank concept of
// its own — the host loads one .sfz per track.
//
// ## What is exact and what is approximated
//
// Exact: note-to-sample mapping, per-note tuning (via `pitch_keycenter` + `tune`),
// loop flag and loop points, pan, relative volume, choke groups, and the vibrato
// LFO (rate, depth and fade-in all have closed forms — see below).
//
// Approximated: the amplitude envelopes. The client walks arbitrary X,Y
// breakpoint arrays with a pitch-scaled step, and additionally applies a
// continuous exponential decay. SFZ's `ampeg_` is a fixed DAHDSR, so the curve
// is fitted to attack/decay/sustain/release. Because we emit one region per note
// rather than per key-range, the fit is computed at each note's own pitch, which
// is as close as a DAHDSR gets. Audition in the music viewer, which runs the
// faithful worklet port, before trusting the SFZ for anything exacting.
//
// Not represented at all: CC16 (sample start offset) and CC17/CC81 (retrigger
// LFO). Those are channel controllers rather than bank data — they live in the
// MIDI and survive the round trip, they just will not be *heard* in the DAW.
// See docs/music-synth.md.
import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { resolveSample } from './sound_effects_midi'
import type { SoundEffectMidiDef, SoundEffectMidiZone } from './sound_effects_midi'
import type { SoundEffectDef } from './sound_effects'
import type { MidiFile } from './midiFile'
import { compareEvents } from './midiFile'
import { SAMPLE_RATE as SFX_SAMPLE_RATE, mixToFloat } from './soundSynth'

// ---------------------------------------------------------------------------
// Timebase constants, all mirrored from MidiPcmStream / our worklet port
// ---------------------------------------------------------------------------

/** One envelope tick is sampleRate/100, i.e. 10 ms. */
const TICK_MS = 10
/** `pitchScalar = ENV_PITCH_SCALAR * ((note - 60) << 8)` — envelope key tracking. */
const ENV_PITCH_SCALAR = 5.086263020833333e-6
/**
 * Envelope X breakpoints are compared as `X << 8` and the position advances by
 * `128 * 2^(pitchScalar * rate)` per tick, so one X unit is two ticks at rate 0.
 */
const MS_PER_X_UNIT = (256 / 128) * TICK_MS
/** The 512-step vibrato LFO table, stepped once per tick. */
const VIBRATO_TABLE_STEPS = 512
/** `pitch` is in 1/256 of a semitone (the client raises 2 to `pitch / 3072`). */
const PITCH_UNITS_PER_SEMITONE = 256
/** Loudest `volume * globalGain` product in the whole index — our 0 dB reference. */
const GAIN_REFERENCE = 4096
/** Per-note pan is 0..128 with 64 as centre. */
const PAN_CENTRE = 64

/** Envelope-rate scaling at a given note: >1 means the envelope runs faster. */
function envRateScale(note: number, rate: number): number {
  return Math.pow(2, ENV_PITCH_SCALAR * ((note - 60) << 8) * rate)
}

/** Milliseconds per envelope X unit for a given note and rate. */
function msPerX(note: number, rate: number): number {
  return MS_PER_X_UNIT / envRateScale(note, rate)
}

// ---------------------------------------------------------------------------
// Which banks and notes a song actually needs
// ---------------------------------------------------------------------------

export type SongBankUsage = {
  /** patch keys the song plays, ascending */
  keys: number[]
  /** patch key -> the note numbers it actually strikes */
  notesByKey: Map<number, Set<number>>
}

/**
 * Replay the song's channel state to find which (patch key, note) pairs it
 * really uses, so an export can carry only what the song needs. Mirrors
 * `MidiPcmStream`: `program + (CC0 << 14) + (CC32 << 7)`, with channel 9
 * defaulting to bank select 128 (`initDrumChannel`).
 *
 * Same-tick ties are resolved by `compareEvents` (file order), not by assuming a
 * program change beats a note written before it — songs really do rely on this,
 * e.g. `music/154` channel 5's first note shares tick 15840 with its program
 * change and sounds on the previous instrument.
 */
export function songBankUsage(midi: MidiFile): SongBankUsage {
  type Step = { tick: number; track: number; seq: number; note: number; channel: number; kind: string; value: number }
  const steps: Step[] = []
  for (const c of midi.controls) {
    steps.push({ tick: c.tick, track: c.track, seq: c.seq, note: -1, channel: c.channel, kind: c.kind, value: c.value })
  }
  for (const n of midi.notes) {
    steps.push({ tick: n.tick, track: n.track, seq: n.seq, note: n.pitch, channel: n.channel, kind: 'note', value: 0 })
  }
  steps.sort(compareEvents)

  const program = new Array(16).fill(0)
  const cc0 = new Array(16).fill(0)
  const cc32 = new Array(16).fill(0)
  cc32[9] = 1 // channel 9 starts on bank select 128

  const notesByKey = new Map<number, Set<number>>()
  for (const s of steps) {
    switch (s.kind) {
      case 'program': program[s.channel] = s.value; break
      case 'bankMsb': cc0[s.channel] = s.value; break
      case 'bankLsb': cc32[s.channel] = s.value; break
      case 'note': {
        const key = program[s.channel] + (cc0[s.channel] << 14) + (cc32[s.channel] << 7)
        let set = notesByKey.get(key)
        if (!set) { set = new Set(); notesByKey.set(key, set) }
        set.add(s.note)
        break
      }
    }
  }
  return { keys: [...notesByKey.keys()].sort((a, b) => a - b), notesByKey }
}

// ---------------------------------------------------------------------------
// Envelope fitting
// ---------------------------------------------------------------------------

type AmpEg = { attack: number; decay: number; sustain: number; release: number }

/**
 * Fit the client's breakpoint envelopes onto SFZ's DAHDSR.
 *
 * The sustain curve is read as attack-to-peak then decay-to-final. A final Y of
 * 0 means the client kills the voice there, which is a one-shot: sustain 0.
 * `decayRate` is a separate continuous exponential (`0.5 ^ (t * 1.953125e-5 *
 * decayRate)`, accumulator stepped at the *vibrato* rate — see the field-name
 * warning in docs/music-synth.md); when it is the faster of the two it wins.
 */
function fitAmpEg(zone: SoundEffectMidiZone | null, note: number): AmpEg {
  const eg: AmpEg = { attack: 0, decay: 0, sustain: 100, release: 0.05 }
  if (!zone) return eg

  const sus = zone.sustainEnvelope
  if (sus && sus.length >= 4) {
    const ms = msPerX(note, zone.sustainRate ?? 0)
    let peakIdx = 0
    let peakY = -1
    for (let i = 0; i < sus.length - 1; i += 2) {
      const y = sus[i + 1] & 0xff
      if (y > peakY) { peakY = y; peakIdx = i }
    }
    const x0 = sus[0] & 0xff
    const xPeak = sus[peakIdx] & 0xff
    const xEnd = sus[sus.length - 2] & 0xff
    const yEnd = sus[sus.length - 1] & 0xff
    eg.attack = Math.max(0, (xPeak - x0) * ms) / 1000
    eg.decay = Math.max(0, (xEnd - xPeak) * ms) / 1000
    eg.sustain = peakY > 0 ? Math.round((yEnd / peakY) * 100) : 0
  }

  const decayRate = zone.decayRate ?? 0
  if (decayRate > 0) {
    // accumulator advances by 128 * 2^(pitchScalar * vibratoRate) per tick
    const perTick = 128 * envRateScale(note, zone.vibratoRate ?? 0)
    // amplitude half-life, then take three of them as "effectively decayed"
    const halfLifeTicks = 51200 / (decayRate * perTick)
    const decaySeconds = (3 * halfLifeTicks * TICK_MS) / 1000
    if (eg.sustain === 100 || decaySeconds < eg.decay) {
      eg.decay = decaySeconds
      eg.sustain = 0
    }
  }

  const rel = zone.releaseEnvelope
  if (rel && rel.length >= 4) {
    const ms = msPerX(note, zone.releaseRate ?? 0)
    const span = (rel[rel.length - 2] & 0xff) - (rel[0] & 0xff)
    eg.release = Math.max(0.001, span * ms) / 1000
  }
  return eg
}

type PitchLfo = { freq: number; depthCents: number; fade: number } | null

/**
 * `calculatePitch`: the LFO amplitude is `vibratoDepth << 2` in 1/256-semitone
 * units, its phase steps by `vibratoRate` per tick around a 512-entry table,
 * and it ramps in linearly over `vibratoDelay << 1` ticks.
 */
function fitPitchLfo(zone: SoundEffectMidiZone | null): PitchLfo {
  if (!zone) return null
  const rate = zone.vibratoRate ?? 0
  const depth = zone.vibratoDepth ?? 0
  if (rate <= 0 || depth <= 0) return null
  const freq = (rate / VIBRATO_TABLE_STEPS) * (1000 / TICK_MS)
  const depthCents = ((depth << 2) / PITCH_UNITS_PER_SEMITONE) * 100
  const fade = ((zone.vibratoDelay ?? 0) << 1) * (TICK_MS / 1000)
  return { freq, depthCents: Math.min(1200, depthCents), fade }
}

// ---------------------------------------------------------------------------
// SFZ text
// ---------------------------------------------------------------------------

export type SampleRef = { entry: 'sound_effects' | 'midi_instruments'; id: number }

/** Stable on-disk name for a sample, so two banks sharing one sample share a file. */
export function sampleFileName(ref: SampleRef): string {
  return ref.entry === 'midi_instruments' ? `inst_${ref.id}.ogg` : `sfx_${ref.id}.wav`
}

/** Loop metadata read from `midi_instruments/<id>/data.json`. */
export type InstrumentMeta = { samplingRate: number; loopStart: number; loopEnd: number }

function fmt(n: number, places = 3): string {
  const r = Number(n.toFixed(places))
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * One `<region>` per mapped note. Grouping consecutive notes into key ranges
 * would be smaller, but each note carries its own tuning delta and the runs are
 * only *usually* chromatic — per-note regions are exact with no special cases,
 * and 128 lines of text costs nothing.
 */
export function sfzForBank(
  def: SoundEffectMidiDef,
  key: number,
  meta: Map<number, InstrumentMeta>,
  onlyNotes?: Set<number>,
): { text: string; refs: SampleRef[]; regions: number } {
  const lines: string[] = []
  const refs: SampleRef[] = []
  const seen = new Set<string>()
  const globalGain = def.globalGain ?? 41

  lines.push(`// RuneScape 2 (727) instrument bank ${key} — exported by cache-editor`)
  lines.push(`// cache index 15 archive ${key}; select in-game as CC32=${key >> 7}, program=${key & 0x7f}`)
  lines.push(`// ${def.zones?.length ?? 0} zones, globalGain ${globalGain}`)
  lines.push('')
  lines.push('<control>')
  lines.push('default_path=samples/')
  lines.push('')

  let regions = 0
  for (let note = 0; note < 128; note++) {
    const code = def.sampleCode[note] ?? 0
    if (!code) continue
    if (onlyNotes && !onlyNotes.has(note)) continue
    const ref = resolveSample(code)
    if (!ref) continue

    const fileName = sampleFileName(ref)
    if (!seen.has(fileName)) { seen.add(fileName); refs.push(ref) }

    // MusicPatch:149/157/177 assemble a signed short; the sign is the loop flag
    const coarse = def.tuningCoarse[note] ?? 0
    const fine = def.tuningFine[note] ?? 0
    const packed = (coarse + (fine << 8) + (((code - 1) & 0x2) << 14)) & 0xffff
    const signed = packed >= 0x8000 ? packed - 0x10000 : packed
    const looped = signed < 0

    // rate = 2^(((note << 8) - (packed & 0x7fff)) / 3072); SFZ gives
    // 2^((key - pitch_keycenter)/12) * 2^(tune/1200), so keycenter - tune/100
    // must equal (packed & 0x7fff) / 256.
    const semis = (packed & 0x7fff) / PITCH_UNITS_PER_SEMITONE
    const keycenter = Math.min(127, Math.max(0, Math.round(semis)))
    const tuneCents = (keycenter - semis) * 100

    const volume = def.volume[note] ?? 0
    const gain = (volume * globalGain) / GAIN_REFERENCE
    const volumeDb = gain > 0 ? Math.max(-60, 20 * Math.log10(gain)) : -60

    const pan = ((def.pan[note] ?? PAN_CENTRE) & 0xff)
    const panSfz = Math.max(-100, Math.min(100, ((pan - PAN_CENTRE) / PAN_CENTRE) * 100))

    const zoneIndex = def.zoneIndex[note] ?? -1
    const zone = zoneIndex >= 0 ? (def.zones?.[zoneIndex] ?? null) : null
    const eg = fitAmpEg(zone, note)
    const lfo = fitPitchLfo(zone)

    const parts = [
      '<region>',
      `sample=${fileName}`,
      `lokey=${note}`,
      `hikey=${note}`,
      `pitch_keycenter=${keycenter}`,
      `tune=${fmt(tuneCents, 1)}`,
      `volume=${fmt(volumeDb, 2)}`,
      `pan=${fmt(panSfz, 1)}`,
    ]

    if (looped) {
      const m = ref.entry === 'midi_instruments' ? meta.get(ref.id) : undefined
      parts.push('loop_mode=loop_continuous')
      if (m && m.loopEnd > m.loopStart) {
        parts.push(`loop_start=${m.loopStart}`, `loop_end=${m.loopEnd}`)
      }
    } else {
      parts.push('loop_mode=no_loop')
    }

    parts.push(
      `ampeg_attack=${fmt(eg.attack)}`,
      `ampeg_decay=${fmt(eg.decay)}`,
      `ampeg_sustain=${fmt(eg.sustain, 1)}`,
      `ampeg_release=${fmt(eg.release)}`,
    )

    const choke = def.chokeGroup[note] ?? -1
    if (choke >= 0) {
      // SFZ treats group 0 as "no group", so shift the client's 0-based ids up
      parts.push(`group=${choke + 1}`, `off_by=${choke + 1}`)
    }

    if (lfo) {
      parts.push(`pitchlfo_freq=${fmt(lfo.freq, 3)}`, `pitchlfo_depth=${fmt(lfo.depthCents, 1)}`)
      if (lfo.fade > 0) parts.push(`pitchlfo_fade=${fmt(lfo.fade, 3)}`)
    }

    lines.push(parts.join(' '))
    regions++
  }

  lines.push('')
  return { text: lines.join('\n'), refs, regions }
}

// ---------------------------------------------------------------------------
// WAV writing (for the sound_effects half — the ogg half is copied verbatim)
// ---------------------------------------------------------------------------

/** 16-bit mono PCM WAV. Uses the correct float conversion, not toWAV's quirk. */
export function floatToWav16(data: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + data.length * 2))
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + data.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, data.length * 2, true)
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// The export itself
// ---------------------------------------------------------------------------

export type SfzExportOptions = {
  /** Restrict to these patch keys (e.g. the ones a song uses). Omit for all. */
  banks?: number[]
  /** Per key, restrict to these notes. Shrinks the sample set considerably. */
  notesByKey?: Map<number, Set<number>>
  /** Free-text line for the README, e.g. which song this was exported for. */
  subject?: string
  onProgress?: (message: string, done: number, total: number) => void
  signal?: AbortSignal
}

export type SfzExportReport = {
  banks: number
  regions: number
  samples: number
  bytes: number
  warnings: string[]
}

async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T> {
  return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as T
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array<ArrayBuffer> | string) {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  // BlobPart is happy with either; going through Blob avoids a BufferSource cast
  await writable.write(new Blob([data]))
  await writable.close()
}

export async function exportSfzPack(
  root: FileSystemDirectoryHandle,
  out: FileSystemDirectoryHandle,
  options: SfzExportOptions = {},
): Promise<SfzExportReport> {
  const { banks, notesByKey, subject, onProgress, signal } = options
  const warnings: string[] = []
  const check = () => { if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError') }

  const bankDir = await resolveEntryHandle(root, getEntryPath('sound_effects_midi'))
  if (!bankDir) throw new Error('This cache has no sound_effects_midi folder — nothing to export.')
  const instDir = await resolveEntryHandle(root, getEntryPath('midi_instruments'))
  const sfxDir = await resolveEntryHandle(root, getEntryPath('sound_effects'))

  // 1. which bank archives are we writing?
  let keys: number[]
  if (banks?.length) {
    keys = [...banks].sort((a, b) => a - b)
  } else {
    keys = []
    for await (const entry of bankDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        const n = Number.parseInt(entry.name, 10)
        if (Number.isFinite(n)) keys.push(n)
      }
    }
    keys.sort((a, b) => a - b)
  }

  // 2. load the defs, then the loop metadata for every instrument they touch
  const defs = new Map<number, SoundEffectMidiDef>()
  for (const key of keys) {
    check()
    try {
      defs.set(key, await readJson<SoundEffectMidiDef>(bankDir, `${key}.json`))
    } catch {
      warnings.push(`bank ${key} is referenced but missing from this dump — skipped`)
    }
  }

  const instMeta = new Map<number, InstrumentMeta>()
  for (const [key, def] of defs) {
    for (let note = 0; note < 128; note++) {
      const code = def.sampleCode[note] ?? 0
      if (!code) continue
      if (notesByKey?.get(key) && !notesByKey.get(key)!.has(note)) continue
      const ref = resolveSample(code)
      if (!ref || ref.entry !== 'midi_instruments' || instMeta.has(ref.id) || !instDir) continue
      check()
      try {
        const sub = await instDir.getDirectoryHandle(String(ref.id))
        const m = await readJson<Partial<InstrumentMeta>>(sub, 'data.json')
        instMeta.set(ref.id, {
          samplingRate: m.samplingRate ?? 22050,
          loopStart: m.loopStart ?? 0,
          loopEnd: m.loopEnd ?? 0,
        })
      } catch {
        // loop points are optional — the region just plays one-shot
      }
    }
  }

  // 3. write the .sfz files, collecting the samples they need
  const needed = new Map<string, SampleRef>()
  let regions = 0
  let written = 0
  for (const [key, def] of defs) {
    check()
    const { text, refs, regions: n } = sfzForBank(def, key, instMeta, notesByKey?.get(key))
    if (n === 0) continue
    await writeFile(out, `bank_${key}.sfz`, text)
    for (const ref of refs) needed.set(sampleFileName(ref), ref)
    regions += n
    written++
    onProgress?.(`bank ${key}`, written, defs.size)
  }

  // 4. copy/render the samples
  const sampleDir = await out.getDirectoryHandle('samples', { create: true })
  let bytes = 0
  let done = 0
  const total = needed.size
  for (const [name, ref] of needed) {
    check()
    try {
      if (ref.entry === 'midi_instruments') {
        if (!instDir) throw new Error('no midi_instruments folder')
        const sub = await instDir.getDirectoryHandle(String(ref.id))
        const file = await (await sub.getFileHandle('sound.ogg')).getFile()
        const buf = new Uint8Array(await file.arrayBuffer())
        await writeFile(sampleDir, name, buf)
        bytes += buf.length
      } else {
        if (!sfxDir) throw new Error('no sound_effects folder')
        const sub = await sfxDir.getDirectoryHandle(String(ref.id))
        const def = await readJson<SoundEffectDef>(sub, `${ref.id}.json`)
        const wav = floatToWav16(mixToFloat(def), SFX_SAMPLE_RATE)
        await writeFile(sampleDir, name, wav)
        bytes += wav.length
      }
    } catch {
      warnings.push(`sample ${name} could not be exported — regions using it will be silent`)
    }
    done++
    if (done % 10 === 0 || done === total) onProgress?.(`sample ${done}/${total}`, done, total)
  }

  await writeFile(out, 'README.md', readme({ keys: [...defs.keys()], regions, samples: total, subject, warnings }))

  return { banks: written, regions, samples: total, bytes, warnings }
}

// ---------------------------------------------------------------------------
// The sound_effects index as its own pack
// ---------------------------------------------------------------------------

/** How many effects share one .sfz — an SFZ instrument has 128 keys. */
const SFX_PER_FILE = 128

export type SoundEffectPackOptions = {
  /** Restrict to these effect ids. Omit for the whole index (~529 MB). */
  ids?: number[]
  onProgress?: (message: string, done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Export `sound_effects` (index 4) as WAVs plus SFZ files that make them
 * playable from a DAW.
 *
 * These are one-shot additive-synthesis effects for ambient/NPC sound, not
 * melodic instruments, so there is no per-note tuning to reconstruct: each
 * effect gets one key at its natural pitch. Ids are laid out 128 to a file, so
 * effect `id` lands on key `id % 128` of `sfx_<block start>-<block end>.sfz`.
 *
 * Rendered through `mixToFloat`, which is the correct conversion — not
 * `toWavDataBytes`, which reproduces a quirk in cryogen's own dumped previews.
 */
export async function exportSoundEffectPack(
  root: FileSystemDirectoryHandle,
  out: FileSystemDirectoryHandle,
  options: SoundEffectPackOptions = {},
): Promise<SfzExportReport> {
  const { ids, onProgress, signal } = options
  const warnings: string[] = []
  const check = () => { if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError') }

  const sfxDir = await resolveEntryHandle(root, getEntryPath('sound_effects'))
  if (!sfxDir) throw new Error('This cache has no sound_effects folder — nothing to export.')

  let list: number[]
  if (ids?.length) {
    list = [...ids].sort((a, b) => a - b)
  } else {
    list = []
    for await (const entry of sfxDir.values()) {
      if (entry.kind !== 'directory') continue
      const n = Number.parseInt(entry.name, 10)
      if (Number.isFinite(n)) list.push(n)
    }
    list.sort((a, b) => a - b)
  }

  const sampleDir = await out.getDirectoryHandle('samples', { create: true })
  const blocks = new Map<number, string[]>()
  let bytes = 0
  let regions = 0
  let done = 0
  // 157 of the ~10,241 ids are empty folders in a real dump, and a few more
  // synthesise to nothing — expected, so they get one summary line rather than
  // one warning each
  let emptyCount = 0
  let silentCount = 0

  for (const id of list) {
    check()
    try {
      const sub = await sfxDir.getDirectoryHandle(String(id))
      const def = await readJson<SoundEffectDef>(sub, `${id}.json`)
      const pcm = mixToFloat(def)
      if (pcm.length === 0) {
        silentCount++
        done++
        continue
      }
      const wav = floatToWav16(pcm, SFX_SAMPLE_RATE)
      const name = `sfx_${id}.wav`
      await writeFile(sampleDir, name, wav)
      bytes += wav.length

      const block = Math.floor(id / SFX_PER_FILE)
      let lines = blocks.get(block)
      if (!lines) { lines = []; blocks.set(block, lines) }
      const key = id % SFX_PER_FILE
      const looped = def.loopEnd > def.loopBegin
      lines.push(
        `<region> sample=${name} lokey=${key} hikey=${key} pitch_keycenter=${key} `
        + `loop_mode=${looped ? 'loop_continuous' : 'no_loop'} `
        + `ampeg_attack=0 ampeg_decay=0 ampeg_sustain=100 ampeg_release=0.05 // effect ${id}`,
      )
      regions++
    } catch {
      emptyCount++
    }
    done++
    if (done % 25 === 0 || done === list.length) onProgress?.(`effect ${done}/${list.length}`, done, list.length)
  }

  if (emptyCount) warnings.push(`${emptyCount} id(s) had no definition on disk (empty folders in the dump) — skipped`)
  if (silentCount) warnings.push(`${silentCount} effect(s) synthesise to zero samples — skipped`)

  for (const [block, lines] of blocks) {
    check()
    const lo = block * SFX_PER_FILE
    const hi = lo + SFX_PER_FILE - 1
    const text = [
      `// RuneScape 2 (727) sound effects ${lo}-${hi} — exported by cache-editor`,
      `// cache index 4. Effect id lands on key (id % ${SFX_PER_FILE}), so key 0 here is effect ${lo}.`,
      '',
      '<control>',
      'default_path=samples/',
      '',
      ...lines,
      '',
    ].join('\n')
    await writeFile(out, `sfx_${lo}-${hi}.sfz`, text)
  }

  await writeFile(out, 'README.md', sfxReadme({ count: regions, files: blocks.size, warnings }))
  return { banks: blocks.size, regions, samples: regions, bytes, warnings }
}

function sfxReadme(info: { count: number; files: number; warnings: string[] }): string {
  return `# RuneScape 2 (727) sound effects

${info.count} effects across ${info.files} SFZ file(s), plus the rendered WAVs in \`samples/\`.

These are cache index 4 — the additive-synthesis one-shots used for ambient and
NPC sound, and (for a handful of percussion slots) by the music system. They are
not melodic instruments, so each one sits on a single key at its natural pitch
rather than being stretched across a keyboard.

Effect \`id\` is on key \`id % ${SFX_PER_FILE}\` of \`sfx_<lo>-<hi>.sfz\`, where
\`lo = floor(id / ${SFX_PER_FILE}) * ${SFX_PER_FILE}\` and \`hi = lo + ${SFX_PER_FILE - 1}\`.
Effect 3452, for example, is key ${3452 % SFX_PER_FILE} of \`sfx_3328-3455.sfz\`.

The WAVs are rendered from the synth definitions at ${SFX_SAMPLE_RATE} Hz using
the correct 16-bit conversion — not the quirky one cryogen's own \`.wav\`
previews use, so these may differ very slightly from the dumped files.
${info.warnings.length ? `\n## Notes\n\n${info.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}`
}

function readme(info: { keys: number[]; regions: number; samples: number; subject?: string; warnings: string[] }): string {
  const banksLine = info.keys.length > 24
    ? `${info.keys.length} banks (${info.keys[0]}–${info.keys[info.keys.length - 1]})`
    : info.keys.map((k) => `bank_${k}.sfz`).join(', ')
  return `# RuneScape 2 (727) instrument pack

${info.subject ? `Exported for ${info.subject}.\n\n` : ''}${banksLine}
${info.regions} regions, ${info.samples} samples.

## Loading these

Each \`bank_<key>.sfz\` is one instrument. Load them with any SFZ player —
[sforzando](https://www.plogue.com/products/sforzando.html) is free and runs as a
VST/AU in any DAW; LinuxSampler, Sfizz and Bitwig's sampler also read SFZ.

The cache addresses instruments as \`program + (CC32 << 7)\` — CC0 is never used.
So a bank key splits as:

    CC32 = key >> 7        program = key & 127

To play an exported song: open the \`.mid\`, and for each track look at its
program change and bank-select (CC32) messages, compute the key, and load the
matching \`bank_<key>.sfz\` on that track. Channel 10 (percussion) starts on
CC32 = 1, i.e. keys 128-255, even with no bank-select message.

## Fidelity

Exact: note-to-sample mapping, per-note tuning, loop points, pan, relative
volume, choke groups, vibrato rate/depth/fade.

Approximated: amplitude envelopes. The client walks arbitrary breakpoint curves
with pitch-scaled timing plus a continuous exponential decay; SFZ has a fixed
DAHDSR, so these are fitted per note. Expect close, not identical.

Absent: CC16 (sample start offset) and CC17/CC81 (retrigger LFO) are channel
controllers the client implements and SFZ players do not. They survive in the
MIDI file, they just will not be heard here. Around 50 songs use them.

Audition in the cache editor's music viewer for the authoritative sound — it
runs a faithful port of the client's mixer.
${info.warnings.length ? `\n## Warnings\n\n${info.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}`
}
