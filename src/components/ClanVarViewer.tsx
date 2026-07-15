import { useEffect, useState } from 'react'
import { NumberInput } from './defFields'
import type { ClanVarDef } from '../loaders/config/clan_var'
import type { JsonDefData } from '../loaders/common'
import { TYPE_LABELS, typeLabel } from './typeChars'
import './ClanVarViewer.css'

type Props = {
  data: JsonDefData<ClanVarDef>
  /** "Clan Var" or "Clan Setting" — the two entries share this shape. */
  title: string
  onSave: (data: JsonDefData<ClanVarDef>) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Selects another var of the same entry (clicking a neighbour in the bit map). */
  onOpenVar?: (id: number) => void
}

const NO_TYPE = '\u0000'

// All-zero triple = unpacked (the dump can't distinguish an absent packing
// opcode from a packing into base 0, bit 0 — no real def does the latter).
const isPackedDef = (d: ClanVarDef) => d.baseVar !== 0 || d.startBit !== 0 || d.endBit !== 0

// One folder scan per session per entry, shared across selections — the map
// needs every def to find the ones packed into the same base word.
const defsCache = new WeakMap<FileSystemDirectoryHandle, Promise<ClanVarDef[]>>()
function scanDefs(dir: FileSystemDirectoryHandle): Promise<ClanVarDef[]> {
  let promise = defsCache.get(dir)
  if (!promise) {
    promise = (async () => {
      const files: FileSystemFileHandle[] = []
      for await (const handle of dir.values()) {
        if (handle.kind === 'file' && handle.name.endsWith('.json')) files.push(handle)
      }
      const defs = await Promise.all(files.map(async (fh) => {
        try {
          return JSON.parse(await (await fh.getFile()).text()) as ClanVarDef
        } catch {
          return null
        }
      }))
      return defs.filter((d): d is ClanVarDef => d != null)
    })()
    defsCache.set(dir, promise)
  }
  return promise
}

type Neighbour = { id: number; startBit: number; endBit: number }

// Greedy interval packing: fit the neighbours into as few display lanes as
// possible (a fully-packed base word of 32 one-bit flags is a single lane).
function packLanes(neighbours: Neighbour[]): Neighbour[][] {
  const sorted = [...neighbours].sort((a, b) => a.startBit - b.startBit || a.id - b.id)
  const lanes: { items: Neighbour[]; lastEnd: number }[] = []
  for (const n of sorted) {
    const lane = lanes.find((l) => l.lastEnd < n.startBit)
    if (lane) {
      lane.items.push(n)
      lane.lastEnd = n.endBit
    } else {
      lanes.push({ items: [n], lastEnd: n.endBit })
    }
  }
  return lanes.map((l) => l.items)
}

// The interactive 32-bit register: bit 0 leftmost. Drag across cells to set
// this var's range; the lanes below map every neighbour in the same base word.
function BitMap({ startBit, endBit, neighbours, onRange, onOpenVar }: {
  startBit: number
  endBit: number
  neighbours: Neighbour[]
  onRange: (start: number, end: number) => void
  onOpenVar?: (id: number) => void
}) {
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null)

  useEffect(() => {
    if (!drag) return
    const commit = () => {
      onRange(Math.min(drag.anchor, drag.current), Math.max(drag.anchor, drag.current))
      setDrag(null)
    }
    window.addEventListener('pointerup', commit)
    return () => window.removeEventListener('pointerup', commit)
  }, [drag, onRange])

  const selStart = drag ? Math.min(drag.anchor, drag.current) : startBit
  const selEnd = drag ? Math.max(drag.anchor, drag.current) : endBit

  const clashes = new Set<number>()
  for (const n of neighbours) {
    for (let b = Math.max(n.startBit, selStart); b <= Math.min(n.endBit, selEnd); b++) clashes.add(b)
  }

  const cells = []
  for (let b = 0; b <= 31; b++) cells.push(b)
  const lanes = packLanes(neighbours)

  return (
    <div className="bitmap">
      <div className="bitmap-row bitmap-cells">
        {cells.map((b) => (
          <div
            key={b}
            className={
              'bit-cell' +
              (b >= selStart && b <= selEnd ? ' bit-sel' : '') +
              (clashes.has(b) ? ' bit-clash' : '')
            }
            title={`bit ${b}`}
            onPointerDown={(e) => { e.preventDefault(); setDrag({ anchor: b, current: b }) }}
            onPointerEnter={() => drag && setDrag((d) => (d ? { ...d, current: b } : d))}
          >
            {b}
          </div>
        ))}
      </div>
      {lanes.map((lane, i) => (
        <div key={i} className="bitmap-row bitmap-lane">
          {lane.map((n) => (
            <button
              key={n.id}
              type="button"
              className="bit-span"
              style={{ gridColumn: `${n.startBit + 1} / ${n.endBit + 2}` }}
              title={`${n.id} — bits ${n.startBit}–${n.endBit} (click to open)`}
              onClick={() => onOpenVar?.(n.id)}
            >
              {n.endBit - n.startBit >= 1 ? n.id : ''}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

// Clan variables / clan settings: a type char plus an optional varbit-style
// packing (baseVar + start/end bit) into a base clan var.
export default function ClanVarViewer({ data, title, onSave, onDirtyChange, onOpenVar }: Props) {
  const [draft, setDraft] = useState<ClanVarDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [allDefs, setAllDefs] = useState<ClanVarDef[] | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Scan the entry folder once (cached) so the bit map can show neighbours.
  useEffect(() => {
    let cancelled = false
    setAllDefs(null)
    if (!data.dir) { setAllDefs([]); return }
    scanDefs(data.dir).then((defs) => { if (!cancelled) setAllDefs(defs) })
    return () => { cancelled = true }
  }, [data])

  function set<K extends keyof ClanVarDef>(key: K, value: ClanVarDef[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setRange(start: number, end: number) {
    setDraft((prev) => ({ ...prev, startBit: start, endBit: end }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    // The neighbour cache holds this def's old packing now.
    if (data.dir) defsCache.delete(data.dir)
    setIsSaving(false)
    setIsDirty(false)
  }

  const isKnown = draft.paramType === NO_TYPE || Boolean(TYPE_LABELS[draft.paramType])
  const isPacked = isPackedDef(draft)
  const bits = draft.endBit - draft.startBit + 1
  const maxValue = bits >= 1 && bits <= 32 ? 2 ** bits - 1 : 0

  const neighbours: Neighbour[] = (allDefs ?? [])
    .filter((d) => d.id !== data.id && isPackedDef(d) && d.baseVar === draft.baseVar)
    .map((d) => ({ id: d.id, startBit: d.startBit, endBit: d.endBit }))
  const clashIds = neighbours
    .filter((n) => n.startBit <= draft.endBit && n.endBit >= draft.startBit)
    .map((n) => n.id)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">{title} {data.id}</span>
          <span className="enum-count">
            {draft.paramType === NO_TYPE ? 'no type' : typeLabel(draft.paramType)}
          </span>
          {isPacked && (
            <span className="item-id-badge">
              {bits} bit{bits === 1 ? '' : 's'} of base var {draft.baseVar}
            </span>
          )}
        </div>
      </div>

      <section className="item-section">
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Param Type</span>
            <select
              className="item-stackable-select"
              value={isKnown ? draft.paramType : '__other'}
              onChange={(e) => { if (e.target.value !== '__other') set('paramType', e.target.value) }}
            >
              <option value={NO_TYPE}>none</option>
              {Object.entries(TYPE_LABELS).map(([char, label]) => (
                <option key={char} value={char}>{char} — {label}</option>
              ))}
              {!isKnown && <option value="__other">{draft.paramType} — unknown</option>}
            </select>
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>Bit Packing</h3>
        <p className="tex-op-note">
          Like a varbit into a varp: this value occupies bits {draft.startBit}–{draft.endBit} of
          base {title.toLowerCase()} {draft.baseVar}. All zeros means the var stands alone. Drag
          across the register below to set the range; the lanes underneath are the other vars
          packed into the same base word (click one to open it).
        </p>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Base Var</span>
            <NumberInput className="item-field-input" value={draft.baseVar} onChange={(v) => set('baseVar', v)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Start Bit</span>
            <NumberInput className="item-field-input" value={draft.startBit} onChange={(v) => set('startBit', v)} min={0} max={31} />
          </label>
          <label className="item-field">
            <span className="item-field-label">End Bit</span>
            <NumberInput className="item-field-input" value={draft.endBit} onChange={(v) => set('endBit', v)} min={0} max={31} />
          </label>
        </div>

        <BitMap
          startBit={draft.startBit}
          endBit={draft.endBit}
          neighbours={neighbours}
          onRange={setRange}
          onOpenVar={onOpenVar}
        />
        <p className="tex-op-note bitmap-meta">
          {bits >= 1
            ? `${bits} bit${bits === 1 ? '' : 's'} selected — values 0–${maxValue.toLocaleString()}`
            : 'End bit is before start bit — the range is invalid.'}
          {allDefs == null && ' · scanning the entry for neighbours…'}
          {allDefs != null && isPacked && ` · ${neighbours.length} other var${neighbours.length === 1 ? '' : 's'} in base ${draft.baseVar}`}
        </p>
        {clashIds.length > 0 && (
          <p className="bitmap-clash-warning">
            ⚠ Overlaps {clashIds.length === 1 ? 'var' : 'vars'} {clashIds.join(', ')} — two vars
            sharing bits will corrupt each other's values.
          </p>
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
