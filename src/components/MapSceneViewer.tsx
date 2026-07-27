import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ClientBloomPass } from './clientBloom'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { LocEntry, MapData, MapRegionDef, MapTerrain } from '../loaders/maps'
import { SIZE, decodeTerrain, decodeUnderwaterTerrain, tileIndex, OBJECT_SLOTS, SLOT_COLORS, SLOT_LABELS, LOC_TYPE_LABELS } from '../loaders/maps'
import { rgbToRenderedHex, DEFAULT_MODEL_SUN } from '../loaders/models'
import { NumberInput } from './defFields'
import { buildTerrainMesh, buildLocsMesh, buildMarkersMesh, buildLightsMesh, buildChunkGrid, buildSkyboxMesh, renderMinimapGround, loadRegionEnvironment, loadSceneConfigs, buildLightGrid, lightRadius, lightRgb, lightScenePos, lightRangesFor, LocAssets, SceneMosaic, DEFAULT_SUN, MARKER_COLORS, computeWaterDepth, computeRiverbedHeights, buildAnimatedLocMesh, markerKindFromDef } from './mapScene'
import { LocAnimator } from './locAnimator'
import type { AnimationDef } from '../loaders/animations'
import type { ModelData } from '../loaders/models'
import type { SceneConfigs, LocRef, MarkerInfo, ObjectDefJson, RegionLight, SunConfig } from './mapScene'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import ObjectDefEditor from './ObjectDefEditor'
import type { AreaInfo, MapSpriteInfo } from './ObjectDefEditor'
import './MapSceneViewer.css'

// 3D scene preview of a map region and its 8 neighbours (the client always
// builds a 3×3 block — buildings that straddle a region boundary only look
// right with the neighbours present). The chunk grid and floating markers
// (sound emitters / map-icon anchors) are editor aids on top.
// See mapScene.ts for the ported client pipeline.

const REGION_UNITS = SIZE * 512
// The client draws opaque objects, THEN the ground, THEN transparent objects
// (SceneObjectManager.method3441). renderOrder is three.js's primary sort key in
// both passes, so mirroring that order here is what stops water compositing over
// foliage that stands in front of it.
/** The client's graphics preferences (`ClientPreferences`, `client/prefs/impl/*`)
 *  with the default each one ships with, and what our renderer actually does about
 *  it. Reference table only — we don't read or write the client's prefs file; this
 *  exists so we can see at a glance which client behaviour we mirror. Defaults were
 *  read from each Preference's `getDefaultValue()`. */
type GfxStatus = 'applied' | 'partial' | 'no' | 'n/a'
/** `control` marks the rows that are live in the editor — they render their
 *  pill/slider inline so each setting, its control and its description live
 *  together in one place. */
const CLIENT_GFX_SETTINGS: { name: string; def: string; status: GfxStatus; note: string; control?: 'bloom' | 'fog' | 'drawDistance' | 'brightness' }[] = [
  { name: 'Bloom', def: '0 (off)', status: 'applied', control: 'bloom', note: 'Client FilterBloom: luminance threshold 1.0, additive strength 0.25. HDR overbright textures only load while bloom is on, exactly like the client.' },
  { name: 'Fog', def: '1', status: 'applied', control: 'fog', note: 'Client formula: linear fog ending at the draw distance, fading over the last (fogDepth+256)·4 units, colour and depth from the region environment. Applies at every lighting-detail setting; water and sky handled.' },
  { name: 'Draw distance', def: 'unknowable', status: 'n/a', control: 'drawDistance', note: 'The fog end point — the client’s projection far plane, a graphics setting the cache can’t tell us. ~24 tiles matches a client-like zoom; the editor default sits further out so the overhead view stays clear.' },
  { name: 'Brightness', def: '3', status: 'applied', control: 'brightness', note: 'Scene ambient ×(0.7 + 0.1·b), exactly the client’s IA(). Baked into vertex colours, so changing it rebuilds the scene. Match your client’s setting when comparing. The minimap has its own gamma slider.' },
  { name: 'Ground blending', def: '1', status: 'applied', note: 'Underlay/overlay corner blending + the crossfade splat pass.' },
  { name: 'Ground decoration', def: '1', status: 'applied', note: 'Ground-decor locs are built.' },
  { name: 'Idle animations', def: '1', status: 'applied', note: 'Loc idle sequences are posed each frame.' },
  { name: 'Flickering effects', def: '1', status: 'applied', note: 'Type-5 face-alpha animation (fireplace/candle flames).' },
  { name: 'Textures', def: '1', status: 'applied', note: 'Material textures on terrain and locs.' },
  { name: 'Water', def: '1', status: 'applied', note: 'Env-mapped water surface + underwater depth; colour not signed off.' },
  { name: 'Sky boxes', def: '1', status: 'applied', note: 'Skybox mesh from the region environment (toggleable).' },
  { name: 'Light detail', def: '1', status: 'partial', note: 'We render the LOW path, calibrated against the client (MeshRasterizer_Sub3 CPU bake + HardwareGround). The HIGH path — region sun, shader-lit ground, ground point lights — is not built.' },
  { name: 'Scenery shadows', def: '2', status: 'partial', note: 'Static shadow grid only — no projected/dynamic scenery shadows.' },
  { name: 'Anti-aliasing', def: '0 (off)', status: 'applied', note: 'WebGL antialias is ON — deliberately differs from the client default.' },
  { name: 'Build area', def: '104 tiles', status: 'no', note: 'We render one 64×64 region; neighbours are decoded for seam-free lighting only.' },
  { name: 'Particles', def: '2 (0 on low RAM)', status: 'no', note: 'Model particle emitters are parsed but not simulated in the map view.' },
  { name: 'Character shadows', def: '1', status: 'no', note: 'No NPCs/players in the map view.' },
  { name: 'Remove roofs', def: '2', status: 'no', note: 'We use per-plane toggles instead of the client’s roof-removal rule.' },
  { name: 'Graphics preset', def: '0', status: 'n/a', note: 'Preset selector that drives the others; no equivalent here.' },
  { name: 'Max screen size', def: 'toolkit-dependent', status: 'n/a', note: 'Canvas sizing is the browser’s.' },
  { name: 'Custom cursors', def: '1', status: 'n/a', note: 'Editor UI concern, not the 3D view.' },
]

const ORDER_RIVERBED = -2
const ORDER_OPAQUE_LOC = -1
const ORDER_TERRAIN = 0
const ORDER_TRANSPARENT_LOC = 1

// BVH-accelerated raycasting: the merged terrain/locs meshes are hundreds of
// thousands of triangles — brute-force raycasts on every mouse move are the
// main source of pointer stutter. Meshes without a boundsTree still fall back
// to the stock raycast.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

// Env-mapped water — mirrors the client's water fragment shader (dumped GLSL
// "EnvMappedWater", 1_1.frag, non-`waves` branch):
//   SurfaceColour.rgb = EnvColour + (Diffuse + Specular) * shoreFactor * SunColour
//   EnvColour = textureCube(EnvMap, reflect(view, waveNormal))
// The client's EnvMap is a sky cube; we synthesise that sky procedurally from the
// reflection direction (zenith→horizon gradient) so it never depends on a captured
// cube. Wave normal is procedural here (the client samples an animated 3D normal
// texture). shoreFactor (depth-based transparency) is not modelled yet — there's no
// underwater riverbed layer to reveal, so the surface is opaque (shoreFactor = 1).
const WATER_VERT = `
  attribute float waterDepth;
  varying vec3 vWorldPos;
  varying vec3 vViewVec;
  varying float vDepth;
  varying float vFogDepth;
  uniform vec3 uEyePos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vViewVec = uEyePos - wp.xyz;
    vDepth = waterDepth;
    vFogDepth = -(viewMatrix * wp).z;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`
// Mirrors the client EnvMappedWater fragment (1_1.frag, non-`waves` branch):
//   SurfaceColour.rgb = EnvColour + (Diffuse + Specular) * shoreFactor * SunColour
//   SurfaceColour.a   = Fresnel * shoreFactor * smoothstep(depth/40)
// with shoreFactor = clamp(depth/breakWaterDepth, 0, 1). The surface is
// transparent — shallow water (low depth) fades to clear so the riverbed mesh
// beneath shows through (sandy shores); deep water reflects the sky. The
// EnvMap is synthesised as a procedural sky. breakWaterDepth/specExp are the
// client's literal constants (256 / 32).
const WATER_FRAG = `
  precision highp float;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uDeepTint;
  uniform float uSpecExp;
  uniform float uBreakDepth;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorldPos;
  varying vec3 vViewVec;
  varying float vDepth;
  varying float vFogDepth;
  vec3 skyEnv(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    return mix(uSkyHorizon, uSkyZenith, pow(up, 0.55));
  }
  void main() {
    vec2 p = vWorldPos.xz * 0.006;
    float t = uTime * 0.55;
    vec3 n = normalize(vec3(
      sin(p.x * 1.5 + t) * 0.05 + sin(p.x * 3.1 - p.y * 2.0 + t * 1.7) * 0.022,
      1.0,
      cos(p.y * 1.3 + t * 1.1) * 0.05 + sin(p.x * 2.2 + p.y * 2.7 - t * 1.3) * 0.022
    ));
    vec3 E = normalize(vViewVec);
    vec3 R = reflect(-E, n);
    vec3 sun = normalize(uSunDir);
    vec3 env = skyEnv(R);
    float fres = 1.0 - abs(dot(R, n));
    float spec = pow(clamp(dot(sun, R), 0.0, 1.0), uSpecExp) * 0.5;
    float diffuse = max(0.0, dot(sun, n)) * (1.0 - fres) * 0.25;
    float shore = clamp(vDepth / uBreakDepth, 0.0, 1.0);
    float depthFade = smoothstep(0.0, 1.0, clamp(vDepth / 40.0, 0.0, 1.0));
    // Deep water reads as a saturated dark blue and is nearly opaque (the sandy
    // riverbed must NOT bleed through the centre); shallow shores fade to clear
    // so the bed shows. alpha rises steeply with depth (shore²).
    vec3 colour = mix(env, uDeepTint, shore * 0.8) + (diffuse + spec) * shore * uSunColour;
    float alpha = depthFade * clamp(shore * shore * 0.9 + shore * 0.2 + fres * shore * 0.35, 0.0, 1.0);
    // Region distance fog, same linear ramp scene.fog applies to everything
    // else — without it the river stays crisp while its banks haze out. Alpha
    // rises with the fog too: fully fogged water is a wall of fog, not a
    // window onto an (equally fogged) riverbed.
    float fogF = clamp((vFogDepth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    colour = mix(colour, uFogColor, fogF);
    alpha = mix(alpha, 1.0, fogF);
    gl_FragColor = vec4(colour, alpha);
  }
`

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
  /** The object definition behind this placement — the draft one when it's
   *  being edited. Everything except the six placement fields above lives
   *  here, and is shared by every placement of the object. Null until the
   *  async read lands. */
  def: ObjectDefJson | null
}

/** A scene object the build tracks so later passes can find it by role. */
type Tagged = { obj: THREE.Object3D; neighbor: boolean; kind: 'terrain' | 'riverbed' | 'loc' | 'marker' | 'light' | 'outline' }
/** Which tagged kinds the sun tint / HDR multiplier is allowed to touch: the
 *  world geometry only. `applyTint` OVERWRITES `material.color` (world materials
 *  keep their colour in vertex colours, so there's nothing to preserve), which
 *  erases the colour of any overlay that carries it in the material instead —
 *  light gizmos, marker diamonds, the chunk grid. */
const TINTED_KINDS: Tagged['kind'][] = ['terrain', 'riverbed', 'loc']

/** Above this many changed placements the targeted patch stops being a win —
 *  each added loc costs its own mesh and draw call, so a big paste is better
 *  off re-merging once. Drags, rotations, places and deletes are all 1-2. */
const PATCH_LIMIT = 8

type MarkerSelection = {
  kind: 'marker'
  markerKind: MarkerInfo['kind']
  /** the kind to fall back to when an edit clears every id field */
  fallback: 'barrier' | 'other'
  objectId: number
  /** the placement's shape, so the panel can tell which slot it sits in */
  type: number
  worldX: number
  worldY: number
  /** The object def backing this marker — the draft one if it's being edited.
   *  Every field the panel edits lives here, NOT on the placement, so an edit
   *  changes the object everywhere it appears. */
  def: ObjectDefJson | null
}

/** A picked region point light — index into the region's `lights[]`. */
type LightSelection = {
  kind: 'light'
  index: number
  light: RegionLight
}

type Selection = LocSelection | MarkerSelection | LightSelection

type PlaceDraft = { objectId: number; type: number; rotation: number; plane: number }

/** What the Place tab is currently placing. */
type PlaceKind = 'object' | 'light' | 'sound'

/** Defaults a click-placed point light starts from (the rest of the record is
 *  derived: footprint from the size, x/z from the clicked tile). */
type LightDraft = { plane: number; size2d: number; y: number; colorHsl: number; type: number }

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
type EditPatch = {
  terrain?: MapTerrain
  objects?: LocEntry[]
  lights?: RegionLight[]
  /** edited object DEFINITIONS keyed by object id (`objects/<id>.json`). Unlike
   *  the others these aren't region data at all — they're global, so one entry
   *  changes every placement of that object everywhere in the game. */
  objectDefs?: Map<number, ObjectDefJson>
  coalesce?: boolean
}

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

export default function MapSceneViewer({ data, focus, objects, terrain, lights, objectDefs, onEdit, gfxSlot, onNavigate }: {
  data: MapData
  focus?: { x: number; y: number; plane: number } | null
  /** draft of the centre region's placements (edits not yet saved) — kept
   *  outside `data` so an edit rebuilds only the centre locs, not the world */
  objects?: LocEntry[]
  /** draft of the centre region's terrain — same decoupling as `objects`, so
   *  a height-brush stroke rebuilds only the centre terrain/locs */
  terrain?: MapTerrain
  /** draft of the region's point lights (map_environments `lights[]`). Absent
   *  until the parent has read the environment file; a light edit re-bakes the
   *  centre locs, since point lights are baked into their vertex colours. */
  lights?: RegionLight[]
  /** draft object definitions, keyed by object id — see EditPatch.objectDefs.
   *  Fed to `LocAssets` so everything the scene resolves through `getDef`
   *  (marker kinds, models, recolours) shows the edit before it's saved. */
  objectDefs?: Map<number, ObjectDefJson>
  /** commit any edit — the parent owns the drafts, undo history, and save */
  onEdit?: (patch: EditPatch) => void
  /** header element the Client graphics settings dropdown portals into, so it
   *  sits beside the Regions button while its state stays here */
  gfxSlot?: HTMLElement | null
  /** jump to another entry's item (the def editor's View links) */
  onNavigate?: (entryName: string, itemId: number) => void
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
  const lightsPropRef = useRef<RegionLight[] | null>(null)
  lightsPropRef.current = lights ?? null
  const lastBuiltLightsRef = useRef<RegionLight[] | null>(null)
  // unified centre rebuild (terrain + locs + shadows + minimap) — assigned by
  // the scene build once its closure state (mosaic grid, assets) exists
  const rebuildCenterRef = useRef<((t: MapTerrain, objs: LocEntry[], lights?: RegionLight[]) => Promise<void>) | null>(null)
  /** Targeted placement patch — see its definition for what it does and does
   *  not update. Resolves false when the edit is too broad, and the caller
   *  falls back to the full rebuild. */
  const patchLocsRef = useRef<((prev: LocEntry[], next: LocEntry[]) => Promise<boolean>) | null>(null)
  // list-row click → select + highlight + fly the camera over the loc
  const selectFromListRef = useRef<((entry: LocEntry, index: number) => void) | null>(null)
  // light-list row click → select the light + fly the camera to it
  const selectLightFromListRef = useRef<((index: number) => void) | null>(null)
  const selectMarkerFromListRef = useRef<((marker: MarkerInfo) => void) | null>(null)
  /** show an uncommitted light record in the scene (null = back to committed) */
  const previewLightRef = useRef<((index: number, light: RegionLight | null) => void) | null>(null)
  /** the lights the scene actually built with — used when the parent hasn't
   *  loaded the environment (read-only view) so the list still shows them */
  const [sceneLights, setSceneLights] = useState<RegionLight[]>([])
  // Marker PLACEMENTS in the centre region, as the build produced them — the
  // View tab's marker list. Only the build knows which placements are markers
  // (it takes a model's sentinel colour to tell), so they can't be derived from
  // the placement list the way the object list is.
  const [sceneMarkers, setSceneMarkers] = useState<MarkerInfo[]>([])
  const [locNames, setLocNames] = useState<Map<number, string>>(new Map())

  // map-sprite previews: config/map_sprites/<id>.json → sprites/<sid>/<sid>_0.png,
  // cached as object URLs (revoked on unmount)
  const spriteUrlCacheRef = useRef<Map<number, Promise<MapSpriteInfo | null>>>(new Map())
  // `spriteId: -1` is a real, deliberate value here — the map_sprites decoder
  // has an opcode (4) whose only job is to blank the sprite, and 7 of the 106
  // records use it (22 alone is referenced by ~940 object defs). So the result
  // distinguishes "record says no sprite" from "sprite failed to load", which
  // the panel badges differently; a null result means no record at all.
  const loadMapSpriteInfo = (mapSpriteId: number): Promise<MapSpriteInfo | null> => {
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
          if (def.spriteId < 0) return { spriteId: -1, url: null }
          try {
            const spriteDir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(def.spriteId))
            const png = await (await spriteDir.getFileHandle(`${def.spriteId}_0.png`)).getFile()
            return { spriteId: def.spriteId, url: URL.createObjectURL(png) }
          } catch {
            return { spriteId: def.spriteId, url: null } // sprite not dumped
          }
        } catch {
          return null
        }
      })()
      cache.set(mapSpriteId, pending)
    }
    return pending
  }
  const loadMapSpriteInfoRef = useRef(loadMapSpriteInfo)
  loadMapSpriteInfoRef.current = loadMapSpriteInfo

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
          return { name: def.areaName, spriteUrl, bitmap, minimap: def.displayedOnMinimap !== false, iconArchive: def.defaultIconArchive }
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
      void pending.then((info) => { if (info?.url) URL.revokeObjectURL(info.url) })
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
  // View = the lists you browse; Edit = whatever is selected, and the only tab
  // where a left-drag moves an object. Selecting anything (scene click or list
  // row) switches to Edit, so you can't end up selected-but-elsewhere without
  // changing tab on purpose.
  const [sideTab, setSideTab] = useState<'view' | 'edit' | 'place' | 'terrain'>('view')
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
  // What the Place tab places: a loc, a point light, or a sound emitter (which
  // IS a loc — an invisible utility object — so it reuses the loc ghost path).
  const [placeKind, setPlaceKind] = useState<PlaceKind>('object')
  // "Add light" mode: the next scene click drops a new point light on the tile
  // it hits (placing one by clicking is much easier than typing coordinates,
  // and it's how the gizmo becomes reachable in the first place).
  const [addingLight, setAddingLight] = useState(false)
  const addingLightRef = useRef(false)
  addingLightRef.current = addingLight
  const onAddLightRef = useRef<(tx: number, ty: number) => void>(() => {})
  // defaults for a newly placed light — colour/type are a real dumped torch
  const [lightDraft, setLightDraft] = useState<LightDraft>({
    plane: 0, size2d: 1, y: 400, colorHsl: 5953, type: 15,
  })

  // Place-tab eyedropper (Alt+click a loc): load it into the place form
  const samplePlaceRef = useRef<(loc: LocRef) => void>(() => {})
  samplePlaceRef.current = (loc) => {
    setPlaceDraft({ objectId: loc.objectId, type: loc.shape, rotation: loc.rotation, plane: loc.plane })
  }

  // marquee multi-select (Shift+drag in the View tab): indices into objects
  const [multiSel, setMultiSel] = useState<number[]>([])
  const setMultiSelRef = useRef(setMultiSel)
  setMultiSelRef.current = setMultiSel
  // Defaults tuned for perf/clarity: only plane 0, no chunk grid (all
  // still toggleable in the controls).
  const [visiblePlanes, setVisiblePlanes] = useState([true, false, false, false])
  const [showLocs, setShowLocs] = useState(true)
  // the patch path attaches meshes without the visibility effect re-running
  // (it keys off `status`, which a patch never changes), so it sets their
  // initial visibility from the same toggles that effect uses. Plane
  // visibility needs no ref — that lives on the plane GROUP.
  const showLocsRef = useRef(showLocs)
  showLocsRef.current = showLocs
  const [showGfxPanel, setShowGfxPanel] = useState(false)
  // Bloom is live-tunable so it can be matched against the client side by side.
  // The client's own FilterBloom params are (threshold 1.0, strength 0.25), but its
  // blur normalisation differs from UnrealBloomPass's mip chain, so the strength
  // does not transfer 1:1 — hence the sliders.
  const [bloomOn, setBloomOn] = useState(true)
  const bloomOnRef = useRef(true)
  bloomOnRef.current = bloomOn
  const bloomPassRef = useRef<ClientBloomPass | null>(null)
  // Region distance fog — client formula: LINEAR fog ending at the draw
  // distance, starting (fogDepth+256)·4 units before it (Class239.method4075 →
  // renderer.c → glFog GL_LINEAR). The client's fog is NOT gated on lighting
  // detail — Atmosphere reads fogColour/fogDepth outside that branch — which is
  // why the client hazes distant foliage at LOW while we didn't. The draw
  // distance is the client's projection far plane, a client setting we can't
  // know, so it's the one exposed knob: at client-like zooms ~24 tiles matches;
  // the editor default sits further out so the overhead view isn't a wall of
  // fog.
  // The client's Brightness setting (1-4, default 3): ambient × (0.7 + 0.1·b),
  // Class239:141. Baked into vertex colours, so changing it triggers the
  // partial rebuild — a few seconds, unlike the live bloom/fog knobs.
  const [brightnessPref, setBrightnessPref] = useState(3)
  const brightnessMulRef = useRef(1)
  brightnessMulRef.current = 0.7 + 0.1 * brightnessPref
  const [fogOn, setFogOn] = useState(true)
  const [fogTiles, setFogTiles] = useState(40)
  // refs so the build effect can apply the current values without depending on
  // them (a fog tweak must not rebuild the scene)
  const fogOnRef = useRef(fogOn); fogOnRef.current = fogOn
  const fogTilesRef = useRef(fogTiles); fogTilesRef.current = fogTiles
  const fogApplyRef = useRef<((on: boolean, tiles: number) => void) | null>(null)
  useEffect(() => { fogApplyRef.current?.(fogOn, fogTiles) }, [fogOn, fogTiles])
  // Brightness is baked into vertex colours, so a change re-runs the partial
  // rebuild with the new factor (skipping the initial mount).
  const brightnessAppliedRef = useRef(brightnessPref)
  useEffect(() => {
    if (brightnessAppliedRef.current === brightnessPref) return
    brightnessAppliedRef.current = brightnessPref
    const assets = assetsRef.current
    const rebuild = rebuildCenterRef.current
    if (!assets || !rebuild) return
    assets.brightness = 0.7 + 0.1 * brightnessPref
    void rebuild(terrainPropRef.current ?? data.terrain, objectsPropRef.current ?? data.def.objects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brightnessPref])
  /** re-applies the sun tint (and the HDR overbright factor) to every built mesh */
  const refreshTintRef = useRef<(() => void) | null>(null)
  const [showOutlines, setShowOutlines] = useState(false)
  const [showMarkers, setShowMarkers] = useState(true)
  const showMarkersRef = useRef(showMarkers)
  showMarkersRef.current = showMarkers
  // point-light gizmos. On by default and drawn x-ray (see buildLightsMesh) —
  // lights live inside the locs they light, so depth-tested gizmos would be
  // unreachable. Off hides them AND stops them being picked.
  const [showLights, setShowLights] = useState(true)
  const showLightsRef = useRef(true)
  showLightsRef.current = showLights
  const [showSky, setShowSky] = useState(true)
  const skyMeshRef = useRef<THREE.Mesh | null>(null)
  const highlightClearRef = useRef<(() => void) | null>(null)
  const lightHighlightClearRef = useRef<(() => void) | null>(null)
  // markers highlight with the select outline rather than a mesh highlight, so
  // clearing a selection needs this as well as the two above
  const selectOutlineClearRef = useRef<(() => void) | null>(null)
  const refreshMarkersRef = useRef<(() => Promise<void>) | null>(null)
  const [status, setStatus] = useState('building terrain…')
  const [hoverText, setHoverText] = useState('')
  // Loading bar = the actual fraction of the build's passes completed (the build
  // drives `setLoadProgress` directly, see below). This effect only handles the
  // reset-to-0 at the start of a fresh build and the show/hide of the overlay.
  const [loadProgress, setLoadProgress] = useState(0)
  const [loadVisible, setLoadVisible] = useState(true)
  const wasBuildingRef = useRef(false)
  useEffect(() => {
    const failed = status.startsWith('scene build failed') || status.startsWith('no cache')
    const building = status !== '' && !failed
    if (building && !wasBuildingRef.current) { setLoadProgress(0); setLoadVisible(true) }
    wasBuildingRef.current = building
    if (failed) { setLoadVisible(false); return }
    if (!building) {
      setLoadProgress(100)
      const t = setTimeout(() => setLoadVisible(false), 300)
      return () => clearTimeout(t)
    }
  }, [status])
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef<Selection | null>(null)
  selectionRef.current = selection
  // The marker panel's uncommitted draft def, pushed here on every keystroke so
  // the scene previews it (LightPanel's onPreview, same idea). Layered OVER
  // `objectDefs` — the applied drafts — when the overrides are handed to
  // LocAssets, so an in-flight edit wins over an applied one for that object.
  const [previewDef, setPreviewDef] = useState<{ id: number; def: ObjectDefJson } | null>(null)
  // Transform-to preview: draw ONE centre placement as a different object,
  // without touching the draft (no dirty, no undo entry). The swapped array
  // goes through the same rebuild/patch effect real edits use, so toggling
  // the preview off patches the original model straight back. A -1 target
  // previews the morph's invisible state by dropping the placement.
  const [previewMorph, setPreviewMorph] = useState<{ index: number; objectId: number } | null>(null)
  const sceneObjects = useMemo(() => {
    if (!previewMorph) return objects
    const base = objects ?? data.def.objects
    if (previewMorph.index < 0 || previewMorph.index >= base.length) return objects
    const next = base.map((o) => [...o] as LocEntry)
    if (previewMorph.objectId < 0) next.splice(previewMorph.index, 1)
    else next[previewMorph.index][0] = previewMorph.objectId
    return next
  }, [objects, previewMorph, data])
  // View-tab section collapse state (objects/lights/markers/controls) — only
  // the objects list and the controls legend start open; lights and markers
  // are occasional-use
  const [openLists, setOpenLists] = useState({ objects: true, lights: false, markers: false, controls: true })
  const planeGroupsRef = useRef<(THREE.Group | null)[]>([null, null, null, null])
  const taggedRef = useRef<Tagged[]>([])
  // Placed locs with an idle sequence (waving flags) — posed each RAF frame.
  type AnimLocRecord = { update: (posed: import('../loaders/skeletalAnimation').PosedVertices) => void; model: ModelData; animationId: number; animator?: LocAnimator; neighbor: boolean; mesh: THREE.Mesh; sphere: THREE.Sphere }
  const animLocsRef = useRef<AnimLocRecord[]>([])
  // Meshes carrying `userData.sortCentreY` — their per-frame sort depth is
  // recomputed from the model's vertical centre (see setTransparentSort above).
  const sortCentreRef = useRef<THREE.Object3D[]>([])
  const assetsRef = useRef<LocAssets | null>(null)
  // FPS label — updated directly on the DOM node (no React re-render per frame).
  const fpsRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false

    const w = mount.clientWidth || 900
    const h = mount.clientHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    // three resets renderer.info at the top of every renderer.render(), and the
    // EffectComposer runs several of those per frame — so reading the counters
    // after composer.render() reports only its final fullscreen output pass
    // (1 draw call), not the scene. Take over the reset and do it once a frame.
    renderer.info.autoReset = false
    // full native DPI on a 4K screen quadruples the pixels pushed per frame —
    // cap it; at these fill rates it's the difference between smooth and choppy
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.setClearColor(0x0b0d12)
    mount.appendChild(renderer.domElement)
    // Client-exact transparent ordering. darkan's SceneObjectManager.method3421
    // keys the per-object sort on the view depth of the object's vertical
    // CENTRE — it projects (x, y + (minY >> 1), z), where minY is the model's
    // top in RS's negative-up space, i.e. base + half the model height. three.js
    // instead projects the object's ORIGIN, which for a tree is its base, so a
    // tall loc sorts as if it were entirely at ground level. Meshes that set
    // `userData.sortCentreY` get a corrected depth in `userData.sortZ` each
    // frame, computed with the SAME projection three.js uses for renderItem.z,
    // so the two can be compared interchangeably here.
    renderer.setTransparentSort((a, b) => {
      if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder
      if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder
      const az = (a.object.userData.sortZ as number | undefined) ?? a.z
      const bz = (b.object.userData.sortZ as number | undefined) ?? b.z
      if (az !== bz) return bz - az // farthest first — back-to-front
      return a.id - b.id
    })
    // Report the actual GPU/driver the browser handed WebGL — a "SwiftShader"/
    // "software" string here means hardware acceleration is OFF (the usual cause
    // of a slideshow-fps, whole-machine-lags-out map). Logged + on window.__gpu.
    try {
      const gl = renderer.getContext()
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      const software = /swiftshader|software|llvmpipe|basic render/i.test(String(gpu))
      // eslint-disable-next-line no-console
      console.log(`[map] WebGL renderer: ${gpu}${software ? '  ⚠ SOFTWARE RENDERING — enable hardware acceleration' : ''} · dpr ${window.devicePixelRatio}`)
      ;(window as unknown as { __gpu?: unknown }).__gpu = { gpu, software, dpr: window.devicePixelRatio, canvas: `${w}x${h}` }
    } catch { /* ignore */ }

    const scene = new THREE.Scene()
    // no fog until the environment loads — applyFog (client formula, region
    // colour/depth, live draw-distance slider) owns scene.fog from then on
    const camera = new THREE.PerspectiveCamera(50, w / h, 8, REGION_UNITS * 10)
    const center = new THREE.Vector3(REGION_UNITS / 2, 0, -REGION_UNITS / 2)
    camera.position.set(center.x, REGION_UNITS * 0.55, center.z + REGION_UNITS * 0.75)

    // HDR + bloom. `hdr` materials are pushed past 1.0 by their overbright
    // multiplier (see MaterialMeta.hdrMultiplier); a half-float target keeps those
    // values instead of clipping, and the bloom pass — thresholded at 1.0 so only
    // genuinely overbright pixels qualify — turns them into the client's glow.
    const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
    }))
    composer.addPass(new RenderPass(scene, camera))
    const bloomPass = new ClientBloomPass(w, h)
    bloomPassRef.current = bloomPass
    composer.addPass(bloomPass)
    composer.addPass(new OutputPass())

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
    // #5: no hover raycasts against the huge merged meshes while actively
    // orbiting/panning — the pick fights the drag and costs frames.
    let orbiting = false
    controls.addEventListener('start', () => { orbiting = true })
    controls.addEventListener('end', () => { orbiting = false })

    const disposables: { dispose(): void }[] = []
    // materials with animated UVs: data-driven scroll (waterfalls, lava —
    // offset = seconds*speed/64, OpenGlToolkit convention) and still water
    // (client ripple effect approximated by a gentle drifting wobble)
    const scrollMaterials: { map: THREE.Texture; u: number; v: number }[] = []
    // Shared uniforms across every water surface (updated once per frame).
    const waterUniforms = {
      uSunDir: { value: new THREE.Vector3(...DEFAULT_MODEL_SUN.dir).normalize() },
      uSunColour: { value: new THREE.Vector3(...DEFAULT_MODEL_SUN.sunColour) },
      // procedural sky reflected by the water: deep steel-blue overhead, lighter
      // toward the horizon (approx. the client's sky env cube)
      uSkyZenith: { value: new THREE.Color(0.10, 0.20, 0.34) },
      uSkyHorizon: { value: new THREE.Color(0.34, 0.47, 0.60) },
      // deep-water body colour blended in by depth (dark blue-teal)
      uDeepTint: { value: new THREE.Color(0.05, 0.15, 0.22) },
      uSpecExp: { value: 32 }, // client EnvMappedWater specExp
      uBreakDepth: { value: 256 }, // client breakWaterDepth
      uTime: { value: 0 },
      uEyePos: { value: new THREE.Vector3() },
      // region distance fog — kept in step with scene.fog by applyFog below
      uFogColor: { value: new THREE.Color(0xc8c0a8) },
      uFogNear: { value: 1e8 },
      uFogFar: { value: 1e9 },
    }
    let hasWater = false
    const track = (obj: THREE.Object3D) => {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) disposables.push(mesh.geometry)
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (let i = 0; i < mats.length; i++) {
            const m = mats[i]
            disposables.push(m)
            const basic = m as THREE.MeshBasicMaterial
            if (basic.map && m.userData.scroll) {
              scrollMaterials.push({ map: basic.map, u: m.userData.scroll.u, v: m.userData.scroll.v })
              disposables.push(basic.map) // per-material texture clone
            } else if (m.userData.water) {
              // swap the flat blue water material for the env-mapped water shader
              const wm = new THREE.ShaderMaterial({
                vertexShader: WATER_VERT,
                fragmentShader: WATER_FRAG,
                uniforms: waterUniforms,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
              })
              wm.userData.water = true
              mats[i] = wm
              disposables.push(wm)
              hasWater = true
            }
          }
        }
      })
      return obj
    }

    /** Free an object's own geometry/materials (and the per-material texture
     *  clones only it owns). Shared with the teardown below, so it lives out
     *  here rather than inside the build. */
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
    selectOutlineClearRef.current = () => { selectOutline.visible = false }

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

    // Centre-region heights + the light records the scene was built from,
    // held where the pointer handlers can see them (the build and every
    // rebuild below reassign both).
    let lightHeights: Int32Array[] = []
    let currentLights: RegionLight[] = []

    // selected point light: a bright ring at its radius plus a vertical stalk,
    // both x-ray (the light is usually buried inside the loc it lights)
    const lightSelRing = (() => {
      const pts: number[] = []
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2
        pts.push(Math.cos(a), 0, Math.sin(a))
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
      const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({
        color: 0xffffff, depthTest: false, depthWrite: false, fog: false,
      }))
      line.renderOrder = 4100
      line.visible = false
      line.raycast = () => {}
      scene.add(line)
      return line
    })()
    const lightSelStalk = (() => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 1, 0]), 3))
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xffffff, depthTest: false, depthWrite: false, fog: false,
      }))
      line.renderOrder = 4100
      line.visible = false
      line.raycast = () => {}
      scene.add(line)
      return line
    })()
    function clearLightHighlight() {
      lightSelRing.visible = false
      lightSelStalk.visible = false
    }
    lightHighlightClearRef.current = clearLightHighlight
    /** Put the highlight on a light record (centre region, current heights). */
    function highlightLight(rec: RegionLight) {
      const p = lightScenePos(rec, lightHeights)
      const radius = Math.max(lightRadius(rec), 64)
      lightSelRing.position.set(p.x, p.y, p.z)
      lightSelRing.scale.set(radius, 1, radius)
      lightSelRing.visible = true
      // stalk from the ground up through the light, so its height reads
      lightSelStalk.position.set(p.x, p.ground, p.z)
      lightSelStalk.scale.set(1, Math.max(p.y - p.ground, 1), 1)
      lightSelStalk.visible = true
    }
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
        // an animated loc's highlight shares the source mesh's geometry so it
        // follows the pose — disposing it here would destroy the loc itself
        if (m.geometry && !m.userData.sharedGeometry) m.geometry.dispose()
        if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose()
      })
      highlightGroup = null
      highlightFill = null
    }
    highlightClearRef.current = clearLocHighlight

    function highlightLoc(mesh: THREE.Mesh, owner: number) {
      clearLocHighlight()
      // An animated loc is a mesh of its own and every triangle is its, so the
      // highlight can share the source geometry outright — it then deforms with
      // the pose instead of freezing at the frame that was clicked. Its edge
      // outline is skipped: EdgesGeometry is a one-off snapshot and would drift
      // off the model as it animates.
      const animated = mesh.userData.animatedLoc === true
      let geometry: THREE.BufferGeometry
      if (animated) {
        geometry = mesh.geometry
      } else {
        const owners = mesh.userData.triangleOwners as Int32Array
        const positions = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
        const tri: number[] = []
        for (let t = 0; t < owners.length; t++) {
          if (owners[t] !== owner) continue
          const base = t * 9
          for (let k = 0; k < 9; k++) tri.push(positions[base + k])
        }
        if (tri.length === 0) return
        geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3))
      }
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
      fill.userData.sharedGeometry = animated
      highlightGroup = new THREE.Group()
      highlightGroup.add(fill)
      if (!animated) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry, 25),
          new THREE.LineBasicMaterial({ color: 0xb7e0ff, transparent: true, opacity: 0.95 }),
        )
        edges.renderOrder = 901
        highlightGroup.add(edges)
      }
      // match the source mesh's full world transform — an animated loc bakes
      // rotation and placement into its matrix, not just a position offset
      highlightGroup.matrixAutoUpdate = false
      highlightGroup.matrix.copy(mesh.matrixWorld)
      highlightGroup.updateMatrixWorld(true)
      // never pickable — clicks must pass through to the loc beneath
      highlightGroup.traverse((o) => { o.raycast = () => {} })
      scene.add(highlightGroup)
    }

    // fill in the async def details (name/size/models/map sprite) for a loc
    function fillLocDef(objectId: number) {
      void (async () => {
        // getDef returns the draft def when one exists, so reselecting an
        // object mid-edit reopens the panel on the edit, not the file
        const def = await assetsRef.current?.getDef(objectId)
        if (!def) return
        setSelection((prev) => prev?.kind === 'loc' && prev.objectId === objectId ? {
          ...prev,
          name: def.name && def.name !== 'null' ? def.name : 'Object',
          sizeX: def.sizeX ?? 1,
          sizeY: def.sizeY ?? 1,
          models: def.objectModelIds ? def.objectModelIds.flat().join(', ') : '',
          def,
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
        if (owner < 0) continue
        // A merged mesh lists every loc in the region — including animated ones,
        // whose triangles live in their own mesh. Matching the id there would
        // "find" a loc with no geometry, so keep looking if it owns no triangles.
        if (!mesh.userData.animatedLoc) {
          const owners = mesh.userData.triangleOwners as Int32Array | undefined
          if (!owners || !owners.includes(owner)) continue
        }
        found = { mesh, owner }
        break
      }
      if (found) highlightLoc(found.mesh, found.owner)
      else clearLocHighlight()
      selectOutline.visible = false
      clearLightHighlight()
      const cx = (x + 0.5) * TILE
      const cz = -(y + 0.5) * TILE
      controls.target.set(cx, 0, cz)
      camera.position.set(cx, 4500, cz + 5200)
      controls.update()
      setSelection({
        kind: 'loc', name: 'Object', objectId, type, rotation, x, y, plane,
        regionX: data.def.regionX, regionY: data.def.regionY,
        inCenter: true, index, editable: index >= 0,
        sizeX: 1, sizeY: 1, models: '', def: null,
      })
      fillLocDef(objectId)
    }

    function pick(): THREE.Intersection | null {
      raycaster.setFromCamera(pointer, camera)
      // only visible meshes — raycasting hidden planes/neighbours (and then
      // discarding the hits) was pure waste. Light gizmos are skipped: they
      // float x-ray over the scene, so leaving them in would let a gizmo eat
      // the terrain brush's or the eyedropper's hit (see pickLight).
      const targets: THREE.Object3D[] = []
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && !(o as THREE.Mesh).userData.lightIndices) targets.push(o)
      })
      const hits = raycaster.intersectObjects(targets, false)
      return hits[0] ?? null
    }

    /**
     * Tile targeting for drag-to-move: raycasts the GROUND only.
     *
     * `pick()` returns the nearest visible mesh of any kind, which is right for
     * selection but wrong for "which tile is the cursor over": while dragging a
     * loc the ray keeps landing on the loc itself — and on every wall, tree or
     * roof the cursor passes over — so the tile, and therefore the ghost, sticks
     * to that object's surface instead of following the cursor across the map.
     * The ghost object excludes itself from raycasts already (`ghostify`), so
     * it never occludes its own target.
     */
    function pickGround(): THREE.Intersection | null {
      raycaster.setFromCamera(pointer, camera)
      const targets: THREE.Object3D[] = []
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).userData.isTerrain) targets.push(o)
      })
      const hits = raycaster.intersectObjects(targets, false)
      return hits[0] ?? null
    }

    /**
     * Point-light gizmos are raycast on their OWN, ahead of everything else:
     * a light sits inside the loc it lights, so the generic `pick()` (nearest
     * hit across the whole scene) would always hand back the surrounding wall
     * or lantern instead. This raycast ignores what's in front of the gizmo, so
     * a light buried in a lantern stays clickable even though it's hidden.
     */
    function pickLight(): { index: number; light: RegionLight } | null {
      if (!showLightsRef.current) return null
      const targets: THREE.Object3D[] = []
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).userData.lightIndices) targets.push(o)
      })
      if (targets.length === 0) return null
      raycaster.setFromCamera(pointer, camera)
      for (const hit of raycaster.intersectObjects(targets, false)) {
        const mesh = hit.object as THREE.Mesh
        const indices = mesh.userData.lightIndices as number[]
        const list = mesh.userData.lights as RegionLight[]
        // 8 triangles per diamond, in `indices` order
        const index = indices[(hit.faceIndex ?? -1) >> 3]
        const light = index === undefined ? undefined : list[index]
        if (light) return { index, light }
      }
      return null
    }

    /** Select a light: panel + highlight, clearing any loc/marker selection. */
    function selectLight(index: number, light: RegionLight) {
      setSideTab('edit') // selecting anything jumps to the Edit tab
      setSelection({ kind: 'light', index, light })
      selectOutline.visible = false
      clearLocHighlight()
      highlightLight(light)
    }

    /** Select a marker: panel + outline, clearing any loc/light selection.
     *  `gp` is the world position of the marker group it belongs to (the region
     *  offset), since MarkerInfo coordinates are region-local. */
    function selectMarker(marker: MarkerInfo, gp: THREE.Vector3) {
      const regionX = data.def.regionX + Math.round(gp.x / (64 * TILE))
      const regionY = data.def.regionY - Math.round(gp.z / (64 * TILE))
      setSideTab('edit') // selecting anything jumps to the Edit tab
      setSelection({
        kind: 'marker',
        markerKind: marker.kind,
        fallback: marker.fallback,
        objectId: marker.objectId,
        type: marker.type,
        worldX: regionX * 64 + marker.tileX,
        worldY: regionY * 64 + marker.tileY,
        def: null, // filled below; the panel shows a loading state until then
      })
      selectOutline.position.set(gp.x + marker.tileX * TILE, gp.y + marker.y + 8, gp.z - marker.tileY * TILE)
      selectOutline.visible = true
      clearLocHighlight()
      clearLightHighlight()
      void (async () => {
        // getDef hands back the draft def when one exists, so reselecting a
        // marker mid-edit reopens the panel on the edit, not the file
        const def = await assetsRef.current?.getDef(marker.objectId) ?? null
        setSelection((prev) => prev?.kind === 'marker' && prev.objectId === marker.objectId
          ? { ...prev, def }
          : prev)
      })()
    }

    // marker-list row click: same selection, plus a camera move (centre-region
    // markers only, so the group offset is the origin)
    selectMarkerFromListRef.current = (marker) => {
      controls.target.set(marker.x, marker.y, marker.z)
      camera.position.set(marker.x, marker.y + 3000, marker.z + 3600)
      controls.update()
      selectMarker(marker, new THREE.Vector3(0, 0, 0))
    }

    // light-list row click: select it and fly the camera over its tile
    selectLightFromListRef.current = (index) => {
      const rec = currentLights[index]
      if (!rec) return
      const p = lightScenePos(rec, lightHeights)
      controls.target.set(p.x, p.y, p.z)
      camera.position.set(p.x, p.y + 3000, p.z + 3600)
      controls.update()
      selectLight(index, rec)
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
      // Merged loc meshes carry their region as a mesh offset; animated locs
      // bake the whole placement into mesh.matrix (position stays at origin),
      // so those record the region in userData instead.
      const locRegion = mesh.userData.locRegion as { x: number; y: number } | undefined
      const meshRegionX = locRegion ? locRegion.x : data.def.regionX + Math.round(mesh.position.x / (64 * TILE))
      const meshRegionY = locRegion ? locRegion.y : data.def.regionY - Math.round(mesh.position.z / (64 * TILE))
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

    // How far the pointer must travel before a press counts as a drag rather
    // than a click. Shared by the click test in onPointerUp and the drag-to-move
    // arming below — they used to disagree, which is how a 1px twitch on a
    // selected loc could commit a move.
    const DRAG_PX = 5

    // drag-to-move: left-drag starting on the selected (editable) loc.
    // `grabTx/grabTy` is the tile that was under the cursor at press time, so
    // the loc moves by DELTA and not to wherever the ray lands — pressing a
    // multi-tile object anywhere but its anchor tile must not teleport it.
    // `armed` stays false until the pointer passes DRAG_PX; an unarmed release
    // falls through and is handled as an ordinary click.
    let movingLoc: { entry: LocEntry; index: number; grabTx: number; grabTy: number; armed: boolean } | null = null
    let suppressClick = false

    function onPointerMove(e: PointerEvent) {
      updatePointer(e)
      pointerInside = true
      bumpActivity()
      if (paintingDrag && terrainBrushRef.current) paintAtPointer(false)
      if (marquee) marqueeRect(e)
      if (movingLoc) {
        if (!movingLoc.armed) {
          if (Math.abs(e.clientX - downX) <= DRAG_PX && Math.abs(e.clientY - downY) <= DRAG_PX) return
          movingLoc.armed = true
        }
        const hit = pickGround()
        const t = hit ? movingTargetTile(movingLoc, hit.point) : null
        if (t) {
          const [objectId, type, rotation, , , plane] = movingLoc.entry
          ghostUpdateRef.current?.({ objectId, type, rotation, plane }, t.tx, t.ty)
        } else {
          // off the map, or the delta would leave the centre region — drop the
          // ghost rather than leave it parked somewhere the release won't honour
          ghostClearRef.current?.()
        }
      }
    }
    /** Where a drag-in-progress would drop the loc: its anchor shifted by the
     *  tile delta the cursor has travelled since the press. Null when that
     *  lands outside the centre region. */
    function movingTargetTile(moving: { entry: LocEntry; grabTx: number; grabTy: number }, point: THREE.Vector3) {
      const t = worldTileOf(point)
      const tx = moving.entry[3] + (t.tx - moving.grabTx)
      const ty = moving.entry[4] + (t.ty - moving.grabTy)
      if (tx < 0 || tx >= 64 || ty < 0 || ty >= 64) return null
      return { tx, ty }
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

      // marquee: Shift+drag — select objects (Edit) or copy an area (Terrain)
      if (e.shiftKey && (sideTabRef.current === 'edit' || sideTabRef.current === 'terrain')) {
        updatePointer(e)
        const hit = pick()
        const tile0 = hit ? (() => { const t = worldTileOf(hit.point); return { tx: t.tx, ty: t.ty } })() : null
        marquee = { x0: e.clientX, y0: e.clientY, tile0 }
        suppressClick = true
        return
      }

      // drag-to-move: press on the currently selected editable loc.
      // The Edit-tab gate is not a silent restriction — selecting a loc forces
      // that tab (`setSideTab('edit')`, three call sites) and selection is
      // blocked outright on the Terrain tab, so you can only be selected-but-
      // elsewhere by switching tabs on purpose. On those tabs left-drag already
      // belongs to the terrain brush and to placement, so it has to yield.
      const sel = selectionRef.current
      if (sideTabRef.current === 'edit' && sel?.kind === 'loc' && sel.editable) {
        updatePointer(e)
        const hit = pick()
        const res = hit ? resolveLocAt(hit) : null
        if (res && res.isCenter && res.index === sel.index && hit) {
          // The grab reference has to come from the ground, like every later
          // sample — taking it off the object's own surface would bias the
          // delta by however far up the model the press landed. Falling back to
          // the loc's own tile makes the delta start at zero.
          const groundHit = pickGround()
          const grab = groundHit ? worldTileOf(groundHit.point) : { tx: sel.x, ty: sel.y }
          movingLoc = {
            entry: [sel.objectId, sel.type, sel.rotation, sel.x, sel.y, sel.plane] as LocEntry,
            index: sel.index,
            grabTx: grab.tx,
            grabTy: grab.ty,
            armed: false,
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

      // finish a marquee: select objects (Edit) or copy the area (Terrain)
      if (marquee) {
        const m = marquee
        marquee = null
        hideMarquee()
        updatePointer(e)
        if (sideTabRef.current === 'edit') {
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

      // finish a drag-to-move. An unarmed press never travelled far enough to
      // be a drag, so it must not commit anything — it falls through to the
      // click handling below and simply re-selects the loc.
      if (movingLoc) {
        const moving = movingLoc
        movingLoc = null
        ghostClearRef.current?.()
        const hit = moving.armed ? pickGround() : null
        if (hit) {
          const t = movingTargetTile(moving, hit.point)
          if (t && (t.tx !== moving.entry[3] || t.ty !== moving.entry[4])) {
            const base = objectsPropRef.current ?? data.def.objects
            const next = base.map((o) => [...o] as LocEntry)
            next[moving.index] = [moving.entry[0], moving.entry[1], moving.entry[2], t.tx, t.ty, moving.entry[5]] as LocEntry
            setSelection(null)
            onEditRef.current?.({ objects: next })
            return
          }
        }
        // never armed, dropped out of bounds, or released in place — treat as
        // a plain re-click below
      }

      if (suppressClick) { suppressClick = false; return }
      if (Math.abs(e.clientX - downX) > DRAG_PX || Math.abs(e.clientY - downY) > DRAG_PX) return // drag, not a click

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

      // armed "Add light": a click drops a new light on the tile under it
      if (addingLightRef.current) {
        const lightHitPoint = pick()
        if (!lightHitPoint) return
        const t = worldTileOf(lightHitPoint.point)
        if (t.tx < 0 || t.tx > 63 || t.ty < 0 || t.ty > 63) return // centre region only
        onAddLightRef.current(t.tx, t.ty)
        return
      }

      // terrain-tab clicks are consumed by the brush (or paste) — no selection
      if (sideTabRef.current === 'terrain') return

      // point lights win over whatever geometry surrounds them (see pickLight)
      const lightHit = pickLight()
      if (lightHit) {
        selectLight(lightHit.index, lightHit.light)
        return
      }

      const hit = pick()
      if (!hit) {
        setSelection(null)
        selectOutline.visible = false
        clearLocHighlight()
        clearLightHighlight()
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
          selectMarker(marker, gp)
          return
        }
      }

      {
        const res = resolveLocAt(hit)
        if (res) {
          const { loc, isCenter, index, meshRegionX, meshRegionY } = res
          setSideTab('edit') // selecting anything jumps to the Edit tab
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
            def: null, // filled by fillLocDef below
          })
          selectOutline.visible = false
          clearLightHighlight()
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
      clearLightHighlight()
    }

    // Orbiting is on the middle button, which is also the browser's autoscroll
    // gesture — without this, dragging the camera also starts that "scroll the
    // page by moving the mouse" mode. Chromium only arms it on the mousedown
    // default action, so cancelling that (not pointerdown) is what stops it.
    function onMiddleMouseDown(e: MouseEvent) {
      if (e.button === 1) e.preventDefault()
    }
    renderer.domElement.addEventListener('mousedown', onMiddleMouseDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    let raf = 0
    let frame = 0
    let mmFrame = 0
    let skipCounter = 0
    let lastHoverText = ''
    // Loc idle animation is frustum-culled: solving every animated loc every frame
    // (hundreds of them) thrashed the GC. Only what's on screen gets posed.
    const animFrustum = new THREE.Frustum()
    const animProjView = new THREE.Matrix4()
    const sortProjScreen = new THREE.Matrix4()
    const sortVec = new THREE.Vector3()
    // whether the last pose tick saw a visible animated loc — lets the idle
    // throttle engage when nothing on screen is animating (hundreds of hidden/
    // off-screen animated locs shouldn't peg full fps forever)
    let animVisible = false
    const pushHoverText = (text: string) => {
      if (text === lastHoverText) return // avoid re-rendering React per frame
      lastHoverText = text
      setHoverText(text)
    }
    function animate() {
      // idle throttle (~15fps) to stop hogging the compositor when nothing is
      // moving — but NOT while animated materials (water/scroll) are on screen,
      // or their animation goes choppy. Full fps whenever something animates.
      const hasAnimation = scrollMaterials.length > 0 || hasWater || animVisible
      if (!hasAnimation && performance.now() - lastActivity > 3000 && (skipCounter++ & 3) !== 0) {
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
      if (scrollMaterials.length > 0) {
        const seconds = (performance.now() % 512000) / 1000
        for (const { map, u, v } of scrollMaterials) {
          map.offset.set(((seconds * u) / 64) % 1, ((seconds * v) / 64) % 1)
        }
      }
      if (hasWater) {
        waterUniforms.uTime.value = (performance.now() % 512000) / 1000
        waterUniforms.uEyePos.value.copy(camera.position)
      }
      // Pose animated locs (waving flags) every frame, but only the ones actually
      // on screen — culling to the visible handful (from potentially hundreds) is
      // what keeps this cheap. Meshes off-screen are frustum-culled by three.js.
      if (animLocsRef.current.length > 0) {
        camera.updateMatrixWorld()
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
        animProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        animFrustum.setFromProjectionMatrix(animProjView)
        const seconds = (performance.now() % 3600000) / 1000
        animVisible = false
        for (const rec of animLocsRef.current) {
          if (!rec.animator) continue
          // skip hidden planes / neighbour-toggle-hidden meshes
          if (!rec.mesh.visible || rec.mesh.parent?.visible === false) continue
          // skip anything not in view — the vast majority most frames
          if (!animFrustum.intersectsSphere(rec.sphere)) continue
          const posed = rec.animator.pose(rec.model, rec.animator.frameAt(seconds))
          if (posed) { rec.update(posed); animVisible = true }
        }
      }
      // hover raycast every other frame — but never mid-orbit (#5)
      if (pointerInside && !orbiting && (frame++ & 1) === 0) {
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
      // Refresh the client-style centre depths the transparent sort reads. Same
      // projection three.js applies to renderItem.z, but from the model's
      // vertical centre instead of its origin (see setTransparentSort).
      if (sortCentreRef.current.length > 0) {
        camera.updateMatrixWorld()
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
        sortProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        for (const obj of sortCentreRef.current) {
          if (!obj.visible || obj.parent?.visible === false) continue
          sortVec.setFromMatrixPosition(obj.matrixWorld)
          sortVec.y += obj.userData.sortCentreY as number
          sortVec.applyMatrix4(sortProjScreen)
          obj.userData.sortZ = sortVec.z
        }
      }
      renderer.info.reset()
      composer.render()
      // FPS readout — averaged over 20 frames, written straight to the label
      // node. No React state per frame.
      {
        const now = performance.now()
        if (perfLast) { perfSum += 1000 / (now - perfLast); perfN++ }
        perfLast = now
        if (perfN >= 20) {
          const fps = Math.round(perfSum / perfN)
          // Whole-frame draw calls, so it includes the composer's handful of
          // post passes. Kept as a general perf readout — the question it was
          // originally added for (can we afford one mesh per transparent loc?)
          // is settled: ~575 calls fully zoomed out, signed off 2026-07-25.
          if (fpsRef.current) fpsRef.current.textContent = `${fps} fps · ${renderer.info.render.calls} calls`
          perfSum = 0; perfN = 0
        }
      }
      raf = requestAnimationFrame(animate)
    }
    let perfLast = 0, perfSum = 0, perfN = 0
    animate()

    function onResize() {
      const nw = mount!.clientWidth || w
      const nh = mount!.clientHeight || h
      renderer.setSize(nw, nh)
      composer.setSize(nw, nh)
      bloomPass.setSize(nw, nh)
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
        assets.brightness = brightnessMulRef.current
        assetsRef.current = assets
        animLocsRef.current = []
        sortCentreRef.current = []
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
        type Cell = { dx: number; dy: number; def: MapRegionDef; terrain: ReturnType<typeof decodeTerrain>; underwater?: MapTerrain }
        // the centre region renders the parent's draft terrain (height-brush
        // edits survive a 2D/3D toggle); `let` because brush rebuilds swap it
        let currentTerrain = terrainPropRef.current ?? data.terrain
        lastBuiltTerrainRef.current = terrainPropRef.current
        const cells: Cell[] = [{ dx: 0, dy: 0, def: data.def, terrain: currentTerrain, underwater: data.underwaterTerrain }]
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
                cells.push({ dx, dy, def, terrain, underwater: decodeUnderwaterTerrain(def) })
                regionGrid[dx + 1][dy + 1] = terrain
              } catch { /* neighbour not dumped */ }
            }
          }
        }
        // region environment (map_environments dump): fog, sun, skybox
        const env = await loadRegionEnvironment(data.rootHandle, data.id)
        // Per-region bloom parameters (map-environment opcode 2). Regions that
        // don't override them keep the client's class defaults.
        if (bloomPassRef.current) {
          bloomPassRef.current.threshold = env?.hdr?.bloomThreshold ?? 1.0
          bloomPassRef.current.strength = env?.hdr?.bloomStrength ?? 0.25
          bloomPassRef.current.whitePoint = env?.hdr?.whitePoint ?? 1.0
        }

        // Region distance fog. Colour and depth come from the environment
        // (Lumbridge: 0x8DA4C2, depth 600); the defaults are the client's own
        // (Class239.anInt2932 = 0xC8C0A8, depth 0). scene.fog covers every
        // standard material; the water ShaderMaterial mirrors it through its
        // uniforms; the skybox opts out (fog:false in buildSkyboxMesh).
        {
          const fogColour = env?.environment?.fogColour ?? 0xc8c0a8
          const fogDepthUnits = ((env?.environment?.fogDepth ?? 0) + 256) * 4
          const fogObj = new THREE.Fog(fogColour, 1, 2)
          fogApplyRef.current = (on, tiles) => {
            if (disposed) return
            if (!on) {
              scene.fog = null
              waterUniforms.uFogNear.value = 1e8
              waterUniforms.uFogFar.value = 1e9
              return
            }
            const end = tiles * 512
            const start = Math.max(1, end - fogDepthUnits)
            fogObj.near = start
            fogObj.far = end
            scene.fog = fogObj
            ;(waterUniforms.uFogColor.value as THREE.Color).copy(fogObj.color)
            waterUniforms.uFogNear.value = start
            waterUniforms.uFogFar.value = end
          }
          fogApplyRef.current(fogOnRef.current, fogTilesRef.current)
        }
        const sun: SunConfig = env?.environment
          ? {
              x: env.environment.sunPosition?.[0] ?? DEFAULT_SUN.x,
              y: env.environment.sunPosition?.[1] ?? DEFAULT_SUN.y,
              z: env.environment.sunPosition?.[2] ?? DEFAULT_SUN.z,
              ambient: env.environment.sunAmbient ?? DEFAULT_SUN.ambient,
            }
          : DEFAULT_SUN
        // clear colour = fog colour, so anything past the terrain fades into
        // the same backdrop. The fog itself is applyFog above (client formula);
        // the old approximate horizon fade that lived here fought with it.
        if (env?.environment?.fogColour !== undefined) {
          renderer.setClearColor(env.environment.fogColour & 0xffffff)
        }

        setStatus('computing mosaic…')
        const mosaic = new SceneMosaic(regionGrid, data.def.regionX, data.def.regionY, configs, sun, assets.brightness)
        if (disposed) return

        // region point lights (map-environment `lights[]`), baked per placement.
        // Needs the centre region's heights: a light's stored y is an offset
        // above its tile's terrain, not a render coordinate. The parent's draft
        // wins when it has one (a light edit made before the scene finished).
        lightHeights = mosaic.slicesFor(0, 0).heights
        currentLights = lightsPropRef.current ?? env?.lights ?? []
        // record what we actually built with, so the parent handing down the
        // very same array (its draft is seeded from this file) doesn't look
        // like an edit and trigger a second full rebuild
        lastBuiltLightsRef.current = currentLights
        setSceneLights(currentLights)
        let lightGrid = buildLightGrid(currentLights, lightHeights)

        // Editor gizmos for the lights, one group per plane so the plane
        // toggles hide them with everything else on that level. Rebuilt whole
        // (they're a few hundred vertices) — cheap enough to redo on every
        // slider tick while a light is being edited, which is what makes the
        // panel feel live without touching the baked loc lighting.
        const setLightGizmos = (list: RegionLight[]) => {
          const stale = taggedRef.current.filter((t) => t.kind === 'light')
          taggedRef.current = taggedRef.current.filter((t) => t.kind !== 'light')
          for (const { obj } of stale) {
            obj.parent?.remove(obj)
            disposeDeep(obj)
          }
          for (let plane = 0; plane < 4; plane++) {
            const indices: number[] = []
            for (let i = 0; i < list.length; i++) {
              if (list[i].plane === plane) indices.push(i)
            }
            const group = buildLightsMesh(list, lightHeights, indices)
            if (!group) continue
            group.visible = showLightsRef.current
            planeGroupsRef.current[plane]?.add(group)
            taggedRef.current.push({ obj: group, neighbor: false, kind: 'light' })
          }
        }

        // Live preview of the light being edited: the gizmo (position, height,
        // colour, reach ring) follows the panel's draft immediately. The LIGHTING
        // itself still waits for Apply — it's baked into every loc around it.
        previewLightRef.current = (index, rec) => {
          if (!rec) {
            setLightGizmos(currentLights)
            const sel = selectionRef.current
            if (sel?.kind === 'light' && currentLights[sel.index]) highlightLight(currentLights[sel.index])
            return
          }
          setLightGizmos(currentLights.map((l, i) => (i === index ? rec : l)))
          highlightLight(rec)
        }

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
          // Runs even with no sun tint: HDR materials still need their overbright
          // factor re-applied when bloom is toggled.
          const tint = sunTint ?? [1, 1, 1]
          obj.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.material) return
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              // water is a ShaderMaterial (no .color) — its sky tint lives in its
              // own uniforms, so skip it here
              const c = (m as THREE.MeshBasicMaterial).color
              if (!c) continue
              // Scale by the material's HDR overbright factor rather than
              // overwriting — a plain setRGB here silently discarded it, which is
              // why HDR materials never reached the bloom threshold.
              const hdr = bloomOnRef.current ? ((m.userData.hdrMultiplier as number) ?? 1) : 1
              if (!sunTint && hdr === 1) continue // nothing to change
              c.setRGB(tint[0] * hdr, tint[1] * hdr, tint[2] * hdr)
            }
          })
        }

        // Re-derive every marker's kind from the (possibly edited) object defs
        // and rebuild the diamonds in place. A def edit can turn a sound
        // emitter into a map-icon anchor, which is purely a colour change — so
        // this deliberately does NOT go near the region rebuild. Cheap enough
        // to run per keystroke: markers are a handful of tiny meshes.
        refreshMarkersRef.current = async () => {
          const a = assetsRef.current
          if (!a) return
          for (const t of taggedRef.current) {
            if (t.kind !== 'marker') continue
            const group = t.obj as THREE.Group
            const all: MarkerInfo[] = []
            group.traverse((o) => {
              const list = (o as THREE.Mesh).userData?.markers as MarkerInfo[] | undefined
              if (list) all.push(...list)
            })
            let changed = false
            for (const m of all) {
              const d = await a.getDef(m.objectId)
              const kind = (d ? markerKindFromDef(d) : null) ?? m.fallback
              if (kind !== m.kind) { m.kind = kind; changed = true }
            }
            if (!changed) continue
            const next = buildMarkersMesh(all)
            if (!next) continue
            next.position.copy(group.position)
            next.visible = group.visible // the per-kind toggle only re-runs on its own deps
            const parent = group.parent
            parent?.remove(group)
            disposeDeep(group)
            track(next)
            parent?.add(next)
            t.obj = next // the tag outlives the mesh it points at
          }
        }

        refreshTintRef.current = () => {
          // Same allowlist as the initial pass below. This used to be "anything
          // that isn't a light gizmo", which quietly whitened every marker
          // diamond and the chunk grid — and since the effect that calls this
          // depends on `status`, it ran after EVERY build, so markers were
          // never seen in their own colour at all.
          for (const t of taggedRef.current) if (TINTED_KINDS.includes(t.kind)) applyTint(t.obj)
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
        // Per-plane BLURRED static-shadow grid (kept separate from the sun light,
        // as GroundGL does — the shadow is subtracted from baseStrength in the HSL
        // stage, not from the directional multiplier). Softened via GroundGL's
        // resetLight kernel (centre>>1 + neighbours) so walls/rocks feather into
        // the ground instead of hard 1-corner blobs.
        const blurredShadows = (locBuilds: ({ shadows: Uint8Array } | null)[]): Float32Array[] =>
          locBuilds.map((b) => {
            const s = b?.shadows
            const V = SIZE + 1
            const out = new Float32Array(V * V)
            if (!s) return out
            for (let x = 0; x < V; x++) {
              for (let y = 0; y < V; y++) {
                out[x * V + y] =
                  (s[x * V + y] >> 1)
                  + (x > 0 ? s[(x - 1) * V + y] >> 2 : 0)
                  + (y > 0 ? s[x * V + y - 1] >> 2 : 0)
                  + (y < V - 1 ? s[x * V + y + 1] >> 3 : 0)
                  + (x < V - 1 ? s[(x + 1) * V + y] >> 3 : 0)
              }
            }
            return out
          })

        // Real progress: 8 passes per cell (4 loc planes + 4 terrain planes);
        // the loc passes report a done/total we use for sub-pass fraction.
        // Only the centre region is BUILT. The 8 neighbours are still decoded
        // above because the mosaic needs their heights/underlays for seam-free
        // lighting at the borders, but building their meshes cost ~9x the load
        // time and draw calls for geometry that was never meant to be shown.
        const buildCells = cells.filter((c) => c.dx === 0 && c.dy === 0)
        const totalUnits = Math.max(1, buildCells.length * 8)
        let doneUnits = 0
        const reportProgress = (frac = 0) =>
          setLoadProgress(Math.min(99, ((doneUnits + frac) / totalUnits) * 100))

        for (const { dx, dy, def, terrain, underwater } of buildCells) {
          const isCenter = dx === 0 && dy === 0
          if (disposed) return

          const offsetX = dx * REGION_UNITS
          const offsetZ = -dy * REGION_UNITS
          const label = isCenter ? 'this region' : `neighbour ${def.regionX},${def.regionY}`
          const { heights, lights } = mosaic.slicesFor(dx, dy)
          // Underwater riverbed + per-vertex water depth (HD-water regions only).
          const waterDepthAll = underwater ? computeWaterDepth(underwater) : undefined
          const riverbedHeights = underwater && waterDepthAll
            ? computeRiverbedHeights(heights, waterDepthAll) : undefined
          const palettes = [0, 1, 2, 3].map((plane) => mosaic.paletteFor(dx, dy, plane))
          const overlayCorners = [0, 1, 2, 3].map((plane) => mosaic.overlayCornerFor(dx, dy, plane))
          const underlayCorners = [0, 1, 2, 3].map((plane) => mosaic.underlayCornerFor(dx, dy, plane))

          // locs FIRST — their static shadows darken the terrain lighting
          const objList = isCenter ? initialObjects : def.objects
          const locBuilds: (Awaited<ReturnType<typeof buildLocsMesh>> | null)[] = [null, null, null, null]
          for (let plane = 0; plane < 4; plane++) {
            if (def.hasLocations && objList.length > 0) {
              locBuilds[plane] = await buildLocsMesh(
                terrain, objList, plane, heights, assets,
                (done, total) => {
                  setStatus(`objects (${label}, plane ${plane}): ${done}/${total}`)
                  reportProgress(total > 0 ? done / total : 1)
                },
                isCenter ? lightGrid : undefined,
              )
              if (disposed) return
            }
            doneUnits++ // one loc plane pass done
            reportProgress()
          }
          const shadows = blurredShadows(locBuilds)

          if (isCenter) {
            // the marker list covers the region being edited, like the object list
            setSceneMarkers(locBuilds.flatMap((b) => b?.markers ?? []))
            minimapBaseRef.current = await renderMinimapGround(terrain, configs, 0, mosaic.underlayRgbBlurFor(dx, dy, 0), assets)
            setMinimapVersion((v) => v + 1)
          }

          setStatus(`terrain: ${label}…`)
          for (let plane = 0; plane < 4; plane++) {
            // Riverbed FIRST (opaque, drawn under the transparent water surface):
            // the submerged "um" terrain, positioned at surface+depth, its own
            // underlays giving the sandy/muddy bottom seen through shallow water.
            if (underwater && riverbedHeights) {
              const bed = await buildTerrainMesh(underwater, plane, riverbedHeights, configs, assets)
              if (disposed) return
              if (bed) {
                bed.position.set(offsetX, 0, offsetZ)
                bed.renderOrder = ORDER_RIVERBED // under the water surface
                bed.geometry.computeBoundsTree({ indirect: true })
                // riverbed is never pickable/water-swapped — add directly
                planeGroupsRef.current[plane]?.add(bed)
                taggedRef.current.push({ obj: bed, neighbor: !isCenter, kind: 'riverbed' })
              }
            }
            const terrainMesh = await buildTerrainMesh(terrain, plane, heights, configs, assets, {
              lights,
              shadows,
              palettes,
              overlayCorners,
              underlayCorners,
            }, waterDepthAll)
            if (disposed) return
            if (terrainMesh) {
              terrainMesh.position.set(offsetX, 0, offsetZ)
              terrainMesh.renderOrder = ORDER_TERRAIN
              // indirect: the default mode reorders triangles, which would break
              // the material groups and the faceIndex→triangleOwners mapping
              terrainMesh.geometry.computeBoundsTree({ indirect: true })
              track(terrainMesh)
              planeGroupsRef.current[plane]?.add(terrainMesh)
              taggedRef.current.push({ obj: terrainMesh, neighbor: !isCenter, kind: 'terrain' })
            }
            doneUnits++ // one terrain plane pass done
            reportProgress()
          }

          for (let plane = 0; plane < 4; plane++) {
            const built = locBuilds[plane]
            if (!built) continue
            if (built.mesh) {
              built.mesh.position.set(offsetX, 0, offsetZ)
              built.mesh.renderOrder = ORDER_OPAQUE_LOC
              built.mesh.geometry.computeBoundsTree({ indirect: true })
              track(built.mesh)
              planeGroupsRef.current[plane]?.add(built.mesh)
              taggedRef.current.push({ obj: built.mesh, neighbor: !isCenter, kind: 'loc' })
            }
            // One mesh per transparent loc — three.js frustum-culls and depth-
            // sorts them back-to-front, which is the client's object pass.
            for (const lm of built.transparentLocs) {
              lm.position.x += offsetX
              lm.position.z += offsetZ
              lm.renderOrder = ORDER_TRANSPARENT_LOC
              track(lm)
              applyTint(lm)
              planeGroupsRef.current[plane]?.add(lm)
              taggedRef.current.push({ obj: lm, neighbor: !isCenter, kind: 'loc' })
            }
            // Animated locs (waving flags etc.): a separate posable mesh each,
            // placed with the region offset baked into the mesh transform.
            for (const al of built.animated) {
              const anim = await buildAnimatedLocMesh(al.model, al.matrix, assets, undefined, al.owner, al.points, al.ambient, al.contrast)
              if (disposed) return
              if (!anim) continue
              anim.mesh.matrixAutoUpdate = false
              anim.mesh.matrix.copy(new THREE.Matrix4().makeTranslation(offsetX, 0, offsetZ).multiply(al.matrix))
              anim.mesh.updateMatrixWorld(true)
              // the placement is baked into the matrix, so mesh.position stays
              // at the origin — record the region for resolveLocAt explicitly
              anim.mesh.userData.locRegion = { x: def.regionX, y: def.regionY }
              track(anim.mesh)
              planeGroupsRef.current[plane]?.add(anim.mesh)
              taggedRef.current.push({ obj: anim.mesh, neighbor: !isCenter, kind: 'loc' })
              if (anim.mesh.userData.sortCentreY !== undefined) sortCentreRef.current.push(anim.mesh)
              const sphere = anim.mesh.geometry.boundingSphere
                ? anim.mesh.geometry.boundingSphere.clone().applyMatrix4(anim.mesh.matrixWorld)
                : new THREE.Sphere(new THREE.Vector3(offsetX, 0, offsetZ), 1e9)
              animLocsRef.current.push({ update: anim.update, model: al.model, animationId: al.animationId, neighbor: !isCenter, mesh: anim.mesh, sphere })
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

          // the region's 8×8 chunk grid; its outer lines are the region border
          const outline = buildChunkGrid(heights[0])
          outline.position.set(offsetX, 0, offsetZ)
          track(outline)
          outlines.add(outline)
          taggedRef.current.push({ obj: outline, neighbor: !isCenter, kind: 'outline' })
        }

        setLightGizmos(currentLights)

        // Resolve each distinct loc idle sequence once, preload its frames, and
        // hand the animator to every placement that uses it (the RAF loop poses).
        if (animLocsRef.current.length > 0 && data.rootHandle) {
          const animsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('animations'))
          if (animsDir) {
            const ids = [...new Set(animLocsRef.current.map((a) => a.animationId))]
            const animators = new Map<number, LocAnimator>()
            await Promise.all(ids.map(async (id) => {
              try {
                const def = JSON.parse(await (await (await animsDir.getFileHandle(`${id}.json`)).getFile()).text()) as AnimationDef
                const animator = new LocAnimator(def)
                await animator.preload(data.rootHandle!)
                animators.set(id, animator)
              } catch { /* animation not dumped — that flag stays at rest */ }
            }))
            if (disposed) return
            for (const rec of animLocsRef.current) rec.animator = animators.get(rec.animationId)
          }
        }

        for (const { obj, kind } of taggedRef.current) {
          if (TINTED_KINDS.includes(kind)) applyTint(obj)
        }


        let centerHeights = mosaic.slicesFor(0, 0).heights

        // --- Place-mode ghost: a translucent single-loc mesh under the cursor
        let ghost: { obj: THREE.Object3D; key: string } | null = null
        // The key of a build that has been STARTED but hasn't landed yet.
        // Without it, `ghost` stays null for the whole build, so every further
        // update — even for the same tile — looked like a new target, bumped
        // the token and restarted the build. A drag fires pointermove faster
        // than buildLocsMesh resolves, so each build cancelled the last and the
        // ghost never appeared at all unless the cursor stopped dead.
        let ghostPendingKey: string | null = null
        let ghostToken = 0
        const clearGhost = () => {
          // also abandon any in-flight build, or it lands after the drag ends
          // and leaves a stray ghost in the scene with nothing to clear it
          ghostToken++
          ghostPendingKey = null
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
          if (ghost?.key === key || ghostPendingKey === key) return
          ghostPendingKey = key
          const token = ++ghostToken
          void (async () => {
            const { mesh, transparentLocs, markers, animated } = await buildLocsMesh(
              currentTerrain, [[p.objectId, p.type, p.rotation, tx, ty, p.plane] as LocEntry],
              p.plane, centerHeights, assets,
            )
            // A loc's geometry comes back on one of THREE paths, and ghosting
            // only the first meant whole classes of object produced no ghost at
            // all, silently: `mesh` is the merged OPAQUE mesh, `transparentLocs`
            // is one mesh per loc with transparent faces (a fountain — which is
            // how this was found), and `animated` is pulled out of the merge
            // entirely (waving flags). Their placement is already baked in for
            // the centre region, so no offset is needed here.
            const parts: THREE.Object3D[] = []
            if (mesh) parts.push(mesh)
            for (const lm of transparentLocs) parts.push(lm)
            for (const al of animated) {
              const anim = await buildAnimatedLocMesh(al.model, al.matrix, assets, undefined, al.owner, al.points, al.ambient, al.contrast)
              if (!anim) continue
              anim.mesh.matrixAutoUpdate = false
              anim.mesh.matrix.copy(al.matrix)
              anim.mesh.updateMatrixWorld(true)
              parts.push(anim.mesh)
            }
            // marker objects have no visible model — ghost their diamond
            if (parts.length === 0 && markers.length > 0) {
              const diamonds = buildMarkersMesh(markers)
              if (diamonds) parts.push(diamonds)
            }
            if (disposed || token !== ghostToken) {
              for (const part of parts) disposeDeep(part)
              return
            }
            if (parts.length === 0) return
            // clearGhost bumps the token; nothing below re-checks it
            clearGhost()
            let obj: THREE.Object3D
            if (parts.length === 1) {
              obj = parts[0]
            } else {
              obj = new THREE.Group()
              for (const part of parts) obj.add(part)
            }
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

        // Edit-tab marquee: project every centre-region loc and select those
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

        /** Blank out one placement's triangles in whichever centre merged mesh
         *  owns them. Collapsing to a degenerate triangle is how the loc build
         *  already hides alpha-hidden faces, and it keeps every index stable —
         *  `triangleOwners` and the material groups are both positional, so
         *  actually removing triangles would invalidate picking. Zero-area
         *  triangles rasterise to nothing and can't be raycast, so the BVH is
         *  left alone too. */
        function hideLocInMerged(entry: LocEntry): boolean {
          // EVERY mesh, not the first match: one placement is routinely split
          // across several — its opaque faces in the plane's merged mesh, its
          // transparent ones in a per-loc mesh or the shared-transparent
          // bucket. Stopping at the first left the rest of the object on
          // screen, which read as "the delete didn't work".
          // An animated placement is its own mesh, posed every frame — blanking
          // its triangles achieves nothing because the animator rewrites them
          // on the next tick. It has to leave the scene and the pose list.
          let removedAnimated = false
          animLocsRef.current = animLocsRef.current.filter((rec) => {
            const l = (rec.mesh?.userData.locs as LocRef[] | undefined)?.[0]
            if (rec.neighbor || !l) return true
            if (l.objectId !== entry[0] || l.shape !== entry[1] || l.rotation !== entry[2]
              || l.x !== entry[3] || l.y !== entry[4] || l.plane !== entry[5]) return true
            // an animated loc's highlight SHARES this geometry (so it follows
            // the pose) — dropping it first, or the dispose below guts it
            clearLocHighlight()
            rec.mesh.parent?.remove(rec.mesh)
            disposeDeep(rec.mesh)
            taggedRef.current = taggedRef.current.filter((t) => t.obj !== rec.mesh)
            sortCentreRef.current = sortCentreRef.current.filter((m) => m !== rec.mesh)
            removedAnimated = true
            return false
          })
          if (removedAnimated) return true

          let hidAny = false
          for (const tagged of taggedRef.current) {
            if (tagged.neighbor || tagged.kind !== 'loc') continue
            const mesh = tagged.obj as THREE.Mesh
            const locs = mesh.userData.locs as LocRef[] | undefined
            const owners = mesh.userData.triangleOwners as Int32Array | undefined
            if (!locs || !owners) continue
            const owner = locs.findIndex((l) => l.objectId === entry[0] && l.shape === entry[1]
              && l.rotation === entry[2] && l.x === entry[3] && l.y === entry[4] && l.plane === entry[5])
            if (owner < 0) continue
            const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
            const pos = attr.array as Float32Array
            let hid = false
            for (let t = 0; t < owners.length; t++) {
              if (owners[t] !== owner) continue
              pos.fill(0, t * 9, t * 9 + 9)
              hid = true
            }
            if (hid) { attr.needsUpdate = true; hidAny = true }
          }
          return hidAny
        }

        /** Fast path for an edit that touches only a handful of placements —
         *  which is every drag, rotate, place and delete.
         *
         *  The full rebuild below re-merges every loc on all four planes (5926
         *  of them in Lumbridge, 3574 on plane 0 alone) plus four planes of
         *  terrain, because the locs of a plane share ONE geometry and loc
         *  shadows feed the terrain's vertex lighting. None of that is needed
         *  to move one object: this hides the old placement in the merge and
         *  gives the new one a mesh of its own, built by the same
         *  `buildLocsMesh` with a one-entry list so contouring, lighting,
         *  textures and transparency all still come from the real pipeline.
         *
         *  What it deliberately does NOT update: the static shadow the loc
         *  casts on the ground, and the minimap. Both are terrain-side and
         *  both catch up on the next full rebuild (a terrain edit, a region
         *  change, or Save). Returns false when the edit is too broad to
         *  patch, and the caller falls back to the full rebuild. */
        const patchLocsImpl = async (prev: LocEntry[], next: LocEntry[]): Promise<boolean> => {
          if (disposed) return false
          const key = (e: LocEntry) => e.join(',')
          const before = new Map<string, LocEntry>()
          for (const e of prev) before.set(key(e), e)
          const added: LocEntry[] = []
          for (const e of next) {
            const k = key(e)
            if (before.has(k)) before.delete(k)
            else added.push(e)
          }
          const removed = [...before.values()]
          if (added.length === 0 && removed.length === 0) return true
          if (added.length + removed.length > PATCH_LIMIT) return false

          // BUILD FIRST, then touch the scene. Anything unexpected below bails
          // to the full rebuild, and bailing must leave the scene exactly as it
          // was — hiding the old placement before knowing the new one built
          // would strand a half-applied edit with nothing to correct it.
          const fresh: { obj: THREE.Object3D; plane: number; kind: Tagged['kind'] }[] = []
          const freshAnim: AnimLocRecord[] = []
          // Animators are shared by animation id — the full rebuild caches them
          // that way too — so a MOVED animated loc can reuse the instance
          // already in memory and never touch the disk. A newly PLACED one has
          // no such instance and does need the rebuild to load it.
          const animators = new Map<number, LocAnimator>()
          for (const rec of animLocsRef.current) {
            if (rec.animator && !animators.has(rec.animationId)) animators.set(rec.animationId, rec.animator)
          }
          const bail = (why: string) => {
            console.info(`[map] placement patch fell back to a full rebuild: ${why}`)
            return false
          }
          try {
            for (const entry of added) {
              let built = false
              // Only the planes this placement can land on, not all four. A loc
              // renders on its decoded plane, or one below it when its tile
              // carries the bridge flag — so at most two builds, each of which
              // costs a set of fresh materials (and their shader compiles).
              const candidates = entry[5] > 0 ? [entry[5], entry[5] - 1] : [0]
              for (const plane of candidates) {
                const b = await buildLocsMesh(
                  currentTerrain, [entry], plane, centerHeights, assets, undefined, lightGrid,
                )
                if (disposed) return false
                for (const m of [...(b.mesh ? [b.mesh] : []), ...b.transparentLocs]) {
                  m.renderOrder = m === b.mesh ? ORDER_OPAQUE_LOC : ORDER_TRANSPARENT_LOC
                  m.geometry.computeBoundsTree({ indirect: true })
                  track(m)
                  applyTint(m)
                  fresh.push({ obj: m, plane, kind: 'loc' })
                  built = true
                }
                if (b.markers.length > 0) {
                  const markerGroup = buildMarkersMesh(b.markers)
                  if (markerGroup) {
                    track(markerGroup)
                    fresh.push({ obj: markerGroup, plane, kind: 'marker' })
                    built = true
                  }
                }
                for (const al of b.animated) {
                  const animator = animators.get(al.animationId)
                  // no loaded animator means nothing in the scene uses this
                  // animation yet — the rebuild reads and preloads it
                  if (!animator) return bail(`object ${entry[0]} animation ${al.animationId} is not loaded yet`)
                  const anim = await buildAnimatedLocMesh(al.model, al.matrix, assets, undefined, al.owner, al.points, al.ambient, al.contrast)
                  if (disposed) return false
                  if (!anim) continue
                  anim.mesh.matrixAutoUpdate = false
                  anim.mesh.matrix.copy(al.matrix)
                  anim.mesh.updateMatrixWorld(true)
                  anim.mesh.userData.locRegion = { x: data.def.regionX, y: data.def.regionY }
                  track(anim.mesh)
                  applyTint(anim.mesh)
                  fresh.push({ obj: anim.mesh, plane, kind: 'loc' })
                  freshAnim.push({
                    update: anim.update, model: al.model, animationId: al.animationId,
                    animator, neighbor: false, mesh: anim.mesh,
                    sphere: anim.mesh.geometry.boundingSphere
                      ? anim.mesh.geometry.boundingSphere.clone().applyMatrix4(anim.mesh.matrixWorld)
                      : new THREE.Sphere(new THREE.Vector3(), 1e9),
                  })
                  built = true
                }
              }
              // produced nothing on any plane: the placement would silently
              // vanish, so hand it to the rebuild instead
              if (!built) return bail(`object ${entry[0]} built no geometry on plane ${entry[5]}`)
            }
            // a placement we can't find in the merge means the scene isn't the
            // one this diff was computed against — fall back rather than guess
            for (const e of removed) {
              if (!hideLocInMerged(e)) return bail(`object ${e[0]} at ${e[3]},${e[4]} plane ${e[5]} not found in any merged mesh`)
            }
          } catch (e) {
            return bail(String(e))
          }

          for (const { obj, plane, kind } of fresh) {
            obj.visible = kind === 'loc' ? showLocsRef.current : showMarkersRef.current
            planeGroupsRef.current[plane]?.add(obj)
            taggedRef.current.push({ obj, neighbor: false, kind })
            const mesh = obj as THREE.Mesh
            if (mesh.userData?.sortCentreY !== undefined) sortCentreRef.current.push(mesh)
          }
          animLocsRef.current.push(...freshAnim)
          return true
        }

        // unified partial rebuild for terrain AND placement edits: recompute
        // the mosaic, rebuild the centre's locs (whose static shadows feed
        // the terrain lighting), minimap, terrain and outline. Neighbour
        // meshes keep their old boundary values; only visible when brushing
        // the outermost tiles.
        const rebuildCenterImpl = async (nextTerrain: MapTerrain, nextObjects: LocEntry[], nextLights?: RegionLight[]) => {
          if (disposed) return
          currentTerrain = nextTerrain
          if (nextLights) {
            currentLights = nextLights
            setSceneLights(nextLights)
          }
          clearLocHighlight()
          setStatus('recomputing…')
          await new Promise((resolve) => setTimeout(resolve, 0)) // let the status paint
          regionGrid[1][1] = nextTerrain
          const nextMosaic = new SceneMosaic(regionGrid, data.def.regionX, data.def.regionY, configs, sun, assets.brightness)
          if (disposed) return
          const slices = nextMosaic.slicesFor(0, 0)
          centerHeights = slices.heights
          // heights moved (a height brush) or the lights themselves changed —
          // either way the grid and the gizmos have to be rebuilt, since a
          // light's y is relative to its tile's ground
          lightHeights = centerHeights
          lightGrid = buildLightGrid(currentLights, lightHeights)
          const palettes = [0, 1, 2, 3].map((pl) => nextMosaic.paletteFor(0, 0, pl))
          const overlayCorners = [0, 1, 2, 3].map((pl) => nextMosaic.overlayCornerFor(0, 0, pl))
          const underlayCorners = [0, 1, 2, 3].map((pl) => nextMosaic.underlayCornerFor(0, 0, pl))

          // light gizmos are deliberately NOT dropped here: setLightGizmos owns
          // them and swaps them at the end, so they stay on screen (and pickable)
          // through the rebuild instead of blinking out for a few seconds
          const stale = taggedRef.current.filter((t) => !t.neighbor
            && (t.kind === 'terrain' || t.kind === 'riverbed' || t.kind === 'outline' || t.kind === 'loc' || t.kind === 'marker'))
          taggedRef.current = taggedRef.current.filter((t) => !stale.includes(t))
          for (const { obj } of stale) {
            obj.parent?.remove(obj)
            disposeDeep(obj)
          }
          // the centre's animated-loc meshes were just disposed with the loc
          // meshes above — drop their pose records (neighbours survive)
          animLocsRef.current = animLocsRef.current.filter((r) => r.neighbor)
          // drop sort entries whose mesh was just disposed (parent detached)
          sortCentreRef.current = sortCentreRef.current.filter((m) => m.parent !== null)

          const locBuilds: (Awaited<ReturnType<typeof buildLocsMesh>> | null)[] = [null, null, null, null]
          if (nextObjects.length > 0) {
            for (let plane = 0; plane < 4; plane++) {
              locBuilds[plane] = await buildLocsMesh(
                nextTerrain, nextObjects, plane, centerHeights, assets,
                (done, total) => setStatus(`updating objects (plane ${plane}): ${done}/${total}`),
                lightGrid,
              )
              if (disposed) return
            }
          }
          const shadows = blurredShadows(locBuilds)

          setSceneMarkers(locBuilds.flatMap((b) => b?.markers ?? []))
          minimapBaseRef.current = await renderMinimapGround(nextTerrain, configs, 0, nextMosaic.underlayRgbBlurFor(0, 0, 0), assets)
          setMinimapVersion((v) => v + 1)

          const uwCenter = data.underwaterTerrain
          const uwDepthCenter = uwCenter ? computeWaterDepth(uwCenter) : undefined
          const riverbedCenter = uwCenter && uwDepthCenter
            ? computeRiverbedHeights(centerHeights, uwDepthCenter) : undefined
          for (let plane = 0; plane < 4; plane++) {
            setStatus(`rebuilding terrain (plane ${plane})…`)
            if (uwCenter && riverbedCenter) {
              const bed = await buildTerrainMesh(uwCenter, plane, riverbedCenter, configs, assets)
              if (disposed) return
              if (bed) {
                bed.renderOrder = ORDER_RIVERBED
                bed.geometry.computeBoundsTree({ indirect: true })
                applyTint(bed)
                planeGroupsRef.current[plane]?.add(bed)
                taggedRef.current.push({ obj: bed, neighbor: false, kind: 'riverbed' })
              }
            }
            const terrainMesh = await buildTerrainMesh(nextTerrain, plane, centerHeights, configs, assets, {
              lights: slices.lights,
              shadows,
              palettes,
              overlayCorners,
              underlayCorners,
            }, uwDepthCenter)
            if (disposed) return
            if (terrainMesh) {
              terrainMesh.renderOrder = ORDER_TERRAIN
              terrainMesh.geometry.computeBoundsTree({ indirect: true })
              track(terrainMesh)
              applyTint(terrainMesh)
              planeGroupsRef.current[plane]?.add(terrainMesh)
              taggedRef.current.push({ obj: terrainMesh, neighbor: false, kind: 'terrain' })
            }
          }
          const rebuiltAnim: AnimLocRecord[] = []
          for (let plane = 0; plane < 4; plane++) {
            const built = locBuilds[plane]
            if (!built) continue
            if (built.mesh) {
              built.mesh.renderOrder = ORDER_OPAQUE_LOC
              built.mesh.geometry.computeBoundsTree({ indirect: true })
              track(built.mesh)
              applyTint(built.mesh)
              planeGroupsRef.current[plane]?.add(built.mesh)
              taggedRef.current.push({ obj: built.mesh, neighbor: false, kind: 'loc' })
            }
            for (const lm of built.transparentLocs) {
              lm.renderOrder = ORDER_TRANSPARENT_LOC
              track(lm)
              applyTint(lm)
              planeGroupsRef.current[plane]?.add(lm)
              taggedRef.current.push({ obj: lm, neighbor: false, kind: 'loc' })
            }
            for (const al of built.animated) {
              const anim = await buildAnimatedLocMesh(al.model, al.matrix, assets, undefined, al.owner, al.points, al.ambient, al.contrast)
              if (disposed) return
              if (!anim) continue
              anim.mesh.matrixAutoUpdate = false
              anim.mesh.matrix.copy(al.matrix)
              anim.mesh.updateMatrixWorld(true)
              anim.mesh.userData.locRegion = { x: data.def.regionX, y: data.def.regionY }
              track(anim.mesh)
              applyTint(anim.mesh)
              planeGroupsRef.current[plane]?.add(anim.mesh)
              taggedRef.current.push({ obj: anim.mesh, neighbor: false, kind: 'loc' })
              if (anim.mesh.userData.sortCentreY !== undefined) sortCentreRef.current.push(anim.mesh)
              const sphere = anim.mesh.geometry.boundingSphere
                ? anim.mesh.geometry.boundingSphere.clone().applyMatrix4(anim.mesh.matrixWorld)
                : new THREE.Sphere(new THREE.Vector3(), 1e9)
              rebuiltAnim.push({ update: anim.update, model: al.model, animationId: al.animationId, neighbor: false, mesh: anim.mesh, sphere })
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
          // re-resolve animators for the rebuilt centre flags, then re-register
          if (rebuiltAnim.length > 0 && data.rootHandle) {
            const animsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('animations'))
            if (animsDir) {
              const cache = new Map<number, LocAnimator>()
              await Promise.all([...new Set(rebuiltAnim.map((a) => a.animationId))].map(async (id) => {
                try {
                  const def = JSON.parse(await (await (await animsDir.getFileHandle(`${id}.json`)).getFile()).text()) as AnimationDef
                  const animator = new LocAnimator(def)
                  await animator.preload(data.rootHandle!)
                  cache.set(id, animator)
                } catch { /* animation not dumped */ }
              }))
              if (disposed) return
              for (const rec of rebuiltAnim) rec.animator = cache.get(rec.animationId)
            }
            animLocsRef.current.push(...rebuiltAnim)
          }
          const outline = buildChunkGrid(centerHeights[0])
          track(outline)
          outlines.add(outline)
          taggedRef.current.push({ obj: outline, neighbor: false, kind: 'outline' })
          setLightGizmos(currentLights)
          // keep the selected light's ring on it (its record — and the ground
          // under it — may have just moved)
          const selLight = selectionRef.current
          if (selLight?.kind === 'light') {
            const rec = currentLights[selLight.index]
            if (rec) highlightLight(rec)
            else clearLightHighlight()
          }
          setStatus('')
        }

        // Builds are SERIALIZED. Rebuilds and patches from rapid successive
        // edits — or a transform-to preview toggled while the previous
        // preview's rebuild was still in flight — used to run concurrently:
        // each disposed the meshes it could see and added its own, so the
        // earlier build's late-added meshes survived as ghosts (an animated
        // loc kept playing after its placement was previewed away). Queued
        // rebuilds coalesce latest-wins, so mid-build edits don't stack a
        // backlog of stale multi-second rebuilds.
        let buildChain: Promise<unknown> = Promise.resolve()
        const enqueueBuild = <T,>(fn: () => Promise<T>): Promise<T> => {
          const run = buildChain.then(fn)
          buildChain = run.then(() => undefined, () => undefined)
          return run
        }
        let queuedRebuild: { t: MapTerrain; o: LocEntry[]; l?: RegionLight[] } | null = null
        rebuildCenterRef.current = (t, o, l) => {
          const idle = queuedRebuild === null
          queuedRebuild = { t, o, l }
          if (!idle) return buildChain.then(() => undefined) // an already-queued rebuild will pick this payload up
          return enqueueBuild(async () => {
            const job = queuedRebuild!
            queuedRebuild = null
            await rebuildCenterImpl(job.t, job.o, job.l)
          })
        }
        patchLocsRef.current = (prev, next) => enqueueBuild(() => patchLocsImpl(prev, next))
        setStatus('')
      } catch (e) {
        setStatus(`scene build failed: ${e}`)
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('mousedown', onMiddleMouseDown)
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
      composer.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      clearLocHighlight()
      ghostClearRef.current?.()
      highlightClearRef.current = null
      lightHighlightClearRef.current = null
      selectOutlineClearRef.current = null
      rebuildCenterRef.current = null
      patchLocsRef.current = null
      fogApplyRef.current = null
      selectFromListRef.current = null
      selectLightFromListRef.current = null
      selectMarkerFromListRef.current = null
      previewLightRef.current = null
      // light gizmos are rebuilt in place rather than tracked, so they aren't in
      // `disposables` — free them here
      for (const t of taggedRef.current) if (t.kind === 'light') disposeDeep(t.obj)
      ghostUpdateRef.current = null
      ghostClearRef.current = null
      planeGroupsRef.current = [null, null, null, null]
      taggedRef.current = []
      skyMeshRef.current = null
    }
  }, [data])

  // placement draft changed (Apply/Delete/place/move) — or a transform-to
  // preview toggled: unified centre rebuild — loc shadows feed the terrain
  // lighting, so terrain rebuilds too. `status` is a dep so an edit made
  // mid-build is caught up when it finishes.
  useEffect(() => {
    if (!sceneObjects || sceneObjects === lastBuiltObjectsRef.current) return
    const rebuild = rebuildCenterRef.current
    if (!rebuild) return
    const prevObjects = lastBuiltObjectsRef.current
    // a terrain edit landing in the same commit changes the ground the locs
    // sit on, so only a placement-only change is patchable
    const terrainUnchanged = lastBuiltTerrainRef.current === terrainPropRef.current
    // the unified rebuild consumes BOTH drafts — mark both as built so a
    // combined commit (e.g. a stamp paste) doesn't rebuild twice
    lastBuiltObjectsRef.current = sceneObjects
    lastBuiltTerrainRef.current = terrainPropRef.current
    void (async () => {
      const patch = patchLocsRef.current
      if (patch && prevObjects && terrainUnchanged && await patch(prevObjects, sceneObjects)) return
      await rebuild(terrainPropRef.current ?? data.terrain, sceneObjects)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneObjects, status])

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

  // point-light draft changed: same unified rebuild, because the lights are
  // baked into the locs' vertex colours (and the terrain's, via the mosaic)
  useEffect(() => {
    if (!lights || lights === lastBuiltLightsRef.current) return
    const rebuild = rebuildCenterRef.current
    if (!rebuild) return
    lastBuiltLightsRef.current = lights
    lastBuiltObjectsRef.current = objectsPropRef.current
    lastBuiltTerrainRef.current = terrainPropRef.current
    void rebuild(
      terrainPropRef.current ?? data.terrain,
      objectsPropRef.current ?? data.def.objects,
      lights,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lights, status])

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

  // close-button / cleared selection also drops every selection visual. The
  // marker outline was missing here, so closing a sound emitter's panel left it
  // outlined in the scene with nothing selected.
  useEffect(() => {
    if (!selection) {
      highlightClearRef.current?.()
      lightHighlightClearRef.current?.()
      selectOutlineClearRef.current?.()
    }
  }, [selection])

  // Draft object defs → the scene. The panel's in-flight edit layers over the
  // applied drafts, then marker kinds are re-derived; `status` is a dep so a
  // fresh build (new LocAssets) gets the overrides handed to it again.
  useEffect(() => {
    const assets = assetsRef.current
    if (!assets) return
    const merged = new Map(objectDefs ?? [])
    if (previewDef) merged.set(previewDef.id, previewDef.def)
    assets.setDefOverrides(merged)
    void refreshMarkersRef.current?.()
  }, [objectDefs, previewDef, status])

  // leaving Place mode (cancel, Esc, or a committed placement) drops the ghost
  useEffect(() => {
    if (!placing) ghostClearRef.current?.()
  }, [placing])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPlacing(false)
        setPasteArmed(false)
        setAddingLight(false)
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
    setAddingLight(false)
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
      else if (k === 'e') setSideTab('edit')
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
            const kind = markerKindFromDef(def)
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
    // objectDefs: a def edit changes a marker's kind (and so this list's colour
    // and the minimap's icon/sprite lookups) without touching the placements
  }, [listEntries, status, objectDefs])

  // MAP_AREAS static elements (world-map-only pins, scanned out of
  // map_areas/static_elements and resolved to area icons) used to be overlaid
  // on this minimap behind a "World-map icons" toggle. Both the loader and the
  // draw were removed 2026-07-25 — see the Map Areas note in TODO.md for why,
  // and for what to rebuild when they get a proper home on the world map.

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

  // Row thumbnails for the View-tab lists: mapCategoryId → icon URL and
  // mapSpriteId → sprite URL. Both go through the same ref-cached loaders the
  // Edit panel uses, so a list that's already been opened costs no extra reads.
  //
  // Deliberately NOT gated on `displayedOnMinimap` the way `areaBitmaps` above
  // is: that gate is correct for the minimap DRAW, but these lists exist to
  // answer "which object carries this icon?", and an area that never shows on
  // the minimap still has one.
  const [iconUrls, setIconUrls] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    const cats = [...new Set(objCats.values())]
    if (cats.length === 0) { setIconUrls(new Map()); return }
    let cancelled = false
    void (async () => {
      const out = new Map<number, string>()
      await Promise.all(cats.map(async (cat) => {
        const info = await loadAreaInfoRef.current(cat)
        if (info?.spriteUrl) out.set(cat, info.spriteUrl)
      }))
      if (!cancelled) setIconUrls(out)
    })()
    return () => { cancelled = true }
  }, [objCats])

  const [spriteUrls, setSpriteUrls] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    const ids = [...new Set(objSprites.values())]
    if (ids.length === 0) { setSpriteUrls(new Map()); return }
    let cancelled = false
    void (async () => {
      const out = new Map<number, string>()
      await Promise.all(ids.map(async (id) => {
        const info = await loadMapSpriteInfoRef.current(id)
        if (info?.url) out.set(id, info.url)
      }))
      if (!cancelled) setSpriteUrls(out)
    })()
    return () => { cancelled = true }
  }, [objSprites])

  // one object so the lists' sort memos have a single stable dependency
  // Would placing the drafted object force the slow path? Mirrors the one bail
  // the placement patch still has: an animated object whose animation nothing
  // on screen uses yet has no loaded animator to hand the new mesh, so it needs
  // the rebuild to read and preload it. An animated object that IS already
  // running somewhere patches in like any other, so this stays quiet for it.
  const [placeNeedsRebuild, setPlaceNeedsRebuild] = useState(false)
  useEffect(() => {
    const assets = assetsRef.current
    if (!assets || status !== '') return
    let cancelled = false
    void (async () => {
      let animId = -1
      try {
        animId = (await assets.getDef(placeDraft.objectId))?.animations?.[0] ?? -1
      } catch { /* def missing — nothing to warn about */ }
      if (cancelled) return
      setPlaceNeedsRebuild(animId >= 0
        && !animLocsRef.current.some((r) => r.animator && r.animationId === animId))
    })()
    return () => { cancelled = true }
  }, [placeDraft.objectId, status])

  const mapSymbols = useMemo<MapSymbols>(
    () => ({ cats: objCats, sprites: objSprites, iconUrls, spriteUrls }),
    [objCats, objSprites, iconUrls, spriteUrls],
  )

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

    // mapscene sprites (tree/rock symbols), anchored at the placement tile.
    // Wall decorations are skipped: the client's per-tile pass
    // (Static.method13042) reads mapSpriteId from the wall, scenery and
    // floor-decoration slots only and never asks for the decoration slot, so
    // a type 4-8 placement never draws one however its def is set.
    for (const e of listEntries) {
      if (e[5] !== 0) continue
      if ((OBJECT_SLOTS[e[1]] ?? 2) === 1) continue
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

  }, [data, terrain, listEntries, objCats, areaBitmaps, objSprites, spriteBitmaps, objInteractive, minimapVersion, sideTab, terrainBrush, mmGammaLut])

  useEffect(() => {
    if (skyMeshRef.current) skyMeshRef.current.visible = showSky
  }, [showSky, status])

  useEffect(() => {
    if (bloomPassRef.current) bloomPassRef.current.enabled = bloomOn
    // The client gates HDR float textures on the bloom filter being live
    // (Class66 checks method8471(), which IS the bloom filter), so turning bloom
    // off must also drop the overbright multiplier — otherwise the flame would
    // clamp to white instead of the client's dim orange.
    refreshTintRef.current?.()
  }, [bloomOn, status])

  // --- point lights ----------------------------------------------------
  // The parent owns the draft (map_environments `lights[]`) exactly like the
  // terrain/placement drafts. Without it the lights are still listed, gizmo'd
  // and selectable — just read-only.
  const lightList = lights ?? sceneLights
  const canEditLights = !!onEdit && !!lights
  const commitLights = (next: RegionLight[]) => onEdit?.({ lights: next })
  onAddLightRef.current = (tx, ty) => {
    // Everything else is derived: the tile centre, and a footprint matching the
    // chosen size. The new light is selected straight away, so the full panel
    // is there for anything the Place tab's few fields don't cover.
    const rec: RegionLight = {
      plane: lightDraft.plane,
      growsUpwards: false,
      growsDownwards: false,
      x: tx * 512 + 256,
      z: ty * 512 + 256,
      y: lightDraft.y,
      size2d: lightDraft.size2d,
      ranges: lightRangesFor(lightDraft.size2d),
      colorHsl: lightDraft.colorHsl,
      type: lightDraft.type,
      rotationOffset: 0,
    }
    const next = [...lightList, rec]
    setSelection({ kind: 'light', index: next.length - 1, light: rec })
    setAddingLight(false)
    commitLights(next)
  }

  // visibility = plane toggle (via group) AND per-kind toggle
  useEffect(() => {
    planeGroupsRef.current.forEach((group, plane) => {
      if (group) group.visible = visiblePlanes[plane]
    })
    for (const { obj, kind } of taggedRef.current) {
      obj.visible = kind === 'loc' ? showLocs
        : kind === 'marker' ? showMarkers
        : kind === 'light' ? showLights
        : kind === 'outline' ? showOutlines
        : true
    }
    if (!showLights) lightHighlightClearRef.current?.()
  }, [visiblePlanes, showLocs, showMarkers, showLights, showOutlines, status])

  // The Client graphics settings dropdown. Rendered into the parent header
  // beside the Regions button when a slot is provided (portal — state stays
  // here); falls back to the controls bar otherwise.
  const gfxDropdown = (
    <div className="mapscene-gfx">
      <button type="button" className="mapscene-gfx-btn" onClick={() => setShowGfxPanel((v) => !v)}>
        Client graphics settings {showGfxPanel ? '▾' : '▸'}
      </button>
      {showGfxPanel && (
        <div className="mapscene-gfx-panel">
          <div className="mapscene-gfx-head">
            The client’s graphics preferences and what we mirror — rows with a control are live.
          </div>
          <div className="mapscene-gfx-list">
            {CLIENT_GFX_SETTINGS.map((g) => (
              <div key={g.name} className="mapscene-gfx-item">
                <div className="mapscene-gfx-itemhead">
                  <span className="mapscene-gfx-name">{g.name}</span>
                  {g.control === 'bloom' && (
                    <span className="btn-pill">
                      <button type="button" className={`zoom-btn${bloomOn ? ' active' : ''}`} onClick={() => setBloomOn(true)}>On</button>
                      <button type="button" className={`zoom-btn${!bloomOn ? ' active' : ''}`} onClick={() => setBloomOn(false)}>Off</button>
                    </span>
                  )}
                  {g.control === 'fog' && (
                    <span className="btn-pill">
                      <button type="button" className={`zoom-btn${fogOn ? ' active' : ''}`} onClick={() => setFogOn(true)}>On</button>
                      <button type="button" className={`zoom-btn${!fogOn ? ' active' : ''}`} onClick={() => setFogOn(false)}>Off</button>
                    </span>
                  )}
                  {g.control === 'drawDistance' && (
                    <span className="mapscene-gfx-slider">
                      <input
                        type="range" min={8} max={96} step={1} value={fogTiles}
                        onChange={(e) => setFogTiles(Number(e.target.value))}
                        disabled={!fogOn}
                      />
                      <span className="mapscene-gfx-sliderval">{fogTiles} tiles</span>
                    </span>
                  )}
                  {g.control === 'brightness' && (
                    <span className="mapscene-gfx-slider">
                      <input
                        type="range" min={1} max={4} step={1} value={brightnessPref}
                        onChange={(e) => setBrightnessPref(Number(e.target.value))}
                      />
                      <span className="mapscene-gfx-sliderval">{brightnessPref} · ambient ×{(0.7 + 0.1 * brightnessPref).toFixed(1)}</span>
                    </span>
                  )}
                  <span className="mapscene-gfx-tail">
                    <span className="mapscene-gfx-def">client default: {g.def}</span>
                    <span className={`mapscene-gfx-badge is-${g.status.replace('/', '')}`}>{
                      g.status === 'applied' ? 'applied' : g.status === 'partial' ? 'partial' : g.status === 'no' ? 'not applied' : 'n/a'
                    }</span>
                  </span>
                </div>
                <div className="mapscene-gfx-note">{g.note}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="mapscene">
      {gfxSlot && createPortal(gfxDropdown, gfxSlot)}
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
          <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
          Chunk grid
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showSky} onChange={(e) => setShowSky(e.target.checked)} />
          Sky
        </label>
        {!gfxSlot && gfxDropdown}
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
          <span className="mapscene-marker-key">
            Markers (<span style={{ color: '#ff9d3a' }}>sound</span>/<span style={{ color: '#b47aff' }}>map icon</span>/<span style={{ color: '#3ad0c8' }}>map sprite</span>/<span style={{ color: '#ff5a5a' }}>barrier</span>)
          </span>
        </label>
        <label
          className="mapscene-toggle"
          title="Region point lights (map_environments lights[]) — diamond + radius ring in the light's own colour. A light hidden inside the loc it lights is still clickable (picking ignores what's in front of it); the selected one's ring shows through geometry."
        >
          <input type="checkbox" checked={showLights} onChange={(e) => setShowLights(e.target.checked)} />
          <span className="mapscene-marker-key">
            Point lights{lightList.length > 0 ? ` (${lightList.length})` : ''}
          </span>
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
        <span ref={fpsRef} className="mapscene-fps" title="Render frames per second">–</span>
      </div>
      <div className="mapscene-view">
        <div className="mapscene-canvas-wrap">
          <div ref={mountRef} className="mapscene-mount" />
          {loadVisible && (
            <div className="rs-loading">
              <div className="rs-loading-inner">
                <p className="rs-loading-title">Loading - please wait.</p>
                <div className="rs-loading-bar">
                  <div className="rs-loading-fill" style={{ width: `${loadProgress}%` }} />
                </div>
                <p className="rs-loading-sub">{Math.round(loadProgress)}%</p>
              </div>
            </div>
          )}
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
              onClick={() => { setSideTab('view'); setPlacing(false); setAddingLight(false) }}
            >
              View
            </button>
            <button
              type="button"
              className={sideTab === 'edit' ? 'selected' : ''}
              onClick={() => { setSideTab('edit'); setPlacing(false); setAddingLight(false) }}
            >
              Edit
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
              onClick={() => { setSideTab('terrain'); setPlacing(false); setAddingLight(false) }}
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
              kind={placeKind}
              onKind={(next) => { setPlaceKind(next); setPlacing(false); setAddingLight(false) }}
              draft={placeDraft}
              onDraft={setPlaceDraft}
              placing={placing}
              canPlace={!!onEdit && status === ''}
              name={locNames.get(placeDraft.objectId)}
              onToggle={() => setPlacing((v) => !v)}
              placeMultiple={placeMultiple}
              onPlaceMultiple={setPlaceMultiple}
              soundPicks={markerPicks.filter((m) => m.kind === 'sound')}
              names={locNames}
              entries={listEntries}
              lightDraft={lightDraft}
              onLightDraft={setLightDraft}
              addingLight={addingLight}
              onAddLightToggle={() => setAddingLight((v) => !v)}
              canPlaceLight={canEditLights && status === ''}
              needsRebuild={placeNeedsRebuild}
            />
          )}
          {/* Edit tab: whatever is selected. Selecting anything from the scene
              or a View-tab list switches here, and this is the only tab where a
              left-drag moves the selected object. */}
          {sideTab === 'edit' && <>
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
              Nothing selected. Click an object, marker or light in the scene —
              or a row in the View tab's lists — and its details appear here.
              With something selected, drag it to move it; Shift+drag selects
              several at once. Alt+click in the Place/Terrain tabs samples
              what's under the cursor. Orbit with the middle mouse button, pan
              with the right.
            </p>
          )}
          {selection?.kind === 'marker' && (
            <MarkerPanel
              key={`marker-${selection.objectId}`}
              sel={selection}
              canEdit={!!onEdit}
              onNavigate={onNavigate}
              placements={listEntries.filter((o) => o[0] === selection.objectId).length}
              root={data.rootHandle ?? null}
              loadSprite={loadMapSpriteInfo}
              loadArea={loadAreaInfo}
              onPreview={(def) => setPreviewDef(def ? { id: selection.objectId, def } : null)}
              onApply={(def) => {
                const next = new Map(objectDefs ?? [])
                next.set(selection.objectId, def)
                setPreviewDef(null)
                setSelection({ ...selection, def, markerKind: markerKindFromDef(def) ?? selection.fallback })
                onEdit?.({ objectDefs: next })
              }}
              onClose={() => { setPreviewDef(null); setSelection(null) }}
            />
          )}
          {selection?.kind === 'light' && (
            <LightPanel
              key={`light-${selection.index}`}
              index={selection.index}
              light={selection.light}
              regionX={data.def.regionX}
              regionY={data.def.regionY}
              canEdit={canEditLights}
              onPreview={(next) => previewLightRef.current?.(selection.index, next)}
              onClose={() => setSelection(null)}
              onApply={(next) => {
                const list = lightList.map((l) => ({ ...l }))
                list[selection.index] = next
                setSelection({ kind: 'light', index: selection.index, light: next })
                commitLights(list)
              }}
              onDelete={() => {
                const list = lightList.filter((_, i) => i !== selection.index).map((l) => ({ ...l }))
                setSelection(null)
                commitLights(list)
              }}
            />
          )}
          {selection?.kind === 'loc' && (
            <LocPanel
              key={`${selection.regionX},${selection.regionY},${selection.index},${selection.objectId},${selection.x},${selection.y}`}
              sel={selection}
              canEdit={!!onEdit}
              onNavigate={onNavigate}
              root={data.rootHandle ?? null}
              loadSprite={loadMapSpriteInfo}
              loadArea={loadAreaInfo}
              onClose={() => { setPreviewDef(null); setPreviewMorph(null); setSelection(null) }}
              onPreviewDef={(def) => setPreviewDef(def ? { id: selection.objectId, def } : null)}
              onPreviewMorph={selection.inCenter ? (objectId) => {
                setPreviewMorph(objectId == null ? null : { index: selection.index, objectId })
              } : undefined}
              onApplyDef={(def) => {
                const next = new Map(objectDefs ?? [])
                next.set(selection.objectId, def)
                setPreviewDef(null)
                setSelection({ ...selection, def, name: def.name && def.name !== 'null' ? def.name : 'Object' })
                onEdit?.({ objectDefs: next })
              }}
              onApply={onEdit ? (entry) => {
                const base = objects ?? data.def.objects
                const next = base.map((o) => [...o] as LocEntry)
                next[selection.index] = entry
                setPreviewMorph(null)
                setSelection(null)
                onEdit({ objects: next })
              } : undefined}
              onDelete={onEdit ? () => {
                const base = objects ?? data.def.objects
                const next = base
                  .filter((_, i) => i !== selection.index)
                  .map((o) => [...o] as LocEntry)
                setPreviewMorph(null)
                setSelection(null)
                onEdit({ objects: next })
              } : undefined}
            />
          )}
          </>}

          {/* View tab: just the lists. Picking a row selects in the scene and
              hands over to the Edit tab. */}
          {sideTab === 'view' && <>
          <p className="mapscene-side-hint">
            Browse what's in this region. Clicking a row selects it, moves the
            camera to it, and opens it in the Edit tab.
          </p>
          <LocList
            entries={listEntries}
            names={locNames}
            symbols={mapSymbols}
            regionX={data.def.regionX}
            regionY={data.def.regionY}
            selectedIndex={selection?.kind === 'loc' && selection.inCenter ? selection.index : -1}
            open={openLists.objects}
            onToggle={() => setOpenLists((s) => ({ ...s, objects: !s.objects }))}
            onPick={(entry, index) => selectFromListRef.current?.(entry, index)}
          />
          <LightList
            lights={lightList}
            regionX={data.def.regionX}
            regionY={data.def.regionY}
            selectedIndex={selection?.kind === 'light' ? selection.index : -1}
            open={openLists.lights}
            onToggle={() => setOpenLists((s) => ({ ...s, lights: !s.lights }))}
            onPick={(index) => selectLightFromListRef.current?.(index)}
          />
          <MarkerList
            markers={sceneMarkers}
            names={locNames}
            symbols={mapSymbols}
            regionX={data.def.regionX}
            regionY={data.def.regionY}
            selectedWorld={selection?.kind === 'marker' ? { x: selection.worldX, y: selection.worldY } : null}
            open={openLists.markers}
            onToggle={() => setOpenLists((s) => ({ ...s, markers: !s.markers }))}
            onPick={(marker) => selectMarkerFromListRef.current?.(marker)}
          />
          <ControlsLegend
            open={openLists.controls}
            onToggle={() => setOpenLists((s) => ({ ...s, controls: !s.controls }))}
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

const PLACE_KINDS: { kind: PlaceKind; label: string; title: string }[] = [
  { kind: 'object', label: 'Object', title: 'A normal placed loc — scenery, walls, doors' },
  { kind: 'light', label: 'Light', title: 'A region point light (the map environment’s lights[])' },
  { kind: 'sound', label: 'Sound', title: 'An ambient-sound emitter: an invisible loc, shown here as an orange marker' },
]

// Place mode: pick WHAT to add (loc / point light / sound emitter), set it up,
// arm placement, then click a tile in the scene. Locs and sound emitters share
// the ghost path — a sound emitter is just a loc whose models are the invisible
// marker quads — while a light is written into the region's environment record.
function PlacePanel({
  kind, onKind, draft, onDraft, placing, canPlace, name, onToggle, placeMultiple, onPlaceMultiple,
  soundPicks, names, entries, lightDraft, onLightDraft, addingLight, onAddLightToggle, canPlaceLight,
  needsRebuild,
}: {
  kind: PlaceKind
  onKind: (next: PlaceKind) => void
  draft: PlaceDraft
  onDraft: (next: PlaceDraft) => void
  placing: boolean
  canPlace: boolean
  name?: string
  onToggle: () => void
  placeMultiple: boolean
  onPlaceMultiple: (v: boolean) => void
  soundPicks: { objectId: number; kind: MarkerInfo['kind']; type: number }[]
  names: Map<number, string>
  entries: LocEntry[]
  lightDraft: LightDraft
  onLightDraft: (next: LightDraft) => void
  addingLight: boolean
  onAddLightToggle: () => void
  canPlaceLight: boolean
  /** the drafted object would force a full rebuild when placed */
  needsRebuild: boolean
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
  const hue = (lightDraft.colorHsl >> 10) & 0x3f
  const sat = (lightDraft.colorHsl >> 7) & 0x7
  const val = lightDraft.colorHsl & 0x7f
  const setLightHsv = (h: number, s: number, v: number) =>
    onLightDraft({ ...lightDraft, colorHsl: ((h & 0x3f) << 10) | ((s & 0x7) << 7) | (v & 0x7f) })

  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">
          Place
          {kind === 'object' && name && <span className="mapscene-side-id">— {name}</span>}
        </span>
      </div>
      <div className="item-field">
        <span className="item-field-label">What to place</span>
        <div className="mapscene-btn-row">
          {PLACE_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`zoom-btn${kind === k.kind ? ' active' : ''}`}
              title={k.title}
              onClick={() => onKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {kind === 'light' && <>
        <p className="mapscene-side-hint">
          Hit Place light, then click a tile — the light lands at the tile centre
          at the height below, and is selected so the full editor is right there.
          It goes into the region's environment record, not its objects, and the
          objects around it are re-lit on the spot. Esc backs out.
        </p>
        <div className="mapscene-side-grid">
          <div className="item-field">
            <span className="item-field-label">Colour</span>
            <div className="mapscene-light-colour">
              <span className="mapscene-light-swatch" style={{ background: lightSwatch(lightDraft.colorHsl) }} />
              <span className="mapscene-field-value">HSV {hue}/{sat}/{val}</span>
            </div>
          </div>
          <label className="item-field">
            <span className="item-field-label">Hue</span>
            <span className="mapscene-light-slider">
              <input type="range" min={0} max={63} value={hue} onChange={(e) => setLightHsv(Number(e.target.value), sat, val)} />
              <NumberInput value={hue} onChange={(v) => setLightHsv(v, sat, val)} min={0} max={63} />
            </span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Saturation</span>
            <span className="mapscene-light-slider">
              <input type="range" min={0} max={7} value={sat} onChange={(e) => setLightHsv(hue, Number(e.target.value), val)} />
              <NumberInput value={sat} onChange={(v) => setLightHsv(hue, v, val)} min={0} max={7} />
            </span>
          </label>
          <label className="item-field">
            <span className="item-field-label">Value</span>
            <span className="mapscene-light-slider">
              <input type="range" min={0} max={127} value={val} onChange={(e) => setLightHsv(hue, sat, Number(e.target.value))} />
              <NumberInput value={val} onChange={(v) => setLightHsv(hue, sat, v)} min={0} max={127} />
            </span>
          </label>
          <label className="item-field">
            <span className="item-field-label">
              Size (radius)<span className="mapscene-gfx-def"> reach = size × 512 + 256 units</span>
            </span>
            <NumberInput value={lightDraft.size2d} onChange={(v) => onLightDraft({ ...lightDraft, size2d: v })} min={0} max={63} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Height above ground</span>
            <NumberInput
              value={lightDraft.y}
              onChange={(v) => onLightDraft({ ...lightDraft, y: Math.round(v / 4) * 4 })}
              min={0}
              max={262140}
            />
          </label>
          <div className="item-field">
            <span className="item-field-label">Plane</span>
            <div className="mapscene-btn-row">
              {[0, 1, 2, 3].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`zoom-btn${lightDraft.plane === p ? ' active' : ''}`}
                  onClick={() => onLightDraft({ ...lightDraft, plane: p })}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <label className="item-field">
            <span className="item-field-label">
              Flicker type<span className="mapscene-gfx-def"> 0–30 presets, 31 = light_intensities id</span>
            </span>
            <NumberInput value={lightDraft.type} onChange={(v) => onLightDraft({ ...lightDraft, type: v })} min={0} max={31} />
          </label>
        </div>
        <div className="mapscene-side-actions">
          <button
            type="button"
            className={addingLight ? 'save-bar-discard' : 'save-bar-save'}
            disabled={!canPlaceLight}
            onClick={onAddLightToggle}
          >
            {addingLight ? 'Cancel (Esc)' : 'Place light'}
          </button>
        </div>
        {!canPlaceLight && (
          <p className="mapscene-side-hint">
            This region's environment file couldn't be loaded, so lights are read-only here.
          </p>
        )}
      </>}

      {kind === 'sound' && <>
        <p className="mapscene-side-hint">
          Ambient-sound emitters are ordinary placements of invisible utility
          objects — the sound lives on the object's own definition
          (<code>ambientSoundId</code>), so placing one means placing that object.
          Pick one already used nearby, or type its id if you know it.
        </p>
        {soundPicks.length > 0 ? (
          <div className="item-field mapscene-place-search">
            <span className="item-field-label">Emitters used in this region — click to load</span>
            <div className="mapscene-marker-chips">
              {soundPicks.map((m) => (
                <button
                  key={m.objectId}
                  type="button"
                  className={`mapscene-marker-chip${draft.objectId === m.objectId ? ' active' : ''}`}
                  title={`object ${m.objectId}, placement type ${m.type}`}
                  style={{ borderColor: `#${MARKER_COLORS.sound.toString(16).padStart(6, '0')}` }}
                  onClick={() => onDraft({ ...draft, objectId: m.objectId, type: m.type })}
                >
                  <span className="mapscene-info-dot" style={{ background: `#${MARKER_COLORS.sound.toString(16).padStart(6, '0')}` }} />
                  sound {m.objectId}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="mapscene-side-hint">
            No emitter is placed in this region to copy — enter an object id below.
            Neighbouring regions often reuse the same few ids.
          </p>
        )}
      </>}

      {kind === 'object' && <>
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
      </>}

      {/* the loc fields: shared by objects and sound emitters, since an emitter
          is a placement like any other — only the object it points at differs.
          Two-up rows: (id, type), (rotation, plane). */}
      {(kind === 'object' || kind === 'sound') && <>
      <div className="mapscene-side-grid is-compact">
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
      {needsRebuild && (
        <p className="mapscene-side-note">
          <strong>This one rebuilds the scene.</strong> Object {draft.objectId} is
          animated and nothing on screen uses its animation yet, so placing it has
          to load the animation and re-merge the region — a few seconds behind the
          loading bar. Ordinary placements are instant, and once one of these is
          down, moving it (or placing another) is too.
        </p>
      )}
      <div className="mapscene-side-actions">
        <button
          type="button"
          className={placing ? 'save-bar-discard' : 'save-bar-save'}
          disabled={!canPlace}
          onClick={onToggle}
        >
          {placing ? 'Cancel (Esc)' : kind === 'sound' ? 'Place emitter' : 'Place'}
        </button>
      </div>
      <label className="mapscene-toggle mapscene-place-multi">
        <input type="checkbox" checked={placeMultiple} onChange={(e) => onPlaceMultiple(e.target.checked)} />
        Place multiple (stay armed after each drop)
      </label>
      </>}
    </>
  )
}

const MARKER_TITLES: Record<MarkerInfo['kind'], string> = {
  sound: 'Sound emitter',
  mapicon: 'Map icon anchor',
  mapsprite: 'Map sprite anchor',
  barrier: 'Barrier wall',
  other: 'Marker',
}

/** Clickable heading for a collapsible list section. The lists already carry a
 *  head with their own count and filter, so this replaces it rather than
 *  stacking a second one on top. */
function SectionHead({ open, onToggle, children }: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button type="button" className="mapscene-section-toggle" onClick={onToggle} aria-expanded={open}>
      <span className="mapscene-section-chevron">{open ? '▾' : '▸'}</span>
      <span className="item-field-label">{children}</span>
    </button>
  )
}

/** The per-object symbol lookups the View-tab lists share: objectId → the def's
 *  `mapCategoryId`/`mapSpriteId` (only ever populated when >= 0), and those ids
 *  resolved to thumbnail URLs. */
export type MapSymbols = {
  cats: Map<number, number>
  sprites: Map<number, number>
  iconUrls: Map<number, string>
  spriteUrls: Map<number, string>
}

/** A row's map icon (the areas record's `defaultIconArchive`) and/or its map
 *  sprite (the map_sprites record's `spriteId`). Object URLs are owned by the
 *  parent's caches, so this never loads anything itself — an id with no
 *  resolvable sprite still gets a placeholder, since "this object carries a
 *  category id whose area has no icon" is exactly what you want to see when
 *  hunting for which object holds a symbol. */
function MapThumbs({ objectId, symbols }: { objectId: number; symbols: MapSymbols }) {
  const cat = symbols.cats.get(objectId)
  const spr = symbols.sprites.get(objectId)
  if (cat === undefined && spr === undefined) return null
  const iconUrl = cat !== undefined ? symbols.iconUrls.get(cat) : undefined
  const spriteUrl = spr !== undefined ? symbols.spriteUrls.get(spr) : undefined
  return (
    <span className="mapscene-loclist-thumbs">
      {cat !== undefined && (iconUrl
        ? <img className="mapscene-loclist-thumb" src={iconUrl} alt="" title={`map icon — area ${cat}`} />
        : <span className="mapscene-loclist-thumb empty" title={`map icon — area ${cat}, no icon sprite`}>◆</span>)}
      {spr !== undefined && (spriteUrl
        ? <img className="mapscene-loclist-thumb" src={spriteUrl} alt="" title={`map sprite ${spr}`} />
        : <span className="mapscene-loclist-thumb empty" title={`map sprite ${spr}, no sprite`}>▪</span>)}
    </span>
  )
}

type ListSort = 'order' | 'name' | 'id' | 'pos' | 'icon' | 'sprite'

const LOC_SORTS: [ListSort, string][] = [
  ['order', 'Placement order'],
  ['name', 'Name'],
  ['id', 'Object id'],
  ['pos', 'Position'],
  ['icon', 'Map icon first'],
  ['sprite', 'Map sprite first'],
]

const MARKER_SORTS: [ListSort, string][] = [
  ['order', 'Scene order'],
  ['name', 'Kind'],
  ['id', 'Object id'],
  ['pos', 'Position'],
  ['icon', 'Map icon first'],
  ['sprite', 'Map sprite first'],
]

/** Rows carrying the symbol sort ahead of those without, then by the symbol's
 *  own id. `Array.sort` is stable, so ties keep the list's natural order. */
function bySymbol<T>(m: Map<number, number>, idOf: (row: T) => number): (a: T, b: T) => number {
  return (a, b) => {
    const ia = idOf(a)
    const ib = idOf(b)
    const va = m.get(ia) ?? -1
    const vb = m.get(ib) ?? -1
    if ((va >= 0) !== (vb >= 0)) return va >= 0 ? -1 : 1
    return va - vb || ia - ib
  }
}

/** Compact sort picker; sits beside a list's filter box. */
function SortSelect({ value, onChange, options }: {
  value: ListSort
  onChange: (v: ListSort) => void
  options: [ListSort, string][]
}) {
  return (
    <select
      className="item-stackable-select mapscene-loclist-sort"
      value={value}
      onChange={(e) => onChange(e.target.value as ListSort)}
      title="Sort rows"
    >
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}

// All placed objects in the centre region: filterable, sortable, virtualized
// (regions carry up to ~2000 placements), row click selects + flies the camera
// there.
function LocList({ entries, names, symbols, regionX, regionY, selectedIndex, open, onToggle, onPick }: {
  entries: LocEntry[]
  symbols: MapSymbols
  names: Map<number, string>
  regionX: number
  regionY: number
  selectedIndex: number
  open: boolean
  onToggle: () => void
  onPick: (entry: LocEntry, index: number) => void
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<ListSort>('order')
  const scrollRef = useRef<HTMLDivElement>(null)
  // placement x/y are region-local; the list shows absolute world tile coords.
  const worldX = (e: LocEntry) => regionX * 64 + e[3]
  const worldY = (e: LocEntry) => regionY * 64 + e[4]

  const filtered = useMemo(() => {
    const all = entries.map((e, i) => ({ e, i }))
    const q = filter.trim().toLowerCase()
    const rows = !q ? all : all.filter(({ e }) =>
      String(e[0]).includes(q)
      || (names.get(e[0])?.toLowerCase().includes(q) ?? false)
      || `${regionX * 64 + e[3]},${regionY * 64 + e[4]}`.includes(q))
    // rows keep their original index `i`, so sorting never disturbs selection
    if (sort === 'order') return rows
    const objId = (r: { e: LocEntry }) => r.e[0]
    const sorted = [...rows]
    if (sort === 'name') sorted.sort((a, b) => (names.get(a.e[0]) ?? '').localeCompare(names.get(b.e[0]) ?? '') || a.e[0] - b.e[0])
    else if (sort === 'id') sorted.sort((a, b) => a.e[0] - b.e[0])
    else if (sort === 'pos') sorted.sort((a, b) => a.e[4] - b.e[4] || a.e[3] - b.e[3])
    else if (sort === 'icon') sorted.sort(bySymbol(symbols.cats, objId))
    else sorted.sort(bySymbol(symbols.sprites, objId))
    return sorted
  }, [entries, names, filter, regionX, regionY, sort, symbols])

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

  // collapsing unmounts the scroll element, so re-measure when it comes back
  // rather than trusting the virtualizer's stale element observation
  useEffect(() => {
    if (open) virtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="mapscene-loclist">
      <div className="mapscene-loclist-head">
        <SectionHead open={open} onToggle={onToggle}>
          Objects — {filtered.length}{filter ? ` of ${entries.length}` : ''}
          <span className="mapscene-loclist-region"> · region {regionX}, {regionY}</span>
        </SectionHead>
        {open && (
          <div className="mapscene-loclist-tools">
            <input
              className="mapscene-loclist-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by name, id or world x,y"
            />
            <SortSelect value={sort} onChange={setSort} options={LOC_SORTS} />
          </div>
        )}
      </div>
      {open && <div ref={scrollRef} className="mapscene-loclist-scroll">
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
                <MapThumbs objectId={e[0]} symbols={symbols} />
                <span className="mapscene-loclist-pos">{worldX(e)}, {worldY(e)}, {e[5]}</span>
              </button>
            )
          })}
        </div>
      </div>}
    </div>
  )
}

/** CSS colour for a light's packed HSV, through the client's palette. */
const lightSwatch = (colorHsl: number) => `#${lightRgb(colorHsl).toString(16).padStart(6, '0')}`

/** Region point lights, with click-to-select — the reliable way in, since a
 *  light buried inside a lantern is a small gizmo to hit. Adding one lives in
 *  the Place tab, with the rest of the placement tools. */
function LightList({ lights, regionX, regionY, selectedIndex, open, onToggle, onPick }: {
  lights: RegionLight[]
  regionX: number
  regionY: number
  selectedIndex: number
  open: boolean
  onToggle: () => void
  onPick: (index: number) => void
}) {
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const all = lights.map((l, i) => ({ l, i }))
    const q = filter.trim().toLowerCase()
    if (!q) return all
    return all.filter(({ l, i }) =>
      String(i).includes(q)
      || `${regionX * 64 + (l.x >> 9)},${regionY * 64 + (l.z >> 9)}`.includes(q)
      || `plane ${l.plane}`.includes(q))
  }, [lights, filter, regionX, regionY])

  return (
    <div className="mapscene-loclist mapscene-lightlist">
      <div className="mapscene-loclist-head">
        <SectionHead open={open} onToggle={onToggle}>
          Point lights — {rows.length}{filter ? ` of ${lights.length}` : ''}
        </SectionHead>
        {open && lights.length > 8 && (
          <input
            className="mapscene-loclist-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by index, world x,y or plane"
          />
        )}
      </div>
      {open && <div className="mapscene-loclist-scroll mapscene-lightlist-scroll">
        {rows.map(({ l, i }) => (
          <button
            key={i}
            type="button"
            className={`mapscene-loclist-row${i === selectedIndex ? ' active' : ''}`}
            onClick={() => onPick(i)}
            title={`radius ${l.size2d + 0.5} tiles, flicker type ${l.type}, height ${l.y}`}
          >
            <span className="mapscene-loclist-dot" style={{ background: lightSwatch(l.colorHsl) }} />
            <span className="mapscene-loclist-name">Light {i} · r{l.size2d}</span>
            <span className="mapscene-loclist-pos">
              {regionX * 64 + (l.x >> 9)}, {regionY * 64 + (l.z >> 9)}, {l.plane}
            </span>
          </button>
        ))}
        {lights.length === 0 && (
          <p className="mapscene-side-hint">This region's environment has no point lights.</p>
        )}
      </div>}
    </div>
  )
}

/** Marker placements in the centre region — the sound emitters, map-icon and
 *  map-sprite anchors and barriers that render as floating diamonds. Same
 *  click-to-select as the object list; the diamonds are small targets in a busy
 *  scene, so the list is usually the easier way in. */
function MarkerList({ markers, names, symbols, regionX, regionY, selectedWorld, open, onToggle, onPick }: {
  markers: MarkerInfo[]
  names: Map<number, string>
  symbols: MapSymbols
  regionX: number
  regionY: number
  /** world tile of the selected marker — the same object id can be placed many
   *  times, so the row match is by position, not by id */
  selectedWorld: { x: number; y: number } | null
  open: boolean
  onToggle: () => void
  onPick: (marker: MarkerInfo) => void
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<ListSort>('order')
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = !q ? markers : markers.filter((m) =>
      String(m.objectId).includes(q)
      || m.kind.includes(q)
      || MARKER_TITLES[m.kind].toLowerCase().includes(q)
      || (names.get(m.objectId)?.toLowerCase().includes(q) ?? false)
      || `${regionX * 64 + m.tileX},${regionY * 64 + m.tileY}`.includes(q))
    if (sort === 'order') return matched
    const objId = (m: MarkerInfo) => m.objectId
    const sorted = [...matched]
    if (sort === 'name') sorted.sort((a, b) => MARKER_TITLES[a.kind].localeCompare(MARKER_TITLES[b.kind]) || a.objectId - b.objectId)
    else if (sort === 'id') sorted.sort((a, b) => a.objectId - b.objectId)
    else if (sort === 'pos') sorted.sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)
    else if (sort === 'icon') sorted.sort(bySymbol(symbols.cats, objId))
    else sorted.sort(bySymbol(symbols.sprites, objId))
    return sorted
  }, [markers, names, filter, regionX, regionY, sort, symbols])

  return (
    <div className="mapscene-loclist mapscene-lightlist">
      <div className="mapscene-loclist-head">
        <SectionHead open={open} onToggle={onToggle}>
          Markers — {rows.length}{filter ? ` of ${markers.length}` : ''}
        </SectionHead>
        {open && markers.length > 8 && (
          <div className="mapscene-loclist-tools">
            <input
              className="mapscene-loclist-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by kind, object id or tile x,y"
            />
            <SortSelect value={sort} onChange={setSort} options={MARKER_SORTS} />
          </div>
        )}
      </div>
      {open && <div className="mapscene-loclist-scroll mapscene-lightlist-scroll">
        {rows.map((m, i) => {
          const wx = regionX * 64 + m.tileX
          const wy = regionY * 64 + m.tileY
          return (
            <button
              key={`${m.objectId}-${m.tileX}-${m.tileY}-${m.plane}-${i}`}
              type="button"
              className={`mapscene-loclist-row${selectedWorld && selectedWorld.x === wx && selectedWorld.y === wy ? ' active' : ''}`}
              onClick={() => onPick(m)}
              title={`object ${m.objectId}${names.get(m.objectId) ? ` — ${names.get(m.objectId)}` : ''}, ${MARKER_TITLES[m.kind].toLowerCase()}`}
            >
              <span className="mapscene-loclist-dot" style={{ background: `#${MARKER_COLORS[m.kind].toString(16).padStart(6, '0')}` }} />
              <span className="mapscene-loclist-name">{MARKER_TITLES[m.kind]} ({m.objectId})</span>
              <MapThumbs objectId={m.objectId} symbols={symbols} />
              <span className="mapscene-loclist-pos">{wx}, {wy}, {m.plane}</span>
            </button>
          )
        })}
        {markers.length === 0 && (
          <p className="mapscene-side-hint">No markers in this region.</p>
        )}
      </div>}
    </div>
  )
}

/** How-to reference for the 3D view's mouse and keyboard controls, shown at
 *  the bottom of the View tab. Keep it in sync with the actual handlers:
 *  OrbitControls' mouseButtons (camera), onPointerDown/onSceneClick (per-tab
 *  pointer behaviour) and the two window keydown effects (hotkeys). */
const CONTROLS_LEGEND: { group: string; rows: [keys: string, does: string][] }[] = [
  {
    group: 'Camera', rows: [
      ['Middle drag', 'orbit'],
      ['Right drag', 'pan'],
      ['Scroll', 'zoom'],
    ],
  },
  {
    group: 'View / Edit tabs', rows: [
      ['Click', 'select the object, marker or light under the cursor (opens Edit)'],
      ['Click ground', 'clear the selection'],
      ['Drag selection', 'move the selected object tile by tile — release commits'],
      ['Shift+drag', 'marquee-select several objects (Edit tab)'],
    ],
  },
  {
    group: 'Place tab', rows: [
      ['Click', 'place the ghost object on its tile'],
      ['R', 'rotate the ghost'],
      ['Alt+click', 'copy an existing placement into the ghost (eyedropper)'],
    ],
  },
  {
    group: 'Terrain tab', rows: [
      ['Left drag', 'paint with the brush'],
      ['Alt+click', 'sample the tile under the cursor into the brush'],
      ['Shift+drag', 'copy an area as a stamp — arm Paste, then click to stamp it'],
      ['[ / ]', 'shrink / grow the brush'],
    ],
  },
  {
    group: 'Anywhere', rows: [
      ['V / E / P / T', 'switch to the View / Edit / Place / Terrain tab'],
      ['Esc', 'cancel placing, pasting or adding a light; clear the multi-selection'],
    ],
  },
]

function ControlsLegend({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="mapscene-loclist">
      <div className="mapscene-loclist-head">
        <SectionHead open={open} onToggle={onToggle}>Controls</SectionHead>
      </div>
      {open && (
        <div className="mapscene-legend">
          {CONTROLS_LEGEND.map(({ group, rows }) => (
            <div key={group} className="mapscene-legend-group">
              <span className="mapscene-legend-title">{group}</span>
              {rows.map(([keys, does]) => (
                <div key={keys} className="mapscene-legend-row">
                  <span className="mapscene-legend-keys">
                    {keys.split('+').map((k, i) => (
                      <span key={k}>
                        {i > 0 && '+'}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className="mapscene-legend-desc">{does}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Flicker phase offset is a 3-bit field stored as `(packed & 0xe0) << 3`, so it
// only ever takes these eight values.
const LIGHT_PHASES = [0, 256, 512, 768, 1024, 1280, 1536, 1792]

/** Editable details for a picked marker.
 *
 *  Everything the panel edits lives on the OBJECT DEFINITION
 *  (`objects/<id>.json`), not on the placement — there is no per-placement copy
 *  of these fields — so an edit changes every placement of that object in the
 *  game. The panel says so, and shows how many placements this region has.
 *
 *  The fields themselves are `ObjectDefEditor`, shared with the object panel:
 *  a marker IS an object, so the only difference is which sections are worth
 *  showing (a marker has no models, name or footprint worth speaking of). */
function MarkerPanel({ sel, canEdit, placements, root, loadSprite, loadArea, onPreview, onApply, onClose, onNavigate }: {
  sel: MarkerSelection
  canEdit: boolean
  onNavigate?: (entryName: string, itemId: number) => void
  /** placements of this object in the region being edited — context for how
   *  wide the blast radius of an edit is locally (it's global regardless) */
  placements: number
  root: FileSystemDirectoryHandle | null
  loadSprite: (id: number) => Promise<MapSpriteInfo | null>
  loadArea: (id: number) => Promise<AreaInfo | null>
  onPreview: (def: ObjectDefJson | null) => void
  onApply: (def: ObjectDefJson) => void
  onClose: () => void
}) {
  const base = sel.def
  const [draft, setDraft] = useState<ObjectDefJson | null>(base)
  useEffect(() => setDraft(base), [base])
  const changed = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base)

  // Push the in-flight draft at the scene so the diamond recolours as you type
  // (a def edit can change the marker's kind), and drop it when the panel goes.
  const previewRef = useRef(onPreview)
  previewRef.current = onPreview
  useEffect(() => { previewRef.current(changed && draft ? draft : null) }, [changed, draft])
  useEffect(() => () => previewRef.current(null), [])

  if (!draft) {
    return (
      <>
        <div className="mapscene-side-head">
          <span className="enum-title mapscene-side-title">{MARKER_TITLES[sel.markerKind]}</span>
          <div className="item-badges"><span className="item-id-badge">object {sel.objectId}</span></div>
        </div>
        <p className="mapscene-side-hint">Loading the object definition…</p>
        <div className="mapscene-side-actions">
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">
          <span
            className="mapscene-info-dot"
            style={{ background: `#${MARKER_COLORS[sel.markerKind].toString(16).padStart(6, '0')}` }}
          />
          {MARKER_TITLES[sel.markerKind]}
        </span>
        <div className="item-badges">
          <span className="item-id-badge">object {sel.objectId}</span>
          <span className="item-id-badge">world tile {sel.worldX}, {sel.worldY}</span>
        </div>
      </div>

      <p className="mapscene-side-hint">
        These fields belong to the <strong>object definition</strong>, not to this
        placement — editing them changes object {sel.objectId} everywhere it
        appears in the game{placements > 1 ? `, including all ${placements} placements in this region` : ''}.
        {canEdit
          ? ` Apply updates the scene; the region's Save button writes objects/${sel.objectId}.json.`
          : ' This view is read-only.'}
      </p>

      <ObjectDefEditor
        draft={draft}
        canEdit={canEdit}
        onChange={setDraft}
        sections={['sprite', 'icon', 'sound']}
        root={root}
        loadSprite={loadSprite}
        loadArea={loadArea}
        placementType={sel.type}
        onNavigate={onNavigate}
      />

      <div className="mapscene-side-actions">
        {canEdit && (
          <button type="button" className="save-bar-save" disabled={!changed} onClick={() => onApply(draft)}>Apply</button>
        )}
        {canEdit && (
          <button type="button" className="save-bar-discard" disabled={!changed} onClick={() => setDraft(base)}>Discard</button>
        )}
        <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
      </div>
    </>
  )
}

/** Editable details for a picked point light. Same convention as LocPanel:
 *  local draft, Apply hands the updated record to the parent. */
function LightPanel({ index, light, regionX, regionY, canEdit, onPreview, onClose, onApply, onDelete }: {
  index: number
  light: RegionLight
  regionX: number
  regionY: number
  canEdit: boolean
  /** live-preview the draft in the scene (gizmo only — the lighting is baked) */
  onPreview: (light: RegionLight | null) => void
  onClose: () => void
  onApply: (next: RegionLight) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<RegionLight>({ ...light, ranges: [...light.ranges] })
  const changed = JSON.stringify(draft) !== JSON.stringify(light)

  // Push every keystroke/drag to the scene so the diamond, its reach ring and
  // its height follow along; dropping the panel puts the committed record back.
  const previewRef = useRef(onPreview)
  previewRef.current = onPreview
  useEffect(() => {
    previewRef.current(draft)
  }, [draft])
  useEffect(() => () => previewRef.current(null), [])
  const set = <K extends keyof RegionLight>(key: K, value: RegionLight[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const hue = (draft.colorHsl >> 10) & 0x3f
  const sat = (draft.colorHsl >> 7) & 0x7
  const val = draft.colorHsl & 0x7f
  const setHsv = (h: number, s: number, v: number) =>
    set('colorHsl', ((h & 0x3f) << 10) | ((s & 0x7) << 7) | (v & 0x7f))

  // stored x/z are region-local world units (the file keeps them as u16 << 2),
  // so they split cleanly into a tile and a sub-tile offset
  const tileX = draft.x >> 9
  const tileZ = draft.z >> 9
  const offX = draft.x & 511
  const offZ = draft.z & 511

  // Labels stay short enough to fit a half-width cell — `.item-field-label`
  // ellipsises anything longer — so every explanation lives in the tooltip.
  const slider = (label: string, title: string, value: number, max: number, onChange: (v: number) => void) => (
    <label className="item-field is-wide" title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit ? (
        <span className="mapscene-light-slider">
          <input type="range" min={0} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
          <NumberInput value={value} onChange={onChange} min={0} max={max} />
        </span>
      ) : <span className="mapscene-field-value">{value}</span>}
    </label>
  )
  const number = (label: string, title: string, value: number, max: number, onChange: (v: number) => void, step = 1) => (
    <label className="item-field" title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit
        ? <NumberInput value={value} onChange={(v) => onChange(Math.round(v / step) * step)} min={0} max={max} />
        : <span className="mapscene-field-value">{value}</span>}
    </label>
  )

  return (
    <>
      <div className="mapscene-side-head">
        <span className="enum-title mapscene-side-title">
          <span className="mapscene-info-dot" style={{ background: lightSwatch(draft.colorHsl) }} />
          Point light <span className="mapscene-side-id">#{index}</span>
        </span>
        <div className="item-badges">
          <span className="item-id-badge">world {regionX * 64 + tileX}, {regionY * 64 + tileZ}</span>
          <span className="item-id-badge">plane {draft.plane}</span>
          <span className="item-id-badge">reach {(draft.size2d + 0.5).toFixed(1)} tiles</span>
          <span className="item-id-badge">raw {draft.x}, {draft.z}, {draft.y}</span>
        </div>
      </div>
      <p className="mapscene-side-hint">
        Edits move the gizmo live. The light itself is baked into every object
        around it, so the scene only re-lights on Apply{changed ? ' — pending now' : ''}.
        {!canEdit && ' This region\'s environment file could not be loaded, so the light is read-only.'}
      </p>

      <div className="mapscene-side-grid is-compact">
        <div className="item-field is-wide" title={`packed HSV ${draft.colorHsl}`}>
          <span className="item-field-label">Colour — HSV {hue}/{sat}/{val}</span>
          <div className="mapscene-light-colour">
            <span className="mapscene-light-swatch" style={{ background: lightSwatch(draft.colorHsl) }} />
            <span className="mapscene-field-value">{lightSwatch(draft.colorHsl)}</span>
          </div>
        </div>
        {slider('Hue', 'Palette hue, 0–63', hue, 63, (v) => setHsv(v, sat, val))}
        {slider('Sat', 'Saturation, 0–7 (3 bits in the packed colour)', sat, 7, (v) => setHsv(hue, v, val))}
        {slider('Value', 'Brightness, 0–127', val, 127, (v) => setHsv(hue, sat, v))}
        <div className="item-field" title="The plane this light belongs to">
          <span className="item-field-label">Plane</span>
          {canEdit ? (
            <div className="mapscene-btn-row">
              {[0, 1, 2, 3].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`zoom-btn${draft.plane === p ? ' active' : ''}`}
                  onClick={() => set('plane', p)}
                >
                  {p}
                </button>
              ))}
            </div>
          ) : <span className="mapscene-field-value">{draft.plane}</span>}
        </div>
        <div className="item-field" title="Extra planes this light also registers on (its grow flags)">
          <span className="item-field-label">Grows</span>
          {canEdit ? (
            <div className="mapscene-light-flags">
              <label className="mapscene-toggle" title="Also light the planes above">
                <input type="checkbox" checked={draft.growsUpwards} onChange={(e) => set('growsUpwards', e.target.checked)} />
                up
              </label>
              <label className="mapscene-toggle" title="Also light the planes below">
                <input type="checkbox" checked={draft.growsDownwards} onChange={(e) => set('growsDownwards', e.target.checked)} />
                down
              </label>
            </div>
          ) : (
            <span className="mapscene-field-value">
              {draft.growsUpwards || draft.growsDownwards
                ? [draft.growsUpwards && 'up', draft.growsDownwards && 'down'].filter(Boolean).join(' + ')
                : 'none'}
            </span>
          )}
        </div>
        {number('Tile X', 'Region-local tile, 0–63', tileX, 63, (v) => set('x', (Math.min(v, 63) << 9) | offX))}
        {number('Tile Y', 'Region-local tile, 0–63', tileZ, 63, (v) => set('z', (Math.min(v, 63) << 9) | offZ))}
        {number('Offset X', 'Position within the tile, 0–508 in steps of 4 (the file stores x/z as u16 << 2)', offX, 508, (v) => set('x', (tileX << 9) | (v & ~3)), 4)}
        {number('Offset Y', 'Position within the tile, 0–508 in steps of 4', offZ, 508, (v) => set('z', (tileZ << 9) | (v & ~3)), 4)}
        {number('Height', "Height above this tile's ground in world units, steps of 4", draft.y, 262140, (v) => set('y', v), 4)}
        <label className="item-field" title="Radius basis — reach = size × 512 + 256 world units. Changing it rewrites the footprint rows.">
          <span className="item-field-label">Size</span>
          {canEdit ? (
            <NumberInput
              value={draft.size2d}
              min={0}
              max={63}
              onChange={(v) => setDraft((d) => ({ ...d, size2d: v, ranges: lightRangesFor(v) }))}
            />
          ) : <span className="mapscene-field-value">{draft.size2d}</span>}
        </label>
        <div
          className="item-field"
          title="0–30 built-in presets, 31 = a config/light_intensities id. Data only here: our bake uses full intensity, like the client with flickering off."
        >
          <span className="item-field-label">Flicker</span>
          {canEdit ? (
            <NumberInput value={draft.type} min={0} max={31} onChange={(v) => set('type', v)} />
          ) : <span className="mapscene-field-value">{draft.type}</span>}
        </div>
        <div className="item-field" title="Flicker phase offset — a 3-bit field stored as (packed & 0xe0) << 3">
          <span className="item-field-label">Phase</span>
          {canEdit ? (
            <select
              className="item-stackable-select"
              value={draft.rotationOffset}
              onChange={(e) => set('rotationOffset', Number(e.target.value))}
            >
              {LIGHT_PHASES.map((p, i) => <option key={p} value={p}>{i} — {p}</option>)}
            </select>
          ) : <span className="mapscene-field-value">{draft.rotationOffset}</span>}
        </div>
        {draft.type === 31 && (
          <div className="item-field" title="config/light_intensities record driving this light's flicker">
            <span className="item-field-label">Intensity id</span>
            {canEdit ? (
              <NumberInput value={draft.lightTypeId ?? 0} min={0} max={65535} onChange={(v) => set('lightTypeId', v)} />
            ) : <span className="mapscene-field-value">{draft.lightTypeId ?? '—'}</span>}
          </div>
        )}
        <div className="item-field is-wide" title="Per-tile-row spans as offset+length — rewritten when the size changes">
          <span className="item-field-label">Footprint</span>
          <span className="mapscene-field-value mapscene-light-ranges">
            {draft.ranges.map((s) => `${s >>> 8}+${s & 0xff}`).join(' ')}
          </span>
        </div>
      </div>

      <div className="mapscene-side-actions">
        {canEdit && (
          <button
            type="button"
            className="save-bar-save"
            disabled={!changed}
            onClick={() => onApply({ ...draft, ranges: [...draft.ranges] })}
          >
            Apply
          </button>
        )}
        {canEdit && (
          <button type="button" className="save-bar-discard mapscene-delete-btn" onClick={onDelete}>
            Delete light
          </button>
        )}
        <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
      </div>
    </>
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

/** Editable details for a picked loc.
 *
 *  Two different things live in this panel and they save to different files:
 *  the six PLACEMENT fields (object id, type, rotation, x, y, plane) belong to
 *  this region's map file and to this instance alone, while everything under
 *  `ObjectDefEditor` is the object DEFINITION, shared by every placement of
 *  that object in the game. Apply commits whichever of the two changed. */
function LocPanel({ sel, canEdit: canEditDef, root, loadSprite, loadArea, onClose, onPreviewDef, onPreviewMorph, onApplyDef, onApply, onDelete, onNavigate }: {
  sel: LocSelection
  onNavigate?: (entryName: string, itemId: number) => void
  /** transform-to preview: draw this placement as the given object in the
   *  scene (null restores). Absent for neighbour-region placements. */
  onPreviewMorph?: (objectId: number | null) => void
  /** def edits are global, so they don't need the placement to be editable — a
   *  neighbour region's object definition is as editable as the centre's */
  canEdit: boolean
  root: FileSystemDirectoryHandle | null
  loadSprite: (id: number) => Promise<MapSpriteInfo | null>
  loadArea: (id: number) => Promise<AreaInfo | null>
  onClose: () => void
  onPreviewDef: (def: ObjectDefJson | null) => void
  onApplyDef: (def: ObjectDefJson) => void
  onApply?: (entry: LocEntry) => void
  onDelete?: () => void
}) {
  const [draft, setDraft] = useState({
    objectId: sel.objectId, type: sel.type, rotation: sel.rotation,
    x: sel.x, y: sel.y, plane: sel.plane,
  })
  const placementChanged = draft.objectId !== sel.objectId || draft.type !== sel.type
    || draft.rotation !== sel.rotation || draft.x !== sel.x || draft.y !== sel.y
    || draft.plane !== sel.plane
  const canEdit = sel.editable && !!onApply
  const slot = OBJECT_SLOTS[draft.type] ?? 2

  const base = sel.def
  const [defDraft, setDefDraft] = useState<ObjectDefJson | null>(base)
  useEffect(() => setDefDraft(base), [base])
  const defChanged = !!defDraft && !!base && JSON.stringify(defDraft) !== JSON.stringify(base)

  // live-preview def edits in the scene (marker colours, and anything else
  // resolved through getDef), and drop the preview when the panel goes
  const previewRef = useRef(onPreviewDef)
  previewRef.current = onPreviewDef
  useEffect(() => { previewRef.current(defChanged && defDraft ? defDraft : null) }, [defChanged, defDraft])
  useEffect(() => () => previewRef.current(null), [])

  // which Transform-to row is being previewed in the scene (highlights the
  // row); the preview itself is scene state, dropped when the panel goes
  const [morphPreviewIndex, setMorphPreviewIndex] = useState<number | null>(null)
  const morphPreviewRef = useRef(onPreviewMorph)
  morphPreviewRef.current = onPreviewMorph
  useEffect(() => () => morphPreviewRef.current?.(null), [])

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
          <span className="item-id-badge">size {sel.sizeX}x{sel.sizeY}</span>
          {sel.models && <span className="item-id-badge">models {sel.models}</span>}
        </div>
      </div>
      {!sel.editable && (
        <p className="mapscene-side-hint">
          {!sel.inCenter
            ? 'In a neighbouring region — teleport there to move or delete this placement. Its object definition is still editable below: that is shared cache-wide.'
            : 'This placement could not be matched, so it cannot be moved or deleted. Its object definition is still editable below.'}
        </p>
      )}

      <div className="mapscene-side-section">Placement — this instance only</div>
      {/* two-up rows: (id, type), (rotation, plane), (x, y) */}
      <div className="mapscene-side-grid is-compact">
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
        {/* world and local coords are the same value in two spaces — editing
            either rewrites draft.x/y, so the other follows automatically */}
        <label className="item-field" title={`World tile coordinate — this region spans ${sel.regionX * 64}–${sel.regionX * 64 + 63}`}>
          <span className="item-field-label">World X</span>
          {canEdit
            ? <NumberInput
                value={sel.regionX * 64 + draft.x}
                onChange={(v) => setDraft((d) => ({ ...d, x: Math.min(63, Math.max(0, v - sel.regionX * 64)) }))}
                min={sel.regionX * 64}
                max={sel.regionX * 64 + 63}
              />
            : <span className="mapscene-field-value">{sel.regionX * 64 + draft.x}</span>}
        </label>
        <label className="item-field" title={`World tile coordinate — this region spans ${sel.regionY * 64}–${sel.regionY * 64 + 63}`}>
          <span className="item-field-label">World Y</span>
          {canEdit
            ? <NumberInput
                value={sel.regionY * 64 + draft.y}
                onChange={(v) => setDraft((d) => ({ ...d, y: Math.min(63, Math.max(0, v - sel.regionY * 64)) }))}
                min={sel.regionY * 64}
                max={sel.regionY * 64 + 63}
              />
            : <span className="mapscene-field-value">{sel.regionY * 64 + draft.y}</span>}
        </label>
        {field('Local X (0–63)', 'x', 63)}
        {field('Local Y (0–63)', 'y', 63)}
      </div>

      {defDraft ? (
        <>
          <p className="mapscene-side-hint">
            Everything below belongs to the <strong>object definition</strong> —
            shared by every placement of object {sel.objectId} in the game, not
            just this one. Written to objects/{sel.objectId}.json on Save.
            {draft.objectId !== sel.objectId && ' (Still object ' + sel.objectId
              + "'s definition — changing the placement's Object ID above swaps which object sits here, it doesn't reload this section.)"}
          </p>
          <ObjectDefEditor
            draft={defDraft}
            canEdit={canEditDef}
            onChange={setDefDraft}
            sections={['identity', 'cursors', 'shape', 'appearance', 'morph', 'sprite', 'icon', 'sound']}
            root={root}
            loadSprite={loadSprite}
            loadArea={loadArea}
            placementType={draft.type}
            onNavigate={onNavigate}
            morphPreviewIndex={morphPreviewIndex}
            onMorphPreview={onPreviewMorph ? (index, objectId) => {
              setMorphPreviewIndex(index)
              onPreviewMorph(index == null ? null : (objectId ?? -1))
            } : undefined}
          />
        </>
      ) : (
        <p className="mapscene-side-hint">Loading the object definition…</p>
      )}

      <div className="mapscene-side-actions">
        {(canEdit || canEditDef) && (
          <button
            type="button"
            className="save-bar-save"
            disabled={!placementChanged && !defChanged}
            onClick={() => {
              // def first: applying the placement rebuilds the scene and clears
              // the selection, which unmounts this panel
              if (defChanged && defDraft) onApplyDef(defDraft)
              if (placementChanged && onApply) {
                onApply([draft.objectId, draft.type, draft.rotation, draft.x, draft.y, draft.plane])
              }
            }}
          >
            Apply
          </button>
        )}
        {(placementChanged || defChanged) && (
          <button
            type="button"
            className="save-bar-discard"
            onClick={() => {
              setDraft({ objectId: sel.objectId, type: sel.type, rotation: sel.rotation, x: sel.x, y: sel.y, plane: sel.plane })
              setDefDraft(base)
            }}
          >
            Discard
          </button>
        )}
        {canEdit && (
          <button type="button" className="save-bar-discard mapscene-delete-btn" onClick={onDelete}>Delete</button>
        )}
        <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
      </div>
    </>
  )
}

