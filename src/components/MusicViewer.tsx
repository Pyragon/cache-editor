import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MusicData } from '../loaders/music'
import type { MidiFile } from '../loaders/midiFile'
import { GM_INSTRUMENTS, formatDuration, midiTickToSeconds, parseMidi } from '../loaders/midiFile'
import { MusicBankLoader } from '../loaders/musicBank'
import { CacheMidiPlayer } from '../audio/midiSynth'
import type { PrepareReport } from '../audio/midiSynth'
import './MusicViewer.css'

/** Oscillator-fallback master level at volume 1.0 — its long-standing value. */
const OSC_BASE_GAIN = 0.22

/**
 * Fill a range input's track up to its thumb.
 *
 * Chromium has no `::-webkit-slider-progress`, and Firefox's
 * `::-moz-range-progress` is Firefox-only, so the portable way is a hard-stop
 * gradient on the track driven by the live value — passed down as a custom
 * property the stylesheet consumes.
 */
function fillTo(percent: number): React.CSSProperties {
  return { '--fill': `${Math.max(0, Math.min(100, percent))}%` } as React.CSSProperties
}

/** Distinct hue per MIDI channel, so the roll and the track table agree. */
function channelHue(channel: number): number {
  return (channel * 47) % 360
}

function channelColor(channel: number, alpha = 1): string {
  if (channel === 9) return `hsla(0, 0%, 72%, ${alpha})` // percussion reads as neutral
  return `hsla(${channelHue(channel)}, 72%, 62%, ${alpha})`
}

/**
 * Piano roll. Pitch on Y, time on X, one rectangle per note coloured by
 * channel — the quickest way to see whether a song is a sparse ambient loop or
 * a dense arrangement, which no amount of numbers conveys.
 */
function PianoRoll({ midi, progress }: { midi: MidiFile; progress: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement

    const draw = () => {
    const cssW = parent?.clientWidth ?? 800
    const cssH = 220
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    if (midi.notes.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '12px system-ui, sans-serif'
      ctx.fillText('No notes in this file', 12, 24)
      return
    }

    let lowest = 127
    let highest = 0
    for (const n of midi.notes) {
      if (n.pitch < lowest) lowest = n.pitch
      if (n.pitch > highest) highest = n.pitch
    }
    // pad the range so edge notes aren't flush against the border
    lowest = Math.max(0, lowest - 2)
    highest = Math.min(127, highest + 2)
    const span = Math.max(1, highest - lowest)
    const totalTicks = Math.max(1, midi.durationTicks)

    // octave guide lines (every C)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let p = Math.ceil(lowest / 12) * 12; p <= highest; p += 12) {
      const y = cssH - ((p - lowest) / span) * cssH
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y) + 0.5)
      ctx.lineTo(cssW, Math.round(y) + 0.5)
      ctx.stroke()
    }

    const noteH = Math.max(2, Math.min(6, cssH / span))
    for (const n of midi.notes) {
      const x = (n.tick / totalTicks) * cssW
      // zero-length notes (never closed) still get a visible sliver
      const w = Math.max(1.5, (Math.max(n.length, totalTicks * 0.001) / totalTicks) * cssW)
      const y = cssH - ((n.pitch - lowest) / span) * cssH - noteH / 2
      ctx.fillStyle = channelColor(n.channel, 0.35 + (n.velocity / 127) * 0.55)
      ctx.fillRect(x, y, w, noteH)
    }
    }

    draw()
    // the canvas is CSS-stretched to its container, so without redrawing at the
    // new backing size a resize just blurs it
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [midi])

  return (
    <div className="music-roll">
      <canvas ref={ref} />
      <div className="music-roll-playhead" style={{ left: `${progress * 100}%`, opacity: progress > 0 ? 1 : 0 }} />
    </div>
  )
}

export default function MusicViewer({ data, onSave, onDirtyChange, rootHandle }: {
  data: MusicData
  onSave: (data: MusicData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Needed to play with the cache's own instruments rather than oscillators. */
  rootHandle?: FileSystemDirectoryHandle
}) {
  const [staged, setStaged] = useState<File | null>(null)
  const [stagedUrl, setStagedUrl] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [midi, setMidi] = useState<MidiFile | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // WebAudio playback state, kept in refs so the RAF loop doesn't re-subscribe
  const audioRef = useRef<AudioContext | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const playerRef = useRef<CacheMidiPlayer | null>(null)
  const banksRef = useRef<MusicBankLoader | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [report, setReport] = useState<PrepareReport | null>(null)

  // --- transport ----------------------------------------------------------
  // Pause and seek only exist on the cache-instrument path: the oscillator
  // fallback schedules every note up front against the AudioContext clock, so
  // there is nothing to freeze or rewind without rebuilding the whole
  // schedule. It keeps Play/Stop, and volume still works through its gain node.
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(1)
  const seekableRef = useRef(false)
  const [seekable, setSeekable] = useState(false)
  // While the thumb is held, incoming playhead frames must not fight the drag.
  const scrubbingRef = useRef(false)
  const oscGainRef = useRef<GainNode | null>(null)

  const duration = midi?.durationSeconds ?? 0

  const sourceFile = staged ?? data.midFile
  const downloadUrl = stagedUrl ?? data.midUrl

  useEffect(() => {
    setStaged(null)
    setStagedUrl(null)
    setIsDirty(false)
  }, [data])

  useEffect(() => { onDirtyChange?.(isDirty) }, [isDirty, onDirtyChange])

  // Parse whatever is current — the dumped file, or the upload once staged so
  // the panel describes what you're about to save rather than what's on disk.
  useEffect(() => {
    let cancelled = false
    setMidi(null)
    setParseError(null)
    if (!sourceFile) return
    void (async () => {
      try {
        const parsed = parseMidi(await sourceFile.arrayBuffer())
        if (cancelled) return
        if (!parsed) setParseError('Not a standard MIDI file (no MThd header).')
        else setMidi(parsed)
      } catch (e) {
        if (!cancelled) setParseError(e instanceof Error ? e.message : 'Could not read the file.')
      }
    })()
    return () => { cancelled = true }
  }, [sourceFile])

  const stopPlayback = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
    oscGainRef.current = null
    seekableRef.current = false
    setSeekable(false)
    setPaused(false)
    setPlaying(false)
    setProgress(0)
  }, [])

  // Volume is live: adjusting mid-song retunes the worklet's master gain (or
  // the fallback's gain node) rather than waiting for the next play.
  useEffect(() => {
    playerRef.current?.setVolume(volume)
    if (oscGainRef.current) oscGainRef.current.gain.value = OSC_BASE_GAIN * volume
  }, [volume])

  // stop the moment the song changes or the page unmounts — otherwise the
  // previous song keeps playing over the next one
  useEffect(() => stopPlayback, [stopPlayback, data])

  // Browsers cap concurrent AudioContexts (~6), so the one created on first
  // play has to be released when the page goes away, not just silenced.
  useEffect(() => () => {
    playerRef.current?.dispose()
    playerRef.current = null
    void audioRef.current?.close().catch(() => { /* already closed */ })
    audioRef.current = null
  }, [])

  function ensureCtx(): AudioContext | null {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return null
    const ctx = audioRef.current ?? new AudioCtor()
    audioRef.current = ctx
    void ctx.resume()
    return ctx
  }

  /**
   * Play with the CACHE'S OWN instruments — the same samples the game uses,
   * resolved program -> bank -> sample through the client's chain and rendered
   * by the AudioWorklet port of its mixer. Falls back to the oscillator
   * preview when there's no cache open, or when this dump can't supply the
   * song's banks.
   */
  async function play() {
    if (!midi || midi.notes.length === 0) return
    stopPlayback()
    const ctx = ensureCtx()
    if (!ctx) return

    if (rootHandle) {
      setStatus('Preparing…')
      try {
        const banks = (banksRef.current ??= new MusicBankLoader(rootHandle))
        const player = (playerRef.current ??= new CacheMidiPlayer(ctx))
        const rep = await player.prepare(midi, banks, setStatus)
        setReport(rep)
        setStatus(null)
        if (rep.playable > 0) {
          player.setVolume(volume)
          player.play(
            (seconds) => {
              // a seek repaints the thumb itself; letting a frame land mid-drag
              // would snap it back under the pointer
              if (scrubbingRef.current) return
              setProgress(Math.max(0, Math.min(1, seconds / Math.max(0.001, midi.durationSeconds))))
            },
            () => stopPlayback(),
          )
          stopRef.current = () => player.stop()
          seekableRef.current = true
          setSeekable(true)
          setPaused(false)
          setPlaying(true)
          return
        }
        // nothing resolved — fall through to the oscillator preview rather
        // than sitting in silence
      } catch (e) {
        setStatus(null)
        setReport(null)
        // eslint-disable-next-line no-console
        console.warn('[music] cache-instrument playback failed, falling back to oscillators', e)
      }
    }

    playOscillators(ctx)
  }

  /**
   * Fallback preview. No samples involved — each note becomes a short
   * triangle-wave envelope, so the melody, rhythm and arrangement come through
   * but the timbre does not. Percussion (channel 9) is skipped rather than
   * rendered as pitched tones, which would be actively misleading.
   */
  function playOscillators(ctx: AudioContext) {
    if (!midi) return

    const master = ctx.createGain()
    master.gain.value = OSC_BASE_GAIN * volume
    master.connect(ctx.destination)
    oscGainRef.current = master

    // Cap the voice count: scheduling tens of thousands of oscillators up front
    // will stall the audio thread. Dense songs get their first N notes.
    const MAX_VOICES = 3000
    const playable = midi.notes.filter((n) => n.channel !== 9)
    const scheduled = playable.slice(0, MAX_VOICES)
    const t0 = ctx.currentTime + 0.08
    const nodes: OscillatorNode[] = []

    for (const n of scheduled) {
      const start = t0 + midiTickToSeconds(midi, n.tick)
      const rawLen = n.length > 0 ? midiTickToSeconds(midi, n.tick + n.length) - midiTickToSeconds(midi, n.tick) : 0.25
      const dur = Math.max(0.05, Math.min(rawLen, 8))
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = 440 * 2 ** ((n.pitch - 69) / 12)
      const peak = 0.05 + (n.velocity / 127) * 0.25
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(gain).connect(master)
      osc.start(start)
      osc.stop(start + dur + 0.05)
      nodes.push(osc)
    }

    const total = midi.durationSeconds
    let raf = 0
    const tick = () => {
      const elapsed = ctx.currentTime - t0
      if (elapsed >= total) { stopPlayback(); return }
      setProgress(Math.max(0, Math.min(1, elapsed / total)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    stopRef.current = () => {
      cancelAnimationFrame(raf)
      for (const o of nodes) { try { o.stop() } catch { /* already stopped */ } }
      try { master.disconnect() } catch { /* already gone */ }
    }
    setPlaying(true)
  }

  /** One button for the whole transport: start, freeze, continue. */
  function togglePlay() {
    if (!playing) { void play(); return }
    const player = playerRef.current
    if (!seekableRef.current || !player) {
      // oscillator fallback — nothing to freeze, so the button is Stop
      stopPlayback()
      return
    }
    if (paused) { player.resume(); setPaused(false) } else { player.pause(); setPaused(true) }
  }

  /** Scrub to a fraction of the song. Works paused as well as playing, so you
   *  can position the playhead and then hit play. */
  function seekTo(fraction: number) {
    const clamped = Math.max(0, Math.min(1, fraction))
    setProgress(clamped)
    if (!seekableRef.current) return
    playerRef.current?.seek(clamped * duration, playing && !paused)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    stopPlayback()
    setStaged(file)
    setStagedUrl(URL.createObjectURL(file))
    setIsDirty(true)
    e.target.value = ''
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, midFile: staged })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    stopPlayback()
    setStaged(null)
    setStagedUrl(null)
    setIsDirty(false)
  }

  const instruments = useMemo(() => {
    if (!midi) return [] as string[]
    const seen = new Set<number>()
    for (const t of midi.tracks) for (const p of t.programs) seen.add(p)
    return [...seen].sort((a, b) => a - b).map((p) => GM_INSTRUMENTS[p] ?? `Program ${p}`)
  }, [midi])

  const stats: [string, string, string?][] = midi
    ? [
      ['Length', formatDuration(midi.durationSeconds), `${midi.durationTicks.toLocaleString()} ticks`],
      ['Tempo', midi.bpm ? `${midi.bpm} BPM` : '—', midi.tempos.length > 1 ? `${midi.tempos.length} changes` : 'constant'],
      ['Tracks', String(midi.trackCount), `format ${midi.format}`],
      ['Notes', midi.notes.length.toLocaleString(), `${instruments.length} instrument${instruments.length === 1 ? '' : 's'}`],
      ['Time sig', midi.timeSignature ? `${midi.timeSignature.numerator}/${midi.timeSignature.denominator}` : '—', midi.keySignature ? `key ${midi.keySignature}` : undefined],
      ['Resolution', midi.ticksPerQuarter ? `${midi.ticksPerQuarter} tpq` : `SMPTE ${midi.smpte?.fps}fps`, `${(midi.byteLength / 1024).toFixed(1)} KB`],
    ]
    : []

  return (
    <div className="item-viewer music-viewer">
      <input ref={fileInputRef} type="file" accept="audio/midi,.mid,.midi" style={{ display: 'none' }} onChange={handleFileChange} />

      <div className="music-header">
        <div className="music-title">
          <span className="enum-title">Song {data.id}</span>
          {midi && <span className="music-sub">{formatDuration(midi.durationSeconds)} · {midi.trackCount} tracks · {midi.notes.length.toLocaleString()} notes</span>}
        </div>
        <div className="music-actions">
          {downloadUrl && (
            <a className="add-row-btn" href={downloadUrl} download={`song-${data.id}.mid`}>Download .mid</a>
          )}
          <button type="button" className="add-row-btn" onClick={() => fileInputRef.current?.click()}>
            Replace…
          </button>
        </div>
      </div>

      {staged && (
        <p className="music-staged">
          Staged <strong>{staged.name}</strong> ({(staged.size / 1024).toFixed(1)} KB) — everything below describes the
          uploaded file. It is read as data only, never executed, and nothing is written until you Save.
        </p>
      )}

      {status && <p className="music-staged">{status}</p>}

      {report && (
        <p className={report.playable > 0 ? 'tex-op-note' : 'music-warning'}>
          {report.playable > 0
            ? <>Playing with the cache's own instruments — <strong>{report.samples}</strong> sample{report.samples === 1 ? '' : 's'} decoded for <strong>{report.playable.toLocaleString()}</strong> notes.</>
            : <>None of this song's instruments resolved in this dump, so the fallback oscillator preview is being used instead.</>}
          {report.missing > 0 && ` ${report.missing.toLocaleString()} note${report.missing === 1 ? '' : 's'} had no sample and stay silent.`}
          {report.missingBanks.length > 0 && ` Missing bank${report.missingBanks.length === 1 ? '' : 's'}: ${report.missingBanks.slice(0, 8).join(', ')}${report.missingBanks.length > 8 ? '…' : ''}.`}
        </p>
      )}

      {!sourceFile && <p className="tex-op-note">No dumped <code>song.mid</code> for this song.</p>}
      {parseError && <p className="music-warning">{parseError}</p>}

      {midi && (
        <>
          <div className="music-stats">
            {stats.map(([label, value, sub]) => (
              <div key={label} className="music-stat">
                <span className="music-stat-label">{label}</span>
                <span className="music-stat-value">{value}</span>
                {sub && <span className="music-stat-sub">{sub}</span>}
              </div>
            ))}
          </div>

          <section className="item-section">
            <h3>Piano roll</h3>
            <PianoRoll midi={midi} progress={progress} />

            <div className="music-transport">
              <button
                type="button"
                className={`music-play${playing && !paused ? ' playing' : ''}`}
                onClick={togglePlay}
                disabled={midi.notes.length === 0}
                title={rootHandle ? "Play using the cache's own instrument samples" : 'Open a cache to play with the real instruments'}
              >
                {status ? '…' : !playing ? '▶ Play' : paused ? '▶ Resume' : seekable ? '⏸ Pause' : '■ Stop'}
              </button>
              <button
                type="button"
                className="music-stop"
                onClick={stopPlayback}
                disabled={!playing}
                title="Stop and rewind"
              >
                ■
              </button>
              <span className="music-time">{formatDuration(progress * duration)}</span>
              <input
                type="range"
                className="music-seek"
                min={0}
                max={1000}
                step={1}
                value={Math.round(progress * 1000)}
                style={fillTo(progress * 100)}
                // enabled only while the worklet actually holds the timeline —
                // scrubbing a song that isn't loaded has nothing to seek, and
                // play() rewinds to 0 anyway, so a pre-set thumb would lie
                disabled={!seekable}
                aria-label="Seek"
                title={seekable
                  ? 'Drag to move through the song'
                  : 'Seeking needs the cache-instrument player — press Play with a cache open'}
                // pointer/key down marks the drag so incoming playhead frames
                // stop overwriting the thumb; the matching up/blur clears it
                onPointerDown={() => { scrubbingRef.current = true }}
                onPointerUp={() => { scrubbingRef.current = false }}
                onKeyDown={() => { scrubbingRef.current = true }}
                onKeyUp={() => { scrubbingRef.current = false }}
                onBlur={() => { scrubbingRef.current = false }}
                onChange={(e) => seekTo(Number(e.target.value) / 1000)}
              />
              <span className="music-time">{formatDuration(duration)}</span>

              <label className="music-volume" title={`Volume ${Math.round(volume * 100)}%`}>
                <span aria-hidden>{volume === 0 ? '🔇' : '🔊'}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(volume * 100)}
                  style={fillTo(volume * 100)}
                  aria-label="Volume"
                  onChange={(e) => setVolume(Number(e.target.value) / 100)}
                />
              </label>
            </div>
            {playing && !seekable && (
              <p className="tex-op-note">
                Oscillator preview — pause and seek need the cache-instrument player, which schedules
                through the worklet rather than queueing every note up front. Volume still applies.
              </p>
            )}
            <p className="tex-op-note">
              Pitch vertically, time horizontally, coloured by MIDI channel (grey = channel 10, percussion).
              Play resolves every note through the client's own chain — program + bank select to a
              <code> sound_effects_midi</code> bank, then to a <code>midi_instruments</code> ogg (99.94% of
              mapped notes) or, for a handful of percussion slots, a synthesised <code>sound_effects</code>
              sample — and renders it with an AudioWorklet port of the client's mixer, so it should sound
              like the game rather than like a General MIDI soundfont. Without a cache open it falls back to
              a plain oscillator preview.
            </p>
          </section>

          {midi.tracks.length > 0 && (
            <section className="item-section">
              <h3>Tracks</h3>
              <div className="quest-table-wrap music-track-wrap">
                <table className="quest-table">
                  <thead><tr><th>#</th><th>Name</th><th>Channels</th><th>Instruments</th><th>Notes</th><th>Events</th></tr></thead>
                  <tbody>
                    {midi.tracks.map((t) => (
                      <tr key={t.index}>
                        <td className="music-track-idx">{t.index}</td>
                        <td>{t.name ?? <span className="music-dim">untitled</span>}</td>
                        <td>
                          {t.channels.length === 0
                            ? <span className="music-dim">—</span>
                            : t.channels.map((c) => (
                              <span key={c} className="music-chan" style={{ background: channelColor(c, 0.22), color: channelColor(c) }}>
                                {c + 1}
                              </span>
                            ))}
                        </td>
                        <td>{t.programs.length === 0 ? <span className="music-dim">—</span> : t.programs.map((p) => GM_INSTRUMENTS[p] ?? `Program ${p}`).join(', ')}</td>
                        <td>{t.noteCount.toLocaleString()}</td>
                        <td>{t.eventCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {midi.warnings.length > 0 && (
            <section className="item-section">
              <h3>Warnings</h3>
              {midi.warnings.map((w, i) => <p key={i} className="music-warning">{w}</p>)}
            </section>
          )}
        </>
      )}

      <details className="item-unknown">
        <summary>How editing and repacking works</summary>
        <p className="tex-op-note">
          The cache stores songs in Jagex's compact format; cryogen decompresses each one into a real,
          standard MIDI file on dump, and recompresses whatever is in <code>song.mid</code> back into the
          cache format on repack (verified: every song in both indices round-trips to identical decoded
          MIDI). <code>song.bin</code> beside it is the raw cache bytes, kept for reference only — editing
          it does nothing. So the workflow is: download, edit in any MIDI editor (MuseScore, a DAW),
          upload here, Save.
        </p>
      </details>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard} disabled={isSaving}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
