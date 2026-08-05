import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnimationFrameSetData, AnimationFrameDef } from '../loaders/animation_frame_sets'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import { TRANSFORM_TYPE_HELP, TRANSFORM_TYPE_NAMES } from '../loaders/animation_frame_bases'
import type { ModelData } from '../loaders/models'
import { loadModelComposite } from '../loaders/npcComposite'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { buildAnimCompatIndex, peekAnimCompatIndex } from '../loaders/animCompat'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { NumberInput, IntListInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { CameraState } from './ModelViewer'
import './AnimationViewer.css'

type Props = {
  data: AnimationFrameSetData
  onSave: (data: AnimationFrameSetData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}

/** Frame sets carry no timing of their own — sequences supply per-frame
 *  durations — so stepping here runs at a flat rate the user picks. */
const PLAY_FPS = [5, 10, 20, 30]

/** A model to try the skeleton on, derived from the anim-compat index. */
type ModelCandidate = { modelIds: number[]; label: string }

/**
 * The model vertices a transform slot actually touches, so hovering a row can
 * light them up in the preview. What a slot's `labels` mean depends entirely on
 * its type, which is the single most confusing thing about this format:
 *   - 0/1/2/3 address VERTEX groups (model.vertexSkins)
 *   - 5/7 address FACE groups (model.faceSkins)
 *   - 8/9/10 address BILLBOARD groups (the attachment's `depth` byte)
 * The last two resolve to their faces' corner vertices, which is what there is
 * to point at on screen.
 */
function slotVertices(model: ModelData, base: AnimationFrameBaseDef, slot: number): Set<number> {
  const out = new Set<number>()
  const labels = base.labels[slot]
  if (!labels || labels.length === 0) return out
  const want = new Set(labels)
  const type = base.transformationTypes[slot]

  const addFace = (f: number) => {
    if (f < 0 || f >= model.faceCount) return
    out.add(model.triangleX[f])
    out.add(model.triangleY[f])
    out.add(model.triangleZ[f])
  }

  if (type === 5 || type === 7) {
    if (!model.faceSkins) return out
    for (let f = 0; f < model.faceCount; f++) if (want.has(model.faceSkins[f])) addFace(f)
    return out
  }
  if (type === 8 || type === 9 || type === 10) {
    for (const bb of model.billboards ?? []) if (want.has(bb.depth)) addFace(bb.face)
    return out
  }
  if (!model.vertexSkins) return out
  for (let v = 0; v < model.vertexCount; v++) if (want.has(model.vertexSkins[v])) out.add(v)
  return out
}

/** The raw X/Y/Z of a transform entry in the units it actually means — the
 *  same three numbers are degrees, model units, 128ths or HSL steps depending
 *  on the slot type, and nothing on screen says so otherwise. */
function describeDelta(type: number, x: number, y: number, z: number): string {
  // types 2 and 9 store the pre-promotion delta; the client applies <<2 & 0x3fff
  const deg = (raw: number) => `${((((raw << 2) & 0x3fff) * 360) / 16384).toFixed(1)}°`
  const signed = (v: number) => (v >= 0 ? `+${v}` : `${v}`)
  const times = (v: number) => `×${(v / 128).toFixed(2)}`
  switch (type) {
    case 0: return x === 0 && y === 0 && z === 0 ? 'pivot to group centre' : `pivot to group centre ${signed(x)}, ${signed(y)}, ${signed(z)}`
    case 1: return `move ${signed(x)}, ${signed(y)}, ${signed(z)}`
    case 2: return `rotate ${deg(x)} x · ${deg(y)} y · ${deg(z)} z`
    case 3: return `scale ${times(x)}, ${times(y)}, ${times(z)}`
    case 5: return `alpha ${signed(x * 8)}`
    case 7: return `hue ${signed(x)} · sat ${signed(y)} · light ${signed(z)}`
    case 8: return `offset ${signed(x)}, ${signed(y)}`
    case 9: return `roll ${deg(x)}`
    case 10: return `${times(x)} wide, ${times(y)} tall`
    default: return ''
  }
}

/**
 * `count` is how many of the base's slots the decoder walks reading a flag
 * byte each, so it has to cover the highest slot the frame actually uses.
 * Every one of the 86,609 real frames sampled sets it to exactly
 * `maxSlot + 1` — the trailing all-zero flags are trimmed — so edits keep it
 * exact rather than merely sufficient.
 */
function slotsScanned(indices: number[]): number {
  return indices.length === 0 ? 0 : Math.max(...indices) + 1
}

/** Insert into a parallel array at `at`, without mutating the original. */
function insertAt<T>(arr: T[], at: number, value: T): T[] {
  const next = arr.slice()
  next.splice(at, 0, value)
  return next
}

function removeAt<T>(arr: T[], at: number): T[] {
  const next = arr.slice()
  next.splice(at, 1)
  return next
}

// A frame set holds every keyframe sharing one frame-base "skeleton". Each
// keyframe is a sparse list of per-slot deltas, which as raw numbers is
// unreadable — so this edits them against a live posed model: pick a frame,
// hover a transform row to see exactly which vertices it moves, and every
// keystroke re-poses the mesh.
export default function AnimationFrameSetViewer({ data, onSave, onDirtyChange, onNavigate }: Props) {
  const root = data.rootHandle

  const [draft, setDraft] = useState<Map<number, AnimationFrameDef>>(data.frames)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const fileIds = useMemo(() => [...draft.keys()].sort((a, b) => a - b), [draft])
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null)
  const frame = selectedFileId != null ? draft.get(selectedFileId) ?? null : null

  // --- Frame base (the skeleton the deltas index into) ----------------------
  const [bases, setBases] = useState<Map<number, AnimationFrameBaseDef>>(new Map())
  const [baseError, setBaseError] = useState<string | null>(null)
  const baseId = frame?.frameBaseId ?? null
  const frameBase = baseId != null ? bases.get(baseId) ?? null : null

  // --- Preview model --------------------------------------------------------
  const [modelIds, setModelIds] = useState<number[]>([])
  const [model, setModel] = useState<ModelData | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const cameraStateRef = useRef<CameraState | null>(null)

  // --- Transport + hover ----------------------------------------------------
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(10)
  const [hoverSlot, setHoverSlot] = useState<number | null>(null)
  const [addSlot, setAddSlot] = useState<number | ''>('')

  // --- Model suggestions from the anim-compat index -------------------------
  const [compatVersion, setCompatVersion] = useState(0)
  const [compatProgress, setCompatProgress] = useState<ScanProgress | null>(null)

  useEffect(() => {
    setDraft(data.frames)
    setIsDirty(false)
    setBaseError(null)
    setPlaying(false)
    setHoverSlot(null)
    const first = [...data.frames.keys()].sort((a, b) => a - b)[0]
    setSelectedFileId(first ?? null)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Resolve the selected frame's base on demand — a set can (rarely) mix bases,
  // and loading all of them up front would read hundreds of files for nothing.
  useEffect(() => {
    if (baseId == null || baseId < 0 || bases.has(baseId) || !root) return
    let cancelled = false
    void (async () => {
      try {
        const dir = await resolveEntryHandle(root, getEntryPath('animation_frame_bases'))
        const loader = getLoader('animation_frame_bases')
        if (!dir || !loader) throw new Error('animation_frame_bases entry not available')
        const loaded = await loader.loadItem(dir, { id: baseId, name: String(baseId) }, root) as { def: AnimationFrameBaseDef }
        if (cancelled) return
        setBases((prev) => new Map(prev).set(baseId, loaded.def))
        setBaseError(null)
      } catch {
        if (!cancelled) setBaseError(`Couldn't load frame base ${baseId}.`)
      }
    })()
    return () => { cancelled = true }
  }, [baseId, bases, root])

  const candidates = useMemo<ModelCandidate[]>(() => {
    if (baseId == null || baseId < 0) return []
    const index = peekAnimCompatIndex()
    if (!index) return []
    const out: ModelCandidate[] = []
    for (const npc of (index.npcsByBase.get(baseId) ?? []).slice(0, 6)) {
      if (npc.modelIds.length > 0) out.push({ modelIds: npc.modelIds, label: `${npc.name} · npc ${npc.id}` })
    }
    for (const spot of (index.spotsByBase.get(baseId) ?? []).slice(0, 4)) {
      if (spot.modelId >= 0) out.push({ modelIds: [spot.modelId], label: `spot anim ${spot.id}` })
    }
    // compatVersion is the scan-completed trigger — peek() itself isn't reactive
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, compatVersion])

  const loadModel = useCallback(async (ids: number[]) => {
    if (!root) return
    const wanted = ids.filter((id) => id >= 0)
    if (wanted.length === 0) return
    setModelError(null)
    setModelLoading(true)
    try {
      // loadModelComposite merges multi-part sets AND upscales pre-v13 parts
      // (<<2) like the client does before animating — frame deltas are in that
      // upscaled space.
      const loaded = await loadModelComposite(root, { modelIds: wanted })
      if (!loaded.vertexSkins) {
        setModel(null)
        setModelError(`Model${wanted.length > 1 ? 's' : ''} ${wanted.join(', ')} carr${wanted.length > 1 ? 'y' : 'ies'} no vertex groups (vertexSkins) — nothing for a frame to move.`)
        return
      }
      setModel(loaded)
    } catch {
      setModel(null)
      setModelError(`Couldn't load model${wanted.length > 1 ? 's' : ''} ${wanted.join(', ')}.`)
    } finally {
      setModelLoading(false)
    }
  }, [root])

  // Auto-load the first suggestion once per skeleton, so opening a frame set
  // with the index already built lands straight on a posed model.
  const autoTriedRef = useRef<number | null>(null)
  useEffect(() => {
    if (baseId == null || baseId < 0 || model || autoTriedRef.current === baseId) return
    const first = candidates[0]
    if (!first) return
    autoTriedRef.current = baseId
    setModelIds(first.modelIds)
    void loadModel(first.modelIds)
  }, [baseId, candidates, model, loadModel])

  async function handleCompatScan() {
    if (!root) return
    setCompatProgress({ phase: 'indexing', done: 0, total: 0 })
    try {
      await buildAnimCompatIndex(root, setCompatProgress)
      setCompatVersion((v) => v + 1)
    } finally {
      setCompatProgress(null)
    }
  }

  // Step frames at a flat rate — see PLAY_FPS.
  useEffect(() => {
    if (!playing || fileIds.length < 2) return
    const timer = setInterval(() => {
      setSelectedFileId((cur) => {
        const i = cur == null ? -1 : fileIds.indexOf(cur)
        return fileIds[(i + 1) % fileIds.length]
      })
    }, 1000 / fps)
    return () => clearInterval(timer)
  }, [playing, fps, fileIds])

  const posed = useMemo(() => {
    if (!model || !frameBase || !frame || frame.rawFallbackBytes) return null
    return applyAnimationFrame(model, frameBase, frame)
  }, [model, frameBase, frame])

  const highlight = useMemo(() => {
    if (hoverSlot == null || !model || !frameBase) return null
    return slotVertices(model, frameBase, hoverSlot)
  }, [hoverSlot, model, frameBase])

  // --- Editing --------------------------------------------------------------
  function editFrame(fileId: number, next: AnimationFrameDef) {
    setDraft((prev) => new Map(prev).set(fileId, next))
    setIsDirty(true)
  }

  function setTransform(
    fileId: number,
    i: number,
    key: 'transformationX' | 'transformationY' | 'transformationZ' | 'transformationFlags' | 'skippedReferences',
    value: number,
  ) {
    const target = draft.get(fileId)
    if (!target) return
    const arr = target[key].slice()
    arr[i] = value
    editFrame(fileId, { ...target, [key]: arr })
  }

  /**
   * Add an entry for a slot the frame doesn't touch yet. `transformationIndices`
   * is ASCENDING in every real frame, and both the client's decoder and
   * `resolveEntries`' tween walk advance through entries in slot order — so the
   * insert is sorted, not appended.
   */
  function addTransform(fileId: number, slot: number) {
    const target = draft.get(fileId)
    if (!target || !frameBase) return
    if (target.transformationIndices.includes(slot)) return
    const type = frameBase.transformationTypes[slot] ?? 0
    const identity = type === 3 || type === 10 ? 128 : 0
    let at = target.transformationIndices.findIndex((s) => s > slot)
    if (at < 0) at = target.transformationIndices.length
    const transformationIndices = insertAt(target.transformationIndices, at, slot)
    editFrame(fileId, {
      ...target,
      count: slotsScanned(transformationIndices),
      transformationCount: transformationIndices.length,
      transformationIndices,
      transformationX: insertAt(target.transformationX, at, identity),
      transformationY: insertAt(target.transformationY, at, identity),
      transformationZ: insertAt(target.transformationZ, at, identity),
      transformationFlags: insertAt(target.transformationFlags, at, 0),
      skippedReferences: insertAt(target.skippedReferences, at, -1),
    })
  }

  function removeTransform(fileId: number, at: number) {
    const target = draft.get(fileId)
    if (!target) return
    const transformationIndices = removeAt(target.transformationIndices, at)
    editFrame(fileId, {
      ...target,
      count: slotsScanned(transformationIndices),
      transformationCount: transformationIndices.length,
      transformationIndices,
      transformationX: removeAt(target.transformationX, at),
      transformationY: removeAt(target.transformationY, at),
      transformationZ: removeAt(target.transformationZ, at),
      transformationFlags: removeAt(target.transformationFlags, at),
      skippedReferences: removeAt(target.skippedReferences, at),
    })
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, frames: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const frameIndex = selectedFileId == null ? -1 : fileIds.indexOf(selectedFileId)
  const unusedSlots = frameBase && frame
    ? frameBase.transformationTypes
        .map((_, slot) => slot)
        .filter((slot) => !frame.transformationIndices.includes(slot))
    : []

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Frame Set {data.id}</span>
          <span className="item-stack-index">{fileIds.length} frame{fileIds.length === 1 ? '' : 's'}</span>
          {baseId != null && baseId >= 0 && onNavigate && (
            <button
              type="button"
              className="anim-skeleton-chip"
              title="Open the frame base (skeleton) this frame transforms against"
              onClick={() => onNavigate('animation_frame_bases', baseId)}
            >
              skeleton {baseId}
            </button>
          )}
        </div>
      </div>

      <p className="tex-op-note">
        A keyframe is not a bone tree — it's a short program. The frame base lists
        numbered transform <em>slots</em>, and this frame supplies a delta for some of
        them. Slots run in order against one running <em>pivot</em>: an origin-marker slot
        moves the pivot to the centre of its groups, and every rotate or scale after it
        turns about that pivot. Hierarchy is emergent — a slot whose labels cover the
        whole arm runs before the one covering just the hand.
      </p>

      <div className="anim-frame-editor">
        <section className="item-section anim-frame-preview">
          <h3>Preview</h3>

          <div className="anim-preview-toolbar">
            <span className="sprite-zoom-label">Model(s)</span>
            <IntListInput
              value={modelIds.length > 0 ? modelIds : undefined}
              onChange={(v) => setModelIds(v ?? [])}
              placeholder="model ids, comma-separated"
            />
            <button type="button" className="replace-btn" disabled={!root || modelLoading} onClick={() => void loadModel(modelIds)}>
              {modelLoading ? 'Loading…' : 'Load'}
            </button>
          </div>

          {candidates.length > 0 && (
            <div className="anim-frame-candidates">
              <span className="map-sprite-hint">Rigged to this skeleton:</span>
              {candidates.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className="field-link-btn"
                  title={`Preview on model${c.modelIds.length > 1 ? 's' : ''} ${c.modelIds.join(', ')}`}
                  onClick={() => { setModelIds(c.modelIds); void loadModel(c.modelIds) }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {candidates.length === 0 && baseId != null && baseId >= 0 && (
            compatProgress != null ? (
              <p className="anim-preview-status">{scanLabel(compatProgress)}</p>
            ) : peekAnimCompatIndex() == null ? (
              <div className="map-sprite-uses-scan">
                <button type="button" className="cursor-pick-btn" disabled={!root} onClick={handleCompatScan}>
                  Find models on this skeleton
                </button>
                <span className="map-sprite-hint">one scan of animations, frame sets, bas, npcs, items and spot anims, then cached for the session</span>
              </div>
            ) : (
              <p className="anim-preview-status">No NPC or spot animation in this cache is rigged to skeleton {baseId} — enter a model id by hand.</p>
            )
          )}

          {baseError && <p className="anim-preview-status">{baseError}</p>}
          {modelError && <p className="anim-preview-status">{modelError}</p>}
          {frame?.rawFallbackBytes && (
            <p className="anim-preview-status">
              This frame is unreadable — it references an orphaned frame base, so it's preserved
              byte-for-byte on save and can't be posed or edited.
            </p>
          )}

          {model ? (
            <ModelViewer
              data={model}
              posedVertices={posed}
              highlightVertices={highlight}
              cameraStateRef={cameraStateRef}
              statsExtra={selectedFileId != null ? `frame ${selectedFileId}` : undefined}
            />
          ) : (
            <p className="anim-preview-status">
              Load a model rigged to this skeleton to see the frame posed.
            </p>
          )}
        </section>

        <div className="anim-frame-side">
          <section className="item-section">
            <h3>Frames</h3>
            <div className="anim-preview-toolbar">
              <span className="btn-pill">
                <button
                  type="button"
                  className="zoom-btn"
                  disabled={playing || frameIndex <= 0}
                  onClick={() => setSelectedFileId(fileIds[frameIndex - 1])}
                >◂ Prev</button>
                <button
                  type="button"
                  className="zoom-btn"
                  disabled={playing || frameIndex < 0 || frameIndex >= fileIds.length - 1}
                  onClick={() => setSelectedFileId(fileIds[frameIndex + 1])}
                >Next ▸</button>
              </span>
              <button
                type="button"
                className={`zoom-btn anim-preview-play${playing ? ' active' : ''}`}
                disabled={fileIds.length < 2}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              {PLAY_FPS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`zoom-btn${fps === f ? ' active' : ''}`}
                  onClick={() => setFps(f)}
                >{f} FPS</button>
              ))}
            </div>
            <p className="map-sprite-hint">
              A frame set has no timing of its own — the durations come from whichever
              sequence plays it, so this steps at a flat rate.
            </p>
            <div className="anim-frame-strip">
              {fileIds.map((fileId) => {
                const f = draft.get(fileId)!
                return (
                  <button
                    key={fileId}
                    type="button"
                    className={`anim-frame-chip${fileId === selectedFileId ? ' active' : ''}${f.rawFallbackBytes ? ' broken' : ''}`}
                    title={f.rawFallbackBytes
                      ? `Frame ${fileId} — unreadable`
                      : `Frame ${fileId} — ${f.transformationIndices.length} transform${f.transformationIndices.length === 1 ? '' : 's'} on base ${f.frameBaseId}`}
                    onClick={() => { setPlaying(false); setSelectedFileId(fileId) }}
                  >
                    {fileId}
                  </button>
                )
              })}
            </div>
          </section>

          {frame && !frame.rawFallbackBytes && (
            <section className="item-section">
              <h3>
                Transforms in frame {selectedFileId}
                <span className="item-stack-index"> {frame.transformationIndices.length} of {frameBase?.transformationTypes.length ?? '?'} slots</span>
              </h3>
              {!frameBase ? (
                <p className="anim-preview-status">Loading frame base {baseId}…</p>
              ) : (
                <>
                  <p className="map-sprite-hint">Hover a row to light up the vertices it moves.</p>
                  <div className="quest-table-wrap">
                    <table className="quest-table">
                      <thead>
                        <tr>
                          <th>Slot</th><th>Type</th><th>Groups</th>
                          <th>X</th><th>Y</th><th>Z</th>
                          <th>Means</th><th>Flags</th><th>Skip</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {frame.transformationIndices.map((slot, i) => {
                          const type = frameBase.transformationTypes[slot] ?? 0
                          const labels = frameBase.labels[slot] ?? []
                          return (
                            <tr
                              key={i}
                              className={hoverSlot === slot ? 'linked-hover' : undefined}
                              onMouseEnter={() => setHoverSlot(slot)}
                              onMouseLeave={() => setHoverSlot((cur) => (cur === slot ? null : cur))}
                            >
                              <td className="item-stack-index">{slot}</td>
                              <td title={TRANSFORM_TYPE_HELP[type] ?? ''}>{TRANSFORM_TYPE_NAMES[type] ?? `type ${type}`}</td>
                              <td className="item-stack-index">{labels.join(', ') || '—'}</td>
                              <td><NumberInput className="cell-input" value={frame.transformationX[i]} onChange={(v) => setTransform(selectedFileId!, i, 'transformationX', v)} /></td>
                              <td><NumberInput className="cell-input" value={frame.transformationY[i]} onChange={(v) => setTransform(selectedFileId!, i, 'transformationY', v)} /></td>
                              <td><NumberInput className="cell-input" value={frame.transformationZ[i]} onChange={(v) => setTransform(selectedFileId!, i, 'transformationZ', v)} /></td>
                              <td className="item-stack-index">{describeDelta(type, frame.transformationX[i], frame.transformationY[i], frame.transformationZ[i])}</td>
                              <td>
                                <NumberInput
                                  className="cell-input"
                                  value={frame.transformationFlags[i]}
                                  min={0}
                                  max={3}
                                  title="Tweening: 1 = snap in from this keyframe, 2 = hold (no blend out)"
                                  onChange={(v) => setTransform(selectedFileId!, i, 'transformationFlags', v)}
                                />
                              </td>
                              <td>
                                <NumberInput
                                  className="cell-input"
                                  value={frame.skippedReferences[i] ?? -1}
                                  min={-1}
                                  title="Re-establish the pivot from this OTHER slot's live vertices before running this entry. −1 = leave the pivot where it is."
                                  onChange={(v) => setTransform(selectedFileId!, i, 'skippedReferences', v)}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="row-remove-btn"
                                  title="Remove this transform from the frame"
                                  onClick={() => removeTransform(selectedFileId!, i)}
                                >×</button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="anim-frame-add">
                    <select
                      className="item-stackable-select"
                      value={addSlot}
                      onChange={(e) => setAddSlot(e.target.value === '' ? '' : Number(e.target.value))}
                    >
                      <option value="">Add a slot this frame doesn't touch…</option>
                      {unusedSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {slot} · {TRANSFORM_TYPE_NAMES[frameBase.transformationTypes[slot]] ?? `type ${frameBase.transformationTypes[slot]}`}
                          {(frameBase.labels[slot] ?? []).length > 0 ? ` · groups ${(frameBase.labels[slot] ?? []).join(', ')}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="add-row-btn"
                      disabled={addSlot === ''}
                      onClick={() => { addTransform(selectedFileId!, addSlot as number); setAddSlot('') }}
                    >
                      Add transform
                    </button>
                  </div>

                  {hoverSlot != null && (
                    <p className="tex-op-note">
                      <strong>{TRANSFORM_TYPE_NAMES[frameBase.transformationTypes[hoverSlot] ?? 0] ?? 'unknown'}</strong>
                      {' — '}
                      {TRANSFORM_TYPE_HELP[frameBase.transformationTypes[hoverSlot] ?? 0] ?? 'No description for this slot type.'}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {frame && !frame.rawFallbackBytes && (
            <section className="item-section anim-advanced">
              <h3>Frame Header</h3>
              <div className="anim-frame-header-grid">
                <label className="sprite-zoom-label">
                  Frame base
                  <NumberInput
                    className="cell-input"
                    value={frame.frameBaseId}
                    title="The skeleton this frame's slot indices address. Changing it repoints every transform at a different slot layout."
                    onChange={(v) => editFrame(selectedFileId!, { ...frame, frameBaseId: v })}
                  />
                </label>
                <label className="sprite-zoom-label">
                  Slots scanned
                  <NumberInput
                    className="cell-input"
                    value={frame.count}
                    min={0}
                    title="How many of the base's slots the decoder walks. Any slot at or past this is never read back — kept in sync when you add or remove transforms."
                    onChange={(v) => editFrame(selectedFileId!, { ...frame, count: v })}
                  />
                </label>
                <label className="sprite-zoom-label">
                  Header byte 0
                  <NumberInput
                    className="cell-input"
                    value={frame.unknownByte0}
                    title="Unidentified in both cryogen and darkan — preserved verbatim."
                    onChange={(v) => editFrame(selectedFileId!, { ...frame, unknownByte0: v })}
                  />
                </label>
                <label className="sprite-zoom-label">
                  <input
                    type="checkbox"
                    checked={frame.modifiesAlpha}
                    onChange={(e) => editFrame(selectedFileId!, { ...frame, modifiesAlpha: e.target.checked })}
                  />
                  Modifies alpha
                </label>
                <label className="sprite-zoom-label">
                  <input
                    type="checkbox"
                    checked={frame.modifiesColor}
                    onChange={(e) => editFrame(selectedFileId!, { ...frame, modifiesColor: e.target.checked })}
                  />
                  Modifies colour
                </label>
                <label className="sprite-zoom-label">
                  <input
                    type="checkbox"
                    checked={frame.aBool988}
                    onChange={(e) => editFrame(selectedFileId!, { ...frame, aBool988: e.target.checked })}
                  />
                  Billboard flag
                </label>
              </div>
            </section>
          )}
        </div>
      </div>

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
