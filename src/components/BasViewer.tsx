import { useEffect, useState } from 'react'
import type { BasData, BasDef } from '../loaders/config/bas'
import { OBJ_SLOT_COUNT } from '../loaders/config/bas'
import { IntListInput, NumberInput, NumGrid, PairTable, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import './BasViewer.css'

type Props = {
  data: BasData
  onSave: (data: BasData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onOpenAnimation: (id: number) => void
}

// Movement matrix rows. The dirN columns replace the main sequence when the
// entity moves at an angle to its facing (PathingEntity.kt: dir1 for
// walkDirection 2048–6144 ≈ 90°, dir2 for 10240–14336 ≈ 270°, dir3 for the
// backwards band in between). Stand has no directional variants.
const MOVE_ROWS: { label: string; main: keyof BasDef; dir1?: keyof BasDef; dir2?: keyof BasDef; dir3?: keyof BasDef; ccw: keyof BasDef; cw: keyof BasDef }[] = [
  { label: 'Stand', main: 'standAnimation', ccw: 'standTurnCcwSequence', cw: 'standTurnCwSequence' },
  { label: 'Walk', main: 'walkAnimation', dir1: 'walkDir1', dir2: 'walkDir2', dir3: 'walkDir3', ccw: 'walkTurnCcwSequence', cw: 'walkTurnCwSequence' },
  { label: 'Run', main: 'runningAnimation', dir1: 'runDir1', dir2: 'runDir2', dir3: 'runDir3', ccw: 'runTurnCcwSequence', cw: 'runTurnCwSequence' },
  { label: 'Teleport', main: 'teleportingAnimation', dir1: 'teleDir1', dir2: 'teleDir2', dir3: 'teleDir3', ccw: 'teleTurnCcwSequence', cw: 'teleTurnCwSequence' },
]

const ROTATION_FIELDS: NumFieldDef[] = [
  ['yawAcceleration', 'Yaw Acceleration'],
  ['yawMaxVelocity', 'Yaw Max Velocity'],
  ['rollAcceleration', 'Roll Acceleration'],
  ['rollMaxVelocity', 'Roll Max Velocity'],
  ['rollTargetAngle', 'Roll Target Angle'],
  ['pitchAcceleration', 'Pitch Acceleration'],
  ['pitchMaxVelocity', 'Pitch Max Velocity'],
  ['pitchTargetAngle', 'Pitch Target Angle'],
]

// [key, label, step] — step matches the cache storage granularity (opcode 26
// stores /4, opcode 54 stores >>6), so stepping never produces a value that
// changes when round-tripped through the cache.
const MODEL_FIELDS: [keyof BasDef, string, number][] = [
  ['modelWidth', 'Model Width', 4],
  ['modelLength', 'Model Length', 4],
  ['iconHeightOverride', 'Icon Height Override', 1],
  ['hillRotateX', 'Hill Rotate X', 64],
  ['hillRotateZ', 'Hill Rotate Z', 64],
]

// A sequence-id cell: number input plus an "anim" jump link when set.
function SeqCell({ value, onChange, onOpen }: {
  value: number
  onChange: (value: number) => void
  onOpen: (id: number) => void
}) {
  return (
    <span className="bas-seq-cell">
      <NumberInput className="cell-input" value={value} min={-1} onChange={onChange} />
      {value >= 0 && (
        <button
          type="button"
          className="field-link-btn"
          title={`Open animation ${value}`}
          onClick={() => onOpen(value)}
        >
          View Anim
        </button>
      )}
    </span>
  )
}

// Editor for the per-obj-slot override opcodes (27/55/56). No rev-727 BAS
// uses them, but the format supports them so the editor does too.
function SlotTable({ title, hint, cols, slots, onSet, onAdd, onRemove }: {
  title: string
  hint?: string
  cols: string[]
  slots: (number[] | null)[] | undefined
  onSet: (slot: number, col: number, value: number) => void
  onAdd: () => void
  onRemove: (slot: number) => void
}) {
  const rows = (slots ?? [])
    .map((values, slot) => (values ? { slot, values } : null))
    .filter((row): row is { slot: number; values: number[] } => row != null)
  const full = rows.length >= OBJ_SLOT_COUNT
  return (
    <section className="item-section">
      <h3>{title}</h3>
      {hint && <p className="bas-slot-hint">{hint}</p>}
      {rows.length > 0 && (
        <div className="quest-table-wrap bas-matrix-wrap">
          <table className="quest-table bas-matrix">
            <thead>
              <tr><th>Slot</th>{cols.map((c) => <th key={c}>{c}</th>)}<th>Remove</th></tr>
            </thead>
            <tbody>
              {rows.map(({ slot, values }) => (
                <tr key={slot}>
                  <td className="bas-slot-label">{slot}</td>
                  {cols.map((_, col) => (
                    <td key={col}>
                      <NumberInput className="cell-input" value={values[col] ?? 0} onChange={(v) => onSet(slot, col, v)} />
                    </td>
                  ))}
                  <td><button type="button" className="row-remove-btn" onClick={() => onRemove(slot)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="add-row-btn" disabled={full} onClick={onAdd}>+ Add slot</button>
    </section>
  )
}

export default function BasViewer({ data, onSave, onDirtyChange, onOpenAnimation }: Props) {
  const [draft, setDraft] = useState<BasDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  const randomSeqs = draft.randomStandSequences ?? []
  const randomChances = draft.randomStandSequenceChances ?? []

  function setRandomPair(index: number, which: 0 | 1, value: number) {
    const key = which === 0 ? 'randomStandSequences' : 'randomStandSequenceChances'
    const arr = [...(which === 0 ? randomSeqs : randomChances)]
    arr[index] = value
    set(key, arr)
  }

  function addRandomPair() {
    setDraft((prev) => ({
      ...prev,
      randomStandSequences: [...(prev.randomStandSequences ?? []), -1],
      randomStandSequenceChances: [...(prev.randomStandSequenceChances ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRandomPair(index: number) {
    setDraft((prev) => ({
      ...prev,
      randomStandSequences: (prev.randomStandSequences ?? []).filter((_, i) => i !== index),
      randomStandSequenceChances: (prev.randomStandSequenceChances ?? []).filter((_, i) => i !== index),
    }))
    setIsDirty(true)
  }

  type SlotArrayKey = 'objVerticeTransformations' | 'projectionOffset'

  function setSlotValue(key: SlotArrayKey, slot: number, col: number, value: number) {
    setDraft((prev) => {
      const arr = padSlots(prev[key])
      const row = [...(arr[slot] ?? [])]
      row[col] = value
      arr[slot] = row
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  function addSlot(key: SlotArrayKey, width: number) {
    setDraft((prev) => {
      const arr = padSlots(prev[key])
      const free = arr.findIndex((v) => v == null)
      if (free === -1) return prev
      arr[free] = Array(width).fill(0)
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  function removeSlot(key: SlotArrayKey, slot: number) {
    setDraft((prev) => {
      const arr = padSlots(prev[key])
      arr[slot] = null
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  // turnAngleAdjustment holds one number per slot rather than an array, so it
  // rides through SlotTable as single-element rows.
  const turnAngleAsRows = draft.turnAngleAdjustment?.map((v) => (v == null ? null : [v]))

  function setTurnAngle(slot: number, value: number | null) {
    setDraft((prev) => {
      const arr: (number | null)[] = [...(prev.turnAngleAdjustment ?? Array(OBJ_SLOT_COUNT).fill(null))]
      while (arr.length < OBJ_SLOT_COUNT) arr.push(null)
      arr[slot] = value
      return { ...prev, turnAngleAdjustment: arr }
    })
    setIsDirty(true)
  }

  function addTurnAngle() {
    const arr = draft.turnAngleAdjustment ?? []
    let free = arr.findIndex((v) => v == null)
    if (free === -1) free = arr.length
    if (free >= OBJ_SLOT_COUNT) return
    setTurnAngle(free, 0)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: pruneDef(draft) })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.def)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">BAS {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Movement Sequences</h3>
        <div className="quest-table-wrap bas-matrix-wrap">
          <table className="quest-table bas-matrix">
            <thead>
              <tr>
                <th />
                <th>Main</th>
                <th title="Plays instead of Main when moving ~90° off facing (walkDirection 2048–6144)">Side 90°</th>
                <th title="Plays instead of Main when moving backwards (walkDirection 6144–10240)">Backwards</th>
                <th title="Plays instead of Main when moving ~270° off facing (walkDirection 10240–14336)">Side 270°</th>
                <th title="Plays while turning counter-clockwise on the spot">Turn CCW</th>
                <th title="Plays while turning clockwise on the spot">Turn CW</th>
              </tr>
            </thead>
            <tbody>
              {MOVE_ROWS.map((row) => (
                <tr key={row.label}>
                  <td className="bas-slot-label">{row.label}</td>
                  {(['main', 'dir1', 'dir3', 'dir2', 'ccw', 'cw'] as const).map((col) => {
                    const key = row[col]
                    return (
                      <td key={col}>
                        {key ? (
                          <SeqCell
                            value={Number(draft[key] ?? -1)}
                            onChange={(v) => set(key, v)}
                            onOpen={onOpenAnimation}
                          />
                        ) : (
                          <span className="bas-cell-na">—</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="bas-pair">
        <PairTable
          title="Random Stand Sequences"
          srcLabel="Sequence"
          dstLabel="Chance"
          src={randomSeqs}
          dst={randomChances}
          onSet={setRandomPair}
          onAdd={addRandomPair}
          onRemove={removeRandomPair}
        />
      </div>

      <section className="item-section">
        <h3>Model</h3>
        <div className="item-grid">
          {MODEL_FIELDS.map(([key, label, step]) => (
            <label key={key} className="item-field">
              <span className="item-field-label" title={label}>{label}</span>
              <NumberInput value={Number(draft[key] ?? 0)} step={step} onChange={(v) => set(key, v)} />
            </label>
          ))}
        </div>
        <ToggleGrid
          fields={[['rendersShadow', 'Renders Shadow']]}
          values={draft as unknown as Record<string, unknown>}
          onChange={set}
        />
      </section>

      <section className="item-section">
        <h3>Rotation Physics</h3>
        <NumGrid
          fields={ROTATION_FIELDS}
          values={draft as unknown as Record<string, unknown>}
          onChange={set}
        />
      </section>

      <details className="item-unknown bas-slots">
        <summary>Per-slot overrides & unused fields</summary>
        <p className="bas-slot-hint">
          Per-equipment-slot overrides (opcodes 27/55/56) and opcode 28 are decoded and
          re-encoded faithfully but no rev-727 BAS uses them; opcodes 37/43/44 are read
          and discarded by the client.
        </p>

        <SlotTable
          title="Obj Vertex Transformations"
          hint="Per-slot model transform applied to the equipped obj's vertices."
          cols={['TX', 'TY', 'TZ', 'RX', 'RY', 'RZ']}
          slots={draft.objVerticeTransformations}
          onSet={(slot, col, v) => setSlotValue('objVerticeTransformations', slot, col, v)}
          onAdd={() => addSlot('objVerticeTransformations', 6)}
          onRemove={(slot) => removeSlot('objVerticeTransformations', slot)}
        />

        <SlotTable
          title="Projection Offset"
          cols={['X', 'Y', 'Z']}
          slots={draft.projectionOffset}
          onSet={(slot, col, v) => setSlotValue('projectionOffset', slot, col, v)}
          onAdd={() => addSlot('projectionOffset', 3)}
          onRemove={(slot) => removeSlot('projectionOffset', slot)}
        />

        <SlotTable
          title="Turn Angle Adjustment"
          cols={['Angle']}
          slots={turnAngleAsRows}
          onSet={(slot, _col, v) => setTurnAngle(slot, v)}
          onAdd={addTurnAngle}
          onRemove={(slot) => setTurnAngle(slot, null)}
        />

        <section className="item-section">
          <h3>Obj Visibility</h3>
          <IntListInput
            value={draft.objVisibility}
            onChange={(v) => set('objVisibility', v)}
            placeholder="e.g. 0, 1, -1 (empty = unset)"
          />
        </section>

        <NumGrid
          fields={[['unusedOpcode37', 'unused (opcode 37)'], ['unusedOpcode43', 'unused (opcode 43)'], ['unusedOpcode44', 'unused (opcode 44)']]}
          values={{
            unusedOpcode37: draft.unusedOpcode37,
            // 43/44 are optional shorts; -1 in the editor means "absent".
            unusedOpcode43: draft.unusedOpcode43 ?? -1,
            unusedOpcode44: draft.unusedOpcode44 ?? -1,
          }}
          onChange={(key, v) => set(key, key === 'unusedOpcode37' ? v : v < 0 ? undefined : v)}
        />
      </details>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

function padSlots(arr: (number[] | null)[] | undefined): (number[] | null)[] {
  const out = [...(arr ?? [])]
  while (out.length < OBJ_SLOT_COUNT) out.push(null)
  return out
}

// Drop keys the dumper would also omit (gson skips null fields), so a
// no-op edit round-trips to the exact JSON cryogen wrote.
function pruneDef(def: BasDef): BasDef {
  const out = { ...def }
  if (!out.randomStandSequences?.length) {
    delete out.randomStandSequences
    delete out.randomStandSequenceChances
  }
  if (!out.objVisibility?.length) delete out.objVisibility
  if (!out.objVerticeTransformations?.some((v) => v != null)) delete out.objVerticeTransformations
  if (!out.projectionOffset?.some((v) => v != null)) delete out.projectionOffset
  if (!out.turnAngleAdjustment?.some((v) => v != null)) delete out.turnAngleAdjustment
  if (out.unusedOpcode43 == null) delete out.unusedOpcode43
  if (out.unusedOpcode44 == null) delete out.unusedOpcode44
  return out
}
