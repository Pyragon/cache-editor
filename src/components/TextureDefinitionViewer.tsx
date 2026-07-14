import { useEffect, useState } from 'react'
import type { TextureDefinitionData } from '../loaders/texture_definitions'
import type { TextureDefinition } from '../loaders/textures'
import { hslToRgb } from '../loaders/models'
import { NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'

type Props = {
  data: TextureDefinitionData
  onSave: (data: TextureDefinitionData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

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

export default function TextureDefinitionViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<TextureDefinition>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [materialUrl, setMaterialUrl] = useState<string | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // The definition shares its id with the textures entry — show that material.
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setMaterialUrl(null)
    if (!data.texturesDir) return
    async function load() {
      try {
        const subHandle = await data.texturesDir!.getDirectoryHandle(String(data.id))
        const fileHandle = await subHandle.getFileHandle(`${data.id}.png`)
        const file = await fileHandle.getFile()
        if (cancelled) return
        url = URL.createObjectURL(file)
        setMaterialUrl(url)
      } catch {
        // no rendered material image for this id
      }
    }
    load()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [data.id, data.texturesDir])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const colourHex = `#${hslToRgb(draft.colorHsl ?? 0).toString(16).padStart(6, '0')}`

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Texture Definition {data.id}</span>
        </div>
      </div>

      {materialUrl && (
        <section className="item-section">
          <h3>Material</h3>
          <div className="hit-preview hit-preview-cell">
            <img src={materialUrl} alt="" className="billboard-preview" />
          </div>
        </section>
      )}

      <section className="item-section">
        <h3>Colour</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Colour (HSL16)</span>
            <div className="map-sprite-colour-row">
              <span className="texture-swatch" style={{ background: colourHex }} />
              <input
                className="item-field-input"
                type="number"
                value={Number(draft.colorHsl ?? 0)}
                onChange={(e) => set('colorHsl', parseInt(e.target.value, 10) || 0)}
              />
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

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
