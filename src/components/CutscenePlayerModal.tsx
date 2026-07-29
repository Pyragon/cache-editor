import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { CutsceneDef } from '../loaders/cutscenes'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { SIZE } from '../loaders/maps'
import type { ModelData } from '../loaders/models'
import { applyPoseToMesh, buildTexturedModelMesh } from './modelMesh'
import type { TexturedModelMesh } from './modelMesh'
import { loadModelComposite, npcCompositeSpec, objectCompositeSpec } from '../loaders/npcComposite'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import {
  DEFAULT_SUN, LocAssets, SceneMosaic, averageHeight, blurShadowGrid, buildAnimatedLocMesh, buildLightGrid,
  buildLocsMesh, buildSkyboxMesh, buildTerrainMesh, loadRegionEnvironment, loadSceneConfigs, sunTintFor,
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
import { assembleCutsceneScene } from './cutsceneScene'
import './AnimationViewer.css'
import './CutsceneViewer.css'

const REGION_UNITS = SIZE * 512
const ONE_V3 = new THREE.Vector3(1, 1, 1)

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
const CYCLE_MS = 20

type Props = {
  def: CutsceneDef
  rootHandle: FileSystemDirectoryHandle
  onClose: () => void
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
}

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
  standAnimId: number
  walkAnimId: number
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
function splinePoint(rows: number[][], kf: number, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
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

const PACE_UNITS: Record<number, number> = { 0: 256 / 30, 2: 1024 / 30 } // half walk / run; walk below
const paceUnits = (t: number) => PACE_UNITS[t] ?? 512 / 30

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

export default function CutscenePlayerModal({ def, rootHandle, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Assembling scene…')
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [cycle, setCycle] = useState(0)
  const [warnings, setWarnings] = useState<string[]>([])

  const playingRef = useRef(playing)
  playingRef.current = playing

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
      animator?: LocAnimator
      billboards?: import('./sceneBillboards').AnimatedBillboards
    }[]
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    heightsByCell: Map<string, Int32Array[]>
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
    disposed: boolean
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
      disposed: false,
      composer: null,
      sky: null,
      particles: null,
      billboards: null,
      animLocs: [],
    }
  }

  // Where the timeline ends. A cutscene finishes at its FINISHED action — the
  // sim stops dead there — so the bar has to end at the same cycle, or it reads
  // as a second of playback that never happens (cutscene 0: 44.8s shown against
  // a 43.8s finish, frozen at the end). Only a cutscene without a FINISHED gets
  // the old tail, to leave its last action time to play out.
  // +1 because an action fires when the clock REACHES its cycle: stopping the
  // sim at the FINISHED cycle itself would leave that action (and anything else
  // sharing the cycle) unapplied, which is what made the end read 134/135.
  const finishCycle = def.actions.find((a) => a.type === 'FINISHED')?.lengthInCycles
  const durationCycles = finishCycle != null
    ? finishCycle + 1
    : def.actions.reduce((m, a) => Math.max(m, a.lengthInCycles), 0) + 50
  // Distinct action start cycles, for the step-by-action buttons. An action at
  // start s is applied once the sim clock passes it (cycle > s), so "jump to
  // this action" means seek(s + 1).
  const actionStarts = [...new Set(def.actions.map((a) => a.lengthInCycles))].sort((a, b) => a - b)

  // Played to the end: the FINISHED action fired, or the clock ran out. Keyed
  // off `cycle` (state) rather than the runtime so the button re-renders.
  const atEnd = ready && (cycle >= durationCycles || rt.current.finished)

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

  useEffect(() => { dialogRef.current?.showModal() }, [])

  // Sidebar action list: the most recently applied start's actions are
  // "current"; keep them scrolled into view as playback advances.
  const actionListRef = useRef<HTMLUListElement>(null)
  const lastAppliedStart = rt.current.cursor > 0 ? def.actions[rt.current.cursor - 1].lengthInCycles : -1
  useEffect(() => {
    const list = actionListRef.current
    if (!list) return
    const current = list.querySelector('.cutscene-player-action-current')
    current?.scrollIntoView({ block: 'nearest' })
  }, [cycle])

  // ------------------------------------------------------------------ helpers

  const groundY = (fineX: number, fineY: number, plane: number): number => {
    const r = rt.current
    const rx = Math.min(Math.max(fineX >> 9 >> 6, 0), 1)
    const ry = Math.min(Math.max(fineY >> 9 >> 6, 0), 1)
    const heights = r.heightsByCell.get(`${rx},${ry}`)
    if (!heights) return 0
    const h = averageHeight(heights[plane], fineX - rx * REGION_UNITS, fineY - ry * REGION_UNITS)
    return -h
  }

  const placeEntity = (e: EntityRt) => {
    e.group.position.set(e.fineX, groundY(e.fineX, e.fineY, e.plane), -e.fineY)
    e.group.rotation.y = e.yaw
    e.group.visible = e.placed
    // model billboards (Saradomin's eyes) live outside the group — move and
    // show/hide them with it, re-anchoring at the held pose if any
    if (e.bb && e.bbMatrix) {
      e.bbMatrix.compose(e.group.position, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.yaw, 0)), ONE_V3)
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
    const posed = applyAnimationFrame(poseModel, frameBase, frame, next, elapsed, duration)
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

  /** Spawns a spot animation (gfx) on an entity — ENTITY_GFX, and the gfx an
   *  ANIMATE_MOVEMENT can carry in its third field (the client plays them via
   *  the same spot-anim slots). Plays its sequence once, then removes itself. */
  const startEntityGfx = async (e: EntityRt, gfxId: number, displayHeight: number, rotation: number) => {
    try {
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('spot_animations'))
      if (!dir) return
      const gfxDef = JSON.parse(await (await dir.getFileHandle(`${gfxId}.json`)).getFile().then((f) => f.text())) as Record<string, unknown>
      const modelId = Number(gfxDef.modelId ?? -1)
      if (modelId < 0) return
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
      const tm = await buildTexturedModelMesh(composite, {
        ambient: 64 + Number(gfxDef.ambient ?? 0),
        contrast: 850 + Number(gfxDef.contrast ?? 0) * 5,
      })
      if (rt.current.disposed) { tm?.dispose(); return }
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
    g.em?.tm.dispose()
    for (const a of g.attachments) a.remove()
    g.attachments = []
  }

  // ---------------------------------------------------------------- actions

  const applyAction = (index: number) => {
    const r = rt.current
    const a = def.actions[index]
    const f = (a.fields ?? {}) as Record<string, number>
    switch (a.type) {
      case 'DIRECT_CAMERA_MOVEMENT': {
        const rows = (movementIndex: number): number[][] => {
          const cam = def.camMovements[movementIndex]
          if (!cam) return []
          const out: number[][] = []
          for (let i = 0; i < cam.xPositions.length; i++) {
            out.push([cam.xPositions[i], cam.yPositions[i], cam.zPositions[i], cam.timestamps[i]])
            out.push([cam.targetXPositions[i], cam.targetYPositions[i], cam.targetZPositions[i], cam.timestamps[i]])
          }
          return out
        }
        r.camRt = {
          posRows: rows(f.positionMovementIndex),
          lookRows: rows(f.lookAtMovementIndex),
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
        e.fineX = f.x * 512 + 256
        e.fineY = f.y * 512 + 256
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
        e.fineX = tiles[0][0] * 512 + 256
        e.fineY = tiles[0][1] * 512 + 256
        e.route = { tiles, paces: m.movementTypes, next: 1 }
        if (e.walkAnimId >= 0) void startAnim(e, e.walkAnimId, false)
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
        if (e) { e.placed = false; e.route = null; e.anim = null; placeEntity(e) }
        break
      }
      case 'REPLACE_OBJECT': {
        const o = r.objects[f.locIndex]
        if (o) {
          o.group.visible = true
          const fineX = f.x * 512 + 256
          const fineY = f.y * 512 + 256
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
      default:
        break // sounds, gfx, projectiles, hints, messages, vars: not simulated
    }
  }

  const fadeColorAt = (fade: NonNullable<FadeRt>, at: number): number[] => {
    const t = fade.endCycle <= fade.startCycle ? 1 : Math.min(Math.max((at - fade.startCycle) / (fade.endCycle - fade.startCycle), 0), 1)
    return fade.from.map((v, i) => v + (fade.to[i] - v) * t)
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
    // entity walking
    for (const e of r.entities) {
      if (!e.placed || !e.route) continue
      let budget = paceUnits(e.route.paces[Math.min(e.route.next, e.route.paces.length - 1)] ?? 1)
      while (budget > 0 && e.route.next < e.route.tiles.length) {
        const [tx, ty] = e.route.tiles[e.route.next]
        const gx = tx * 512 + 256
        const gy = ty * 512 + 256
        const dx = gx - e.fineX
        const dy = gy - e.fineY
        const dist = Math.hypot(dx, dy)
        // gated exactly like the client (see turnsWhileWalking): an entity
        // whose BAS can't turn keeps its scripted facing while it moves
        if (dist > 1 && e.turnsWhileWalking) e.yaw = Math.atan2(dx, -dy) + Math.PI
        if (dist <= budget) {
          e.fineX = gx; e.fineY = gy
          budget -= dist
          e.route.next++
        } else {
          e.fineX += (dx / dist) * budget
          e.fineY += (dy / dist) * budget
          budget = 0
        }
      }
      if (e.route.next >= e.route.tiles.length) {
        e.route = null
        if (animSettled(e) && e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
      }
      placeEntity(e)
    }
    // animation frames for entities, spawned objects and in-flight gfx
    // (durations are client cycles). Returns true when a one-shot finished.
    const stepAnim = (holder: { anim: AnimState | null; em: EntityMesh | null }): boolean => {
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
        void poseEntityFrame(holder)
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

  const applyCameraAndFade = () => {
    const r = rt.current
    if (r.camRt) {
      const t = r.camRt.progress / 65535
      const from = splinePoint(r.camRt.posRows, r.camRt.posKf, t)
      const to = splinePoint(r.camRt.lookRows, r.camRt.lookKf, t)
      r.camera.position.set(from[0], from[1], -from[2])
      r.camera.lookAt(to[0], to[1], -to[2])
      r.focusY = to[1]
    }
    if (fadeRef.current) {
      const c = r.fade ? fadeColorAt(r.fade, r.cycle) : [0, 0, 0, 0]
      fadeRef.current.style.background = `rgba(${c[1] | 0}, ${c[2] | 0}, ${c[3] | 0}, ${(c[0] / 255).toFixed(3)})`
    }
  }

  /** Jump the sim to an absolute cycle (rebuilds from 0 when scrubbing back). */
  const seek = (target: number) => {
    const r = rt.current
    if (target < r.cycle) {
      r.cursor = 0
      r.cycle = 0
      r.camRt = null
      r.fade = null
      r.finished = false
      // rest poses too — a replayed entity otherwise shows its end-of-scene
      // pose (Zilyana standing) until its first animation lands
      for (const e of r.entities) {
        e.placed = false; e.route = null; e.anim = null; e.lastPosed = null
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
    }
    while (r.cycle < target) stepCycle()
    applyCameraAndFade()
    setCycle(r.cycle)
  }

  // ------------------------------------------------------------ scene setup

  useEffect(() => {
    const r = rt.current
    r.disposed = false
    let cancelled = false
    let disposeResize: (() => void) | null = null
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
              r.animLocs.push({
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
        // a placeholder marker (its appearance is streamed at runtime).
        setStatus('Loading cast…')
        const npcsDir = await resolveEntryHandle(rootHandle, getEntryPath('npcs'))
        const basDir = await resolveEntryHandle(rootHandle, getEntryPath('config_bas'))
        for (const entity of def.entities) {
          const ert: EntityRt = {
            em: null, group: new THREE.Group(), placed: false,
            fineX: 0, fineY: 0, plane: 0, yaw: 0, route: null, anim: null,
            animPending: 0, animCommitted: 0,
            standAnimId: -1, walkAnimId: -1, turnsWhileWalking: true,
            bb: null, bbMatrix: null, lastPosed: null,
          }
          try {
            if (entity.id >= 0 && npcsDir) {
              const file = await (await npcsDir.getFileHandle(`${entity.id}.json`)).getFile()
              const npcDef = JSON.parse(await file.text()) as Record<string, unknown>
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
              // the client only re-faces a walking entity when its BAS has a
              // yaw acceleration or the def a non-zero contrast
              // (PathingEntity.method15863's gate) — assume no BAS = no turning
              ert.turnsWhileWalking = Number(npcDef.contrast ?? 0) !== 0
              if (basId >= 0 && basDir) {
                try {
                  const basFile = await (await basDir.getFileHandle(`${basId}.json`)).getFile()
                  const bas = JSON.parse(await basFile.text()) as Record<string, unknown>
                  ert.standAnimId = Number(bas.standAnimation ?? -1)
                  ert.walkAnimId = Number(bas.walkAnimation ?? -1)
                  ert.turnsWhileWalking ||= Number(bas.yawAcceleration ?? 0) !== 0
                } catch { /* BAS unavailable */ }
              }
            } else {
              const marker = new THREE.Mesh(
                new THREE.ConeGeometry(140, 460, 12),
                new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.75 }),
              )
              marker.position.y = 230
              ert.group.add(marker)
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
          for (const e of r.entities) animIds.push(e.standAnimId, e.walkAnimId)
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
          // gfx defs carry their own sequence ids — resolve those too
          if (gfxIds.length > 0) {
            try {
              const gfxDir = await resolveEntryHandle(rootHandle, getEntryPath('spot_animations'))
              if (gfxDir) {
                await Promise.all([...new Set(gfxIds)].filter((id) => id > 0).map(async (id) => {
                  try {
                    const gfxDef = JSON.parse(await (await gfxDir.getFileHandle(`${id}.json`)).getFile().then((fl) => fl.text())) as Record<string, unknown>
                    animIds.push(Number(gfxDef.sequenceId ?? -1))
                  } catch { /* missing gfx def */ }
                }))
              }
            } catch { /* no spot_animations entry */ }
          }
          await prewarmAnims(animIds)
          if (cancelled) return
        }

        if (cancelled) return
        // Start-of-scene camera: overhead of the used area until an action takes over.
        r.camera.position.set(REGION_UNITS * 0.75, 4500, -REGION_UNITS * 0.55)
        r.camera.lookAt(REGION_UNITS * 0.75, 0, -REGION_UNITS * 0.75)
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
        const loop = (now: number) => {
          if (r.disposed) return
          requestAnimationFrame(loop)
          const dt = Math.min(now - last, 250)
          last = now
          if (playingRef.current && !r.finished && r.cycle < durationCycles) {
            r.msAcc += dt
            let stepped = false
            while (r.msAcc >= CYCLE_MS) {
              r.msAcc -= CYCLE_MS
              stepCycle()
              stepped = true
            }
            if (stepped) setCycle(r.cycle)
            // the sim stops at FINISHED; drop out of "playing" so the transport
            // shows Replay instead of a pause button over a frozen picture
            if (r.finished || r.cycle >= durationCycles) setPlaying(false)
          }
          applyCameraAndFade()
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
            for (const rec of r.animLocs) {
              if (!rec.animator) continue
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
          if (playingRef.current) {
            for (const e of r.entities) if (e.anim?.def.tweened && e.placed) void poseEntityFrame(e)
            for (const o of r.objects) if (o?.anim?.def.tweened && o.group.visible) void poseEntityFrame(o)
            for (const g of r.gfx) if (g.anim?.def.tweened) void poseEntityFrame(g)
          }
          r.particles?.step(dt, r.camera)
          if (r.sky) r.sky.position.copy(r.camera.position)
          if (r.composer) r.composer.render()
          else r.renderer!.render(r.scene, r.camera)
        }
        requestAnimationFrame(loop)
      } catch (e) {
        if (!cancelled) setStatus(`Scene build failed: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return () => {
      cancelled = true
      disposeResize?.()
      const rr = rt.current
      rr.disposed = true
      rr.particles?.dispose()
      rr.billboards?.dispose()
      rr.billboards = null
      rr.animLocs = []
      rr.gfx = []
      rr.objects = []
      rr.entities = []
      rr.composer?.dispose()
      rr.renderer?.dispose()
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
    }
    // the scene build runs once per cutscene
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, rootHandle])

  return (
    <dialog ref={dialogRef} className="anim-preview-dialog cutscene-player-dialog" onCancel={(e) => { e.preventDefault(); onClose() }}>
      <div className="anim-preview-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Cutscene {def.id} — playback preview</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>
        <div className="cutscene-player-main">
          <div className="cutscene-player-stage">
            <canvas ref={canvasRef} className="cutscene-player-canvas" />
            <div ref={fadeRef} className="cutscene-player-fade" />
            {status && <p className="anim-preview-status cutscene-player-status">{status}</p>}
          </div>
          <div className="cutscene-player-actions">
            <ul ref={actionListRef}>
              {def.actions.map((a, i) => {
                const state = i < rt.current.cursor
                  ? (a.lengthInCycles === lastAppliedStart ? 'current' : 'done')
                  : 'pending'
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={`cutscene-player-action cutscene-player-action-${state}`}
                      title={`Jump here (${JSON.stringify(a.fields ?? {})})`}
                      onClick={() => { seek(a.lengthInCycles + 1); setPlaying(false) }}
                    >
                      <span className="cutscene-player-action-time">{(a.lengthInCycles * CYCLE_MS / 1000).toFixed(1)}s</span>
                      <span className={`cutscene-action-badge cutscene-action-${actionGroupClass(a.type)}`}>{a.type.toLowerCase().replace(/_/g, ' ')}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
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
            {(cycle * CYCLE_MS / 1000).toFixed(1)}s / {(durationCycles * CYCLE_MS / 1000).toFixed(1)}s
            <span className="cutscene-player-actioncount">action {rt.current.cursor}/{def.actions.length}</span>
          </span>
        </div>
        <p className="cutscene-note">
          Simulated: terrain/locs from the areas recipe, camera splines, entity placement + walk routes + animations, object spawns, screen fades.
          Not simulated: sounds, gfx/projectiles, hitmarks, hint arrows, tile messages{warnings.length > 0 ? ` — ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${[...new Set(warnings)].slice(0, 3).join('; ')}` : ''}.
        </p>
      </div>
    </dialog>
  )
}
