import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import { memSet } from './memoryDebug'

// Sequence playback over a loaded model: resolves each frame's frame set and
// frame base (session-cached per hook instance), poses the model through the
// ported skeletal transform math, and advances at the animation's real
// per-frame durations (20ms client ticks) while playing. The posed vertices
// are meant for ModelViewer's `posedVertices` prop — in-place buffer updates
// on the live scene, so real-time speed is fine. Shared by the animation
// playback dialog and the NPC full-model preview's BAS stand pose.
/** Union of a posed sequence's vertex extents, in raw RS model space. */
export type PoseBounds = {
  minX: number; maxX: number
  minY: number; maxY: number
  minZ: number; maxZ: number
}

/** Cap on frames sampled for the pose-bounds union; see the effect below. */
const MAX_BOUNDS_SAMPLES = 96

export function useSequencePlayback(
  animation: AnimationDef | null,
  model: ModelData | null,
  rootHandle: FileSystemDirectoryHandle | undefined,
  autoPlay = false,
) {
  const [frameIndex, setFrameIndex] = useState(0)
  const [posedVertices, setPosedVertices] = useState<PosedVertices | null>(null)
  const [status, setStatus] = useState('')
  const [playing, setPlaying] = useState(autoPlay)

  // Caches hold the load PROMISE, not the finished value: playback keeps
  // advancing frames while the first load is in flight, and a value cache
  // made every one of those ticks re-fetch the same (large) frame set — the
  // pile-up never caught up and the view sat on "Loading…" forever.
  //
  // Capped, because the hook instance OUTLIVES the thing being previewed:
  // App.tsx renders one viewer component per entry and swaps its `data` prop
  // as you click through the item list, so an uncapped cache accumulated every
  // frame set of every sequence visited in the session. Frame sets are the
  // largest objects this app decodes (a Map of keyframes, each holding several
  // plain number[] of per-bone transforms), so that grew fast.
  const frameSetCache = useRef(new Map<number, Promise<AnimationFrameSetData>>())
  const frameBaseCache = useRef(new Map<number, Promise<AnimationFrameBaseDef>>())
  // Only the newest poseFrame call may write state — awaits resolve out of
  // order during playback, and a stale frame landing late would jitter the
  // pose backwards (or leave a stale status up).
  const poseSeq = useRef(0)

  const frameCount = animation?.frameDurations?.length ?? 0

  /** Insert into an LRU-by-insertion-order Map, evicting the oldest over `cap`.
   *  A cache HIT must re-insert too (see `touch`) or the entry a sequence is
   *  actively cycling through can age out from under it. */
  function put<T>(cache: Map<number, T>, key: number, value: T, cap: number) {
    cache.set(key, value)
    while (cache.size > cap) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }
  function touch<T>(cache: Map<number, T>, key: number, value: T) {
    cache.delete(key)
    cache.set(key, value)
  }
  // 8,211 of the 17,186 sequences set this; the rest are authored to step.
  const tweened = animation?.tweened === true

  /** Resolves one keyframe and its base, both session-cached. Returns null
   *  (after setting a status) when the frame can't be posed. */
  async function loadFrame(index: number, seq: number) {
    if (!animation || !rootHandle) return null
    const setId = animation.frameSetIds?.[index]
    if (setId == null) return null
    const fileId = frameFileId(animation, index)

    let frameSetP = frameSetCache.current.get(setId)
    if (frameSetP) {
      touch(frameSetCache.current, setId, frameSetP)
    } else {
      setStatus('Loading…')
      frameSetP = (async () => {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
        const loader = getLoader('animation_frame_sets')
        if (!dir || !loader) throw new Error('animation_frame_sets entry not available')
        return await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
      })()
      // 8 is comfortably more than any one sequence spans (almost all use 1–2)
      // while keeping a browse through the item list from piling them up.
      put(frameSetCache.current, setId, frameSetP, 8)
      memSet('frameSets', frameSetCache.current.size)
      frameSetP.catch(() => frameSetCache.current.delete(setId))
    }
    const frameSet = await frameSetP
    if (seq !== poseSeq.current) return null
    const frame = frameSet.frames.get(fileId)
    if (!frame) { setStatus(`Frame set ${setId} has no file ${fileId}.`); return null }
    if (frame.rawFallbackBytes) { setStatus('This frame is unreadable (references an orphaned frame base).'); return null }

    let frameBaseP = frameBaseCache.current.get(frame.frameBaseId)
    if (frameBaseP) {
      touch(frameBaseCache.current, frame.frameBaseId, frameBaseP)
    } else {
      setStatus('Loading…')
      frameBaseP = (async () => {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const data = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
        return data.def
      })()
      // Bases are far smaller than frame sets, so a looser cap is fine.
      put(frameBaseCache.current, frame.frameBaseId, frameBaseP, 32)
      frameBaseP.catch(() => frameBaseCache.current.delete(frame.frameBaseId))
    }
    const frameBase = await frameBaseP
    if (seq !== poseSeq.current) return null
    return { frame, frameBase }
  }

  /** Poses `index`, optionally blended `elapsed`/`duration` of the way toward
   *  the next keyframe. Only sequences flagged `tweened` get a blend — the
   *  rest are authored to step. */
  async function poseFrame(index: number, elapsed = 0, duration = 1) {
    if (!animation || !model || !rootHandle) return
    const seq = ++poseSeq.current

    try {
      const current = await loadFrame(index, seq)
      if (!current) { if (seq === poseSeq.current) setPosedVertices(null); return }

      let next = null
      if (tweened && frameCount > 1 && elapsed > 0) {
        const following = await loadFrame((index + 1) % frameCount, seq)
        if (seq !== poseSeq.current) return
        // Only blend within one frame base — a set change mid-blend would
        // interpolate against unrelated bone slots.
        if (following && following.frameBase === current.frameBase) next = following.frame
      }

      const posed = applyAnimationFrame(model, current.frameBase, current.frame, next, elapsed, duration)
      if (!posed) { setStatus('This frame base has no compatible skin data for the loaded model.'); setPosedVertices(null); return }

      setPosedVertices(posed)
      setStatus('')
    } catch {
      if (seq !== poseSeq.current) return
      setStatus('Failed to pose this frame.')
      setPosedVertices(null)
    }
  }

  // --- Pose bounds ---------------------------------------------------------
  // ModelViewer frames the camera on the REST bounding box, but posing can move
  // the mesh a long way from it: 60% of spot animations end up more than half
  // their own size away from the rest centre, and spot animation 59 lands 1,091
  // units off a 536-unit model — entirely out of shot, which just reads as a
  // black panel. So measure where the animation actually *is* and hand that to
  // the camera.
  //
  // The union across frames rather than frame 0's box, because 43% of them
  // travel more than half their size away from where they start. It's a single
  // fixed box for the whole sequence, so the camera still never jerks between
  // frames — the property the fixed rest pivot was protecting.
  const [poseBounds, setPoseBounds] = useState<PoseBounds | null>(null)
  const boundsSeq = useRef(0)

  useEffect(() => {
    setPoseBounds(null)
    if (!model || !animation || !rootHandle || frameCount === 0) return
    const seq = ++boundsSeq.current
    let cancelled = false

    void (async () => {
      // Every spot-anim sequence in the cache uses exactly one frame set, so
      // this reuses the very load frame 0 needs — no extra I/O, and no risk of
      // churning the capped frame-set cache. The sample cap only bites on long
      // sequences, where evenly spaced frames bound the cost (worst measured:
      // 130 frames x 1,724 vertices = 70ms) without meaningfully shrinking the
      // union.
      const step = Math.max(1, Math.ceil(frameCount / MAX_BOUNDS_SAMPLES))
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      let minZ = Infinity, maxZ = -Infinity

      for (let i = 0; i < frameCount; i += step) {
        if (cancelled || seq !== boundsSeq.current) return
        let loaded
        try {
          // deliberately NOT poseSeq — this walk must survive playback
          // advancing frames underneath it
          loaded = await loadFrame(i, poseSeq.current)
        } catch {
          continue
        }
        if (!loaded) continue
        const posed = applyAnimationFrame(model, loaded.frameBase, loaded.frame)
        if (!posed) continue
        for (let v = 0; v < model.vertexCount; v++) {
          const x = posed.x[v], y = posed.y[v], z = posed.z[v]
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
      }

      if (cancelled || seq !== boundsSeq.current || !isFinite(minX)) return
      setPoseBounds({ minX, maxX, minY, maxY, minZ, maxZ })
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animation, model, rootHandle, frameCount])

  // A fresh SEQUENCE starts over from frame 0 (and re-arms autoplay).
  useEffect(() => {
    setFrameIndex(0)
    setPosedVertices(null)
    setStatus('')
    if (autoPlay) setPlaying(true)
    // autoPlay is a config flag, not reactive state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animation])

  // A fresh MODEL keeps the current frame — restarting here made every edit in
  // a live editor snap the animation back to the start, which reads as the
  // whole preview resetting. Only the stale pose is dropped, because it holds
  // vertex data sized for the previous mesh; the effect below immediately
  // re-poses the new one at the same frame.
  useEffect(() => {
    setPosedVertices(null)
  }, [model])

  // Paused (or scrubbing): pose the selected frame exactly. While playing the
  // RAF loop below owns posing, so this would fight it.
  useEffect(() => {
    if (model && animation && !playing) void poseFrame(frameIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, animation, frameIndex, playing])

  // Playback. Frames advance at their authored durations (20ms client ticks),
  // but a TWEENED sequence is re-posed every render frame at its sub-frame
  // fraction — stepping keyframes alone runs at whatever the durations say,
  // which for a stand animation is 5 ticks (100ms), i.e. 10 updates a second,
  // and reads as stutter however fast the scene renders.
  const playState = useRef({ index: 0, elapsedMs: 0 })
  useEffect(() => {
    if (!playing || !model || !animation || frameCount === 0) return
    const durations = animation.frameDurations ?? []
    const durationMs = (i: number) => Math.max((durations[i] ?? 1) * 20, 20)

    playState.current = { index: frameIndex, elapsedMs: 0 }
    let raf = 0
    let last = performance.now()

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const state = playState.current
      state.elapsedMs += now - last
      last = now

      let advanced = false
      while (state.elapsedMs >= durationMs(state.index)) {
        state.elapsedMs -= durationMs(state.index)
        state.index = (state.index + 1) % frameCount
        advanced = true
      }
      if (advanced) setFrameIndex(state.index)

      const duration = durationMs(state.index)
      void poseFrame(
        state.index,
        tweened ? state.elapsedMs / 20 : 0,
        tweened ? duration / 20 : 1,
      )
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // frameIndex seeds the loop but must not restart it every advance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, model, animation, frameCount, tweened])

  return { posedVertices, status, frameIndex, setFrameIndex, frameCount, playing, setPlaying, poseBounds }
}
