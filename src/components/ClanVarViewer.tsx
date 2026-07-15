import { useEffect, useState } from 'react'
import { NumberInput } from './defFields'
import type { ClanVarDef } from '../loaders/config/clan_var'
import type { JsonDefData } from '../loaders/common'
import { TYPE_LABELS, typeLabel } from './typeChars'

type Props = {
  data: JsonDefData<ClanVarDef>
  /** "Clan Var" or "Clan Setting" — the two entries share this shape. */
  title: string
  onSave: (data: JsonDefData<ClanVarDef>) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const NO_TYPE = '\u0000'

// Clan variables / clan settings: a type char plus an optional varbit-style
// packing (baseVar + start/end bit) into a base clan var.
export default function ClanVarViewer({ data, title, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<ClanVarDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set<K extends keyof ClanVarDef>(key: K, value: ClanVarDef[K]) {
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
  const isPacked = draft.baseVar !== 0 || draft.startBit !== 0 || draft.endBit !== 0
  const bits = draft.endBit - draft.startBit + 1

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">{title} {data.id}</span>
          <span className="enum-count">
            {draft.paramType === NO_TYPE ? 'no type' : typeLabel(draft.paramType)}
          </span>
          {isPacked && (
            <span className="item-id-badge">
              {bits} bit{bits === 1 ? '' : 's'} of base var {draft.baseVar}
            </span>
          )}
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
        </div>
      </section>

      <section className="item-section">
        <h3>Bit Packing</h3>
        <p className="tex-op-note">
          Like a varbit into a varp: this value occupies bits {draft.startBit}–{draft.endBit} of
          base {title.toLowerCase()} {draft.baseVar}. All zeros means the var stands alone.
        </p>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Base Var</span>
            <NumberInput className="item-field-input" value={draft.baseVar} onChange={(v) => set('baseVar', v)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Start Bit</span>
            <NumberInput className="item-field-input" value={draft.startBit} onChange={(v) => set('startBit', v)} min={0} max={31} />
          </label>
          <label className="item-field">
            <span className="item-field-label">End Bit</span>
            <NumberInput className="item-field-input" value={draft.endBit} onChange={(v) => set('endBit', v)} min={0} max={31} />
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
