import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnumData, EnumValue } from '../loaders/enums'
import { TYPE_LABELS } from './typeChars'
import './EnumViewer.css'

type Props = {
  data: EnumData
  onSave: (data: EnumData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

type Row = { key: string; value: string }

const CUSTOM_TYPES_KEY = 'cache-editor:enum-custom-types'

function loadCustomTypes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_TYPES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveCustomTypes(types: Record<string, string>) {
  localStorage.setItem(CUSTOM_TYPES_KEY, JSON.stringify(types))
}

function toRows(values: Record<string, EnumValue>): Row[] {
  return Object.entries(values).map(([key, value]) => ({ key, value: String(value) }))
}

type TypeOption = { char: string; label: string }

type TypeCharDropdownProps = {
  value: string
  options: TypeOption[]
  onChange: (char: string) => void
  onAddCustom: (char: string, label: string) => void
}

function TypeCharDropdown({ value, options, onChange, onAddCustom }: TypeCharDropdownProps) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newChar, setNewChar] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setAdding(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = options.find((o) => o.char === value)

  function submitCustom() {
    const char = newChar.slice(0, 1)
    if (!char) return
    onAddCustom(char, newLabel.trim() || 'custom')
    onChange(char)
    setNewChar('')
    setNewLabel('')
    setAdding(false)
    setOpen(false)
  }

  return (
    <div ref={ref} className="type-dropdown-wrap">
      <button type="button" className="type-dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="type-dropdown-char">{value || '?'}</span>
        <span className="type-dropdown-label">{current?.label ?? 'unknown'}</span>
        <span className="badge-dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="type-dropdown-menu">
          {options.map((opt) => (
            <button
              key={opt.char}
              type="button"
              className={`type-dropdown-item${opt.char === value ? ' active' : ''}`}
              onClick={() => { onChange(opt.char); setOpen(false) }}
            >
              <span className="type-dropdown-char">{opt.char}</span>
              <span>{opt.label}</span>
            </button>
          ))}
          {!adding ? (
            <button type="button" className="type-dropdown-item type-dropdown-add" onClick={() => setAdding(true)}>
              + Add custom type…
            </button>
          ) : (
            <div className="type-dropdown-custom-form">
              <input
                className="type-dropdown-custom-char"
                maxLength={1}
                placeholder="char"
                value={newChar}
                onChange={(e) => setNewChar(e.target.value)}
                autoFocus
              />
              <input
                className="type-dropdown-custom-label"
                placeholder="label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
              />
              <button type="button" className="type-dropdown-custom-save" onClick={submitCustom}>Add</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function EnumViewer({ data, onSave, onDirtyChange }: Props) {
  const [keyTypeChar, setKeyTypeChar] = useState(data.keyTypeChar)
  const [valueTypeChar, setValueTypeChar] = useState(data.valueTypeChar)
  const [defaultStringValue, setDefaultStringValue] = useState(data.defaultStringValue)
  const [defaultIntValue, setDefaultIntValue] = useState(data.defaultIntValue)
  const [rows, setRows] = useState<Row[]>(() => toRows(data.values))
  const [filter, setFilter] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [customTypes, setCustomTypes] = useState<Record<string, string>>(() => loadCustomTypes())

  const typeOptions = useMemo(() => {
    const merged = { ...TYPE_LABELS, ...customTypes }
    return Object.entries(merged)
      .map(([char, label]) => ({ char, label }))
      .sort((a, b) => a.char.localeCompare(b.char))
  }, [customTypes])

  function addCustomType(char: string, label: string) {
    setCustomTypes((prev) => {
      const next = { ...prev, [char]: label }
      saveCustomTypes(next)
      return next
    })
  }

  useEffect(() => {
    setKeyTypeChar(data.keyTypeChar)
    setValueTypeChar(data.valueTypeChar)
    setDefaultStringValue(data.defaultStringValue)
    setDefaultIntValue(data.defaultIntValue)
    setRows(toRows(data.values))
    setFilter('')
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const valueIsNumeric = valueTypeChar !== 's'

  function markDirty() {
    setIsDirty(true)
  }

  function setRowKey(index: number, key: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, key } : r)))
    markDirty()
  }

  function setRowValue(index: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, value } : r)))
    markDirty()
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index))
    markDirty()
  }

  function addRow() {
    setRows((prev) => [...prev, { key: '', value: '' }])
    markDirty()
  }

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !q || row.key.toLowerCase().includes(q) || row.value.toLowerCase().includes(q))
  }, [rows, filter])

  async function handleSave() {
    setIsSaving(true)
    const values: Record<string, EnumValue> = {}
    for (const row of rows) {
      if (row.key === '') continue
      const value: EnumValue = valueIsNumeric
        ? (Number(row.value) || 0)
        : row.value
      values[row.key] = value
    }
    await onSave({
      id: data.id,
      keyTypeChar,
      valueTypeChar,
      defaultStringValue,
      defaultIntValue,
      values,
    })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setKeyTypeChar(data.keyTypeChar)
    setValueTypeChar(data.valueTypeChar)
    setDefaultStringValue(data.defaultStringValue)
    setDefaultIntValue(data.defaultIntValue)
    setRows(toRows(data.values))
    setIsDirty(false)
  }

  return (
    <div className="enum-viewer">
      <div className="enum-header">
        <span className="enum-title">Enum {data.id}</span>
        <span className="enum-count">{rows.length.toLocaleString()} entries</span>
      </div>

      <div className="enum-stats">
        <div className="stat-card">
          <span className="stat-label">Key type</span>
          <TypeCharDropdown
            value={keyTypeChar}
            options={typeOptions}
            onChange={(c) => { setKeyTypeChar(c); markDirty() }}
            onAddCustom={addCustomType}
          />
        </div>
        <div className="stat-card">
          <span className="stat-label">Value type</span>
          <TypeCharDropdown
            value={valueTypeChar}
            options={typeOptions}
            onChange={(c) => { setValueTypeChar(c); markDirty() }}
            onAddCustom={addCustomType}
          />
        </div>
        <div className="stat-card">
          <span className="stat-label">Default int value</span>
          <input
            className="stat-input"
            type="number"
            value={defaultIntValue}
            onChange={(e) => { setDefaultIntValue(parseInt(e.target.value, 10) || 0); markDirty() }}
          />
        </div>
        <div className="stat-card">
          <span className="stat-label">Default string value</span>
          <input
            className="stat-input"
            value={defaultStringValue}
            onChange={(e) => { setDefaultStringValue(e.target.value); markDirty() }}
          />
        </div>
      </div>

      <div className="enum-toolbar">
        <input
          className="item-filter enum-filter"
          type="text"
          placeholder="Search key or value…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="add-row-btn" onClick={addRow}>+ Add entry</button>
      </div>

      <div className="quest-table-wrap enum-table-wrap">
        <table className="quest-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Remove</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(({ row, index }) => (
              <tr key={index}>
                <td style={{ width: 140 }}>
                  <input
                    className="cell-input"
                    type="number"
                    value={row.key}
                    onChange={(e) => setRowKey(index, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="cell-input"
                    type={valueIsNumeric ? 'number' : 'text'}
                    value={row.value}
                    onChange={(e) => setRowValue(index, e.target.value)}
                  />
                </td>
                <td><button type="button" className="row-remove-btn" onClick={() => removeRow(index)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
