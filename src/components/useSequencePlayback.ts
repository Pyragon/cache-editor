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

// Sequence playback over a loaded model: resolves each frame's frame set and
// frame base (session-cached per hook instance), poses the model through the
// ported skeletal transform math, and advances at the animation's real
// per-frame durations (20ms client ticks) while playing. The posed vertices
// are meant for ModelViewer's `posedVertices` prop — in-place buffer updates
// on the live scene, so real-time speed is fine. Shared by the animation
// playback dialog and the NPC full-model preview's BAS stand pose.
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
  const frameSetCache = useRef(new Map<number, Promise<AnimationFrameSetData>>())
  const frameBaseCache = useRef(new Map<number, Promise<AnimationFrameBaseDef>>())
  // Only the newest poseFrame call may write state — awaits resolve out of
  // order during playback, and a stale frame landing late would jitter the
  // pose backwards (or leave a stale status up).
  const poseSeq = useRef(0)

  const frameCount = animation?.frameDurations?.length ?? 0
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
    if (!frameSetP) {
      setStatus('Loading…')
      frameSetP = (async () => {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
        const loader = getLoader('animation_frame_sets')
        if (!dir || !loader) throw new Error('animation_frame_sets entry not available')
        return await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
      })()
      frameSetCache.current.set(setId, frameSetP)
      frameSetP.catch(() => frameSetCache.current.delete(setId))
    }
    const frameSet = await frameSetP
    if (seq !== poseSeq.current) return null
    const frame = frameSet.frames.get(fileId)
    if (!frame) { setStatus(`Frame set ${setId} has no file ${fileId}.`); return null }
    if (frame.rawFallbackBytes) { setStatus('This frame is unreadable (references an orphaned frame base).'); return null }

    let frameBaseP = frameBaseCache.current.get(frame.frameBaseId)
    if (!frameBaseP) {
      setStatus('Loading…')
      frameBaseP = (async () => {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const data = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
        return data.def
      })()
      frameBaseCache.current.set(frame.frameBaseId, frameBaseP)
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

  return { posedVertices, status, frameIndex, setFrameIndex, frameCount, playing, setPlaying }
}
