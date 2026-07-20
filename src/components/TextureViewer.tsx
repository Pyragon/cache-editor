import { useEffect, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import { writeMaterial, writeTextureDef, writeTexturePng } from '../loaders/textures'
import type { MaterialDefinition, TextureData, TextureDefinition } from '../loaders/textures'
import { hslToRgb } from '../loaders/models'
import type { SpriteMeta } from '../loaders/sprites'
import { nextFreeSpriteId, writeNewSprite } from '../loaders/spriteStore'
import { opName } from '../loaders/textureOps'
import { NumberInput, NumGrid, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import TextureOpsEditor from './TextureOpsEditor'
import { useTexturePreview } from './useTexturePreview'
import { applyImageToMeta, imageDataFromFile } from './spriteRender'
import { averageImageColor, quantizeImage } from './quantize'
import { rgbToHsl16 } from './rsColor'
import './TextureViewer.css'

// The preview surface, shared by the live op-graph render (ImageData) and the
// dumped-PNG fallback (Blob). Materials with a UV scroll (the fire cape's lava)
// slide with the client's formula — offset = seconds * speed / 64, speeds in 64ths
// of a repeat per second — and the speeds come from the DRAFT, so editing
// Speed U/V animates the preview immediately.
function TexturePreviewSurface({ source, zoom, speedU, speedV, onDims }: {
  source: ImageData | Blob
  zoom: number
  speedU: number
  speedV: number
  onDims?: (w: number, h: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tile, setTile] = useState<HTMLCanvasElement | ImageBitmap | null>(null)

  useEffect(() => {
    let cancelled = false
    if (source instanceof Blob) {
      createImageBitmap(source).then((bitmap) => {
        if (cancelled) { bitmap.close(); return }
        setTile(bitmap)
        onDims?.(bitmap.width, bitmap.height)
      }).catch(() => setTile(null))
      return () => { cancelled = true }
    }
    const offscreen = document.createElement('canvas')
    offscreen.width = source.width
    offscreen.height = source.height
    offscreen.getContext('2d')!.putImageData(source, 0, 0)
    setTile(offscreen)
    onDims?.(source.width, source.height)
    // onDims deliberately excluded: it's only a dims reporter, and depending on its
    // identity would rebuild the tile every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !tile) return
    const w = tile.width
    const h = tile.height
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!

    // Sampling at uv + offset shifts the visible content by -offset, so the draw
    // position is negated — same direction as the model viewer's texture.offset.
    function draw(now: number) {
      const seconds = (now % 128000) / 1000
      const sx = -Math.round((((((seconds * speedU) / 64) % 1) + 1) % 1) * w) % w
      const sy = -Math.round((((((seconds * speedV) / 64) % 1) + 1) % 1) * h) % h
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(tile!, sx, sy)
      if (sx !== 0) ctx.drawImage(tile!, sx + w, sy)
      if (sy !== 0) ctx.drawImage(tile!, sx, sy + h)
      if (sx !== 0 && sy !== 0) ctx.drawImage(tile!, sx + w, sy + h)
    }

    if (speedU === 0 && speedV === 0) {
      draw(0)
      return
    }

    let raf = 0
    function loop(now: number) {
      draw(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tile, speedU, speedV])

  if (!tile) return null
  return (
    <canvas
      ref={canvasRef}
      className="texture-image"
      style={{ width: tile.width * zoom, height: tile.height * zoom, imageRendering: 'pixelated' }}
    />
  )
}

// A quantized upload waiting for the user to confirm creation. Ids are
// allocated at stage time so the panel can say exactly what it will write.
type StagedImage = {
  image: ImageData
  fileName: string
  originalCount: number
  colorCount: number
  textureId: number
  spriteId: number
}

function StagedImageCanvas({ image }: { image: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')!.putImageData(image, 0, 0)
  }, [image])
  return (
    <canvas
      ref={ref}
      className="texture-image"
      style={{ imageRendering: 'pixelated', maxWidth: '100%' }}
    />
  )
}

type Props = {
  data: TextureData
  onSave: (data: TextureData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Called with the new texture id after "New from image" writes its files. */
  onCreated?: (id: number) => void
}

const ZOOM_LEVELS = [1, 2, 4, 8]

const NUM_FIELDS: NumFieldDef[] = [
  ['brightness', 'Brightness'],
  ['alpha', 'Alpha'],
  ['effectId', 'Effect ID'],
  ['effectParam1', 'Effect Param 1'],
  ['effectParam2', 'Effect Param 2'],
  ['textureSpeedU', 'Speed U'],
  ['textureSpeedV', 'Speed V'],
  ['mipmapping', 'Mipmapping'],
  ['combineMode', 'Combine Mode'],
  ['effectCombiner', 'Effect Combiner'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['detailsOnly', 'Details Only'],
  ['isHalfSize', 'Half Size'],
  ['skipTriangles', 'Skip Triangles'],
  ['isBrickTile', 'Brick Tile'],
  ['repeatS', 'Repeat S'],
  ['repeatT', 'Repeat T'],
  ['hdr', 'HDR'],
  ['aBool2087', 'aBool2087 (?)'],
]

// Merged view of a material: the rendered PNG (the `textures` entry) and the
// definition fields that produce it (`texture_definitions`). Both entries open
// this; edits always save to texture_definitions/<id>.json.
export default function TextureViewer({ data, onSave, onDirtyChange, onCreated }: Props) {
  const [zoom, setZoom] = useZoom('cache-editor:texture-zoom', ZOOM_LEVELS, 1)
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [draft, setDraft] = useState<TextureDefinition | null>(data.def)
  const [material, setMaterial] = useState<MaterialDefinition | null>(data.material)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [staged, setStaged] = useState<StagedImage | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDims(null)
    setDraft(data.def)
    setMaterial(data.material)
    setIsDirty(false)
    setStaged(null)
    setUploadError(null)
    if (!data.png) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(data.png)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft, material })
    setIsSaving(false)
    setIsDirty(false)
  }

  function updateMaterial(next: MaterialDefinition) {
    setMaterial(next)
    setIsDirty(true)
  }

  // Renders the DRAFT graph, so the preview tracks edits before they're saved.
  const preview = useTexturePreview(material, draft, data.texturesDir, data.defsDir, data.spritesDir ?? null)

  function handleDownload() {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `texture_${data.id}.png`
    a.click()
  }

  function openUpload() {
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  // Stages an uploaded image as a brand-new texture: quantized to the sprite
  // palette limit and previewed with its allocated ids. The image is read as
  // pixel data only; nothing hits disk until the user clicks Create.
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)
    try {
      if (!data.texturesDir || !data.defsDir || !data.spritesDir) {
        throw new Error('Creating a texture needs the textures, texture_definitions and sprites folders in this dump.')
      }
      const raw = await imageDataFromFile(file)
      const { image, colorCount, originalCount } = quantizeImage(raw, 255)

      const spriteId = await nextFreeSpriteId(data.spritesDir)
      // The two texture folders share one id space, so the new id must clear both.
      let maxId = -1
      for await (const handle of data.texturesDir.values()) {
        if (handle.kind !== 'directory') continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id) && id > maxId) maxId = id
      }
      for await (const handle of data.defsDir.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id) && id > maxId) maxId = id
      }

      setStaged({ image, fileName: file.name, originalCount, colorCount, textureId: maxId + 1, spriteId })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  // Writes the three halves of a sprite-backed material — the sprite, the
  // 3-node op graph sampling it (the same shape the cache uses for its own
  // image-based materials, e.g. texture 1190), and the definition flags.
  async function handleCreate() {
    if (!staged || !data.texturesDir || !data.defsDir || !data.spritesDir) return
    setIsCreating(true)
    setUploadError(null)
    try {
      const { image, textureId, spriteId } = staged

      const blankMeta: SpriteMeta = {
        width: 0, height: 0, palette: [0],
        pixelIndices: [[]], alpha: [[]],
        usesAlpha: [false], isVertical: [false],
        offsetsX: [0], offsetsY: [0], subWidths: [0], subHeights: [0],
      }
      const meta = applyImageToMeta(image, 0, blankMeta)

      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
      )

      await writeNewSprite(data.spritesDir, spriteId, meta, png)

      await writeMaterial(data.texturesDir, {
        id: textureId,
        textureOperations: [
          { fillValue: 4096, type: 0, monochrome: true, imageCacheCapacity: 1 },
          { fillValue: 0, type: 0, monochrome: true, imageCacheCapacity: 1 },
          { spriteId, type: 39, monochrome: false, imageCacheCapacity: 1 },
        ],
        operationIndices: [[], [], []],
        opaqueOperationIndex: 2,
        opacityOperationIndex: 0,
        hdrOperationIndex: 1,
      })
      await writeTexturePng(data.texturesDir, textureId, png)

      const avg = averageImageColor(image)
      await writeTextureDef(data.defsDir, {
        id: textureId,
        detailsOnly: true,
        isHalfSize: Math.max(image.width, image.height) <= 64,
        skipTriangles: false,
        brightness: 0,
        alpha: -1,
        effectId: 0,
        effectParam1: 0,
        colorHsl: avg ? rgbToHsl16(avg.r, avg.g, avg.b) : 0,
        textureSpeedU: 0,
        textureSpeedV: 0,
        aBool2087: false,
        isBrickTile: false,
        mipmapping: 2,
        repeatS: true,
        repeatT: true,
        hdr: false,
        combineMode: 0,
        effectParam2: 0,
        effectCombiner: 0,
      })

      setStaged(null)
      onCreated?.(textureId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCreating(false)
    }
  }

  const colourHex = `#${hslToRgb(draft?.colorHsl ?? 0).toString(16).padStart(6, '0')}`

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Texture {data.id}</span>
          {dims && <span className="item-id-badge">{dims.w} × {dims.h}</span>}
        </div>
      </div>

      <div className="hit-zoom-bar">
        <span className="hit-zoom-label">Zoom</span>
        <div className="hit-zoom-buttons">
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

      <section className="item-section">
        <h3 className="tex-op-heading">
          Preview
          {preview.status === 'rendered' && <span className="item-id-badge">live</span>}
          {preview.status !== 'rendered' && url && <span className="item-id-badge">last dump</span>}
        </h3>

        <div className="texture-canvas-wrap">
          {preview.status === 'rendered' ? (
            <TexturePreviewSurface
              source={preview.pixels}
              zoom={zoom}
              speedU={draft?.textureSpeedU ?? 0}
              speedV={draft?.textureSpeedV ?? 0}
              onDims={(w, h) => setDims({ w, h })}
            />
          ) : data.png ? (
            <TexturePreviewSurface
              source={data.png}
              zoom={zoom}
              speedU={draft?.textureSpeedU ?? 0}
              speedV={draft?.textureSpeedV ?? 0}
              onDims={(w, h) => setDims({ w, h })}
            />
          ) : (
            <p className="map-sprite-none">No rendered material image for this id.</p>
          )}
        </div>

        {preview.status === 'unsupported' && (
          <p className="tex-op-note">
            Showing the last dumped render — this material uses{' '}
            {preview.ops.map((t) => `${opName(t)} (type ${t})`).join(', ')}, which the live renderer
            doesn't evaluate yet.
          </p>
        )}
        {preview.status === 'error' && (
          <p className="tex-op-note">Live render unavailable: {preview.message}</p>
        )}

        <div className="texture-actions">
          <button type="button" className="replace-btn" disabled={!url} onClick={handleDownload}>
            Download
          </button>
          <button type="button" className="replace-btn" onClick={openUpload}>
            New from image…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
        {uploadError && !staged && <p className="upload-error">{uploadError}</p>}
      </section>

      {staged && (
        <section className="item-section">
          <h3 className="tex-op-heading">
            New texture from image
            <span className="item-id-badge">texture {staged.textureId}</span>
          </h3>
          <div className="texture-canvas-wrap">
            <StagedImageCanvas image={staged.image} />
          </div>
          <p className="tex-op-note">
            {staged.fileName} — {staged.image.width} × {staged.image.height},{' '}
            {staged.originalCount > staged.colorCount
              ? `${staged.originalCount} colours reduced to ${staged.colorCount} to fit the sprite palette (max 255).`
              : `${staged.colorCount} colours — fits the sprite palette as-is.`}
          </p>
          <p className="tex-op-note">
            Create writes new sprite {staged.spriteId} and a 3-node material at texture {staged.textureId} that
            samples it — the same shape the cache uses for its own image-based materials. In-game, materials
            render at 128 × 128 (64 × 64 with Half Size, set automatically for images 64px and under), so other
            sizes are resampled. The image is read as pixel data only; nothing is written until you click Create.
          </p>
          {uploadError && <p className="upload-error">{uploadError}</p>}
          <div className="texture-actions">
            <button type="button" className="replace-btn" onClick={() => setStaged(null)} disabled={isCreating}>
              Cancel
            </button>
            <button type="button" className="save-bar-save" onClick={handleCreate} disabled={isCreating}>
              {isCreating ? 'Creating…' : `Create texture ${staged.textureId}`}
            </button>
          </div>
        </section>
      )}

      {draft ? (
        <>
          <section className="item-section">
            <h3>Colour</h3>
            <div className="item-grid">
              <label className="item-field">
                <span className="item-field-label">Colour (HSL16)</span>
                <div className="map-sprite-colour-row">
                  <span className="texture-swatch" style={{ background: colourHex }} />
                  <NumberInput className="item-field-input" value={Number(draft.colorHsl ?? 0)} onChange={(v) => set('colorHsl',v)} />
                </div>
              </label>
            </div>
          </section>

          <section className="item-section">
            <h3>General</h3>
            <NumGrid fields={NUM_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
          </section>

          <section className="item-section">
            <h3>Flags</h3>
            <ToggleGrid fields={FLAG_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
          </section>
        </>
      ) : (
        <section className="item-section">
          <p className="map-sprite-none">
            No definition found for this id in texture_definitions — nothing to edit.
          </p>
        </section>
      )}

      <section className="item-section">
        <h3 className="tex-op-heading">
          Operations
          {material && <span className="item-id-badge">{material.textureOperations?.length ?? 0} nodes</span>}
        </h3>
        <p className="tex-op-note tex-op-intro">
          A material isn't a stored image — it's a small program the client runs per pixel. Each node
          takes its inputs from other nodes, and the three outputs below pick which nodes produce the
          colour, opacity and HDR channels.
        </p>
        {material ? (
          <TextureOpsEditor material={material} onChange={updateMaterial} />
        ) : (
          <p className="map-sprite-none">
            No op graph found at textures/{data.id}/{data.id}.json — re-dump the textures index to edit it.
          </p>
        )}
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">
            Unsaved changes — saves to texture_definitions/{data.id}.json and textures/{data.id}/{data.id}.json
          </span>
          <button
            type="button"
            className="save-bar-discard"
            onClick={() => { setDraft(data.def); setMaterial(data.material); setIsDirty(false) }}
          >
            Discard
          </button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
