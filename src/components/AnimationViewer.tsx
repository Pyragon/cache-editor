import { useEffect, useState } from 'react'
import type { AnimationData, AnimationDef } from '../loaders/animations'
import { frameFileId, setFrameRef } from '../loaders/animations'
import { NumberInput, NumGrid, IntListInput } from './defFields'
import type { NumFieldDef } from './defFields'
import AnimationPlaybackViewer from './AnimationPlaybackViewer'

const GENERAL_FIELDS: NumFieldDef[] = [
  ['priority', 'Priority'],
  ['maxLoops', 'Max Loops'],
  ['loopDelay', 'Loop Delay'],
  ['replayMode', 'Replay Mode'],
  ['animatingPrecedence', 'Animating Precedence'],
  ['walkingPrecedence', 'Walking Precedence'],
]

type Props = {
  data: AnimationData
  onSave: (data: AnimationData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

export default function AnimationViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<AnimationDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showPlayback, setShowPlayback] = useState(false)

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

  function setFrameDuration(i: number, value: number) {
    setDraft((prev) => {
      const frameDurations = (prev.frameDurations ?? []).slice()
      frameDurations[i] = value
      return { ...prev, frameDurations }
    })
    setIsDirty(true)
  }

  function setFrame(i: number, frameSetId: number, fileId: number) {
    setDraft((prev) => setFrameRef(prev, i, frameSetId, fileId))
    setIsDirty(true)
  }

  function addFrame() {
    setDraft((prev) => {
      const frameDurations = [...(prev.frameDurations ?? []), 20]
      const frameSetIds = [...(prev.frameSetIds ?? []), 0]
      const frameHashes = [...(prev.frameHashes ?? []), 0]
      return { ...prev, frameDurations, frameSetIds, frameHashes }
    })
    setIsDirty(true)
  }

  function removeFrame(i: number) {
    setDraft((prev) => ({
      ...prev,
      frameDurations: (prev.frameDurations ?? []).filter((_, idx) => idx !== i),
      frameSetIds: (prev.frameSetIds ?? []).filter((_, idx) => idx !== i),
      frameHashes: (prev.frameHashes ?? []).filter((_, idx) => idx !== i),
    }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const frameCount = draft.frameDurations?.length ?? 0
  const totalMs = (draft.frameDurations ?? []).reduce((sum, d) => sum + d * 20, 0)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Animation {data.id}</span>
          <span className="item-stack-index">{frameCount} frames · {totalMs}ms</span>
        </div>
        <button type="button" className="model-toolbar-btn" onClick={() => setShowPlayback(true)} disabled={frameCount === 0}>
          Preview on Model…
        </button>
      </div>

      {showPlayback && (
        <AnimationPlaybackViewer animation={draft} rootHandle={data.rootHandle} onClose={() => setShowPlayback(false)} />
      )}

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Held Items</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className={`item-field-label${onNavigate ? ' field-link-label' : ''}`}>
              <span>Left Hand Item</span>
              {onNavigate && draft.leftHandItem !== 65535 && (
                <button type="button" className="field-link-btn" onClick={() => onNavigate('items', draft.leftHandItem)}>View</button>
              )}
            </span>
            <NumberInput value={draft.leftHandItem} onChange={(v) => set('leftHandItem', v)} />
          </label>
          <label className="item-field">
            <span className={`item-field-label${onNavigate ? ' field-link-label' : ''}`}>
              <span>Right Hand Item</span>
              {onNavigate && draft.rightHandItem !== 65535 && (
                <button type="button" className="field-link-btn" onClick={() => onNavigate('items', draft.rightHandItem)}>View</button>
              )}
            </span>
            <NumberInput value={draft.rightHandItem} onChange={(v) => set('rightHandItem', v)} />
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <div className="item-grid">
          {(['lights', 'tweened', 'vorbis'] as const).map((key) => (
            <label key={key} className="item-field def-toggle-field">
              <span className="item-field-label">{key}</span>
              <span className="sprite-toggle">
                <input type="checkbox" checked={draft[key]} onChange={(e) => set(key, e.target.checked)} />
                <span className="sprite-toggle-track" />
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="item-section">
        <h3>Frames ({frameCount})</h3>
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>#</th><th>Duration (ticks)</th><th>Frame Set</th><th>File ID</th><th></th></tr>
            </thead>
            <tbody>
              {(draft.frameDurations ?? []).map((duration, i) => (
                <tr key={i}>
                  <td className="item-stack-index">{i}</td>
                  <td><NumberInput className="cell-input" value={duration} onChange={(v) => setFrameDuration(i, v)} min={0} /></td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={draft.frameSetIds?.[i] ?? 0}
                      onChange={(v) => setFrame(i, v, frameFileId(draft, i))}
                    />
                    {onNavigate && (
                      <button type="button" className="field-link-btn" onClick={() => onNavigate('animation_frame_sets', draft.frameSetIds?.[i] ?? 0)}>View</button>
                    )}
                  </td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={frameFileId(draft, i)}
                      onChange={(v) => setFrame(i, draft.frameSetIds?.[i] ?? 0, v)}
                    />
                  </td>
                  <td><button type="button" className="row-remove-btn" onClick={() => removeFrame(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="add-row-btn" onClick={addFrame}>+ Add frame</button>
      </section>

      <section className="item-section">
        <h3>Interleave Order</h3>
        <p className="tex-op-note">Walk-cycle interruption points — which frame indices this animation can be safely interrupted/blended at.</p>
        <IntListInput
          value={draft.interLeaveOrder ? draft.interLeaveOrder.map((v, i) => (v ? i : -1)).filter((i) => i >= 0) : undefined}
          onChange={(v) => {
            if (!v) { set('interLeaveOrder', undefined); return }
            const arr = new Array(256).fill(false)
            for (const i of v) if (i >= 0 && i < 256) arr[i] = true
            set('interLeaveOrder', arr)
          }}
          placeholder="frame indices, comma-separated"
        />
      </section>

      <section className="item-section">
        <h3>Interface Frames</h3>
        <IntListInput value={draft.interfaceFrames} onChange={(v) => set('interfaceFrames', v)} placeholder="—" />
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
