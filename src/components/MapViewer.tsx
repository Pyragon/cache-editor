import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapData } from '../loaders/maps'
import { PLANES, SIZE, tileIndex } from '../loaders/maps'
import { rgbToRenderedHex } from '../loaders/models'
import { NumberInput } from './defFields'
import { useZoom } from './useZoom'
import MapSceneViewer from './MapSceneViewer'
import './MapViewer.css'

const ZOOM_LEVELS = [4, 6, 8, 10, 14]

// cryogen Region.OBJECT_SLOTS — which of the 4 placement slots a location's
// `type` (0-22) occupies: 0 wall, 1 wall decoration, 2 floor (scenery, by
// far the most common), 3 floor decoration (ground-item-like).
const OBJECT_SLOTS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3]
const SLOT_COLORS = ['#ff5a5a', '#ffa64d', '#4d9fff', '#4dd97f']
const SLOT_LABELS = ['Wall', 'Wall Decoration', 'Floor', 'Floor Decoration']

const NO_OVERLAY_COLOR = 0xff00ff

type SelectedTile = { x: number; y: number }

export default function MapViewer({ data, onSave, onDirtyChange }: {
  data: MapData
  onSave: (data: MapData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [terrain, setTerrain] = useState(data.terrain)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [plane, setPlane] = useState(0)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d')
  const [zoom, setZoom] = useZoom('cache-editor:map-zoom', ZOOM_LEVELS, 8)
  const [selected, setSelected] = useState<SelectedTile | null>(null)
  const [hoverObj, setHoverObj] = useState<{ x: number; y: number; text: string } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    setTerrain(data.terrain)
    setIsDirty(false)
    setSelected(null)
    setPlane(0)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const planeObjects = useMemo(
    () => data.def.objects.filter((o) => o[5] === plane),
    [data, plane],
  )

  // --- draw ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const px = zoom
    canvas.width = SIZE * px
    canvas.height = SIZE * px

    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        const idx = tileIndex(plane, x, y)
        const underlayId = terrain.underlayIds[idx]
        const overlayId = terrain.overlayIds[idx]

        let rgb: number | null = null
        if (overlayId > 0) {
          const c = data.overlayColors.get(overlayId)
          if (c != null && c !== NO_OVERLAY_COLOR) rgb = c
        }
        if (rgb == null && underlayId > 0) {
          rgb = data.underlayColors.get(underlayId) ?? null
        }

        ctx.fillStyle = rgb != null ? rgbToRenderedHex(rgb) : '#0c0e14'
        // canvas y grows downward; RS tile y grows north — flip so north is up.
        const drawY = SIZE - 1 - y
        ctx.fillRect(x * px, drawY * px, px, px)

        const flags = terrain.tileFlags[idx]
        if (flags & 0x1) {
          ctx.fillStyle = 'rgba(255, 60, 60, 0.28)'
          ctx.fillRect(x * px, drawY * px, px, px)
        }

        if (selected && selected.x === x && selected.y === y) {
          ctx.strokeStyle = '#7eb8ff'
          ctx.lineWidth = 2
          ctx.strokeRect(x * px + 1, drawY * px + 1, px - 2, px - 2)
        }
      }
    }

    for (const [, type, , ox, oy] of planeObjects) {
      const slot = OBJECT_SLOTS[type] ?? 2
      const drawY = SIZE - 1 - oy
      const cx = ox * px + px / 2
      const cy = drawY * px + px / 2
      ctx.fillStyle = SLOT_COLORS[slot]
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(px * 0.16, 1.5), 0, Math.PI * 2)
      ctx.fill()
    }
  }, [terrain, plane, zoom, selected, planeObjects, data])

  function tileFromEvent(e: React.MouseEvent<HTMLCanvasElement>): SelectedTile {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = zoom
    const cx = Math.floor((e.clientX - rect.left) / px)
    const cy = Math.floor((e.clientY - rect.top) / px)
    return { x: Math.min(Math.max(cx, 0), SIZE - 1), y: SIZE - 1 - Math.min(Math.max(cy, 0), SIZE - 1) }
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    setSelected(tileFromEvent(e))
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = tileFromEvent(e)
    const hit = planeObjects.find((o) => o[3] === x && o[4] === y)
    if (!hit) { setHoverObj(null); return }
    const [id, type, rotation] = hit
    const slot = OBJECT_SLOTS[type] ?? 2
    setHoverObj({
      x: e.clientX, y: e.clientY,
      text: `Object ${id} · type ${type} (${SLOT_LABELS[slot]}) · rotation ${rotation}`,
    })
  }

  function setTileField(field: 'underlayIds' | 'overlayIds' | 'tileFlags', value: number) {
    if (!selected) return
    const idx = tileIndex(plane, selected.x, selected.y)
    const next = { ...terrain, [field]: terrain[field].slice() as Uint8Array }
    next[field][idx] = value & 0xff
    setTerrain(next)
    setIsDirty(true)
  }

  function setShapeRot(which: 'shape' | 'rotation', value: number) {
    if (!selected) return
    const idx = tileIndex(plane, selected.x, selected.y)
    const packed = terrain.overlayShapeRot[idx]
    const shape = which === 'shape' ? value & 0xf : packed >> 2
    const rotation = which === 'rotation' ? value & 0x3 : packed & 0x3
    const next = { ...terrain, overlayShapeRot: terrain.overlayShapeRot.slice() }
    next.overlayShapeRot[idx] = ((shape << 2) | rotation) & 0xff
    setTerrain(next)
    setIsDirty(true)
  }

  function setHeight(present: boolean, value?: number) {
    if (!selected) return
    const idx = tileIndex(plane, selected.x, selected.y)
    const nextPresence = terrain.heightPresence.slice()
    const nextValue = terrain.heightValue.slice()
    if (present) nextPresence[idx >> 3] |= 1 << (idx & 0x7)
    else nextPresence[idx >> 3] &= ~(1 << (idx & 0x7))
    if (value != null) nextValue[idx] = value & 0xff
    setTerrain({ ...terrain, heightPresence: nextPresence, heightValue: nextValue })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, terrain })
    setIsSaving(false)
    setIsDirty(false)
  }

  const worldX = data.def.regionX * 64
  const worldY = data.def.regionY * 64
  const selIdx = selected ? tileIndex(plane, selected.x, selected.y) : -1
  const selPacked = selected ? terrain.overlayShapeRot[selIdx] : 0
  const selHasHeight = selected ? (terrain.heightPresence[selIdx >> 3] & (1 << (selIdx & 0x7))) !== 0 : false

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Region {data.def.regionX}, {data.def.regionY}</span>
          <span className="item-id-badge">world tile {worldX}, {worldY} – {worldX + 63}, {worldY + 63}</span>
          {data.def.hasLocations && <span className="item-id-badge">{data.def.objects.length} objects</span>}
          {!data.def.hasLocations && <span className="item-id-badge">no location key</span>}
        </div>
        <div className="map-mode-toggle">
          <button type="button" className={viewMode === '2d' ? 'selected' : ''} onClick={() => setViewMode('2d')}>2D</button>
          <button type="button" className={viewMode === '3d' ? 'selected' : ''} onClick={() => setViewMode('3d')}>3D</button>
        </div>
      </div>

      {viewMode === '3d' && <MapSceneViewer data={{ ...data, terrain }} />}

      {viewMode === '2d' && <>
      <section className="item-section">
        <p className="tex-op-note">
          Top-down preview: tile colour blends the overlay (paths, water) over the underlay (ground
          base colour), red tint marks blocked tiles, and dots mark placed objects (red wall, orange
          wall decoration, blue scenery, green floor decoration). Click a tile to edit it; object
          placement is read-only in this preview.
        </p>
        <div className="map-controls">
          <div className="hit-zoom-bar">
            <span className="hit-zoom-label">Plane</span>
            <div className="hit-zoom-buttons">
              {Array.from({ length: PLANES }, (_, p) => (
                <button
                  key={p}
                  type="button"
                  className={`zoom-btn${plane === p ? ' active' : ''}`}
                  onClick={() => { setPlane(p); setSelected(null) }}
                >
                  {p}
                </button>
              ))}
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
                  {z}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="map-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="map-canvas"
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverObj(null)}
          />
          {hoverObj && (
            <div className="map-hover-tip" style={{ left: hoverObj.x + 14, top: hoverObj.y + 14 }}>
              {hoverObj.text}
            </div>
          )}
        </div>
      </section>

      {selected && (
        <section className="item-section">
          <h3 className="tex-op-heading">
            Tile {selected.x}, {selected.y}
            <span className="item-id-badge">world {worldX + selected.x}, {worldY + selected.y}, plane {plane}</span>
          </h3>
          <div className="item-grid">
            <label className="item-field">
              <span className="item-field-label">Underlay ID</span>
              <NumberInput value={terrain.underlayIds[selIdx]} onChange={(v) => setTileField('underlayIds', v)} min={0} max={255} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Overlay ID</span>
              <NumberInput value={terrain.overlayIds[selIdx]} onChange={(v) => setTileField('overlayIds', v)} min={0} max={255} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Overlay Shape (0–11)</span>
              <NumberInput value={selPacked >> 2} onChange={(v) => setShapeRot('shape', v)} min={0} max={11} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Overlay Rotation (0–3)</span>
              <NumberInput value={selPacked & 0x3} onChange={(v) => setShapeRot('rotation', v)} min={0} max={3} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Tile Flags</span>
              <NumberInput value={terrain.tileFlags[selIdx]} onChange={(v) => setTileField('tileFlags', v)} min={0} max={255} />
            </label>
            <label className="item-field def-toggle-field">
              <span className="item-field-label">Explicit Height</span>
              <span className="sprite-toggle">
                <input type="checkbox" checked={selHasHeight} onChange={(e) => setHeight(e.target.checked, terrain.heightValue[selIdx])} />
                <span className="sprite-toggle-track" />
              </span>
            </label>
            {selHasHeight && (
              <label className="item-field">
                <span className="item-field-label">Height Value</span>
                <NumberInput value={terrain.heightValue[selIdx]} onChange={(v) => setHeight(true, v)} min={0} max={255} />
              </label>
            )}
          </div>
          <p className="tex-op-note">
            Bit 0x1 of Tile Flags blocks the tile (the red tint above). Height is an explicit
            override — when off, the client derives a smooth default from its terrain noise
            function (the 3D view reproduces it).
          </p>
        </section>
      )}
      </>}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setTerrain(data.terrain); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
