import { useEffect, useMemo, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import { NumberInput } from './defFields'
import type { CursorData, CursorDef } from '../loaders/config/cursors'
import type { SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, imageDataFromFile, renderFrame } from './spriteRender'
import './CursorViewer.css'

type Props = {
  data: CursorData
  onSave: (data: CursorData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const ZOOM_LEVELS = [1, 2, 4, 8]

export default function CursorViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<CursorDef>(data.cursor)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [zoom, setZoom] = useZoom('cache-editor:cursor-zoom', ZOOM_LEVELS, 1)
  const [sprite, setSprite] = useState<SpriteMeta | null>(null)
  const [spriteError, setSpriteError] = useState<string | null>(null)
  const [isPickingHotspot, setIsPickingHotspot] = useState(false)
  const [hoverPixel, setHoverPixel] = useState<{ x: number; y: number } | null>(null)
  const [isTestingCursor, setIsTestingCursor] = useState(false)
  const [isSpriteDirty, setIsSpriteDirty] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [spriteReloadKey, setSpriteReloadKey] = useState(0)
  const [clickCrosses, setClickCrosses] = useState<{ id: number; x: number; y: number; color: 'red' | 'yellow' }[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const crossIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // True while an uploaded (not-yet-saved) sprite is staged — blocks the
  // disk-load effect from clobbering it when the allocated id is applied.
  const stagedUploadRef = useRef(false)

  useEffect(() => {
    setDraft(data.cursor)
    setIsDirty(false)
    setIsPickingHotspot(false)
    setIsTestingCursor(false)
    setIsSpriteDirty(false)
    setUploadError(null)
    setSaveError(null)
    stagedUploadRef.current = false
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // CSS cursor value for the live test area: the sprite rendered at 1:1 as
  // a PNG data URL, with the draft hotspot as the cursor's hotspot.
  // (Chromium ignores cursor images over 128px — game cursors are well under.)
  const testCursorCss = useMemo(() => {
    if (!sprite) return 'auto'
    const canvas = document.createElement('canvas')
    renderFrame(canvas, sprite, 0)
    const hx = Math.max(0, Math.min(sprite.width - 1, draft.hotspotPointX))
    const hy = Math.max(0, Math.min(sprite.height - 1, draft.hotspotPointY))
    return `url(${canvas.toDataURL()}) ${hx} ${hy}, auto`
  }, [sprite, draft.hotspotPointX, draft.hotspotPointY])

  // Load the referenced sprite's meta whenever the sprite id changes.
  useEffect(() => {
    if (!data.spritesDir) {
      setSprite(null)
      setSpriteError('No sprites entry found in this cache — preview unavailable.')
      return
    }
    // A staged upload isn't on disk yet — its allocated id has nothing to
    // load, so leave the staged sprite in place.
    if (stagedUploadRef.current) return
    let cancelled = false
    async function load() {
      try {
        const subHandle = await data.spritesDir!.getDirectoryHandle(String(draft.spriteId))
        const fileHandle = await subHandle.getFileHandle(`${draft.spriteId}.json`)
        const file = await fileHandle.getFile()
        const meta = JSON.parse(await file.text()) as SpriteMeta
        if (!cancelled) {
          setSprite(meta)
          setSpriteError(null)
          // Anything freshly read from disk is clean by definition — this
          // also discards a pending upload if the sprite id is changed.
          setIsSpriteDirty(false)
        }
      } catch {
        if (!cancelled) {
          setSprite(null)
          setSpriteError(`Sprite ${draft.spriteId} not found in the sprites entry.`)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [draft.spriteId, data.spritesDir, spriteReloadKey])

  useEffect(() => {
    if (sprite && canvasRef.current) renderFrame(canvasRef.current, sprite, 0)
  }, [sprite])

  function set<K extends keyof CursorDef>(key: K, value: CursorDef[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  // Manually editing the sprite id abandons any staged upload so the
  // disk-load effect fetches the typed id instead.
  function setSpriteId(value: number) {
    stagedUploadRef.current = false
    setIsSpriteDirty(false)
    set('spriteId', value)
  }

  function pixelFromEvent(e: React.MouseEvent<HTMLDivElement>): { x: number; y: number } | null {
    if (!sprite) return null
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(sprite.width - 1, Math.floor((e.clientX - rect.left) / zoom))),
      y: Math.max(0, Math.min(sprite.height - 1, Math.floor((e.clientY - rect.top) / zoom))),
    }
  }

  // While hotspot picking is enabled, clicking the preview moves the
  // hotspot to that pixel and exits picking mode.
  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isPickingHotspot) return
    const pixel = pixelFromEvent(e)
    if (!pixel) return
    setDraft((prev) => ({ ...prev, hotspotPointX: pixel.x, hotspotPointY: pixel.y }))
    setIsDirty(true)
    setIsPickingHotspot(false)
    setHoverPixel(null)
  }

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isPickingHotspot) return
    setHoverPixel(pixelFromEvent(e))
  }

  // RS-style click feedback in the test area: left click = red X,
  // right click = yellow X, each fading out shortly after.
  function spawnClickCross(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const id = crossIdRef.current++
    const color = e.button === 2 ? 'yellow' as const : 'red' as const
    setClickCrosses((prev) => [...prev, { id, x: e.clientX - rect.left, y: e.clientY - rect.top, color }])
    setTimeout(() => {
      setClickCrosses((prev) => prev.filter((c) => c.id !== id))
    }, 450)
  }

  function handleDownload() {
    if (!sprite) return
    const canvas = document.createElement('canvas')
    renderFrame(canvas, sprite, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cursor_${data.id}_sprite_${draft.spriteId}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  function openUpload() {
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  // An upload never overwrites the referenced sprite (other cache entries
  // may share it). It stages a brand-new single-frame sprite under the next
  // free id and repoints the cursor at it; nothing hits disk until Save.
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !data.spritesDir) return
    try {
      const imageData = await imageDataFromFile(file)
      const blankMeta: SpriteMeta = {
        width: 0, height: 0, palette: [0],
        pixelIndices: [[]], alpha: [[]],
        usesAlpha: [false], isVertical: [false],
        offsetsX: [0], offsetsY: [0], subWidths: [0], subHeights: [0],
      }
      const newSprite = applyImageToMeta(imageData, 0, blankMeta)

      let maxId = -1
      for await (const handle of data.spritesDir.values()) {
        if (handle.kind !== 'directory') continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id) && id > maxId) maxId = id
      }
      const newId = maxId + 1

      stagedUploadRef.current = true
      setSprite(newSprite)
      setSpriteError(null)
      setIsSpriteDirty(true)
      set('spriteId', newId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave() {
    // `sprite` is only non-null when the current spriteId resolved from disk
    // (or is a staged upload created on save) — so this covers existence.
    if (!sprite) {
      setSaveError(`Sprite ${draft.spriteId} doesn't exist — pick a valid sprite id before saving.`)
      return
    }
    if (
      draft.hotspotPointX < 0 || draft.hotspotPointX >= sprite.width ||
      draft.hotspotPointY < 0 || draft.hotspotPointY >= sprite.height
    ) {
      setSaveError(`Hotspot (${draft.hotspotPointX}, ${draft.hotspotPointY}) is outside the sprite (${sprite.width} × ${sprite.height}).`)
      return
    }
    setSaveError(null)

    setIsSaving(true)
    let spritePng: Blob | null = null
    if (isSpriteDirty) {
      const canvas = document.createElement('canvas')
      renderFrame(canvas, sprite, 0)
      spritePng = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    }
    await onSave({ ...data, cursor: draft, sprite, spriteDirty: isSpriteDirty, spritePng })
    setIsSaving(false)
    setIsDirty(false)
    setIsSpriteDirty(false)
    stagedUploadRef.current = false
  }

  function handleDiscard() {
    stagedUploadRef.current = false
    setDraft(data.cursor)
    setIsDirty(false)
    setUploadError(null)
    setSaveError(null)
    if (isSpriteDirty) {
      setIsSpriteDirty(false)
      setSpriteReloadKey((k) => k + 1)
    }
  }

  return (
    <div className="cursor-viewer">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="cursor-header">
        <div className="cursor-title">
          <span className="cursor-id">Cursor {data.id}</span>
          {sprite && <span className="cursor-dims">{sprite.width} × {sprite.height}</span>}
        </div>
        <div className="sprite-zoom-row">
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

      <div className="cursor-stats">
        <div className="stat-card">
          <span className="stat-label">Sprite ID</span>
          <NumberInput className="stat-input" value={draft.spriteId} onChange={(v) => setSpriteId(v)} />
          {isSpriteDirty && <span className="cursor-hint">new — created on save</span>}
        </div>
        <div className="stat-card">
          <span className="stat-label">Hotspot X</span>
          <NumberInput className="stat-input" value={draft.hotspotPointX} onChange={(v) => set('hotspotPointX',v)} />
        </div>
        <div className="stat-card">
          <span className="stat-label">Hotspot Y</span>
          <NumberInput className="stat-input" value={draft.hotspotPointY} onChange={(v) => set('hotspotPointY',v)} />
        </div>
      </div>

      {spriteError && <p className="cursor-sprite-error">{spriteError}</p>}
      {uploadError && <p className="cursor-sprite-error">{uploadError}</p>}

      {sprite && (
        <div className="cursor-preview-section">
          <div className="cursor-hotspot-controls">
            <button
              type="button"
              className={`cursor-pick-btn${isPickingHotspot ? ' active' : ''}`}
              onClick={() => setIsPickingHotspot((v) => !v)}
            >
              {isPickingHotspot ? 'Cancel' : 'Set hotspot'}
            </button>
            <button
              type="button"
              className={`cursor-pick-btn${isTestingCursor ? ' active' : ''}`}
              onClick={() => setIsTestingCursor((v) => !v)}
            >
              {isTestingCursor ? 'Hide preview' : 'Preview cursor'}
            </button>
            <button type="button" className="cursor-pick-btn" onClick={openUpload}>
              Upload sprite
            </button>
            <button type="button" className="cursor-pick-btn" onClick={handleDownload}>
              Download
            </button>
            {isPickingHotspot && (
              <span className="cursor-hint">Click the preview to place the hotspot.</span>
            )}
          </div>
          <div
            className={`sprite-canvas cursor-preview${isPickingHotspot ? ' picking' : ''}`}
            style={{ width: sprite.width * zoom, height: sprite.height * zoom }}
            onClick={handleCanvasClick}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={() => setHoverPixel(null)}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: sprite.width * zoom,
                height: sprite.height * zoom,
                imageRendering: 'pixelated',
                display: 'block',
              }}
            />
            <span
              className="cursor-hotspot"
              style={{
                left: (draft.hotspotPointX + 0.5) * zoom,
                top: (draft.hotspotPointY + 0.5) * zoom,
              }}
            />
            {isPickingHotspot && hoverPixel && (
              <span
                className="cursor-hover-pixel"
                style={{
                  left: hoverPixel.x * zoom,
                  top: hoverPixel.y * zoom,
                  width: zoom,
                  height: zoom,
                }}
              />
            )}
          </div>
          {isTestingCursor && (
            <div
              className="cursor-test-area"
              style={{ cursor: testCursorCss }}
              onMouseDown={spawnClickCross}
              onContextMenu={(e) => e.preventDefault()}
            >
              Move your mouse here — this is the cursor with its current sprite and hotspot.
              Left click for a red X, right click for a yellow X.
              {clickCrosses.map((cross) => (
                <span
                  key={cross.id}
                  className={`click-cross ${cross.color}`}
                  style={{ left: cross.x, top: cross.y }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">
            Unsaved changes
            {saveError && <span className="save-bar-error"> — {saveError}</span>}
          </span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
