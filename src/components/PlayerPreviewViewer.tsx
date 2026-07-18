import { useEffect, useState } from 'react'
import type { AppearanceSlot } from '../loaders/playerAppearance'
import { APPEARANCE_SLOT_COUNT, defaultAppearanceSlots, slotLabel, buildPlayerModel } from '../loaders/playerAppearance'
import type { ModelData } from '../loaders/models'
import { NumberInput } from './defFields'
import ModelViewer from './ModelViewer'

type Props = {
  rootHandle?: FileSystemDirectoryHandle
  onClose: () => void
}

// Assembles a full player avatar from user-picked identikit/item ids per
// appearance slot — the composite-mesh building block (mergeModels +
// per-part recolor) is shared with IdentikitViewer's own body/head preview;
// this just stacks all 15 slots into one avatar, mirroring darkan
// PlayerAppearance.kt's getBodyModel().
export default function PlayerPreviewViewer({ rootHandle, onClose }: Props) {
  const [female, setFemale] = useState(false)
  const [slots, setSlots] = useState<AppearanceSlot[]>(defaultAppearanceSlots)
  const [preview, setPreview] = useState<{ loading: boolean; data: ModelData | null; error: boolean }>({ loading: false, data: null, error: false })

  function setSlotKind(position: number, kind: AppearanceSlot['kind']) {
    setSlots((prev) => {
      const next = prev.slice()
      next[position] = kind === 'empty' ? { kind: 'empty' } : { kind, id: 0 }
      return next
    })
  }

  function setSlotId(position: number, id: number) {
    setSlots((prev) => {
      const next = prev.slice()
      const slot = next[position]
      if (slot.kind !== 'empty') next[position] = { ...slot, id }
      return next
    })
  }

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    setPreview((p) => ({ ...p, loading: true, error: false }))
    buildPlayerModel(slots, female, rootHandle).then((data) => {
      if (cancelled) return
      setPreview({ loading: false, data, error: data == null })
    }).catch(() => {
      if (!cancelled) setPreview({ loading: false, data: null, error: true })
    })
    return () => { cancelled = true }
  }, [slots, female, rootHandle])

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Player Preview</span>
        </div>
        <button type="button" className="model-toolbar-btn" onClick={onClose}>Close</button>
      </div>

      <section className="item-section">
        <h3>Gender</h3>
        <div className="item-grid">
          <label className="item-field def-toggle-field">
            <span className="item-field-label">Female</span>
            <span className="sprite-toggle">
              <input type="checkbox" checked={female} onChange={(e) => setFemale(e.target.checked)} />
              <span className="sprite-toggle-track" />
            </span>
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>Appearance Slots</h3>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>Slot</th><th>Kind</th><th>ID</th></tr></thead>
            <tbody>
              {Array.from({ length: APPEARANCE_SLOT_COUNT }, (_, position) => {
                const slot = slots[position]
                return (
                  <tr key={position}>
                    <td className="item-stack-index">{slotLabel(position)}</td>
                    <td>
                      <select
                        className="cell-input"
                        value={slot.kind}
                        onChange={(e) => setSlotKind(position, e.target.value as AppearanceSlot['kind'])}
                      >
                        <option value="empty">Empty</option>
                        <option value="identikit">Identikit</option>
                        <option value="item">Item</option>
                      </select>
                    </td>
                    <td>
                      {slot.kind !== 'empty' && (
                        <NumberInput className="cell-input" value={slot.id} onChange={(v) => setSlotId(position, v)} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="item-section">
        <h3>Preview</h3>
        {preview.loading && <p className="tex-op-note">Loading…</p>}
        {preview.error && !preview.loading && <p className="tex-op-note">No renderable parts — check the slot ids above.</p>}
        {preview.data && <ModelViewer data={preview.data} />}
      </section>
    </div>
  )
}
