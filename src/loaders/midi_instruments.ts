import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// One folder per instrument sample (IndexType.MIDI_INSTRUMENTS — despite the
// name, this is Ogg Vorbis audio, not General MIDI; the music sequencer
// references these ids as its voices). Dumped by cryogen MidiInstrument as
// <id>/data.json (framing metadata) + <id>/sound.ogg (a real, playable
// reconstructed Vorbis file — natively playable by the browser).
export type MidiInstrumentDef = {
  samplingRate: number
  sampleSize: number
  loopStart: number
  loopEnd: number
  duration: number
  aBool7609: boolean
}

export type MidiInstrumentData = {
  id: number
  def: MidiInstrumentDef
  oggUrl: string | null
  /** Kept so saveItem() can write the .ogg back untouched when only metadata changed. */
  oggFile: File | null
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
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

    return { id: item.id, def, oggUrl, oggFile } satisfies MidiInstrumentData
  },

  async saveItem(dirHandle, item, data) {
    const { def, oggFile } = data as MidiInstrumentData
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id), { create: true })

    const jsonHandle = await subHandle.getFileHandle('data.json', { create: true })
    const writable = await jsonHandle.createWritable()
    await writable.write(JSON.stringify(def))
    await writable.close()

    // Re-writing sound.ogg is only necessary when the audio itself changed
    // (a replace-upload) — cryogen's getActions() re-reads whatever file is
    // on disk regardless, so leaving an untouched file alone is correct too.
    // This just handles the "uploaded a new file this session" case.
    if (oggFile) {
      const oggHandle = await subHandle.getFileHandle('sound.ogg', { create: true })
      const oggWritable = await oggHandle.createWritable()
      await oggWritable.write(await oggFile.arrayBuffer())
      await oggWritable.close()
    }
  },
}

export default loader
