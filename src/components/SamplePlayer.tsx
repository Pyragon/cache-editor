import { useEffect, useRef, useState } from 'react'
import { sampleAudioContext } from './sampleAudio'

// Transport for a decoded audio buffer: play/pause, a seek slider and the
// length. Shared by the two sound cells, which differ only in where their
// audio comes from —
//
//   SoundPlayerCell        index 4  synthesised from a SoundEffectDef
//   InstrumentPlayerCell   index 14 decoded from a sample's sound.ogg
//
// — and had no business each owning a copy of the play/pause/seek logic.
//
// `undefined` means still loading, `null` means there is nothing to play.

export function SamplePlayer({ buffer, title, className }: {
  buffer: AudioBuffer | null | undefined
  /** what the play button says it will play, for the tooltip */
  title: string
  className?: string
}) {
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startRef = useRef({ ctxTime: 0, offset: 0 })
  const rafRef = useRef(0)

  const duration = buffer ? buffer.duration : 0

  function stopPlayback() {
    const source = sourceRef.current
    sourceRef.current = null // silences onended's reset
    if (source) { try { source.stop() } catch { /* already stopped */ } }
    cancelAnimationFrame(rafRef.current)
  }

  // a new buffer means a different sound — never keep playing the old one
  useEffect(() => {
    stopPlayback()
    setPlaying(false)
    setPos(0)
  }, [buffer])

  useEffect(() => () => stopPlayback(), [])

  function tick() {
    if (!sourceRef.current) return
    const ctx = sampleAudioContext()
    setPos(Math.min(startRef.current.offset + (ctx.currentTime - startRef.current.ctxTime), duration))
    rafRef.current = requestAnimationFrame(tick)
  }

  function startAt(offset: number) {
    if (!buffer || buffer.length === 0) return
    const ctx = sampleAudioContext()
    void ctx.resume()
    stopPlayback()
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
    source.start(0, Math.max(0, Math.min(offset, Math.max(0, duration - 0.001))))
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }

  function pause() {
    if (!sourceRef.current) return
    const ctx = sampleAudioContext()
    const p = startRef.current.offset + (ctx.currentTime - startRef.current.ctxTime)
    stopPlayback()
    setPos(Math.min(p, duration))
    setPlaying(false)
  }

  // A source node can't be repositioned, so seeking restarts one at the new
  // offset — but only while playing. Paused, it just parks the playhead.
  function seek(v: number) {
    setPos(v)
    if (playing) startAt(v)
  }

  if (buffer === null) return <span className="sound-cell-length">no audio</span>

  return (
    <div className={`sound-cell-player${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="zoom-btn sound-cell-btn"
        disabled={!buffer}
        title={playing ? 'Pause' : `Play ${title}`}
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
        disabled={!buffer}
        onChange={(e) => seek(parseFloat(e.target.value))}
      />
      <span className="sound-cell-length">{buffer ? `${duration.toFixed(2)}s` : '…'}</span>
    </div>
  )
}
