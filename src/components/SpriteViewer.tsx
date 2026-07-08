import { useEffect, useRef, useState } from 'react'
import type { SpriteData, SpriteMeta } from '../loaders/sprites'
import './SpriteViewer.css'

type Props = {
  data: SpriteData
  onSave: (data: SpriteData) => Promise<void>
}

const ZOOM_LEVELS = [1, 2, 4, 8, 16]

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

type FrameCanvasProps = {
  meta: SpriteMeta
  frameIndex: number
  zoom: number
}

function FrameCanvas({ meta, frameIndex, zoom }: FrameCanvasProps) {
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

export default function SpriteViewer({ data, onSave }: Props) {
  const [zoom, setZoom] = useState(4)
  const [draft, setDraft] = useState<SpriteMeta>(data.meta)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setZoom(4)
    setDraft(data.meta)
    setIsDirty(false)
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

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, meta: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.meta)
    setIsDirty(false)
  }

  const frameCount = draft.usesAlpha.length

  return (
    <div className="sprite-viewer">
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

      <div className="sprite-frames">
        {Array.from({ length: frameCount }, (_, i) => (
          <div key={i} className="sprite-frame">
            {frameCount > 1 && (
              <span className="sprite-frame-label">Frame {i}</span>
            )}
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
