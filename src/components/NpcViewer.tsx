import { useEffect, useState } from 'react'
import type { NpcData, NpcDef } from '../loaders/npcs'
import { NumberInput, IntListInput, NumGrid, PairTable, ParamsTable, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'

type Props = {
  data: NpcData
  onSave: (data: NpcData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['size', 'Size'],
  ['combatLevel', 'Combat Level'],
  ['headIcons', 'Head Icons'],
  ['turnDirection', 'Turn Direction'],
  ['iconHeight', 'Icon Height'],
  ['walkMask', 'Walk Mask'],
  ['sizeShift', 'Size Shift'],
  ['gameType', 'Game Type'],
  ['basId', 'BAS ID'],
  ['mecId', 'MEC ID'],
  ['overheadSprite', 'Overhead Sprite'],
  ['shadowSize', 'Shadow Size'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['visible', 'Visible'],
  ['displayOnMinimap', 'Minimap Dot'],
  ['delayMovement', 'Delay Movement'],
  ['shadowed', 'Shadowed'],
  ['highPriority', 'High Priority'],
  ['mediumPriority', 'Medium Priority'],
  ['lowPriority', 'Low Priority'],
  ['hasTint', 'Has Tint'],
  ['instrumentSoundEffect', 'Instrument Sound FX'],
]

const RENDER_FIELDS: NumFieldDef[] = [
  ['scaleXZ', 'Scale XZ'],
  ['scaleY', 'Scale Y'],
  ['ambient', 'Ambient'],
  ['contrast', 'Contrast'],
]

const SHADOW_FIELDS: NumFieldDef[] = [
  ['shadowColorSrc', 'Colour Src'],
  ['shadowColorDst', 'Colour Dst'],
  ['shadowAlphaSrc', 'Alpha Src'],
  ['shadowAlphaDst', 'Alpha Dst'],
]

const SOUND_FIELDS: NumFieldDef[] = [
  ['walkingSoundEffect', 'Walking Sound'],
  ['runningSoundEffect', 'Running Sound'],
  ['idleSoundEffect', 'Idle Sound'],
  ['teleportSoundEffect', 'Teleport Sound'],
  ['ambientSoundVolume', 'Volume'],
  ['ambientSoundMinHearDistance', 'Min Hear Distance'],
  ['ambientSoundMaxHearDistance', 'Max Hear Distance'],
  ['ambientSoundMinDelay', 'Min Delay'],
  ['ambientSoundMaxDelay', 'Max Delay'],
]

const CURSOR_FIELDS: NumFieldDef[] = [
  ['primaryCursorActionIndex', 'Primary Op'],
  ['primaryCursor', 'Primary Cursor'],
  ['secondaryCursorActionIndex', 'Secondary Op'],
  ['secondaryCursor', 'Secondary Cursor'],
  ['attackCursor', 'Attack Cursor'],
]

const TINT_FIELDS: NumFieldDef[] = [
  ['tintHue', 'Hue'],
  ['tintSaturation', 'Saturation'],
  ['tintLightness', 'Lightness'],
  ['tintOpacity', 'Opacity'],
]

const VAR_FIELDS: NumFieldDef[] = [
  ['varp', 'Varp'],
  ['varpBit', 'Varbit'],
]

const DIRECTIONS = ['NORTH', 'NORTHEAST', 'EAST', 'SOUTHEAST', 'SOUTH', 'SOUTHWEST', 'WEST', 'NORTHWEST']

export default function NpcViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<NpcDef>(data.npc)
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => toParamRows(data.npc.parameters))
  const [newQuestId, setNewQuestId] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.npc)
    setParamRows(toParamRows(data.npc.parameters))
    setNewQuestId('')
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
    setIsDirty(true)
  }

  function setOption(key: 'options' | 'membersOptions', index: number, value: string) {
    const arr = [...(draft[key] ?? [null, null, null, null, null])]
    arr[index] = value === '' ? null : value
    set(key, arr)
  }

  function setPair(srcKey: string, dstKey: string, index: number, which: 0 | 1, value: number) {
    const src = [...((draft[srcKey] as number[] | undefined) ?? [])]
    const dst = [...((draft[dstKey] as number[] | undefined) ?? [])]
    if (which === 0) src[index] = value
    else dst[index] = value
    setDraft((prev) => ({ ...prev, [srcKey]: src, [dstKey]: dst }))
    setIsDirty(true)
  }

  function addPair(srcKey: string, dstKey: string) {
    const src = [...((draft[srcKey] as number[] | undefined) ?? []), 0]
    const dst = [...((draft[dstKey] as number[] | undefined) ?? []), 0]
    setDraft((prev) => ({ ...prev, [srcKey]: src, [dstKey]: dst }))
    setIsDirty(true)
  }

  function removePair(srcKey: string, dstKey: string, index: number) {
    const src = ((draft[srcKey] as number[] | undefined) ?? []).filter((_, i) => i !== index)
    const dst = ((draft[dstKey] as number[] | undefined) ?? []).filter((_, i) => i !== index)
    setDraft((prev) => {
      const next = { ...prev }
      if (src.length === 0) {
        delete next[srcKey]
        delete next[dstKey]
      } else {
        next[srcKey] = src
        next[dstKey] = dst
      }
      return next
    })
    setIsDirty(true)
  }

  // --- model translations ---------------------------------------------------
  // Sparse: one slot per entry in modelIds, each null or an [x, y, z] triple.

  const modelIds = (draft.modelIds as number[] | undefined) ?? []
  const modelTranslation = (draft.modelTranslation as (number[] | null)[] | undefined) ?? []

  function setTranslation(index: number, axis: 0 | 1 | 2, value: number) {
    const next = modelIds.map((_, i) => {
      const current = modelTranslation[i] ?? null
      if (i !== index) return current
      const triple = current ? [...current] : [0, 0, 0]
      triple[axis] = value
      return triple
    })
    set('modelTranslation', next)
  }

  function addTranslation(index: number) {
    const next = modelIds.map((_, i) => (i === index ? [0, 0, 0] : (modelTranslation[i] ?? null)))
    set('modelTranslation', next)
  }

  function clearTranslation(index: number) {
    const next = modelIds.map((_, i) => (i === index ? null : (modelTranslation[i] ?? null)))
    set('modelTranslation', next.every((t) => t === null) ? undefined : next)
  }

  function addQuest() {
    const id = parseInt(newQuestId, 10)
    if (isNaN(id)) return
    const quests = (draft.quests as number[] | undefined) ?? []
    if (quests.includes(id)) return
    set('quests', [...quests, id])
    setNewQuestId('')
  }

  function removeQuest(id: number) {
    const quests = ((draft.quests as number[] | undefined) ?? []).filter((q) => q !== id)
    set('quests', quests.length === 0 ? undefined : quests)
  }

  function setParamRow(index: number, patch: Partial<ParamRow>) {
    setParamRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
    setIsDirty(true)
  }

  async function handleSave() {
    const next: NpcDef = { ...draft }
    const params = paramRowsToRecord(paramRows)
    if (params) next.parameters = params
    else delete next.parameters

    setIsSaving(true)
    await onSave({ ...data, npc: next })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.npc)
    setParamRows(toParamRows(data.npc.parameters))
    setNewQuestId('')
    setIsDirty(false)
  }

  const quests = (draft.quests as number[] | undefined) ?? []

  return (
    <div className="item-viewer">
      <div className="item-header">
        <input
          className="quest-name-input"
          value={String(draft.name ?? '')}
          onChange={(e) => set('name', e.target.value)}
        />
        <div className="item-badges">
          <span className="item-id-badge">ID {data.id}</span>
          <label className="item-stackable">
            <span className="item-field-label">Respawn Direction</span>
            <select
              className="item-stackable-select"
              value={String(draft.respawnDirection ?? 'SOUTH')}
              onChange={(e) => set('respawnDirection', e.target.value)}
            >
              {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
      </div>

      <section className="item-section">
        <h3>Models</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Model IDs</span>
          <IntListInput
            value={(draft.modelIds as number[] | undefined)}
            onChange={(v) => set('modelIds', v)}
            placeholder="model ids, comma-separated"
          />
        </div>
        <div className="object-int-list-row">
          <span className="item-field-label">Head Models</span>
          <IntListInput
            value={(draft.headModels as number[] | undefined)}
            onChange={(v) => set('headModels', v)}
            placeholder="head model ids, comma-separated"
          />
        </div>
        {modelIds.length > 0 && (
          <div className="quest-table-wrap object-shapes-wrap">
            <table className="quest-table">
              <thead><tr><th>Model</th><th>Translate X</th><th>Y</th><th>Z</th><th></th></tr></thead>
              <tbody>
                {modelIds.map((modelId, i) => {
                  const triple = modelTranslation[i] ?? null
                  return (
                    <tr key={i}>
                      <td className="item-stack-index">{modelId}</td>
                      {triple ? (
                        <>
                          {([0, 1, 2] as const).map((axis) => (
                            <td key={axis}>
                              <NumberInput className="cell-input" value={triple[axis] ?? 0} onChange={(v) => setTranslation(i, axis,v)} />
                            </td>
                          ))}
                          <td><button type="button" className="row-remove-btn" title="Remove translation" onClick={() => clearTranslation(i)}>×</button></td>
                        </>
                      ) : (
                        <>
                          <td colSpan={3} className="item-stack-index">no translation</td>
                          <td>
                            <button type="button" className="add-row-btn" onClick={() => addTranslation(i)}>+ Set</button>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="item-section">
        <h3>Options</h3>
        <div className="item-options">
          {(['options', 'membersOptions'] as const).map((key) => (
            <div key={key} className="item-option-row">
              <span className="item-field-label">{key === 'options' ? 'Options' : 'Members'}</span>
              {Array.from({ length: 5 }, (_, i) => (
                <input
                  key={i}
                  className="item-option-input"
                  type="text"
                  placeholder="—"
                  value={(draft[key]?.[i] ?? '') as string}
                  onChange={(e) => setOption(key, i, e.target.value)}
                />
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid fields={FLAG_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Render</h3>
        <NumGrid fields={RENDER_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Shadow</h3>
        <NumGrid fields={SHADOW_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Sounds</h3>
        <NumGrid fields={SOUND_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Cursors</h3>
        <NumGrid fields={CURSOR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Tint</h3>
        <NumGrid fields={TINT_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Var Transforms</h3>
        <NumGrid fields={VAR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
        <div className="object-int-list-row">
          <span className="item-field-label">Transform To</span>
          <IntListInput
            value={(draft.transformTo as number[] | undefined)}
            onChange={(v) => set('transformTo', v)}
            placeholder="npc ids, comma-separated (-1 = none)"
          />
        </div>
      </section>

      <PairTable
        title="Colours" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalColors as number[] | undefined) ?? []}
        dst={(draft.modifiedColors as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalColors', 'modifiedColors', i, w, v)}
        onAdd={() => addPair('originalColors', 'modifiedColors')}
        onRemove={(i) => removePair('originalColors', 'modifiedColors', i)}
      />
      <PairTable
        title="Textures" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalTextures as number[] | undefined) ?? []}
        dst={(draft.modifiedTextures as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalTextures', 'modifiedTextures', i, w, v)}
        onAdd={() => addPair('originalTextures', 'modifiedTextures')}
        onRemove={(i) => removePair('originalTextures', 'modifiedTextures', i)}
      />

      <section className="item-section">
        <h3>Quests</h3>
        <div className="quest-prereqs">
          {quests.map((id) => (
            <span key={id} className="prereq-tag">
              {id}
              <button type="button" onClick={() => removeQuest(id)}>×</button>
            </span>
          ))}
          <div className="prereq-add">
            <input className="prereq-input" type="number" placeholder="ID"
              value={newQuestId}
              onChange={(e) => setNewQuestId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addQuest()} />
            <button type="button" className="add-row-btn" onClick={addQuest}>Add</button>
          </div>
        </div>
      </section>

      <section className="item-section">
        <h3>Params (parameters)</h3>
        <ParamsTable
          rows={paramRows}
          onSet={setParamRow}
          onAdd={() => { setParamRows((prev) => [...prev, { key: '', isString: false, value: '' }]); setIsDirty(true) }}
          onRemove={(i) => { setParamRows((prev) => prev.filter((_, idx) => idx !== i)); setIsDirty(true) }}
        />
      </section>

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
