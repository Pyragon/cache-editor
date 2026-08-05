import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnimationData, AnimationDef } from '../loaders/animations'
import { frameFileId, setFrameRef } from '../loaders/animations'
import { buildAnimCompatIndex, peekAnimCompatIndex } from '../loaders/animCompat'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { NumberInput, NumGrid, IntListInput } from './defFields'
import { SoundPlayerCell } from './SoundPlayerCell'
import { InstrumentPlayerCell } from './InstrumentPlayerCell'
import type { NumFieldDef } from './defFields'
import { NpcFitTable, SpotFitTable } from './AnimCompatTables'
import AnimationPlaybackViewer from './AnimationPlaybackViewer'
import AnimationStudio from './AnimationStudio'
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
  const hoveredFrameRef = useRef<number | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showPlayback, setShowPlayback] = useState(false)
  const [studio, setStudio] = useState(false)
  // model the playback modal opens preloaded with (from a fit-table row)
  const [previewModelIds, setPreviewModelIds] = useState<number[] | null>(null)
  // null = still resolving, -1 = no frames / unresolvable
  const [skeleton, setSkeleton] = useState<number | null>(null)
  // Bumped when a scan completes; readiness itself is derived from
  // peekAnimCompatIndex() each render so a save that invalidates the index
  // (App does this for anim/bas/npc/item/spot saves) falls back to the scan
  // button instead of reading a vanished cache.
  const [compatVersion, setCompatVersion] = useState(0)
  const [compatProgress, setCompatProgress] = useState<ScanProgress | null>(null)

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
  }, [data, compatVersion])

  async function handleCompatScan() {
    if (!data.rootHandle) return
    setCompatProgress({ phase: 'indexing', done: 0, total: 0 })
    try {
      await buildAnimCompatIndex(data.rootHandle, setCompatProgress)
      setCompatVersion((v) => v + 1)
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

  // Per-frame sounds. soundSettings[frame][0] packs id/repeats/positionOffset
  // exactly as SequenceSoundPlayer:21-24 unpacks it; entries [1..] are
  // alternates the client picks between at random. Which index the ids name is
  // the `vorbis` flag's job — SequenceSoundPlayer:42 branches on it, sending
  // them to playSoundVorbis (midi_instruments) or playSoundSynth
  // (sound_effects).
  const soundEntry = draft.vorbis ? 'midi_instruments' : 'sound_effects'
  const frameSounds = useMemo(() => {
    const rows: { frame: number; id: number; repeats: number; volume: number; alternates: number[] }[] = []
    ;(draft.soundSettings ?? []).forEach((entry, frame) => {
      if (!entry || entry.length === 0) return
      const packed = entry[0]
      rows.push({
        frame,
        id: packed >> 8,
        repeats: (packed >> 5) & 0x7,
        volume: draft.frameSoundVolume?.[frame] ?? 255,
        alternates: entry.slice(1),
      })
    })
    return rows
  }, [draft])

  const frameCount = draft.frameDurations?.length ?? 0
  const totalMs = (draft.frameDurations ?? []).reduce((sum, d) => sum + d * 20, 0)

  // Hovering a timeline segment highlights its table row and vice versa. Done
  // by toggling a class on exactly two nodes rather than through state: the
  // longest animation here has 400 frames, and re-rendering 1,200 number
  // inputs on every pointer move between segments visibly stutters.
  const segId = (i: number) => `anim-frame-seg-${data.id}-${i}`
  const rowId = (i: number) => `anim-frame-row-${data.id}-${i}`
  const setHoveredFrame = useCallback((index: number | null) => {
    const mark = (i: number, on: boolean) => {
      document.getElementById(`anim-frame-seg-${data.id}-${i}`)?.classList.toggle('linked-hover', on)
      document.getElementById(`anim-frame-row-${data.id}-${i}`)?.classList.toggle('linked-hover', on)
    }
    if (hoveredFrameRef.current === index) return
    if (hoveredFrameRef.current != null) mark(hoveredFrameRef.current, false)
    hoveredFrameRef.current = index
    if (index != null) mark(index, true)
  }, [data.id])

  // React doesn't know about the class above, so it survives a re-render that
  // shifts the rows — clear it whenever the frame list changes underneath it.
  useEffect(() => { setHoveredFrame(null) }, [data.id, frameCount, setHoveredFrame])

  // The studio takes the whole page: it is a different way of working on the
  // same animation, not a panel within the field editor.
  if (studio) return <AnimationStudio data={data} onClose={() => setStudio(false)} />

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Animation {data.id}</span>
          <button
            type="button"
            className="anim-skeleton-chip"
            title="Pose this animation on a model instead of editing its fields"
            onClick={() => setStudio(true)}
          >
            Open in studio
          </button>
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
          onClick={() => { setPreviewModelIds(null); setShowPlayback(true) }}
          disabled={frameCount === 0}
        >
          Preview on Model…
        </button>
      </div>

      {showPlayback && (
        <AnimationPlaybackViewer
          animation={draft}
          rootHandle={data.rootHandle}
          initialModelIds={previewModelIds ?? undefined}
          onClose={() => setShowPlayback(false)}
        />
      )}

      <section className="item-section">
        <h3>Frames ({frameCount})</h3>
        {frameCount > 1 && (
          <div
            className="anim-timeline"
            title="One segment per frame, width = duration. Amber underline = interruption point. Hover to highlight its row; click to jump to it."
            onMouseLeave={() => setHoveredFrame(null)}
          >
            {(draft.frameDurations ?? []).map((duration, i) => (
              <button
                key={i}
                id={segId(i)}
                type="button"
                className={`anim-timeline-seg${draft.interLeaveOrder?.[i] ? ' interruptible' : ''}`}
                style={{ flexGrow: Math.max(1, duration) }}
                title={`Frame ${i} — ${duration} ticks (${duration * 20}ms) · set ${draft.frameSetIds?.[i] ?? 0} file ${frameFileId(draft, i)}`}
                onMouseEnter={() => setHoveredFrame(i)}
                // keyboard tabbing gets the link too; blur fires before the
                // next focus, so the early-return keeps it from flickering
                onFocus={() => setHoveredFrame(i)}
                onBlur={() => setHoveredFrame(null)}
                onClick={() => document.getElementById(rowId(i))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
              />
            ))}
          </div>
        )}
        <div className="quest-table-wrap anim-frames-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>#</th><th>Duration (ticks)</th><th>Frame Set</th><th>File ID</th><th></th></tr>
            </thead>
            <tbody onMouseLeave={() => setHoveredFrame(null)}>
              {(draft.frameDurations ?? []).map((duration, i) => (
                <tr key={i} id={rowId(i)} onMouseEnter={() => setHoveredFrame(i)}>
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


      {frameSounds.length > 0 && (
        <section className="item-section">
          <h3>Frame Sounds — {frameSounds.length}</h3>
          <p className="tex-op-note">
            Played as the animation reaches each frame. The packed value carries the sound id, how many times it
            repeats, and a position offset; where a frame lists alternates the client picks one at random, so the
            same swing doesn't sound identical twice.
            {' '}
            {draft.vorbis
              ? <>This animation has <code>vorbis</code> set, so the ids are <code>midi_instruments</code> samples.</>
              : <>Without <code>vorbis</code> set, the ids are <code>sound_effects</code> synth entries.</>}
          </p>
          <div className="quest-table-wrap">
            <table className="quest-table">
              <thead>
                <tr><th>Frame</th><th>Sound</th><th>Repeats</th><th>Volume</th><th>Alternates</th><th /></tr>
              </thead>
              <tbody>
                {frameSounds.map((s) => (
                  <tr key={s.frame}>
                    <td className="item-stack-index">{s.frame}</td>
                    <td>
                      {onNavigate
                        ? <button type="button" className="field-link-btn" onClick={() => onNavigate(soundEntry, s.id)}>{s.id}</button>
                        : s.id}
                    </td>
                    <td>{s.repeats}</td>
                    <td>{s.volume}</td>
                    <td>{s.alternates.length > 0 ? s.alternates.join(', ') : '—'}</td>
                    <td>
                      {data.rootHandle && (draft.vorbis
                        ? <InstrumentPlayerCell cacheRoot={data.rootHandle} soundId={s.id} />
                        : <SoundPlayerCell cacheRoot={data.rootHandle} soundId={s.id} />)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
              {scanLabel(compatProgress)}
            </p>
          ) : peekAnimCompatIndex() == null ? (
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
                    setPreviewModelIds(npc.modelIds)
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
