// Shared building blocks for definition editors (items, objects, ...).
// Styling comes from ItemViewer.css / QuestViewer.css / SpriteViewer.css —
// component CSS is global in this app by convention.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ParamRow } from './defParams'

// Item icon served from public/icons (fetched by scripts/download-icons.mjs).
// Renders an empty placeholder for ids with no downloaded icon. Keyed by id:
// reusing one <img> keeps SHOWING the previous item's icon until the new file
// finishes fetching (slow over the network), which reads as a laggy update —
// a fresh element goes blank immediately and fills in when ready.
export function ItemIcon({ id }: { id: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [id])
  if (failed || id < 0) return <span className="item-icon item-icon-empty" />
  return (
    <img
      key={id}
      className="item-icon"
      src={`${import.meta.env.BASE_URL}icons/${id}.png`}
      alt=""
      onError={() => setFailed(true)}
    />
  )
}

// Number input with styled −/+ steppers instead of the browser's tiny
// unstyled spinner arrows (hidden via .num-input in ItemViewer.css).
// `className` picks the surrounding field style (item-field-input in grids,
// cell-input in tables) so it drops into either context.
export function NumberInput({ value, onChange, className = 'item-field-input', step = 1, min, max, title, placeholder }: {
  value: number
  onChange: (value: number) => void
  className?: string
  step?: number
  min?: number
  max?: number
  title?: string
  placeholder?: string
}) {
  // While focused, the field is free text (digits and a leading minus) so
  // intermediate states like "" or "-" survive typing — a controlled
  // type="number" input snapped those straight back to 0, which made
  // clearing a 0 to type 1000 produce 01000 and negatives untypeable. Only
  // fully valid integers are committed to the draft; blur snaps the text
  // back to the last committed value, so nothing invalid can ever be saved.
  const [text, setText] = useState<string | null>(null)

  function clamp(next: number): number {
    if (min != null && next < min) return min
    if (max != null && next > max) return max
    return next
  }

  return (
    <span className="num-input" title={title}>
      <input
        className={`${className} num-input-field`}
        type="text"
        inputMode="numeric"
        value={text ?? String(Number.isFinite(value) ? value : 0)}
        placeholder={placeholder}
        onFocus={() => setText(String(Number.isFinite(value) ? value : 0))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          const raw = e.target.value
          if (!/^-?\d*$/.test(raw)) return // reject non-numeric keystrokes
          setText(raw)
          if (/^-?\d+$/.test(raw)) onChange(clamp(parseInt(raw, 10)))
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setText(null); onChange(clamp(value + step)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setText(null); onChange(clamp(value - step)) }
        }}
      />
      <span className="num-input-steps">
        <button
          type="button"
          className="num-input-step"
          tabIndex={-1}
          disabled={min != null && value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </button>
        <button
          type="button"
          className="num-input-step"
          tabIndex={-1}
          disabled={max != null && value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </span>
    </span>
  )
}

export type NumFieldDef = [key: string, label: string]

// Clickable sorting header for read-only tables: first click sorts ascending,
// clicking the active column flips direction. (Editable tables deliberately
// don't use this — their edit handlers address rows by index.)
export type SortState = { key: string; dir: 1 | -1 }

export function SortableTh({ label, sortKey, sort, onSort }: {
  label: string
  sortKey: string
  sort: SortState | null
  onSort: (next: SortState) => void
}) {
  const [hovered, setHovered] = useState(false)
  const active = sort?.key === sortKey
  // The arrow always previews what a click gives you: inactive columns show a
  // faded ascending arrow on hover (CSS opacity), the active column flips its
  // arrow to the other direction while hovered.
  const arrow = active
    ? ((hovered ? -sort!.dir : sort!.dir) === 1 ? '▲' : '▼')
    : '▲'
  return (
    <th
      className={`sortable-th${active ? ' active' : ''}`}
      title={`Sort by ${label.toLowerCase()}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSort(active ? { key: sortKey, dir: -sort!.dir as 1 | -1 } : { key: sortKey, dir: 1 })}
    >
      {label}
      <span className="sortable-th-arrow">{arrow}</span>
    </th>
  )
}

// A cell's id link to another entry's viewer (e.g. modelId → the model
// viewer), rendered as a small button in the cell's top-right corner.
export type FieldLink = { label: string; onOpen: (value: number) => void }

export function NumGrid({ fields, values, onChange, links, fieldExtra }: {
  fields: NumFieldDef[]
  values: Record<string, unknown>
  onChange: (key: string, value: number) => void
  links?: Record<string, FieldLink | undefined>
  /** Extra content under a field's input (e.g. the NPC sound mini-player).
      Fields with extras render as a div, not a label — interactive extras
      inside a label would fight its click-to-focus behaviour. */
  fieldExtra?: Record<string, ReactNode | undefined>
}) {
  return (
    <div className="item-grid">
      {fields.map(([key, label]) => {
        const value = Number(values[key] ?? 0)
        const link = links?.[key]
        const extra = fieldExtra?.[key]
        const Wrapper = extra != null ? 'div' : 'label'
        return (
          <Wrapper key={key} className="item-field">
            <span className={`item-field-label${link ? ' field-link-label' : ''}`} title={label}>
              {link ? (
                <>
                  <span>{label}</span>
                  {value >= 0 && (
                    <button
                      type="button"
                      className="field-link-btn"
                      title={`Open ${value} in its viewer`}
                      onClick={(e) => { e.preventDefault(); link.onOpen(value) }}
                    >
                      {link.label}
                    </button>
                  )}
                </>
              ) : (
                label
              )}
            </span>
            <NumberInput value={value} onChange={(v) => onChange(key, v)} />
            {extra}
          </Wrapper>
        )
      })}
    </div>
  )
}

export function ToggleGrid({ fields, values, onChange }: {
  fields: NumFieldDef[]
  values: Record<string, unknown>
  onChange: (key: string, value: boolean) => void
}) {
  return (
    <div className="item-grid">
      {fields.map(([key, label]) => (
        <label key={key} className="item-field def-toggle-field">
          <span className="item-field-label" title={label}>{label}</span>
          <span className="sprite-toggle">
            <input
              type="checkbox"
              checked={Boolean(values[key])}
              onChange={(e) => onChange(key, e.target.checked)}
            />
            <span className="sprite-toggle-track" />
          </span>
        </label>
      ))}
    </div>
  )
}

// Comma-separated integer list. Empty input reports undefined so callers
// can drop the key entirely (matching how absent arrays are omitted).
export function IntListInput({ value, onChange, placeholder }: {
  value: number[] | undefined
  onChange: (value: number[] | undefined) => void
  placeholder?: string
}) {
  return (
    <input
      className="def-int-list"
      type="text"
      placeholder={placeholder ?? '—'}
      value={(value ?? []).join(', ')}
      onChange={(e) => {
        const trimmed = e.target.value.trim()
        if (trimmed === '') {
          onChange(undefined)
          return
        }
        const parsed = trimmed.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        onChange(parsed)
      }}
    />
  )
}

export function PairTable({ title, srcLabel, dstLabel, src, dst, onSet, onAdd, onRemove, srcIcon, cellExtra }: {
  title: string
  srcLabel: string
  dstLabel: string
  src: number[]
  dst: number[]
  onSet: (index: number, which: 0 | 1, value: number) => void
  onAdd: () => void
  onRemove: (index: number) => void
  // Optional leading icon column rendered from each row's src value.
  srcIcon?: (value: number) => ReactNode
  // Optional adornment rendered beside EVERY value input (both columns) —
  // e.g. an HSL16 colour swatch, or a View jump link for texture ids.
  cellExtra?: (value: number) => ReactNode
}) {
  const cell = (value: number, i: number, which: 0 | 1) => (
    <td>
      {cellExtra ? (
        <span className="pair-cell-inner">
          <NumberInput className="cell-input" value={value} onChange={(v) => onSet(i, which, v)} />
          {cellExtra(value)}
        </span>
      ) : (
        <NumberInput className="cell-input" value={value} onChange={(v) => onSet(i, which, v)} />
      )}
    </td>
  )
  return (
    <section className="item-section">
      <h3>{title}</h3>
      {src.length > 0 && (
        <div className="quest-table-wrap item-pair-wrap">
          <table className="quest-table">
            <thead><tr>{srcIcon && <th className="pair-icon-th" />}<th>{srcLabel}</th><th>{dstLabel}</th><th>Remove</th></tr></thead>
            <tbody>
              {src.map((s, i) => (
                <tr key={i}>
                  {srcIcon && <td className="pair-icon-cell">{srcIcon(s)}</td>}
                  {cell(s, i, 0)}
                  {cell(dst[i] ?? 0, i, 1)}
                  <td><button type="button" className="row-remove-btn" onClick={() => onRemove(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="add-row-btn" onClick={onAdd}>+ Add pair</button>
    </section>
  )
}

export function ParamsTable({ rows, onSet, onAdd, onRemove, rowAnnotation }: {
  rows: ParamRow[]
  onSet: (index: number, patch: Partial<ParamRow>) => void
  onAdd: () => void
  onRemove: (index: number) => void
  /** Optional inline note rendered after a row's value input (e.g. the item
      viewer labels param 644 "(Render Anim)" with a BAS jump link). */
  rowAnnotation?: (row: ParamRow) => React.ReactNode
}) {
  return (
    <>
      {rows.length > 0 && (
        <div className="quest-table-wrap item-params-wrap">
          <table className="quest-table">
            <thead><tr><th>Key</th><th>Type</th><th>Value</th><th>Remove</th></tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td style={{ width: 110 }}>
                    <input className="cell-input" type="number" value={row.key}
                      onChange={(e) => onSet(i, { key: e.target.value })} />
                  </td>
                  <td style={{ width: 90 }}>
                    <select
                      className="item-stackable-select"
                      value={row.isString ? 'string' : 'int'}
                      onChange={(e) => onSet(i, { isString: e.target.value === 'string' })}
                    >
                      <option value="int">int</option>
                      <option value="string">string</option>
                    </select>
                  </td>
                  <td>
                    <span className="param-value-cell">
                      <input className="cell-input" type={row.isString ? 'text' : 'number'} value={row.value}
                        onChange={(e) => onSet(i, { value: e.target.value })} />
                      {rowAnnotation?.(row)}
                    </span>
                  </td>
                  <td><button type="button" className="row-remove-btn" onClick={() => onRemove(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="add-row-btn" onClick={onAdd}>+ Add param</button>
    </>
  )
}
