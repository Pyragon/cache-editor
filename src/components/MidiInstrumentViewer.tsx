import { useCallback, useEffect, useRef, useState } from 'react'
import type { MidiInstrumentData, MidiInstrumentDef } from '../loaders/midi_instruments'
import { loopEnabled, withLoopEnabled } from '../loaders/midi_instruments'
import { instrumentUsage, deepInstrumentUsage, deepScanReady, formatNotes, bankAddress } from '../loaders/midiInstrumentUsage'
import type { InstrumentUse, DeepScan } from '../loaders/midiInstrumentUsage'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { NumberInput } from './defFields'
import './MidiInstrumentViewer.css'

/** Master level at volume 1.0, matching the music page. */
const MAX_GAIN = 0.35

function seconds(n: number): string {
  if (!isFinite(n) || n <= 0) return '0.00s'
  return n < 10 ? `${n.toFixed(2)}s` : `${n.toFixed(1)}s`
}

/**
 * Waveform with the loop region shaded and the playhead riding the audio clock.
 *
 * Drawn from the DECODED buffer rather than the container's own timing, which
 * is what makes the waveform and the playhead agree with what you hear.
 */
function Waveform({ buffer, loopFrom, loopTo, progress, onScrub }: {
  buffer: AudioBuffer | null
  /** loop bounds as a fraction of the whole sample, or null when it doesn't loop */
  loopFrom: number | null
  loopTo: number | null
  progress: number
  onScrub: (fraction: number) => void
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement

    const draw = () => {
      const cssW = parent?.clientWidth ?? 800
      const cssH = 150
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = cssW * dpr
      canvas.height = cssH * dpr
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const mid = cssH / 2
      if (!buffer) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.font = '12px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('Decoding…', cssW / 2, mid + 4)
        return
      }

      // loop region behind the wave, so the shading reads as "this part repeats"
      if (loopFrom != null && loopTo != null && loopTo > loopFrom) {
        ctx.fillStyle = 'rgba(255, 225, 77, 0.10)'
        ctx.fillRect(loopFrom * cssW, 0, (loopTo - loopFrom) * cssW, cssH)
        for (const [x, label] of [[loopFrom, 'loop'], [loopTo, 'end']] as const) {
          const px = Math.round(x * cssW) + 0.5
          ctx.strokeStyle = 'rgba(255, 196, 0, 0.8)'
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(px, 0)
          ctx.lineTo(px, cssH)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255, 196, 0, 0.9)'
          ctx.font = '9px system-ui, sans-serif'
          ctx.textAlign = x > 0.9 ? 'right' : 'left'
          ctx.fillText(label, x > 0.9 ? px - 3 : px + 3, 12)
        }
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(cssW, mid)
      ctx.stroke()

      // min/max per column, the standard audio-editor rendering
      const data = buffer.getChannelData(0)
      const per = data.length / cssW
      ctx.strokeStyle = 'rgba(47, 143, 255, 0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x < cssW; x++) {
        const from = Math.floor(x * per)
        const to = Math.min(data.length, Math.max(from + 1, Math.floor((x + 1) * per)))
        let lo = 1
        let hi = -1
        for (let i = from; i < to; i++) {
          if (data[i] < lo) lo = data[i]
          if (data[i] > hi) hi = data[i]
        }
        ctx.moveTo(x + 0.5, mid - hi * (mid - 6))
        ctx.lineTo(x + 0.5, mid - lo * (mid - 6))
      }
      ctx.stroke()

      if (progress > 0) {
        const px = Math.round(progress * cssW) + 0.5
        ctx.strokeStyle = '#ffe14d'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, cssH)
        ctx.stroke()
      }
    }

    draw()
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [buffer, loopFrom, loopTo, progress])

  return (
    <div
      className="mi-wave"
      onPointerDown={(e) => {
        if (!buffer) return
        const rect = e.currentTarget.getBoundingClientRect()
        onScrub(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
      }}
    >
      <canvas ref={ref} />
    </div>
  )
}

export default function MidiInstrumentViewer({ data, onSave, onDirtyChange, onNavigate }: {
  data: MidiInstrumentData
  onSave: (data: MidiInstrumentData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}) {
  const [def, setDef] = useState<MidiInstrumentDef>(data.def)
  const [oggUrl, setOggUrl] = useState(data.oggUrl)
  const [oggFile, setOggFile] = useState<File | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [volume, setVolume] = useState(1)
  const [loopPlayback, setLoopPlayback] = useState(false)

  const [uses, setUses] = useState<InstrumentUse[] | null>(null)
  // ambient-sound references need every object and NPC read, so that pass is
  // opt-in; once run it is cached for the session and applies to every item
  // seeded from the cache: a remount shouldn't re-offer a scan that already ran
  const [deep, setDeep] = useState(() => (data.rootHandle ? deepScanReady(data.rootHandle) : false))
  const [scanning, setScanning] = useState<ScanProgress | null>(null)
  const [scanResult, setScanResult] = useState<DeepScan | null>(null)

  const ctxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const rafRef = useRef(0)
  const startedAtRef = useRef(0)
  const offsetRef = useRef(0)
  /** seek fraction held during a drag, applied on release */
  const pendingSeekRef = useRef<number | null>(null)

  useEffect(() => {
    setDef(data.def)
    setOggUrl(data.oggUrl)
    setOggFile(null)
    setIsDirty(false)
  }, [data])

  useEffect(() => { onDirtyChange?.(isDirty) }, [isDirty, onDirtyChange])

  // the useState seed only runs on first mount, so re-check when the cache
  // itself changes — otherwise a reopened cache re-offers a finished scan
  useEffect(() => {
    if (data.rootHandle && deepScanReady(data.rootHandle)) setDeep(true)
  }, [data.rootHandle])

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    const source = sourceRef.current
    sourceRef.current = null
    if (source) {
      source.onended = null
      try { source.stop() } catch { /* already stopped */ }
    }
    offsetRef.current = 0
    setPlaying(false)
    setProgress(0)
  }, [])

  // stop the moment the instrument changes or the panel goes away
  useEffect(() => stop, [stop, data])
  useEffect(() => () => {
    void ctxRef.current?.close().catch(() => { /* already closed */ })
    ctxRef.current = null
  }, [])

  // Decoded rather than handed to an <audio> element: the samples are what the
  // waveform, the loop markers and the loop-region playback are all drawn from,
  // and only a decoded buffer can supply them.
  useEffect(() => {
    let cancelled = false
    setBuffer(null)
    setDecodeError(null)
    const file = oggFile ?? data.oggFile
    if (!file) return
    void (async () => {
      try {
        const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioCtor) throw new Error('This browser has no Web Audio support.')
        const ctx = ctxRef.current ?? new AudioCtor()
        ctxRef.current = ctx
        const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
        if (!cancelled) setBuffer(decoded)
      } catch (e) {
        if (!cancelled) setDecodeError(e instanceof Error ? e.message : 'Could not decode this audio.')
      }
    })()
    return () => { cancelled = true }
  }, [data.oggFile, oggFile])

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = MAX_GAIN * volume
  }, [volume])

  // Cheap after the first lookup — the reverse index is built once per cache.
  // Reuses the deep index instead when it has already been built.
  useEffect(() => {
    let cancelled = false
    setUses(null)
    const root = data.rootHandle
    if (!root) return
    const load = deep
      ? deepInstrumentUsage(root).then((r) => { if (!cancelled) setScanResult(r); return r.index })
      : instrumentUsage(root)
    void load
      .then((index) => { if (!cancelled) setUses(index.get(data.id) ?? []) })
      .catch(() => { if (!cancelled) setUses(null) })
    return () => { cancelled = true }
  }, [data.rootHandle, data.id, deep])

  async function runDeepScan() {
    const root = data.rootHandle
    if (!root) return
    setScanning({ phase: 'indexing', done: 0, total: 0 })
    try {
      setScanResult(await deepInstrumentUsage(root, ({ phase, done, total, index }) => {
        setScanning({ phase, done, total })
        // the index is live, so the table fills in as matches are found
        setUses([...(index.get(data.id) ?? [])])
      }))
      setDeep(true)
    } finally {
      setScanning(null)
    }
  }

  const rate = def.samplingRate || 22050
  const trueDuration = buffer ? buffer.duration : def.sampleSize / Math.max(1, rate)
  const loops = loopEnabled(def)
  // loop points are samples at the DUMP's rate; the decode may have resampled
  const scale = buffer ? buffer.sampleRate / Math.max(1, rate) : 1
  const loopStartSec = (def.loopStart * scale) / Math.max(1, buffer?.sampleRate ?? rate)
  const loopEndSec = (def.loopEnd * scale) / Math.max(1, buffer?.sampleRate ?? rate)
  const hasLoopRegion = loops && def.loopEnd > def.loopStart

  function playFrom(offsetSeconds: number) {
    const ctx = ctxRef.current
    if (!ctx || !buffer) return
    stop()
    void ctx.resume()
    const gain = gainRef.current ?? ctx.createGain()
    gain.gain.value = MAX_GAIN * volume
    gain.connect(ctx.destination)
    gainRef.current = gain

    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (loopPlayback && hasLoopRegion) {
      source.loop = true
      source.loopStart = loopStartSec
      source.loopEnd = Math.min(loopEndSec, buffer.duration)
    }
    source.connect(gain)
    source.onended = () => { if (sourceRef.current === source) stop() }
    source.start(0, Math.max(0, Math.min(offsetSeconds, buffer.duration - 0.001)))
    sourceRef.current = source
    startedAtRef.current = ctx.currentTime
    offsetRef.current = offsetSeconds
    setPlaying(true)

    const tick = () => {
      const src = sourceRef.current
      if (!src || !ctxRef.current) return
      let elapsed = offsetRef.current + (ctxRef.current.currentTime - startedAtRef.current)
      if (src.loop && elapsed > src.loopEnd) {
        const span = src.loopEnd - src.loopStart
        if (span > 0) elapsed = src.loopStart + ((elapsed - src.loopStart) % span)
      }
      setProgress(Math.max(0, Math.min(1, elapsed / buffer.duration)))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  /**
   * Apply a dragged seek. While playing this restarts at the new offset; while
   * stopped it just parks the playhead, and Play picks it up from there —
   * scrubbing a stopped sample shouldn't start making noise on its own.
   */
  function commitSeek() {
    const f = pendingSeekRef.current
    if (f == null || !buffer) return
    pendingSeekRef.current = null
    const target = f * buffer.duration
    if (playing) playFrom(target)
    else offsetRef.current = target
  }

  function set<K extends keyof MidiInstrumentDef>(key: K, value: MidiInstrumentDef[K]) {
    setDef((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    stop()
    setOggFile(file)
    setOggUrl(URL.createObjectURL(file))
    setIsDirty(true)
    e.target.value = ''
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def, oggFile })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    stop()
    setDef(data.def)
    setOggUrl(data.oggUrl)
    setOggFile(null)
    setIsDirty(false)
  }

  // the scan summary counts only what the scan itself found, so bank
  // references (already listed before it ran) are excluded
  const ambientUses = uses?.filter((u) => u.kind !== 'bank').length ?? 0

  const fill = (pct: number) => ({ '--fill': `${Math.max(0, Math.min(100, pct))}%` } as React.CSSProperties)

  return (
    <div className="item-viewer mi-viewer">
      <input ref={fileInputRef} type="file" accept="audio/ogg,.ogg" style={{ display: 'none' }} onChange={handleFileChange} />

      <div className="mi-header">
        <div className="mi-title">
          <span className="enum-title">Instrument {data.id}</span>
          <span className="mi-sub">
            {seconds(trueDuration)} · {rate.toLocaleString()} Hz · {def.sampleSize.toLocaleString()} samples
            {loops ? ' · loops' : ' · one-shot'}
          </span>
        </div>
        <div className="music-actions">
          {oggUrl && <a className="add-row-btn" href={oggUrl} download={`instrument-${data.id}.ogg`}>Download .ogg</a>}
          <button type="button" className="add-row-btn" onClick={() => fileInputRef.current?.click()}>Replace…</button>
        </div>
      </div>

      {oggFile && (
        <p className="music-staged">
          Staged <strong>{oggFile.name}</strong> ({(oggFile.size / 1024).toFixed(1)} KB) — read as data only, never
          executed or transcoded, and nothing is written until you Save.
        </p>
      )}
      {decodeError && <p className="music-warning">Could not decode this audio: {decodeError}</p>}

      <section className="item-section">
        <h3>Sample</h3>
        <Waveform
          buffer={buffer}
          loopFrom={hasLoopRegion && buffer ? Math.min(1, loopStartSec / buffer.duration) : null}
          loopTo={hasLoopRegion && buffer ? Math.min(1, loopEndSec / buffer.duration) : null}
          progress={progress}
          onScrub={(f) => { if (buffer) playFrom(f * buffer.duration) }}
        />

        <div className="music-transport">
          <button
            type="button"
            className={`music-play${playing ? ' playing' : ''}`}
            disabled={!buffer}
            onClick={() => (playing ? stop() : playFrom(offsetRef.current))}
          >
            {playing ? '■ Stop' : buffer ? '▶ Play' : '…'}
          </button>
          <span className="music-time">{seconds(progress * trueDuration)}</span>
          <input
            type="range"
            className="music-seek"
            min={0}
            max={1000}
            step={1}
            value={Math.round(progress * 1000)}
            style={fill(progress * 100)}
            disabled={!buffer}
            aria-label="Position"
            // move the playhead while dragging but commit on release — an
            // AudioBufferSourceNode can't be repositioned, so seeking means
            // tearing one down and starting another, and doing that per step
            // of a drag machine-guns the attack
            onChange={(e) => {
              const f = Number(e.target.value) / 1000
              pendingSeekRef.current = f
              setProgress(f)
            }}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
          <span className="music-time">{seconds(trueDuration)}</span>

          <label className={`mi-loop-toggle${hasLoopRegion ? '' : ' disabled'}`} title={hasLoopRegion
            ? 'Repeat the loop region, the way a held note sustains in game'
            : 'This sample has no loop region'}>
            <input
              type="checkbox"
              checked={loopPlayback && hasLoopRegion}
              disabled={!hasLoopRegion}
              onChange={(e) => { setLoopPlayback(e.target.checked); stop() }}
            />
            Loop
          </label>

          <label className="music-volume" title={`Volume ${Math.round(volume * 100)}%`}>
            <span aria-hidden>{volume === 0 ? '🔇' : '🔊'}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              style={fill(volume * 100)}
              aria-label="Volume"
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
            />
          </label>
        </div>

        <p className="tex-op-note">Click the waveform to play from that point.</p>
      </section>

      <section className="item-section">
        <h3>Properties</h3>
        <div className="mi-grid">
          <label className="item-field">
            <span className="item-field-label">Sampling rate (Hz)</span>
            <NumberInput value={def.samplingRate} onChange={(v) => set('samplingRate', v)} min={0} />
            <span className="mi-hint">The rate the sample and its loop points are counted in.</span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Sample count</span>
            <NumberInput value={def.sampleSize} onChange={(v) => set('sampleSize', v)} min={0} />
            <span className="mi-hint">{seconds(def.sampleSize / Math.max(1, rate))} at this rate.</span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Loop start (samples)</span>
            <NumberInput value={def.loopStart} onChange={(v) => set('loopStart', v)} min={0} />
            <span className="mi-hint">{seconds(def.loopStart / Math.max(1, rate))} in.</span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Loop end (samples)</span>
            <NumberInput value={def.loopEnd} onChange={(v) => set('loopEnd', v)} min={0} />
            <span className="mi-hint">Equals the sample count on every instrument in this cache.</span>
          </label>
          <label className="item-field def-toggle-field">
            <span className="item-field-label">Loops</span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={loops}
                onChange={(e) => { setDef((prev) => withLoopEnabled(prev, e.target.checked)); setIsDirty(true) }}
              />
              <span className="sprite-toggle-track" />
            </span>
            <span className="mi-hint">
              Whether a held note sustains on this sample. Not its own field on the wire — a negative
              <code> loop end</code> means "loops", and the real end is its complement.
            </span>
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>Used by</h3>
        {!data.rootHandle && <p className="tex-op-note">Reopen the cache to resolve what references this sample.</p>}
        {data.rootHandle && uses == null && <p className="tex-op-note">Scanning…</p>}

        {uses != null && uses.length > 0 && (
          <div className="quest-table-wrap">
            <table className="quest-table">
              <thead><tr><th>Source</th><th>Reached as</th><th /></tr></thead>
              <tbody>
                {uses.map((u, i) => (
                  <tr key={i}>
                    <td className="item-stack-index">
                      {u.kind === 'bank' ? `Bank ${u.bank}` : u.kind === 'object' ? `Object ${u.id}` : `NPC ${u.id}`}
                    </td>
                    <td>
                      {u.kind === 'bank'
                        ? <>{bankAddress(u.bank)} · note{u.notes.length === 1 ? '' : 's'} {formatNotes(u.notes)}</>
                        : <><code>{u.field}</code> — ambient sound</>}
                    </td>
                    <td>
                      {onNavigate && (
                        <button
                          type="button"
                          className="field-link-btn"
                          onClick={() => onNavigate(
                            u.kind === 'bank' ? 'sound_effects_midi' : u.kind === 'object' ? 'objects' : 'npcs',
                            u.kind === 'bank' ? u.bank : u.id,
                          )}
                        >
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {uses != null && uses.length === 0 && (
          <p className="tex-op-note">
            No {deep ? 'bank, object or NPC in this cache' : 'instrument bank'} references this sample.
          </p>
        )}

        {/* After a scan, say what it covered and what it added. Without this the
            button just disappears and an instrument with no ambient-sound users
            looks identical to one where the scan never ran. */}
        {deep && scanResult && (
          <p className="tex-op-note">
            Searched <strong>{scanResult.scanned.toLocaleString()}</strong> object and NPC defs
            {' — '}
            {ambientUses === 0
              ? <>none reference this instrument.</>
              : <><strong>{ambientUses}</strong> reference{ambientUses === 1 ? 's' : ''} this instrument.</>}
          </p>
        )}

        {data.rootHandle && !deep && (
          <div className="mi-scan">
            <button type="button" className="add-row-btn" disabled={scanning != null} onClick={() => void runDeepScan()}>
              {scanning ? scanLabel(scanning, 'defs') : 'Scan objects & NPCs'}
            </button>
            <p className="tex-op-note">
              The table above covers instrument banks only. An object or NPC can also point straight at a sample
              here — their sound id is read from this index instead of <code>sound_effects</code> when the def
              sets the instrument flag (object opcodes 168/169, NPC opcode 162) — but finding those means
              reading every object and NPC in the cache.
            </p>
          </div>
        )}
      </section>

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
