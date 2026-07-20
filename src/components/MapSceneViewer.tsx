import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { LocEntry, MapData, MapRegionDef, MapTerrain } from '../loaders/maps'
import { SIZE, decodeTerrain, tileIndex, OBJECT_SLOTS, SLOT_COLORS, SLOT_LABELS, LOC_TYPE_LABELS } from '../loaders/maps'
import { rgbToRenderedHex } from '../loaders/models'
import { NumberInput } from './defFields'
import { buildTerrainMesh, buildLocsMesh, buildMarkersMesh, buildRegionOutline, buildSkyboxMesh, renderMinimapGround, loadRegionEnvironment, loadSceneConfigs, LocAssets, SceneMosaic, DEFAULT_SUN, MARKER_COLORS } from './mapScene'
import type { SceneConfigs, LocRef, MarkerInfo, SunConfig } from './mapScene'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import './MapSceneViewer.css'

// 3D scene preview of a map region and its 8 neighbours (the client always
// builds a 3×3 block — buildings that straddle a region boundary only look
// right with the neighbours present). Region outlines and floating markers
// (sound emitters / map-icon anchors) are editor aids on top.
// See mapScene.ts for the ported client pipeline.

const REGION_UNITS = SIZE * 512

// BVH-accelerated raycasting: the merged terrain/locs meshes are hundreds of
// thousands of triangles — brute-force raycasts on every mouse move are the
// main source of pointer stutter. Meshes without a boundsTree still fall back
// to the stock raycast.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

let cachedConfigs: { root: FileSystemDirectoryHandle; configs: SceneConfigs } | null = null

// A clicked loc, resolved to its entry in its region's objects array.
type LocSelection = {
  kind: 'loc'
  name: string
  objectId: number
  type: number
  rotation: number
  x: number
  y: number
  plane: number
  regionX: number
  regionY: number
  inCenter: boolean
  /** index into the centre region's objects array; -1 when unmatched */
  index: number
  /** only centre-region locs are editable — neighbours live in another file */
  editable: boolean
  sizeX: number
  sizeY: number
  models: string
  /** def.mapSpriteId (-1 = none) + resolved sprite frame for the preview */
  mapSpriteId: number
  spriteUrl?: string
  /** def.mapCategoryId (-1 = none) — the areas config whose icon this
   *  placement puts on the minimap (e.g. the bank symbol on a bank chest) */
  mapCategoryId: number
  areaName?: string
  areaSpriteUrl?: string
}

type MarkerSelection = {
  kind: 'marker'
  markerKind: MarkerInfo['kind']
  objectId: number
  lines: string[]
  spriteUrl?: string
  areaSpriteUrl?: string
}

/** Resolved areas-config info for a mapCategoryId. */
type AreaInfo = {
  name?: string
  spriteUrl: string | null
  bitmap: ImageBitmap | null
  minimap: boolean
}

type Selection = LocSelection | MarkerSelection

type PlaceDraft = { objectId: number; type: number; rotation: number; plane: number }

const BRUSH_SIZES = [1, 2, 3, 5, 7]

type TerrainBrush = {
  tool: 'height' | 'underlay' | 'overlay' | 'flags'
  size: number
  step: number
  mode: 'raise' | 'lower' | 'flatten' | 'smooth'
  plane: number
  underlayId: number
  overlayId: number
  overlayShape: number
  overlayRotation: number
  flagBit: number
  flagSet: boolean
}

/** One edit against the parent's drafts; coalesce folds it into the previous
 *  undo step (used for drag-stroke continuations). */
type EditPatch = { terrain?: MapTerrain; objects?: LocEntry[]; coalesce?: boolean }

/** Copied area: per-plane tile channels + contained placements (relative). */
type StampClipboard = {
  w: number
  h: number
  underlay: Uint8Array
  overlay: Uint8Array
  shapeRot: Uint8Array
  flags: Uint8Array
  heightPresent: Uint8Array
  heightValue: Uint8Array
  objects: LocEntry[]
}

export default function MapSceneViewer({ data, focus, objects, terrain, onEdit }: {
  data: MapData
  focus?: { x: number; y: number; plane: number } | null
  /** draft of the centre region's placements (edits not yet saved) — kept
   *  outside `data` so an edit rebuilds only the centre locs, not the world */
  objects?: LocEntry[]
  /** draft of the centre region's terrain — same decoupling as `objects`, so
   *  a height-brush stroke rebuilds only the centre terrain/locs */
  terrain?: MapTerrain
  /** commit any edit — the parent owns the drafts, undo history, and save */
  onEdit?: (patch: EditPatch) => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const minimapCamRef = useRef<HTMLDivElement>(null)
  const marqueeDivRef = useRef<HTMLDivElement>(null)
  // client-style minimap ground (blurred+lit, shape-masked overlays; 256×256
  // RGBA), produced by the scene build / terrain rebuilds from the mosaic
  const minimapBaseRef = useRef<Uint8ClampedArray | null>(null)
  const [minimapVersion, setMinimapVersion] = useState(0)
  // minimap brightness = the client's palette gamma (its Brightness setting).
  // The map-dumper ground is raw config RGB, so 1.0 is neutral; the slider
  // applies a straight gamma via a post-LUT. (New storage key — the old one
  // was calibrated against the HSL-palette ground.)
  const [mmGamma, setMmGamma] = useState(() => {
    const stored = parseFloat(localStorage.getItem('cache-editor:minimap-gamma-v2') ?? '')
    return Number.isFinite(stored) ? stored : 1.0
  })
  const mmGammaLut = useMemo(() => {
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, mmGamma))
    return lut
  }, [mmGamma])
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  // current draft, readable from inside the scene-build closure
  const objectsPropRef = useRef<LocEntry[] | null>(null)
  objectsPropRef.current = objects ?? null
  const lastBuiltObjectsRef = useRef<LocEntry[] | null>(null)
  // unified centre rebuild (terrain + locs + shadows + minimap) — assigned by
  // the scene build once its closure state (mosaic grid, assets) exists
  const rebuildCenterRef = useRef<((t: MapTerrain, objs: LocEntry[]) => Promise<void>) | null>(null)
  // list-row click → select + highlight + fly the camera over the loc
  const selectFromListRef = useRef<((entry: LocEntry, index: number) => void) | null>(null)
  const [locNames, setLocNames] = useState<Map<number, string>>(new Map())

  // map-sprite previews: config/map_sprites/<id>.json → sprites/<sid>/<sid>_0.png,
  // cached as object URLs (revoked on unmount)
  const spriteUrlCacheRef = useRef<Map<number, Promise<string | null>>>(new Map())
  const loadMapSpriteUrl = (mapSpriteId: number): Promise<string | null> => {
    const cache = spriteUrlCacheRef.current
    let pending = cache.get(mapSpriteId)
    if (!pending) {
      pending = (async () => {
        try {
          const root = data.rootHandle
          if (!root) return null
          const cfgDir = await (await root.getDirectoryHandle('config')).getDirectoryHandle('map_sprites')
          const cfgFile = await (await cfgDir.getFileHandle(`${mapSpriteId}.json`)).getFile()
          const def = JSON.parse(await cfgFile.text()) as { spriteId: number }
          if (def.spriteId < 0) return null
          const spriteDir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(def.spriteId))
          const png = await (await spriteDir.getFileHandle(`${def.spriteId}_0.png`)).getFile()
          return URL.createObjectURL(png)
        } catch {
          return null
        }
      })()
      cache.set(mapSpriteId, pending)
    }
    return pending
  }
  const loadMapSpriteUrlRef = useRef(loadMapSpriteUrl)
  loadMapSpriteUrlRef.current = loadMapSpriteUrl

  // areas config (mapCategoryId → map function icon): config/areas/<id>.json,
  // icon sprite = defaultIconArchive (cryogen's spriteId field is the
  // worldmap-label channel and is -1 on regular icons)
  const areaInfoCacheRef = useRef<Map<number, Promise<AreaInfo | null>>>(new Map())
  const loadAreaInfo = (categoryId: number): Promise<AreaInfo | null> => {
    const cache = areaInfoCacheRef.current
    let pending = cache.get(categoryId)
    if (!pending) {
      pending = (async () => {
        try {
          const root = data.rootHandle
          if (!root) return null
          const dir = await (await root.getDirectoryHandle('config')).getDirectoryHandle('areas')
          const file = await (await dir.getFileHandle(`${categoryId}.json`)).getFile()
          const def = JSON.parse(await file.text()) as { defaultIconArchive: number; areaName?: string; displayedOnMinimap: boolean }
          let spriteUrl: string | null = null
          let bitmap: ImageBitmap | null = null
          if (def.defaultIconArchive >= 0) {
            try {
              const spriteDir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(def.defaultIconArchive))
              const png = await (await spriteDir.getFileHandle(`${def.defaultIconArchive}_0.png`)).getFile()
              spriteUrl = URL.createObjectURL(png)
              bitmap = await createImageBitmap(png)
            } catch { /* icon sprite not dumped */ }
          }
          return { name: def.areaName, spriteUrl, bitmap, minimap: def.displayedOnMinimap !== false }
        } catch {
          return null
        }
      })()
      cache.set(categoryId, pending)
    }
    return pending
  }
  const loadAreaInfoRef = useRef(loadAreaInfo)
  loadAreaInfoRef.current = loadAreaInfo

  useEffect(() => () => {
    for (const pending of spriteUrlCacheRef.current.values()) {
      void pending.then((url) => { if (url) URL.revokeObjectURL(url) })
    }
    for (const pending of areaInfoCacheRef.current.values()) {
      void pending.then((info) => { if (info?.spriteUrl) URL.revokeObjectURL(info.spriteUrl) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // single commit path for every edit
  const onEditRef = useRef<((patch: EditPatch) => void) | null>(null)
  onEditRef.current = onEdit ?? null

  // --- Terrain brush: heights/paint/flags under a circular brush -----------
  const [terrainBrush, setTerrainBrush] = useState<TerrainBrush>({
    tool: 'height', size: 2, step: 8, mode: 'raise', plane: 0,
    underlayId: 1, overlayId: 1, overlayShape: 0, overlayRotation: 0,
    flagBit: 0x1, flagSet: true,
  })
  const terrainBrushRef = useRef<TerrainBrush | null>(null)
  const terrainPropRef = useRef<MapTerrain | null>(null)
  terrainPropRef.current = terrain ?? null
  const lastBuiltTerrainRef = useRef<MapTerrain | null>(null)

  // eyedropper (Alt+click in the Terrain tab): sample the tile into the brush
  const sampleTerrainRef = useRef<(tx: number, ty: number) => void>(() => {})
  sampleTerrainRef.current = (tx, ty) => {
    const t = terrain ?? data.terrain
    setTerrainBrush((b) => {
      const idx = tileIndex(b.plane, tx, ty)
      if (b.tool === 'underlay') return { ...b, underlayId: t.underlayIds[idx] }
      if (b.tool === 'overlay') {
        return {
          ...b,
          overlayId: t.overlayIds[idx],
          overlayShape: t.overlayShapeRot[idx] >> 2,
          overlayRotation: t.overlayShapeRot[idx] & 0x3,
        }
      }
      return b
    })
  }

  // stamp clipboard (Shift+drag an area in the Terrain tab to copy it)
  const [clipboard, setClipboard] = useState<StampClipboard | null>(null)
  const [pasteArmed, setPasteArmed] = useState(false)
  const pasteArmedRef = useRef(false)
  const clipboardRef = useRef<StampClipboard | null>(null)
  clipboardRef.current = clipboard
  const copyAreaRef = useRef<(x0: number, y0: number, x1: number, y1: number) => void>(() => {})
  copyAreaRef.current = (x0, y0, x1, y1) => {
    const t = terrain ?? data.terrain
    const list = objects ?? data.def.objects
    const minX = Math.max(0, Math.min(x0, x1))
    const maxX = Math.min(63, Math.max(x0, x1))
    const minY = Math.max(0, Math.min(y0, y1))
    const maxY = Math.min(63, Math.max(y0, y1))
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const n = w * h * 4
    const clip: StampClipboard = {
      w, h,
      underlay: new Uint8Array(n), overlay: new Uint8Array(n),
      shapeRot: new Uint8Array(n), flags: new Uint8Array(n),
      heightPresent: new Uint8Array(n), heightValue: new Uint8Array(n),
      objects: [],
    }
    for (let plane = 0; plane < 4; plane++) {
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          const src = tileIndex(plane, minX + dx, minY + dy)
          const dst = (plane * w + dx) * h + dy
          clip.underlay[dst] = t.underlayIds[src]
          clip.overlay[dst] = t.overlayIds[src]
          clip.shapeRot[dst] = t.overlayShapeRot[src]
          clip.flags[dst] = t.tileFlags[src]
          clip.heightPresent[dst] = (t.heightPresence[src >> 3] & (1 << (src & 0x7))) !== 0 ? 1 : 0
          clip.heightValue[dst] = t.heightValue[src]
        }
      }
    }
    for (const o of list) {
      if (o[3] >= minX && o[3] <= maxX && o[4] >= minY && o[4] <= maxY) {
        clip.objects.push([o[0], o[1], o[2], o[3] - minX, o[4] - minY, o[5]] as LocEntry)
      }
    }
    setClipboard(clip)
    setPasteArmed(false)
  }
  const pasteAreaRef = useRef<(px: number, py: number) => void>(() => {})
  pasteAreaRef.current = (px, py) => {
    const clip = clipboardRef.current
    const commit = onEditRef.current
    if (!clip || !commit) return
    const t = terrain ?? data.terrain
    const list = objects ?? data.def.objects
    const nextTerrain: MapTerrain = {
      ...t,
      underlayIds: t.underlayIds.slice(),
      overlayIds: t.overlayIds.slice(),
      overlayShapeRot: t.overlayShapeRot.slice(),
      tileFlags: t.tileFlags.slice(),
      heightPresence: t.heightPresence.slice(),
      heightValue: t.heightValue.slice(),
    }
    for (let plane = 0; plane < 4; plane++) {
      for (let dx = 0; dx < clip.w; dx++) {
        for (let dy = 0; dy < clip.h; dy++) {
          const x = px + dx
          const y = py + dy
          if (x > 63 || y > 63) continue
          const src = (plane * clip.w + dx) * clip.h + dy
          const dst = tileIndex(plane, x, y)
          nextTerrain.underlayIds[dst] = clip.underlay[src]
          nextTerrain.overlayIds[dst] = clip.overlay[src]
          nextTerrain.overlayShapeRot[dst] = clip.shapeRot[src]
          nextTerrain.tileFlags[dst] = clip.flags[src]
          if (clip.heightPresent[src]) nextTerrain.heightPresence[dst >> 3] |= 1 << (dst & 0x7)
          else nextTerrain.heightPresence[dst >> 3] &= ~(1 << (dst & 0x7))
          nextTerrain.heightValue[dst] = clip.heightValue[src]
        }
      }
    }
    const nextObjects = list.map((o) => [...o] as LocEntry)
    for (const o of clip.objects) {
      const x = px + o[3]
      const y = py + o[4]
      if (x > 63 || y > 63) continue
      nextObjects.push([o[0], o[1], o[2], x, y, o[5]] as LocEntry)
    }
    commit({ terrain: nextTerrain, objects: nextObjects })
    setPasteArmed(false)
  }

  // --- Place mode: a ghost of the object follows the cursor; click commits --
  const [sideTab, setSideTab] = useState<'view' | 'place' | 'terrain'>('view')
  const [placing, setPlacing] = useState(false)
  const [placeMultiple, setPlaceMultiple] = useState(false)
  const placeMultipleRef = useRef(false)
  placeMultipleRef.current = placeMultiple
  const [placeDraft, setPlaceDraft] = useState<PlaceDraft>({ objectId: 1276, type: 10, rotation: 0, plane: 0 })
  const placingRef = useRef<PlaceDraft | null>(null)
  placingRef.current = placing ? placeDraft : null
  terrainBrushRef.current = sideTab === 'terrain' ? terrainBrush : null
  pasteArmedRef.current = sideTab === 'terrain' && pasteArmed
  const sideTabRef = useRef(sideTab)
  sideTabRef.current = sideTab
  const ghostUpdateRef = useRef<((p: PlaceDraft, tx: number, ty: number) => void) | null>(null)
  const ghostClearRef = useRef<(() => void) | null>(null)
  const onPlaceRef = useRef<(entry: LocEntry) => void>(() => {})
  onPlaceRef.current = (entry) => {
    const base = objects ?? data.def.objects
    onEditRef.current?.({ objects: [...base.map((o) => [...o] as LocEntry), entry] })
    if (!placeMultipleRef.current) setPlacing(false)
  }
  // Place-tab eyedropper (Alt+click a loc): load it into the place form
  const samplePlaceRef = useRef<(loc: LocRef) => void>(() => {})
  samplePlaceRef.current = (loc) => {
    setPlaceDraft({ objectId: loc.objectId, type: loc.shape, rotation: loc.rotation, plane: loc.plane })
  }

  // marquee multi-select (Shift+drag in the View tab): indices into objects
  const [multiSel, setMultiSel] = useState<number[]>([])
  const setMultiSelRef = useRef(setMultiSel)
  setMultiSelRef.current = setMultiSel
  const [visiblePlanes, setVisiblePlanes] = useState([true, true, true, true])
  const [showLocs, setShowLocs] = useState(true)
  const [showNeighbors, setShowNeighbors] = useState(true)
  const [showOutlines, setShowOutlines] = useState(true)
  const [showMarkers, setShowMarkers] = useState(true)
  const [showSky, setShowSky] = useState(true)
  const skyMeshRef = useRef<THREE.Mesh | null>(null)
  const highlightClearRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState('building terrain…')
  const [hoverText, setHoverText] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef<Selection | null>(null)
  selectionRef.current = selection
  const planeGroupsRef = useRef<(THREE.Group | null)[]>([null, null, null, null])
  type Tagged = { obj: THREE.Object3D; neighbor: boolean; kind: 'terrain' | 'loc' | 'marker' | 'outline' }
  const taggedRef = useRef<Tagged[]>([])
  const assetsRef = useRef<LocAssets | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false

    const w = mount.clientWidth || 900
    const h = mount.clientHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    // full native DPI on a 4K screen quadruples the pixels pushed per frame —
    // cap it; at these fill rates it's the difference between smooth and choppy
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.setClearColor(0x0b0d12)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x0b0d12, REGION_UNITS * 2, REGION_UNITS * 5)
    const camera = new THREE.PerspectiveCamera(50, w / h, 8, REGION_UNITS * 10)
    const center = new THREE.Vector3(REGION_UNITS / 2, 0, -REGION_UNITS / 2)
    camera.position.set(center.x, REGION_UNITS * 0.55, center.z + REGION_UNITS * 0.75)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.maxPolarAngle = Math.PI / 2 - 0.02
    // middle mouse orbits, right pans; left is free for picking/painting
    controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
    controls.update()
    cameraRef.current = camera
    controlsRef.current = controls

    // idle throttle: rendering this scene at 60fps around the clock starves
    // the rest of the browser — after a few seconds without input, drop to
    // ~15fps (water keeps drifting); any interaction restores full rate
    let lastActivity = performance.now()
    const bumpActivity = () => { lastActivity = performance.now() }
    controls.addEventListener('change', bumpActivity)

    const disposables: { dispose(): void }[] = []
    // materials with animated UVs: data-driven scroll (waterfalls, lava —
    // offset = seconds*speed/64, OpenGlToolkit convention) and still water
    // (client ripple effect approximated by a gentle drifting wobble)
    const scrollMaterials: { map: THREE.Texture; u: number; v: number }[] = []
    const waterMaterials: THREE.Texture[] = []
    const track = (obj: THREE.Object3D) => {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) disposables.push(mesh.geometry)
        if (mesh.material) {
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            disposables.push(m)
            const basic = m as THREE.MeshBasicMaterial
            if (basic.map && m.userData.scroll) {
              scrollMaterials.push({ map: basic.map, u: m.userData.scroll.u, v: m.userData.scroll.v })
              disposables.push(basic.map) // per-material texture clone
            } else if (basic.map && m.userData.water) {
              waterMaterials.push(basic.map)
              disposables.push(basic.map)
            }
          }
        }
      })
      return obj
    }

    // --- picking: hover tile highlight + click-to-select -----------------
    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true // BVH: stop at the closest hit per mesh
    const pointer = new THREE.Vector2()
    let pointerInside = false
    const TILE = 512

    function tileOutline(color: number): THREE.LineLoop {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0, TILE, 0, 0, TILE, 0, -TILE, 0, 0, -TILE,
      ]), 3))
      const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, linewidth: 2 }))
      line.visible = false
      line.raycast = () => {} // never pickable
      scene.add(line)
      return line
    }
    const hoverOutline = tileOutline(0xffe14d)
    const selectOutline = tileOutline(0xff5ad2)

    // terrain-brush footprint ring (unit circle of one tile radius, scaled)
    const ringPts: number[] = []
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      ringPts.push(Math.cos(a) * TILE, 0, Math.sin(a) * TILE)
    }
    const ringGeo = new THREE.BufferGeometry()
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ringPts), 3))
    const brushRing = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0x8dff5a }))
    brushRing.visible = false
    brushRing.raycast = () => {}
    scene.add(brushRing)
    // assigned once the mosaic exists (needs current heights to derive values)
    let applyBrush: ((tx: number, ty: number, opts?: { coalesce?: boolean; first?: boolean }) => void) | null = null
    let marqueeSelect: ((x0: number, y0: number, x1: number, y1: number) => void) | null = null

    // --- picked-loc highlight: the loc's own triangles, pulled from the
    // merged geometry via triangleOwners, as a pulsing fill + edge outline
    let highlightGroup: THREE.Group | null = null
    let highlightFill: THREE.MeshBasicMaterial | null = null
    function clearLocHighlight() {
      if (!highlightGroup) return
      scene.remove(highlightGroup)
      highlightGroup.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose()
      })
      highlightGroup = null
      highlightFill = null
    }
    highlightClearRef.current = clearLocHighlight

    function highlightLoc(mesh: THREE.Mesh, owner: number) {
      clearLocHighlight()
      const owners = mesh.userData.triangleOwners as Int32Array
      const positions = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
      const tri: number[] = []
      for (let t = 0; t < owners.length; t++) {
        if (owners[t] !== owner) continue
        const base = t * 9
        for (let k = 0; k < 9; k++) tri.push(positions[base + k])
      }
      if (tri.length === 0) return
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3))
      highlightFill = new THREE.MeshBasicMaterial({
        color: 0x2f8fff,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const fill = new THREE.Mesh(geometry, highlightFill)
      fill.renderOrder = 900
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: 0xb7e0ff, transparent: true, opacity: 0.95 }),
      )
      edges.renderOrder = 901
      highlightGroup = new THREE.Group()
      highlightGroup.add(fill, edges)
      highlightGroup.position.copy(mesh.position)
      // never pickable — clicks must pass through to the loc beneath
      highlightGroup.traverse((o) => { o.raycast = () => {} })
      scene.add(highlightGroup)
    }

    // fill in the async def details (name/size/models/map sprite) for a loc
    function fillLocDef(objectId: number) {
      void (async () => {
        const def = await assetsRef.current?.getDef(objectId)
        if (!def) return
        const mapSpriteId = def.mapSpriteId ?? -1
        const spriteUrl = mapSpriteId >= 0 ? await loadMapSpriteUrlRef.current(mapSpriteId) : null
        const mapCategoryId = def.mapCategoryId ?? -1
        const area = mapCategoryId >= 0 ? await loadAreaInfoRef.current(mapCategoryId) : null
        setSelection((prev) => prev?.kind === 'loc' && prev.objectId === objectId ? {
          ...prev,
          name: def.name && def.name !== 'null' ? def.name : 'Object',
          sizeX: def.sizeX ?? 1,
          sizeY: def.sizeY ?? 1,
          models: def.objectModelIds ? def.objectModelIds.flat().join(', ') : '',
          mapSpriteId,
          spriteUrl: spriteUrl ?? undefined,
          mapCategoryId,
          areaName: area?.name,
          areaSpriteUrl: area?.spriteUrl ?? undefined,
        } : prev)
      })()
    }

    // object-list row click: same selection as clicking the loc in the scene,
    // plus the camera flies over its tile
    selectFromListRef.current = (entry, index) => {
      const [objectId, type, rotation, x, y, plane] = entry
      let found: { mesh: THREE.Mesh; owner: number } | null = null
      for (const t of taggedRef.current) {
        if (t.neighbor || t.kind !== 'loc') continue
        const mesh = t.obj as THREE.Mesh
        const locs = mesh.userData.locs as LocRef[] | undefined
        if (!locs) continue
        const owner = locs.findIndex((l) =>
          l.objectId === objectId && l.shape === type && l.rotation === rotation
          && l.x === x && l.y === y && l.plane === plane)
        if (owner >= 0) { found = { mesh, owner }; break }
      }
      if (found) highlightLoc(found.mesh, found.owner)
      else clearLocHighlight()
      selectOutline.visible = false
      const cx = (x + 0.5) * TILE
      const cz = -(y + 0.5) * TILE
      controls.target.set(cx, 0, cz)
      camera.position.set(cx, 4500, cz + 5200)
      controls.update()
      setSelection({
        kind: 'loc', name: 'Object', objectId, type, rotation, x, y, plane,
        regionX: data.def.regionX, regionY: data.def.regionY,
        inCenter: true, index, editable: index >= 0,
        sizeX: 1, sizeY: 1, models: '', mapSpriteId: -1, mapCategoryId: -1,
      })
      fillLocDef(objectId)
    }

    function pick(): THREE.Intersection | null {
      raycaster.setFromCamera(pointer, camera)
      // only visible meshes — raycasting hidden planes/neighbours (and then
      // discarding the hits) was pure waste
      const targets: THREE.Object3D[] = []
      scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o) })
      const hits = raycaster.intersectObjects(targets, false)
      return hits[0] ?? null
    }

    function worldTileOf(point: THREE.Vector3): { wx: number; wy: number; tx: number; ty: number } {
      const tx = Math.floor(point.x / TILE)
      const ty = Math.floor(-point.z / TILE)
      return { wx: data.def.regionX * 64 + tx, wy: data.def.regionY * 64 + ty, tx, ty }
    }

    function updatePointer(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    // resolve the loc (placed object) under a raycast hit, shared by
    // selection, the eyedropper, and drag-to-move
    function resolveLocAt(hit: THREE.Intersection): {
      loc: LocRef; mesh: THREE.Mesh; owner: number
      isCenter: boolean; index: number; meshRegionX: number; meshRegionY: number
    } | null {
      const mesh = hit.object as THREE.Mesh
      const faceIndex = hit.faceIndex ?? -1
      if (!mesh.userData.locs || faceIndex < 0) return null
      const owners = mesh.userData.triangleOwners as Int32Array
      const owner = owners?.[faceIndex] ?? -1
      const loc = owner >= 0 ? (mesh.userData.locs as LocRef[])[owner] : undefined
      if (!loc) return null
      const meshRegionX = data.def.regionX + Math.round(mesh.position.x / (64 * TILE))
      const meshRegionY = data.def.regionY - Math.round(mesh.position.z / (64 * TILE))
      const isCenter = meshRegionX === data.def.regionX && meshRegionY === data.def.regionY
      const centerList = objectsPropRef.current ?? data.def.objects
      const index = isCenter
        ? centerList.findIndex((o) =>
            o[0] === loc.objectId && o[1] === loc.shape && o[2] === loc.rotation
            && o[3] === loc.x && o[4] === loc.y && o[5] === loc.plane)
        : -1
      return { loc, mesh, owner, isCenter, index, meshRegionX, meshRegionY }
    }

    // terrain drag-painting: left button held, apply once per tile crossed
    let paintingDrag = false
    let lastPaintTile = -1
    function paintAtPointer(first: boolean) {
      const hit = pick()
      if (!hit) return
      const t = worldTileOf(hit.point)
      if (t.tx < 0 || t.tx > 63 || t.ty < 0 || t.ty > 63) return // centre region only
      const key = t.tx * 64 + t.ty
      if (key === lastPaintTile) return
      const wasFirst = first && lastPaintTile === -1
      lastPaintTile = key
      applyBrush?.(t.tx, t.ty, { coalesce: !wasFirst, first: wasFirst })
    }

    // marquee (Shift+drag): view tab selects objects, terrain tab copies area
    let marquee: { x0: number; y0: number; tile0: { tx: number; ty: number } | null } | null = null
    function marqueeRect(e: PointerEvent) {
      const wrap = renderer.domElement.parentElement
      const base = wrap?.getBoundingClientRect()
      if (!marquee || !base || !marqueeDivRef.current) return
      const left = Math.min(marquee.x0, e.clientX) - base.left
      const top = Math.min(marquee.y0, e.clientY) - base.top
      const w = Math.abs(e.clientX - marquee.x0)
      const h = Math.abs(e.clientY - marquee.y0)
      Object.assign(marqueeDivRef.current.style, {
        display: 'block', left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`,
      })
    }
    function hideMarquee() {
      if (marqueeDivRef.current) marqueeDivRef.current.style.display = 'none'
    }

    // drag-to-move: left-drag starting on the selected (editable) loc
    let movingLoc: { entry: LocEntry; index: number } | null = null
    let suppressClick = false

    function onPointerMove(e: PointerEvent) {
      updatePointer(e)
      pointerInside = true
      bumpActivity()
      if (paintingDrag && terrainBrushRef.current) paintAtPointer(false)
      if (marquee) marqueeRect(e)
      if (movingLoc) {
        const hit = pick()
        if (hit) {
          const t = worldTileOf(hit.point)
          if (t.tx >= 0 && t.tx < 64 && t.ty >= 0 && t.ty < 64) {
            const [objectId, type, rotation, , , plane] = movingLoc.entry
            ghostUpdateRef.current?.({ objectId, type, rotation, plane }, t.tx, t.ty)
          }
        }
      }
    }
    function onPointerLeave() {
      pointerInside = false
      paintingDrag = false
      marquee = null
      hideMarquee()
      if (movingLoc) { movingLoc = null; ghostClearRef.current?.() }
      hoverOutline.visible = false
      brushRing.visible = false
      pushHoverText('') // defined below; only ever called after init
    }

    let downX = 0, downY = 0
    function onPointerDown(e: PointerEvent) {
      downX = e.clientX
      downY = e.clientY
      suppressClick = false
      bumpActivity()
      if (e.button !== 0) return

      // eyedropper: Alt+click samples instead of acting
      if (e.altKey) {
        updatePointer(e)
        const tab = sideTabRef.current
        if (tab === 'terrain') {
          const hit = pick()
          if (hit) {
            const t = worldTileOf(hit.point)
            if (t.tx >= 0 && t.tx < 64 && t.ty >= 0 && t.ty < 64) sampleTerrainRef.current(t.tx, t.ty)
          }
          suppressClick = true
        } else if (tab === 'place') {
          const hit = pick()
          const res = hit ? resolveLocAt(hit) : null
          if (res) samplePlaceRef.current(res.loc)
          suppressClick = true
        }
        return
      }

      // marquee: Shift+drag — select objects (View) or copy an area (Terrain)
      if (e.shiftKey && (sideTabRef.current === 'view' || sideTabRef.current === 'terrain')) {
        updatePointer(e)
        const hit = pick()
        const tile0 = hit ? (() => { const t = worldTileOf(hit.point); return { tx: t.tx, ty: t.ty } })() : null
        marquee = { x0: e.clientX, y0: e.clientY, tile0 }
        suppressClick = true
        return
      }

      // drag-to-move: press on the currently selected editable loc
      const sel = selectionRef.current
      if (sideTabRef.current === 'view' && sel?.kind === 'loc' && sel.editable) {
        updatePointer(e)
        const hit = pick()
        const res = hit ? resolveLocAt(hit) : null
        if (res && res.isCenter && res.index === sel.index) {
          movingLoc = {
            entry: [sel.objectId, sel.type, sel.rotation, sel.x, sel.y, sel.plane] as LocEntry,
            index: sel.index,
          }
          return
        }
      }

      // Terrain brush: left press paints immediately and keeps painting
      // while dragged (orbit lives on the middle button now)
      if (terrainBrushRef.current && !pasteArmedRef.current) {
        updatePointer(e)
        lastPaintTile = -1
        paintingDrag = true
        paintAtPointer(true)
      }
    }
    function onPointerUp(e: PointerEvent) {
      if (paintingDrag) { paintingDrag = false; return }
      if (e.button !== 0) return // middle/right are camera buttons

      // finish a marquee: select objects (View) or copy the area (Terrain)
      if (marquee) {
        const m = marquee
        marquee = null
        hideMarquee()
        updatePointer(e)
        if (sideTabRef.current === 'view') {
          marqueeSelect?.(m.x0, m.y0, e.clientX, e.clientY)
        } else if (m.tile0) {
          const hit = pick()
          if (hit) {
            const t = worldTileOf(hit.point)
            copyAreaRef.current(m.tile0.tx, m.tile0.ty, t.tx, t.ty)
          }
        }
        return
      }

      // finish a drag-to-move
      if (movingLoc) {
        const moving = movingLoc
        movingLoc = null
        ghostClearRef.current?.()
        const hit = pick()
        if (hit) {
          const t = worldTileOf(hit.point)
          if (t.tx >= 0 && t.tx < 64 && t.ty >= 0 && t.ty < 64
              && (t.tx !== moving.entry[3] || t.ty !== moving.entry[4])) {
            const base = objectsPropRef.current ?? data.def.objects
            const next = base.map((o) => [...o] as LocEntry)
            next[moving.index] = [moving.entry[0], moving.entry[1], moving.entry[2], t.tx, t.ty, moving.entry[5]] as LocEntry
            setSelection(null)
            onEditRef.current?.({ objects: next })
            return
          }
        }
        // released in place — treat as a plain re-click below
      }

      if (suppressClick) { suppressClick = false; return }
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return // drag, not a click

      // armed paste: a click stamps the clipboard at the tile (SW anchor)
      if (pasteArmedRef.current) {
        const hit = pick()
        if (!hit) return
        const t = worldTileOf(hit.point)
        if (t.tx < 0 || t.tx > 63 || t.ty < 0 || t.ty > 63) return
        pasteAreaRef.current(t.tx, t.ty)
        return
      }

      // Place mode: a click commits the ghost's tile instead of selecting
      if (placingRef.current) {
        const placeHit = pick()
        if (!placeHit) return
        const t = worldTileOf(placeHit.point)
        if (t.tx < 0 || t.tx > 63 || t.ty < 0 || t.ty > 63) return // centre region only
        const p = placingRef.current
        onPlaceRef.current([p.objectId, p.type, p.rotation, t.tx, t.ty, p.plane] as LocEntry)
        return
      }

      // terrain-tab clicks are consumed by the brush (or paste) — no selection
      if (sideTabRef.current === 'terrain') return

      const hit = pick()
      if (!hit) {
        setSelection(null)
        selectOutline.visible = false
        clearLocHighlight()
        return
      }
      const mesh = hit.object as THREE.Mesh
      const { wx, wy } = worldTileOf(hit.point)
      const faceIndex = hit.faceIndex ?? -1

      if (mesh.userData.markers && faceIndex >= 0) {
        const marker = (mesh.userData.markers as MarkerInfo[])[faceIndex >> 3]
        if (marker) {
          const gp = new THREE.Vector3()
          mesh.getWorldPosition(gp)
          const regionX = data.def.regionX + Math.round(gp.x / (64 * TILE))
          const regionY = data.def.regionY - Math.round(gp.z / (64 * TILE))
          const mwx = regionX * 64 + marker.tileX
          const mwy = regionY * 64 + marker.tileY
          setSideTab('view') // the selection panel lives in the View tab
          setSelection({
            kind: 'marker',
            markerKind: marker.kind,
            objectId: marker.objectId,
            lines: [`world tile ${mwx}, ${mwy}`],
          })
          selectOutline.position.set(gp.x + marker.tileX * TILE, gp.y + marker.y + 8, gp.z - marker.tileY * TILE)
          selectOutline.visible = true
          clearLocHighlight()
          void (async () => {
            const def = await assetsRef.current?.getDef(marker.objectId)
            if (!def) return
            const mapSpriteId = def.mapSpriteId ?? -1
            const spriteUrl = mapSpriteId >= 0 ? await loadMapSpriteUrlRef.current(mapSpriteId) : null
            const mapCategoryId = def.mapCategoryId ?? -1
            const area = mapCategoryId >= 0 ? await loadAreaInfoRef.current(mapCategoryId) : null
            setSelection((prev) => prev?.kind === 'marker' ? {
              ...prev,
              lines: [
                `world tile ${mwx}, ${mwy}`,
                def.ambientSoundId !== undefined ? `ambient sound ${def.ambientSoundId}` : '',
                def.soundId !== undefined ? `sound ${def.soundId}` : '',
                def.soundGroupIds?.length ? `sound group [${def.soundGroupIds.join(', ')}]` : '',
                mapCategoryId >= 0 ? `map icon ${mapCategoryId}${area?.name ? ` — ${area.name}` : ''}` : '',
                mapSpriteId >= 0 ? `map sprite ${mapSpriteId}` : '',
              ].filter(Boolean),
              spriteUrl: spriteUrl ?? undefined,
              areaSpriteUrl: area?.spriteUrl ?? undefined,
            } : prev)
          })()
          return
        }
      }

      {
        const res = resolveLocAt(hit)
        if (res) {
          const { loc, isCenter, index, meshRegionX, meshRegionY } = res
          setSideTab('view') // the selection panel lives in the View tab
          setSelection({
            kind: 'loc',
            name: 'Object',
            objectId: loc.objectId,
            type: loc.shape,
            rotation: loc.rotation,
            x: loc.x,
            y: loc.y,
            plane: loc.plane,
            regionX: meshRegionX,
            regionY: meshRegionY,
            inCenter: isCenter,
            index,
            editable: isCenter && index >= 0,
            sizeX: 1,
            sizeY: 1,
            models: '',
            mapSpriteId: -1,
            mapCategoryId: -1,
          })
          selectOutline.visible = false
          highlightLoc(res.mesh, res.owner)
          fillLocDef(loc.objectId)
          return
        }
      }

      // terrain clicks intentionally don't select (locs only, for now)
      void wx; void wy
      setSelection(null)
      selectOutline.visible = false
      clearLocHighlight()
    }

    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    let raf = 0
    let frame = 0
    let mmFrame = 0
    let skipCounter = 0
    let lastHoverText = ''
    const pushHoverText = (text: string) => {
      if (text === lastHoverText) return // avoid re-rendering React per frame
      lastHoverText = text
      setHoverText(text)
    }
    function animate() {
      // idle: render every 4th frame only (~15fps) — water still drifts,
      // the GPU stops hogging the compositor
      if (performance.now() - lastActivity > 3000 && (skipCounter++ & 3) !== 0) {
        raf = requestAnimationFrame(animate)
        return
      }
      controls.update()
      // minimap camera marker: position = orbit target, arrow = view heading
      if ((mmFrame++ & 7) === 0 && minimapCamRef.current) {
        const P = 4
        const tx = Math.max(0, Math.min(SIZE, controls.target.x / TILE))
        const ty = Math.max(0, Math.min(SIZE, -controls.target.z / TILE))
        const fx = controls.target.x - camera.position.x
        const fz = controls.target.z - camera.position.z
        const rot = Math.atan2(fx, -fz)
        minimapCamRef.current.style.transform =
          `translate(${tx * P - 7}px, ${SIZE * P - ty * P - 7}px) rotate(${rot}rad)`
      }
      // the sky dome stays centred on the camera so it reads as infinitely far
      if (skyMeshRef.current) skyMeshRef.current.position.copy(camera.position)
      // pulse the picked-loc highlight
      if (highlightFill) highlightFill.opacity = 0.24 + Math.sin(performance.now() / 170) * 0.12
      if (scrollMaterials.length > 0 || waterMaterials.length > 0) {
        const seconds = (performance.now() % 512000) / 1000
        for (const { map, u, v } of scrollMaterials) {
          map.offset.set(((seconds * u) / 64) % 1, ((seconds * v) / 64) % 1)
        }
        // still water: slow diagonal drift with a subtle swell
        const wu = (seconds * 0.022 + Math.sin(seconds * 0.8) * 0.012) % 1
        const wv = (seconds * 0.031 + Math.cos(seconds * 0.6) * 0.012) % 1
        for (const map of waterMaterials) map.offset.set(wu, wv)
      }
      // hover raycast every other frame — cheap enough, keeps orbit smooth
      if (pointerInside && (frame++ & 1) === 0) {
        const hit = pick()
        if (hit) {
          const { wx, wy, tx, ty } = worldTileOf(hit.point)
          hoverOutline.position.set(tx * TILE, hit.point.y + 8, -ty * TILE)
          hoverOutline.visible = true
          pushHoverText(`tile ${wx}, ${wy}`)
          // Place mode: keep the ghost under the cursor (centre region only)
          if (placingRef.current) {
            if (tx >= 0 && tx < 64 && ty >= 0 && ty < 64) ghostUpdateRef.current?.(placingRef.current, tx, ty)
            else ghostClearRef.current?.()
          }
          // Terrain brush: footprint ring follows the cursor
          const brush = terrainBrushRef.current
          if (brush && tx >= 0 && tx < 64 && ty >= 0 && ty < 64) {
            const rr = Math.max(0.5, brush.size - 0.5)
            brushRing.scale.set(rr, 1, rr)
            brushRing.position.set((tx + 0.5) * TILE, hit.point.y + 10, -(ty + 0.5) * TILE)
            brushRing.visible = true
          } else {
            brushRing.visible = false
          }
        } else {
          hoverOutline.visible = false
          brushRing.visible = false
          pushHoverText('')
          if (placingRef.current) ghostClearRef.current?.()
        }
      }
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    function onResize() {
      const nw = mount!.clientWidth || w
      const nh = mount!.clientHeight || h
      renderer.setSize(nw, nh)
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(mount)

    ;(async () => {
      try {
        if (!data.rootHandle) {
          setStatus('no cache root available')
          return
        }
        if (!cachedConfigs || cachedConfigs.root !== data.rootHandle) {
          cachedConfigs = { root: data.rootHandle, configs: await loadSceneConfigs(data.rootHandle) }
        }
        const configs = cachedConfigs.configs
        if (disposed) return

        const assets = new LocAssets(data.rootHandle)
        assetsRef.current = assets
        const mapsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('maps'))

        for (let plane = 0; plane < 4; plane++) {
          const group = new THREE.Group()
          scene.add(group)
          planeGroupsRef.current[plane] = group
        }
        const outlines = new THREE.Group()
        scene.add(outlines)

        // load all 9 cells first — the mosaic needs every terrain up front so
        // heights/lighting/underlay-blur are seam-free across boundaries
        setStatus('loading regions…')
        type Cell = { dx: number; dy: number; def: MapRegionDef; terrain: ReturnType<typeof decodeTerrain> }
        // the centre region renders the parent's draft terrain (height-brush
        // edits survive a 2D/3D toggle); `let` because brush rebuilds swap it
        let currentTerrain = terrainPropRef.current ?? data.terrain
        lastBuiltTerrainRef.current = terrainPropRef.current
        const cells: Cell[] = [{ dx: 0, dy: 0, def: data.def, terrain: currentTerrain }]
        const regionGrid: (Cell['terrain'] | null)[][] = [[null, null, null], [null, null, null], [null, null, null]]
        regionGrid[1][1] = currentTerrain
        if (mapsDir) {
          for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
              if (dx === 0 && dy === 0) continue
              try {
                const id = ((data.def.regionX + dx) << 8) | (data.def.regionY + dy)
                const file = await (await mapsDir.getFileHandle(`${id}.json`)).getFile()
                const def = JSON.parse(await file.text()) as MapRegionDef
                const terrain = decodeTerrain(def)
                cells.push({ dx, dy, def, terrain })
                regionGrid[dx + 1][dy + 1] = terrain
              } catch { /* neighbour not dumped */ }
            }
          }
        }
        // region environment (map_environments dump): fog, sun, skybox
        const env = await loadRegionEnvironment(data.rootHandle, data.id)
        const sun: SunConfig = env?.environment
          ? {
              x: env.environment.sunPosition?.[0] ?? DEFAULT_SUN.x,
              y: env.environment.sunPosition?.[1] ?? DEFAULT_SUN.y,
              z: env.environment.sunPosition?.[2] ?? DEFAULT_SUN.z,
              ambient: env.environment.sunAmbient ?? DEFAULT_SUN.ambient,
            }
          : DEFAULT_SUN
        if (env?.environment?.fogColour !== undefined) {
          const fogColor = env.environment.fogColour & 0xffffff
          renderer.setClearColor(fogColor)
          const density = Math.min(env.environment.fogDepth ?? 0, 1200) / 1200
          const scale = 1 - density * 0.5
          scene.fog = new THREE.Fog(fogColor, REGION_UNITS * 2 * scale, REGION_UNITS * 5 * scale)
        }

        setStatus('computing mosaic…')
        const mosaic = new SceneMosaic(regionGrid, data.def.regionX, data.def.regionY, configs, sun)
        if (disposed) return

        // sun colour tint (fixed-function diffuse) relative to the default
        // 0xDDCCBB — applied to terrain/loc materials, including rebuilt ones
        let sunTint: [number, number, number] | null = null
        const sunColour = env?.environment?.sunColour
        if (sunColour !== undefined && (sunColour & 0xffffff) !== 0xddccbb) {
          sunTint = [
            Math.min(1.6, ((sunColour >> 16) & 0xff) / 0xdd),
            Math.min(1.6, ((sunColour >> 8) & 0xff) / 0xcc),
            Math.min(1.6, (sunColour & 0xff) / 0xbb),
          ]
        }
        const applyTint = (obj: THREE.Object3D) => {
          if (!sunTint) return
          obj.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.material) return
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              (m as THREE.MeshBasicMaterial).color.setRGB(...sunTint)
            }
          })
        }

        // the centre region renders the parent's draft placements, so an
        // Apply that happened while in 2D view is already reflected here
        const initialObjects = objectsPropRef.current ?? data.def.objects
        lastBuiltObjectsRef.current = objectsPropRef.current

        if (env?.skybox) {
          const sky = await buildSkyboxMesh(data.rootHandle, assets, env.skybox.id, env.skybox.rotation)
          if (sky && !disposed) {
            // dome model hangs below the origin in three-space (RS y-down
            // authoring) — mirror it up, and blow it up to read as distant
            sky.scale.set(24, -24, 24)
            // never pickable — it would otherwise be raycast on every hover
            sky.traverse((o) => { o.raycast = () => {} })
            track(sky)
            scene.add(sky)
            skyMeshRef.current = sky
          }
        }

        // subtract the locs' static shadows from a copy of the light slices —
        // through the HD client's softening kernel (GroundGL.resetLight), NOT
        // raw like the software renderer: effective shadow at a vertex =
        // centre>>1 + west>>2 + south>>2 + north>>3 + east>>3. Raw subtraction
        // makes every wall/rock a hard 1-corner dark blob (per-tile mottling);
        // the blur halves the amplitude and feathers it over neighbours.
        const shadowLights = (lights: Uint8Array[], locBuilds: ({ shadows: Uint8Array } | null)[]) =>
          lights.map((l, plane) => {
            const s = locBuilds[plane]?.shadows
            if (!s) return l
            const V = SIZE + 1
            const out = l.slice()
            for (let x = 0; x < V; x++) {
              for (let y = 0; y < V; y++) {
                const eff =
                  (s[x * V + y] >> 1)
                  + (x > 0 ? s[(x - 1) * V + y] >> 2 : 0)
                  + (y > 0 ? s[x * V + y - 1] >> 2 : 0)
                  + (y < V - 1 ? s[x * V + y + 1] >> 3 : 0)
                  + (x < V - 1 ? s[(x + 1) * V + y] >> 3 : 0)
                const i = x * V + y
                out[i] = Math.max(0, out[i] - eff)
              }
            }
            return out
          })

        for (const { dx, dy, def, terrain } of cells) {
          const isCenter = dx === 0 && dy === 0
          if (disposed) return

          const offsetX = dx * REGION_UNITS
          const offsetZ = -dy * REGION_UNITS
          const label = isCenter ? 'this region' : `neighbour ${def.regionX},${def.regionY}`
          const { heights, lights } = mosaic.slicesFor(dx, dy)
          const palettes = [0, 1, 2, 3].map((plane) => mosaic.paletteFor(dx, dy, plane))
          const overlayCorners = [0, 1, 2, 3].map((plane) => mosaic.overlayCornerFor(dx, dy, plane))
          const underlayCorners = [0, 1, 2, 3].map((plane) => mosaic.underlayCornerFor(dx, dy, plane))

          // locs FIRST — their static shadows darken the terrain lighting
          const objList = isCenter ? initialObjects : def.objects
          const locBuilds: (Awaited<ReturnType<typeof buildLocsMesh>> | null)[] = [null, null, null, null]
          if (def.hasLocations && objList.length > 0) {
            for (let plane = 0; plane < 4; plane++) {
              locBuilds[plane] = await buildLocsMesh(
                terrain, objList, plane, heights, assets,
                (done, total) => setStatus(`objects (${label}, plane ${plane}): ${done}/${total}`),
              )
              if (disposed) return
            }
          }
          const litShadowed = shadowLights(lights, locBuilds)

          if (isCenter) {
            minimapBaseRef.current = await renderMinimapGround(terrain, configs, 0, mosaic.underlayRgbBlurFor(dx, dy, 0), assets)
            setMinimapVersion((v) => v + 1)
          }

          setStatus(`terrain: ${label}…`)
          for (let plane = 0; plane < 4; plane++) {
            const terrainMesh = await buildTerrainMesh(terrain, plane, heights, configs, assets, {
              lights: litShadowed,
              palettes,
              overlayCorners,
              underlayCorners,
            })
            if (disposed) return
            if (terrainMesh) {
              terrainMesh.position.set(offsetX, 0, offsetZ)
              // indirect: the default mode reorders triangles, which would break
              // the material groups and the faceIndex→triangleOwners mapping
              terrainMesh.geometry.computeBoundsTree({ indirect: true })
              track(terrainMesh)
              planeGroupsRef.current[plane]?.add(terrainMesh)
              taggedRef.current.push({ obj: terrainMesh, neighbor: !isCenter, kind: 'terrain' })
            }
          }

          for (let plane = 0; plane < 4; plane++) {
            const built = locBuilds[plane]
            if (!built) continue
            if (built.mesh) {
              built.mesh.position.set(offsetX, 0, offsetZ)
              built.mesh.geometry.computeBoundsTree({ indirect: true })
              track(built.mesh)
              planeGroupsRef.current[plane]?.add(built.mesh)
              taggedRef.current.push({ obj: built.mesh, neighbor: !isCenter, kind: 'loc' })
            }
            if (built.markers.length > 0) {
              const markerGroup = buildMarkersMesh(built.markers)
              if (markerGroup) {
                markerGroup.position.set(offsetX, 0, offsetZ)
                track(markerGroup)
                planeGroupsRef.current[plane]?.add(markerGroup)
                taggedRef.current.push({ obj: markerGroup, neighbor: !isCenter, kind: 'marker' })
              }
            }
          }

          // outline every region's perimeter; centre gets the bright colour
          const outline = buildRegionOutline(heights[0], isCenter ? 0x2f8fff : 0x9a5cff)
          outline.position.set(offsetX, 0, offsetZ)
          track(outline)
          outlines.add(outline)
          taggedRef.current.push({ obj: outline, neighbor: !isCenter, kind: 'outline' })
        }

        for (const { obj, kind } of taggedRef.current) {
          if (kind === 'terrain' || kind === 'loc') applyTint(obj)
        }

        let centerHeights = mosaic.slicesFor(0, 0).heights

        // --- Place-mode ghost: a translucent single-loc mesh under the cursor
        let ghost: { obj: THREE.Object3D; key: string } | null = null
        let ghostToken = 0
        const disposeDeep = (obj: THREE.Object3D) => {
          obj.traverse((o) => {
            const m = o as THREE.Mesh
            if (m.geometry) m.geometry.dispose()
            if (m.material) {
              for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
                const basic = mat as THREE.MeshBasicMaterial
                if (basic.map && (mat.userData.scroll || mat.userData.water)) basic.map.dispose()
                mat.dispose()
              }
            }
          })
        }
        const clearGhost = () => {
          if (!ghost) return
          scene.remove(ghost.obj)
          disposeDeep(ghost.obj)
          ghost = null
        }
        const ghostify = (obj: THREE.Object3D) => {
          obj.traverse((o) => {
            const m = o as THREE.Mesh
            if (!m.material) return
            for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
              const basic = mat as THREE.MeshBasicMaterial
              // flat hologram-blue: real model colours are often too dark to
              // read as translucent — a uniform tint shows shape + footprint
              basic.vertexColors = false
              basic.map = null
              basic.color.set(0x7ec4ff)
              basic.transparent = true
              basic.opacity = 0.45
              basic.depthWrite = false
              basic.needsUpdate = true
            }
            m.renderOrder = 500
          })
          obj.traverse((o) => { o.raycast = () => {} }) // clicks land on the tile below
        }
        ghostClearRef.current = clearGhost
        ghostUpdateRef.current = (p, tx, ty) => {
          const key = `${p.objectId},${p.type},${p.rotation},${p.plane},${tx},${ty}`
          if (ghost?.key === key) return
          const token = ++ghostToken
          void (async () => {
            const { mesh, markers } = await buildLocsMesh(
              currentTerrain, [[p.objectId, p.type, p.rotation, tx, ty, p.plane] as LocEntry],
              p.plane, centerHeights, assets,
            )
            if (disposed || token !== ghostToken) {
              if (mesh) disposeDeep(mesh)
              return
            }
            clearGhost()
            // marker objects have no visible model — ghost their diamond
            const obj: THREE.Object3D | null = mesh ?? (markers.length > 0 ? buildMarkersMesh(markers) : null)
            if (!obj) return
            ghostify(obj)
            scene.add(obj)
            ghost = { obj, key }
          })()
        }

        // --- Terrain brush: heights (derived from the current computed
        // heights), underlay/overlay paint, or flag bits — committed drafts
        const VERTS = SIZE + 1
        const vEffAt = (plane: number, x: number, y: number) => {
          // effective height value: plane 0 stores absolute (-v*32),
          // upper planes store the offset below the plane underneath
          const h = centerHeights[plane][x * VERTS + y]
          const below = plane > 0 ? centerHeights[plane - 1][x * VERTS + y] : 0
          return plane === 0 ? Math.round(-h / 32) : Math.round((below - h) / 32)
        }
        let strokeAnchorV = 0 // flatten: the height sampled at stroke start
        applyBrush = (cx, cy, opts) => {
          const p = terrainBrushRef.current
          const commit = onEditRef.current
          if (!p || !commit) return
          const t = terrainPropRef.current ?? currentTerrain
          const coalesce = opts?.coalesce ?? false

          // circular footprint clipped to the centre region
          const tiles: [number, number][] = []
          const r = Math.max(0.5, p.size - 0.5)
          const ri = Math.ceil(r)
          for (let dx = -ri; dx <= ri; dx++) {
            for (let dy = -ri; dy <= ri; dy++) {
              if (dx * dx + dy * dy > r * r) continue
              const x = cx + dx
              const y = cy + dy
              if (x >= 0 && x <= 63 && y >= 0 && y <= 63) tiles.push([x, y])
            }
          }
          if (tiles.length === 0) return

          if (p.tool === 'height') {
            if (opts?.first) strokeAnchorV = vEffAt(p.plane, cx, cy)
            const nextPresence = t.heightPresence.slice()
            const nextValue = t.heightValue.slice()
            for (const [x, y] of tiles) {
              const idx = tileIndex(p.plane, x, y)
              let target: number
              if (p.mode === 'flatten') {
                target = strokeAnchorV
              } else if (p.mode === 'smooth') {
                // 3×3 average of the pre-stroke heights
                let sum = 0
                let n = 0
                for (let sx = -1; sx <= 1; sx++) {
                  for (let sy = -1; sy <= 1; sy++) {
                    const nx = Math.max(0, Math.min(63, x + sx))
                    const ny = Math.max(0, Math.min(63, y + sy))
                    sum += vEffAt(p.plane, nx, ny)
                    n++
                  }
                }
                target = Math.round(sum / n)
              } else {
                target = vEffAt(p.plane, x, y) + (p.mode === 'raise' ? p.step : -p.step)
              }
              target = Math.max(0, Math.min(255, target))
              // stored value 1 decodes to height 0 (client quirk) — so 0 and 1
              // both collapse to the sentinel
              nextValue[idx] = target <= 1 ? 1 : target
              nextPresence[idx >> 3] |= 1 << (idx & 0x7)
            }
            commit({ terrain: { ...t, heightPresence: nextPresence, heightValue: nextValue }, coalesce })
          } else if (p.tool === 'underlay') {
            const next = t.underlayIds.slice()
            for (const [x, y] of tiles) next[tileIndex(p.plane, x, y)] = p.underlayId & 0xff
            commit({ terrain: { ...t, underlayIds: next }, coalesce })
          } else if (p.tool === 'overlay') {
            const nextOverlay = t.overlayIds.slice()
            const nextShapeRot = t.overlayShapeRot.slice()
            for (const [x, y] of tiles) {
              const idx = tileIndex(p.plane, x, y)
              nextOverlay[idx] = p.overlayId & 0xff
              nextShapeRot[idx] = p.overlayId > 0
                ? (((p.overlayShape & 0xf) << 2) | (p.overlayRotation & 0x3)) & 0xff
                : 0
            }
            commit({ terrain: { ...t, overlayIds: nextOverlay, overlayShapeRot: nextShapeRot }, coalesce })
          } else {
            const next = t.tileFlags.slice()
            for (const [x, y] of tiles) {
              const idx = tileIndex(p.plane, x, y)
              next[idx] = p.flagSet ? (next[idx] | p.flagBit) : (next[idx] & ~p.flagBit)
            }
            commit({ terrain: { ...t, tileFlags: next }, coalesce })
          }
        }

        // View-tab marquee: project every centre-region loc and select those
        // whose anchor tile lands inside the dragged screen rectangle
        marqueeSelect = (x0, y0, x1, y1) => {
          const rect = renderer.domElement.getBoundingClientRect()
          const toNdc = (px: number, py: number) => ({
            x: ((px - rect.left) / rect.width) * 2 - 1,
            y: -((py - rect.top) / rect.height) * 2 + 1,
          })
          const a = toNdc(x0, y0)
          const b = toNdc(x1, y1)
          const minX = Math.min(a.x, b.x)
          const maxX = Math.max(a.x, b.x)
          const minY = Math.min(a.y, b.y)
          const maxY = Math.max(a.y, b.y)
          const list = objectsPropRef.current ?? data.def.objects
          const used = new Set<number>()
          const sel: number[] = []
          const v = new THREE.Vector3()
          for (const tagged of taggedRef.current) {
            if (tagged.neighbor || tagged.kind !== 'loc' || !tagged.obj.visible) continue
            const locs = (tagged.obj as THREE.Mesh).userData.locs as LocRef[] | undefined
            if (!locs) continue
            for (const loc of locs) {
              const h = centerHeights[loc.plane]?.[loc.x * VERTS + loc.y] ?? 0
              v.set((loc.x + 0.5) * TILE, -h, -((loc.y + 0.5) * TILE)).project(camera)
              if (v.x < minX || v.x > maxX || v.y < minY || v.y > maxY || v.z > 1) continue
              for (let i = 0; i < list.length; i++) {
                if (used.has(i)) continue
                const o = list[i]
                if (o[0] === loc.objectId && o[1] === loc.shape && o[2] === loc.rotation
                    && o[3] === loc.x && o[4] === loc.y && o[5] === loc.plane) {
                  used.add(i)
                  sel.push(i)
                  break
                }
              }
            }
          }
          setMultiSelRef.current(sel)
        }

        // unified partial rebuild for terrain AND placement edits: recompute
        // the mosaic, rebuild the centre's locs (whose static shadows feed
        // the terrain lighting), minimap, terrain and outline. Neighbour
        // meshes keep their old boundary values; only visible when brushing
        // the outermost tiles.
        rebuildCenterRef.current = async (nextTerrain, nextObjects) => {
          if (disposed) return
          currentTerrain = nextTerrain
          clearLocHighlight()
          setStatus('recomputing…')
          await new Promise((resolve) => setTimeout(resolve, 0)) // let the status paint
          regionGrid[1][1] = nextTerrain
          const nextMosaic = new SceneMosaic(regionGrid, data.def.regionX, data.def.regionY, configs, sun)
          if (disposed) return
          const slices = nextMosaic.slicesFor(0, 0)
          centerHeights = slices.heights
          const palettes = [0, 1, 2, 3].map((pl) => nextMosaic.paletteFor(0, 0, pl))
          const overlayCorners = [0, 1, 2, 3].map((pl) => nextMosaic.overlayCornerFor(0, 0, pl))
          const underlayCorners = [0, 1, 2, 3].map((pl) => nextMosaic.underlayCornerFor(0, 0, pl))

          const stale = taggedRef.current.filter((t) => !t.neighbor
            && (t.kind === 'terrain' || t.kind === 'outline' || t.kind === 'loc' || t.kind === 'marker'))
          taggedRef.current = taggedRef.current.filter((t) => !stale.includes(t))
          for (const { obj } of stale) {
            obj.parent?.remove(obj)
            disposeDeep(obj)
          }

          const locBuilds: (Awaited<ReturnType<typeof buildLocsMesh>> | null)[] = [null, null, null, null]
          if (nextObjects.length > 0) {
            for (let plane = 0; plane < 4; plane++) {
              locBuilds[plane] = await buildLocsMesh(
                nextTerrain, nextObjects, plane, centerHeights, assets,
                (done, total) => setStatus(`updating objects (plane ${plane}): ${done}/${total}`),
              )
              if (disposed) return
            }
          }
          const litShadowed = shadowLights(slices.lights, locBuilds)

          minimapBaseRef.current = await renderMinimapGround(nextTerrain, configs, 0, nextMosaic.underlayRgbBlurFor(0, 0, 0), assets)
          setMinimapVersion((v) => v + 1)

          for (let plane = 0; plane < 4; plane++) {
            setStatus(`rebuilding terrain (plane ${plane})…`)
            const terrainMesh = await buildTerrainMesh(nextTerrain, plane, centerHeights, configs, assets, {
              lights: litShadowed,
              palettes,
              overlayCorners,
              underlayCorners,
            })
            if (disposed) return
            if (terrainMesh) {
              terrainMesh.geometry.computeBoundsTree({ indirect: true })
              track(terrainMesh)
              applyTint(terrainMesh)
              planeGroupsRef.current[plane]?.add(terrainMesh)
              taggedRef.current.push({ obj: terrainMesh, neighbor: false, kind: 'terrain' })
            }
          }
          for (let plane = 0; plane < 4; plane++) {
            const built = locBuilds[plane]
            if (!built) continue
            if (built.mesh) {
              built.mesh.geometry.computeBoundsTree({ indirect: true })
              track(built.mesh)
              applyTint(built.mesh)
              planeGroupsRef.current[plane]?.add(built.mesh)
              taggedRef.current.push({ obj: built.mesh, neighbor: false, kind: 'loc' })
            }
            if (built.markers.length > 0) {
              const markerGroup = buildMarkersMesh(built.markers)
              if (markerGroup) {
                track(markerGroup)
                planeGroupsRef.current[plane]?.add(markerGroup)
                taggedRef.current.push({ obj: markerGroup, neighbor: false, kind: 'marker' })
              }
            }
          }
          const outline = buildRegionOutline(centerHeights[0], 0x2f8fff)
          track(outline)
          outlines.add(outline)
          taggedRef.current.push({ obj: outline, neighbor: false, kind: 'outline' })
          setStatus('')
        }
        setStatus('')
      } catch (e) {
        setStatus(`scene build failed: ${e}`)
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      cameraRef.current = null
      controlsRef.current = null
      for (const d of disposables) d.dispose()
      void assetsRef.current?.dispose()
      assetsRef.current = null
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      clearLocHighlight()
      ghostClearRef.current?.()
      highlightClearRef.current = null
      rebuildCenterRef.current = null
      selectFromListRef.current = null
      ghostUpdateRef.current = null
      ghostClearRef.current = null
      planeGroupsRef.current = [null, null, null, null]
      taggedRef.current = []
      skyMeshRef.current = null
    }
  }, [data])

  // placement draft changed (Apply/Delete/place/move): unified centre rebuild
  // — loc shadows feed the terrain lighting, so terrain rebuilds too.
  // `status` is a dep so an edit made mid-build is caught up when it finishes.
  useEffect(() => {
    if (!objects || objects === lastBuiltObjectsRef.current) return
    const rebuild = rebuildCenterRef.current
    if (!rebuild) return
    // the unified rebuild consumes BOTH drafts — mark both as built so a
    // combined commit (e.g. a stamp paste) doesn't rebuild twice
    lastBuiltObjectsRef.current = objects
    lastBuiltTerrainRef.current = terrainPropRef.current
    void rebuild(terrainPropRef.current ?? data.terrain, objects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, status])

  // terrain draft changed (brush): same unified rebuild
  useEffect(() => {
    if (!terrain || terrain === lastBuiltTerrainRef.current) return
    const rebuild = rebuildCenterRef.current
    if (!rebuild) return
    lastBuiltTerrainRef.current = terrain
    lastBuiltObjectsRef.current = objectsPropRef.current
    void rebuild(terrain, objectsPropRef.current ?? data.def.objects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain, status])

  // coordinate-search teleport: fly the camera to the focused tile. Runs
  // after the scene effect (declared below it), so on a cross-region jump the
  // fresh camera/controls are already in the refs.
  useEffect(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!focus || !camera || !controls) return
    const cx = (focus.x + 0.5) * 512
    const cz = -(focus.y + 0.5) * 512
    controls.target.set(cx, 0, cz)
    // high enough to see ~20 tiles of context around the target
    camera.position.set(cx, 8000, cz + 9500)
    controls.update()
    // data is a dep so a rebuild (e.g. after applying a loc edit) returns the
    // camera to the current position instead of the far default overview
  }, [focus, data])

  // close-button / cleared selection also drops the loc highlight
  useEffect(() => {
    if (!selection) highlightClearRef.current?.()
  }, [selection])

  // leaving Place mode (cancel, Esc, or a committed placement) drops the ghost
  useEffect(() => {
    if (!placing) ghostClearRef.current?.()
  }, [placing])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPlacing(false)
        setPasteArmed(false)
        setMultiSel([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // a teleport/rebuild invalidates the ghost machinery — exit Place mode
  useEffect(() => {
    setPlacing(false)
    setMultiSel([])
    setPasteArmed(false)
  }, [data])

  // the multi-selection indexes the objects draft — any edit invalidates it
  useEffect(() => {
    setMultiSel([])
  }, [objects])

  // hotkeys: V/P/T switch tabs, [ ] brush size, R rotates the place draft
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'v') setSideTab('view')
      else if (k === 'p') setSideTab('place')
      else if (k === 't') setSideTab('terrain')
      else if (k === '[' || k === ']') {
        setTerrainBrush((b) => {
          const i = BRUSH_SIZES.indexOf(b.size)
          const ni = Math.max(0, Math.min(BRUSH_SIZES.length - 1, i + (k === ']' ? 1 : -1)))
          return { ...b, size: BRUSH_SIZES[ni] }
        })
      } else if (k === 'r') {
        setPlaceDraft((d) => ({ ...d, rotation: (d.rotation + 1) % 4 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // resolve display names + map categories for the object list/minimap — the
  // scene build already cached every placed object's def, so these are memory hits
  const listEntries = objects ?? data.def.objects
  const [objCats, setObjCats] = useState<Map<number, number>>(new Map())
  const [objSprites, setObjSprites] = useState<Map<number, number>>(new Map())
  // objects with right-click options — the client draws their walls WHITE
  const [objInteractive, setObjInteractive] = useState<Set<number>>(new Set())
  // invisible utility objects seen in the region — the Place tab's marker
  // quick-picks (sound emitters, icon anchors, etc.)
  const [markerPicks, setMarkerPicks] = useState<{ objectId: number; kind: MarkerInfo['kind']; type: number }[]>([])
  useEffect(() => {
    if (status !== '') return
    const assets = assetsRef.current
    if (!assets) return
    let cancelled = false
    void (async () => {
      const names = new Map<number, string>()
      const cats = new Map<number, number>()
      const sprites = new Map<number, number>()
      const interactive = new Set<number>()
      const picks: { objectId: number; kind: MarkerInfo['kind']; type: number }[] = []
      await Promise.all([...new Set(listEntries.map((o) => o[0]))].map(async (id) => {
        try {
          const def = await assets.getDef(id)
          if (def?.name && def.name !== 'null') names.set(id, def.name)
          if (def?.mapCategoryId !== undefined && def.mapCategoryId >= 0) cats.set(id, def.mapCategoryId)
          if (def?.mapSpriteId !== undefined && def.mapSpriteId >= 0) sprites.set(id, def.mapSpriteId)
          if (def?.options?.some((o) => o != null)) interactive.add(id)
          // nameless utility objects = the marker anchors
          if (def && (!def.name || def.name === 'null')) {
            const kind: MarkerInfo['kind'] | null =
              def.soundId !== undefined || def.ambientSoundId !== undefined || (def.soundGroupIds?.length ?? 0) > 0
                ? 'sound'
                : def.mapCategoryId !== undefined && def.mapCategoryId >= 0
                  ? 'mapicon'
                  : def.mapSpriteId !== undefined && def.mapSpriteId >= 0
                    ? 'mapsprite'
                    : null
            if (kind) {
              const entry = listEntries.find((o) => o[0] === id)
              picks.push({ objectId: id, kind, type: entry?.[1] ?? 10 })
            }
          }
        } catch { /* def missing — row falls back to 'Object' */ }
      }))
      if (!cancelled) {
        setLocNames(names)
        setObjCats(cats)
        setObjSprites(sprites)
        setObjInteractive(interactive)
        setMarkerPicks(picks.sort((a, b) => a.kind.localeCompare(b.kind) || a.objectId - b.objectId))
      }
    })()
    return () => { cancelled = true }
  }, [listEntries, status])

  // world-map static elements: icons Jagex pinned at coordinates in the
  // MAP_AREAS index (see docs/worldmap.md) — world-map-only, overlaid here
  // as an editor aid so they're visible in context
  const [showWmIcons, setShowWmIcons] = useState(true)
  const [staticElements, setStaticElements] = useState<{ x: number; y: number; plane: number; areaId: number }[]>([])
  const [staticBitmaps, setStaticBitmaps] = useState<Map<number, ImageBitmap | null>>(new Map())
  useEffect(() => {
    const root = data.rootHandle
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const dir = await (await root.getDirectoryHandle('map_areas')).getDirectoryHandle('static_elements')
        const all: { x: number; y: number; plane: number; areaId: number }[] = []
        for await (const handle of dir.values()) {
          if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
          try {
            const entries = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as
              { x: number; y: number; plane: number; areaId: number }[]
            // keep only elements inside the centre region
            for (const e of entries) {
              if (e.x >> 6 === data.def.regionX && e.y >> 6 === data.def.regionY) all.push(e)
            }
          } catch { /* skip unreadable file */ }
        }
        if (!cancelled) setStaticElements(all)
      } catch {
        if (!cancelled) setStaticElements([]) // static_elements not dumped
      }
    })()
    return () => { cancelled = true }
  }, [data])
  useEffect(() => {
    const ids = [...new Set(staticElements.map((e) => e.areaId))]
    if (ids.length === 0) { setStaticBitmaps(new Map()); return }
    let cancelled = false
    void (async () => {
      const out = new Map<number, ImageBitmap | null>()
      await Promise.all(ids.map(async (areaId) => {
        const info = await loadAreaInfoRef.current(areaId)
        out.set(areaId, info?.bitmap ?? null)
      }))
      if (!cancelled) setStaticBitmaps(out)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticElements])

  // mapscene sprites for the minimap: mapSpriteId → sprite bitmap (the tree/
  // rock symbols the client stamps at placements)
  const [spriteBitmaps, setSpriteBitmaps] = useState<Map<number, ImageBitmap | null>>(new Map())
  const spriteBitmapCacheRef = useRef<Map<number, Promise<ImageBitmap | null>>>(new Map())
  useEffect(() => {
    const ids = [...new Set(objSprites.values())]
    if (ids.length === 0) { setSpriteBitmaps(new Map()); return }
    let cancelled = false
    void (async () => {
      const out = new Map<number, ImageBitmap | null>()
      await Promise.all(ids.map(async (mapSpriteId) => {
        let pending = spriteBitmapCacheRef.current.get(mapSpriteId)
        if (!pending) {
          pending = (async () => {
            try {
              const root = data.rootHandle
              if (!root) return null
              const cfgDir = await (await root.getDirectoryHandle('config')).getDirectoryHandle('map_sprites')
              const cfg = JSON.parse(await (await (await cfgDir.getFileHandle(`${mapSpriteId}.json`)).getFile()).text()) as { spriteId: number }
              if (cfg.spriteId < 0) return null
              const spriteDir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(cfg.spriteId))
              const png = await (await spriteDir.getFileHandle(`${cfg.spriteId}_0.png`)).getFile()
              return await createImageBitmap(png)
            } catch {
              return null
            }
          })()
          spriteBitmapCacheRef.current.set(mapSpriteId, pending)
        }
        out.set(mapSpriteId, await pending)
      }))
      if (!cancelled) setSpriteBitmaps(out)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objSprites])

  // map function icons for the minimap: mapCategoryId → area icon bitmap
  // (only areas flagged displayedOnMinimap)
  const [areaBitmaps, setAreaBitmaps] = useState<Map<number, ImageBitmap | null>>(new Map())
  useEffect(() => {
    const cats = [...new Set(objCats.values())]
    if (cats.length === 0) { setAreaBitmaps(new Map()); return }
    let cancelled = false
    void (async () => {
      const bitmaps = new Map<number, ImageBitmap | null>()
      await Promise.all(cats.map(async (cat) => {
        const info = await loadAreaInfoRef.current(cat)
        if (info?.minimap) bitmaps.set(cat, info.bitmap)
      }))
      if (!cancelled) setAreaBitmaps(bitmaps)
    })()
    return () => { cancelled = true }
  }, [objCats])

  // minimap: client-style — the mosaic's blurred+lit ground colours (from the
  // scene build), wall lines, mapscene sprites, and map function icons.
  useEffect(() => {
    const ctx = minimapRef.current?.getContext('2d')
    if (!ctx) return
    const P = 4 // client draws 4px per tile
    const base = minimapBaseRef.current
    const terrainNow = terrain ?? data.terrain

    // ground: prerendered by the scene build (blurred+lit, shape-masked),
    // run through the brightness LUT (client gamma vs our 0.7 base palette)
    if (base) {
      const adjusted = new Uint8ClampedArray(base.length)
      for (let i = 0; i < base.length; i += 4) {
        adjusted[i] = mmGammaLut[base[i]]
        adjusted[i + 1] = mmGammaLut[base[i + 1]]
        adjusted[i + 2] = mmGammaLut[base[i + 2]]
        adjusted[i + 3] = 255
      }
      ctx.putImageData(new ImageData(adjusted as Uint8ClampedArray<ArrayBuffer>, SIZE * P, SIZE * P), 0, 0)
    } else {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, SIZE * P, SIZE * P)
    }

    // wall lines (plane 0), client colours: plain walls near-white #EEEEEE,
    // interactive ones (doors, gates — anything with an option) red #EE0000.
    // ComponentMinimap.drawLocOnMinimap: types 0/2/3/9 only; objects with a
    // map sprite draw their sprite instead of a line (handled below).
    for (const e of listEntries) {
      if (e[5] !== 0) continue
      if (objSprites.has(e[0])) continue // sprite replaces the wall line
      const type = e[1]
      const rot = e[2]
      const left = e[3] * P
      const top = (SIZE - 1 - e[4]) * P
      ctx.fillStyle = objInteractive.has(e[0]) ? '#ee0000' : '#eeeeee'
      const edge = (r: number) => {
        if (r === 0) ctx.fillRect(left, top, 1, P) // west
        else if (r === 1) ctx.fillRect(left, top, P, 1) // north
        else if (r === 2) ctx.fillRect(left + P - 1, top, 1, P) // east
        else ctx.fillRect(left, top + P - 1, P, 1) // south
      }
      if (type === 0) edge(rot)
      else if (type === 2) { edge(rot); edge((rot + 1) & 3) }
      else if (type === 3) {
        // corner pixel: rot 0 NW, 1 NE, 2 SE, 3 SW (drawLocOnMinimap)
        const cxp = rot === 0 || rot === 3 ? left : left + P - 1
        const cyp = rot === 0 || rot === 1 ? top : top + P - 1
        ctx.fillRect(cxp, cyp, 1, 1)
      } else if (type === 9) {
        // diagonal wall
        for (let i = 0; i < P; i++) {
          ctx.fillRect((rot & 1) === 0 ? left + P - 1 - i : left + i, top + i, 1, 1)
        }
      }
    }

    // flags-tool aid: show blocked tiles only while painting flags
    if (sideTab === 'terrain' && terrainBrush.tool === 'flags') {
      ctx.fillStyle = 'rgba(255, 60, 60, 0.4)'
      for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
          if (terrainNow.tileFlags[tileIndex(terrainBrush.plane, x, y)] & terrainBrush.flagBit) {
            ctx.fillRect(x * P, (SIZE - 1 - y) * P, P, P)
          }
        }
      }
    }

    // mapscene sprites (tree/rock symbols), anchored at the placement tile
    for (const e of listEntries) {
      if (e[5] !== 0) continue
      const spriteId = objSprites.get(e[0])
      if (spriteId === undefined) continue
      const bmp = spriteBitmaps.get(spriteId)
      if (!bmp) continue
      ctx.drawImage(bmp, e[3] * P, (SIZE - 1 - e[4]) * P + P - bmp.height)
    }

    // map function icons on top, centred on their tile
    for (const e of listEntries) {
      const cat = objCats.get(e[0])
      if (cat === undefined || !areaBitmaps.has(cat)) continue
      const cx = e[3] * P + P / 2
      const cy = (SIZE - 1 - e[4]) * P + P / 2
      const bmp = areaBitmaps.get(cat)
      if (bmp) {
        ctx.drawImage(bmp, cx - bmp.width / 2, cy - bmp.height / 2)
      } else {
        ctx.fillStyle = '#b47aff'
        ctx.fillRect(cx - 2, cy - 2, 4, 4)
      }
    }

    // world-map static elements (dimmed + violet corner dot): these icons
    // exist only on the world map — shown here as an editor aid
    if (showWmIcons) {
      for (const e of staticElements) {
        if (e.plane !== 0) continue
        const lx = e.x & 63
        const ly = e.y & 63
        const cx = lx * P + P / 2
        const cy = (SIZE - 1 - ly) * P + P / 2
        const bmp = staticBitmaps.get(e.areaId)
        if (bmp) {
          ctx.globalAlpha = 0.75
          ctx.drawImage(bmp, cx - bmp.width / 2, cy - bmp.height / 2)
          ctx.globalAlpha = 1
          ctx.fillStyle = '#b47aff'
          ctx.fillRect(Math.round(cx + bmp.width / 2 - 2), Math.round(cy - bmp.height / 2), 2, 2)
        } else {
          ctx.fillStyle = '#b47aff'
          ctx.fillRect(cx - 2, cy - 2, 4, 4)
        }
      }
    }
  }, [data, terrain, listEntries, objCats, areaBitmaps, objSprites, spriteBitmaps, objInteractive, staticElements, staticBitmaps, showWmIcons, minimapVersion, sideTab, terrainBrush, mmGammaLut])

  useEffect(() => {
    if (skyMeshRef.current) skyMeshRef.current.visible = showSky
  }, [showSky, status])

  // visibility = plane toggle (via group) AND per-kind toggle AND neighbour toggle
  useEffect(() => {
    planeGroupsRef.current.forEach((group, plane) => {
      if (group) group.visible = visiblePlanes[plane]
    })
    for (const { obj, neighbor, kind } of taggedRef.current) {
      const kindOn = kind === 'loc' ? showLocs : kind === 'marker' ? showMarkers : kind === 'outline' ? showOutlines : true
      obj.visible = kindOn && (!neighbor || showNeighbors)
    }
  }, [visiblePlanes, showLocs, showMarkers, showOutlines, showNeighbors, status])

  return (
    <div className="mapscene">
      <div className="mapscene-controls">
        {[0, 1, 2, 3].map((plane) => (
          <label key={plane} className="mapscene-toggle">
            <input
              type="checkbox"
              checked={visiblePlanes[plane]}
              onChange={(e) => setVisiblePlanes((prev) => prev.map((v, i) => (i === plane ? e.target.checked : v)))}
            />
            Plane {plane}
          </label>
        ))}
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showLocs} onChange={(e) => setShowLocs(e.target.checked)} />
          Objects
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showNeighbors} onChange={(e) => setShowNeighbors(e.target.checked)} />
          Adjacent regions
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
          Region outlines
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showSky} onChange={(e) => setShowSky(e.target.checked)} />
          Sky
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
          <span className="mapscene-marker-key">
            Markers (<span style={{ color: '#ff9d3a' }}>sound</span>/<span style={{ color: '#b47aff' }}>map icon</span>/<span style={{ color: '#3ad0c8' }}>map sprite</span>/<span style={{ color: '#ff5a5a' }}>barrier</span>)
          </span>
        </label>
        <label className="mapscene-toggle" title="Icons pinned in the world map's own index (static elements) — they never appear on the real minimap; shown dimmed with a violet dot as an editor aid">
          <input type="checkbox" checked={showWmIcons} onChange={(e) => setShowWmIcons(e.target.checked)} />
          World-map icons
        </label>
        <label className="mapscene-toggle mapscene-gamma" title="Minimap palette gamma — the client's Brightness setting (higher = darker). Client defaults sit around 0.8–0.9.">
          Map brightness
          <input
            type="range"
            min={0.6}
            max={1.3}
            step={0.05}
            value={mmGamma}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              setMmGamma(v)
              localStorage.setItem('cache-editor:minimap-gamma-v2', String(v))
            }}
          />
          <span className="mapscene-gamma-value">{mmGamma.toFixed(2)}</span>
        </label>
        {status && <span className="mapscene-status">{status}</span>}
        {!status && hoverText && <span className="mapscene-hover">{hoverText}</span>}
      </div>
      <div className="mapscene-view">
        <div className="mapscene-canvas-wrap">
          <div ref={mountRef} className="mapscene-mount" />
          <div className="mapscene-minimap" title="Centre region, plane 0 — north up">
            <canvas ref={minimapRef} width={SIZE * 4} height={SIZE * 4} />
            <div ref={minimapCamRef} className="mapscene-minimap-cam" />
          </div>
          <div ref={marqueeDivRef} className="mapscene-marquee" />
        </div>
        <aside className="mapscene-side">
          <div className="map-mode-toggle mapscene-side-tabs">
            <button
              type="button"
              className={sideTab === 'view' ? 'selected' : ''}
              onClick={() => { setSideTab('view'); setPlacing(false) }}
            >
              View
            </button>
            <button
              type="button"
              className={sideTab === 'place' ? 'selected' : ''}
              onClick={() => setSideTab('place')}
            >
              Place
            </button>
            <button
              type="button"
              className={sideTab === 'terrain' ? 'selected' : ''}
              onClick={() => { setSideTab('terrain'); setPlacing(false) }}
            >
              Terrain
            </button>
          </div>
          {sideTab === 'terrain' && (
            <TerrainPanel
              brush={terrainBrush}
              onBrush={setTerrainBrush}
              canEdit={!!onEdit && status === ''}
              underlayColors={data.underlayColors}
              overlayColors={data.overlayColors}
              clipboard={clipboard}
              pasteArmed={pasteArmed}
              onPasteArm={() => setPasteArmed((v) => !v)}
              onClearClipboard={() => { setClipboard(null); setPasteArmed(false) }}
            />
          )}
          {sideTab === 'place' && (
            <PlacePanel
              draft={placeDraft}
              onDraft={setPlaceDraft}
              placing={placing}
              canPlace={!!onEdit && status === ''}
              name={locNames.get(placeDraft.objectId)}
              onToggle={() => setPlacing((v) => !v)}
              placeMultiple={placeMultiple}
              onPlaceMultiple={setPlaceMultiple}
              markerPicks={markerPicks}
              names={locNames}
              entries={listEntries}
            />
          )}
          {sideTab === 'view' && <>
          {multiSel.length > 0 && (
            <div className="mapscene-multisel">
              <span className="item-id-badge">{multiSel.length} objects selected</span>
              <div className="mapscene-side-actions">
                <button
                  type="button"
                  className="save-bar-discard mapscene-delete-btn"
                  onClick={() => {
                    const del = new Set(multiSel)
                    const next = listEntries.filter((_, i) => !del.has(i)).map((o) => [...o] as LocEntry)
                    onEdit?.({ objects: next })
                  }}
                >
                  Delete selected
                </button>
                <button type="button" className="save-bar-discard" onClick={() => setMultiSel([])}>Clear</button>
              </div>
            </div>
          )}
          {!selection && multiSel.length === 0 && (
            <p className="mapscene-side-hint">
              Click an object in the scene to inspect it; drag a selected object
              to move it. Shift+drag selects multiple objects. Alt+click in the
              Place/Terrain tabs samples what's under the cursor. Orbit with the
              middle mouse button, pan with the right.
            </p>
          )}
          {selection?.kind === 'marker' && (
            <>
              <div className="mapscene-side-head">
                <span className="enum-title mapscene-side-title">
                  <span
                    className="mapscene-info-dot"
                    style={{ background: `#${MARKER_COLORS[selection.markerKind].toString(16).padStart(6, '0')}` }}
                  />
                  {selection.markerKind === 'sound' ? 'Sound emitter'
                    : selection.markerKind === 'mapicon' ? 'Map icon anchor'
                    : selection.markerKind === 'mapsprite' ? 'Map sprite anchor'
                    : selection.markerKind === 'barrier' ? 'Barrier wall'
                    : 'Marker'}
                </span>
                <div className="item-badges">
                  <span className="item-id-badge">object {selection.objectId}</span>
                  {selection.lines.map((line, i) => <span key={i} className="item-id-badge">{line}</span>)}
                </div>
              </div>
              {(selection.spriteUrl || selection.areaSpriteUrl) && (
                <div className="mapscene-sprite-previews">
                  {selection.areaSpriteUrl && (
                    <div className="mapscene-sprite-preview">
                      <span className="item-field-label">Map icon</span>
                      <img src={selection.areaSpriteUrl} alt="map icon" />
                    </div>
                  )}
                  {selection.spriteUrl && (
                    <div className="mapscene-sprite-preview">
                      <span className="item-field-label">Minimap sprite</span>
                      <img src={selection.spriteUrl} alt="map sprite" />
                    </div>
                  )}
                </div>
              )}
              <div className="mapscene-side-actions">
                <button type="button" className="save-bar-discard" onClick={() => setSelection(null)}>Close</button>
              </div>
            </>
          )}
          {selection?.kind === 'loc' && (
            <LocPanel
              key={`${selection.regionX},${selection.regionY},${selection.index},${selection.objectId},${selection.x},${selection.y}`}
              sel={selection}
              onClose={() => setSelection(null)}
              onApply={onEdit ? (entry) => {
                const base = objects ?? data.def.objects
                const next = base.map((o) => [...o] as LocEntry)
                next[selection.index] = entry
                setSelection(null)
                onEdit({ objects: next })
              } : undefined}
              onDelete={onEdit ? () => {
                const base = objects ?? data.def.objects
                const next = base
                  .filter((_, i) => i !== selection.index)
                  .map((o) => [...o] as LocEntry)
                setSelection(null)
                onEdit({ objects: next })
              } : undefined}
            />
          )}
          <LocList
            entries={listEntries}
            names={locNames}
            selectedIndex={selection?.kind === 'loc' && selection.inCenter ? selection.index : -1}
            onPick={(entry, index) => selectFromListRef.current?.(entry, index)}
          />
          </>}
        </aside>
      </div>
    </div>
  )
}

// Colour-swatch picker for underlay/overlay ids. 0xff00ff is the "no colour"
// sentinel (texture-only overlays) — shown hatched with a T.
function SwatchPicker({ colors, selected, onPick, allowNone }: {
  colors: Map<number, number>
  selected: number
  onPick: (id: number) => void
  allowNone: boolean
}) {
  const ids = useMemo(() => [...colors.keys()].sort((a, b) => a - b), [colors])
  return (
    <div className="mapscene-swatches">
      {allowNone && (
        <button
          type="button"
          className={`mapscene-swatch mapscene-swatch-none${selected === 0 ? ' active' : ''}`}
          title="0 — none (erase)"
          onClick={() => onPick(0)}
        >
          ×
        </button>
      )}
      {ids.map((id) => {
        const rgb = colors.get(id)!
        const textured = rgb === 0xff00ff
        return (
          <button
            key={id}
            type="button"
            className={`mapscene-swatch${selected === id ? ' active' : ''}${textured ? ' mapscene-swatch-tex' : ''}`}
            style={textured ? undefined : { background: rgbToRenderedHex(rgb) }}
            title={`${id}${textured ? ' — texture only (no flat colour)' : ''}`}
            onClick={() => onPick(id)}
          >
            {textured ? 'T' : ''}
          </button>
        )
      })}
    </div>
  )
}

// Terrain brush: while this tab is open, a green ring follows the cursor.
// Tools: heights (raise/lower/flatten/smooth), underlay/overlay paint, flags.
function TerrainPanel({ brush, onBrush, canEdit, underlayColors, overlayColors, clipboard, pasteArmed, onPasteArm, onClearClipboard }: {
  brush: TerrainBrush
  onBrush: (next: TerrainBrush) => void
  canEdit: boolean
  underlayColors: Map<number, number>
  overlayColors: Map<number, number>
  clipboard: StampClipboard | null
  pasteArmed: boolean
  onPasteArm: () => void
  onClearClipboard: () => void
}) {
  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">Terrain brush</span>
      </div>
      <p className="mapscene-side-hint">
        {canEdit
          ? 'The green ring is the brush — click or drag to paint (centre region only). Alt+click samples the tile into the brush; Shift+drag copies an area. Orbit with the middle mouse, pan with the right. [ and ] resize the brush.'
          : 'Waiting for the scene build to finish…'}
      </p>
      <div className="mapscene-side-grid">
        <div className="item-field">
          <span className="item-field-label">Tool</span>
          <div className="mapscene-btn-row">
            {([['height', 'Heights'], ['underlay', 'Under'], ['overlay', 'Over'], ['flags', 'Flags']] as const).map(([tool, label]) => (
              <button
                key={tool}
                type="button"
                className={`zoom-btn${brush.tool === tool ? ' active' : ''}`}
                onClick={() => onBrush({ ...brush, tool })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="item-field">
          <span className="item-field-label">Brush size (tiles across)</span>
          <div className="mapscene-btn-row">
            {BRUSH_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                className={`zoom-btn${brush.size === s ? ' active' : ''}`}
                onClick={() => onBrush({ ...brush, size: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="item-field">
          <span className="item-field-label">Plane</span>
          <div className="mapscene-btn-row">
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                className={`zoom-btn${brush.plane === p ? ' active' : ''}`}
                onClick={() => onBrush({ ...brush, plane: p })}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {brush.tool === 'height' && <>
          <div className="item-field">
            <span className="item-field-label">Mode</span>
            <div className="mapscene-btn-row">
              {([['raise', '+ Raise', 'Each click/stroke raises the terrain'],
                 ['lower', '− Lower', 'Each click/stroke lowers the terrain'],
                 ['flatten', 'Flatten', 'Level everything to the height where the stroke started'],
                 ['smooth', 'Smooth', 'Blend each tile toward its neighbours']] as const).map(([mode, label, title]) => (
                <button
                  key={mode}
                  type="button"
                  className={`zoom-btn${brush.mode === mode ? ' active' : ''}`}
                  title={title}
                  onClick={() => onBrush({ ...brush, mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {(brush.mode === 'raise' || brush.mode === 'lower') && (
            <label className="item-field">
              <span className="item-field-label">Strength — height units per click</span>
              <NumberInput value={brush.step} onChange={(v) => onBrush({ ...brush, step: v })} min={1} max={64} />
            </label>
          )}
        </>}

        {brush.tool === 'flags' && <>
          <div className="item-field">
            <span className="item-field-label">Flag bit</span>
            <div className="mapscene-btn-row">
              {([[0x1, 'Blocked'], [0x2, 'Bridge'], [0x4, '0x4'], [0x8, '0x8']] as const).map(([bit, label]) => (
                <button
                  key={bit}
                  type="button"
                  className={`zoom-btn${brush.flagBit === bit ? ' active' : ''}`}
                  onClick={() => onBrush({ ...brush, flagBit: bit })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="item-field">
            <span className="item-field-label">Mode</span>
            <div className="mapscene-btn-row">
              <button type="button" className={`zoom-btn${brush.flagSet ? ' active' : ''}`} onClick={() => onBrush({ ...brush, flagSet: true })}>Set</button>
              <button type="button" className={`zoom-btn${!brush.flagSet ? ' active' : ''}`} onClick={() => onBrush({ ...brush, flagSet: false })}>Clear</button>
            </div>
          </div>
        </>}

        {brush.tool === 'underlay' && (
          <div className="item-field">
            <span className="item-field-label">Underlay — {brush.underlayId === 0 ? 'none' : brush.underlayId}</span>
            <SwatchPicker
              colors={underlayColors}
              selected={brush.underlayId}
              onPick={(id) => onBrush({ ...brush, underlayId: id })}
              allowNone
            />
          </div>
        )}

        {brush.tool === 'overlay' && <>
          <div className="item-field">
            <span className="item-field-label">Overlay — {brush.overlayId === 0 ? 'none (clear)' : brush.overlayId}</span>
            <SwatchPicker
              colors={overlayColors}
              selected={brush.overlayId}
              onPick={(id) => onBrush({ ...brush, overlayId: id })}
              allowNone
            />
          </div>
          <label className="item-field">
            <span className="item-field-label">Shape (0 = full tile)</span>
            <NumberInput value={brush.overlayShape} onChange={(v) => onBrush({ ...brush, overlayShape: v })} min={0} max={11} />
          </label>
          <div className="item-field">
            <span className="item-field-label">Rotation</span>
            <div className="mapscene-btn-row">
              {ROTATION_LABELS.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className={`zoom-btn${brush.overlayRotation === i ? ' active' : ''}`}
                  title={r.title}
                  onClick={() => onBrush({ ...brush, overlayRotation: i })}
                >
                  {i} · {r.dir}
                </button>
              ))}
            </div>
          </div>
        </>}
        <div className="item-field">
          <span className="item-field-label">
            Area stamp {clipboard ? `— ${clipboard.w}×${clipboard.h}, ${clipboard.objects.length} objects` : ''}
          </span>
          {clipboard ? (
            <div className="mapscene-side-actions">
              <button
                type="button"
                className={pasteArmed ? 'save-bar-discard' : 'save-bar-save'}
                onClick={onPasteArm}
              >
                {pasteArmed ? 'Cancel paste' : 'Paste'}
              </button>
              <button type="button" className="save-bar-discard" onClick={onClearClipboard}>Clear</button>
            </div>
          ) : (
            <span className="mapscene-field-value">Shift+drag an area to copy it</span>
          )}
        </div>
      </div>
      <p className="mapscene-side-hint">
        {brush.tool === 'height'
          ? 'One height unit is 32 client units — 30 is roughly a full storey. A drag applies one uniform step across the stroke; release and drag again to stack. Edited tiles become explicit heights (the noise default no longer applies).'
          : brush.tool === 'underlay'
          ? 'Underlays are the blended ground colour. Colours come from the underlay config; painting 0 removes the ground colour entirely.'
          : brush.tool === 'overlay'
          ? 'Overlays sit over the ground: paths, water, floors. T swatches are texture-only overlays. Painting 0 clears the overlay and its shape.'
          : 'Flag bits are invisible in 3D but show on the minimap/2D view (blocked = red tint). Bit 0x1 blocks movement; 0x2 on plane 1 marks bridges.'}
        {' '}When paste is armed, a click stamps the copied area with its south-west corner on the clicked tile. Changes go through the save bar; Ctrl+Z undoes.
      </p>
    </>
  )
}

// Place mode: configure the object to add, arm placement, then click a tile
// in the scene — a translucent ghost follows the cursor until then.
function PlacePanel({ draft, onDraft, placing, canPlace, name, onToggle, placeMultiple, onPlaceMultiple, markerPicks, names, entries }: {
  draft: PlaceDraft
  onDraft: (next: PlaceDraft) => void
  placing: boolean
  canPlace: boolean
  name?: string
  onToggle: () => void
  placeMultiple: boolean
  onPlaceMultiple: (v: boolean) => void
  markerPicks: { objectId: number; kind: MarkerInfo['kind']; type: number }[]
  names: Map<number, string>
  entries: LocEntry[]
}) {
  const slot = OBJECT_SLOTS[draft.type] ?? 2
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const seen = new Set<number>()
    const out: { id: number; name: string; type: number }[] = []
    for (const [id, n] of names) {
      if (!n.toLowerCase().includes(q) || seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: n, type: entries.find((e) => e[0] === id)?.[1] ?? 10 })
      if (out.length >= 8) break
    }
    return out
  }, [query, names, entries])
  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">
          Place object
          {name && <span className="mapscene-side-id">— {name}</span>}
        </span>
      </div>
      <p className="mapscene-side-hint">
        Set the object up, hit Place, then move over the scene — a translucent
        preview follows the cursor and a click drops it (centre region only).
        R rotates while placing; Alt+click any object to copy its setup here;
        Esc backs out.
      </p>
      <div className="item-field mapscene-place-search">
        <span className="item-field-label">Find by name — objects in this area</span>
        <input
          className="mapscene-loclist-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. tree, fern, fence"
        />
        {matches.length > 0 && (
          <div className="mapscene-place-matches">
            {matches.map((m) => (
              <button
                key={m.id}
                type="button"
                className="mapscene-loclist-row"
                onClick={() => { onDraft({ ...draft, objectId: m.id, type: m.type }); setQuery('') }}
              >
                <span className="mapscene-loclist-name">{m.name} ({m.id})</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {markerPicks.length > 0 && (
        <div className="item-field mapscene-place-search">
          <span className="item-field-label">Markers seen in this region</span>
          <div className="mapscene-marker-chips">
            {markerPicks.map((m) => (
              <button
                key={m.objectId}
                type="button"
                className="mapscene-marker-chip"
                title={`object ${m.objectId}`}
                style={{ borderColor: `#${MARKER_COLORS[m.kind].toString(16).padStart(6, '0')}` }}
                onClick={() => onDraft({ ...draft, objectId: m.objectId, type: m.type })}
              >
                <span className="mapscene-info-dot" style={{ background: `#${MARKER_COLORS[m.kind].toString(16).padStart(6, '0')}` }} />
                {m.kind} {m.objectId}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mapscene-side-grid">
        <label className="item-field">
          <span className="item-field-label">Object ID</span>
          <NumberInput value={draft.objectId} onChange={(v) => onDraft({ ...draft, objectId: v })} min={0} max={131071} />
        </label>
        <div className="item-field">
          <span className="item-field-label">Type — {SLOT_LABELS[slot]} slot</span>
          <select
            className="item-stackable-select"
            value={draft.type}
            onChange={(e) => onDraft({ ...draft, type: Number(e.target.value) })}
          >
            {LOC_TYPE_LABELS.map((label, i) => (
              <option key={i} value={i}>{i} — {label}</option>
            ))}
          </select>
        </div>
        <div className="item-field">
          <span className="item-field-label">Rotation</span>
          <div className="mapscene-btn-row">
            {ROTATION_LABELS.map((r, i) => (
              <button
                key={i}
                type="button"
                className={`zoom-btn${draft.rotation === i ? ' active' : ''}`}
                title={r.title}
                onClick={() => onDraft({ ...draft, rotation: i })}
              >
                {i} · {r.dir}
              </button>
            ))}
          </div>
        </div>
        <div className="item-field">
          <span className="item-field-label">Plane</span>
          <div className="mapscene-btn-row">
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                className={`zoom-btn${draft.plane === p ? ' active' : ''}`}
                onClick={() => onDraft({ ...draft, plane: p })}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mapscene-side-actions">
        <button
          type="button"
          className={placing ? 'save-bar-discard' : 'save-bar-save'}
          disabled={!canPlace}
          onClick={onToggle}
        >
          {placing ? 'Cancel (Esc)' : 'Place'}
        </button>
      </div>
      <label className="mapscene-toggle mapscene-place-multi">
        <input type="checkbox" checked={placeMultiple} onChange={(e) => onPlaceMultiple(e.target.checked)} />
        Place multiple (stay armed after each drop)
      </label>
    </>
  )
}

// All placed objects in the centre region: filterable, virtualized (regions
// carry up to ~2000 placements), row click selects + flies the camera there.
function LocList({ entries, names, selectedIndex, onPick }: {
  entries: LocEntry[]
  names: Map<number, string>
  selectedIndex: number
  onPick: (entry: LocEntry, index: number) => void
}) {
  const [filter, setFilter] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const rows = entries.map((e, i) => ({ e, i }))
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(({ e }) =>
      String(e[0]).includes(q)
      || (names.get(e[0])?.toLowerCase().includes(q) ?? false)
      || `${e[3]},${e[4]}`.includes(q))
  }, [entries, names, filter])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  })

  // scene-click selections scroll their row into view
  useEffect(() => {
    if (selectedIndex < 0) return
    const pos = filtered.findIndex((r) => r.i === selectedIndex)
    if (pos >= 0) virtualizer.scrollToIndex(pos, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex])

  return (
    <div className="mapscene-loclist">
      <div className="mapscene-loclist-head">
        <span className="item-field-label">Objects — {filtered.length}{filter ? ` of ${entries.length}` : ''}</span>
        <input
          className="mapscene-loclist-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by name, id or x,y"
        />
      </div>
      <div ref={scrollRef} className="mapscene-loclist-scroll">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const { e, i } = filtered[vi.index]
            return (
              <button
                key={vi.key}
                type="button"
                className={`mapscene-loclist-row${i === selectedIndex ? ' active' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vi.size, transform: `translateY(${vi.start}px)` }}
                onClick={() => onPick(e, i)}
                title={`${LOC_TYPE_LABELS[e[1]] ?? 'type ' + e[1]}, rotation ${e[2]}`}
              >
                <span className="mapscene-loclist-dot" style={{ background: SLOT_COLORS[OBJECT_SLOTS[e[1]] ?? 2] }} />
                <span className="mapscene-loclist-name">{names.get(e[0]) ?? 'Object'} ({e[0]})</span>
                <span className="mapscene-loclist-pos">{e[3]},{e[4]} · p{e[5]}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Rotation steps are 90° clockwise from above; for walls the step picks the
// tile edge the wall sits on (0 = west edge), which is the client convention.
const ROTATION_LABELS = [
  { dir: 'W', title: 'West — 0°' },
  { dir: 'N', title: 'North — 90°' },
  { dir: 'E', title: 'East — 180°' },
  { dir: 'S', title: 'South — 270°' },
]

// Editable details for a picked loc. Draft state is local; Apply hands the
// updated placement entry to the parent (which rebuilds the scene with it).
function LocPanel({ sel, onClose, onApply, onDelete }: {
  sel: LocSelection
  onClose: () => void
  onApply?: (entry: LocEntry) => void
  onDelete?: () => void
}) {
  const [draft, setDraft] = useState({
    objectId: sel.objectId, type: sel.type, rotation: sel.rotation,
    x: sel.x, y: sel.y, plane: sel.plane,
  })
  const changed = draft.objectId !== sel.objectId || draft.type !== sel.type
    || draft.rotation !== sel.rotation || draft.x !== sel.x || draft.y !== sel.y
    || draft.plane !== sel.plane
  const canEdit = sel.editable && !!onApply
  const slot = OBJECT_SLOTS[draft.type] ?? 2

  const field = (label: string, key: keyof typeof draft, max: number) => (
    <label className="item-field">
      <span className="item-field-label">{label}</span>
      {canEdit
        ? <NumberInput value={draft[key]} onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))} min={0} max={max} />
        : <span className="mapscene-field-value">{draft[key]}</span>}
    </label>
  )

  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">
          {sel.name} <span className="mapscene-side-id">({sel.objectId})</span>
        </span>
        <div className="item-badges">
          <span className="item-id-badge">world {sel.regionX * 64 + sel.x}, {sel.regionY * 64 + sel.y}</span>
          <span className="item-id-badge">plane {sel.plane}</span>
          <span className="item-id-badge">size {sel.sizeX}×{sel.sizeY}</span>
          {sel.models && <span className="item-id-badge">models {sel.models}</span>}
          {sel.mapSpriteId >= 0 && <span className="item-id-badge">map sprite {sel.mapSpriteId}</span>}
          {sel.mapCategoryId >= 0 && (
            <span className="item-id-badge">map icon {sel.mapCategoryId}{sel.areaName ? ` — ${sel.areaName}` : ''}</span>
          )}
        </div>
      </div>
      {(sel.spriteUrl || sel.areaSpriteUrl) && (
        <div className="mapscene-sprite-previews">
          {sel.areaSpriteUrl && (
            <div className="mapscene-sprite-preview">
              <span className="item-field-label">Map icon</span>
              <img src={sel.areaSpriteUrl} alt="map icon" />
            </div>
          )}
          {sel.spriteUrl && (
            <div className="mapscene-sprite-preview">
              <span className="item-field-label">Minimap sprite</span>
              <img src={sel.spriteUrl} alt="map sprite" />
            </div>
          )}
        </div>
      )}
      {!sel.editable && (
        <p className="mapscene-side-hint">
          {!sel.inCenter
            ? 'In a neighbouring region — teleport there to edit it.'
            : 'This placement could not be matched for editing.'}
        </p>
      )}

      <div className="mapscene-side-grid">
        {field('Object ID', 'objectId', 131071)}
        <div className="item-field">
          <span className="item-field-label">Type — {SLOT_LABELS[slot]} slot</span>
          {canEdit ? (
            <select
              className="item-stackable-select"
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: Number(e.target.value) }))}
            >
              {LOC_TYPE_LABELS.map((label, i) => (
                <option key={i} value={i}>{i} — {label}</option>
              ))}
            </select>
          ) : (
            <span className="mapscene-field-value">
              {draft.type} — {LOC_TYPE_LABELS[draft.type] ?? '?'}
            </span>
          )}
        </div>
        <div className="item-field">
          <span className="item-field-label">Rotation</span>
          {canEdit ? (
            <div className="mapscene-btn-row">
              {ROTATION_LABELS.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className={`zoom-btn${draft.rotation === i ? ' active' : ''}`}
                  title={r.title}
                  onClick={() => setDraft((d) => ({ ...d, rotation: i }))}
                >
                  {i} · {r.dir}
                </button>
              ))}
            </div>
          ) : (
            <span className="mapscene-field-value">
              {draft.rotation} · {ROTATION_LABELS[draft.rotation]?.dir}
            </span>
          )}
        </div>
        {field('Local X (0–63)', 'x', 63)}
        {field('Local Y (0–63)', 'y', 63)}
        <div className="item-field">
          <span className="item-field-label">Plane</span>
          {canEdit ? (
            <div className="mapscene-btn-row">
              {[0, 1, 2, 3].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`zoom-btn${draft.plane === p ? ' active' : ''}`}
                  onClick={() => setDraft((d) => ({ ...d, plane: p }))}
                >
                  {p}
                </button>
              ))}
            </div>
          ) : (
            <span className="mapscene-field-value">{draft.plane}</span>
          )}
        </div>
      </div>

      <div className="mapscene-side-actions">
        {canEdit && (
          <button
            type="button"
            className="save-bar-save"
            disabled={!changed}
            onClick={() => onApply!([draft.objectId, draft.type, draft.rotation, draft.x, draft.y, draft.plane])}
          >
            Apply
          </button>
        )}
        {canEdit && (
          <button type="button" className="save-bar-discard mapscene-delete-btn" onClick={onDelete}>Delete</button>
        )}
        <button type="button" className="save-bar-discard" onClick={onClose}>Cancel</button>
      </div>
    </>
  )
}
