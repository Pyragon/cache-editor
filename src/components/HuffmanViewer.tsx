import { useEffect, useMemo, useRef, useState } from 'react'
import { buildLengthLimitedLengths, deriveCodesAndTable, kraftSum, roundTripTest } from '../loaders/huffmanCodes'
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

type RegenResult = {
  lengths: number[]
  codes: number[]
  table: number[]
  testPassed: boolean
  stats: { messages: number; counted: number; skipped: number; oldAvg: number; newAvg: number }
}

export default function HuffmanViewer({ data, onSave }: { data: HuffmanData; onSave?: (data: HuffmanData) => Promise<void> }) {
  const [showUnused, setShowUnused] = useState(false)
  const [view, setView] = useState<'table' | 'visual'>('table')
  const [regen, setRegen] = useState<RegenResult | null>(null)
  const [regenError, setRegenError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const corpusInputRef = useRef<HTMLInputElement>(null)

  // Status modal: analyzing (corpus processing), saving, saved (success
  // recap), verified (results of the Verify button's self-test).
  const [phase, setPhase] = useState<'idle' | 'analyzing' | 'saving' | 'saved' | 'verified'>('idle')
  const [savedStats, setSavedStats] = useState<RegenResult['stats'] | null>(null)
  const [verifyResults, setVerifyResults] = useState<{ checks: { name: string; ok: boolean }[]; sampleRaw: number; sampleEncoded: number } | null>(null)
  const statusModalRef = useRef<HTMLDialogElement>(null)

  // In-viewer equivalent of scripts/verify-huffman.mjs: proves the CURRENTLY
  // LOADED table is self-consistent by re-deriving from its length array and
  // round-tripping text through the stored codes and decode table.
  function runVerify() {
    const lengths = data.originalByteData
    const { codes, table } = deriveCodesAndTable(lengths)
    const checks: { name: string; ok: boolean }[] = []

    checks.push({
      name: 'Stored codes match re-derivation from the code lengths',
      ok: data.codes.length === codes.length && codes.every((c, i) => c === data.codes[i]),
    })
    checks.push({
      name: 'Stored decode table matches re-derivation',
      ok: data.table.every((t, i) => t === (table[i] ?? 0)) && table.every((t, i) => t === (data.table[i] ?? 0)),
    })
    checks.push({
      name: 'Kraft sum is exactly 1 (complete prefix code)',
      ok: Math.abs(kraftSum(lengths) - 1) < 1e-9,
    })

    const allBytes: number[] = []
    for (let b = 0; b < 256; b++) if (lengths[b] > 0) allBytes.push(b)
    checks.push({
      name: `Encode → decode round-trip: all ${allBytes.length} coded bytes`,
      ok: roundTripTest(lengths, data.codes, data.table, allBytes),
    })

    const message = 'Selling lobsters at the Grand Exchange! 99 str btw :)'
    const bytes = [...message].map((ch) => ch.charCodeAt(0)).filter((c) => c < 256 && lengths[c] > 0)
    checks.push({
      name: `Encode → decode round-trip: "${message}"`,
      ok: roundTripTest(lengths, data.codes, data.table, bytes),
    })

    setVerifyResults({
      checks,
      sampleRaw: bytes.length * 8,
      sampleEncoded: bytes.reduce((n, b) => n + lengths[b], 0),
    })
    setPhase('verified')
  }

  useEffect(() => {
    const modal = statusModalRef.current
    if (!modal) return
    if (phase !== 'idle') {
      if (!modal.open) modal.showModal()
    } else if (modal.open) {
      modal.close()
    }
  }, [phase])

  // SECURITY: the corpus is only ever read as plain text (file.text()) and
  // used for byte-frequency counting — never executed, evaluated, written to
  // disk, or retained. The input is cleared immediately so no reference to
  // the file survives past this handler.
  async function handleCorpusFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setRegen(null)
    setRegenError(null)

    if (file.size > 50 * 1024 * 1024) {
      setRegenError('File too large — max 50 MB of plain text.')
      return
    }
    if (file.type && !file.type.startsWith('text/')) {
      setRegenError(`Not a plain-text file (got "${file.type}"). Upload a .txt of chat lines.`)
      return
    }

    // Show the analyzing modal and yield a frame so it paints before the
    // synchronous frequency/package-merge work starts.
    setPhase('analyzing')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const text = await file.text()

    // Frequencies floored at 1 so all 256 bytes keep a code and any future
    // message can still encode. Newlines are message separators, not chat
    // content, so they don't contribute counts (beyond the floor).
    const freqs = new Array<number>(256).fill(1)
    let counted = 0
    let skipped = 0
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === 10 || c === 13) continue
      if (c < 256) {
        freqs[c]++
        counted++
      } else {
        skipped++
      }
    }
    if (counted < 1000) {
      setPhase('idle')
      setRegenError(`Only ${counted.toLocaleString()} characters of chat found — that's too little to build a meaningful table (aim for at least a few thousand messages).`)
      return
    }

    const messages = text.split('\n').filter((line) => line.trim() !== '').length
    const lengths = buildLengthLimitedLengths(freqs)
    const { codes, table } = deriveCodesAndTable(lengths)

    // Self-test before the table is ever allowed to save: Kraft equality plus
    // an encode→decode round trip over all 256 bytes and a corpus sample.
    const sample: number[] = []
    for (let b = 0; b < 256; b++) sample.push(b)
    for (let i = 0; i < Math.min(text.length, 2048); i++) {
      const c = text.charCodeAt(i)
      if (c < 256 && c !== 10 && c !== 13) sample.push(c)
    }
    const testPassed = Math.abs(kraftSum(lengths) - 1) < 1e-9 && roundTripTest(lengths, codes, table, sample)

    let oldBits = 0
    let newBits = 0
    let total = 0
    for (let b = 0; b < 256; b++) {
      const f = freqs[b] - 1
      if (f <= 0) continue
      total += f
      oldBits += f * (data.originalByteData[b] ?? UNUSED_LENGTH)
      newBits += f * lengths[b]
    }
    setRegen({
      lengths, codes, table, testPassed,
      stats: {
        messages, counted, skipped,
        oldAvg: total > 0 ? oldBits / total : 0,
        newAvg: total > 0 ? newBits / total : 0,
      },
    })
    setPhase('idle')
  }

  async function applyRegen() {
    if (!regen?.testPassed || !onSave) return
    setIsSaving(true)
    setPhase('saving')
    try {
      await onSave({ codes: regen.codes, originalByteData: regen.lengths, table: regen.table })
      setSavedStats(regen.stats)
      setRegen(null)
      setPhase('saved')
    } catch {
      setPhase('idle')
      setRegenError('Saving huffman.json failed — the table was NOT applied.')
    } finally {
      setIsSaving(false)
    }
  }

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
          <div className="mode-toggle">
            <button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>☰ Table</button>
            <button type="button" className={view === 'visual' ? 'active' : ''} onClick={() => setView('visual')}>▦ Visual</button>
          </div>
          {view === 'table' && (
            <button type="button" className="huffman-toggle" onClick={() => setShowUnused((v) => !v)}>
              {showUnused ? 'Hide unused' : 'Show unused'}
            </button>
          )}
          <button type="button" className="huffman-toggle" title="Re-derive the codes and decode table from the length array and round-trip text through them" onClick={runVerify}>
            ✓ Verify
          </button>
        </div>
      </div>

      {onSave && (
        <details className="huffman-regen">
          <summary>Regenerate table from a chat corpus…</summary>
          <div className="huffman-regen-body">
            <ul className="huffman-regen-disclaimers">
              <li><strong>Lines of chat text only, one message per line.</strong> Strip usernames, timestamps/dates, channel tags and any other metadata first — those characters (colons, digits, brackets) would skew the frequencies and mis-tune the compression.</li>
              <li>The file is read as plain text in your browser, used only to count character frequencies, never executed, and discarded immediately after processing — nothing is uploaded or written anywhere.</li>
              <li>A few thousand messages makes a solid table; ~1&nbsp;MB is comfortable. The result is only applied after an encode/decode self-test passes.</li>
            </ul>
            <input ref={corpusInputRef} type="file" accept=".txt,text/plain" style={{ display: 'none' }} onChange={handleCorpusFile} />
            <button type="button" className="huffman-regen-upload" onClick={() => corpusInputRef.current?.click()}>
              📄 Choose corpus file…
            </button>
            {regenError && <p className="huffman-regen-error">{regenError}</p>}
            {regen && (
              <div className="huffman-regen-result">
                <p>
                  <strong>{regen.stats.messages.toLocaleString()}</strong> messages · <strong>{regen.stats.counted.toLocaleString()}</strong> characters counted
                  {regen.stats.skipped > 0 && <> · {regen.stats.skipped.toLocaleString()} non-cp1252 characters ignored</>}
                </p>
                <p>
                  Average bits per character on this corpus: <strong>{regen.stats.oldAvg.toFixed(2)}</strong> (current table) → <strong>{regen.stats.newAvg.toFixed(2)}</strong> (new table)
                </p>
                <p className={regen.testPassed ? 'huffman-regen-pass' : 'huffman-regen-fail'}>
                  {regen.testPassed
                    ? '✓ Round-trip self-test passed (all 256 bytes + corpus sample encode and decode back exactly).'
                    : '✗ Self-test FAILED — this table will not be saved. Please report this corpus.'}
                </p>
                <div className="huffman-regen-actions">
                  <button type="button" className="save-bar-discard" onClick={() => setRegen(null)}>Discard</button>
                  <button type="button" className="save-bar-save" disabled={!regen.testPassed || isSaving} onClick={applyRegen}>
                    {isSaving ? 'Saving…' : 'Apply & Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </details>
      )}

      <dialog
        ref={statusModalRef}
        className="confirm-dialog"
        onCancel={(e) => { if (phase === 'analyzing' || phase === 'saving') e.preventDefault() }}
      >
          <div className="confirm-dialog-body">
            {phase === 'saved' && savedStats ? (
              <>
                <h3 className="confirm-dialog-title">✓ Huffman table regenerated</h3>
                <p className="confirm-dialog-message">
                  The new table is saved to huffman.json and is now what you're viewing —
                  built from <strong>{savedStats.messages.toLocaleString()}</strong> messages,
                  averaging <strong>{savedStats.newAvg.toFixed(2)}</strong> bits per character on your corpus
                  (previous table: {savedStats.oldAvg.toFixed(2)}).
                </p>
                <p className="confirm-dialog-message">
                  Use the <strong>✓ Verify</strong> button in the header to confirm the saved
                  table encodes and decodes text correctly.
                </p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="save-bar-save" autoFocus onClick={() => setPhase('idle')}>Close</button>
                </div>
              </>
            ) : phase === 'verified' && verifyResults ? (
              <>
                <h3 className="confirm-dialog-title">
                  {verifyResults.checks.every((c) => c.ok) ? '✓ Huffman table verified' : '✗ Huffman table has problems'}
                </h3>
                <ul className="huffman-verify-list">
                  {verifyResults.checks.map((check) => (
                    <li key={check.name} className={check.ok ? 'huffman-regen-pass' : 'huffman-regen-fail'}>
                      {check.ok ? '✓' : '✗'} {check.name}
                    </li>
                  ))}
                </ul>
                <p className="confirm-dialog-message">
                  Sample message: {verifyResults.sampleRaw} bits raw → {verifyResults.sampleEncoded} bits encoded
                  ({(100 - 100 * verifyResults.sampleEncoded / verifyResults.sampleRaw).toFixed(1)}% smaller).
                </p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="save-bar-save" autoFocus onClick={() => setPhase('idle')}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3 className="confirm-dialog-title">
                  {phase === 'saving' ? 'Saving Huffman table…' : 'Regenerating Huffman table…'}
                </h3>
                <p className="confirm-dialog-message">
                  {phase === 'saving'
                    ? 'Writing the new codes to huffman.json.'
                    : 'Counting character frequencies and building the length-limited code table. Large corpora can take a few seconds.'}
                </p>
              </>
            )}
          </div>
        </dialog>

      {view === 'table' ? (
        <div className="huffman-table-shell">
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

  // Histogram: count (and members) of symbols per code length across the full range.
  const histogram = useMemo(() => {
    const byLength = new Map<number, string[]>()
    for (const e of active) {
      if (!byLength.has(e.length)) byLength.set(e.length, [])
      byLength.get(e.length)!.push(e.char)
    }
    const rows: { length: number; count: number; chars: string[] }[] = []
    for (let l = min; l <= max; l++) rows.push({ length: l, count: byLength.get(l)?.length ?? 0, chars: byLength.get(l) ?? [] })
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
              {h.count > 0 && (
                <div className="huffman-histo-tooltip">
                  <strong>{h.length} bits</strong> · {h.count} char{h.count === 1 ? '' : 's'}
                  <div className="huffman-histo-tooltip-chars">{h.chars.join(' ')}</div>
                </div>
              )}
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
