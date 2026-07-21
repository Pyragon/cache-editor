import { useEffect, useRef, useState } from 'react'
import { loadModelComposite } from '../loaders/npcComposite'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { useSequencePlayback } from './useSequencePlayback'
import { IntListInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { CameraState } from './ModelViewer'
import './AnimationViewer.css'

type Props = {
  animation: AnimationDef
  rootHandle?: FileSystemDirectoryHandle
  /** Pre-fill and auto-load these models (e.g. from a compatible-NPC row).
   *  Several ids are merged into one composite before animating — part
   *  models share skin labels on the same skeleton, so the combined mesh
   *  poses as one (submesh-gated transforms excepted, see TODO). */
  initialModelIds?: number[]
  onClose: () => void
}

// Modal that plays a sequence's frames on a chosen model (or a merged set of
// part models) through the shared useSequencePlayback hook (skeletal
// transform math per frame, posed vertices applied in place to the live
// scene — the scene is built once per model load, so playback runs at the
// animation's real per-frame durations).
export default function AnimationPlaybackViewer({ animation, rootHandle, initialModelIds, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [modelIds, setModelIds] = useState<number[]>(initialModelIds ?? [])
  const [model, setModel] = useState<ModelData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Orbit rotation survives model reloads (which do rebuild the scene).
  const cameraStateRef = useRef<CameraState | null>(null)

  const { posedVertices, status, frameIndex, setFrameIndex, frameCount, playing, setPlaying } =
    useSequencePlayback(animation, model, rootHandle)

  async function loadModel() {
    if (!rootHandle) return
    const ids = modelIds.filter((id) => id >= 0)
    if (ids.length === 0) return
    setLoadError(null)
    setModel(null)
    try {
      // loadModelComposite merges multi-part sets AND upscales pre-v13
      // parts (<<2) like the client does before animating — anim deltas
      // are in that upscaled space.
      const data = await loadModelComposite(rootHandle, { modelIds: ids })
      if (!data.vertexSkins) {
        setLoadError(`Model${ids.length > 1 ? 's' : ''} ${ids.join(', ')} ha${ids.length > 1 ? 've' : 's'} no skeletal skin data (vertexSkins) — can't be animated.`)
        return
      }
      setModel(data)
    } catch {
      setLoadError(`Couldn't load model${ids.length > 1 ? 's' : ''} ${ids.join(', ')}.`)
    }
  }

  useEffect(() => {
    dialogRef.current?.showModal()
    if (initialModelIds?.length) loadModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          <span className="sprite-zoom-label">Model(s)</span>
          <IntListInput value={modelIds.length > 0 ? modelIds : undefined} onChange={(v) => setModelIds(v ?? [])} placeholder="model ids, comma-separated" />
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
