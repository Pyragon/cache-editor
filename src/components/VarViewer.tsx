import { useEffect, useState } from 'react'
import { NumberInput } from './defFields'
import type { VarData, VarDef } from '../loaders/config/vars'
import { TYPE_LABELS, typeLabel } from './typeChars'

type Props = {
  data: VarData
  onSave: (data: VarData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const NO_TYPE = '\u0000'

export default function VarViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<VarDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set<K extends keyof VarDef>(key: K, value: VarDef[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const isKnown = draft.paramType === NO_TYPE || Boolean(TYPE_LABELS[draft.paramType])

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Var {data.id}</span>
          <span className="enum-count">
            {draft.paramType === NO_TYPE ? 'no type' : typeLabel(draft.paramType)}
          </span>
        </div>
      </div>

      <section className="item-section">
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Param Type</span>
            <select
              className="item-stackable-select"
              value={isKnown ? draft.paramType : '__other'}
              onChange={(e) => { if (e.target.value !== '__other') set('paramType', e.target.value) }}
            >
              <option value={NO_TYPE}>none</option>
              {Object.entries(TYPE_LABELS).map(([char, label]) => (
                <option key={char} value={char}>{char} — {label}</option>
              ))}
              {!isKnown && <option value="__other">{draft.paramType} — unknown</option>}
            </select>
          </label>
          <label className="item-field">
            <span className="item-field-label">Client Code</span>
            <NumberInput className="item-field-input" value={Number(draft.clientCode ?? 0)} onChange={(v) => set('clientCode',v)} />
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
