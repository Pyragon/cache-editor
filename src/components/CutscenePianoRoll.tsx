import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CutsceneActionDef } from '../loaders/cutscenes'
import { clockShort } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import { CUTSCENE_LANES as LANES, actionLane } from './cutsceneLanes'
import './CutscenePianoRoll.css'

// A piano roll over the cutscene's actions: time runs left to right, and each
// action sits in the lane for the kind of thing it does. The action table says
// WHAT happens; this says WHEN, and — the reason it exists — what happens at the
// same moment as what.
//
// Two playheads. The solid one is the sim clock. The ghost one follows the
// pointer, because the authoring loop is "put the cursor somewhere, then act":
// clicking scrubs there, and the keybinds insert at whatever the ghost is over,
// so you never have to type a cycle number.

const ZOOMS = [0.25, 0.5, 1, 2, 4]
const LANE_HEIGHT = 26
/**
 * Cells closer together than this merge into one `#n` stack.
 *
 * It's the width a short label needs, not an arbitrary nearness: below it two
 * cells can't both be named, and an unlabelled cell is a dot you have to hover
 * to identify. Collapsing instead means everything on screen either reads its
 * own name or says how many are hiding there — which is what the fan is for.
 */
const STACK_PX = 46

export type PianoRollProps = {
  actions: CutsceneActionDef[]
  durationCycles: number
  /** Sim clock, for the solid playhead. */
  cycle: number
  unit: CutsceneClockUnit
  /** Index into `actions` of the currently selected one, if any. */
  selectedIndex?: number | null
  onScrub: (cycle: number) => void
  onSelectAction: (index: number) => void
  /** Keybind targets. The cycle is wherever the ghost playhead is. */
  onAddAt: (cycle: number) => void
  onCameraAt: (cycle: number) => void
}

type Cell = { index: number; action: CutsceneActionDef }
type Stack = {
  lane: string
  cycle: number
  cells: Cell[]
  /** Pixels until the next stack in this lane — how much room the label has
   *  before it would run into its neighbour. */
  gapPx: number
}

/** Below this a label is unreadable anyway, so the cell becomes a plain marker
 *  and the name lives in the tooltip. */
const LABEL_MIN_PX = 34

export default function CutscenePianoRoll({
  actions, durationCycles, cycle, unit, selectedIndex,
  onScrub, onSelectAction, onAddAt, onCameraAt,
}: PianoRollProps) {
  const [zoom, setZoom] = useState(1)
  const [ghost, setGhost] = useState<number | null>(null)
  /**
   * Which stack is fanned open, and where to draw its fan.
   *
   * The fan is portalled to the body at fixed coordinates rather than nested in
   * the lane, because the track is an `overflow-x: auto` scroller — that makes
   * it a scroll container in BOTH axes, so anything taller than a 26px lane is
   * clipped at the top of the roll however the overflow is set. Same reason and
   * same fix as the fit tables' "View Anim" menu.
   */
  const [openStack, setOpenStack] = useState<{ key: string; left: number; bottom: number } | null>(null)
  const [pinned, setPinned] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Grace period so the pointer can cross the gap from cell to fan. */
  const closeTimer = useRef<number | null>(null)

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])

  const closeFanSoon = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => { if (!pinned) setOpenStack(null) }, 120)
  }, [cancelClose, pinned])

  const openFanAt = useCallback((key: string, el: HTMLElement) => {
    cancelClose()
    const rect = el.getBoundingClientRect()
    setOpenStack({ key, left: rect.left, bottom: window.innerHeight - rect.top + 4 })
  }, [cancelClose])

  useEffect(() => () => cancelClose(), [cancelClose])

  // Fixed coordinates go stale the moment anything scrolls, so close instead of
  // trying to follow — same bargain the fit-table menu makes.
  useEffect(() => {
    if (!openStack) return
    const close = () => { setPinned(false); setOpenStack(null) }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [openStack])

  const pxPerCycle = zoom
  const width = Math.max(240, Math.ceil((durationCycles + 20) * pxPerCycle))

  // Group actions into per-lane stacks. Two actions in the same lane land in the
  // same stack when they'd overlap on screen at the current zoom — which is the
  // whole point: at 0.25 px/cycle a whole second collapses, and that IS the
  // question being asked ("what fires around here?").
  const stacks = useMemo(() => {
    const byLane = new Map<string, Cell[]>()
    actions.forEach((action, index) => {
      const lane = actionLane(action.type)
      let list = byLane.get(lane)
      if (!list) byLane.set(lane, list = [])
      list.push({ index, action })
    })
    const out: Stack[] = []
    for (const [lane, cells] of byLane) {
      cells.sort((a, b) => a.action.lengthInCycles - b.action.lengthInCycles)
      const laneStacks: Stack[] = []
      let current: Cell[] = []
      const flush = () => {
        if (current.length > 0) {
          laneStacks.push({ lane, cycle: current[0].action.lengthInCycles, cells: current, gapPx: Infinity })
        }
      }
      for (const cell of cells) {
        if (current.length === 0) { current = [cell]; continue }
        const first = current[0].action.lengthInCycles
        if (cell.action.lengthInCycles - first) {
          if ((cell.action.lengthInCycles - first) * pxPerCycle <= STACK_PX) { current.push(cell); continue }
          flush()
          current = [cell]
        } else current.push(cell)
      }
      flush()
      // How much room each cell has: the distance to its neighbour. Without
      // this a wide label just draws over the next one, which is what made a
      // busy camera lane an unreadable smear of "direct camera".
      for (let i = 0; i < laneStacks.length; i++) {
        const next = laneStacks[i + 1]
        laneStacks[i].gapPx = next ? (next.cycle - laneStacks[i].cycle) * pxPerCycle : Infinity
      }
      out.push(...laneStacks)
    }
    return out
  }, [actions, pxPerCycle])

  const cycleAt = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    return Math.max(0, Math.round(x / pxPerCycle))
  }, [pxPerCycle])

  // Keybinds act at the ghost when the pointer is over the roll, else at the
  // sim clock — so they still do something sensible from the keyboard alone.
  const targetCycle = ghost ?? cycle

  // Listened for on the document rather than the roll, so hovering is enough —
  // "insert where I'm pointing" shouldn't need a click to focus first. Guarded
  // to the pointer being over the roll, or the roll actually holding focus for
  // the keyboard-only path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = rootRef.current
      if (!el) return
      const engaged = ghost != null || el.contains(document.activeElement)
      if (!engaged) return
      // never steal a keystroke from a field the user is typing in, and never
      // fire behind a modal this same keybind just opened
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (t && t.closest('dialog')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); onAddAt(targetCycle) }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); onCameraAt(targetCycle) }
      else if (e.key === 'Escape') { setPinned(false); setOpenStack(null) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [targetCycle, ghost, onAddAt, onCameraAt])

  // Ruler ticks: aim for one roughly every 80px, snapped to a round number of
  // cycles so the labels read as times rather than arbitrary offsets.
  const ticks = useMemo(() => {
    const target = 80 / pxPerCycle
    const steps = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
    const step = steps.find((s) => s >= target) ?? steps[steps.length - 1]
    const out: number[] = []
    for (let c = 0; c <= durationCycles + 20; c += step) out.push(c)
    return { step, marks: out }
  }, [pxPerCycle, durationCycles])

  const stackKey = (s: Stack) => `${s.lane}:${s.cycle}`

  /** The cells the open fan is showing, looked up once rather than threaded
   *  through the portal. */
  const fanCells = useMemo(() => {
    if (!openStack) return null
    return stacks.find((s) => stackKey(s) === openStack.key)?.cells ?? null
  }, [openStack, stacks])

  return (
    <div
      ref={rootRef}
      className="piano-roll"
      tabIndex={0}
      onMouseLeave={() => { setGhost(null); if (!pinned) setOpenStack(null) }}
    >
      <div className="piano-roll-head">
        <span className="piano-roll-hint">
          Click to scrub. <kbd>A</kbd> add an action here · <kbd>C</kbd> camera here
          {ghost != null && <> · <strong>{clockShort(ghost, unit)}</strong></>}
        </span>
        <span className="btn-pill">
          {ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              className={`zoom-btn${zoom === z ? ' active' : ''}`}
              onClick={() => setZoom(z)}
            >
              {z < 1 ? `1/${1 / z}×` : `${z}×`}
            </button>
          ))}
        </span>
      </div>

      <div className="piano-roll-body">
        <div className="piano-roll-lanes">
          <div className="piano-roll-ruler-spacer" />
          {LANES.map((lane) => (
            <div key={lane.key} className="piano-roll-lane-label" style={{ height: LANE_HEIGHT }}>
              {lane.label}
            </div>
          ))}
        </div>

        <div
          ref={trackRef}
          className="piano-roll-track"
          onMouseMove={(e) => setGhost(cycleAt(e.clientX))}
          onClick={(e) => {
            // a click on a cell selects it; only bare track scrubs
            if ((e.target as HTMLElement).closest('.piano-roll-cell')) return
            onScrub(cycleAt(e.clientX))
          }}
        >
          <div className="piano-roll-canvas" style={{ width }}>
            <div className="piano-roll-ruler">
              {ticks.marks.map((c) => (
                <span key={c} className="piano-roll-tick" style={{ left: c * pxPerCycle }}>
                  {clockShort(c, unit)}
                </span>
              ))}
            </div>

            {LANES.map((lane) => (
              <div key={lane.key} className="piano-roll-lane" style={{ height: LANE_HEIGHT }}>
                {stacks.filter((s) => s.lane === lane.key).map((s) => {
                  const key = stackKey(s)
                  const many = s.cells.length > 1
                  const selected = s.cells.some((c) => c.index === selectedIndex)
                  // Never wider than the room before the next cell, so a long
                  // type name can't draw over its neighbour. Cells too close to
                  // both fit a label have already merged into a stack.
                  const room = Math.min(150, Math.max(10, s.gapPx - 3))
                  const labelled = room >= LABEL_MIN_PX
                  return (
                    <div
                      key={key}
                      className="piano-roll-stack"
                      style={{ left: s.cycle * pxPerCycle, maxWidth: room }}
                      onMouseEnter={(e) => { if (many) openFanAt(key, e.currentTarget) }}
                      onMouseLeave={() => { if (many) closeFanSoon() }}
                    >
                      <button
                        type="button"
                        className={`piano-roll-cell piano-roll-${lane.key}${selected ? ' selected' : ''}${many ? ' stacked' : ''}${labelled || many ? '' : ' bare'}`}
                        // a stacked marker must not push past its own room
                        style={many ? { minWidth: Math.min(26, room) } : undefined}
                        title={many
                          ? `${s.cells.length} actions at ${clockShort(s.cycle, unit)} — hover to fan out, click to pin`
                          : `${s.cells[0].action.type} at ${clockShort(s.cycle, unit)}`}
                        onClick={(e) => {
                          if (many) {
                            const same = openStack?.key === key
                            setPinned((p) => !(p && same))
                            openFanAt(key, e.currentTarget.parentElement as HTMLElement)
                            return
                          }
                          onSelectAction(s.cells[0].index)
                          onScrub(s.cycle + 1)
                        }}
                      >
                        {many
                          ? <span className="piano-roll-count">#{s.cells.length}</span>
                          : labelled
                          ? s.cells[0].action.type.toLowerCase().replace(/_/g, ' ')
                          : ''}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}

            {/* Ghost first so the real playhead draws over it when they meet. */}
            {ghost != null && (
              <div className="piano-roll-playhead ghost" style={{ left: ghost * pxPerCycle }} />
            )}
            <div className="piano-roll-playhead" style={{ left: Math.min(cycle, durationCycles + 20) * pxPerCycle }} />
          </div>
        </div>
      </div>

      {openStack && fanCells && createPortal(
        <div
          className="piano-roll-fan"
          style={{ position: 'fixed', left: openStack.left, bottom: openStack.bottom }}
          onMouseEnter={cancelClose}
          onMouseLeave={closeFanSoon}
        >
          {fanCells.map((c) => (
            <button
              key={c.index}
              type="button"
              className={`piano-roll-cell piano-roll-${actionLane(c.action.type)}${c.index === selectedIndex ? ' selected' : ''}`}
              title={`${c.action.type} at ${clockShort(c.action.lengthInCycles, unit)} — ${JSON.stringify(c.action.fields ?? {})}`}
              onClick={() => {
                onSelectAction(c.index)
                onScrub(c.action.lengthInCycles + 1)
                setPinned(false)
                setOpenStack(null)
              }}
            >
              <span className="piano-roll-fan-time">{clockShort(c.action.lengthInCycles, unit)}</span>
              {c.action.type.toLowerCase().replace(/_/g, ' ')}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
