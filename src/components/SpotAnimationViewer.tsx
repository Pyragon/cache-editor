import { useEffect, useRef, useState } from 'react'
import type { SpotAnimationData, SpotAnimationDef } from '../loaders/spot_animations'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import { applyRecolor } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameSetData } from '../loaders/animation_frame_sets'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import ModelViewer from './ModelViewer'
import { NumberInput, NumGrid, PairTable } from './defFields'
import type { NumFieldDef } from './defFields'

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

  const [baseModel, setBaseModel] = useState<ModelData | null>(null)
  // Animated vertex positions applied in place by ModelViewer — the scene
  // itself is only rebuilt when baseModel changes, not per frame.
  const [posedVertices, setPosedVertices] = useState<PosedVertices | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [sequence, setSequence] = useState<AnimationDef | null>(null)
  const [status, setStatus] = useState('')

  const frameSetCache = useRef(new Map<number, AnimationFrameSetData>())
  const frameBaseCache = useRef(new Map<number, AnimationFrameBaseDef>())

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

  async function loadPreview() {
    if (!data.rootHandle) return
    setStatus('Loading model…')
    setBaseModel(null)
    setPosedVertices(null)
    setSequence(null)
    try {
      const modelsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('models'))
      const modelsLoader = getLoader('models')
      if (!modelsDir || !modelsLoader) throw new Error('models entry not available')
      const model = await modelsLoader.loadItem(modelsDir, { id: draft.modelId, name: `${draft.modelId}` }, data.rootHandle) as ModelData

      if (draft.originalColours) {
        applyRecolor(model, draft.originalColours, draft.modifiedColours ?? [], draft.originalTextures ?? [], draft.modifiedTextures ?? [])
      }
      setBaseModel(model)

      if (draft.sequenceId >= 0) {
        const seqDir = await resolveEntryHandle(data.rootHandle, getEntryPath('animations'))
        const seqLoader = getLoader('animations')
        if (seqDir && seqLoader) {
          const seqData = await seqLoader.loadItem(seqDir, { id: draft.sequenceId, name: `${draft.sequenceId}` }, data.rootHandle) as { def: AnimationDef }
          setSequence(seqData.def)
          setFrameIndex(0)
        }
      }
      setStatus('')
    } catch {
      setStatus(`Couldn't load model ${draft.modelId}.`)
    }
  }

  async function poseFrame(index: number) {
    if (!baseModel || !sequence || !data.rootHandle) { setPosedVertices(null); return }
    const setId = sequence.frameSetIds?.[index]
    if (setId == null) return
    const fileId = frameFileId(sequence, index)

    try {
      let frameSet = frameSetCache.current.get(setId)
      if (!frameSet) {
        const dir = await resolveEntryHandle(data.rootHandle, getEntryPath('animation_frame_sets'))
        const loader = getLoader('animation_frame_sets')
        if (!dir || !loader) throw new Error('animation_frame_sets entry not available')
        frameSet = await loader.loadItem(dir, { id: setId, name: `${setId}` }, data.rootHandle) as AnimationFrameSetData
        frameSetCache.current.set(setId, frameSet)
      }
      const frame = frameSet.frames.get(fileId)
      if (!frame || frame.rawFallbackBytes) { setStatus('Frame unavailable.'); setPosedVertices(null); return }

      let frameBase = frameBaseCache.current.get(frame.frameBaseId)
      if (!frameBase) {
        const dir = await resolveEntryHandle(data.rootHandle, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const fbData = await loader.loadItem(dir, { id: frame.frameBaseId, name: `${frame.frameBaseId}` }, data.rootHandle) as { def: AnimationFrameBaseDef }
        frameBase = fbData.def
        frameBaseCache.current.set(frame.frameBaseId, frameBase)
      }

      const posed = applyAnimationFrame(baseModel, frameBase, frame)
      setPosedVertices(posed)
    } catch {
      setPosedVertices(null)
    }
  }

  useEffect(() => {
    if (baseModel) poseFrame(frameIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseModel, sequence, frameIndex])

  const frameCount = sequence?.frameDurations?.length ?? 0

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Spot Animation {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Model &amp; Sequence</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Model ID</span>
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
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Ground Contour</h3>
        <p className="tex-op-note">How the mesh height-blends to terrain (blood, scorch marks). Type 0 = none.</p>
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

      <section className="item-section">
        <h3>Preview</h3>
        <button type="button" className="add-row-btn" onClick={loadPreview}>Load Preview</button>
        {status && <p className="tex-op-note">{status}</p>}
        {sequence && frameCount > 0 && (
          <div className="model-toolbar">
            <span className="item-stack-index">Frame {frameIndex + 1} / {frameCount}</span>
            <button type="button" className="model-toolbar-btn" disabled={frameIndex === 0} onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}>◂ Prev</button>
            <button type="button" className="model-toolbar-btn" disabled={frameIndex >= frameCount - 1} onClick={() => setFrameIndex((i) => Math.min(frameCount - 1, i + 1))}>Next ▸</button>
          </div>
        )}
        {baseModel && <ModelViewer data={baseModel} posedVertices={posedVertices} />}
      </section>

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
