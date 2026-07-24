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
import {
  DEFAULT_SUN, LocAssets, SceneMosaic, averageHeight, buildLocsMesh, buildTerrainMesh, loadSceneConfigs,
} from './mapScene'
import { assembleCutsceneScene } from './cutsceneScene'
import './AnimationViewer.css'
import './CutsceneViewer.css'

const REGION_UNITS = SIZE * 512
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

// ---------------------------------------------------------------------------
// Runtime state (all in refs — the sim runs on the rAF loop, not React).

type EntityRt = {
  em: EntityMesh | null
  group: THREE.Group
  placed: boolean
  fineX: number
  fineY: number
  plane: number
  yaw: number // three.js rotation.y
  route: { tiles: [number, number][]; paces: number[]; next: number } | null
  anim: { def: AnimationDef; frame: number; acc: number; oneShot: boolean } | null
  standAnimId: number
  walkAnimId: number
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
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    heightsByCell: Map<string, Int32Array[]>
    entities: EntityRt[]
    objects: (THREE.Group | null)[]
    camRt: CameraRt
    fade: FadeRt
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
      camRt: null,
      fade: null,
      cursor: 0,
      cycle: 0,
      msAcc: 0,
      finished: false,
      disposed: false,
    }
  }

  const durationCycles = def.actions.reduce((m, a) => Math.max(m, a.lengthInCycles), 0) + 50
  // Distinct action start cycles, for the step-by-action buttons. An action at
  // start s is applied once the sim clock passes it (cycle > s), so "jump to
  // this action" means seek(s + 1).
  const actionStarts = [...new Set(def.actions.map((a) => a.lengthInCycles))].sort((a, b) => a - b)

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
  }

  // Animation caches shared by all entities.
  const animDefCache = useRef(new Map<number, Promise<AnimationDef | null>>())
  const frameSetCache = useRef(new Map<number, Promise<AnimationFrameSetData | null>>())
  const frameBaseCache = useRef(new Map<number, Promise<AnimationFrameBaseDef | null>>())

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
    }
    return p
  }

  const poseEntityFrame = async (e: EntityRt) => {
    if (!e.anim || !e.em) return
    const index = e.anim.frame
    const setId = e.anim.def.frameSetIds?.[index]
    if (setId == null) return
    try {
      let setP = frameSetCache.current.get(setId)
      if (!setP) {
        setP = (async () => {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
          const loader = getLoader('animation_frame_sets')
          if (!dir || !loader) return null
          return await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
        })()
        frameSetCache.current.set(setId, setP)
      }
      const frameSet = await setP
      const frame = frameSet?.frames.get(frameFileId(e.anim.def, index))
      if (!frame || frame.rawFallbackBytes) return
      let baseP = frameBaseCache.current.get(frame.frameBaseId)
      if (!baseP) {
        baseP = (async () => {
          const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
          const loader = getLoader('animation_frame_bases')
          if (!dir || !loader) return null
          const data = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
          return data.def
        })()
        frameBaseCache.current.set(frame.frameBaseId, baseP)
      }
      const frameBase = await baseP
      if (!frameBase || rt.current.disposed) return
      const posed = applyAnimationFrame(e.em.model, frameBase, frame)
      if (posed) applyPose(e.em, posed)
    } catch { /* frame unavailable — hold the last pose */ }
  }

  const startAnim = async (e: EntityRt, animId: number, oneShot: boolean) => {
    if (animId < 0) { e.anim = null; if (e.em) applyPose(e.em, null); return }
    const animDef = await loadAnimDef(animId)
    if (!animDef || !animDef.frameDurations?.length) return
    e.anim = { def: animDef, frame: 0, acc: 0, oneShot }
    void poseEntityFrame(e)
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
        e.yaw = Math.PI + (f.direction / 16384) * Math.PI * 2
        if (!e.anim && e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
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
        if (e) void startAnim(e, f.movementAnimationId, true)
        break
      }
      case 'ROTATE_CUTSCENE_ENTITY': {
        const e = r.entities[f.cutsceneEntityPtr]
        if (e) { e.yaw = Math.PI + (f.rotation / 16384) * Math.PI * 2; placeEntity(e) }
        break
      }
      case 'RESET_CUTSCENE_ENTITY': {
        const e = r.entities[f.entityIndex]
        if (e) { e.placed = false; e.route = null; e.anim = null; placeEntity(e) }
        break
      }
      case 'REPLACE_OBJECT': {
        const g = r.objects[f.locIndex]
        if (g) {
          g.visible = true
          const fineX = f.x * 512 + 256
          const fineY = f.y * 512 + 256
          g.position.set(fineX, groundY(fineX, fineY, f.plane), -fineY)
          g.rotation.y = -(f.rotation * Math.PI) / 2
        }
        break
      }
      case 'DESTROY_OBJECT': {
        const g = r.objects[f.cutsceneObjectPtr]
        if (g) g.visible = false
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
        if (dist > 1) e.yaw = Math.atan2(dx, -dy) + Math.PI
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
        if (e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
      }
      placeEntity(e)
    }
    // entity animation frames (durations are client cycles)
    for (const e of r.entities) {
      if (!e.anim) continue
      const durations = e.anim.def.frameDurations ?? []
      if (durations.length === 0) continue
      e.anim.acc++
      if (e.anim.acc >= (durations[e.anim.frame] || 1)) {
        e.anim.acc = 0
        if (e.anim.frame + 1 >= durations.length) {
          if (e.anim.oneShot) {
            e.anim = null
            if (e.standAnimId >= 0) void startAnim(e, e.standAnimId, false)
            continue
          }
          e.anim.frame = 0
        } else {
          e.anim.frame++
        }
        void poseEntityFrame(e)
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
      for (const e of r.entities) { e.placed = false; e.route = null; e.anim = null; placeEntity(e) }
      for (const g of r.objects) { if (g) g.visible = false }
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
        const assembled = await assembleCutsceneScene(def, mapsDir)
        if (cancelled) return
        setWarnings(assembled.warnings)

        setStatus('Loading ground configs…')
        const configs = await loadSceneConfigs(rootHandle)
        const assets = new LocAssets(rootHandle)

        // 3×3 mosaic grid with our 2×2 synthetic scene in the +0/+1 cells.
        const grid: (import('../loaders/maps').MapTerrain | null)[][] = [[null, null, null], [null, null, null], [null, null, null]]
        for (const cell of assembled.cells) grid[cell.rx + 1][cell.ry + 1] = cell.terrain
        const mosaic = new SceneMosaic(grid, 0, 0, configs, DEFAULT_SUN)

        for (const cell of assembled.cells) {
          if (cancelled) return
          const { heights, lights } = mosaic.slicesFor(cell.rx, cell.ry)
          r.heightsByCell.set(`${cell.rx},${cell.ry}`, heights)
          const palettes = [0, 1, 2, 3].map((p) => mosaic.paletteFor(cell.rx, cell.ry, p))
          const overlayCorners = [0, 1, 2, 3].map((p) => mosaic.overlayCornerFor(cell.rx, cell.ry, p))
          const underlayCorners = [0, 1, 2, 3].map((p) => mosaic.underlayCornerFor(cell.rx, cell.ry, p))
          for (let plane = 0; plane < 4; plane++) {
            setStatus(`Building region ${cell.rx},${cell.ry} plane ${plane}…`)
            if (cell.def.objects.length > 0) {
              const locs = await buildLocsMesh(cell.terrain, cell.def.objects, plane, heights, assets)
              if (locs.mesh) {
                locs.mesh.position.set(cell.rx * REGION_UNITS, 0, -cell.ry * REGION_UNITS)
                r.scene.add(locs.mesh)
              }
            }
            const terrainMesh = await buildTerrainMesh(cell.terrain, plane, heights, configs, assets, { lights, palettes, overlayCorners, underlayCorners })
            if (terrainMesh) {
              terrainMesh.position.set(cell.rx * REGION_UNITS, 0, -cell.ry * REGION_UNITS)
              r.scene.add(terrainMesh)
            }
          }
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
            standAnimId: -1, walkAnimId: -1,
          }
          try {
            if (entity.id >= 0 && npcsDir) {
              const file = await (await npcsDir.getFileHandle(`${entity.id}.json`)).getFile()
              const npcDef = JSON.parse(await file.text()) as Record<string, unknown>
              const composite = await loadModelComposite(rootHandle, npcCompositeSpec(npcDef))
              const tm = await buildTexturedModelMesh(composite)
              if (tm) {
                ert.em = { tm, model: composite }
                ert.group.add(tm.mesh)
              }
              const basId = Number(npcDef.basId ?? -1)
              if (basId >= 0 && basDir) {
                try {
                  const basFile = await (await basDir.getFileHandle(`${basId}.json`)).getFile()
                  const bas = JSON.parse(await basFile.text()) as Record<string, unknown>
                  ert.standAnimId = Number(bas.standAnimation ?? -1)
                  ert.walkAnimId = Number(bas.walkAnimation ?? -1)
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
          let group: THREE.Group | null = null
          try {
            if (objectsDir) {
              const file = await (await objectsDir.getFileHandle(`${obj.locId}.json`)).getFile()
              const objDef = JSON.parse(await file.text()) as Record<string, unknown>
              const composite = await loadModelComposite(rootHandle, objectCompositeSpec(objDef))
              const tm = await buildTexturedModelMesh(composite)
              if (tm) {
                group = new THREE.Group()
                group.add(tm.mesh)
                group.visible = false
                r.scene.add(group)
              }
            }
          } catch { /* object unloadable */ }
          r.objects.push(group)
        }

        if (cancelled) return
        // Start-of-scene camera: overhead of the used area until an action takes over.
        r.camera.position.set(REGION_UNITS * 0.75, 4500, -REGION_UNITS * 0.55)
        r.camera.lookAt(REGION_UNITS * 0.75, 0, -REGION_UNITS * 0.75)
        r.scene.background = new THREE.Color(0x000000)

        const canvas = canvasRef.current!
        r.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
        // setPixelRatio + setSize together own the drawing buffer AND the GL
        // viewport — sizing the canvas by hand leaves the viewport stale and
        // the render squeezed into a corner on any DPR > 1 display
        const fitCanvas = () => {
          r.renderer!.setPixelRatio(window.devicePixelRatio || 1)
          r.renderer!.setSize(canvas.clientWidth, canvas.clientHeight, false)
          r.camera.aspect = canvas.clientWidth / canvas.clientHeight
          r.camera.updateProjectionMatrix()
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
          }
          applyCameraAndFade()
          r.renderer!.render(r.scene, r.camera)
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
            onClick={() => {
              if (rt.current.finished || rt.current.cycle >= durationCycles) seek(0)
              setPlaying((p) => !p)
            }}
          >
            {playing ? '⏸' : '▶'}
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
            className="cutscene-player-scrub"
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
