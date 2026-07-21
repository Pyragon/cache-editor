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
import { NumberInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { CameraState } from './ModelViewer'
import './AnimationViewer.css'

type Props = {
  animation: AnimationDef
  rootHandle?: FileSystemDirectoryHandle
  /** Pre-fill and auto-load this model (e.g. from a compatible-NPC row). */
  initialModelId?: number
  onClose: () => void
}

// Modal that plays a sequence's frames on a chosen model, applying the ported
// skeletal transform math (skeletalAnimation.ts) per frame. The posed vertices
// go to ModelViewer as `posedVertices`, applied in place to the live scene —
// the scene is built once per model load, so playback runs at the animation's
// real per-frame durations.
export default function AnimationPlaybackViewer({ animation, rootHandle, initialModelId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [modelId, setModelId] = useState(initialModelId ?? 0)
  const [model, setModel] = useState<ModelData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [posedVertices, setPosedVertices] = useState<PosedVertices | null>(null)
  const [status, setStatus] = useState<string>('')
  const [playing, setPlaying] = useState(false)

  const frameSetCache = useRef(new Map<number, AnimationFrameSetData>())
  const frameBaseCache = useRef(new Map<number, AnimationFrameBaseDef>())
  // Orbit rotation survives model reloads (which do rebuild the scene).
  const cameraStateRef = useRef<CameraState | null>(null)

  const frameCount = animation.frameDurations?.length ?? 0

  async function loadModel() {
    if (!rootHandle) return
    setLoadError(null)
    setModel(null)
    setPosedVertices(null)
    try {
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('models'))
      const loader = getLoader('models')
      if (!dir || !loader) throw new Error('models entry not available')
      const data = await loader.loadItem(dir, { id: modelId, name: `${modelId}` }, rootHandle) as ModelData
      if (!data.vertexSkins) {
        setLoadError(`Model ${modelId} has no skeletal skin data (vertexSkins) — it can't be animated.`)
        return
      }
      setModel(data)
    } catch {
      setLoadError(`Couldn't load model ${modelId}.`)
    }
  }

  async function poseFrame(index: number) {
    if (!model || !rootHandle) return
    const setId = animation.frameSetIds?.[index]
    if (setId == null) return
    const fileId = frameFileId(animation, index)

    try {
      // Only surface "Loading…" on a real cache miss — setting it on every
      // frame advance re-rendered and reflowed the dialog twice per frame
      // during playback (the cached path is effectively synchronous).
      let frameSet = frameSetCache.current.get(setId)
      if (!frameSet) {
        setStatus('Loading…')
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
        const loader = getLoader('animation_frame_sets')
        if (!dir || !loader) throw new Error('animation_frame_sets entry not available')
        frameSet = await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
        frameSetCache.current.set(setId, frameSet)
      }
      const frame = frameSet.frames.get(fileId)
      if (!frame) { setStatus(`Frame set ${setId} has no file ${fileId}.`); setPosedVertices(null); return }
      if (frame.rawFallbackBytes) { setStatus('This frame is unreadable (references an orphaned frame base).'); setPosedVertices(null); return }

      let frameBase = frameBaseCache.current.get(frame.frameBaseId)
      if (!frameBase) {
        setStatus('Loading…')
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const data = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
        frameBase = data.def
        frameBaseCache.current.set(frame.frameBaseId, frameBase)
      }

      const posed = applyAnimationFrame(model, frameBase, frame)
      if (!posed) { setStatus('This frame base has no compatible skin data for the loaded model.'); setPosedVertices(null); return }

      setPosedVertices(posed)
      setStatus('')
    } catch {
      setStatus('Failed to pose this frame.')
      setPosedVertices(null)
    }
  }

  useEffect(() => {
    if (model) poseFrame(frameIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, frameIndex])

  useEffect(() => {
    dialogRef.current?.showModal()
    if (initialModelId != null) loadModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Playback: advance per the frame's own duration (20ms client ticks) —
  // posing is an in-place buffer update now, so real-time speed is fine.
  useEffect(() => {
    if (!playing || !model || frameCount === 0) return
    const duration = (animation.frameDurations?.[frameIndex] ?? 1) * 20
    const timer = setTimeout(() => setFrameIndex((i) => (i + 1) % frameCount), Math.max(duration, 20))
    return () => clearTimeout(timer)
  }, [playing, frameIndex, model, frameCount, animation.frameDurations])

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Animation {animation.id} — Preview on Model</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        <div className="anim-preview-toolbar">
          <span className="sprite-zoom-label">Model</span>
          <NumberInput value={modelId} onChange={setModelId} />
          <button type="button" className="replace-btn" onClick={loadModel}>Load</button>
          {model && (
            <>
              <span className="btn-pill">
                <button type="button" className="zoom-btn" disabled={playing || frameIndex === 0} onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}>◂ Prev</button>
                <button type="button" className="zoom-btn" disabled={playing || frameIndex >= frameCount - 1} onClick={() => setFrameIndex((i) => Math.min(frameCount - 1, i + 1))}>Next ▸</button>
              </span>
              <button
                type="button"
                className={`zoom-btn anim-preview-play${playing ? ' active' : ''}`}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <span className="anim-preview-frame-label">Frame {frameIndex + 1} / {frameCount}</span>
            </>
          )}
        </div>

        {loadError && <p className="anim-preview-status">{loadError}</p>}
        {status && <p className="anim-preview-status">{status}</p>}
        {model && <ModelViewer data={model} posedVertices={posedVertices} cameraStateRef={cameraStateRef} />}
      </div>
    </dialog>
  )
}
