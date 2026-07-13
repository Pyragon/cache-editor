// Shared building blocks for definition editors (items, objects, ...).
// Styling comes from ItemViewer.css / QuestViewer.css / SpriteViewer.css —
// component CSS is global in this app by convention.
import type { ParamRow } from './defParams'

export type NumFieldDef = [key: string, label: string]

export function NumGrid({ fields, values, onChange }: {
  fields: NumFieldDef[]
  values: Record<string, unknown>
  onChange: (key: string, value: number) => void
}) {
  return (
    <div className="item-grid">
      {fields.map(([key, label]) => (
        <label key={key} className="item-field">
          <span className="item-field-label" title={label}>{label}</span>
          <input
            className="item-field-input"
            type="number"
            value={Number(values[key] ?? 0)}
            onChange={(e) => onChange(key, parseInt(e.target.value, 10) || 0)}
          />
        </label>
      ))}
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

export function PairTable({ title, srcLabel, dstLabel, src, dst, onSet, onAdd, onRemove }: {
  title: string
  srcLabel: string
  dstLabel: string
  src: number[]
  dst: number[]
  onSet: (index: number, which: 0 | 1, value: number) => void
  onAdd: () => void
  onRemove: (index: number) => void
}) {
  return (
    <section className="item-section">
      <h3>{title}</h3>
      {src.length > 0 && (
        <div className="quest-table-wrap item-pair-wrap">
          <table className="quest-table">
            <thead><tr><th>{srcLabel}</th><th>{dstLabel}</th><th>Remove</th></tr></thead>
            <tbody>
              {src.map((s, i) => (
                <tr key={i}>
                  <td><input className="cell-input" type="number" value={s}
                    onChange={(e) => onSet(i, 0, parseInt(e.target.value, 10) || 0)} /></td>
                  <td><input className="cell-input" type="number" value={dst[i] ?? 0}
                    onChange={(e) => onSet(i, 1, parseInt(e.target.value, 10) || 0)} /></td>
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

export function ParamsTable({ rows, onSet, onAdd, onRemove }: {
  rows: ParamRow[]
  onSet: (index: number, patch: Partial<ParamRow>) => void
  onAdd: () => void
  onRemove: (index: number) => void
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
                    <input className="cell-input" type={row.isString ? 'text' : 'number'} value={row.value}
                      onChange={(e) => onSet(i, { value: e.target.value })} />
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
