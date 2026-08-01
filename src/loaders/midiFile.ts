// Standard MIDI File parser, so the music page can show what a song actually
// IS rather than just offering a download link.
//
// The cache stores songs in Jagex's compact format; cryogen decompresses each
// one into a real, standard `.mid` on dump (verified round-trip), so by the
// time it reaches us it's an ordinary SMF and every field below is the real
// thing — no cache-specific quirks to work around.
//
// Deliberately dependency-free and tolerant: a malformed or truncated track
// stops that track rather than throwing away the whole file, because a partly
// readable song is still worth showing.

/** General MIDI program names, indexed by program change value (0-127). */
export const GM_INSTRUMENTS = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]

const KEY_NAMES_MAJOR = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
const KEY_NAMES_MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m']

/** One sounding note, resolved from its note-on/note-off pair. */
export type MidiNote = {
  /** absolute tick of the note-on */
  tick: number
  /** length in ticks (0 if the file never closed it) */
  length: number
  /** MIDI pitch 0-127 */
  pitch: number
  velocity: number
  /** 0-15; channel 9 is percussion */
  channel: number
  track: number
  /** file-order index across the whole parse — see `compareEvents` */
  seq: number
}

export type MidiTrackInfo = {
  index: number
  name: string | null
  /** channels this track writes to */
  channels: number[]
  /** program numbers seen, in order of first use */
  programs: number[]
  noteCount: number
  eventCount: number
}

/**
 * A timed channel-state event. Playback needs these because which instrument a
 * note uses depends on the program AND bank select in force at that tick —
 * `MidiPcmStream` keys patches on `program + (CC0 << 14) + (CC32 << 7)`.
 */
export type MidiControlEvent = {
  tick: number
  channel: number
  kind: 'program' | 'bankMsb' | 'bankLsb' | 'bend' | 'sustain'
  /** program number, controller value, or bend as a signed 14-bit offset */
  value: number
  track: number
  /** file-order index across the whole parse — see `compareEvents` */
  seq: number
}

/**
 * Merge order for notes and controls, which live in separate arrays.
 *
 * Ties at the same tick are NOT arbitrary: cryogen's decompressor writes the
 * client's single event stream out in order, so a note that precedes a program
 * change in the file really does sound on the previous instrument. Sorting by
 * (tick, track, seq) reproduces that — `seq` is monotonic within a track, and
 * `track` breaks ties first because a sequencer merges whole tracks in order.
 *
 * Assuming "controls always win at equal ticks" instead mis-assigns the first
 * note of a phrase in roughly 1,300 of the cache's 1,662 songs.
 */
export function compareEvents(
  a: { tick: number; track: number; seq: number },
  b: { tick: number; track: number; seq: number },
): number {
  return a.tick - b.tick || a.track - b.track || a.seq - b.seq
}

export type MidiFile = {
  /** 0 = single track, 1 = simultaneous tracks, 2 = independent patterns */
  format: number
  trackCount: number
  /** ticks per quarter note (null when the file uses SMPTE timing) */
  ticksPerQuarter: number | null
  smpte: { fps: number; ticksPerFrame: number } | null
  tracks: MidiTrackInfo[]
  notes: MidiNote[]
  /** program / bank-select / pitch-bend / sustain, in tick order */
  controls: MidiControlEvent[]
  /** tempo changes as (tick, microseconds per quarter note) */
  tempos: { tick: number; usPerQuarter: number }[]
  timeSignature: { numerator: number; denominator: number } | null
  keySignature: string | null
  /** total length in ticks */
  durationTicks: number
  /** total length in seconds, resolved through the tempo map */
  durationSeconds: number
  /** first tempo as BPM, the number people expect to see */
  bpm: number | null
  byteLength: number
  /** non-fatal problems worth surfacing rather than hiding */
  warnings: string[]
}

class Reader {
  pos = 0
  view: DataView
  // an explicit field rather than a parameter property: the project builds with
  // `erasableSyntaxOnly`, which rules those out
  constructor(view: DataView) { this.view = view }
  get remaining() { return this.view.byteLength - this.pos }
  u8() { return this.view.getUint8(this.pos++) }
  u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v }
  u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v }
  str(n: number) {
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i))
    this.pos += n
    return s
  }
  /** MIDI variable-length quantity: 7 bits per byte, high bit = continue. */
  varint() {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      value = (value << 7) | (b & 0x7f)
      if ((b & 0x80) === 0) break
    }
    return value
  }
}

/** Convert an absolute tick to seconds using the tempo map. */
function tickToSeconds(tick: number, tempos: { tick: number; usPerQuarter: number }[], tpq: number): number {
  let seconds = 0
  let last = 0
  let us = 500000 // MIDI default: 120 BPM
  for (const t of tempos) {
    if (t.tick >= tick) break
    seconds += ((t.tick - last) / tpq) * (us / 1e6)
    last = t.tick
    us = t.usPerQuarter
  }
  return seconds + ((tick - last) / tpq) * (us / 1e6)
}

export function parseMidi(buffer: ArrayBuffer): MidiFile | null {
  const view = new DataView(buffer)
  const warnings: string[] = []
  if (view.byteLength < 14) return null

  const r = new Reader(view)
  if (r.str(4) !== 'MThd') return null
  const headerLength = r.u32()
  const format = r.u16()
  const trackCount = r.u16()
  const division = r.view.getInt16(r.pos); r.pos += 2
  // headers are always 6 bytes in practice; skip anything extra rather than
  // assuming, so an unusual writer doesn't desync every track after it
  if (headerLength > 6) r.pos += headerLength - 6

  let ticksPerQuarter: number | null = null
  let smpte: { fps: number; ticksPerFrame: number } | null = null
  if (division & 0x8000) {
    const fps = -(division >> 8)
    const ticksPerFrame = division & 0xff
    smpte = { fps, ticksPerFrame }
  } else {
    ticksPerQuarter = division
  }

  const tracks: MidiTrackInfo[] = []
  const notes: MidiNote[] = []
  const tempos: { tick: number; usPerQuarter: number }[] = []
  const controls: MidiControlEvent[] = []
  let timeSignature: { numerator: number; denominator: number } | null = null
  let keySignature: string | null = null
  let durationTicks = 0
  // monotonic across the whole parse; within a track it is file order, which is
  // what `compareEvents` needs to break same-tick ties correctly
  let seq = 0

  for (let t = 0; t < trackCount; t++) {
    if (r.remaining < 8) { warnings.push(`File ends after ${t} of ${trackCount} tracks.`); break }
    const id = r.str(4)
    const length = r.u32()
    if (id !== 'MTrk') {
      // unknown chunk type — the spec says skip it
      r.pos += length
      t--
      continue
    }
    const end = Math.min(r.pos + length, view.byteLength)

    const info: MidiTrackInfo = { index: t, name: null, channels: [], programs: [], noteCount: 0, eventCount: 0 }
    // pitch+channel -> the open note-on waiting for its note-off
    const open = new Map<number, MidiNote>()
    let tick = 0
    let running = 0

    try {
      while (r.pos < end) {
        tick += r.varint()
        let status = r.u8()
        if (status < 0x80) {
          // running status: reuse the last status and rewind this data byte
          r.pos--
          status = running
        } else if (status < 0xf0) {
          running = status
        }
        info.eventCount++

        if (status === 0xff) {
          const type = r.u8()
          const len = r.varint()
          const at = r.pos
          if (type === 0x51 && len >= 3) {
            tempos.push({ tick, usPerQuarter: (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2) })
          } else if (type === 0x03 && len > 0) {
            let s = ''
            for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(at + i))
            if (!info.name) info.name = s.trim() || null
          } else if (type === 0x58 && len >= 2) {
            if (!timeSignature) timeSignature = { numerator: view.getUint8(at), denominator: 2 ** view.getUint8(at + 1) }
          } else if (type === 0x59 && len >= 2) {
            if (!keySignature) {
              const sf = view.getInt8(at)
              const minor = view.getUint8(at + 1) === 1
              const idx = sf + 7
              const table = minor ? KEY_NAMES_MINOR : KEY_NAMES_MAJOR
              keySignature = table[idx] ?? null
            }
          }
          r.pos = at + len
        } else if (status === 0xf0 || status === 0xf7) {
          r.pos += r.varint()
        } else {
          const kind = status & 0xf0
          const channel = status & 0x0f
          if (!info.channels.includes(channel)) info.channels.push(channel)
          if (kind === 0x90 || kind === 0x80) {
            const pitch = r.u8()
            const velocity = r.u8()
            const key = (channel << 8) | pitch
            // note-on with velocity 0 is the conventional note-off
            if (kind === 0x90 && velocity > 0) {
              const note: MidiNote = { tick, length: 0, pitch, velocity, channel, track: t, seq: seq++ }
              open.set(key, note)
              notes.push(note)
              info.noteCount++
            } else {
              const held = open.get(key)
              if (held) { held.length = tick - held.tick; open.delete(key) }
            }
          } else if (kind === 0xc0) {
            const program = r.u8()
            if (!info.programs.includes(program)) info.programs.push(program)
            controls.push({ tick, channel, kind: 'program', value: program, track: t, seq: seq++ })
          } else if (kind === 0xd0) {
            r.pos++
          } else if (kind === 0xb0) {
            const cc = r.u8()
            const value = r.u8()
            // only the controllers playback actually acts on
            if (cc === 0) controls.push({ tick, channel, kind: 'bankMsb', value, track: t, seq: seq++ })
            else if (cc === 32) controls.push({ tick, channel, kind: 'bankLsb', value, track: t, seq: seq++ })
            else if (cc === 64) controls.push({ tick, channel, kind: 'sustain', value, track: t, seq: seq++ })
          } else if (kind === 0xe0) {
            const lsb = r.u8()
            const msb = r.u8()
            controls.push({ tick, channel, kind: 'bend', value: ((msb << 7) | lsb) - 8192, track: t, seq: seq++ })
          } else {
            r.pos += 2
          }
        }
      }
    } catch {
      warnings.push(`Track ${t} is truncated or malformed; read what was there.`)
    }

    if (open.size > 0) warnings.push(`Track ${t} leaves ${open.size} note${open.size === 1 ? '' : 's'} unclosed.`)
    if (tick > durationTicks) durationTicks = tick
    tracks.push(info)
    r.pos = end
  }

  tempos.sort((a, b) => a.tick - b.tick)
  const tpq = ticksPerQuarter ?? 480
  const durationSeconds = smpte
    ? durationTicks / (smpte.fps * smpte.ticksPerFrame)
    : tickToSeconds(durationTicks, tempos, tpq)

  return {
    format,
    trackCount,
    ticksPerQuarter,
    smpte,
    tracks,
    notes,
    controls: controls.sort((a, b) => a.tick - b.tick),
    tempos,
    timeSignature,
    keySignature,
    durationTicks,
    durationSeconds,
    bpm: tempos.length > 0 ? Math.round(60e6 / tempos[0].usPerQuarter) : (smpte ? null : 120),
    byteLength: view.byteLength,
    warnings,
  }
}

/** Seconds for an arbitrary tick — exported so the player can seek/schedule. */
export function midiTickToSeconds(midi: MidiFile, tick: number): number {
  if (midi.smpte) return tick / (midi.smpte.fps * midi.smpte.ticksPerFrame)
  return tickToSeconds(tick, midi.tempos, midi.ticksPerQuarter ?? 480)
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
