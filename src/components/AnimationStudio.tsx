import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnimationData, AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import type { AnimationFrameBaseDef } from '../loaders/animation_frame_bases'
import type { AnimationFrameDef, AnimationFrameSetData } from '../loaders/animation_frame_sets'
import type { ModelData } from '../loaders/models'
import { buildRig, partForVertex, partLabel, partVertices } from '../loaders/animRig'
import type { Rig } from '../loaders/animRig'
import { applyAnimationFrame } from '../loaders/skeletalAnimation'
import { loadModelComposite } from '../loaders/npcComposite'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { buildAnimCompatIndex, peekAnimCompatIndex } from '../loaders/animCompat'
import { scanLabel } from '../loaders/scan'
import type { ScanProgress } from '../loaders/scan'
import { IntListInput } from './defFields'
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
}

export default function AnimationStudio({ data, onClose }: Props) {
  const root = data.rootHandle
  const def: AnimationDef = data.def

  const [frames, setFrames] = useState<StudioFrame[]>([])
  const [frameIndex, setFrameIndex] = useState(0)
  const [base, setBase] = useState<AnimationFrameBaseDef | null>(null)
  const [status, setStatus] = useState('Loading…')

  const [modelIds, setModelIds] = useState<number[]>([])
  const [model, setModel] = useState<ModelData | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [selectedPart, setSelectedPart] = useState<number | null>(null)
  const [hoverPart, setHoverPart] = useState<number | null>(null)
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

        const setIds = [...new Set((def.frameSetIds ?? []).filter((id) => id >= 0))]
        const sets = new Map<number, AnimationFrameSetData>()
        for (const id of setIds) {
          sets.set(id, await setLoader.loadItem(setsDir, { id, name: String(id) }, root) as AnimationFrameSetData)
        }
        if (cancelled) return

        const out: StudioFrame[] = []
        const durations = def.frameDurations ?? []
        ;(def.frameSetIds ?? []).forEach((setId, i) => {
          const fileId = frameFileId(def, i)
          const frame = sets.get(setId)?.frames.get(fileId)
          if (!frame || frame.rawFallbackBytes) return
          out.push({ setId, fileId, frame, durationCycles: durations[i] ?? 1 })
        })
        if (out.length === 0) { setStatus('This animation names no readable frames.'); return }

        const baseId = out[0].frame.frameBaseId
        const loaded = await baseLoader.loadItem(basesDir, { id: baseId, name: String(baseId) }, root) as { def: AnimationFrameBaseDef }
        if (cancelled) return
        setBase(loaded.def)
        setFrames(out)
        setStatus('')
      } catch (err) {
        if (!cancelled) setStatus(err instanceof Error ? err.message : 'Could not load this animation.')
      }
    })()
    return () => { cancelled = true }
  }, [root, def])

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
  const posed = useMemo(() => {
    if (!model || !base || !current) return null
    return applyAnimationFrame(model, base, current.frame)
  }, [model, base, current])

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

  const poseable = useMemo(
    () => (rig ? rig.parts.filter((p) => p.poseable) : []),
    [rig],
  )

  const totalCycles = frames.reduce((n, f) => n + f.durationCycles, 0)

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
          <button type="button" className="field-link-btn" onClick={onClose}>Back to the sequence</button>
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
        select it, then drag its handle. <strong>Nothing saves yet</strong> — this pass is the shell;
        writing the frames and the sequence back comes next.
      </p>

      <div className="anim-studio-body">
        <div className="anim-studio-rig">
          <h3>Rig</h3>
          {rig == null ? <p className="anim-preview-status">No skeleton.</p> : (
            <ul className="anim-studio-parts">
              {poseable.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`anim-studio-part${selectedPart === p.id ? ' active' : ''}`}
                    style={{ paddingLeft: 8 + p.depth * 12 }}
                    title={`${p.channels.map((c) => TYPE_WORD[c.type] ?? c.type).join(', ')} · groups ${p.labels.join(', ')}`}
                    onMouseEnter={() => setHoverPart(p.id)}
                    onMouseLeave={() => setHoverPart((cur) => (cur === p.id ? null : cur))}
                    onClick={() => setSelectedPart(p.id)}
                  >
                    {partLabel(rig, p.id)}
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
          {model ? (
            <ModelViewer
              data={model}
              posedVertices={posed}
              highlightVertices={highlight}
              cameraStateRef={cameraStateRef}
              onPickVertex={onPickVertex}
              hideHeader
            />
          ) : (
            <p className="anim-preview-status">Load a model rigged to this skeleton to start posing.</p>
          )}

          <div className="anim-studio-frames">
            {frames.map((f, i) => (
              <button
                key={i}
                type="button"
                className={`anim-frame-chip${i === frameIndex ? ' active' : ''}`}
                title={`Frame ${i + 1} — set ${f.setId} file ${f.fileId}, ${f.durationCycles} cycles`}
                onClick={() => setFrameIndex(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const TYPE_WORD: Record<number, string> = { 0: 'pivot', 1: 'move', 2: 'turn', 3: 'scale' }
