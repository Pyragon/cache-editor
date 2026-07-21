import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { loadModelComposite } from '../loaders/npcComposite'
import type { ModelData } from '../loaders/models'
import type { AnimationDef } from '../loaders/animations'
import { useSequencePlayback } from './useSequencePlayback'
import { NumberInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { ModelDisplayParams } from './ModelViewer'
import './AnimationViewer.css' // reuses the .anim-preview-dialog modal styles

type Props = {
  title: string
  /** One id shows that model; several are merged into one composite (the way
   *  the client builds an NPC from its part models). */
  modelIds: number[]
  /** Per-model [x, y, z] vertex nudges, paired positionally with modelIds
   *  (NPC modelTranslation, opcode 121) — applied before merging. */
  translations?: (number[] | null)[]
  /** Recolour/retexture pairs applied to the (merged) mesh, e.g. an NPC's. */
  recolor?: { from?: number[]; to?: number[]; textureFrom?: number[]; textureTo?: number[] }
  /** NPC scaleXZ/scaleY (128 = unscaled) — client Model.scale, v·s >> 7. */
  scale?: { xz: number; y: number }
  /** NPC tint: each face HSL component blends toward the target by
   *  opacity/128 (client ModelSM.tint); ignored when opacity is 0, and a −1
   *  component leaves that channel untouched. */
  tint?: { hue: number; saturation: number; lightness: number; opacity: number }
  /** Hide skin-255 static marker faces (NPC composites — see npcComposite). */
  hideMarkerFaces?: boolean
  /** When set (≥ 0), this sequence auto-plays on the model — e.g. the NPC's
   *  BAS stand animation. Unresolvable sequences fall back to a static view. */
  sequenceId?: number
  /** Selectable sequences (the BAS's emotes) for the playback dropdown.
   *  Passing an array — even an empty one — also enables the "play any
   *  sequence id" field; omit to hide the playback toolbar entirely. */
  sequenceOptions?: { label: string; seqId: number }[]
  /** Item pose (inventory-icon display params); plain model when absent. */
  display?: ModelDisplayParams | null
  rootHandle: FileSystemDirectoryHandle
  /** Optional escape hatch, e.g. "Open in Models" / "Open Item". */
  openLabel?: string
  onOpen?: () => void
  /** When set, the part-model list under the playback rows renders each id
   *  as a jump link (multi-part composites only). */
  onOpenModelId?: (modelId: number) => void
  onClose: () => void
}

/** Modal wrapper around ModelViewer: quick model previews without navigating
 *  away from the page you're on (items page View Model, BAS item rows, NPC
 *  part/full-model views). */
export default function ModelPreviewModal({ title, modelIds, translations, recolor, scale, tint, hideMarkerFaces, display, rootHandle, sequenceId, sequenceOptions, openLabel, onOpen, onOpenModelId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [model, setModel] = useState<ModelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [animation, setAnimation] = useState<AnimationDef | null>(null)
  // The sequence currently loaded/playing (seqId) and which control row owns
  // it — the emote dropdown and the free "any sequence" field each have their
  // own play/pause button, so the source decides which one shows Pause.
  const [seqId, setSeqId] = useState<number | null>(sequenceId ?? null)
  const [seqSource, setSeqSource] = useState<'emote' | 'custom'>('emote')
  const [emoteSel, setEmoteSel] = useState<number | null>(sequenceId ?? null)
  const [customSeq, setCustomSeq] = useState(0)

  useEffect(() => {
    setSeqId(sequenceId ?? null)
    setEmoteSel(sequenceId ?? null)
    setSeqSource('emote')
  }, [sequenceId])

  useEffect(() => { dialogRef.current?.showModal() }, [])

  // Optional sequence (e.g. the NPC's BAS stand animation), auto-played once
  // both it and the model resolve. Failures just leave the view static.
  useEffect(() => {
    let cancelled = false
    setAnimation(null)
    if (seqId == null || seqId < 0) return
    ;(async () => {
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animations'))
        if (!dir) return
        const file = await (await dir.getFileHandle(`${seqId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as AnimationDef
        if (!cancelled) setAnimation(def)
      } catch { /* sequence unavailable — static preview */ }
    })()
    return () => { cancelled = true }
  }, [seqId, rootHandle])

  const { posedVertices, status, frameIndex, frameCount, playing, setPlaying } =
    useSequencePlayback(animation, model, rootHandle, true)

  // Keyed by the id list's VALUE — callers build the array inline, so the
  // identity changes every parent render and must not retrigger loads.
  const idsKey = modelIds.join(',')
  useEffect(() => {
    let cancelled = false
    setModel(null)
    setError(null)
    ;(async () => {
      try {
        // translate + merge + recolour + scale + tint, client order
        const merged = await loadModelComposite(rootHandle, { modelIds, translations, recolor, scale, tint, hideMarkerFaces })
        if (!cancelled) setModel(merged)
      } catch {
        if (!cancelled) setError(`Couldn't load model${modelIds.length > 1 ? 's' : ''} ${modelIds.join(', ')}.`)
      }
    })()
    return () => { cancelled = true }
    // modelIds participates via idsKey; translations/recolor come from the
    // same caller state object as the ids, so idsKey covers them too
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, rootHandle])

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">{title}</h3>
          <span className="anim-fit-actions">
            {onOpen && openLabel && (
              <button type="button" className="field-link-btn" onClick={onOpen}>{openLabel}</button>
            )}
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>

        {sequenceOptions != null && (() => {
          const emoteActive = seqSource === 'emote' && seqId != null && seqId === emoteSel
          const emotePlaying = emoteActive && playing && animation != null
          const customActive = seqSource === 'custom' && seqId != null && seqId === customSeq
          const customPlaying = customActive && playing && animation != null
          return (
            <div className="anim-preview-seq-grid">
              {sequenceOptions.length > 0 && (
                <>
                  <span className="sprite-zoom-label">Emote</span>
                  <select
                    className="item-stackable-select"
                    value={sequenceOptions.some((o) => o.seqId === emoteSel) ? String(emoteSel) : ''}
                    onChange={(e) => {
                      if (e.target.value === '') return
                      const picked = parseInt(e.target.value, 10)
                      setEmoteSel(picked)
                      // switching emotes mid-play jumps straight to the new one
                      if (seqSource === 'emote') setSeqId(picked)
                    }}
                  >
                    {!sequenceOptions.some((o) => o.seqId === emoteSel) && <option value="">—</option>}
                    {sequenceOptions.map((o) => (
                      <option key={o.label} value={o.seqId}>{o.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`zoom-btn anim-preview-play${emotePlaying ? ' active' : ''}`}
                    disabled={emoteSel == null}
                    onClick={() => {
                      if (emotePlaying) { setPlaying(false); return }
                      if (emoteActive && animation) { setPlaying(true); return }
                      if (emoteSel != null) { setSeqSource('emote'); setSeqId(emoteSel) }
                    }}
                  >
                    {emotePlaying ? '⏸ Pause' : '▶ Play'}
                  </button>
                </>
              )}
              <span className="sprite-zoom-label">Any sequence</span>
              <NumberInput value={customSeq} onChange={setCustomSeq} />
              <button
                type="button"
                className={`zoom-btn anim-preview-play${customPlaying ? ' active' : ''}`}
                disabled={customSeq < 0}
                onClick={() => {
                  if (customPlaying) { setPlaying(false); return }
                  if (customActive && animation) { setPlaying(true); return }
                  if (customSeq >= 0) { setSeqSource('custom'); setSeqId(customSeq) }
                }}
              >
                {customPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
            </div>
          )
        })()}

        {modelIds.length > 1 && (
          <p className="anim-preview-status anim-preview-parts">
            Built from {modelIds.length} models:{' '}
            <span className="anim-fit-models">
              {modelIds.map((id, i) => onOpenModelId ? (
                <button key={i} type="button" className="field-link-btn" title={`Open model ${id}`} onClick={() => onOpenModelId(id)}>
                  {id}
                </button>
              ) : (
                <span key={i}>{id}{i < modelIds.length - 1 ? ',' : ''}</span>
              ))}
            </span>
          </p>
        )}
        {error && <p className="anim-preview-status">{error}</p>}
        {status && <p className="anim-preview-status">{status}</p>}
        {!model && !error && <p className="anim-preview-status">Loading model{modelIds.length > 1 ? 's' : ''} {idsKey}…</p>}
        {model && (
          <ModelViewer
            data={model}
            display={display ?? undefined}
            posedVertices={posedVertices}
            statsExtra={animation ? `anim ${seqId} · frame ${frameIndex + 1} / ${frameCount}${playing ? '' : ' (paused)'}` : undefined}
          />
        )}
      </div>
    </dialog>
  )
}
