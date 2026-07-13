import { useEffect, useState } from 'react'
import type { ParamData, ParamDef } from '../loaders/config/params'
import { TYPE_LABELS, typeLabel } from './typeChars'

type Props = {
  data: ParamData
  onSave: (data: ParamData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function ParamViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<ParamDef>(data.def)
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
    setDraft((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
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
          <span className="enum-title">Param {data.id}</span>
          <span className="enum-count">{typeLabel(draft.type)}</span>
        </div>
      </div>

      <section className="item-section">
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Type</span>
            <select
              className="item-stackable-select"
              value={TYPE_LABELS[draft.type] ? draft.type : '__other'}
              onChange={(e) => { if (e.target.value !== '__other') set('type', e.target.value) }}
            >
              {Object.entries(TYPE_LABELS).map(([char, label]) => (
                <option key={char} value={char}>{char} — {label}</option>
              ))}
              {!TYPE_LABELS[draft.type] && <option value="__other">{draft.type} — unknown</option>}
            </select>
          </label>
          <label className="item-field">
            <span className="item-field-label">Default Int</span>
            <input
              className="item-field-input"
              type="number"
              value={Number(draft.defaultInt ?? 0)}
              onChange={(e) => set('defaultInt', parseInt(e.target.value, 10) || 0)}
            />
          </label>
          <label className="item-field">
            <span className="item-field-label">Type Name (optional)</span>
            <input
              className="item-field-input"
              type="text"
              value={String(draft.typeName ?? '')}
              onChange={(e) => set('typeName', e.target.value === '' ? undefined : e.target.value)}
            />
          </label>
          <label className="item-field def-toggle-field">
            <span className="item-field-label">Auto Disable</span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.autoDisable)}
                onChange={(e) => set('autoDisable', e.target.checked)}
              />
              <span className="sprite-toggle-track" />
            </span>
          </label>
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
