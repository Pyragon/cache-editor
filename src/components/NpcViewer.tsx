import { useEffect, useState } from 'react'
import type { NpcData, NpcDef } from '../loaders/npcs'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { hslToRgb } from '../loaders/models'
import { npcCompositeSpec } from '../loaders/npcComposite'
import { getNpcIcon, peekNpcIcon } from './npcSnapshot'
import { CursorPreview, ModelSnapshotIcon, SpriteFramePreview } from './spriteCards'
import { NpcMenuPreview } from './NpcMenuPreview'
import { SoundPlayerCell } from './SoundPlayerCell'
import ModelPreviewModal from './ModelPreviewModal'
import ChatheadPreviewModal from './ChatheadPreviewModal'
import { NumberInput, NumGrid, PairTable, ParamsTable, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'

type Props = {
  data: NpcData
  onSave: (data: NpcData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
  /** Cache root for the model preview modals (part + full-NPC views). */
  cacheRoot?: FileSystemDirectoryHandle | null
}

/** What the model preview modal is currently showing (null = closed). */
type NpcModelPreview = {
  title: string
  modelIds: number[]
  translations?: (number[] | null)[]
  recolor?: { from?: number[]; to?: number[]; textureFrom?: number[]; textureTo?: number[] }
  scale?: { xz: number; y: number }
  tint?: { hue: number; saturation: number; lightness: number; opacity: number }
  /** Hide skin-255 static marker faces (full-model view). */
  hideMarkerFaces?: boolean
  /** Sequence to auto-play (the BAS's stand animation, full-model view). */
  sequenceId?: number
  /** The BAS's emotes for the modal's playback dropdown. */
  sequenceOptions?: { label: string; seqId: number }[]
  /** Set for single-part previews: the modal's "Open in Models" target. */
  openModelId?: number
}

// Every named BAS sequence field, labeled for the emote dropdown (same
// movement matrix the BAS viewer shows; dirs per PathingEntity.kt's bands).
const BAS_EMOTE_FIELDS: [key: string, label: string][] = [
  ['standAnimation', 'Stand'],
  ['standTurnCcwSequence', 'Stand turn CCW'],
  ['standTurnCwSequence', 'Stand turn CW'],
  ['walkAnimation', 'Walk'],
  ['walkDir1', 'Walk side 90°'],
  ['walkDir3', 'Walk backwards'],
  ['walkDir2', 'Walk side 270°'],
  ['walkTurnCcwSequence', 'Walk turn CCW'],
  ['walkTurnCwSequence', 'Walk turn CW'],
  ['runningAnimation', 'Run'],
  ['runDir1', 'Run side 90°'],
  ['runDir3', 'Run backwards'],
  ['runDir2', 'Run side 270°'],
  ['runTurnCcwSequence', 'Run turn CCW'],
  ['runTurnCwSequence', 'Run turn CW'],
  ['teleportingAnimation', 'Teleport'],
  ['teleDir1', 'Teleport side 90°'],
  ['teleDir3', 'Teleport backwards'],
  ['teleDir2', 'Teleport side 270°'],
  ['teleTurnCcwSequence', 'Teleport turn CCW'],
  ['teleTurnCwSequence', 'Teleport turn CW'],
]

// The "headicons_prayer" sprite group. The client resolves it by name hash
// at runtime (darkan StaticMedia.loadGroupIds); the dump carries no names,
// so this is the rev-727 group id — verified by eye: 30 frames at 25×25,
// frame 0 the protect-melee sword (439 next door is headicons_pk's skulls).
// An NPC's headIcons value is a FRAME index into this group, not a sprite id.
const HEADICONS_PRAYER_SPRITE = 440

// headIcons is dumped as an unsigned short; 65535 is the encoded -1 "none".
const HEAD_ICON_NONE = 65535

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

// The four sound fields holding sound_effects ids (index 4) — they get the
// View jump link and the inline mini-player.
const SOUND_ID_KEYS = ['walkingSoundEffect', 'runningSoundEffect', 'idleSoundEffect', 'teleportSoundEffect'] as const

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

// cryogen NPCDefinitions.MovementType (opcode-driven; absent = unset)
const MOVEMENT_TYPES = ['STATIONARY', 'HALF_WALK', 'WALKING', 'RUNNING']

// Combat-bonus params — cryogen derives the dumped `bonuses`/`strBonuses`
// arrays from these at load (NPCDefinitions.getBonus): 0-4 attack, 5-9
// defence, 641/643/965 strength values stored ×10, 14 attack speed.
const NPC_PARAM_LABELS: Record<string, string> = {
  '0': 'Stab Atk',
  '1': 'Slash Atk',
  '2': 'Crush Atk',
  '3': 'Magic Atk',
  '4': 'Range Atk',
  '5': 'Stab Def',
  '6': 'Slash Def',
  '7': 'Crush Def',
  '8': 'Magic Def',
  '9': 'Range Def',
  '14': 'Attack Speed',
  '641': 'Melee Str ×10',
  '643': 'Range Str ×10',
  '965': 'Magic Dmg ×10',
}

export default function NpcViewer({ data, onSave, onDirtyChange, onNavigate, cacheRoot }: Props) {
  const [draft, setDraft] = useState<NpcDef>(data.npc)
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => toParamRows(data.npc.parameters))
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.npc)
    setParamRows(toParamRows(data.npc.parameters))
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
  const [modelPreview, setModelPreview] = useState<NpcModelPreview | null>(null)
  // In-game dialogue (interface 1184) preview of the merged head models.
  const [chatheadPreview, setChatheadPreview] = useState<number[] | null>(null)

  // Snapshot icon: rendered in the background from the SAVED def the first
  // time this NPC is opened (npcSnapshot.ts session cache serves revisits).
  const [icon, setIcon] = useState<string | null>(peekNpcIcon(data.id) ?? null)
  useEffect(() => {
    setIcon(peekNpcIcon(data.id) ?? null)
    if (!cacheRoot) return
    let cancelled = false
    getNpcIcon(cacheRoot, data.id, data.npc as Record<string, unknown>).then((url) => {
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

  // All part models merged with their per-model translations, the NPC's
  // recolour/retexture pairs, its scaleXZ/scaleY and its tint — the composite
  // the client actually renders — idling in its BAS's stand animation when
  // one resolves.
  async function previewFullModel() {
    let sequenceId: number | undefined
    const sequenceOptions: { label: string; seqId: number }[] = []
    const basId = Number(draft.basId ?? -1)
    if (basId >= 0 && cacheRoot) {
      try {
        const dir = await resolveEntryHandle(cacheRoot, getEntryPath('config_bas'))
        const file = await (await dir!.getFileHandle(`${basId}.json`)).getFile()
        const bas = JSON.parse(await file.text()) as Record<string, unknown>
        for (const [key, label] of BAS_EMOTE_FIELDS) {
          const seq = Number(bas[key] ?? -1)
          if (seq >= 0) sequenceOptions.push({ label: `${label} · ${seq}`, seqId: seq })
        }
        const randoms = (bas.randomStandSequences as number[] | undefined) ?? []
        randoms.forEach((seq, i) => {
          if (seq >= 0) sequenceOptions.push({ label: `Random stand ${i + 1} · ${seq}`, seqId: seq })
        })
        const stand = Number(bas.standAnimation ?? -1)
        if (stand >= 0) sequenceId = stand
        else if (sequenceOptions.length > 0) sequenceId = sequenceOptions[0].seqId
      } catch { /* BAS unreadable — static preview */ }
    }
    setModelPreview({
      sequenceId,
      sequenceOptions,
      title: `NPC ${data.id} — full model`,
      ...npcCompositeSpec(draft as Record<string, unknown>),
    })
  }

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

  // Model rows edit modelIds and modelTranslation TOGETHER — the two arrays
  // pair positionally (opcode 121), so add/remove always splices both.
  function setModelId(index: number, value: number) {
    const ids = [...modelIds]
    ids[index] = value
    set('modelIds', ids)
  }

  function addModel() {
    setDraft((prev) => {
      const prevIds = (prev.modelIds as number[] | undefined) ?? []
      const prevTr = prev.modelTranslation as (number[] | null)[] | undefined
      const next = { ...prev, modelIds: [...prevIds, 0] }
      if (prevTr) next.modelTranslation = [...prevIds.map((_, i) => prevTr[i] ?? null), null]
      return next
    })
    setIsDirty(true)
  }

  const headModels = (draft.headModels as number[] | undefined) ?? []
  const transformTo = (draft.transformTo as number[] | undefined) ?? []

  function setTransformTo(index: number, value: number) {
    const arr = [...transformTo]
    arr[index] = value
    set('transformTo', arr)
  }

  function removeTransformTo(index: number) {
    const arr = transformTo.filter((_, i) => i !== index)
    set('transformTo', arr.length > 0 ? arr : undefined)
  }

  function setHeadModel(index: number, value: number) {
    const ids = [...headModels]
    ids[index] = value
    set('headModels', ids)
  }

  function removeHeadModel(index: number) {
    const ids = headModels.filter((_, i) => i !== index)
    set('headModels', ids.length === 0 ? undefined : ids)
  }

  function removeModel(index: number) {
    setDraft((prev) => {
      const prevIds = (prev.modelIds as number[] | undefined) ?? []
      const prevTr = prev.modelTranslation as (number[] | null)[] | undefined
      const ids = prevIds.filter((_, i) => i !== index)
      const next = { ...prev }
      if (ids.length === 0) delete next.modelIds
      else next.modelIds = ids
      if (prevTr) {
        const tr = prevIds.map((_, i) => prevTr[i] ?? null).filter((_, i) => i !== index)
        if (ids.length === 0 || tr.every((t) => t === null)) delete next.modelTranslation
        else next.modelTranslation = tr
      }
      return next
    })
    setIsDirty(true)
  }

  function setQuest(index: number, value: number) {
    const arr = [...((draft.quests as number[] | undefined) ?? [])]
    arr[index] = value
    set('quests', arr)
  }

  function removeQuestAt(index: number) {
    const arr = ((draft.quests as number[] | undefined) ?? []).filter((_, i) => i !== index)
    set('quests', arr.length === 0 ? undefined : arr)
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
    setIsDirty(false)
  }

  const quests = (draft.quests as number[] | undefined) ?? []

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          {icon && <img className="npc-header-icon" src={icon} alt="" title="Snapshot of the full composite model" />}
          <input
            className="quest-name-input"
            value={String(draft.name ?? '')}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
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
          <label className="item-stackable">
            <span className="item-field-label">Movement Type</span>
            <select
              className="item-stackable-select"
              value={String(draft.movementType ?? '')}
              onChange={(e) => set('movementType', e.target.value === '' ? undefined : e.target.value)}
            >
              <option value="">(unset)</option>
              {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="item-stackable" title="Use the crawl-walk BAS variant when moving">
            <span className="item-field-label">Crawl-Walk BAS</span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.usesCrawlWalkBAS)}
                onChange={(e) => set('usesCrawlWalkBAS', e.target.checked)}
              />
              <span className="sprite-toggle-track" />
            </span>
          </label>
        </div>
      </div>

      <section className="item-section">
        <h3>Models</h3>
        {modelIds.length > 0 && (
          <div className="quest-table-wrap object-shapes-wrap">
            <table className="quest-table">
              <thead><tr><th className="pair-icon-th" /><th>Model</th><th>Translate X</th><th>Y</th><th>Z</th><th></th></tr></thead>
              <tbody>
                {modelIds.map((modelId, i) => {
                  const triple = modelTranslation[i] ?? null
                  return (
                    <tr key={i}>
                      <td className="pair-icon-cell"><ModelSnapshotIcon cacheRoot={cacheRoot ?? null} modelId={modelId} /></td>
                      <td><NumberInput className="cell-input" value={modelId} onChange={(v) => setModelId(i, v)} /></td>
                      {triple ? (
                        ([0, 1, 2] as const).map((axis) => (
                          <td key={axis}>
                            <NumberInput className="cell-input" value={triple[axis] ?? 0} onChange={(v) => setTranslation(i, axis, v)} />
                          </td>
                        ))
                      ) : (
                        <td colSpan={3}>
                          <button type="button" className="add-row-btn" onClick={() => addTranslation(i)}>+ Set translation</button>
                        </td>
                      )}
                      <td>
                        <span className="anim-fit-actions">
                          {cacheRoot && (
                            <button
                              type="button"
                              className="field-link-btn"
                              title={`Preview model ${modelId} in a modal`}
                              onClick={() => setModelPreview({ title: `NPC ${data.id} — part model ${modelId}`, modelIds: [modelId], openModelId: modelId })}
                            >
                              View Model
                            </button>
                          )}
                          {triple && (
                            <button type="button" className="field-link-btn" title="Remove this model's translation" onClick={() => clearTranslation(i)}>
                              Clear TX
                            </button>
                          )}
                          <button type="button" className="row-remove-btn" title="Remove this model (its translation slot goes with it)" onClick={() => removeModel(i)}>×</button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <span className="npc-models-actions">
          <button type="button" className="add-row-btn" onClick={addModel}>+ Add model</button>
          {cacheRoot && modelIds.length > 0 && (
            <button
              type="button"
              className="add-row-btn"
              title="Merge every part model (with its translation and the NPC's recolours) into the composite the client renders"
              onClick={previewFullModel}
            >
              View Full Model
            </button>
          )}
        </span>

        <h3 className="npc-headmodels-title">Head Models</h3>
        <p className="tex-op-note">Chathead pieces — the client merges these into one head mesh (head/hair/beard), like the body models above.</p>
        {headModels.length > 0 && (
          <div className="quest-table-wrap npc-headmodels-wrap">
            <table className="quest-table">
              <thead><tr><th className="pair-icon-th" /><th>Model</th><th></th></tr></thead>
              <tbody>
                {headModels.map((modelId, i) => (
                  <tr key={i}>
                    <td className="pair-icon-cell"><ModelSnapshotIcon cacheRoot={cacheRoot ?? null} modelId={modelId} /></td>
                    <td><NumberInput className="cell-input" value={modelId} onChange={(v) => setHeadModel(i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {cacheRoot && (
                          <button
                            type="button"
                            className="field-link-btn"
                            title={`Preview head model ${modelId} in a modal`}
                            onClick={() => setModelPreview({ title: `NPC ${data.id} — head model ${modelId}`, modelIds: [modelId], openModelId: modelId })}
                          >
                            View Model
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this head model" onClick={() => removeHeadModel(i)}>×</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <span className="npc-models-actions">
          <button type="button" className="add-row-btn" onClick={() => set('headModels', [...headModels, 0])}>+ Add head model</button>
          {cacheRoot && headModels.length > 0 && (
            <button
              type="button"
              className="add-row-btn"
              title="Render the merged head models inside the game's dialogue interface (1184)"
              onClick={() => setChatheadPreview([...headModels])}
            >
              Preview Chathead
            </button>
          )}
        </span>
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
        <NpcMenuPreview
          cacheRoot={cacheRoot ?? null}
          name={String(draft.name ?? '')}
          combatLevel={Number(draft.combatLevel ?? 0)}
          options={(draft.options as (string | null)[] | undefined) ?? []}
          membersOptions={(draft.membersOptions as (string | null)[] | undefined) ?? []}
        />
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid
          fields={GENERAL_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={{
            basId: onNavigate && { label: 'View BAS', onOpen: (id: number) => onNavigate('config_bas', id) },
            // MEC = Map Element Config — the map_areas shared-config group
            // (36), i.e. this NPC's world-map/minimap marker.
            mecId: onNavigate && { label: 'View Map Area', onOpen: (id: number) => onNavigate('config_map_areas', id) },
          }}
        />
        {(() => {
          const overhead = Number(draft.overheadSprite ?? -1)
          const headIcon = Number(draft.headIcons ?? -1)
          const hasHeadIcon = headIcon >= 0 && headIcon !== HEAD_ICON_NONE
          if (overhead < 0 && !hasHeadIcon) return null
          return (
            <div className="item-cursor-row">
              {overhead >= 0 && (
                <SpriteFramePreview
                  spritesDir={spritesDir}
                  spriteId={overhead}
                  label={`Overhead · sprite ${overhead}`}
                  onOpen={onNavigate && ((id) => onNavigate('sprites', id))}
                />
              )}
              {hasHeadIcon && (
                <SpriteFramePreview
                  spritesDir={spritesDir}
                  spriteId={HEADICONS_PRAYER_SPRITE}
                  frameIndex={headIcon}
                  label={`Head icon · frame ${headIcon} of headicons_prayer (${HEADICONS_PRAYER_SPRITE})`}
                  onOpen={onNavigate && ((id) => onNavigate('sprites', id))}
                />
              )}
            </div>
          )
        })()}
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
        <NumGrid
          fields={SOUND_FIELDS}
          values={draft}
          onChange={(k, v) => set(k, v)}
          links={Object.fromEntries(SOUND_ID_KEYS.map((key) => [
            key,
            onNavigate && { label: 'View', onOpen: (id: number) => onNavigate('sound_effects', id) },
          ]))}
          fieldExtra={cacheRoot ? Object.fromEntries(SOUND_ID_KEYS.map((key) => {
            const id = Number(draft[key] ?? -1)
            return [key, id >= 0 && id !== 65535 ? <SoundPlayerCell key={key} cacheRoot={cacheRoot} soundId={id} /> : undefined]
          })) : undefined}
        />
      </section>

      <section className="item-section">
        <h3>Cursors</h3>
        <NumGrid fields={CURSOR_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
        {(['primaryCursor', 'secondaryCursor', 'attackCursor'] as const).some((key) => Number(draft[key] ?? -1) >= 0) && (
          <div className="item-cursor-row">
            {([['primaryCursor', 'Primary'], ['secondaryCursor', 'Secondary'], ['attackCursor', 'Attack']] as const).map(([key, label]) => (
              <CursorPreview
                key={key}
                cursorsDir={cursorsDir}
                spritesDir={spritesDir}
                cursorId={Number(draft[key] ?? -1)}
                label={label}
                onOpen={onNavigate && ((id) => onNavigate('config_cursors', id))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="item-section">
        <h3>Tint</h3>
        <NumGrid fields={TINT_FIELDS} values={draft} onChange={(k, v) => set(k, v)} />
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
        {/* Positional: transformTo[var value] = the NPC shown for that value
            (the last slot is the client's out-of-range fallback), so rows are
            keyed by var value rather than freely reorderable. */}
        {transformTo.length > 0 && (
          <div className="quest-table-wrap npc-headmodels-wrap">
            <table className="quest-table">
              <thead><tr><th>Var Value</th><th>NPC</th><th></th></tr></thead>
              <tbody>
                {transformTo.map((npcId, i) => (
                  <tr key={i}>
                    <td className="bas-slot-label">{i === transformTo.length - 1 ? `${i} / fallback` : i}</td>
                    <td><NumberInput className="cell-input" value={npcId} min={-1} onChange={(v) => setTransformTo(i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && npcId >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open NPC ${npcId}`} onClick={() => onNavigate('npcs', npcId)}>
                            View NPC
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this slot (later var values shift down)" onClick={() => removeTransformTo(i)}>×</button>
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
                    <td><NumberInput className="cell-input" value={id} onChange={(v) => setQuest(i, v)} /></td>
                    <td>
                      <span className="anim-fit-actions">
                        {onNavigate && id >= 0 && (
                          <button type="button" className="field-link-btn" title={`Open quest ${id}`} onClick={() => onNavigate('config_quests', id)}>
                            View
                          </button>
                        )}
                        <button type="button" className="row-remove-btn" title="Remove this quest" onClick={() => removeQuestAt(i)}>×</button>
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
          rowAnnotation={(row) => {
            const label = NPC_PARAM_LABELS[row.key]
            return label ? <span className="param-row-note">{label}</span> : null
          }}
        />
      </section>

      {modelPreview && cacheRoot && (
        <ModelPreviewModal
          title={modelPreview.title}
          modelIds={modelPreview.modelIds}
          translations={modelPreview.translations}
          recolor={modelPreview.recolor}
          scale={modelPreview.scale}
          tint={modelPreview.tint}
          hideMarkerFaces={modelPreview.hideMarkerFaces}
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

      {chatheadPreview && cacheRoot && (
        <ChatheadPreviewModal
          rootHandle={cacheRoot}
          headModelIds={chatheadPreview}
          npcName={String(draft.name ?? '')}
          recolor={npcCompositeSpec(draft as Record<string, unknown>).recolor}
          tint={npcCompositeSpec(draft as Record<string, unknown>).tint}
          onClose={() => setChatheadPreview(null)}
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
