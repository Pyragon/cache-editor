import { useEffect, useState } from 'react'
import type { OverlayData, OverlayDef } from '../loaders/config/overlays'
import { NO_COLOR } from '../loaders/config/overlays'
import { NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { rgbToRenderedHex } from '../loaders/models'
import './UnderlayViewer.css'

const NUM_FIELDS: NumFieldDef[] = [
  ['texture', 'Texture ID'],
  ['textureScale', 'Texture Scale'],
  ['slot', 'Slot'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['occlude', 'Occlude'],
  ['shadowed', 'Shadowed'],
  ['blendsWithUnderlay', 'Blends With Underlay'],
]

const WATER_FIELDS: NumFieldDef[] = [
  ['waterFogDepth', 'Fog Depth'],
  ['waterIntensity', 'Intensity'],
  ['opcode20', 'Water Scale (?)'],
]

const UNKNOWN_FIELDS: NumFieldDef[] = [
  ['unusedOpcode21', 'unusedOpcode21'],
  ['unusedOpcode22', 'unusedOpcode22'],
]

// One colour field with an editable swatch, the client-rendered result, and
// a "no colour" toggle (the cache's 0xff00ff sentinel).
function ColorField({ label, value, onChange }: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  const isNone = value === NO_COLOR
  const rawHex = `#${(isNone ? 0 : value & 0xffffff).toString(16).padStart(6, '0')}`
  const renderedHex = isNone ? null : rgbToRenderedHex(value)

  return (
    <div className="item-field">
      <span className="item-field-label">{label}</span>
      <div className="underlay-color-row">
        <label className="underlay-swatch-label">
          <input
            type="color"
            className="underlay-color-input"
            value={rawHex}
            disabled={isNone}
            onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
          />
          <span className="underlay-swatch-caption">uploaded</span>
        </label>
        {renderedHex && (
          <div className="underlay-swatch-static" style={{ background: renderedHex }} title={renderedHex}>
            <span className="underlay-swatch-caption">in-game</span>
          </div>
        )}
        <label className="badge-toggle">
          <input type="checkbox" checked={isNone} onChange={(e) => onChange(e.target.checked ? NO_COLOR : 0x7f7f7f)} />
          <span className={isNone ? 'badge item-badge-off' : 'badge badge-members'}>
            {isNone ? 'No colour' : 'Coloured'}
          </span>
        </label>
      </div>
    </div>
  )
}

type Props = {
  data: OverlayData
  onSave: (data: OverlayData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function OverlayViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<OverlayDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Overlay {data.id}</span>
          {draft.blendsWithUnderlay && <span className="item-id-badge">blends with underlay</span>}
        </div>
      </div>

      <section className="item-section">
        <h3>Colour</h3>
        <div className="item-grid">
          <ColorField label="Tile Colour" value={draft.colorRgb} onChange={(v) => set('colorRgb', v)} />
          <ColorField label="Minimap Colour" value={draft.minimapColorRgb} onChange={(v) => set('minimapColorRgb', v)} />
        </div>
        <p className="tex-op-note">
          The client quantises tile colour through the same 65,536-entry HSL palette used for model
          faces — the "in-game" swatch shows the result. Minimap colour, when set, is what the
          minimap uses instead of the tile colour (and overrides a texture's own average colour).
        </p>
      </section>

      <section className="item-section">
        <h3>Texture</h3>
        <NumGrid fields={NUM_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid fields={FLAG_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Water</h3>
        <p className="tex-op-note">
          Only used for plane-0 overlays that the client treats as water (drawn as an animated,
          fogged surface rather than a flat tile).
        </p>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Water Colour</span>
            <input
              type="color"
              className="underlay-color-input"
              value={`#${(draft.waterColor & 0xffffff).toString(16).padStart(6, '0')}`}
              onChange={(e) => set('waterColor', parseInt(e.target.value.slice(1), 16))}
            />
          </label>
        </div>
        <NumGrid fields={WATER_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <details className="item-unknown">
        <summary>Unknown fields</summary>
        <NumGrid fields={UNKNOWN_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </details>

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
