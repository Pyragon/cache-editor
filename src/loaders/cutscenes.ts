import type { CacheLoader } from './types'
import { deleteJsonItem, loadJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'

// Field names follow darkan-bot-refactor's config/cutscene/ package (the
// authoritative decoder); the dump comes from cryogen CutsceneDefinitions,
// whose fields were renamed to match.

export type CutsceneAreaDef = {
  plane: number
  regionX: number
  regionY: number
  width: number
  length: number
  cutscenePlane: number
  chunkBaseX: number
  chunkBaseY: number
  rotation: number
}

export type CutsceneCameraMovementDef = {
  xPositions: number[]
  yPositions: number[]
  zPositions: number[]
  timestamps: number[]
  targetXPositions: number[]
  targetYPositions: number[]
  targetZPositions: number[]
}

export type CutsceneEntityDef = {
  index: number
  /** NPC id, or -1 when the entity is the player. */
  id: number
  /** Dev label baked into the entry (darkan reads and discards it). */
  name: string
}

export type CutsceneObjectDef = {
  locId: number
  locShape: number
}

export type CutsceneEntityMovementDef = {
  /** 0 = half walk, 2 = run, anything else walks. */
  movementTypes: number[]
  /** Tile coords packed y + (x << 16). */
  bitpackedPositions: number[]
}

export type CutsceneActionDef = {
  typeId: number
  type: string
  /** Start time: the client performs the action once this many cycles (20ms
   *  each) have passed since the cutscene loaded — a timestamp, not a duration
   *  (darkan Client.kt's scheduler), despite the darkan field name. */
  lengthInCycles: number
  fields?: Record<string, number | string>
}

export type CutsceneDef = {
  id: number
  viewportHeight: number
  viewportWidth: number
  areas: CutsceneAreaDef[]
  camMovements: CutsceneCameraMovementDef[]
  entities: CutsceneEntityDef[]
  objects: CutsceneObjectDef[]
  movements: CutsceneEntityMovementDef[]
  actions: CutsceneActionDef[]
}

export type CutsceneData = {
  id: number
  def: CutsceneDef
}

/** Action type ids, from cryogen's dumper / darkan's `listCutsceneAction`
 *  switch. The editor needs the id as well as the name, because the dump
 *  carries both and a hand-authored action has to write a valid pair. */
export const CUTSCENE_ACTION_TYPES: { id: number; type: string }[] = [
  { id: 0, type: 'DESTROY_OBJECT' },
  { id: 1, type: 'RESET_CUTSCENE_ENTITY' },
  { id: 2, type: 'APPLY_HITMARK' },
  { id: 4, type: 'MOVEMENT' },
  { id: 5, type: 'PLAY_JINGLE' },
  { id: 6, type: 'PLAY_VORBIS' },
  { id: 8, type: 'UNCENTERED_CAMERA_MOVEMENT' },
  { id: 9, type: 'BASIC_MOVEMENT' },
  { id: 10, type: 'SET_VARIABLE' },
  { id: 11, type: 'DIRECT_CAMERA_MOVEMENT' },
  { id: 12, type: 'SET_HINT_DETAILS' },
  { id: 13, type: 'ANIMATE_OBJECT' },
  { id: 14, type: 'POSITIONED_GFX' },
  { id: 15, type: 'PROJECTILE_HOMING' },
  { id: 16, type: 'FINISHED' },
  { id: 17, type: 'REPLACE_OBJECT' },
  { id: 18, type: 'ANIMATE_MOVEMENT' },
  { id: 19, type: 'ENTITY_GFX' },
  { id: 20, type: 'FADE_SCREEN' },
  { id: 22, type: 'TILE_MESSAGE' },
  { id: 23, type: 'PLAY_SONG' },
  { id: 24, type: 'EXECUTE_SCRIPT' },
  { id: 25, type: 'SET_BIT_VARIABLE' },
  { id: 26, type: 'PLAY_SYNTH' },
]

const ACTION_ID_BY_TYPE = new Map(CUTSCENE_ACTION_TYPES.map((a) => [a.type, a.id]))

export function actionTypeId(type: string): number {
  return ACTION_ID_BY_TYPE.get(type) ?? -1
}

/** A blank cutscene: one 8×8-chunk area at the given region, the fade-in every
 *  shipped cutscene opens with, and the FINISHED the client needs to hand
 *  control back. Nothing else — the editor fills it in. */
export function newCutsceneDef(id: number, regionX = 3200, regionY = 3200): CutsceneDef {
  return {
    id,
    // the dumped names are swapped — aspect = viewportHeight/viewportWidth,
    // and every shipped 4:3 cutscene stores 640/480 exactly like this
    viewportHeight: 640,
    viewportWidth: 480,
    areas: [0, 1, 2, 3].map((plane) => ({
      plane,
      regionX,
      regionY,
      width: 8,
      length: 8,
      cutscenePlane: plane,
      chunkBaseX: 0,
      chunkBaseY: 0,
      rotation: 0,
    })),
    camMovements: [],
    entities: [],
    objects: [],
    movements: [],
    actions: [
      // black immediately, then fade up over a second — the opening of every
      // shipped cutscene
      { typeId: 20, type: 'FADE_SCREEN', lengthInCycles: 0, fields: { fadeDurationCycles: 1, fadeScreenColor: -16777216 } },
      { typeId: 20, type: 'FADE_SCREEN', lengthInCycles: 1, fields: { fadeDurationCycles: 50, fadeScreenColor: 0 } },
      { typeId: 16, type: 'FINISHED', lengthInCycles: 200, fields: {} },
    ],
  }
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item) {
    const def = (await loadJsonItem(dirHandle, item)) as CutsceneDef
    return { id: item.id, def } satisfies CutsceneData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as CutsceneData
    // Actions must be in ascending start order: the client walks them with a
    // single cursor and stops at the first one still in the future
    // (Client.kt's `if (action.lengthInCycles > cyclesPassed) break`), so an
    // out-of-order action would never fire.
    const ordered = {
      ...def,
      id: item.id,
      actions: [...def.actions].sort((a, b) => a.lengthInCycles - b.lengthInCycles),
    }
    await writeJsonItem(dirHandle, item.id, ordered)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, newCutsceneDef(id))
    return { id, name: String(id) }
  },

  async cloneItem(dirHandle, item) {
    const source = (await loadJsonItem(dirHandle, item)) as CutsceneDef
    const id = await nextFreeJsonId(dirHandle)
    // Deep-copied, or the clone would share its arrays with the original and
    // editing one would silently edit the other.
    await writeJsonItem(dirHandle, id, { ...structuredClone(source), id })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },
}

export default loader
