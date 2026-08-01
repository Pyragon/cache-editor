import { useEffect, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { SamplePlayer } from './SamplePlayer'
import { sampleAudioContext } from './sampleAudio'

// Mini player for an index-14 (midi_instruments) sample — the sibling of
// SoundPlayerCell's index-4 synth player. Transport lives in SamplePlayer.
//
// A cutscene's PLAY_VORBIS action reads from THIS index, not the empty index
// 36: "vorbis" names the format (a streamed Ogg sample) as opposed to index
// 4's additive synth. The client picks between them on AreaSound.type — type 1
// goes to Resource.SOUND_EFFECT, while types 2 (vorbis) and 3 (voice-over) are
// `spoken()` and go to Resource.MIDI_INSTRUMENT (AreaSoundPlayer:59 vs :67).
// Object and NPC ambient sounds take the same fork on their instrument flag.
//
// Decoded rather than handed to an <audio> element, so it doesn't depend on the
// container's granule positions.

const bufferCache = new Map<number, AudioBuffer | null>()

export function InstrumentPlayerCell({ cacheRoot, soundId, label }: {
  cacheRoot: FileSystemDirectoryHandle
  soundId: number
  label?: string
}) {
  const [buffer, setBuffer] = useState<AudioBuffer | null | undefined>(bufferCache.get(soundId))

  useEffect(() => {
    let cancelled = false
    const cached = bufferCache.get(soundId)
    if (cached !== undefined) { setBuffer(cached); return }
    setBuffer(undefined)
    void (async () => {
      let out: AudioBuffer | null = null
      try {
        const dir = await resolveEntryHandle(cacheRoot, getEntryPath('midi_instruments'))
        if (!dir) throw new Error('midi_instruments entry not available')
        const sub = await dir.getDirectoryHandle(String(soundId))
        const file = await (await sub.getFileHandle('sound.ogg')).getFile()
        out = await sampleAudioContext().decodeAudioData(await file.arrayBuffer())
      } catch { /* missing or undecodable — cache the miss */ }
      bufferCache.set(soundId, out)
      if (!cancelled) setBuffer(out)
    })()
    return () => { cancelled = true }
    // cacheRoot is stable for a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundId])

  return <SamplePlayer buffer={buffer} title={label ?? `instrument sample ${soundId}`} />
}
