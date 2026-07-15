import { useEffect, useMemo, useState } from 'react'
import type { MaterialDefinition, TextureOperation } from '../loaders/textures'
import { OP_TYPES, SHAPE_TYPES, newOperation, opName } from '../loaders/textureOps'
import type { OpField } from '../loaders/textureOps'
import { NumberInput } from './defFields'
import { useConfirm } from './useConfirm'
import './TextureOpsEditor.css'

type Props = {
  material: MaterialDefinition
  onChange: (material: MaterialDefinition) => void
}

type Shape = { shapeType: number; fillColor: number; strokeColor: number; strokeWidth: number; [k: string]: number }

// The three graph roots. Every node is reachable from one of them; anything that
// isn't is dead weight the client never evaluates.
const ROOTS: [keyof MaterialDefinition, string, string][] = [
  ['opaqueOperationIndex', 'Colour', 'The RGB channels of the texture'],
  ['opacityOperationIndex', 'Opacity', 'The alpha channel'],
  ['hdrOperationIndex', 'HDR', 'The HDR/glow channel'],
]

function toHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

// A swatch that doubles as the colour picker: the native <input type="color"> is
// laid transparently over it, so clicking the colour opens the picker.
// -1 renders hatched — the rasterizer uses it for "no fill" / "no stroke".
function ColorSwatch({ value, onChange, title }: { value: number; onChange?: (rgb: number) => void; title?: string }) {
  const none = value < 0
  const hex = none ? '#000000' : toHex(value)

  const swatch = (
    <span
      className={`tex-op-swatch${none ? ' tex-op-swatch-none' : ''}`}
      style={none ? undefined : { background: hex }}
      title={title ?? (none ? 'none' : hex)}
    />
  )

  if (!onChange) return swatch

  return (
    <label className="tex-op-swatch-picker">
      {swatch}
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
      />
    </label>
  )
}

function ShapeEditor({ shapes, onChange }: { shapes: Shape[]; onChange: (next: Shape[]) => void }) {
  const set = (i: number, key: string, value: number) => {
    const next = shapes.slice()
    next[i] = { ...next[i], [key]: value }
    onChange(next)
  }

  return (
    <div className="tex-op-shapes">
      {shapes.map((shape, i) => {
        const spec = SHAPE_TYPES[shape.shapeType]
        return (
          <div key={i} className="tex-op-shape">
            <div className="tex-op-shape-head">
              <span className="tex-op-shape-name">{spec?.name ?? `Shape ${shape.shapeType}`}</span>
              <span className="tex-op-shape-colors">
                <ColorSwatch
                  value={shape.fillColor}
                  title={shape.fillColor < 0 ? 'No fill' : `Fill ${toHex(shape.fillColor)}`}
                  onChange={(rgb) => set(i, 'fillColor', rgb)}
                />
                <ColorSwatch
                  value={shape.strokeColor}
                  title={shape.strokeColor < 0 ? 'No stroke' : `Stroke ${toHex(shape.strokeColor)}`}
                  onChange={(rgb) => set(i, 'strokeColor', rgb)}
                />
                <span className="tex-op-hint">stroke {shape.strokeWidth}</span>
              </span>
            </div>
            <div className="tex-op-grid">
              {(spec?.fields ?? []).map(([key, label]) => (
                <label key={key} className="tex-op-field">
                  <span className="tex-op-label">{label}</span>
                  <NumberInput className="item-field-input" value={Number(shape[key] ?? 0)} onChange={(v) => set(i, key, v)} />
                </label>
              ))}
              <label className="tex-op-field">
                <span className="tex-op-label">Fill Colour</span>
                <NumberInput className="item-field-input" value={shape.fillColor} onChange={(v) => set(i, 'fillColor', v)} />
              </label>
              <label className="tex-op-field">
                <span className="tex-op-label">Stroke Colour</span>
                <NumberInput className="item-field-input" value={shape.strokeColor} onChange={(v) => set(i, 'strokeColor', v)} />
              </label>
              <label className="tex-op-field">
                <span className="tex-op-label">Stroke Width</span>
                <NumberInput className="item-field-input" value={shape.strokeWidth} onChange={(v) => set(i, 'strokeWidth', v)} />
              </label>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Curve control points and gradient colour stops are both small tables of ints;
// `columns` names them and `stops` adds a swatch built from the RGB triple.
function PointTable({
  rows,
  columns,
  swatch,
  onChange,
}: {
  rows: number[][]
  columns: string[]
  swatch?: boolean
  onChange: (next: number[][]) => void
}) {
  const set = (r: number, c: number, value: number) => {
    const next = rows.map((row) => row.slice())
    next[r][c] = value
    onChange(next)
  }

  // Stop channels are 12-bit fixed point, stored as the byte from the cache << 4.
  // Keeping the picker's 0-255 in that form (max 4080) is also what stops a value
  // of 4096 sneaking in, which overflows the byte the encoder writes.
  const setRgb = (r: number, rgb: number) => {
    const next = rows.map((row) => row.slice())
    next[r][1] = ((rgb >> 16) & 0xff) << 4
    next[r][2] = ((rgb >> 8) & 0xff) << 4
    next[r][3] = (rgb & 0xff) << 4
    onChange(next)
  }

  const removeRow = (r: number) => onChange(rows.filter((_, i) => i !== r))
  const addRow = () => onChange([...rows, new Array(columns.length).fill(0)])

  return (
    <div className="tex-op-table-wrap">
      <table className="quest-table tex-op-table">
        <thead>
          <tr>
            {swatch && <th className="tex-op-th-swatch" />}
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
            <th className="tex-op-th-remove" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {swatch && (
                <td className="tex-op-td-swatch">
                  {/* stops are [position, r, g, b]; click the swatch to pick all three */}
                  <ColorSwatch
                    value={(((row[1] ?? 0) >> 4) << 16) | (((row[2] ?? 0) >> 4) << 8) | ((row[3] ?? 0) >> 4)}
                    onChange={(rgb) => setRgb(r, rgb)}
                  />
                </td>
              )}
              {columns.map((c, i) => (
                <td key={c}>
                  <NumberInput className="cell-input" value={Number(row[i] ?? 0)} onChange={(v) => set(r, i, v)} />
                </td>
              ))}
              <td>
                <button type="button" className="row-remove-btn" onClick={() => removeRow(r)} title="Remove">
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="add-row-btn" onClick={addRow}>
        + Add row
      </button>
    </div>
  )
}

export default function TextureOpsEditor({ material, onChange }: Props) {
  const ops = material.textureOperations ?? []
  const edges = useMemo(() => material.operationIndices ?? [], [material])

  // Graphs run to a dozen-plus nodes, so start with every card shut and let them
  // be scanned by their headers. Re-collapses when you switch to another texture.
  const collapseAll = () => new Set(ops.map((_, i) => i))
  const [collapsed, setCollapsed] = useState<Set<number>>(collapseAll)
  const [addType, setAddType] = useState(0)
  const { confirm, dialog } = useConfirm()

  useEffect(() => {
    setCollapsed(collapseAll())
    // Only on a different texture — editing a node changes `material` by identity
    // but must not slam every card shut mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material.id])

  // Which nodes the client can actually reach from the three roots — everything
  // else is dead and never evaluated, worth flagging rather than hiding.
  const reachable = useMemo(() => {
    const seen = new Set<number>()
    const stack = ROOTS.map(([key]) => material[key] as number).filter((i) => i >= 0 && i < ops.length)
    while (stack.length) {
      const i = stack.pop()!
      if (seen.has(i)) continue
      seen.add(i)
      for (const child of edges[i] ?? []) if (child >= 0 && child < ops.length) stack.push(child)
    }
    return seen
  }, [material, ops.length, edges])

  const rootOf = (index: number) =>
    ROOTS.filter(([key]) => (material[key] as number) === index).map(([, label]) => label)

  function setOp(index: number, key: string, value: unknown) {
    const next = ops.slice()
    next[index] = { ...next[index], [key]: value } as TextureOperation
    onChange({ ...material, textureOperations: next })
  }

  function setEdge(opIndex: number, slot: number, target: number) {
    const next = edges.map((row) => row.slice())
    next[opIndex][slot] = target
    onChange({ ...material, operationIndices: next })
  }

  function setRoot(key: keyof MaterialDefinition, value: number) {
    onChange({ ...material, [key]: value })
  }

  // The node list and the edge list are parallel arrays — a node added to one
  // without a matching row in the other desyncs the whole graph, so they always
  // grow together. New inputs point at node 0 until they're rewired.
  function addNode() {
    const op = newOperation(addType) as unknown as TextureOperation
    const inputCount = OP_TYPES[addType]?.inputs.length ?? 0

    onChange({
      ...material,
      textureOperations: [...ops, op],
      operationIndices: [...edges, new Array(inputCount).fill(0)],
    })

    // Open the node that was just added; it's the one thing you want to look at.
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(ops.length)
      return next
    })
  }

  // Who still points at this node — other nodes' inputs, and the graph roots.
  // A node can only be removed once nothing refers to it, otherwise the deletion
  // would leave dangling edges. Records the exact input slot so the error can say
  // *which* input of the other node is wired here.
  function referencesTo(index: number) {
    const nodes: { node: number; slot: string }[] = []
    edges.forEach((row, i) => {
      if (i === index) return
      ;(row ?? []).forEach((target, slot) => {
        if (target !== index) return
        nodes.push({ node: i, slot: OP_TYPES[ops[i].type]?.inputs[slot] ?? `Input ${slot}` })
      })
    })
    const roots = ROOTS.filter(([key]) => (material[key] as number) === index).map(([, label]) => label)
    return { nodes, roots }
  }

  async function handleRemove(index: number) {
    if (ops.length === 1) {
      await confirm('A material needs at least one node, so the last one can’t be removed.', {
        title: 'Can’t remove the only node',
        acknowledge: true,
        confirmLabel: 'Close',
      })
      return
    }

    const { nodes, roots } = referencesTo(index)
    if (nodes.length || roots.length) {
      await confirm(
        <>
          <p className="tex-op-modal-lead">
            <strong>#{index} {opName(ops[index].type)}</strong> is still wired into the graph. Repoint
            the references below, then remove it.
          </p>
          <ul className="tex-op-refs">
            {nodes.map(({ node, slot }) => (
              <li key={`${node}-${slot}`}>
                <span className="tex-op-ref-node">#{node} {opName(ops[node].type)}</span>
                <span className="tex-op-ref-slot">{slot} input</span>
              </li>
            ))}
            {roots.map((root) => (
              <li key={root}>
                <span className="tex-op-ref-node">{root} output</span>
                <span className="tex-op-ref-slot">graph root</span>
              </li>
            ))}
          </ul>
        </>,
        { title: `Can’t remove node #${index}`, acknowledge: true, confirmLabel: 'Close' },
      )
      return
    }

    removeNode(index)
  }

  // Removing node i renumbers everything above it, so every edge and every root
  // index has to shift down with it.
  function removeNode(index: number) {
    const shift = (i: number) => (i > index ? i - 1 : i)

    const next: MaterialDefinition = {
      ...material,
      textureOperations: ops.filter((_, i) => i !== index),
      operationIndices: edges.filter((_, i) => i !== index).map((row) => (row ?? []).map(shift)),
      opaqueOperationIndex: shift(material.opaqueOperationIndex),
      opacityOperationIndex: shift(material.opacityOperationIndex),
      hdrOperationIndex: shift(material.hdrOperationIndex),
    }

    onChange(next)

    // Collapsed state is keyed by index, so it has to shift too.
    setCollapsed((prev) => {
      const out = new Set<number>()
      for (const i of prev) {
        if (i === index) continue
        out.add(shift(i))
      }
      return out
    })
  }

  function toggle(index: number) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function renderField(op: TextureOperation, index: number, field: OpField) {
    const value = op[field.key]

    switch (field.kind) {
      case 'bool':
        return (
          <label key={field.key} className="tex-op-field tex-op-field-bool">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => setOp(index, field.key, e.target.checked)} />
            <span className="tex-op-label">{field.label}</span>
          </label>
        )

      case 'select':
        return (
          <label key={field.key} className="tex-op-field">
            <span className="tex-op-label">{field.label}</span>
            <select
              className="item-stackable-select"
              value={Number(value ?? 0)}
              onChange={(e) => setOp(index, field.key, parseInt(e.target.value, 10))}
            >
              {Object.entries(field.options ?? {}).map(([v, label]) => (
                <option key={v} value={v}>
                  {v} — {label}
                </option>
              ))}
              {/* the cache can hold a value we have no label for; keep it selectable */}
              {!(String(value) in (field.options ?? {})) && <option value={Number(value ?? 0)}>{String(value)}</option>}
            </select>
          </label>
        )

      case 'color': {
        const packed = Number(value ?? 0) & 0xffffff
        const hex = `#${packed.toString(16).padStart(6, '0')}`
        return (
          <label key={field.key} className="tex-op-field">
            <span className="tex-op-label">
              {field.label} <span className="tex-op-hint">(packed RGB)</span>
            </span>
            <div className="tex-op-color-row">
              <input
                type="color"
                className="tex-op-color-input"
                value={hex}
                onChange={(e) => setOp(index, field.key, parseInt(e.target.value.slice(1), 16))}
              />
              <NumberInput className="item-field-input" value={packed} onChange={(v) => setOp(index, field.key, v)} />
            </div>
          </label>
        )
      }

      case 'sprite':
      case 'material':
        return (
          <label key={field.key} className="tex-op-field">
            <span className="tex-op-label">
              {field.label} <span className="tex-op-hint">({field.kind === 'sprite' ? 'sprites' : 'textures'} id)</span>
            </span>
            <NumberInput className="item-field-input" value={Number(value ?? -1)} onChange={(v) => setOp(index, field.key, v)} />
          </label>
        )

      case 'points':
        return (
          <div key={field.key} className="tex-op-wide">
            <span className="tex-op-label">
              {field.label}
              {field.hint && <span className="tex-op-hint"> — {field.hint}</span>}
            </span>
            <PointTable
              rows={(value as number[][]) ?? []}
              columns={['Input', 'Output']}
              onChange={(next) => setOp(index, field.key, next)}
            />
          </div>
        )

      case 'stops':
        return (
          <div key={field.key} className="tex-op-wide">
            <span className="tex-op-label">{field.label}</span>
            <PointTable
              rows={(value as number[][]) ?? []}
              columns={['Position', 'Red', 'Green', 'Blue']}
              swatch
              onChange={(next) => setOp(index, field.key, next)}
            />
          </div>
        )

      case 'shorts': {
        const list = (value as number[]) ?? []
        if (!list.length) return null
        return (
          <div key={field.key} className="tex-op-wide">
            <span className="tex-op-label">{field.label}</span>
            <div className="tex-op-shorts">
              {list.map((n, i) => (
                <NumberInput
                  key={i}
                  className="cell-input"
                  value={n}
                  onChange={(v) => {
                    const next = list.slice()
                    next[i] = v
                    setOp(index, field.key, next)
                  }}
                />
              ))}
            </div>
          </div>
        )
      }

      case 'shapes':
        return (
          <div key={field.key} className="tex-op-wide">
            <span className="tex-op-label">
              {field.label} <span className="tex-op-hint">({((value as Shape[]) ?? []).length})</span>
            </span>
            <ShapeEditor shapes={(value as Shape[]) ?? []} onChange={(next) => setOp(index, field.key, next)} />
          </div>
        )

      default:
        return (
          <label key={field.key} className="tex-op-field">
            <span className="tex-op-label">
              {field.label}
              {field.hint && <span className="tex-op-hint"> ({field.hint})</span>}
            </span>
            <NumberInput className="item-field-input" value={Number(value ?? 0)} onChange={(v) => setOp(index, field.key, v)} />
          </label>
        )
    }
  }

  if (!ops.length) {
    return <p className="map-sprite-none">This material has no operations.</p>
  }

  return (
    <div className="tex-ops">
      <div className="tex-op-roots">
        {ROOTS.map(([key, label, hint]) => (
          <label key={key} className="tex-op-field" title={hint}>
            <span className="tex-op-label">{label} Output</span>
            <select
              className="item-stackable-select"
              value={material[key] as number}
              onChange={(e) => setRoot(key, parseInt(e.target.value, 10))}
            >
              {ops.map((op, i) => (
                <option key={i} value={i}>
                  #{i} {opName(op.type)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="tex-op-list">
        {ops.map((op, index) => {
          const spec = OP_TYPES[op.type]
          const roots = rootOf(index)
          const isOpen = !collapsed.has(index)
          const dead = !reachable.has(index)

          return (
            <div key={index} className="tex-op-row">
            <section className={`tex-op${dead ? ' tex-op-dead' : ''}`}>
              <header className="tex-op-head" onClick={() => toggle(index)}>
                <span className="tex-op-index">#{index}</span>
                <span className="tex-op-name">{opName(op.type)}</span>
                <span className="tex-op-type">type {op.type}</span>
                {roots.map((r) => (
                  <span key={r} className="tex-op-badge tex-op-badge-root">
                    {r}
                  </span>
                ))}
                {dead && (
                  <span className="tex-op-badge tex-op-badge-dead" title="Not reachable from any output — the client never evaluates it">
                    unused
                  </span>
                )}
                <span className="tex-op-chevron">{isOpen ? '−' : '+'}</span>
              </header>

              {isOpen && (
                <div className="tex-op-body">
                  {spec?.hint && <p className="tex-op-note">{spec.hint}</p>}

                  {(spec?.inputs.length ?? 0) > 0 && (
                    <div className="tex-op-grid">
                      {spec!.inputs.map((inputLabel, slot) => (
                        <label key={slot} className="tex-op-field">
                          <span className="tex-op-label">Input: {inputLabel}</span>
                          <select
                            className="item-stackable-select"
                            value={edges[index]?.[slot] ?? 0}
                            onChange={(e) => setEdge(index, slot, parseInt(e.target.value, 10))}
                          >
                            {ops.map((other, i) => (
                              <option key={i} value={i} disabled={i === index}>
                                #{i} {opName(other.type)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  )}

                  <div className="tex-op-grid">
                    {(spec?.fields ?? []).filter((f) => f.kind !== 'points' && f.kind !== 'stops' && f.kind !== 'shapes' && f.kind !== 'shorts').map((f) => renderField(op, index, f))}
                    <label className="tex-op-field">
                      <span className="tex-op-label">
                        Cache Rows <span className="tex-op-hint">(255 = full height)</span>
                      </span>
                      <NumberInput
                        className="item-field-input"
                        value={op.imageCacheCapacity}
                        onChange={(v) => setOp(index, 'imageCacheCapacity', v)}
                      />
                    </label>
                  </div>

                  {(spec?.fields ?? [])
                    .filter((f) => f.kind === 'points' || f.kind === 'stops' || f.kind === 'shapes' || f.kind === 'shorts')
                    .map((f) => renderField(op, index, f))}
                </div>
              )}
            </section>

            <button
              type="button"
              className="row-remove-btn tex-op-remove"
              title={`Remove node #${index}`}
              onClick={() => handleRemove(index)}
            >
              ×
            </button>
            </div>
          )
        })}
      </div>

      <div className="tex-op-add">
        <select
          className="item-stackable-select"
          value={addType}
          onChange={(e) => setAddType(parseInt(e.target.value, 10))}
        >
          {Object.entries(OP_TYPES)
            .sort(([, a], [, b]) => a.name.localeCompare(b.name))
            .map(([type, spec]) => (
              <option key={type} value={type}>
                {spec.name}
                {spec.inputs.length > 0 && ` (${spec.inputs.length} input${spec.inputs.length > 1 ? 's' : ''})`}
              </option>
            ))}
        </select>
        <button type="button" className="add-row-btn" onClick={addNode}>
          + Add node
        </button>
      </div>

      {dialog}
    </div>
  )
}
