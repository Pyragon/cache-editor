import { useEffect, useState } from 'react'
import type { SkyboxData, SkyboxDef } from '../loaders/config/skyboxes'
import { IntListInput, NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'

type Props = {
  data: SkyboxData
  onSave: (data: SkyboxData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['materialId', 'Material ID'],
  ['defaultSunIndex', 'Default Sun Index'],
  ['archiveId', 'Archive ID'],
]

// Values from darkan-bot-refactor BackgroundMode.kt.
const BACKGROUND_LABELS: Record<number, string> = {
  0: 'Single colour',
  1: 'Colour transition',
}

export default function SkyboxViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<SkyboxDef>(data.def)
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

  // Load the referenced material PNG (textures/<id>/<id>.png) for the preview.
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setMaterialUrl(null)
    const materialId = draft.materialId ?? -1
    if (!data.texturesDir || materialId < 0) return
    async function load() {
      try {
        const subHandle = await data.texturesDir!.getDirectoryHandle(String(materialId))
        const fileHandle = await subHandle.getFileHandle(`${materialId}.png`)
        const file = await fileHandle.getFile()
        if (cancelled) return
        url = URL.createObjectURL(file)
        setMaterialUrl(url)
      } catch {
        // no material image for this id — preview stays empty
      }
    }
    load()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [draft.materialId, data.texturesDir])

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

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Skybox {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Sky Material</h3>
        {materialUrl ? (
          <div className="hit-preview hit-preview-cell">
            <img src={materialUrl} alt="" className="billboard-preview" style={{ maxWidth: '100%' }} />
          </div>
        ) : (
          <p className="map-sprite-none">
            {data.texturesDir
              ? 'No material image resolves — set a valid material id to preview.'
              : 'No textures entry found in this cache — preview unavailable.'}
          </p>
        )}
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Background Mode</span>
            <select
              className="item-stackable-select"
              value={draft.backgroundMode ?? 0}
              onChange={(e) => set('backgroundMode', parseInt(e.target.value, 10))}
            >
              {Object.entries(BACKGROUND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="item-field">
            <span className="item-field-label">Sun Definition IDs</span>
            <IntListInput
              value={draft.sunDefinitionIds}
              onChange={(v) => set('sunDefinitionIds', v)}
              placeholder="comma-separated sun ids"
            />
          </label>
        </div>
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
