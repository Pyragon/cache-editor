import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import './Cs2ScriptModal.css'

/**
 * Read-only look at a CS2 script without leaving the interface you're editing.
 *
 * A component's hooks are a script id plus its args, and the id alone tells you
 * nothing — the only way to know whether `onLoad: 817, 5` fills an orb or hides
 * a button is to read script 817. That used to mean navigating away to the cs2
 * entry and losing the component you were working on.
 *
 * Scripts call other scripts constantly (817 is reached through 2298, which is
 * reached from the prayer orb's hook), so `script_N` references are clickable
 * and push onto a back stack — following a chain is the normal way to read one.
 */
/** Tabs are rendered at this size (see .cs2-code) — only used to decide which
 *  line is longest, since a tab counts for more than one column. */
const TAB_SIZE = 2
/** Everything outside the measured row: body padding, source border, and room
 *  for the vertical scrollbar. */
const DIALOG_CHROME = 60

export default function Cs2ScriptModal({ rootHandle, scriptId, onClose }: {
  rootHandle: FileSystemDirectoryHandle | null
  scriptId: number
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])

  /** current id + where we came from, so following a call can be undone */
  const [stack, setStack] = useState<number[]>([scriptId])
  const current = stack[stack.length - 1]
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSource(null)
    setError(null)
    ;(async () => {
      if (!rootHandle) { setError('No cache folder open.'); return }
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('cs2'))
        if (!dir) { setError('This cache has no cs2 dump.'); return }
        const file = await (await dir.getFileHandle(`${current}.cs2`)).getFile()
        const text = await file.text()
        if (!cancelled) setSource(text)
      } catch {
        if (!cancelled) setError(`Script ${current} isn't in the cs2 dump.`)
      }
    })()
    return () => { cancelled = true }
  }, [rootHandle, current])

  // Split the source so `script_N` becomes a link; everything else is plain.
  const lines = (source ?? '').split('\n')

  // Size the dialog to the script. The longest line decides it, and rather
  // than predict its pixel width from a font string — a canvas silently
  // measures in a fallback font if it doesn't like the shorthand, and it knows
  // nothing about tab-size — an off-screen copy of that line is rendered with
  // the REAL row markup and measured. Re-runs whenever the source changes, so
  // following a call to a wider script widens the dialog with it.
  const longest = useMemo(() => {
    let best = ''
    let bestLen = -1
    for (const line of lines) {
      const len = line.replace(/\t/g, ' '.repeat(TAB_SIZE)).length
      if (len > bestLen) { bestLen = len; best = line }
    }
    return best
  }, [lines])

  const measureRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (source === null || !measureRef.current) return
    const row = measureRef.current.getBoundingClientRect().width
    setWidth(Math.min(Math.ceil(row + DIALOG_CHROME), window.innerWidth * 0.94))
  }, [source, longest])

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog cs2-dialog"
      style={width ? { width: `${width}px` } : undefined}
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body cs2-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">
            {stack.length > 1 && (
              <button
                type="button"
                className="cs2-back"
                title="Back to the script that called this one"
                onClick={() => setStack((s) => s.slice(0, -1))}
              >
                ←
              </button>
            )}
            Script {current}
          </h3>
          <span className="anim-fit-actions">
            {stack.length > 1 && <span className="cs2-trail">from {stack.slice(0, -1).join(' → ')}</span>}
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>

        {error && <div className="cs2-error">{error}</div>}
        {!error && source === null && <div className="cs2-loading">Loading…</div>}

        {/* off-screen twin of one source row, in the same markup and styles,
            so the width below is what the browser will actually lay out */}
        {source !== null && (
          <div className="cs2-measure-box" aria-hidden>
            <div className="cs2-line cs2-measure" ref={measureRef}>
              <span className="cs2-lineno">{lines.length}</span>
              <code className="cs2-code">{longest}</code>
            </div>
          </div>
        )}

        {source !== null && (
          <div className="cs2-source">
            {lines.map((line, i) => (
              <div key={i} className="cs2-line">
                <span className="cs2-lineno">{i + 1}</span>
                <code className="cs2-code">{renderLine(line, (id) => setStack((s) => [...s, id]))}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  )
}

/** `script_N` references become buttons; the rest of the line is text. */
function renderLine(line: string, onFollow: (id: number) => void) {
  const parts: React.ReactNode[] = []
  const re = /\bscript_(\d+)\b/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index))
    const id = Number(m[1])
    parts.push(
      <button
        key={`${m.index}-${id}`}
        type="button"
        className="cs2-ref"
        title={`Open script ${id}`}
        onClick={() => onFollow(id)}
      >
        {m[0]}
      </button>,
    )
    last = m.index + m[0].length
  }
  parts.push(line.slice(last))
  return parts
}
