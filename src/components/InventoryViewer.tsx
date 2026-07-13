import { useEffect, useState } from 'react'
import type { InventoryData, InventoryDef } from '../loaders/config/inventories'
import { ItemIcon, PairTable } from './defFields'

type Props = {
  data: InventoryData
  onSave: (data: InventoryData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function InventoryViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<InventoryDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const ids = draft.ids ?? []
  const amounts = draft.amounts ?? []

  function setPair(index: number, which: 0 | 1, value: number) {
    const nextIds = [...ids]
    const nextAmounts = [...amounts]
    if (which === 0) nextIds[index] = value
    else nextAmounts[index] = value
    setDraft((prev) => ({ ...prev, ids: nextIds, amounts: nextAmounts }))
    setIsDirty(true)
  }

  function addPair() {
    setDraft((prev) => ({ ...prev, ids: [...ids, 0], amounts: [...amounts, 0] }))
    setIsDirty(true)
  }

  function removePair(index: number) {
    const nextIds = ids.filter((_, i) => i !== index)
    const nextAmounts = amounts.filter((_, i) => i !== index)
    setDraft((prev) => {
      const next = { ...prev }
      if (nextIds.length === 0) {
        delete next.ids
        delete next.amounts
      } else {
        next.ids = nextIds
        next.amounts = nextAmounts
      }
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
          <span className="enum-title">Inventory {data.id}</span>
          <span className="enum-count">{draft.length} slots</span>
        </div>
      </div>

      <section className="item-section">
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Length (slots)</span>
            <input
              className="item-field-input"
              type="number"
              value={Number(draft.length ?? 0)}
              onChange={(e) => { setDraft((prev) => ({ ...prev, length: parseInt(e.target.value, 10) || 0 })); setIsDirty(true) }}
            />
          </label>
        </div>
      </section>

      <PairTable
        title="Default Stock" srcLabel="Item ID" dstLabel="Amount"
        src={ids} dst={amounts}
        onSet={setPair} onAdd={addPair} onRemove={removePair}
        srcIcon={(id) => <ItemIcon id={id} />}
      />

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
