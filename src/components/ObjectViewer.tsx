import { useEffect, useState } from 'react'
import type { ObjectData, ObjectDef } from '../loaders/objects'
import { NumberInput, IntListInput, NumGrid, PairTable, ParamsTable, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'
import './ObjectViewer.css'

type Props = {
  data: ObjectData
  onSave: (data: ObjectData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['sizeX', 'Size X'],
  ['sizeY', 'Size Y'],
  ['clipType', 'Clip Type'],
  ['interactable', 'Interactable'],
  ['supportsItems', 'Supports Items'],
  ['decorDisplacement', 'Decor Displacement'],
  ['occludes', 'Occludes'],
  ['accessBlockFlag', 'Access Block Flag'],
  ['ambient', 'Ambient'],
  ['contrast', 'Contrast'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['blocks', 'Blocks'],
  ['obstructsGround', 'Obstructs Ground'],
  ['ignoreClipOnAltRoute', 'Ignore Clip (Alt Route)'],
  ['members', 'Members'],
  ['delayShading', 'Delay Shading'],
  ['inverted', 'Inverted'],
  ['staticShadow', 'Static Shadow'],
  ['dynamicShadow', 'Dynamic Shadow'],
  ['replaySequence', 'Replay Sequence'],
  ['requiresTextures', 'Requires Textures'],
  ['hasAnimation', 'Has Animation'],
  ['adjustMapSceneRotation', 'Map Scene Rotates'],
  ['flipMapSprite', 'Flip Map Sprite'],
  ['instrumentSoundEffect', 'Instrument Sound FX'],
  ['instrumentAmbientSound', 'Instrument Ambient'],
  ['transforms', 'Transforms'],
  ['dynamicTint', 'Dynamic Tint'],
]

const TRANSFORM_FIELDS: NumFieldDef[] = [
  ['scaleX', 'Scale X'],
  ['scaleY', 'Scale Y'],
  ['scaleZ', 'Scale Z'],
  ['offsetX', 'Offset X'],
  ['offsetY', 'Offset Y'],
  ['offsetZ', 'Offset Z'],
]

const CONTOUR_FIELDS: NumFieldDef[] = [
  ['groundContourType', 'Contour Type'],
  ['groundContourModifier', 'Contour Modifier'],
  ['groundDecorationHeight', 'Decoration Height'],
  ['cullY', 'Cull Y'],
  ['cullXZ', 'Cull XZ'],
]

const MAP_FIELDS: NumFieldDef[] = [
  ['mapSpriteId', 'Map Sprite ID'],
  ['mapSpriteRotation', 'Map Sprite Rotation'],
  ['mapCategoryId', 'Map Category ID'],
]

const CURSOR_FIELDS: NumFieldDef[] = [
  ['primaryCursorActionIndex', 'Primary Op'],
  ['primaryCursor', 'Primary Cursor'],
  ['secondaryCursorActionIndex', 'Secondary Op'],
  ['secondaryCursor', 'Secondary Cursor'],
]

const SOUND_FIELDS: NumFieldDef[] = [
  ['ambientSoundId', 'Ambient Sound ID'],
  ['ambientSoundVolume', 'Volume'],
  ['ambientSoundHearDistance', 'Hear Distance'],
  ['ambientSoundMaxHearDistance', 'Max Hear Distance'],
  ['soundMinInterval', 'Min Interval'],
  ['soundMaxInterval', 'Max Interval'],
  ['ambientSoundMinDelay', 'Min Delay'],
  ['ambientSoundMaxDelay', 'Max Delay'],
]

const TINT_FIELDS: NumFieldDef[] = [
  ['tintHue', 'Hue'],
  ['tintSaturation', 'Saturation'],
  ['tintLightness', 'Lightness'],
  ['tintOpacity', 'Opacity'],
]

const SHADOW_FIELDS: NumFieldDef[] = [
  ['shadowOffsetX', 'Shadow Offset X'],
  ['shadowOffsetY', 'Shadow Offset Y'],
  ['shadowOffsetZ', 'Shadow Offset Z'],
]

const VAR_FIELDS: NumFieldDef[] = [
  ['varp', 'Varp'],
  ['varpBit', 'Varbit'],
]

export default function ObjectViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<ObjectDef>(data.object)
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => toParamRows(data.object.parameters))
  const [newQuestId, setNewQuestId] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.object)
    setParamRows(toParamRows(data.object.parameters))
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

  function setOption(index: number, value: string) {
    const arr = [...(draft.options ?? [null, null, null, null, null])]
    arr[index] = value === '' ? null : value
    set('options', arr)
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

  // --- shapes / models ------------------------------------------------------

  const shapes = (draft.shapes as number[] | undefined) ?? []
  const objectModelIds = (draft.objectModelIds as number[][] | undefined) ?? []

  function setShape(index: number, shape: number) {
    const next = [...shapes]
    next[index] = shape
    set('shapes', next)
  }

  function setShapeModels(index: number, models: number[] | undefined) {
    const next = objectModelIds.map((m, i) => (i === index ? (models ?? []) : m))
    set('objectModelIds', next)
  }

  function addShape() {
    setDraft((prev) => ({
      ...prev,
      shapes: [...shapes, 10],
      objectModelIds: [...objectModelIds, []],
    }))
    setIsDirty(true)
  }

  function removeShape(index: number) {
    setDraft((prev) => {
      const next = { ...prev }
      const s = shapes.filter((_, i) => i !== index)
      const m = objectModelIds.filter((_, i) => i !== index)
      if (s.length === 0) {
        delete next.shapes
        delete next.objectModelIds
      } else {
        next.shapes = s
        next.objectModelIds = m
      }
      return next
    })
    setIsDirty(true)
  }

  // --- quests ----------------------------------------------------------------

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
    const next: ObjectDef = { ...draft }
    const params = paramRowsToRecord(paramRows)
    if (params) next.parameters = params
    else delete next.parameters

    setIsSaving(true)
    await onSave({ ...data, object: next })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.object)
    setParamRows(toParamRows(data.object.parameters))
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
        </div>
      </div>

      <section className="item-section">
        <h3>Shapes &amp; Models</h3>
        {shapes.length > 0 && (
          <div className="quest-table-wrap object-shapes-wrap">
            <table className="quest-table">
              <thead><tr><th>Shape</th><th>Model IDs</th><th>Remove</th></tr></thead>
              <tbody>
                {shapes.map((shape, i) => (
                  <tr key={i}>
                    <td style={{ width: 90 }}>
                      <NumberInput className="cell-input" value={shape} onChange={(v) => setShape(i,v)} />
                    </td>
                    <td>
                      <IntListInput
                        value={objectModelIds[i] ?? []}
                        onChange={(models) => setShapeModels(i, models)}
                        placeholder="model ids, comma-separated"
                      />
                    </td>
                    <td><button type="button" className="row-remove-btn" onClick={() => removeShape(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={addShape}>+ Add shape</button>
      </section>

      <section className="item-section">
        <h3>Options</h3>
        <div className="item-option-row">
          {Array.from({ length: 5 }, (_, i) => (
            <input
              key={i}
              className="item-option-input"
              type="text"
              placeholder="—"
              value={(draft.options?.[i] ?? '') as string}
              onChange={(e) => setOption(i, e.target.value)}
            />
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
        <h3>Scale &amp; Offset</h3>
        <NumGrid fields={TRANSFORM_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Ground Contour</h3>
        <NumGrid fields={CONTOUR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Map</h3>
        <NumGrid fields={MAP_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Cursors</h3>
        <NumGrid fields={CURSOR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Sound</h3>
        <NumGrid fields={SOUND_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
        <div className="object-int-list-row">
          <span className="item-field-label">Sound Group IDs</span>
          <IntListInput
            value={(draft.soundGroupIds as number[] | undefined)}
            onChange={(v) => set('soundGroupIds', v)}
            placeholder="sound ids, comma-separated"
          />
        </div>
      </section>

      <section className="item-section">
        <h3>Tint</h3>
        <NumGrid fields={TINT_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Shadow</h3>
        <NumGrid fields={SHADOW_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Var Transforms</h3>
        <NumGrid fields={VAR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
        <div className="object-int-list-row">
          <span className="item-field-label">Transform To</span>
          <IntListInput
            value={(draft.transformTo as number[] | undefined)}
            onChange={(v) => set('transformTo', v)}
            placeholder="object ids, comma-separated (-1 = none)"
          />
        </div>
      </section>

      <section className="item-section">
        <h3>Animations</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Animation IDs</span>
          <IntListInput
            value={(draft.animations as number[] | undefined)}
            onChange={(v) => set('animations', v)}
            placeholder="animation ids, comma-separated"
          />
        </div>
        <div className="object-int-list-row">
          <span className="item-field-label">Anim Odds (normalized)</span>
          <IntListInput
            value={(draft.animProbs as number[] | undefined)}
            onChange={(v) => set('animProbs', v)}
            placeholder="probabilities"
          />
        </div>
        <div className="object-int-list-row">
          <span className="item-field-label">Anim Odds (raw)</span>
          <IntListInput
            value={(draft.animVals as number[] | undefined)}
            onChange={(v) => set('animVals', v)}
            placeholder="raw byte weights"
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
