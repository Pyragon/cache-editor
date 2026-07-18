import { useEffect, useState } from 'react'
import type { AnimationFrameBaseData, AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import { NumberInput, IntListInput } from './defFields'

const TRANSFORM_TYPE_NAMES: Record<number, string> = {
  0: 'origin marker',
  1: 'translate',
  2: 'rotate',
  3: 'scale',
  5: 'alpha',
  7: 'colour',
  8: 'billboard',
  9: 'rotate (2D)',
  10: 'scale (2D)',
}

type Props = {
  data: AnimationFrameBaseData
  onSave: (data: AnimationFrameBaseData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

// A "skeleton": the bone-group structure animation frames transform
// against. Each row is one transform slot — its type, whether it casts a
// shadow, the equipment-submesh bitmask it's gated by, and which vertex
// group label ids it moves. Individual animation frames (animation_frame_sets)
// reference these slots by index.
export default function AnimationFrameBaseViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<AnimationFrameBaseDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function setSlot(i: number, patch: Partial<{ transformationTypes: number; shadowed: boolean; submeshes: number }>) {
    setDraft((prev) => {
      const next = { ...prev }
      if (patch.transformationTypes !== undefined) {
        next.transformationTypes = prev.transformationTypes.slice()
        next.transformationTypes[i] = patch.transformationTypes
      }
      if (patch.shadowed !== undefined) {
        next.shadowed = prev.shadowed.slice()
        next.shadowed[i] = patch.shadowed
      }
      if (patch.submeshes !== undefined) {
        next.submeshes = prev.submeshes.slice()
        next.submeshes[i] = patch.submeshes
      }
      return next
    })
    setIsDirty(true)
  }

  function setLabels(i: number, labels: number[] | undefined) {
    setDraft((prev) => {
      const next = prev.labels.slice()
      next[i] = labels ?? []
      return { ...prev, labels: next }
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
          <span className="enum-title">Frame Base {data.id}</span>
          <span className="item-stack-index">{draft.count} transform slots</span>
        </div>
      </div>

      {draft.trailingUnreadBytes && (
        <p className="tex-op-note">
          This archive has {draft.trailingUnreadBytes.length} bytes past what its transform count implies — likely
          orphaned data from a previous version. Preserved as-is on save, not editable here.
        </p>
      )}

      <section className="item-section">
        <h3>Transform Slots</h3>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>#</th><th>Type</th><th>Shadowed</th><th>Submeshes</th><th>Labels (vertex groups)</th></tr>
            </thead>
            <tbody>
              {draft.transformationTypes.map((type, i) => (
                <tr key={i}>
                  <td className="item-stack-index">{i}</td>
                  <td>
                    <NumberInput className="cell-input" value={type} onChange={(v) => setSlot(i, { transformationTypes: v })} />
                    <span className="item-stack-index">{TRANSFORM_TYPE_NAMES[type] ?? ''}</span>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={draft.shadowed[i] ?? false}
                      onChange={(e) => setSlot(i, { shadowed: e.target.checked })}
                    />
                  </td>
                  <td><NumberInput className="cell-input" value={draft.submeshes[i] ?? 0} onChange={(v) => setSlot(i, { submeshes: v })} /></td>
                  <td>
                    <IntListInput
                      value={draft.labels[i]}
                      onChange={(v) => setLabels(i, v)}
                      placeholder="vertex group ids"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
