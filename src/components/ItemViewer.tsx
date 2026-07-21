import { useEffect, useState } from 'react'
import type { ItemData, ItemDef } from '../loaders/items'
import type { ModelDisplayParams } from './ModelViewer'
import { RENDER_ANIM_PARAM } from '../loaders/animCompat'
import { itemIconDisplayParams } from './modelDisplay'
import { CursorPreview } from './spriteCards'
import { NumberInput, ItemIcon, NumGrid, PairTable, ParamsTable  } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'
import './ItemViewer.css'

type Props = {
  data: ItemData
  onSave: (data: ItemData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Opens the model viewer with the given model id selected — posed with the
      item's inventory-icon display params when given, plain otherwise (the
      equipment models are worn meshes; the icon transform doesn't apply). */
  onOpenModel?: (id: number, display?: ModelDisplayParams) => void
  /** Opens the config cursors viewer with the given cursor id selected. */
  onOpenCursor?: (id: number) => void
  /** Generic entry/item navigation (the render-anim param's BAS link). */
  onNavigate?: (entryName: string, itemId: number) => void
}

// The Equipment Models fields that hold model ids (the wear offsets are
// translations, not ids). −1 = none; NumGrid hides the link for negatives.
const EQUIP_MODEL_KEYS = [
  'maleEquip1', 'maleEquip2', 'maleEquip3',
  'femaleEquip1', 'femaleEquip2', 'femaleEquip3',
  'maleHead1', 'maleHead2', 'femaleHead1', 'femaleHead2',
]


// [cursor id key, op index key, label, which options list the op indexes]
const CURSOR_PREVIEWS: [key: string, opKey: string, label: string, options: 'groundOptions' | 'inventoryOptions'][] = [
  ['primaryCursor', 'primaryCursorActionIndex', 'Ground', 'groundOptions'],
  ['secondaryCursor', 'secondaryCursorActionIndex', 'Ground', 'groundOptions'],
  ['customCursorId1', 'customCursorOp1', 'Inventory', 'inventoryOptions'],
  ['customCursorId2', 'customCursorOp2', 'Inventory', 'inventoryOptions'],
]

// CursorPreview moved to spriteCards.tsx (shared with the NPC viewer).

const GENERAL_FIELDS: NumFieldDef[] = [
  ['value', 'Value'],
  ['teamId', 'Team ID'],
  ['wearPos', 'Wear Pos'],
  ['wearPos2', 'Wear Pos 2'],
  ['wearPos3', 'Wear Pos 3'],
  ['multiStackSize', 'Multi Stack Size'],
  ['pickSizeShift', 'Pick Size Shift'],
]

const MODEL_FIELDS: NumFieldDef[] = [
  ['modelId', 'Model ID'],
  ['modelZoom', 'Zoom'],
  ['modelRotationX', 'Rotation X'],
  ['modelRotationY', 'Rotation Y'],
  ['modelRotationZ', 'Rotation Z'],
  ['modelOffsetX', 'Offset X'],
  ['modelOffsetY', 'Offset Y'],
  ['resizeX', 'Resize X'],
  ['resizeY', 'Resize Y'],
  ['resizeZ', 'Resize Z'],
  ['ambient', 'Ambient'],
  ['contrast', 'Contrast'],
]

const EQUIP_FIELDS: NumFieldDef[] = [
  ['maleEquip1', 'Male Equip 1'],
  ['maleEquip2', 'Male Equip 2'],
  ['maleEquip3', 'Male Equip 3'],
  ['femaleEquip1', 'Female Equip 1'],
  ['femaleEquip2', 'Female Equip 2'],
  ['femaleEquip3', 'Female Equip 3'],
  ['maleHead1', 'Male Head 1'],
  ['maleHead2', 'Male Head 2'],
  ['femaleHead1', 'Female Head 1'],
  ['femaleHead2', 'Female Head 2'],
  ['maleWearXOffset', 'Male Wear X'],
  ['maleWearYOffset', 'Male Wear Y'],
  ['maleWearZOffset', 'Male Wear Z'],
  ['femaleWearXOffset', 'Female Wear X'],
  ['femaleWearYOffset', 'Female Wear Y'],
  ['femaleWearZOffset', 'Female Wear Z'],
]

const LINK_FIELDS: NumFieldDef[] = [
  ['certId', 'Cert (Note) ID'],
  ['certTemplateId', 'Cert Template'],
  ['lendId', 'Lend ID'],
  ['lendTemplateId', 'Lend Template'],
  ['bindId', 'Bind ID'],
  ['bindTemplateId', 'Bind Template'],
]

// Keys keep darkan's field names; the labels say what the client does with
// them. primary/secondary (opcodes 127/128) attach a cursor to a GROUND menu
// option (the index picks the groundOptions slot — same pair NPCs/objects use
// for their world options). custom 1/2 (129/130) attach one to an INVENTORY
// option, queried by interface CS2 (CS2Interpreter.method4630).
const CURSOR_FIELDS: NumFieldDef[] = [
  ['primaryCursorActionIndex', 'Ground Option 1'],
  ['primaryCursor', 'Ground Cursor 1'],
  ['secondaryCursorActionIndex', 'Ground Option 2'],
  ['secondaryCursor', 'Ground Cursor 2'],
  ['customCursorOp1', 'Inventory Option 1'],
  ['customCursorId1', 'Inventory Cursor 1'],
  ['customCursorOp2', 'Inventory Option 2'],
  ['customCursorId2', 'Inventory Cursor 2'],
]

const UNKNOWN_FIELDS: NumFieldDef[] = [
  ['unknownInt6', 'unknownInt6'],
  ['i_96_', 'i_96_'],
  ['i_97_', 'i_97_'],
  ['realOffsetX', 'realOffsetX'],
  ['realOffsetY', 'realOffsetY'],
]

export default function ItemViewer({ data, onSave, onDirtyChange, onOpenModel, onOpenCursor, onNavigate }: Props) {
  const [draft, setDraft] = useState<ItemDef>(data.item)
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => toParamRows(data.item.clientScriptData))
  const [newQuestId, setNewQuestId] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.item)
    setParamRows(toParamRows(data.item.clientScriptData))
    setNewQuestId('')
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  const bool = (key: string) => Boolean(draft[key])

  function setOption(key: 'groundOptions' | 'inventoryOptions', index: number, value: string) {
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
    setDraft((prev) => {
      const next = { ...prev }
      if (quests.length === 0) delete next.quests
      else next.quests = quests
      return next
    })
    setIsDirty(true)
  }

  function setStack(index: number, which: 0 | 1, value: number) {
    const ids = [...((draft.stackIds as number[] | undefined) ?? new Array(10).fill(0))]
    const amounts = [...((draft.stackTriggerAmount as number[] | undefined) ?? new Array(10).fill(0))]
    if (which === 0) ids[index] = value
    else amounts[index] = value
    setDraft((prev) => ({ ...prev, stackIds: ids, stackTriggerAmount: amounts }))
    setIsDirty(true)
  }

  function setParamRow(index: number, patch: Partial<ParamRow>) {
    setParamRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
    setIsDirty(true)
  }

  async function handleSave() {
    const next: ItemDef = { ...draft }
    const params = paramRowsToRecord(paramRows)
    if (params) next.clientScriptData = params
    else delete next.clientScriptData

    setIsSaving(true)
    await onSave({ ...data, item: next })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.item)
    setParamRows(toParamRows(data.item.clientScriptData))
    setNewQuestId('')
    setIsDirty(false)
  }

  const quests = (draft.quests as number[] | undefined) ?? []
  const hasStacks = draft.stackIds != null

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          <ItemIcon id={data.id} />
          <input
            className="quest-name-input"
            value={String(draft.name ?? '')}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {data.id}</span>
          <label className="badge-toggle">
            <input type="checkbox" checked={bool('membersOnly')} onChange={(e) => set('membersOnly', e.target.checked)} />
            <span className={bool('membersOnly') ? 'badge badge-members' : 'badge badge-f2p'}>
              {bool('membersOnly') ? 'Members' : 'Free to Play'}
            </span>
          </label>
          <label className="badge-toggle">
            <input type="checkbox" checked={bool('tradeable')} onChange={(e) => set('tradeable', e.target.checked)} />
            <span className={bool('tradeable') ? 'badge item-badge-tradeable' : 'badge item-badge-off'}>
              {bool('tradeable') ? 'Tradeable' : 'Untradeable'}
            </span>
          </label>
          <label className="item-stackable">
            <span className="item-field-label">Stackable</span>
            <select
              className="item-stackable-select"
              value={Number(draft.stackable ?? 0)}
              onChange={(e) => set('stackable', Number(e.target.value))}
            >
              <option value={0}>0 — No</option>
              <option value={1}>1 — Yes</option>
              <option value={2}>2 — Sometimes</option>
            </select>
          </label>
          {bool('noted') && <span className="badge item-badge-flag">Noted</span>}
          {bool('lended') && <span className="badge item-badge-flag">Lended</span>}
        </div>
      </div>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Options</h3>
        <div className="item-options">
          {(['groundOptions', 'inventoryOptions'] as const).map((key) => (
            <div key={key} className="item-option-row">
              <span className="item-field-label">{key === 'groundOptions' ? 'Ground' : 'Inventory'}</span>
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
        <h3>Model</h3>
        <NumGrid
          fields={MODEL_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{ modelId: onOpenModel && {
            label: 'View',
            // Carry the item's display params so the model preview can pose
            // the model the way the client draws this item's inventory icon.
            onOpen: (id) => onOpenModel(id, itemIconDisplayParams(draft as Record<string, unknown>, `item ${data.id}`)),
          } }}
        />
      </section>

      <section className="item-section">
        <h3>Equipment Models</h3>
        <NumGrid
          fields={EQUIP_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={onOpenModel && Object.fromEntries(EQUIP_MODEL_KEYS.map((key) => [
            key,
            { label: 'View', onOpen: (id: number) => onOpenModel(id) },
          ]))}
        />
      </section>

      <section className="item-section">
        <h3>Note / Lend / Bind Links</h3>
        <NumGrid fields={LINK_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Cursors</h3>
        <NumGrid fields={CURSOR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
        {CURSOR_PREVIEWS.some(([key]) => Number(draft[key] ?? -1) >= 0) && (
          <div className="item-cursor-row">
            {CURSOR_PREVIEWS.map(([key, opKey, label, optionsKey]) => {
              const option = (draft[optionsKey] as (string | null)[] | undefined)?.[Number(draft[opKey] ?? -1)]
              return (
                <CursorPreview
                  key={key}
                  cursorsDir={data.cursorsDir}
                  spritesDir={data.spritesDir}
                  cursorId={Number(draft[key] ?? -1)}
                  label={option ? `${label} · ${option}` : label}
                  onOpen={onOpenCursor}
                />
              )
            })}
          </div>
        )}
      </section>

      <PairTable
        title="Model Colours" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalModelColours as number[] | undefined) ?? []}
        dst={(draft.modifiedModelColours as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalModelColours', 'modifiedModelColours', i, w, v)}
        onAdd={() => addPair('originalModelColours', 'modifiedModelColours')}
        onRemove={(i) => removePair('originalModelColours', 'modifiedModelColours', i)}
      />
      <PairTable
        title="Model Textures" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalTextureIds as number[] | undefined) ?? []}
        dst={(draft.modifiedTextureIds as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalTextureIds', 'modifiedTextureIds', i, w, v)}
        onAdd={() => addPair('originalTextureIds', 'modifiedTextureIds')}
        onRemove={(i) => removePair('originalTextureIds', 'modifiedTextureIds', i)}
      />

      <section className="item-section">
        <h3>Stack Variants</h3>
        {hasStacks ? (
          <div className="quest-table-wrap item-pair-wrap">
            <table className="quest-table">
              <thead><tr><th>#</th><th>Item ID</th><th>Trigger Amount</th></tr></thead>
              <tbody>
                {Array.from({ length: 10 }, (_, i) => (
                  <tr key={i}>
                    <td className="item-stack-index">{i}</td>
                    <td><NumberInput className="cell-input" value={(draft.stackIds as number[])[i] ?? 0} onChange={(v) => setStack(i, 0,v)} /></td>
                    <td><NumberInput className="cell-input" value={(draft.stackTriggerAmount as number[] | undefined)?.[i] ?? 0} onChange={(v) => setStack(i, 1,v)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <button type="button" className="add-row-btn" onClick={() => setStack(0, 0, 0)}>+ Add stack variants</button>
        )}
      </section>

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
        <h3>Params (clientScriptData)</h3>
        <ParamsTable
          rows={paramRows}
          onSet={setParamRow}
          onAdd={() => { setParamRows((prev) => [...prev, { key: '', isString: false, value: '' }]); setIsDirty(true) }}
          onRemove={(i) => { setParamRows((prev) => prev.filter((_, idx) => idx !== i)); setIsDirty(true) }}
          rowAnnotation={(row) => {
            // Param 644 is the wielded render anim (BAS id) — the reason the
            // BAS viewer's "Items (weapon stance)" table lists this item.
            if (row.key !== RENDER_ANIM_PARAM || row.isString) return null
            const basId = parseInt(row.value, 10)
            return (
              <span className="param-row-note">
                Render Anim
                {onNavigate && !isNaN(basId) && basId >= 0 && (
                  <button type="button" className="field-link-btn" onClick={() => onNavigate('config_bas', basId)}>
                    View BAS
                  </button>
                )}
              </span>
            )
          }}
        />
      </section>

      <details className="item-unknown">
        <summary>Unknown fields</summary>
        <NumGrid fields={UNKNOWN_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
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
