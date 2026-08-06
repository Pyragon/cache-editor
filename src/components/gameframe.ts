import type { CS2Script, IComponentDefinition, InterfaceData } from '../loaders/interfaces'
import { loadInterfaceById } from '../loaders/interfaces'
import {
  InterfaceAssets, resolveAbsoluteLayout, loadPreviewAssets, paintInterface,
} from './interfacePreview'
import type { LayoutRect, PreviewOptions } from './interfacePreview'
import { Cs2Interpreter } from '../cs2/interpreter'
import { Cs2VarStore, makeCs2Env } from '../cs2/ops'
import { Cs2InterfaceScene } from '../cs2/runtime'
import type { Cs2SceneSnapshot, Cs2TraceEntry, Cs2Warning } from '../cs2/runtime'
import { Cs2Cache } from '../cs2/cache'
import { SKILL_NAMES, loadVarOverrides, namedVar, skillLevel } from '../loaders/varOverrides'
import { loadVarbitDef } from '../loaders/varbitDefs'

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

/** Is this interface one of the two window panes (IF_OPENTOP targets)? */
export function isGameframeRoot(id: number): boolean {
  return id === FIXED_ROOT || id === RESIZABLE_ROOT
}

/** The mode a gameframe root can only be viewed in — editing 548 means the
 *  fixed frame, editing 746 means the resizable one. null = not a root. */
export function modeForRoot(id: number): GameframeMode | null {
  if (id === FIXED_ROOT) return 'fixed'
  if (id === RESIZABLE_ROOT) return 'resizable'
  return null
}

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
  /** Cache for the NON-edited interfaces of the frame. In-editor edits can't
   *  change them, and re-reading ~15 of them from disk per keystroke opened a
   *  stale window where hovers ran against the old frame — which read exactly
   *  like "hook params don't update". Fresh per preview mount. */
  depCache?: Map<number, (IComponentDefinition | null)[]>,
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
  // A gameframe root is the window pane itself — it can never be a sub of
  // anything, so it's previewed AS the root (the substitution below) and
  // never plugged into a slot. Excluding only the CURRENT mode's root left
  // the other one attachable, which composed 746 inside 548: two gameframes
  // drawn at once, and the placement map (first-write-wins per interface)
  // then pointed selection at the wrong copy.
  const attachedTarget = edited && target && !isGameframeRoot(edited.id) ? target : null
  if (edited && attachedTarget) {
    attachments.set(hash(attachedTarget[0], attachedTarget[1]), edited.id)
  }

  const needed = new Set<number>([rootId, ...attachments.values()])
  const interfaces = new Map<number, (IComponentDefinition | null)[]>()
  await Promise.all([...needed].map(async (id) => {
    if (edited && id === edited.id) {
      interfaces.set(id, edited.components)
      return
    }
    const cached = depCache?.get(id)
    if (cached) { interfaces.set(id, cached); return }
    try {
      const data = await loadInterfaceById(rootHandle, id)
      if (data) {
        interfaces.set(id, data.components)
        depCache?.set(id, data.components)
      }
    } catch { /* missing from the dump — slot stays empty */ }
  }))

  const hidden = new Set<number>(FORCE_HIDDEN[mode].map(([i, c]) => hash(i, c)))
  // the tab content slot ships hidden until the client selects a tab — unhide
  // the one holding whatever we attached there (inventory or the edited iface)
  const shown = new Set<number>([hash(rootId, mode === 'fixed' ? TAB_CONTENT[1] : TAB_CONTENT[2])])
  if (attachedTarget) shown.add(hash(attachedTarget[0], attachedTarget[1]))
  return { rootId, interfaces, attachments, hidden, shown }
}

/**
 * The hook fields we fire, in the order a freshly logged-in client fires them.
 *
 * `onLoad` alone is not enough to draw a live-looking HUD: the orb FILLS come
 * from the other three. The hitpoints orb's fill (script_808) hangs off
 * `onTimer`, the prayer and summoning fills (script_801) off `onStatTransmit`,
 * and the poison/disease variants off `onVarpTransmit`. A preview that runs
 * only onLoad renders orbs that never move no matter what the Variables modal
 * says — which is exactly what it did.
 *
 * The client fires a transmit hook each time one of the component's listed
 * vars/stats arrives from the server, and a timer hook every cycle. A preview
 * has one static world state, so one pass each is the faithful equivalent of
 * "the server has just sent the whole player block, and one tick has passed".
 */
const HOOK_PASSES: {
  field: 'onLoadScript' | 'onVarpTransmit' | 'onStatTransmit' | 'onTimer'
  label: string
  /** why the client would fire it, phrased for the console. `vars` is the
   *  LIVE store, read just before the hook runs, so a transmit line reports
   *  the value the script is about to see — including one an earlier hook
   *  wrote, which is the whole reason it isn't read from the saved overrides */
  trigger: (comp: IComponentDefinition, vars: Cs2VarStore) => string
}[] = [
  { field: 'onLoadScript', label: 'onLoad', trigger: () => 'interface opened' },
  {
    field: 'onVarpTransmit',
    label: 'onVarpTransmit',
    // The component's SUBSCRIPTION list and what each of those vars currently
    // holds. Deliberately not phrased as "transmitted": the preview fires
    // every transmit hook once regardless of what changed, so claiming these
    // vars just arrived would be a lie — and a confusing one, since the var
    // you edited is usually not in this list at all. "watches" is what the
    // list actually is. Named where anything names them, so writing a name
    // into the Variables modal pays off here.
    trigger: (c, vars) => (c.varps?.length
      ? `watches ${c.varps.map((v) => {
        const name = namedVar('varp', v)
        return `${name ? `${name.name} (varp ${v})` : `varp ${v}`} = ${vars.varp(v)}`
      }).join(', ')}`
      : 'no varp filter list — in game this would never fire'),
  },
  {
    field: 'onStatTransmit',
    label: 'onStatTransmit',
    // stats aren't in the var store — `stat()` / `stat_base()` read
    // skillLevel() straight from the overrides, so this reads the same source
    trigger: (c) => (c.statTransmitFilter?.length
      ? `watches ${c.statTransmitFilter.map((s) => `${SKILL_NAMES[s] ?? `skill ${s}`} = ${skillLevel(s)}`).join(', ')}`
      : 'no stat filter list — in game this would never fire'),
  },
  { field: 'onTimer', label: 'onTimer', trigger: () => 'one client tick' },
]

/**
 * Hook argument sentinels (darkan-game-client CS2Executor.executeHookInner):
 * the cache stores placeholders the client swaps for live event state before
 * the script starts. Passing them through raw hands a script a nonsense
 * component hash, and every if_* setter aimed at it silently does nothing —
 * script_801's whole body is `if_*` calls on arg 0, so the prayer orb fill ran
 * and changed nothing. Only `self` has a real answer in a static preview; the
 * rest are event state we have none of, and resolve to the client's own
 * "absent" value.
 */
const HOOK_ARG_SENTINELS: Record<number, (self: number, mouseX: number, mouseY: number) => number> = {
  [-2147483647]: (_s, mouseX) => mouseX,
  [-2147483646]: (_s, _x, mouseY) => mouseY,
  [-2147483645]: (self) => self, // the component the hook is attached to
  [-2147483644]: () => -1, // op index
  [-2147483643]: () => -1, // source slot
  [-2147483642]: () => -1, // the other component (drag target)
  [-2147483641]: () => -1, // the other component's slot
  [-2147483640]: () => -1, // typed key code
  [-2147483639]: () => -1, // typed key char
}

function resolveHookArgs(
  args: (number | string)[],
  sourceHash: number,
  mouse: { x: number; y: number } = { x: 0, y: 0 },
): (number | string)[] {
  return args.map((a) => {
    if (typeof a === 'number') return HOOK_ARG_SENTINELS[a]?.(sourceHash, mouse.x, mouse.y) ?? a
    // "event_opbase" is the string sentinel; there is no hovered op here
    return a === 'event_opbase' ? '' : a
  })
}

/**
 * The pointer's relationship to the frame, as the client's three guards:
 * components it just entered, every component it is currently inside, and
 * components it just left. Sets, not single components — see `hoverTargets`.
 * Coordinates are COMPONENT-LOCAL, matching the client's `getMouseX() - x`.
 */
export type GameframePointer = {
  /** newly inside — edge-triggered, fires the enter hook once */
  entered: HoverTarget[]
  /** currently inside — fires the every-cycle hook on each run */
  over: HoverTarget[]
  /** newly outside — edge-triggered, fires the exit hook once */
  exited: HoverTarget[]
  /** just clicked — one press/release cycle, for one run only */
  clicked: HoverTarget[]
}

/**
 * The hover hooks, exactly as `client.java` dispatches them (traced
 * 2026-08-03, around the per-component `aBool1440` "is hovered" flag):
 *
 *   !hovered && over  → set hovered, fire decode slot 2  (once, on entering)
 *    hovered && over  → fire decode slot 12  EVERY cycle while inside
 *    hovered && !over → clear hovered, fire decode slot 3 (once, on leaving)
 *
 * All three carry the mouse position relative to the component.
 *
 * **The dumped field names for slots 2 and 12 are crossed.** The installer
 * opcodes — which cryogen's `CS2Opcode` table and the client's
 * `CS2Instruction` agree on — say what each slot really is:
 *
 *   HOOK_MOUSE_ENTER (968)   → slot 2,  dumped `onMouseOver`   → ENTER, once
 *   IF_SETONMOUSEOVER (753)  → slot 12, dumped `popupScript`   → OVER, per cycle
 *   HOOK_MOUSE_EXIT (600)    → slot 3,  dumped `onMouseLeaveScript` → EXIT, once
 *
 * So `popupScript` is not a popup: it is the real continuous "while the mouse
 * is over" hook, which is why interface 9's components pair it with the exit
 * hook to hold a highlight. Labels below follow the OPCODES, because those are
 * verifiable; the dumped field name is kept alongside so a console line still
 * maps to the editor.
 *
 * **`mouseLeaveScript` (slot 7) is NOT in this list and must never be** —
 * despite `IF_SETONMOUSELEAVE (809)` writing it and every source sharing the
 * name. Its dispatch is transmit-shaped: a global counter against a
 * per-component cursor, scanning a 32-entry ring buffer of recently-changed
 * ids against `mouseLeaveArrayParams`. Same shape as the varp and stat
 * transmit hooks it decodes between, and its filter list sits between `varps`
 * and `statTransmitFilter`. It's an inventory transmit hook. See EDITOR.md.
 */
const HOVER_PASSES: {
  field: 'onMouseOver' | 'popupScript' | 'onMouseLeaveScript' | 'onClick' | 'onRelease'
  label: string
  /** which of the pointer's sets this pass walks */
  on: keyof GameframePointer
  trigger: string
}[] = [
  {
    field: 'onMouseLeaveScript',
    label: 'mouseExit',
    on: 'exited',
    trigger: 'pointer left the component — once (HOOK_MOUSE_EXIT, dumped as onMouseLeaveScript)',
  },
  {
    field: 'onMouseOver',
    label: 'mouseEnter',
    on: 'entered',
    trigger: 'pointer entered the component — once (HOOK_MOUSE_ENTER, dumped as onMouseOver)',
  },
  {
    field: 'popupScript',
    label: 'mouseOver',
    on: 'over',
    trigger: 'pointer is inside — every client cycle (IF_SETONMOUSEOVER, dumped as popupScript — not a popup)',
  },
  // A click is a press and a release, and the client fires a different hook
  // for each — mapping decode slots to the dispatch: slot 13 fires on the
  // press edge (`!pressed && down`), slot 15 on the release
  // (`pressed && !down`). Slots 14 and 16 (onClickRepeat / onHold) fire while
  // the button is HELD, which a single click never reaches, so they stay
  // unfired. Last in the list because the pointer is over a component before
  // it clicks it.
  {
    field: 'onClick',
    label: 'onClick',
    on: 'clicked',
    trigger: 'button pressed on the component',
  },
  {
    field: 'onRelease',
    label: 'onRelease',
    on: 'clicked',
    trigger: 'button released — the other half of the same click',
  },
]

/** Does this component react to the pointer at all? Hover tracking uses this
 *  to decide whether a transition is worth a full CS2 re-run — most components
 *  carry no hover hook, and re-running ~60 hooks to produce an identical frame
 *  every time the pointer crosses a border would make the preview crawl. */
export function hasHoverHook(comp: IComponentDefinition | null | undefined): boolean {
  if (!comp) return false
  return HOVER_PASSES.some((p) => (comp[p.field]?.length ?? 0) > 0)
}

/**
 * Does this component carry the EVERY-CYCLE hover hook? Such a hook expects to
 * be called ~50×/second and scripts lean on that: interface 11:18's tooltip
 * runs `script_4761`, which creeps a varc forward a little per call and only
 * shows the tooltip once it passes `client_clock() + delay`. Fire it once per
 * pointer movement and the tooltip needs two dozen deliberate mouse jiggles to
 * appear. `GameframePreview` uses this to decide when to run a cycle ticker.
 */
export function hasPerCycleHook(comp: IComponentDefinition | null | undefined): boolean {
  if (!comp) return false
  return HOVER_PASSES.some((p) => p.on === 'over' && (comp[p.field]?.length ?? 0) > 0)
}

/** The client's cycle length. Scripts that time themselves off
 *  `client_clock()` are calibrated against this. */
export const CLIENT_CYCLE_MS = 20

/** Hook fields the preview does not fire at all — they need an event we don't
 *  model. Counted so the console can say so rather than implying an interface
 *  is inert. */
const UNRUN_HOOKS = [
  'onClickRepeat', 'onHold', 'onDrag', 'onDragComplete',
  'onMouseMove', 'onKey', 'onScrollWheel', 'onTargetEnter', 'onTargetLeave',
] as const

export type HookCensus = {
  /** onLoad / varp / stat / timer — fire on their own when the frame runs */
  frame: number
  /** enter / over / exit — need the pointer */
  hover: number
  /** click / release — need a click, in the toolbar's "fire onClick" mode */
  click: number
  /** the ones we never fire, BY FIELD. Named individually on purpose: this
   *  used to be a bare count summarised as "drag/key hooks", which sent
   *  someone hunting through interface 11 for a drag script that was never
   *  there — the two hooks were `onMouseMove`. A count of a nine-field bucket
   *  can't be checked against the data. */
  unrun: { field: string; count: number }[]
}

/**
 * What hooks an interface actually carries, split by whether the preview can
 * ever fire them.
 *
 * The console needs this to explain an empty log honestly. Interface 11's
 * components carry only HOVER hooks, so before the pointer touches one the
 * log is legitimately empty — and reporting that as "carries no hooks" is
 * simply false.
 */
export function censusHooks(components: (IComponentDefinition | null)[]): HookCensus {
  const census: HookCensus = { frame: 0, hover: 0, click: 0, unrun: [] }
  const unrun = new Map<string, number>()
  for (const comp of components) {
    if (!comp) continue
    for (const p of HOOK_PASSES) if (comp[p.field]?.length) census.frame++
    for (const p of HOVER_PASSES) {
      if (comp[p.field]?.length) census[p.on === 'clicked' ? 'click' : 'hover']++
    }
    for (const f of UNRUN_HOOKS) {
      if ((comp[f] as unknown[] | null)?.length) unrun.set(f, (unrun.get(f) ?? 0) + 1)
    }
  }
  census.unrun = [...unrun].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count)
  return census
}

/**
 * Run the CS2 hooks the composed gameframe carries, the way the client does on
 * IF_OPENTOP / IF_OPENSUB (Connection.runIComponentScripts) and on the var/stat
 * blocks that follow: top pane first, then each attached interface, one pass
 * per hook field (see HOOK_PASSES). Hooks run against CLONED components in a
 * Cs2InterfaceScene — the pristine defs never mutate — and the result is a
 * substitute components map for paintGameframe, the op-coverage warnings
 * (every stubbed/unknown op, counted) and the run trace the console shows.
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
): Promise<GameframeRun> {
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

  // held here, not inside the env, so the trigger lines below can read the
  // value a transmit hook is about to see
  const vars = new Cs2VarStore()
  const cs2Env = makeCs2Env({
    scene: cs2, mode, rootHandle, basis, cache, vars,
    loadInterface: async (id) => (await loadInterfaceById(rootHandle, id))?.components ?? null,
  })
  const interp = new Cs2Interpreter(cs2Env, cache.scripts)

  // run order: root, then attachments in BFS order (matches open order). Each
  // hook FIELD gets a full pass over every interface before the next starts —
  // the client opens the whole frame, then the var block arrives, then ticks.
  const order = [scene.rootId, ...[...basis.keys()].filter((id) => id !== scene.rootId)]

  const fire = hookFirer(cs2, interp)

  for (const pass of HOOK_PASSES) {
    for (const ifaceId of order) {
      const iface = cs2.interfaces.get(ifaceId)
      if (!iface) continue
      for (const comp of iface.components) {
        const hook = comp?.[pass.field]
        if (!comp || !runnableHook(hook)) continue
        await fire(comp, ifaceId, hook, pass.label, pass.trigger(comp, vars))
      }
    }
  }

  const interfaces = new Map<number, (IComponentDefinition | null)[]>()
  for (const [id, iface] of cs2.interfaces) interfaces.set(id, iface.components)
  // client-side subs the hooks opened join the composition
  const attachments = new Map(scene.attachments)
  for (const [parentHash, ifaceId] of cs2.subs) attachments.set(parentHash, ifaceId)
  return {
    interfaces,
    snapshot: cs2.snapshot(),
    attachments,
    warnings: [...cs2.warnings.values()],
    trace: cs2.trace,
    routes: await varRouting(cs2, rootHandle),
    ctx: { rootHandle, mode, basis, cache, vars },
  }
}

/**
 * Is there actually a script to run? A hook the editor has just attached but
 * not yet pointed at a script holds id −1 — the field has to exist to be
 * editable, but running it would report a missing script on every pass.
 */
function runnableHook(hook: CS2Script | null | undefined): hook is CS2Script {
  return !!hook && hook.length > 0 && typeof hook[0] === 'number' && hook[0] >= 0
}

/** Run one hook against a scene, traced. */
function hookFirer(cs2: Cs2InterfaceScene, interp: Cs2Interpreter) {
  return async (
    comp: IComponentDefinition,
    ifaceId: number,
    hook: (number | string)[],
    label: string,
    trigger: string,
    mouse?: { x: number; y: number },
  ) => {
    const scriptId = hook[0] as number
    const sourceHash = (ifaceId << 16) | comp.componentId
    const entry = cs2.beginHook(label, trigger, scriptId, `${ifaceId}:${comp.componentId}`)
    try {
      await interp.run(scriptId, resolveHookArgs(hook.slice(1), sourceHash, mouse))
      cs2.endHook(entry.changes.length === 0 ? 'ran, changed nothing' : undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      cs2.warn('run-failure', `script ${scriptId} on ${ifaceId}:${comp.componentId}: ${message}`)
      cs2.endHook(`failed: ${message}`)
    }
  }
}

/**
 * The frame's CS2 state, and everything the cheap hover phase needs to build
 * on top of it. Produced once per real change (scene, mode, viewport, vars)
 * and REUSED across pointer movement — see `applyGameframeHover`.
 */
export type GameframeRun = {
  interfaces: Map<number, (IComponentDefinition | null)[]>
  /** the frame scene's runtime state, including dynamic-child bookkeeping the
   *  frame hooks' own cc_creates established — hover continues from this */
  snapshot: Cs2SceneSnapshot
  attachments: Map<number, number>
  warnings: Cs2Warning[]
  trace: Cs2TraceEntry[]
  /** where each set variable actually goes in this frame (see `varRouting`) */
  routes: Cs2VarRoute[]
  ctx: {
    rootHandle: FileSystemDirectoryHandle
    mode: GameframeMode
    basis: Map<number, { w: number; h: number }>
    cache: Cs2Cache
    vars: Cs2VarStore
  }
}

/**
 * Layer the pointer's hooks over an already-computed frame.
 *
 * This exists purely for latency. The frame passes are ~60 hooks through an
 * async tree-walking interpreter, and at least one gameframe script runs to
 * the 250k-step budget before aborting — re-running all of that to answer
 * "the pointer moved onto a button" cost 1–2 seconds and produced a frame
 * identical except for one sprite. Hover needs at most three hooks.
 *
 * Hover state ACCUMULATES: each run starts from `previous` — the components
 * the last hover run produced — and only falls back to the frame base when
 * there is no previous (a fresh frame). That mirrors the client, which mutates
 * one live scene and relies on the leave script to put things back.
 *
 * Starting from the base each time was tempting and wrong. The appearance came
 * out right, because a base clone simply has no hover applied — but the log
 * lied. A leave script setting `color` back to 12875312 on a base that already
 * held 12875312 is a no-op diff, so the console showed the leave hook running
 * and changing nothing, when on screen it had just undone a highlight.
 */
export async function applyGameframeHover(
  base: GameframeRun,
  pointer: GameframePointer | undefined,
  previous?: Cs2SceneSnapshot | null,
  cycle = 0,
): Promise<{
  interfaces: Map<number, (IComponentDefinition | null)[]>
  /** carry into the next call so cc_create/cc_deleteall stay coherent */
  snapshot: Cs2SceneSnapshot
  attachments: Map<number, number>
  warnings: Cs2Warning[]
  trace: Cs2TraceEntry[]
}> {
  const source = previous ?? base.snapshot
  const work = HOVER_PASSES.flatMap((pass) =>
    (pointer?.[pass.on] ?? []).map((target) => ({ pass, target })))

  // pointer outside everything, and nothing just left — whatever we last
  // produced still stands
  if (work.length === 0) {
    const interfaces = new Map<number, (IComponentDefinition | null)[]>()
    for (const [id, iface] of source) interfaces.set(id, iface.components)
    return {
      interfaces,
      snapshot: source,
      attachments: base.attachments,
      warnings: base.warnings,
      trace: [],
    }
  }

  const cs2 = new Cs2InterfaceScene()
  cs2.continueFrom(source)
  const env = makeCs2Env({
    scene: cs2,
    mode: base.ctx.mode,
    rootHandle: base.ctx.rootHandle,
    basis: base.ctx.basis,
    cache: base.ctx.cache,
    vars: base.ctx.vars,
    cycle,
    loadInterface: async (id) => (await loadInterfaceById(base.ctx.rootHandle, id))?.components ?? null,
  })
  const fire = hookFirer(cs2, new Cs2Interpreter(env, base.ctx.cache.scripts))

  for (const { pass, target } of work) {
    const ifaceId = target.hash >>> 16
    const comp = cs2.interfaces.get(ifaceId)?.components[target.hash & 0xffff]
    const hook = comp?.[pass.field]
    if (!comp || !runnableHook(hook)) continue
    await fire(comp, ifaceId, hook, pass.label, pass.trigger, { x: target.x, y: target.y })
  }

  const interfaces = new Map<number, (IComponentDefinition | null)[]>()
  for (const [id, iface] of cs2.interfaces) interfaces.set(id, iface.components)
  const attachments = new Map(base.attachments)
  for (const [parentHash, ifaceId] of cs2.subs) attachments.set(parentHash, ifaceId)
  // warnings from the base plus anything the hover scripts newly hit
  const warnings = [...base.warnings]
  for (const w of cs2.warnings.values()) if (!warnings.some((b) => b.op === w.op)) warnings.push(w)
  // the trace is JUST the hover hooks: a pointer move didn't re-run the frame,
  // and listing 60 cached entries again would bury the two that are news
  return { interfaces, snapshot: cs2.snapshot(), attachments, warnings, trace: cs2.trace }
}

/** A variable set in the Variables modal that a hook in this frame actually
 *  fires on. */
export type Cs2VarRoute = {
  /** "Prayer points (varbit 9816) = 990" */
  subject: string
  /** how it gets there, when that isn't direct — a varbit's containing varp */
  route?: string
  /** components whose transmit hook fires on it, "749:6" */
  watchers: string[]
}

/**
 * "I changed a variable — what did it reach?"
 *
 * Only reports variables something here DOES watch. A var nobody subscribes
 * to isn't a fault to warn about: the Variables list is global and mostly
 * describes world state for the map and cutscene previews, so on any given
 * interface most of it is simply irrelevant. Repeating "nothing watches this"
 * once per variable per run buried the log in warnings about a situation
 * that is normal and that no script here is even asking about.
 *
 * What's left is worth a line because it is genuinely invisible otherwise:
 * **varbits are bit ranges INSIDE a varp** (`baseVar`), and transmit filter
 * lists only ever name the varp. Setting varbit 455 fires the hooks watching
 * varp 449, and nothing else on screen connects those two numbers — so
 * without this the log reads as though it's discussing a var you never
 * touched.
 */
async function varRouting(cs2: Cs2InterfaceScene, rootHandle: FileSystemDirectoryHandle): Promise<Cs2VarRoute[]> {
  const varpWatchers = new Map<number, string[]>()
  const statWatchers = new Map<number, string[]>()
  const add = (map: Map<number, string[]>, id: number, who: string) => {
    const list = map.get(id)
    if (list) { if (!list.includes(who)) list.push(who) } else map.set(id, [who])
  }
  for (const iface of cs2.interfaces.values()) {
    for (const comp of iface.components) {
      if (!comp) continue
      const who = `${iface.id}:${comp.componentId}`
      // a filter list with no hook on it subscribes to nothing
      if (comp.onVarpTransmit?.length) for (const v of comp.varps ?? []) add(varpWatchers, v, who)
      if (comp.onStatTransmit?.length) for (const s of comp.statTransmitFilter ?? []) add(statWatchers, s, who)
    }
  }

  const routes: Cs2VarRoute[] = []
  for (const o of loadVarOverrides()) {
    // varbits reach scripts through their containing varp, so resolve first
    // and subscribe-check against THAT
    const def = o.kind === 'varbit' ? await loadVarbitDef(rootHandle, o.id) : null
    const watchers = o.kind === 'stat'
      ? statWatchers.get(o.id)
      : varpWatchers.get(o.kind === 'varp' ? o.id : def?.baseVar ?? -1)
    if (!watchers?.length) continue

    const label = namedVar(o.kind, o.id)?.name
    const kindWord = o.kind === 'stat' ? 'skill' : o.kind
    routes.push({
      subject: `${label ? `${label} (${kindWord} ${o.id})` : `${kindWord} ${o.id}`} = ${o.value}`,
      route: def ? `bits ${def.startBit}–${def.endBit} of varp ${def.baseVar}` : undefined,
      watchers,
    })
  }
  return routes
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
): Promise<{
  placements: Map<number, { x: number; y: number; w: number; h: number }>
  regions: GameframeRegion[]
}> {
  const painted = new Set<number>() // attachment hashes painted (guards cycles)
  /** where each interface landed (origin + basis) — the caller uses this to
   *  draw the selection outline over the edited interface's component */
  const placements = new Map<number, { x: number; y: number; w: number; h: number }>()
  /** every painted interface with the layout it painted at, in paint order —
   *  what pointer hit-testing walks (backwards, so the topmost wins) */
  const regions: GameframeRegion[] = []

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
    regions.push({ interfaceId, x: originX, y: originY, w, h, comps, layout })
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
  return { placements, regions }
}

/** A painted interface and where it landed, for pointer hit-testing. */
export type GameframeRegion = {
  interfaceId: number
  x: number
  y: number
  w: number
  h: number
  comps: (IComponentDefinition | null)[]
  layout: Map<number, LayoutRect>
}

/** A component the pointer is inside, with the position in ITS coordinates. */
export type HoverTarget = { hash: number; x: number; y: number }

/**
 * EVERY component whose bounds contain the pointer, across the whole frame.
 *
 * Not the topmost — all of them. The client has no topmost-wins rule for
 * hover: `client.java` walks every component of every open interface and sets
 * its own `bool_48` from a plain bounds test
 * (`mouseX >= leftBound && … && mouseY < upperBound`), so a pointer over an
 * icon is simultaneously "over" that icon, the container holding it, and that
 * container's parent — and all of their hover hooks fire. Returning one
 * component meant a hook on a parent never ran unless you found a bare patch
 * of it not covered by a child.
 *
 * (`hitTestComponent`, which picks the deepest/smallest, is still the right
 * answer for click-to-select — there you want the one specific thing.)
 *
 * Ordered outermost-first within each interface, matching the client's
 * component iteration.
 */
export function hoverTargets(
  regions: GameframeRegion[],
  px: number,
  py: number,
  showHidden: boolean,
): HoverTarget[] {
  const out: HoverTarget[] = []
  for (const r of regions) {
    const localX = px - r.x
    const localY = py - r.y
    if (localX < 0 || localY < 0 || localX > r.w || localY > r.h) continue
    for (const c of r.comps) {
      if (!c || (c.hidden && !showHidden)) continue
      const rect = r.layout.get(c.componentId)
      if (!rect) continue
      if (localX < rect.x || localX > rect.x + rect.width) continue
      if (localY < rect.y || localY > rect.y + rect.height) continue
      out.push({
        hash: hash(r.interfaceId, c.componentId),
        // the client passes mouse position RELATIVE TO THE COMPONENT
        // (`getMouseX() - x`), so hook args see component-local coordinates
        x: Math.round(localX - rect.x),
        y: Math.round(localY - rect.y),
      })
    }
  }
  return out
}
