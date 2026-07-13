import { useEffect, useState } from 'react'
import type { StructData, StructDef } from '../loaders/config/structs'
import { ParamsTable } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'

type Props = {
  data: StructData
  onSave: (data: StructData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function StructViewer({ data, onSave, onDirtyChange }: Props) {
  const [rows, setRows] = useState<ParamRow[]>(() => toParamRows(data.def.values))
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setRows(toParamRows(data.def.values))
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  async function handleSave() {
    const def: StructDef = { ...data.def, values: paramRowsToRecord(rows) ?? {} }
    setIsSaving(true)
    await onSave({ ...data, def })
    setIsSaving(false)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Struct {data.id}</span>
          <span className="enum-count">{rows.length} values</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Values (param key → value)</h3>
        <ParamsTable
          rows={rows}
          onSet={(i, patch) => { setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); setIsDirty(true) }}
          onAdd={() => { setRows((prev) => [...prev, { key: '', isString: false, value: '' }]); setIsDirty(true) }}
          onRemove={(i) => { setRows((prev) => prev.filter((_, idx) => idx !== i)); setIsDirty(true) }}
        />
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setRows(toParamRows(data.def.values)); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
