import { useEffect, useMemo, useRef, useState } from 'react'
import type { HitbarData, HitbarDef } from '../loaders/config/hitbars'
import type { SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, averageSpriteColor, downloadSpritePng, imageDataFromFile, loadSpriteMeta, renderFrame, renderFrameToCanvas } from './spriteRender'
import { nextFreeSpriteId } from '../loaders/spriteStore'
import type { PendingSprites } from '../loaders/spriteStore'
import { NumberInput, NumGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import './HitbarViewer.css'

type Props = {
  data: HitbarData
  onSave: (data: HitbarData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['hitbarAlpha', 'Alpha'],
  ['priority', 'Priority'],
  ['fadeStartOffset', 'Fade Start Offset'],
  ['fadeOutDuration', 'Fade Out Duration'],
  ['animationStepSize', 'Animation Step'],
]

const SPRITE_FIELDS: NumFieldDef[] = [
  ['greenBarSpriteId', 'Green Bar Sprite'],
  ['redBarSpriteId', 'Red Bar Sprite'],
  ['pGreenBarSpriteId', 'P Green Bar Sprite'],
  ['pRedBarSpriteId', 'P Red Bar Sprite'],
]

type Sprites = {
  green: SpriteMeta | null
  red: SpriteMeta | null
  pGreen: SpriteMeta | null
  pRed: SpriteMeta | null
}

const SPRITE_META_KEY: Record<string, keyof Sprites> = {
  greenBarSpriteId: 'green',
  redBarSpriteId: 'red',
  pGreenBarSpriteId: 'pGreen',
  pRedBarSpriteId: 'pRed',
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

export default function HitbarViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<HitbarDef>(data.hitbar)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [percent, setPercent] = useState(75)
  const [zoom, setZoom] = useState(1)
  const [sprites, setSprites] = useState<Sprites>({ green: null, red: null, pGreen: null, pRed: null })
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingSprites, setPendingSprites] = useState<PendingSprites>({})

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingSlotRef = useRef<{ field: string; metaKey: keyof Sprites } | null>(null)

  useEffect(() => {
    setDraft(data.hitbar)
    setPendingSprites({})
    setUploadError(null)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Load the referenced bar sprites whenever the ids change.
  useEffect(() => {
    if (!data.spritesDir) return
    let cancelled = false
    async function load() {
      const dir = data.spritesDir!
      const [green, red, pGreen, pRed] = await Promise.all([
        draft.greenBarSpriteId >= 0 ? loadSpriteMeta(dir, draft.greenBarSpriteId) : null,
        draft.redBarSpriteId >= 0 ? loadSpriteMeta(dir, draft.redBarSpriteId) : null,
        draft.pGreenBarSpriteId >= 0 ? loadSpriteMeta(dir, draft.pGreenBarSpriteId) : null,
        draft.pRedBarSpriteId >= 0 ? loadSpriteMeta(dir, draft.pRedBarSpriteId) : null,
      ])
      if (!cancelled) setSprites({ green, red, pGreen, pRed })
    }
    load()
    return () => { cancelled = true }
  }, [draft.greenBarSpriteId, draft.redBarSpriteId, draft.pGreenBarSpriteId, draft.pRedBarSpriteId, data.spritesDir])

  // Render each bar sprite to an offscreen canvas ONCE (only when the sprite
  // itself changes). Dragging the health slider must not re-decode sprites.
  const greenCanvas = useMemo(() => (sprites.green ? renderFrameToCanvas(sprites.green) : null), [sprites.green])
  const redCanvas = useMemo(() => (sprites.red ? renderFrameToCanvas(sprites.red) : null), [sprites.red])

  // The slider's fill colours are sampled from the actual bar sprites, since a
  // sprite's colour may not match its name (e.g. hitbar 2's "green" bar is
  // cyan). Falls back to conventional green/red when a sprite is missing.
  const greenColor = useMemo(() => (sprites.green ? averageSpriteColor(sprites.green) : null), [sprites.green])
  const redColor = useMemo(() => (sprites.red ? averageSpriteColor(sprites.red) : null), [sprites.red])

  // Composite the preview: red bar as the depleted background, green bar
  // clipped to the health percentage on top — mirroring the client, which
  // draws the green sprite's leftmost health-fraction over the red sprite.
  // Per-frame this is only a clear + two drawImage calls (cheap); the main
  // canvas is resized (and previewSize state updated) solely when the sprite
  // dimensions change, so dragging the slider never reallocates the canvas
  // backing store or rebuilds pixel data — that was the source of the lag.
  //
  // Note: hitbarType.hitbarAlpha is NOT a render opacity — the client only
  // uses it to prioritise which queued hitbar wins (PathingEntity.kt), and the
  // draw alpha starts at 255 (reduced only by the fade-out animation). So the
  // preview always draws the bars fully opaque.
  useEffect(() => {
    const canvas = canvasRef.current
    const base = redCanvas ?? greenCanvas
    if (!canvas || !base) return

    if (canvas.width !== base.width || canvas.height !== base.height) {
      canvas.width = base.width
      canvas.height = base.height
      setPreviewSize({ w: base.width, h: base.height })
    }

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (redCanvas) ctx.drawImage(redCanvas, 0, 0)
    if (greenCanvas) {
      const greenWidth = Math.round(greenCanvas.width * (percent / 100))
      if (greenWidth > 0) {
        ctx.drawImage(greenCanvas, 0, 0, greenWidth, greenCanvas.height, 0, 0, greenWidth, greenCanvas.height)
      }
    }
  }, [greenCanvas, redCanvas, percent])

  function set(key: string, value: number) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function openUpload(field: string, metaKey: keyof Sprites) {
    pendingSlotRef.current = { field, metaKey }
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  // Upload never overwrites a shared sprite: it allocates a fresh sprite id
  // and points this slot at it. The sprite is only *staged* here — saveItem
  // writes it — so Discard drops it without leaving an orphan on disk.
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

      // Reserve an id past anything already staged this session, so two
      // uploads before a save can't land on the same id.
      const staged = Object.values(pendingSprites).map((p) => p.id)
      const newId = await nextFreeSpriteId(data.spritesDir, staged)

      const canvas = document.createElement('canvas')
      renderFrame(canvas, meta, 0)
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

      // Staged only — saveItem writes it, so Discard leaves no orphan behind.
      setPendingSprites((prev) => ({ ...prev, [slot.field]: { id: newId, meta, png } }))
      setSprites((prev) => ({ ...prev, [slot.metaKey]: meta }))
      set(slot.field, newId)
      setUploadError(null)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, hitbar: draft, pendingSprites })
    setPendingSprites({})
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDraft(data.hitbar)
    setPendingSprites({})
    setUploadError(null)
    setIsDirty(false)
  }

  const hasPreview = (sprites.green ?? sprites.red) != null

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
          <span className="enum-title">Hitbar {data.id}</span>
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
            <div className="hit-preview-controls hit-slider-controls">
              <div
                className="health-slider-wrap"
                style={{
                  '--frac': percent / 100,
                  '--bar-green': greenColor ?? '#46d15e',
                  '--bar-red': redColor ?? '#e23b32',
                } as React.CSSProperties}
              >
                <div className="health-slider-bubble">{percent}%</div>
                <input
                  className="hit-health-slider"
                  type="range" min={0} max={100} value={percent}
                  onChange={(e) => setPercent(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="map-sprite-none">
            {data.spritesDir
              ? 'No bar sprites resolve — set valid green/red sprite ids to preview.'
              : 'No sprites entry found in this cache — preview unavailable.'}
          </p>
        )}
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={set} />
      </section>

      <section className="item-section">
        <h3>Sprites</h3>
        {uploadError && <p className="cursor-sprite-error">{uploadError}</p>}
        <div className="hit-sprite-grid hit-sprite-grid-wide">
          {SPRITE_FIELDS.map(([key, label]) => {
            const metaKey = SPRITE_META_KEY[key]
            const meta = sprites[metaKey]
            return (
              <div key={key} className="hit-sprite-cell">
                <span className="item-field-label" title={label}>{label}</span>
                <NumberInput className="item-field-input" value={Number(draft[key as keyof HitbarDef] ?? -1)} onChange={(v) => set(key,v)} />
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
                  onClick={() => meta && downloadSpritePng(meta, `sprite_${draft[key as keyof HitbarDef]}.png`)}
                >
                  Download
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <details className="item-unknown">
        <summary>Unused fields</summary>
        <NumGrid
          fields={[['unused', 'unused (opcode 1)'], ['unused2', 'unused2 (opcode 6)']]}
          values={draft as unknown as Record<string, unknown>}
          onChange={set}
        />
      </details>

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
