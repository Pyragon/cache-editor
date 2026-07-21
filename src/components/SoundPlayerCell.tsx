import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { SAMPLE_RATE, mixToFloat } from '../loaders/soundSynth'
import type { SoundEffectDef } from '../loaders/sound_effects'

// Mini player rendered under a sound-effect id field (NumGrid fieldExtra):
// play/pause, a seek slider and the synthesized length. The id references
// index 4 — the same sound_effects entry the SoundEffectViewer edits — and
// the PCM comes from the ported synth engine, session-cached per id.

let sharedCtx: AudioContext | null = null
const pcmCache = new Map<number, Float32Array | null>()

export function SoundPlayerCell({ cacheRoot, soundId }: {
  cacheRoot: FileSystemDirectoryHandle
  soundId: number
}) {
  const [pcm, setPcm] = useState<Float32Array | null | undefined>(pcmCache.get(soundId))
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startRef = useRef({ ctxTime: 0, offset: 0 })
  const rafRef = useRef(0)

  const duration = pcm ? pcm.length / SAMPLE_RATE : 0

  function stopPlayback() {
    const source = sourceRef.current
    sourceRef.current = null // silences onended's reset
    if (source) { try { source.stop() } catch { /* already stopped */ } }
    cancelAnimationFrame(rafRef.current)
  }

  // (Re)synthesize when the field's id changes; stop whatever was playing.
  useEffect(() => {
    let cancelled = false
    stopPlayback()
    setPlaying(false)
    setPos(0)
    const cached = pcmCache.get(soundId)
    if (cached !== undefined) { setPcm(cached); return }
    setPcm(undefined)
    ;(async () => {
      let out: Float32Array | null = null
      try {
        const dir = await resolveEntryHandle(cacheRoot, getEntryPath('sound_effects'))
        if (!dir) throw new Error('sound_effects entry not available')
        const sub = await dir.getDirectoryHandle(String(soundId))
        const file = await (await sub.getFileHandle(`${soundId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as SoundEffectDef
        out = mixToFloat(def)
      } catch { /* unreadable def — cache the miss */ }
      pcmCache.set(soundId, out)
      if (!cancelled) setPcm(out)
    })()
    return () => { cancelled = true }
    // cacheRoot is stable for a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundId])

  useEffect(() => () => stopPlayback(), [])

  function tick() {
    if (!sourceRef.current || !sharedCtx) return
    const p = startRef.current.offset + (sharedCtx.currentTime - startRef.current.ctxTime)
    setPos(Math.min(p, duration))
    rafRef.current = requestAnimationFrame(tick)
  }

  function startAt(offset: number) {
    if (!pcm || pcm.length === 0) return
    sharedCtx ??= new AudioContext({ sampleRate: SAMPLE_RATE })
    const ctx = sharedCtx
    stopPlayback()
    const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE)
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => {
      if (sourceRef.current === source) {
        sourceRef.current = null
        cancelAnimationFrame(rafRef.current)
        setPlaying(false)
        setPos(0)
      }
    }
    startRef.current = { ctxTime: ctx.currentTime, offset }
    sourceRef.current = source
    source.start(0, offset)
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }

  function pause() {
    if (!sharedCtx || !sourceRef.current) return
    const p = startRef.current.offset + (sharedCtx.currentTime - startRef.current.ctxTime)
    stopPlayback()
    setPos(Math.min(p, duration))
    setPlaying(false)
  }

  function seek(v: number) {
    setPos(v)
    if (playing) startAt(v) // paused: the next play resumes from here
  }

  if (pcm === null) return <span className="sound-cell-length">no audio</span>

  return (
    <div className="sound-cell-player">
      <button
        type="button"
        className="zoom-btn sound-cell-btn"
        disabled={!pcm}
        title={playing ? 'Pause' : `Play sound effect ${soundId}`}
        onClick={() => (playing ? pause() : startAt(pos >= duration - 0.01 ? 0 : pos))}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <input
        className="sound-cell-slider"
        type="range"
        min={0}
        max={duration || 1}
        step={0.01}
        value={Math.min(pos, duration)}
        disabled={!pcm}
        onChange={(e) => seek(parseFloat(e.target.value))}
      />
      <span className="sound-cell-length">{pcm ? `${duration.toFixed(2)}s` : '…'}</span>
    </div>
  )
}
