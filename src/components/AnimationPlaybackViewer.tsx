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

type Props = {
  animation: AnimationDef
  rootHandle?: FileSystemDirectoryHandle
  onClose: () => void
}

// Steps through a sequence's frames on a user-picked model, applying the
// ported skeletal transform math (skeletalAnimation.ts) per frame. Not
// real-time playback — ModelViewer rebuilds its whole Three.js scene per
// `data` change, too costly to do at animation framerate, so this is a
// frame-by-frame stepper instead (still shows the real deformation working).
export default function AnimationPlaybackViewer({ animation, rootHandle, onClose }: Props) {
  const [modelId, setModelId] = useState(0)
  const [model, setModel] = useState<ModelData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [posedModel, setPosedModel] = useState<ModelData | null>(null)
  const [status, setStatus] = useState<string>('')

  const frameSetCache = useRef(new Map<number, AnimationFrameSetData>())
  const frameBaseCache = useRef(new Map<number, AnimationFrameBaseDef>())

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

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Animation {animation.id} Preview</span>
        </div>
        <button type="button" className="model-toolbar-btn" onClick={onClose}>Close</button>
      </div>

      <section className="item-section">
        <h3>Model</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Model ID</span>
            <NumberInput value={modelId} onChange={setModelId} />
          </label>
        </div>
        <button type="button" className="add-row-btn" onClick={loadModel}>Load Model</button>
        {loadError && <p className="tex-op-note">{loadError}</p>}
      </section>

      {model && (
        <section className="item-section">
          <h3>Frame ({frameIndex + 1} / {frameCount})</h3>
          <div className="model-toolbar">
            <button type="button" className="model-toolbar-btn" disabled={frameIndex === 0} onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}>◂ Prev</button>
            <button type="button" className="model-toolbar-btn" disabled={frameIndex >= frameCount - 1} onClick={() => setFrameIndex((i) => Math.min(frameCount - 1, i + 1))}>Next ▸</button>
          </div>
          {status && <p className="tex-op-note">{status}</p>}
          {posedModel && <ModelViewer data={posedModel} />}
        </section>
      )}
    </div>
  )
}
