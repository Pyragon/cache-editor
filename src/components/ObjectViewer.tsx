import { useEffect, useState } from 'react'
import type { ObjectData, ObjectDef } from '../loaders/objects'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { hslToRgb } from '../loaders/models'
import { objectCompositeSpec } from '../loaders/npcComposite'
import type { ModelCompositeSpec } from '../loaders/npcComposite'
import { getObjectIcon, peekObjectIcon } from './npcSnapshot'
import { CursorPreview, ModelSnapshotIcon, SpriteFramePreview } from './spriteCards'
import { SoundPlayerCell } from './SoundPlayerCell'
import { MenuPreview } from './MenuPreview'
import ModelPreviewModal from './ModelPreviewModal'
import { NumberInput, NumGrid, PairTable, ParamsTable, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'
import './ObjectViewer.css'

type Props = {
  data: ObjectData
  onSave: (data: ObjectData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
  /** Cache root for the icon, model/animation previews and sound players. */
  cacheRoot?: FileSystemDirectoryHandle | null
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

/** What the model preview modal is showing (null = closed). */
type ObjectModelPreview = {
  title: string
  modelIds: number[]
  recolor?: ModelCompositeSpec['recolor']
  scale?: ModelCompositeSpec['scale']
  tint?: ModelCompositeSpec['tint']
  sequenceId?: number
  sequenceOptions?: { label: string; seqId: number }[]
  openModelId?: number
}

/** Sprite card behind one level of indirection: mapSpriteId → map sprite
 *  def's spriteId, or mapCategoryId → the area's defaultIconArchive. */
function ResolvedSpriteCard({ cacheRoot, entryName, refId, resolve, label, onOpen }: {
  cacheRoot: FileSystemDirectoryHandle | null
  entryName: string
  refId: number
  resolve: (def: Record<string, unknown>) => { spriteId: number; suffix?: string } | null
  label: string
  onOpen?: () => void
}) {
  const [resolved, setResolved] = useState<{ spriteId: number; suffix?: string } | null>(null)
  const [spritesDir, setSpritesDir] = useState<FileSystemDirectoryHandle | null>(null)

  useEffect(() => {
    let cancelled = false
    setResolved(null)
    if (!cacheRoot || refId < 0) return
    ;(async () => {
      try {
        const [dir, sprites] = await Promise.all([
          resolveEntryHandle(cacheRoot, getEntryPath(entryName)),
          resolveEntryHandle(cacheRoot, getEntryPath('sprites')),
        ])
        if (!dir) return
        const file = await (await dir.getFileHandle(`${refId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as Record<string, unknown>
        if (cancelled) return
        setSpritesDir(sprites)
        setResolved(resolve(def))
      } catch { /* unresolvable — no preview */ }
    })()
    return () => { cancelled = true }
    // resolve is a stable inline fn per call site; refId/entry cover it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheRoot, entryName, refId])

  if (refId < 0 || !resolved || resolved.spriteId < 0) return null
  return (
    <SpriteFramePreview
      spritesDir={spritesDir}
      spriteId={resolved.spriteId}
      label={`${label}${resolved.suffix ? ` · ${resolved.suffix}` : ''}`}
      onOpen={onOpen && (() => onOpen())}
    />
  )
}

export default function ObjectViewer({ data, onSave, onDirtyChange, onNavigate, cacheRoot }: Props) {
  const [draft, setDraft] = useState<ObjectDef>(data.object)
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => toParamRows(data.object.parameters))
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [modelPreview, setModelPreview] = useState<ObjectModelPreview | null>(null)

  // Snapshot icon from the SAVED def (npcSnapshot.ts session cache).
  const [icon, setIcon] = useState<string | null>(peekObjectIcon(data.id) ?? null)
  useEffect(() => {
    setIcon(peekObjectIcon(data.id) ?? null)
    if (!cacheRoot) return
    let cancelled = false
    getObjectIcon(cacheRoot, data.id, data.object as Record<string, unknown>).then((url) => {
      if (!cancelled) setIcon(url)
    })
    return () => { cancelled = true }
  }, [data, cacheRoot])

  // Sprite/cursor preview cards need these entry folders.
  const [spritesDir, setSpritesDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [cursorsDir, setCursorsDir] = useState<FileSystemDirectoryHandle | null>(null)
  useEffect(() => {
    let cancelled = false
    setSpritesDir(null)
    setCursorsDir(null)
    if (!cacheRoot) return
    ;(async () => {
      const sprites = await resolveEntryHandle(cacheRoot, getEntryPath('sprites'))
      const cursors = await resolveEntryHandle(cacheRoot, getEntryPath('config_cursors'))
      if (!cancelled) {
        setSpritesDir(sprites)
        setCursorsDir(cursors)
      }
    })()
    return () => { cancelled = true }
  }, [cacheRoot])

  useEffect(() => {
    setDraft(data.object)
    setParamRows(toParamRows(data.object.parameters))
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
  const animations = (draft.animations as number[] | undefined) ?? []
  const animProbs = (draft.animProbs as number[] | undefined) ?? []
  const animVals = (draft.animVals as number[] | undefined) ?? []

  function setShape(index: number, shape: number) {
    const next = [...shapes]
    next[index] = shape
    set('shapes', next)
  }

  function setShapeModel(shapeIndex: number, modelIndex: number, value: number) {
    const next = objectModelIds.map((m, i) => {
      if (i !== shapeIndex) return m
      const models = [...(m ?? [])]
      models[modelIndex] = value
      return models
    })
    set('objectModelIds', next)
  }

  function addShapeModel(shapeIndex: number) {
    const next = objectModelIds.map((m, i) => (i === shapeIndex ? [...(m ?? []), 0] : m))
    set('objectModelIds', next)
  }

  function removeShapeModel(shapeIndex: number, modelIndex: number) {
    const next = objectModelIds.map((m, i) => (i === shapeIndex ? (m ?? []).filter((_, j) => j !== modelIndex) : m))
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

  // Preview one shape row's models as the composite the client would place —
  // recolours/scale/tint from the def, and the def's animations available in
  // the modal's emote-style dropdown (first one auto-plays).
  function previewShape(index: number) {
    const modelIds = objectModelIds[index] ?? []
    if (modelIds.length === 0) return
    const spec = objectCompositeSpec(draft as Record<string, unknown>)
    const sequenceOptions = animations
      .filter((a) => a >= 0)
      .map((a, i) => ({ label: `Anim ${a}${animProbs[i] != null ? ` · odds ${animProbs[i]}` : ''}`, seqId: a }))
    setModelPreview({
      title: `Object ${data.id} — shape ${shapes[index]}`,
      modelIds: [...modelIds],
      recolor: spec.recolor,
      scale: spec.scale,
      tint: spec.tint,
      sequenceId: sequenceOptions[0]?.seqId,
      sequenceOptions,
      openModelId: modelIds.length === 1 ? modelIds[0] : undefined,
    })
  }

  // --- animations (parallel arrays) ------------------------------------------

  function setAnimCell(key: 'animations' | 'animProbs' | 'animVals', index: number, value: number) {
    const arr = [...((draft[key] as number[] | undefined) ?? [])]
    arr[index] = value
    set(key, arr)
  }

  function addAnimation() {
    setDraft((prev) => ({
      ...prev,
      animations: [...animations, -1],
      animProbs: [...animProbs, 0],
      animVals: [...animVals, 0],
    }))
    setIsDirty(true)
  }

  function removeAnimation(index: number) {
    setDraft((prev) => {
      const next = { ...prev }
      const a = animations.filter((_, i) => i !== index)
      const p = animProbs.filter((_, i) => i !== index)
      const v = animVals.filter((_, i) => i !== index)
      if (a.length === 0) {
        delete next.animations
        delete next.animProbs
        delete next.animVals
      } else {
        next.animations = a
        next.animProbs = p
        next.animVals = v
      }
      return next
    })
    setIsDirty(true)
  }

  // --- transformTo / soundGroupIds / quests -----------------------------------

  const transformTo = (draft.transformTo as number[] | undefined) ?? []
  const soundGroupIds = (draft.soundGroupIds as number[] | undefined) ?? []
  const quests = (draft.quests as number[] | undefined) ?? []

  function setListValue(key: string, index: number, value: number) {
    const arr = [...((draft[key] as number[] | undefined) ?? [])]
    arr[index] = value
    set(key, arr)
  }

  function removeListValue(key: string, index: number) {
    const arr = ((draft[key] as number[] | undefined) ?? []).filter((_, i) => i !== index)
    set(key, arr.length === 0 ? undefined : arr)
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
    setIsDirty(false)
  }

  // Object menu entries carry the name in cyan (MiniMenuBuilder loc path,
  // TextUtils.setTextColor(65535)) and no level.
  const menuTarget = `<col=00ffff>${String(draft.name ?? 'null') || 'null'}`
  const menuRows = [
    ...((draft.options ?? []).filter((o): o is string => o != null && o.length > 0)
      .map((o) => `${o} ${menuTarget}`)),
    'Walk here',
    `Examine ${menuTarget}`,
    'Cancel',
  ]

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          {icon && <img className="npc-header-icon" src={icon} alt="" title="Snapshot of the shape-10 composite" />}
          <input
            className="quest-name-input"
            value={String(draft.name ?? '')}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Shapes &amp; Models</h3>
        {shapes.length > 0 && (
          <div className="quest-table-wrap object-shapes-wrap">
            <table className="quest-table">
              <thead><tr><th>Shape</th><th>Models</th><th></th></tr></thead>
              <tbody>
                {shapes.map((shape, i) => (
                  <tr key={i}>
                    <td style={{ width: 90 }}>
                      <NumberInput className="cell-input" value={shape} onChange={(v) => setShape(i, v)} />
                    </td>
                    <td>
                      <span className="object-model-chips">
                        {(objectModelIds[i] ?? []).map((modelId, j) => (
                          <span key={j} className="object-model-chip">
                            <ModelSnapshotIcon cacheRoot={cacheRoot ?? null} modelId={modelId} />
                            <NumberInput className="cell-input" value={modelId} onChange={(v) => setShapeModel(i, j, v)} />
                            <button type="button" className="row-remove-btn" title="Remove this model" onClick={() => removeShapeModel(i, j)}>×</button>
                          </span>
                        ))}
                        <button type="button" className="field-link-btn" title="Add a model to this shape" onClick={() => addShapeModel(i)}>+</button>
                      </span>
                    </td>
                    <td>
                      <span className="anim-fit-actions">
                        {cacheRoot && (objectModelIds[i] ?? []).length > 0 && (
                          <button type="button" className="field-link-btn" title="Preview this shape's composite (recolours/scale/tint applied; animations playable)" onClick={() => previewShape(i)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this shape row" onClick={() => removeShape(i)}>×</button>
                      </span>
                    </td>
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
        {cacheRoot && (
          <div className="npc-menu-preview">
            <MenuPreview cacheRoot={cacheRoot} rows={menuRows} />
          </div>
        )}
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
        <NumGrid
          fields={MAP_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{
            mapSpriteId: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('config_map_sprites', id) },
            mapCategoryId: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('config_map_areas', id) },
          }}
        />
        {(Number(draft.mapSpriteId ?? -1) >= 0 || Number(draft.mapCategoryId ?? -1) >= 0) && (
          <div className="item-cursor-row">
            <ResolvedSpriteCard
              cacheRoot={cacheRoot ?? null}
              entryName="config_map_sprites"
              refId={Number(draft.mapSpriteId ?? -1)}
              resolve={(def) => ({ spriteId: Number(def.spriteId ?? -1) })}
              label={`Map sprite ${draft.mapSpriteId}`}
              onOpen={onNavigate && (() => onNavigate('config_map_sprites', Number(draft.mapSpriteId)))}
            />
            <ResolvedSpriteCard
              cacheRoot={cacheRoot ?? null}
              entryName="config_map_areas"
              refId={Number(draft.mapCategoryId ?? -1)}
              resolve={(def) => ({
                spriteId: Number(def.defaultIconArchive ?? -1),
                suffix: typeof def.areaName === 'string' && def.areaName ? def.areaName : undefined,
              })}
              label={`Map icon ${draft.mapCategoryId}`}
              onOpen={onNavigate && (() => onNavigate('config_map_areas', Number(draft.mapCategoryId)))}
            />
          </div>
        )}
      </section>

      <section className="item-section">
        <h3>Cursors</h3>
        <NumGrid
          fields={CURSOR_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{
            primaryCursor: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('config_cursors', id) },
            secondaryCursor: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('config_cursors', id) },
          }}
        />
        {(['primaryCursor', 'secondaryCursor'] as const).some((key) => Number(draft[key] ?? -1) >= 0) && (
          <div className="item-cursor-row">
            {([['primaryCursor', 'primaryCursorActionIndex', 'Primary'], ['secondaryCursor', 'secondaryCursorActionIndex', 'Secondary']] as const).map(([key, opKey, label]) => {
              // the cursor applies to the option its action index points at
              const option = (draft.options ?? [])[Number(draft[opKey] ?? -1)]
              return (
                <CursorPreview
                  key={key}
                  cursorsDir={cursorsDir}
                  spritesDir={spritesDir}
                  cursorId={Number(draft[key] ?? -1)}
                  label={option ? `${label} · ${option}` : label}
                  onOpen={onNavigate && ((id) => onNavigate('config_cursors', id))}
                />
              )
            })}
          </div>
        )}
      </section>

      <section className="item-section">
        <h3>Sound</h3>
        <NumGrid
          fields={SOUND_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{ ambientSoundId: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('sound_effects', id) } }}
          fieldExtra={cacheRoot ? {
            ambientSoundId: Number(draft.ambientSoundId ?? -1) >= 0
              ? <SoundPlayerCell key="ambientSoundId" cacheRoot={cacheRoot} soundId={Number(draft.ambientSoundId)} />
              : undefined,
          } : undefined}
        />
        <h4 className="anim-fit-subhead">Sound Group</h4>
        <p className="tex-op-note">Random ambient pool — the client picks one of these each interval instead of a fixed ambient sound.</p>
        {soundGroupIds.length > 0 && (
          <div className="quest-table-wrap npc-headmodels-wrap">
            <table className="quest-table">
              <thead><tr><th>Sound</th><th>Preview</th><th></th></tr></thead>
              <tbody>
                {soundGroupIds.map((soundId, i) => (
                  <tr key={i}>
                    <td><NumberInput className="cell-input" value={soundId} onChange={(v) => setListValue('soundGroupIds', i, v)} /></td>
                    <td>
                      {cacheRoot && soundId >= 0 && <SoundPlayerCell cacheRoot={cacheRoot} soundId={soundId} />}
                    </td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && soundId >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open sound effect ${soundId}`} onClick={() => onNavigate('sound_effects', soundId)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this sound" onClick={() => removeListValue('soundGroupIds', i)}>×</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={() => set('soundGroupIds', [...soundGroupIds, 0])}>+ Add sound</button>
      </section>

      <section className="item-section">
        <h3>Tint</h3>
        <NumGrid fields={TINT_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Shadow</h3>
        <NumGrid fields={SHADOW_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section npc-var-transforms">
        <h3>Var Transforms</h3>
        <NumGrid
          fields={VAR_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{
            varp: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('config_vars', id) },
            varpBit: onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('varbits', id) },
          }}
        />
        {/* Positional: transformTo[var value] = the object shown for that
            value (the last slot is the client's out-of-range fallback). */}
        {transformTo.length > 0 && (
          <div className="quest-table-wrap npc-headmodels-wrap">
            <table className="quest-table">
              <thead><tr><th>Var Value</th><th>Object</th><th></th></tr></thead>
              <tbody>
                {transformTo.map((objectId, i) => (
                  <tr key={i}>
                    <td className="bas-slot-label">{i === transformTo.length - 1 ? `${i} / fallback` : i}</td>
                    <td><NumberInput className="cell-input" value={objectId} min={-1} onChange={(v) => setListValue('transformTo', i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && objectId >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open object ${objectId}`} onClick={() => onNavigate('objects', objectId)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this slot (later var values shift down)" onClick={() => removeListValue('transformTo', i)}>×</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={() => set('transformTo', [...transformTo, -1])}>+ Add transform</button>
      </section>

      <section className="item-section npc-var-transforms">
        <h3>Animations</h3>
        {animations.length > 0 && (
          <div className="quest-table-wrap npc-headmodels-wrap">
            <table className="quest-table">
              <thead><tr><th>Animation</th><th>Odds (norm)</th><th>Odds (raw)</th><th></th></tr></thead>
              <tbody>
                {animations.map((animId, i) => (
                  <tr key={i}>
                    <td><NumberInput className="cell-input" value={animId} min={-1} onChange={(v) => setAnimCell('animations', i, v)} /></td>
                    <td><NumberInput className="cell-input" value={animProbs[i] ?? 0} onChange={(v) => setAnimCell('animProbs', i, v)} /></td>
                    <td><NumberInput className="cell-input" value={animVals[i] ?? 0} onChange={(v) => setAnimCell('animVals', i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && animId >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open animation ${animId}`} onClick={() => onNavigate('animations', animId)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this animation" onClick={() => removeAnimation(i)}>×</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={addAnimation}>+ Add animation</button>
      </section>

      <PairTable
        title="Colours" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalColors as number[] | undefined) ?? []}
        dst={(draft.modifiedColors as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalColors', 'modifiedColors', i, w, v)}
        onAdd={() => addPair('originalColors', 'modifiedColors')}
        onRemove={(i) => removePair('originalColors', 'modifiedColors', i)}
        // live swatch of the HSL16 the id encodes, tracking edits
        cellExtra={(v) => (
          <span
            className="pair-swatch"
            title={`HSL16 ${v & 0xffff}`}
            style={{ background: `#${hslToRgb(v & 0xffff).toString(16).padStart(6, '0')}` }}
          />
        )}
      />
      <PairTable
        title="Textures" srcLabel="Original" dstLabel="Modified"
        src={(draft.originalTextures as number[] | undefined) ?? []}
        dst={(draft.modifiedTextures as number[] | undefined) ?? []}
        onSet={(i, w, v) => setPair('originalTextures', 'modifiedTextures', i, w, v)}
        onAdd={() => addPair('originalTextures', 'modifiedTextures')}
        onRemove={(i) => removePair('originalTextures', 'modifiedTextures', i)}
        cellExtra={onNavigate && ((v) => v >= 0 && (
          <button type="button" className="field-link-btn" title={`Open texture ${v}`} onClick={() => onNavigate('textures', v)}>
            View
          </button>
        ))}
      />

      <section className="item-section">
        <h3>Quests</h3>
        {quests.length > 0 && (
          <div className="quest-table-wrap npc-quests-wrap">
            <table className="quest-table">
              <thead><tr><th>Quest</th><th></th></tr></thead>
              <tbody>
                {quests.map((id, i) => (
                  <tr key={i}>
                    <td><NumberInput className="cell-input" value={id} onChange={(v) => setListValue('quests', i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && id >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open quest ${id}`} onClick={() => onNavigate('config_quests', id)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this quest" onClick={() => removeListValue('quests', i)}>×</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={() => set('quests', [...quests, 0])}>+ Add quest</button>
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

      {modelPreview && cacheRoot && (
        <ModelPreviewModal
          title={modelPreview.title}
          modelIds={modelPreview.modelIds}
          recolor={modelPreview.recolor}
          scale={modelPreview.scale}
          tint={modelPreview.tint}
          hideMarkerFaces
          sequenceId={modelPreview.sequenceId}
          sequenceOptions={modelPreview.sequenceOptions}
          rootHandle={cacheRoot}
          openLabel={modelPreview.openModelId != null ? 'Open in Models' : undefined}
          onOpen={modelPreview.openModelId != null
            ? () => { setModelPreview(null); onNavigate?.('models', modelPreview.openModelId!) }
            : undefined}
          onOpenModelId={onNavigate && ((id) => { setModelPreview(null); onNavigate('models', id) })}
          onClose={() => setModelPreview(null)}
        />
      )}

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
