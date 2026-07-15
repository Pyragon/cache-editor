import { useEffect, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import { NumberInput } from './defFields'
import type { SpriteData, SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, imageDataFromFile, renderFrame } from './spriteRender'
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

export default function SpriteViewer({ data, onSave, onDirtyChange }: Props) {
  const [zoom, setZoom] = useZoom('cache-editor:sprite-zoom', ZOOM_LEVELS, 4)
  const [draft, setDraft] = useState<SpriteMeta>(data.meta)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingFrameRef = useRef<number>(0)

  useEffect(() => {
    setDraft(data.meta)
    setIsDirty(false)
    setUploadError(null)
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
      setDraft((prev) => applyImageToMeta(imageData, frameIndex, prev))
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
