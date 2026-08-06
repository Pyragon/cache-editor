import { useEffect, useMemo, useRef, useState } from 'react'
import type { LocEntry, MapData, WorldMapData } from '../loaders/maps'
import { PLANES, SIZE, tileIndex, loadRegion, saveRegion, createRegionDef, newRegionData, OBJECT_SLOTS, SLOT_COLORS, SLOT_LABELS } from '../loaders/maps'
import { rgbToRenderedHex } from '../loaders/models'
import { NumberInput } from './defFields'
import { useZoom } from './useZoom'
import { useConfirm } from './useConfirm'
import MapSceneViewer from './MapSceneViewer'
import type { RegionDraft } from './MapSceneViewer'
import { loadRegionEnvironment, saveRegionEnvironment } from './mapScene'
import type { ObjectDefJson, RegionEnvironment, RegionLight } from './mapScene'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { writeJsonItem } from '../loaders/common'
import './MapViewer.css'

const ZOOM_LEVELS = [4, 6, 8, 10, 14]

// world region picker view: canvas is a fixed 512px square, zoom levels are
// px-per-region (2 = whole 256×256 world exactly fits)
const PICKER_SIZE = 512
/** Cap on how many regions one selection may cover. The old create bar capped a
 *  square area at 64×64 regions (4096×4096 tiles, a quarter of the world grid);
 *  a free-form selection gets the same ceiling. */
const MAX_SELECTION = 64 * 64
const PICKER_ZOOMS = [2, 3, 4, 6, 8, 12, 16, 24, 32]

function clampPickerView(scale: number, ox: number, oy: number) {
  // keep the world covering the canvas — you can't pan the map off screen
  const lim = PICKER_SIZE - 256 * scale
  return {
    scale,
    ox: Math.min(0, Math.max(lim, Math.round(ox))),
    oy: Math.min(0, Math.max(lim, Math.round(oy))),
  }
}

const NO_OVERLAY_COLOR = 0xff00ff

const HOME = { x: 3220, y: 3218, plane: 0 }

type SelectedTile = { x: number; y: number }
type WorldCoords = { x: number; y: number; plane: number }

const regionIdOf = (c: WorldCoords) => ((c.x >> 6) << 8) | (c.y >> 6)

/** An inclusive rectangle of regions, in region coords. */
export type RegionRect = { x0: number; y0: number; x1: number; y1: number }

const rectFrom = (a: { rx: number; ry: number }, b: { rx: number; ry: number }): RegionRect => ({
  x0: Math.min(a.rx, b.rx), y0: Math.min(a.ry, b.ry),
  x1: Math.max(a.rx, b.rx), y1: Math.max(a.ry, b.ry),
})
const rectW = (r: RegionRect) => r.x1 - r.x0 + 1
const rectH = (r: RegionRect) => r.y1 - r.y0 + 1
const rectCount = (r: RegionRect) => rectW(r) * rectH(r)
const rectHas = (r: RegionRect, rx: number, ry: number) => rx >= r.x0 && rx <= r.x1 && ry >= r.y0 && ry <= r.y1

function rectIds(r: RegionRect): number[] {
  const ids: number[] = []
  for (let rx = r.x0; rx <= r.x1; rx++) for (let ry = r.y0; ry <= r.y1; ry++) ids.push((rx << 8) | ry)
  return ids
}

// The maps entry's single world viewer: no per-region item list — it owns the
// current position, loads the region containing it (the 3D view adds the 8
// neighbours itself), and saves edits back to that region's own file.
/** The environment record minus its lights — those are drafted separately. */
function withoutLights(env: RegionEnvironment): RegionEnvironment {
  const rest = { ...env }
  delete rest.lights
  return rest
}

export default function MapViewer({ world, onDirtyChange, onNavigate, gotoRegion }: {
  world: WorldMapData
  onDirtyChange?: (dirty: boolean) => void
  /** jump to another entry's item (the 3D panel's View links) */
  onNavigate?: (entryName: string, itemId: number) => void
  /** Region id to open on, from something that navigated here wanting a place
   *  rather than the entry — e.g. a cutscene's map block. Bumped by the caller
   *  so asking for the SAME region twice still moves the view back. */
  gotoRegion?: { id: number; nonce: number } | null
}) {
  const [coords, setCoords] = useState<WorldCoords>(HOME)

  // Land on the middle of the requested region, so the whole of it is in view
  // rather than its corner.
  useEffect(() => {
    if (!gotoRegion) return
    setCoords({
      x: ((gotoRegion.id >> 8) & 0xff) * 64 + 32,
      y: (gotoRegion.id & 0xff) * 64 + 32,
      plane: 0,
    })
  }, [gotoRegion])
  const [data, setData] = useState<MapData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [terrain, setTerrain] = useState<MapData['terrain'] | null>(null)
  // draft of the region's placed objects — edited from the 3D side panel
  const [objects, setObjects] = useState<LocEntry[] | null>(null)
  // The region's environment record (maps/environments/<id>.json) and the draft
  // of its point lights, which the 3D view edits like the placements. The whole
  // record is kept so a save round-trips fog/sun/skybox/HDR untouched.
  const [env, setEnv] = useState<RegionEnvironment | null>(null)
  const [lights, setLights] = useState<RegionLight[] | null>(null)
  // draft of the rest of that record — sun, fog, cube texture, bloom, skybox,
  // and the sections we only carry through (lighting grid, opcode order) —
  // edited from the 3D view's Environment panel. Lights stay separate above
  // because the scene rebakes on them; these mostly apply live.
  const [envSettings, setEnvSettings] = useState<RegionEnvironment | null>(null)
  // Draft edits to object DEFINITIONS (objects/<id>.json), keyed by object id —
  // made from the 3D marker panel. Global data, not region data: one entry
  // rewrites a file every region shares. Held here anyway so they ride the same
  // draft/undo/Discard/Save flow as everything else in this editor.
  const [objectDefs, setObjectDefs] = useState<Map<number, ObjectDefJson>>(new Map())
  // latest written environment record, so consecutive saves keep round-tripping
  // the parts we don't edit (kept out of state — see handleSave)
  const envRef = useRef<RegionEnvironment | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [plane, setPlane] = useState(0)
  const [viewMode, setViewMode] = useState<'2d' | '3d' | 'pov'>('3d')
  const [zoom, setZoom] = useZoom('cache-editor:map-zoom', ZOOM_LEVELS, 8)
  const [selected, setSelected] = useState<SelectedTile | null>(null)
  const [hoverObj, setHoverObj] = useState<{ x: number; y: number; text: string } | null>(null)
  const [search, setSearch] = useState('')
  const [searchMsg, setSearchMsg] = useState('')
  const [createFill, setCreateFill] = useState(true)
  // stored tile byte = underlay definition id + 1 (0 = none). 164 = underlay
  // 163, the Lumbridge grass (what's on the ground at world tile 3219, 3224).
  const [createUnderlay, setCreateUnderlay] = useState(164)
  const [createBusy, setCreateBusy] = useState(false)
  // world-grid region picker: shows every existing region. Clicking SELECTS
  // rather than navigating, so an area to create doesn't have to be a square —
  // the footer acts on whatever is selected. Creation lives entirely in here;
  // it used to close the picker and drop a "this region doesn't exist, create
  // it?" bar onto the map, which said nothing the picker wasn't already showing.
  const [pickerOpen, setPickerOpen] = useState(false)
  /**
   * The selection, as a RECTANGLE of regions rather than a free set.
   * Contiguity isn't a nicety here: picking 50,50 and 52,50 on their own would
   * ask the viewer to load — or the creator to write — two islands with a hole
   * between them. Spanning corners makes that unrepresentable, and it keeps the
   * loaded set a plain rectangle, which is exactly what SceneMosaic wants.
   */
  const [selRect, setSelRect] = useState<RegionRect | null>(null)
  /** An explicit region rectangle chosen in the picker. Null = follow the
   *  default 3×3 around wherever you are (see `effectiveRect`). */
  const [loadedRect, setLoadedRect] = useState<RegionRect | null>(null)
  /**
   * Placement drafts for LOADED regions other than the one you're standing in,
   * keyed by region id. Every loaded region is editable, and each saves to its
   * own `maps/<id>.json` — so this is a plain per-region draft store rather
   * than anything cleverer. The base region keeps its own `objects` state.
   */
  /**
   * Unsaved edits to LOADED regions other than the one you're standing in,
   * keyed by region id. Every loaded region is editable — placements, terrain,
   * point lights and environment alike — and each is its own pair of files, so
   * one draft per region beats a map per field. It also makes an undo snapshot
   * a single reference, since every update replaces the map.
   */
  const [regionDrafts, setRegionDrafts] = useState<Map<number, RegionDraft>>(() => new Map())

  /**
   * What the 3D view actually loads: the picker's rectangle when it covers
   * where you are, otherwise the default 3×3 around the current region — which
   * is what the client itself builds, and what the old span selector defaulted
   * to. Walking out of an explicitly chosen rectangle falls back to the 3×3
   * rather than leaving you standing outside the loaded set.
   */
  const effectiveRect = useMemo<RegionRect>(() => {
    const rx = coords.x >> 6, ry = coords.y >> 6
    if (loadedRect && rectHas(loadedRect, rx, ry)) return loadedRect
    return {
      x0: Math.max(0, rx - 1), y0: Math.max(0, ry - 1),
      x1: Math.min(255, rx + 1), y1: Math.min(255, ry + 1),
    }
  }, [loadedRect, coords.x, coords.y])
  /** first corner; the next click sets the opposite one */
  const [selAnchor, setSelAnchor] = useState<{ rx: number; ry: number } | null>(null)
  /** true between the two corner clicks — the hover preview draws in this state */
  const awaitingCornerRef = useRef(false)
  // header slot the 3D view portals its graphics-settings dropdown into
  const [gfxSlot, setGfxSlot] = useState<HTMLElement | null>(null)
  const [usedRegions, setUsedRegions] = useState<Set<number> | null>(null)
  const [pickerHover, setPickerHover] = useState<{ rx: number; ry: number; used: boolean } | null>(null)
  const [pickerView, setPickerView] = useState(() => clampPickerView(2, 0, 0))
  const [pickerMsg, setPickerMsg] = useState('')
  const pickerDragRef = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null)
  const pickerCanvasRef = useRef<HTMLCanvasElement>(null)
  // id of a region created in-memory this session but not yet saved to disk —
  // it rides the normal dirty/Save/Discard flow instead of being written on
  // creation, so the load effect must not try to read it from the cache
  const unsavedNewRef = useRef<number | null>(null)
  // where Discard returns to when it abandons an unsaved created region
  const prevCoordsRef = useRef<WorldCoords | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { confirm: confirmDialog, dialog: confirmDialogElement } = useConfirm()

  const regionId = regionIdOf(coords)

  // load the region containing the current coords (teleports validate the
  // target exists before moving, so failures here mean the initial region)
  useEffect(() => {
    // an unsaved created region only exists in memory — there's nothing on
    // disk to load, and moving anywhere else abandons the draft
    if (unsavedNewRef.current != null && unsavedNewRef.current !== regionId) unsavedNewRef.current = null
    if (unsavedNewRef.current === regionId) return
    let cancelled = false
    ;(async () => {
      setLoadError('')
      try {
        const next = await loadRegion(world.mapsDir, world.rootHandle, regionId)
        // the environment record rides along: its point lights are edited in
        // the 3D view, and a save has to write the whole record back
        const nextEnv = world.rootHandle
          ? await loadRegionEnvironment(world.rootHandle, regionId)
          : null
        if (!cancelled) {
          envRef.current = nextEnv
          setEnv(nextEnv)
          setData(next)
        }
      } catch {
        if (!cancelled) setLoadError(`region ${regionId >> 8}, ${regionId & 0xff} isn't in the cache`)
      }
    })()
    return () => { cancelled = true }
  }, [world, regionId])

  // last-saved state, for Discard — kept out of `data` so saving doesn't
  // change the scene viewer's data prop (which would force a full rebuild)
  type Snapshot = { terrain: MapData['terrain']; objects: LocEntry[]; lights: RegionLight[] | null; envSettings: RegionEnvironment | null; objectDefs: Map<number, ObjectDefJson>
    /** every OTHER loaded region's drafts at this point — absent on the
     *  baseline, which predates any region being edited */
    regionDrafts?: Map<number, RegionDraft> }
  const baselineRef = useRef<Snapshot | null>(null)
  // per-step undo/redo over the drafts. Snapshots are references (every edit
  // path copies the arrays it changes), so pushing them is free.
  const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] })

  useEffect(() => {
    if (!data) return
    // Point lights are only editable when we have a cache root to write the
    // environment file back to; otherwise the 3D view shows them read-only.
    const initialLights = world.rootHandle ? (env?.lights ?? []) : null
    const initialEnv = env ? withoutLights(env) : null
    baselineRef.current = { terrain: data.terrain, objects: data.def.objects, lights: initialLights, envSettings: initialEnv, objectDefs: new Map() }
    historyRef.current = { past: [], future: [] }
    setTerrain(data.terrain)
    setObjects(data.def.objects)
    setLights(initialLights)
    setEnvSettings(initialEnv)
    setObjectDefs(new Map())
    // a just-created region starts dirty — it doesn't exist on disk until saved
    setIsDirty(unsavedNewRef.current === data.id)
    setSelected(null)
    setPlane(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, env])

  // Single entry point for every 3D-view edit (brush strokes, loc edits,
  // placements, stamps). `coalesce` folds drag-stroke steps into one undo.
  /** One point in the undo stack: the base region's drafts PLUS every other
   *  loaded region's. `regionDrafts` is replaced wholesale on each edit, so
   *  holding the reference is enough to restore it. */
  const snapshot = (t: MapData['terrain'], o: LocEntry[]): Snapshot =>
    ({ terrain: t, objects: o, lights, envSettings, objectDefs, regionDrafts })

  function applyEdit(patch: { terrain?: MapData['terrain']; objects?: LocEntry[]; lights?: RegionLight[]; env?: RegionEnvironment; objectDefs?: Map<number, ObjectDefJson>; coalesce?: boolean; regionId?: number }) {
    if (!terrain || !objects) return
    // An edit to a NEIGHBOUR region: drafted in its own slot and saved to its
    // own file. Everything else in the patch belongs to the base region, so a
    // neighbour patch only ever carries `objects`.
    if (patch.regionId !== undefined && patch.regionId !== data?.id) {
      const id = patch.regionId
      if (!patch.coalesce) {
        historyRef.current.past.push(snapshot(terrain, objects))
        if (historyRef.current.past.length > 60) historyRef.current.past.shift()
        historyRef.current.future = []
      }
      setRegionDrafts((prev) => {
        const next = new Map(prev)
        next.set(id, {
          ...(prev.get(id) ?? {}),
          ...(patch.objects ? { objects: patch.objects } : {}),
          ...(patch.terrain ? { terrain: patch.terrain } : {}),
          ...(patch.lights ? { lights: patch.lights } : {}),
          ...(patch.env ? { env: patch.env } : {}),
        })
        return next
      })
      setIsDirty(true)
      return
    }
    if (!patch.coalesce) {
      historyRef.current.past.push(snapshot(terrain, objects))
      if (historyRef.current.past.length > 60) historyRef.current.past.shift()
      historyRef.current.future = []
    }
    if (patch.terrain) setTerrain(patch.terrain)
    if (patch.objects) setObjects(patch.objects)
    if (patch.lights) setLights(patch.lights)
    if (patch.env) setEnvSettings(patch.env)
    if (patch.objectDefs) setObjectDefs(patch.objectDefs)
    setIsDirty(true)
  }
  const applyEditRef = useRef(applyEdit)
  applyEditRef.current = applyEdit

  const undoRef = useRef(() => {})
  undoRef.current = () => {
    const prev = historyRef.current.past.pop()
    if (!prev || !terrain || !objects) return
    historyRef.current.future.push(snapshot(terrain, objects))
    setTerrain(prev.terrain)
    setObjects(prev.objects)
    setLights(prev.lights)
    setEnvSettings(prev.envSettings)
    setObjectDefs(prev.objectDefs)
    setRegionDrafts(prev.regionDrafts ?? new Map())
    setIsDirty(true)
  }
  const redoRef = useRef(() => {})
  redoRef.current = () => {
    const next = historyRef.current.future.pop()
    if (!next || !terrain || !objects) return
    historyRef.current.past.push(snapshot(terrain, objects))
    setTerrain(next.terrain)
    setObjects(next.objects)
    setLights(next.lights)
    setEnvSettings(next.envSettings)
    setObjectDefs(next.objectDefs)
    setRegionDrafts(next.regionDrafts ?? new Map())
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

        // stored bytes are definition id + 1 (0 = none) — same convention the
        // 3D ground path uses (configs.underlays.get(id - 1))
        let rgb: number | null = null
        if (overlayId > 0) {
          const c = data.overlayColors.get(overlayId - 1)
          if (c != null && c !== NO_OVERLAY_COLOR) rgb = c
        }
        if (rgb == null && underlayId > 0) {
          rgb = data.underlayColors.get(underlayId - 1) ?? null
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
    // Every OTHER loaded region that was edited. Each is its own file, so this
    // is one saveRegion per region — re-read from disk first so a placement
    // edit doesn't clobber whatever else that file holds.
    for (const [id, draft] of regionDrafts) {
      if (id === data.id) continue
      try {
        if (draft.objects || draft.terrain) {
          // re-read first: a placement edit must not clobber whatever else
          // that region's file holds
          const region = await loadRegion(world.mapsDir, world.rootHandle, id)
          await saveRegion(world.mapsDir, {
            ...region,
            def: { ...region.def, objects: draft.objects ?? region.def.objects },
            terrain: draft.terrain ?? region.terrain,
          })
        }
        if ((draft.env || draft.lights) && world.rootHandle) {
          const base = draft.env ?? await loadRegionEnvironment(world.rootHandle, id) ?? {}
          const rec: RegionEnvironment = { ...base, ...(draft.lights ? { lights: draft.lights } : {}) }
          if (!rec.lights?.length) delete rec.lights
          await saveRegionEnvironment(world.rootHandle, id, rec)
        }
      } catch (e) {
        console.error(`failed saving region ${id}`, e)
        setSearchMsg(`couldn't save region ${id >> 8}, ${id & 0xff} — see console`)
      }
    }
    setRegionDrafts(new Map())
    // a draft-created region is now on disk — from here it's a normal region
    if (unsavedNewRef.current === data.id) {
      unsavedNewRef.current = null
      prevCoordsRef.current = null
      setUsedRegions((prev) => {
        if (!prev) return prev
        const nextSet = new Set(prev)
        nextSet.add(data.id)
        return nextSet
      })
    }
    // Point lights live in a different file (maps/environments/<id>.json), so
    // they're only rewritten when they actually changed — and the rest of the
    // environment record goes back untouched.
    const lightsChanged = lights != null && lights !== baselineRef.current?.lights
    const envChanged = envSettings !== baselineRef.current?.envSettings
    if (world.rootHandle && (lightsChanged || envChanged)) {
      // the env draft is the whole record minus lights, so it carries the
      // sections we never model (lighting grid, opcode order) back out intact
      const nextEnv: RegionEnvironment = { ...(envSettings ?? envRef.current ?? {}), lights: lights ?? [] }
      if (!nextEnv.lights?.length) delete nextEnv.lights
      await saveRegionEnvironment(world.rootHandle, data.id, nextEnv)
      // the ref, not the `env` state: setting the state would re-run the draft
      // reset below and hand the 3D view a new lights array (= full rebuild)
      envRef.current = nextEnv
    }
    // Edited object definitions are a third target again — objects/<id>.json,
    // outside this region entirely. Written whole (the draft is the parsed file
    // with fields replaced), so anything the editor doesn't model round-trips.
    if (world.rootHandle && objectDefs.size > 0) {
      const objectsDir = await resolveEntryHandle(world.rootHandle, getEntryPath('objects'))
      if (objectsDir) {
        for (const [id, def] of objectDefs) await writeJsonItem(objectsDir, id, def)
      }
    }
    // deliberately no setData: the drafts already show the saved state, and a
    // data change would rebuild the whole 3D scene for nothing
    baselineRef.current = { terrain, objects, lights, envSettings, objectDefs }
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    if (!data) return
    if (unsavedNewRef.current === data.id) {
      // abandon the draft-created region entirely — it was never on disk, so
      // there's no baseline to restore; go back to where creation started
      unsavedNewRef.current = null
      historyRef.current = { past: [], future: [] }
      setRegionDrafts(new Map())
      setIsDirty(false)
      setCoords(prevCoordsRef.current ?? HOME)
      prevCoordsRef.current = null
      return
    }
    setTerrain(baselineRef.current?.terrain ?? data.terrain)
    setObjects(baselineRef.current?.objects ?? data.def.objects)
    setLights(baselineRef.current?.lights ?? null)
    setEnvSettings(baselineRef.current?.envSettings ?? null)
    setObjectDefs(baselineRef.current?.objectDefs ?? new Map())
    // neighbour regions' drafts go back to what's on disk too — the scene
    // rebuilds each of those cells off the cleared map
    setRegionDrafts(new Map())
    historyRef.current = { past: [], future: [] }
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
        // Not in the cache. Rather than answering with a bar on the map, open
        // the picker on that cell with it selected — the picker already shows
        // what exists around it, which is the context you need to decide how
        // much to create.
        const rx = x >> 6, ry = y >> 6
        setSearchMsg(`region ${rx}, ${ry} isn't in the cache — create it from here`)
        // seed it as the anchor so a second click can span an area out from it
        setSelAnchor({ rx, ry })
        setSelRect({ x0: rx, y0: ry, x1: rx, y1: ry })
        awaitingCornerRef.current = true
        setPickerView(() => {
          const scale = 8
          return clampPickerView(scale, PICKER_SIZE / 2 - (rx + 0.5) * scale, PICKER_SIZE / 2 - (255 - ry + 0.5) * scale)
        })
        void openRegionPicker()
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
    setCoords(target)
  }

  async function openRegionPicker() {
    setPickerOpen(true)
    setPickerMsg('')
    if (usedRegions) return // scanned once per session — regions rarely change under us
    const used = new Set<number>()
    for await (const handle of world.mapsDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (!isNaN(id)) used.add(id)
    }
    setUsedRegions(used)
  }

  // draw the 256×256 world grid (north up) through the picker's pan/zoom view
  useEffect(() => {
    const ctx = pickerCanvasRef.current?.getContext('2d')
    if (!pickerOpen || !usedRegions || !ctx) return
    const { scale, ox, oy } = pickerView
    ctx.fillStyle = '#0c0e14'
    ctx.fillRect(0, 0, PICKER_SIZE, PICKER_SIZE)
    ctx.fillStyle = '#2f6b46'
    for (const id of usedRegions) {
      const x = (id >> 8) * scale + ox
      const y = (255 - (id & 0xff)) * scale + oy
      if (x + scale < 0 || x > PICKER_SIZE || y + scale < 0 || y > PICKER_SIZE) continue
      ctx.fillRect(x, y, scale, scale)
    }
    const drawRect = (r: RegionRect, style: string) => {
      ctx.fillStyle = style
      const x = r.x0 * scale + ox
      const y = (255 - r.y1) * scale + oy
      ctx.fillRect(x, y, rectW(r) * scale, rectH(r) * scale)
    }
    // EVERY loaded region, not just the base one — with a whole rectangle in
    // the scene, "what am I looking at" is the useful thing to see here
    const loaded = effectiveRect
    drawRect(loaded, '#2f8fff')
    // selection sits over the exists/loaded colours, so a selected region that
    // is already loaded still reads as selected
    if (selRect) drawRect(selRect, '#7fc4ff')
    // live preview of the rectangle the second corner would span, so the
    // in-between regions are visible BEFORE committing to them
    if (selAnchor && awaitingCornerRef.current && pickerHover) {
      drawRect(rectFrom(selAnchor, pickerHover), 'rgba(127, 196, 255, 0.45)')
    }
    // "you are here" — the base (editable) region, marked rather than coloured
    // so it stays readable on top of loaded/selected fills
    {
      const bx = (regionId >> 8) * scale + ox
      const by = (255 - (regionId & 0xff)) * scale + oy
      ctx.strokeStyle = '#ff4d4d'
      if (scale >= 5) {
        const pad = Math.max(1, scale * 0.18)
        ctx.lineWidth = Math.max(1.5, scale / 7)
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(bx + pad, by + pad)
        ctx.lineTo(bx + scale - pad, by + scale - pad)
        ctx.moveTo(bx + scale - pad, by + pad)
        ctx.lineTo(bx + pad, by + scale - pad)
        ctx.stroke()
      } else {
        // too small for an X to read — outline the cell instead
        ctx.lineWidth = 1
        ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, scale - 1), Math.max(1, scale - 1))
      }
    }
    // faint region-boundary grid, once cells are big enough for it to read
    if (scale >= 4) {
      ctx.fillStyle = `rgba(255, 255, 255, ${scale >= 8 ? 0.09 : 0.05})`
      const gx0 = Math.max(0, ox)
      const gx1 = Math.min(PICKER_SIZE, 256 * scale + ox)
      const gy0 = Math.max(0, oy)
      const gy1 = Math.min(PICKER_SIZE, 256 * scale + oy)
      for (let i = 0; i <= 256; i++) {
        const x = i * scale + ox
        if (x >= gx0 && x <= gx1) ctx.fillRect(x, gy0, 1, gy1 - gy0)
        const y = i * scale + oy
        if (y >= gy0 && y <= gy1) ctx.fillRect(gx0, y, gx1 - gx0, 1)
      }
    }
  }, [pickerOpen, usedRegions, regionId, pickerView, selRect, selAnchor, pickerHover, effectiveRect])

  // wheel-zoom toward the cursor. Native listener because React registers
  // wheel as passive, and we need preventDefault to keep the page still.
  useEffect(() => {
    const canvas = pickerCanvasRef.current
    if (!pickerOpen || !usedRegions || !canvas) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = canvas!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setPickerView((v) => {
        const idx = PICKER_ZOOMS.indexOf(v.scale)
        const scale = PICKER_ZOOMS[Math.max(0, Math.min(PICKER_ZOOMS.length - 1, idx + (e.deltaY < 0 ? 1 : -1)))]
        if (scale === v.scale) return v
        // keep the region under the cursor under the cursor
        return clampPickerView(scale, cx - ((cx - v.ox) / v.scale) * scale, cy - ((cy - v.oy) / v.scale) * scale)
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [pickerOpen, usedRegions])

  function pickerCell(e: React.MouseEvent<HTMLCanvasElement>): { rx: number; ry: number; used: boolean } | null {
    const rect = e.currentTarget.getBoundingClientRect()
    const { scale, ox, oy } = pickerView
    const rx = Math.floor((e.clientX - rect.left - ox) / scale)
    const ry = 255 - Math.floor((e.clientY - rect.top - oy) / scale)
    if (rx < 0 || rx > 255 || ry < 0 || ry > 255) return null
    return { rx, ry, used: usedRegions?.has((rx << 8) | ry) ?? false }
  }

  // left/middle drag pans; a left press that never moves is a click (select)
  function handlePickerPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault() // middle button would start browser autoscroll
    e.currentTarget.setPointerCapture(e.pointerId)
    pickerDragRef.current = { startX: e.clientX, startY: e.clientY, ox: pickerView.ox, oy: pickerView.oy, moved: false }
  }

  function handlePickerPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    setPickerHover(pickerCell(e))
    const drag = pickerDragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    e.currentTarget.style.cursor = 'grabbing'
    setPickerView((v) => clampPickerView(v.scale, drag.ox + dx, drag.oy + dy))
  }

  function handlePickerPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = pickerDragRef.current
    pickerDragRef.current = null
    e.currentTarget.style.cursor = ''
    if (!drag || drag.moved || e.button !== 0) return
    const cell = pickerCell(e)
    if (cell) pickerClick(cell, e.shiftKey)
  }

  // Right-click deletes a region file, after an are-you-sure. Unlike edits
  // and creation this writes (well, removes) on disk immediately — a file
  // deletion isn't representable in the one-region draft/save model.
  async function handlePickerContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const cell = pickerCell(e)
    if (!cell?.used) return
    const id = (cell.rx << 8) | cell.ry
    if (id === regionId) {
      setPickerMsg("can't delete the region you're standing in — move somewhere else first")
      return
    }
    const ok = await confirmDialog(
      `Delete region ${cell.rx}, ${cell.ry}? This permanently removes ${id}.json from the maps folder on disk.`,
      { title: 'Delete region', confirmLabel: 'Delete', danger: true },
    )
    if (!ok) return
    try {
      await world.mapsDir.removeEntry(`${id}.json`)
    } catch (err) {
      setPickerMsg(`delete failed: ${err}`)
      return
    }
    setPickerMsg(`deleted region ${cell.rx}, ${cell.ry}`)
    setUsedRegions((prev) => {
      if (!prev) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /** Jump to a region, honouring the unsaved-changes guard. False = cancelled. */
  async function pickerGoTo(rx: number, ry: number): Promise<boolean> {
    const target: WorldCoords = { x: rx * 64 + 32, y: ry * 64 + 32, plane: 0 }
    if (isDirty && regionIdOf(target) !== regionId) {
      const ok = await confirmDialog('You have unsaved changes in this region. Discard them and jump?', {
        title: 'Unsaved changes',
        confirmLabel: 'Discard',
        danger: true,
      })
      if (!ok) return false
    }
    setPickerOpen(false)
    setCoords(target)
    return true
  }

  /**
   * Load the selected rectangle into the 3D view. The BASE region — the one
   * that stays editable — is the current one when it falls inside the
   * selection, so loading more around where you're working doesn't move you;
   * otherwise it's the middle of the rectangle.
   */
  async function loadSelection() {
    if (!selRect) return
    const inside = rectHas(selRect, regionId >> 8, regionId & 0xff)
    const brx = inside ? regionId >> 8 : Math.floor((selRect.x0 + selRect.x1) / 2)
    const bry = inside ? regionId & 0xff : Math.floor((selRect.y0 + selRect.y1) / 2)
    const rect = selRect
    if (!(await pickerGoTo(brx, bry))) return
    setLoadedRect(rect)
    clearSelection()
  }

  /**
   * Click toggles a cell; shift+click fills the rectangle back to the last
   * plain-clicked one. Selecting is deliberately non-destructive — nothing
   * happens to the cache until the footer's Create/Load is pressed — so an
   * existing region can be selected alongside free ones without navigating
   * away mid-selection. Double-click still jumps straight to a region.
   */
  function pickerClick(cell: { rx: number; ry: number }, shift: boolean) {
    // shift always re-spans from the existing anchor, so you can keep adjusting
    // the far corner without restarting the rectangle
    if (selAnchor && (shift || awaitingCornerRef.current)) {
      const rect = rectFrom(selAnchor, cell)
      if (rectCount(rect) > MAX_SELECTION) {
        setPickerMsg(`that would be ${rectCount(rect)} regions — the cap is ${MAX_SELECTION}`)
        return
      }
      setSelRect(rect)
      setPickerMsg('')
      awaitingCornerRef.current = false
      return
    }
    // first corner — collapses to a single region, and the next click spans to it
    setSelAnchor(cell)
    setSelRect(rectFrom(cell, cell))
    setPickerMsg('')
    awaitingCornerRef.current = true
  }

  function clearSelection() {
    setSelRect(null)
    setSelAnchor(null)
    awaitingCornerRef.current = false
    setPickerMsg('')
  }

  // Create the pending region as an in-memory draft: nothing touches disk
  // until Save writes the region file. Discard — or navigating away past the
  // unsaved-changes confirm — abandons it entirely.
  //
  // A MULTI-region area (width/height > 1) is different: the files are
  // written to disk immediately, after a confirm — like the picker's
  // right-click delete, a bulk file operation has no place in the one-region
  // draft/save model. Existing regions inside the area are left untouched.
  /**
   * Creates every selected region that doesn't already exist. Existing ones in
   * the selection are left untouched — selecting a mix is how you say "fill in
   * the gaps around here", which is what proc-gen will want to regenerate a
   * hole while its neighbours constrain it.
   *
   * A lone new region stays an in-memory draft on the normal dirty/Save/Discard
   * flow. Creating SEVERAL writes their files to disk immediately, like the
   * picker's right-click delete: a many-region draft has no place in the
   * one-region draft/save model.
   */
  async function createSelected() {
    if (createBusy) return
    const missing = selIds
      .filter((id) => !usedRegions?.has(id))
      .map((id) => ({ rx: id >> 8, ry: id & 0xff }))
      .sort((a, b) => (a.rx - b.rx) || (a.ry - b.ry))
    if (missing.length === 0) return
    if (isDirty) {
      const ok = await confirmDialog('You have unsaved changes in this region. Discard them and create?', {
        title: 'Unsaved changes',
        confirmLabel: 'Discard',
        danger: true,
      })
      if (!ok) return
    }
    const fill = createFill ? { underlayId: createUnderlay } : undefined
    const first = missing[0]

    if (missing.length === 1) {
      const def = createRegionDef(first.rx, first.ry, fill)
      const created = await newRegionData(world.rootHandle, def)
      // Discard returns here; creating on top of another unsaved creation keeps
      // the original return point (the abandoned draft is no place to go back to)
      prevCoordsRef.current = unsavedNewRef.current === regionId ? (prevCoordsRef.current ?? HOME) : coords
      unsavedNewRef.current = def.id
      envRef.current = null
      setEnv(null)
      setData(created)
      clearSelection()
      setPickerOpen(false)
      setCoords({ x: first.rx * 64 + 32, y: first.ry * 64 + 32, plane: 0 })
      return
    }

    const already = selIds.length - missing.length
    const ok = await confirmDialog(
      `Write ${missing.length} new region files to the maps folder now?` +
      (already > 0 ? ` ${already} selected region${already === 1 ? '' : 's'} already exist${already === 1 ? 's' : ''} and will be left untouched.` : '') +
      ' Unlike a single new region, several are written to disk immediately rather than staged for Save.',
      { title: `Create ${missing.length} regions`, confirmLabel: `Create ${missing.length} regions` },
    )
    if (!ok) return
    setCreateBusy(true)
    try {
      const createdIds: number[] = []
      for (let i = 0; i < missing.length; i++) {
        // createRegionDef returns the encoded, JSON-ready def — the same
        // shape saveRegion writes
        const def = createRegionDef(missing[i].rx, missing[i].ry, fill)
        const fh = await world.mapsDir.getFileHandle(`${def.id}.json`, { create: true })
        const writable = await fh.createWritable()
        await writable.write(JSON.stringify(def))
        await writable.close()
        createdIds.push(def.id)
        if ((i + 1) % 16 === 0 || i === missing.length - 1) setPickerMsg(`creating regions… ${i + 1}/${missing.length}`)
      }
      setUsedRegions((prev) => {
        if (!prev) return prev
        const next = new Set(prev)
        for (const id of createdIds) next.add(id)
        return next
      })
      setSearchMsg(`created ${createdIds.length} regions${already > 0 ? ` (${already} already existed)` : ''}`)
      clearSelection()
      setPickerOpen(false)
      setCoords({ x: first.rx * 64 + 32, y: first.ry * 64 + 32, plane: 0 })
    } finally {
      setCreateBusy(false)
    }
  }

  // how many of the selected cells don't exist yet — drives the footer's action
  const selIds = useMemo(() => (selRect ? rectIds(selRect) : []), [selRect])
  const selMissing = useMemo(
    () => selIds.filter((id) => !usedRegions?.has(id)).length,
    [selIds, usedRegions],
  )

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
          <button type="button" className="map-regions-btn" onClick={openRegionPicker} title="World region map — visit a region or pick a free slot to create">
            Regions
          </button>
          {/* the 3D view's Client graphics settings dropdown portals in here so
              it sits beside Regions while its state stays in MapSceneViewer */}
          <span className="map-header-gfx" ref={(el) => setGfxSlot(el)} />
        </div>
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
          <button type="button" className={viewMode === 'pov' ? 'selected' : ''} title="First-person walk: click the view to grab the cursor, WASD/arrows to move, mouse to look, Esc to release" onClick={() => setViewMode('pov')}>POV</button>
        </div>
      </div>

      {pickerOpen && (
        <div className="map-picker-overlay" onClick={() => { setPickerOpen(false); setPickerMsg('') }}>
          <div className="map-picker" onClick={(e) => e.stopPropagation()}>
            <div className="map-picker-head">
              <span className="enum-title map-picker-title">World regions</span>
              <span className="map-picker-legend">
                <span className="map-picker-key" style={{ background: '#2f6b46' }} /> exists
                <span className="map-picker-key" style={{ background: '#0c0e14' }} /> free
                <span className="map-picker-key" style={{ background: '#2f8fff' }} /> loaded
                <span className="map-picker-key" style={{ background: '#7fc4ff' }} /> selected
                <span className="map-picker-key map-picker-key-here" /> you are here
              </span>
              <button
                type="button"
                className="map-picker-close"
                onClick={() => { setPickerOpen(false); setPickerMsg('') }}
              >
                Close
              </button>
            </div>
            {usedRegions ? (
              <canvas
                ref={pickerCanvasRef}
                className="map-picker-canvas"
                width={PICKER_SIZE}
                height={PICKER_SIZE}
                onPointerDown={handlePickerPointerDown}
                onPointerMove={handlePickerPointerMove}
                onPointerUp={handlePickerPointerUp}
                onPointerCancel={() => { pickerDragRef.current = null }}
                onMouseLeave={() => setPickerHover(null)}
                onDoubleClick={(e) => {
                  const cell = pickerCell(e)
                  if (cell?.used) void pickerGoTo(cell.rx, cell.ry)
                }}
                onContextMenu={handlePickerContextMenu}
              />
            ) : (
              <p className="loading-text">Scanning regions…</p>
            )}
            {usedRegions && (
              <div className="map-picker-hint">click to select · shift+click to select a rectangle · double-click to open · scroll to zoom · drag to pan · right-click deletes · north is up</div>
            )}
            {pickerMsg && <div className="map-picker-msg">{pickerMsg}</div>}
            <div className="map-picker-status">
              {pickerHover
                ? `region ${pickerHover.rx}, ${pickerHover.ry} — world ${pickerHover.rx * 64}, ${pickerHover.ry * 64} ${pickerHover.used ? '(exists)' : '(free)'}`
                : usedRegions ? `${usedRegions.size} regions in the cache` : ''}
            </div>
            {selRect && (
              <div className="map-picker-actions">
                <span className="map-picker-selcount">
                  {rectW(selRect)}×{rectH(selRect)} — {selRect.x0},{selRect.y0} to {selRect.x1},{selRect.y1}
                  {selMissing > 0 && <> · <strong>{selMissing} free</strong></>}
                  {selIds.length - selMissing > 0 && <> · {selIds.length - selMissing} existing</>}
                </span>
                {selMissing > 0 && (
                  <>
                    <label className="mapscene-toggle">
                      <input type="checkbox" checked={createFill} onChange={(e) => setCreateFill(e.target.checked)} />
                      fill plane 0 with flat ground
                    </label>
                    {createFill && (
                      <label className="map-create-underlay" title="Stored tile byte — underlay definition id + 1. Default 164 = underlay 163, Lumbridge grass.">
                        <span className="item-field-label">underlay</span>
                        <NumberInput value={createUnderlay} onChange={setCreateUnderlay} min={0} max={255} digits={3} />
                      </label>
                    )}
                  </>
                )}
                <button type="button" className="save-bar-discard" disabled={createBusy} onClick={clearSelection}>
                  Clear
                </button>
                {selMissing > 0 ? (
                  <button type="button" className="save-bar-save" disabled={createBusy} onClick={() => void createSelected()}>
                    {createBusy ? 'Creating…' : `Create ${selMissing} region${selMissing === 1 ? '' : 's'}`}
                  </button>
                ) : (
                  <button type="button" className="save-bar-save" onClick={() => void loadSelection()}>
                    {selIds.length === 1 ? 'Load region' : `Load ${selIds.length} regions`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {(viewMode === '3d' || viewMode === 'pov') && sceneData && (
        <MapSceneViewer
          data={sceneData}
          regionRect={effectiveRect}
          regionDrafts={regionDrafts}
          focus={sceneFocus}
          objects={objects ?? undefined}
          terrain={terrain ?? undefined}
          lights={lights ?? undefined}
          env={envSettings}
          envEditable={world.rootHandle != null}
          objectDefs={objectDefs}
          onEdit={(patch) => applyEditRef.current(patch)}
          gfxSlot={gfxSlot}
          onNavigate={onNavigate}
          pov={viewMode === 'pov'}
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
            Underlay and Overlay IDs are the stored tile byte — the definition id <em>plus one</em>,
            with 0 meaning none (byte 164 = underlay 163). Bit 0x1 of Tile Flags blocks the tile
            (the red tint above). Height is an explicit override — when off, the client derives a
            smooth default from its terrain noise function (the 3D view reproduces it).
          </p>
        </section>
      )}
      </>}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {confirmDialogElement}
    </div>
  )
}
