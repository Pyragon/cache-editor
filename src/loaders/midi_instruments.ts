import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// One folder per instrument sample (IndexType.MIDI_INSTRUMENTS — despite the
// name, this is Ogg Vorbis audio, not General MIDI; the music sequencer
// references these ids as its voices). Dumped by cryogen MidiInstrument as
// <id>/data.json (framing metadata + the raw Vorbis packets) and
// <id>/sound.ogg (a reconstructed Vorbis file).
//
// Two dumper bugs were fixed in cryogen on 2026-08-01 and NEED A RE-DUMP: the
// .ogg's granule positions were the packet index rather than a running sample
// count (so players read the duration as a few milliseconds), and `duration`
// was derived from that same bad figure at 1,000 samples per packet. Until the
// re-dump lands, an existing dump still carries both — which costs nothing
// here, since the viewer decodes the packets and measures the audio itself.
export type MidiInstrumentDef = {
  samplingRate: number
  /** Number of samples in the decoded audio. */
  sampleSize: number
  /** Loop region start, in samples at `samplingRate`. */
  loopStart: number
  /** Loop region end, in samples. Equals sampleSize on every instrument in
   *  this cache: they all sustain from loopStart to the end. */
  loopEnd: number
  /** Length in seconds, derived at dump time from sampleSize / samplingRate. */
  duration: number
  /**
   * Whether the sample loops at all. Not a field of its own on the wire: a
   * NEGATIVE `end` means "loops", and the real end is `~end`.
   */
  loopConsistency?: boolean
  /** @deprecated pre-2026-08-01 dumps called this `aBool7609`. */
  aBool7609?: boolean
  /** Raw Vorbis packets, kept verbatim so a metadata-only save can't drop them. */
  packets?: number[][]
}

/** The loop flag under whichever name this dump used. */
export function loopEnabled(def: MidiInstrumentDef): boolean {
  return def.loopConsistency ?? def.aBool7609 ?? false
}

/** Write back under the name the dump already uses, so a save doesn't quietly
 *  migrate the file's field names as a side effect of a checkbox. */
export function withLoopEnabled(def: MidiInstrumentDef, value: boolean): MidiInstrumentDef {
  return def.loopConsistency !== undefined || def.aBool7609 === undefined
    ? { ...def, loopConsistency: value }
    : { ...def, aBool7609: value }
}

export type MidiInstrumentData = {
  id: number
  def: MidiInstrumentDef
  oggUrl: string | null
  /** Kept so saveItem() can write the .ogg back untouched when only metadata changed. */
  oggFile: File | null
  /** Needed to resolve which banks reference this instrument. */
  rootHandle?: FileSystemDirectoryHandle
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const jsonHandle = await subHandle.getFileHandle('data.json')
    const jsonFile = await jsonHandle.getFile()
    const def = JSON.parse(await jsonFile.text()) as MidiInstrumentDef

    let oggUrl: string | null = null
    let oggFile: File | null = null
    try {
      const oggHandle = await subHandle.getFileHandle('sound.ogg')
      oggFile = await oggHandle.getFile()
      oggUrl = URL.createObjectURL(oggFile)
    } catch {
      // no dumped preview
    }

    return { id: item.id, def, oggUrl, oggFile, rootHandle } satisfies MidiInstrumentData
  },

  async saveItem(dirHandle, item, data) {
    const { def, oggFile } = data as MidiInstrumentData
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id), { create: true })

    const jsonHandle = await subHandle.getFileHandle('data.json', { create: true })
    const writable = await jsonHandle.createWritable()
    // `def` carries `packets` (and `id`) through untouched from the load — the
    // TypeScript type is narrower than the file, and stringifying the whole
    // object rather than a picked subset is what keeps the audio data intact.
    await writable.write(JSON.stringify(def))
    await writable.close()

    // Re-writing sound.ogg is only necessary when the audio itself changed
    // (a replace-upload) — cryogen's getActions() re-reads whatever file is
    // on disk regardless, so leaving an untouched file alone is correct too.
    if (oggFile) {
      const oggHandle = await subHandle.getFileHandle('sound.ogg', { create: true })
      const oggWritable = await oggHandle.createWritable()
      await oggWritable.write(await oggFile.arrayBuffer())
      await oggWritable.close()
    }
  },
}

export default loader
