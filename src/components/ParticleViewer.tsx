import { useEffect, useState } from 'react'
import type { ParticleData, ParticleProducer } from '../loaders/particles'
import { NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import ParticlePreview from './ParticlePreview'
import './ParticleViewer.css'

type Props = {
  data: ParticleData
  onSave: (data: ParticleData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const EMISSION_FIELDS: NumFieldDef[] = [
  ['minimumParticleRate', 'Min Rate (1/64 per tick)'],
  ['maximumParticleRate', 'Max Rate (1/64 per tick)'],
  ['minimumLifetime', 'Min Lifetime (ticks)'],
  ['maximumLifetime', 'Max Lifetime (ticks)'],
]

// A full turn is 16384. The client centres the spread on the minimum rather than
// treating it as a floor, so a producer can legitimately have max below min.
const ANGLE_FIELDS: NumFieldDef[] = [
  ['minimumAngleH', 'Horizontal Angle'],
  ['maximumAngleH', 'Horizontal Spread'],
  ['minimumAngleV', 'Vertical Angle'],
  ['maximumAngleV', 'Vertical Spread'],
]

const SPEED_FIELDS: NumFieldDef[] = [
  ['minimumSpeed', 'Min Speed'],
  ['maximumSpeed', 'Max Speed'],
  ['endSpeed', 'End Speed (-1 = none)'],
  ['speedChange', 'Speed Ramp (% of life)'],
  ['speedFallOffStep', 'Falloff Step'],
]

const SIZE_FIELDS: NumFieldDef[] = [
  ['minimumSize', 'Min Size'],
  ['maximumSize', 'Max Size'],
  ['endSize', 'End Size (-1 = none)'],
  ['sizeChange', 'Size Ramp (% of life)'],
]

const FADE_FIELDS: NumFieldDef[] = [
  ['colorFading', 'Colour Fade (% of life)'],
  ['alphaFading', 'Alpha Fade (% of life)'],
]

const LIFECYCLE_FIELDS: NumFieldDef[] = [
  ['emissionEndTime', 'Emission End'],
  ['lifetime', 'Producer Lifetime'],
  ['minimumSetting', 'Min Detail Setting'],
  ['updatesPerCycle', 'Updates / Cycle'],
  ['lowestDisplayPlane', 'Lowest Plane'],
  ['highestDisplayPlane', 'Highest Plane'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['activeFirst', 'Active First'],
  ['periodic', 'Periodic'],
  ['uniformColorVariance', 'Uniform Colour Variance'],
  ['isTextured', 'Textured'],
  ['adjustsLightIntensity', 'Adjusts Light Intensity'],
  ['killOverlapping', 'Kill On Overlap'],
  ['killAboveSurface', 'Kill Above Surface'],
  ['aBool572', 'aBool572 (?)'],
]

const SPEED_MODES: Record<number, string> = {
  0: 'None',
  1: 'Linear with distance',
  2: 'Quadratic with distance',
}

// The packed colours are ARGB ints; the editor shows them as a swatch + picker plus
// the raw value, since alpha matters and a colour input can't express it.
function ArgbField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  const argb = value | 0
  const alpha = (argb >>> 24) & 0xff
  const rgb = argb & 0xffffff
  const hex = `#${rgb.toString(16).padStart(6, '0')}`

  return (
    <label className="item-field">
      <span className="item-field-label">
        {label} <span className="tex-op-hint">ARGB</span>
      </span>
      <div className="particle-color-row">
        <span
          className="tex-op-swatch"
          style={{ background: `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, ${alpha / 255})` }}
          title={`alpha ${alpha}`}
        />
        <input
          type="color"
          className="tex-op-color-input"
          value={hex}
          onChange={(e) => onChange(((alpha << 24) | parseInt(e.target.value.slice(1), 16)) | 0)}
        />
        <NumberInput className="item-field-input" value={argb} onChange={onChange} />
      </div>
    </label>
  )
}

export default function ParticleViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<ParticleProducer | null>(data.producer)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.producer)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
    setIsDirty(true)
  }

  async function handleSave() {
    if (!draft) return
    setIsSaving(true)
    await onSave({ ...data, producer: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  if (!draft) {
    return (
      <div className="item-viewer">
        <p className="map-sprite-none">No producer found for this id.</p>
      </div>
    )
  }

  const values = draft as unknown as Record<string, unknown>

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Particle {data.id}</span>
          {draft.materialId >= 0 && <span className="item-id-badge">material {draft.materialId}</span>}
        </div>
      </div>

      <section className="item-section">
        <h3>Preview</h3>
        <p className="tex-op-note tex-op-intro">
          The client's emitter, run live: particles are spawned, moved, faded and killed with the same
          maths the game uses, drawn with this producer's material. Edits below take effect immediately.
        </p>
        <ParticlePreview producer={draft} data={data} />
      </section>

      <section className="item-section">
        <h3>Emission</h3>
        <NumGrid fields={EMISSION_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>
          Direction <span className="tex-op-hint">a full turn is 16384; the spread is centred on the angle</span>
        </h3>
        <NumGrid fields={ANGLE_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Speed</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Falloff Mode</span>
            <select
              className="item-stackable-select"
              value={draft.speedUpdateType}
              onChange={(e) => set('speedUpdateType', parseInt(e.target.value, 10))}
            >
              {Object.entries(SPEED_MODES).map(([v, label]) => (
                <option key={v} value={v}>{v} — {label}</option>
              ))}
            </select>
          </label>
        </div>
        <NumGrid fields={SPEED_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Size</h3>
        <NumGrid fields={SIZE_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Colour</h3>
        <div className="item-grid">
          <ArgbField label="Start Colour (min)" value={draft.minimumStartColorRgb} onChange={(v) => set('minimumStartColorRgb', v)} />
          <ArgbField label="Start Colour (max)" value={draft.maximumStartColorRgb} onChange={(v) => set('maximumStartColorRgb', v)} />
          <ArgbField label="Fade Toward (0 = no fade)" value={draft.fadeColor} onChange={(v) => set('fadeColor', v)} />
        </div>
        <NumGrid fields={FADE_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Material</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">
              Material <span className="tex-op-hint">(textures id)</span>
            </span>
            <NumberInput className="item-field-input" value={draft.materialId} onChange={(v) => set('materialId', v)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">
              Untextured Fallback <span className="tex-op-hint">(producer id)</span>
            </span>
            <NumberInput className="item-field-input" value={draft.nonTexturedProducerId} onChange={(v) => set('nonTexturedProducerId', v)} />
          </label>
        </div>
        {draft.particleFileIds?.length ? (
          <p className="tex-op-note">
            Inherits motion from particle type{draft.particleFileIds.length > 1 ? 's' : ''}{' '}
            {draft.particleFileIds.map((id) => {
              const type = data.types.get(id)
              return type
                ? `${id} (offset ${type.offsetX}, ${type.offsetY}, ${type.offsetZ}${type.currentOffset === 0 ? ', accelerating' : ''})`
                : `${id}`
            }).join('; ')}
          </p>
        ) : null}
      </section>

      <section className="item-section">
        <h3>Lifecycle</h3>
        <NumGrid fields={LIFECYCLE_FIELDS} values={values} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid fields={FLAG_FIELDS} values={values} onChange={set} />
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes — saves to particles/{data.id}.json</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.producer); setIsDirty(false) }}>
            Discard
          </button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
