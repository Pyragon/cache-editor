import { useEffect, useMemo, useRef, useState } from 'react'
import {
  bitOwners, bitsFor, buildVarbitIndex, invalidateVarbitIndex, peekVarbitIndex, varbitMask,
} from '../loaders/varbitUsage'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { writeJsonItem } from '../loaders/common'
import { NumberInput } from './defFields'
import { useConfirm } from './useConfirm'
import './VarbitViewer.css'

type Props = {
  rootHandle: FileSystemDirectoryHandle
  /** Varbit ids written, plus the var id when a new one was created with them.
   *  The host lists them, jumps to the first, and reports what happened. */
  onCreated?: (ids: number[], varpId: number | null) => void
  onClose: () => void
  /** Offered when the planner opens from the Add button: skip planning and
   *  append a single blank varbit the normal way. */
  onAddSingle?: () => void
}

/** The dump's "no type" paramType: a NUL char, matching the vars loader's
 *  own default. Built at runtime so no source escape can be mangled. */
const NO_PARAM_TYPE = String.fromCharCode(0)

/** One row of the planner: something the user wants to store. */
type PlanField = { name: string; maxValue: number }

// Works out how to pack a set of values into a varp's bits and writes the
// varbits (and the varp, when it needs a new one). The arithmetic is the part
// worth automating: widths come from each field's largest value, `endBit` is
// inclusive, and a new varp only works if it actually exists as a file —
// see EDITOR.md's varbit section for the traced client behaviour.
export default function VarbitPlanner({ rootHandle, onCreated, onClose, onAddSingle }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { confirm, dialog } = useConfirm()

  const [indexVersion, setIndexVersion] = useState(0)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanField[]>([
    { name: 'field 1', maxValue: 47 },
    { name: 'field 2', maxValue: 47 },
  ])
  /** −1 = a brand new varp at the end; otherwise pack into this existing one. */
  const [planVarp, setPlanVarp] = useState(-1)
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<string | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const index = useMemo(() => peekVarbitIndex(), [indexVersion])

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // The planner is useless without knowing which bits are taken, so the scan
  // starts on open rather than behind another click. "Just add one on the end"
  // stays available while it runs.
  useEffect(() => {
    if (peekVarbitIndex()) return
    let cancelled = false
    void (async () => {
      setScanProgress({ phase: 'indexing', done: 0, total: 0 })
      try {
        await buildVarbitIndex(rootHandle, (p) => { if (!cancelled) setScanProgress(p) })
        if (!cancelled) setIndexVersion((v) => v + 1)
      } catch (err) {
        if (!cancelled) setScanError(err instanceof Error ? err.message : 'Scan failed.')
      } finally {
        if (!cancelled) setScanProgress(null)
      }
    })()
    return () => { cancelled = true }
  }, [rootHandle])

  const planRows = useMemo(() => {
    // Existing claims on the target varp, so packing lands in genuinely free bits.
    const target = planVarp >= 0 ? index?.byBaseVar.get(planVarp) : undefined
    const taken = bitOwners(target)
    const rows: { field: PlanField; bits: number; startBit: number; endBit: number; fits: boolean }[] = []
    let cursor = 0
    for (const field of plan) {
      const bits = bitsFor(field.maxValue)
      let start = cursor
      for (; start + bits <= 32; start++) {
        let clear = true
        for (let b = start; b < start + bits; b++) if (taken[b]) { clear = false; break }
        if (clear) break
      }
      const fits = start + bits <= 32
      rows.push({ field, bits, startBit: start, endBit: start + bits - 1, fits })
      if (!fits) { cursor = 32; continue }
      for (let b = start; b < start + bits; b++) taken[b] = { id: -1, startBit: start, endBit: start + bits - 1 }
      cursor = start + bits
    }
    return rows
  }, [plan, planVarp, index])

  const planBits = planRows.reduce((n, r) => n + r.bits, 0)
  const planFits = planRows.length > 0 && planRows.every((r) => r.fits)
  const nextVarbitId = index ? index.maxVarbitId + 1 : null
  const newVarpId = index ? index.varpCount : null
  const planTargetVarp = planVarp >= 0 ? planVarp : newVarpId
  const varpMissing = index != null && planVarp >= index.varpCount

  function setPlanField(i: number, patch: Partial<PlanField>) {
    setPlan((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  }

  async function handleCreate() {
    if (!index || nextVarbitId == null || planTargetVarp == null) return
    const creatingVarp = planVarp < 0
    const ids = planRows.map((_, i) => nextVarbitId + i)
    const fileCount = ids.length + (creatingVarp ? 1 : 0)

    if (!(await confirm(
      <>
        {creatingVarp && (
          <p>
            Create <strong>var {planTargetVarp}</strong> — an empty varp. It only has to exist so
            the client's value array is big enough to index it.
          </p>
        )}
        <p>
          Create <strong>varbit{ids.length === 1 ? '' : 's'} {ids.join(', ')}</strong> on var{' '}
          {planTargetVarp}, claiming bits {planRows.map((r) => `${r.startBit}–${r.endBit}`).join(', ')}.
        </p>
        <p>
          Files are written straight to disk. Nothing outside the cache knows about them yet — the
          server still has to set the varp for these to hold anything.
        </p>
      </>,
      { title: 'Create varbits', confirmLabel: `Create ${fileCount} file${fileCount === 1 ? '' : 's'}` },
    ))) return

    setCreating(true)
    setCreateResult(null)
    let wrote = false
    try {
      if (creatingVarp) {
        const varsDir = await resolveEntryHandle(rootHandle, getEntryPath('config_vars'))
        if (!varsDir) throw new Error('config/vars entry not found in this cache')
        // Matches the vars loader's own defaults — NUL paramType is the dump's
        // "no type", and both varp opcodes are optional in the client.
        await writeJsonItem(varsDir, planTargetVarp, { id: planTargetVarp, paramType: NO_PARAM_TYPE, clientCode: 0 })
      }
      const varbitsDir = await resolveEntryHandle(rootHandle, getEntryPath('varbits'))
      if (!varbitsDir) throw new Error('varbits entry not found in this cache')
      for (let i = 0; i < planRows.length; i++) {
        const row = planRows[i]
        await writeJsonItem(varbitsDir, ids[i], {
          id: ids[i], baseVar: planTargetVarp, startBit: row.startBit, endBit: row.endBit,
        })
      }
      invalidateVarbitIndex()
      wrote = true
    } catch (err) {
      // Stay open on failure — the plan is still on screen to retry or adjust.
      setCreateResult(`Couldn't write the files: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setCreating(false)
    }
    // Handing off closes this modal, so do it after the state above settles.
    if (wrote) {
      onCreated?.(ids, creatingVarp ? planTargetVarp : null)
      onClose()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="varbit-planner-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      {dialog}
      <div className="varbit-planner-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Add varbits</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        {onAddSingle && (
          <div className="varbit-planner-quick">
            <button type="button" className="replace-btn" onClick={onAddSingle}>
              Just add one on the end
            </button>
            <span className="map-sprite-hint">
              a single blank varbit at the next free id, to fill in by hand
            </span>
          </div>
        )}

        <p className="tex-op-note">
          Or say what you need to store and this works out the bit layout. A varp is one 32-bit int
          and a varbit is a slice of it, so each field's width comes from its largest value — a max
          of 47 needs 6 bits, because 6 bits hold 0–63. <strong>End bit is inclusive.</strong>
        </p>

        {scanProgress != null ? (
          <p className="anim-preview-status">{scanLabel(scanProgress, 'varbits')}</p>
        ) : scanError ? (
          <p className="varbit-problem">{scanError}</p>
        ) : !index ? (
          <p className="anim-preview-status">Reading varbits…</p>
        ) : (
          <>
            <div className="quest-table-wrap">
              <table className="quest-table">
                <thead>
                  <tr><th>What it stores</th><th>Largest value</th><th>Bits</th><th>Range</th><th>Holds</th><th /></tr>
                </thead>
                <tbody>
                  {planRows.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="text"
                          className="cell-input"
                          value={row.field.name}
                          onChange={(e) => setPlanField(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <NumberInput
                          className="cell-input"
                          value={row.field.maxValue}
                          min={0}
                          onChange={(v) => setPlanField(i, { maxValue: v })}
                        />
                      </td>
                      <td className="item-stack-index">{row.bits}</td>
                      <td className="item-stack-index">{row.fits ? `${row.startBit}–${row.endBit}` : '—'}</td>
                      <td className="item-stack-index">
                        0–{row.fits ? (varbitMask(row.startBit, row.endBit) >>> 0) : '—'}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="row-remove-btn"
                          disabled={plan.length <= 1}
                          onClick={() => setPlan((prev) => prev.filter((_, j) => j !== i))}
                        >×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="varbit-planner-row">
              <button
                type="button"
                className="add-row-btn"
                onClick={() => setPlan((prev) => [...prev, { name: `field ${prev.length + 1}`, maxValue: 47 }])}
              >
                Add a field
              </button>
              <span className="sprite-zoom-label">
                Pack into
                <NumberInput
                  className="cell-input"
                  value={planVarp}
                  min={-1}
                  title="−1 creates a brand new var at the end of the list. Any other id packs into that existing var's free bits."
                  onChange={setPlanVarp}
                />
              </span>
              <span className="map-sprite-hint">
                {planVarp < 0
                  ? `new var ${newVarpId} — will be created`
                  : varpMissing
                  ? `var ${planVarp} does not exist`
                  : `existing var ${planVarp}`}
              </span>
            </div>

            <p className="map-sprite-hint">
              {planBits} of 32 bits used
              {planFits
                ? nextVarbitId != null && ` · varbit${planRows.length === 1 ? '' : 's'} ${planRows.length === 1 ? nextVarbitId : `${nextVarbitId}–${nextVarbitId + planRows.length - 1}`} free`
                : ' — does not fit, drop a field or split across two vars'}
            </p>

            {varpMissing && (
              <p className="varbit-problem">
                Var {planVarp} does not exist and vars must stay contiguous — the client sizes its
                value array by the var FILE COUNT, so a gap leaves the highest vars unaddressable.
                Use −1 to create the next one in sequence.
              </p>
            )}

            <div className="varbit-planner-row">
              <button
                type="button"
                className="save-bar-save"
                disabled={!planFits || creating || varpMissing}
                onClick={handleCreate}
              >
                {creating ? 'Creating…' : 'Create these varbits'}
              </button>
              {/* only ever a failure now — success closes the modal */}
              {createResult && <span className="varbit-problem">{createResult}</span>}
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
