import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnimationData, AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameDef, AnimationFrameSetData } from '../loaders/animation_frame_sets'
import type { ModelData } from '../loaders/models'
import { buildRig, defaultPivotSlot, partForVertex, partLabel, partVertices, partsInTreeOrder, pivotParts } from '../loaders/animRig'
import type { Rig } from '../loaders/animRig'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import { applyGizmoDelta, ensureEntry, gizmoModeFor } from '../loaders/animPose'
import type { GizmoDelta } from '../loaders/animPose'
import { loadModelComposite } from '../loaders/npcComposite'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { writeJsonItem } from '../loaders/common'
import { buildAnimCompatIndex, invalidateAnimCompatIndex, peekAnimCompatIndex } from '../loaders/animCompat'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { IntListInput, NumberInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { CameraState } from './ModelViewer'
import './AnimationStudio.css'

// One editor for making an animation, instead of three index viewers wired
// together by hand. See docs/animation-studio.md.
//
// The thing that makes it possible is `animRig`: a frame base's slots reuse the
// same vertex-group label sets, and that reuse IS the skeleton. So the studio
// talks in PARTS — click the hand, turn it — and never in slot numbers.
//
// This pass is the shell: model, rig tree, viewport selection, posing the
// selected frame. Writing the frames and the sequence back is the next one, so
// nothing here saves yet and the page says so.

type Props = {
  data: AnimationData
  onClose: () => void
}

/** One frame of the animation being built. */
type StudioFrame = {
  /** Where it came from, so an unedited frame can be left alone on save. */
  setId: number
  fileId: number
  frame: AnimationFrameDef
  durationCycles: number
  /** Position in the SAVED sequence, or -1 for a frame added since. The
   *  sequence carries several other per-frame parallel arrays (sounds,
   *  interleave order) that save has to permute identically — this is the
   *  index it permutes them by. */
  srcIndex: number
  /**
   * The number shown on the timeline. Assigned once and KEPT through
   * reordering — if position renamed the cells, dragging #6 between 3 and 4
   * instantly renumbered everything and you couldn't see that the drag worked.
   * Save gets to compact them back to 1..n.
   */
  label: number
}

export default function AnimationStudio({ data, onClose }: Props) {
  const root = data.rootHandle
  const def: AnimationDef = data.def

  const [frames, setFrames] = useState<StudioFrame[]>([])
  const [frameIndex, setFrameIndex] = useState(0)
  const [base, setBase] = useState<AnimationFrameBaseDef | null>(null)
  const [status, setStatus] = useState('Loading…')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState('')
  /** Bumped by Discard to re-run the load from disk. */
  const [reloadNonce, setReloadNonce] = useState(0)
  /** The def as last WRITTEN — the baseline the next save permutes from. The
   *  prop goes stale the moment the first save lands. */
  const savedDefRef = useRef<AnimationDef>(def)

  const [modelIds, setModelIds] = useState<number[]>([])
  const [model, setModel] = useState<ModelData | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [selectedPart, setSelectedPart] = useState<number | null>(null)
  const [hoverPart, setHoverPart] = useState<number | null>(null)
  /** Which channel of the selected part the handle drives. A part can carry
   *  turn, move and scale at once, where a raw slot only ever had one. */
  const [channelType, setChannelType] = useState(2)
  const dragBase = useRef<{ index: number; x: number; y: number; z: number } | null>(null)
  /** Pivot the user chose for the current selection, overriding the guess. */
  const [pivotOverride, setPivotOverride] = useState<number | null>(null)
  /** Tree order is the default because it's the only order in which the indent
   *  means anything; ascending is for when you know a part number. */
  const [sortMode, setSortMode] = useState<'tree' | 'id'>('tree')
  const [playing, setPlaying] = useState(false)
  /** Blend between frames instead of stepping. Seeded from the sequence's own
   *  flag, because that is what the client will do when it plays this. */
  const [tweened, setTweened] = useState(false)
  /** Cycles into the CURRENT frame, for the blend and the playhead. */
  const [elapsed, setElapsed] = useState(0)
  /** Frame being dragged along the timeline, and where the pointer is. */
  const [dragFrame, setDragFrame] = useState<{ from: number; grabX: number; x: number; target: number; cycle: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [compatVersion, setCompatVersion] = useState(0)
  const [scanning, setScanning] = useState<ScanProgress | null>(null)
  const cameraStateRef = useRef<CameraState | null>(null)

  const rig = useMemo((): Rig | null => (base ? buildRig(base) : null), [base])
  const current = frames[frameIndex] ?? null

  // ---------------------------------------------------------------- loading
  // Pull the sequence's frames in one go: every frame it names, plus the base
  // they share. The sequence is the playlist, so it already knows the order and
  // the timing — the studio just needs them as one list.
  useEffect(() => {
    if (!root) { setStatus('Reopen the cache to use the studio.'); return }
    let cancelled = false
    void (async () => {
      try {
        const setsDir = await resolveEntryHandle(root, getEntryPath('animation_frame_sets'))
        const basesDir = await resolveEntryHandle(root, getEntryPath('animation_frame_bases'))
        const setLoader = getLoader('animation_frame_sets')
        const baseLoader = getLoader('animation_frame_bases')
        if (!setsDir || !basesDir || !setLoader || !baseLoader) throw new Error('animation entries not available')

        const live = savedDefRef.current
        const setIds = [...new Set((live.frameSetIds ?? []).filter((id) => id >= 0))]
        const sets = new Map<number, AnimationFrameSetData>()
        for (const id of setIds) {
          sets.set(id, await setLoader.loadItem(setsDir, { id, name: String(id) }, root) as AnimationFrameSetData)
        }
        if (cancelled) return

        const out: StudioFrame[] = []
        const durations = live.frameDurations ?? []
        ;(live.frameSetIds ?? []).forEach((setId, i) => {
          const fileId = frameFileId(live, i)
          const frame = sets.get(setId)?.frames.get(fileId)
          if (!frame || frame.rawFallbackBytes) return
          out.push({ setId, fileId, frame, durationCycles: durations[i] ?? 1, label: out.length + 1, srcIndex: i })
        })
        if (out.length === 0) { setStatus('This animation names no readable frames.'); return }

        const baseId = out[0].frame.frameBaseId
        const loaded = await baseLoader.loadItem(basesDir, { id: baseId, name: String(baseId) }, root) as { def: AnimationFrameBaseDef }
        if (cancelled) return
        setBase(loaded.def)
        setFrames(out)
        setTweened(live.tweened === true)
        setDirty(false)
        setStatus('')
      } catch (err) {
        if (!cancelled) setStatus(err instanceof Error ? err.message : 'Could not load this animation.')
      }
    })()
    return () => { cancelled = true }
    // def prop never changes identity; reloadNonce is Discard's re-read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, reloadNonce])

  // Models rigged to this skeleton, from the compat index.
  const candidates = useMemo(() => {
    void compatVersion // peek() isn't reactive — a finished scan bumps this
    const baseId = frames[0]?.frame.frameBaseId
    const index = peekAnimCompatIndex()
    if (baseId == null || !index) return [] as { modelIds: number[]; label: string }[]
    const out: { modelIds: number[]; label: string }[] = []
    for (const npc of (index.npcsByBase.get(baseId) ?? []).slice(0, 8)) {
      if (npc.modelIds.length > 0) out.push({ modelIds: npc.modelIds, label: `${npc.name} · npc ${npc.id}` })
    }
    for (const spot of (index.spotsByBase.get(baseId) ?? []).slice(0, 4)) {
      if (spot.modelId >= 0) out.push({ modelIds: [spot.modelId], label: `spot anim ${spot.id}` })
    }
    return out
  }, [frames, compatVersion])

  const loadModel = useCallback(async (ids: number[]) => {
    if (!root) return
    const wanted = ids.filter((id) => id >= 0)
    if (wanted.length === 0) return
    setModelError(null)
    try {
      const loaded = await loadModelComposite(root, { modelIds: wanted })
      if (!loaded.vertexSkins) { setModel(null); setModelError(`Model ${wanted.join(', ')} has no vertex groups — nothing to pose.`); return }
      setModel(loaded)
    } catch {
      setModel(null)
      setModelError(`Couldn't load model ${wanted.join(', ')}.`)
    }
  }, [root])

  const autoTried = useRef(false)
  useEffect(() => {
    if (model || autoTried.current || candidates.length === 0) return
    autoTried.current = true
    setModelIds(candidates[0].modelIds)
    void loadModel(candidates[0].modelIds)
  }, [candidates, model, loadModel])

  async function scan() {
    if (!root) return
    setScanning({ phase: 'indexing', done: 0, total: 0 })
    try {
      await buildAnimCompatIndex(root, setScanning)
      setCompatVersion((v) => v + 1)
    } finally { setScanning(null) }
  }

  // ----------------------------------------------------------------- posing
  /** The part's channels, so the toolbar only offers handles it really has. */
  const channels = useMemo(() => {
    if (selectedPart == null || !rig) return []
    return rig.parts[selectedPart].channels.filter((c) => gizmoModeFor(c.type) != null)
  }, [selectedPart, rig])

  // Keep the chosen channel on something the part actually has — rotate first,
  // since that is what nearly every pose adjustment is.
  useEffect(() => {
    if (channels.length === 0) return
    if (channels.some((c) => c.type === channelType)) return
    setChannelType((channels.find((c) => c.type === 2) ?? channels[0]).type)
  }, [channels, channelType])

  const activeSlot = channels.find((c) => c.type === channelType)?.slot ?? null
  const gizmoMode = gizmoModeFor(channelType)

  const posed = useMemo(() => {
    if (!model || !base || !current) return null
    // Tweening blends toward the NEXT frame by how far through this one we are.
    // Only while playing: a still frame must show what it really stores, or you
    // would be posing against a blend rather than the frame.
    const next = tweened && playing && frames.length > 1
      ? frames[(frameIndex + 1) % frames.length].frame
      : null
    return applyAnimationFrame(
      model, base, current.frame, next,
      next ? elapsed : 0, next ? Math.max(1, current.durationCycles) : 1,
      undefined, activeSlot ?? undefined,
    )
  }, [model, base, current, activeSlot, tweened, playing, elapsed, frames, frameIndex])

  // Playback: frames are held for their own duration (20ms cycles). Tweened
  // sequences re-pose every rendered frame at the sub-cycle fraction, because
  // stepping alone at 5 cycles a frame reads as a stutter however fast the
  // scene draws.
  useEffect(() => {
    if (!playing || frames.length === 0) return
    let raf = 0
    let last = performance.now()
    let index = frameIndex
    let within = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      within += (now - last) / 20
      last = now
      let guard = 0
      while (within >= Math.max(1, frames[index].durationCycles) && guard++ < 64) {
        within -= Math.max(1, frames[index].durationCycles)
        index = (index + 1) % frames.length
      }
      setFrameIndex(index)
      setElapsed(within)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // frameIndex seeds the loop; re-running on every advance would restart it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames])

  /**
   * The pivot this rotation turns about. An entry that already exists carries
   * its own — the animation's author chose it — so that wins; otherwise the
   * user's pick, otherwise the guess.
   */
  const existingSkip = useMemo(() => {
    if (!current || activeSlot == null) return -1
    const i = current.frame.transformationIndices.indexOf(activeSlot)
    return i >= 0 ? current.frame.skippedReferences[i] ?? -1 : -1
  }, [current, activeSlot])

  const pivotSlot = pivotOverride
    ?? (existingSkip >= 0 ? existingSkip : null)
    ?? (rig && selectedPart != null ? defaultPivotSlot(rig, selectedPart) : -1)

  const pivotChoices = useMemo(() => (rig ? pivotParts(rig) : []), [rig])

  /**
   * Which parts actually turn about each pivot, read out of the animation's own
   * frames. A pivot on its own tells you nothing — the useful question is "what
   * moves around this?", and only the entries answer it, since the base records
   * no link between a rotation and its joint.
   */
  const pivotUsers = useMemo(() => {
    const out = new Map<number, Set<number>>()
    if (!rig) return out
    const partOfSlot = new Map<number, number>()
    for (const part of rig.parts) for (const c of part.channels) partOfSlot.set(c.slot, part.id)
    for (const f of frames) {
      f.frame.transformationIndices.forEach((slot, i) => {
        const skip = f.frame.skippedReferences[i] ?? -1
        if (skip < 0) return
        const part = partOfSlot.get(slot)
        if (part == null) return
        let set = out.get(skip)
        if (!set) out.set(skip, set = new Set())
        set.add(part)
      })
    }
    return out
  }, [frames, rig])

  /** The parts turning about the pivot currently selected, if it is one. */
  const usersOfSelected = useMemo(() => {
    if (!rig || selectedPart == null) return []
    const part = rig.parts[selectedPart]
    if (part.poseable) return []
    const slot = part.channels.find((c) => c.type === 0)?.slot
    if (slot == null) return []
    return [...(pivotUsers.get(slot) ?? [])]
  }, [rig, selectedPart, pivotUsers])

  // A different part means a different joint; don't carry the pick across.
  useEffect(() => { setPivotOverride(null) }, [selectedPart, frameIndex])

  /** Repoint the current transform at another joint, creating the entry if the
   *  frame doesn't have one yet. */
  function setPivot(slot: number) {
    setPivotOverride(slot)
    if (activeSlot == null || !current) return
    const { frame: withEntry, index } = ensureEntry(current.frame, activeSlot, channelType, slot)
    const skips = withEntry.skippedReferences.slice()
    skips[index] = slot
    setFrames((prev) => prev.map((f, i) => (
      i === frameIndex ? { ...f, frame: { ...withEntry, skippedReferences: skips } } : f
    )))
  }

  /** Pinned when the handle attaches — see the frame editor for why following
   *  the live pivot makes the handle jump. */
  const posedRef = useRef(posed)
  posedRef.current = posed
  const gizmoPos = useMemo((): [number, number, number] | null => {
    if (activeSlot == null || gizmoMode == null || !model || !rig || selectedPart == null) return null
    const at = posedRef.current
    if ((channelType === 2 || channelType === 3) && at?.pivot) return at.pivot
    const verts = partVertices(rig, model, selectedPart)
    if (verts.size === 0) return at?.pivot ?? [0, 0, 0]
    const X = at?.x ?? model.vertexX, Y = at?.y ?? model.vertexY, Z = at?.z ?? model.vertexZ
    let sx = 0, sy = 0, sz = 0
    for (const v of verts) { sx += X[v]; sy += Y[v]; sz += Z[v] }
    return [Math.round(sx / verts.size), Math.round(sy / verts.size), Math.round(sz / verts.size)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, gizmoMode, model, rig, selectedPart, channelType, frameIndex, pivotSlot])

  /** Grab: make sure the frame HAS an entry for this slot — posing a part the
   *  frame never touched is the normal case when building an animation — and
   *  remember its values to apply the drag against. */
  function onGizmoDragging(dragging: boolean) {
    if (!dragging) { dragBase.current = null; return }
    if (activeSlot == null || !current) return
    // A fresh rotate entry with no pivot turns about the origin — the model's
    // feet — which is not what "raise the arm" means. Name the joint.
    const pivot = channelType === 2 || channelType === 3 ? pivotSlot : -1
    const { frame: withEntry, index } = ensureEntry(current.frame, activeSlot, channelType, pivot)
    if (withEntry !== current.frame) {
      setFrames((prev) => prev.map((f, i) => (i === frameIndex ? { ...f, frame: withEntry } : f)))
      touch()
    }
    dragBase.current = {
      index,
      x: withEntry.transformationX[index],
      y: withEntry.transformationY[index],
      z: withEntry.transformationZ[index],
    }
  }

  function onGizmoTransform(t: GizmoDelta) {
    const b = dragBase.current
    if (!b || !current) return
    const next = applyGizmoDelta(channelType, { x: b.x, y: b.y, z: b.z }, t)
    setFrames((prev) => prev.map((f, i) => {
      if (i !== frameIndex) return f
      const set = (arr: number[], v: number) => { const a = arr.slice(); a[b.index] = v; return a }
      return {
        ...f,
        frame: {
          ...f.frame,
          transformationX: set(f.frame.transformationX, next.x),
          transformationY: set(f.frame.transformationY, next.y),
          transformationZ: set(f.frame.transformationZ, next.z),
        },
      }
    }))
    touch()
  }

  const highlight = useMemo(() => {
    const part = hoverPart ?? selectedPart
    if (part == null || !rig || !model) return null
    return partVertices(rig, model, part)
  }, [hoverPart, selectedPart, rig, model])

  /** Clicking the mesh selects the most specific part that owns what was hit —
   *  the hand, not the torso that contains it. */
  const onPickVertex = useCallback((vertexIndex: number) => {
    if (!rig || !model) return
    const part = partForVertex(rig, model, vertexIndex)
    if (part != null) setSelectedPart(part)
  }, [rig, model])

  // Pivot-only parts are the JOINTS — they're what a rotation turns about, so
  // hiding them was wrong. Shown alongside, marked, and not selectable as a
  // thing to drag.
  const listed = useMemo(() => {
    if (!rig) return []
    return sortMode === 'tree' ? partsInTreeOrder(rig) : [...rig.parts].sort((a, b) => a.id - b.id)
  }, [rig, sortMode])
  const poseable = useMemo(() => listed.filter((p) => p.poseable), [listed])


  /** How many parts turn about this pivot marker in this animation. */
  const pivotUsedBy = (p: { channels: { slot: number; type: number }[] }) => {
    const slot = p.channels.find((c) => c.type === 0)?.slot
    return slot == null ? 0 : (pivotUsers.get(slot)?.size ?? 0)
  }

  /** Any edit: dirty, and whatever the last save said is stale. */
  const touch = () => { setDirty(true); setSaveNote('') }

  /** Sequence-level edits (loop delay, hand items…) waiting for save. */
  const [defEdits, setDefEdits] = useState<Partial<AnimationDef>>({})
  /** The sequence as it will be written: last-saved def + pending edits. */
  const seq: AnimationDef = { ...savedDefRef.current, ...defEdits }
  const editSeq = (patch: Partial<AnimationDef>) => { setDefEdits((prev) => ({ ...prev, ...patch })); touch() }

  /**
   * Add a frame after the current one, carrying its pose over.
   *
   * Duplicating is the point: an animation is a pose changing slightly, so
   * starting each frame from the last one is the loop — a blank frame would
   * snap the model back to its rest pose and you'd rebuild it every time.
   * `fileId` is left at -1 to mark it as not yet on disk; save assigns real ones.
   */
  function addFrameAfter(i: number) {
    setFrames((prev) => {
      const src = prev[i]
      if (!src) return prev
      const copy: StudioFrame = {
        setId: src.setId,
        fileId: -1,
        srcIndex: -1,
        label: prev.reduce((m, f) => Math.max(m, f.label ?? 0), 0) + 1,
        durationCycles: src.durationCycles,
        // deep enough: every array a pose edit touches is replaced wholesale
        frame: {
          ...src.frame,
          transformationIndices: [...src.frame.transformationIndices],
          transformationX: [...src.frame.transformationX],
          transformationY: [...src.frame.transformationY],
          transformationZ: [...src.frame.transformationZ],
          transformationFlags: [...src.frame.transformationFlags],
          skippedReferences: [...src.frame.skippedReferences],
        },
      }
      return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)]
    })
    setFrameIndex(i + 1)
    touch()
  }

  function removeFrame(i: number) {
    if (frames.length <= 1) return
    setFrames((prev) => prev.filter((_, j) => j !== i))
    setFrameIndex((cur) => Math.max(0, Math.min(cur, frames.length - 2)))
    touch()
  }

  function setDuration(i: number, cycles: number) {
    setFrames((prev) => prev.map((f, j) => (j === i ? { ...f, durationCycles: Math.max(1, cycles) } : f)))
    touch()
  }

  /**
   * Where playback returns to after the last frame, or null when it doesn't.
   *
   * The client restarts at `frameCount - loopDelay`, NOT at frame 0, so only
   * the tail repeats. 73% of sequences use -1, which loops nothing — they play
   * through once. Looping a whole walk cycle means loopDelay === frameCount.
   */
  /**
   * How far apart two poses are, in transforms that don't match.
   *
   * The reason it matters: when an animation ends the entity snaps back to its
   * stance, so a last frame that doesn't resemble the first produces a visible
   * jump. Nothing in the format warns about it — it's an authoring concern —
   * so the studio measures it instead of leaving you to spot it by eye.
   */
  function poseDifference(a: StudioFrame, b: StudioFrame): number {
    const read = (f: StudioFrame) => {
      const m = new Map<number, string>()
      f.frame.transformationIndices.forEach((slot, i) => {
        m.set(slot, `${f.frame.transformationX[i]},${f.frame.transformationY[i]},${f.frame.transformationZ[i]}`)
      })
      return m
    }
    const ma = read(a), mb = read(b)
    let differ = 0
    for (const [slot, v] of ma) if (mb.get(slot) !== v) differ++
    for (const slot of mb.keys()) if (!ma.has(slot)) differ++
    return differ
  }

  const endSnap = frames.length > 1 ? poseDifference(frames[0], frames[frames.length - 1]) : 0

  /** Replace one frame's pose with another's, keeping its own timing. */
  function copyPose(from: number, to: number) {
    setFrames((prev) => {
      const src = prev[from]
      if (!src || !prev[to]) return prev
      return prev.map((f, i) => (i !== to ? f : {
        ...f,
        frame: {
          ...f.frame,
          count: src.frame.count,
          transformationCount: src.frame.transformationCount,
          transformationIndices: [...src.frame.transformationIndices],
          transformationX: [...src.frame.transformationX],
          transformationY: [...src.frame.transformationY],
          transformationZ: [...src.frame.transformationZ],
          transformationFlags: [...src.frame.transformationFlags],
          skippedReferences: [...src.frame.skippedReferences],
        },
      }))
    })
    touch()
  }

  const loopBackAt = seq.loopDelay >= 0 && seq.loopDelay <= frames.length
    ? frames.length - seq.loopDelay
    : null

  // Frames can arrive without labels (state preserved across a hot reload from
  // before labels existed). Backfill instead of falling back at render time —
  // a positional fallback shows 1,2,3 in every order, which is exactly the
  // "did my drag even work" problem labels exist to solve.
  useEffect(() => {
    if (frames.length > 0 && frames.some((f) => f.label == null)) {
      setFrames((prev) => prev.map((f, i) => (f.label == null ? { ...f, label: i + 1 } : f)))
    }
  }, [frames])

  /** Field-wise: a frame parsed from disk and one built here can stringify
   *  with different key orders, so JSON comparison would false-positive. */
  function sameFrame(a: AnimationFrameDef, b: AnimationFrameDef): boolean {
    const eq = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i])
    return a.frameBaseId === b.frameBaseId && a.count === b.count
      && a.transformationCount === b.transformationCount
      && a.unknownByte0 === b.unknownByte0
      && a.modifiesAlpha === b.modifiesAlpha && a.modifiesColor === b.modifiesColor && a.aBool988 === b.aBool988
      && eq(a.transformationIndices, b.transformationIndices)
      && eq(a.transformationX, b.transformationX)
      && eq(a.transformationY, b.transformationY)
      && eq(a.transformationZ, b.transformationZ)
      && eq(a.transformationFlags, b.transformationFlags)
      && eq(a.skippedReferences, b.skippedReferences)
  }

  /**
   * Write everything the animation needs, in the only order that is safe.
   *
   * Frame sets are SHARED — 363 of them serve 10+ sequences — so an edited
   * pose is never written over the file it came from: it goes to a FRESH file
   * id in the same set (copy-on-write) and only this sequence is repointed.
   * Unedited frames keep their original files untouched. Re-saving the same
   * edit writes nothing new, because the comparison then matches the copy.
   *
   * The sequence is rewritten with the parallel arrays the client expects:
   * frameSetIds, packed frameHashes ((setId << 16) | fileId), frameDurations —
   * and every OTHER per-frame array it carries (sounds, interleave order)
   * permuted by the same reorder, defaults for added frames, so a reordered
   * animation cannot end up with frame 3's footstep sound on frame 7.
   */
  async function save() {
    if (!root || frames.length === 0 || saving) return
    setSaving(true)
    setSaveNote('')
    try {
      const setsDir = await resolveEntryHandle(root, getEntryPath('animation_frame_sets'))
      const animsDir = await resolveEntryHandle(root, getEntryPath('animations'))
      const setLoader = getLoader('animation_frame_sets')
      if (!setsDir || !animsDir || !setLoader) throw new Error('animation entries not available')

      const setCache = new Map<number, AnimationFrameSetData>()
      const loadSet = async (id: number): Promise<AnimationFrameSetData> => {
        let cached = setCache.get(id)
        if (!cached) {
          cached = await setLoader.loadItem(setsDir, { id, name: String(id) }, root) as AnimationFrameSetData
          setCache.set(id, cached)
        }
        return cached
      }

      const updated: StudioFrame[] = []
      let wrote = 0
      for (const f of frames) {
        const set = await loadSet(f.setId)
        if (f.fileId >= 0) {
          const disk = set.frames.get(f.fileId)
          if (disk && sameFrame(disk, f.frame)) { updated.push(f); continue }
        }
        let nid = 0
        for (const k of set.frames.keys()) if (k >= nid) nid = k + 1
        if (nid > 0xffff) throw new Error(`Frame set ${f.setId} is full — no free file id`)
        set.frames.set(nid, f.frame)
        const setDirHandle = await setsDir.getDirectoryHandle(String(f.setId))
        const fileHandle = await setDirHandle.getFileHandle(`${nid}.json`, { create: true })
        const writable = await fileHandle.createWritable()
        await writable.write(JSON.stringify(f.frame))
        await writable.close()
        wrote++
        updated.push({ ...f, fileId: nid })
      }

      const src = savedDefRef.current
      const frameCount = src.frameDurations?.length ?? 0
      const def2: AnimationDef = {
        ...src,
        ...defEdits,
        frameSetIds: updated.map((f) => f.setId),
        frameHashes: updated.map((f) => ((f.setId & 0xffff) << 16) | (f.fileId & 0xffff)),
        frameDurations: updated.map((f) => f.durationCycles),
      }
      const PER_FRAME = ['interLeaveOrder', 'interfaceFrames', 'soundSettings', 'frameSoundVolume', 'soundMinDelay', 'soundMaxDelay'] as const
      for (const key of PER_FRAME) {
        const arr = src[key] as unknown[] | undefined
        if (!Array.isArray(arr) || arr.length !== frameCount) continue
        const fallback = key === 'soundSettings' ? null : typeof arr[0] === 'boolean' ? false : 0
        ;(def2 as unknown as Record<string, unknown>)[key] =
          updated.map((f) => (f.srcIndex >= 0 && f.srcIndex < arr.length ? arr[f.srcIndex] : fallback))
      }
      await writeJsonItem(animsDir, data.id, def2)
      savedDefRef.current = def2

      invalidateAnimCompatIndex()
      // the written state is the new baseline: real file ids, positions as
      // source indices, and the session numbers compacted back to 1..n
      setFrames(updated.map((f, i) => ({ ...f, srcIndex: i, label: i + 1 })))
      setDefEdits({})
      setDirty(false)
      setSaveNote(wrote > 0
        ? `Saved — ${wrote} frame file${wrote === 1 ? '' : 's'} written, sequence ${data.id} updated.`
        : `Saved — sequence ${data.id} updated.`)
    } catch (err) {
      setSaveNote(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    setDefEdits({})
    setDirty(false)
    setSaveNote('')
    setReloadNonce((n) => n + 1)
  }

  const totalCycles = frames.reduce((n, f) => n + f.durationCycles, 0)

  /** Ruler marks: labelled majors, with unlabelled minor stubs between them so
   *  timing is readable anywhere on the track without counting. */
  const ticks = useMemo(() => {
    const step = [1, 2, 5, 10, 25, 50, 100, 250].find((v) => v * TIMELINE_PX >= 44) ?? 250
    const majors: number[] = []
    for (let c = 0; c <= totalCycles; c += step) majors.push(c)
    const minorStep = step >= 5 ? step / 5 : 0
    const minors: number[] = []
    if (minorStep) for (let c = 0; c <= totalCycles; c += minorStep) if (c % step !== 0) minors.push(c)
    return { majors, minors }
  }, [totalCycles])

  function cycleAt(clientX: number): number {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / TIMELINE_PX)
  }

  /** Put the playhead where the pointer is — which is also how you restart, so
   *  there is no separate button for it. */
  function scrubTo(clientX: number) {
    const cycle = cycleAt(clientX)
    let at = 0
    for (let i = 0; i < frames.length; i++) {
      const end = at + frames[i].durationCycles
      if (cycle < end || i === frames.length - 1) {
        setFrameIndex(i)
        setElapsed(Math.max(0, Math.min(cycle - at, frames[i].durationCycles)))
        return
      }
      at = end
    }
  }

  /** The frame under a pointer x. */
  function frameAtX(clientX: number): number {
    const cycle = cycleAt(clientX)
    let at = 0
    for (let i = 0; i < frames.length; i++) {
      const end = at + frames[i].durationCycles
      if (cycle < end) return i
      at = end
    }
    return frames.length - 1
  }

  /** Drop a dragged frame where the pointer is. Everything after it shifts by
   *  this frame's own duration on its own, because the layout is cumulative. */
  function dropFrame(clientX: number) {
    if (!dragFrame) return
    const target = frameAtX(clientX)
    if (target === dragFrame.from) return
    setFrames((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragFrame.from, 1)
      next.splice(target, 0, moved)
      return next
    })
    setFrameIndex(target)
    touch()
  }

  if (status) {
    return (
      <div className="item-viewer">
        <div className="item-header">
          <div className="item-title-row">
            <span className="enum-title">Animation studio — {data.id}</span>
            <button type="button" className="field-link-btn" onClick={onClose}>Back</button>
          </div>
        </div>
        <p className="anim-preview-status">{status}</p>
      </div>
    )
  }

  return (
    <div className="item-viewer anim-studio">
      <div className="item-header">
        <div className="item-title-row">
          <span className="enum-title">Animation studio — {data.id}</span>
          <button
            type="button"
            className="field-link-btn"
            onClick={() => {
              if (dirty && !window.confirm('Leave the studio? Unsaved changes are lost.')) return
              onClose()
            }}
          >
            Back to the sequence
          </button>
        </div>
        <div className="item-badges">
          <span className="item-id-badge">{frames.length} frames</span>
          <span className="item-id-badge">{(totalCycles * 0.02).toFixed(2)}s</span>
          <span className="item-id-badge">{poseable.length} poseable parts</span>
          <span className="item-id-badge">skeleton {frames[0]?.frame.frameBaseId}</span>
        </div>
      </div>

      <p className="tex-op-note">
        Pose the model, and each frame of the animation is that pose. Click a part of the model to
        select it, then drag its handle. Saving writes edited poses as NEW frame files and repoints
        this sequence at them — other animations sharing the same frames are never touched.
      </p>

      <div className="anim-studio-body">
        <div className="anim-studio-rig">
          <div className="anim-studio-righead">
            <h3>Rig</h3>
            <span className="btn-pill">
              <button
                type="button"
                className={`zoom-btn${sortMode === 'tree' ? ' active' : ''}`}
                title="Each part followed by its children, indented by depth"
                onClick={() => setSortMode('tree')}
              >
                Tree
              </button>
              <button
                type="button"
                className={`zoom-btn${sortMode === 'id' ? ' active' : ''}`}
                title="By part number, flat — the indent would mean nothing in this order"
                onClick={() => setSortMode('id')}
              >
                Ascending
              </button>
            </span>
          </div>
          {rig == null ? <p className="anim-preview-status">No skeleton.</p> : (
            <ul className="anim-studio-parts">
              {listed.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`anim-studio-part${selectedPart === p.id ? ' active' : ''}${p.poseable ? '' : ' pivot'}`}
                    style={{ paddingLeft: sortMode === 'tree' ? 8 + Math.min(p.depth, 10) * 10 : 8 }}
                    title={`${p.channels.map((c) => TYPE_WORD[c.type] ?? c.type).join(', ')} · groups ${p.labels.join(', ')}`}
                    onMouseEnter={() => setHoverPart(p.id)}
                    onDoubleClick={() => {
                      const slot = p.channels.find((c) => c.type === 0)?.slot
                      if (slot != null && !p.poseable) setPivot(slot)
                    }}
                    onMouseLeave={() => setHoverPart((cur) => (cur === p.id ? null : cur))}
                    onClick={() => setSelectedPart(p.id)}
                  >
                    {p.poseable
                      ? partLabel(rig, p.id)
                      : `${partLabel(rig, p.id)} · pivot${pivotUsedBy(p) > 0 ? ` · used by ${pivotUsedBy(p)}` : ' · unused here'}`}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="anim-studio-stage">
          <div className="anim-preview-toolbar">
            <span className="sprite-zoom-label">Model</span>
            <IntListInput
              value={modelIds.length > 0 ? modelIds : undefined}
              onChange={(v) => setModelIds(v ?? [])}
              placeholder="model ids"
            />
            <button type="button" className="replace-btn" onClick={() => void loadModel(modelIds)}>Load</button>
            {candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                className="field-link-btn"
                onClick={() => { setModelIds(c.modelIds); void loadModel(c.modelIds) }}
              >
                {c.label}
              </button>
            ))}
            {candidates.length === 0 && peekAnimCompatIndex() == null && (
              scanning
                ? <span className="map-sprite-hint">{scanLabel(scanning, 'files')}</span>
                : <button type="button" className="cursor-pick-btn" onClick={scan}>Find models</button>
            )}
          </div>
          {modelError && <p className="anim-preview-status">{modelError}</p>}

          {selectedPart != null && rig && (
            <div className="anim-preview-toolbar">
              <span className="sprite-zoom-label">{partLabel(rig, selectedPart)}</span>
              {channels.length === 0 ? (
                usersOfSelected.length > 0 ? (
                  <>
                    <span className="map-sprite-hint">a pivot — turned about by</span>
                    {usersOfSelected.map((id) => (
                      <button key={id} type="button" className="field-link-btn" onClick={() => setSelectedPart(id)}>
                        {partLabel(rig, id)}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="map-sprite-hint">
                    a pivot, and nothing in this animation turns about it — select a part and choose it
                    from “turns about” to use it
                  </span>
                )
              ) : (
                <span className="btn-pill">
                  {channels.map((c) => (
                    <button
                      key={c.slot}
                      type="button"
                      className={`zoom-btn${channelType === c.type ? ' active' : ''}`}
                      onClick={() => setChannelType(c.type)}
                    >
                      {TYPE_WORD[c.type] ?? c.type}
                    </button>
                  ))}
                </span>
              )}
              {(channelType === 2 || channelType === 3) && (
                <label className="anim-studio-pivot">
                  <span>turns about</span>
                  <select
                    className="item-stackable-select"
                    value={String(pivotSlot)}
                    title="The joint this rotation pivots on. Pick the one nearest the part — a hand turning about the shoulder is what stretches the arm."
                    onChange={(e) => setPivot(Number(e.target.value))}
                  >
                    <option value="-1">model origin (no pivot)</option>
                    {/* Labelled by PART, the same number the rig list shows.
                        The option's value is still the slot, because that is
                        what an entry's `skip` names — but nobody should have to
                        know both numbering systems to find a joint. */}
                    {pivotChoices.map((p) => {
                      const slot = p.channels.find((c) => c.type === 0)!.slot
                      const used = pivotUsers.get(slot)?.size ?? 0
                      return (
                        <option key={slot} value={slot}>
                          part {p.id} · {p.labels.length} group{p.labels.length === 1 ? '' : 's'}
                          {used > 0 ? ` · used by ${used}` : ''}
                        </option>
                      )
                    })}
                  </select>
                </label>
              )}
              <button type="button" className="field-link-btn" onClick={() => setSelectedPart(null)}>Deselect</button>
            </div>
          )}
          {model ? (
            <ModelViewer
              data={model}
              posedVertices={posed}
              highlightVertices={highlight}
              cameraStateRef={cameraStateRef}
              onPickVertex={onPickVertex}
              gizmo={gizmoMode && gizmoPos ? { mode: gizmoMode, position: gizmoPos } : null}
              onGizmoTransform={onGizmoTransform}
              onGizmoDragging={onGizmoDragging}
              hideHeader
            />
          ) : (
            <p className="anim-preview-status">Load a model rigged to this skeleton to start posing.</p>
          )}

          {/* A timeline, not a strip: cells are laid out ON a time axis, so
              their width and position are when they happen, and the playhead
              sweeps across it as the animation runs. */}
          <div className="anim-studio-transport">
            <span className="btn-pill">
              <button
                type="button"
                className="zoom-btn"
                disabled={frameIndex === 0}
                onClick={() => { setPlaying(false); setFrameIndex(frameIndex - 1); setElapsed(0) }}
              ><span className="anim-studio-glyph">◀</span> Prev</button>
              <button
                type="button"
                className={`zoom-btn anim-preview-play${playing ? ' active' : ''}`}
                onClick={() => setPlaying((p) => !p)}
              >{playing ? <><span className="anim-studio-glyph">⏸</span> Pause</> : <><span className="anim-studio-glyph">▶</span> Play</>}</button>
              <button
                type="button"
                className="zoom-btn"
                disabled={frameIndex >= frames.length - 1}
                onClick={() => { setPlaying(false); setFrameIndex(frameIndex + 1); setElapsed(0) }}
              >Next <span className="anim-studio-glyph">▶</span></button>
            </span>
            <button
              type="button"
              className={`zoom-btn${tweened ? ' active' : ''}`}
              title="Blend between frames while playing, the way the client does for sequences with the tweened flag"
              onClick={() => setTweened((t) => !t)}
            >
              Tweening {tweened ? 'on' : 'off'}
            </button>
            <span className="map-sprite-hint">
              frame {frames[frameIndex]?.label ?? frameIndex + 1}/{frames.length} · {(totalCycles * 0.02).toFixed(2)}s
              {seq.tweened !== tweened && ` · the sequence says tweened: ${seq.tweened ? 'on' : 'off'}`}
            </span>
          </div>

          <div className="anim-preview-toolbar">
            <button
              type="button"
              className="add-row-btn"
              title="Insert a new frame after this one, starting from the current pose"
              onClick={() => addFrameAfter(frameIndex)}
            >
              + Add Frame
            </button>
            <button
              type="button"
              className="remove-btn"
              disabled={frames.length <= 1}
              title="Remove this frame — the frames after it close the gap"
              onClick={() => removeFrame(frameIndex)}
            >
              × Remove Frame
            </button>
            <button
              type="button"
              className="field-link-btn"
              disabled={frameIndex === 0}
              title="Replace this frame's pose with frame 1's, keeping its timing"
              onClick={() => copyPose(0, frameIndex)}
            >
              Reset to frame 1's pose
            </button>
            <label className="anim-studio-pivot">
              <span>holds for</span>
              <NumberInput
                className="cell-input"
                value={frames[frameIndex]?.durationCycles ?? 1}
                min={1}
                title="Cycles this frame is held — 20ms each, so 5 is a tenth of a second"
                onChange={(v) => setDuration(frameIndex, v)}
              />
            </label>
            <span className="map-sprite-hint">
              {((frames[frameIndex]?.durationCycles ?? 0) * 0.02).toFixed(2)}s · {frames.length} frames
            </span>
          </div>

          {/* Time runs left to right and a cell's width IS how long it's held.
              Drag a cell to reorder — the frames after it shift by that frame's
              duration on their own, because the layout is cumulative. Drag the
              track to scrub, which is also how you restart. */}
          <div className="anim-studio-timeline">
            <div
              ref={trackRef}
              className="anim-studio-track"
              style={{ width: Math.max(240, totalCycles * TIMELINE_PX + 24) }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('.anim-studio-cell')) return
                e.currentTarget.setPointerCapture(e.pointerId)
                setPlaying(false)
                scrubTo(e.clientX)
              }}
              onPointerMove={(e) => {
                if (dragFrame) setDragFrame({ ...dragFrame, x: e.clientX, target: frameAtX(e.clientX), cycle: cycleAt(e.clientX) })
                else if (e.buttons === 1) scrubTo(e.clientX)
              }}
              onPointerUp={() => { if (dragFrame) dropFrame(dragFrame.x); setDragFrame(null) }}
              onPointerCancel={() => setDragFrame(null)}
            >
              <div className="anim-studio-ruler">
                {ticks.minors.map((c) => (
                  <span key={`m${c}`} className="anim-studio-tick minor" style={{ left: c * TIMELINE_PX }} />
                ))}
                {ticks.majors.map((c) => (
                  <span key={c} className="anim-studio-tick" style={{ left: c * TIMELINE_PX }}>
                    {(c * 0.02).toFixed(2)}s
                  </span>
                ))}
              </div>

              {/* Major ticks continue down through the lane as faint gridlines,
                  so a pose can be read against the ruler without a straightedge. */}
              {ticks.majors.map((c) => (
                <span key={`g${c}`} className="anim-studio-grid" style={{ left: c * TIMELINE_PX }} />
              ))}

              <div className="anim-studio-lane">
                {loopBackAt != null && (
                  <div
                    className="anim-studio-looprgn"
                    style={{
                      left: frames.slice(0, loopBackAt).reduce((n, f) => n + f.durationCycles, 0) * TIMELINE_PX,
                      width: frames.slice(loopBackAt).reduce((n, f) => n + f.durationCycles, 0) * TIMELINE_PX,
                    }}
                    title="The loop returns here — this stretch repeats"
                  />
                )}
                {(() => {
                  let at = 0
                  return frames.map((f, i) => {
                    const left = at * TIMELINE_PX
                    at += f.durationCycles
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`anim-studio-cell${i === frameIndex ? ' active' : ''}${f.fileId < 0 ? ' fresh' : ''}${i === loopBackAt ? ' loopstart' : ''}${dragFrame?.from === i ? ' dragging' : ''}`}
                        style={{ left, width: Math.max(10, f.durationCycles * TIMELINE_PX - 2) }}
                        title={`Frame ${f.label ?? i + 1} · ${f.durationCycles} cycles (${(f.durationCycles * 0.02).toFixed(2)}s)${f.fileId < 0 ? ' · new' : ''} — drag to reorder`}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          // capture on the TRACK: its move/up handlers keep
                          // firing even when the pointer leaves it, so a drag
                          // can't be cancelled by drifting a few pixels up
                          trackRef.current?.setPointerCapture(e.pointerId)
                          setPlaying(false)
                          setFrameIndex(i)
                          setElapsed(0)
                          setDragFrame({ from: i, grabX: e.clientX, x: e.clientX, target: i, cycle: cycleAt(e.clientX) })
                        }}
                      >
                        <span className="anim-studio-key" />
                        <span className="anim-studio-hold" />
                        <span className="anim-studio-cellbody">
                          {f.durationCycles * TIMELINE_PX > 12 && <span className="anim-studio-cellno">{f.label ?? i + 1}</span>}
                          {f.durationCycles * TIMELINE_PX > 64 && (
                            <span className="anim-studio-cellms">{(f.durationCycles * 0.02).toFixed(2)}s</span>
                          )}
                        </span>
                      </button>
                    )
                  })
                })()}
                <span className="anim-studio-end" style={{ left: totalCycles * TIMELINE_PX }} />
                {dragFrame && dragFrame.target !== dragFrame.from && (
                  <span
                    className="anim-studio-dropind"
                    style={{ left: frames.slice(0, dragFrame.target).reduce((n, f) => n + f.durationCycles, 0) * TIMELINE_PX }}
                  />
                )}
                {/* The picked-up frame itself, riding under the pointer. Only
                    once the pointer has really moved, or every click flashes it. */}
                {dragFrame && Math.abs(dragFrame.x - dragFrame.grabX) > 4 && frames[dragFrame.from] && (
                  <div
                    className="anim-studio-ghost"
                    style={{
                      left: dragFrame.cycle * TIMELINE_PX - (frames[dragFrame.from].durationCycles * TIMELINE_PX) / 2,
                      width: Math.max(14, frames[dragFrame.from].durationCycles * TIMELINE_PX),
                    }}
                  >
                    <span className="anim-studio-key" />
                    <span className="anim-studio-hold" />
                    <span className="anim-studio-cellbody">
                      <span className="anim-studio-cellno">{frames[dragFrame.from].label ?? dragFrame.from + 1}</span>
                    </span>
                  </div>
                )}
              </div>

              <div
                className="anim-studio-playhead"
                style={{ left: (frames.slice(0, frameIndex).reduce((n, f) => n + f.durationCycles, 0) + elapsed) * TIMELINE_PX }}
              />
            </div>
          </div>

          <p className="map-sprite-hint">
            {loopBackAt == null
              ? `Plays once and stops (loop delay ${seq.loopDelay}). To loop the whole thing, loop delay must equal the frame count — ${frames.length}.`
              : loopBackAt === 0
              ? 'Loops the whole animation — the last frame runs, then it starts again at frame 1.'
              : `Loops back to frame ${frames[loopBackAt]?.label ?? loopBackAt + 1}, so only the last ${frames.length - loopBackAt} frames repeat.`}
          </p>
          {frames.length > 1 && (
            <p className={endSnap > 0 ? 'varbit-problem' : 'map-sprite-hint'}>
              {endSnap === 0
                ? 'The last frame matches the first, so the animation ends where it began — no snap when it hands back to the stance.'
                : `The last frame differs from the first in ${endSnap} transform${endSnap === 1 ? '' : 's'}, so the model will jump when the animation ends and the stance takes over.`}
            </p>
          )}
          {frames.length > 1 && endSnap > 0 && (
            <div className="anim-studio-fixrow">
              <button
                type="button"
                className="add-row-btn"
                title="Copy frame 1's pose onto the last frame, so it lands where it started"
                onClick={() => copyPose(0, frames.length - 1)}
              >
                Match the first frame
              </button>
            </div>
          )}
        </div>
      </div>

      <section className="item-section">
        <h3>Sequence options</h3>
        <p className="map-sprite-hint">
          How the client runs this animation — saved with it. Sounds, script hooks and the rest stay
          on the raw animations page.
        </p>
        <div className="anim-studio-optgrid">
          <label className="anim-studio-opt">
            <span>Loop delay</span>
            <NumberInput className="cell-input" value={seq.loopDelay} min={-1} onChange={(v) => editSeq({ loopDelay: v })} />
            <button
              type="button"
              className="field-link-btn"
              disabled={seq.loopDelay === frames.length}
              title="Set the loop delay to the frame count, so the whole animation repeats"
              onClick={() => editSeq({ loopDelay: frames.length })}
            >
              loop all
            </button>
            <em>
              How much of the TAIL repeats: playback restarts at frame count − loop delay, not at
              frame 1. −1 never loops (73% of sequences); {frames.length} loops this whole animation.
              The amber region on the timeline follows this.
            </em>
          </label>
          <label className="anim-studio-opt">
            <span>Max loops</span>
            <NumberInput className="cell-input" value={seq.maxLoops} min={0} onChange={(v) => editSeq({ maxLoops: v })} />
            <em>Times the loop runs before the animation ends. 99 is the near-universal value; 1 plays through once.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Tweened</span>
            <input
              type="checkbox"
              checked={seq.tweened === true}
              onChange={(e) => { editSeq({ tweened: e.target.checked }); setTweened(e.target.checked) }}
            />
            <em>
              Blend between keyframes instead of stepping — the transport’s preview toggle follows
              this. 8,211 of 17,186 sequences set it; a deliberately snappy animation should not.
            </em>
          </label>
          <label className="anim-studio-opt">
            <span>Priority</span>
            <NumberInput className="cell-input" value={seq.priority} min={-1} onChange={(v) => editSeq({ priority: v })} />
            <em>Which animation wins when two want the same entity — higher beats lower. −1 is the common default.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Animating precedence</span>
            <NumberInput className="cell-input" value={seq.animatingPrecedence} min={-1} onChange={(v) => editSeq({ animatingPrecedence: v })} />
            <em>What shows when another animation is already playing. Darkan’s name; exact semantics untraced — −1 default.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Walking precedence</span>
            <NumberInput className="cell-input" value={seq.walkingPrecedence} min={-1} onChange={(v) => editSeq({ walkingPrecedence: v })} />
            <em>What shows while the entity is moving — whether the walk or this animation wins. Untraced beyond the name; −1 default.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Replay mode</span>
            <NumberInput className="cell-input" value={seq.replayMode} min={0} max={2} onChange={(v) => editSeq({ replayMode: v })} />
            <em>Untraced beyond its values: 16,695 of 17,186 sequences store 2 (0 and 1 are rare). Change with care.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Left hand item</span>
            <NumberInput className="cell-input" value={seq.leftHandItem} min={0} max={65535} onChange={(v) => editSeq({ leftHandItem: v })} />
            <em>Item shown in the left hand while this plays (weapon/shield substitution). 65535 = no override.</em>
          </label>
          <label className="anim-studio-opt">
            <span>Right hand item</span>
            <NumberInput className="cell-input" value={seq.rightHandItem} min={0} max={65535} onChange={(v) => editSeq({ rightHandItem: v })} />
            <em>Item shown in the right hand while this plays. 65535 = no override.</em>
          </label>
        </div>
      </section>

      {saveNote && <p className="map-sprite-hint anim-studio-savenote">{saveNote}</p>}

      {dirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={discard}>Discard</button>
          <button
            type="button"
            className="save-bar-save"
            disabled={saving}
            title="Edited poses become new frame files (copy-on-write); unedited frames and other sequences are untouched"
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

/** Pixels per 20ms cycle on the timeline. */
const TIMELINE_PX = 10

const TYPE_WORD: Record<number, string> = { 0: 'pivot', 1: 'move', 2: 'rotate', 3: 'scale' }
