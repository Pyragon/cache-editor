import { useEffect, useMemo, useRef, useState } from 'react'
import type { InterfaceData } from '../loaders/interfaces'
import { InterfaceAssets } from './interfacePreview'
import type { PreviewOptions } from './interfacePreview'
import {
  EDIT_SLOTS, FIXED_SIZE, RESIZABLE_MIN, loadGameframeScene, modeForRoot, paintGameframe, runGameframeCs2,
} from './gameframe'
import { hitTestComponent, resolveAbsoluteLayout } from './interfacePreview'
import type { GameframeMode, GameframeScene } from './gameframe'
import type { Cs2Warning } from '../cs2/runtime'
import { Cs2Cache } from '../cs2/cache'
import { preparePixelCanvas } from '../pixelScale'
import { onVarOverridesChanged } from '../loaders/varOverrides'
import VarOverridesModal from './VarOverridesModal'
import './GameframePreview.css'

/**
 * "How will this look in game": the interface being edited, rendered inside
 * the real gameframe (root pane 548/746 + chatbox + orbs + tabs, composed
 * exactly as cryogen's InterfaceManager sends them — see interfaces.md), at a
 * viewport the user can resize like a client window. Fixed mode is pinned to
 * the client's 765×553; resizable mode drags from 800×600 up.
 *
 * The edited components come in as the live DRAFT, so field edits show here
 * immediately — including when the interface being edited IS part of the
 * gameframe (548, 746, 752, an orb...).
 */
export default function GameframePreview({ data, assets, opts, selectedId, onSelect }: {
  data: InterfaceData
  assets: InterfaceAssets | null
  opts: PreviewOptions
  /** selected component in the editor — outlined over the composed frame */
  selectedId?: number | null
  /** clicking a component of the edited interface selects it in the editor */
  onSelect?: (componentId: number) => void
}) {
  const [pickedMode, setPickedMode] = useState<GameframeMode>('fixed')
  // Editing a window pane pins the preview to that pane's mode: 548 IS the
  // fixed frame and 746 IS the resizable one, so the other mode would draw
  // the on-disk copy of a different root and hide the edits entirely.
  const pinnedMode = modeForRoot(data.id)
  const mode = pinnedMode ?? pickedMode
  const setMode = setPickedMode
  const [slotKey, setSlotKey] = useState('screen')
  const [size, setSize] = useState({ width: 1024, height: 768 })
  const [status, setStatus] = useState<string | null>('Loading gameframe…')
  const [cs2Enabled, setCs2Enabled] = useState(true)
  const [cs2Warnings, setCs2Warnings] = useState<Cs2Warning[]>([])
  const [showWarnings, setShowWarnings] = useState(false)
  const [showPlayer, setShowPlayer] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<GameframeScene | null>(null)
  const paintGen = useRef(0)
  /** parsed scripts + enum/param data survive across repaints (a resize drag
   *  repaints constantly; only the hook RUN should repeat, not the I/O) */
  const cs2CacheRef = useRef<Cs2Cache | null>(null)
  const paintBusy = useRef(false)
  const paintQueued = useRef(false)
  const dragRef = useRef<{ startX: number; startY: number; baseW: number; baseH: number } | null>(null)
  /** the edited interface's placement + components from the last paint, for
   *  click hit-testing */
  const hitRef = useRef<{ place: { x: number; y: number; w: number; h: number }; comps: (import('../loaders/interfaces').IComponentDefinition | null)[] } | null>(null)

  const viewport = mode === 'fixed' ? FIXED_SIZE : size

  // Page zoom folds into devicePixelRatio. Below 100% the browser has fewer
  // device pixels than the frame needs, so 1px cache detail can't survive the
  // squeeze — say so rather than letting it read as a rendering bug.
  const [pageZoom, setPageZoom] = useState(window.devicePixelRatio || 1)
  useEffect(() => {
    const media = window.matchMedia(`(resolution: ${pageZoom}dppx)`)
    const onChange = () => setPageZoom(window.devicePixelRatio || 1)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [pageZoom])
  const zoomedOut = pageZoom < 1

  // The HUD's CS2 hooks read the simulated player (levels, points, run
  // energy, name), so saving the Variables modal has to re-run them.
  const repaintRef = useRef<() => void>(() => {})
  useEffect(() => onVarOverridesChanged(() => repaintRef.current()), [])

  // Scene assembly depends on mode/slot/draft identity; keyed on the
  // components ARRAY so a field edit (new array from the viewer) reloads.
  const sceneKey = useMemo(() => ({ mode, slotKey, components: data.components, id: data.id }), [mode, slotKey, data.components, data.id])

  useEffect(() => {
    if (!data.rootHandle) { setStatus('No cache folder'); return }
    let cancelled = false
    ;(async () => {
      try {
        const scene = await loadGameframeScene(data.rootHandle!, sceneKey.mode, { id: sceneKey.id, components: sceneKey.components }, sceneKey.slotKey)
        if (cancelled) return
        sceneRef.current = scene
        setStatus(null)
        repaint()
      } catch (e) {
        if (!cancelled) setStatus(`Gameframe failed to load: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, data.rootHandle])

  const repaint = () => {
    // collapse overlapping requests: while a paint is running, remember that
    // another was asked for and run exactly one more when it finishes — a
    // resize drag then repaints at paint-throughput instead of queueing
    // dozens of full CS2 runs
    if (paintBusy.current) { paintQueued.current = true; return }
    const canvas = canvasRef.current
    const scene = sceneRef.current
    if (!canvas || !scene || !assets) return
    paintBusy.current = true
    const gen = ++paintGen.current
    const { width, height } = mode === 'fixed' ? FIXED_SIZE : size
    void (async () => {
      // CS2 first: the mutated clones feed the painter. Painting only starts
      // once the hooks are done, so a stale run can't half-draw.
      let override: Awaited<ReturnType<typeof runGameframeCs2>> | null = null
      if (cs2Enabled && data.rootHandle) {
        try {
          if (!cs2CacheRef.current) cs2CacheRef.current = new Cs2Cache()
          override = await runGameframeCs2(data.rootHandle, scene, mode, width, height, cs2CacheRef.current)
        } catch (e) {
          setStatus(`CS2 run failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      if (gen !== paintGen.current) { paintBusy.current = false; return }
      setCs2Warnings(override?.warnings ?? [])
      // The canvas displays at 1:1 CSS size, so the buffer renders at the
      // device pixel ratio — every drawn pixel maps to a device pixel and
      // nothing is resampled. A fixed 2× buffer looked fine at DPR 1/2 but on
      // fractional display scaling (Windows 125%) the browser's downsample
      // DROPPED single-pixel columns — interface 5's 1px left border vanished
      // by x-position parity. renderScale() also floors the ratio at 1: page
      // zoom folds into devicePixelRatio, and below 100% a raw ratio would
      // shrink the buffer and delete the 1px strokes cache fonts are made of.
      const ctx = preparePixelCanvas(canvas, width, height)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      // no placeholder boxes in the composed frame — the client draws
      // nothing for runtime-filled content in a normal frame
      const placements = await paintGameframe(ctx, assets, scene, width, height, { ...opts, showPlaceholders: false }, override ?? undefined)
      // selection outline: same dashed blue as the flat canvas, drawn where
      // the edited interface's component actually landed in the frame
      {
        const place = placements.get(data.id)
        const comps = override?.interfaces.get(data.id) ?? scene.interfaces.get(data.id)
        hitRef.current = place && comps ? { place, comps } : null
      }
      if (selectedId != null) {
        const place = hitRef.current?.place
        const comps = hitRef.current?.comps
        if (place && comps) {
          const rect = resolveAbsoluteLayout(comps, place.w, place.h).get(selectedId)
          if (rect) {
            ctx.strokeStyle = '#2f8fff'
            ctx.lineWidth = 1.5
            ctx.setLineDash([5, 3])
            ctx.strokeRect(place.x + rect.x + 0.5, place.y + rect.y + 0.5, rect.width, rect.height)
            ctx.setLineDash([])
          }
        }
      }
      paintBusy.current = false
      if (paintQueued.current) {
        paintQueued.current = false
        repaint()
      }
    })()
  }

  // repaint on size/asset/option changes (scene changes repaint via the loader)
  useEffect(() => { repaint() }, [size, mode, assets, cs2Enabled, selectedId, opts.showHidden, opts.showContainerOutlines]) // eslint-disable-line react-hooks/exhaustive-deps

  const onHandleDown = (e: React.PointerEvent) => {
    if (mode === 'fixed') return
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseW: size.width, baseH: size.height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // the canvas displays at CSS half-scale of nothing — it's 1:1 CSS px, so
    // pointer deltas map straight onto viewport units
    setSize({
      width: Math.max(RESIZABLE_MIN.width, Math.round(d.baseW + (e.clientX - d.startX))),
      height: Math.max(RESIZABLE_MIN.height, Math.round(d.baseH + (e.clientY - d.startY))),
    })
  }
  const onHandleUp = () => { dragRef.current = null }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitRef.current
    const canvas = canvasRef.current
    if (!hit || !canvas || !onSelect) return
    const bounds = canvas.getBoundingClientRect()
    const { width, height } = mode === 'fixed' ? FIXED_SIZE : size
    const px = ((e.clientX - bounds.left) / bounds.width) * width - hit.place.x
    const py = ((e.clientY - bounds.top) / bounds.height) * height - hit.place.y
    if (px < 0 || py < 0 || px > hit.place.w || py > hit.place.h) return
    const layout = resolveAbsoluteLayout(hit.comps, hit.place.w, hit.place.h)
    const id = hitTestComponent(hit.comps, layout, px, py, opts.showHidden === true)
    if (id != null) onSelect(id)
  }

  repaintRef.current = repaint

  return (
    <div className="gfp">
      <div className="gfp-toolbar">
        <div className="gfp-modes">
          <button
            className={mode === 'fixed' ? 'selected' : ''}
            disabled={pinnedMode != null}
            title={pinnedMode ? `Interface ${data.id} is the ${pinnedMode} window pane, so the mode follows it` : undefined}
            onClick={() => setMode('fixed')}
          >Fixed 765×553</button>
          <button
            className={mode === 'resizable' ? 'selected' : ''}
            disabled={pinnedMode != null}
            title={pinnedMode ? `Interface ${data.id} is the ${pinnedMode} window pane, so the mode follows it` : undefined}
            onClick={() => setMode('resizable')}
          >Resizable</button>
        </div>
        {mode === 'resizable' && (
          <div className="gfp-presets">
            {[[800, 600], [1024, 768], [1280, 720], [1600, 900]].map(([w, h]) => (
              <button key={`${w}x${h}`} className={size.width === w && size.height === h ? 'selected' : ''} onClick={() => setSize({ width: w, height: h })}>{w}×{h}</button>
            ))}
            <span className="gfp-size">{size.width}×{size.height}</span>
          </div>
        )}
        {pinnedMode ? (
          <span className="gfp-root-note">
            window pane — the frame itself, not placed in a slot
          </span>
        ) : (
        <div className="gfp-slot-pills" title="Where the interface is shown — the client decides this by which packet sends it (sendTab / sendChatBoxInterface / sendInterface / setOverlay), not by anything in the data">
          {EDIT_SLOTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={slotKey === s.key ? 'selected' : ''}
              onClick={() => setSlotKey(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        )}
        <label className="gfp-cs2">
          <input type="checkbox" checked={cs2Enabled} onChange={(e) => setCs2Enabled(e.target.checked)} />
          CS2 hooks
        </label>
        {cs2Enabled && cs2Warnings.length > 0 && (
          <button type="button" className="gfp-cs2-warnings" onClick={() => setShowWarnings((v) => !v)}>
            {cs2Warnings.reduce((n, w) => n + w.count, 0)} stubbed CS2 calls ({cs2Warnings.length} ops)
          </button>
        )}
        <button
          type="button"
          className="gfp-player-btn"
          title="The simulated player the HUD scripts read — levels, life/prayer points, run energy, display name"
          onClick={() => setShowPlayer(true)}
        >
          Player…
        </button>
        {zoomedOut && (
          <span className="gfp-zoom-warning" title="The browser has fewer device pixels than the frame needs, so 1px strokes (cache font glyphs, borders) get resampled. The client always draws 1:1 — reset zoom to compare accurately.">
            page zoom {Math.round(pageZoom * 100)}% — not pixel-accurate
          </span>
        )}
      </div>
      {showWarnings && cs2Warnings.length > 0 && (
        <div className="gfp-warning-list">
          {cs2Warnings.slice(0, 40).map((w) => (
            <div key={w.op} className="gfp-warning-row">
              <span className="gfp-warning-op">{w.op}</span>
              <span className="gfp-warning-count">×{w.count}</span>
              <span className="gfp-warning-example">{w.example}</span>
            </div>
          ))}
        </div>
      )}
      <div className="gfp-stage">
        <div className="gfp-frame" style={{ width: viewport.width, height: viewport.height }}>
          <canvas ref={canvasRef} className="gfp-canvas" style={{ width: viewport.width, height: viewport.height }} onClick={onCanvasClick} />
          {mode === 'resizable' && (
            <div
              className="gfp-resize-handle"
              title="Drag to resize the client"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
          )}
          {status && <div className="gfp-status">{status}</div>}
        </div>
      </div>
      {showPlayer && <VarOverridesModal onClose={() => setShowPlayer(false)} />}
    </div>
  )
}
