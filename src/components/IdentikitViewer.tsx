import { useEffect, useState } from 'react'
import type { IdentikitData, IdentikitDef } from '../loaders/config/identikit'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import { mergeModels, applyRecolor } from '../loaders/models'
import ModelViewer from './ModelViewer'
import PlayerPreviewViewer from './PlayerPreviewViewer'
import { NumberInput, NumGrid, IntListInput, PairTable } from './defFields'
import type { NumFieldDef } from './defFields'

const GENERAL_FIELDS: NumFieldDef[] = [
  ['category', 'Category'],
]

const HEAD_SLOT_COUNT = 5

type PreviewState = { loading: boolean; data: ModelData | null; error: boolean }

export default function IdentikitViewer({ data, onSave, onDirtyChange }: {
  data: IdentikitData
  onSave: (data: IdentikitData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState<IdentikitDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [bodyPreview, setBodyPreview] = useState<PreviewState>({ loading: false, data: null, error: false })
  const [headPreview, setHeadPreview] = useState<PreviewState>({ loading: false, data: null, error: false })
  const [showPlayerPreview, setShowPlayerPreview] = useState(false)

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

  function setHeadModel(slot: number, value: number) {
    setDraft((prev) => {
      const headModels = (prev.headModels ?? [-1, -1, -1, -1, -1]).slice()
      headModels[slot] = value
      return { ...prev, headModels }
    })
    setIsDirty(true)
  }

  function setRecolorPair(index: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).slice()
      const replacementColours = (prev.replacementColours ?? []).slice()
      if (which === 0) originalColours[index] = value
      else replacementColours[index] = value
      return { ...prev, originalColours, replacementColours }
    })
    setIsDirty(true)
  }

  function addRecolorPair() {
    setDraft((prev) => ({
      ...prev,
      originalColours: [...(prev.originalColours ?? []), 0],
      replacementColours: [...(prev.replacementColours ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRecolorPair(index: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).filter((_, i) => i !== index)
      const replacementColours = (prev.replacementColours ?? []).filter((_, i) => i !== index)
      return {
        ...prev,
        originalColours: originalColours.length > 0 ? originalColours : undefined,
        replacementColours: replacementColours.length > 0 ? replacementColours : undefined,
      }
    })
    setIsDirty(true)
  }

  function setRetexturePair(index: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const originalTextures = (prev.originalTextures ?? []).slice()
      const replacementTextures = (prev.replacementTextures ?? []).slice()
      if (which === 0) originalTextures[index] = value
      else replacementTextures[index] = value
      return { ...prev, originalTextures, replacementTextures }
    })
    setIsDirty(true)
  }

  function addRetexturePair() {
    setDraft((prev) => ({
      ...prev,
      originalTextures: [...(prev.originalTextures ?? []), 0],
      replacementTextures: [...(prev.replacementTextures ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRetexturePair(index: number) {
    setDraft((prev) => {
      const originalTextures = (prev.originalTextures ?? []).filter((_, i) => i !== index)
      const replacementTextures = (prev.replacementTextures ?? []).filter((_, i) => i !== index)
      return {
        ...prev,
        originalTextures: originalTextures.length > 0 ? originalTextures : undefined,
        replacementTextures: replacementTextures.length > 0 ? replacementTextures : undefined,
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

  // Loads and merges a set of model ids into one composite ModelData with
  // this identikit's recolor/retexture pairs applied — mirrors cryogen's
  // IdentiKitDefinitions.renderBody()/renderHead().
  async function loadComposite(modelIds: number[], setState: (s: PreviewState) => void) {
    if (modelIds.length === 0 || !data.rootHandle) { setState({ loading: false, data: null, error: false }); return }
    setState({ loading: true, data: null, error: false })
    try {
      const modelsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('models'))
      const loader = getLoader('models')
      if (!modelsDir || !loader) throw new Error('models entry not available')
      const parts = await Promise.all(modelIds.map((id) =>
        loader.loadItem(modelsDir, { id, name: `${id}` }, data.rootHandle) as Promise<ModelData>,
      ))
      const merged = mergeModels(parts)
      if (draft.originalColours) {
        applyRecolor(
          merged,
          draft.originalColours, draft.replacementColours ?? [],
          draft.originalTextures ?? [], draft.replacementTextures ?? [],
        )
      }
      setState({ loading: false, data: merged, error: false })
    } catch {
      setState({ loading: false, data: null, error: true })
    }
  }

  useEffect(() => {
    loadComposite(draft.bodyModels ?? [], setBodyPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.bodyModels, draft.originalColours, draft.replacementColours, draft.originalTextures, draft.replacementTextures, data.rootHandle])

  useEffect(() => {
    const heads = (draft.headModels ?? []).filter((id) => id >= 0)
    loadComposite(heads, setHeadPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.headModels, draft.originalColours, draft.replacementColours, draft.originalTextures, draft.replacementTextures, data.rootHandle])

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Identikit {data.id}</span>
        </div>
        <button type="button" className="model-toolbar-btn" onClick={() => setShowPlayerPreview(true)}>
          Preview Full Player…
        </button>
      </div>

      {showPlayerPreview && (
        <PlayerPreviewViewer rootHandle={data.rootHandle} onClose={() => setShowPlayerPreview(false)} />
      )}

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Body Models</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Model IDs (merge into one composite)</span>
          <IntListInput
            value={draft.bodyModels}
            onChange={(v) => set('bodyModels', v)}
            placeholder="body model ids, comma-separated"
          />
        </div>
      </section>

      <section className="item-section">
        <h3>Head Models</h3>
        <div className="item-grid">
          {Array.from({ length: HEAD_SLOT_COUNT }, (_, i) => (
            <label key={i} className="item-field">
              <span className="item-field-label">Slot {i}</span>
              <NumberInput value={draft.headModels?.[i] ?? -1} onChange={(v) => setHeadModel(i, v)} />
            </label>
          ))}
        </div>
      </section>

      <PairTable
        title="Recolour Pairs"
        srcLabel="Original HSL"
        dstLabel="Replacement HSL"
        src={draft.originalColours ?? []}
        dst={draft.replacementColours ?? []}
        onSet={setRecolorPair}
        onAdd={addRecolorPair}
        onRemove={removeRecolorPair}
      />

      <PairTable
        title="Retexture Pairs"
        srcLabel="Original Texture"
        dstLabel="Replacement Texture"
        src={draft.originalTextures ?? []}
        dst={draft.replacementTextures ?? []}
        onSet={setRetexturePair}
        onAdd={addRetexturePair}
        onRemove={removeRetexturePair}
      />

      {(draft.bodyModels?.length ?? 0) > 0 && (
        <section className="item-section">
          <h3>Body Preview</h3>
          {bodyPreview.loading && <p className="tex-op-note">Loading…</p>}
          {bodyPreview.error && <p className="tex-op-note">Couldn't load one or more body models.</p>}
          {bodyPreview.data && <ModelViewer data={bodyPreview.data} />}
        </section>
      )}

      {(draft.headModels?.some((id) => id >= 0) ?? false) && (
        <section className="item-section">
          <h3>Head Preview</h3>
          {headPreview.loading && <p className="tex-op-note">Loading…</p>}
          {headPreview.error && <p className="tex-op-note">Couldn't load one or more head models.</p>}
          {headPreview.data && <ModelViewer data={headPreview.data} />}
        </section>
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
