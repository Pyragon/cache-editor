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

// Field descriptions. The non-obvious ones are traced against
// darkan-bot-refactor's ObjectType.kt (the authoritative decoder) and its
// consumers in SceneGraph/MapLoader rather than guessed — where cryogen's
// dumped name disagrees with what the client actually does, the tooltip says
// so instead of quietly repeating the wrong name.
const GENERAL_FIELDS: NumFieldDef[] = [
  ['sizeX', 'Size X', 'Opcode 14. Footprint width in tiles. Swapped with Size Y when the placement rotation is odd.'],
  ['sizeY', 'Size Y', 'Opcode 15. Footprint depth in tiles. Swapped with Size X when the placement rotation is odd.'],
  ['clipType', 'Clip Type', "Opcodes 17 and 27 — darkan's blocksMovement. 2 (default) blocks walking, 1 blocks but still draws ground decoration under it, 0 doesn't block at all. Also the fallback that decides Supports Items."],
  ['interactable', 'Interactable', "Opcode 19 — darkan's hasActions: does this object give a right-click menu? -1 means unset, and the client resolves it after decoding (an object with a real name or any option becomes 1)."],
  ['supportsItems', 'Supports Items', 'Opcode 75. Whether dropped ground items sit ON TOP of this object instead of on the floor — tables, counters, altars. 1 = yes. Left unset it defaults from Clip Type (anything that blocks supports items).'],
  ['decorDisplacement', 'Decor Displacement', 'Opcode 28, stored <<2, default 64. How far a wall DECORATION mounted on this wall is pushed out from it — the gap between a torch or a sign and the wall behind it.'],
  ['occludes', 'Occludes', "Opcodes 23 and 103 — darkan's occlusionMode. Whether the object hides what's behind it for visibility culling. -1 = unset, 1 = occludes, 0 = never."],
  ['accessBlockFlag', 'Access Block Flag', "Opcode 69, a per-side bitmask (cryogen's name — darkan's decoder reads the byte and throws it away, so its exact effect is unverified here)."],
  ['ambient', 'Ambient', 'Opcode 29, signed. Brightens or darkens the whole model at bake time: base lightness is scaled by (64 + ambient)/128, so 0 is neutral and negatives darken.'],
  ['contrast', 'Contrast', 'Opcode 39, stored x5 by the client at decode (cryogen keeps the raw byte). Flattens or sharpens the directional shading — the light term is divided by (850 + contrast*5)/768, so higher values mean less contrast.'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['blocks', 'Blocks Projectiles', "Opcodes 17 and 18 — darkan's blocksProjectiles. Whether arrows and spells are stopped by this object, which is separate from whether you can walk through it (that's Clip Type)."],
  ['obstructsGround', 'Force Show Decoration', "Opcode 73 — darkan calls this forceDisplayDecoration, and cryogen's \"obstructsGround\" is a misnomer. It forces a ground decoration to draw even when the player has ground decorations turned off (SceneGraph checks it alongside hasActions and blocksMovement)."],
  ['ignoreClipOnAltRoute', 'Ignore Clip (Alt Route)', 'Opcode 74. Lets path-finding route through this object when taking an alternative route.'],
  ['members', 'Members', 'Opcode 79 era flag — the object only appears on members worlds.'],
  ['delayShading', 'Delay Shading', 'Opcode 22. Defers the object\'s shading pass; set on walls whose lighting is resolved later.'],
  ['inverted', 'Inverted', 'Opcode 62. Mirrors the model. The client also forces this on for whole-corner wall shapes rotated past 3.'],
  ['staticShadow', 'Static Shadow', 'Whether the object drops the cheap baked shadow onto the tile beneath it — always placed the same way, unlike the sun-following one.'],
  ['dynamicShadow', 'Dynamic Shadow', 'Opcode 88 clears this. Whether the object casts the GPU sun-following shadow.'],
  ['replaySequence', 'Replay Sequence', 'Opcode 89 clears this. Whether the idle animation loops; off means it plays once and stops.'],
  ['requiresTextures', 'Requires Textures', 'Opcode 82. The object is only drawn when the client is running with textures enabled.'],
  ['hasAnimation', 'Force Non-Stationary', "Opcode 98 — despite cryogen's name it does NOT mean \"this object has an idle animation\"; that comes from the Animations list below (opcodes 24/106), which the client reads separately. This is an extra way to force the object out of the static scene batch. SceneGraph treats a placement as stationary only when it has no sequence AND no animation list AND no Transform To list AND neither this flag nor Transforms — so any one of them is enough, and an object that already animates leaves this false."],
  ['adjustMapSceneRotation', 'Map Scene Rotates', "Whether the object's map-scene icon turns with the placement rotation instead of staying upright."],
  ['flipMapSprite', 'Flip Map Sprite', 'Mirrors the minimap sprite horizontally.'],
  ['instrumentSoundEffect', 'Instrument Sound FX', 'The ambient sound is played through the MIDI instrument path rather than as a plain sound effect.'],
  ['instrumentAmbientSound', 'Instrument Ambient', 'As above, for the looping ambient sound.'],
  ['transforms', 'Transforms', 'Opcode 177. Like the flag above, a marker that keeps the object out of the static scene batch. The client also derives it at load time from an animation list or a Transform To list, so a stored true is only needed when the object has neither.'],
  ['dynamicTint', 'Dynamic Tint', "Opcode 189. The object takes the current scene's tint (the Tint section below) instead of rendering with its own colours."],
]

const TRANSFORM_FIELDS: NumFieldDef[] = [
  ['scaleX', 'Scale X', 'Opcode 65, 128 = 1x. Model scale along X before placement.'],
  ['scaleY', 'Scale Y', 'Opcode 66, 128 = 1x. Vertical model scale.'],
  ['scaleZ', 'Scale Z', 'Opcode 67, 128 = 1x. Model scale along Z.'],
  ['offsetX', 'Offset X', 'Opcode 70, stored <<2. Shifts the model off its tile centre along X.'],
  ['offsetY', 'Offset Y', 'Opcode 71, stored <<2. Raises or lowers the model — RS Y is negative-up, so a negative value lifts it.'],
  ['offsetZ', 'Offset Z', 'Opcode 72, stored <<2. Shifts the model off its tile centre along Z.'],
]

const CONTOUR_FIELDS: NumFieldDef[] = [
  ['groundContourType', 'Contour Type', 'How the model is bent to follow sloping ground (contourToGround). 0 = none, 1 = follow the tile heights, 2/3/4/5 = the variants set by opcodes 81/82-ish/94/96 — bridges, paths and ramps need one of these or they float and clip.'],
  ['groundContourModifier', 'Contour Modifier', 'The parameter for the contour type above (a height, an angle or a target level depending on the type). The client ignores contouring entirely when this is 16384 or more.'],
  ['groundDecorationHeight', 'Decoration Height', 'Height offset applied to ground-decoration placements of this object.'],
  ['cullY', 'Cull Y', 'Opcode 170, default 960. Vertical extent used for visibility culling — how tall the client assumes this object is.'],
  ['cullXZ', 'Cull XZ', 'Opcode 171, default 0. Horizontal extent used for visibility culling.'],
]

const MAP_FIELDS: NumFieldDef[] = [
  ['mapSpriteId', 'Map Sprite ID', 'The minimap sprite drawn for this object (a config/map_sprites id), or -1 for none.'],
  ['mapSpriteRotation', 'Map Sprite Rotation', 'Rotation applied to that minimap sprite.'],
  ['mapCategoryId', 'Map Category ID', 'The world-map category this object belongs to (config/areas), which decides its world-map icon and label. -1 = none.'],
]

const CURSOR_FIELDS: NumFieldDef[] = [
  ['primaryCursorActionIndex', 'Primary Op', 'Which right-click option (0-4, matching the Options boxes) uses the primary cursor below. -1 = none.'],
  ['primaryCursor', 'Primary Cursor', 'The config/cursors id shown when hovering for that option — the magnifying glass, the ladder, the door hand.'],
  ['secondaryCursorActionIndex', 'Secondary Op', 'A second option index that gets its own cursor. -1 = none.'],
  ['secondaryCursor', 'Secondary Cursor', 'The config/cursors id for that second option.'],
]

const SOUND_FIELDS: NumFieldDef[] = [
  ['ambientSoundId', 'Ambient Sound ID', 'The looping sound this object emits into the world — a fire crackling, a wheel turning. -1 = silent.'],
  ['ambientSoundVolume', 'Volume', 'Playback volume for that ambient sound.'],
  ['ambientSoundHearDistance', 'Hear Distance', 'Tile radius within which the sound plays at full volume.'],
  ['ambientSoundMaxHearDistance', 'Max Hear Distance', 'Tile radius at which the sound fades out entirely. (darkan flags its own decode of this one as unconfirmed.)'],
  ['soundMinInterval', 'Min Interval', 'Shortest gap between repeats when the object picks randomly from its sound list.'],
  ['soundMaxInterval', 'Max Interval', 'Longest gap between those repeats.'],
  ['ambientSoundMinDelay', 'Min Delay', 'Shortest delay before the ambient loop restarts, default 256.'],
  ['ambientSoundMaxDelay', 'Max Delay', 'Longest delay before it restarts, default 256.'],
]

const TINT_FIELDS: NumFieldDef[] = [
  ['tintHue', 'Hue', 'Scene tint applied to the whole model when Dynamic Tint is on — hue component.'],
  ['tintSaturation', 'Saturation', 'Saturation component of that tint.'],
  ['tintLightness', 'Lightness', 'Lightness component of that tint.'],
  ['tintOpacity', 'Opacity', 'How strongly the tint is mixed in; 0 leaves the model untinted.'],
]

const SHADOW_FIELDS: NumFieldDef[] = [
  ['shadowOffsetX', 'Shadow Offset X', 'Shifts the baked shadow off the model along X.'],
  ['shadowOffsetY', 'Shadow Offset Y', 'Vertical shadow offset. A non-zero value also forces the client down its ground-contour path.'],
  ['shadowOffsetZ', 'Shadow Offset Z', 'Shifts the baked shadow off the model along Z.'],
]

const VAR_FIELDS: NumFieldDef[] = [
  ['varp', 'Varp', "Opcodes 77/92 — the player variable whose value picks which entry of Transform To is shown. -1 = none."],
  ['varpBit', 'Varbit', 'Opcodes 77/92 — the varbit (a packed slice of a varp) used for the same job, and checked first. -1 = none.'],
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
