import { useEffect, useMemo, useRef, useState } from 'react'
import type { FontData, FontMetricsDef } from '../loaders/font_metrics'
import { NumberInput } from './defFields'
import { DEFAULT_IMPORT, frameToCanvas, loadFontFace, rasteriseFont } from './fontImport'
import type { ImportOptions, ImportedFont } from './fontImport'
import { nextFreeSpriteId } from '../loaders/spriteStore'
import './FontViewer.css'

type Props = {
  data: FontData
  onSave: (data: FontData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

// The sample survives switching fonts (handy for comparing them), so there's
// a Reset button to get back to this.
const DEFAULT_SAMPLE = 'The quick brown fox 0123456789'

function charLabel(code: number): string {
  if (code === 32) return 'SP'
  if (code === 9) return '\\t'
  if (code === 10) return '\\n'
  if (code >= 33 && code <= 126) return String.fromCharCode(code)
  return `0x${code.toString(16).toUpperCase().padStart(2, '0')}`
}

// Renders text exactly like the client: each glyph blitted at the pen position,
// then the pen advanced by that character's advance width (glyphWidths), with
// verticalSpacing between lines. Kerning isn't applied — these fonts are all
// variadicWidth: false, so the cache carries no kerning table.
function TextPreview({ text, bitmaps, metrics, zoom, color }: {
  text: string
  bitmaps: Map<number, ImageBitmap>
  metrics: FontMetricsDef | null
  zoom: number
  color: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !metrics) return

    const lineHeight = metrics.verticalSpacing || 12
    const widths = metrics.glyphWidths ?? []
    const lines = text.split('\n')

    // Measure first so the canvas is exactly the rendered size.
    let maxWidth = 1
    let tallestGlyph = 0
    for (const line of lines) {
      let w = 0
      for (const ch of line) {
        const code = ch.charCodeAt(0)
        w += widths[code] ?? 0
        const bitmap = bitmaps.get(code)
        if (bitmap && bitmap.height > tallestGlyph) tallestGlyph = bitmap.height
      }
      if (w > maxWidth) maxWidth = w
    }

    // verticalSpacing is the LINE ADVANCE, not the glyph height — descenders
    // (q, p, y, g) hang below it. Size the canvas by the tallest glyph on the
    // last line so they aren't clipped off the bottom.
    const height = Math.max((lines.length - 1) * lineHeight + Math.max(tallestGlyph, lineHeight), 1)

    // Render at the zoomed resolution rather than CSS-scaling the element: a
    // transform leaves the layout box at 1x, so the container couldn't size or
    // centre the canvas correctly (the text drifted to the bottom at 2x/4x).
    canvas.width = maxWidth * zoom
    canvas.height = height * zoom
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = false
    ctx.scale(zoom, zoom)

    lines.forEach((line, lineIndex) => {
      let penX = 0
      const baseY = lineIndex * lineHeight
      for (const ch of line) {
        const code = ch.charCodeAt(0)
        const bitmap = bitmaps.get(code)
        // A bitmap can be detached if its font was swapped out mid-render.
        if (bitmap && bitmap.width > 0) {
          try {
            ctx.drawImage(bitmap, penX, baseY)
          } catch {
            // detached — the effect will re-run with the new font's bitmaps
          }
        }
        penX += widths[code] ?? 0
      }
    })

    // The glyph PNGs are white/greyscale masks; tint them like the client does
    // when drawing text in a colour.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.globalCompositeOperation = 'source-over'
  }, [text, bitmaps, metrics, color, zoom])

  if (!metrics) return <p className="map-sprite-none">No metrics for this font — can't lay out text.</p>

  return <canvas ref={ref} className="font-preview-canvas" />
}

// A plain <input> can't wrap (single-line by spec), so the sample field is a
// textarea styled as a normal box: no resize handle, no scrollbar, and its
// height driven by the content.
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// Live preview of a rasterised TTF/OTF, before it's applied: the sample text
// laid out with the imported advance widths, plus a strip of the glyphs.
// Draws straight from the SpriteMeta frames, so it shows exactly what would be
// written to the cache — not the browser's own rendering of the font.
function ImportPreview({ imported, sample, zoom }: {
  imported: ImportedFont
  sample: string
  zoom: number
}) {
  const textRef = useRef<HTMLCanvasElement>(null)
  const atlasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const { meta, metrics } = imported
    const widths = metrics.glyphWidths ?? []
    const lineHeight = metrics.verticalSpacing || 12

    // --- sample text ---
    const canvas = textRef.current
    if (canvas) {
      let textWidth = 1
      for (const ch of sample) textWidth += widths[ch.charCodeAt(0)] ?? 0

      canvas.width = textWidth * zoom
      canvas.height = lineHeight * zoom
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.imageSmoothingEnabled = false
      ctx.scale(zoom, zoom)

      let penX = 0
      for (const ch of sample) {
        const code = ch.charCodeAt(0)
        const glyph = frameToCanvas(meta, code)
        if (glyph) ctx.drawImage(glyph, penX, 0)
        penX += widths[code] ?? 0
      }
    }

    // --- glyph strip (A–Z a–z 0–9) ---
    const atlas = atlasRef.current
    if (atlas) {
      const codes = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789']
        .map((c) => c.charCodeAt(0))

      let stripWidth = 1
      for (const code of codes) stripWidth += (widths[code] ?? 0) + 1

      atlas.width = stripWidth * zoom
      atlas.height = lineHeight * zoom
      const ctx = atlas.getContext('2d')!
      ctx.clearRect(0, 0, atlas.width, atlas.height)
      ctx.imageSmoothingEnabled = false
      ctx.scale(zoom, zoom)

      let penX = 0
      for (const code of codes) {
        const glyph = frameToCanvas(meta, code)
        if (glyph) ctx.drawImage(glyph, penX, 0)
        penX += (widths[code] ?? 0) + 1
      }
    }
  }, [imported, sample, zoom])

  return (
    <div className="font-import-preview">
      <span className="item-field-label">Sample</span>
      <div className="font-preview-wrap">
        <canvas ref={textRef} className="font-preview-canvas" />
      </div>
      <span className="item-field-label">Glyphs</span>
      <div className="font-preview-wrap font-import-strip">
        <canvas ref={atlasRef} className="font-preview-canvas" />
      </div>
    </div>
  )
}

function GlyphCell({ code, blob, zoom }: { code: number; blob: Blob; zoom: number }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])

  return (
    <div className="font-glyph-cell">
      <div className="font-glyph-img-wrap">
        {url && <img src={url} alt="" className="font-glyph-img" style={{ transform: `scale(${zoom})` }} />}
      </div>
      <span className="font-glyph-char" title={`Character ${charLabel(code)} (code ${code})`}>
        {charLabel(code)}
      </span>
    </div>
  )
}

export default function FontViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<FontMetricsDef | null>(data.metrics)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [sample, setSample] = useState(DEFAULT_SAMPLE)
  const [color, setColor] = useState('#ffffff')
  const [zoom, setZoom] = useState(1)
  const [showAll, setShowAll] = useState(false)
  const [bitmaps, setBitmaps] = useState<Map<number, ImageBitmap>>(new Map())
  const sampleRef = useRef<HTMLTextAreaElement>(null)

  // --- TTF/OTF import ---
  const [importFamily, setImportFamily] = useState<string | null>(null)
  const [importOpts, setImportOpts] = useState<ImportOptions>(DEFAULT_IMPORT)
  const [importResult, setImportResult] = useState<ImportedFont | null>(null)
  const [importSpriteId, setImportSpriteId] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<FontData['pendingImport']>(null)
  const fontFileRef = useRef<HTMLInputElement>(null)
  const releaseFontRef = useRef<(() => void) | null>(null)

  // Drop the loaded FontFace when leaving the page or swapping fonts.
  useEffect(() => () => releaseFontRef.current?.(), [])

  // SECURITY: the file is read as bytes and handed to the browser's font
  // rasteriser only — never executed, evaluated, or written to disk. The input
  // is cleared immediately so no reference to the file survives.
  async function handleFontFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setImportError(null)
    setImportResult(null)
    if (file.size > 20 * 1024 * 1024) {
      setImportError('File too large — max 20 MB.')
      return
    }
    if (!/\.(ttf|otf)$/i.test(file.name)) {
      setImportError('Not a .ttf or .otf file.')
      return
    }

    try {
      releaseFontRef.current?.()
      const { family, release } = await loadFontFace(file)
      releaseFontRef.current = release
      setImportFamily(family)
      if (data.rootDir) {
        setImportSpriteId(await nextFreeSpriteId(await data.rootDir.getDirectoryHandle('sprites')))
      }
    } catch {
      setImportError("Couldn't read that font — is it a valid TTF/OTF?")
    }
  }

  // Re-rasterise whenever the font or its options change, so the preview is live.
  useEffect(() => {
    if (!importFamily) return
    try {
      setImportResult(rasteriseFont(importFamily, importOpts, data.id))
      setImportError(null)
    } catch {
      setImportError('Rasterising failed at these settings.')
    }
  }, [importFamily, importOpts, data.id])

  // Stage the import: preview it in the editor, but nothing is written until Save.
  async function applyImport() {
    if (!importResult || importSpriteId == null) return

    const frames = await Promise.all(
      Array.from({ length: 256 }, async (_, code) => {
        const canvas = frameToCanvas(importResult.meta, code)
        if (!canvas) return null
        return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      }),
    )

    setPendingImport({ spriteId: importSpriteId, meta: importResult.meta, frames })
    setDraft(importResult.metrics)

    // Preview the imported glyphs immediately.
    const decoded = new Map<number, ImageBitmap>()
    await Promise.all(frames.map(async (png, code) => {
      if (png) decoded.set(code, await createImageBitmap(png))
    }))
    setBitmaps(decoded)

    setIsDirty(true)
    setImportResult(null)
    setImportFamily(null)
    releaseFontRef.current?.()
  }

  function cancelImport() {
    setImportResult(null)
    setImportFamily(null)
    setImportError(null)
    releaseFontRef.current?.()
  }

  // Resize on the VALUE, not in the change handler: Reset (and any other
  // programmatic set) never goes through onChange, so the box kept its old
  // height and stopped wrapping to fit.
  useEffect(() => {
    autoGrow(sampleRef.current)
  }, [sample])

  useEffect(() => {
    setDraft(data.metrics)
    setPendingImport(null)
    // Drop the previous font's bitmaps right away — otherwise the preview
    // renders one frame with the old glyphs before the new ones decode.
    setBitmaps(new Map())
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Decode every glyph once for the text preview.
  //
  // The bitmaps are NOT closed on cleanup: the same map is handed to the
  // preview, and closing them detaches the images out from under a render
  // that may still be in flight ("The image source is detached"). They're
  // garbage-collected with the map instead; only bitmaps from a run whose
  // results were thrown away get closed explicitly.
  useEffect(() => {
    let cancelled = false
    const decoded = new Map<number, ImageBitmap>()
    Promise.all([...data.glyphs.entries()].map(async ([code, blob]) => {
      const bitmap = await createImageBitmap(blob)
      decoded.set(code, bitmap)
    })).then(() => {
      if (cancelled) {
        for (const bitmap of decoded.values()) bitmap.close()
        return
      }
      setBitmaps(decoded)
    })
    return () => { cancelled = true }
  }, [data.glyphs])

  function setMetric(key: string, value: number) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
    setIsDirty(true)
  }

  function setGlyphWidth(code: number, value: number) {
    setDraft((prev) => {
      if (!prev) return prev
      const widths = [...(prev.glyphWidths ?? new Array(256).fill(0))]
      widths[code] = value
      return { ...prev, glyphWidths: widths }
    })
    setIsDirty(true)
  }

  async function handleSave() {
    if (!draft) return
    setIsSaving(true)
    await onSave({ ...data, metrics: draft, pendingImport })
    setPendingImport(null)
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.metrics)
    setPendingImport(null)
    setIsDirty(false)
  }

  const widths = draft?.glyphWidths ?? []

  // Printable range by default; the toggle reveals every dumped glyph.
  const glyphCodes = useMemo(() => {
    const codes = [...data.glyphs.keys()].sort((a, b) => a - b)
    return showAll ? codes : codes.filter((c) => c >= 32 && c <= 126)
  }, [data.glyphs, showAll])

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Font {data.id}</span>
          <span className="item-id-badge">{data.kind}</span>
          <span className="item-id-badge" title={data.glyphSource === 'sprites' ? 'Glyphs read from the sprites index — the client loads fonts from either the font index or sprites' : 'Glyphs from the dedicated font index'}>
            {data.glyphs.size} glyphs · {data.glyphSource}
          </span>
          {draft?.variadicWidth && <span className="item-id-badge">variadic</span>}
        </div>
      </div>

      <div className="hit-zoom-bar">
        <span className="hit-zoom-label">Zoom</span>
        <div className="hit-zoom-buttons">
          {[1, 2, 4].map((z) => (
            <button key={z} type="button" className={`zoom-btn${zoom === z ? ' active' : ''}`} onClick={() => setZoom(z)}>
              {z}×
            </button>
          ))}
        </div>
      </div>

      <section className="item-section">
        <h3>Text Preview</h3>
        {data.glyphs.size === 0 ? (
          <p className="map-sprite-none">
            No glyphs dumped for this font — re-dump with cryogen's FontGlyphs to get fonts/glyphs/.
          </p>
        ) : (
          <>
            <div className="font-preview-wrap">
              <TextPreview text={sample} bitmaps={bitmaps} metrics={draft} zoom={zoom} color={color} />
            </div>
            <div className="item-grid font-preview-controls">
              <label className="item-field font-sample-field">
                <span className="item-field-label font-sample-label">
                  <span>Sample Text · {sample.length} chars</span>
                  {sample !== DEFAULT_SAMPLE && (
                    <button
                      type="button"
                      className="font-sample-reset"
                      title="Restore the default sample text"
                      onClick={() => setSample(DEFAULT_SAMPLE)}
                    >
                      Reset
                    </button>
                  )}
                </span>
                <textarea
                  className="item-field-input font-sample-input"
                  rows={1}
                  value={sample}
                  ref={sampleRef}
                  onChange={(e) => setSample(e.target.value)}
                />
              </label>
              <label className="item-field">
                <span className="item-field-label">Colour</span>
                <div className="map-sprite-colour-row">
                  <input
                    type="color"
                    className="map-sprite-colour-input"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                  />
                  <span className="map-sprite-colour-hex">{color}</span>
                </div>
              </label>
            </div>
          </>
        )}
      </section>

      <details className="huffman-regen" open={importResult != null}>
        <summary>Import a TTF/OTF font…</summary>
        <div className="huffman-regen-body">
          <ul className="huffman-regen-disclaimers">
            <li>
              The font is rasterised in your browser at the pixel size you pick, producing a
              <strong> 256-frame sprite archive</strong> (one bitmap per cp1252 character) and a
              <strong> metrics file</strong> (advance widths + line height). Only the 256 byte codes
              are addressable, so glyphs outside cp1252 can't be represented.
            </li>
            <li>
              The file is read as bytes and handed to the browser's font rasteriser — never executed,
              and never written anywhere. Nothing touches disk until you press Save.
            </li>
            <li>
              Cache fonts are small and hand-pixelled. Antialiasing is off by default so glyphs stay
              crisp; raise the threshold if strokes look too heavy.
            </li>
          </ul>

          <input
            ref={fontFileRef}
            type="file"
            accept=".ttf,.otf,font/ttf,font/otf"
            style={{ display: 'none' }}
            onChange={handleFontFile}
          />
          <button type="button" className="huffman-regen-upload" onClick={() => fontFileRef.current?.click()}>
            🅵 Choose a .ttf / .otf file…
          </button>

          {importError && <p className="huffman-regen-error">{importError}</p>}

          {importFamily && (
            <>
              <div className="item-grid font-import-options">
                <label className="item-field">
                  <span className="item-field-label">Pixel Size</span>
                  <NumberInput value={importOpts.pixelSize} min={4} max={64}
                    onChange={(v) => setImportOpts((o) => ({ ...o, pixelSize: v }))} />
                </label>
                <label className="item-field">
                  <span className="item-field-label">Threshold (0–255)</span>
                  <NumberInput value={importOpts.threshold} min={1} max={254}
                    onChange={(v) => setImportOpts((o) => ({ ...o, threshold: v }))} />
                </label>
                <label className="item-field def-toggle-field">
                  <span className="item-field-label">Bold</span>
                  <span className="sprite-toggle">
                    <input type="checkbox" checked={importOpts.bold}
                      onChange={(e) => setImportOpts((o) => ({ ...o, bold: e.target.checked }))} />
                    <span className="sprite-toggle-track" />
                  </span>
                </label>
                <label className="item-field def-toggle-field">
                  <span className="item-field-label">Antialias</span>
                  <span className="sprite-toggle">
                    <input type="checkbox" checked={importOpts.antialias}
                      onChange={(e) => setImportOpts((o) => ({ ...o, antialias: e.target.checked }))} />
                    <span className="sprite-toggle-track" />
                  </span>
                </label>
              </div>

              {importResult && (
                <div className="huffman-regen-result">
                  <ImportPreview imported={importResult} sample={sample} zoom={zoom} />
                  <p>
                    <strong>{importResult.glyphCount}</strong> glyphs rasterised at{' '}
                    <strong>{importOpts.pixelSize}px</strong> · line height{' '}
                    <strong>{importResult.metrics.verticalSpacing}</strong>
                  </p>
                  <p className="qc-hint">
                    Saving creates sprite <strong>{importSpriteId}</strong> and writes
                    fonts/metrics/{data.id}.json — replacing this font's glyphs and metrics.
                  </p>
                  <div className="huffman-regen-actions">
                    <button type="button" className="save-bar-discard" onClick={cancelImport}>Discard</button>
                    <button type="button" className="save-bar-save" onClick={applyImport}>Apply</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </details>

      {draft ? (
        <section className="item-section">
          <h3>Metrics</h3>
          <div className="item-grid">
            <label className="item-field">
              <span className="item-field-label">Vertical Spacing (line height)</span>
              <NumberInput value={draft.verticalSpacing ?? 0} min={0} onChange={(v) => setMetric('verticalSpacing', v)} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Top Padding</span>
              <NumberInput value={draft.topPadding ?? 0} min={0} onChange={(v) => setMetric('topPadding', v)} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Bottom Padding</span>
              <NumberInput value={draft.bottomPadding ?? 0} min={0} onChange={(v) => setMetric('bottomPadding', v)} />
            </label>
          </div>
        </section>
      ) : (
        <section className="item-section">
          <p className="map-sprite-none">
            No metrics file for this id — the glyphs render, but text can't be laid out without advance widths.
          </p>
        </section>
      )}

      <section className="item-section">
        <div className="font-glyphs-header">
          <h3>Glyphs</h3>
          <button type="button" className="huffman-toggle" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Printable only' : `Show all ${data.glyphs.size}`}
          </button>
        </div>
        <p className="qc-hint">Each cell shows the glyph bitmap, its character, and its advance width (editable).</p>
        {glyphCodes.length === 0 ? (
          <p className="map-sprite-none">No glyphs in this range.</p>
        ) : (
          <div className="font-glyph-grid">
            {glyphCodes.map((code) => (
              <div key={code} className="font-glyph-entry">
                <GlyphCell code={code} blob={data.glyphs.get(code)!} zoom={zoom} />
                <div className="font-glyph-meta">
                  <span className="font-glyph-meta-row" title="The character's code in the font (cp1252)">
                    <span className="font-glyph-meta-label">Code</span>
                    <span className="font-glyph-meta-value">{code}</span>
                  </span>
                  <span className="font-glyph-meta-row" title="Advance width: how far the pen moves after drawing this character. This is what controls text spacing.">
                    <span className="font-glyph-meta-label">Advance</span>
                    {draft ? (
                      <NumberInput
                        className="cell-input font-glyph-advance"
                        value={widths[code] ?? 0}
                        min={0}
                        onChange={(v) => setGlyphWidth(code, v)}
                      />
                    ) : (
                      <span className="font-glyph-meta-value">{widths[code] ?? 0}</span>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes — saves to fonts/metrics/{data.id}.json</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
