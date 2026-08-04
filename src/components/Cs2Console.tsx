import { useEffect, useMemo, useRef, useState } from 'react'
import type { Cs2TraceEntry, Cs2Warning } from '../cs2/runtime'
import type { Cs2VarRoute, HookCensus } from './gameframe'
import Cs2ScriptModal from './Cs2ScriptModal'
import './Cs2Console.css'

/**
 * What the preview's CS2 runs actually did, under the frame they drew.
 *
 * The gameframe is mostly script output — the orb fills, the numbers on them,
 * the chat name, half the tab strip — so when something looks wrong the
 * question is never "which field is off" but "did the script that sets it run,
 * and did it touch anything". That is unanswerable from a canvas. This is the
 * log: every hook in the order it fired, why the client would have fired it,
 * and every component field it changed.
 *
 * It ACCUMULATES. Every repaint is a fresh CS2 run, and a console that
 * replaced its contents each time couldn't answer "what did my last edit
 * change" — the before and after were never on screen together. Runs stack
 * newest-first with a header each; entries within a run stay in fire order,
 * because that's the causality. Identical consecutive runs are folded into a
 * repeat count instead of appended, so dragging the resize handle doesn't bury
 * the run you were reading.
 *
 * The most useful lines are the ones where nothing happened — a hook marked
 * "ran, changed nothing", a `target not in scene` event from an if_* setter
 * aimed at a component that doesn't exist, and a variable route with no
 * watchers. All three look identical to success on the canvas.
 */

/** Runs kept before the oldest is dropped. Enough to compare a few edits;
 *  small enough that the log stays a log and not a memory leak. */
const MAX_RUNS = 12

type Run = {
  id: number
  at: string
  entries: Cs2TraceEntry[]
  routes: Cs2VarRoute[]
  /** identity of the run's OUTPUT, for folding repeats */
  signature: string
  /** how many identical runs this row stands for */
  repeats: number
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Cheap identity of a run: what fired, and what it did. Two runs matching on
 *  this produced the same frame, whatever prompted them. */
function signatureOf(trace: Cs2TraceEntry[], routes: Cs2VarRoute[]): string {
  const parts = trace.map((e) => (
    `${e.hook}${e.script}${e.source}${e.trigger}${e.note ?? ''}`
    + e.changes.map((c) => `${c.target}${c.field}${c.from}${c.to}`).join('')
  ))
  return parts.join('|') + '#' + routes.map((r) => `${r.subject}${r.route ?? ''}${r.watchers.join(',')}`).join('|')
}

export default function Cs2Console({ trace, routes, warnings, enabled, census, rootHandle, editedInterfaceId, onSelect, onEditScript }: {
  trace: Cs2TraceEntry[]
  /** where each set variable goes in this frame */
  routes: Cs2VarRoute[]
  /** what the EDITED interface carries, so an empty log can say why */
  census: HookCensus
  warnings: Cs2Warning[]
  /** CS2 hooks toggle — off means the trace is empty for a reason */
  enabled: boolean
  rootHandle: FileSystemDirectoryHandle | null
  /** the interface being edited; only its components are selectable */
  editedInterfaceId: number
  onSelect?: (componentId: number) => void
  /** leave for the cs2 entry to edit the script the reader has open */
  onEditScript?: (scriptId: number) => void
}) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'run' | 'stubs'>('run')
  const [showQuiet, setShowQuiet] = useState(false)
  const [onlyMine, setOnlyMine] = useState(false)
  const [filter, setFilter] = useState('')
  const [scriptId, setScriptId] = useState<number | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const nextRunId = useRef(0)

  /**
   * Does this hook have anything to do with the interface being edited? Yes if
   * it HANGS OFF one of its components — and also if it merely CHANGED one.
   * The second half matters: a gameframe script reaching into the interface
   * you're editing is the most interesting line in the log, not noise, so
   * filtering purely by which interface owns the hook would hide exactly the
   * thing you'd want to catch.
   */
  const mine = useMemo(() => {
    const prefix = `${editedInterfaceId}:`
    return (e: Cs2TraceEntry) => (
      e.source.startsWith(prefix) || e.changes.some((c) => c.target.startsWith(prefix))
    )
  }, [editedInterfaceId])

  // Read inside the append effect without making the filter a dependency:
  // toggling it should change what gets recorded NEXT, not replay the current
  // trace as a fresh run.
  const recordFilter = useRef({ onlyMine, mine })
  recordFilter.current = { onlyMine, mine }

  // Append each completed run. A repaint that produced an identical run bumps
  // the newest row's repeat count rather than pushing a duplicate.
  useEffect(() => {
    if (!enabled || trace.length === 0) return
    // With "Only this interface" on, a run that touched nothing of ours is not
    // recorded at all. Hiding its rows wasn't enough: hovering the gameframe
    // fires a hook per pointer transition, and those runs would still take
    // header space and — worse — evict the runs you actually care about from
    // the capped history.
    const { onlyMine: only, mine: isMine } = recordFilter.current
    if (only && !trace.some(isMine)) return
    const signature = signatureOf(trace, routes)
    setRuns((prev) => {
      if (prev.length > 0 && prev[0].signature === signature) {
        return [{ ...prev[0], repeats: prev[0].repeats + 1 }, ...prev.slice(1)]
      }
      const run: Run = {
        id: ++nextRunId.current,
        at: new Date().toLocaleTimeString(),
        entries: trace,
        routes,
        signature,
        repeats: 1,
      }
      return [run, ...prev].slice(0, MAX_RUNS)
    })
  }, [trace, routes, enabled])

  const changed = useMemo(() => trace.filter((e) => e.changes.length > 0).length, [trace])
  const stubCount = useMemo(() => warnings.reduce((n, w) => n + w.count, 0), [warnings])

  const foreign = useMemo(() => trace.filter((e) => !mine(e)).length, [trace, mine])

  /** The filters, applied inside each run so the run boundaries survive them. */
  const visibleRuns = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const keep = (e: Cs2TraceEntry) => {
      if (!showQuiet && e.changes.length === 0) return false
      if (onlyMine && !mine(e)) return false
      if (!needle) return true
      return (
        String(e.script).includes(needle)
        || e.source.includes(needle)
        || e.hook.toLowerCase().includes(needle)
        || e.trigger.toLowerCase().includes(needle)
        || e.changes.some((c) => c.target.includes(needle) || c.field.toLowerCase().includes(needle))
      )
    }
    // A run filtered down to nothing is dropped whole — a header on its own
    // says only "something ran that you asked not to see".
    return runs
      .map((run) => ({ ...run, shown: run.entries.filter(keep) }))
      .filter((run) => run.shown.length > 0 || run.routes.length > 0)
  }, [runs, showQuiet, onlyMine, mine, filter])

  /** Filtered every run away — say why rather than showing a blank box that
   *  reads as "the console broke". */
  const allEmpty = visibleRuns.length === 0

  /**
   * Why there is nothing to show. Worth getting right: an empty log is the
   * normal state for an interface whose hooks are all pointer-driven, and the
   * message has to distinguish that from one that genuinely carries none.
   * The census counts what the interface HAS; the trace says what has run.
   */
  const emptyReason = useMemo(() => {
    const mineRan = trace.some(mine)
    if (onlyMine && !mineRan) {
      const unrunTotal = census.unrun.reduce((n, u) => n + u.count, 0)
      if (census.frame + census.hover + census.click + unrunTotal === 0) {
        return `Interface ${editedInterfaceId} carries no hooks at all.`
      }
      const has: string[] = []
      if (census.hover > 0) has.push(plural(census.hover, 'hover hook'))
      if (census.click > 0) has.push(plural(census.click, 'click hook'))
      // named, not bucketed — a summary like "drag/key hooks" can't be
      // checked against the components and sends you looking for the wrong
      // thing
      if (unrunTotal > 0) {
        has.push(`${census.unrun.map((u) => `${u.count} ${u.field}`).join(', ')} the preview never fires`)
      }
      if (census.frame > 0) has.push(plural(census.frame, 'load or transmit hook'))
      // how to make something happen, given what it has
      const how = [
        census.hover > 0 ? 'point at one of its components' : null,
        census.click > 0 ? 'click one with "Click fires onClick" on' : null,
      ].filter(Boolean)
      return how.length > 0
        ? `Nothing of interface ${editedInterfaceId} has run yet — it carries ${has.join(', ')}. To fire them, ${how.join(', or ')}.`
        : `Nothing of interface ${editedInterfaceId} has run — it carries ${has.join(', ')}.`
    }
    if (runs.length === 0) return 'No hooks have run in this frame yet.'
    if (changed === 0) return `${plural(trace.length, 'hook')} ran and none changed a component — tick "No-ops" to see them.`
    return 'Nothing matches the filter.'
  }, [trace, mine, onlyMine, census, editedInterfaceId, runs.length, changed])

  /** A component reference is clickable only when it's in the interface the
   *  editor has open — selecting a component of the chatbox would have nothing
   *  to select in. */
  const selectable = (target: string) => {
    const [iface, comp] = target.split(':')
    return onSelect != null && Number(iface) === editedInterfaceId && comp !== undefined
  }
  const select = (target: string) => onSelect?.(Number(target.split(':')[1]))

  return (
    <div className={`cs2-console${open ? '' : ' collapsed'}`}>
      <div className="cs2-console-head">
        <button
          type="button"
          className="cs2-console-toggle"
          title={open ? 'Collapse the console' : 'Expand the console'}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="cs2-console-caret">{open ? '▾' : '▸'}</span>
          Console
        </button>

        <div className="cs2-console-tabs">
          <button
            type="button"
            className={tab === 'run' ? 'selected' : ''}
            onClick={() => { setTab('run'); setOpen(true) }}
          >
            Run <span className="cs2-console-tally">{changed}/{trace.length}</span>
          </button>
          <button
            type="button"
            className={tab === 'stubs' ? 'selected' : ''}
            title="Ops the preview doesn't implement. Each one returned a zero to the script that asked, so anything downstream of it is a guess."
            onClick={() => { setTab('stubs'); setOpen(true) }}
          >
            Stubbed ops <span className="cs2-console-tally">{stubCount}</span>
          </button>
        </div>

        {open && (
          <div className="cs2-console-controls">
            {tab === 'run' && (
              <>
                <label
                  className="iface-toggle"
                  title={`Hides the ${foreign} hooks belonging to the rest of the gameframe — chatbox, orbs, tab strip, window pane — and stops recording runs that touched nothing of yours at all, so hovering the frame can't push your runs out of the history. A hook stays if it hangs off interface ${editedInterfaceId} or if it changed one of its components.`}
                >
                  <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
                  Only this interface
                </label>
                <label className="iface-toggle" title="Hooks that ran and changed no component. Usually correct — a script guarding on state the preview doesn't have — but it's also what a broken hook looks like.">
                  <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} />
                  No-ops
                </label>
              </>
            )}
            <input
              className="text-input-sized cs2-console-filter"
              value={filter}
              placeholder="Filter — script, 749:6, field…"
              onChange={(e) => setFilter(e.target.value)}
            />
            {tab === 'run' && runs.length > 0 && (
              <button
                type="button"
                className="cs2-console-clear"
                title="Drop the run history. The next repaint starts a fresh Run 1."
                onClick={() => { setRuns([]); nextRunId.current = 0 }}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {open && tab === 'run' && (
        <div className="cs2-console-body">
          {!enabled && <div className="cs2-console-empty">CS2 hooks are off — nothing ran.</div>}
          {enabled && (runs.length === 0 || allEmpty) && (
            <div className="cs2-console-empty">{emptyReason}</div>
          )}
          {enabled && visibleRuns.map((run) => (
            <div key={run.id} className="cs2-run">
              <div className="cs2-run-head">
                <span className="cs2-run-id">Run {run.id}</span>
                <span className="cs2-run-at">{run.at}</span>
                <span className="cs2-run-counts">
                  {plural(run.entries.length, 'hook')}
                  {' · '}
                  {plural(run.entries.reduce((n, e) => n + e.changes.length, 0), 'change')}
                  {run.shown.length !== run.entries.length && ` · ${run.shown.length} shown`}
                </span>
                {run.repeats > 1 && (
                  <span className="cs2-run-repeats" title="Repaints since that produced an identical run — a resize drag or a reselect, not a new result.">
                    ×{run.repeats}
                  </span>
                )}
              </div>
              {/* Set variables that a hook here actually fires on. A varbit
                  reaches scripts through its CONTAINING varp, and no other
                  line connects those two numbers — without this the log reads
                  as though it's discussing a var you never touched. Variables
                  nothing here watches are not reported: the list is global and
                  mostly irrelevant to any one interface, so that isn't a
                  fault worth a warning. */}
              {run.routes.map((r, i) => (
                <div key={i} className="cs2-run-route">
                  <span className="cs2-route-subject">{r.subject}</span>
                  {r.route && <span className="cs2-route-via">{r.route}</span>}
                  <span className="cs2-route-heard">
                    fires {r.watchers.length === 1 ? 'the hook' : 'hooks'} on {r.watchers.join(', ')}
                  </span>
                </div>
              ))}
              {run.shown.map((entry) => (
            <div key={entry.seq} className={`cs2-log-entry${entry.changes.length === 0 ? ' quiet' : ''}`}>
              <div className="cs2-log-row">
                <span className="cs2-log-seq">{entry.seq}</span>
                <span className={`cs2-log-hook hook-${entry.hook}`}>{entry.hook}</span>
                <button
                  type="button"
                  className={`cs2-log-comp${selectable(entry.source) ? ' selectable' : ''}`}
                  title={selectable(entry.source) ? 'Select this component in the editor' : 'The component the hook hangs off'}
                  disabled={!selectable(entry.source)}
                  onClick={() => select(entry.source)}
                >
                  {entry.source}
                </button>
                <button
                  type="button"
                  className="cs2-log-script"
                  title={`Read script ${entry.script}`}
                  onClick={() => setScriptId(entry.script)}
                >
                  script_{entry.script}
                </button>
                {/* ellipsized in a dense row — a transmit line listing several
                    vars and their values easily outruns the column */}
                <span className="cs2-log-trigger" title={entry.trigger}>{entry.trigger}</span>
                {entry.note && <span className="cs2-log-note">{entry.note}</span>}
              </div>
              {entry.changes.length > 0 && (
                <div className="cs2-log-changes">
                  {entry.changes.map((c, i) => (
                    <div key={i} className="cs2-log-change">
                      <button
                        type="button"
                        className={`cs2-log-comp${selectable(c.target) ? ' selectable' : ''}`}
                        disabled={!selectable(c.target)}
                        title={selectable(c.target) ? 'Select this component in the editor' : undefined}
                        onClick={() => select(c.target)}
                      >
                        {c.target}
                      </button>
                      <span className="cs2-log-field">{c.field}</span>
                      {c.from === '' ? (
                        <span className="cs2-log-detail">{c.to}</span>
                      ) : (
                        <>
                          <span className="cs2-log-from">{c.from}</span>
                          <span className="cs2-log-arrow">→</span>
                          <span className="cs2-log-to">{c.to}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {open && tab === 'stubs' && (
        <div className="cs2-console-body">
          {warnings.length === 0 && <div className="cs2-console-empty">Every op the run asked for is implemented.</div>}
          {warnings
            .filter((w) => !filter.trim() || w.op.toLowerCase().includes(filter.trim().toLowerCase()))
            .map((w) => (
              <div key={w.op} className="cs2-log-row">
                <span className="cs2-log-script">{w.op}</span>
                <span className="cs2-log-seq">×{w.count}</span>
                <span className="cs2-log-trigger">{w.example}</span>
              </div>
            ))}
        </div>
      )}

      {scriptId != null && (
        <Cs2ScriptModal
          rootHandle={rootHandle}
          scriptId={scriptId}
          onClose={() => setScriptId(null)}
          onEdit={onEditScript}
        />
      )}
    </div>
  )
}
