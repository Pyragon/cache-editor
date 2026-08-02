import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CutsceneActionDef, CutsceneData, CutsceneDef } from '../loaders/cutscenes'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getNpcIcon, getObjectIcon, peekNpcIcon, peekObjectIcon } from './npcSnapshot'
import { SoundPlayerCell } from './SoundPlayerCell'
import { InstrumentPlayerCell } from './InstrumentPlayerCell'
import { SongPlayerCell } from './SongPlayerCell'
import CutscenePlayer from './CutscenePlayer'
import CutsceneEditor from './CutsceneEditor'
import { CLOCK_UNITS, clockGranularity, clockShort } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import './CutsceneViewer.css'

type Props = {
  data: CutsceneData
  onNavigate?: (entryName: string, itemId: number) => void
  cacheRoot?: FileSystemDirectoryHandle | null
  onSave?: (data: CutsceneData) => void
  onDirtyChange?: (dirty: boolean) => void
}

// One clear colour per camera path / entity movement on the overview canvas.
const PATH_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#81c784', '#f06292', '#a1887f', '#90a4ae', '#fff176']

const cycleTime = (cycles: number) => `${(cycles * 0.02).toFixed(1)}s`

/** 0..16383 client angle units → compass degrees. */
const angleDeg = (angle: number) => `${Math.round((angle % 16384) / 16384 * 360)}°`

const MOVE_TYPE_NAMES: Record<number, string> = { 0: 'half walk', 2: 'run' }
const moveTypeName = (t: number) => MOVE_TYPE_NAMES[t] ?? 'walk'

/** A cast NPC or a cutscene object, resolved to something you can recognise:
 *  the def's name and a rendered snapshot of its model. */
type DefInfo = { name: string; icon: string | null }

/** Collects resolved defs and commits them at most every `MS`, so a cast that
 *  streams in doesn't re-render the page once per member. */
const BATCH_MS = 250

function batcher(
  set: React.Dispatch<React.SetStateAction<Map<number, DefInfo>>>,
  cancelled: () => boolean,
) {
  const pending = new Map<number, DefInfo>()
  let last = 0
  const commit = () => {
    if (pending.size === 0 || cancelled()) return
    const batch = new Map(pending)
    pending.clear()
    set((prev) => {
      const next = new Map(prev)
      for (const [id, info] of batch) next.set(id, info)
      return next
    })
  }
  return {
    add(id: number, info: DefInfo) {
      pending.set(id, info)
      const now = performance.now()
      if (now - last < BATCH_MS) return
      last = now
      commit()
    },
    done: commit,
  }
}

export default function CutsceneViewer({ data, onNavigate, cacheRoot, onSave, onDirtyChange }: Props) {
  // Read-only page by default; the editor is a separate surface over the same
  // def (see CutsceneEditor). Reset when the cutscene changes so switching
  // items never lands you in an editor for something you didn't open.
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  useEffect(() => { setMode('preview') }, [data.def])
  // A hand-made or truncated JSON may omit whole sections — treat them as empty
  // rather than crashing the page. Memoized so effects can depend on it.
  const def: CutsceneDef = useMemo(() => ({
    ...data.def,
    areas: data.def.areas ?? [],
    camMovements: data.def.camMovements ?? [],
    entities: data.def.entities ?? [],
    objects: data.def.objects ?? [],
    movements: data.def.movements ?? [],
    actions: data.def.actions ?? [],
  }), [data.def])

  // NPC names + snapshot icons for every distinct NPC the cutscene casts.
  const [npcInfo, setNpcInfo] = useState<Map<number, DefInfo>>(new Map())
  useEffect(() => {
    if (!cacheRoot) return
    let cancelled = false
    const ids = [...new Set(def.entities.map((e) => e.id).filter((id) => id >= 0))]
    ;(async () => {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath('npcs'))
      if (!dir) return
      // Batched at ~4Hz rather than one setState per NPC. Cast names feed the
      // roll's lane labels, so each update rebuilt every mark in it — 21 NPCs
      // in cutscene 11 meant 21 rebuilds of 341 marks while the page loaded.
      // Still progressive, just not per icon.
      const flush = batcher(setNpcInfo, () => cancelled)
      for (const id of ids) {
        try {
          const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
          const npcDef = JSON.parse(await file.text()) as Record<string, unknown>
          const name = typeof npcDef.name === 'string' && npcDef.name !== 'null' ? npcDef.name : `NPC ${id}`
          const icon = peekNpcIcon(id) ?? await getNpcIcon(cacheRoot, id, npcDef)
          if (cancelled) return
          flush.add(id, { name, icon })
        } catch { /* NPC def unreadable — the id link still works */ }
      }
      flush.done()
    })()
    return () => { cancelled = true }
  }, [def, cacheRoot])

  // The same for the locs the cutscene spawns as props. A loc id on its own
  // says nothing about what appears on screen — cutscene 0's battle crowd is
  // loc-spawned fighters — so the objects list gets the cast list's treatment.
  const [objectInfo, setObjectInfo] = useState<Map<number, DefInfo>>(new Map())
  useEffect(() => {
    if (!cacheRoot) return
    let cancelled = false
    const ids = [...new Set(def.objects.map((o) => o.locId).filter((id) => id >= 0))]
    ;(async () => {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath('objects'))
      if (!dir) return
      const flush = batcher(setObjectInfo, () => cancelled)
      for (const id of ids) {
        try {
          const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
          const objDef = JSON.parse(await file.text()) as Record<string, unknown>
          const name = typeof objDef.name === 'string' && objDef.name !== 'null' ? objDef.name : `Object ${id}`
          const icon = peekObjectIcon(id) ?? await getObjectIcon(cacheRoot, id, objDef)
          if (cancelled) return
          flush.add(id, { name, icon })
        } catch { /* object def unreadable — the id link still works */ }
      }
      flush.done()
    })()
    return () => { cancelled = true }
  }, [def, cacheRoot])

  const entityLabel = (index: number): string => {
    const entity = def.entities[index]
    if (!entity) return `entity #${index}`
    if (entity.id < 0) return `entity #${index} (Player)`
    const info = npcInfo.get(entity.id)
    return `entity #${index} (${info?.name ?? `NPC ${entity.id}`})`
  }

  /** The object-list counterpart of entityLabel: actions name a loc by its
   *  index into `def.objects`, which says nothing on its own. */
  const objectLabel = (index: number): string => {
    const obj = def.objects[index]
    if (!obj) return `object #${index}`
    const name = objectInfo.get(obj.locId)?.name
    const known = name && name !== `Object ${obj.locId}`
    return `object #${index} (${known ? `${name}, loc ${obj.locId}` : `loc ${obj.locId}`})`
  }

  const [selectedAction, setSelectedAction] = useState<number | null>(null)
  // The preview's clock reaches the roll's playhead through an imperative
  // handle, not state: as state it re-rendered this whole page — cast table,
  // areas, camera paths, the lot — ten times a second during playback, for a
  // marker that moves a pixel. ActionRoll registers a setter that writes the
  // element's `left` directly.
  const rollHandle = useRef<{ setPlayCycle: (cycle: number) => void } | null>(null)
  const reportCycle = useCallback((cycle: number) => rollHandle.current?.setPlayCycle(cycle), [])
  // the roll's ruler, and with it the preview's action list and transport:
  // seconds, 600ms game ticks, or the 20ms client cycles the cache stores
  const [rollUnit, setRollUnit] = useState<CutsceneClockUnit>('seconds')
  // The flat action table is a few hundred rows on a real cutscene, and it sits
  // between the roll and everything below it — collapsed unless asked for.
  const [showAllActions, setShowAllActions] = useState(false)
  useEffect(() => { setSelectedAction(null); setShowAllActions(false) }, [def])

  /** Short lane name for the roll — the cast table already carries the detail. */
  const rollEntityName = useCallback((index: number): string => {
    const entity = def.entities[index]
    if (!entity) return `Entity ${index}`
    if (entity.id < 0) return `${index} · Player`
    const name = npcInfo.get(entity.id)?.name
    return name && name !== `NPC ${entity.id}` ? `${index} · ${name}` : `${index} · NPC ${entity.id}`
  }, [def, npcInfo])

  const durationCycles = def.actions.reduce((max, a) => Math.max(max, a.lengthInCycles), 0)

  if (mode === 'edit' && onSave) {
    return (
      <CutsceneEditor
        data={data}
        cacheRoot={cacheRoot ?? null}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        onClose={() => setMode('preview')}
      />
    )
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          <span className="cutscene-title">Cutscene {def.id}</span>
          {onSave && (
            <button type="button" className="field-link-btn" onClick={() => setMode('edit')}>
              Edit cutscene
            </button>
          )}
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {def.id}</span>
          <span className="item-id-badge">viewport {def.viewportWidth}×{def.viewportHeight}</span>
          <span className="item-id-badge">runs {cycleTime(durationCycles)} ({durationCycles} cycles)</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Preview</h3>
        {cacheRoot
          ? <CutscenePlayer def={def} rootHandle={cacheRoot} onCycle={reportCycle} unit={rollUnit} />
          : <p className="cutscene-note">Reopen the cache to play this cutscene.</p>}
      </section>

      <section className="item-section">
        <div className="cutscene-section-head">
          <h3>Timeline — {def.actions.length} actions</h3>
          <span className="btn-pill">
            {CLOCK_UNITS.map((u) => (
              <button
                key={u.key}
                type="button"
                className={`zoom-btn${rollUnit === u.key ? ' active' : ''}`}
                title={u.hint}
                onClick={() => setRollUnit(u.key)}
              >
                {u.label}
              </button>
            ))}
          </span>
        </div>
        <p className="cutscene-note">
          Each mark is one action at the cycle it fires, on the row of whatever it acts on. Click a mark to
          single it out below; click it again to show them all.
        </p>
        <ActionRoll
          def={def}
          entityName={rollEntityName}
          selected={selectedAction}
          onSelect={setSelectedAction}
          handle={rollHandle}
          unit={rollUnit}
        />
        {/* A selected mark always shows its own row — that is what clicking it
            is for — so the collapse only governs the full list. */}
        {selectedAction == null && (
          <button
            type="button"
            className="cutscene-collapse-btn"
            aria-expanded={showAllActions}
            onClick={() => setShowAllActions((v) => !v)}
          >
            {showAllActions ? '▾' : '▸'} {showAllActions ? 'Hide' : 'Show'} the full action list ({def.actions.length})
          </button>
        )}
        {(selectedAction != null || showAllActions) && (
          <div className="quest-table-wrap">
            <table className="quest-table cutscene-timeline">
              <thead><tr><th>Start</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                {def.actions.map((a, i) => (selectedAction != null && selectedAction !== i ? null : (
                  <tr key={i} className={selectedAction === i ? 'linked-hover' : undefined}>
                    <td className="cutscene-time">{cycleTime(a.lengthInCycles)}<span className="cutscene-cycles">{a.lengthInCycles}c</span></td>
                    <td><span className={`cutscene-action-badge cutscene-action-${actionGroup(a.type)}`}>{actionTitle(a.type)}</span></td>
                    <td><ActionRow action={a} entityLabel={entityLabel} objectLabel={objectLabel} def={def} onNavigate={onNavigate} cacheRoot={cacheRoot ?? null} /></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="item-section">
        <h3>Cast — {def.entities.length} entit{def.entities.length === 1 ? 'y' : 'ies'}</h3>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>#</th><th>NPC</th><th>Dev label</th><th></th></tr></thead>
            <tbody>
              {def.entities.map((e) => {
                const info = e.id >= 0 ? npcInfo.get(e.id) : null
                return (
                  <tr key={e.index}>
                    <td>{e.index}</td>
                    <td>
                      <span className="cutscene-def-cell">
                        {info?.icon && <img className="cutscene-def-icon" src={info.icon} alt="" />}
                        {e.id < 0
                          ? 'Player (appearance streamed at runtime)'
                          : info && info.name !== `NPC ${e.id}` ? `${info.name} (${e.id})` : `NPC ${e.id}`}
                      </span>
                    </td>
                    <td className="cutscene-devlabel">{e.name || '—'}</td>
                    <td>
                      {e.id >= 0 && onNavigate && (
                        <button type="button" className="field-link-btn" onClick={() => onNavigate('npcs', e.id)}>View NPC</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {def.objects.length > 0 && (
        <section className="item-section">
          <h3>Objects — {def.objects.length}</h3>
          <div className="quest-table-wrap">
            <table className="quest-table">
              <thead><tr><th>#</th><th>Object</th><th>Shape</th><th></th></tr></thead>
              <tbody>
                {def.objects.map((o, i) => {
                  const info = o.locId >= 0 ? objectInfo.get(o.locId) : null
                  return (
                  <tr key={i}>
                    <td>{i}</td>
                    <td>
                      <span className="cutscene-def-cell">
                        {info?.icon && <img className="cutscene-def-icon" src={info.icon} alt="" />}
                        {info && info.name !== `Object ${o.locId}` ? `${info.name} (${o.locId})` : `Object ${o.locId}`}
                      </span>
                    </td>
                    <td>{o.locShape}</td>
                    <td>
                      {onNavigate && (
                        <button type="button" className="field-link-btn" onClick={() => onNavigate('objects', o.locId)}>View Object</button>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="item-section">
        <h3>Map Areas — {def.areas.length}</h3>
        <p className="cutscene-note">
          Chunks copied from the live map into the cutscene scene: source base tile → destination chunk, like a construction-style dynamic region.
        </p>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead><tr><th>Source (tile, plane)</th><th>Region</th><th>Size (chunks)</th><th>Dest chunk</th><th>Dest plane</th><th>Rotation</th></tr></thead>
            <tbody>
              {def.areas.map((a, i) => (
                <tr key={i}>
                  <td>{a.regionX}, {a.regionY}, plane {a.plane}</td>
                  <td>{(a.regionX >> 6) << 8 | (a.regionY >> 6)}</td>
                  <td>{a.width}×{a.length}</td>
                  <td>{a.chunkBaseX}, {a.chunkBaseY}</td>
                  <td>{a.cutscenePlane}</td>
                  <td>{a.rotation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {def.camMovements.length > 0 && (
        <section className="item-section">
          <h3>Camera Paths — {def.camMovements.length}</h3>
          {def.camMovements.map((cam, i) => (
            <details key={i} className="cutscene-details">
              <summary>
                <span className="cutscene-path-swatch" style={{ background: PATH_COLORS[i % PATH_COLORS.length] }} />
                Path {i} — {cam.xPositions.length} keyframe{cam.xPositions.length === 1 ? '' : 's'}
              </summary>
              <div className="quest-table-wrap">
                <table className="quest-table">
                  <thead><tr><th>#</th><th>Position (x, z, height)</th><th>Look at (x, z, height)</th><th>Timestamp</th></tr></thead>
                  <tbody>
                    {cam.xPositions.map((_, k) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{cam.xPositions[k]}, {cam.zPositions[k]}, {cam.yPositions[k]}</td>
                        <td>{cam.targetXPositions[k]}, {cam.targetZPositions[k]}, {cam.targetYPositions[k]}</td>
                        <td>{cam.timestamps[k]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </section>
      )}

      {def.movements.length > 0 && (
        <section className="item-section">
          <h3>Walk Routes — {def.movements.length}</h3>
          {def.movements.map((m, i) => (
            <details key={i} className="cutscene-details">
              <summary>
                <span className="cutscene-path-swatch cutscene-path-swatch-dotted" style={{ background: PATH_COLORS[i % PATH_COLORS.length] }} />
                Route {i} — {m.movementTypes.length} step{m.movementTypes.length === 1 ? '' : 's'}
              </summary>
              <div className="quest-table-wrap">
                <table className="quest-table">
                  <thead><tr><th>#</th><th>Tile</th><th>Pace</th></tr></thead>
                  <tbody>
                    {m.movementTypes.map((t, k) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{m.bitpackedPositions[k] >>> 16}, {m.bitpackedPositions[k] & 0xffff}</td>
                        <td>{moveTypeName(t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </section>
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Action roll — the timeline as lanes over cycles, reading the same way as the
// music page's piano roll: subject down the side, time across, one mark per
// event. A 342-action cutscene as a flat table is unreadable; laid out this way
// you can see the camera cut while an entity is mid-walk, which is the thing
// you actually want to know.
// ---------------------------------------------------------------------------

/** Which row an action belongs to. Actions name their subject through one of
 *  several different fields — targetIndex, entityIndex, objectIndex, locIndex —
 *  so this is the single place that has to know all of them. */
function actionLane(a: CutsceneActionDef, entityName: (i: number) => string): { key: string; label: string; order: number } {
  const f = (a.fields ?? {}) as Record<string, number>
  const entity = f.targetIndex ?? f.entityIndex
  if (entity != null) return { key: `e${entity}`, label: entityName(entity), order: 100 + entity }
  if (a.type.includes('CAMERA')) return { key: 'camera', label: 'Camera', order: 0 }
  if (a.type.includes('OBJECT')) return { key: 'object', label: 'Objects', order: 300 }
  if (a.type.startsWith('PLAY_')) return { key: 'sound', label: 'Sound', order: 400 }
  return { key: 'scene', label: 'Scene', order: 500 }
}

/** Mark width in px, mirrored in .cutscene-roll-mark. The fan spacing derives
 *  from it plus a real 3px gap: marks sit at a PERCENTAGE offset, so a 1px gap
 *  lands on a different sub-pixel remainder per pile and rounds away on some
 *  of them — which is why some piles looked touching and others didn't. */
const MARK_W = 9

function ActionRoll({ def, entityName, selected, onSelect, handle, unit }: {
  def: CutsceneDef
  entityName: (index: number) => string
  selected: number | null
  onSelect: (index: number | null) => void
  /** The preview writes its clock here. Deliberately imperative — see the note
   *  at the call site; a state prop re-rendered the whole page per update. */
  handle: React.RefObject<{ setPlayCycle: (cycle: number) => void } | null>
  /** what the ruler counts in — seconds, 600ms game ticks, or raw cycles */
  unit: CutsceneClockUnit
}) {
  const playheadRef = useRef<HTMLDivElement>(null)
  const { lanes, laneOf, stackAt, maxCycle } = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; order: number }>()
    const laneOf: string[] = []
    // Actions routinely share a lane AND a cycle — an entity is placed and
    // told to walk on the same tick — and drawn at the same x they hide each
    // other exactly. That is how cutscene 0's spawn of Saradomin looked
    // missing. Each coincident mark gets a small nudge so the pile is visible.
    const stackAt: number[] = []
    const seen = new Map<string, number>()
    let maxCycle = 0
    for (const a of def.actions) {
      const lane = actionLane(a, entityName)
      if (!byKey.has(lane.key)) byKey.set(lane.key, lane)
      laneOf.push(lane.key)
      const slot = `${lane.key}@${a.lengthInCycles}`
      const n = seen.get(slot) ?? 0
      stackAt.push(n)
      seen.set(slot, n + 1)
      if (a.lengthInCycles > maxCycle) maxCycle = a.lengthInCycles
    }
    return {
      lanes: [...byKey.values()].sort((x, y) => x.order - y.order),
      laneOf,
      stackAt,
      maxCycle: Math.max(1, maxCycle),
    }
  }, [def, entityName])

  // Everything except the playhead, built once and reused while playback moves.
  // The playhead updates ~10× a second and this is 341 marks plus their lanes
  // in cutscene 11 — without the memo, reconciling all of them was a
  // significant slice of every frame. Nothing in here depends on playCycle.
  const grid = useMemo(() => {
    // Aim for a dozen gridlines however long the cutscene is, snapped to the
    // displayed unit's own granularity (50 cycles to a second, 30 to a tick) so
    // every label comes out a whole number rather than 1.7t, 3.3t, 5t…
    const gran = clockGranularity(unit)
    const step = Math.max(gran, Math.ceil(maxCycle / 12 / gran) * gran)
    const ticks: number[] = []
    for (let c = 0; c <= maxCycle; c += step) ticks.push(c)
    return (
      <>
        <div className="cutscene-roll-ticks">
          {ticks.map((c, i) => (
            <span
              key={c}
              className="cutscene-roll-tick"
              style={{
                left: `${(c / maxCycle) * 100}%`,
                // centred by default, but the end ones are anchored inward:
                // a centred 0s hangs half off the grid and vanishes under the
                // pinned lane labels, which is why it read as a bare "s"
                transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {clockShort(c, unit)}
            </span>
          ))}
        </div>
        {lanes.map((l) => (
          <div key={l.key} className="cutscene-roll-lane">
            {ticks.map((c) => (
              <span key={c} className="cutscene-roll-gridline" style={{ left: `${(c / maxCycle) * 100}%` }} />
            ))}
            {def.actions.map((a, i) => (laneOf[i] === l.key ? ((): React.ReactNode => {
              const frac = a.lengthInCycles / maxCycle
              // A mark is 9px wide and normally centred on its cycle, but at the
              // very ends that hangs it outside the grid — at 0 it slid under
              // the pinned lane labels, which is why the first actions looked
              // absent. Anchor the ends inward, and fan a pile away from the
              // edge rather than through it.
              const atStart = frac <= 0
              const atEnd = frac >= 1
              const base = atStart ? 0 : atEnd ? -MARK_W : -MARK_W / 2
              // step by the full mark width plus a hairline: at less than the
              // width each mark covered part of the one before it, so only the
              // last in a pile looked full size
              const nudge = stackAt[i] * (MARK_W + 3) * (atEnd ? -1 : 1)
              return (
              <button
                key={i}
                type="button"
                className={`cutscene-roll-mark cutscene-action-${actionGroup(a.type)}${stackAt[i] % 2 === 1 ? ' alt' : ''}${selected === i ? ' selected' : ''}`}
                style={{ left: `${frac * 100}%`, marginLeft: `${base + nudge}px` }}
                title={`${clockShort(a.lengthInCycles, unit)} — ${actionTitle(a.type)}`}
                onClick={() => onSelect(selected === i ? null : i)}
              />
              )
            })() : null))}
          </div>
        ))}
      </>
    )
  }, [def, lanes, laneOf, stackAt, maxCycle, selected, onSelect, unit])

  useEffect(() => {
    handle.current = {
      setPlayCycle: (cycle) => {
        const el = playheadRef.current
        if (!el) return
        // hidden at 0 rather than parked on the left edge, which read as an
        // event at cycle 0
        el.style.display = cycle > 0 ? '' : 'none'
        el.style.left = `${Math.min(100, (cycle / maxCycle) * 100)}%`
      },
    }
    return () => { handle.current = null }
  }, [handle, maxCycle])

  if (lanes.length === 0) return <p className="cutscene-note">No actions.</p>

  return (
    <div className="cutscene-roll">
      <div className="cutscene-roll-side">
        <div className="cutscene-roll-corner" />
        {lanes.map((l) => <div key={l.key} className="cutscene-roll-lane-label">{l.label}</div>)}
      </div>
      <div className="cutscene-roll-grid">
        <div ref={playheadRef} className="cutscene-roll-playhead" style={{ display: 'none' }} />
        {grid}
      </div>
    </div>
  )
}

function actionTitle(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ')
}

/** Badge colour family per action category. */
function actionGroup(type: string): string {
  if (type.includes('CAMERA')) return 'camera'
  if (type.includes('MOVEMENT') || type === 'ROTATE_CUTSCENE_ENTITY' || type === 'RESET_CUTSCENE_ENTITY') return 'entity'
  if (type.includes('OBJECT')) return 'object'
  if (type.startsWith('PLAY_')) return 'sound'
  if (type.includes('GFX') || type.startsWith('PROJECTILE')) return 'gfx'
  if (type === 'FINISHED') return 'end'
  return 'misc'
}

/**
 * Cross-entry jumps offered by an action, rendered as a row UNDER its
 * description rather than trailed inline — inline they got lost in the prose,
 * and an action with two of them (an entity playing an animation has both an
 * NPC and a sequence) read as a run-on sentence.
 *
 * Entity-based actions all resolve their NPC through the cast: the action
 * carries a cast index, and `def.entities[index].id` is the npc id. A negative
 * id is the player, whose appearance streams from the server, so there is
 * nothing to link to.
 */
function actionLinks(action: CutsceneActionDef, def: CutsceneDef): { entry: string; id: number; label: string }[] {
  const f = (action.fields ?? {}) as Record<string, number>
  const links: { entry: string; id: number; label: string }[] = []

  const addEntity = (castIndex: number | undefined) => {
    if (castIndex == null) return
    const npcId = def.entities[castIndex]?.id
    if (npcId != null && npcId >= 0) links.push({ entry: 'npcs', id: npcId, label: 'View NPC' })
  }
  const addObject = (objectIndex: number | undefined) => {
    if (objectIndex == null) return
    const locId = def.objects[objectIndex]?.locId
    if (locId != null && locId >= 0) links.push({ entry: 'objects', id: locId, label: 'View Object' })
  }

  // every field an action can name its entity through
  addEntity(f.targetIndex ?? f.entityIndex ?? f.cutsceneEntityPtr)

  switch (action.type) {
    case 'ANIMATE_MOVEMENT':
      links.push({ entry: 'animations', id: f.movementAnimationId, label: 'View Anim' })
      break
    case 'REPLACE_OBJECT':
      addObject(f.locIndex)
      break
    case 'DESTROY_OBJECT':
      addObject(f.cutsceneObjectPtr)
      break
    case 'ANIMATE_OBJECT':
      addObject(f.objectIndex)
      links.push({ entry: 'animations', id: f.sequenceId, label: 'View Anim' })
      break
    case 'ENTITY_GFX':
    case 'POSITIONED_GFX':
      links.push({ entry: 'spot_animations', id: f.gfxId, label: 'View GFX' })
      break
    case 'PROJECTILE_HOMING':
    case 'PROJECTILE_TO_COORD':
    case 'PROJECTILE_FROM_COORD':
    case 'PROJECTILE_BETWEEN_COORDS':
      addEntity(f.sourceEntityIndex)
      addEntity(f.targetEntityIndex)
      links.push({ entry: 'spot_animations', id: f.gfxId, label: 'View GFX' })
      break
    case 'PLAY_SONG':
      links.push({ entry: 'music', id: f.musicId, label: 'View Music' })
      break
    case 'PLAY_SYNTH':
      links.push({ entry: 'sound_effects', id: f.soundId, label: 'View Sound' })
      break
    case 'PLAY_VORBIS':
      links.push({ entry: 'midi_instruments', id: f.soundId, label: 'View Sample' })
      break
    default:
      break
  }

  // an entity can appear twice (a projectile from A to A), and a duplicate
  // button is just noise
  const seen = new Set<string>()
  return links.filter((l) => {
    if (l.id == null || l.id < 0) return false
    const key = `${l.entry}:${l.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function ActionRow({ action, entityLabel, objectLabel, def, onNavigate, cacheRoot }: {
  action: CutsceneActionDef
  entityLabel: (index: number) => string
  objectLabel: (index: number) => string
  def: CutsceneDef
  onNavigate?: (entryName: string, itemId: number) => void
  cacheRoot: FileSystemDirectoryHandle | null
}) {
  const links = actionLinks(action, def)
  return (
    <div className="cutscene-detail">
      <ActionDetails action={action} entityLabel={entityLabel} objectLabel={objectLabel} cacheRoot={cacheRoot} />
      {onNavigate && links.length > 0 && (
        <div className="cutscene-detail-links">
          {links.map((l) => (
            <button
              key={`${l.entry}:${l.id}:${l.label}`}
              type="button"
              className="field-link-btn"
              onClick={() => onNavigate(l.entry, l.id)}
            >
              {l.label} {l.id}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// The two label helpers now resolve everything this needs out of the cutscene
// def, so it no longer takes the def itself.
function ActionDetails({ action, entityLabel, objectLabel, cacheRoot }: {
  action: CutsceneActionDef
  entityLabel: (index: number) => string
  objectLabel: (index: number) => string
  cacheRoot: FileSystemDirectoryHandle | null
}) {
  const f = (action.fields ?? {}) as Record<string, number & string>

  switch (action.type) {
    case 'DIRECT_CAMERA_MOVEMENT':
      return <>fly camera along path {f.positionMovementIndex} (from keyframe {f.positionKeyframe}), aiming along path {f.lookAtMovementIndex} (keyframe {f.lookAtKeyframe}), spline speed {f.splineSpeedStart} → {f.splineSpeedEnd}</>
    case 'UNCENTERED_CAMERA_MOVEMENT':
      return <>place camera at local ({f.localX}, {f.localY}) height {f.moveZ}, facing angleX {f.angleX} angleY {f.angleY}</>
    case 'MOVEMENT':
      return <>place {entityLabel(f.targetIndex)} at tile ({f.x}, {f.y}) plane {f.plane}, facing {angleDeg(((f.direction as number) + 16384) % 16384)}</>
    case 'BASIC_MOVEMENT':
      return <>walk {entityLabel(f.entityIndex)} along route {f.movementIndex} on plane {f.plane}</>
    case 'ANIMATE_MOVEMENT':
      return <>
        {entityLabel(f.entityIndex)} plays animation {f.movementAnimationId}{(f.seqFlag as number) !== 0 ? ` (flag ${f.seqFlag})` : ' (as movement anims)'}
      </>
    case 'RESET_CUTSCENE_ENTITY':
      return <>remove {entityLabel(f.entityIndex)} from the scene</>
    case 'ROTATE_CUTSCENE_ENTITY':
      return <>turn {entityLabel(f.cutsceneEntityPtr)} to {angleDeg(f.rotation as number)}</>
    case 'REPLACE_OBJECT':
      return <>
        spawn {objectLabel(f.locIndex)} at tile ({f.x}, {f.y}) plane {f.plane}, rotation {f.rotation}
      </>
    case 'DESTROY_OBJECT':
      return <>remove {objectLabel(f.cutsceneObjectPtr)}</>
    case 'ANIMATE_OBJECT':
      return <>
        {objectLabel(f.objectIndex)} plays animation {f.sequenceId}
      </>
    case 'ENTITY_GFX':
      return <>
        {entityLabel(f.targetIndex)} shows gfx {f.gfxId} (slot {f.spotAnimationIndex}, height {f.displayHeight}, rotation {f.rotation})
      </>
    case 'POSITIONED_GFX':
      return <>
        gfx {f.gfxId} at tile ({f.x}, {f.y}) plane {f.plane} (height {f.displayHeight}, rotation {f.rotation})
      </>
    case 'PLAY_SONG':
      return <>
        play music track {f.musicId} at volume {f.volume}
        {cacheRoot && <SongPlayerCell cacheRoot={cacheRoot} musicId={f.musicId as number} />}
      </>
    case 'PLAY_JINGLE':
      return <>play jingle {f.jingleId} at volume {f.volume}</>
    case 'PLAY_SYNTH':
      return <>
        <span className="cutscene-sound-row">
          play synth sound {f.soundId} (volume {f.volume}, rate {f.sampleRate}, repeats {f.timesRepeated})
          {cacheRoot && <SoundPlayerCell cacheRoot={cacheRoot} soundId={f.soundId as number} />}
        </span>
      </>
    case 'PLAY_VORBIS':
      // "Vorbis" is the FORMAT, not an index: the client sends these through
      // AreaSound type 2, which `spoken()` routes to midi_instruments (index
      // 14) — not the empty index 36. All 81 distinct ids resolve there.
      return <>
        play sample {f.soundId} (volume {f.volume}, rate {f.sampleRate}, repeats {f.timesRepeated})
        {cacheRoot && <InstrumentPlayerCell cacheRoot={cacheRoot} soundId={f.soundId as number} label={`sample ${f.soundId}`} />}
      </>
    case 'FADE_SCREEN': {
      const argb = (f.fadeScreenColor as number) >>> 0
      const alpha = argb >>> 24
      const rgb = `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`
      return <>
        fade screen to <span className="pair-swatch" style={{ background: rgb }} /> {rgb} (alpha {alpha}) over {f.fadeDurationCycles} cycles ({cycleTime(f.fadeDurationCycles as number)})
      </>
    }
    case 'SET_HINT_DETAILS':
      return <>hint arrow on {entityLabel(f.entityIndex)}: “{f.text}” (color {f.colorType}, {f.duration} cycles)</>
    case 'TILE_MESSAGE':
      return <>message at tile ({f.absX}, {f.absY}): “{f.minimenuText}” for {f.cycleDuration} cycles</>
    case 'SET_VARIABLE':
      return <>set cutscene varp {f.key} = {f.value}</>
    case 'SET_BIT_VARIABLE':
      return <>set cutscene varbit {f.key} = {f.value}</>
    case 'EXECUTE_SCRIPT':
      // Both fields are ARGUMENTS, not identifiers: the client resolves the
      // script from the cutscene itself — it scans the CS2 index for the
      // archive whose 32-bit nameHash equals `20 | cutsceneId << 10` (trigger
      // RUN_CUTSCENE_SCRIPT = 20) — and hands it these as its first string and
      // int locals. See EDITOR.md; the dump drops those hashes, so we can't
      // name the script.
      return <>
        run this cutscene’s script with “{f.scriptStringParam}” and {f.scriptIntParam}
      </>
    case 'APPLY_HITMARK':
      return <>
        hit {entityLabel(f.entityIndex)}{f.hitsplatId != null ? <> — hitsplat {f.hitsplatId} showing {f.hitText}</> : null}
        {f.soakHitsplatId != null ? <>, soak {f.soakHitsplatId} showing {f.soakText}</> : null}
        {f.currentHealth != null ? <>, health {f.currentHealth}/{f.maxHealth}</> : null}
      </>
    case 'PROJECTILE_HOMING':
    case 'PROJECTILE_TO_COORD':
    case 'PROJECTILE_FROM_COORD':
    case 'PROJECTILE_BETWEEN_COORDS': {
      const from = f.sourceEntityIndex != null ? entityLabel(f.sourceEntityIndex) : `tile (${f.startTileX}, ${f.startTileY})`
      const to = f.targetEntityIndex != null ? entityLabel(f.targetEntityIndex) : `tile (${f.endTileX}, ${f.endTileY})`
      return <>
        projectile gfx {f.gfxId} from {from} to {to} over {f.duration} cycles (heights {f.startHeight}→{f.endHeight}, angle {f.angle}, slope {f.slope})
      </>
    }
    case 'FINISHED':
      return <>end of cutscene — client tells the server to exit</>
    default:
      return <>{JSON.stringify(action.fields ?? {})}</>
  }
}

// ---------------------------------------------------------------------------
