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

  async function poseFrame(index: number) {
    if (!animation || !model || !rootHandle) return
    const setId = animation.frameSetIds?.[index]
    if (setId == null) return
    const fileId = frameFileId(animation, index)
    const seq = ++poseSeq.current

    try {
      // Only surface "Loading…" on a real cache miss — setting it on every
      // frame advance re-rendered and reflowed the dialog twice per frame
      // during playback (the cached path is effectively synchronous).
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
        frameSetP.catch(() => frameSetCache.current.delete(setId)) // failed loads may retry
      }
      const frameSet = await frameSetP
      if (seq !== poseSeq.current) return
      const frame = frameSet.frames.get(fileId)
      if (!frame) { setStatus(`Frame set ${setId} has no file ${fileId}.`); setPosedVertices(null); return }
      if (frame.rawFallbackBytes) { setStatus('This frame is unreadable (references an orphaned frame base).'); setPosedVertices(null); return }

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
      if (seq !== poseSeq.current) return

      const posed = applyAnimationFrame(model, frameBase, frame)
      if (!posed) { setStatus('This frame base has no compatible skin data for the loaded model.'); setPosedVertices(null); return }

      setPosedVertices(posed)
      setStatus('')
    } catch {
      if (seq !== poseSeq.current) return
      setStatus('Failed to pose this frame.')
      setPosedVertices(null)
    }
  }

  // A fresh model or sequence starts over from frame 0 (and re-arms autoplay).
  useEffect(() => {
    setFrameIndex(0)
    setPosedVertices(null)
    setStatus('')
    if (autoPlay) setPlaying(true)
    // autoPlay is a config flag, not reactive state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, animation])

  useEffect(() => {
    if (model && animation) poseFrame(frameIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, animation, frameIndex])

  // Playback: advance per the frame's own duration (20ms client ticks) —
  // posing is an in-place buffer update, so real-time speed is fine.
  useEffect(() => {
    if (!playing || !model || frameCount === 0) return
    const duration = (animation?.frameDurations?.[frameIndex] ?? 1) * 20
    const timer = setTimeout(() => setFrameIndex((i) => (i + 1) % frameCount), Math.max(duration, 20))
    return () => clearTimeout(timer)
  }, [playing, frameIndex, model, frameCount, animation?.frameDurations])

  return { posedVertices, status, frameIndex, setFrameIndex, frameCount, playing, setPlaying }
}
