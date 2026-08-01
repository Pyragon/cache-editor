import { useEffect, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { SAMPLE_RATE, mixToFloat } from '../loaders/soundSynth'
import type { SoundEffectDef } from '../loaders/sound_effects'
import { SamplePlayer } from './SamplePlayer'
import { pcmToBuffer } from './sampleAudio'

// Mini player for an index-4 sound effect — the same entry SoundEffectViewer
// edits, synthesised through the ported engine and session-cached per id.
// Transport lives in SamplePlayer, shared with the index-14 sample cell.
//
// Note the id alone does NOT tell you which index a sound lives in: an object
// or NPC whose def sets the instrument flag reads the very same id out of
// midi_instruments instead. Callers pick the cell; see InstrumentPlayerCell.

const bufferCache = new Map<number, AudioBuffer | null>()

export function SoundPlayerCell({ cacheRoot, soundId }: {
  cacheRoot: FileSystemDirectoryHandle
  soundId: number
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
        const dir = await resolveEntryHandle(cacheRoot, getEntryPath('sound_effects'))
        if (!dir) throw new Error('sound_effects entry not available')
        const sub = await dir.getDirectoryHandle(String(soundId))
        const file = await (await sub.getFileHandle(`${soundId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as SoundEffectDef
        const pcm = mixToFloat(def)
        out = pcm.length > 0 ? pcmToBuffer(pcm, SAMPLE_RATE) : null
      } catch { /* unreadable def — cache the miss */ }
      bufferCache.set(soundId, out)
      if (!cancelled) setBuffer(out)
    })()
    return () => { cancelled = true }
    // cacheRoot is stable for a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundId])

  return <SamplePlayer buffer={buffer} title={`sound effect ${soundId}`} />
}
