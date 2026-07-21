import { useEffect, useState } from 'react'
import { useZoom } from './useZoom'
import type { BillboardData, BillboardDef } from '../loaders/billboards'
import { buildBillboardUsage, invalidateBillboardUsage, isBillboardUsageBuilding, peekBillboardUsage } from '../loaders/billboardUsage'
import { NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import './BillboardViewer.css'

type Props = {
  data: BillboardData
  onSave: (data: BillboardData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

const ZOOM_LEVELS = [1, 2, 4]

const GENERAL_FIELDS: NumFieldDef[] = [
  ['materialId', 'Material ID'],
  ['size2d', 'Width (size2d)'],
  ['size3d', 'Height (size3d)'],
]

// Value meanings from darkan-bot-refactor BillboardType.kt / BillboardEffect.kt.
const SHAPE_LABELS: Record<number, string> = {
  0: 'Rectangle',
  1: 'Circle',
  2: 'Brightened rectangle',
}

const BLEND_LABELS: Record<number, string> = {
  0: 'Colour mix',
  1: 'No colour mix',
}

export default function BillboardViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<BillboardDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [zoom, setZoom] = useZoom('cache-editor:billboard-zoom', ZOOM_LEVELS, 2)
  const [materialUrl, setMaterialUrl] = useState<string | null>(null)
  // Used-by-models: session-wide scan of every model binary (billboardUsage.ts),
  // opt-in via button like the BAS/animation compat index.
  const [usageReady, setUsageReady] = useState(peekBillboardUsage() != null)
  const [usageProgress, setUsageProgress] = useState<{ done: number; total: number } | null>(null)

  async function handleUsageScan() {
    if (!data.rootHandle) return
    setUsageProgress({ done: 0, total: 0 })
    try {
      await buildBillboardUsage(data.rootHandle, (done, total) => setUsageProgress({ done, total }))
      setUsageReady(true)
    } finally {
      setUsageProgress(null)
    }
  }

  // A scan started from another billboard page may still be running when this
  // one mounts — attach to it so the section fills in when it lands.
  useEffect(() => {
    if (usageReady || !isBillboardUsageBuilding() || !data.rootHandle) return
    handleUsageScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const shape = draft.shape ?? 2

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Billboard {data.id}</span>
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
        <h3>Preview</h3>
        {materialUrl ? (
          <div className="hit-preview hit-preview-cell">
            <img
              src={materialUrl}
              alt=""
              className={`billboard-preview${shape === 1 ? ' billboard-circle' : ''}${shape === 2 ? ' billboard-brightened' : ''}`}
              style={{ width: (draft.size2d ?? 64) * zoom, height: (draft.size3d ?? 64) * zoom }}
            />
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
        <h3>Used By Models</h3>
        {usageProgress != null ? (
          <p className="map-sprite-none">
            Scanning models… {usageProgress.done.toLocaleString()}{usageProgress.total > 0 ? ` / ${usageProgress.total.toLocaleString()}` : ''}
          </p>
        ) : !usageReady ? (
          <div className="map-sprite-uses-scan">
            <button type="button" className="cursor-pick-btn" disabled={!data.rootHandle} onClick={handleUsageScan}>
              Scan usages
            </button>
            <span className="map-sprite-hint">
              walks every model binary once (~40k footer reads, shared by all billboard pages this session)
            </span>
          </div>
        ) : (() => {
          const usedBy = peekBillboardUsage()!.get(data.id) ?? []
          return (
            <>
              {usedBy.length === 0 ? (
                <p className="map-sprite-none">No models reference this billboard.</p>
              ) : (
                <span className="anim-fit-models billboard-used-by">
                  {usedBy.map((modelId) => (
                    <button
                      key={modelId}
                      type="button"
                      className="field-link-btn"
                      title={`Open model ${modelId}`}
                      onClick={() => onNavigate?.('models', modelId)}
                    >
                      {modelId}
                    </button>
                  ))}
                </span>
              )}
              <div className="map-sprite-uses-scan">
                <button
                  type="button"
                  className="cursor-pick-btn"
                  onClick={() => { invalidateBillboardUsage(); setUsageReady(false); handleUsageScan() }}
                >
                  Rescan
                </button>
                <span className="map-sprite-hint">
                  results are from this session's scan — rescan if models changed on disk (e.g. after a re-dump)
                </span>
              </div>
            </>
          )
        })()}
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Rendering</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Shape</span>
            <select
              className="item-stackable-select"
              value={shape}
              onChange={(e) => set('shape', parseInt(e.target.value, 10))}
            >
              {Object.entries(SHAPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="item-field">
            <span className="item-field-label">Blend Type</span>
            <select
              className="item-stackable-select"
              value={draft.blendType ?? 1}
              onChange={(e) => set('blendType', parseInt(e.target.value, 10))}
            >
              {Object.entries(BLEND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <ToggleGrid
          fields={[['stationary', 'Stationary'], ['hasUid', 'Has UID']]}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => set(k, v)}
        />
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
