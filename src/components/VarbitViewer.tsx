import { useEffect, useMemo, useState } from 'react'
import type { VarbitData, VarbitDef } from '../loaders/varbits'
import {
  bitOwners, buildVarbitIndex, invalidateVarbitIndex, peekVarbitIndex, varbitMask,
} from '../loaders/varbitUsage'
import type { VarbitUse } from '../loaders/varbitUsage'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import './VarbitViewer.css'

type Props = {
  data: VarbitData
  onSave: (data: VarbitData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

const FIELDS: NumFieldDef[] = [
  ['baseVar', 'Base Var'],
  ['startBit', 'Start Bit'],
  ['endBit', 'End Bit'],
]

export default function VarbitViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<VarbitDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const [indexVersion, setIndexVersion] = useState(0)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // peek() isn't reactive — indexVersion is what re-reads it after a scan or save
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const index = useMemo(() => peekVarbitIndex(), [indexVersion, data])

  const width = draft.endBit - draft.startBit + 1
  const maxValue = width > 0 && width <= 32 ? varbitMask(draft.startBit, draft.endBit) >>> 0 : 0

  // --- Validation, in the client's own terms -------------------------------
  const problems: string[] = []
  if (draft.endBit < draft.startBit) {
    problems.push(`End bit ${draft.endBit} is below start bit ${draft.startBit}. The client indexes BIT_MASKS[endBit − startBit], so a negative width throws immediately.`)
  }
  if (draft.startBit < 0 || draft.endBit > 31) {
    problems.push('A var is one 32-bit int, so bits run 0–31. BIT_MASKS only has 32 entries; anything past bit 31 is out of range.')
  }
  if (index && draft.baseVar >= index.varpCount) {
    problems.push(`Var ${draft.baseVar} does not exist — the cache has ${index.varpCount} vars (0–${index.maxVarpId}). The client allocates its value array as IntArray(varCount), so reading this varbit indexes past the end of it. Create var ${draft.baseVar} first.`)
  }
  if (index && index.varpGaps.length > 0) {
    problems.push(`The vars entry is missing id${index.varpGaps.length === 1 ? '' : 's'} ${index.varpGaps.slice(0, 6).join(', ')}${index.varpGaps.length > 6 ? '…' : ''}. The client sizes its value array by the FILE COUNT, so a gap leaves the highest vars unaddressable.`)
  }

  const siblings = index?.byBaseVar.get(draft.baseVar) ?? []
  const overlaps = siblings.filter((u) => (
    u.id !== data.id && u.startBit <= draft.endBit && u.endBit >= draft.startBit
  ))
  const owners = bitOwners(siblings)

  async function handleScan() {
    if (!data.rootHandle) return
    setScanProgress({ phase: 'indexing', done: 0, total: 0 })
    try {
      await buildVarbitIndex(data.rootHandle, setScanProgress)
      setIndexVersion((v) => v + 1)
    } finally {
      setScanProgress(null)
    }
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    invalidateVarbitIndex()
    setIndexVersion((v) => v + 1)
    setIsSaving(false)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Varbit {data.id}</span>
          <span className="enum-count">
            bits {draft.startBit}–{draft.endBit} of var {draft.baseVar}
          </span>
          {width > 0 && width <= 32 && (
            <span className="item-stack-index">
              {width} bit{width === 1 ? '' : 's'} · values 0–{maxValue.toLocaleString()}
            </span>
          )}
          {onNavigate && (
            <button
              type="button"
              className="anim-skeleton-chip"
              title={`Open var ${draft.baseVar}`}
              onClick={() => onNavigate('config_vars', draft.baseVar)}
            >
              var {draft.baseVar}
            </button>
          )}
        </div>
      </div>

      <p className="tex-op-note">
        A <strong>var</strong> (varp) is one 32-bit player variable. A <strong>varbit</strong> is a
        named slice of one — the client reads it as{' '}
        <code>activeVars[baseVar] &gt;&gt; startBit &amp; mask</code>, where the mask covers{' '}
        <code>endBit − startBit + 1</code> bits. <strong>End bit is inclusive</strong>, so bits 0–5
        is six bits holding 0–63. Values outside that range are stored as 0 rather than clamped.
      </p>

      <section className="item-section">
        <h3>Placement</h3>
        <NumGrid
          fields={FIELDS}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => { setDraft((prev) => ({ ...prev, [k]: v })); setIsDirty(true) }}
        />

        {problems.map((p, i) => (
          <p key={i} className="varbit-problem">{p}</p>
        ))}

        {overlaps.length > 0 && (
          <p className="varbit-problem">
            Overlaps varbit{overlaps.length === 1 ? '' : 's'}{' '}
            {overlaps.map((u) => `${u.id} (bits ${u.startBit}–${u.endBit})`).join(', ')} on the same
            var. Both would read and write the same bits, corrupting each other.
          </p>
        )}
      </section>

      <section className="item-section">
        <h3>Var {draft.baseVar} bit map</h3>
        {!index ? (
          scanProgress != null ? (
            <p className="anim-preview-status">{scanLabel(scanProgress, 'varbits')}</p>
          ) : (
            <div className="map-sprite-uses-scan">
              <button type="button" className="cursor-pick-btn" disabled={!data.rootHandle} onClick={handleScan}>
                Scan varbits
              </button>
              <span className="map-sprite-hint">
                reads every varbit (~12k files) once to work out which bits of each var are already
                taken, then cached for the session
              </span>
            </div>
          )
        ) : (
          <>
            <p className="map-sprite-hint">
              Bit 0 is on the left. {siblings.length} varbit{siblings.length === 1 ? '' : 's'} pack
              into var {draft.baseVar}; {owners.filter((o) => o == null).length} of 32 bits are free.
            </p>
            <div className="varbit-bitmap">
              {owners.map((owner, bit) => {
                const mine = bit >= draft.startBit && bit <= draft.endBit
                const cls = mine ? 'mine' : owner ? 'taken' : 'free'
                return (
                  <button
                    key={bit}
                    type="button"
                    className={`varbit-bit ${cls}`}
                    title={
                      mine
                        ? `Bit ${bit} — this varbit (${data.id})`
                        : owner
                        ? `Bit ${bit} — varbit ${owner.id} (bits ${owner.startBit}–${owner.endBit})`
                        : `Bit ${bit} — free`
                    }
                    disabled={!owner || owner.id === data.id || !onNavigate}
                    onClick={() => owner && onNavigate?.('varbits', owner.id)}
                  >
                    {bit}
                  </button>
                )
              })}
            </div>
            {siblings.length > 0 && (
              <div className="quest-table-wrap">
                <table className="quest-table">
                  <thead>
                    <tr><th>Varbit</th><th>Bits</th><th>Width</th><th>Values</th></tr>
                  </thead>
                  <tbody>
                    {siblings.map((u: VarbitUse) => (
                      <tr key={u.id} className={u.id === data.id ? 'linked-hover' : undefined}>
                        <td>
                          {onNavigate && u.id !== data.id ? (
                            <button type="button" className="field-link-btn" onClick={() => onNavigate('varbits', u.id)}>{u.id}</button>
                          ) : (
                            <span className="item-stack-index">{u.id}</span>
                          )}
                        </td>
                        <td className="item-stack-index">{u.startBit}–{u.endBit}</td>
                        <td className="item-stack-index">{u.endBit - u.startBit + 1}</td>
                        <td className="item-stack-index">0–{varbitMask(u.startBit, u.endBit) >>> 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
