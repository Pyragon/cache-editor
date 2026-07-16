import { useEffect, useState } from 'react'
import type { SoundEffectData, SoundEffectDef, InstrumentDef, EnvelopeDef, FilterDef } from '../loaders/sound_effects'
import { emptyInstrument } from '../loaders/sound_effects'
import { NumberInput, NumGrid } from './defFields'
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

function EnvelopeEditor({ label, envelope, onChange }: {
  label: string
  envelope: EnvelopeDef
  onChange: (next: EnvelopeDef) => void
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

  return (
    <div className="sfx-envelope">
      <div className="sfx-envelope-title">{label}</div>
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
          <thead><tr><th>Phase Duration</th><th>Phase Peak</th><th>Remove</th></tr></thead>
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
      <EnvelopeEditor label={labelA} envelope={a} onChange={onSetA} />
      <EnvelopeEditor label={labelB} envelope={b ?? emptyEnvelope()} onChange={onSetB} />
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
      <EnvelopeEditor label="Filter Envelope" envelope={filterEnvelope} onChange={onChangeEnvelope} />
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
        <EnvelopeEditor label="Pitch" envelope={instrument.pitch} onChange={(e) => set('pitch', e)} />
      </section>

      <section className="item-section">
        <h3>Volume Envelope</h3>
        <EnvelopeEditor label="Volume" envelope={instrument.volume} onChange={(e) => set('volume', e)} />
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
        {data.wavUrl
          ? <audio controls src={data.wavUrl} className="sfx-audio" />
          : <span className="sfx-no-preview">No dumped preview — live re-synthesis after edits isn't implemented yet (see TODO); re-dump the cache to hear changes.</span>}
      </div>

      <section className="item-section">
        <h3>Loop</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Loop Begin (ticks)</span>
            <NumberInput value={def.loopBegin} onChange={(v) => setLoop('loopBegin', v)} min={0} max={65535} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Loop End (ticks)</span>
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
