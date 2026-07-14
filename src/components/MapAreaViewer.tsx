import { useEffect, useState } from 'react'
import type { MapAreaData, MapAreaDef, MapAreaRect } from '../loaders/map_areas'
import { NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'

type Props = {
  data: MapAreaData
  onSave: (data: MapAreaData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const GENERAL_FIELDS: NumFieldDef[] = [
  ['bitpackedPlacement', 'Bitpacked Placement'],
  ['defaultZoomLevel', 'Default Zoom Level'],
  ['color', 'Colour'],
]

// Values from cryogen RegionSize (mirrors darkan MapSize).
const MAP_SIZES = ['SIZE_72', 'SIZE_104', 'SIZE_120', 'SIZE_136', 'SIZE_168']

const RECT_COLUMNS: [key: keyof MapAreaRect, label: string][] = [
  ['plane', 'Plane'],
  ['startX', 'Start X'],
  ['startY', 'Start Y'],
  ['endX', 'End X'],
  ['endY', 'End Y'],
  ['mapMinX', 'Map Min X'],
  ['mapMinY', 'Map Min Y'],
  ['mapMaxX', 'Map Max X'],
  ['mapMaxY', 'Map Max Y'],
]

const EMPTY_RECT: MapAreaRect = {
  plane: 0, startX: 0, startY: 0, endX: 0, endY: 0,
  mapMinX: 0, mapMinY: 0, mapMaxX: 0, mapMaxY: 0,
}

export default function MapAreaViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<MapAreaDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setRect(index: number, key: keyof MapAreaRect, value: number) {
    setDraft((prev) => {
      const rects = [...(prev.areaRects ?? [])]
      rects[index] = { ...rects[index], [key]: value }
      return { ...prev, areaRects: rects }
    })
    setIsDirty(true)
  }

  function addRect() {
    setDraft((prev) => ({ ...prev, areaRects: [...(prev.areaRects ?? []), { ...EMPTY_RECT }] }))
    setIsDirty(true)
  }

  function removeRect(index: number) {
    setDraft((prev) => ({ ...prev, areaRects: (prev.areaRects ?? []).filter((_, i) => i !== index) }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const rects = draft.areaRects ?? []

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          <input
            className="quest-name-input"
            value={draft.areaName ?? ''}
            onChange={(e) => set('areaName', e.target.value)}
          />
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>General</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Filename Prefix</span>
            <input
              className="item-field-input"
              type="text"
              value={draft.filenamePrefix ?? ''}
              onChange={(e) => set('filenamePrefix', e.target.value)}
            />
          </label>
          <label className="item-field">
            <span className="item-field-label">Map Size</span>
            <select
              className="item-stackable-select"
              value={draft.mapSize ?? 'SIZE_104'}
              onChange={(e) => set('mapSize', e.target.value)}
            >
              {MAP_SIZES.map((size) => (
                <option key={size} value={size}>{size.replace('SIZE_', '')} tiles</option>
              ))}
            </select>
          </label>
          <label className="item-field def-toggle-field">
            <span className="item-field-label">Should Render</span>
            <span className="sprite-toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.shouldRender)}
                onChange={(e) => set('shouldRender', e.target.checked)}
              />
              <span className="sprite-toggle-track" />
            </span>
          </label>
        </div>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Map Bounds (derived from the rects below, saved with the file)</h3>
        <p className="map-sprite-none">
          {rects.length === 0
            ? 'No rects — bounds are undefined.'
            : `X ${Math.min(...rects.map((r) => r.mapMinX))} – ${Math.max(...rects.map((r) => r.mapMaxX))}, ` +
              `Y ${Math.min(...rects.map((r) => r.mapMinY))} – ${Math.max(...rects.map((r) => r.mapMaxY))}`}
        </p>
      </section>

      <section className="item-section">
        <h3>Area Rects</h3>
        {rects.length > 0 && (
          <div className="quest-table-wrap item-params-wrap map-area-rects">
            <table className="quest-table">
              <thead>
                <tr>
                  {RECT_COLUMNS.map(([, label]) => <th key={label}>{label}</th>)}
                  <th>Remove</th>
                </tr>
              </thead>
              <tbody>
                {rects.map((rect, i) => (
                  <tr key={i}>
                    {RECT_COLUMNS.map(([key]) => (
                      <td key={key}>
                        <input
                          className="cell-input"
                          type="number"
                          value={Number(rect[key] ?? 0)}
                          onChange={(e) => setRect(i, key, parseInt(e.target.value, 10) || 0)}
                        />
                      </td>
                    ))}
                    <td><button type="button" className="row-remove-btn" onClick={() => removeRect(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={addRect}>+ Add rect</button>
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
