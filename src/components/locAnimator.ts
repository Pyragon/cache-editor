import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame, makePoseScratch } from '../loaders/skeletalAnimation'
import type { PosedVertices, PoseScratch } from '../loaders/skeletalAnimation'

// Imperative (non-React) sequence playback for the map scene — the same
// frameSet → frameBase → applyAnimationFrame pipeline as useSequencePlayback,
// but usable from the plain RAF loop that drives loc idle animations (waving
// flags etc.). One instance per distinct animation id; frame sets and bases are
// preloaded once so per-frame posing is synchronous.
export class LocAnimator {
  readonly def: AnimationDef
  readonly frameCount: number
  /** Total loop length in client ticks (sum of frame durations). */
  readonly totalTicks: number
  /**
   * The frame the client rewinds to past the end (`frame1Index -= loopDelay`
   * in Animation.setupLoop): only the last `loopDelay` frames repeat. Null
   * when the sequence doesn't loop — loopDelay −1 finishes (the loc reverts
   * to its static model, Class123.method2133 `update(-1)`), and 0 rewinds by
   * nothing, which also finishes.
   */
  private readonly loopBackAt: number | null
  /** Ticks spent in the intro (frames before loopBackAt) / the repeating tail. */
  private readonly introTicks: number
  private readonly tailTicks: number
  private frameSets = new Map<number, AnimationFrameSetData>()
  private frameBases = new Map<number, AnimationFrameBaseDef>()
  private ready = false

  constructor(def: AnimationDef) {
    this.def = def
    this.frameCount = def.frameDurations?.length ?? 0
    let ticks = 0
    for (const d of def.frameDurations ?? []) ticks += Math.max(1, d)
    this.totalTicks = Math.max(1, ticks)
    const loops = def.loopDelay >= 1 && def.loopDelay <= this.frameCount
    this.loopBackAt = loops ? this.frameCount - def.loopDelay : null
    let intro = 0
    for (let i = 0; i < (this.loopBackAt ?? 0); i++) intro += Math.max(1, def.frameDurations?.[i] ?? 1)
    this.introTicks = intro
    this.tailTicks = Math.max(1, this.totalTicks - intro)
  }

  /**
   * Map the shared wall clock onto the sequence the way the client's steady
   * state looks: an ambient loc has been animating since it spawned, so a
   * looping sequence is always deep in its REPEATING TAIL — the intro frames
   * before count − loopDelay ran once, long ago, and never show again. A
   * non-looping sequence would have finished and reverted to the static
   * model; the preview replays it whole instead, because a permanently
   * static "animated" loc is useless in an editor.
   */
  private tickFor(rawTick: number): number {
    return this.loopBackAt != null
      ? this.introTicks + (rawTick % this.tailTicks)
      : rawTick % this.totalTicks
  }

  /** Load every frame set + frame base this animation references. */
  async preload(root: FileSystemDirectoryHandle): Promise<void> {
    if (this.ready) return
    const setsDir = await resolveEntryHandle(root, getEntryPath('animation_frame_sets'))
    const basesDir = await resolveEntryHandle(root, getEntryPath('animation_frame_bases'))
    const setLoader = getLoader('animation_frame_sets')
    const baseLoader = getLoader('animation_frame_bases')
    if (!setsDir || !basesDir || !setLoader || !baseLoader) return
    const setIds = new Set(this.def.frameSetIds ?? [])
    for (const setId of setIds) {
      if (setId == null || setId < 0) continue
      try {
        const data = await setLoader.loadItem(setsDir, { id: setId, name: `${setId}` }, root) as AnimationFrameSetData
        this.frameSets.set(setId, data)
      } catch { /* missing frame set — frames from it just won't pose */ }
    }
    // gather the frame bases referenced by the frames we actually use
    const baseIds = new Set<number>()
    for (let i = 0; i < this.frameCount; i++) {
      const setId = this.def.frameSetIds?.[i]
      if (setId == null) continue
      const frame = this.frameSets.get(setId)?.frames.get(frameFileId(this.def, i))
      if (frame && !frame.rawFallbackBytes) baseIds.add(frame.frameBaseId)
    }
    for (const baseId of baseIds) {
      try {
        const data = await baseLoader.loadItem(basesDir, { id: baseId, name: `${baseId}` }, root) as { def: AnimationFrameBaseDef }
        this.frameBases.set(baseId, data.def)
      } catch { /* missing base — those frames won't pose */ }
    }
    this.ready = true
  }

  /** Frame index for a given elapsed time (seconds), looping over the sequence
   *  at the real 20ms-per-tick client cadence. */
  frameAt(seconds: number): number {
    if (this.frameCount <= 1) return 0
    let tick = this.tickFor(Math.floor((seconds * 1000) / 20))
    for (let i = 0; i < this.frameCount; i++) {
      tick -= Math.max(1, this.def.frameDurations?.[i] ?? 1)
      if (tick < 0) return i
    }
    return this.frameCount - 1
  }

  private frameFor(frameIndex: number) {
    const setId = this.def.frameSetIds?.[frameIndex]
    if (setId == null) return null
    return this.frameSets.get(setId)?.frames.get(frameFileId(this.def, frameIndex)) ?? null
  }

  /** Pose a model at a frame index. Null if the frame/base is missing or the
   *  model has no compatible skin data. */
  pose(model: ModelData, frameIndex: number): PosedVertices | null {
    const frame = this.frameFor(frameIndex)
    if (!frame || frame.rawFallbackBytes) return null
    const base = this.frameBases.get(frame.frameBaseId)
    if (!base) return null
    return applyAnimationFrame(model, base, frame)
  }

  /**
   * Pose with the client's keyframe interpolation: fractional ticks within
   * the current frame blend toward the next one when the sequence is
   * `tweened` (MeshRasterizer.method11266; without the flag the client — and
   * this — steps exact keyframes). At the wrap the tween targets the frame
   * playback actually returns to — count − loopDelay, the client's
   * frame2Index rule in Animation.setupLoop — and a non-looping sequence has
   * no target on its last frame: the client finishes there, so the pose
   * holds for the frame's duration (tweening toward frame 0 played the whole
   * thing in reverse over the last frame — arms lowering, arrows flying
   * backwards).
   */
  poseAt(model: ModelData, seconds: number): PosedVertices | null {
    if (this.frameCount === 0) return null
    const durations = this.def.frameDurations ?? []
    let tick = this.tickFor((seconds * 1000) / 20)
    let index = this.frameCount - 1
    for (let i = 0; i < this.frameCount; i++) {
      const d = Math.max(1, durations[i] ?? 1)
      if (tick < d) { index = i; break }
      tick -= d
    }
    const frame = this.frameFor(index)
    if (!frame || frame.rawFallbackBytes) return null
    const base = this.frameBases.get(frame.frameBaseId)
    if (!base) return null
    const scratch = scratchFor(model)
    if (!this.def.tweened || this.frameCount <= 1) return applyAnimationFrame(model, base, frame, null, 0, 1, scratch)
    const nextIndex = index + 1 < this.frameCount ? index + 1 : this.loopBackAt
    const next = nextIndex != null ? this.frameFor(nextIndex) : null
    return applyAnimationFrame(model, base, frame, next, tick, Math.max(1, durations[index] ?? 1), scratch)
  }
}

// Pose buffers per MODEL, shared by every animator and placement that uses it.
// Safe because a posed frame is consumed synchronously by its caller — the map
// scene and the cutscene player both do `update(posed)` and `billboards.pose
// (posed)` immediately — so two placements of the same model never hold a pose
// across each other's call. Without this, every animated loc allocated three
// arrays the size of its model on every frame.
const locScratch = new WeakMap<ModelData, PoseScratch>()

function scratchFor(model: ModelData): PoseScratch {
  let s = locScratch.get(model)
  if (!s) locScratch.set(model, s = makePoseScratch(model))
  return s
}
