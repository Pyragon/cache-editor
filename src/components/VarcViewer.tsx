import { useEffect, useState } from 'react'
import type { VarcData, VarcDef } from '../loaders/config/varc'
import { TYPE_LABELS, typeLabel } from './typeChars'

type Props = {
  data: VarcData
  onSave: (data: VarcData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const NO_TYPE = '\u0000'

// Client variables (VARC): a type char plus a persistence flag. The client
// keeps varc values in memory; persistenceType 0 saves the value across
// sessions (client preferences file), 1 resets it on logout.
export default function VarcViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<VarcDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set<K extends keyof VarcDef>(key: K, value: VarcDef[K]) {
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
  const persists = draft.persistenceType === 0

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Varc {data.id}</span>
          <span className="enum-count">
            {draft.paramType === NO_TYPE ? 'no type' : typeLabel(draft.paramType)}
          </span>
          {persists && <span className="item-id-badge">persisted</span>}
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
          <label className="item-field def-toggle-field">
            <span className="item-field-label" title="persistenceType 0 saves the value across sessions; 1 resets it on logout">
              Persists Across Sessions
            </span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={persists}
                onChange={(e) => set('persistenceType', e.target.checked ? 0 : 1)}
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
