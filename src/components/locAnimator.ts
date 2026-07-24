import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import type { PosedVertices } from '../loaders/skeletalAnimation'

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
  private frameSets = new Map<number, AnimationFrameSetData>()
  private frameBases = new Map<number, AnimationFrameBaseDef>()
  private ready = false

  constructor(def: AnimationDef) {
    this.def = def
    this.frameCount = def.frameDurations?.length ?? 0
    let ticks = 0
    for (const d of def.frameDurations ?? []) ticks += Math.max(1, d)
    this.totalTicks = Math.max(1, ticks)
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
    let tick = Math.floor((seconds * 1000) / 20) % this.totalTicks
    for (let i = 0; i < this.frameCount; i++) {
      tick -= Math.max(1, this.def.frameDurations?.[i] ?? 1)
      if (tick < 0) return i
    }
    return this.frameCount - 1
  }

  /** Pose a model at a frame index. Null if the frame/base is missing or the
   *  model has no compatible skin data. */
  pose(model: ModelData, frameIndex: number): PosedVertices | null {
    const setId = this.def.frameSetIds?.[frameIndex]
    if (setId == null) return null
    const frame = this.frameSets.get(setId)?.frames.get(frameFileId(this.def, frameIndex))
    if (!frame || frame.rawFallbackBytes) return null
    const base = this.frameBases.get(frame.frameBaseId)
    if (!base) return null
    return applyAnimationFrame(model, base, frame)
  }
}
