import { useEffect, useRef, useState } from 'react'
import type { VarKind, VarOverride } from '../loaders/varOverrides'
import { loadVarOverrides, saveVarOverrides } from '../loaders/varOverrides'
import { NumberInput } from './defFields'
import './VarOverridesModal.css'

// Stand-in world state. A morph loc picks its appearance from a varbit or varp
// (ObjectType.getMultiLoc), and with nothing set every one of them renders the
// default at the end of its `transformTo` list. Setting a value here is how you
// see the other states — a door open, a quest area part-way through, the
// smashed roof at 2938,3540 that only appears when varbit 10685 is 2.
//
// Save is separate from Close on purpose: editing a value re-resolves locs in
// the open scene, so it shouldn't happen on every keystroke.

type Props = { onClose: () => void }

type Row = VarOverride & { key: number }

let nextKey = 1

export default function VarOverridesModal({ onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])
  const [rows, setRows] = useState<Row[]>(() => loadVarOverrides().map((o) => ({ ...o, key: nextKey++ })))
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  const edit = (key: number, patch: Partial<VarOverride>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setDirty(true)
    setSaved(false)
  }

  const addRow = () => {
    setRows((prev) => [...prev, { key: nextKey++, kind: 'varbit', id: 0, value: 0 }])
    setDirty(true)
    setSaved(false)
  }

  const removeRow = (key: number) => {
    setRows((prev) => prev.filter((r) => r.key !== key))
    setDirty(true)
    setSaved(false)
  }

  const save = () => {
    saveVarOverrides(rows.map(({ kind, id, value }) => ({ kind, id, value })))
    setDirty(false)
    setSaved(true)
  }

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body var-overrides">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Variables</h3>
          <span className="anim-fit-actions">
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>

        <p className="cutscene-note var-overrides-note">
          Some objects have more than one version — a door open or shut, a roof before and after a quest
          smashes it — and the game picks between them using a varbit or varp. With nothing set here you
          always get the version a brand-new account would see. Set a value to see one of the others.
          Applies to the map scene and to cutscene previews.
        </p>

        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>Type</th><th>Id</th><th>Value</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <select
                      className="cell-select"
                      value={row.kind}
                      onChange={(e) => edit(row.key, { kind: e.target.value as VarKind })}
                    >
                      <option value="varbit">Varbit</option>
                      <option value="varp">Varp</option>
                    </select>
                  </td>
                  <td><NumberInput className="cell-input" value={row.id} min={0} onChange={(v) => edit(row.key, { id: v })} /></td>
                  <td><NumberInput className="cell-input" value={row.value} onChange={(v) => edit(row.key, { value: v })} /></td>
                  <td>
                    <button type="button" className="row-remove-btn" title="Remove" onClick={() => removeRow(row.key)}>×</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={4} className="var-overrides-empty">Nothing set — every morph shows its default.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <button type="button" className="add-row-btn" onClick={addRow}>+ Add variable</button>

        <div className="save-bar var-overrides-save">
          <span className="save-bar-label">
            {dirty ? 'Unsaved changes' : saved ? 'Saved — open scenes updated.' : 'No changes'}
          </span>
          <button type="button" className="save-bar-save" disabled={!dirty} onClick={save}>Save</button>
        </div>
      </div>
    </dialog>
  )
}
