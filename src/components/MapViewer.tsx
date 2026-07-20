import { useEffect, useMemo, useRef, useState } from 'react'
import type { LocEntry, MapData, WorldMapData } from '../loaders/maps'
import { PLANES, SIZE, tileIndex, loadRegion, saveRegion, createRegionDef, OBJECT_SLOTS, SLOT_COLORS, SLOT_LABELS } from '../loaders/maps'
import { rgbToRenderedHex } from '../loaders/models'
import { NumberInput } from './defFields'
import { useZoom } from './useZoom'
import { useConfirm } from './useConfirm'
import MapSceneViewer from './MapSceneViewer'
import './MapViewer.css'

const ZOOM_LEVELS = [4, 6, 8, 10, 14]

const NO_OVERLAY_COLOR = 0xff00ff

const HOME = { x: 3333, y: 3333, plane: 0 }

type SelectedTile = { x: number; y: number }
type WorldCoords = { x: number; y: number; plane: number }

const regionIdOf = (c: WorldCoords) => ((c.x >> 6) << 8) | (c.y >> 6)

// The maps entry's single world viewer: no per-region item list — it owns the
// current position, loads the region containing it (the 3D view adds the 8
// neighbours itself), and saves edits back to that region's own file.
export default function MapViewer({ world, onDirtyChange }: {
  world: WorldMapData
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [coords, setCoords] = useState<WorldCoords>(HOME)
  const [data, setData] = useState<MapData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [terrain, setTerrain] = useState<MapData['terrain'] | null>(null)
  // draft of the region's placed objects — edited from the 3D side panel
  const [objects, setObjects] = useState<LocEntry[] | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [plane, setPlane] = useState(0)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('3d')
  const [zoom, setZoom] = useZoom('cache-editor:map-zoom', ZOOM_LEVELS, 8)
  const [selected, setSelected] = useState<SelectedTile | null>(null)
  const [hoverObj, setHoverObj] = useState<{ x: number; y: number; text: string } | null>(null)
  const [search, setSearch] = useState('')
  const [searchMsg, setSearchMsg] = useState('')
  // searched coords landed in a region that isn't in the cache — offer to
  // create it (optionally pre-filled with a flat ground slab)
  const [pendingCreate, setPendingCreate] = useState<{ rx: number; ry: number; target: WorldCoords } | null>(null)
  const [createFill, setCreateFill] = useState(true)
  const [createUnderlay, setCreateUnderlay] = useState(1)
  // world-grid region picker: shows every existing region, click to visit or
  // click a free cell to start creating there
  const [pickerOpen, setPickerOpen] = useState(false)
  const [usedRegions, setUsedRegions] = useState<Set<number> | null>(null)
  const [pickerHover, setPickerHover] = useState<{ rx: number; ry: number; used: boolean } | null>(null)
  const pickerCanvasRef = useRef<HTMLCanvasElement>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { confirm: confirmDialog, dialog: confirmDialogElement } = useConfirm()

  const regionId = regionIdOf(coords)

  // load the region containing the current coords (teleports validate the
  // target exists before moving, so failures here mean the initial region)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadError('')
      try {
        const next = await loadRegion(world.mapsDir, world.rootHandle, regionId)
        if (!cancelled) setData(next)
      } catch {
        if (!cancelled) setLoadError(`region ${regionId >> 8}, ${regionId & 0xff} isn't in the cache`)
      }
    })()
    return () => { cancelled = true }
  }, [world, regionId])

  // last-saved state, for Discard — kept out of `data` so saving doesn't
  // change the scene viewer's data prop (which would force a full rebuild)
  const baselineRef = useRef<{ terrain: MapData['terrain']; objects: LocEntry[] } | null>(null)
  // per-step undo/redo over the drafts. Snapshots are references (every edit
  // path copies the arrays it changes), so pushing them is free.
  const historyRef = useRef<{
    past: { terrain: MapData['terrain']; objects: LocEntry[] }[]
    future: { terrain: MapData['terrain']; objects: LocEntry[] }[]
  }>({ past: [], future: [] })

  useEffect(() => {
    if (!data) return
    baselineRef.current = { terrain: data.terrain, objects: data.def.objects }
    historyRef.current = { past: [], future: [] }
    setTerrain(data.terrain)
    setObjects(data.def.objects)
    setIsDirty(false)
    setSelected(null)
    setPlane(0)
  }, [data])

  // Single entry point for every 3D-view edit (brush strokes, loc edits,
  // placements, stamps). `coalesce` folds drag-stroke steps into one undo.
  function applyEdit(patch: { terrain?: MapData['terrain']; objects?: LocEntry[]; coalesce?: boolean }) {
    if (!terrain || !objects) return
    if (!patch.coalesce) {
      historyRef.current.past.push({ terrain, objects })
      if (historyRef.current.past.length > 60) historyRef.current.past.shift()
      historyRef.current.future = []
    }
    if (patch.terrain) setTerrain(patch.terrain)
    if (patch.objects) setObjects(patch.objects)
    setIsDirty(true)
  }
  const applyEditRef = useRef(applyEdit)
  applyEditRef.current = applyEdit

  const undoRef = useRef(() => {})
  undoRef.current = () => {
    const prev = historyRef.current.past.pop()
    if (!prev || !terrain || !objects) return
    historyRef.current.future.push({ terrain, objects })
    setTerrain(prev.terrain)
    setObjects(prev.objects)
    setIsDirty(true)
  }
  const redoRef = useRef(() => {})
  redoRef.current = () => {
    const next = historyRef.current.future.pop()
    if (!next || !terrain || !objects) return
    historyRef.current.past.push({ terrain, objects })
    setTerrain(next.terrain)
    setObjects(next.objects)
    setIsDirty(true)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redoRef.current()
        else undoRef.current()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Apply the current position once its region is on screen: switch to its
  // plane and select the tile. The coords object itself is the consumption
  // token — a save (new data, same coords) doesn't steal the selection back.
  const appliedFocusRef = useRef<WorldCoords | null>(null)
  useEffect(() => {
    if (appliedFocusRef.current === coords) return
    if (!data || coords.x >> 6 !== data.def.regionX || coords.y >> 6 !== data.def.regionY) return
    appliedFocusRef.current = coords
    setPlane(coords.plane)
    setSelected({ x: coords.x & 63, y: coords.y & 63 })
  }, [coords, data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const planeObjects = useMemo(
    () => (objects ?? data?.def.objects)?.filter((o) => o[5] === plane) ?? [],
    [objects, data, plane],
  )

  // --- draw ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data || !terrain) return
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
    // viewMode is a dep because switching to 3D unmounts the canvas — coming
    // back mounts a fresh blank one that needs this effect to re-run.
  }, [terrain, plane, zoom, selected, planeObjects, data, viewMode])

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
    if (!selected || !terrain) return
    const idx = tileIndex(plane, selected.x, selected.y)
    const next = { ...terrain, [field]: terrain[field].slice() as Uint8Array }
    next[field][idx] = value & 0xff
    setTerrain(next)
    setIsDirty(true)
  }

  function setShapeRot(which: 'shape' | 'rotation', value: number) {
    if (!selected || !terrain) return
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
    if (!selected || !terrain) return
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
    if (!data || !terrain || !objects) return
    setIsSaving(true)
    const next = { ...data, def: { ...data.def, objects }, terrain }
    await saveRegion(world.mapsDir, next)
    // deliberately no setData: the drafts already show the saved state, and a
    // data change would rebuild the whole 3D scene for nothing
    baselineRef.current = { terrain, objects }
    setIsSaving(false)
    setIsDirty(false)
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    const nums = search.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if ((nums.length !== 2 && nums.length !== 3) || nums.some((n) => !Number.isInteger(n) || n < 0)) {
      setSearchMsg('use: x y — or x y plane')
      return
    }
    const [x, y] = nums
    const p = nums.length === 3 ? nums[2] : plane
    if (x > 16383 || y > 16383 || p > 3) {
      setSearchMsg('out of range')
      return
    }
    const target: WorldCoords = { x, y, plane: p }
    const targetRegion = regionIdOf(target)
    if (targetRegion !== regionId) {
      // validate before moving — a missing region shouldn't blank the view,
      // but it CAN be created
      try {
        await world.mapsDir.getFileHandle(`${targetRegion}.json`)
      } catch {
        setSearchMsg('')
        setPendingCreate({ rx: x >> 6, ry: y >> 6, target })
        return
      }
      if (isDirty) {
        const ok = await confirmDialog('You have unsaved changes in this region. Discard them and jump?', {
          title: 'Unsaved changes',
          confirmLabel: 'Discard',
          danger: true,
        })
        if (!ok) return
      }
    }
    setSearchMsg('')
    setPendingCreate(null)
    setCoords(target)
  }

  async function openRegionPicker() {
    setPickerOpen(true)
    if (usedRegions) return // scanned once per session — regions rarely change under us
    const used = new Set<number>()
    for await (const handle of world.mapsDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (!isNaN(id)) used.add(id)
    }
    setUsedRegions(used)
  }

  // draw the 256×256 world grid (2px per region, north up)
  useEffect(() => {
    const ctx = pickerCanvasRef.current?.getContext('2d')
    if (!pickerOpen || !usedRegions || !ctx) return
    const P = 2
    ctx.fillStyle = '#0c0e14'
    ctx.fillRect(0, 0, 256 * P, 256 * P)
    ctx.fillStyle = '#2f6b46'
    for (const id of usedRegions) {
      const rx = id >> 8
      const ry = id & 0xff
      ctx.fillRect(rx * P, (255 - ry) * P, P, P)
    }
    // regions created this session (in pendingCreate flow they appear after
    // creation via the load effect, so mark the current region specially)
    ctx.fillStyle = '#2f8fff'
    ctx.fillRect((regionId >> 8) * P, (255 - (regionId & 0xff)) * P, P, P)
  }, [pickerOpen, usedRegions, regionId])

  function pickerCell(e: React.MouseEvent<HTMLCanvasElement>): { rx: number; ry: number; used: boolean } {
    const rect = e.currentTarget.getBoundingClientRect()
    const P = 2
    const rx = Math.max(0, Math.min(255, Math.floor((e.clientX - rect.left) / P)))
    const ry = 255 - Math.max(0, Math.min(255, Math.floor((e.clientY - rect.top) / P)))
    return { rx, ry, used: usedRegions?.has((rx << 8) | ry) ?? false }
  }

  async function handlePickerClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const cell = pickerCell(e)
    const target: WorldCoords = { x: cell.rx * 64 + 32, y: cell.ry * 64 + 32, plane: 0 }
    if (cell.used) {
      if (isDirty && regionIdOf(target) !== regionId) {
        const ok = await confirmDialog('You have unsaved changes in this region. Discard them and jump?', {
          title: 'Unsaved changes',
          confirmLabel: 'Discard',
          danger: true,
        })
        if (!ok) return
      }
      setPickerOpen(false)
      setPendingCreate(null)
      setCoords(target)
    } else {
      setPickerOpen(false)
      setPendingCreate({ rx: cell.rx, ry: cell.ry, target })
    }
  }

  // Create the pending region: write its file, then teleport into it. This
  // writes to disk immediately (a region file either exists or it doesn't) —
  // subsequent edits go through the normal draft/save flow.
  async function handleCreateRegion() {
    if (!pendingCreate) return
    const def = createRegionDef(pendingCreate.rx, pendingCreate.ry, createFill ? { underlayId: createUnderlay } : undefined)
    try {
      const fileHandle = await world.mapsDir.getFileHandle(`${def.id}.json`, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(JSON.stringify(def))
      await writable.close()
    } catch (e) {
      setSearchMsg(`create failed: ${e}`)
      setPendingCreate(null)
      return
    }
    setUsedRegions((prev) => {
      if (!prev) return prev
      const next = new Set(prev)
      next.add(def.id)
      return next
    })
    const target = pendingCreate.target
    setPendingCreate(null)
    setCoords(target)
  }

  // stable identity for the 3D viewer — an inline object would rebuild the
  // whole scene on every re-render (e.g. typing in the search bar). The
  // objects and terrain drafts are deliberately NOT folded in: they go down
  // as their own props so edits only partially rebuild the centre region.
  const sceneData = useMemo(() => data ?? null, [data])
  const sceneFocus = useMemo(() => {
    if (!data || coords.x >> 6 !== data.def.regionX || coords.y >> 6 !== data.def.regionY) return null
    return { x: coords.x & 63, y: coords.y & 63, plane: coords.plane }
  }, [coords, data])

  if (!data) {
    return (
      <div className="item-viewer">
        <p className="loading-text">{loadError || 'Loading region…'}</p>
      </div>
    )
  }

  const worldX = data.def.regionX * 64
  const worldY = data.def.regionY * 64
  const selIdx = selected && terrain ? tileIndex(plane, selected.x, selected.y) : -1
  const selPacked = selected && terrain ? terrain.overlayShapeRot[selIdx] : 0
  const selHasHeight = selected && terrain ? (terrain.heightPresence[selIdx >> 3] & (1 << (selIdx & 0x7))) !== 0 : false

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Region {data.def.regionX}, {data.def.regionY}</span>
          <span className="item-id-badge">world tile {worldX}, {worldY} – {worldX + 63}, {worldY + 63}</span>
          {data.def.hasLocations && <span className="item-id-badge">{(objects ?? data.def.objects).length} objects</span>}
          {!data.def.hasLocations && <span className="item-id-badge">no location key</span>}
          {data.id !== regionId && <span className="item-id-badge">loading region {regionId >> 8}, {regionId & 0xff}…</span>}
        </div>
        <button type="button" className="map-regions-btn" onClick={openRegionPicker} title="World region map — visit a region or pick a free slot to create">
          Regions…
        </button>
        <form className="map-coord-search" onSubmit={handleSearchSubmit}>
          {searchMsg && <span className="map-coord-msg">{searchMsg}</span>}
          <input
            className="map-coord-input"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSearchMsg('') }}
            placeholder={`go to x, y (at ${coords.x}, ${coords.y}, ${coords.plane})`}
            title="World tile coordinates, e.g. 3222 3218 — optional third number is the plane"
          />
          <button type="submit">Go</button>
        </form>
        <div className="map-mode-toggle">
          <button type="button" className={viewMode === '2d' ? 'selected' : ''} onClick={() => setViewMode('2d')}>2D</button>
          <button type="button" className={viewMode === '3d' ? 'selected' : ''} onClick={() => setViewMode('3d')}>3D</button>
        </div>
      </div>

      {pickerOpen && (
        <div className="map-picker-overlay" onClick={() => setPickerOpen(false)}>
          <div className="map-picker" onClick={(e) => e.stopPropagation()}>
            <div className="map-picker-head">
              <span className="enum-title map-picker-title">World regions</span>
              <span className="map-picker-legend">
                <span className="map-picker-key" style={{ background: '#2f6b46' }} /> exists — click to visit
                <span className="map-picker-key" style={{ background: '#0c0e14' }} /> free — click to create
                <span className="map-picker-key" style={{ background: '#2f8fff' }} /> you are here
              </span>
              <button type="button" className="mapscene-info-close" onClick={() => setPickerOpen(false)}>×</button>
            </div>
            {usedRegions ? (
              <canvas
                ref={pickerCanvasRef}
                className="map-picker-canvas"
                width={512}
                height={512}
                onMouseMove={(e) => setPickerHover(pickerCell(e))}
                onMouseLeave={() => setPickerHover(null)}
                onClick={handlePickerClick}
              />
            ) : (
              <p className="loading-text">Scanning regions…</p>
            )}
            <div className="map-picker-status">
              {pickerHover
                ? `region ${pickerHover.rx}, ${pickerHover.ry} — world ${pickerHover.rx * 64}, ${pickerHover.ry * 64} ${pickerHover.used ? '(exists)' : '(free)'}`
                : usedRegions ? `${usedRegions.size} regions in the cache — north is up` : ''}
            </div>
          </div>
        </div>
      )}

      {pendingCreate && (
        <div className="map-create-bar">
          <span className="map-create-msg">
            Region {pendingCreate.rx}, {pendingCreate.ry} isn't in the cache — create it?
          </span>
          <label className="mapscene-toggle">
            <input type="checkbox" checked={createFill} onChange={(e) => setCreateFill(e.target.checked)} />
            fill plane 0 with flat ground
          </label>
          {createFill && (
            <label className="map-create-underlay">
              <span className="item-field-label">underlay</span>
              <NumberInput value={createUnderlay} onChange={setCreateUnderlay} min={0} max={255} />
            </label>
          )}
          <button type="button" className="save-bar-save" onClick={handleCreateRegion}>Create region</button>
          <button type="button" className="save-bar-discard" onClick={() => setPendingCreate(null)}>Cancel</button>
        </div>
      )}

      {viewMode === '3d' && sceneData && (
        <MapSceneViewer
          data={sceneData}
          focus={sceneFocus}
          objects={objects ?? undefined}
          terrain={terrain ?? undefined}
          onEdit={(patch) => applyEditRef.current(patch)}
        />
      )}

      {viewMode === '2d' && terrain && <>
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
              <span className="btn-pill">
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
              </span>
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
                    {z}
                  </button>
                ))}
              </span>
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
          <button type="button" className="save-bar-discard" onClick={() => { setTerrain(baselineRef.current?.terrain ?? data.terrain); setObjects(baselineRef.current?.objects ?? data.def.objects); historyRef.current = { past: [], future: [] }; setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {confirmDialogElement}
    </div>
  )
}
