import { useEffect, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import { NumberInput } from './defFields'
import type { SpriteData, SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, imageDataFromFile, renderFrame } from './spriteRender'
import { quantizeImage } from './quantize'
import SpritePixelEditor from './SpritePixelEditor'
import './SpriteViewer.css'

type Props = {
  data: SpriteData
  onSave: (data: SpriteData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const ZOOM_LEVELS = [1, 2, 4, 8, 16]

function FrameCanvas({ meta, frameIndex, zoom }: { meta: SpriteMeta; frameIndex: number; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (ref.current) renderFrame(ref.current, meta, frameIndex)
  }, [meta, frameIndex])

  return (
    <canvas
      ref={ref}
      style={{
        width:  meta.width  * zoom,
        height: meta.height * zoom,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type CanvasBg = 'checker' | 'dark' | 'transparent' | 'custom'

export default function SpriteViewer({ data, onSave, onDirtyChange }: Props) {
  const [zoom, setZoom] = useZoom('cache-editor:sprite-zoom', ZOOM_LEVELS, 4)
  const [draft, setDraft] = useState<SpriteMeta>(data.meta)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [pixelEditFrame, setPixelEditFrame] = useState<number | null>(null)
  const [bgColor, setBgColor] = useState('#3a6ea5')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingFrameRef = useRef<number>(0)

  useEffect(() => {
    setDraft(data.meta)
    setIsDirty(false)
    setUploadError(null)
    setUploadNote(null)
    setPixelEditFrame(null)
  }, [data.id, data.meta])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function setFrameField(
    key: 'subWidths' | 'subHeights' | 'offsetsX' | 'offsetsY',
    frameIndex: number,
    value: number,
  ) {
    setDraft((prev) => {
      const arr = [...prev[key]]
      arr[frameIndex] = value
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  function setFrameBool(key: 'usesAlpha' | 'isVertical', frameIndex: number, value: boolean) {
    setDraft((prev) => {
      const arr = [...prev[key]]
      arr[frameIndex] = value
      return { ...prev, [key]: arr }
    })
    setIsDirty(true)
  }

  function handleDownload(frameIndex: number) {
    const canvas = document.createElement('canvas')
    renderFrame(canvas, draft, frameIndex)
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sprite_${data.id}_frame_${frameIndex}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  function openUpload(frameIndex: number) {
    pendingFrameRef.current = frameIndex
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const frameIndex = pendingFrameRef.current

    try {
      const imageData = await imageDataFromFile(file)
      // The palette budget for this frame is whatever the OTHER frames leave
      // of the 255 usable slots — images over it are quantized down instead of
      // refused (applyImageToMeta's own throw remains as a backstop).
      const others = new Set<number>()
      for (let f = 0; f < draft.usesAlpha.length; f++) {
        if (f === frameIndex) continue
        const frame = draft.pixelIndices[f] ?? []
        for (const col of frame) {
          for (const idx of col ?? []) {
            if (idx !== 0) others.add((draft.palette[idx] ?? 0) & 0xffffff)
          }
        }
      }
      const q = quantizeImage(imageData, Math.max(1, 255 - others.size))
      setUploadNote(q.colorCount < q.originalCount
        ? `Image had ${q.originalCount} colours — quantized down to ${q.colorCount} to fit the sprite palette.`
        : null)
      setDraft((prev) => {
        // "Add frame" uploads target index === frame count — extend all the
        // parallel per-frame arrays with an empty frame first
        const base = frameIndex >= prev.usesAlpha.length ? appendEmptyFrame(prev) : prev
        return applyImageToMeta(q.image, frameIndex, base)
      })
      setIsDirty(true)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  // Swap frame i with its neighbour across all the parallel per-frame arrays.
  function handleMoveFrame(i: number, dir: -1 | 1) {
    setDraft((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.usesAlpha.length) return prev
      function swap<T>(arr: T[]): T[] {
        const out = [...arr]
        ;[out[i], out[j]] = [out[j], out[i]]
        return out
      }
      return {
        ...prev,
        pixelIndices: swap(prev.pixelIndices),
        alpha: swap(prev.alpha),
        usesAlpha: swap(prev.usesAlpha),
        isVertical: swap(prev.isVertical),
        offsetsX: swap(prev.offsetsX),
        offsetsY: swap(prev.offsetsY),
        subWidths: swap(prev.subWidths),
        subHeights: swap(prev.subHeights),
      }
    })
    setIsDirty(true)
  }

  function appendEmptyFrame(meta: SpriteMeta): SpriteMeta {
    return {
      ...meta,
      pixelIndices: [...meta.pixelIndices, []],
      alpha: [...meta.alpha, []],
      usesAlpha: [...meta.usesAlpha, false],
      isVertical: [...meta.isVertical, false],
      offsetsX: [...meta.offsetsX, 0],
      offsetsY: [...meta.offsetsY, 0],
      subWidths: [...meta.subWidths, 0],
      subHeights: [...meta.subHeights, 0],
    }
  }

  // A pre-sized empty frame for the pixel editor's "add frame" flow —
  // appendEmptyFrame's 0×0 sub-frame would open a 1×1 canvas.
  function withNewFrame(meta: SpriteMeta): SpriteMeta {
    const appended = appendEmptyFrame(meta)
    const i = appended.usesAlpha.length - 1
    appended.subWidths[i] = Math.max(1, meta.width)
    appended.subHeights[i] = Math.max(1, meta.height)
    return appended
  }

  function handleCloneFrame(frameIndex: number) {
    setDraft((prev) => ({
      ...prev,
      pixelIndices: [...prev.pixelIndices, prev.pixelIndices[frameIndex]?.map((col) => [...col]) ?? []],
      alpha: [...prev.alpha, [...(prev.alpha[frameIndex] ?? [])]],
      usesAlpha: [...prev.usesAlpha, prev.usesAlpha[frameIndex] ?? false],
      isVertical: [...prev.isVertical, prev.isVertical[frameIndex] ?? false],
      offsetsX: [...prev.offsetsX, prev.offsetsX[frameIndex] ?? 0],
      offsetsY: [...prev.offsetsY, prev.offsetsY[frameIndex] ?? 0],
      subWidths: [...prev.subWidths, prev.subWidths[frameIndex] ?? 0],
      subHeights: [...prev.subHeights, prev.subHeights[frameIndex] ?? 0],
    }))
    setIsDirty(true)
  }

  function handleRemoveFrame(frameIndex: number) {
    setDraft((prev) => {
      const drop = <T,>(arr: T[]): T[] => arr.filter((_, i) => i !== frameIndex)
      return {
        ...prev,
        pixelIndices: drop(prev.pixelIndices),
        alpha: drop(prev.alpha),
        usesAlpha: drop(prev.usesAlpha),
        isVertical: drop(prev.isVertical),
        offsetsX: drop(prev.offsetsX),
        offsetsY: drop(prev.offsetsY),
        subWidths: drop(prev.subWidths),
        subHeights: drop(prev.subHeights),
      }
    })
    setIsDirty(true)
  }

  function handlePaletteColor(index: number, hex: string) {
    const rgb = parseInt(hex.slice(1), 16)
    setDraft((prev) => {
      const palette = [...prev.palette]
      palette[index] = rgb
      return { ...prev, palette }
    })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, meta: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.meta)
    setIsDirty(false)
    setUploadError(null)
    setUploadNote(null)
  }

  const frameCount = draft.usesAlpha.length

  return (
    <div className="sprite-viewer">
      {/* Hidden file input shared across all frames */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="sprite-header">
        <div className="sprite-title">
          <span className="sprite-id">Sprite {data.id}</span>
          <span className="sprite-dims">{draft.width} × {draft.height}</span>
          <span className="sprite-dims">{frameCount} frame{frameCount === 1 ? '' : 's'}</span>
          <span className="sprite-dims">{draft.palette.length} / 256 colours</span>
        </div>
        <div className="sprite-zoom-row">
          <span className="sprite-zoom-label">Background</span>
          <span className="btn-pill">
            {(['checker', 'dark', 'transparent'] as CanvasBg[]).map((b) => (
              <button
                key={b}
                type="button"
                className={`zoom-btn${bg === b ? ' active' : ''}`}
                onClick={() => setBg(b)}
              >
                {b === 'checker' ? 'Checker' : b === 'dark' ? 'Dark' : 'Transparent'}
              </button>
            ))}
          </span>
          <input
            type="color"
            className={`sprite-bg-swatch${bg === 'custom' ? ' active' : ''}`}
            title="Custom background colour"
            value={bgColor}
            onClick={() => setBg('custom')}
            onChange={(e) => {
              setBgColor(e.target.value)
              setBg('custom')
            }}
          />
          <span className="sprite-zoom-label">Zoom</span>
          <span className="btn-pill">
            {ZOOM_LEVELS.map((z) => (
              <button
                key={z}
                type="button"
                className={`zoom-btn${zoom === z ? ' active' : ''}`}
                onClick={() => setZoom(z)}
              >
                {z}×
              </button>
            ))}
          </span>
        </div>
      </div>

      {uploadError && (
        <div className="upload-error">{uploadError}</div>
      )}
      {uploadNote && (
        <div className="upload-note">{uploadNote}</div>
      )}

      {draft.palette.length > 1 && (
        <div className="sprite-palette">
          <span className="sprite-meta-label">Palette — click a swatch to recolour every pixel using it</span>
          <div className="sprite-palette-grid">
            <span
              className="sprite-palette-swatch sprite-palette-transparent"
              title="Index 0 — reserved transparent"
            />
            {draft.palette.slice(1).map((rgb, i) => (
              <input
                key={i + 1}
                type="color"
                className="sprite-palette-swatch"
                title={`Index ${i + 1} — #${(rgb >>> 0).toString(16).padStart(6, '0')}`}
                value={`#${((rgb & 0xffffff) >>> 0).toString(16).padStart(6, '0')}`}
                onChange={(e) => handlePaletteColor(i + 1, e.target.value)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="sprite-frames">
        {Array.from({ length: frameCount }, (_, i) => (
          <div key={i} className="sprite-frame">
            <div className="sprite-frame-header">
              {frameCount > 1 && (
                <span className="sprite-frame-label">Frame {i}</span>
              )}
              {frameCount > 1 && (
                <>
                  <button
                    type="button"
                    className="replace-btn"
                    title="Move this frame up"
                    disabled={i === 0}
                    onClick={() => handleMoveFrame(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="replace-btn"
                    title="Move this frame down"
                    disabled={i === frameCount - 1}
                    onClick={() => handleMoveFrame(i, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button
                type="button"
                className="replace-btn"
                onClick={() => setPixelEditFrame(i)}
              >
                Edit
              </button>
              <button
                type="button"
                className="replace-btn"
                onClick={() => openUpload(i)}
              >
                Replace
              </button>
              <button
                type="button"
                className="replace-btn"
                onClick={() => handleDownload(i)}
              >
                Download
              </button>
              <button
                type="button"
                className="replace-btn"
                onClick={() => handleCloneFrame(i)}
              >
                Clone
              </button>
              {frameCount > 1 && (
                <button
                  type="button"
                  className="replace-btn sprite-remove-btn"
                  onClick={() => handleRemoveFrame(i)}
                >
                  Remove
                </button>
              )}
            </div>
            <div
              className="sprite-canvas"
              style={{
                width: draft.width * zoom,
                height: draft.height * zoom,
                ...(bg === 'dark' ? { background: '#14161d' }
                  : bg === 'custom' ? { background: bgColor }
                  // shorthand also clears the CSS checker background-image;
                  // the border goes too so nothing frames the bare pixels
                  : bg === 'transparent' ? { background: 'transparent', border: 'none' }
                  : {}),
              }}
            >
              <FrameCanvas meta={draft} frameIndex={i} zoom={zoom} />
            </div>
            <div className="sprite-frame-meta">
              {([
                ['Sub-width',  'subWidths'],
                ['Sub-height', 'subHeights'],
                ['Offset X',   'offsetsX'],
                ['Offset Y',   'offsetsY'],
              ] as [string, 'subWidths' | 'subHeights' | 'offsetsX' | 'offsetsY'][]).map(([label, key]) => (
                <div key={key} className="sprite-meta-card">
                  <span className="sprite-meta-label">{label}</span>
                  <NumberInput className="stat-input" value={draft[key][i] ?? 0} onChange={(v) => setFrameField(key, i,v)} />
                </div>
              ))}
              <div className="sprite-meta-card" title="Cache storage order only (column-major pixel packing) — does not rotate or change how the sprite renders. Kept so repacking can write the original byte order.">
                <span className="sprite-meta-label">Vertical Storage</span>
                <label className="sprite-toggle">
                  <input
                    type="checkbox"
                    checked={draft.isVertical[i] ?? false}
                    onChange={(e) => setFrameBool('isVertical', i, e.target.checked)}
                  />
                  <span className="sprite-toggle-track" />
                </label>
              </div>
              <div className="sprite-meta-card">
                <span className="sprite-meta-label">Alpha</span>
                <label className="sprite-toggle">
                  <input
                    type="checkbox"
                    checked={draft.usesAlpha[i] ?? false}
                    onChange={(e) => setFrameBool('usesAlpha', i, e.target.checked)}
                  />
                  <span className="sprite-toggle-track" />
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="sprite-add-frame"
        title="Draw a new frame in the pixel editor (upload or fetch a starting image inside)"
        onClick={() => setPixelEditFrame(frameCount)}
      >
        + Add frame
      </button>

      {pixelEditFrame != null && (
        <SpritePixelEditor
          // Adding targets index === frame count: the editor gets a draft with
          // an empty frame appended (pre-sized to the sprite), and Cancel drops
          // it since the real draft is only replaced on Apply.
          meta={pixelEditFrame >= frameCount ? withNewFrame(draft) : draft}
          frameIndex={pixelEditFrame}
          title={pixelEditFrame >= frameCount ? `New frame ${pixelEditFrame}` : undefined}
          onApply={(m) => {
            setDraft(m)
            setIsDirty(true)
            setPixelEditFrame(null)
          }}
          onCancel={() => setPixelEditFrame(null)}
        />
      )}

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
