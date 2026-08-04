// Shared building blocks for definition editors (items, objects, ...).
// Styling comes from ItemViewer.css / QuestViewer.css / SpriteViewer.css —
// component CSS is global in this app by convention.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
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
export function NumberInput({ value, onChange, className = 'item-field-input', step = 1, min, max, title, placeholder, digits, onStep, inputRef }: {
  value: number
  onChange: (value: number) => void
  className?: string
  step?: number
  min?: number
  max?: number
  title?: string
  placeholder?: string
  /** How many digits this field can hold (callers know: a viewport is 3-4, a
   *  colour channel 3...). Sizes the field to the content instead of filling
   *  its container, and gives it a visible bordered box — standalone fields
   *  are otherwise background-on-background. Omit inside tables/grids, where
   *  the cell provides the sizing and chrome. */
  digits?: number
  /** Takes over the steppers and Arrow keys so a field can walk a set of valid
   *  values instead of every integer (e.g. only the items that fit an
   *  equipment slot). The owner calls `onChange` itself, which lets the search
   *  be async. Typing is unaffected — free entry still works, so an out-of-set
   *  value can be entered and flagged rather than blocked. */
  onStep?: (current: number, direction: 1 | -1) => void
  /** Handle on the underlying field, for callers that want to focus it. */
  inputRef?: Ref<HTMLInputElement>
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

  function bump(direction: 1 | -1) {
    if (onStep) onStep(value, direction)
    else onChange(clamp(value + direction * step))
  }

  return (
    <span
      className={`num-input${digits ? ' num-input-sized' : ''}`}
      title={title}
      // digits·ch content + 6px left pad + 41px stepper reserve + 2px borders
      style={digits ? { width: `calc(${digits + 1}ch + 49px)` } : undefined}
    >
      <input
        ref={inputRef}
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
          if (e.key === 'ArrowUp') { e.preventDefault(); setText(null); bump(1) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setText(null); bump(-1) }
        }}
      />
      <span className="num-input-steps">
        <button
          type="button"
          className="num-input-step"
          tabIndex={-1}
          disabled={!onStep && min != null && value <= min}
          onClick={() => bump(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="num-input-step"
          tabIndex={-1}
          disabled={!onStep && max != null && value >= max}
          onClick={() => bump(1)}
        >
          +
        </button>
      </span>
    </span>
  )
}

// A 24-bit colour as `#RRGGBB`. The cache stores these as plain integers, and
// nobody reads 12047514 as a colour — hex is what the value actually means.
// Free text while focused (same reason as NumberInput: a controlled field that
// re-canonicalises every keystroke can't be edited), committing only on a full
// six digits, so half-typed values can never reach the draft.
export function HexColorInput({ value, onChange, className = 'hex-input', disabled, title }: {
  value: number
  onChange: (value: number) => void
  className?: string
  disabled?: boolean
  title?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const canonical = `#${(value & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`

  return (
    <input
      className={className}
      type="text"
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      title={title}
      value={text ?? canonical}
      onFocus={() => setText(canonical)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value.trim()
        if (!/^#?[0-9a-fA-F]{0,6}$/.test(raw)) return // reject non-hex keystrokes
        const digits = raw.replace('#', '')
        setText(`#${digits.toUpperCase()}`)
        if (digits.length === 6) onChange(parseInt(digits, 16))
      }}
    />
  )
}

/**
 * A field in a NumGrid / ToggleGrid. The optional third element explains what
 * the field does, in one of two weights:
 *
 * - a **string** becomes a hover `title` on the whole cell — cheap, unobtrusive,
 *   and the right choice for pages with dozens of fields (objects, npcs, items).
 * - **JSX** becomes a "?" disclosure that expands under the input, for pages
 *   where a field needs real prose (the ground editors).
 */
export type NumFieldDef = [key: string, label: string, help?: ReactNode]

// A field's "?" disclosure. Definition pages carry a lot of hard-won meaning
// per field (which opcode wrote it, what the client actually does with it,
// which values are sentinels) and a `title` tooltip is too small a surface for
// it — this keeps the grid scannable but puts the explanation one click away.
export function HelpToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`field-help-btn${open ? ' open' : ''}`}
      title={open ? 'Hide explanation' : 'What does this field do?'}
      aria-expanded={open}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle() }}
    >
      ?
    </button>
  )
}

/** The app's table-cell dropdown: a styled trigger + menu rather than a native
 *  `<select>`, which the OS paints in its own chrome and refuses to theme. Any
 *  in-table picker should be this — `.cell-select` is the unstyled fallback and
 *  looks foreign next to it. Values may be numbers or strings so enum-ish
 *  columns (a var's kind, a quest's difficulty) use the same control. */
export function CellDropdown<T extends string | number>({ value, options, onChange, title }: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="cell-dropdown-wrap">
      <button
        type="button"
        className={`cell-dropdown-trigger${open ? ' open' : ''}`}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
        <span className="badge-dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="cell-dropdown-menu">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`cell-dropdown-item${opt.value === value ? ' active' : ''}`}
              title={opt.hint}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One labelled field cell with an optional "?" explanation. Renders as a
 *  `<label>` (so clicking the label focuses the input) unless it holds
 *  something interactive — a help toggle or an extra — because nested
 *  interactive elements fight a label's click-to-focus. */
export function Field({ label, help, children, className }: {
  label: string
  help?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const Wrapper = help != null ? 'div' : 'label'
  return (
    <Wrapper className={`item-field${className ? ` ${className}` : ''}`}>
      <span className={`item-field-label${help != null ? ' has-help' : ''}`}>
        <span className="field-label-text" title={label}>{label}</span>
        {help != null && <HelpToggle open={open} onToggle={() => setOpen((o) => !o)} />}
      </span>
      {children}
      {open && help != null && <div className="field-help-text">{help}</div>}
    </Wrapper>
  )
}

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
  const [openHelp, setOpenHelp] = useState<string | null>(null)
  return (
    <div className="item-grid">
      {fields.map(([key, label, help]) => {
        const value = Number(values[key] ?? 0)
        const link = links?.[key]
        const extra = fieldExtra?.[key]
        // string help = hover tooltip on the cell; JSX help = "?" disclosure
        const tip = typeof help === 'string' ? help : undefined
        const rich = typeof help === 'string' ? undefined : help
        const helpOpen = openHelp === key
        const Wrapper = extra != null || rich != null ? 'div' : 'label'
        return (
          <Wrapper key={key} className="item-field" title={tip}>
            <span
              className={`item-field-label${link ? ' field-link-label' : ''}${rich != null ? ' has-help' : ''}`}
              title={tip ? undefined : label}
            >
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
              ) : rich != null ? (
                <span className="field-label-text">{label}</span>
              ) : (
                label
              )}
              {rich != null && (
                <HelpToggle open={helpOpen} onToggle={() => setOpenHelp(helpOpen ? null : key)} />
              )}
            </span>
            <NumberInput value={value} onChange={(v) => onChange(key, v)} />
            {extra}
            {helpOpen && rich != null && <div className="field-help-text">{rich}</div>}
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
  const [openHelp, setOpenHelp] = useState<string | null>(null)
  return (
    <div className="item-grid">
      {fields.map(([key, label, help]) => {
        const helpOpen = openHelp === key
        const tip = typeof help === 'string' ? help : undefined
        const rich = typeof help === 'string' ? undefined : help
        // The checkbox itself is `display: none` — something must be a <label>
        // for a click to reach it. Without a "?" that's the whole cell (the
        // long-standing behaviour); with one the cell has to be a <div>,
        // because a help button nested in a label would toggle the flag, so
        // the switch carries its own label instead. A plain string tooltip
        // doesn't add anything interactive, so it keeps the label cell.
        const Wrapper = rich != null ? 'div' : 'label'
        const ToggleTag = rich != null ? 'label' : 'span'
        return (
          <Wrapper key={key} className="item-field def-toggle-field" title={tip}>
            <span className={`item-field-label${rich != null ? ' has-help' : ''}`} title={tip ? undefined : label}>
              {rich != null ? <span className="field-label-text">{label}</span> : label}
              {rich != null && (
                <HelpToggle open={helpOpen} onToggle={() => setOpenHelp(helpOpen ? null : key)} />
              )}
            </span>
            <ToggleTag className="sprite-toggle">
              <input
                type="checkbox"
                checked={Boolean(values[key])}
                onChange={(e) => onChange(key, e.target.checked)}
              />
              <span className="sprite-toggle-track" />
            </ToggleTag>
            {helpOpen && rich != null && <div className="field-help-text">{rich}</div>}
          </Wrapper>
        )
      })}
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
  // Free text while focused: a controlled input that re-renders the parsed
  // list on every keystroke eats the comma you just typed ("3," parses to
  // [3] and renders back as "3"), which makes typing a second value
  // impossible. The parsed list still commits per keystroke; blur snaps the
  // text back to the canonical comma-joined form.
  const [text, setText] = useState<string | null>(null)
  const canonical = (value ?? []).join(', ')
  return (
    <input
      className="def-int-list"
      type="text"
      placeholder={placeholder ?? '—'}
      value={text ?? canonical}
      onFocus={() => setText(canonical)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        const trimmed = raw.trim()
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
