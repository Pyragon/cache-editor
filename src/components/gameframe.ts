import type { IComponentDefinition, InterfaceData } from '../loaders/interfaces'
import { loadInterfaceById } from '../loaders/interfaces'
import {
  InterfaceAssets, resolveAbsoluteLayout, loadPreviewAssets, paintInterface,
} from './interfacePreview'
import type { PreviewOptions } from './interfacePreview'
import { Cs2Interpreter } from '../cs2/interpreter'
import { makeCs2Env } from '../cs2/ops'
import { Cs2InterfaceScene } from '../cs2/runtime'
import type { Cs2Warning } from '../cs2/runtime'
import { Cs2Cache } from '../cs2/cache'

// The in-game gameframe, composed the way the SERVER builds it (cryogen
// InterfaceManager.java, traced 2026-08-02 — the full slot tables live in
// interfaces.md): a root window pane (IF_OPENTOP) with the HUD interfaces
// attached to fixed component slots (IF_OPENSUB), and the interface being
// edited plugged into whichever slot the user picks. No CS2 is involved in
// frame ASSEMBLY (verified — the server sends only opentop/opensub/sethide),
// so a script-free compositor is faithful to the frame itself; what CS2 does
// add (per-component onResize nudges, varc-driven tab switching) is listed as
// a known gap in interfaces.md.

export const FIXED_ROOT = 548
export const RESIZABLE_ROOT = 746

/** The client's fixed-mode canvas is 765×553 (client.GAME_WIDTH/HEIGHT) — the
 *  765×503 play area sits under a 50px top strip; interface 548's two
 *  top-level containers are exactly those two bands. */
export const FIXED_SIZE = { width: 765, height: 553 }
/** The client clamps a resizable canvas to at least 800×600 (Class46). */
export const RESIZABLE_MIN = { width: 800, height: 600 }

export type GameframeMode = 'fixed' | 'resizable'

/** hash = (interfaceId << 16) | componentId — the client's parent uid. */
const hash = (iface: number, comp: number) => (iface << 16) | comp

/** Always-on HUD: interface → root slot per mode (InterfaceManager
 *  sendFixedInterfaces/sendResizeableInterfaces). 745/754 (multicombat and
 *  system-update indicators) are situational and left out. */
const HUD: [iface: number, fixedSlot: number, resizableSlot: number][] = [
  [752, 168, 22], // chatbox window
  [751, 53, 23], // chat bar / filter buttons
  [748, 160, 196], // hitpoints orb
  [749, 161, 197], // prayer orb
  [750, 162, 198], // run orb (Tab.RUN)
  [747, 164, 199], // summoning orb
  [182, 194, 130], // logout
]

/** Interfaces attached inside OTHER attached interfaces (not the root):
 *  137 is the chat message area, sent to 752:9 unconditionally. */
const NESTED: [iface: number, parentIface: number, slot: number][] = [
  [137, 752, 9],
]

/** The default-selected tab's content (inventory 679); the other tab panels
 *  are hidden by varc 168 + CS2 in the client, so attaching just the selected
 *  one matches what's on screen. */
const TAB_CONTENT: [iface: number, fixedSlot: number, resizableSlot: number] = [679, 180, 116]

/** IFSetHide the server sends during frame setup (money pouch). */
const FORCE_HIDDEN: Record<GameframeMode, [iface: number, comp: number][]> = {
  fixed: [[FIXED_ROOT, 167]],
  resizable: [[RESIZABLE_ROOT, 208]],
}

/**
 * Where the edited interface is plugged in. NOTHING in the interface data
 * says where one belongs — it's decided by which server call sends it
 * (cryogen: sendTab → the tab content slot, sendChatBoxInterface → 752:13,
 * sendInterface → the central slot, setOverlay → the overlay slot; all are
 * the same IF_OPENSUB packet with a different parent component + clip flag).
 * So the preview makes it a user choice, rendered as pill buttons.
 *
 * "In tab" uses the tab CONTENT area (the slot the default inventory
 * attachment occupies — same hash, so choosing it replaces the inventory
 * panel exactly like the client showing one tab at a time).
 */
export const EDIT_SLOTS: {
  key: string
  label: string
  fixed: [iface: number, comp: number] | null
  resizable: [iface: number, comp: number] | null
}[] = [
  { key: 'screen', label: 'In screen', fixed: [FIXED_ROOT, 44], resizable: [RESIZABLE_ROOT, 29] },
  { key: 'tab', label: 'In tab', fixed: [FIXED_ROOT, 180], resizable: [RESIZABLE_ROOT, 116] },
  { key: 'chat', label: 'In chatbox', fixed: [752, 13], resizable: [752, 13] },
  { key: 'overlay', label: 'In overlay', fixed: [FIXED_ROOT, 3], resizable: [RESIZABLE_ROOT, 12] },
  { key: 'none', label: 'None', fixed: null, resizable: null },
]

export type GameframeScene = {
  rootId: number
  /** component arrays per interface id (the edited draft substituted in) */
  interfaces: Map<number, (IComponentDefinition | null)[]>
  /** parent component hash → attached interface id */
  attachments: Map<number, number>
  /** component hashes force-hidden by the server's IFSetHide */
  hidden: Set<number>
  /** component hashes force-SHOWN: the tab content containers ship hidden
   *  and the client unhides the selected one (varc 168 + CS2) — the preview
   *  unhides whichever slot holds an attachment we mean to display */
  shown: Set<number>
}

/**
 * Assemble the scene: the root pane for the mode, the HUD attachments, the
 * default tab content, and (optionally) the edited interface in its slot.
 * `edited` substitutes for the on-disk copy EVERYWHERE its id appears — so
 * editing 548/746/752 themselves previews live too.
 */
export async function loadGameframeScene(
  rootHandle: FileSystemDirectoryHandle,
  mode: GameframeMode,
  edited: InterfaceData | null,
  slotKey: string,
): Promise<GameframeScene> {
  const rootId = mode === 'fixed' ? FIXED_ROOT : RESIZABLE_ROOT
  const attachments = new Map<number, number>()
  for (const [iface, fixedSlot, resizableSlot] of HUD) {
    attachments.set(hash(rootId, mode === 'fixed' ? fixedSlot : resizableSlot), iface)
  }
  for (const [iface, parentIface, slot] of NESTED) attachments.set(hash(parentIface, slot), iface)
  attachments.set(hash(rootId, mode === 'fixed' ? TAB_CONTENT[1] : TAB_CONTENT[2]), TAB_CONTENT[0])

  const slot = EDIT_SLOTS.find((s) => s.key === slotKey)
  const target = slot ? (mode === 'fixed' ? slot.fixed : slot.resizable) : null
  if (edited && target && edited.id !== rootId) {
    attachments.set(hash(target[0], target[1]), edited.id)
  }

  const needed = new Set<number>([rootId, ...attachments.values()])
  const interfaces = new Map<number, (IComponentDefinition | null)[]>()
  await Promise.all([...needed].map(async (id) => {
    if (edited && id === edited.id) {
      interfaces.set(id, edited.components)
      return
    }
    try {
      const data = await loadInterfaceById(rootHandle, id)
      if (data) interfaces.set(id, data.components)
    } catch { /* missing from the dump — slot stays empty */ }
  }))

  const hidden = new Set<number>(FORCE_HIDDEN[mode].map(([i, c]) => hash(i, c)))
  // the tab content slot ships hidden until the client selects a tab — unhide
  // the one holding whatever we attached there (inventory or the edited iface)
  const shown = new Set<number>([hash(rootId, mode === 'fixed' ? TAB_CONTENT[1] : TAB_CONTENT[2])])
  if (target) shown.add(hash(target[0], target[1]))
  return { rootId, interfaces, attachments, hidden, shown }
}

/**
 * Run every onLoad CS2 hook the composed gameframe carries, the way the
 * client does on IF_OPENTOP / IF_OPENSUB (Connection.runIComponentScripts):
 * top pane first, then each attached interface. Hooks run against CLONED
 * components in a Cs2InterfaceScene — the pristine defs never mutate — and
 * the result is a substitute components map for paintGameframe plus the
 * op-coverage warnings (every stubbed/unknown op, counted).
 *
 * Each interface's layout basis is its slot rect (the client's openSub
 * relayout), so scripts that read if_getwidth/height see mode-correct sizes.
 */
export async function runGameframeCs2(
  rootHandle: FileSystemDirectoryHandle,
  scene: GameframeScene,
  mode: GameframeMode,
  viewportW: number,
  viewportH: number,
  cache: Cs2Cache = new Cs2Cache(),
): Promise<{ interfaces: Map<number, (IComponentDefinition | null)[]>; attachments: Map<number, number>; warnings: Cs2Warning[] }> {
  const cs2 = new Cs2InterfaceScene()
  for (const [id, comps] of scene.interfaces) cs2.addInterface(id, comps)

  // slot basis per interface: root = the viewport; attachments = their slot
  // component's rect, resolved breadth-first from the root
  const basis = new Map<number, { w: number; h: number }>()
  basis.set(scene.rootId, { w: viewportW, h: viewportH })
  const queue = [scene.rootId]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const ifaceId = queue.shift()!
    const iface = scene.interfaces.get(ifaceId)
    const b = basis.get(ifaceId)
    if (!iface || !b) continue
    const layout = resolveAbsoluteLayout(iface, b.w, b.h)
    for (const [parentHash, childId] of scene.attachments) {
      if ((parentHash >>> 16) !== ifaceId || seen.has(childId)) continue
      const comp = iface[parentHash & 0xffff]
      const rect = layout.get(parentHash & 0xffff)
      if (!comp || !rect) continue
      basis.set(childId, {
        w: comp.scrollWidth !== 0 ? comp.scrollWidth : rect.width,
        h: comp.scrollHeight !== 0 ? comp.scrollHeight : rect.height,
      })
      seen.add(childId)
      queue.push(childId)
    }
  }

  const env = makeCs2Env({
    scene: cs2, mode, rootHandle, basis, cache,
    loadInterface: async (id) => (await loadInterfaceById(rootHandle, id))?.components ?? null,
  })
  const interp = new Cs2Interpreter(env, cache.scripts)

  // run order: root, then attachments in BFS order (matches open order)
  const order = [scene.rootId, ...[...basis.keys()].filter((id) => id !== scene.rootId)]
  for (const ifaceId of order) {
    const iface = cs2.interfaces.get(ifaceId)
    if (!iface) continue
    for (const comp of iface.components) {
      const hook = comp?.onLoadScript
      if (!hook || hook.length === 0) continue
      try {
        await interp.run(hook[0] as number, hook.slice(1))
      } catch (e) {
        cs2.warn('run-failure', `script ${hook[0]} on ${ifaceId}:${comp!.componentId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  const interfaces = new Map<number, (IComponentDefinition | null)[]>()
  for (const [id, iface] of cs2.interfaces) interfaces.set(id, iface.components)
  // client-side subs the hooks opened join the composition
  const attachments = new Map(scene.attachments)
  for (const [parentHash, ifaceId] of cs2.subs) attachments.set(parentHash, ifaceId)
  return { interfaces, attachments, warnings: [...cs2.warnings.values()] }
}

/**
 * Paint the composed gameframe. Each attached interface lays out and clips
 * inside its parent component's rect (the client's IF_OPENSUB semantics: the
 * container's scroll size — or its own size — becomes the child's viewport,
 * Class480.method8044). Parent interfaces paint fully before their
 * attachments; the gameframe's slots are dedicated empty containers, so the
 * z-order simplification doesn't show.
 *
 * `override` substitutes component arrays (the CS2-mutated clones from
 * runGameframeCs2) without touching the scene.
 */
export async function paintGameframe(
  ctx: CanvasRenderingContext2D,
  assets: InterfaceAssets,
  scene: GameframeScene,
  viewportW: number,
  viewportH: number,
  opts: PreviewOptions,
  override?: { interfaces: Map<number, (IComponentDefinition | null)[]>; attachments?: Map<number, number> },
): Promise<Map<number, { x: number; y: number; w: number; h: number }>> {
  const painted = new Set<number>() // attachment hashes painted (guards cycles)
  /** where each interface landed (origin + basis) — the caller uses this to
   *  draw the selection outline over the edited interface's component */
  const placements = new Map<number, { x: number; y: number; w: number; h: number }>()

  async function paintTree(interfaceId: number, originX: number, originY: number, w: number, h: number, depth: number): Promise<void> {
    if (depth > 8) return
    const source = override?.interfaces.get(interfaceId) ?? scene.interfaces.get(interfaceId)
    if (!source) return
    // apply the server's IFSetHide and the selected-tab unhide by
    // substituting patched copies
    const comps = source.map((c) => {
      if (!c) return c
      const h = hash(interfaceId, c.componentId)
      if (scene.hidden.has(h)) return { ...c, hidden: true }
      if (scene.shown.has(h)) return { ...c, hidden: false }
      return c
    })
    if (!placements.has(interfaceId)) placements.set(interfaceId, { x: originX, y: originY, w, h })
    const layout = resolveAbsoluteLayout(comps, w, h)
    const resolved = await loadPreviewAssets(assets, comps, layout, w, h, opts)
    ctx.save()
    ctx.translate(originX, originY)
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.clip()
    paintInterface(ctx, comps, layout, resolved, w, h, opts)
    ctx.restore()
    for (const [parentHash, childId] of override?.attachments ?? scene.attachments) {
      if ((parentHash >>> 16) !== interfaceId || painted.has(parentHash)) continue
      const compId = parentHash & 0xffff
      const comp = comps[compId]
      const rect = layout.get(compId)
      if (!comp || !rect || (comp.hidden && !opts.showHidden)) continue
      painted.add(parentHash)
      // the child's viewport basis is the container's scroll size when set
      const basisW = comp.scrollWidth !== 0 ? comp.scrollWidth : rect.width
      const basisH = comp.scrollHeight !== 0 ? comp.scrollHeight : rect.height
      await paintTree(childId, originX + rect.x, originY + rect.y, basisW, basisH, depth + 1)
    }
  }

  await paintTree(scene.rootId, 0, 0, viewportW, viewportH, 0)
  return placements
}
