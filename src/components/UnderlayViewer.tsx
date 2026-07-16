import { useEffect, useState } from 'react'
import type { UnderlayData, UnderlayDef } from '../loaders/config/underlays'
import { NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { rgbToRenderedHex } from '../loaders/models'
import './UnderlayViewer.css'

const NUM_FIELDS: NumFieldDef[] = [
  ['texture', 'Texture ID'],
  ['scale', 'Texture Scale'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['shadowed', 'Shadowed'],
  ['occlude', 'Occlude'],
]

type Props = {
  data: UnderlayData
  onSave: (data: UnderlayData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

// Ground tile base colour. The swatch shows the colour as the client
// actually renders it — quantised through the same HSL16 palette as model
// faces — not the raw uploaded RGB, which can look a little different.
export default function UnderlayViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<UnderlayDef>(data.def)
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

  const rawHex = `#${(draft.rgb & 0xffffff).toString(16).padStart(6, '0')}`
  const renderedHex = rgbToRenderedHex(draft.rgb)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Underlay {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Colour</h3>
        <div className="underlay-color-row">
          <label className="underlay-swatch-label">
            <input
              type="color"
              className="underlay-color-input"
              value={rawHex}
              onChange={(e) => set('rgb', parseInt(e.target.value.slice(1), 16))}
            />
            <span className="underlay-swatch-caption">uploaded</span>
          </label>
          <div className="underlay-swatch-static" style={{ background: renderedHex }} title={renderedHex}>
            <span className="underlay-swatch-caption">in-game</span>
          </div>
          <NumberInput className="item-field-input" value={draft.rgb} onChange={(v) => set('rgb', v)} />
        </div>
        <p className="tex-op-note">
          The client quantises this colour through the same 65,536-entry HSL palette used for model
          faces — the "in-game" swatch shows the result, which can differ slightly from the raw value.
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
