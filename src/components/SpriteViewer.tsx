import { useEffect, useRef, useState } from 'react'
import type { SpriteData, SpriteMeta } from '../loaders/sprites'
import './SpriteViewer.css'

type Props = {
  data: SpriteData
  onSave: (data: SpriteData) => Promise<void>
}

const ZOOM_LEVELS = [1, 2, 4, 8, 16]

// ---------------------------------------------------------------------------
// Canvas renderer
// ---------------------------------------------------------------------------

function renderFrame(canvas: HTMLCanvasElement, meta: SpriteMeta, frameIndex: number) {
  const { width, height, palette, pixelIndices, alpha, usesAlpha } = meta
  const subWidth  = meta.subWidths[frameIndex]  ?? 0
  const subHeight = meta.subHeights[frameIndex] ?? 0
  const offsetX   = meta.offsetsX[frameIndex]   ?? 0
  const offsetY   = meta.offsetsY[frameIndex]   ?? 0
  const framePixels = pixelIndices[frameIndex]
  const frameAlpha  = alpha?.[frameIndex]
  const hasAlpha    = usesAlpha[frameIndex] && frameAlpha != null

  canvas.width  = width
  canvas.height = height

  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const px = imageData.data

  for (let x = 0; x < subWidth; x++) {
    const col = framePixels?.[x]
    if (!col) continue
    for (let y = 0; y < subHeight; y++) {
      const paletteIdx = col[y] & 0xFF
      const cx = x + offsetX
      const cy = y + offsetY
      if (cx >= width || cy >= height) continue

      const pos = (cy * width + cx) * 4

      if (hasAlpha) {
        const a = frameAlpha[y * subWidth + x] & 0xFF
        if (a === 0) continue
        const rgb = palette[paletteIdx] ?? 0
        px[pos]     = (rgb >> 16) & 0xFF
        px[pos + 1] = (rgb >> 8)  & 0xFF
        px[pos + 2] =  rgb        & 0xFF
        px[pos + 3] = a
      } else {
        if (paletteIdx === 0) continue
        const rgb = palette[paletteIdx] ?? 0
        px[pos]     = (rgb >> 16) & 0xFF
        px[pos + 1] = (rgb >> 8)  & 0xFF
        px[pos + 2] =  rgb        & 0xFF
        px[pos + 3] = 255
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
}

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
// Image → SpriteMeta conversion  (mirrors Java's generatePalette logic)
// ---------------------------------------------------------------------------

function applyImageToMeta(
  imageData: ImageData,
  frameIndex: number,
  meta: SpriteMeta,
): SpriteMeta {
  const { width: imgW, height: imgH, data } = imageData

  // Build new palette, seeding with colours from frames we are NOT replacing
  // so their pixel indices remain valid after the rebuild.
  const palette: number[] = [0] // index 0 = transparent (reserved)
  const rgbToIdx = new Map<number, number>([[0, 0]])

  function getOrAdd(rgb: number): number {
    if (rgbToIdx.has(rgb)) return rgbToIdx.get(rgb)!
    if (palette.length >= 256) throw new Error(`Too many colours (${palette.length}); max is 256`)
    const idx = palette.length
    palette.push(rgb)
    rgbToIdx.set(rgb, idx)
    return idx
  }

  // Pass 1 — seed palette with all colours used by other frames
  const frameCount = meta.usesAlpha.length
  for (let f = 0; f < frameCount; f++) {
    if (f === frameIndex) continue
    const frame = meta.pixelIndices[f] ?? []
    const sw = meta.subWidths[f] ?? 0
    const sh = meta.subHeights[f] ?? 0
    for (let x = 0; x < sw; x++) {
      for (let y = 0; y < sh; y++) {
        const idx = frame[x]?.[y] ?? 0
        if (idx !== 0) getOrAdd(meta.palette[idx] ?? 1)
      }
    }
  }

  // Pass 2 — re-index other frames using the new palette
  const newPixelIndices: number[][][] = Array.from({ length: frameCount }, (_, f) => {
    if (f === frameIndex) return [] // filled below
    const oldFrame = meta.pixelIndices[f] ?? []
    const sw = meta.subWidths[f] ?? 0
    const sh = meta.subHeights[f] ?? 0
    const newFrame: number[][] = Array.from({ length: sw }, () => new Array(sh).fill(0))
    for (let x = 0; x < sw; x++) {
      for (let y = 0; y < sh; y++) {
        const oldIdx = oldFrame[x]?.[y] ?? 0
        if (oldIdx !== 0) newFrame[x][y] = getOrAdd(meta.palette[oldIdx] ?? 1)
      }
    }
    return newFrame
  })

  // Pass 3 — build pixel data from the uploaded image
  // Following generatePalette: usesAlpha = true whenever any pixel has alpha != 0
  const newFramePixels: number[][] = Array.from({ length: imgW }, () => new Array(imgH).fill(0))
  const newFrameAlpha: number[] = new Array(imgW * imgH).fill(0)
  let frameUsesAlpha = false

  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const pos = (y * imgW + x) * 4
      const r = data[pos], g = data[pos + 1], b = data[pos + 2], a = data[pos + 3]
      newFrameAlpha[y * imgW + x] = a
      if (a !== 0) {
        frameUsesAlpha = true
        const rgb = (r << 16) | (g << 8) | b
        newFramePixels[x][y] = getOrAdd(rgb)
      }
    }
  }

  newPixelIndices[frameIndex] = newFramePixels

  const newAlpha = [...meta.alpha]
  newAlpha[frameIndex] = newFrameAlpha

  const newUsesAlpha = [...meta.usesAlpha]
  newUsesAlpha[frameIndex] = frameUsesAlpha

  const newSubWidths = [...meta.subWidths]
  const newSubHeights = [...meta.subHeights]
  newSubWidths[frameIndex] = imgW
  newSubHeights[frameIndex] = imgH

  const offsetX = meta.offsetsX[frameIndex] ?? 0
  const offsetY = meta.offsetsY[frameIndex] ?? 0

  return {
    ...meta,
    width:        Math.max(meta.width,  offsetX + imgW),
    height:       Math.max(meta.height, offsetY + imgH),
    palette,
    pixelIndices: newPixelIndices,
    alpha:        newAlpha,
    usesAlpha:    newUsesAlpha,
    subWidths:    newSubWidths,
    subHeights:   newSubHeights,
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SpriteViewer({ data, onSave }: Props) {
  const [zoom, setZoom] = useState(4)
  const [draft, setDraft] = useState<SpriteMeta>(data.meta)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingFrameRef = useRef<number>(0)

  useEffect(() => {
    setZoom(4)
    setDraft(data.meta)
    setIsDirty(false)
    setUploadError(null)
  }, [data.id, data.meta])

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
      const bitmap = await createImageBitmap(file)
      const offscreen = document.createElement('canvas')
      offscreen.width  = bitmap.width
      offscreen.height = bitmap.height
      const ctx = offscreen.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const imageData = ctx.getImageData(0, 0, offscreen.width, offscreen.height)

      setDraft((prev) => {
        const next = applyImageToMeta(imageData, frameIndex, prev)
        return next
      })
      setIsDirty(true)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
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
          <span className="sprite-dims">{draft.palette.length} colours</span>
        </div>
        <div className="sprite-zoom-row">
          <span className="sprite-zoom-label">Zoom</span>
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
        </div>
      </div>

      {uploadError && (
        <div className="upload-error">{uploadError}</div>
      )}

      <div className="sprite-frames">
        {Array.from({ length: frameCount }, (_, i) => (
          <div key={i} className="sprite-frame">
            <div className="sprite-frame-header">
              {frameCount > 1 && (
                <span className="sprite-frame-label">Frame {i}</span>
              )}
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
            </div>
            <div
              className="sprite-canvas"
              style={{ width: draft.width * zoom, height: draft.height * zoom }}
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
                  <input
                    className="stat-input"
                    type="number"
                    value={draft[key][i] ?? 0}
                    onChange={(e) => setFrameField(key, i, parseInt(e.target.value, 10) || 0)}
                  />
                </div>
              ))}
              <div className="sprite-meta-card">
                <span className="sprite-meta-label">Vertical</span>
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
