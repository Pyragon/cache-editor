import { useEffect, useRef, useState } from 'react'
import type { SoundEffectData, SoundEffectDef, InstrumentDef, EnvelopeDef, FilterDef } from '../loaders/sound_effects'
import { emptyInstrument } from '../loaders/sound_effects'
import { mixToFloat, SAMPLE_RATE } from '../loaders/soundSynth'
import { NumberInput, NumGrid } from './defFields'
import EnvelopeGraph from './EnvelopeGraph'
import './SoundEffectViewer.css'

const FORM_OPTIONS = [
  [0, '0 — None'],
  [1, '1 — Square'],
  [2, '2 — Sine'],
  [3, '3 — Sawtooth'],
  [4, '4 — Noise'],
] as const

function emptyEnvelope(): EnvelopeDef {
  return { form: 1, start: 0, end: 0, numPhases: 2, phaseDuration: [0, 65535], phasePeak: [0, 65535] }
}

// ---------------------------------------------------------------------------
// Live synthesis + waveform preview. The TS port of the client's synth
// engine (soundSynth.ts, verified sample-exact against the dumped WAVs)
// re-renders the audio ~instantly after every edit — no re-dump needed.
// ---------------------------------------------------------------------------

let sharedAudioContext: AudioContext | null = null
function audioContext(): AudioContext {
  if (!sharedAudioContext) sharedAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
  return sharedAudioContext
}

function WaveformPreview({ def, dumpedWavUrl }: { def: SoundEffectDef; dumpedWavUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pcm, setPcm] = useState<Float32Array | null>(null)
  const [error, setError] = useState<string | null>(null)
  const playRef = useRef<{ source: AudioBufferSourceNode; startedAt: number; duration: number } | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  // Debounced re-synthesis on every edit.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setPcm(mixToFloat(def))
        setError(null)
      } catch (e) {
        setPcm(null)
        setError(String(e))
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [def])

  // Waveform + loop markers + (while playing) the moving playhead.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width, h = canvas.height
    let raf = 0

    function draw() {
      const c = ctx!
      c.clearRect(0, 0, w, h)
      c.fillStyle = '#0a0c12'
      c.beginPath()
      c.roundRect(0, 0, w, h, 10)
      c.fill()

      const mid = h / 2
      c.strokeStyle = 'rgba(255,255,255,0.08)'
      c.beginPath()
      c.moveTo(8, mid)
      c.lineTo(w - 8, mid)
      c.stroke()

      if (!pcm || pcm.length === 0) {
        c.fillStyle = 'rgba(139,147,163,0.8)'
        c.font = '12px system-ui'
        c.textAlign = 'center'
        c.fillText(error ? 'synthesis failed — see note below' : 'no audio (all instrument slots empty)', w / 2, mid + 4)
        return
      }

      // min/max column rendering, audio-editor style
      const usable = w - 16
      const perPx = pcm.length / usable
      c.strokeStyle = 'rgba(47,143,255,0.9)'
      c.lineWidth = 1
      c.beginPath()
      for (let x = 0; x < usable; x++) {
        const from = Math.floor(x * perPx)
        const to = Math.min(pcm.length, Math.max(from + 1, Math.floor((x + 1) * perPx)))
        let lo = 1, hi = -1
        for (let i = from; i < to; i++) {
          if (pcm[i] < lo) lo = pcm[i]
          if (pcm[i] > hi) hi = pcm[i]
        }
        c.moveTo(x + 8, mid - hi * (mid - 8))
        c.lineTo(x + 8, mid - lo * (mid - 8))
      }
      c.stroke()

      // loop markers (loopBegin/loopEnd are milliseconds)
      const totalMs = (pcm.length / SAMPLE_RATE) * 1000
      if (def.loopEnd > def.loopBegin && totalMs > 0) {
        for (const [ms, label] of [[def.loopBegin, 'loop start'], [def.loopEnd, 'loop end']] as const) {
          const x = 8 + (ms / totalMs) * usable
          if (x < 8 || x > w - 8) continue
          c.strokeStyle = 'rgba(255,196,0,0.75)'
          c.setLineDash([4, 3])
          c.beginPath()
          c.moveTo(x, 6)
          c.lineTo(x, h - 6)
          c.stroke()
          c.setLineDash([])
          c.fillStyle = 'rgba(255,196,0,0.9)'
          c.font = '9px system-ui'
          c.textAlign = 'left'
          c.fillText(label, x + 3, 14)
        }
      }

      // playhead
      const playing = playRef.current
      if (playing) {
        const elapsed = audioContext().currentTime - playing.startedAt
        if (elapsed <= playing.duration) {
          const x = 8 + (elapsed / playing.duration) * usable
          c.strokeStyle = '#fff'
          c.lineWidth = 1.5
          c.beginPath()
          c.moveTo(x, 4)
          c.lineTo(x, h - 4)
          c.stroke()
          raf = requestAnimationFrame(draw)
        }
      }
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [pcm, error, def.loopBegin, def.loopEnd, isPlaying, def])

  function stop() {
    playRef.current?.source.stop()
    playRef.current = null
    setIsPlaying(false)
  }

  function play() {
    if (!pcm || pcm.length === 0) return
    stop()
    const ctx = audioContext()
    void ctx.resume()
    const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE)
    buffer.copyToChannel(new Float32Array(pcm), 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => {
      if (playRef.current?.source === source) {
        playRef.current = null
        setIsPlaying(false)
      }
    }
    source.start()
    playRef.current = { source, startedAt: ctx.currentTime, duration: pcm.length / SAMPLE_RATE }
    setIsPlaying(true)
  }

  useEffect(() => () => playRef.current?.source.stop(), [])

  const durationMs = pcm ? Math.round((pcm.length / SAMPLE_RATE) * 1000) : 0

  return (
    <div className="sfx-wave-wrap">
      <canvas ref={canvasRef} width={860} height={150} className="sfx-wave-canvas" />
      <div className="sfx-wave-controls">
        <button type="button" className="sfx-play-btn" onClick={isPlaying ? stop : play} disabled={!pcm || pcm.length === 0}>
          {isPlaying ? '■ Stop' : '▶ Play'}
        </button>
        <span className="sfx-wave-meta">
          {pcm ? `${durationMs} ms · ${pcm.length.toLocaleString()} samples @ ${SAMPLE_RATE} Hz` : '—'}
          {' · synthesized live from the current edits'}
        </span>
        {dumpedWavUrl && (
          <span className="sfx-dumped">
            <span className="sfx-wave-meta">dumped preview:</span>
            <audio controls src={dumpedWavUrl} className="sfx-audio" />
          </span>
        )}
      </div>
      {error && <p className="tex-op-note">Synthesis failed: {error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Envelope editor — drawn curve + the editable breakpoint table
// ---------------------------------------------------------------------------

function EnvelopeEditor({ label, envelope, onChange, accent }: {
  label: string
  envelope: EnvelopeDef
  onChange: (next: EnvelopeDef) => void
  accent?: string
}) {
  function setPhase(i: number, which: 'phaseDuration' | 'phasePeak', value: number) {
    const arr = [...envelope[which]]
    arr[i] = value
    onChange({ ...envelope, [which]: arr })
  }
  function addPhase() {
    onChange({
      ...envelope,
      numPhases: envelope.numPhases + 1,
      phaseDuration: [...envelope.phaseDuration, 65535],
      phasePeak: [...envelope.phasePeak, 0],
    })
  }
  function removePhase(i: number) {
    const phaseDuration = envelope.phaseDuration.filter((_, idx) => idx !== i)
    const phasePeak = envelope.phasePeak.filter((_, idx) => idx !== i)
    onChange({ ...envelope, numPhases: phaseDuration.length, phaseDuration, phasePeak })
  }

  const points = envelope.phaseDuration.map((d, i) => ({ x: d, y: envelope.phasePeak[i] ?? 0 }))

  return (
    <div className="sfx-envelope">
      <div className="sfx-envelope-title">{label}</div>
      <div className="sfx-envelope-body">
        <div className="sfx-envelope-graph">
          <EnvelopeGraph points={points} xMax={65535} yDomain={[0, 65535]} color={accent ?? 'var(--electric-blue-bright)'} label={`peak over time (maps to ${envelope.start} → ${envelope.end})`} />
        </div>
        <div className="sfx-envelope-fields">
          <div className="item-grid">
            <label className="item-field">
              <span className="item-field-label">Wave Form</span>
              <select value={envelope.form} onChange={(e) => onChange({ ...envelope, form: Number(e.target.value) })}>
                {FORM_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="item-field">
              <span className="item-field-label">Start</span>
              <NumberInput value={envelope.start} onChange={(v) => onChange({ ...envelope, start: v })} />
            </label>
            <label className="item-field">
              <span className="item-field-label">End</span>
              <NumberInput value={envelope.end} onChange={(v) => onChange({ ...envelope, end: v })} />
            </label>
          </div>
          <div className="quest-table-wrap uniform">
            <table className="quest-table">
              <thead><tr><th>Time (0–65535)</th><th>Peak (0–65535)</th><th></th></tr></thead>
              <tbody>
                {envelope.phaseDuration.map((d, i) => (
                  <tr key={i}>
                    <td><NumberInput className="cell-input" value={d} onChange={(v) => setPhase(i, 'phaseDuration', v)} min={0} max={65535} /></td>
                    <td><NumberInput className="cell-input" value={envelope.phasePeak[i] ?? 0} onChange={(v) => setPhase(i, 'phasePeak', v)} min={0} max={65535} /></td>
                    <td><button type="button" className="row-remove-btn" disabled={envelope.phaseDuration.length <= 1} onClick={() => removePhase(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="add-row-btn" onClick={addPhase}>+ Add phase</button>
        </div>
      </div>
    </div>
  )
}

function OptionalEnvelopePair({ title, a, b, onSetA, onSetB, labelA = 'Modifier', labelB = 'Amplitude' }: {
  title: string
  a: EnvelopeDef | null
  b: EnvelopeDef | null
  onSetA: (e: EnvelopeDef | null) => void
  onSetB: (e: EnvelopeDef | null) => void
  labelA?: string
  labelB?: string
}) {
  if (a == null) {
    return (
      <section className="item-section">
        <h3>{title}</h3>
        <button type="button" className="add-row-btn" onClick={() => { onSetA(emptyEnvelope()); onSetB(emptyEnvelope()) }}>
          + Add {title}
        </button>
      </section>
    )
  }
  return (
    <section className="item-section">
      <h3>{title}</h3>
      <EnvelopeEditor label={labelA} envelope={a} onChange={onSetA} accent="hsl(280 70% 65%)" />
      <EnvelopeEditor label={labelB} envelope={b ?? emptyEnvelope()} onChange={onSetB} accent="hsl(320 70% 65%)" />
      <button type="button" className="row-remove-btn sfx-remove-pair" onClick={() => { onSetA(null); onSetB(null) }}>
        Remove {title}
      </button>
    </section>
  )
}

// Filters are rare (most instruments carry numPairs [0,0]) and their two
// biquad-style coefficient arrays are the most opaque part of the format —
// exposed as raw editable grids rather than a bespoke widget. The migrated
// bitmask (which [dir][term] pairs decode a *distinct* end-of-envelope
// value vs. reusing the start value) is kept in sync automatically here so
// edits round-trip through cryogen's encode() correctly.
function FilterEditor({ filter, filterEnvelope, onChangeFilter, onChangeEnvelope }: {
  filter: FilterDef
  filterEnvelope: EnvelopeDef
  onChangeFilter: (f: FilterDef) => void
  onChangeEnvelope: (e: EnvelopeDef) => void
}) {
  function setNumPairs(dir: 0 | 1, value: number) {
    const clamped = Math.max(0, Math.min(4, value))
    const numPairs: [number, number] = [...filter.numPairs]
    numPairs[dir] = clamped
    onChangeFilter({ ...filter, numPairs })
  }
  function setUnity(dir: 0 | 1, value: number) {
    const unity: [number, number] = [...filter.unity]
    unity[dir] = value
    onChangeFilter({ ...filter, unity })
  }
  function setPair(dir: number, phase: 0 | 1, term: number, which: 'pairPhase' | 'pairMagnitude', value: number) {
    const next = filter[which].map((d) => d.map((p) => [...p]))
    next[dir][phase][term] = value
    let migrated = filter.migrated
    const differs = next[dir][1][term] !== next[dir][0][term]
    const bit = 1 << (dir * 4) << term
    migrated = differs ? migrated | bit : migrated & ~bit
    onChangeFilter({ ...filter, [which]: next, migrated })
  }

  if (filter.numPairs[0] === 0 && filter.numPairs[1] === 0) {
    return (
      <button type="button" className="add-row-btn" onClick={() => setNumPairs(0, 1)}>+ Add filter (numerator pair)</button>
    )
  }

  return (
    <div className="sfx-filter">
      <div className="item-grid">
        <label className="item-field">
          <span className="item-field-label">Numerator Pairs (0-4)</span>
          <NumberInput value={filter.numPairs[0]} onChange={(v) => setNumPairs(0, v)} min={0} max={4} />
        </label>
        <label className="item-field">
          <span className="item-field-label">Denominator Pairs (0-4)</span>
          <NumberInput value={filter.numPairs[1]} onChange={(v) => setNumPairs(1, v)} min={0} max={4} />
        </label>
        <label className="item-field">
          <span className="item-field-label">Unity Start</span>
          <NumberInput value={filter.unity[0]} onChange={(v) => setUnity(0, v)} />
        </label>
        <label className="item-field">
          <span className="item-field-label">Unity End</span>
          <NumberInput value={filter.unity[1]} onChange={(v) => setUnity(1, v)} />
        </label>
      </div>
      {([0, 1] as const).map((dir) => filter.numPairs[dir] > 0 && (
        <div key={dir} className="quest-table-wrap uniform">
          <div className="sfx-envelope-title">{dir === 0 ? 'Numerator' : 'Denominator'} Pairs</div>
          <table className="quest-table">
            <thead><tr><th>#</th><th>Phase (start)</th><th>Magnitude (start)</th><th>Phase (end)</th><th>Magnitude (end)</th></tr></thead>
            <tbody>
              {Array.from({ length: filter.numPairs[dir] }, (_, term) => (
                <tr key={term}>
                  <td>{term + 1}</td>
                  <td><NumberInput className="cell-input" value={filter.pairPhase[dir][0][term]} onChange={(v) => setPair(dir, 0, term, 'pairPhase', v)} /></td>
                  <td><NumberInput className="cell-input" value={filter.pairMagnitude[dir][0][term]} onChange={(v) => setPair(dir, 0, term, 'pairMagnitude', v)} /></td>
                  <td><NumberInput className="cell-input" value={filter.pairPhase[dir][1][term]} onChange={(v) => setPair(dir, 1, term, 'pairPhase', v)} /></td>
                  <td><NumberInput className="cell-input" value={filter.pairMagnitude[dir][1][term]} onChange={(v) => setPair(dir, 1, term, 'pairMagnitude', v)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <EnvelopeEditor label="Filter Envelope" envelope={filterEnvelope} onChange={onChangeEnvelope} accent="hsl(160 70% 55%)" />
      <button type="button" className="row-remove-btn sfx-remove-pair" onClick={() => onChangeFilter({ numPairs: [0, 0], pairPhase: filter.pairPhase, pairMagnitude: filter.pairMagnitude, unity: [0, 0], migrated: 0 })}>
        Remove Filter
      </button>
    </div>
  )
}

function InstrumentEditor({ instrument, onChange, onRemove }: {
  instrument: InstrumentDef
  onChange: (next: InstrumentDef) => void
  onRemove: () => void
}) {
  function set<K extends keyof InstrumentDef>(key: K, value: InstrumentDef[K]) {
    onChange({ ...instrument, [key]: value })
  }
  function setOsc(which: 'oscillatorVolume' | 'oscillatorPitch' | 'oscillatorDelays', i: number, value: number) {
    const arr = [...instrument[which]]
    arr[i] = value
    onChange({ ...instrument, [which]: arr })
  }

  return (
    <div className="sfx-instrument">
      <section className="item-section">
        <h3>Timing</h3>
        <NumGrid
          fields={[['duration', 'Duration (ms)'], ['offset', 'Offset (ms)'], ['delayTime', 'Echo Delay'], ['delayDecay', 'Echo Decay %']]}
          values={instrument}
          onChange={(k, v) => set(k as keyof InstrumentDef, v as never)}
        />
      </section>

      <section className="item-section">
        <h3>Oscillators</h3>
        <p className="tex-op-note">Up to 5 additive voices — volume in %, pitch in semitone-ish steps relative to the pitch envelope, delay in ms.</p>
        <div className="quest-table-wrap uniform">
          <table className="quest-table">
            <thead><tr><th>#</th><th>Volume</th><th>Pitch</th><th>Delay</th></tr></thead>
            <tbody>
              {[0, 1, 2, 3, 4].map((i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><NumberInput className="cell-input" value={instrument.oscillatorVolume[i]} onChange={(v) => setOsc('oscillatorVolume', i, v)} min={0} /></td>
                  <td><NumberInput className="cell-input" value={instrument.oscillatorPitch[i]} onChange={(v) => setOsc('oscillatorPitch', i, v)} /></td>
                  <td><NumberInput className="cell-input" value={instrument.oscillatorDelays[i]} onChange={(v) => setOsc('oscillatorDelays', i, v)} min={0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="item-section">
        <h3>Pitch Envelope</h3>
        <EnvelopeEditor label="Pitch (Hz sweep)" envelope={instrument.pitch} onChange={(e) => set('pitch', e)} accent="hsl(38 90% 60%)" />
      </section>

      <section className="item-section">
        <h3>Volume Envelope</h3>
        <EnvelopeEditor label="Volume" envelope={instrument.volume} onChange={(e) => set('volume', e)} accent="var(--electric-blue-bright)" />
      </section>

      <OptionalEnvelopePair
        title="Pitch Modifier"
        a={instrument.pitchModifier} b={instrument.pitchModifierAmplitude}
        onSetA={(e) => set('pitchModifier', e)} onSetB={(e) => set('pitchModifierAmplitude', e)}
        labelA="Modifier" labelB="Amplitude"
      />
      <OptionalEnvelopePair
        title="Volume Multiplier"
        a={instrument.volumeMultiplier} b={instrument.volumeAmplitude}
        onSetA={(e) => set('volumeMultiplier', e)} onSetB={(e) => set('volumeAmplitude', e)}
        labelA="Multiplier" labelB="Amplitude"
      />
      <OptionalEnvelopePair
        title="Release / Attack"
        a={instrument.release} b={instrument.attack}
        onSetA={(e) => set('release', e)} onSetB={(e) => set('attack', e)}
        labelA="Release" labelB="Attack"
      />

      <section className="item-section">
        <h3>Filter <span className="sfx-advanced-note">(advanced)</span></h3>
        <FilterEditor
          filter={instrument.filter}
          filterEnvelope={instrument.filterEnvelope}
          onChangeFilter={(f) => set('filter', f)}
          onChangeEnvelope={(e) => set('filterEnvelope', e)}
        />
      </section>

      <button type="button" className="row-remove-btn sfx-remove-instrument" onClick={onRemove}>Remove Instrument</button>
    </div>
  )
}

export default function SoundEffectViewer({ data, onSave, onDirtyChange }: {
  data: SoundEffectData
  onSave: (data: SoundEffectData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [def, setDef] = useState<SoundEffectDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState(() => data.def.instruments.findIndex((i) => i != null))

  useEffect(() => {
    setDef(data.def)
    setIsDirty(false)
    setSelectedSlot(data.def.instruments.findIndex((i) => i != null))
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function setInstruments(instruments: (InstrumentDef | null)[]) {
    setDef((prev) => ({ ...prev, instruments }))
    setIsDirty(true)
  }

  function updateSlot(i: number, instrument: InstrumentDef) {
    const instruments = [...def.instruments]
    instruments[i] = instrument
    setInstruments(instruments)
  }

  function addSlot(i: number) {
    const instruments = [...def.instruments]
    instruments[i] = emptyInstrument()
    setInstruments(instruments)
    setSelectedSlot(i)
  }

  function removeSlot(i: number) {
    const instruments = [...def.instruments]
    instruments[i] = null
    setInstruments(instruments)
    if (selectedSlot === i) setSelectedSlot(instruments.findIndex((x) => x != null))
  }

  function setLoop(key: 'loopBegin' | 'loopEnd', value: number) {
    setDef((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDef(data.def)
    setIsDirty(false)
  }

  const selected = selectedSlot >= 0 ? def.instruments[selectedSlot] : null

  return (
    <div className="sfx-viewer">
      <div className="sfx-header">
        <span className="item-id-badge">Sound Effect {data.id}</span>
      </div>

      <WaveformPreview def={def} dumpedWavUrl={data.wavUrl} />

      <section className="item-section">
        <h3>Loop</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Loop Begin (ms)</span>
            <NumberInput value={def.loopBegin} onChange={(v) => setLoop('loopBegin', v)} min={0} max={65535} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Loop End (ms)</span>
            <NumberInput value={def.loopEnd} onChange={(v) => setLoop('loopEnd', v)} min={0} max={65535} />
          </label>
        </div>
      </section>

      <div className="sfx-slots">
        {def.instruments.map((instrument, i) => (
          <button
            key={i}
            type="button"
            className={`sfx-slot-btn${instrument != null ? ' populated' : ''}${selectedSlot === i ? ' selected' : ''}`}
            onClick={() => (instrument != null ? setSelectedSlot(i) : addSlot(i))}
          >
            {i + 1}{instrument == null && <span className="sfx-slot-add">+</span>}
          </button>
        ))}
      </div>

      {selected && (
        <InstrumentEditor
          instrument={selected}
          onChange={(next) => updateSlot(selectedSlot, next)}
          onRemove={() => removeSlot(selectedSlot)}
        />
      )}

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
