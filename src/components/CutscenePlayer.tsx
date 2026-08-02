import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { CutsceneDef } from '../loaders/cutscenes'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { SIZE } from '../loaders/maps'
import type { MapTerrain } from '../loaders/maps'
import type { ModelData } from '../loaders/models'
import { applyPoseToMesh, buildTexturedModelMesh } from './modelMesh'
import type { TexturedModelMesh } from './modelMesh'
import { loadModelComposite, npcCompositeSpec, objectCompositeSpec } from '../loaders/npcComposite'
import { buildLookModel } from '../loaders/playerAppearance'
import { loadPlayerGender, loadPlayerLooks } from '../loaders/playerLook'
import { resolveRenderEmote } from '../loaders/renderEmote'
import { onVarOverridesChanged } from '../loaders/varOverrides'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame, makePoseScratch } from '../loaders/skeletalAnimation'
import type { PoseScratch } from '../loaders/skeletalAnimation'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import {
  DEFAULT_SUN, LocAssets, SceneMosaic, averageHeight, blurShadowGrid, buildAnimatedLocMesh, buildLightGrid,
  buildLocsMesh, buildSkyboxMesh, buildTerrainMesh, isBridgeTile, loadRegionEnvironment, loadSceneConfigs,
  sunTintFor,
} from './mapScene'
import type { RegionEnvironment, SunConfig } from './mapScene'
import { ClientBloomPass } from './clientBloom'
import { SceneParticles } from './sceneParticles'
import { SceneBillboards } from './sceneBillboards'
import { LocAnimator } from './locAnimator'
import { modelUpscale } from '../loaders/models'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { assembleCutsceneScene, replacedLocKey } from './cutsceneScene'
import { CutsceneAudio } from './cutsceneAudio'
import { NumberInput } from './defFields'
import { CYCLE_MS, clockShort, clockSuffix, clockValue } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import './AnimationViewer.css'
import './CutsceneViewer.css'

const REGION_UNITS = SIZE * 512
const ONE_V3 = new THREE.Vector3(1, 1, 1)

/** Cull sphere around a 1-tile thing, scaled by its footprint. Deliberately
 *  loose — three tiles clears the tallest cutscene NPC, and over-including
 *  costs a pose while under-including would pop one. */
const CULL_RADIUS = 1536
const frustum = new THREE.Frustum()
const frustumMatrix = new THREE.Matrix4()
const cullSphere = new THREE.Sphere()
const yawEuler = new THREE.Euler()
const yawQuat = new THREE.Quaternion()
/** How far ahead of the camera the free-look control orbits — a few tiles, the
 *  distance a cutscene camera usually frames its subject at. */
const ORBIT_DISTANCE = 1800
/** How far the selected-tile marker sits above the ground — enough to clear
 *  z-fighting with the terrain, not enough to read as floating. */
const TILE_MARK_LIFT = 6
const picker = new THREE.Raycaster()
const pickNdc = new THREE.Vector2()
const pickDir = new THREE.Vector3()
const splineFrom: [number, number, number] = [0, 0, 0]
const splineTo: [number, number, number] = [0, 0, 0]
const fadeNow: number[] = [0, 0, 0, 0]
const ZERO_FADE: readonly number[] = [0, 0, 0, 0]

// The client's pass order, same as the map scene: opaque objects, then ground,
// then transparent objects back-to-front (MeshRasterizer_Sub3 /
// SceneObjectManager.method3441). Without it the transparent locs this player
// now draws would z-fight the ground they stand on.
const ORDER_OPAQUE_LOC = -1
const ORDER_TERRAIN = 0
const ORDER_TRANSPARENT_LOC = 1

/**
 * A cutscene has no environment of its own — it copies chunks out of live
 * regions — so it borrows the record of the region its FIRST area comes from:
 * sun, fog, skybox and bloom. That is the right answer whenever a cutscene
 * stays in one place, which every shipped one does, and the client is in the
 * same position: a scene has exactly one environment however many regions fed
 * its chunks.
 */
async function cutsceneEnvironment(root: FileSystemDirectoryHandle, def: CutsceneDef): Promise<RegionEnvironment | null> {
  const area = def.areas[0]
  if (!area) return null
  return loadRegionEnvironment(root, ((area.regionX >> 6) << 8) | (area.regionY >> 6))
}

function sunOf(env: RegionEnvironment | null): SunConfig {
  const e = env?.environment
  if (!e) return DEFAULT_SUN
  return {
    x: e.sunPosition?.[0] ?? DEFAULT_SUN.x,
    y: e.sunPosition?.[1] ?? DEFAULT_SUN.y,
    z: e.sunPosition?.[2] ?? DEFAULT_SUN.z,
    ambient: e.sunAmbient ?? DEFAULT_SUN.ambient,
  }
}

/** Draw distance the fog fades out over, in tiles. The client uses the
 *  player's draw-distance preference; 40 (the map view's default) put the fog
 *  START at 14.6 tiles in cutscene 1 (fogColour black, fogDepth 3000 — a
 *  23-tile fade band), swallowing Saradomin's 26-unit eye sprites from
 *  mid-distance while his big lit silhouette stayed readable. 64 matches a
 *  high draw-distance client and keeps the fade band's far edge past the
 *  2×2-region area a cutscene can even copy. */
const FOG_TILES = 64

const VOLUME_KEY = 'cache-editor:cutscene-volume'

/** No def to read ambient/contrast from, so the client's base values. */
const PLAYER_LIGHTING = { ambient: 64, contrast: 850 }

/** What a scene tile pick resolves to, in CUTSCENE tile coords — the same
 *  space every action's `x`/`y` is written in. */
export type PickedTile = { x: number; y: number; plane: number }

/** The editor's window into the running scene: what's under the pointer, where
 *  the camera is, and whether the user may fly it. Deliberately imperative —
 *  none of it belongs in React state, and the scene is rebuilt on its own
 *  schedule (see sceneKey). */
export type CutsceneSceneHandle = {
  pickTile: (clientX: number, clientY: number) => PickedTile | null
  /** Cast index of the entity under the pointer, or null. */
  pickEntity: (clientX: number, clientY: number) => number | null
  /** Index into `def.objects` of the spawned object under the pointer. */
  pickObject: (clientX: number, clientY: number) => number | null
  /** Camera position and look-at target, in the units camera paths store. */
  cameraPose: () => { pos: [number, number, number]; target: [number, number, number] }
  /** Point the camera somewhere, for previewing a keyframe being authored. */
  setCameraPose: (pos: [number, number, number], target: [number, number, number]) => void
  /** Outline a tile in the scene, or clear it with null. */
  setTileHighlight: (tile: PickedTile | null) => void
  /** While on, the user orbits/dollies the camera and the cutscene's own camera
   *  actions stop driving it. */
  setFreeCamera: (on: boolean) => void
  isFreeCamera: () => boolean
}

type Props = {
  def: CutsceneDef
  rootHandle: FileSystemDirectoryHandle
  /** Reports the sim clock so the page's action roll can draw a playhead. */
  onCycle?: (cycle: number) => void
  /** Editing surface. Present = the editor is driving; see CutsceneSceneHandle. */
  sceneHandle?: React.RefObject<CutsceneSceneHandle | null>
  /** Clock unit for the action list and transport readout, shared with the
   *  roll's pill so the whole page counts the same way. */
  unit?: CutsceneClockUnit
}

// ---------------------------------------------------------------------------
// Entity meshes come from modelMesh.ts (textured, non-indexed, with the
// corner→vertex map skeletal poses need to rewrite positions in place).

type EntityMesh = { tm: TexturedModelMesh; model: ModelData }

const applyPose = (em: EntityMesh, posed: { x: Int32Array; y: Int32Array; z: Int32Array } | null) =>
  applyPoseToMesh(em.tm, em.model, posed)

type AnimState = { def: AnimationDef; frame: number; acc: number; oneShot: boolean }

/** Anything startAnim can drive. The two counters serialize the ASYNC anim
 *  swaps: each request takes a ticket at call time and only the latest may
 *  commit, and a one-shot completion may only revert to the stand/idle when
 *  no newer request is in flight. Without this, a cached def resolving in
 *  call order let the completion revert OVERWRITE a same-cycle
 *  ANIMATE_MOVEMENT — Saradomin's kneel-down (10395) is exactly 104 ticks
 *  and its kneel-loop (10379) fires on the exact completion cycle, so on
 *  replay (everything cached) he stood up instead. */
type AnimHolder = {
  anim: AnimState | null
  em: EntityMesh | null
  animPending: number
  animCommitted: number
  /** pose buffers owned by this instance — see tryPoseSync */
  scratch?: PoseScratch
  /** outside the camera on the last frame, so posing it is wasted work */
  offScreen?: boolean
  /** its frame advanced while off-screen — pose it as soon as it's visible */
  poseDirty?: boolean
  /** attachment driver — called with every posed frame */
  onPosed?: (posed: PosedVertices) => void
}

/** A cutscene-spawned object (REPLACE_OBJECT): unlike region locs these are
 *  props the script places, and in this era they are how battle crowds are
 *  staged — cutscene 0's fight is mostly loc-spawned fighters whose combat
 *  loops are their defs' idle animations. */
type ObjectRt = AnimHolder & {
  group: THREE.Group
  /** the def's idle sequence — plays while spawned, and is what an
   *  ANIMATE_OBJECT one-shot falls back to */
  idleAnimId: number
  /** footprint in tiles: a loc's model sits at the CENTRE of it, not on the
   *  base tile (SceneGraph.addObject) */
  sizeX: number
  sizeY: number
}

/** An in-flight entity gfx (spot animation riding an entity). Many gfx
 *  models are nothing but attachment carriers (1-5 faces hosting billboards
 *  and particle emitters — the burst around Saradomin's heal is billboards),
 *  so the mesh may be absent while `poseModel` still drives the pose. */
type GfxRt = AnimHolder & {
  holder: THREE.Group
  parent: THREE.Group
  /** the composite the sequence poses, whether or not a mesh was built */
  poseModel: ModelData
  /** billboard/particle attachments riding this gfx, removed with it */
  attachments: { pose: (posed: PosedVertices | null) => void; remove: () => void }[]
  /** false while the sequence is still loading — anim null + settled is "done" */
  settled: boolean
  /** the gfx id whose prebuilt spare mesh this borrowed, so removal returns it
   *  instead of disposing it (null = it built its own) */
  spareOf: number | null
}

/** A spot animation prepared at build time: its def, its model composite
 *  (shareable — posing never writes to the model) and one prebuilt mesh. */
type GfxAsset = { def: Record<string, unknown>; composite: ModelData; spare: TexturedModelMesh | null }

// ---------------------------------------------------------------------------
// Runtime state (all in refs — the sim runs on the rAF loop, not React).

type EntityRt = AnimHolder & {
  group: THREE.Group
  placed: boolean
  fineX: number
  fineY: number
  plane: number
  yaw: number // three.js rotation.y
  route: { tiles: [number, number][]; paces: number[]; next: number } | null
  /** NPC def `size` in tiles. Like a loc, a multi-tile entity is positioned by
   *  the centre of its footprint — every movement target in the client is
   *  `tile * 512 + getSize() * 256` (EntityUpdating). Cutscene 15's carriages
   *  are 2×2 and its smoke clouds 5×5. */
  size: number
  standAnimId: number
  walkAnimId: number
  /** BAS runningSequence / teleportSequence — the client picks between these
   *  and the walk by the PACE of the step being taken, so a cutscene route of
   *  RUNNING steps animates with the run, not a walk cycle at double speed. */
  runAnimId: number
  halfWalkAnimId: number
  /** which of the three is currently playing, so a pace change restarts the
   *  animation but a one-shot ANIMATE_MOVEMENT over the top of a walk doesn't
   *  get clobbered on the next cycle */
  moveAnimId: number
  /** NPC-model billboards (Saradomin's glowing eyes, model 58935 type 115):
   *  separate scene meshes that must FOLLOW the entity — bbMatrix is the
   *  placement the billboard runtime reads, resynced on every move/pose. */
  bb: import('./sceneBillboards').AnimatedBillboards | null
  bbMatrix: THREE.Matrix4 | null
  lastPosed: PosedVertices | null
  /** whether walking re-faces the entity along its travel direction — the
   *  client's PathingEntity.method15863 gate: BAS yawAcceleration != 0 or the
   *  NPC def's contrast != 0. Saradomin in cutscene 0 has BOTH zero, so his
   *  eastward glide keeps the scripted westward facing (walking backwards
   *  toward the camera is intentional). */
  turnsWhileWalking: boolean
}

type CameraRt = {
  posRows: number[][]
  lookRows: number[][]
  posKf: number
  lookKf: number
  speedStart: number
  speedEnd: number
  progress: number
} | null

type FadeRt = { from: number[]; to: number[]; startCycle: number; endCycle: number } | null

/** Client Bezier segment (Camera.calculateCutsceneCameraPosition): rows are the
 *  interleaved [pos, target] keyframe pairs; the segment from keyframe k to k+1
 *  uses rows 2k..2k+3, with the target rows acting as control handles. */
function splinePoint(rows: number[][], kf: number, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const i4 = kf * 2
  const r0 = rows[i4] ?? [0, 0, 0, 0]
  const r1 = rows[i4 + 1] ?? r0
  const r2 = rows[i4 + 2] ?? r1
  const r3 = rows[i4 + 3] ?? r2
  for (let d = 0; d < 3; d++) {
    const a3 = r0[d] * 3
    const b3 = r1[d] * 3
    const c3 = (r2[d] - (r3[d] - r2[d])) * 3
    const p0 = r0[d]
    const c1 = b3 - a3
    const c2 = a3 - b3 * 2 + c3
    const cc = r2[d] - p0 + b3 - c3
    out[d] = p0 + ((cc * t + c2) * t + c1) * t
  }
  return out
}

/**
 * Fine units per client cycle, straight from the client's own mover
 * (EntityUpdating: `positionDelta = 16`, doubled for RUNNING and halved for
 * HALF_WALK). Its catch-up speedups for a backlog of queued steps are all
 * gated on NOT being in a cutscene, so 16/32/8 is the whole story here.
 *
 * Not modelled: the client halves this again while an entity is still turning
 * toward its step (delayMovement), which needs the gradual yaw we snap.
 */
const PACE_UNITS: Record<number, number> = { 0: 8, 2: 32 } // half walk / run; walk below
const paceUnits = (t: number) => PACE_UNITS[t] ?? 16

/**
 * The client's facing for a movement step. It turns by the SIGN of the delta
 * into one of eight compass directions rather than taking a continuous
 * bearing, so a 2×1 step still faces a clean diagonal.
 *
 * These are the client's own constants, and they pin the angle space that
 * MOVEMENT's `direction` field also lives in: south 0, west 4096, north 8192,
 * east 12288. (Both `EntityUpdating`'s step table and its face-an-entity
 * `atan2` agree — the latter passes self−target, i.e. the bearing *away* from
 * what it faces, which is the same +8192 offset.) Returns null for no movement,
 * where the client leaves the facing alone.
 */
function stepFacing(dx: number, dy: number): number | null {
  if (dx > 0) return dy > 0 ? 10240 : dy < 0 ? 14336 : 12288
  if (dx < 0) return dy > 0 ? 6144 : dy < 0 ? 2048 : 4096
  return dy > 0 ? 8192 : dy < 0 ? 0 : null
}

/** Badge colour family per action category (mirrors CutsceneViewer's list). */
function actionGroupClass(type: string): string {
  if (type.includes('CAMERA')) return 'camera'
  if (type.includes('MOVEMENT') || type === 'ROTATE_CUTSCENE_ENTITY' || type === 'RESET_CUTSCENE_ENTITY') return 'entity'
  if (type.includes('OBJECT')) return 'object'
  if (type.startsWith('PLAY_')) return 'sound'
  if (type.includes('GFX') || type.startsWith('PROJECTILE')) return 'gfx'
  if (type === 'FINISHED') return 'end'
  return 'misc'
}

export default function CutscenePlayer({ def, rootHandle, onCycle, unit = 'seconds', sceneHandle }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const perfRef = useRef<HTMLSpanElement>(null)
  // The scene build's teardown force-loses the WebGL context: three's dispose()
  // doesn't free it and a tab only gets ~16. But a canvas lost that way can
  // never hand out another context — getContext keeps returning the same dead
  // one, and three dies on it asking for getShaderPrecisionFormat().precision.
  // Selecting a second cutscene re-runs the build on this same mounted
  // component, so the canvas has to be a NEW element each time: this counter
  // changes in the very render that re-runs the effect, which makes React swap
  // the node instead of reusing it. (Every other viewer avoids the problem by
  // letting three create its own canvas into a mount div.)
  // Variable overrides feed the morph locs the scene is built from, so a save
  // has to rebuild it. Unlike the map viewer there's no partial path here — the
  // whole scene is assembled in one pass — and a cutscene rebuilds on selection
  // anyway, so a full rebuild is the honest option rather than a special case.
  const [varGen, setVarGen] = useState(0)
  useEffect(() => onVarOverridesChanged(() => setVarGen((g) => g + 1)), [])

  // What the BUILD depends on, as a value rather than an identity. Areas decide
  // the terrain, entities and objects decide which meshes exist; everything else
  // — actions, walk routes, camera paths — is read live by the sim, so editing
  // the timeline must not tear the scene down and reload it. The editor hands
  // this component a new def object on every keystroke, and without this each
  // one would cost a full rebuild.
  const sceneKey = useMemo(
    () => JSON.stringify({ a: def.areas, e: def.entities, o: def.objects }),
    [def],
  )
  const buildGen = useRef({ sceneKey, rootHandle, varGen, n: 0 })
  const switchedBuild = buildGen.current.sceneKey !== sceneKey
    || buildGen.current.rootHandle !== rootHandle
    || buildGen.current.varGen !== varGen
  if (switchedBuild) buildGen.current = { sceneKey, rootHandle, varGen, n: buildGen.current.n + 1 }
  const [status, setStatus] = useState('Assembling scene…')
  const [ready, setReady] = useState(false)
  // Not autoplaying: the player is a page section now rather than something
  // you opened deliberately, so it waits to be started.
  const [playing, setPlaying] = useState(false)
  const [cycle, setCycle] = useState(0)
  // kept in a ref so the rAF loop can report without re-subscribing
  const onCycleRef = useRef(onCycle)
  onCycleRef.current = onCycle
  const [warnings, setWarnings] = useState<string[]>([])
  // Volume is a preference, not scene state: it outlives this cutscene, the
  // next one, and the session (same convention as the map viewer's POV
  // settings). Read once at mount; written back below as it changes.
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '')
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    } catch { return 1 }
  })
  const audioRef = useRef<CutsceneAudio | null>(null)

  const playingRef = useRef(playing)
  playingRef.current = playing

  // Audio lives as long as the panel. `audible` follows the transport so a
  // paused preview goes quiet and a resumed one picks the song back up.
  useEffect(() => {
    audioRef.current = new CutsceneAudio(rootHandle)
    return () => { audioRef.current?.dispose(); audioRef.current = null }
  }, [rootHandle])

  useEffect(() => {
    rt.current.audible = playing
    if (playing) audioRef.current?.resume()
    else {
      audioRef.current?.pause()
      // the sim clock is only pushed into state at ~10Hz while playing, so on
      // pause it can be a few cycles stale — land on the real one
      setCycle(rt.current.cycle)
    }
  }, [playing])

  useEffect(() => {
    audioRef.current?.setVolume(volume)
    try { localStorage.setItem(VOLUME_KEY, String(volume)) } catch { /* private mode — it just won't persist */ }
  }, [volume])

  // Everything the sim touches, mutable and rAF-owned.
  const rt = useRef<{
    renderer: THREE.WebGLRenderer | null
    composer: EffectComposer | null
    sky: THREE.Mesh | null
    particles: SceneParticles | null
    billboards: SceneBillboards | null
    /** idle-animated locs (torch flames, flags): posed every frame like the
     *  map scene — rendered at rest pose, a torch's flame model is a tall
     *  authored stack of licks the animation is what collapses */
    animLocs: {
      update: (posed: import('../loaders/skeletalAnimation').PosedVertices) => void
      model: ModelData
      animationId: number
      /** world-space bounds, for skipping the pose when it's out of shot */
      sphere: THREE.Sphere
      animator?: LocAnimator
      billboards?: import('./sceneBillboards').AnimatedBillboards
    }[]
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    heightsByCell: Map<string, Int32Array[]>
    /** the same cells' terrain, for the bridge-flag lookup in groundY */
    terrainByCell: Map<string, MapTerrain>
    /** region locs a REPLACE_OBJECT swaps out, keyed by tile + shape group;
     *  visible until their action fires (see the REPLACE_OBJECT case) */
    replacedLocs: Map<string, THREE.Group>
    entities: EntityRt[]
    objects: (ObjectRt | null)[]
    gfx: GfxRt[]
    camRt: CameraRt
    fade: FadeRt
    /** height of the camera's current focus point — drives which planes'
     *  particle/billboard groups draw (the client's plane visibility follows
     *  the viewpoint; see Particle.java's per-plane bucketing) */
    focusY: number
    cursor: number
    cycle: number
    msAcc: number
    finished: boolean
    /** false while a seek replays history, so it stays silent */
    audible: boolean
    disposed: boolean
    /** terrain meshes, kept for the editor's tile picking */
    terrainMeshes: THREE.Mesh[]
    /** the editor's selected-tile marker, built on first use */
    tileHighlight: THREE.Group | null
    /** editor is flying the camera — cutscene camera actions stop applying */
    freeCamera: boolean
  }>(null!)
  if (!rt.current) {
    rt.current = {
      renderer: null,
      scene: new THREE.Scene(),
      // The cutscene viewport is 640×480 LANDSCAPE (the dump's viewportHeight/
      // viewportWidth names are swapped — darkan's aspectFovMax clamp of
      // 480·512/640 = 384 is a height/width ratio of 0.75, i.e. 4:3). The
      // client's projection focal length works out to tan(halfFovV) = 334/(4·
      // fovScale) with fovScale clamped to 334 → vertical FOV = 2·atan(0.25).
      camera: new THREE.PerspectiveCamera(2 * Math.atan(0.25) * 180 / Math.PI, 4 / 3, 50, 60000),
      heightsByCell: new Map(),
      terrainByCell: new Map(),
      replacedLocs: new Map(),
      entities: [],
      objects: [],
      gfx: [],
      camRt: null,
      fade: null,
      focusY: 0,
      cursor: 0,
      cycle: 0,
      msAcc: 0,
      finished: false,
      audible: false,
      disposed: false,
      terrainMeshes: [],
      tileHighlight: null,
      freeCamera: false,
      composer: null,
      sky: null,
      particles: null,
      billboards: null,
      animLocs: [],
    }
  }

  // Reset the transport HERE rather than in the build effect. A cutscene switch
  // is visible to render one pass before any effect runs, and render reads the
  // sim's cursor — cutscene 2 watched to its end left a cursor of 60 against
  // cutscene 3's shorter action list, so `def.actions[cursor - 1]` was
  // undefined and the whole panel died mid-render. Everything the render path
  // touches has to be consistent with `def` by the time render sees it; the
  // rest of the teardown stays in the effect where it belongs.
  if (switchedBuild) {
    const r = rt.current
    r.cursor = 0
    r.cycle = 0
    r.msAcc = 0
    r.finished = false
    r.camRt = null
    r.fade = null
  }

  // Where the timeline ends. A cutscene finishes at its FINISHED action — the
  // sim stops dead there — so the bar has to end at the same cycle, or it reads
  // as a second of playback that never happens (cutscene 0: 44.8s shown against
  // a 43.8s finish, frozen at the end). Only a cutscene without a FINISHED gets
  // the old tail, to leave its last action time to play out.
  // +1 because an action fires when the clock REACHES its cycle: stopping the
  // sim at the FINISHED cycle itself would leave that action (and anything else
  // sharing the cycle) unapplied, which is what made the end read 134/135.
  //
  // Both derived once per cutscene rather than per render — the clock re-renders
  // this component several times a second and these are a find, a reduce, a Set
  // and a sort over every action (341 of them in cutscene 11).
  const { durationCycles, actionStarts } = useMemo(() => {
    const finishCycle = def.actions.find((a) => a.type === 'FINISHED')?.lengthInCycles
    return {
      durationCycles: finishCycle != null
        ? finishCycle + 1
        : def.actions.reduce((m, a) => Math.max(m, a.lengthInCycles), 0) + 50,
      // Distinct action start cycles, for the step-by-action buttons. An action
      // at start s is applied once the sim clock passes it (cycle > s), so
      // "jump to this action" means seek(s + 1).
      actionStarts: [...new Set(def.actions.map((a) => a.lengthInCycles))].sort((a, b) => a - b),
    }
  }, [def])

  // Played to the end: the FINISHED action fired, or the clock ran out. Keyed
  // off `cycle` (state) rather than the runtime so the button re-renders.
  const atEnd = ready && (cycle >= durationCycles || rt.current.finished)

  // Frame-stepping, for pinning down something that happens too fast to see.
  // Cycle-sized rather than action-sized: the action steppers jump between
  // events, this crawls THROUGH one.
  const [stepSize, setStepSize] = useState(5)

  const stepCycles = (dir: 1 | -1) => {
    const target = Math.max(0, Math.min(durationCycles, rt.current.cycle + dir * stepSize))
    seek(target)
    setPlaying(false)
  }

  const stepToAction = (dir: 1 | -1) => {
    const r = rt.current
    if (dir === 1) {
      const next = actionStarts.find((s) => s >= r.cycle)
      if (next != null) seek(next + 1)
    } else {
      const applied = actionStarts.filter((s) => s < r.cycle)
      if (applied.length <= 1) seek(0)
      else seek(applied[applied.length - 2] + 1)
    }
    setPlaying(false)
  }


  // Tooltips built once per cutscene, not per render: the list re-renders on
  // every clock update and this was 341 JSON.stringify calls each time.
  const actionTitles = useMemo(
    () => def.actions.map((a) => `Jump here (${JSON.stringify(a.fields ?? {})})`),
    [def],
  )

  // Sidebar action list: the most recently applied start's actions are
  // "current"; keep them scrolled into view as playback advances.
  const actionListRef = useRef<HTMLUListElement>(null)
  const cursor = rt.current.cursor
  // `?.` on principle: the cursor is sim state and this is render, so any future
  // path that lets the two drift must not be able to take the panel down again.
  const lastAppliedStart = def.actions[cursor - 1]?.lengthInCycles ?? -1

  // Built only when the CURSOR moves, not on every clock update. The clock goes
  // into state ~10×/s while cutscene 11's actions fire about 4×/s, so most of
  // those updates would reconcile all 341 items for no visual change. `seek` is
  // reached through a ref because it's a fresh closure every render, which
  // would defeat the memo.
  const seekRef = useRef<(target: number) => void>(null!)
  const actionItems = useMemo(() => def.actions.map((a, i) => {
    const state = i < cursor ? (a.lengthInCycles === lastAppliedStart ? 'current' : 'done') : 'pending'
    return (
      <li key={i}>
        <button
          type="button"
          className={`cutscene-player-action cutscene-player-action-${state}`}
          title={actionTitles[i]}
          onClick={() => { seekRef.current(a.lengthInCycles + 1); setPlaying(false) }}
        >
          <span className="cutscene-player-action-time">{clockShort(a.lengthInCycles, unit)}</span>
          <span className={`cutscene-action-badge cutscene-action-${actionGroupClass(a.type)}`}>{a.type.toLowerCase().replace(/_/g, ' ')}</span>
        </button>
      </li>
    )
  }), [def, cursor, lastAppliedStart, actionTitles, unit])
  // Keyed on the CURSOR, not the clock: the row to scroll to only moves when an
  // action fires, so following the clock re-ran this (and its layout reads) for
  // nothing most of the time. The row is indexed off `children` rather than
  // found with querySelector, which was a scan of all 341 items.
  useEffect(() => {
    const list = actionListRef.current
    if (!list || cursor === 0) return
    const current = list.children[cursor - 1] as HTMLElement | undefined
    if (!current) return
    // Scroll the LIST, never scrollIntoView. That walks every scrollable
    // ancestor including the page, so while playing it fired on each cycle and
    // yanked the window back — you could not scroll the player off-screen.
    const top = current.offsetTop
    const bottom = top + current.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [cursor])

  // ------------------------------------------------------------------ helpers

  const groundY = (fineX: number, fineY: number, plane: number): number => {
    const r = rt.current
    const rx = Math.min(Math.max(fineX >> 9 >> 6, 0), 1)
    const ry = Math.min(Math.max(fineY >> 9 >> 6, 0), 1)
    const key = `${rx},${ry}`
    const heights = r.heightsByCell.get(key)
    if (!heights) return 0
    const localX = fineX - rx * REGION_UNITS
    const localY = fineY - ry * REGION_UNITS
    // Bridge columns: a tile flagged 0x2 on DECODED plane 1 puts its deck at
    // render plane 0, and buildTerrainMesh already draws it that way — so the
    // ground you stand on there is one decoded plane up from the plane the
    // action names. The client does exactly this when placing an entity:
    // `collisionPlane + 1` if SettingsBits.areRoofsHidden (NpcEntity.move),
    // which is the same flag read on the same plane. Without it every entity
    // on a bridge tile stands on whatever is UNDER the deck — cutscene 7's
    // dancers were buried to the neck in the carpet they dance on.
    const terrain = r.terrainByCell.get(key)
    const tileX = localX >> 9
    const tileY = localY >> 9
    const onBridge = terrain != null
      && tileX >= 0 && tileY >= 0 && tileX < SIZE && tileY < SIZE
      && isBridgeTile(terrain, tileX, tileY)
    const h = averageHeight(heights[onBridge ? Math.min(plane + 1, 3) : plane], localX, localY)
    return -h
  }

  const placeEntity = (e: EntityRt) => {
    e.group.position.set(e.fineX, groundY(e.fineX, e.fineY, e.plane), -e.fineY)
    e.group.rotation.y = e.yaw
    e.group.visible = e.placed
    // model billboards (Saradomin's eyes) live outside the group — move and
    // show/hide them with it, re-anchoring at the held pose if any
    if (e.bb && e.bbMatrix) {
      // scratch, not fresh objects: this runs per entity per cycle
      yawEuler.set(0, e.yaw, 0)
      e.bbMatrix.compose(e.group.position, yawQuat.setFromEuler(yawEuler), ONE_V3)
      e.bb.setVisible(e.placed)
      if (e.placed) e.bb.pose(e.lastPosed)
    }
  }

  // Animation caches shared by all entities. Each promise cache has a RESOLVED
  // mirror, because posing must be able to run SYNCHRONOUSLY: a MOVEMENT and
  // an ANIMATE_MOVEMENT in the same tick must land in the same stepCycle, and
  // even a cached promise commits in a microtask AFTER the frame renders —
  // Zilyana appeared standing for a beat before lying down. The mirrors fill
  // at resolution (attached first, so they beat any awaiting consumer) and
  // via the build-time prewarm below.
  const animDefCache = useRef(new Map<number, Promise<AnimationDef | null>>())
  const frameSetCache = useRef(new Map<number, Promise<AnimationFrameSetData | null>>())
  const frameBaseCache = useRef(new Map<number, Promise<AnimationFrameBaseDef | null>>())
  // Spot-animation assets, keyed by gfx id — see loadGfxAsset.
  const gfxAssets = useRef(new Map<number, GfxAsset>())
  const gfxPending = useRef(new Map<number, Promise<GfxAsset | null>>())
  const animDefSync = useRef(new Map<number, AnimationDef | null>())
  const frameSetSync = useRef(new Map<number, AnimationFrameSetData | null>())
  const frameBaseSync = useRef(new Map<number, AnimationFrameBaseDef | null>())

  const loadAnimDef = (id: number) => {
    let p = animDefCache.current.get(id)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('animations'))
          const file = await (await dir!.getFileHandle(`${id}.json`)).getFile()
          return JSON.parse(await file.text()) as AnimationDef
        } catch { return null }
      })()
      animDefCache.current.set(id, p)
      void p.then((v) => animDefSync.current.set(id, v))
    }
    return p
  }

  const loadFrameSet = (setId: number): Promise<AnimationFrameSetData | null> => {
    if (setId < 0) return Promise.resolve(null)
    let p = frameSetCache.current.get(setId)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
          const loader = getLoader('animation_frame_sets')
          if (!dir || !loader) return null
          return await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
        } catch { return null }
      })()
      frameSetCache.current.set(setId, p)
      void p.then((v) => frameSetSync.current.set(setId, v))
    }
    return p
  }

  const loadFrameBase = (baseId: number) => {
    let p = frameBaseCache.current.get(baseId)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
          const loader = getLoader('animation_frame_bases')
          if (!dir || !loader) return null
          const data = await loader.loadItem(dir, { id: baseId, name: `${baseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
          return data.def
        } catch { return null }
      })()
      frameBaseCache.current.set(baseId, p)
      void p.then((v) => frameBaseSync.current.set(baseId, v))
    }
    return p
  }

  /** No newer startAnim in flight — safe for a fallback (stand/idle) to run. */
  const animSettled = (h: AnimHolder) => h.animPending === h.animCommitted

  /** The BAS sequence for a step of this pace, mirroring the client's
   *  `PathingEntity.animateMovement`: RUNNING takes the running sequence and
   *  HALF_WALK the teleport one when they exist, and everything else walks. */
  const moveAnimFor = (e: EntityRt, pace: number): number => {
    if (pace === 2 && e.runAnimId >= 0) return e.runAnimId
    if (pace === 0 && e.halfWalkAnimId >= 0) return e.halfWalkAnimId
    return e.walkAnimId
  }

  const frameSync = (def: AnimationDef, index: number) => {
    const setId = def.frameSetIds?.[index]
    if (setId == null) return null
    return frameSetSync.current.get(setId)?.frames.get(frameFileId(def, index)) ?? null
  }

  /** the tween target's index, or -1 when the frame holds (one-shot end) */
  const nextFrameIndex = (anim: AnimState) => {
    const count = anim.def.frameDurations?.length ?? 0
    if (!anim.def.tweened || count <= 1) return -1
    return anim.frame + 1 >= count ? (anim.oneShot ? -1 : 0) : anim.frame + 1
  }

  type PoseTarget = {
    anim: AnimState | null
    em: EntityMesh | null
    /** poses even without a mesh (attachment-only gfx) */
    poseModel?: ModelData
    /** attachment driver (billboards riding the pose) */
    onPosed?: (posed: PosedVertices) => void
    /** this instance's pose buffers, allocated on first use */
    scratch?: PoseScratch
  }

  /** Pose from the resolved mirrors. False = something still loading. */
  const tryPoseSync = (e: PoseTarget): boolean => {
    const poseModel = e.em?.model ?? e.poseModel
    if (!e.anim || !poseModel) return true
    const anim = e.anim
    const setId = anim.def.frameSetIds?.[anim.frame]
    if (setId == null) return true
    if (!frameSetSync.current.has(setId)) return false
    const frame = frameSync(anim.def, anim.frame)
    if (!frame || frame.rawFallbackBytes) return true
    const ni = nextFrameIndex(anim)
    let next: typeof frame | null = null
    if (ni >= 0) {
      const nextSetId = anim.def.frameSetIds?.[ni]
      if (nextSetId != null && !frameSetSync.current.has(nextSetId)) return false
      next = frameSync(anim.def, ni)
    }
    if (!frameBaseSync.current.has(frame.frameBaseId)) return false
    const frameBase = frameBaseSync.current.get(frame.frameBaseId)
    if (!frameBase) return true
    // ticks elapsed in this frame, plus the sub-cycle fraction of the sim
    // clock, so a 60fps render tweens smoothly through 20ms sim ticks
    const elapsed = anim.acc + Math.min(rt.current.msAcc / CYCLE_MS, 0.999)
    const duration = Math.max(1, anim.def.frameDurations?.[anim.frame] ?? 1)
    // Posed into this holder's OWN buffers rather than three fresh arrays each
    // time. Per holder, not per model: gfx of the same id share a composite,
    // and entities keep their last pose (billboards read it), so a buffer
    // shared between two live things would have them overwrite each other.
    e.scratch ??= makePoseScratch(poseModel)
    const posed = applyAnimationFrame(poseModel, frameBase, frame, next, elapsed, duration, e.scratch)
    if (posed) {
      if (e.em) applyPose(e.em, posed)
      e.onPosed?.(posed)
    }
    return true
  }

  /** Sync when everything's resolved (the prewarmed common case), else loads
   *  and applies when the data lands. */
  const poseEntityFrame = (e: PoseTarget) => {
    if (tryPoseSync(e)) return
    const anim = e.anim
    if (!anim) return
    void (async () => {
      try {
        await loadFrameSet(anim.def.frameSetIds?.[anim.frame] ?? -1)
        const frame = frameSync(anim.def, anim.frame)
        const ni = nextFrameIndex(anim)
        if (ni >= 0) await loadFrameSet(anim.def.frameSetIds?.[ni] ?? -1)
        if (frame && !frame.rawFallbackBytes) await loadFrameBase(frame.frameBaseId)
        if (rt.current.disposed || e.anim !== anim) return
        tryPoseSync(e)
      } catch { /* frame unavailable — hold the last pose */ }
    })()
  }

  const startAnim = async (e: AnimHolder, animId: number, oneShot: boolean) => {
    // ticket the request: an older load resolving late may not overwrite a
    // newer animation (fresh-load I/O and cached-microtask order both raced)
    const seq = ++e.animPending
    if (animId < 0) { e.animCommitted = seq; e.anim = null; if (e.em) applyPose(e.em, null); return }
    // synchronous when prewarmed — the anim commits AND poses inside the
    // calling stepCycle, simultaneous with a same-tick placement
    let animDef = animDefSync.current.get(animId)
    if (animDef === undefined) {
      animDef = await loadAnimDef(animId)
      if (e.animPending !== seq) return // superseded while loading
    }
    e.animCommitted = seq
    if (!animDef || !animDef.frameDurations?.length) return
    e.anim = { def: animDef, frame: 0, acc: 0, oneShot }
    poseEntityFrame(e)
  }

  /** The client refuses to start a cutscene until every action's assets are
   *  `ready()` (CutsceneAction.method1599) — mirror it by prewarming every
   *  referenced sequence (defs, frame sets, frame bases) at build, which is
   *  also what makes the same-tick place+animate path fully synchronous. */
  const prewarmAnims = async (ids: Iterable<number>) => {
    await Promise.all([...new Set(ids)].filter((id) => id != null && id >= 0).map(async (id) => {
      const def = await loadAnimDef(id)
      if (!def?.frameDurations?.length) return
      const setIds = new Set((def.frameSetIds ?? []).filter((s) => s != null && s >= 0))
      await Promise.all([...setIds].map(loadFrameSet))
      const baseIds = new Set<number>()
      for (let i = 0; i < def.frameDurations.length; i++) {
        const frame = frameSync(def, i)
        if (frame && !frame.rawFallbackBytes) baseIds.add(frame.frameBaseId)
      }
      await Promise.all([...baseIds].map(loadFrameBase))
    }))
  }

  const gfxLighting = (gfxDef: Record<string, unknown>) => ({
    ambient: 64 + Number(gfxDef.ambient ?? 0),
    contrast: 850 + Number(gfxDef.contrast ?? 0) * 5,
  })

  /**
   * Load a spot animation's def, model composite and one built mesh, once per
   * gfx id, at BUILD time.
   *
   * The client will not start a cutscene until every spot-anim action reports
   * `isFullyCached()`, which is `gfxType.isModelLoaded() && seqType.ready()`
   * (AbstractCutsceneSpotAnimation) — we were doing only the sequence half, so
   * a gfx read its def off disk, parsed its model and built its mesh at the
   * exact cycle it was supposed to already be on screen. Cutscene 0's teleport
   * flash (gfx 1588, 30 cycles from 2033) was meant to cover two entities being
   * removed at 2042 and 2072, and instead arrived after they had both blinked
   * out.
   *
   * The composite is shared between concurrent instances of the same gfx —
   * posing copies the model's vertex arrays into its own state and never writes
   * back — but a mesh owns GPU geometry that each pose rewrites, so only one
   * prebuilt mesh is kept, lent to whichever instance is live and returned when
   * it ends. A second simultaneous instance falls back to building its own.
   */
  const loadGfxAsset = (gfxId: number): Promise<GfxAsset | null> => {
    let p = gfxPending.current.get(gfxId)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('spot_animations'))
          if (!dir) return null
          const gfxDef = JSON.parse(await (await dir.getFileHandle(`${gfxId}.json`)).getFile().then((f) => f.text())) as Record<string, unknown>
          const modelId = Number(gfxDef.modelId ?? -1)
          if (modelId < 0) return null
          const composite = await loadModelComposite(rootHandle, {
            hideMarkerFaces: true,
            modelIds: [modelId],
            recolor: {
              from: gfxDef.originalColors as number[] | undefined,
              to: gfxDef.modifiedColors as number[] | undefined,
              textureFrom: gfxDef.originalTextures as number[] | undefined,
              textureTo: gfxDef.modifiedTextures as number[] | undefined,
            },
            scale: {
              x: Number(gfxDef.scaleXZ ?? 128) || 128,
              y: Number(gfxDef.scaleY ?? 128) || 128,
              z: Number(gfxDef.scaleXZ ?? 128) || 128,
            },
          })
          const spare = await buildTexturedModelMesh(composite, gfxLighting(gfxDef))
          if (rt.current.disposed) { spare?.dispose(); return null }
          const asset: GfxAsset = { def: gfxDef, composite, spare }
          gfxAssets.current.set(gfxId, asset)
          return asset
        } catch {
          return null // gfx unavailable — its actions just do nothing
        }
      })()
      gfxPending.current.set(gfxId, p)
    }
    return p
  }

  /** Spawns a spot animation (gfx) on an entity — ENTITY_GFX, and the gfx an
   *  ANIMATE_MOVEMENT can carry in its third field (the client plays them via
   *  the same spot-anim slots). Plays its sequence once, then removes itself. */
  const startEntityGfx = async (e: EntityRt, gfxId: number, displayHeight: number, rotation: number) => {
    try {
      // Prewarmed in the common case, so this resolves in a microtask and the
      // gfx is on screen in the same frame its action fired.
      const asset = gfxAssets.current.get(gfxId) ?? await loadGfxAsset(gfxId)
      if (!asset) return
      const { def: gfxDef, composite } = asset
      let tm = asset.spare
      const borrowed = tm != null
      if (tm) {
        asset.spare = null
        applyPose({ tm, model: composite }, null) // it holds the last run's final pose
      } else {
        // another instance of this gfx is already using the spare
        tm = await buildTexturedModelMesh(composite, gfxLighting(gfxDef))
      }
      if (rt.current.disposed) { if (!borrowed) tm?.dispose(); return }
      // Most cutscene 1 gfx models are pure attachment carriers (1-5 faces,
      // all billboard hosts / emitter spawn surfaces) — tm comes back null
      // for those and the billboards/particles below ARE the effect. Only
      // bail when there is neither a mesh nor any attachment.
      if (!tm && !composite.billboards?.length && !composite.emitters?.length) return
      const gfxYaw = -(rotation / 16384) * Math.PI * 2
      const holder = new THREE.Group()
      if (tm) holder.add(tm.mesh)
      holder.position.y = displayHeight
      holder.rotation.y = gfxYaw
      e.group.add(holder)
      const gfx: GfxRt = {
        em: tm ? { tm, model: composite } : null,
        poseModel: composite,
        anim: null, animPending: 0, animCommitted: 0,
        holder, parent: e.group, attachments: [], settled: false,
        spareOf: borrowed ? gfxId : null,
      }
      // Billboards/particles ride the entity's CURRENT placement (a cutscene
      // entity rarely moves during its own gfx). Billboards follow the posed
      // frames through onPosed; particles spawn from the rest-pose faces like
      // every loc emitter does.
      const placement = new THREE.Matrix4().compose(
        new THREE.Vector3(e.group.position.x, e.group.position.y + displayHeight, e.group.position.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.group.rotation.y + gfxYaw, 0)),
        new THREE.Vector3(1, 1, 1),
      )
      const placed = { model: composite, matrix: placement, upscale: modelUpscale(composite), plane: 0 }
      const bb = rt.current.billboards?.addAnimated(placed)
      if (bb) gfx.attachments.push(bb)
      if (composite.emitters?.length && rt.current.particles) {
        const pt = await rt.current.particles.add(placed)
        if (pt) gfx.attachments.push({ pose: () => {}, remove: pt.remove })
      }
      gfx.onPosed = (posed) => { for (const a of gfx.attachments) a.pose(posed) }
      rt.current.gfx.push(gfx)
      await startAnim(gfx, Number(gfxDef.sequenceId ?? -1), true)
      gfx.settled = true
      // a gfx whose sequence failed to load still shows its model one cycle,
      // then the stepper removes it (anim stays null with settled set)
    } catch { /* gfx unavailable */ }
  }

  const removeGfx = (g: GfxRt) => {
    g.parent.remove(g.holder)
    if (g.em) {
      // hand a borrowed mesh back rather than destroying it — the next spawn of
      // this gfx has to be instant too
      const asset = g.spareOf != null ? gfxAssets.current.get(g.spareOf) : null
      if (asset && !asset.spare) asset.spare = g.em.tm
      else g.em.tm.dispose()
    }
    for (const a of g.attachments) a.remove()
    g.attachments = []
  }

  // ---------------------------------------------------------------- actions

  /** A camera path as the interleaved [position, target] keyframe rows the
   *  client's Bezier walks (see splinePoint). */
  const camRows = (movementIndex: number): number[][] => {
    const cam = def.camMovements[movementIndex]
    if (!cam) return []
    const out: number[][] = []
    for (let i = 0; i < cam.xPositions.length; i++) {
      out.push([cam.xPositions[i], cam.yPositions[i], cam.zPositions[i], cam.timestamps[i]])
      out.push([cam.targetXPositions[i], cam.targetYPositions[i], cam.targetZPositions[i], cam.timestamps[i]])
    }
    return out
  }

  /**
   * Park the camera where the cutscene's FIRST camera move begins, without
   * starting anything: the still you see before pressing play is then the
   * cutscene's own opening shot rather than a generic overhead guess, which
   * put the camera somewhere arbitrary and sometimes under the terrain.
   *
   * Deliberately does NOT set `camRt` — that would have the spline advancing
   * from cycle 0, flying the camera before its action has fired. Only the
   * pose at t = 0 is borrowed. Returns false when there is no camera path to
   * borrow it from, so the caller can fall back.
   */
  const applyInitialCamera = (): boolean => {
    const r = rt.current
    const first = def.actions.find((a) => a.type === 'DIRECT_CAMERA_MOVEMENT')
    if (!first) return false
    const f = (first.fields ?? {}) as Record<string, number>
    const posRows = camRows(f.positionMovementIndex)
    const lookRows = camRows(f.lookAtMovementIndex)
    if (posRows.length === 0 || lookRows.length === 0) return false
    const from = splinePoint(posRows, f.positionKeyframe, 0)
    const to = splinePoint(lookRows, f.lookAtKeyframe, 0)
    r.camera.position.set(from[0], from[1], -from[2])
    r.camera.lookAt(to[0], to[1], -to[2])
    r.focusY = to[1]
    return true
  }

  const applyAction = (index: number) => {
    const r = rt.current
    const a = def.actions[index]
    const f = (a.fields ?? {}) as Record<string, number>
    switch (a.type) {
      case 'DIRECT_CAMERA_MOVEMENT': {
        r.camRt = {
          posRows: camRows(f.positionMovementIndex),
          lookRows: camRows(f.lookAtMovementIndex),
          posKf: f.positionKeyframe,
          lookKf: f.lookAtKeyframe,
          speedStart: f.splineSpeedStart,
          speedEnd: f.splineSpeedEnd,
          progress: 0,
        }
        break
      }
      case 'MOVEMENT': {
        const e = r.entities[f.targetIndex]
        if (!e) break
        e.placed = true
        e.fineX = (f.x << 9) + (e.size << 8)
        e.fineY = (f.y << 9) + (e.size << 8)
        e.plane = f.plane
        e.route = null
        // Client entity angles run CLOCKWISE FROM NORTH (PathingEntity.turn's
        // 0x3fff units; the walk table in SystemInfo.java:312 pins the compass:
        // +y tiles=0, east=4096, south=8192, west=12288). Our scene has north
        // at -z, so the three.js yaw is the NEGATED angle. The old `π + angle`
        // guess happened to match at east/west and was 180° off at north/south.
        e.yaw = -(f.direction / 16384) * Math.PI * 2
        // stand only when nothing is playing AND nothing newer is loading — a
        // same-cycle ANIMATE_MOVEMENT's pose must not lose to this fallback
        if (!e.anim && animSettled(e) && e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
        placeEntity(e)
        break
      }
      case 'BASIC_MOVEMENT': {
        const e = r.entities[f.entityIndex]
        const m = def.movements[f.movementIndex]
        if (!e || !m || m.bitpackedPositions.length === 0) break
        const tiles = m.bitpackedPositions.map((p) => [p >>> 16, p & 0xffff] as [number, number])
        e.placed = true
        e.plane = f.plane
        e.fineX = (tiles[0][0] << 9) + (e.size << 8)
        e.fineY = (tiles[0][1] << 9) + (e.size << 8)
        e.route = { tiles, paces: m.movementTypes, next: 1 }
        // the walking loop below starts the right sequence for the first leg's
        // pace on this very cycle — clearing it is what tells it to
        e.moveAnimId = -1
        placeEntity(e)
        break
      }
      case 'ANIMATE_MOVEMENT': {
        const e = r.entities[f.entityIndex]
        if (e) {
          void startAnim(e, f.movementAnimationId, true)
          // the third field is a gfx id, not a flag: the client plays the
          // animation with that spot anim when non-zero (CutsceneAction_Sub18
          // routes through the entity's spot-anim slots)
          if (f.seqFlag) void startEntityGfx(e, f.seqFlag, 0, 0)
        }
        break
      }
      case 'ROTATE_CUTSCENE_ENTITY': {
        const e = r.entities[f.cutsceneEntityPtr]
        // same clockwise-from-north units as MOVEMENT's direction field
        if (e) { e.yaw = -(f.rotation / 16384) * Math.PI * 2; placeEntity(e) }
        break
      }
      case 'RESET_CUTSCENE_ENTITY': {
        const e = r.entities[f.entityIndex]
        if (e) { e.placed = false; e.route = null; e.anim = null; e.moveAnimId = -1; placeEntity(e) }
        break
      }
      case 'REPLACE_OBJECT': {
        // The REPLACE half: whatever region loc held this tile in this shape
        // group goes, then ours takes its place (LocAction.destroyObject).
        const shape = def.objects[f.locIndex]?.locShape
        if (shape != null) {
          const previous = r.replacedLocs.get(replacedLocKey(f.plane, f.x, f.y, shape))
          if (previous) previous.visible = false
        }
        const o = r.objects[f.locIndex]
        if (o) {
          o.group.visible = true
          // A loc is positioned by the CENTRE of its footprint, not its base
          // tile, and rotations 1/3 swap that footprint (SceneGraph.addObject:
          // `sceneX = (x << 9) + (sizeX << 8)`) — the same maths buildLocsMesh
          // uses for every region loc. Cutscene 8's portcullis is 2×6, so
          // dropping it on the base tile put a six-tile gate 2½ tiles out of
          // place, swinging it across the camera.
          const swap = f.rotation === 1 || f.rotation === 3
          const sizeX = swap ? o.sizeY : o.sizeX
          const sizeY = swap ? o.sizeX : o.sizeY
          const fineX = (f.x << 9) + (sizeX << 8)
          const fineY = (f.y << 9) + (sizeY << 8)
          o.group.position.set(fineX, groundY(fineX, fineY, f.plane), -fineY)
          o.group.rotation.y = -(f.rotation * Math.PI) / 2
          // spawned objects play their def's idle sequence — cutscene 0's
          // battle crowd is loc-spawned fighters whose combat loops ARE their
          // idle animations; without this they stand frozen
          if (!o.anim && o.idleAnimId >= 0) void startAnim(o, o.idleAnimId, false)
        }
        break
      }
      case 'DESTROY_OBJECT': {
        const o = r.objects[f.cutsceneObjectPtr]
        if (o) { o.group.visible = false; o.anim = null }
        break
      }
      case 'ANIMATE_OBJECT': {
        // client: Class9.animateObject(...) — play the sequence on the spawned
        // loc, then fall back to its idle (the one-shot handling below)
        const o = r.objects[f.objectIndex]
        if (o) void startAnim(o, f.sequenceId, true)
        break
      }
      case 'ENTITY_GFX': {
        const e = r.entities[f.targetIndex]
        if (e) void startEntityGfx(e, f.gfxId, f.displayHeight ?? 0, f.rotation ?? 0)
        break
      }
      case 'FADE_SCREEN': {
        const argb = (f.fadeScreenColor as number) >>> 0
        const prev = r.fade
        const prevNow = prev ? fadeColorAt(prev, r.cycle) : [0, 0, 0, 0]
        r.fade = {
          from: prevNow,
          to: [argb >>> 24, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff],
          startCycle: r.cycle,
          endCycle: r.cycle + (f.fadeDurationCycles as number),
        }
        break
      }
      case 'FINISHED':
        r.finished = true
        break
      case 'PLAY_SYNTH':
      case 'PLAY_VORBIS':
      case 'PLAY_SONG':
        // A seek re-applies every earlier action to rebuild scene state, and
        // firing their sounds too would dump the whole soundtrack at once —
        // so audio only sounds while the clock is genuinely running forward.
        if (r.audible) audioRef.current?.play(a.type, f, (r.cycle * CYCLE_MS) / 1000)
        break
      default:
        break // gfx, projectiles, hints, messages, vars: not simulated
    }
  }

  /** `out` lets the per-frame caller avoid allocating; FADE_SCREEN's own use
   *  needs a fresh array, since it stores the result. */
  const fadeColorAt = (fade: NonNullable<FadeRt>, at: number, out?: number[]): number[] => {
    const t = fade.endCycle <= fade.startCycle ? 1 : Math.min(Math.max((at - fade.startCycle) / (fade.endCycle - fade.startCycle), 0), 1)
    const target = out ?? new Array<number>(fade.from.length)
    for (let i = 0; i < fade.from.length; i++) target[i] = fade.from[i] + (fade.to[i] - fade.from[i]) * t
    return target
  }

  // ------------------------------------------------------------ per-cycle sim

  const stepCycle = () => {
    const r = rt.current
    while (r.cursor < def.actions.length && def.actions[r.cursor].lengthInCycles <= r.cycle) {
      applyAction(r.cursor)
      r.cursor++
    }
    // camera spline progress (client: accelerating 16.16 progress per cycle)
    if (r.camRt) {
      const c = r.camRt
      const speed = c.speedStart + (((c.speedEnd - c.speedStart) * c.progress) >> 16)
      c.progress = Math.min(c.progress + speed, 65535)
    }
    // Entity walking. Each axis advances by the full step independently, as
    // the client does it — a diagonal leg therefore covers both axes at full
    // speed rather than sharing one budget between them — and only one leg is
    // consumed per cycle, with no leftover carried into the next.
    for (const e of r.entities) {
      if (!e.placed || !e.route) continue
      const pace = e.route.paces[Math.min(e.route.next, e.route.paces.length - 1)] ?? 1
      // The BAS sequence follows the pace of the leg being walked. Only a
      // CHANGE restarts it, so a one-shot animation playing over a walk lives
      // out its length instead of being reset every cycle.
      const wantAnim = moveAnimFor(e, pace)
      if (wantAnim >= 0 && wantAnim !== e.moveAnimId) {
        e.moveAnimId = wantAnim
        void startAnim(e, wantAnim, false)
      }
      const step = paceUnits(pace)
      const [tx, ty] = e.route.tiles[e.route.next]
      const gx = (tx << 9) + (e.size << 8)
      const gy = (ty << 9) + (e.size << 8)
      // gated exactly like the client (see turnsWhileWalking): an entity that
      // cannot turn keeps its scripted facing while it moves
      if (e.turnsWhileWalking) {
        const facing = stepFacing(gx - e.fineX, gy - e.fineY)
        if (facing != null) e.yaw = -(facing / 16384) * Math.PI * 2
      }
      if (e.fineX < gx) e.fineX = Math.min(gx, e.fineX + step)
      else if (e.fineX > gx) e.fineX = Math.max(gx, e.fineX - step)
      if (e.fineY < gy) e.fineY = Math.min(gy, e.fineY + step)
      else if (e.fineY > gy) e.fineY = Math.max(gy, e.fineY - step)
      if (e.fineX === gx && e.fineY === gy) e.route.next++
      if (e.route.next >= e.route.tiles.length) {
        e.route = null
        e.moveAnimId = -1
        if (animSettled(e) && e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
      }
      placeEntity(e)
    }
    // animation frames for entities, spawned objects and in-flight gfx
    // (durations are client cycles). Returns true when a one-shot finished.
    const stepAnim = (holder: AnimHolder): boolean => {
      if (!holder.anim) return false
      const durations = holder.anim.def.frameDurations ?? []
      if (durations.length === 0) return false
      holder.anim.acc++
      if (holder.anim.acc >= (durations[holder.anim.frame] || 1)) {
        holder.anim.acc = 0
        if (holder.anim.frame + 1 >= durations.length) {
          if (holder.anim.oneShot) {
            holder.anim = null
            return true
          }
          holder.anim.frame = 0
        } else {
          holder.anim.frame++
        }
        // Off-screen, the new frame is noted and posed when it next comes into
        // view — the pose is what's expensive and nothing can see it meanwhile.
        // The animation's own state advanced either way, so it stays in step.
        if (holder.offScreen) holder.poseDirty = true
        else void poseEntityFrame(holder)
      }
      return false
    }
    // A finished one-shot HOLDS its last frame — the client's Animation sets
    // its finished flag and keeps rendering the final keyframe until the next
    // action replaces it (no server clears a cutscene sequence). Reverting to
    // the BAS stand here was our invention, and it flashed Saradomin upright
    // for one tick: his kneel-down (10395, 104 ticks from cycle 73) completes
    // at 176, one tick before the kneel-loop action at 177. Same for spawned
    // objects — a death one-shot stays down rather than popping back to its
    // combat idle.
    for (const e of r.entities) stepAnim(e)
    for (const o of r.objects) if (o) stepAnim(o)
    // gfx play once and vanish; one whose sequence failed lives a single cycle
    for (let i = r.gfx.length - 1; i >= 0; i--) {
      const g = r.gfx[i]
      if (stepAnim(g) || (g.settled && !g.anim)) {
        removeGfx(g)
        r.gfx.splice(i, 1)
      }
    }
    r.cycle++
  }

  // ----------------------------------------------------------------- editing
  //
  // Everything below is inert unless the editor passed a `sceneHandle`. It
  // reads the live scene rather than React state, because the scene is rebuilt
  // on its own schedule and a click has to resolve against what's on screen.

  /** Pointer position in normalised device coords, or null if off the canvas. */
  const ndcAt = (clientX: number, clientY: number): THREE.Vector2 | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    pickNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    return pickNdc
  }

  /**
   * The selected-tile marker: a translucent quad with a bright outline, built
   * once and moved. Its four corners each take the ground height at that
   * corner, so it lies flush on a slope instead of hovering over one edge —
   * lifted a few units and drawn without depth writes so it reads as paint on
   * the ground rather than a box sunk into it.
   */
  const tileHighlight = (): THREE.Group => {
    const r = rt.current
    if (r.tileHighlight) return r.tileHighlight
    const group = new THREE.Group()
    const positions = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
    const fill = new THREE.BufferGeometry()
    fill.setAttribute('position', positions)
    fill.setIndex([0, 1, 2, 0, 2, 3])
    const fillMesh = new THREE.Mesh(fill, new THREE.MeshBasicMaterial({
      color: 0x4fc3f7,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    }))
    // the outline shares the same buffer, so moving the tile moves both
    const outline = new THREE.BufferGeometry()
    outline.setAttribute('position', positions)
    const outlineMesh = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({
      color: 0x9fe4ff,
      transparent: true,
      depthWrite: false,
    }))
    for (const mesh of [fillMesh, outlineMesh]) {
      mesh.frustumCulled = false
      mesh.renderOrder = ORDER_TRANSPARENT_LOC + 1
      mesh.raycast = () => {} // never picks itself
      group.add(mesh)
    }
    group.visible = false
    r.scene.add(group)
    r.tileHighlight = group
    return group
  }

  const raycastAt = (clientX: number, clientY: number, targets: THREE.Object3D[]) => {
    const ndc = ndcAt(clientX, clientY)
    if (!ndc || targets.length === 0) return null
    picker.setFromCamera(ndc, rt.current.camera)
    const hits = picker.intersectObjects(targets, true)
    return hits.length > 0 ? hits[0] : null
  }

  useEffect(() => {
    if (!sceneHandle) return
    const r = rt.current
    sceneHandle.current = {
      pickTile: (clientX, clientY) => {
        const hit = raycastAt(clientX, clientY, r.terrainMeshes)
        if (!hit) return null
        // Scene space is x = fine east, z = −fine north (see placeEntity), and
        // a tile is 512 fine units.
        const x = Math.floor(hit.point.x / 512)
        const y = Math.floor(-hit.point.z / 512)
        if (x < 0 || y < 0) return null
        // The plane a cutscene action names is the CUTSCENE plane; the visible
        // ground is whichever plane's mesh was hit, and the terrain meshes are
        // added plane by plane, so the hit's own mesh knows.
        return { x, y, plane: (hit.object.userData.cutscenePlane as number) ?? 0 }
      },
      pickEntity: (clientX, clientY) => {
        const groups = r.entities.filter((e) => e.placed).map((e) => e.group)
        const hit = raycastAt(clientX, clientY, groups)
        if (!hit) return null
        let node: THREE.Object3D | null = hit.object
        while (node) {
          const index = r.entities.findIndex((e) => e.group === node)
          if (index >= 0) return index
          node = node.parent
        }
        return null
      },
      pickObject: (clientX, clientY) => {
        const groups = r.objects.filter((o): o is ObjectRt => o != null && o.group.visible).map((o) => o.group)
        const hit = raycastAt(clientX, clientY, groups)
        if (!hit) return null
        let node: THREE.Object3D | null = hit.object
        while (node) {
          const index = r.objects.findIndex((o) => o?.group === node)
          if (index >= 0) return index
          node = node.parent
        }
        return null
      },
      cameraPose: () => {
        // Camera paths store (x, height, z) with z POSITIVE north, the mirror
        // of the scene's −z; the look target is a point on the view ray.
        r.camera.getWorldDirection(pickDir)
        const p = r.camera.position
        return {
          pos: [Math.round(p.x), Math.round(p.y), Math.round(-p.z)],
          target: [
            Math.round(p.x + pickDir.x * 512),
            Math.round(p.y + pickDir.y * 512),
            Math.round(-(p.z + pickDir.z * 512)),
          ],
        }
      },
      setCameraPose: (pos, target) => {
        r.camera.position.set(pos[0], pos[1], -pos[2])
        r.camera.lookAt(target[0], target[1], -target[2])
      },
      setTileHighlight: (tile) => {
        const group = tileHighlight()
        if (!tile) { group.visible = false; return }
        const attr = (group.children[0] as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute
        const corners: [number, number][] = [
          [tile.x, tile.y],
          [tile.x + 1, tile.y],
          [tile.x + 1, tile.y + 1],
          [tile.x, tile.y + 1],
        ]
        for (let i = 0; i < 4; i++) {
          const fineX = corners[i][0] * 512
          const fineY = corners[i][1] * 512
          attr.setXYZ(i, fineX, groundY(fineX, fineY, tile.plane) + TILE_MARK_LIFT, -fineY)
        }
        attr.needsUpdate = true
        group.visible = true
      },
      setFreeCamera: (on) => { r.freeCamera = on },
      isFreeCamera: () => r.freeCamera,
    }
    return () => { sceneHandle.current = null }
    // the handle closes over refs, which are stable for the component's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneHandle])

  const applyCameraAndFade = () => {
    const r = rt.current
    // While the editor is flying the camera, the cutscene's own camera actions
    // stop moving it — otherwise composing a shot fights the timeline. Fades
    // still apply, so what you frame is what the scene looks like.
    if (r.camRt && !r.freeCamera) {
      const t = r.camRt.progress / 65535
      // into scratch — this runs every rendered frame
      const from = splinePoint(r.camRt.posRows, r.camRt.posKf, t, splineFrom)
      const to = splinePoint(r.camRt.lookRows, r.camRt.lookKf, t, splineTo)
      r.camera.position.set(from[0], from[1], -from[2])
      r.camera.lookAt(to[0], to[1], -to[2])
      r.focusY = to[1]
    }
    if (fadeRef.current) {
      const c = r.fade ? fadeColorAt(r.fade, r.cycle, fadeNow) : ZERO_FADE
      fadeRef.current.style.background = `rgba(${c[1] | 0}, ${c[2] | 0}, ${c[3] | 0}, ${(c[0] / 255).toFixed(3)})`
    }
  }

  /** Jump the sim to an absolute cycle (rebuilds from 0 when scrubbing back). */
  const seek = (target: number) => {
    const r = rt.current
    // whatever was sounding belongs to the old position
    audioRef.current?.stopAll()
    const wasAudible = r.audible
    r.audible = false
    if (target < r.cycle) {
      r.cursor = 0
      r.cycle = 0
      r.camRt = null
      r.fade = null
      r.finished = false
      // back to the opening shot — with camRt cleared nothing else would move
      // the camera, so a scrub to 0 would otherwise hold the last frame's view
      applyInitialCamera()
      // rest poses too — a replayed entity otherwise shows its end-of-scene
      // pose (Zilyana standing) until its first animation lands
      for (const e of r.entities) {
        e.placed = false; e.route = null; e.anim = null; e.moveAnimId = -1; e.lastPosed = null
        if (e.em) applyPose(e.em, null)
        placeEntity(e)
      }
      for (const o of r.objects) {
        if (o) {
          o.group.visible = false; o.anim = null
          if (o.em) applyPose(o.em, null)
        }
      }
      for (const g of r.gfx) removeGfx(g)
      r.gfx = []
      // the region locs come back — a scrub to before the REPLACE_OBJECT that
      // took them out should show the scene as the client built it
      for (const group of r.replacedLocs.values()) group.visible = true
    }
    while (r.cycle < target) stepCycle()
    r.audible = wasAudible
    applyCameraAndFade()
    setCycle(r.cycle)
  }
  // the memoized action list calls seek through this, so its buttons don't have
  // to be rebuilt every render just to capture a fresh closure
  seekRef.current = seek

  // ------------------------------------------------------------ scene setup

  useEffect(() => {
    const r = rt.current
    // captured for the cleanup: the Maps themselves are stable for the life of
    // the component, but reading `.current` down there trips the ref lint rule
    const builtGfx = gfxAssets.current
    const pendingGfx = gfxPending.current
    r.disposed = false
    // The sim's own counters were already reset during render (see
    // switchedBuild); this is the rest — scene-scoped data, the React-side
    // transport, and whatever the last cutscene was still playing, since the
    // audio outlives this effect, being keyed only on the cache handle.
    r.heightsByCell.clear()
    r.terrainByCell.clear()
    r.replacedLocs.clear()
    audioRef.current?.stopAll()
    setCycle(0)
    setReady(false)
    setPlaying(false)
    setWarnings([])
    setStatus('Assembling scene…')
    let cancelled = false
    let disposeResize: (() => void) | null = null
    let stopLoop: (() => void) | null = null
    let disposeControls: (() => void) | null = null
    ;(async () => {
      try {
        const mapsDir = await resolveEntryHandle(rootHandle, getEntryPath('maps'))
        if (!mapsDir) { setStatus('The maps entry is missing — no terrain to build.'); return }
        const assembled = await assembleCutsceneScene(def, mapsDir, rootHandle)
        if (cancelled) return
        setWarnings(assembled.warnings)

        setStatus('Loading ground configs…')
        const configs = await loadSceneConfigs(rootHandle)
        const assets = new LocAssets(rootHandle)

        // 3×3 mosaic grid with our 2×2 synthetic scene in the +0/+1 cells.
        const grid: (import('../loaders/maps').MapTerrain | null)[][] = [[null, null, null], [null, null, null], [null, null, null]]
        for (const cell of assembled.cells) grid[cell.rx + 1][cell.ry + 1] = cell.terrain
        // The scene's sun comes from the environment record of the region the
        // cutscene copies its FIRST area from — the areas are nearly always one
        // place, and a wrong sun is baked into every vertex colour, so the
        // client's default is only a fallback for a cutscene with no areas.
        const particles = new SceneParticles()
        // blend + HDR come off the producer's material, exactly as loc faces do
        particles.setMaterialLookup(async (id) => {
          const meta = await assets.getMaterialMeta(id)
          return meta ? { hdrMultiplier: meta.hdrMultiplier, effectCombiner: meta.effectCombiner } : null
        })
        r.particles = particles
        for (const group of particles.groups) r.scene.add(group)
        // billboard sprites (a fire's glow + smoke column); the cutscene player
        // always runs with bloom on, so its `stationary` stand-ins stay hidden
        const billboards = new SceneBillboards()
        billboards.setBloomEnabled(true)
        // HDR comes off the sprite's material — Saradomin's eye sprites
        // (material 744, hdr ≈×2.45) glow through the bloom pass
        billboards.setMaterialLookup(async (id) => {
          const meta = await assets.getMaterialMeta(id)
          return meta ? { hdrMultiplier: meta.hdrMultiplier, effectCombiner: meta.effectCombiner } : null
        })
        r.billboards = billboards
        for (const group of billboards.groups) r.scene.add(group)

        const env = await cutsceneEnvironment(rootHandle, def)
        particles.setAmbient(sunOf(env).ambient)
        const mosaic = new SceneMosaic(grid, 0, 0, configs, sunOf(env))

        for (const cell of assembled.cells) {
          if (cancelled) return
          const { heights, lights } = mosaic.slicesFor(cell.rx, cell.ry)
          r.heightsByCell.set(`${cell.rx},${cell.ry}`, heights)
          r.terrainByCell.set(`${cell.rx},${cell.ry}`, cell.terrain)
          const palettes = [0, 1, 2, 3].map((p) => mosaic.paletteFor(cell.rx, cell.ry, p))
          const overlayCorners = [0, 1, 2, 3].map((p) => mosaic.overlayCornerFor(cell.rx, cell.ry, p))
          const underlayCorners = [0, 1, 2, 3].map((p) => mosaic.underlayCornerFor(cell.rx, cell.ry, p))
          const offsetX = cell.rx * REGION_UNITS
          const offsetZ = -cell.ry * REGION_UNITS

          // Locs first, all four planes: their static shadows darken the ground
          // the terrain pass then builds, exactly as the map scene orders it.
          // Point lights that came in with the copied chunks, baked into the
          // locs' vertex colours exactly as the map scene does it.
          const lightGrid = cell.lights.length > 0 ? buildLightGrid(cell.lights, heights) : undefined
          const locBuilds: (Awaited<ReturnType<typeof buildLocsMesh>> | null)[] = [null, null, null, null]
          for (let plane = 0; plane < 4; plane++) {
            if (cell.def.objects.length === 0) continue
            setStatus(`Building region ${cell.rx},${cell.ry} objects (plane ${plane})…`)
            locBuilds[plane] = await buildLocsMesh(cell.terrain, cell.def.objects, plane, heights, assets, undefined, lightGrid)
            if (cancelled) return
          }

          for (let plane = 0; plane < 4; plane++) {
            const built = locBuilds[plane]
            if (!built) continue
            // A loc's geometry comes back on THREE paths and this player used to
            // add only the first, so transparent scenery (windows, fences,
            // fountains) and animated locs (waving flags) were silently missing
            // from every cutscene — see the same note in MapSceneViewer.
            if (built.mesh) {
              built.mesh.position.set(offsetX, 0, offsetZ)
              built.mesh.renderOrder = ORDER_OPAQUE_LOC
              r.scene.add(built.mesh)
            }
            for (const lm of built.transparentLocs) {
              lm.position.x += offsetX
              lm.position.z += offsetZ
              lm.renderOrder = ORDER_TRANSPARENT_LOC
              r.scene.add(lm)
            }
            for (const al of built.animated) {
              const anim = await buildAnimatedLocMesh(al.model, al.matrix, assets, undefined, al.owner, al.points, al.ambient, al.contrast)
              if (cancelled) return
              if (!anim) continue
              // placement is baked into the mesh transform, so the region offset
              // has to multiply in rather than sit on .position
              const placedMatrix = new THREE.Matrix4().makeTranslation(offsetX, 0, offsetZ).multiply(al.matrix)
              anim.mesh.matrixAutoUpdate = false
              anim.mesh.matrix.copy(placedMatrix)
              anim.mesh.renderOrder = ORDER_OPAQUE_LOC
              r.scene.add(anim.mesh)
              // keep the pose hook — rendered at rest, a torch's flame model is
              // a tall authored stack of licks; the idle animation is what
              // collapses it into a flame. Billboards ride the same pose.
              // World-space bounds for the frustum test below. Off the rest
              // pose, so it's padded: an animated flame stretches well past the
              // geometry it was built from, and over-including only costs a
              // pose while under-including would freeze one in view.
              anim.mesh.geometry.computeBoundingSphere()
              const rest = anim.mesh.geometry.boundingSphere
              const sphere = rest
                ? rest.clone().applyMatrix4(placedMatrix)
                : new THREE.Sphere(new THREE.Vector3().setFromMatrixPosition(placedMatrix), CULL_RADIUS)
              sphere.radius = sphere.radius * 1.5 + 256
              r.animLocs.push({
                sphere,
                update: anim.update,
                model: al.model,
                animationId: al.animationId,
                billboards: billboards.addAnimated({
                  model: al.model, matrix: placedMatrix, upscale: modelUpscale(al.model), plane,
                }) ?? undefined,
              })
            }
          }

          // Particle emitters (fires, torches) and billboard sprites (glow,
          // smoke). The cutscene scene has no plane toggles, so every plane's
          // groups go straight in.
          for (const built of locBuilds) {
            if (!built) continue
            for (const emitter of built.emitters) {
              const placed = {
                ...emitter,
                matrix: new THREE.Matrix4().makeTranslation(offsetX, 0, offsetZ).multiply(emitter.matrix),
              }
              await particles.add(placed)
              billboards.add(placed)
            }
          }

          // Region locs a REPLACE_OBJECT takes over, each as its own group so
          // it can be removed on the cycle the action fires — the client builds
          // the scene with them present and only calls destroyObject when the
          // action runs, so they must be here and then go, not never exist.
          for (const loc of cell.replacedObjects) {
            const [, shape, , ox, oy, oplane] = loc
            const built = await buildLocsMesh(cell.terrain, [loc], oplane, heights, assets, undefined, lightGrid)
            if (cancelled) return
            if (!built) continue
            const group = new THREE.Group()
            if (built.mesh) {
              built.mesh.renderOrder = ORDER_OPAQUE_LOC
              group.add(built.mesh)
            }
            for (const lm of built.transparentLocs) {
              lm.renderOrder = ORDER_TRANSPARENT_LOC
              group.add(lm)
            }
            group.position.set(offsetX, 0, offsetZ)
            r.scene.add(group)
            r.replacedLocs.set(replacedLocKey(oplane, cell.rx * SIZE + ox, cell.ry * SIZE + oy, shape), group)
          }

          const shadows = locBuilds.map((b) => blurShadowGrid(b?.shadows))
          for (let plane = 0; plane < 4; plane++) {
            setStatus(`Building region ${cell.rx},${cell.ry} terrain (plane ${plane})…`)
            const terrainMesh = await buildTerrainMesh(cell.terrain, plane, heights, configs, assets, {
              lights, shadows, palettes, overlayCorners, underlayCorners,
            })
            if (cancelled) return
            if (terrainMesh) {
              terrainMesh.position.set(offsetX, 0, offsetZ)
              terrainMesh.renderOrder = ORDER_TERRAIN
              r.scene.add(terrainMesh)
              // the editor raycasts these to turn a click into a tile, and needs
              // to know which plane it landed on
              terrainMesh.userData.cutscenePlane = plane
              r.terrainMeshes.push(terrainMesh)
            }
          }
        }

        // Resolve each distinct loc idle sequence once, preload its frames,
        // and hand the animator to every placement that uses it (the render
        // loop poses) — same pattern as the map scene.
        if (r.animLocs.length > 0) {
          setStatus('Loading loc animations…')
          const animsDir = await resolveEntryHandle(rootHandle, getEntryPath('animations'))
          if (animsDir) {
            const ids = [...new Set(r.animLocs.map((a) => a.animationId))]
            const animators = new Map<number, LocAnimator>()
            await Promise.all(ids.map(async (id) => {
              try {
                const adef = JSON.parse(await (await (await animsDir.getFileHandle(`${id}.json`)).getFile()).text()) as AnimationDef
                const animator = new LocAnimator(adef)
                await animator.preload(rootHandle)
                animators.set(id, animator)
              } catch { /* animation not dumped — that loc stays at rest */ }
            }))
            if (cancelled) return
            for (const rec of r.animLocs) rec.animator = animators.get(rec.animationId)
          }
        }

        // The sun's COLOUR is a tint on the built materials rather than
        // something baked into vertex colours (its direction and ambient are),
        // and HDR materials carry an overbright factor that only counts once
        // applied — without this the bloom above has nothing over 1.0 to find.
        // Same treatment as the map scene's applyTint.
        {
          const tint = sunTintFor(env?.environment?.sunColour) ?? [1, 1, 1]
          r.scene.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.material) return
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              const colour = (m as THREE.MeshBasicMaterial).color
              if (!colour) continue // water is a ShaderMaterial — tinted through its uniforms
              const hdr = (m.userData.hdrMultiplier as number | undefined) ?? 1
              if (tint[0] === 1 && tint[1] === 1 && tint[2] === 1 && hdr === 1) continue
              colour.setRGB(tint[0] * hdr, tint[1] * hdr, tint[2] * hdr)
            }
          })
        }

        // Entities: NPC composites + BAS stand/walk anims; the player entity is
        // the editor's stored Player Look, standing in for the appearance the
        // real client streams from the server.
        setStatus('Loading cast…')
        const npcsDir = await resolveEntryHandle(rootHandle, getEntryPath('npcs'))
        const basDir = await resolveEntryHandle(rootHandle, getEntryPath('config_bas'))
        /** Stand/walk/run/half-walk sequences, plus the BAS half of the turn
         *  gate. Shared by NPCs (their def's basId) and the player (1426). */
        const applyBas = async (ert: EntityRt, basId: number) => {
          if (basId < 0 || !basDir) return
          try {
            const basFile = await (await basDir.getFileHandle(`${basId}.json`)).getFile()
            const bas = JSON.parse(await basFile.text()) as Record<string, unknown>
            ert.standAnimId = Number(bas.standAnimation ?? -1)
            ert.walkAnimId = Number(bas.walkAnimation ?? -1)
            ert.runAnimId = Number(bas.runningAnimation ?? -1)
            ert.halfWalkAnimId = Number(bas.teleportingAnimation ?? -1)
            ert.turnsWhileWalking ||= Number(bas.yawAcceleration ?? 0) !== 0
          } catch { /* BAS unavailable */ }
        }
        for (const entity of def.entities) {
          const ert: EntityRt = {
            em: null, group: new THREE.Group(), placed: false,
            fineX: 0, fineY: 0, plane: 0, yaw: 0, route: null, anim: null, size: 1,
            animPending: 0, animCommitted: 0,
            standAnimId: -1, walkAnimId: -1, runAnimId: -1, halfWalkAnimId: -1, moveAnimId: -1,
            turnsWhileWalking: true,
            bb: null, bbMatrix: null, lastPosed: null,
          }
          try {
            if (entity.id >= 0 && npcsDir) {
              const file = await (await npcsDir.getFileHandle(`${entity.id}.json`)).getFile()
              const npcDef = JSON.parse(await file.text()) as Record<string, unknown>
              // CutsceneEntity.move: `npc.sizeInSquares = definitions.size`
              ert.size = Math.max(1, Number(npcDef.size ?? 1) || 1)
              const composite = await loadModelComposite(rootHandle, npcCompositeSpec(npcDef))
              // baked with the client's model sun + the def's ambient/contrast,
              // like every loc — unlit NPCs read flat and over-bright
              const tm = await buildTexturedModelMesh(composite, {
                ambient: 64 + Number(npcDef.ambient ?? 0),
                contrast: 850 + Number(npcDef.contrast ?? 0) * 5,
              })
              if (tm) {
                ert.em = { tm, model: composite }
                ert.group.add(tm.mesh)
              }
              // NPC-model billboards (Saradomin's glowing eyes, model 58935
              // type 115 on faces 31/1376). Their placement matrix is read by
              // reference on every pose, so re-composing it as the entity
              // moves keeps the eyes in the head; each posed frame re-anchors
              // to the animated face centroids through onPosed.
              if (composite.billboards?.length) {
                ert.bbMatrix = new THREE.Matrix4()
                ert.bb = billboards.addAnimated({
                  model: composite, matrix: ert.bbMatrix, upscale: modelUpscale(composite), plane: 0,
                }) ?? null
                if (ert.bb) {
                  const bb = ert.bb
                  ert.onPosed = (posed) => {
                    ert.lastPosed = posed
                    bb.pose(posed)
                  }
                  bb.setVisible(false)
                }
              }
              const basId = Number(npcDef.basId ?? -1)
              // The client's gate for re-facing a moving entity is
              // `PathingEntity.turn`: BAS yawAcceleration != 0 OR the entity's
              // own turnDirection != 0, which for a cutscene entity is the NPC
              // def's turnDirection << 3 (CutsceneEntity.move). The def's
              // default is 32, so all but a handful of deliberately fixed
              // characters do turn. (This used to read the def's `contrast`,
              // which is the LIGHTING field and unrelated — it left most
              // entities gliding sideways and made the ones it did catch walk
              // backwards, since the walk facing was 180° out on top of it.)
              ert.turnsWhileWalking = (Number(npcDef.turnDirection ?? 32) << 3) !== 0
              await applyBas(ert, basId)
            } else {
              // The player. Its appearance streams from the server in the real
              // client (CutsceneEntity decodes an appearance block), so there is
              // nothing in the cache that says who this is — the editor's own
              // stored Player Look stands in: the identikit parts, colour
              // choices and equipped items you set under Player Look, assembled
              // by the same buildLookModel the modal previews with.
              const looks = loadPlayerLooks()
              const female = loadPlayerGender()
              const look = female ? looks.female : looks.male
              const built = await buildLookModel(rootHandle, look, null, female)
              const tm = built.model ? await buildTexturedModelMesh(built.model, PLAYER_LIGHTING) : null
              if (tm && built.model) {
                ert.em = { tm, model: built.model }
                ert.group.add(tm.mesh)
              } else {
                // no usable look (parts missing from the dump) — keep the old
                // marker so the entity's placement and routes stay visible
                const marker = new THREE.Mesh(
                  new THREE.ConeGeometry(140, 460, 12),
                  new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.75 }),
                )
                marker.position.y = 230
                ert.group.add(marker)
              }
              // The render emote: the equipped weapon's BAS (item client-script
              // param 644), or 1426 unarmed — so wielding a sword in Player
              // Look gives the cutscene player the sword stance, exactly as the
              // server derives it (Appearance.getRenderEmote).
              await applyBas(ert, (await resolveRenderEmote(rootHandle, look.equipment)).bas)
            }
          } catch { /* NPC unloadable — the entity acts but stays invisible */ }
          ert.group.visible = false
          r.scene.add(ert.group)
          r.entities.push(ert)
        }

        // Cutscene objects: hidden until REPLACE_OBJECT spawns them.
        setStatus('Loading objects…')
        const objectsDir = await resolveEntryHandle(rootHandle, getEntryPath('objects'))
        for (const obj of def.objects) {
          let record: ObjectRt | null = null
          try {
            if (objectsDir) {
              const file = await (await objectsDir.getFileHandle(`${obj.locId}.json`)).getFile()
              const objDef = JSON.parse(await file.text()) as Record<string, unknown>
              const composite = await loadModelComposite(rootHandle, objectCompositeSpec(objDef))
              const tm = await buildTexturedModelMesh(composite, {
                ambient: 64 + Number(objDef.ambient ?? 0),
                contrast: 850 + Number(objDef.contrast ?? 0) * 5,
              })
              if (tm) {
                const group = new THREE.Group()
                group.add(tm.mesh)
                record = {
                  group,
                  em: { tm, model: composite },
                  anim: null,
                  animPending: 0,
                  animCommitted: 0,
                  idleAnimId: Number((objDef.animations as number[] | undefined)?.[0] ?? -1),
                  sizeX: Number(objDef.sizeX ?? 1) || 1,
                  sizeY: Number(objDef.sizeY ?? 1) || 1,
                }
                group.visible = false
                r.scene.add(group)
              }
            }
          } catch { /* object unloadable */ }
          r.objects.push(record)
        }

        // Prewarm every sequence the cutscene can reach — the client refuses
        // to start until all of them are ready(), and the synchronous pose
        // path needs them resolved for a same-tick place+animate to land
        // together (Zilyana flashed standing before her lie-down otherwise).
        setStatus('Loading animations…')
        {
          const animIds: number[] = []
          for (const e of r.entities) animIds.push(e.standAnimId, e.walkAnimId, e.runAnimId, e.halfWalkAnimId)
          for (const o of r.objects) if (o) animIds.push(o.idleAnimId)
          const gfxIds: number[] = []
          for (const a of def.actions) {
            const f = (a.fields ?? {}) as Record<string, number>
            if (a.type === 'ANIMATE_MOVEMENT') {
              animIds.push(f.movementAnimationId)
              if (f.seqFlag) gfxIds.push(f.seqFlag)
            } else if (a.type === 'ANIMATE_OBJECT') {
              animIds.push(f.sequenceId)
            } else if (a.type === 'ENTITY_GFX') {
              gfxIds.push(f.gfxId)
            }
          }
          // Every gfx the cutscene can spawn: model AND mesh built now, not at
          // the cycle it fires (the client's isModelLoaded half of a spot-anim
          // action's ready check). Their defs carry the sequence ids the
          // prewarm below then resolves.
          if (gfxIds.length > 0) {
            setStatus('Loading effects…')
            const assets = await Promise.all([...new Set(gfxIds)].filter((id) => id > 0).map(loadGfxAsset))
            if (cancelled) return
            for (const asset of assets) if (asset) animIds.push(Number(asset.def.sequenceId ?? -1))
          }
          await prewarmAnims(animIds)
          if (cancelled) return
        }

        if (cancelled) return
        // Start-of-scene camera: the cutscene's own opening shot, falling back
        // to an overhead of the used area for one with no camera path at all.
        if (!applyInitialCamera()) {
          r.camera.position.set(REGION_UNITS * 0.75, 4500, -REGION_UNITS * 0.55)
          r.camera.lookAt(REGION_UNITS * 0.75, 0, -REGION_UNITS * 0.75)
        }
        // Distance fog, the client's own formula: it ends at the draw distance
        // and fades over the last (fogDepth + 256) * 4 units, with the backdrop
        // set to the same colour so the world fades into it rather than into
        // black. Defaults are the client's (Class239.anInt2932 = 0xC8C0A8).
        {
          const fogColour = env?.environment?.fogColour ?? 0xc8c0a8
          const end = FOG_TILES * 512
          const start = Math.max(1, end - ((env?.environment?.fogDepth ?? 0) + 256) * 4)
          r.scene.fog = new THREE.Fog(fogColour, start, end)
          r.scene.background = new THREE.Color(fogColour)
          // fixed-function fog covers particles/billboards in the client too
          particles.setFog(fogColour, start, end)
          billboards.setFog(fogColour, start, end)
        }

        // The region's sky dome, if it has one. Same treatment as the map
        // scene: mirrored up (the model hangs below the origin in RS y-down
        // authoring), blown up to read as distant, never pickable, and
        // re-centred on the camera every frame so it can't be flown out of.
        if (env?.skybox) {
          const sky = await buildSkyboxMesh(rootHandle, assets, env.skybox.id, env.skybox.rotation)
          if (cancelled) return
          if (sky) {
            sky.scale.set(24, -24, 24)
            sky.traverse((o) => { o.raycast = () => {} })
            r.scene.add(sky)
            r.sky = sky
          }
        }

        const canvas = canvasRef.current!
        r.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
        // three resets renderer.info at the top of every render(), and the
        // composer runs several per frame — so reading the counters afterwards
        // reports only its final fullscreen pass. Take over the reset (see the
        // same note in MapSceneViewer).
        r.renderer.info.autoReset = false

        // Free-camera controls, live only while the editor has turned them on.
        // Orbit around the point the camera looks at, dolly with the wheel,
        // right-drag to pan — enough to frame a shot and capture it as a
        // keyframe. Deliberately not OrbitControls: the camera here is defined
        // by a position and a look-at pair that get written into a cutscene's
        // camera path, so the control has to keep those two as the truth.
        {
          let dragging: 0 | 1 | 2 = 0
          let lastX = 0
          let lastY = 0
          const target = new THREE.Vector3()
          const offset = new THREE.Vector3()
          const spherical = new THREE.Spherical()
          const focus = () => {
            r.camera.getWorldDirection(pickDir)
            // orbit about a point a few tiles ahead, which is what a cutscene
            // camera is almost always framing
            target.copy(r.camera.position).addScaledVector(pickDir, ORBIT_DISTANCE)
          }
          const onDown = (e: PointerEvent) => {
            if (!r.freeCamera) return
            dragging = e.button === 2 ? 2 : 1
            lastX = e.clientX
            lastY = e.clientY
            focus()
            canvas.setPointerCapture(e.pointerId)
            e.preventDefault()
          }
          const onMove = (e: PointerEvent) => {
            if (!r.freeCamera || dragging === 0) return
            const dx = e.clientX - lastX
            const dy = e.clientY - lastY
            lastX = e.clientX
            lastY = e.clientY
            if (dragging === 1) {
              offset.copy(r.camera.position).sub(target)
              spherical.setFromVector3(offset)
              spherical.theta -= dx * 0.005
              spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * 0.005))
              offset.setFromSpherical(spherical)
              r.camera.position.copy(target).add(offset)
            } else {
              // pan both the camera and what it orbits, so framing survives
              const panScale = ORBIT_DISTANCE / 900
              r.camera.getWorldDirection(pickDir)
              const right = new THREE.Vector3().crossVectors(pickDir, r.camera.up).normalize()
              const up = new THREE.Vector3().crossVectors(right, pickDir).normalize()
              const shift = right.multiplyScalar(-dx * panScale).add(up.multiplyScalar(dy * panScale))
              r.camera.position.add(shift)
              target.add(shift)
            }
            r.camera.lookAt(target)
          }
          const onUp = (e: PointerEvent) => {
            if (dragging === 0) return
            dragging = 0
            try { canvas.releasePointerCapture(e.pointerId) } catch { /* already released */ }
          }
          const onWheel = (e: WheelEvent) => {
            if (!r.freeCamera) return
            e.preventDefault()
            r.camera.getWorldDirection(pickDir)
            r.camera.position.addScaledVector(pickDir, e.deltaY < 0 ? 256 : -256)
          }
          const onContext = (e: MouseEvent) => { if (r.freeCamera) e.preventDefault() }
          canvas.addEventListener('pointerdown', onDown)
          canvas.addEventListener('pointermove', onMove)
          canvas.addEventListener('pointerup', onUp)
          canvas.addEventListener('pointercancel', onUp)
          canvas.addEventListener('wheel', onWheel, { passive: false })
          canvas.addEventListener('contextmenu', onContext)
          disposeControls = () => {
            canvas.removeEventListener('pointerdown', onDown)
            canvas.removeEventListener('pointermove', onMove)
            canvas.removeEventListener('pointerup', onUp)
            canvas.removeEventListener('pointercancel', onUp)
            canvas.removeEventListener('wheel', onWheel)
            canvas.removeEventListener('contextmenu', onContext)
          }
        }
        // setPixelRatio + setSize together own the drawing buffer AND the GL
        // viewport — sizing the canvas by hand leaves the viewport stale and
        // the render squeezed into a corner on any DPR > 1 display
        const fitCanvas = () => {
          r.renderer!.setPixelRatio(window.devicePixelRatio || 1)
          r.renderer!.setSize(canvas.clientWidth, canvas.clientHeight, false)
          r.composer?.setSize(canvas.clientWidth, canvas.clientHeight)
          r.particles?.setViewport(canvas.clientHeight, r.camera.fov)
          r.camera.aspect = canvas.clientWidth / canvas.clientHeight
          r.camera.updateProjectionMatrix()
        }
        // HDR + bloom, as in the map scene: a half-float target keeps the
        // overbright values the client's HDR materials push past 1.0, and the
        // bloom pass turns them into its glow. Per-region parameters when the
        // environment overrides them, else the client's own class defaults.
        {
          const w = canvas.clientWidth || 1
          const h = canvas.clientHeight || 1
          const composer = new EffectComposer(r.renderer, new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType,
            colorSpace: THREE.LinearSRGBColorSpace,
          }))
          composer.addPass(new RenderPass(r.scene, r.camera))
          const bloom = new ClientBloomPass(w, h)
          bloom.threshold = env?.hdr?.bloomThreshold ?? 1.0
          bloom.strength = env?.hdr?.bloomStrength ?? 0.25
          bloom.whitePoint = env?.hdr?.whitePoint ?? 1.0
          composer.addPass(bloom)
          composer.addPass(new OutputPass())
          r.composer = composer
        }

        fitCanvas()
        const resizeObserver = new ResizeObserver(fitCanvas)
        resizeObserver.observe(canvas)
        disposeResize = () => resizeObserver.disconnect()

        setStatus('')
        setReady(true)

        let last = performance.now()
        let rafId = 0
        const loop = (now: number) => {
          // `cancelled` is THIS build's own token. `r.disposed` is shared
          // runtime state that the next build clears on its way in, so a loop
          // guarded only by that would see its stop signal undone and carry on
          // driving the new scene alongside the new loop: two sims stepping one
          // runtime (double speed), the old cutscene's actions applied to the
          // new cast, and its camera fighting the new one.
          if (cancelled || r.disposed) return
          rafId = requestAnimationFrame(loop)
          const dt = Math.min(now - last, 250)
          last = now
          const tSimStart = performance.now()
          if (playingRef.current && !r.finished && r.cycle < durationCycles) {
            r.msAcc += dt
            let stepped = false
            while (r.msAcc >= CYCLE_MS) {
              r.msAcc -= CYCLE_MS
              stepCycle()
              stepped = true
            }
            // React state at ~10Hz, NOT once per frame. Every update re-renders
            // this panel's action list AND, through onCycle, the page's roll —
            // 341 actions in cutscene 11, so ~680 elements reconciled per
            // update. At 60Hz that work dwarfed the render: sim, pose and draw
            // together measured 8.5ms of a 62ms frame, and the missing 54ms was
            // React. Nothing driven by `cycle` needs more than 10Hz — the clock
            // reads to a tenth of a second and the playhead moves a pixel.
            if (stepped && now - lastCycleReport >= 100) {
              lastCycleReport = now
              setCycle(r.cycle)
            }
            // the sim stops at FINISHED; drop out of "playing" so the transport
            // shows Replay instead of a pause button over a frozen picture
            if (r.finished || r.cycle >= durationCycles) {
              setCycle(r.cycle) // land exactly on the end rather than up to 100ms short
              setPlaying(false)
            }
          }
          const tSimEnd = performance.now()
          applyCameraAndFade()
          // Straight from the sim clock every frame, not from React state at
          // 10Hz: the receiver writes a style directly (see ActionRoll's
          // handle), so a smooth playhead costs nothing. Unconditional, which
          // also covers scrubbing while paused.
          onCycleRef.current?.(r.cycle)
          // One frustum per frame, shared by the animated-loc and entity pose
          // passes below. Built from a FRESHLY updated camera matrix: three
          // only refreshes matrixWorld inside render(), so reading it here
          // without this would cull against where the camera was last frame.
          r.camera.updateMatrixWorld()
          frustumMatrix.multiplyMatrices(
            r.camera.projectionMatrix,
            r.camera.matrixWorldInverse.copy(r.camera.matrixWorld).invert(),
          )
          frustum.setFromProjectionMatrix(frustumMatrix)
          // Plane visibility for loc attachments follows the camera's FOCUS:
          // the client buckets particles per plane band and draws them under
          // the viewpoint's plane visibility. Without this, upper-plane
          // emitter anchors rain their flames down the whole scene — the
          // chapel's torch anchors are ONE plane-3 loc whose 8 carrier faces
          // stack a spawn point per storey, and drawing all of them put a
          // column of flames over each door torch (map viewer avoids it the
          // same way: upper planes default hidden).
          {
            const band = Math.max(0, Math.min(3, Math.floor(r.focusY / 960)))
            for (let p = 0; p < 4; p++) {
              const vis = p <= band
              if (r.particles) r.particles.groups[p].visible = vis
              if (r.billboards) r.billboards.groups[p].visible = vis
            }
          }
          // Loc idle animations (torch flames, flags): pose every frame, on
          // the client's free-running 20ms tick clock like the map scene,
          // with keyframe interpolation for tweened sequences.
          if (r.animLocs.length > 0) {
            const seconds = (performance.now() % 3600000) / 1000
            // Same frustum the entity poses use, and the same reasoning: a town
            // scene has torches and flags all over it and only a few are ever
            // in shot. (The map viewer culls its animated locs identically.)
            for (const rec of r.animLocs) {
              if (!rec.animator) continue
              if (!frustum.intersectsSphere(rec.sphere)) continue
              const posed = rec.animator.poseAt(rec.model, seconds)
              if (posed) {
                rec.update(posed)
                rec.billboards?.pose(posed)
              }
            }
          }
          // Tweened entity/object/gfx sequences re-pose every render frame so
          // the sub-tick interpolation actually shows (frame-change posing
          // alone would step at the keyframe rate).
          // Posing is the expensive part of a crowded scene, and nothing can see
          // the result for something the camera isn't pointed at. Each frame
          // marks what's on screen and poses only that — tweened things while
          // playing (their pose changes every frame), plus anything whose frame
          // advanced while it was off-screen, so it comes back current rather
          // than holding a stale pose. The sim is untouched: animations still
          // advance off-screen, so an entity walking into shot arrives right.
          //
          // Runs even when paused, because a seek steps the sim and a scrub can
          // bring a marked-dirty entity into view with the clock stopped.
          //
          // The test is a fixed radius around the placement rather than the
          // mesh's real bounds: over-including costs one pose, under-including
          // would pop.
          const tPoseStart = performance.now()
          {
            const onScreen = (obj: THREE.Object3D, radius: number) => {
              cullSphere.center.copy(obj.position)
              cullSphere.radius = radius
              return frustum.intersectsSphere(cullSphere)
            }
            const playing = playingRef.current
            const poseIfDue = (h: AnimHolder, visible: boolean, tweened: boolean) => {
              h.offScreen = !visible
              if (!visible) return
              if (!h.poseDirty && !(playing && tweened)) return
              h.poseDirty = false
              void poseEntityFrame(h)
            }
            for (const e of r.entities) {
              if (!e.placed) { e.offScreen = true; continue }
              poseIfDue(e, onScreen(e.group, CULL_RADIUS * Math.max(1, e.size)), e.anim?.def.tweened === true)
            }
            for (const o of r.objects) {
              if (!o) continue
              if (!o.group.visible) { o.offScreen = true; continue }
              poseIfDue(o, onScreen(o.group, CULL_RADIUS * Math.max(o.sizeX, o.sizeY)), o.anim?.def.tweened === true)
            }
            // gfx are short-lived and ride whatever the shot is about, so they
            // skip the test and always pose
            for (const g of r.gfx) if (playing && g.anim?.def.tweened) void poseEntityFrame(g)
          }
          const tPoseEnd = performance.now()
          r.particles?.step(dt, r.camera)
          if (r.sky) r.sky.position.copy(r.camera.position)
          const tDrawStart = performance.now()
          r.renderer!.info.reset()
          if (r.composer) r.composer.render()
          else r.renderer!.render(r.scene, r.camera)
          const tDrawEnd = performance.now()
          simMs += tSimEnd - tSimStart
          poseMs += tPoseEnd - tPoseStart
          drawMs += tDrawEnd - tDrawStart
          // Averaged over 20 frames rather than instantaneous, which jitters
          // too much to read. Written straight to the DOM node — a state update
          // per frame would re-render the whole panel, action list included.
          if (perfLast) { perfSum += 1000 / (now - perfLast); perfN++ }
          perfLast = now
          if (perfN >= 20 && perfRef.current) {
            const info = r.renderer!.info.render
            const ms = (total: number) => (total / perfN).toFixed(1)
            perfRef.current.textContent =
              `${Math.round(perfSum / perfN)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`
              + ` · sim ${ms(simMs)} pose ${ms(poseMs)} draw ${ms(drawMs)} ms`
            perfSum = 0
            perfN = 0
            simMs = 0
            poseMs = 0
            drawMs = 0
          }
        }
        let perfLast = 0, perfSum = 0, perfN = 0
        /** last `now` at which the sim clock was pushed into React state */
        let lastCycleReport = 0
        // Where a frame's time actually goes, averaged over the same window:
        // `sim` is the cycle stepper, `pose` the per-frame skeletal re-pose of
        // every tweened entity, `draw` the composer. Only `sim` and `pose` run
        // while playing, so a large gap between paused and playing frame rates
        // has to be one of them.
        let simMs = 0, poseMs = 0, drawMs = 0
        rafId = requestAnimationFrame(loop)
        stopLoop = () => cancelAnimationFrame(rafId)
      } catch (e) {
        if (!cancelled) setStatus(`Scene build failed: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return () => {
      cancelled = true
      // drops the frame already queued, so teardown can't be raced by one last
      // render against a disposed renderer
      stopLoop?.()
      disposeResize?.()
      disposeControls?.()
      const rr = rt.current
      rr.disposed = true
      // Prebuilt gfx meshes are held OUTSIDE the scene graph while unused, so
      // the traverse below can't reach them — and the next cutscene needs its
      // own anyway.
      for (const asset of builtGfx.values()) asset.spare?.dispose()
      builtGfx.clear()
      pendingGfx.clear()
      rr.particles?.dispose()
      rr.billboards?.dispose()
      rr.billboards = null
      rr.animLocs = []
      rr.gfx = []
      rr.objects = []
      rr.entities = []
      rr.terrainMeshes = []
      // disposed with the rest of the scene by the traverse below
      rr.tileHighlight = null
      rr.composer?.dispose()
      rr.renderer?.dispose()
      // dispose() frees three's GPU objects but NOT the WebGL context — the
      // browser only reclaims that whenever the canvas is collected, so every
      // open/close of this modal would otherwise leave a live context behind.
      rr.renderer?.forceContextLoss()
      rr.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            ;(m as THREE.MeshBasicMaterial).map?.dispose()
            m.dispose()
          }
        }
      })
      // The scene object itself is reused across builds, and disposing a mesh
      // does NOT take it out of the graph — three would happily re-upload the
      // last cutscene's terrain into the next one's. Empty it.
      rr.scene.clear()
      rr.sky = null
    }
    // Keyed on the SCENE, not the def — see sceneKey. Exactly the deps buildGen
    // keys the canvas on, which it must, since teardown force-loses the context
    // and a canvas lost that way is dead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, rootHandle, varGen])

  return (
    <div className="cutscene-player">
      <div className="anim-preview-body">
        <div className="cutscene-player-main">
          <div className="cutscene-player-stage">
            <canvas key={buildGen.current.n} ref={canvasRef} className="cutscene-player-canvas" />
            <div ref={fadeRef} className="cutscene-player-fade" />
            <span
              ref={perfRef}
              className="cutscene-player-perf"
              title="Render frames per second, draw calls and triangles per frame"
            >–</span>
            {status && <p className="anim-preview-status cutscene-player-status">{status}</p>}
          </div>
          <div className="cutscene-player-actions">
            <ul ref={actionListRef}>{actionItems}</ul>
          </div>
        </div>
        {/* Right under the picture, which is what it describes — at the bottom
            of the panel it read as a footnote to the transport. */}
        <p className="cutscene-note cutscene-player-scope">
          Simulated: terrain/locs from the areas recipe, camera splines, entity placement + walk routes + animations, object spawns, screen fades, entity gfx, sound.
          Not simulated: projectiles, hitmarks, hint arrows and tile messages — none of which any cutscene in this cache uses{warnings.length > 0 ? ` — ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${[...new Set(warnings)].slice(0, 3).join('; ')}` : ''}.
        </p>
        <div className="cutscene-player-bar">
          <button
            type="button"
            className="zoom-btn anim-preview-play"
            disabled={!ready}
            title="Jump back one action"
            onClick={() => stepToAction(-1)}
          >
            ⏮
          </button>
          <button
            type="button"
            className="zoom-btn anim-preview-play"
            disabled={!ready}
            title={`Back ${stepSize} cycle${stepSize === 1 ? '' : 's'} (${(stepSize * CYCLE_MS / 1000).toFixed(2)}s)`}
            onClick={() => stepCycles(-1)}
          >
            ⏪
          </button>
          <button
            type="button"
            className="zoom-btn anim-preview-play"
            disabled={!ready}
            title={atEnd ? 'Replay from the start' : playing ? 'Pause' : 'Play'}
            onClick={() => {
              if (atEnd) seek(0)
              setPlaying((p) => (atEnd ? true : !p))
            }}
          >
            {atEnd ? '↺' : playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="zoom-btn anim-preview-play"
            disabled={!ready}
            title={`Forward ${stepSize} cycle${stepSize === 1 ? '' : 's'} (${(stepSize * CYCLE_MS / 1000).toFixed(2)}s)`}
            onClick={() => stepCycles(1)}
          >
            ⏩
          </button>
          <button
            type="button"
            className="zoom-btn anim-preview-play"
            disabled={!ready}
            title="Jump to the next action"
            onClick={() => stepToAction(1)}
          >
            ⏭
          </button>
          <input
            type="range"
            className="cutscene-player-scrub rs-slider"
            min={0}
            max={durationCycles}
            value={Math.min(cycle, durationCycles)}
            disabled={!ready}
            onChange={(e) => seek(parseInt(e.target.value, 10))}
          />
          <span className="cutscene-player-time">
            {clockValue(cycle, unit)} / {clockValue(durationCycles, unit)}{clockSuffix(unit)}
            <span className="cutscene-player-actioncount">{rt.current.cursor}/{def.actions.length}</span>
          </span>
          <label className="cutscene-player-volume" title={`Volume ${Math.round(volume * 100)}%`}>
            <span aria-hidden>{volume === 0 ? '🔇' : '🔊'}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              style={{ ['--fill' as string]: `${Math.round(volume * 100)}%` } as React.CSSProperties}
              aria-label="Volume"
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
            />
          </label>
        </div>
        <div className="cutscene-player-stepbar">
          <label className="cutscene-player-step">
            <span>Step</span>
            <NumberInput value={stepSize} min={1} max={durationCycles} onChange={setStepSize} />
            <span>cycles</span>
          </label>
          <p className="cutscene-note cutscene-player-stephint">
            How far ⏪ and ⏩ move the clock. A client cycle is 20ms — 50 to the second — so 1 steps a
            single frame, which is how you catch something that happens too fast to watch.
          </p>
        </div>
      </div>
    </div>
  )
}
