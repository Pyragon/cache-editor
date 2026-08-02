import { useCallback, useMemo, useRef, useState } from 'react'
import type { CutsceneActionDef, CutsceneData, CutsceneDef } from '../loaders/cutscenes'
import { actionTypeId } from '../loaders/cutscenes'
import CutscenePlayer from './CutscenePlayer'
import type { CutsceneSceneHandle, PickedTile } from './CutscenePlayer'
import { ACTION_FIELDS, ADDABLE_ACTIONS, SIMULATED_ACTIONS, defaultFields } from './cutsceneActionFields'
import type { ActionField } from './cutsceneActionFields'
import { NumberInput } from './defFields'
import { CLOCK_UNITS, clockShort } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import './CutsceneEditor.css'

// Authoring surface for a cutscene: the same simulated 3D scene the preview
// runs, plus picking and an editable timeline.
//
// The working model is "the clock is the cursor". You scrub to a moment, click
// something in the scene, and the action you add lands at that cycle — which is
// how the format itself thinks, since every action is a timestamp plus a
// subject. Everything writes into one draft def; the preview re-reads the
// timeline live, so only structural changes (areas, cast, objects) cost a scene
// rebuild.

type Props = {
  data: CutsceneData
  cacheRoot: FileSystemDirectoryHandle | null
  onSave: (data: CutsceneData) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Back to the read-only page. */
  onClose: () => void
}

type Selection =
  | { kind: 'tile'; tile: PickedTile }
  | { kind: 'entity'; index: number }
  | { kind: 'object'; index: number }
  | null

/** Where an entity stands at a given cycle, read out of the timeline rather
 *  than the scene — the editor needs it to author a walk from where the entity
 *  will actually be, which may be ahead of what's on screen. */
function entityTileAt(def: CutsceneDef, entityIndex: number, cycle: number): { x: number; y: number; plane: number } | null {
  let best: { x: number; y: number; plane: number } | null = null
  for (const action of def.actions) {
    if (action.lengthInCycles > cycle) continue
    const f = (action.fields ?? {}) as Record<string, number>
    if (action.type === 'MOVEMENT' && f.targetIndex === entityIndex) {
      best = { x: f.x, y: f.y, plane: f.plane }
    } else if (action.type === 'BASIC_MOVEMENT' && f.entityIndex === entityIndex) {
      const route = def.movements[f.movementIndex]
      const last = route?.bitpackedPositions[route.bitpackedPositions.length - 1]
      if (last != null) best = { x: last >>> 16, y: last & 0xffff, plane: f.plane }
    }
  }
  return best
}

/** Every field that names a cast index, and every field that names an entry in
 *  `def.objects`. Removing one of those entries renumbers everything after it,
 *  so the actions pointing at them have to move with it or they silently end up
 *  acting on the wrong thing. */
const ENTITY_REF_FIELDS = ['targetIndex', 'entityIndex', 'cutsceneEntityPtr', 'sourceEntityIndex', 'targetEntityIndex']
const OBJECT_REF_FIELDS = ['locIndex', 'cutsceneObjectPtr', 'objectIndex']

/** Drops actions that pointed at `removed` and shifts higher references down.
 *  Returns the surviving actions and how many were dropped, so the UI can say
 *  what it just did rather than quietly deleting someone's work. */
function repointActions(
  actions: CutsceneActionDef[],
  removed: number,
  refFields: string[],
): { actions: CutsceneActionDef[]; dropped: number } {
  let dropped = 0
  const kept: CutsceneActionDef[] = []
  for (const action of actions) {
    const fields = { ...(action.fields ?? {}) }
    let orphaned = false
    for (const name of refFields) {
      const value = fields[name]
      if (typeof value !== 'number') continue
      if (value === removed) orphaned = true
      else if (value > removed) fields[name] = value - 1
    }
    if (orphaned) { dropped++; continue }
    kept.push({ ...action, fields })
  }
  return { actions: kept, dropped }
}

export default function CutsceneEditor({ data, cacheRoot, onSave, onDirtyChange, onClose }: Props) {
  const [draft, setDraft] = useState<CutsceneDef>(data.def)
  const [dirty, setDirty] = useState(false)
  const [selection, setSelection] = useState<Selection>(null)
  const [insertCycle, setInsertCycle] = useState(0)
  // Which entity subsequent tile clicks act on. Kept apart from `selection` so
  // picking a tile to walk to doesn't drop the entity you're walking — that
  // round trip is the whole authoring loop for movement.
  const [activeEntity, setActiveEntity] = useState<number | null>(null)
  const [freeCam, setFreeCam] = useState(false)
  const [unit, setUnit] = useState<CutsceneClockUnit>('cycles')
  const [note, setNote] = useState('')
  const scene = useRef<CutsceneSceneHandle | null>(null)

  const edit = useCallback((next: CutsceneDef) => {
    setDraft(next)
    setDirty(true)
    onDirtyChange?.(true)
  }, [onDirtyChange])

  /** Add an action at the insertion cycle, with sensible starting fields. */
  const addAction = useCallback((type: string, fields: Record<string, number | string> = {}) => {
    const action: CutsceneActionDef = {
      typeId: actionTypeId(type),
      type,
      lengthInCycles: insertCycle,
      fields: { ...defaultFields(type), ...fields },
    }
    edit({ ...draft, actions: [...draft.actions, action].sort((a, b) => a.lengthInCycles - b.lengthInCycles) })
    setNote(`Added ${type.toLowerCase().replace(/_/g, ' ')} at ${insertCycle}c`)
  }, [draft, edit, insertCycle])

  // ------------------------------------------------------------------ picking

  const onStageClick = (e: React.MouseEvent) => {
    const handle = scene.current
    if (!handle || freeCam) return
    const entity = handle.pickEntity(e.clientX, e.clientY)
    if (entity != null) {
      setSelection({ kind: 'entity', index: entity })
      setActiveEntity(entity)
      // the marker means "the tile the tile-actions will act on", so it clears
      // when the selection moves off a tile. The entity stays active, which is
      // what the next tile click needs.
      handle.setTileHighlight(null)
      return
    }
    const object = handle.pickObject(e.clientX, e.clientY)
    if (object != null) {
      setSelection({ kind: 'object', index: object })
      handle.setTileHighlight(null)
      return
    }
    const tile = handle.pickTile(e.clientX, e.clientY)
    setSelection(tile ? { kind: 'tile', tile } : null)
    handle.setTileHighlight(tile)
  }

  // The clock reports every rendered frame so the preview's own playhead stays
  // smooth; the editor only needs it a few times a second, and each update
  // re-renders this page.
  const lastReport = useRef(0)
  const reportCycle = useCallback((cycle: number) => {
    const now = performance.now()
    if (now - lastReport.current < 150) return
    lastReport.current = now
    setInsertCycle(cycle)
  }, [])

  // -------------------------------------------------------------- draft edits

  const setActions = (actions: CutsceneActionDef[]) => edit({ ...draft, actions })

  const patchAction = (index: number, patch: Partial<CutsceneActionDef>) => {
    const actions = draft.actions.map((a, i) => (i === index ? { ...a, ...patch } : a))
    setActions(patch.lengthInCycles != null ? actions.sort((a, b) => a.lengthInCycles - b.lengthInCycles) : actions)
  }

  const patchField = (index: number, name: string, value: number | string) => {
    const action = draft.actions[index]
    patchAction(index, { fields: { ...(action.fields ?? {}), [name]: value } })
  }

  const addEntity = (npcId: number) => {
    const entities = [...draft.entities, { index: draft.entities.length, id: npcId, name: '' }]
    edit({ ...draft, entities })
  }

  const addObject = (locId: number, locShape: number) =>
    edit({ ...draft, objects: [...draft.objects, { locId, locShape }] })

  /** Walk the selected entity to a tile: extends the route it's already walking
   *  at this cycle, or starts a new one from where it stands. */
  const walkTo = (entityIndex: number, tile: PickedTile) => {
    const existing = draft.actions.findIndex(
      (a) => a.type === 'BASIC_MOVEMENT'
        && a.lengthInCycles === insertCycle
        && (a.fields as Record<string, number>)?.entityIndex === entityIndex,
    )
    const packed = (tile.x << 16) | (tile.y & 0xffff)
    if (existing >= 0) {
      const routeIndex = (draft.actions[existing].fields as Record<string, number>).movementIndex
      const movements = draft.movements.map((m, i) => (i === routeIndex
        ? { movementTypes: [...m.movementTypes, 1], bitpackedPositions: [...m.bitpackedPositions, packed] }
        : m))
      edit({ ...draft, movements })
      setNote(`Route ${routeIndex}: step to ${tile.x}, ${tile.y}`)
      return
    }
    const from = entityTileAt(draft, entityIndex, insertCycle)
    if (!from) { setNote('Place the entity first — a walk starts from where it stands.'); return }
    const routeIndex = draft.movements.length
    const movements = [...draft.movements, {
      movementTypes: [1, 1],
      bitpackedPositions: [(from.x << 16) | (from.y & 0xffff), packed],
    }]
    const action: CutsceneActionDef = {
      typeId: actionTypeId('BASIC_MOVEMENT'),
      type: 'BASIC_MOVEMENT',
      lengthInCycles: insertCycle,
      fields: { entityIndex, movementIndex: routeIndex, plane: tile.plane },
    }
    edit({
      ...draft,
      movements,
      actions: [...draft.actions, action].sort((a, b) => a.lengthInCycles - b.lengthInCycles),
    })
    setNote(`Route ${routeIndex} created — click more tiles to extend it`)
  }

  /**
   * A camera move names TWO paths and reads the POSITION array of each: one
   * gives where the camera is, the other gives the point it aims at (see
   * splinePoint — the look-at path's own positions are the target, its target
   * columns act as the spline's control handles). So a shot is a pair, and
   * capturing has to create or extend both together.
   *
   * The pairing isn't stored anywhere in the format except in the action that
   * names them, so a new shot writes its DIRECT_CAMERA_MOVEMENT straight away
   * and later keyframes are added through that action.
   */
  const newShot = () => {
    const handle = scene.current
    if (!handle) return
    const { pos, target } = handle.cameraPose()
    const posPath = draft.camMovements.length
    const lookPath = posPath + 1
    const path = (p: [number, number, number]) => ({
      xPositions: [p[0]], yPositions: [p[1]], zPositions: [p[2]],
      // A single-keyframe path has nothing to interpolate toward, so the
      // handles start on the point itself — the spline then holds still until
      // a second keyframe is captured.
      targetXPositions: [p[0]], targetYPositions: [p[1]], targetZPositions: [p[2]],
      timestamps: [0],
    })
    const action: CutsceneActionDef = {
      typeId: actionTypeId('DIRECT_CAMERA_MOVEMENT'),
      type: 'DIRECT_CAMERA_MOVEMENT',
      lengthInCycles: insertCycle,
      fields: {
        positionMovementIndex: posPath,
        lookAtMovementIndex: lookPath,
        positionKeyframe: 0,
        lookAtKeyframe: 0,
        splineSpeedStart: 1000,
        splineSpeedEnd: 1000,
      },
    }
    edit({
      ...draft,
      camMovements: [...draft.camMovements, path(pos), path(target)],
      actions: [...draft.actions, action].sort((a, b) => a.lengthInCycles - b.lengthInCycles),
    })
    setNote(`Shot added at ${insertCycle}c — paths ${posPath} (camera) and ${lookPath} (aim)`)
  }

  /** Append the current view to both paths of an existing shot. */
  const addShotKeyframe = (actionIndex: number) => {
    const handle = scene.current
    if (!handle) return
    const f = (draft.actions[actionIndex]?.fields ?? {}) as Record<string, number>
    const posPath = f.positionMovementIndex
    const lookPath = f.lookAtMovementIndex
    if (draft.camMovements[posPath] == null || draft.camMovements[lookPath] == null) {
      setNote('That shot names a path that no longer exists.')
      return
    }
    const { pos, target } = handle.cameraPose()
    const append = (i: number, p: [number, number, number]) => {
      const c = draft.camMovements[i]
      return {
        xPositions: [...c.xPositions, p[0]],
        yPositions: [...c.yPositions, p[1]],
        zPositions: [...c.zPositions, p[2]],
        targetXPositions: [...c.targetXPositions, p[0]],
        targetYPositions: [...c.targetYPositions, p[1]],
        targetZPositions: [...c.targetZPositions, p[2]],
        timestamps: [...c.timestamps, 0],
      }
    }
    const camMovements = draft.camMovements.map((c, i) => (
      i === posPath ? append(i, pos) : i === lookPath ? append(i, target) : c
    ))
    edit({ ...draft, camMovements })
    setNote(`Keyframe ${draft.camMovements[posPath].xPositions.length} added to the shot`)
  }

  /** Put the preview camera where a shot starts, to check the framing. */
  const previewShot = (actionIndex: number) => {
    const f = (draft.actions[actionIndex]?.fields ?? {}) as Record<string, number>
    const posPath = draft.camMovements[f.positionMovementIndex]
    const lookPath = draft.camMovements[f.lookAtMovementIndex]
    if (!posPath || !lookPath) return
    const k = f.positionKeyframe ?? 0
    const lk = f.lookAtKeyframe ?? 0
    scene.current?.setCameraPose(
      [posPath.xPositions[k] ?? 0, posPath.yPositions[k] ?? 0, posPath.zPositions[k] ?? 0],
      [lookPath.xPositions[lk] ?? 0, lookPath.yPositions[lk] ?? 0, lookPath.zPositions[lk] ?? 0],
    )
    setNote('Camera moved to the shot’s first keyframe — free camera is on if you want to adjust it.')
  }

  const save = () => {
    onSave({ id: data.id, def: draft })
    setDirty(false)
    onDirtyChange?.(false)
    setNote('Saved.')
  }

  const discard = () => {
    setDraft(data.def)
    setDirty(false)
    onDirtyChange?.(false)
    setSelection(null)
    setNote('Reverted to the saved cutscene.')
  }

  const toggleFreeCam = () => {
    const next = !freeCam
    setFreeCam(next)
    scene.current?.setFreeCamera(next)
  }

  const entityLabel = (index: number) => {
    const e = draft.entities[index]
    if (!e) return `entity ${index}`
    return `${index} · ${e.id < 0 ? 'Player' : `NPC ${e.id}`}${e.name ? ` (${e.name})` : ''}`
  }

  const refOptions = (field: ActionField): { value: number; label: string }[] | null => {
    switch (field.ref) {
      case 'entity': return draft.entities.map((e) => ({ value: e.index, label: entityLabel(e.index) }))
      case 'object': return draft.objects.map((o, i) => ({ value: i, label: `${i} · loc ${o.locId}` }))
      case 'movement': return draft.movements.map((m, i) => ({ value: i, label: `${i} · ${m.movementTypes.length} steps` }))
      case 'camera': return draft.camMovements.map((c, i) => ({ value: i, label: `${i} · ${c.xPositions.length} keyframes` }))
      default: return null
    }
  }

  const durationCycles = useMemo(
    () => draft.actions.reduce((m, a) => Math.max(m, a.lengthInCycles), 0),
    [draft],
  )

  /** Camera-move actions, which are what pairs two paths into a shot. */
  const shots = useMemo(
    () => draft.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.type === 'DIRECT_CAMERA_MOVEMENT'),
    [draft],
  )

  // The timeline is the heaviest thing on the page — a row per action, each
  // with an input per field — and the clock ticks several times a second while
  // the preview plays. Rebuilt only when the draft or the unit changes, so
  // scrubbing doesn't touch it.
  const timelineRows = useMemo(() => draft.actions.map((a, i) => (
    <tr key={i}>
      <td>
        <NumberInput
          className="cell-input"
          value={a.lengthInCycles}
          min={0}
          onChange={(v) => patchAction(i, { lengthInCycles: v })}
        />
        <div className="cutscene-cycles">{clockShort(a.lengthInCycles, unit)}</div>
      </td>
      <td>
        <span className="cutscene-action-badge">{a.type.toLowerCase().replace(/_/g, ' ')}</span>
        {!SIMULATED_ACTIONS.has(a.type) && (
          <div className="cutscene-editor-unsimulated" title="Saves correctly, but the preview above doesn’t show it">
            not previewed
          </div>
        )}
      </td>
      <td>
        <div className="cutscene-editor-fields">
          {(ACTION_FIELDS[a.type] ?? []).map((field) => {
            const value = (a.fields ?? {})[field.name]
            const options = refOptions(field)
            return (
              <label key={field.name} className="cutscene-editor-field">
                <span>{field.label}</span>
                {options ? (
                  <select
                    className="cell-select"
                    value={String(value ?? 0)}
                    onChange={(e) => patchField(i, field.name, Number(e.target.value))}
                  >
                    {options.length === 0 && <option value="0">none defined</option>}
                    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : field.kind === 'string' ? (
                  <input
                    className="cell-input"
                    value={String(value ?? '')}
                    onChange={(e) => patchField(i, field.name, e.target.value)}
                  />
                ) : (
                  <NumberInput
                    className="cell-input"
                    value={Number(value ?? 0)}
                    onChange={(v) => patchField(i, field.name, v)}
                  />
                )}
                {field.hint && <em>{field.hint}</em>}
              </label>
            )
          })}
          {(ACTION_FIELDS[a.type] ?? []).length === 0 && <span className="cutscene-editor-empty">no fields</span>}
        </div>
      </td>
      <td>
        <button
          type="button"
          className="row-remove-btn"
          onClick={() => setActions(draft.actions.filter((_, j) => j !== i))}
        >×</button>
      </td>
    </tr>
    // the handlers close over `draft`, which is in the deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [draft, unit])

  return (
    <div className="item-viewer cutscene-editor">
      <div className="item-header">
        <div className="item-title-row">
          <span className="cutscene-title">Editing cutscene {data.id}</span>
          <button
            type="button"
            className="field-link-btn"
            onClick={() => {
              if (dirty && !window.confirm('Leave the editor? Unsaved changes are lost.')) return
              onClose()
            }}
          >
            Back to preview
          </button>
        </div>
        <div className="item-badges">
          <span className="item-id-badge">{draft.actions.length} actions</span>
          <span className="item-id-badge">{draft.entities.length} cast</span>
          <span className="item-id-badge">{draft.camMovements.length} camera paths</span>
          <span className="item-id-badge">runs {clockShort(durationCycles, 'seconds')}</span>
        </div>
      </div>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Scene</h3>
          <span className="btn-pill">
            <button type="button" className={`zoom-btn${freeCam ? ' active' : ''}`} onClick={toggleFreeCam}>
              {freeCam ? 'Free camera on' : 'Free camera off'}
            </button>
          </span>
          <span className="btn-pill">
            {CLOCK_UNITS.map((u) => (
              <button
                key={u.key}
                type="button"
                className={`zoom-btn${unit === u.key ? ' active' : ''}`}
                title={u.hint}
                onClick={() => setUnit(u.key)}
              >
                {u.label}
              </button>
            ))}
          </span>
        </div>
        <p className="cutscene-note cutscene-editor-help">
          {freeCam
            ? 'Drag to orbit, right-drag to pan, wheel to dolly. The cutscene’s own camera actions are paused while this is on — turn it off to watch the real shot.'
            : 'Click the ground to pick a tile, or click an entity or spawned object to select it. Whatever you add lands at the insertion cycle below, so scrub first, then click.'}
        </p>
        <div className="cutscene-editor-stage" onClick={onStageClick}>
          {cacheRoot
            ? <CutscenePlayer def={draft} rootHandle={cacheRoot} unit={unit} sceneHandle={scene} onCycle={reportCycle} />
            : <p className="cutscene-note">Reopen the cache to edit this cutscene.</p>}
        </div>
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Insert at</h3>
          <label className="cutscene-player-step">
            <NumberInput value={insertCycle} min={0} onChange={setInsertCycle} />
            <span>cycles</span>
          </label>
        </div>
        <p className="cutscene-note cutscene-editor-help">
          New actions get this start time. Scrubbing the preview above sets it, so the usual flow is
          scrub to the moment, then click what the action is about.
        </p>

        <div className="cutscene-editor-selection">
          {selection == null && <span className="cutscene-note">Nothing selected.</span>}

          {selection?.kind === 'tile' && (
            <>
              <span className="cutscene-editor-selname">
                Tile {selection.tile.x}, {selection.tile.y} · plane {selection.tile.plane}
                {activeEntity != null && ` — acting on ${entityLabel(activeEntity)}`}
              </span>
              <div className="cutscene-editor-actions">
                <button
                  type="button"
                  className="field-link-btn"
                  disabled={activeEntity == null}
                  title={activeEntity == null ? 'Select an entity in the scene or the cast list first' : undefined}
                  onClick={() => addAction('MOVEMENT', {
                    targetIndex: activeEntity ?? 0,
                    x: selection.tile.x, y: selection.tile.y, plane: selection.tile.plane, direction: 0,
                  })}
                >
                  Place here
                </button>
                <button
                  type="button"
                  className="field-link-btn"
                  disabled={activeEntity == null}
                  title={activeEntity == null ? 'Select an entity first' : 'Click more tiles at this same cycle to extend the route'}
                  onClick={() => activeEntity != null && walkTo(activeEntity, selection.tile)}
                >
                  Walk here
                </button>
                <button
                  type="button"
                  className="field-link-btn"
                  disabled={draft.objects.length === 0}
                  onClick={() => addAction('REPLACE_OBJECT', {
                    locIndex: 0, x: selection.tile.x, y: selection.tile.y, plane: selection.tile.plane, rotation: 0,
                  })}
                >
                  Spawn object 0 here
                </button>
                <button
                  type="button"
                  className="field-link-btn"
                  onClick={() => addAction('POSITIONED_GFX', {
                    gfxId: 0, x: selection.tile.x, y: selection.tile.y, plane: selection.tile.plane,
                  })}
                >
                  Gfx here
                </button>
              </div>
            </>
          )}

          {selection?.kind === 'entity' && (
            <>
              <span className="cutscene-editor-selname">{entityLabel(selection.index)}</span>
              <div className="cutscene-editor-actions">
                <button type="button" className="field-link-btn" onClick={() => addAction('ANIMATE_MOVEMENT', { entityIndex: selection.index })}>
                  Play animation
                </button>
                <button type="button" className="field-link-btn" onClick={() => addAction('ENTITY_GFX', { targetIndex: selection.index })}>
                  Play gfx
                </button>
                <button type="button" className="field-link-btn" onClick={() => addAction('ROTATE_CUTSCENE_ENTITY', { cutsceneEntityPtr: selection.index })}>
                  Turn
                </button>
                <button type="button" className="field-link-btn" onClick={() => addAction('RESET_CUTSCENE_ENTITY', { entityIndex: selection.index })}>
                  Remove from scene
                </button>
              </div>
              <p className="cutscene-note cutscene-editor-help">
                Click a tile with this entity selected to walk it there — clicking more tiles at the same
                insertion cycle extends the same route.
              </p>
            </>
          )}

          {selection?.kind === 'object' && (
            <>
              <span className="cutscene-editor-selname">
                Object {selection.index} · loc {draft.objects[selection.index]?.locId}
              </span>
              <div className="cutscene-editor-actions">
                <button type="button" className="field-link-btn" onClick={() => addAction('ANIMATE_OBJECT', { objectIndex: selection.index })}>
                  Animate
                </button>
                <button type="button" className="field-link-btn" onClick={() => addAction('DESTROY_OBJECT', { cutsceneObjectPtr: selection.index })}>
                  Destroy
                </button>
              </div>
            </>
          )}
        </div>

        {note && <p className="cutscene-note cutscene-editor-note">{note}</p>}
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Camera shots</h3>
          <span className="btn-pill">
            <button type="button" className="zoom-btn" onClick={newShot}>New shot from view</button>
          </span>
        </div>
        <p className="cutscene-note cutscene-editor-help">
          A shot is a camera-move action plus the two paths it reads: one holds where the camera is, the
          other holds what it aims at. Turn free camera on, frame the view, and capture — the pair is
          created together, because nothing in the format records which two paths belong to each other
          except the action that names them. Capture again to add keyframes and the camera flies between
          them; a shot with one keyframe simply holds still.
        </p>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>At</th><th>Camera path</th><th>Aim path</th><th>Keyframes</th><th /></tr></thead>
            <tbody>
              {shots.map(({ action, index }) => {
                const f = (action.fields ?? {}) as Record<string, number>
                const keyframes = draft.camMovements[f.positionMovementIndex]?.xPositions.length ?? 0
                return (
                  <tr key={index}>
                    <td>{clockShort(action.lengthInCycles, unit)}</td>
                    <td>{f.positionMovementIndex}</td>
                    <td>{f.lookAtMovementIndex}</td>
                    <td>{keyframes}</td>
                    <td>
                      <button type="button" className="field-link-btn" onClick={() => addShotKeyframe(index)}>
                        Add keyframe from view
                      </button>
                      <button type="button" className="field-link-btn" onClick={() => previewShot(index)}>
                        Go to shot
                      </button>
                    </td>
                  </tr>
                )
              })}
              {shots.length === 0 && (
                <tr><td colSpan={5} className="cutscene-editor-empty">No camera shots yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Cast — {draft.entities.length}</h3>
          <span className="btn-pill">
            <button type="button" className="zoom-btn" onClick={() => addEntity(-1)}>+ Player</button>
            <button type="button" className="zoom-btn" onClick={() => addEntity(0)}>+ NPC</button>
          </span>
        </div>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>#</th><th>NPC id</th><th>Dev label</th><th /></tr></thead>
            <tbody>
              {draft.entities.map((e, i) => (
                <tr key={i} className={activeEntity === e.index ? 'linked-hover' : undefined}>
                  <td>
                    <button
                      type="button"
                      className="field-link-btn"
                      title="Tile clicks act on this entity"
                      onClick={() => { setActiveEntity(e.index); setSelection({ kind: 'entity', index: e.index }) }}
                    >
                      {e.index}
                    </button>
                  </td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={e.id}
                      min={-1}
                      onChange={(v) => edit({ ...draft, entities: draft.entities.map((x, j) => (j === i ? { ...x, id: v } : x)) })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={e.name}
                      onChange={(ev) => edit({ ...draft, entities: draft.entities.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-remove-btn"
                      title="Remove — actions acting on it are removed with it, later indices shift down"
                      onClick={() => {
                        const { actions, dropped } = repointActions(draft.actions, e.index, ENTITY_REF_FIELDS)
                        edit({
                          ...draft,
                          entities: draft.entities.filter((_, j) => j !== i).map((x, j) => ({ ...x, index: j })),
                          actions,
                        })
                        if (activeEntity === e.index) setActiveEntity(null)
                        setNote(dropped > 0
                          ? `Removed the entity and ${dropped} action${dropped === 1 ? '' : 's'} that acted on it`
                          : 'Removed the entity')
                      }}
                    >×</button>
                  </td>
                </tr>
              ))}
              {draft.entities.length === 0 && (
                <tr><td colSpan={4} className="cutscene-editor-empty">No cast yet — add the player or an NPC.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Objects — {draft.objects.length}</h3>
          <span className="btn-pill">
            <button type="button" className="zoom-btn" onClick={() => addObject(0, 10)}>+ Object</button>
          </span>
        </div>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>#</th><th>Loc id</th><th>Shape</th><th /></tr></thead>
            <tbody>
              {draft.objects.map((o, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={o.locId}
                      min={0}
                      onChange={(v) => edit({ ...draft, objects: draft.objects.map((x, j) => (j === i ? { ...x, locId: v } : x)) })}
                    />
                  </td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={o.locShape}
                      min={0}
                      max={22}
                      onChange={(v) => edit({ ...draft, objects: draft.objects.map((x, j) => (j === i ? { ...x, locShape: v } : x)) })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-remove-btn"
                      title="Remove — actions using it are removed with it, later indices shift down"
                      onClick={() => {
                        const { actions, dropped } = repointActions(draft.actions, i, OBJECT_REF_FIELDS)
                        edit({ ...draft, objects: draft.objects.filter((_, j) => j !== i), actions })
                        setNote(dropped > 0
                          ? `Removed the object and ${dropped} action${dropped === 1 ? '' : 's'} that used it`
                          : 'Removed the object')
                      }}
                    >×</button>
                  </td>
                </tr>
              ))}
              {draft.objects.length === 0 && (
                <tr><td colSpan={4} className="cutscene-editor-empty">No objects yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="item-section">
        <h3>Map areas — {draft.areas.length}</h3>
        <p className="cutscene-note cutscene-editor-help">
          Chunks copied out of a live region into the scene. One row per plane is the usual shape — the
          source tile is the region’s base corner, and the destination is measured in 8-tile chunks.
        </p>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>Source X</th><th>Source Y</th><th>Plane</th><th>W</th><th>L</th><th>Dest chunk X</th><th>Dest chunk Y</th><th>Dest plane</th><th /></tr>
            </thead>
            <tbody>
              {draft.areas.map((a, i) => {
                const patch = (key: keyof typeof a, v: number) =>
                  edit({ ...draft, areas: draft.areas.map((x, j) => (j === i ? { ...x, [key]: v } : x)) })
                return (
                  <tr key={i}>
                    <td><NumberInput className="cell-input" value={a.regionX} min={0} onChange={(v) => patch('regionX', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.regionY} min={0} onChange={(v) => patch('regionY', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.plane} min={0} max={3} onChange={(v) => patch('plane', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.width} min={1} onChange={(v) => patch('width', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.length} min={1} onChange={(v) => patch('length', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.chunkBaseX} min={0} onChange={(v) => patch('chunkBaseX', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.chunkBaseY} min={0} onChange={(v) => patch('chunkBaseY', v)} /></td>
                    <td><NumberInput className="cell-input" value={a.cutscenePlane} min={0} max={3} onChange={(v) => patch('cutscenePlane', v)} /></td>
                    <td>
                      <button
                        type="button"
                        className="row-remove-btn"
                        onClick={() => edit({ ...draft, areas: draft.areas.filter((_, j) => j !== i) })}
                      >×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="add-row-btn"
          onClick={() => edit({
            ...draft,
            areas: [...draft.areas, draft.areas[draft.areas.length - 1]
              ? { ...draft.areas[draft.areas.length - 1] }
              : { plane: 0, regionX: 3200, regionY: 3200, width: 8, length: 8, cutscenePlane: 0, chunkBaseX: 0, chunkBaseY: 0, rotation: 0 }],
          })}
        >
          + Add area
        </button>
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Timeline — {draft.actions.length} actions</h3>
          <select
            className="cell-select cutscene-editor-add"
            value=""
            onChange={(e) => { if (e.target.value) addAction(e.target.value) }}
          >
            <option value="">+ Add action…</option>
            {ADDABLE_ACTIONS.map((t) => (
              <option key={t} value={t}>{t.toLowerCase().replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        <div className="quest-table-wrap">
          <table className="quest-table cutscene-editor-timeline">
            <thead><tr><th>Start</th><th>Action</th><th>Fields</th><th /></tr></thead>
            <tbody>{timelineRows}</tbody>
          </table>
        </div>
      </section>

      {dirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={discard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={save}>Save</button>
        </div>
      )}
    </div>
  )
}
