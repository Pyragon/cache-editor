import { useEffect, useRef, useState } from 'react'
import type { HitsplatData, HitsplatDef } from '../loaders/config/hitsplats'
import type { SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, downloadSpritePng, imageDataFromFile, loadSpriteMeta, renderFrame, renderFrameToCanvas } from './spriteRender'
import { writeNewSprite } from '../loaders/spriteStore'
import { NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import './HitbarViewer.css'

type Props = {
  data: HitsplatData
  onSave: (data: HitsplatData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['fontId', 'Font ID'],
  ['cyclesVisible', 'Cycles Visible'],
  ['fadeStartCycle', 'Fade Start Cycle'],
  ['displayType', 'Display Type'],
  ['scrollOffsetX', 'Scroll Offset X'],
  ['scrollOffsetY', 'Scroll Offset Y'],
  ['textOffsetY', 'Text Offset Y'],
]

const SPRITE_FIELDS: NumFieldDef[] = [
  ['leftCapSpriteId', 'Left Cap / Splat'],
  ['innerLeftSpriteId', 'Inner Left'],
  ['middleFillSpriteId', 'Middle Fill'],
  ['rightCapSpriteId', 'Right Cap'],
]

type Sprites = {
  leftCap: SpriteMeta | null
  innerLeft: SpriteMeta | null
  middleFill: SpriteMeta | null
  rightCap: SpriteMeta | null
}

const SPRITE_META_KEY: Record<string, keyof Sprites> = {
  leftCapSpriteId: 'leftCap',
  innerLeftSpriteId: 'innerLeft',
  middleFillSpriteId: 'middleFill',
  rightCapSpriteId: 'rightCap',
}

function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

// Renders a sprite's first frame at the given zoom, or a placeholder.
function SpritePreview({ meta, zoom }: { meta: SpriteMeta | null; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !meta || meta.width <= 0 || meta.height <= 0) return
    renderFrame(canvas, meta, 0)
  }, [meta])

  if (!meta || meta.width <= 0 || meta.height <= 0) {
    return <span className="hit-sprite-preview-empty">none</span>
  }
  return (
    <canvas
      ref={ref}
      className="hit-sprite-preview-canvas"
      style={{ width: meta.width * zoom, height: meta.height * zoom, imageRendering: 'pixelated' }}
    />
  )
}

export default function HitsplatViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<HitsplatDef>(data.hitsplat)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [damage, setDamage] = useState(497)
  const [zoom, setZoom] = useState(1)
  const [sprites, setSprites] = useState<Sprites>({ leftCap: null, innerLeft: null, middleFill: null, rightCap: null })
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingSlotRef = useRef<{ field: string; metaKey: keyof Sprites } | null>(null)

  useEffect(() => {
    setDraft(data.hitsplat)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => {
    if (!data.spritesDir) return
    let cancelled = false
    async function load() {
      const dir = data.spritesDir!
      const [leftCap, innerLeft, middleFill, rightCap] = await Promise.all([
        draft.leftCapSpriteId >= 0 ? loadSpriteMeta(dir, draft.leftCapSpriteId) : null,
        draft.innerLeftSpriteId >= 0 ? loadSpriteMeta(dir, draft.innerLeftSpriteId) : null,
        draft.middleFillSpriteId >= 0 ? loadSpriteMeta(dir, draft.middleFillSpriteId) : null,
        draft.rightCapSpriteId >= 0 ? loadSpriteMeta(dir, draft.rightCapSpriteId) : null,
      ])
      if (!cancelled) setSprites({ leftCap, innerLeft, middleFill, rightCap })
    }
    load()
    return () => { cancelled = true }
  }, [draft.leftCapSpriteId, draft.innerLeftSpriteId, draft.middleFillSpriteId, draft.rightCapSpriteId, data.spritesDir])

  // Compose the splat like the client: legacy splats are a single sprite
  // (left cap only) with the number centered on it; stretchy splats are
  // left cap + inner left + middle fill (tiled behind the text) + right cap.
  // The placement string's %1 slots are replaced with the hit number.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const leftCap = sprites.leftCap ? renderFrameToCanvas(sprites.leftCap) : null
    const innerLeft = sprites.innerLeft ? renderFrameToCanvas(sprites.innerLeft) : null
    const middleFill = sprites.middleFill ? renderFrameToCanvas(sprites.middleFill) : null
    const rightCap = sprites.rightCap ? renderFrameToCanvas(sprites.rightCap) : null
    if (!leftCap && !middleFill) return

    const text = draft.placementExampleString !== ''
      ? draft.placementExampleString.replaceAll('%1', String(damage))
      : String(damage)

    const measure = document.createElement('canvas').getContext('2d')!
    measure.font = 'bold 11px Arial, sans-serif'
    const textWidth = Math.ceil(measure.measureText(text).width)

    let width: number
    let height: number
    let fillStart = 0
    let fillWidth = 0

    if (middleFill) {
      fillWidth = Math.max(textWidth + 4, middleFill.width)
      fillStart = (leftCap?.width ?? 0) + (innerLeft?.width ?? 0)
      width = fillStart + fillWidth + (rightCap?.width ?? 0)
      height = Math.max(leftCap?.height ?? 0, innerLeft?.height ?? 0, middleFill.height, rightCap?.height ?? 0)
    } else {
      width = leftCap!.width
      height = leftCap!.height
    }

    // Ensure the text baseline (textOffsetY + 15) isn't clipped, mirroring
    // the client's clip-region expansion for the number.
    height = Math.max(height, draft.textOffsetY + 17)

    canvas.width = width
    canvas.height = height
    setPreviewSize({ w: width, h: height })

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, width, height)

    if (middleFill) {
      if (leftCap) ctx.drawImage(leftCap, 0, 0)
      if (innerLeft) ctx.drawImage(innerLeft, leftCap?.width ?? 0, 0)
      for (let x = fillStart; x < fillStart + fillWidth; x += middleFill.width) {
        const sliceWidth = Math.min(middleFill.width, fillStart + fillWidth - x)
        ctx.drawImage(middleFill, 0, 0, sliceWidth, middleFill.height, x, 0, sliceWidth, middleFill.height)
      }
      if (rightCap) ctx.drawImage(rightCap, fillStart + fillWidth, 0)
    } else {
      ctx.drawImage(leftCap!, 0, 0)
    }

    const textCenterX = middleFill ? fillStart + fillWidth / 2 : width / 2
    // Client anchors the number's baseline at (sprite top) + textOffsetY + 15
    // — see darkan EntityUpdating: textDrawY = drawY + textOffsetY + 15, then
    // renderPlain(text, x, textDrawY). (drawY is the sprite top = y 0 here.)
    const textBaselineY = draft.textOffsetY + 15
    ctx.font = 'bold 11px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#000'
    ctx.fillText(text, textCenterX + 1, textBaselineY + 1)
    ctx.fillStyle = draft.hasColor ? rgbIntToHex(draft.color) : '#ffffff'
    ctx.fillText(text, textCenterX, textBaselineY)
  }, [sprites, damage, draft.placementExampleString, draft.textOffsetY, draft.color, draft.hasColor])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function openUpload(field: string, metaKey: keyof Sprites) {
    pendingSlotRef.current = { field, metaKey }
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  // Upload never overwrites a shared sprite: it allocates the next free
  // sprite id, writes the new sprite immediately, and points this slot at
  // it. (A brand-new id can't collide with anything already referenced.)
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const slot = pendingSlotRef.current
    if (!file || !slot || !data.spritesDir) return
    try {
      const imageData = await imageDataFromFile(file)
      const blank: SpriteMeta = {
        width: 0, height: 0, palette: [0],
        pixelIndices: [[]], alpha: [[]],
        usesAlpha: [false], isVertical: [false],
        offsetsX: [0], offsetsY: [0], subWidths: [0], subHeights: [0],
      }
      const meta = applyImageToMeta(imageData, 0, blank)

      let maxId = -1
      for await (const handle of data.spritesDir.values()) {
        if (handle.kind !== 'directory') continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id) && id > maxId) maxId = id
      }
      const newId = maxId + 1

      const canvas = document.createElement('canvas')
      renderFrame(canvas, meta, 0)
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      await writeNewSprite(data.spritesDir, newId, meta, png)

      setSprites((prev) => ({ ...prev, [slot.metaKey]: meta }))
      set(slot.field, newId)
      setUploadError(null)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, hitsplat: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const hasPreview = (sprites.leftCap ?? sprites.middleFill) != null

  return (
    <div className="item-viewer">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Hitsplat {data.id}</span>
        </div>
      </div>

      <div className="hit-zoom-bar">
        <span className="hit-zoom-label">Zoom</span>
        <div className="hit-zoom-buttons">
          {[1, 2, 4, 8].map((z) => (
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

      <section className="item-section">
        <h3>Preview</h3>
        {hasPreview ? (
          <div className="hit-preview hit-preview-cell">
            <canvas
              ref={canvasRef}
              className="hit-preview-canvas"
              style={previewSize ? { width: previewSize.w * zoom, height: previewSize.h * zoom } : undefined}
            />
            <div className="hit-preview-controls">
              <span className="item-field-label">Damage</span>
              <input
                className="hit-preview-number"
                type="number"
                min={0}
                value={damage}
                onChange={(e) => setDamage(Math.max(0, parseInt(e.target.value, 10) || 0))}
              />
            </div>
          </div>
        ) : (
          <p className="map-sprite-none">
            {data.spritesDir
              ? 'No splat sprites resolve — set a valid left cap (or middle fill) sprite id to preview.'
              : 'No sprites entry found in this cache — preview unavailable.'}
          </p>
        )}
      </section>

      <section className="item-section">
        <h3>Text</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Colour</span>
            <div className="map-sprite-colour-row">
              <input
                type="color"
                className="map-sprite-colour-input"
                value={rgbIntToHex(draft.color)}
                onChange={(e) => { set('color', parseInt(e.target.value.slice(1), 16) || 0); set('hasColor', true) }}
              />
              <span className="map-sprite-colour-hex">{rgbIntToHex(draft.color)}</span>
            </div>
          </label>
          <label className="item-field def-toggle-field">
            <span className="item-field-label">Has Colour</span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.hasColor)}
                onChange={(e) => set('hasColor', e.target.checked)}
              />
              <span className="sprite-toggle-track" />
            </span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Placement String (%1 = hit)</span>
            <input
              className="item-field-input"
              type="text"
              value={draft.placementExampleString}
              onChange={(e) => set('placementExampleString', e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Sprites</h3>
        {uploadError && <p className="cursor-sprite-error">{uploadError}</p>}
        <div className="hit-sprite-grid">
          {SPRITE_FIELDS.map(([key, label]) => {
            const metaKey = SPRITE_META_KEY[key]
            const meta = sprites[metaKey]
            return (
              <div key={key} className="hit-sprite-cell">
                <span className="item-field-label" title={label}>{label}</span>
                <input
                  className="item-field-input"
                  type="number"
                  value={Number(draft[key as keyof HitsplatDef] ?? -1)}
                  onChange={(e) => set(key, parseInt(e.target.value, 10) || 0)}
                />
                <div className="hit-sprite-preview">
                  <SpritePreview meta={meta} zoom={zoom} />
                </div>
                <button type="button" className="cursor-pick-btn" onClick={() => openUpload(key, metaKey)}>
                  Upload
                </button>
                <button
                  type="button"
                  className="cursor-pick-btn"
                  disabled={!meta || meta.width <= 0}
                  onClick={() => meta && downloadSpritePng(meta, `sprite_${draft[key as keyof HitsplatDef]}.png`)}
                >
                  Download
                </button>
              </div>
            )
          })}
        </div>
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.hitsplat); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
