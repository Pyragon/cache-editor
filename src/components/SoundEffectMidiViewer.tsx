import { useEffect, useMemo, useRef, useState } from 'react'
import type { SoundEffectMidiData, SoundEffectMidiDef, SoundEffectMidiZone } from '../loaders/sound_effects_midi'
import { groupNoteRanges, resolveSample } from '../loaders/sound_effects_midi'
import { NumberInput, NumGrid, PairTable } from './defFields'
import type { NumFieldDef } from './defFields'
import EnvelopeGraph from './EnvelopeGraph'
import type { EnvelopePoint } from './EnvelopeGraph'
import './SoundEffectMidiViewer.css'

const ZONE_FIELDS: NumFieldDef[] = [
  ['decayRate', 'Decay Rate'],
  ['decayRateScale', 'Decay Scale'],
  ['sustainRate', 'Sustain Rate'],
  ['releaseRate', 'Release Rate'],
  ['vibratoRate', 'Vibrato Rate'],
  ['vibratoDepth', 'Vibrato Depth'],
  ['vibratoDelay', 'Vibrato Delay'],
]

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK = new Set([1, 3, 6, 8, 10])

function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`
}

/** Distinct, stable hue per zone index (golden-angle walk). */
function zoneHue(zone: number): number {
  return Math.round((zone * 137.508) % 360)
}

// ---------------------------------------------------------------------------
// Piano keymap
// ---------------------------------------------------------------------------

const WHITE_W = 12
const WHITE_H = 64
const BLACK_W = 7.5
const BLACK_H = 40
const LABEL_H = 14

// Precomputed white-key index per note (position along the keyboard).
const WHITE_INDEX: number[] = []
{
  let w = 0
  for (let n = 0; n < 128; n++) {
    WHITE_INDEX[n] = w
    if (!BLACK.has(n % 12)) w++
  }
}
const WHITE_COUNT = WHITE_INDEX[127] + 1
const KEYBOARD_W = WHITE_COUNT * WHITE_W

/** Center x of a note's key, for aligning overlays. */
function noteCenterX(note: number): number {
  if (BLACK.has(note % 12)) return (WHITE_INDEX[note] + 1) * WHITE_W
  return WHITE_INDEX[note] * WHITE_W + WHITE_W / 2
}

function PianoKeymap({ def, selected, onSelect }: {
  def: SoundEffectMidiDef
  selected: { lo: number; hi: number; note: number } | null
  onSelect: (note: number) => void
}) {
  function keyTitle(note: number): string {
    const sample = resolveSample(def.sampleCode[note] ?? 0)
    const zone = def.zoneIndex[note] ?? -1
    if (!sample) return `${noteName(note)} (${note}) — unmapped`
    const kind = sample.entry === 'sound_effects' ? 'SFX' : 'Sample'
    return `${noteName(note)} (${note}) — ${kind} ${sample.id} · zone ${zone} · pan ${def.pan[note]} · vol ${def.volume[note]}`
  }

  function keyFill(note: number, black: boolean): string {
    if ((def.sampleCode[note] ?? 0) === 0) return black ? '#1a1c22' : '#f2f3f5'
    const h = zoneHue(def.zoneIndex[note] ?? 0)
    return black ? `hsl(${h} 62% 40%)` : `hsl(${h} 58% 76%)`
  }

  const whites: number[] = []
  const blacks: number[] = []
  for (let n = 0; n < 128; n++) (BLACK.has(n % 12) ? blacks : whites).push(n)

  return (
    <div className="sem-keyboard-scroll">
      <svg width={KEYBOARD_W} height={WHITE_H + LABEL_H + 6} className="sem-keyboard">
        {whites.map((n) => (
          <rect
            key={n}
            x={WHITE_INDEX[n] * WHITE_W}
            y={0}
            width={WHITE_W - 0.75}
            height={WHITE_H}
            rx={1.5}
            fill={keyFill(n, false)}
            stroke={selected?.note === n ? 'var(--electric-blue-bright)' : 'rgba(0,0,0,0.45)'}
            strokeWidth={selected?.note === n ? 2 : 0.75}
            className="sem-key"
            onClick={() => onSelect(n)}
          >
            <title>{keyTitle(n)}</title>
          </rect>
        ))}
        {blacks.map((n) => (
          <rect
            key={n}
            x={(WHITE_INDEX[n] + 1) * WHITE_W - BLACK_W / 2}
            y={0}
            width={BLACK_W}
            height={BLACK_H}
            rx={1.5}
            fill={keyFill(n, true)}
            stroke={selected?.note === n ? 'var(--electric-blue-bright)' : 'rgba(0,0,0,0.7)'}
            strokeWidth={selected?.note === n ? 2 : 0.75}
            className="sem-key"
            onClick={() => onSelect(n)}
          >
            <title>{keyTitle(n)}</title>
          </rect>
        ))}
        {selected && (
          <rect
            x={(BLACK.has(selected.lo % 12) ? noteCenterX(selected.lo) - BLACK_W / 2 : WHITE_INDEX[selected.lo] * WHITE_W)}
            y={WHITE_H + 2}
            width={Math.max(
              WHITE_W,
              (BLACK.has(selected.hi % 12) ? noteCenterX(selected.hi) + BLACK_W / 2 : (WHITE_INDEX[selected.hi] + 1) * WHITE_W)
              - (BLACK.has(selected.lo % 12) ? noteCenterX(selected.lo) - BLACK_W / 2 : WHITE_INDEX[selected.lo] * WHITE_W),
            )}
            height={4}
            rx={2}
            fill="var(--electric-blue-bright)"
          />
        )}
        {whites.filter((n) => n % 12 === 0).map((n) => (
          <text key={`l${n}`} x={WHITE_INDEX[n] * WHITE_W + 2} y={WHITE_H + LABEL_H} className="sem-octave-label">
            {noteName(n)}
          </text>
        ))}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vibrato wave — a live sine at the zone's rate/depth, with the onset ramp
// (vibratoDelay) replayed every few seconds so the fade-in is visible.
// ---------------------------------------------------------------------------

function VibratoWave({ rate, depth, delay, hue }: { rate: number; depth: number; delay: number; hue: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width, h = canvas.height
    let raf = 0
    let last = 0
    const start = performance.now()

    function draw(now: number) {
      raf = requestAnimationFrame(draw)
      if (now - last < 33) return // ~30fps is plenty for an indicator
      last = now
      const c = ctx!

      c.clearRect(0, 0, w, h)
      c.fillStyle = '#0a0c12'
      c.beginPath()
      c.roundRect(0, 0, w, h, 8)
      c.fill()

      const mid = h / 2
      c.strokeStyle = 'rgba(255,255,255,0.08)'
      c.beginPath()
      c.moveTo(6, mid)
      c.lineTo(w - 6, mid)
      c.stroke()

      // Onset cycle: restart every 4s so the delay ramp reads visually.
      const t = ((now - start) / 1000) % 4
      const ramp = delay > 0 ? Math.min(1, t / (delay / 30)) : 1
      const amp = Math.min(1, depth / 48) * (mid - 7) * ramp
      const cycles = 2 + Math.min(rate, 200) / 24
      const phase = ((now - start) / 1000) * (0.5 + rate / 40) * Math.PI * 2

      c.strokeStyle = `hsl(${hue} 70% 62%)`
      c.lineWidth = 1.8
      c.beginPath()
      for (let x = 6; x <= w - 6; x++) {
        const y = mid + amp * Math.sin(((x - 6) / (w - 12)) * cycles * Math.PI * 2 - phase)
        if (x === 6) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.stroke()
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [rate, depth, delay, hue])

  return <canvas ref={canvasRef} width={260} height={52} className="sem-vibrato" title="Vibrato LFO at this zone's rate/depth; the fade-in replays every 4s to show the onset delay" />
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

type Props = {
  data: SoundEffectMidiData
  onSave: (data: SoundEffectMidiData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

function envelopePoints(envelope: number[] | undefined): EnvelopePoint[] {
  const points: EnvelopePoint[] = []
  for (let i = 0; i + 1 < (envelope?.length ?? 0); i += 2) points.push({ x: envelope![i], y: envelope![i + 1] })
  return points
}

export default function SoundEffectMidiViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<SoundEffectMidiDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [selectedNote, setSelectedNote] = useState<number | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
    setSelectedNote(null)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const ranges = useMemo(() => groupNoteRanges(draft), [draft])

  const selected = useMemo(() => {
    if (selectedNote == null) return null
    const range = ranges.find((r) => selectedNote >= r.lowNote && selectedNote <= r.highNote)
    if (!range) return null
    return { lo: range.lowNote, hi: range.highNote, note: selectedNote, range }
  }, [selectedNote, ranges])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  /** Writes one per-note array value across the selected contiguous range. */
  function setRange(key: 'sampleCode' | 'chokeGroup' | 'pan' | 'volume' | 'zoneIndex', value: number) {
    if (!selected) return
    setDraft((prev) => {
      const arr = prev[key].slice()
      for (let n = selected.lo; n <= selected.hi; n++) arr[n] = value
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  /** Tuning is genuinely per-note (a curve across the keyboard) — edits apply to the clicked note only. */
  function setNoteTuning(key: 'tuningCoarse' | 'tuningFine', value: number) {
    if (!selected) return
    setDraft((prev) => {
      const arr = prev[key].slice()
      arr[selected.note] = value
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  function setSampleKind(kind: 'none' | 'sound_effects' | 'midi_instruments') {
    if (!selected) return
    if (kind === 'none') { setRange('sampleCode', 0); return }
    const current = resolveSample(selected.range.sampleCode)
    const id = current?.id ?? 0
    setRange('sampleCode', ((id << 2) | (kind === 'midi_instruments' ? 1 : 0)) + 1)
  }

  function setSampleId(id: number) {
    if (!selected) return
    const current = resolveSample(selected.range.sampleCode)
    const bit = current?.entry === 'midi_instruments' ? 1 : 0
    setRange('sampleCode', ((Math.max(0, id) << 2) | bit) + 1)
  }

  function setZone(index: number, patch: Partial<SoundEffectMidiZone>) {
    setDraft((prev) => {
      const zones = prev.zones.slice()
      zones[index] = { ...zones[index], ...patch }
      return { ...prev, zones }
    })
    setIsDirty(true)
  }

  function setEnvelopePair(zoneIndex: number, key: 'sustainEnvelope' | 'releaseEnvelope', pairIndex: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const zones = prev.zones.slice()
      const zone = { ...zones[zoneIndex] }
      const envelope = (zone[key] ?? []).slice()
      envelope[pairIndex * 2 + which] = value
      zone[key] = envelope
      zones[zoneIndex] = zone
      return { ...prev, zones }
    })
    setIsDirty(true)
  }

  function addEnvelopePair(zoneIndex: number, key: 'sustainEnvelope' | 'releaseEnvelope') {
    setDraft((prev) => {
      const zones = prev.zones.slice()
      const zone = { ...zones[zoneIndex] }
      const envelope = (zone[key] ?? []).slice()
      const lastX = envelope.length >= 2 ? envelope[envelope.length - 2] : 0
      envelope.push(lastX + 1, 0)
      zone[key] = envelope
      zones[zoneIndex] = zone
      return { ...prev, zones }
    })
    setIsDirty(true)
  }

  function removeEnvelopePair(zoneIndex: number, key: 'sustainEnvelope' | 'releaseEnvelope', pairIndex: number) {
    setDraft((prev) => {
      const zones = prev.zones.slice()
      const zone = { ...zones[zoneIndex] }
      const envelope = (zone[key] ?? []).slice()
      envelope.splice(pairIndex * 2, 2)
      zone[key] = envelope.length > 0 ? envelope : undefined
      zones[zoneIndex] = zone
      return { ...prev, zones }
    })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const mappedCount = draft.sampleCode.filter((c) => c !== 0).length
  const zoneNoteCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (let n = 0; n < 128; n++) {
      if ((draft.sampleCode[n] ?? 0) === 0) continue
      const z = draft.zoneIndex[n] ?? -1
      counts.set(z, (counts.get(z) ?? 0) + 1)
    }
    return counts
  }, [draft])

  const selectedSample = selected ? resolveSample(selected.range.sampleCode) : null

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Sound Effect Midi {data.id}</span>
          <span className="item-stack-index">{mappedCount}/128 notes mapped · {draft.zones.length} zone{draft.zones.length === 1 ? '' : 's'}</span>
        </div>
        <label className="item-field sem-gain-field">
          <span className="item-field-label">Global Gain</span>
          <NumberInput value={draft.globalGain} onChange={(v) => set('globalGain', v)} min={1} max={256} />
        </label>
      </div>

      <section className="item-section">
        <h3>Note Keymap</h3>
        <p className="tex-op-note">
          Each key is coloured by the zone it plays through — click a key to inspect and edit its range.
          The actual audio lives in the <code>sound_effects</code> / <code>midi_instruments</code> indices; this
          instrument only maps notes onto those samples.
        </p>
        <div className="sem-keyboard-wrap">
          <PianoKeymap def={draft} selected={selected} onSelect={setSelectedNote} />
          <div className="sem-legend">
            {draft.zones.map((_, i) => (
              <span key={i} className="sem-legend-item">
                <span className="sem-swatch" style={{ background: `hsl(${zoneHue(i)} 62% 55%)` }} />
                zone {i} · {zoneNoteCounts.get(i) ?? 0} notes
              </span>
            ))}
            <span className="sem-legend-item">
              <span className="sem-swatch sem-swatch-unmapped" />
              unmapped
            </span>
          </div>
        </div>
      </section>

      {selected && (
        <section className="item-section sem-detail">
          <h3>
            {selected.lo === selected.hi
              ? `${noteName(selected.note)} (${selected.note})`
              : `${noteName(selected.note)} (${selected.note}) — range ${noteName(selected.lo)}–${noteName(selected.hi)}`}
          </h3>
          <div className="item-grid">
            <label className="item-field">
              <span className="item-field-label">Sample Source</span>
              <select
                className="cell-input"
                value={selectedSample?.entry ?? 'none'}
                onChange={(e) => setSampleKind(e.target.value as 'none' | 'sound_effects' | 'midi_instruments')}
              >
                <option value="none">— unmapped —</option>
                <option value="sound_effects">Sound Effect (synth)</option>
                <option value="midi_instruments">Instrument Sample (ogg)</option>
              </select>
            </label>
            {selectedSample && (
              <label className="item-field">
                <span className={`item-field-label${onNavigate ? ' field-link-label' : ''}`}>
                  <span>Sample ID</span>
                  {onNavigate && (
                    <button type="button" className="field-link-btn" onClick={() => onNavigate(selectedSample.entry, selectedSample.id)}>View</button>
                  )}
                </span>
                <NumberInput value={selectedSample.id} onChange={setSampleId} min={0} />
              </label>
            )}
            <label className="item-field">
              <span className="item-field-label">Zone</span>
              <select
                className="cell-input"
                value={selected.range.zoneIndex}
                onChange={(e) => setRange('zoneIndex', parseInt(e.target.value, 10))}
              >
                <option value={-1}>— none —</option>
                {draft.zones.map((_, i) => <option key={i} value={i}>zone {i}</option>)}
              </select>
            </label>
            <label className="item-field">
              <span className="item-field-label">Pan (0–128)</span>
              <NumberInput value={selected.range.pan} onChange={(v) => setRange('pan', v)} min={0} max={128} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Volume</span>
              <NumberInput value={selected.range.volume} onChange={(v) => setRange('volume', v)} min={0} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Choke Group (−1 = none)</span>
              <NumberInput value={selected.range.chokeGroup} onChange={(v) => setRange('chokeGroup', v)} min={-1} />
            </label>
            <label className="item-field">
              <span className="item-field-label" title="Tuning is a per-note curve — this edits only the clicked note">Tuning Coarse (this note)</span>
              <NumberInput value={draft.tuningCoarse[selected.note] ?? 0} onChange={(v) => setNoteTuning('tuningCoarse', v)} />
            </label>
            <label className="item-field">
              <span className="item-field-label" title="Tuning is a per-note curve — this edits only the clicked note">Tuning Fine (this note)</span>
              <NumberInput value={draft.tuningFine[selected.note] ?? 0} onChange={(v) => setNoteTuning('tuningFine', v)} />
            </label>
          </div>
          <p className="tex-op-note">Edits apply to the whole contiguous range (except tuning, which is per-note).</p>
        </section>
      )}

      {(draft.volumeCurve || draft.panCurve) && (
        <section className="item-section">
          <h3>Keyboard-wide Curves</h3>
          <p className="tex-op-note">
            Baked into per-note volume/pan by the client at load time — preserved verbatim for a byte-exact repack, shown here read-only.
          </p>
          <div className="sem-graphs">
            {draft.volumeCurve && <EnvelopeGraph points={envelopePoints(draft.volumeCurve)} xMax={127} label="Volume curve" color="hsl(38 90% 60%)" />}
            {draft.panCurve && <EnvelopeGraph points={envelopePoints(draft.panCurve)} xMax={127} label="Pan curve" color="hsl(190 80% 60%)" />}
          </div>
        </section>
      )}

      <section className="item-section">
        <h3>Zones</h3>
        <div className="sem-zone-grid">
          {draft.zones.map((zone, i) => {
            const hue = zoneHue(i)
            return (
              <div key={i} className="sem-zone-card" style={{ borderColor: `hsl(${hue} 50% 40% / 0.6)` }}>
                <div className="sem-zone-head">
                  <span className="sem-swatch" style={{ background: `hsl(${hue} 62% 55%)` }} />
                  <span className="sem-zone-title">Zone {i}</span>
                  <span className="item-stack-index">{zoneNoteCounts.get(i) ?? 0} notes</span>
                </div>
                <div className="sem-graphs">
                  <EnvelopeGraph points={envelopePoints(zone.sustainEnvelope)} label="Sustain envelope" color={`hsl(${hue} 70% 62%)`} />
                  <EnvelopeGraph points={envelopePoints(zone.releaseEnvelope)} label="Release envelope" color={`hsl(${(hue + 40) % 360} 70% 62%)`} />
                </div>
                {zone.vibratoRate > 0 && zone.vibratoDepth > 0 && (
                  <div className="sem-vibrato-row">
                    <VibratoWave rate={zone.vibratoRate} depth={zone.vibratoDepth} delay={zone.vibratoDelay} hue={hue} />
                  </div>
                )}
                {zone.vibratoRate > 0 && zone.vibratoDepth === 0 && (
                  <p className="tex-op-note">Vibrato rate is set but depth is 0 — this zone only vibrates under a live MIDI mod wheel.</p>
                )}
                <NumGrid fields={ZONE_FIELDS} values={zone as unknown as Record<string, unknown>} onChange={(k, v) => setZone(i, { [k]: v })} />
                <details className="sem-points-details">
                  <summary>Edit envelope points</summary>
                  <PairTable
                    title="Sustain Envelope"
                    srcLabel="Time"
                    dstLabel="Level"
                    src={envelopePoints(zone.sustainEnvelope).map((p) => p.x)}
                    dst={envelopePoints(zone.sustainEnvelope).map((p) => p.y)}
                    onSet={(idx, which, v) => setEnvelopePair(i, 'sustainEnvelope', idx, which, v)}
                    onAdd={() => addEnvelopePair(i, 'sustainEnvelope')}
                    onRemove={(idx) => removeEnvelopePair(i, 'sustainEnvelope', idx)}
                  />
                  <PairTable
                    title="Release Envelope"
                    srcLabel="Time"
                    dstLabel="Level"
                    src={envelopePoints(zone.releaseEnvelope).map((p) => p.x)}
                    dst={envelopePoints(zone.releaseEnvelope).map((p) => p.y)}
                    onSet={(idx, which, v) => setEnvelopePair(i, 'releaseEnvelope', idx, which, v)}
                    onAdd={() => addEnvelopePair(i, 'releaseEnvelope')}
                    onRemove={(idx) => removeEnvelopePair(i, 'releaseEnvelope', idx)}
                  />
                </details>
              </div>
            )
          })}
        </div>
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
