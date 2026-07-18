import { Fragment, useEffect, useState } from 'react'
import type { AnimationFrameSetData, AnimationFrameDef } from '../loaders/animation_frame_sets'
import { NumberInput } from './defFields'

type Props = {
  data: AnimationFrameSetData
  onSave: (data: AnimationFrameSetData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

// A frame set holds every keyframe (AnimationFrame) sharing one frame-base
// skeleton, indexed by raw file id. Each frame is a sparse list of
// per-transform-slot deltas — shown here as an expandable table per frame
// rather than a single flat editor, since a frame base can have upward of
// a hundred slots and most frames only touch a handful of them.
export default function AnimationFrameSetViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const [draft, setDraft] = useState<Map<number, AnimationFrameDef>>(data.frames)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    setDraft(data.frames)
    setIsDirty(false)
    setExpanded(null)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function setFrame(fileId: number, patch: Partial<AnimationFrameDef>) {
    setDraft((prev) => {
      const next = new Map(prev)
      const frame = next.get(fileId)
      if (!frame) return prev
      next.set(fileId, { ...frame, ...patch })
      return next
    })
    setIsDirty(true)
  }

  function setTransform(fileId: number, i: number, key: 'transformationX' | 'transformationY' | 'transformationZ' | 'transformationFlags', value: number) {
    const frame = draft.get(fileId)
    if (!frame) return
    const arr = frame[key].slice()
    arr[i] = value
    setFrame(fileId, { [key]: arr } as Partial<AnimationFrameDef>)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, frames: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const fileIds = [...draft.keys()].sort((a, b) => a - b)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Frame Set {data.id}</span>
          <span className="item-stack-index">{fileIds.length} frames</span>
        </div>
      </div>

      <section className="item-section">
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th></th><th>File ID</th><th>Frame Base</th><th>Transforms</th><th>Flags</th></tr>
            </thead>
            <tbody>
              {fileIds.map((fileId) => {
                const frame = draft.get(fileId)!
                const broken = frame.rawFallbackBytes != null
                return (
                  <Fragment key={fileId}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="field-link-btn"
                          onClick={() => setExpanded(expanded === fileId ? null : fileId)}
                          disabled={broken}
                        >
                          {expanded === fileId ? '▾' : '▸'}
                        </button>
                      </td>
                      <td className="item-stack-index">{fileId}</td>
                      <td>
                        {frame.frameBaseId}
                        {onNavigate && (
                          <button type="button" className="field-link-btn" onClick={() => onNavigate('animation_frame_bases', frame.frameBaseId)}>View</button>
                        )}
                      </td>
                      <td className="item-stack-index">{broken ? 'unreadable (orphaned frame base)' : frame.transformationCount}</td>
                      <td className="item-stack-index">
                        {[frame.modifiesAlpha && 'alpha', frame.modifiesColor && 'colour', frame.aBool988 && 'billboard'].filter(Boolean).join(', ') || '—'}
                      </td>
                    </tr>
                    {expanded === fileId && !broken && (
                      <tr>
                        <td colSpan={5}>
                          <div className="quest-table-wrap">
                            <table className="quest-table">
                              <thead>
                                <tr><th>Slot</th><th>X</th><th>Y</th><th>Z</th><th>Flags</th><th>Skip Ref</th></tr>
                              </thead>
                              <tbody>
                                {frame.transformationIndices.map((slot, i) => (
                                  <tr key={i}>
                                    <td className="item-stack-index">{slot}</td>
                                    <td><NumberInput className="cell-input" value={frame.transformationX[i]} onChange={(v) => setTransform(fileId, i, 'transformationX', v)} /></td>
                                    <td><NumberInput className="cell-input" value={frame.transformationY[i]} onChange={(v) => setTransform(fileId, i, 'transformationY', v)} /></td>
                                    <td><NumberInput className="cell-input" value={frame.transformationZ[i]} onChange={(v) => setTransform(fileId, i, 'transformationZ', v)} /></td>
                                    <td><NumberInput className="cell-input" value={frame.transformationFlags[i]} onChange={(v) => setTransform(fileId, i, 'transformationFlags', v)} min={0} max={3} /></td>
                                    <td className="item-stack-index">{frame.skippedReferences[i]}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.frames); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
