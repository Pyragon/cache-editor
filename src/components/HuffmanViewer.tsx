import { useState } from 'react'
import './HuffmanViewer.css'

export type HuffmanData = {
  codes: number[]
  originalByteData: number[]
  table: number[]
}

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

export default function HuffmanViewer({ data }: { data: HuffmanData }) {
  const [showUnused, setShowUnused] = useState(false)

  const entries = data.codes.map((code, i) => ({
    byte: i,
    char: charLabel(i),
    length: data.originalByteData[i],
    code: extractCode(code, data.originalByteData[i]),
  }))

  const active = entries
    .filter((e) => e.length < 22)
    .sort((a, b) => a.length - b.length || a.byte - b.byte)

  const unused = entries.filter((e) => e.length === 22)
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
        <button
          type="button"
          className="huffman-toggle"
          onClick={() => setShowUnused((v) => !v)}
        >
          {showUnused ? 'Hide unused' : 'Show unused'}
        </button>
      </div>

      <div className="huffman-table-scroll">
      <table className="huffman-table">
        <thead>
          <tr>
            <th>Byte</th>
            <th>Char</th>
            <th>Bits</th>
            <th>Code</th>
          </tr>
        </thead>
        <tbody>
          {displayed.map((entry) => (
            <tr key={entry.byte} className={entry.length === 22 ? 'unused' : ''}>
              <td className="cell-byte">{entry.byte}</td>
              <td className="cell-char">{entry.char}</td>
              <td className="cell-bits">{entry.length}</td>
              <td className="cell-code">{entry.code || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
