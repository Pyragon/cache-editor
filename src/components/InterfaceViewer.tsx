import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InterfaceData, IComponentDefinition, ComponentType, ModelType, CS2Script } from '../loaders/interfaces'
import { COMPONENT_TYPES, MODEL_TYPES, blankComponent } from '../loaders/interfaces'
import ConfirmDialog from './ConfirmDialog'
import type { PendingConfirm } from './ConfirmDialog'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import ModelViewer from './ModelViewer'
import { CellDropdown, IntListInput, NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { SKILL_NAMES } from '../loaders/varOverrides'
import { InterfaceAssets, childrenByParent, hitTestComponent, loadPreviewAssets, paintInterface, resolveAbsoluteLayout } from './interfacePreview'
import { dragToBasePosition, parentBoxOf } from './ifaceDrag'
import type { SnapGuide } from './ifaceDrag'
import GameframePreview from './GameframePreview'
import Cs2ScriptModal from './Cs2ScriptModal'
import './InterfaceViewer.css'

// CS2 script hooks a component may carry — shown as a flat list of the ones
// actually present (most components have none). Decompiling CS2 bytecode
// into readable logic is out of scope; this exposes the raw tagged args.
//
// Labels follow the INSTALLER OPCODE, not the dumped field name, wherever the
// two disagree — the opcode is verifiable (cryogen's CS2Opcode table and the
// client's CS2Instruction agree) and the dumped names for the mouse hooks are
// crossed. `hint` carries the dumped name so a field is still findable by it.
// Full trace in EDITOR.md; the gameframe preview fires these three.
const SCRIPT_FIELDS: [key: keyof IComponentDefinition, label: string, hint?: string][] = [
  ['onLoadScript', 'On Load'],
  ['onMouseOver', 'On Mouse Enter', 'HOOK_MOUSE_ENTER (968) — fires ONCE when the pointer enters. Dumped as `onMouseOver`.'],
  ['onMouseLeaveScript', 'On Mouse Exit', 'HOOK_MOUSE_EXIT (600) — fires ONCE when the pointer leaves. Dumped as `onMouseLeaveScript`.'],
  ['hookParams', 'Hook Params'],
  ['onTargetEnter', 'On Target Enter'],
  ['onVarpTransmit', 'On Varp Transmit'],
  ['mouseLeaveScript', 'Mouse Leave (misnomer)', 'IF_SETONMOUSELEAVE (809) writes this, but the client dispatches it like a TRANSMIT hook — a change-counter scanning a ring buffer against `mouseLeaveArrayParams`. Almost certainly an inventory transmit hook. Not fired as a mouse hook by the preview.'],
  ['onStatTransmit', 'On Stat Transmit'],
  ['onTimer', 'On Timer'],
  ['params', 'Params'],
  ['onTargetLeave', 'On Target Leave'],
  ['popupScript', 'On Mouse Over', 'IF_SETONMOUSEOVER (753) — fires EVERY client cycle while the pointer is inside, not once. Dumped as `popupScript`; it is not a popup.'],
  ['onClick', 'On Click'],
  ['onClickRepeat', 'On Click Repeat'],
  ['onRelease', 'On Release'],
  ['onHold', 'On Hold'],
  ['onDrag', 'On Drag'],
  ['onDragComplete', 'On Drag Complete'],
  ['onMouseMove', 'On Mouse Move'],
  ['onKey', 'On Key'],
  ['onScrollWheel', 'On Scroll Wheel'],
  ['anObjectArray1413', 'Script 1413'],
  ['anObjectArray1292', 'Script 1292'],
  ['anObjectArray1415', 'Script 1415'],
  ['anObjectArray1416', 'Script 1416'],
  ['anObjectArray1383', 'Script 1383'],
  ['anObjectArray1419', 'Script 1419'],
  ['anObjectArray1361', 'Script 1361'],
  ['anObjectArray1421', 'Script 1421'],
  ['anObjectArray1346', 'Script 1346'],
  ['anObjectArray1353', 'Script 1353'],
  ['anObjectArray1271', 'On Resize (1271)'],
]

const LAYOUT_FIELDS: NumFieldDef[] = [
  ['basePositionX', 'Base X'],
  ['basePositionY', 'Base Y'],
  ['baseWidth', 'Base Width'],
  ['baseHeight', 'Base Height'],
]

const SPRITE_FIELDS: NumFieldDef[] = [
  ['angle2d', 'Angle'],
  ['transparency', 'Transparency'],
  ['borderThickness', 'Border Thickness'],
  ['spriteShadow', 'Shadow (ARGB)'],
]

const MODEL_FIELDS: NumFieldDef[] = [
  ['animation', 'Animation'],
  ['originX', 'Origin X'],
  ['originY', 'Origin Y'],
  ['originZ', 'Origin Z'],
  ['spritePitch', 'Pitch'],
  ['spriteRoll', 'Roll'],
  ['spriteYaw', 'Yaw'],
  ['spriteScale', 'Scale'],
]

const TEXT_FIELDS: NumFieldDef[] = [
  ['lineSpacing', 'Line Spacing'],
  ['textHorizontalAli', 'Horizontal Align'],
  ['textVerticalAli', 'Vertical Align'],
  ['maxTextLines', 'Max Lines'],
  ['transparency', 'Transparency'],
]

const CURSOR_FIELDS: NumFieldDef[] = [
  ['targetOverCursor', 'Target Over Cursor'],
  ['targetLeaveCursor', 'Target Leave Cursor'],
  ['moveOverCursor', 'Move Over Cursor'],
  ['dragDeadzone', 'Drag Deadzone'],
  ['dragDeadTime', 'Drag Dead Time'],
  ['dragType', 'Drag Type'],
]

// The client's layout-mode semantics (Class246.method4204 / Class484.initSizes
// — traced 2026-08-02, see interfaces.md). Editing these as named modes
// instead of bare numbers is most of the point of the inspector.
const X_MODES = ['Absolute (from left)', 'Centred + offset', 'Right-anchored', 'Proportional', 'Centred + proportional', 'Right + proportional']
const Y_MODES = ['Absolute (from top)', 'Centred + offset', 'Bottom-anchored', 'Proportional', 'Centred + proportional', 'Bottom + proportional']
const SIZE_MODES = ['Absolute px', 'Parent minus base (fill/inset)', 'Proportional (base/16384)', '(unused)', 'Aspect-ratio from other axis']

function ModeSelect({ label, value, modes, onChange }: { label: string; value: number; modes: string[]; onChange: (v: number) => void }) {
  return (
    <label className="item-field">
      <span className="item-field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {modes.map((m, i) => <option key={i} value={i}>{i} — {m}</option>)}
      </select>
    </label>
  )
}

function rgbInputHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}

function scriptToText(script: CS2Script | null | undefined): string {
  if (!script) return ''
  return script.join(', ')
}

function textToScript(text: string): CS2Script | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  // empty tokens are typing artifacts ("1, "), not script args — drop them
  return trimmed.split(',').map((tok) => tok.trim()).filter((t) => t !== '').map((t) => {
    const n = Number(t)
    return Number.isFinite(n) ? n : t
  })
}

/** Script args as free text while focused — a controlled input that
 *  re-renders the parsed script every keystroke would normalize away the
 *  separator being typed. Commits per keystroke; blur snaps to canonical. */
function ScriptInput({ script, onCommit }: { script: CS2Script | null; onCommit: (s: CS2Script | null) => void }) {
  const [text, setText] = useState<string | null>(null)
  const canonical = scriptToText(script)
  return (
    <input
      className="cell-input"
      value={text ?? canonical}
      onFocus={() => setText(canonical)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        setText(e.target.value)
        onCommit(textToScript(e.target.value))
      }}
    />
  )
}

/** Collapsible inspector group. Everything relevant to the selected component
 *  is on screen at once — sections collapse for reading comfort but nothing is
 *  hidden behind an exclusive tab (the old section rail meant clicking a MODEL
 *  component showed no model fields unless "Model" happened to be selected). */
function Group({ title, badge, defaultOpen = true, children }: { title: string; badge?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`iface-group${open ? '' : ' closed'}`}>
      <button type="button" className="iface-group-head" onClick={() => setOpen((o) => !o)}>
        <span className={`iface-group-arrow${open ? ' open' : ''}`}>▸</span>
        {title}
        {badge && <span className="iface-group-badge">{badge}</span>}
      </button>
      {open && <div className="iface-group-body">{children}</div>}
    </section>
  )
}

export default function InterfaceViewer({ data, onSave, onDirtyChange, onNavigate }: {
  data: InterfaceData
  onSave: (data: InterfaceData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}) {
  const [components, setComponents] = useState(data.components)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [viewportW, setViewportW] = useState(765)
  const [viewportH, setViewportH] = useState(503)
  const [showHidden, setShowHidden] = useState(false)
  const [showOutlines, setShowOutlines] = useState(false)
  /** null = fit the panel; a number = explicit scale with scrollable overflow. */
  const [zoom, setZoom] = useState<number | null>(null)
  /** flat single-interface canvas vs the composed in-game gameframe */
  const [gamePreview, setGamePreview] = useState(false)
  /** CS2 script open in the read-only viewer (null = closed) */
  const [viewScript, setViewScript] = useState<number | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  /** tree drag-to-reparent: what's being dragged, and what it's hovering */
  const [dragId, setDragId] = useState<number | null>(null)
  const [drop, setDrop] = useState<{ id: number; where: 'before' | 'inside' | 'after' } | null>(null)
  /** a reorder has changed ids since the last save — see handleSave */
  const [renumbered, setRenumbered] = useState(false)
  /** tree context menu. `target` null = right-clicked empty space, which means
   *  "top level" rather than "no target". */
  const [menu, setMenu] = useState<{ x: number; y: number; target: number | null } | null>(null)

  // Any click, Escape, or scroll dismisses it — a menu that outlives the thing
  // it was opened on would act on a stale component.
  useEffect(() => {
    if (!menu) return
    // Test containment rather than relying on stopPropagation inside the menu:
    // the menu is portalled out of this component's DOM subtree, so a React
    // handler on it can't be counted on to stop the native event before it
    // reaches window — and swallowing the mousedown would unmount the menu
    // before its own button's click could fire.
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    const onScroll = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  // Keep it on screen: right-clicking near the bottom or right edge would
  // otherwise open a menu partly outside the viewport, and a fixed element
  // can't be scrolled to. Measured after mount rather than estimated, since
  // the item labels carry component ids of varying width.
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const box = el.getBoundingClientRect()
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4))
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4))
    if (x !== menu.x || y !== menu.y) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [menu])

  /** Does the right-clicked component have anything nested under it? Decides
   *  whether Clone needs to be offered as a choice. */
  const menuHasChildren = menu?.target != null && subtreeOf(menu.target).length > 1

  const openMenu = (e: React.MouseEvent, target: number | null) => {
    e.preventDefault()
    e.stopPropagation()
    // right-clicking a row selects it, so the inspector follows the menu
    if (target != null) setSelectedId(target)
    setMenu({ x: e.clientX, y: e.clientY, target })
  }
  const confirm = (opts: Omit<PendingConfirm, 'resolve'>) =>
    new Promise<boolean>((resolve) => setPendingConfirm({ ...opts, resolve }))
  /** collapsed tree parents (componentIds) */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [modelPreview, setModelPreview] = useState<{ modelId: number; loading: boolean; data: ModelData | null } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** selection outline + snap guides, layered over the base */
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const dragCompRef = useRef<{ id: number; grabX: number; grabY: number; moved: boolean; downX: number; downY: number } | null>(null)
  const [guides, setGuides] = useState<SnapGuide[]>([])
  const [snapEnabled, setSnapEnabled] = useState(true)
  const assetsRef = useRef<InterfaceAssets | null>(null)
  const [assetsReady, setAssetsReady] = useState(0)

  useEffect(() => {
    setComponents(data.components)
    setIsDirty(false)
    setSelectedId(data.components.find((c) => c != null)?.componentId ?? null)
    setModelPreview(null)
  }, [data])

  // One asset cache per opened cache root (sprites/fonts/model renders persist across interfaces).
  useEffect(() => {
    if (!data.rootHandle) return
    const assets = new InterfaceAssets(data.rootHandle)
    assetsRef.current = assets
    setAssetsReady((n) => n + 1)
    return () => {
      assets.dispose()
      if (assetsRef.current === assets) assetsRef.current = null
    }
  }, [data.rootHandle])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const list = useMemo(() => components.filter((c): c is IComponentDefinition => c != null), [components])
  const byId = useMemo(() => new Map(list.map((c) => [c.componentId, c])), [list])

  /** Missing component ids below the highest used one. The client walks
   *  components 0..n and dereferences every slot, so a gap crashes it on load.
   *  Surfaced even with no pending edit, because an interface saved before
   *  removal learned to renumber is already holed on disk and needs a way out. */
  const idGaps = useMemo(() => {
    let lastUsed = -1
    for (let i = 0; i < components.length; i++) if (components[i] != null) lastUsed = i
    const out: number[] = []
    for (let i = 0; i < lastUsed; i++) if (components[i] == null) out.push(i)
    return out
  }, [components])
  // The sidebar tree: a depth-first walk so every component sits directly
  // under its parent (sibling order = components-array order, which is the
  // client's draw order). Orphans whose parent id doesn't resolve are
  // appended at the end rather than vanishing.
  const treeRows = useMemo(() => {
    const byParent = childrenByParent(components)
    const rows: { c: IComponentDefinition; depth: number; hasChildren: boolean }[] = []
    const visited = new Set<number>()
    const walk = (parentId: number, depth: number) => {
      if (depth > 32) return
      for (const c of byParent.get(parentId) ?? []) {
        if (visited.has(c.componentId)) continue
        visited.add(c.componentId)
        const hasChildren = (byParent.get(c.componentId)?.length ?? 0) > 0
        rows.push({ c, depth, hasChildren })
        if (!collapsed.has(c.componentId)) walk(c.componentId, depth + 1)
      }
    }
    walk(-1, 0)
    for (const c of list) {
      if (!visited.has(c.componentId) && !isDescendantOfCollapsed(c)) rows.push({ c, depth: 0, hasChildren: false })
    }
    function isDescendantOfCollapsed(c: IComponentDefinition): boolean {
      let cur = c
      const seen = new Set<number>()
      while (cur.parent !== -1) {
        const pid = cur.parent & 0xffff
        if (seen.has(pid)) return false
        seen.add(pid)
        if (collapsed.has(pid)) return true
        const parent = byId.get(pid)
        if (!parent) return false
        cur = parent
      }
      return false
    }
    return rows
  }, [components, list, collapsed, byId])

  // Selecting a component anywhere — a click on either canvas, a parent link
  // in the inspector — has to make it findable in the tree: expand whatever
  // collapsed ancestors are hiding its row, then scroll it into view.
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selectedId == null) return
    const ancestors: number[] = []
    let cur = byId.get(selectedId)
    const seen = new Set<number>()
    while (cur && cur.parent !== -1) {
      const pid = cur.parent & 0xffff
      if (seen.has(pid)) break
      seen.add(pid)
      ancestors.push(pid)
      cur = byId.get(pid)
    }
    setCollapsed((prev) => {
      if (!ancestors.some((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of ancestors) next.delete(id)
      return next
    })
  }, [selectedId, byId])

  // after the row exists (post-expand render), bring it into view; 'nearest'
  // leaves an already-visible row alone, so clicking rows doesn't jump
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, treeRows])

  const toggleCollapsed = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const layout = useMemo(() => resolveAbsoluteLayout(components, viewportW, viewportH), [components, viewportW, viewportH])
  const selected = selectedId != null ? byId.get(selectedId) ?? null : null

  // --- draw preview: load whatever assets this frame needs, then paint ---
  useEffect(() => {
    if (gamePreview) return // the gameframe component owns the canvas then
    const canvas = canvasRef.current
    const assets = assetsRef.current
    if (!canvas) return
    let cancelled = false
    const opts = { showHidden, showContainerOutlines: showOutlines }
    // Fixed 2× supersample: the canvas is CSS-fitted to its panel (the whole
    // interface is always visible, never scrolled), so the buffer renders at
    // 2× and downscales crisply.
    const SCALE = 2

    function paintBase(ctx: CanvasRenderingContext2D) {
      canvas!.width = viewportW * SCALE
      canvas!.height = viewportH * SCALE
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#14161d'
      ctx.fillRect(0, 0, viewportW, viewportH)
    }

    ;(async () => {
      const ctx = canvas.getContext('2d')!
      if (!assets) {
        paintBase(ctx)
        return
      }
      const resolved = await loadPreviewAssets(assets, components, layout, viewportW, viewportH, opts)
      if (cancelled) return
      paintBase(ctx)
      paintInterface(ctx, components, layout, resolved, viewportW, viewportH, opts)
    })()
    return () => { cancelled = true }
    // NOT selectedId — see the overlay effect below.
  }, [components, layout, viewportW, viewportH, showHidden, showOutlines, gamePreview, assetsReady])

  /**
   * The selection outline, on its own canvas over the base.
   *
   * It used to be the last step of the paint above, which meant clicking a
   * component re-resolved every sprite and font and redrew all of them to move
   * a dashed rectangle. On interface 746 — 459 components — that made the tree
   * unusable. A transparent overlay costs one stroke instead.
   */
  useEffect(() => {
    if (gamePreview) return
    const canvas = overlayRef.current
    if (!canvas) return
    const SCALE = 2
    // assigning width clears the canvas, so deselecting needs no explicit erase
    canvas.width = viewportW * SCALE
    canvas.height = viewportH * SCALE
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    // snap guides first, so the selection outline reads on top of them
    if (guides.length > 0) {
      ctx.strokeStyle = '#d9b45c'
      ctx.lineWidth = 1
      for (const g of guides) {
        // A guide on the parent's FAR edge sits exactly on the canvas
        // boundary, and a 1px line centred there is half outside — it drew
        // nothing at all, so bottom and right snaps looked like they weren't
        // snapping. Pull the line inside by half its width.
        const at = g.axis === 'x'
          ? Math.min(Math.max(g.at + 0.5, 0.5), viewportW - 0.5)
          : Math.min(Math.max(g.at + 0.5, 0.5), viewportH - 0.5)
        ctx.beginPath()
        if (g.axis === 'x') { ctx.moveTo(at, 0); ctx.lineTo(at, viewportH) }
        else { ctx.moveTo(0, at); ctx.lineTo(viewportW, at) }
        ctx.stroke()
      }
    }
    if (selectedId == null) return
    const rect = layout.get(selectedId)
    if (!rect) return
    ctx.strokeStyle = '#2f8fff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height)
  }, [selectedId, layout, viewportW, viewportH, gamePreview, guides])

  /** Canvas pixel under the event, in interface units — the canvas is CSS-fitted
   *  (or zoomed), so its displayed size is not its logical size. */
  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) {
    const bounds = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - bounds.left) / bounds.width) * viewportW,
      y: ((e.clientY - bounds.top) / bounds.height) * viewportH,
    }
  }

  /**
   * The SELECTED component is what drags, even when the press lands on a child
   * drawn on top of it.
   *
   * Hit-testing the press instead made a container or a backing figure
   * effectively immovable: the pointer is almost always over one of the
   * sprites inside it, so the drag grabbed the sprite. Selecting in the tree
   * and then dragging anywhere inside the selection is the way to move the
   * thing you actually mean.
   *
   * A press that DOESN'T move still selects whatever is under the cursor on
   * release, so clicking through to a child is unaffected.
   */
  function handleCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = canvasPoint(e)
    const selRect = selectedId != null ? layout.get(selectedId) : null
    const inSelection = selRect != null
      && p.x >= selRect.x && p.x <= selRect.x + selRect.width
      && p.y >= selRect.y && p.y <= selRect.y + selRect.height
    const id = inSelection ? selectedId! : hitTestComponent(list, layout, p.x, p.y, showHidden)
    if (id == null) return
    if (!inSelection) setSelectedId(id)
    const rect = layout.get(id)
    if (!rect) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragCompRef.current = { id, grabX: p.x - rect.x, grabY: p.y - rect.y, moved: false, downX: p.x, downY: p.y }
  }

  function handleCanvasPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragCompRef.current
    if (!drag) return
    const comp = byId.get(drag.id)
    const rect = layout.get(drag.id)
    if (!comp || !rect) return
    const p = canvasPoint(e)
    // a couple of pixels of slop, so a click that twitches isn't a move
    if (!drag.moved && Math.abs(p.x - drag.downX) < 2 && Math.abs(p.y - drag.downY) < 2) return
    const parent = parentBoxOf(comp, list, layout, viewportW, viewportH)
    const out = dragToBasePosition(
      comp, rect, parent, list, layout, p, { x: drag.grabX, y: drag.grabY }, snapEnabled,
    )
    drag.moved = true
    setGuides(out.guides)
    setComponents((prev) => prev.map((c) => (
      c && c.componentId === drag.id
        ? { ...c, basePositionX: out.basePositionX, basePositionY: out.basePositionY }
        : c
    )))
    setIsDirty(true)
  }

  function handleCanvasPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragCompRef.current
    dragCompRef.current = null
    setGuides([])
    // a click, not a drag: select what's actually under the cursor, so a
    // container being selected doesn't block clicking through to its children
    if (drag && !drag.moved) {
      const p = canvasPoint(e)
      const id = hitTestComponent(list, layout, p.x, p.y, showHidden)
      if (id != null) setSelectedId(id)
    }
  }

  function updateSelected(patch: Partial<IComponentDefinition>) {
    if (selectedId == null) return
    setComponents((prev) => prev.map((c) => (c && c.componentId === selectedId ? { ...c, ...patch } : c)))
    setIsDirty(true)
  }

  function set(key: keyof IComponentDefinition, value: unknown) {
    updateSelected({ [key]: value } as Partial<IComponentDefinition>)
  }

  /**
   * Add a component as a child of the selected one (or at the top level when
   * nothing is selected).
   *
   * The id is always `length` — the array is dense and stays that way. There
   * is no such thing as a free index to reuse: the client walks components
   * 0..n and dereferences every slot, so removal renumbers rather than leaving
   * a hole. A new component therefore lands last in its parent's draw order;
   * drag it into place if that matters.
   */
  function addComponent(parentId: number | null) {
    const parentHash = parentId == null ? -1 : (data.id << 16) | parentId
    const id = components.length
    setComponents((prev) => [...prev, blankComponent(data.id, prev.length, parentHash, 0)])
    setSelectedId(id)
    setIsDirty(true)
  }

  /**
   * Duplicate a component, optionally with everything under it.
   *
   * With children, hashes are rewired to the copies: a cloned button whose
   * hook points at its own tooltip container gets a hook pointing at the
   * CLONE's container, not the original's. References that leave the copied
   * set are untouched — those still mean what they said, and that is exactly
   * why cloning WITHOUT children rewrites nothing at all: the copy's hooks go
   * on addressing the original's children, because those are the only ones
   * that exist.
   */
  function cloneComponent(id: number, withChildren: boolean) {
    // deepest first, and only ids that actually resolve — the copies are
    // appended in this order, so skipping a missing one mid-loop would leave
    // the gap that removal now goes out of its way to prevent
    const subtree = (withChildren ? subtreeOf(id) : [id]).filter((old) => components[old] != null)
    if (subtree.length === 0) return
    const base = components.length
    const remap = new Map<number, number>()
    subtree.forEach((old, i) => remap.set(old, base + i))
    const hashOf = (n: number) => (data.id << 16) | n
    const remapHash = (v: number | string) => {
      if (typeof v !== 'number' || v < 0 || (v >>> 16) !== data.id) return v
      const to = remap.get(v & 0xffff)
      return to === undefined ? v : hashOf(to)
    }

    setComponents((prev) => {
      const next = [...prev]
      for (const old of subtree) {
        const src = prev[old]
        if (!src) continue
        const newId = remap.get(old)!
        const clone: IComponentDefinition = {
          ...src,
          componentId: newId,
          // the subtree's ROOT keeps its parent — the copy lands beside the
          // original; everything below it follows its own copied parent
          parent: old === id ? src.parent : remapHash(src.parent) as number,
        }
        for (const [key] of SCRIPT_FIELDS) {
          const hook = src[key] as CS2Script | null
          if (hook) (clone[key] as CS2Script) = hook.map(remapHash)
        }
        if (src.targetParams && src.targetParams.interfaceId === data.id) {
          const to = remap.get(src.targetParams.componentId)
          if (to !== undefined) clone.targetParams = { ...src.targetParams, componentId: to }
        }
        while (next.length <= newId) next.push(null)
        next[newId] = clone
      }
      return next
    })
    setSelectedId(remap.get(id)!)
    setIsDirty(true)
  }

  /**
   * Move a component under a new parent. −1 makes it top-level.
   *
   * Nothing is renumbered: `parent` is a hash the component stores about
   * ITSELF, so reparenting touches exactly one field on one component. Ids
   * stay put, which matters because an id is the component's filename and the
   * low half of every hash that references it — including from other
   * interfaces, which this viewer can't see. Interface 746 already has 46
   * components whose id is lower than their parent's, so a hierarchy that
   * disagrees with id order is normal cache data, not something to tidy up.
   */
  function reparent(childId: number, newParentId: number) {
    if (childId === newParentId) return
    // a component can't be moved inside its own subtree — the tree walk would
    // never terminate and the client's layout pass would recurse forever
    if (subtreeOf(childId).includes(newParentId)) return
    const parentHash = newParentId === -1 ? -1 : (data.id << 16) | newParentId
    setComponents((prev) => prev.map((c) => (
      c && c.componentId === childId ? { ...c, parent: parentHash } : c
    )))
    setIsDirty(true)
  }

  /**
   * Put `dragId` immediately before or after `targetId`, becoming a sibling of
   * it.
   *
   * Sibling draw order IS componentId order — the client builds its draw list
   * with a straight `System.arraycopy` of the id-indexed array
   * (`Interface.getDefinitionsFromComponents`), and the only reordering it
   * does (bring-to-front, from CS2) mutates that copy at runtime and never
   * reaches the cache. So expressing a new order means changing ids.
   *
   * It changes as few as possible: the new sibling list keeps the exact SET of
   * ids it already had, and only which component holds which is permuted. No
   * id outside that group moves, so nothing outside it needs rewriting.
   */
  function moveBeside(dragId: number, targetId: number, after: boolean) {
    const target = byId.get(targetId)
    const dragged = byId.get(dragId)
    if (!target || !dragged || dragId === targetId) return
    const newParentId = target.parent === -1 ? -1 : target.parent & 0xffff
    if (subtreeOf(dragId).includes(newParentId)) return

    // `list` is array order, so siblings come out ascending by id already
    const siblings = list.filter((c) => (
      (c.parent === -1 ? -1 : c.parent & 0xffff) === newParentId && c.componentId !== dragId
    ))
    const at = siblings.findIndex((c) => c.componentId === targetId)
    if (at === -1) return
    const ordered = [...siblings]
    ordered.splice(after ? at + 1 : at, 0, dragged)

    // the same ids, ascending, handed out in the new order
    const slots = ordered.map((c) => c.componentId).sort((a, b) => a - b)
    const remap = new Map<number, number>()
    ordered.forEach((c, i) => { if (c.componentId !== slots[i]) remap.set(c.componentId, slots[i]) })
    if (remap.size === 0) {
      reparent(dragId, newParentId) // already in place; may still be a move
      return
    }
    applyRenumber(remap, dragId, newParentId)
  }

  /**
   * Rewrite ids across the interface: the components themselves, every
   * `parent` hash, every hook argument that names one, and drag/target
   * settings. Returns a fresh array indexed BY the new componentId.
   *
   * Interface-LOCAL only. A component's id is the low half of the hash any
   * script uses to reach it, and hooks in other interfaces hold those hashes
   * too — 548 references 746's components today. Nothing here can see those,
   * which is why saving after a renumber warns.
   */
  function rewriteIds(
    source: (IComponentDefinition | null)[],
    remap: Map<number, number>,
    /** Force one component (named by its OLD id) onto a new parent — for a
     *  drag that reparents as well as reorders. */
    parentOverride?: { oldId: number; parentId: number },
  ): (IComponentDefinition | null)[] {
    const hashOf = (id: number) => (data.id << 16) | id
    const remapHash = (v: number | string) => {
      if (typeof v !== 'number' || v < 0) return v
      if ((v >>> 16) !== data.id) return v // a hash into a different interface
      const to = remap.get(v & 0xffff)
      return to === undefined ? v : hashOf(to)
    }

    const moved: IComponentDefinition[] = []
    for (const c of source) {
      if (!c) continue
      const id = remap.get(c.componentId) ?? c.componentId
      const parent = parentOverride && c.componentId === parentOverride.oldId
        ? (parentOverride.parentId === -1 ? -1 : hashOf(parentOverride.parentId))
        : (c.parent === -1 ? -1 : remapHash(c.parent) as number)
      const next: IComponentDefinition = { ...c, componentId: id, parent }
      for (const [key] of SCRIPT_FIELDS) {
        const hook = c[key] as CS2Script | null
        if (hook) (next[key] as CS2Script) = hook.map(remapHash)
      }
      if (c.targetParams && c.targetParams.interfaceId === data.id) {
        const to = remap.get(c.targetParams.componentId)
        if (to !== undefined) next.targetParams = { ...c.targetParams, componentId: to }
      }
      moved.push(next)
    }
    // index must equal componentId — that index is the filename on save
    const out: (IComponentDefinition | null)[] = []
    for (const c of moved) {
      while (out.length <= c.componentId) out.push(null)
      out[c.componentId] = c
    }
    return out
  }

  function applyRenumber(remap: Map<number, number>, movedId: number, movedParentId: number) {
    setComponents((prev) => rewriteIds(prev, remap, { oldId: movedId, parentId: movedParentId }))
    // follow the component the user actually dragged
    setSelectedId(remap.get(movedId) ?? movedId)
    setRenumbered(true)
    setIsDirty(true)
  }

  /** Does this component's hooks or drag target name any of `ids`? */
  function referencesAny(c: IComponentDefinition, ids: ReadonlySet<number>): boolean {
    for (const [key] of SCRIPT_FIELDS) {
      const hook = c[key] as CS2Script | null
      if (!hook) continue
      for (const v of hook) {
        if (typeof v === 'number' && v >= 0 && (v >>> 16) === data.id && ids.has(v & 0xffff)) return true
      }
    }
    return c.targetParams != null
      && c.targetParams.interfaceId === data.id
      && ids.has(c.targetParams.componentId)
  }

  /** Would this drop be legal? Rejected up front so an impossible target
   *  never lights up — a drop into your own subtree, or a no-op onto the
   *  parent you already have. */
  function canDropInto(childId: number, parentId: number): boolean {
    if (childId === parentId) return false
    const child = byId.get(childId)
    if (child && (child.parent === -1 ? -1 : child.parent & 0xffff) === parentId) return false
    return !subtreeOf(childId).includes(parentId)
  }

  /** A component and everything under it, deepest first. */
  function subtreeOf(rootId: number): number[] {
    const out: number[] = []
    const walk = (id: number, depth: number) => {
      if (depth > 32) return
      for (const c of components) {
        if (c && c.parent !== -1 && (c.parent & 0xffff) === id && c.componentId !== id) walk(c.componentId, depth + 1)
      }
      out.push(id)
    }
    walk(rootId, 0)
    return out
  }

  /**
   * Remove the selected component AND its descendants. Deleting a container
   * on its own would leave its children pointing at an id that no longer
   * resolves — they'd still save, still load, and render as orphans at the
   * top of the tree, which is a worse outcome than losing them deliberately.
   */
  async function removeComponent(id: number) {
    const doomed = subtreeOf(id)
    const kids = doomed.length - 1
    const doomedSet = new Set(doomed)

    // Component ids must stay CONTIGUOUS. The client builds its draw list by
    // walking the array with a plain `for (i = 0; i < components.length; i++)`
    // and dereferencing every slot, so a gap is a crash on load, not untidiness
    // — and 1,321 of the 1,322 interfaces in the cache are contiguous 0..n-1.
    // So removal closes the gap: survivors keep their relative order and are
    // renumbered down onto 0..n-1, with every hash rewritten to match.
    const survivors = list.filter((c) => !doomedSet.has(c.componentId))
    const remap = new Map<number, number>()
    survivors.forEach((c, i) => { if (c.componentId !== i) remap.set(c.componentId, i) })

    // Hooks aimed at something being removed can't be repointed anywhere
    // sensible, and after the renumber those ids belong to a DIFFERENT
    // component — so they don't dangle, they silently retarget. Name them.
    const stale = survivors.filter((c) => referencesAny(c, doomedSet)).map((c) => c.componentId)

    // Always ask. Removal is the one edit here with no undo short of
    // discarding every other change too.
    if (!(await confirm({
      title: 'Remove component',
      message: (
        <>
          <p>
            {kids > 0
              ? `Remove component ${id} and the ${kids} component${kids === 1 ? '' : 's'} inside it? Everything nested under it goes as well — left behind, they would point at a parent that no longer exists.`
              : `Remove component ${id}?`}
          </p>
          {remap.size > 0 && (
            <p>
              {remap.size} component{remap.size === 1 ? '' : 's'} will be renumbered to keep ids
              contiguous — a gap crashes the client on load. References inside this interface are
              rewritten; anything outside it still points at the old numbers.
            </p>
          )}
          {stale.length > 0 && (
            <p>
              <strong>Warning:</strong> component{stale.length === 1 ? '' : 's'} {stale.join(', ')}
              {stale.length === 1 ? ' references' : ' reference'} something being removed. Those
              references will end up pointing at a different component — fix them after removing.
            </p>
          )}
        </>
      ),
      confirmLabel: kids > 0 ? `Remove all ${doomed.length}` : 'Remove',
      danger: true,
    }))) return

    setComponents(() => rewriteIds(survivors, remap))
    setSelectedId(null)
    if (remap.size > 0) setRenumbered(true)
    setIsDirty(true)
  }

  async function handleSave() {
    let toSave = components

    // Contiguity backstop. The client walks components with a plain
    // `for (i = 0; i < components.length; i++)` and dereferences every slot, so
    // a missing id crashes it on load — and the loader turns a null slot into a
    // deleted file, which is exactly how that reaches disk. Removal renumbers
    // to prevent it; this catches an interface that is ALREADY holed (one
    // written before that fix) and offers to close the gaps on the way out.
    const gaps = idGaps
    if (gaps.length > 0) {
      if (!(await confirm({
        title: 'Component ids are not contiguous',
        message: (
          <>
            <p>
              Interface {data.id} is missing component{gaps.length === 1 ? '' : 's'} {gaps.join(', ')}{' '}
              while higher ids exist. The client walks components 0..n and dereferences every slot,
              so it would crash loading this.
            </p>
            <p>
              Saving can close the gap{gaps.length === 1 ? '' : 's'} by renumbering the{' '}
              {list.length} remaining components onto 0..{list.length - 1}, rewriting every parent
              hash, hook argument and drag target inside this interface to match.
            </p>
            <p>
              Anything OUTSIDE this interface that names these components — hooks on other
              interfaces, ids baked into CS2 scripts, server code — still points at the old numbers
              and will now reach the wrong component. Check before saving.
            </p>
          </>
        ),
        confirmLabel: 'Renumber and save',
        danger: true,
      }))) return
      const remap = new Map<number, number>()
      list.forEach((c, i) => { if (c.componentId !== i) remap.set(c.componentId, i) })
      toSave = rewriteIds(list, remap)
      setComponents(toSave)
      setSelectedId(null)
    } else if (renumbered) {
      // A reorder changed component IDS, and an id is the low half of every hash
      // that reaches the component. References inside this interface were
      // rewritten; references from ANYWHERE ELSE cannot be — not other
      // interfaces' hooks, not hardcoded hashes in CS2 scripts, not server code.
      // Worth a stop, because nothing about it fails loudly.
      if (!(await confirm({
        title: 'Component ids changed',
        message: `Reordering changed component ids in interface ${data.id}. Hashes inside this interface were updated, but anything OUTSIDE it that names those components — hooks on other interfaces, ids baked into CS2 scripts, server code — still points at the old numbers and will now reach the wrong component. Check before saving.`,
        confirmLabel: 'Save anyway',
        danger: true,
      }))) return
    }

    setIsSaving(true)
    await onSave({ ...data, components: toSave })
    setIsSaving(false)
    setIsDirty(false)
    setRenumbered(false)
  }

  function handleDiscard() {
    setComponents(data.components)
    setIsDirty(false)
    setRenumbered(false)
  }

  async function openModelPreview(modelId: number) {
    if (modelId < 0 || !data.rootHandle) return
    setModelPreview({ modelId, loading: true, data: null })
    try {
      const modelsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('models'))
      const loader = getLoader('models')
      if (!modelsDir || !loader) throw new Error('models entry not available')
      const modelData = await loader.loadItem(modelsDir, { id: modelId, name: `${modelId}` }, data.rootHandle) as ModelData
      setModelPreview({ modelId, loading: false, data: modelData })
    } catch {
      setModelPreview({ modelId, loading: false, data: null })
    }
  }

  const attachedScripts = selected ? SCRIPT_FIELDS.filter(([key]) => (selected[key] as CS2Script | null) != null) : []
  const unattachedScripts = selected ? SCRIPT_FIELDS.filter(([key]) => (selected[key] as CS2Script | null) == null) : []
  // The transmit filters only mean anything next to a transmit hook — showing
  // two empty id lists on the thousands of components that have neither is
  // noise. A stale list with no hook still shows, so it can be cleared.
  const showsFilters = selected != null && (
    selected.onVarpTransmit != null || selected.onStatTransmit != null
    || (selected.varps?.length ?? 0) > 0 || (selected.statTransmitFilter?.length ?? 0) > 0
  )
  const hasOps = selected != null && (selected.hasInteraction || selected.opBase !== '' || selected.targetVerb !== '' || (selected.options?.some((o) => o) ?? false))

  return (
    <div className="iface-viewer">
      <div className="iface-header">
        <span className="item-id-badge">Interface {data.id}</span>
        <span className="iface-count">{list.length} components</span>
        <button
          type="button"
          className={`iface-gameframe-btn${gamePreview ? ' selected' : ''}`}
          title="Render this interface inside the real gameframe (chatbox, minimap, tabs) at a resizable client size"
          onClick={() => setGamePreview((v) => !v)}
        >
          In-game preview
        </button>
        {!gamePreview && (
          <>
            <label className="iface-viewport-field">
              Viewport
              <NumberInput value={viewportW} onChange={setViewportW} min={16} digits={4} />
              ×
              <NumberInput value={viewportH} onChange={setViewportH} min={16} digits={4} />
            </label>
            <div className="iface-presets">
              <button type="button" title="Classic fixed game screen" onClick={() => { setViewportW(765); setViewportH(503) }}>765×503</button>
              <button type="button" title="Fixed-mode 3D viewport" onClick={() => { setViewportW(512); setViewportH(334) }}>512×334</button>
              <button type="button" title="A resizable-mode window" onClick={() => { setViewportW(1024); setViewportH(768) }}>1024×768</button>
            </div>
            <div className="iface-zoom">
              <button type="button" onClick={() => setZoom((z) => Math.max(0.25, (z ?? 1) - 0.25))}>−</button>
              <span>{zoom == null ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
              <button type="button" onClick={() => setZoom((z) => Math.min(4, (z ?? 1) + 0.25))}>+</button>
              {zoom != null && <button type="button" className="iface-zoom-fit" onClick={() => setZoom(null)}>Fit</button>}
            </div>
          </>
        )}
        <label className="iface-toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
        <label className="iface-toggle">
          <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
          Container outlines
        </label>
        {/* One control for both previews — the flat canvas and the gameframe
            drag through the same code, so two toggles would only disagree. */}
        <button
          type="button"
          className={`iface-snap-pill${snapEnabled ? ' selected' : ''}`}
          title={snapEnabled
            ? 'Dragging snaps to the parent’s edges and centre and to sibling edges. Click to drag freely.'
            : 'Dragging is free. Click to snap to parent and sibling edges.'}
          onClick={() => setSnapEnabled((v) => !v)}
        >
          Snap {snapEnabled ? 'on' : 'off'}
        </button>
      </div>

      <div className="iface-body">
        <div className="iface-tree" onContextMenu={(e) => openMenu(e, null)}>
          {treeRows.map(({ c, depth, hasChildren }) => (
            <div
              key={c.componentId}
              ref={c.componentId === selectedId ? selectedRowRef : undefined}
              className={[
                'iface-tree-row',
                c.componentId === selectedId ? 'selected' : '',
                c.hidden ? 'hidden-row' : '',
                dragId === c.componentId ? 'dragging' : '',
                drop?.id === c.componentId ? `drop-${drop.where}` : '',
              ].filter(Boolean).join(' ')}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => setSelectedId(c.componentId)}
              onContextMenu={(e) => openMenu(e, c.componentId)}
              draggable
              onDragStart={(e) => {
                setDragId(c.componentId)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox ignores a drag with no payload
                e.dataTransfer.setData('text/plain', String(c.componentId))
              }}
              onDragEnd={() => { setDragId(null); setDrop(null) }}
              onDragOver={(e) => {
                if (dragId == null) return
                // Three zones: the edges mean "beside this one" (a reorder,
                // which renumbers), the middle means "inside it" (just a
                // reparent). The middle is the larger target because it's the
                // cheaper operation.
                const box = e.currentTarget.getBoundingClientRect()
                const frac = (e.clientY - box.top) / box.height
                const where = frac < 0.25 ? 'before' : frac > 0.75 ? 'after' : 'inside'
                if (where === 'inside' && !canDropInto(dragId, c.componentId)) return
                if (where !== 'inside' && c.componentId === dragId) return
                e.preventDefault() // "yes, this is a drop target"
                e.dataTransfer.dropEffect = 'move'
                setDrop({ id: c.componentId, where })
              }}
              onDragLeave={() => setDrop((d) => (d?.id === c.componentId ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (dragId != null && drop?.id === c.componentId) {
                  if (drop.where === 'inside') reparent(dragId, c.componentId)
                  else moveBeside(dragId, c.componentId, drop.where === 'after')
                }
                setDragId(null)
                setDrop(null)
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className={`iface-tree-arrow${collapsed.has(c.componentId) ? '' : ' open'}`}
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(c.componentId) }}
                >
                  ▸
                </button>
              ) : (
                <span className="iface-tree-arrow-spacer" />
              )}
              <span className="iface-tree-id">{c.componentId}</span>
              <span className="iface-tree-type">{c.type}</span>
              {c.name && <span className="iface-tree-name">{c.name}</span>}
            </div>
          ))}
          {/* Drop here to move a component OUT of its parent — there is no
              row representing "top level" to aim at otherwise. Fills the
              leftover space so it's an easy target on a short tree. */}
          <div
            className={`iface-tree-root-drop${drop?.id === -1 ? ' drop-inside' : ''}`}
            onDragOver={(e) => {
              if (dragId == null || !canDropInto(dragId, -1)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDrop({ id: -1, where: 'inside' })
            }}
            onDragLeave={() => setDrop((d) => (d?.id === -1 ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId != null) reparent(dragId, -1)
              setDragId(null)
              setDrop(null)
            }}
          >
            {/* doubles as the only signpost for the context menu, now that
                add/remove live there rather than on a toolbar */}
            {dragId != null ? 'drop here for top level' : 'right-click for add · clone · remove'}
          </div>
        </div>

        <div className="iface-main">
          {gamePreview ? (
            <GameframePreview
              data={{ ...data, components }}
              assets={assetsRef.current}
              opts={{ showHidden, showContainerOutlines: showOutlines }}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onEditScript={onNavigate ? (id) => onNavigate('cs2', id) : undefined}
              snap={snapEnabled}
              onMoveComponent={(id, basePositionX, basePositionY) => {
                setComponents((prev) => prev.map((c) => (
                  c && c.componentId === id ? { ...c, basePositionX, basePositionY } : c
                )))
                setIsDirty(true)
              }}
            />
          ) : (
            <div className="iface-canvas-wrap">
              <canvas
                ref={canvasRef}
                className="iface-canvas"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                style={zoom == null ? undefined : { width: `${viewportW * zoom}px`, maxWidth: 'none', maxHeight: 'none' }}
              />
              {/* selection only — pointer-events off so clicks reach the base */}
              <canvas
                ref={overlayRef}
                className="iface-canvas iface-canvas-overlay"
                style={zoom == null ? undefined : { width: `${viewportW * zoom}px`, maxWidth: 'none', maxHeight: 'none' }}
              />
            </div>
          )}
        </div>

        <div className="iface-inspector">
          {!selected && (
            <div className="iface-side-hint">Click a component in the preview or the tree to inspect it.</div>
          )}
          {selected && (
            <>
              <div className="iface-fields-title">
                Component {selected.componentId}
                {/* The type decides which field groups below even apply, so it
                    has to be changeable — a component added as a container
                    could otherwise never become a sprite. `typeId` is written
                    alongside because the JSON carries both and they must not
                    disagree. */}
                <CellDropdown<ComponentType>
                  value={selected.type}
                  options={COMPONENT_TYPES.map((t) => ({ value: t, label: t }))}
                  title="What this component IS. Changing it changes which fields apply."
                  onChange={(type) => updateSelected({ type, typeId: COMPONENT_TYPES.indexOf(type) })}
                />
                {selected.parent !== -1 && (
                  <button type="button" className="iface-parent-link" onClick={() => setSelectedId(selected.parent & 0xffff)}>
                    parent {selected.parent & 0xffff}
                  </button>
                )}
              </div>

              {selected.type === 'SPRITE' && (
                <Group title="Sprite">
                  <NumGrid
                    fields={[['spriteId', 'Sprite Id'], ...SPRITE_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                    links={{ spriteId: onNavigate ? { label: 'View', onOpen: (id) => onNavigate('sprites', id) } : undefined }}
                  />
                  <ToggleGrid
                    fields={[['tiling', 'Tiling'], ['alpha', 'Alpha'], ['flipVertical', 'Flip V'], ['flipHorizontal', 'Flip H'], ['clickMask', 'Click Mask']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </Group>
              )}

              {selected.type === 'MODEL' && (
                <Group title="Model">
                  <label className="item-field">
                    <span className="item-field-label">Model Type</span>
                    <select value={selected.modelType} onChange={(e) => set('modelType', e.target.value as ModelType)}>
                      {MODEL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <NumGrid
                    fields={[['modelId', 'Model Id'], ...MODEL_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                    links={{
                      modelId: {
                        label: 'Preview',
                        onOpen: (id) => openModelPreview(id),
                      },
                    }}
                  />
                  <ToggleGrid
                    fields={[['hasOrigin', 'Has Origin'], ['hasTransform', 'Has Transform'], ['priorityRender', 'Priority Render'], ['usesOrthogonal', 'Orthogonal']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  {modelPreview && (
                    <div className="iface-model-preview">
                      {modelPreview.loading && <div className="iface-model-loading">Loading model {modelPreview.modelId}…</div>}
                      {!modelPreview.loading && !modelPreview.data && <div className="iface-model-loading">Model {modelPreview.modelId} failed to load.</div>}
                      {!modelPreview.loading && modelPreview.data && (
                        <div className="iface-model-preview-canvas">
                          <ModelViewer data={modelPreview.data} display={null} />
                        </div>
                      )}
                    </div>
                  )}
                </Group>
              )}

              {selected.type === 'TEXT' && (
                <Group title="Text">
                  <label className="item-field iface-text-field">
                    <span className="item-field-label">Text</span>
                    <textarea
                      className="quest-textarea"
                      value={selected.text}
                      onChange={(e) => set('text', e.target.value)}
                    />
                  </label>
                  <NumGrid
                    fields={[['fontId', 'Font Id'], ...TEXT_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <ToggleGrid
                    fields={[['shadow', 'Shadow'], ['monospaced', 'Monospaced']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </Group>
              )}

              {(selected.type === 'FIGURE' || selected.type === 'LINE') && (
                <Group title={selected.type === 'FIGURE' ? 'Figure' : 'Line'}>
                  <NumGrid
                    fields={selected.type === 'LINE' ? [['lineWidth', 'Line Width']] : [['transparency', 'Transparency']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <ToggleGrid
                    fields={selected.type === 'FIGURE' ? [['filled', 'Filled']] : [['lineDirection', 'Direction (\\ vs /)']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </Group>
              )}

              <Group title="Layout">
                <NumGrid fields={LAYOUT_FIELDS} values={selected} onChange={(k, v) => set(k as keyof IComponentDefinition, v)} />
                <ModeSelect label="X mode" value={selected.aspectXType} modes={X_MODES} onChange={(v) => set('aspectXType', v)} />
                <ModeSelect label="Y mode" value={selected.aspectYType} modes={Y_MODES} onChange={(v) => set('aspectYType', v)} />
                <ModeSelect label="Width mode" value={selected.aspectWidthType} modes={SIZE_MODES} onChange={(v) => set('aspectWidthType', v)} />
                <ModeSelect label="Height mode" value={selected.aspectHeightType} modes={SIZE_MODES} onChange={(v) => set('aspectHeightType', v)} />
                {selected.type === 'CONTAINER' && (
                  <NumGrid
                    fields={[['scrollWidth', 'Scroll Width'], ['scrollHeight', 'Scroll Height']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                )}
                <ToggleGrid
                  fields={[['hidden', 'Hidden'], ['preventClickThrough', 'Prevent Click-Through']]}
                  values={selected}
                  onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                />
              </Group>

              <Group title="Options & Cursors" badge={hasOps ? undefined : 'none'} defaultOpen={hasOps}>
                <label className="item-field">
                  <span className="item-field-label">Op Base</span>
                  <input className="cell-input" value={selected.opBase} onChange={(e) => set('opBase', e.target.value)} />
                </label>
                <label className="item-field">
                  <span className="item-field-label">Target Verb</span>
                  <input className="cell-input" value={selected.targetVerb} onChange={(e) => set('targetVerb', e.target.value)} />
                </label>
                {(selected.options ?? []).map((opt, i) => (
                  <label key={i} className="item-field">
                    <span className="item-field-label">Option {i + 1}</span>
                    <input
                      className="cell-input"
                      value={opt ?? ''}
                      onChange={(e) => {
                        const next = [...(selected.options ?? [])]
                        next[i] = e.target.value
                        set('options', next)
                      }}
                    />
                  </label>
                ))}
                <NumGrid fields={CURSOR_FIELDS} values={selected} onChange={(k, v) => set(k as keyof IComponentDefinition, v)} />
              </Group>

              <Group
                title="CS2 Scripts"
                badge={attachedScripts.length > 0 ? `${attachedScripts.length}` : 'none'}
                defaultOpen={attachedScripts.length > 0}
              >
                {attachedScripts.length === 0 && (
                  <div className="iface-no-scripts">No scripts attached to this component.</div>
                )}
                {/* The subscription lists. A transmit hook does NOT fire on
                    every var — the client only runs it when one of the ids
                    listed here arrives, so a script with an empty list is dead
                    in game. They belong beside the hooks for that reason: edit
                    one without the other and the component silently stops
                    updating. (The gameframe preview fires transmit hooks
                    unconditionally — one static world state — so it can't warn
                    you about this.) */}
                <div className="iface-filter-row" hidden={!showsFilters}>
                  <label className="item-field iface-text-field">
                    <span className="item-field-label" title="Varp ids that make On Varp Transmit fire. Comma-separated; empty means it never fires.">
                      Varp filter
                    </span>
                    <IntListInput
                      value={selected.varps ?? undefined}
                      onChange={(v) => set('varps', v ?? null)}
                    />
                  </label>
                  <label className="item-field iface-text-field">
                    <span className="item-field-label" title="Skill ids that make On Stat Transmit fire. Comma-separated; empty means it never fires.">
                      Stat filter
                    </span>
                    <IntListInput
                      value={selected.statTransmitFilter ?? undefined}
                      onChange={(v) => set('statTransmitFilter', v ?? null)}
                    />
                    {(selected.statTransmitFilter?.length ?? 0) > 0 && (
                      <span className="iface-filter-hint">
                        {selected.statTransmitFilter!.map((s) => SKILL_NAMES[s] ?? `skill ${s}`).join(', ')}
                      </span>
                    )}
                  </label>
                </div>
                {attachedScripts.map(([key, label, hint]) => {
                  // a hook is [scriptId, ...args] — the id is only viewable
                  // when it's actually a number (some hooks carry a string tag)
                  const hook = selected[key] as CS2Script | null
                  const id = typeof hook?.[0] === 'number' ? (hook[0] as number) : null
                  return (
                    <label key={key} className="item-field iface-text-field">
                      {/* same top-right cell button as the id fields that jump
                          to another entry, so every cell's action sits in the
                          same place regardless of label length */}
                      <span className="item-field-label field-link-label">
                        <span title={hint}>{label}{hint && <span className="iface-label-note">?</span>}</span>
                        <span className="iface-hook-actions">
                          {id != null && id >= 0 && (
                            <button
                              type="button"
                              className="field-link-btn"
                              title={`Read script ${id} without leaving this component`}
                              onClick={(e) => { e.preventDefault(); setViewScript(id) }}
                            >
                              View
                            </button>
                          )}
                          {/* Detaches the hook entirely — null, not an empty
                              array. A zero-length hook still writes the field
                              to the JSON, and the client treats "present but
                              empty" differently from absent. */}
                          <button
                            type="button"
                            className="row-remove-btn"
                            title={`Detach ${label} from this component`}
                            onClick={(e) => { e.preventDefault(); set(key, null) }}
                          >
                            ×
                          </button>
                        </span>
                      </span>
                      <ScriptInput
                        script={hook}
                        onCommit={(s) => set(key, s)}
                      />
                    </label>
                  )
                })}
                {unattachedScripts.length > 0 && (
                  <div className="var-add-row">
                    <select
                      className="item-stackable-select"
                      value=""
                      onChange={(e) => {
                        // -1 is "no script yet": the field now exists so it can
                        // be edited, but the preview skips negative ids rather
                        // than reporting a missing script on every run
                        set(e.target.value as keyof IComponentDefinition, [-1])
                        e.currentTarget.value = ''
                      }}
                    >
                      <option value="" disabled>+ Attach a hook…</option>
                      {unattachedScripts.map(([key, label, hint]) => (
                        <option key={key} value={key} title={hint}>{label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </Group>
            </>
          )}
        </div>
      </div>

      {menu && createPortal(
        // Portalled to <body> deliberately. `position: fixed` resolves against
        // the viewport only if NO ancestor creates a containing block for it —
        // a transform, filter, backdrop-filter, will-change or contain
        // anywhere up the tree silently re-anchors it, which is what put this
        // menu far to the right of the cursor. Out at the body there is no
        // ancestor left to do that, and it also escapes any overflow clipping
        // and z-index stacking on the way up.
        <div
          ref={menuRef}
          className="iface-ctx-menu cell-dropdown-menu"
          style={{ top: menu.y, left: menu.x }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
        >
          <button
            type="button"
            className="cell-dropdown-item"
            onClick={() => { addComponent(menu.target); setMenu(null) }}
          >
            Add component
          </button>
          {menu.target != null && (
            <>
              {/* Only a component with children needs the choice — offering
                  both on a leaf would be two items that do the same thing. */}
              {menuHasChildren ? (
                <>
                  <button
                    type="button"
                    className="cell-dropdown-item"
                    onClick={() => { cloneComponent(menu.target!, true); setMenu(null) }}
                  >
                    Clone (with children)
                  </button>
                  <button
                    type="button"
                    className="cell-dropdown-item"
                    onClick={() => { cloneComponent(menu.target!, false); setMenu(null) }}
                  >
                    Clone (without children)
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="cell-dropdown-item"
                  onClick={() => { cloneComponent(menu.target!, false); setMenu(null) }}
                >
                  Clone
                </button>
              )}
              <button
                type="button"
                className="cell-dropdown-item danger"
                onClick={() => { const t = menu.target!; setMenu(null); void removeComponent(t) }}
              >
                Remove
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {pendingConfirm && (
        <ConfirmDialog
          pending={pendingConfirm}
          onClose={(result) => { pendingConfirm.resolve(result); setPendingConfirm(null) }}
        />
      )}

      {viewScript != null && (
        <Cs2ScriptModal
          rootHandle={data.rootHandle ?? null}
          scriptId={viewScript}
          onClose={() => setViewScript(null)}
          onEdit={onNavigate ? (id) => onNavigate('cs2', id) : undefined}
        />
      )}

      {(isDirty || idGaps.length > 0) && (
        <div className="save-bar">
          <span className="save-bar-label">
            {isDirty ? 'Unsaved changes' : 'Interface needs repair'}
            {idGaps.length > 0 && (
              <span
                className="save-bar-warn"
                title={`The client walks components 0..n and dereferences every slot, so a missing id crashes it on load. Saving offers to renumber the remaining components onto 0..${list.length - 1}.`}
              >
                missing component{idGaps.length === 1 ? '' : 's'} {idGaps.join(', ')}
              </span>
            )}
            {renumbered && (
              <span
                className="save-bar-warn"
                title="Reordering siblings changes component ids, because id order IS draw order in the cache. References inside this interface were rewritten; anything outside it still points at the old ids."
              >
                component ids changed
              </span>
            )}
          </span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard} disabled={isSaving}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
