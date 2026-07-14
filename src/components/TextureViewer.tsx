import { useEffect, useState } from 'react'
import type { TextureData, TextureDefinition } from '../loaders/textures'
import { hslToRgb } from '../loaders/models'
import { NumberInput, NumGrid, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import './TextureViewer.css'

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
  const [zoom, setZoom] = useState(2)
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [draft, setDraft] = useState<TextureDefinition | null>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setZoom(2)
    setDims(null)
    setDraft(data.def)
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
    if (!draft) return
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

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

      <section className="item-section">
        <div className="texture-zoom-row">
          <span className="texture-zoom-label">Zoom</span>
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
          <button type="button" className="replace-btn" disabled={!url} onClick={handleDownload}>
            Download
          </button>
        </div>

        <div className="texture-canvas-wrap">
          {url ? (
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

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes — saves to texture_definitions/{data.id}.json</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
