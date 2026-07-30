// Live 3D preview for the ground-material editors (config/underlays and
// config/overlays).
//
// This does NOT reimplement the ground pipeline. It synthesises a small patch
// of map terrain and hands it to the very same `buildTerrainMesh` the 3D map
// view uses, with the definition being edited swapped into the scene configs.
// So whatever the map draws for this material, the preview draws — the corner
// palette blur, the overlay shape families, texture splatting and the client's
// vertex lighting all come along for free, and the preview can never drift
// from the real renderer.
//
// The controls exist because most of what these fields do is only visible in
// context: a colour is quantised and blurred against its NEIGHBOURS, an
// overlay's shape only means something against an underlay, and texture scale
// only reads across several tiles.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { MapTerrain } from '../loaders/maps'
import { SIZE, TILES, tileIndex } from '../loaders/maps'
import { buildTerrainMesh, computeHeights, loadSceneConfigs, blurShadowGrid, LocAssets } from './mapScene'
import type { FloJson, FluJson, SceneConfigs } from './mapScene'
import './GroundPreview.css'

const TILE_UNITS = 512
const VERTS = SIZE + 1
const CENTRE = SIZE >> 1

/** Field sizes, in tiles across the built slab. The subject material occupies
 *  the middle half; the rest is the neighbour material, which is what makes
 *  the cross-tile blend visible at all. */
const FIELDS = [
  { label: 'Close', tiles: 8 },
  { label: 'Medium', tiles: 16 },
  { label: 'Wide', tiles: 32 },
] as const

/** The 13 overlay tile shapes. Names describe the UNROTATED coverage — the
 *  client's own tables are `OVERLAY_SHAPE_*` indexed before rotation. */
const SHAPE_LABELS = [
  '0 · full tile',
  '1 · half (diagonal)',
  '2 · half (diagonal)',
  '3 · corner quarter',
  '4 · three quarters',
  '5 · half (straight)',
  '6 · half (straight)',
  '7 · corner quarter',
  '8 · three quarters',
  '9 · diagonal band',
  '10 · diagonal band',
  '11 · small corner',
  '12 · none (plain tile)',
]

// Loading every underlay/overlay JSON takes a moment, and the sidebar makes it
// trivial to hop between definitions — so the configs and the texture cache are
// shared per cache root and survive remounts. LocAssets is deliberately never
// disposed here: a THREE.Texture is context-independent, so the next preview
// re-uploads it rather than re-decoding the PNG.
const configsCache = new WeakMap<FileSystemDirectoryHandle, Promise<SceneConfigs>>()
const assetsCache = new WeakMap<FileSystemDirectoryHandle, LocAssets>()

function sharedConfigs(root: FileSystemDirectoryHandle): Promise<SceneConfigs> {
  let p = configsCache.get(root)
  if (!p) {
    p = loadSceneConfigs(root)
    configsCache.set(root, p)
  }
  return p
}

function sharedAssets(root: FileSystemDirectoryHandle): LocAssets {
  let a = assetsCache.get(root)
  if (!a) {
    a = new LocAssets(root)
    assetsCache.set(root, a)
  }
  return a
}

export type PreviewKind = 'underlay' | 'overlay'

type BuildOpts = {
  kind: PreviewKind
  /** 0-based definition id being edited. */
  subjectId: number
  /** 0-based underlay id painted around (and, for overlays, under) the subject. */
  neighbourId: number
  tiles: number
  shape: number
  rotation: number
  sloped: boolean
}

/** A synthetic region holding one slab of ground: the neighbour material over
 *  the whole field, the subject material in the middle. Tiles outside the field
 *  keep underlay/overlay 0, which emits no geometry — so the slab floats alone
 *  and the build stays cheap no matter how big the region array is. */
function buildPreviewTerrain(o: BuildOpts): MapTerrain {
  const terrain: MapTerrain = {
    underlayIds: new Uint8Array(TILES),
    overlayIds: new Uint8Array(TILES),
    overlayShapeRot: new Uint8Array(TILES),
    tileFlags: new Uint8Array(TILES),
    heightPresence: new Uint8Array(TILES / 8),
    heightValue: new Uint8Array(TILES),
  }
  const half = o.tiles >> 1
  const x0 = CENTRE - half
  const y0 = CENTRE - half
  // the subject occupies the middle half of the field, so there is always a
  // ring of the neighbour material to blend against on every side
  const inner = Math.max(1, half >> 1)
  const sx0 = CENTRE - inner
  const sy0 = CENTRE - inner
  const sx1 = CENTRE + inner - 1
  const sy1 = CENTRE + inner - 1

  for (let x = x0; x < x0 + o.tiles; x++) {
    for (let y = y0; y < y0 + o.tiles; y++) {
      const idx = tileIndex(0, x, y)
      const isSubject = x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1

      // Per-tile bytes are "definition id + 1" — 0 means "no material here".
      if (o.kind === 'underlay') {
        terrain.underlayIds[idx] = ((isSubject ? o.subjectId : o.neighbourId) + 1) & 0xff
      } else {
        terrain.underlayIds[idx] = (o.neighbourId + 1) & 0xff
        if (isSubject) {
          terrain.overlayIds[idx] = (o.subjectId + 1) & 0xff
          terrain.overlayShapeRot[idx] = ((o.shape << 2) | (o.rotation & 0x3)) & 0xff
        }
      }

      // Explicit heights: stored value 1 is the height-0 sentinel, and without
      // presence set plane 0 falls back to the client's global Perlin noise.
      let v = 1
      if (o.sloped) {
        const cx = (x - CENTRE) / Math.max(1, half)
        const cy = (y - CENTRE) / Math.max(1, half)
        const r = Math.min(1, Math.hypot(cx, cy))
        v = 1 + Math.round(14 * Math.cos((r * Math.PI) / 2))
      }
      terrain.heightValue[idx] = v
      terrain.heightPresence[idx >> 3] |= 1 << (idx & 0x7)
    }
  }
  return terrain
}

/** A stand-in for the baked scenery/wall shadows: a band across one side of
 *  the subject patch, run through the client's own 5-tap blur. The grid is
 *  always supplied — `buildTerrainMesh` decides per tile whether to sample it,
 *  from the material's `shadowed` flag, so turning the flag off shows the real
 *  renderer behaviour (and the hard edge against still-shadowed neighbours)
 *  rather than a preview-only approximation. */
function previewShadowGrid(tiles: number): Float32Array[] {
  const raw = new Uint8Array(VERTS * VERTS)
  const half = tiles >> 1
  const x0 = CENTRE - half
  for (let x = x0; x < CENTRE + 1; x++) {
    for (let y = CENTRE - half; y < CENTRE + half; y++) {
      if (x < 0 || x >= VERTS || y < 0 || y >= VERTS) continue
      // strongest against the "wall" line, fading over three tiles
      const d = CENTRE - x
      const strength = Math.max(0, 60 - d * 18)
      if (strength > 0) raw[x * VERTS + y] = strength
    }
  }
  const blurred = blurShadowGrid(raw)
  return [blurred, blurred, blurred, blurred]
}

type Props = {
  rootHandle: FileSystemDirectoryHandle | undefined
  kind: PreviewKind
  /** 0-based id of the definition being edited. */
  id: number
  /** The live draft — the preview always renders unsaved edits. */
  def: Record<string, unknown>
  /** Underlay id to surround the subject with. Defaults to a grass-ish one. */
  defaultNeighbour?: number
}

export default function GroundPreview({ rootHandle, kind, id, def, defaultNeighbour = 163 }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const meshRef = useRef<THREE.Mesh | null>(null)
  const invalidateRef = useRef<() => void>(() => {})
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)

  const [configs, setConfigs] = useState<SceneConfigs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)

  const [neighbour, setNeighbour] = useState(defaultNeighbour)
  /** Field size the camera was last framed for — reframing on every edit would
   *  undo the user's zoom mid-typing. */
  const framedRef = useRef<number | null>(null)
  const [fieldIdx, setFieldIdx] = useState(1)
  const [shape, setShape] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [sloped, setSloped] = useState(false)

  const tiles = FIELDS[fieldIdx].tiles
  // Only the fields the ground pipeline actually reads need to retrigger a
  // build, but stringifying the whole draft is simpler and always correct —
  // a redundant rebuild costs a few ms and can never show a stale scene.
  const defKey = JSON.stringify(def)

  // ---- one-time three.js setup -------------------------------------------
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false

    const w = mount.clientWidth || 640
    const h = mount.clientHeight || 320
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.setClearColor(0x0b0d12)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    sceneRef.current = scene
    const camera = new THREE.PerspectiveCamera(45, w / h, 8, 400000)
    cameraRef.current = camera

    // Same composer chain as the map view: the terrain writes raw client
    // colours into a linear buffer and OutputPass does the encode, so the
    // preview's colours match the map's exactly.
    const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
    }))
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(new OutputPass())

    const centre = new THREE.Vector3(CENTRE * TILE_UNITS, 0, -CENTRE * TILE_UNITS)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(centre)
    controls.maxPolarAngle = Math.PI / 2 - 0.05
    controls.enablePan = false
    controlsRef.current = controls

    // Render on demand: a static ground patch has nothing to animate, so a
    // permanent RAF loop would burn a GPU core for nothing while someone types
    // in the fields above it.
    let queued = false
    const draw = () => {
      queued = false
      controls.update()
      composer.render()
    }
    const invalidate = () => {
      if (queued || disposed) return
      queued = true
      requestAnimationFrame(draw)
    }
    invalidateRef.current = invalidate
    controls.addEventListener('change', invalidate)

    const resize = () => {
      const nw = mount.clientWidth || w
      const nh = mount.clientHeight || h
      renderer.setSize(nw, nh)
      composer.setSize(nw, nh)
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      invalidate()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    invalidate()

    return () => {
      disposed = true
      observer.disconnect()
      controls.removeEventListener('change', invalidate)
      controls.dispose()
      const mesh = meshRef.current
      if (mesh) {
        mesh.geometry.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) m.dispose()
      }
      meshRef.current = null
      sceneRef.current = null
      composer.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  // ---- scene configs ------------------------------------------------------
  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    sharedConfigs(rootHandle)
      .then((c) => { if (!cancelled) setConfigs(c) })
      .catch(() => { if (!cancelled) setError('Could not read config/underlays and config/overlays from this cache.') })
    return () => { cancelled = true }
  }, [rootHandle])

  // Neighbour choices: every underlay that actually carries a colour, so the
  // dropdown isn't full of blanks.
  const neighbourOptions = useMemo(() => {
    if (!configs) return [] as { id: number; label: string }[]
    return [...configs.underlays.entries()]
      .filter(([, flu]) => flu.rgb !== undefined || flu.texture !== undefined)
      .map(([uid, flu]) => ({
        id: uid,
        label: `${uid}${flu.texture !== undefined && flu.texture >= 0 ? ` · tex ${flu.texture}` : ''}`,
      }))
      .sort((a, b) => a.id - b.id)
  }, [configs])

  // Keep the neighbour choice both valid and useful: it has to exist in this
  // cache, and for an underlay it must not be the material being edited —
  // otherwise the field is one flat colour and the cross-tile blend the preview
  // exists to demonstrate isn't there at all.
  useEffect(() => {
    if (neighbourOptions.length === 0) return
    const unusable = (uid: number) => kind === 'underlay' && uid === id
    if (neighbourOptions.some((o) => o.id === neighbour) && !unusable(neighbour)) return
    const pick = neighbourOptions.find((o) => o.id === defaultNeighbour && !unusable(o.id))
      ?? neighbourOptions.find((o) => !unusable(o.id))
    if (pick) setNeighbour(pick.id)
  }, [neighbourOptions, neighbour, kind, id, defaultNeighbour])

  // ---- (re)build the slab on every edit -----------------------------------
  useEffect(() => {
    if (!configs || !rootHandle) return
    const scene = sceneRef.current
    if (!scene) return
    let cancelled = false
    setBuilding(true)

    // Debounced: dragging a colour picker fires continuously, and each build
    // walks the whole field plus an 11×11 palette blur.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const draft = JSON.parse(defKey) as Record<string, unknown>
          // Swap the draft in over the loaded config so the preview shows
          // unsaved edits. Copy the maps rather than mutating the shared ones.
          const overrides: SceneConfigs = {
            underlays: new Map(configs.underlays),
            overlays: new Map(configs.overlays),
          }
          if (kind === 'underlay') overrides.underlays.set(id, { ...(draft as unknown as FluJson), id })
          else overrides.overlays.set(id, { ...(draft as unknown as FloJson), id })

          const terrain = buildPreviewTerrain({
            kind, subjectId: id, neighbourId: neighbour, tiles, shape, rotation, sloped,
          })
          const heights = computeHeights(terrain, 0, 0)
          const assets = sharedAssets(rootHandle)
          // `pre` is how a shadow grid gets in; empty lights/palettes arrays
          // make the builder compute those itself for this lone region, which
          // is what we want (there are no neighbouring regions to stay seamless
          // with here).
          const mesh = await buildTerrainMesh(terrain, 0, heights, overrides, assets, {
            lights: [],
            shadows: previewShadowGrid(tiles),
            palettes: [],
          })
          if (cancelled) {
            // The build outlived its effect (a fast edit, or unmount) — the
            // geometry is already on the GPU, so drop it rather than leak it.
            if (mesh) {
              mesh.geometry.dispose()
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
              for (const m of mats) m.dispose()
            }
            return
          }

          const previous = meshRef.current
          if (previous) {
            scene.remove(previous)
            previous.geometry.dispose()
            const mats = Array.isArray(previous.material) ? previous.material : [previous.material]
            for (const m of mats) m.dispose()
          }
          meshRef.current = mesh
          if (mesh) scene.add(mesh)

          // Frame the field on the first build and whenever the field size
          // changes — but never on an ordinary field edit, which would yank the
          // camera back while someone is mid-zoom.
          const camera = cameraRef.current
          const controls = controlsRef.current
          if (camera && controls && framedRef.current !== tiles) {
            framedRef.current = tiles
            const want = tiles * TILE_UNITS * 1.15
            const dir = camera.position.clone().sub(controls.target)
            if (dir.lengthSq() < 1) dir.set(0.35, 0.75, 0.9)
            camera.position.copy(controls.target).add(dir.setLength(want))
            camera.updateProjectionMatrix()
            controls.update()
          }
          setError(null)
          invalidateRef.current()
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Preview failed to build.')
        } finally {
          if (!cancelled) setBuilding(false)
        }
      })()
    }, 70)

    return () => { cancelled = true; window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configs, rootHandle, kind, id, defKey, neighbour, tiles, shape, rotation, sloped])

  if (!rootHandle) {
    return (
      <div className="ground-preview ground-preview-empty">
        <p className="tex-op-note">Open a cache folder to preview this material in 3D.</p>
      </div>
    )
  }

  return (
    <div className="ground-preview">
      <div className="ground-preview-canvas" ref={mountRef}>
        {building && <span className="ground-preview-badge">building…</span>}
        {error && <span className="ground-preview-error">{error}</span>}
      </div>

      <div className="ground-preview-controls">
        <label className="ground-preview-control">
          <span className="ground-preview-control-label">
            {kind === 'overlay' ? 'Ground under/around' : 'Surrounded by'}
          </span>
          <select
            className="item-stackable-select"
            value={neighbour}
            onChange={(e) => setNeighbour(parseInt(e.target.value, 10))}
          >
            {neighbourOptions.map((o) => (
              <option key={o.id} value={o.id}>Underlay {o.label}</option>
            ))}
          </select>
        </label>

        {kind === 'overlay' && (
          <>
            <label className="ground-preview-control">
              <span className="ground-preview-control-label">Tile shape</span>
              <select
                className="item-stackable-select"
                value={shape}
                onChange={(e) => setShape(parseInt(e.target.value, 10))}
              >
                {SHAPE_LABELS.map((label, i) => (
                  <option key={i} value={i}>{label}</option>
                ))}
              </select>
            </label>
            <label className="ground-preview-control">
              <span className="ground-preview-control-label">Rotation</span>
              <select
                className="item-stackable-select"
                value={rotation}
                onChange={(e) => setRotation(parseInt(e.target.value, 10))}
              >
                {[0, 1, 2, 3].map((r) => <option key={r} value={r}>{r} · {r * 90}°</option>)}
              </select>
            </label>
          </>
        )}

        <label className="ground-preview-control">
          <span className="ground-preview-control-label">Field</span>
          <select
            className="item-stackable-select"
            value={fieldIdx}
            onChange={(e) => setFieldIdx(parseInt(e.target.value, 10))}
          >
            {FIELDS.map((f, i) => <option key={f.label} value={i}>{f.label} · {f.tiles} tiles</option>)}
          </select>
        </label>

        <label className="ground-preview-control ground-preview-check">
          <input type="checkbox" checked={sloped} onChange={(e) => setSloped(e.target.checked)} />
          <span>Sloped ground</span>
        </label>
      </div>

      <p className="tex-op-note ground-preview-note">
        Rendered by the map view's own terrain builder, so this is exactly how the material draws
        in game — including the cross-tile colour blur, texture splatting and the client's vertex
        lighting. Drag to orbit, scroll to zoom. The shadow band on the left stands in for the
        scenery and wall shadows a real region bakes — the terrain builder decides per tile
        whether to sample it from the <code>shadowed</code> flag, so turning that off leaves this
        material evenly lit while its neighbours stay shadowed.
      </p>
    </div>
  )
}
