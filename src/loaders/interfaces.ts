import type { CacheLoader } from './types'
import { streamDirItems } from './common'
import { getEntryPath, resolveEntryHandle } from './entryOrder'

// One archive per interface (IndexType.INTERFACES), one file per component.
// Dumped by cryogen IComponentDefinitions as interfaces/<interfaceId>/<componentId>.json
// — one interface per folder, one JSON file per component (no components/
// subfolder, no screenshot). Field names match darkan-bot-refactor's
// Component.kt; JSON keys are what matter and must match cryogen's Gson
// output exactly.

export const COMPONENT_TYPES = [
  'CONTAINER',
  'TYPE_1',
  'TYPE_2',
  'FIGURE',
  'TEXT',
  'SPRITE',
  'MODEL',
  'TYPE_7',
  'TYPE_8',
  'LINE',
] as const
export type ComponentType = (typeof COMPONENT_TYPES)[number]

export const MODEL_TYPES = [
  'NONE',
  'RAW_MODEL',
  'NPC_HEAD',
  'PLAYER_HEAD',
  'ITEM',
  'PLAYER_MODEL',
  'NPC_MODEL',
  'PLAYER_HEAD_IGNOREWORN',
  'ITEM_CONTAINER_MALE',
  'ITEM_CONTAINER_FEMALE',
] as const
export type ModelType = (typeof MODEL_TYPES)[number]

/** A CS2 script hook: length-prefixed args, each tagged int (0) or string (1) on the wire. */
export type CS2Script = (number | string)[]

export type IComponentSettings = {
  interfaceId: number
  componentId: number
  fromSlot: number
  toSlot: number
  settings: number
}

export type IComponentDefinition = {
  clientParams: Record<string, number | string> | null
  type: ComponentType
  name: string | null
  contentType: number
  basePositionX: number
  basePositionY: number
  baseWidth: number
  baseHeight: number
  aspectWidthType: number
  aspectHeightType: number
  aspectXType: number
  aspectYType: number
  /** -1 for the interface's own root component. */
  parent: number
  hidden: boolean
  scrollWidth: number
  scrollHeight: number
  preventClickThrough: boolean
  spriteId: number
  angle2d: number
  modelType: ModelType
  modelId: number
  /** Upper-nibble bits of the MODEL flag byte the client never reads — round-tripped as-is, not exposed for editing. */
  modelFlagUnusedBits: number
  tiling: boolean
  fontId: number
  text: string
  color: number
  alpha: boolean
  transparency: number
  borderThickness: number
  spriteShadow: number
  lineSpacing: number
  textHorizontalAli: number
  textVerticalAli: number
  lineWidth: number
  hasOrigin: boolean
  monospaced: boolean
  filled: boolean
  keyTriggeringAction: number[][] | null
  keyTriggerParams: number[][] | null
  cycleSteps: number[] | null
  anIntArray1267: number[] | null
  opBase: string
  flipVertical: boolean
  shadow: boolean
  lineDirection: boolean
  options: string[] | null
  usesOrthogonal: boolean
  maxTextLines: number
  opCursors: number[] | null
  flipHorizontal: boolean
  resumeText: string | null
  priorityRender: boolean
  hasInteraction: boolean
  dragDeadzone: number
  dragDeadTime: number
  dragType: number
  targetVerb: string
  originX: number
  originY: number
  spritePitch: number
  spriteRoll: number
  spriteYaw: number
  spriteScale: number
  clickMask: boolean
  originZ: number
  animation: number
  targetOverCursor: number
  moveOverCursor: number
  targetParams: IComponentSettings
  aspectWidth: number
  targetLeaveCursor: number
  // CS2 script hooks (renamed from darkan Component.kt where identified).
  onLoadScript: CS2Script | null
  onMouseOver: CS2Script | null
  onMouseLeaveScript: CS2Script | null
  hookParams: CS2Script | null
  onTargetEnter: CS2Script | null
  onVarpTransmit: CS2Script | null
  mouseLeaveScript: CS2Script | null
  onStatTransmit: CS2Script | null
  onTimer: CS2Script | null
  params: CS2Script | null
  aspectHeight: number
  onTargetLeave: CS2Script | null
  popupScript: CS2Script | null
  onClick: CS2Script | null
  onClickRepeat: CS2Script | null
  onRelease: CS2Script | null
  onHold: CS2Script | null
  onDrag: CS2Script | null
  onDragComplete: CS2Script | null
  onMouseMove: CS2Script | null
  onKey: CS2Script | null
  onScrollWheel: CS2Script | null
  varps: number[] | null
  mouseLeaveArrayParams: number[] | null
  statTransmitFilter: number[] | null
  keyPressArray: number[] | null
  mouseWheelArray: number[] | null
  // Additional CS2 hooks not yet cross-referenced against darkan-bot-refactor.
  anObjectArray1413: CS2Script | null
  anObjectArray1292: CS2Script | null
  anObjectArray1415: CS2Script | null
  anObjectArray1416: CS2Script | null
  anObjectArray1383: CS2Script | null
  anObjectArray1419: CS2Script | null
  anObjectArray1361: CS2Script | null
  anObjectArray1421: CS2Script | null
  anObjectArray1346: CS2Script | null
  anObjectArray1353: CS2Script | null
  anObjectArray1271: CS2Script | null
  usesScripts: boolean
  interfaceId: number
  componentId: number
  // Internal decode state — load-bearing for a faithful re-encode, not for display.
  revision: number
  typeId: number
  hasTransform: boolean
  menuOptionsCount: number
  menuCursorMask: number
  oneCursor: number
  /** Bytes past whatever decode() consumed — round-tripped as-is; null for every normal component. */
  trailingUnreadBytes: number[] | null
}

export type InterfaceData = {
  id: number
  /** Index === componentId. May contain holes (null) if a component id was never used. */
  components: (IComponentDefinition | null)[]
  rootHandle?: FileSystemDirectoryHandle
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const interDir = await dirHandle.getDirectoryHandle(`${item.id}`)
    const entries: { id: number; def: IComponentDefinition }[] = []
    for await (const handle of interDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (isNaN(id)) continue
      const file = await handle.getFile()
      entries.push({ id, def: JSON.parse(await file.text()) as IComponentDefinition })
    }

    const maxId = entries.reduce((max, e) => Math.max(max, e.id), -1)
    const components: (IComponentDefinition | null)[] = new Array(maxId + 1).fill(null)
    for (const { id, def } of entries) components[id] = def

    return { id: item.id, components, rootHandle } satisfies InterfaceData
  },

  async saveItem(dirHandle, item, data) {
    const { components } = data as InterfaceData
    const interDir = await dirHandle.getDirectoryHandle(`${item.id}`, { create: true })

    // A component removed (or the array shrunk) needs its stale file gone —
    // cryogen's getActions() only emits a RemoveAction when a previously
    // tracked component file is missing from disk on the next pack.
    for await (const handle of interDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (isNaN(id)) continue
      if (id >= components.length || components[id] == null) {
        await interDir.removeEntry(handle.name)
      }
    }

    for (let id = 0; id < components.length; id++) {
      const comp = components[id]
      if (comp == null) continue
      const fileHandle = await interDir.getFileHandle(`${id}.json`, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(JSON.stringify(comp))
      await writable.close()
    }
  },
}

/** Loads a single interface's components by id, for cross-references (e.g. a MODEL
 *  component preview needing to resolve a target interface) outside the normal sidebar flow. */
export async function loadInterfaceById(
  rootHandle: FileSystemDirectoryHandle,
  interfaceId: number,
): Promise<InterfaceData | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('interfaces'))
    if (!dir) return null
    return (await loader.loadItem(dir, { id: interfaceId, name: `${interfaceId}` }, rootHandle)) as InterfaceData
  } catch {
    return null
  }
}

export default loader
