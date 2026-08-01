import { useEffect, useRef, useState } from 'react'
import type { SpotAnimationData, SpotAnimationDef } from '../loaders/spot_animations'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { loadModelComposite } from '../loaders/npcComposite'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import ModelViewer from './ModelViewer'
import type { CameraState, WorldRenderParams } from './ModelViewer'
import ModelPreviewModal from './ModelPreviewModal'
import { useSequencePlayback } from './useSequencePlayback'
import { NumberInput, NumGrid, PairTable } from './defFields'
import type { NumFieldDef } from './defFields'
import './SpotAnimationViewer.css'

const GENERAL_FIELDS: NumFieldDef[] = [
  ['scaleXZ', 'Scale XZ'],
  ['scaleY', 'Scale Y'],
  ['rotation', 'Rotation'],
  ['ambient', 'Ambient'],
  ['contrast', 'Contrast'],
]

const CONTOUR_FIELDS: NumFieldDef[] = [
  ['contourType', 'Contour Type'],
  ['contourModifier', 'Contour Modifier'],
]

type Props = {
  data: SpotAnimationData
  onSave: (data: SpotAnimationData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

export default function SpotAnimationViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<SpotAnimationDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [modelModal, setModelModal] = useState(false)

  const [model, setModel] = useState<ModelData | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sequence, setSequence] = useState<AnimationDef | null>(null)
  // Keeps the orbit across scene rebuilds — every scale/rotation/ambient edit
  // rebuilds the preview, and snapping back to the default view each keystroke
  // makes the panel unusable.
  const cameraStateRef = useRef<CameraState | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setRecolorPair(index: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).slice()
      const modifiedColours = (prev.modifiedColours ?? []).slice()
      if (which === 0) originalColours[index] = value
      else modifiedColours[index] = value
      return { ...prev, originalColours, modifiedColours }
    })
    setIsDirty(true)
  }

  function addRecolorPair() {
    setDraft((prev) => ({
      ...prev,
      originalColours: [...(prev.originalColours ?? []), 0],
      modifiedColours: [...(prev.modifiedColours ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRecolorPair(index: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).filter((_, i) => i !== index)
      const modifiedColours = (prev.modifiedColours ?? []).filter((_, i) => i !== index)
      return {
        ...prev,
        originalColours: originalColours.length > 0 ? originalColours : undefined,
        modifiedColours: modifiedColours.length > 0 ? modifiedColours : undefined,
      }
    })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  // --- Live preview -------------------------------------------------------
  // The mesh, with the def's recolour/retexture pairs baked in (the client
  // applies those to the rasterizer). Scale and rotation deliberately stay OUT
  // of the vertices: the client resizes and rotates AFTER posing, so they ride
  // ModelViewer's render transform instead.
  const modelKey = [
    draft.modelId,
    (draft.originalColours ?? []).join(','),
    (draft.modifiedColours ?? []).join(','),
    (draft.originalTextures ?? []).join(','),
    (draft.modifiedTextures ?? []).join(','),
  ].join('|')

  const rootHandle = data.rootHandle
  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    // Typing an id commits a digit at a time; without this every prefix
    // (1, 12, 123…) would fetch and decode a whole model.
    const timer = setTimeout(() => {
      ;(async () => {
        try {
          const merged = await loadModelComposite(rootHandle, {
            modelIds: [draft.modelId],
            recolor: {
              from: draft.originalColours,
              to: draft.modifiedColours,
              textureFrom: draft.originalTextures,
              textureTo: draft.modifiedTextures,
            },
          })
          if (cancelled) return
          setModel(merged)
          setModelError(null)
        } catch {
          if (cancelled) return
          setModel(null)
          setModelError(`Couldn't load model ${draft.modelId}.`)
        }
      })()
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
    // the pairs participate through modelKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, rootHandle])

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    setSequence(null)
    if (draft.sequenceId < 0) return
    ;(async () => {
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animations'))
        if (!dir) return
        const file = await (await dir.getFileHandle(`${draft.sequenceId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as AnimationDef
        if (!cancelled) setSequence(def)
      } catch { /* unresolvable sequence — the preview stays static */ }
    })()
    return () => { cancelled = true }
  }, [draft.sequenceId, rootHandle])

  const { posedVertices, status, frameIndex, setFrameIndex, frameCount, playing, setPlaying } =
    useSequencePlayback(sequence, model, rootHandle, true)

  function stepFrame(delta: number) {
    if (frameCount === 0) return
    setPlaying(false)
    setFrameIndex((i) => (i + delta + frameCount) % frameCount)
  }

  // Client SpotAnimationDefinitions.rasterize: createMeshRasterizer(…, ambient
  // + 64, contrast + 850), then resize(scaleXZ, scaleY, scaleXZ) and a 90/180/
  // 270-degree yaw — all after the animation pose.
  const world: WorldRenderParams = {
    ambient: draft.ambient,
    contrast: draft.contrast,
    scaleX: draft.scaleXZ,
    scaleY: draft.scaleY,
    scaleZ: draft.scaleXZ,
    rotation: draft.rotation,
  }

  return (
    <div className="item-viewer spotanim-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Spot Animation {data.id}</span>
        </div>
      </div>

      <div className="spotanim-layout">
        <div className="spotanim-main">
          <section className="item-section">
            <h3>Model &amp; Sequence</h3>
            <div className="item-grid">
              <label className="item-field">
                <span className={`item-field-label${rootHandle ? ' field-link-label' : ''}`}>
                  <span>Model ID</span>
                  {rootHandle && (
                    <button type="button" className="field-link-btn" onClick={() => setModelModal(true)}>View</button>
                  )}
                </span>
                <NumberInput value={draft.modelId} onChange={(v) => set('modelId', v)} />
              </label>
              <label className="item-field">
                <span className={`item-field-label${onNavigate ? ' field-link-label' : ''}`}>
                  <span>Sequence ID</span>
                  {onNavigate && draft.sequenceId >= 0 && (
                    <button type="button" className="field-link-btn" onClick={() => onNavigate('animations', draft.sequenceId)}>View</button>
                  )}
                </span>
                <NumberInput value={draft.sequenceId} onChange={(v) => set('sequenceId', v)} />
              </label>
              <label className="item-field def-toggle-field">
                <span className="item-field-label">Replay</span>
                <span className="sprite-toggle">
                  <input type="checkbox" checked={draft.replay} onChange={(e) => set('replay', e.target.checked)} />
                  <span className="sprite-toggle-track" />
                </span>
              </label>
            </div>
          </section>

          <section className="item-section">
            <h3>Display</h3>
            <p className="tex-op-note">
              Scales are 128ths. Rotation is degrees — only 90/180/270 do anything. Ambient brightens
              (<code>+64</code>); contrast <em>divides</em> the sun (<code>768/(contrast+850)</code>), so higher = flatter.
            </p>
            <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
          </section>

          <section className="item-section">
            <h3>Ground Contour</h3>
            <p className="tex-op-note">How the mesh height-blends to terrain (blood, scorch marks). Type 0 = none. Not previewed.</p>
            <NumGrid fields={CONTOUR_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
          </section>

          <PairTable
            title="Recolour Pairs"
            srcLabel="Original HSL"
            dstLabel="Replacement HSL"
            src={draft.originalColours ?? []}
            dst={draft.modifiedColours ?? []}
            onSet={setRecolorPair}
            onAdd={addRecolorPair}
            onRemove={removeRecolorPair}
          />
        </div>

        <aside className="spotanim-preview">
          {/* A peer of the field sections' headings, NOT of the page title —
              same font and same 10px gap to its body, so the card's top edge
              lands level with the first row of field cells. */}
          <div className="spotanim-preview-head">
            <h3>Preview</h3>
          </div>

          <div className="spotanim-preview-body">
            {!rootHandle && <p className="tex-op-note">Reopen the cache to enable the preview.</p>}
            {modelError && <p className="tex-op-note">{modelError}</p>}
            {rootHandle && !model && !modelError && <p className="tex-op-note">Loading model {draft.modelId}…</p>}
            {model && (
              <ModelViewer
                data={model}
                world={world}
                posedVertices={posedVertices}
                cameraStateRef={cameraStateRef}
                fitScale={2.8}
                hideHeader
              />
            )}
            <div className="model-toolbar spotanim-playback">
              <button
                type="button"
                className="model-toolbar-btn"
                disabled={frameCount === 0}
                title="Previous frame"
                onClick={() => stepFrame(-1)}
              >
                ◂◂
              </button>
              <button
                type="button"
                className={`model-toolbar-btn spotanim-play-btn${playing ? ' active' : ''}`}
                disabled={frameCount === 0}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button
                type="button"
                className="model-toolbar-btn"
                disabled={frameCount === 0}
                title="Next frame"
                onClick={() => stepFrame(1)}
              >
                ▸▸
              </button>
              {/* Beside the transport, not off in a corner — this is the one
                  number you watch while scrubbing. */}
              <span className="spotanim-frame-count">
                {frameCount > 0
                  ? `Frame ${frameIndex + 1} / ${frameCount}`
                  : draft.sequenceId < 0
                  ? 'Static'
                  : 'No frames'}
              </span>
            </div>
            <p className="spotanim-preview-meta">
              {frameCount > 0
                ? `Sequence ${draft.sequenceId}`
                : draft.sequenceId < 0
                ? 'No sequence — static model.'
                : `Sequence ${draft.sequenceId} has no frames.`}
              {status && ` · ${status}`}
            </p>
          </div>
        </aside>
      </div>

      {modelModal && rootHandle && (
        <ModelPreviewModal
          title={`Spot animation ${data.id} — model ${draft.modelId}`}
          modelIds={[draft.modelId]}
          recolor={{
            from: draft.originalColours,
            to: draft.modifiedColours,
            textureFrom: draft.originalTextures,
            textureTo: draft.modifiedTextures,
          }}
          scale={{ x: draft.scaleXZ, y: draft.scaleY, z: draft.scaleXZ }}
          sequenceId={draft.sequenceId >= 0 ? draft.sequenceId : undefined}
          rootHandle={rootHandle}
          openLabel={onNavigate ? 'Open in Models' : undefined}
          onOpen={onNavigate ? () => { setModelModal(false); onNavigate('models', draft.modelId) } : undefined}
          onClose={() => setModelModal(false)}
        />
      )}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
