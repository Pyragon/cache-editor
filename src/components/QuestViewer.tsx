import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import type { QuestServerData } from '../loaders/types'
import './QuestViewer.css'

const SKILLS: Record<number, string> = {
  0: 'Attack', 1: 'Defence', 2: 'Strength', 3: 'Hitpoints', 4: 'Ranged',
  5: 'Prayer', 6: 'Magic', 7: 'Cooking', 8: 'Woodcutting', 9: 'Fletching',
  10: 'Fishing', 11: 'Firemaking', 12: 'Crafting', 13: 'Smithing', 14: 'Mining',
  15: 'Herblore', 16: 'Agility', 17: 'Thieving', 18: 'Slayer', 19: 'Farming',
  20: 'Runecrafting', 21: 'Hunter', 22: 'Construction',
}

const DIFFICULTIES = ['NOVICE', 'INTERMEDIATE', 'EXPERIENCED', 'MASTER', 'GRANDMASTER']
const TYPES = ['NORMAL', 'MINIQUEST', 'HOLIDAY']

const DIFFICULTY_COLOURS: Record<string, string> = {
  NOVICE: '#4caf50',
  INTERMEDIATE: '#ff9800',
  EXPERIENCED: '#f44336',
  MASTER: '#9c27b0',
  GRANDMASTER: '#3f51b5',
}

const TYPE_LABELS: Record<string, string> = {
  NORMAL: 'Quest',
  MINIQUEST: 'Miniquest',
  HOLIDAY: 'Holiday',
}

export type QuestData = {
  id: number
  name: string
  sortName?: string
  members: boolean
  type: string
  difficulty: string
  questpointRequirement: number
  questpointReward: number
  graphicId: number
  varValues?: number[][]
  varbitValues?: number[][]
  _questPrerequisiteIds?: number[]
  _levelRequirements?: number[][]
}

const DEFAULT_SERVER_DATA: QuestServerData = {
  startNpc: -1,
  startLocation: { x: 0, y: 0, plane: 0 },
  slotId: -1,
  prereqQuestIds: [],
  skillReqs: [],
  structId: -1,
  structName: '',
  structSortName: '',
  journal: { startHint: '', requiredItems: '', enemiesToDefeat: '', rewards: '' },
  extraValues: [],
  preReqSkillReqs: [],
}

const JOURNAL_FIELDS: [key: keyof QuestServerData['journal'], structKey: number, label: string][] = [
  ['startHint', 948, 'Start Hint'],
  ['requiredItems', 949, 'Required Items'],
  ['enemiesToDefeat', 950, 'Enemies to Defeat'],
  ['rewards', 951, 'Rewards'],
]

type BadgeDropdownProps = {
  value: string
  options: { value: string; label: string; color?: string }[]
  className?: string
  style?: React.CSSProperties
  onChange: (value: string) => void
}

function BadgeDropdown({ value, options, className, style, onChange }: BadgeDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="badge-dropdown-wrap">
      <button
        type="button"
        className={`badge-dropdown-trigger ${className ?? ''}`}
        style={style}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
        <span className="badge-dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="badge-dropdown-menu">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`badge-dropdown-item ${opt.value === value ? 'active' : ''}`}
              style={opt.color ? { color: opt.color } : undefined}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type CellDropdownProps = {
  value: number
  options: { value: number; label: string }[]
  onChange: (value: number) => void
}

function CellDropdown({ value, options, onChange }: CellDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="cell-dropdown-wrap">
      <button
        type="button"
        className={`cell-dropdown-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
        <span className="badge-dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="cell-dropdown-menu">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`cell-dropdown-item${opt.value === value ? ' active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SKILL_OPTIONS = Object.entries(SKILLS).map(([id, name]) => ({ value: Number(id), label: name }))

type Props = {
  data: QuestData
  serverData?: QuestServerData
  onSave: (quest: QuestData, server: QuestServerData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function QuestViewer({ data, serverData, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<QuestData>(data)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [newPrereqId, setNewPrereqId] = useState('')
  const [serverDraft, setServerDraft] = useState<QuestServerData>(serverData ?? DEFAULT_SERVER_DATA)
  const [isServerDirty, setIsServerDirty] = useState(false)
  const [newServerPrereqId, setNewServerPrereqId] = useState('')

  useEffect(() => {
    setDraft(data)
    setIsDirty(false)
    setNewPrereqId('')
    setServerDraft(serverData ?? DEFAULT_SERVER_DATA)
    setIsServerDirty(false)
    setNewServerPrereqId('')
  }, [data, serverData])

  useEffect(() => {
    onDirtyChange?.(isDirty || isServerDirty)
  }, [isDirty, isServerDirty, onDirtyChange])

  function set<K extends keyof QuestData>(key: K, value: QuestData[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setServer<K extends keyof QuestServerData>(key: K, value: QuestServerData[K]) {
    setServerDraft((prev) => ({ ...prev, [key]: value }))
    setIsServerDirty(true)
  }

  function setTile(field: 'x' | 'y' | 'plane', val: number) {
    setServerDraft((prev) => ({ ...prev, startLocation: { ...prev.startLocation, [field]: val } }))
    setIsServerDirty(true)
  }

  function setJournal(key: keyof QuestServerData['journal'], value: string) {
    setServerDraft((prev) => ({ ...prev, journal: { ...prev.journal, [key]: value } }))
    setIsServerDirty(true)
  }

  function setExtra(i: number, which: 0 | 1, value: number | string) {
    setServerDraft((prev) => ({
      ...prev,
      extraValues: prev.extraValues.map((row, ri) =>
        ri === i ? ([which === 0 ? Number(value) : row[0], which === 1 ? value : row[1]] as [number, string | number]) : row
      ),
    }))
    setIsServerDirty(true)
  }

  function addExtra() {
    setServer('extraValues', [...serverDraft.extraValues, [0, 0]])
  }

  function removeExtra(i: number) {
    setServer('extraValues', serverDraft.extraValues.filter((_, ri) => ri !== i))
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave(draft, serverDraft)
    setIsSaving(false)
    setIsDirty(false)
    setIsServerDirty(false)
  }

  function handleDiscard() {
    setDraft(data)
    setIsDirty(false)
    setNewPrereqId('')
    setServerDraft(serverData ?? DEFAULT_SERVER_DATA)
    setIsServerDirty(false)
    setNewServerPrereqId('')
  }

  const varKey = draft.varValues !== undefined ? 'varValues' : 'varbitValues'
  const vars = (draft[varKey] ?? []) as number[][]
  const varLabel = varKey === 'varValues' ? 'Var' : 'Varbit'

  function setVar(i: number, j: number, val: number) {
    const updated = vars.map((row, ri) =>
      ri === i ? row.map((v, ci) => (ci === j ? val : v)) : row
    )
    set(varKey, updated)
  }

  function addVar() { set(varKey, [...vars, [0, 0, 0]]) }
  function removeVar(i: number) { set(varKey, vars.filter((_, ri) => ri !== i)) }

  const prereqs = draft._questPrerequisiteIds ?? []
  const levelReqs = draft._levelRequirements ?? []

  function setLevelReq(i: number, j: number, val: number) {
    const updated = levelReqs.map((row, ri) =>
      ri === i ? row.map((v, ci) => (ci === j ? val : v)) : row
    )
    set('_levelRequirements', updated)
  }

  function addLevelReq() { set('_levelRequirements', [...levelReqs, [0, 1]]) }
  function removeLevelReq(i: number) { set('_levelRequirements', levelReqs.filter((_, ri) => ri !== i)) }

  function addPrereq() {
    const id = parseInt(newPrereqId, 10)
    if (!isNaN(id) && !prereqs.includes(id)) {
      set('_questPrerequisiteIds', [...prereqs, id])
      setNewPrereqId('')
    }
  }

  function removePrereq(id: number) {
    set('_questPrerequisiteIds', prereqs.filter((p) => p !== id))
  }

  function addServerPrereq() {
    const id = parseInt(newServerPrereqId, 10)
    if (!isNaN(id) && !serverDraft.prereqQuestIds.includes(id)) {
      setServer('prereqQuestIds', [...serverDraft.prereqQuestIds, id])
      setNewServerPrereqId('')
    }
  }

  function removeServerPrereq(id: number) {
    setServer('prereqQuestIds', serverDraft.prereqQuestIds.filter((p) => p !== id))
  }

  function addSkillReq() {
    setServer('skillReqs', [...serverDraft.skillReqs, [0, 1]])
  }

  function setSkillReq(i: number, j: number, val: number) {
    setServerDraft((prev) => ({
      ...prev,
      skillReqs: prev.skillReqs.map((row, ri) =>
        ri === i ? (row.map((v, ci) => (ci === j ? val : v)) as [number, number]) : row
      ),
    }))
    setIsServerDirty(true)
  }

  function removeSkillReq(i: number) {
    setServer('skillReqs', serverDraft.skillReqs.filter((_, ri) => ri !== i))
  }

  const diffColour = DIFFICULTY_COLOURS[draft.difficulty] ?? '#888'
  const anyDirty = isDirty || isServerDirty

  return (
    <div className="quest-viewer">

      <div className="quest-header">
        <input
          className="quest-name-input"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <div className="quest-badges">
          <BadgeDropdown
            value={draft.type}
            options={TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            className="badge-type"
            onChange={(v) => set('type', v)}
          />
          <BadgeDropdown
            value={draft.difficulty}
            options={DIFFICULTIES.map((d) => ({ value: d, label: d, color: DIFFICULTY_COLOURS[d] }))}
            style={{ color: diffColour, borderColor: diffColour }}
            onChange={(v) => set('difficulty', v)}
          />
          <label className="badge-toggle">
            <input
              type="checkbox"
              checked={draft.members}
              onChange={(e) => set('members', e.target.checked)}
            />
            <span className={draft.members ? 'badge badge-members' : 'badge badge-f2p'}>
              {draft.members ? 'Members' : 'Free to Play'}
            </span>
          </label>
        </div>
      </div>

      <p className="tex-op-note quest-sources-note">
        A quest lives in two cache archives: sections marked <strong>quest def</strong> edit
        config/quests/&lt;id&gt;.json (CONFIG archive 35 — the client's quest list), and sections
        marked <strong>struct</strong> edit config/structs/{serverDraft.structId >= 0 ? serverDraft.structId : '?'}.json
        (CONFIG archive 26 — the quest start interface), linked via enum 2252. Some data exists in
        both and can drift.
      </p>

      <div className="quest-stats">
        {([
          ['QP Required', 'questpointRequirement'],
          ['QP Reward', 'questpointReward'],
          ['Graphic ID', 'graphicId'],
        ] as const).map(([label, key]) => (
          <div key={key} className="stat-card">
            <span className="stat-label">{label}</span>
            <NumberInput className="stat-input" value={draft[key]} onChange={(v) => set(key,v)} />
          </div>
        ))}
        <div className="stat-card">
          <span className="stat-label">Quest ID</span>
          <span className="stat-value">{draft.id}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Slot ID</span>
          <NumberInput className="stat-input" value={serverDraft.slotId} onChange={(v) => setServer('slotId',v)} />
        </div>
        <div className="stat-card">
          <span className="stat-label">Start NPC</span>
          <NumberInput className="stat-input" value={serverDraft.startNpc} onChange={(v) => setServer('startNpc',v)} />
        </div>
      </div>

      <section className="quest-section">
        <h3>Level Requirements (quest def)</h3>
        <div className="quest-table-wrap uniform">
          <table className="quest-table">
            <thead><tr><th>Skill</th><th>Level</th><th>Remove</th></tr></thead>
            <tbody>
              {levelReqs.map(([skillId, level], i) => (
                <tr key={i}>
                  <td style={{ minWidth: 160 }}>
                    <CellDropdown
                      value={skillId}
                      options={SKILL_OPTIONS}
                      onChange={(v) => setLevelReq(i, 0, v)}
                    />
                  </td>
                  <td style={{ minWidth: 70 }}>
                    <NumberInput className="cell-input" value={level} onChange={(v) => setLevelReq(i, 1,v)} />
                  </td>
                  <td><button type="button" className="row-remove-btn" onClick={() => removeLevelReq(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="add-row-btn" onClick={addLevelReq}>+ Add requirement</button>
      </section>

      <section className="quest-section">
        <h3>Prerequisite Quest IDs (quest def)</h3>
        <div className="quest-prereqs">
          {prereqs.map((id) => (
            <span key={id} className="prereq-tag">
              {id}
              <button type="button" onClick={() => removePrereq(id)}>×</button>
            </span>
          ))}
          <div className="prereq-add">
            <input className="prereq-input" type="number" placeholder="ID"
              value={newPrereqId}
              onChange={(e) => setNewPrereqId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPrereq()} />
            <button type="button" className="add-row-btn" onClick={addPrereq}>Add</button>
          </div>
        </div>
      </section>

      <section className="quest-section">
        <h3>Prereq Quest IDs (struct, keys 859–870)</h3>
        <div className="quest-prereqs">
          {serverDraft.prereqQuestIds.map((id) => (
            <span key={id} className="prereq-tag">
              {id}
              <button type="button" onClick={() => removeServerPrereq(id)}>×</button>
            </span>
          ))}
          <div className="prereq-add">
            <input className="prereq-input" type="number" placeholder="ID"
              value={newServerPrereqId}
              onChange={(e) => setNewServerPrereqId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addServerPrereq()} />
            <button type="button" className="add-row-btn" onClick={addServerPrereq}>Add</button>
          </div>
        </div>
      </section>

      <section className="quest-section">
        <h3>{varLabel} Tracking</h3>
        <div className="quest-table-wrap uniform">
          <table className="quest-table">
            <thead><tr><th>{varLabel} ID</th><th>Min</th><th>Max</th><th>Remove</th></tr></thead>
            <tbody>
              {vars.map((row, i) => (
                <tr key={i}>
                  {row.map((val, j) => (
                    <td key={j}>
                      <NumberInput className="cell-input" value={val} onChange={(v) => setVar(i, j,v)} />
                    </td>
                  ))}
                  <td><button type="button" className="row-remove-btn" onClick={() => removeVar(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="add-row-btn" onClick={addVar}>+ Add row</button>
      </section>

      <section className="quest-section">
        <h3>Start Location (struct, key 850)</h3>
        <div className="tile-inputs">
          {(['x', 'y', 'plane'] as const).map((field) => (
            <div key={field} className="tile-field">
              <label className="tile-label">{field.toUpperCase()}</label>
              <NumberInput className="cell-input" value={serverDraft.startLocation[field]} onChange={(v) => setTile(field,v)} />
            </div>
          ))}
        </div>
      </section>

      <section className="quest-section">
        <h3>Skill Requirements (struct, keys 871+)</h3>
        <div className="quest-table-wrap uniform">
          <table className="quest-table">
            <thead><tr><th>Skill</th><th>Level</th><th>Remove</th></tr></thead>
            <tbody>
              {serverDraft.skillReqs.map(([skillId, level], i) => (
                <tr key={i}>
                  <td style={{ minWidth: 160 }}>
                    <CellDropdown
                      value={skillId}
                      options={SKILL_OPTIONS}
                      onChange={(v) => setSkillReq(i, 0, v)}
                    />
                  </td>
                  <td style={{ minWidth: 70 }}>
                    <NumberInput className="cell-input" value={level} onChange={(v) => setSkillReq(i, 1,v)} />
                  </td>
                  <td><button type="button" className="row-remove-btn" onClick={() => removeSkillReq(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="add-row-btn" onClick={addSkillReq}>+ Add requirement</button>
      </section>

      <section className="quest-section">
        <h3>Total Skill Requirements (computed)</h3>
        <p className="tex-op-note">
          Read-only: the highest level needed per skill across this quest and its entire
          prerequisite tree (struct data, accumulated recursively).
        </p>
        <div className="quest-prereqs quest-computed-reqs">
          {serverDraft.preReqSkillReqs.length === 0 && <span className="quest-computed-none">None</span>}
          {serverDraft.preReqSkillReqs.map(([skillId, level]) => (
            <span key={skillId} className="prereq-tag quest-computed-tag">
              {level} {SKILLS[skillId] ?? `Skill ${skillId}`}
            </span>
          ))}
        </div>
      </section>

      <section className="quest-section">
        <h3>Quest Start Interface (struct {serverDraft.structId >= 0 ? serverDraft.structId : '?'})</h3>
        <div className="quest-journal-names">
          <label className="item-field">
            <span className="item-field-label">Interface Name (845)</span>
            <input className="item-field-input" value={serverDraft.structName}
              onChange={(e) => setServer('structName', e.target.value)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Sort Name (846)</span>
            <input className="item-field-input" value={serverDraft.structSortName}
              onChange={(e) => setServer('structSortName', e.target.value)} />
          </label>
        </div>
        {JOURNAL_FIELDS.map(([key, structKey, label]) => (
          <label key={key} className="item-field quest-journal-field">
            <span className="item-field-label">{label} ({structKey})</span>
            <textarea
              className="item-field-input quest-journal-text"
              rows={2}
              value={serverDraft.journal[key]}
              onChange={(e) => setJournal(key, e.target.value)}
            />
          </label>
        ))}
      </section>

      <section className="quest-section">
        <h3>Other Struct Values</h3>
        <p className="tex-op-note">
          Every remaining key of struct {serverDraft.structId >= 0 ? serverDraft.structId : '?'} not
          covered by the fields above, editable raw. Known uses include extra location hashes
          (851–854), the quest-complete graphic (952) and Squeal-era reward text (1212).
        </p>
        {serverDraft.extraValues.length > 0 && (
          <div className="quest-table-wrap uniform">
            <table className="quest-table">
              <thead><tr><th>Key</th><th>Value</th><th>Remove</th></tr></thead>
              <tbody>
                {serverDraft.extraValues.map(([key, value], i) => (
                  <tr key={i}>
                    <td style={{ width: 110 }}>
                      <NumberInput className="cell-input" value={key} onChange={(v) => setExtra(i, 0, v)} />
                    </td>
                    <td>
                      <input className="cell-input" value={String(value)}
                        onChange={(e) => setExtra(i, 1, e.target.value)} />
                    </td>
                    <td><button type="button" className="row-remove-btn" onClick={() => removeExtra(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={addExtra}>+ Add value</button>
      </section>

      {anyDirty && (
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
