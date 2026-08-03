import { useEffect, useRef, useState } from 'react'
import type { VarKind, VarOverride, PlayerState } from '../loaders/varOverrides'
import {
  DEFAULT_SKILL_LEVEL, KNOWN_VARS, knownVar, loadPlayerState, loadVarOverrides, savePlayerState, saveVarOverrides,
} from '../loaders/varOverrides'
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
  const [player, setPlayer] = useState<PlayerState>(() => loadPlayerState())
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  const editPlayer = (patch: Partial<PlayerState>) => {
    setPlayer((prev) => ({ ...prev, ...patch }))
    setDirty(true)
    setSaved(false)
  }

  /** Add a named variable at its current effective value, so the row starts
   *  where the preview already is instead of snapping something to 0. */
  const addKnown = (index: number) => {
    const k = KNOWN_VARS[index]
    if (!k) return
    const level = (skill: number) => rows.find((r) => r.kind === 'stat' && r.id === skill)?.value ?? DEFAULT_SKILL_LEVEL
    const value = k.kind === 'stat' ? DEFAULT_SKILL_LEVEL : k.derive?.(level) ?? 0
    setRows((prev) => (prev.some((r) => r.kind === k.kind && r.id === k.id)
      ? prev
      : [...prev, { key: nextKey++, kind: k.kind, id: k.id, value }]))
    setDirty(true)
    setSaved(false)
  }

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
    savePlayerState(player)
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
          The stand-in player the previews read. Objects with more than one version — a door open or shut,
          a roof before and after a quest smashes it — pick between them with a varbit or varp, and the
          gameframe's HUD scripts size the orb fills and colour their numbers from a player's levels and
          points. With nothing set you get a brand-new account: every skill level {DEFAULT_SKILL_LEVEL},
          full orbs, and each morph showing the version a fresh world would. Applies to the map scene,
          cutscene previews and the in-game interface preview.
        </p>

        <div className="var-player-row">
          <label className="item-field">
            <span className="item-field-label">Display name</span>
            <input
              className="text-input-sized var-name-input"
              value={player.displayName}
              title="get_displayname / chat_playername — the name the chatbox and any interface that greets you shows"
              onChange={(e) => editPlayer({ displayName: e.target.value })}
            />
          </label>
          <label className="item-field" title="runenergy_visible() — fills the run orb and colours its number">
            <span className="item-field-label">Run energy</span>
            <NumberInput value={player.runEnergy} digits={3} min={0} max={100} onChange={(v) => editPlayer({ runEnergy: v })} />
          </label>
          <label className="iface-toggle" title="map_members / playermember">
            <input type="checkbox" checked={player.members} onChange={(e) => editPlayer({ members: e.target.checked })} />
            Members world
          </label>
        </div>

        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>Type</th><th>Id</th><th>Name</th><th>Value</th><th /></tr>
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
                      <option value="stat">Skill</option>
                    </select>
                  </td>
                  <td><NumberInput className="cell-input" value={row.id} min={0} onChange={(v) => edit(row.key, { id: v })} /></td>
                  <td className="var-name-cell" title={knownVar(row.kind, row.id)?.what}>
                    {knownVar(row.kind, row.id)
                      ? <>{knownVar(row.kind, row.id)!.name}<span className="var-what">{knownVar(row.kind, row.id)!.what}</span></>
                      : <span className="var-unnamed">{row.kind === 'stat' ? `skill ${row.id}` : '—'}</span>}
                  </td>
                  <td><NumberInput className="cell-input" value={row.value} onChange={(v) => edit(row.key, { value: v })} /></td>
                  <td>
                    <button type="button" className="row-remove-btn" title="Remove" onClick={() => removeRow(row.key)}>×</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="var-overrides-empty">Nothing set — a fresh account, every morph on its default.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="var-add-row">
          <button type="button" className="add-row-btn" onClick={addRow}>+ Add variable</button>
          <select
            className="item-stackable-select var-known-picker"
            value=""
            onChange={(e) => { addKnown(Number(e.target.value)); e.currentTarget.value = '' }}
          >
            <option value="" disabled>+ Add a named one…</option>
            {KNOWN_VARS.map((k, i) => (
              <option key={`${k.kind}:${k.id}`} value={i} disabled={rows.some((r) => r.kind === k.kind && r.id === k.id)}>
                {k.name} — {k.what}
              </option>
            ))}
          </select>
        </div>

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
