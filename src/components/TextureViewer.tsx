import { useEffect, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import type { MaterialDefinition, TextureData, TextureDefinition } from '../loaders/textures'
import { hslToRgb } from '../loaders/models'
import { opName } from '../loaders/textureOps'
import { NumberInput, NumGrid, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import TextureOpsEditor from './TextureOpsEditor'
import { useTexturePreview } from './useTexturePreview'
import './TextureViewer.css'

// The live render, drawn from the evaluated op graph rather than the dumped PNG.
function LivePreview({ image, zoom }: { image: ImageData; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')!.putImageData(image, 0, 0)
  }, [image])

  return (
    <canvas
      ref={ref}
      className="texture-image"
      style={{ width: image.width * zoom, height: image.height * zoom, imageRendering: 'pixelated' }}
    />
  )
}

type Props = {
  data: TextureData
  onSave: (data: TextureData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
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
export default function TextureViewer({ data, onSave, onDirtyChange }: Props) {
  const [zoom, setZoom] = useZoom('cache-editor:texture-zoom', ZOOM_LEVELS, 1)
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [draft, setDraft] = useState<TextureDefinition | null>(data.def)
  const [material, setMaterial] = useState<MaterialDefinition | null>(data.material)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDims(null)
    setDraft(data.def)
    setMaterial(data.material)
    setIsDirty(false)
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

      <section className="item-section">
        <h3 className="tex-op-heading">
          Preview
          {preview.status === 'rendered' && <span className="item-id-badge">live</span>}
          {preview.status !== 'rendered' && url && <span className="item-id-badge">last dump</span>}
        </h3>

        <div className="texture-canvas-wrap">
          {preview.status === 'rendered' ? (
            <LivePreview image={preview.pixels} zoom={zoom} />
          ) : url ? (
            <img
              src={url}
              alt={`Texture ${data.id}`}
              className="texture-image"
              style={dims ? { width: dims.w * zoom, height: dims.h * zoom } : undefined}
              onLoad={(e) => {
                const img = e.currentTarget
                setDims({ w: img.naturalWidth, h: img.naturalHeight })
              }}
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
        </div>
      </section>

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
