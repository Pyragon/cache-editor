import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
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

// Modal that steps through a sequence's frames on a chosen model, applying the
// ported skeletal transform math (skeletalAnimation.ts) per frame. Not
// real-time playback — ModelViewer rebuilds its whole Three.js scene per
// `data` change, too costly to do at animation framerate, so this is a
// frame-by-frame stepper instead (still shows the real deformation working).
const FPS_CAPS = [5, 10, 20, 30]

export default function AnimationPlaybackViewer({ animation, rootHandle, initialModelId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [modelId, setModelId] = useState(initialModelId ?? 0)
  const [model, setModel] = useState<ModelData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [posedModel, setPosedModel] = useState<ModelData | null>(null)
  const [status, setStatus] = useState<string>('')
  const [playing, setPlaying] = useState(false)
  const [fpsCap, setFpsCap] = useState(10)

  const frameSetCache = useRef(new Map<number, AnimationFrameSetData>())
  const frameBaseCache = useRef(new Map<number, AnimationFrameBaseDef>())
  // Orbit rotation survives the per-frame scene rebuilds (and model reloads).
  const cameraStateRef = useRef<CameraState | null>(null)

  const frameCount = animation.frameDurations?.length ?? 0

  async function loadModel() {
    if (!rootHandle) return
    setLoadError(null)
    setModel(null)
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

    setStatus('Loading…')
    try {
      let frameSet = frameSetCache.current.get(setId)
      if (!frameSet) {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_sets'))
        const loader = getLoader('animation_frame_sets')
        if (!dir || !loader) throw new Error('animation_frame_sets entry not available')
        frameSet = await loader.loadItem(dir, { id: setId, name: `${setId}` }, rootHandle) as AnimationFrameSetData
        frameSetCache.current.set(setId, frameSet)
      }
      const frame = frameSet.frames.get(fileId)
      if (!frame) { setStatus(`Frame set ${setId} has no file ${fileId}.`); setPosedModel(null); return }
      if (frame.rawFallbackBytes) { setStatus('This frame is unreadable (references an orphaned frame base).'); setPosedModel(null); return }

      let frameBase = frameBaseCache.current.get(frame.frameBaseId)
      if (!frameBase) {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const data = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, rootHandle) as { def: AnimationFrameBaseDef }
        frameBase = data.def
        frameBaseCache.current.set(frame.frameBaseId, frameBase)
      }

      const posed = applyAnimationFrame(model, frameBase, frame)
      if (!posed) { setStatus('This frame base has no compatible skin data for the loaded model.'); setPosedModel(null); return }

      setPosedModel({ ...model, vertexX: posed.x, vertexY: posed.y, vertexZ: posed.z })
      setStatus('')
    } catch {
      setStatus('Failed to pose this frame.')
      setPosedModel(null)
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

  // Playback: advance per the frame's own duration (20ms client ticks),
  // never faster than the FPS cap allows — each step rebuilds the Three.js
  // scene, which is the expensive part the cap protects against.
  useEffect(() => {
    if (!playing || !model || frameCount === 0) return
    const duration = (animation.frameDurations?.[frameIndex] ?? 1) * 20
    const wait = Math.max(duration, 1000 / fpsCap)
    const timer = setTimeout(() => setFrameIndex((i) => (i + 1) % frameCount), wait)
    return () => clearTimeout(timer)
  }, [playing, frameIndex, model, fpsCap, frameCount, animation.frameDurations])

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
              <span className="sprite-zoom-label">FPS cap</span>
              <span className="btn-pill">
                {FPS_CAPS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`zoom-btn${fpsCap === f ? ' active' : ''}`}
                    title="Playback never advances faster than this (each frame rebuilds the 3D scene)"
                    onClick={() => setFpsCap(f)}
                  >
                    {f}
                  </button>
                ))}
              </span>
            </>
          )}
        </div>

        {loadError && <p className="anim-preview-status">{loadError}</p>}
        {status && <p className="anim-preview-status">{status}</p>}
        {posedModel && <ModelViewer data={posedModel} cameraStateRef={cameraStateRef} />}
      </div>
    </dialog>
  )
}
