import type { CacheLoader } from './types'
import { loadJsonItem, streamJsonItems } from './common'

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

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item) {
    const def = (await loadJsonItem(dirHandle, item)) as CutsceneDef
    return { id: item.id, def } satisfies CutsceneData
  },
}

export default loader
