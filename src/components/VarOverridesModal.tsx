import { useEffect, useMemo, useRef, useState } from 'react'
import type { CustomVarName, VarKind, VarOverride, PlayerState } from '../loaders/varOverrides'
import {
  DEFAULT_SKILL_LEVEL, loadPlayerState, loadVarNames, loadVarOverrides, mergeVarNames,
  savePlayerState, saveVarNames, saveVarOverrides, tracedVar,
} from '../loaders/varOverrides'
import { CellDropdown, NumberInput } from './defFields'
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

const KIND_OPTIONS: { value: VarKind; label: string; hint: string }[] = [
  { value: 'varbit', label: 'Varbit', hint: 'A packed bit range inside a varp — what most morphs and HUD counters read' },
  { value: 'varp', label: 'Varp', hint: 'A whole player variable' },
  { value: 'stat', label: 'Skill', hint: 'A skill level, read by stat() / stat_base()' },
]

/** `${kind}:${id}` — names key off the VAR, not the row, so retyping a row's
 *  id shows that id's name rather than dragging the old one along. */
const varKey = (kind: VarKind, id: number) => `${kind}:${id}`

/**
 * The name box. Free text while focused, same as `ScriptInput` /
 * `IntListInput`: the committed value falls back to the traced name when the
 * custom one is empty, so a controlled input would put "Life points" back the
 * instant you cleared it to type your own. Blur snaps to the canonical name.
 */
function NameInput({ custom, traced, onCommit, title }: {
  custom: string | undefined
  traced: string | undefined
  onCommit: (name: string) => void
  title?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const canonical = custom ?? traced ?? ''
  return (
    <input
      className="cell-input var-name-field"
      value={text ?? canonical}
      placeholder="name it…"
      title={title}
      onFocus={() => setText(canonical)}
      onBlur={() => setText(null)}
      onChange={(e) => { setText(e.target.value); onCommit(e.target.value) }}
    />
  )
}

/** The draft name map back in storage shape. */
const draftNames = (names: Map<string, string>): CustomVarName[] =>
  [...names].map(([key, name]) => {
    const [kind, id] = key.split(':')
    return { kind: kind as VarKind, id: Number(id), name }
  })

let nextKey = 1

export default function VarOverridesModal({ onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])
  const [rows, setRows] = useState<Row[]>(() => loadVarOverrides().map((o) => ({ ...o, key: nextKey++ })))
  const [player, setPlayer] = useState<PlayerState>(() => loadPlayerState())
  /** the user's own names, `${kind}:${id}` → name. Held separately from `rows`
   *  because a name outlives its row: deleting the row that taught you what
   *  varbit 10685 is shouldn't lose the fact. */
  const [names, setNames] = useState<Map<string, string>>(
    () => new Map(loadVarNames().map((n) => [varKey(n.kind, n.id), n.name])),
  )
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  /** The picker's contents: traced names with the DRAFT names layered over
   *  them, so one typed a second ago is offerable and one just cleared is not
   *  — waiting for Save would make the box feel broken. */
  const pickable = useMemo(
    () => mergeVarNames(draftNames(names)).sort((a, b) => a.name.localeCompare(b.name)),
    [names],
  )

  const editPlayer = (patch: Partial<PlayerState>) => {
    setPlayer((prev) => ({ ...prev, ...patch }))
    setDirty(true)
    setSaved(false)
  }

  /** Add a named variable at its current effective value, so the row starts
   *  where the preview already is instead of snapping something to 0. */
  const addKnown = (index: number) => {
    const k = pickable[index]
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

  /** Name a var. Clearing the box drops the custom name — which restores the
   *  traced one underneath if there is one, rather than blanking it. */
  const rename = (kind: VarKind, id: number, name: string) => {
    setNames((prev) => {
      const next = new Map(prev)
      const trimmed = name.trim()
      if (trimmed === '') next.delete(varKey(kind, id))
      else next.set(varKey(kind, id), trimmed)
      return next
    })
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
    // names first: the override save is what notifies the open scenes, so by
    // the time anything repaints the names it might show are already current
    saveVarNames(draftNames(names))
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
              <tr>
                <th>Type</th>
                <th>Id</th>
                <th title="Yours to write. The cache names nothing — varps and varbits are bare numbered slots — so a name here is either one we traced out of a gameframe script or one you gave it. Named vars are offered in the picker below, so a name survives deleting its row.">
                  Name
                </th>
                <th>Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // traced, NOT the merged view — the draft name below is the
                // user's answer, and `known.what` has to keep describing the
                // var even after they rename it
                const known = tracedVar(row.kind, row.id)
                const custom = names.get(varKey(row.kind, row.id))
                return (
                  <tr key={row.key}>
                    <td>
                      <CellDropdown<VarKind>
                        value={row.kind}
                        options={KIND_OPTIONS}
                        onChange={(kind) => edit(row.key, { kind })}
                      />
                    </td>
                    <td><NumberInput className="cell-input" value={row.id} min={0} onChange={(v) => edit(row.key, { id: v })} /></td>
                    <td className="var-name-cell">
                      <NameInput
                        custom={custom}
                        traced={known?.name}
                        title={custom && known?.what
                          ? `Your name. Traced as "${known.name}" — ${known.what}`
                          : known?.what || 'Nothing names this one yet — type what it does and it joins the picker below.'}
                        onCommit={(name) => rename(row.kind, row.id, name)}
                      />
                      {known?.what && <span className="var-what">{known.what}</span>}
                    </td>
                    <td><NumberInput className="cell-input" value={row.value} onChange={(v) => edit(row.key, { value: v })} /></td>
                    <td>
                      <button type="button" className="row-remove-btn" title="Remove" onClick={() => removeRow(row.key)}>×</button>
                    </td>
                  </tr>
                )
              })}
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
            {pickable.map((k, i) => (
              <option key={varKey(k.kind, k.id)} value={i} disabled={rows.some((r) => r.kind === k.kind && r.id === k.id)}>
                {k.name}{k.what ? ` — ${k.what}` : ` — ${k.kind} ${k.id}`}
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
