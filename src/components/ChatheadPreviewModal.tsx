import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { IComponentDefinition, InterfaceData } from '../loaders/interfaces'
import type { ModelData } from '../loaders/models'
import { loadModelComposite } from '../loaders/npcComposite'
import type { ModelCompositeSpec } from '../loaders/npcComposite'
import type { AnimationDef } from '../loaders/animations'
import { frameFileId } from '../loaders/animations'
import { DEFAULT_HEAD_ANIMATION, HEAD_ANIMATIONS } from '../loaders/headAnimations'
import { useSequencePlayback } from './useSequencePlayback'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import { InterfaceAssets, loadPreviewAssets, paintInterface, resolveAbsoluteLayout } from './interfacePreview'
import type { LayoutRect } from './interfacePreview'
import './AnimationViewer.css' // reuses the .anim-preview-dialog modal styles

// Renders the game's actual NPC dialogue interface (1184) with the NPC's
// merged head models sitting in the chathead slot — the same painter the
// interfaces page uses, so fonts/sprites/model projection all match the
// client. Component 11 is the chathead MODEL slot (modelId −1 until runtime),
// 17 the name/title line, 13 the dialogue body text. Dialogue emotes (HeadE)
// play on the merged head via the shared sequence-playback hook, repainting
// the model component per frame.
const DIALOGUE_INTERFACE = 1184
const CHATHEAD_COMPONENT = 11
const TEXT_COMPONENT = 13
const TITLE_COMPONENT = 17
/** Synthetic model id primed into InterfaceAssets for the merged chathead. */
const MERGED_CHATHEAD_MODEL_ID = 0x7ffffff0
// The client opens dialogue interfaces inside the chatbox window's dialog
// slot, and 1184's root fills that parent exactly. Fixed mode: the chatbox
// (interface 752) sits in pane component 548:168 at 519×142 (from the dump's
// layout chain), and its dialog slot 752:13 insets 5px per side → 509×132.
// Rendering at that size gives the pixel-exact in-game box, no cropping.
const VIEWPORT_W = 509
const VIEWPORT_H = 132
const SCALE = 2
const PAINT_OPTS = { showHidden: false, showContainerOutlines: false }

// ---------------------------------------------------------------------------
// Emote probing: an emote fits a chathead when its skeleton (the frame base
// behind the sequence's first frame) addresses any of the head's vertex-skin
// labels — same fit criterion the anim-compat index uses. Reads one anim
// JSON, ONE frame file of its first frame set, and the base JSON; session-
// cached per emote id.
// ---------------------------------------------------------------------------
type ProbedAnim = { def: AnimationDef; labels: Set<number> }
const probeCache = new Map<number, Promise<ProbedAnim | null>>()

function probeAnim(root: FileSystemDirectoryHandle, animId: number): Promise<ProbedAnim | null> {
  let p = probeCache.get(animId)
  if (!p) {
    p = (async (): Promise<ProbedAnim | null> => {
      try {
        const readJson = async (dir: FileSystemDirectoryHandle, name: string) =>
          JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text())
        const animsDir = await resolveEntryHandle(root, getEntryPath('animations'))
        if (!animsDir) return null
        const def = await readJson(animsDir, `${animId}.json`) as AnimationDef
        const setId = def.frameSetIds?.[0]
        if (setId == null || setId < 0) return null
        const setsDir = await resolveEntryHandle(root, getEntryPath('animation_frame_sets'))
        if (!setsDir) return null
        const setFolder = await setsDir.getDirectoryHandle(String(setId))
        const frame = await readJson(setFolder, `${frameFileId(def, 0)}.json`) as { frameBaseId?: number }
        if (frame.frameBaseId == null) return null
        const basesDir = await resolveEntryHandle(root, getEntryPath('animation_frame_bases'))
        if (!basesDir) return null
        const base = await readJson(basesDir, `${frame.frameBaseId}.json`) as { labels?: number[][] }
        const labels = new Set<number>()
        for (const arr of base.labels ?? []) for (const label of arr ?? []) labels.add(label)
        return { def, labels }
      } catch {
        return null
      }
    })()
    probeCache.set(animId, p)
  }
  return p
}

type Scene = {
  assets: InterfaceAssets
  components: (IComponentDefinition | null)[]
  layout: Map<number, LayoutRect>
  resolved: Awaited<ReturnType<typeof loadPreviewAssets>>
  merged: ModelData
  chatheadComp: IComponentDefinition
  chatheadRect: LayoutRect
  chatheadClip: LayoutRect
}

export default function ChatheadPreviewModal({ rootHandle, headModelIds, npcName, recolor, tint, onClose }: {
  rootHandle: FileSystemDirectoryHandle
  headModelIds: number[]
  /** Title line (component 17) — the NPC's name, like a real dialogue. */
  npcName: string
  /** The NPC's recolour/retexture pairs — the client applies them to head
   *  models too (Hans's brown hair is a recolour, not the mesh default). */
  recolor?: ModelCompositeSpec['recolor']
  /** Def tint — NPCType's head builder applies it after recolours. */
  tint?: ModelCompositeSpec['tint']
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<Scene | null>(null)
  const [status, setStatus] = useState('Rendering dialogue…')
  const [merged, setMerged] = useState<ModelData | null>(null)
  const [emotes, setEmotes] = useState<{ name: string; animId: number }[] | null>(null)
  const [selectedEmote, setSelectedEmote] = useState(DEFAULT_HEAD_ANIMATION)
  const [animation, setAnimation] = useState<AnimationDef | null>(null)

  useEffect(() => { dialogRef.current?.showModal() }, [])

  const { posedVertices, status: playStatus } = useSequencePlayback(animation, merged, rootHandle, true)

  function repaint(posed: PosedVertices | null) {
    const scene = sceneRef.current
    const canvas = canvasRef.current
    if (!scene || !canvas) return
    const { assets, components, layout, resolved, merged: model, chatheadComp, chatheadRect, chatheadClip } = scene
    const toRender = posed && posed.x.length === model.vertexCount
      ? {
          ...model,
          vertexX: posed.x,
          vertexY: posed.y,
          vertexZ: posed.z,
          // type 5/7 face effects — blinking is a type-5 alpha transform
          faceAlpha: posed.faceAlpha ?? model.faceAlpha,
          faceColor: posed.faceColor ?? model.faceColor,
        }
      : model
    resolved.modelRenders.set(CHATHEAD_COMPONENT, assets.renderModelFrame(toRender, chatheadComp, chatheadRect, chatheadClip))
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H)
    ctx.imageSmoothingEnabled = false
    paintInterface(ctx, components, layout, resolved, VIEWPORT_W, VIEWPORT_H, PAINT_OPTS)
  }

  // Posed frames land here at the animation's own cadence.
  useEffect(() => { repaint(posedVertices) }, [posedVertices]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build the dialogue scene once per open.
  useEffect(() => {
    let cancelled = false
    const assets = new InterfaceAssets(rootHandle)
    ;(async () => {
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('interfaces'))
        const loader = getLoader('interfaces')
        if (!dir || !loader) throw new Error('interfaces entry not available')
        const iface = await loader.loadItem(
          dir, { id: DIALOGUE_INTERFACE, name: String(DIALOGUE_INTERFACE) }, rootHandle,
        ) as InterfaceData

        // The client merges head/hair/beard into one chathead mesh, with the
        // NPC's recolour/retexture pairs and tint applied (NPCType.kt order).
        const composite = await loadModelComposite(rootHandle, { modelIds: headModelIds, recolor, tint })
        assets.primeModel(MERGED_CHATHEAD_MODEL_ID, composite)

        const components = iface.components.map((c) => {
          if (!c) return c
          if (c.componentId === TITLE_COMPONENT) return { ...c, text: npcName || 'Preview Chathead Model' }
          if (c.componentId === TEXT_COMPONENT) return { ...c, text: `Previewing ChatHead Model ${headModelIds.join(', ')}` }
          if (c.componentId === CHATHEAD_COMPONENT) return { ...c, modelId: MERGED_CHATHEAD_MODEL_ID }
          return c
        })

        const layout = resolveAbsoluteLayout(components, VIEWPORT_W, VIEWPORT_H)
        const resolved = await loadPreviewAssets(assets, components, layout, VIEWPORT_W, VIEWPORT_H, PAINT_OPTS)
        if (cancelled) return

        const chatheadComp = components.find((c) => c?.componentId === CHATHEAD_COMPONENT)
        const chatheadRect = layout.get(CHATHEAD_COMPONENT)
        const chatheadClip = resolved.clips.get(CHATHEAD_COMPONENT)
        if (!chatheadComp || !chatheadRect || !chatheadClip) throw new Error('no chathead slot')

        sceneRef.current = { assets, components, layout, resolved, merged: composite, chatheadComp, chatheadRect, chatheadClip }
        const canvas = canvasRef.current!
        canvas.width = VIEWPORT_W * SCALE
        canvas.height = VIEWPORT_H * SCALE
        // rendered at 2× for crispness, displayed at native size
        canvas.style.width = `${VIEWPORT_W}px`
        canvas.style.height = `${VIEWPORT_H}px`
        repaint(null)
        setStatus('')
        setMerged(composite)

        // Emote viability: which HeadE skeletons address this head's labels.
        const headLabels = new Set<number>()
        if (composite.vertexSkins) for (let v = 0; v < composite.vertexCount; v++) headLabels.add(composite.vertexSkins[v])
        const probes = await Promise.all(HEAD_ANIMATIONS.map(async (e) => {
          const probed = await probeAnim(rootHandle, e.animId)
          if (!probed) return null
          for (const label of probed.labels) if (headLabels.has(label)) return e
          return null
        }))
        if (cancelled) return
        setEmotes(probes.filter((e): e is { name: string; animId: number } => e != null))
      } catch {
        if (!cancelled) setStatus(`Couldn't render dialogue interface ${DIALOGUE_INTERFACE}.`)
      }
    })()
    return () => {
      cancelled = true
      sceneRef.current = null
      assets.dispose()
    }
    // recolor/tint are rebuilt by the caller each render; ids/name cover them
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootHandle, headModelIds, npcName])

  // Emote selection → animation def (CALM_TALK by default; falls back to the
  // first viable emote, else static).
  useEffect(() => {
    if (!emotes) return
    let cancelled = false
    const pick = emotes.some((e) => e.animId === selectedEmote)
      ? selectedEmote
      : emotes[0]?.animId ?? -1
    if (pick !== selectedEmote) { setSelectedEmote(pick); return }
    if (pick < 0) { setAnimation(null); return }
    probeAnim(rootHandle, pick).then((probed) => {
      if (!cancelled) setAnimation(probed?.def ?? null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emotes, selectedEmote])

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Chathead Preview</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        {emotes && (
          <div className="anim-preview-toolbar">
            <span className="sprite-zoom-label">Dialogue emote</span>
            {emotes.length === 0 ? (
              <span className="anim-preview-status">no compatible emotes for this head's skeleton</span>
            ) : (
              <select
                className="item-stackable-select"
                value={selectedEmote}
                onChange={(e) => setSelectedEmote(parseInt(e.target.value, 10))}
              >
                {emotes.map((e) => (
                  <option key={e.name} value={e.animId}>{e.name} · {e.animId}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {status && <p className="anim-preview-status">{status}</p>}
        {!status && playStatus && <p className="anim-preview-status">{playStatus}</p>}
        <div className="chathead-preview-stage">
          <canvas ref={canvasRef} />
        </div>
      </div>
    </dialog>
  )
}
