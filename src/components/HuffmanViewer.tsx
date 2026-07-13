import { useMemo, useState } from 'react'
import './HuffmanViewer.css'

export type HuffmanData = {
  codes: number[]
  originalByteData: number[]
  table: number[]
}

const UNUSED_LENGTH = 22

function charLabel(byte: number): string {
  if (byte === 9)  return '\\t'
  if (byte === 10) return '\\n'
  if (byte === 13) return '\\r'
  if (byte === 32) return 'SP'
  if (byte >= 33 && byte <= 126) return String.fromCharCode(byte)
  return `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`
}

function extractCode(code: number, length: number): string {
  if (length === 0) return ''
  return (code >>> (32 - length)).toString(2).padStart(length, '0')
}

type Entry = { byte: number; char: string; length: number; code: string }

export default function HuffmanViewer({ data }: { data: HuffmanData }) {
  const [showUnused, setShowUnused] = useState(false)
  const [view, setView] = useState<'table' | 'visual'>('table')

  const entries: Entry[] = useMemo(() => data.codes.map((code, i) => ({
    byte: i,
    char: charLabel(i),
    length: data.originalByteData[i],
    code: extractCode(code, data.originalByteData[i]),
  })), [data])

  const active = useMemo(
    () => entries.filter((e) => e.length < UNUSED_LENGTH).sort((a, b) => a.length - b.length || a.byte - b.byte),
    [entries],
  )
  const unused = useMemo(() => entries.filter((e) => e.length === UNUSED_LENGTH), [entries])
  const displayed = showUnused ? [...active, ...unused] : active

  return (
    <div className="huffman-viewer">
      <div className="huffman-header">
        <div className="huffman-stats">
          <span className="stat"><strong>{active.length}</strong> active</span>
          <span className="stat-sep">/</span>
          <span className="stat"><strong>{unused.length}</strong> unused</span>
          <span className="stat"><strong>{data.table.length}</strong> tree nodes</span>
        </div>
        <div className="huffman-controls">
          <div className="huffman-viewtoggle">
            <button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>Table</button>
            <button type="button" className={view === 'visual' ? 'active' : ''} onClick={() => setView('visual')}>Visual</button>
          </div>
          {view === 'table' && (
            <button type="button" className="huffman-toggle" onClick={() => setShowUnused((v) => !v)}>
              {showUnused ? 'Hide unused' : 'Show unused'}
            </button>
          )}
        </div>
      </div>

      {view === 'table' ? (
        <div className="huffman-table-scroll">
          <table className="huffman-table">
            <thead>
              <tr><th>Byte</th><th>Char</th><th>Bits</th><th>Code</th></tr>
            </thead>
            <tbody>
              {displayed.map((entry) => (
                <tr key={entry.byte} className={entry.length === UNUSED_LENGTH ? 'unused' : ''}>
                  <td className="cell-byte">{entry.byte}</td>
                  <td className="cell-char">{entry.char}</td>
                  <td className="cell-bits">{entry.length}</td>
                  <td className="cell-code">{entry.code || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <VisualView active={active} />
      )}
    </div>
  )
}

// The code length maps to a hue: short (frequent) = warm/green, long = cool.
function lengthColor(length: number, min: number, max: number): string {
  const t = max === min ? 0 : (length - min) / (max - min)
  const hue = 140 - t * 140 // 140 (green) → 0 (red)
  return `hsl(${hue}, 65%, 55%)`
}

function VisualView({ active }: { active: Entry[] }) {
  const lengths = active.map((e) => e.length)
  const min = Math.min(...lengths)
  const max = Math.max(...lengths)

  // Histogram: count of symbols per code length across the full range.
  const histogram = useMemo(() => {
    const counts = new Map<number, number>()
    for (const e of active) counts.set(e.length, (counts.get(e.length) ?? 0) + 1)
    const rows: { length: number; count: number }[] = []
    for (let l = min; l <= max; l++) rows.push({ length: l, count: counts.get(l) ?? 0 })
    return rows
  }, [active, min, max])
  const peak = Math.max(...histogram.map((h) => h.count), 1)

  return (
    <div className="huffman-visual-scroll">
      <section className="huffman-visual-section">
        <h3>Code-length distribution</h3>
        <p className="huffman-visual-hint">Shorter codes are more frequent characters. Bars coloured by length.</p>
        <div className="huffman-histogram">
          {histogram.map((h) => (
            <div key={h.length} className="huffman-histo-col">
              <span className="huffman-histo-count">{h.count || ''}</span>
              <div
                className="huffman-histo-bar"
                style={{ height: `${(h.count / peak) * 120 + 2}px`, background: lengthColor(h.length, min, max) }}
              />
              <span className="huffman-histo-label">{h.length}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="huffman-visual-section">
        <h3>Codes</h3>
        <p className="huffman-visual-hint">Each code as a row of bit cells (0 = left, 1 = right in the tree), shortest first.</p>
        <div className="huffman-codes">
          {active.map((e) => (
            <div key={e.byte} className="huffman-code-row">
              <span className="huffman-code-char" style={{ color: lengthColor(e.length, min, max) }}>{e.char}</span>
              <span className="huffman-code-bits">{e.length}b</span>
              <div className="huffman-code-cells">
                {e.code.split('').map((bit, i) => (
                  <span key={i} className={`huffman-bit huffman-bit-${bit}`}>{bit}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
