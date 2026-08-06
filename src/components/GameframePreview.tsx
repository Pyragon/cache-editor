import { useEffect, useMemo, useRef, useState } from 'react'
import type { InterfaceData, IComponentDefinition } from '../loaders/interfaces'
import { InterfaceAssets } from './interfacePreview'
import type { PreviewOptions } from './interfacePreview'
import {
  CLIENT_CYCLE_MS, EDIT_SLOTS, FIXED_SIZE, RESIZABLE_MIN, applyGameframeHover, censusHooks,
  hasHoverHook, hasPerCycleHook, hoverTargets, loadGameframeScene, modeForRoot, paintGameframe,
  runGameframeCs2,
} from './gameframe'
import { hitTestComponent, resolveAbsoluteLayout } from './interfacePreview'
import { dragToBasePosition, parentBoxOf } from './ifaceDrag'
import type { SnapGuide } from './ifaceDrag'
import type {
  Cs2VarRoute, GameframeMode, GameframePointer, GameframeRegion, GameframeRun, GameframeScene,
  HoverTarget,
} from './gameframe'
import type { Cs2SceneSnapshot, Cs2TraceEntry, Cs2Warning } from '../cs2/runtime'
import { Cs2Cache } from '../cs2/cache'
import { preparePixelCanvas } from '../pixelScale'
import { onVarOverridesChanged } from '../loaders/varOverrides'
import VarOverridesModal from './VarOverridesModal'
import Cs2Console from './Cs2Console'
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
/** Client cycles the hover ticker runs before giving up, per hover change.
 *  ~3s — the tooltip delay it exists for is around 24. */
const TICK_BUDGET = 150

export default function GameframePreview({ data, assets, opts, selectedId, onSelect, onEditScript, snap, onMoveComponent }: {
  data: InterfaceData
  assets: InterfaceAssets | null
  opts: PreviewOptions
  /** selected component in the editor — outlined over the composed frame */
  selectedId?: number | null
  /** clicking a component of the edited interface selects it in the editor */
  onSelect?: (componentId: number) => void
  /** leave for the cs2 entry to edit a script the console links to */
  onEditScript?: (scriptId: number) => void
  /** snap dragging to parent/sibling edges — one toggle governs both previews */
  snap?: boolean
  /** a drag wrote new aspect-mode-correct base coordinates */
  onMoveComponent?: (componentId: number, basePositionX: number, basePositionY: number) => void
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
  const [cs2Trace, setCs2Trace] = useState<Cs2TraceEntry[]>([])
  const [cs2Routes, setCs2Routes] = useState<Cs2VarRoute[]>([])
  const [showPlayer, setShowPlayer] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** selection outline only, layered over the frame — see `drawSelection` */
  const overlayRef = useRef<HTMLCanvasElement>(null)
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
  /** every painted interface from the last paint, for pointer hit-testing
   *  across the WHOLE frame (hovering an orb has to reach the orb, not the
   *  window pane it sits on) */
  const regionsRef = useRef<GameframeRegion[]>([])
  /** hover state fed to the CS2 run; a ref because the pointer moves far more
   *  often than a repaint is warranted */
  const pointerRef = useRef<GameframePointer>({ entered: [], over: [], exited: [], clicked: [] })
  /** what a click on the canvas does — pick a component to edit, or act as a
   *  real click and fire its onClick/onRelease hooks */
  const [clickMode, setClickMode] = useState<'select' | 'script'>('select')
  const dragCompRef = useRef<{ id: number; grabX: number; grabY: number; moved: boolean; downX: number; downY: number } | null>(null)
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** a drag just ended — swallow the click that follows it */
  const suppressClickRef = useRef(false)
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  /** The frame's CS2 state, kept across pointer movement. Rebuilt only when
   *  its key changes — everything a pointer move does NOT affect. */
  const frameRef = useRef<{ key: string; run: GameframeRun } | null>(null)
  /** bumped when the composed scene is replaced (mode/slot/draft edit) */
  const sceneGen = useRef(0)
  /** bumped when the Variables modal saves — the frame hooks read that player */
  const varsGen = useRef(0)
  /** what the last hover run produced. Hover state accumulates like the
   *  client's: an exit script has to see the highlight it's undoing, or the
   *  console records it as having changed nothing. Dropped whenever the frame
   *  is rebuilt, since it was layered over the old one. */
  const hoverStateRef = useRef<Cs2SceneSnapshot | null>(null)
  /** `client_clock()` — advanced by the hover ticker below */
  const cycleRef = useRef(0)
  const tickRef = useRef<number | null>(null)
  /** Non-edited interfaces of the composed frame — see loadGameframeScene. */
  const depCacheRef = useRef(new Map<number, (IComponentDefinition | null)[]>())

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
  useEffect(() => onVarOverridesChanged(() => { varsGen.current++; repaintRef.current() }), [])

  // Scene assembly depends on mode/slot/draft identity; keyed on the
  // components ARRAY so a field edit (new array from the viewer) reloads.
  const sceneKey = useMemo(() => ({ mode, slotKey, components: data.components, id: data.id }), [mode, slotKey, data.components, data.id])

  /** What the edited interface carries, so the console can explain an empty
   *  log — "no hooks" and "only hover hooks, none pointed at yet" look
   *  identical in the trace but mean very different things. */
  const hookCensus = useMemo(() => censusHooks(data.components), [data.components])

  useEffect(() => {
    if (!data.rootHandle) { setStatus('No cache folder'); return }
    let cancelled = false
    ;(async () => {
      try {
        const scene = await loadGameframeScene(data.rootHandle!, sceneKey.mode, { id: sceneKey.id, components: sceneKey.components }, sceneKey.slotKey, depCacheRef.current)
        if (cancelled) return
        sceneRef.current = scene
        sceneGen.current++
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
      let override: Awaited<ReturnType<typeof applyGameframeHover>> | null = null
      let routes: Cs2VarRoute[] = []
      if (cs2Enabled && data.rootHandle) {
        try {
          if (!cs2CacheRef.current) cs2CacheRef.current = new Cs2Cache()
          // The frame passes are the expensive part and only depend on the
          // scene, the viewport and the simulated player — none of which a
          // pointer move touches. Cache them so hovering costs three hooks
          // instead of sixty.
          const key = `${sceneGen.current}|${mode}|${width}x${height}|${varsGen.current}`
          const rebuilt = frameRef.current?.key !== key
          if (rebuilt) {
            const run = await runGameframeCs2(data.rootHandle, scene, mode, width, height, cs2CacheRef.current)
            frameRef.current = { key, run }
            hoverStateRef.current = null
          }
          const base = frameRef.current!.run
          routes = base.routes
          // One run IS one client cycle. Advancing the clock on the timer
          // instead made the countdown in a delay script diverge: `varc_1`
          // only moves when the hook actually RUNS (paint rate), while
          // `client_clock() + delay` moved at timer rate, so the gap closed at
          // the difference between the two rather than at the script's own
          // pace — a ~0.5s tooltip took 3s, and would never have appeared at
          // all if painting dropped below half the timer rate.
          cycleRef.current++
          const hover = await applyGameframeHover(base, pointerRef.current, hoverStateRef.current, cycleRef.current)
          hoverStateRef.current = hover.snapshot
          // What the console should call this run: a rebuild is the whole
          // frame plus whatever the pointer added; a cache hit is ONLY the
          // hover hooks, since the frame didn't run again and re-listing 60
          // cached entries would bury the two that are news.
          const merged = rebuilt ? [...base.trace, ...hover.trace] : hover.trace
          override = {
            ...hover,
            // the two traces are numbered from their own scenes, so renumber
            // rather than emit a run with two #1s
            trace: merged.map((e, i) => (e.seq === i + 1 ? e : { ...e, seq: i + 1 })),
          }
          // entered/exited are one-shot edges: their hooks fire on the run
          // that observed them and must not re-fire on later repaints. `over`
          // stays, because its hook is per-cycle by design.
          pointerRef.current = { entered: [], over: pointerRef.current.over, exited: [], clicked: [] }
        } catch (e) {
          setStatus(`CS2 run failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      if (gen !== paintGen.current) { paintBusy.current = false; return }
      setCs2Warnings(override?.warnings ?? [])
      setCs2Trace(override?.trace ?? [])
      setCs2Routes(routes)
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
      const { placements, regions } = await paintGameframe(ctx, assets, scene, width, height, { ...opts, showPlaceholders: false }, override ?? undefined)
      regionsRef.current = regions
      // selection outline: same dashed blue as the flat canvas, drawn where
      // the edited interface's component actually landed in the frame
      {
        const place = placements.get(data.id)
        const comps = override?.interfaces.get(data.id) ?? scene.interfaces.get(data.id)
        hitRef.current = place && comps ? { place, comps } : null
      }
      drawSelection()
      paintBusy.current = false
      if (paintQueued.current) {
        paintQueued.current = false
        repaint()
      }
    })()
  }

  /**
   * The selection outline, on its own transparent canvas over the frame.
   *
   * Selecting used to be in the repaint deps, so clicking a component in the
   * tree re-ran the whole compositor — every attached interface's assets
   * resolved and redrawn — to move a dashed rectangle. Its own canvas costs
   * one stroke. Called at the end of a paint too, since the component may
   * have MOVED even when the selection didn't change.
   */
  const drawSelection = () => {
    const canvas = overlayRef.current
    if (!canvas) return
    const { width, height } = mode === 'fixed' ? FIXED_SIZE : size
    // preparePixelCanvas assigns canvas.width, which clears it — so a
    // deselection needs no explicit erase
    const ctx = preparePixelCanvas(canvas, width, height)
    // snap guides under the outline, so the selection still reads on top
    if (guides.length > 0) {
      ctx.strokeStyle = '#d9b45c'
      ctx.lineWidth = 1
      for (const g of guides) {
        // a guide on a far edge sits on the canvas boundary and a 1px line
        // centred there is half outside, drawing nothing — pull it inside
        const at = g.axis === 'x'
          ? Math.min(Math.max(g.at + 0.5, 0.5), width - 0.5)
          : Math.min(Math.max(g.at + 0.5, 0.5), height - 0.5)
        ctx.beginPath()
        if (g.axis === 'x') { ctx.moveTo(at, 0); ctx.lineTo(at, height) }
        else { ctx.moveTo(0, at); ctx.lineTo(width, at) }
        ctx.stroke()
      }
    }
    if (selectedId == null) return
    const place = hitRef.current?.place
    const comps = hitRef.current?.comps
    if (!place || !comps) return
    const rect = resolveAbsoluteLayout(comps, place.w, place.h).get(selectedId)
    if (!rect) return
    ctx.strokeStyle = '#2f8fff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    ctx.strokeRect(place.x + rect.x + 0.5, place.y + rect.y + 0.5, rect.width, rect.height)
  }

  // repaint on size/asset/option changes (scene changes repaint via the loader).
  // NOT selectedId — that only moves the overlay.
  useEffect(() => { repaint() }, [size, mode, assets, cs2Enabled, opts.showHidden, opts.showContainerOutlines]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { drawSelection() }, [selectedId, guides]) // eslint-disable-line react-hooks/exhaustive-deps

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

  /** canvas pixel under the event, in viewport units */
  const canvasPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect()
    const { width, height } = mode === 'fixed' ? FIXED_SIZE : size
    return {
      x: ((e.clientX - bounds.left) / bounds.width) * width,
      y: ((e.clientY - bounds.top) / bounds.height) * height,
    }
  }

  /**
   * Hover tracking. The client keeps an "is hovered" flag per component and
   * fires enter/leave on the transition, so this only has to notice the
   * transition and hand it to the next run.
   *
   * The repaint is CONDITIONAL: a full CS2 run is ~60 hooks, and re-running it
   * every time the pointer crosses any component boundary would make the
   * preview crawl for no visible result. Only a component that actually
   * carries a hover hook is worth a run — components already inside the set
   * have had their effect applied.
   */
  /**
   * The client cycle, run only while it can matter.
   *
   * The every-cycle hover hook is written expecting ~50 calls a second, and
   * scripts time themselves off `client_clock()` against a varc they advance
   * per call — the 11:18 tooltip needs roughly 24 cycles (~0.5s) of that
   * before it shows. Firing the hook once per pointer movement made that
   * "jiggle the mouse two dozen times".
   *
   * Bounded on purpose: each tick is a hover run plus a full repaint, so it
   * stops after TICK_BUDGET cycles and restarts on the next hover change. A
   * script still counting down after three seconds was not going to finish.
   */
  const stopTicking = () => {
    if (tickRef.current != null) window.clearInterval(tickRef.current)
    tickRef.current = null
  }

  const startTicking = () => {
    stopTicking()
    let budget = TICK_BUDGET
    tickRef.current = window.setInterval(() => {
      if (budget-- <= 0) { stopTicking(); return }
      // asks for a cycle; repaint() advances the clock only when one actually
      // runs, so a slow paint can't outrun the scripts timing against it
      repaint()
    }, CLIENT_CYCLE_MS)
  }

  useEffect(() => stopTicking, [])

  const applyHover = (next: HoverTarget[]) => {
    const prev = pointerRef.current.over
    const prevHashes = new Set(prev.map((t) => t.hash))
    const nextHashes = new Set(next.map((t) => t.hash))
    const entered = next.filter((t) => !prevHashes.has(t.hash))
    const exited = prev.filter((t) => !nextHashes.has(t.hash))
    if (entered.length === 0 && exited.length === 0) {
      // same components — just keep the coordinates current for the next run
      pointerRef.current.over = next
      return
    }
    pointerRef.current = { ...pointerRef.current, entered, over: next, exited }
    // the label names the innermost component, since that's what the eye is
    // on, and counts the ancestors also receiving the hover
    const deepest = next[next.length - 1]
    setHoverLabel(deepest
      ? `${deepest.hash >>> 16}:${deepest.hash & 0xffff}${next.length > 1 ? ` +${next.length - 1}` : ''}`
      : null)
    if ([...entered, ...exited].some((t) => hasHoverHook(componentAt(t.hash)))) repaint()
    // tick only while something under the pointer wants per-cycle calls
    if (cs2Enabled && next.some((t) => hasPerCycleHook(componentAt(t.hash)))) startTicking()
    else stopTicking()
  }

  const onCanvasMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasPoint(e)
    applyHover(hoverTargets(regionsRef.current, x, y, opts.showHidden === true))
  }

  const onCanvasLeave = () => applyHover([])

  /** The painted (CS2-mutated) component behind a hit hash. */
  const componentAt = (hash: number) => {
    const region = regionsRef.current.find((r) => r.interfaceId === (hash >>> 16))
    return region?.comps[hash & 0xffff] ?? null
  }

  /**
   * Drag a component of the EDITED interface to move it. Only in "click
   * selects / drags" mode — in onClick mode a drag would be indistinguishable
   * from a click, and firing hooks mid-drag would be nonsense.
   *
   * Restricted to the edited interface for the same reason selection is: the
   * other interfaces in the frame are on-disk copies this viewer isn't editing
   * and can't save.
   */
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (clickMode !== 'select' || !onMoveComponent) return
    const hit = hitRef.current
    if (!hit) return
    const p = canvasPoint(e)
    const px = p.x - hit.place.x
    const py = p.y - hit.place.y
    if (px < 0 || py < 0 || px > hit.place.w || py > hit.place.h) return
    const layout = resolveAbsoluteLayout(hit.comps, hit.place.w, hit.place.h)
    // The SELECTED component drags, even when the press lands on a child drawn
    // over it — otherwise a container is unmovable, since the pointer is
    // almost always over one of the sprites inside it.
    const selRect = selectedId != null ? layout.get(selectedId) : null
    const inSelection = selRect != null
      && px >= selRect.x && px <= selRect.x + selRect.width
      && py >= selRect.y && py <= selRect.y + selRect.height
    const id = inSelection ? selectedId! : hitTestComponent(hit.comps, layout, px, py, opts.showHidden === true)
    if (id == null) return
    const rect = layout.get(id)
    if (!rect) return
    if (!inSelection) onSelect?.(id)
    e.currentTarget.setPointerCapture(e.pointerId)
    dragCompRef.current = { id, grabX: px - rect.x, grabY: py - rect.y, moved: false, downX: px, downY: py }
  }

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragCompRef.current
    const hit = hitRef.current
    if (!drag || !hit || !onMoveComponent) return
    const comp = hit.comps.find((c) => c?.componentId === drag.id)
    const layout = resolveAbsoluteLayout(hit.comps, hit.place.w, hit.place.h)
    const rect = layout.get(drag.id)
    if (!comp || !rect) return
    const p = canvasPoint(e)
    // work in the edited interface's own coordinates, not the frame's
    const local = { x: p.x - hit.place.x, y: p.y - hit.place.y }
    // slop, so a click that twitches isn't treated as a move
    if (!drag.moved && Math.abs(local.x - drag.downX) < 2 && Math.abs(local.y - drag.downY) < 2) return
    drag.moved = true
    const parent = parentBoxOf(comp, hit.comps, layout, hit.place.w, hit.place.h)
    const out = dragToBasePosition(
      comp, rect, parent, hit.comps, layout, local, { x: drag.grabX, y: drag.grabY }, snap === true,
    )
    setGuides(out.guides.map((g) => ({
      axis: g.axis,
      at: g.at + (g.axis === 'x' ? hit.place.x : hit.place.y),
    })))
    onMoveComponent(drag.id, out.basePositionX, out.basePositionY)
  }

  const onCanvasPointerUp = () => {
    // A drag is followed by a click event. Without this the click would
    // hit-test where the pointer ended up and select the child you just
    // dragged the container out from under.
    suppressClickRef.current = dragCompRef.current?.moved === true
    dragCompRef.current = null
    setGuides([])
  }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (clickMode === 'script') {
      // Same set semantics as hover: the client fires the click hooks of
      // every component whose bounds contain the point, not just the topmost.
      const { x, y } = canvasPoint(e)
      pointerRef.current = {
        ...pointerRef.current,
        clicked: hoverTargets(regionsRef.current, x, y, opts.showHidden === true),
      }
      repaint()
      return
    }
    // Selection stays scoped to the EDITED interface — clicking a chatbox
    // component would have nothing to select in the tree.
    const hit = hitRef.current
    if (!hit || !onSelect) return
    const point = canvasPoint(e)
    const px = point.x - hit.place.x
    const py = point.y - hit.place.y
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
        <div className="gfp-slot-pills" title="What clicking the frame does. Selecting is for editing — and lets you drag the edited interface's components to move them. Firing onClick makes the preview behave like the client, running the clicked component's onClick and onRelease hooks; dragging is off in that mode so a drag can't be mistaken for a click.">
          <button
            type="button"
            className={clickMode === 'select' ? 'selected' : ''}
            onClick={() => setClickMode('select')}
          >
            Click selects / drags
          </button>
          <button
            type="button"
            className={clickMode === 'script' ? 'selected' : ''}
            onClick={() => setClickMode('script')}
          >
            Click fires onClick
          </button>
        </div>
        <label className="gfp-cs2">
          <input type="checkbox" checked={cs2Enabled} onChange={(e) => setCs2Enabled(e.target.checked)} />
          CS2 hooks
        </label>
        <button
          type="button"
          className="gfp-player-btn"
          title="The variables the HUD scripts read — varps, varbits, skill levels, plus the handful of player values (run energy, display name) that aren't vars"
          onClick={() => setShowPlayer(true)}
        >
          Variables…
        </button>
        {hoverLabel && (
          <span className="gfp-hover" title="The component under the pointer. Its hover hooks (onMouseOver / popup / onMouseLeave) run in the preview — watch the console.">
            hover {hoverLabel}
          </span>
        )}
        {zoomedOut && (
          <span className="gfp-zoom-warning" title="The browser has fewer device pixels than the frame needs, so 1px strokes (cache font glyphs, borders) get resampled. The client always draws 1:1 — reset zoom to compare accurately.">
            page zoom {Math.round(pageZoom * 100)}% — not pixel-accurate
          </span>
        )}
      </div>
      <div className="gfp-stage">
        <div className="gfp-frame" style={{ width: viewport.width, height: viewport.height }}>
          <canvas
            ref={canvasRef}
            className="gfp-canvas"
            style={{ width: viewport.width, height: viewport.height }}
            onClick={onCanvasClick}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
            onMouseMove={onCanvasMove}
            onMouseLeave={onCanvasLeave}
          />
          {/* selection only — pointer-events off so the frame keeps hover */}
          <canvas
            ref={overlayRef}
            className="gfp-canvas gfp-canvas-overlay"
            style={{ width: viewport.width, height: viewport.height }}
          />
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
      <Cs2Console
        trace={cs2Trace}
        routes={cs2Routes}
        warnings={cs2Warnings}
        census={hookCensus}
        enabled={cs2Enabled}
        rootHandle={data.rootHandle ?? null}
        editedInterfaceId={data.id}
        onSelect={onSelect}
        onEditScript={onEditScript}
      />
      {showPlayer && <VarOverridesModal onClose={() => setShowPlayer(false)} />}
    </div>
  )
}
