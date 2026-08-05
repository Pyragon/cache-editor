import { useEffect, useMemo, useRef, useState } from 'react'
import { ACTION_FIELDS, ADDABLE_ACTIONS, SIMULATED_ACTIONS, defaultFields } from './cutsceneActionFields'
import type { ActionField } from './cutsceneActionFields'
import { actionLane } from './cutsceneLanes'
import { clockShort } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import { NumberInput } from './defFields'
import './CutscenePianoRoll.css'

// "A" on the piano roll: pick a type, fill it in, and it lands at the cycle the
// ghost playhead was over. Everything the type carries is on screen — the point
// of the modal over the old dropdown is that you author the whole action in one
// step instead of adding a zeroed one and hunting for it in the table.

type Props = {
  cycle: number
  unit: CutsceneClockUnit
  /** Pickers for fields that name a cast/object/route/path entry. */
  refOptions: (field: ActionField) => { value: number; label: string }[] | null
  onAdd: (type: string, fields: Record<string, number | string>) => void
  onClose: () => void
}

export default function CutsceneAddActionModal({ cycle, unit, refOptions, onAdd, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [filter, setFilter] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, number | string>>({})

  useEffect(() => { dialogRef.current?.showModal() }, [])

  const matches = useMemo(() => {
    const f = filter.trim().toLowerCase().replace(/ /g, '_')
    return ADDABLE_ACTIONS.filter((t) => f === '' || t.toLowerCase().includes(f))
  }, [filter])

  function choose(next: string) {
    setType(next)
    setFields(defaultFields(next))
  }

  const spec = type ? ACTION_FIELDS[type] ?? [] : []

  return (
    <dialog
      ref={dialogRef}
      className="varbit-planner-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="cutscene-modal-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Add action at {clockShort(cycle, unit)}</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        {type == null ? (
          <>
            <input
              type="text"
              className="map-sprite-uses-filter"
              placeholder="Filter actions…"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches.length > 0) choose(matches[0]) }}
            />
            <div className="cutscene-modal-types">
              {matches.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`piano-roll-cell piano-roll-${actionLane(t)} cutscene-modal-type`}
                  onClick={() => choose(t)}
                >
                  {t.toLowerCase().replace(/_/g, ' ')}
                  {!SIMULATED_ACTIONS.has(t) && <em> · not previewed</em>}
                </button>
              ))}
              {matches.length === 0 && <span className="cutscene-editor-empty">No action matches that.</span>}
            </div>
          </>
        ) : (
          <>
            <div className="cutscene-modal-chosen">
              <span className={`cutscene-action-badge cutscene-action-${actionLane(type)}`}>
                {type.toLowerCase().replace(/_/g, ' ')}
              </span>
              <button type="button" className="field-link-btn" onClick={() => setType(null)}>Pick a different one</button>
            </div>

            <div className="cutscene-editor-fields">
              {spec.map((field) => {
                const options = refOptions(field)
                const value = fields[field.name]
                return (
                  <label key={field.name} className="cutscene-editor-field">
                    <span>{field.label}</span>
                    {options ? (
                      <select
                        className="cell-select"
                        value={String(value ?? 0)}
                        onChange={(e) => setFields((p) => ({ ...p, [field.name]: Number(e.target.value) }))}
                      >
                        {options.length === 0 && <option value="0">none defined</option>}
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : field.kind === 'string' ? (
                      <input
                        className="cell-input"
                        value={String(value ?? '')}
                        onChange={(e) => setFields((p) => ({ ...p, [field.name]: e.target.value }))}
                      />
                    ) : (
                      <NumberInput
                        className="cell-input"
                        value={Number(value ?? 0)}
                        onChange={(v) => setFields((p) => ({ ...p, [field.name]: v }))}
                      />
                    )}
                    {field.hint && <em>{field.hint}</em>}
                  </label>
                )
              })}
              {spec.length === 0 && <span className="cutscene-editor-empty">This action carries no fields.</span>}
            </div>

            {!SIMULATED_ACTIONS.has(type) && (
              <p className="cutscene-note">
                Saves correctly, but the preview doesn’t simulate this one — you won’t see it happen.
              </p>
            )}

            <div className="varbit-planner-row">
              <button
                type="button"
                className="save-bar-save"
                onClick={() => { onAdd(type, fields); onClose() }}
              >
                Add at {clockShort(cycle, unit)}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
