import { useEffect, useState } from 'react'
import type { VarbitData, VarbitDef } from '../loaders/varbits'
import { NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'

type Props = {
  data: VarbitData
  onSave: (data: VarbitData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const FIELDS: NumFieldDef[] = [
  ['baseVar', 'Base Var'],
  ['startBit', 'Start Bit'],
  ['endBit', 'End Bit'],
]

export default function VarbitViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<VarbitDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

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
          <span className="enum-title">Varbit {data.id}</span>
          <span className="enum-count">
            bits {draft.startBit}–{draft.endBit} of var {draft.baseVar}
          </span>
        </div>
      </div>

      <section className="item-section">
        <NumGrid
          fields={FIELDS}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => { setDraft((prev) => ({ ...prev, [k]: v })); setIsDirty(true) }}
        />
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
