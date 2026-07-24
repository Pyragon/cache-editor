import { useEffect, useMemo, useRef, useState } from 'react'
import type { CutsceneActionDef, CutsceneData, CutsceneDef } from '../loaders/cutscenes'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getNpcIcon, peekNpcIcon } from './npcSnapshot'
import { SoundPlayerCell } from './SoundPlayerCell'
import CutscenePlayerModal from './CutscenePlayerModal'
import './CutsceneViewer.css'

type Props = {
  data: CutsceneData
  onNavigate?: (entryName: string, itemId: number) => void
  cacheRoot?: FileSystemDirectoryHandle | null
}

// One clear colour per camera path / entity movement on the overview canvas.
const PATH_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#81c784', '#f06292', '#a1887f', '#90a4ae', '#fff176']

const cycleTime = (cycles: number) => `${(cycles * 0.02).toFixed(1)}s`

/** 0..16383 client angle units → compass degrees. */
const angleDeg = (angle: number) => `${Math.round((angle % 16384) / 16384 * 360)}°`

const MOVE_TYPE_NAMES: Record<number, string> = { 0: 'half walk', 2: 'run' }
const moveTypeName = (t: number) => MOVE_TYPE_NAMES[t] ?? 'walk'

type NpcInfo = { name: string; icon: string | null }

export default function CutsceneViewer({ data, onNavigate, cacheRoot }: Props) {
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
  const [npcInfo, setNpcInfo] = useState<Map<number, NpcInfo>>(new Map())
  useEffect(() => {
    if (!cacheRoot) return
    let cancelled = false
    const ids = [...new Set(def.entities.map((e) => e.id).filter((id) => id >= 0))]
    ;(async () => {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath('npcs'))
      if (!dir) return
      for (const id of ids) {
        try {
          const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
          const npcDef = JSON.parse(await file.text()) as Record<string, unknown>
          const name = typeof npcDef.name === 'string' && npcDef.name !== 'null' ? npcDef.name : `NPC ${id}`
          const icon = peekNpcIcon(id) ?? await getNpcIcon(cacheRoot, id, npcDef)
          if (cancelled) return
          setNpcInfo((prev) => new Map(prev).set(id, { name, icon }))
        } catch { /* NPC def unreadable — the id link still works */ }
      }
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

  const durationCycles = def.actions.reduce((max, a) => Math.max(max, a.lengthInCycles), 0)
  const [playerOpen, setPlayerOpen] = useState(false)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          <span className="cutscene-title">Cutscene {def.id}</span>
          {cacheRoot && (
            <button type="button" className="zoom-btn anim-preview-play" onClick={() => setPlayerOpen(true)}>
              ▶ Play Cutscene
            </button>
          )}
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {def.id}</span>
          <span className="item-id-badge">viewport {def.viewportWidth}×{def.viewportHeight}</span>
          <span className="item-id-badge">runs {cycleTime(durationCycles)} ({durationCycles} cycles)</span>
        </div>
      </div>

      {playerOpen && cacheRoot && (
        <CutscenePlayerModal def={def} rootHandle={cacheRoot} onClose={() => setPlayerOpen(false)} />
      )}

      <section className="item-section">
        <h3>Scene Overview</h3>
        <p className="cutscene-note">
          Camera paths (solid) with their look-at targets (dashed), and entity walk routes (dotted lines with step markers), in scene tile coordinates.
        </p>
        <SceneCanvas def={def} />
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
                      <span className="cutscene-npc-cell">
                        {info?.icon && <img className="cutscene-npc-icon" src={info.icon} alt="" />}
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
                {def.objects.map((o, i) => (
                  <tr key={i}>
                    <td>{i}</td>
                    <td>{o.locId}</td>
                    <td>{o.locShape}</td>
                    <td>
                      {onNavigate && (
                        <button type="button" className="field-link-btn" onClick={() => onNavigate('objects', o.locId)}>View Object</button>
                      )}
                    </td>
                  </tr>
                ))}
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

      <section className="item-section">
        <h3>Timeline — {def.actions.length} actions</h3>
        <div className="quest-table-wrap">
          <table className="quest-table cutscene-timeline">
            <thead><tr><th>Start</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {def.actions.map((a, i) => (
                <tr key={i}>
                  <td className="cutscene-time">{cycleTime(a.lengthInCycles)}<span className="cutscene-cycles">{a.lengthInCycles}c</span></td>
                  <td><span className={`cutscene-action-badge cutscene-action-${actionGroup(a.type)}`}>{actionTitle(a.type)}</span></td>
                  <td><ActionDetails action={a} entityLabel={entityLabel} def={def} onNavigate={onNavigate} cacheRoot={cacheRoot ?? null} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------

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

function ActionDetails({ action, entityLabel, def, onNavigate, cacheRoot }: {
  action: CutsceneActionDef
  entityLabel: (index: number) => string
  def: CutsceneDef
  onNavigate?: (entryName: string, itemId: number) => void
  cacheRoot: FileSystemDirectoryHandle | null
}) {
  const f = (action.fields ?? {}) as Record<string, number & string>
  const link = (entry: string, id: number, label: string) => onNavigate
    ? <button type="button" className="field-link-btn" onClick={() => onNavigate(entry, id)}>{label}</button>
    : <>{label}</>

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
        {entityLabel(f.entityIndex)} plays animation {f.movementAnimationId}{(f.seqFlag as number) !== 0 ? ` (flag ${f.seqFlag})` : ' (as movement anims)'}{' '}
        {link('animations', f.movementAnimationId as number, 'View Anim')}
      </>
    case 'RESET_CUTSCENE_ENTITY':
      return <>remove {entityLabel(f.entityIndex)} from the scene</>
    case 'ROTATE_CUTSCENE_ENTITY':
      return <>turn {entityLabel(f.cutsceneEntityPtr)} to {angleDeg(f.rotation as number)}</>
    case 'REPLACE_OBJECT': {
      const obj = def.objects[f.locIndex as number]
      return <>
        spawn object #{f.locIndex}{obj ? ` (loc ${obj.locId})` : ''} at tile ({f.x}, {f.y}) plane {f.plane}, rotation {f.rotation}{' '}
        {obj && link('objects', obj.locId, 'View Object')}
      </>
    }
    case 'DESTROY_OBJECT': {
      const obj = def.objects[f.cutsceneObjectPtr as number]
      return <>remove object #{f.cutsceneObjectPtr}{obj ? ` (loc ${obj.locId})` : ''} {obj && link('objects', obj.locId, 'View Object')}</>
    }
    case 'ANIMATE_OBJECT': {
      const obj = def.objects[f.objectIndex as number]
      return <>
        object #{f.objectIndex}{obj ? ` (loc ${obj.locId})` : ''} plays animation {f.sequenceId}{' '}
        {link('animations', f.sequenceId as number, 'View Anim')}
      </>
    }
    case 'ENTITY_GFX':
      return <>
        {entityLabel(f.targetIndex)} shows gfx {f.gfxId} (slot {f.spotAnimationIndex}, height {f.displayHeight}, rotation {f.rotation}){' '}
        {link('spot_animations', f.gfxId as number, 'View GFX')}
      </>
    case 'POSITIONED_GFX':
      return <>
        gfx {f.gfxId} at tile ({f.x}, {f.y}) plane {f.plane} (height {f.displayHeight}, rotation {f.rotation}){' '}
        {link('spot_animations', f.gfxId as number, 'View GFX')}
      </>
    case 'PLAY_SONG':
      return <>play music track {f.musicId} at volume {f.volume} {link('music', f.musicId as number, 'View Music')}</>
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
      return <>play vorbis sound {f.soundId} (volume {f.volume}, rate {f.sampleRate}, repeats {f.timesRepeated}) — vorbis index isn't dumped, no preview</>
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
      return <>run cutscene script hook “{f.scriptStringParam}” with arg {f.scriptIntParam}</>
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
        projectile gfx {f.gfxId} from {from} to {to} over {f.duration} cycles (heights {f.startHeight}→{f.endHeight}, angle {f.angle}, slope {f.slope}){' '}
        {link('spot_animations', f.gfxId as number, 'View GFX')}
      </>
    }
    case 'FINISHED':
      return <>end of cutscene — client tells the server to exit</>
    default:
      return <>{JSON.stringify(action.fields ?? {})}</>
  }
}

// ---------------------------------------------------------------------------

/** Top-down plot of camera paths (fine coords /512 = tiles) and walk routes. */
function SceneCanvas({ def }: { def: CutsceneDef }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Gather every point in tile units to find the bounds.
    const points: { x: number; y: number }[] = []
    for (const cam of def.camMovements) {
      for (let i = 0; i < cam.xPositions.length; i++) {
        points.push({ x: cam.xPositions[i] / 512, y: cam.zPositions[i] / 512 })
        points.push({ x: cam.targetXPositions[i] / 512, y: cam.targetZPositions[i] / 512 })
      }
    }
    for (const m of def.movements) {
      for (const p of m.bitpackedPositions) points.push({ x: p >>> 16, y: p & 0xffff })
    }
    const W = 480
    const H = 360
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    if (points.length === 0) {
      ctx.fillStyle = '#8a8a94'
      ctx.font = '13px sans-serif'
      ctx.fillText('No camera paths or walk routes to plot.', 16, 24)
      return
    }

    const pad = 2
    const minX = Math.min(...points.map((p) => p.x)) - pad
    const maxX = Math.max(...points.map((p) => p.x)) + pad
    const minY = Math.min(...points.map((p) => p.y)) - pad
    const maxY = Math.max(...points.map((p) => p.y)) + pad
    const scale = Math.min(W / (maxX - minX), H / (maxY - minY))
    const ox = (W - (maxX - minX) * scale) / 2
    const oy = (H - (maxY - minY) * scale) / 2
    // Game north (+y) points up: flip the canvas y axis.
    const px = (x: number) => ox + (x - minX) * scale
    const py = (y: number) => H - oy - (y - minY) * scale

    // Tile grid every 8 tiles (one chunk).
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let gx = Math.ceil(minX / 8) * 8; gx <= maxX; gx += 8) {
      ctx.beginPath(); ctx.moveTo(px(gx), 0); ctx.lineTo(px(gx), H); ctx.stroke()
    }
    for (let gy = Math.ceil(minY / 8) * 8; gy <= maxY; gy += 8) {
      ctx.beginPath(); ctx.moveTo(0, py(gy)); ctx.lineTo(W, py(gy)); ctx.stroke()
    }

    // Walk routes: dotted lines with a dot per step.
    def.movements.forEach((m, i) => {
      const color = PATH_COLORS[i % PATH_COLORS.length]
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.setLineDash([2, 3])
      ctx.lineWidth = 1.5
      ctx.beginPath()
      m.bitpackedPositions.forEach((p, k) => {
        const x = px(p >>> 16)
        const y = py(p & 0xffff)
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.setLineDash([])
      m.bitpackedPositions.forEach((p) => {
        ctx.beginPath()
        ctx.arc(px(p >>> 16), py(p & 0xffff), 3, 0, Math.PI * 2)
        ctx.fill()
      })
    })

    // Camera paths: solid position spline, dashed look-at line, numbered keyframes.
    def.camMovements.forEach((cam, i) => {
      const color = PATH_COLORS[i % PATH_COLORS.length]
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.beginPath()
      cam.xPositions.forEach((x, k) => {
        const cx = px(x / 512)
        const cy = py(cam.zPositions[k] / 512)
        if (k === 0) ctx.moveTo(cx, cy)
        else ctx.lineTo(cx, cy)
      })
      ctx.stroke()

      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      cam.targetXPositions.forEach((x, k) => {
        const cx = px(x / 512)
        const cy = py(cam.targetZPositions[k] / 512)
        if (k === 0) ctx.moveTo(cx, cy)
        else ctx.lineTo(cx, cy)
      })
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = color
      cam.xPositions.forEach((x, k) => {
        const cx = px(x / 512)
        const cy = py(cam.zPositions[k] / 512)
        ctx.beginPath()
        ctx.arc(cx, cy, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#111'
        ctx.font = 'bold 8px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(k), cx, cy)
        ctx.fillStyle = color
      })
    })
  }, [def])

  return <canvas ref={canvasRef} className="cutscene-map-canvas" style={{ width: 480, height: 360 }} />
}
