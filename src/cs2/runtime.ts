// The mutable interface scene CS2 ops act on: cloned static components plus
// the dynamic children cc_create makes, addressed exactly like the client —
// a 32-bit hash (interfaceId << 16 | componentId) for statics, and
// (parentHash, childIndex) for dynamics.
//
// The gameframe preview builds one of these per paint from its pristine
// scene, runs the onLoad hooks through the interpreter, then lays out and
// paints the mutated components.

import type { IComponentDefinition } from '../loaders/interfaces'

export type RuntimeInterface = {
  id: number
  components: (IComponentDefinition | null)[]
  /** next free componentId for dynamic children (kept clear of statics) */
  nextDynamicId: number
  /** (parentComponentId << 16 | childIndex) → dynamic componentId, the
   *  client's keyed replace semantics for cc_create */
  dynamicByKey: Map<number, number>
}

export type Cs2Warning = { op: string; count: number; example: string }

/** A blank component in the image of the client's cc_create defaults. */
function blankComponent(interfaceId: number, componentId: number, parentHash: number, typeId: number): IComponentDefinition {
  const type = (['CONTAINER', 'TYPE_1', 'TYPE_2', 'FIGURE', 'TEXT', 'SPRITE', 'MODEL', 'TYPE_7', 'TYPE_8', 'LINE'] as const)[typeId] ?? 'CONTAINER'
  return {
    clientParams: null,
    type,
    name: null,
    contentType: 0,
    basePositionX: 0,
    basePositionY: 0,
    baseWidth: 0,
    baseHeight: 0,
    aspectWidthType: 0,
    aspectHeightType: 0,
    aspectXType: 0,
    aspectYType: 0,
    parent: parentHash,
    hidden: false,
    scrollWidth: 0,
    scrollHeight: 0,
    preventClickThrough: false,
    spriteId: -1,
    angle2d: 0,
    modelType: 'NONE',
    modelId: -1,
    modelFlagUnusedBits: 0,
    tiling: false,
    fontId: -1,
    text: '',
    color: 0,
    alpha: false,
    transparency: 0,
    borderThickness: 0,
    spriteShadow: 0,
    lineSpacing: 0,
    textHorizontalAli: 0,
    textVerticalAli: 0,
    lineWidth: 1,
    hasOrigin: false,
    monospaced: false,
    filled: false,
    keyTriggeringAction: null,
    keyTriggerParams: null,
    cycleSteps: null,
    anIntArray1267: null,
    opBase: '',
    flipVertical: false,
    shadow: false,
    lineDirection: false,
    options: null,
    usesOrthogonal: false,
    maxTextLines: 0,
    opCursors: null,
    flipHorizontal: false,
    resumeText: null,
    priorityRender: false,
    hasInteraction: false,
    dragDeadzone: 0,
    dragDeadTime: 0,
    dragType: 0,
    targetVerb: '',
    originX: 0,
    originY: 0,
    spritePitch: 0,
    spriteRoll: 0,
    spriteYaw: 0,
    spriteScale: 100,
    clickMask: false,
    originZ: 0,
    animation: -1,
    targetOverCursor: -1,
    moveOverCursor: -1,
    targetParams: { interfaceId: -1, componentId: 0, fromSlot: 0, toSlot: 0, settings: 0 },
    aspectWidth: 0,
    targetLeaveCursor: -1,
    onLoadScript: null,
    onMouseOver: null,
    onMouseLeaveScript: null,
    hookParams: null,
    onTargetEnter: null,
    onVarpTransmit: null,
    mouseLeaveScript: null,
    onStatTransmit: null,
    onTimer: null,
    params: null,
    aspectHeight: 0,
    onTargetLeave: null,
    popupScript: null,
    onClick: null,
    onClickRepeat: null,
    onRelease: null,
    onHold: null,
    onDrag: null,
    onDragComplete: null,
    onMouseMove: null,
    onKey: null,
    onScrollWheel: null,
    varps: null,
    mouseLeaveArrayParams: null,
    statTransmitFilter: null,
    keyPressArray: null,
    mouseWheelArray: null,
    anObjectArray1413: null,
    anObjectArray1292: null,
    anObjectArray1415: null,
    anObjectArray1416: null,
    anObjectArray1383: null,
    anObjectArray1419: null,
    anObjectArray1361: null,
    anObjectArray1421: null,
    anObjectArray1346: null,
    anObjectArray1353: null,
    anObjectArray1271: null,
    usesScripts: false,
    interfaceId,
    componentId,
    revision: -1,
    typeId,
    hasTransform: false,
    menuOptionsCount: 0,
    menuCursorMask: 0,
    oneCursor: 0,
    trailingUnreadBytes: null,
  }
}

/**
 * The runtime scene: interfaces by id (components CLONED so hook runs never
 * touch the pristine defs), plus the client's two active-component slots
 * (cc_* ops and their @1 variants).
 */
export class Cs2InterfaceScene {
  interfaces = new Map<number, RuntimeInterface>()
  /** the active component per bank (cc_find/cc_create set it; -1 = none):
   *  bank 0 = plain ops, bank 1 = the @1 variants */
  active: (IComponentDefinition | null)[] = [null, null]
  /** client-side sub-interfaces (if_opensubclient): parent hash -> interface */
  subs = new Map<number, number>()
  warnings = new Map<string, Cs2Warning>()

  addInterface(id: number, components: (IComponentDefinition | null)[]): void {
    if (this.interfaces.has(id)) return
    const cloned = components.map((c) => (c ? { ...c } : null))
    this.interfaces.set(id, {
      id,
      components: cloned,
      nextDynamicId: Math.max(cloned.length, 1),
      dynamicByKey: new Map(),
    })
  }

  /** Resolve a component hash to its (cloned) definition. */
  get(hash: number): IComponentDefinition | null {
    if (hash === -1 || hash === 0xffffffff) return null
    const iface = this.interfaces.get(hash >>> 16)
    return iface?.components[hash & 0xffff] ?? null
  }

  /** cc_find: point a bank at (parentHash, childIndex)'s dynamic component.
   *  Returns true when it exists. */
  find(bank: number, parentHash: number, childIndex: number): boolean {
    const iface = this.interfaces.get(parentHash >>> 16)
    if (!iface) { this.active[bank] = null; return false }
    const dynId = iface.dynamicByKey.get(((parentHash & 0xffff) << 16) | (childIndex & 0xffff))
    this.active[bank] = dynId !== undefined ? iface.components[dynId] ?? null : null
    return this.active[bank] != null
  }

  /** cc_create: make (or replace) the dynamic child at (parentHash,
   *  childIndex) and make it the bank's active component. */
  create(bank: number, parentHash: number, typeId: number, childIndex: number): boolean {
    const ifaceId = parentHash >>> 16
    const iface = this.interfaces.get(ifaceId)
    if (!iface) { this.active[bank] = null; return false }
    const key = ((parentHash & 0xffff) << 16) | (childIndex & 0xffff)
    let compId = iface.dynamicByKey.get(key)
    if (compId === undefined) {
      compId = iface.nextDynamicId++
      if (compId > 0xffff) { this.active[bank] = null; return false }
      iface.dynamicByKey.set(key, compId)
    }
    const comp = blankComponent(ifaceId, compId, parentHash, typeId)
    iface.components[compId] = comp
    this.active[bank] = comp
    return true
  }

  /** cc_delete / cc_deleteall */
  deleteAll(parentHash: number): void {
    const iface = this.interfaces.get(parentHash >>> 16)
    if (!iface) return
    const parentKeyBase = (parentHash & 0xffff) << 16
    for (const [key, compId] of [...iface.dynamicByKey]) {
      if ((key & 0xffff0000) === parentKeyBase) {
        iface.components[compId] = null
        iface.dynamicByKey.delete(key)
      }
    }
  }

  warn(op: string, example: string): void {
    const w = this.warnings.get(op)
    if (w) w.count++
    else this.warnings.set(op, { op, count: 1, example })
  }
}
