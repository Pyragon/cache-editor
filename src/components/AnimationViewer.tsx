import { useEffect, useState } from 'react'
import type { AnimationData, AnimationDef } from '../loaders/animations'
import { frameFileId, setFrameRef } from '../loaders/animations'
import { buildAnimCompatIndex, peekAnimCompatIndex } from '../loaders/animCompat'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { NumberInput, NumGrid, IntListInput } from './defFields'
import type { NumFieldDef } from './defFields'
import { NpcFitTable, SpotFitTable } from './AnimCompatTables'
import AnimationPlaybackViewer from './AnimationPlaybackViewer'
import './AnimationViewer.css'

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
  // model the playback modal opens preloaded with (from a fit-table row)
  const [previewModelId, setPreviewModelId] = useState<number | null>(null)
  // null = still resolving, -1 = no frames / unresolvable
  const [skeleton, setSkeleton] = useState<number | null>(null)
  const [compatReady, setCompatReady] = useState(peekAnimCompatIndex() != null)
  const [compatProgress, setCompatProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  // Resolve this sequence's skeleton (frame base): from the compat index when
  // built, else a two-read direct lookup via its first frame set.
  useEffect(() => {
    setSkeleton(null)
    const index = peekAnimCompatIndex()
    if (index) {
      setSkeleton(index.seqBase.get(data.id) ?? -1)
      return
    }
    const firstSet = data.def.frameSetIds?.[0]
    if (firstSet == null || firstSet < 0 || !data.rootHandle) {
      setSkeleton(-1)
      return
    }
    let cancelled = false
    async function resolve() {
      try {
        const frameSetsDir = await resolveEntryHandle(data.rootHandle!, getEntryPath('animation_frame_sets'))
        const setDir = await frameSetsDir!.getDirectoryHandle(String(firstSet))
        for await (const handle of setDir.values()) {
          if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
          const frame = JSON.parse(await (await handle.getFile()).text()) as { frameBaseId?: number }
          if (!cancelled) setSkeleton(frame.frameBaseId ?? -1)
          return
        }
        if (!cancelled) setSkeleton(-1)
      } catch {
        if (!cancelled) setSkeleton(-1)
      }
    }
    resolve()
    return () => { cancelled = true }
  }, [data, compatReady])

  async function handleCompatScan() {
    if (!data.rootHandle) return
    setCompatProgress({ done: 0, total: 0 })
    try {
      await buildAnimCompatIndex(data.rootHandle, (done, total) => setCompatProgress({ done, total }))
      setCompatReady(true)
    } finally {
      setCompatProgress(null)
    }
  }

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
          {skeleton != null && skeleton >= 0 && (
            <button
              type="button"
              className="anim-skeleton-chip"
              title={`This sequence is rigged against frame base ${skeleton} — click to open it`}
              onClick={() => onNavigate?.('animation_frame_bases', skeleton)}
            >
              skeleton {skeleton}
            </button>
          )}
        </div>
        <button
          type="button"
          className="model-toolbar-btn"
          onClick={() => { setPreviewModelId(null); setShowPlayback(true) }}
          disabled={frameCount === 0}
        >
          Preview on Model…
        </button>
      </div>

      {showPlayback && (
        <AnimationPlaybackViewer
          animation={draft}
          rootHandle={data.rootHandle}
          initialModelId={previewModelId ?? undefined}
          onClose={() => setShowPlayback(false)}
        />
      )}

      <section className="item-section">
        <h3>Frames ({frameCount})</h3>
        {frameCount > 1 && (
          <div className="anim-timeline" title="One segment per frame, width = duration. Amber underline = interruption point. Click a segment to jump to its row.">
            {(draft.frameDurations ?? []).map((duration, i) => (
              <button
                key={i}
                type="button"
                className={`anim-timeline-seg${draft.interLeaveOrder?.[i] ? ' interruptible' : ''}`}
                style={{ flexGrow: Math.max(1, duration) }}
                title={`Frame ${i} — ${duration} ticks (${duration * 20}ms) · set ${draft.frameSetIds?.[i] ?? 0} file ${frameFileId(draft, i)}`}
                onClick={() => document.getElementById(`anim-frame-row-${data.id}-${i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
              />
            ))}
          </div>
        )}
        <div className="quest-table-wrap anim-frames-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>#</th><th>Duration (ticks)</th><th>Frame Set</th><th>File ID</th><th></th></tr>
            </thead>
            <tbody>
              {(draft.frameDurations ?? []).map((duration, i) => (
                <tr key={i} id={`anim-frame-row-${data.id}-${i}`}>
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
        <h3>Playback Settings</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
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

      <details className="item-unknown anim-advanced">
        <summary>Advanced — interleave order & interface frames</summary>
        <section className="item-section">
          <h3>Interleave Order</h3>
          <p className="tex-op-note">Walk-cycle interruption points — which frame indices this animation can be safely interrupted/blended at (also marked amber on the timeline).</p>
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
      </details>

      <section className="item-section">
        <h3>Skeleton & Compatible Models</h3>
        <p className="map-sprite-hint">
          {skeleton == null ? (
            'Resolving skeleton…'
          ) : skeleton < 0 ? (
            'No skeleton — this sequence has no frames (or its frame set is unreadable).'
          ) : (
            <>
              Rigged against frame base{' '}
              {onNavigate ? (
                <button type="button" className="field-link-btn" title={`Open frame base ${skeleton}`} onClick={() => onNavigate('animation_frame_bases', skeleton)}>
                  {skeleton}
                </button>
              ) : (
                skeleton
              )}
              {' '}— it fits exactly the models skinned for that skeleton. The lists below are the
              client's own pairings on this skeleton (spot anims pair model+sequence directly; NPCs
              pair their models with a BAS whose sequences share it).
            </>
          )}
        </p>
        {skeleton != null && skeleton >= 0 && (
          compatProgress != null ? (
            <p className="map-sprite-none">
              Scanning… {compatProgress.done.toLocaleString()}{compatProgress.total > 0 ? ` / ${compatProgress.total.toLocaleString()}` : ''}
            </p>
          ) : !compatReady ? (
            <div className="map-sprite-uses-scan">
              <button type="button" className="cursor-pick-btn" disabled={!data.rootHandle} onClick={handleCompatScan}>
                Scan compatibility
              </button>
              <span className="map-sprite-hint">reads animations, frame sets, bas, npcs, items and spot anims (~68k files) once, then cached for the session</span>
            </div>
          ) : (() => {
            const index = peekAnimCompatIndex()!
            const sharedSeqs = index.baseSeqs.get(skeleton)?.length ?? 0
            return (
              <>
                <p className="map-sprite-hint">{sharedSeqs.toLocaleString()} sequence{sharedSeqs === 1 ? '' : 's'} share this skeleton.</p>
                <h4 className="anim-fit-subhead">NPCs on this skeleton</h4>
                <NpcFitTable
                  npcs={index.npcsByBase.get(skeleton) ?? []}
                  emptyText="No NPC's BAS uses a sequence on this skeleton."
                  onNavigate={onNavigate}
                  onPreviewAnim={(npc) => {
                    setPreviewModelId(npc.modelIds[0])
                    setShowPlayback(true)
                  }}
                />
                <h4 className="anim-fit-subhead">Spot anim pairings on this skeleton</h4>
                <SpotFitTable
                  spots={index.spotsByBase.get(skeleton) ?? []}
                  emptyText="No spot anim uses a sequence on this skeleton."
                  onNavigate={onNavigate}
                />
              </>
            )
          })()
        )}
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
