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

/** The cutscene map is 104×104 tiles — 13 chunks square. Cutscene 0 proves it
 *  exactly: a full 8×8 block at chunk 0,0 plus a 5×5 one at chunk 8,8. */
export const CUTSCENE_CHUNKS = 13

/**
 * One source region placed into the cutscene's own map, before it's expanded
 * into the four per-plane rows the format actually stores.
 *
 * `regionX`/`regionY` are REGION coordinates (the maps entry's x,y — region id
 * is `x << 8 | y`); the stored `regionX`/`regionY` are those times 64, because
 * the format wants the region's base TILE. `width`/`length` are in chunks, so
 * 8×8 is a whole region.
 */
export type CutsceneAreaBlock = {
  regionX: number
  regionY: number
  /** Destination in the cutscene's map, in chunks. */
  chunkX: number
  chunkY: number
  width: number
  length: number
  rotation: number
  /** Which planes this block copies. Every shipped block is all four. */
  planes: number[]
}

const TILES_PER_REGION = 64
export const ALL_PLANES = [0, 1, 2, 3]

/** Expand placed region blocks into the per-plane rows the format stores — one
 *  per plane, each keeping its own plane in the destination, which is what every
 *  shipped cutscene does (52 of 52 blocks, all four planes, `cutscenePlane`
 *  always equal to `plane`). */
export function areasForBlocks(blocks: CutsceneAreaBlock[]): CutsceneAreaDef[] {
  const out: CutsceneAreaDef[] = []
  for (const b of blocks) {
    for (const plane of b.planes) {
      out.push({
        plane,
        regionX: b.regionX * TILES_PER_REGION,
        regionY: b.regionY * TILES_PER_REGION,
        width: b.width,
        length: b.length,
        cutscenePlane: plane,
        chunkBaseX: b.chunkX,
        chunkBaseY: b.chunkY,
        rotation: b.rotation,
      })
    }
  }
  return out
}

/** How a block reads in a tooltip: both the region coord and the id, because
 *  the maps entry names regions by id and everything else by coordinate. */
export function blockLabel(b: CutsceneAreaBlock): string {
  return `region ${b.regionX},${b.regionY} (id ${(b.regionX << 8) | b.regionY})`
}

/** A fresh block placed beside the last one, wrapping to the next row when it
 *  would run off the map — which is how the shipped cutscenes tile regions. */
export function nextBlock(blocks: CutsceneAreaBlock[]): CutsceneAreaBlock {
  const last = blocks[blocks.length - 1]
  if (!last) {
    return { regionX: 50, regionY: 50, chunkX: 0, chunkY: 0, width: 8, length: 8, rotation: 0, planes: [...ALL_PLANES] }
  }
  const nextX = last.chunkX + last.width
  const fits = nextX + last.width <= CUTSCENE_CHUNKS
  return {
    ...last,
    planes: [...last.planes],
    regionX: fits ? last.regionX + 1 : last.regionX,
    regionY: fits ? last.regionY : last.regionY + 1,
    chunkX: fits ? nextX : 0,
    chunkY: fits ? last.chunkY : last.chunkY + last.length,
  }
}

/**
 * The inverse: recover placed blocks from stored rows by grouping the rows that
 * differ only by plane.
 *
 * Returns null when the rows don't fit the model — a source tile that isn't a
 * whole region, or a row whose destination plane differs from its source plane.
 * Neither occurs anywhere in the cache (208 of 208 rows check out), but a
 * hand-edited cutscene could produce one, and silently rewriting it into
 * something the grid CAN express would quietly change the map. The editor keeps
 * the raw table for those.
 */
export function blocksFromAreas(areas: CutsceneAreaDef[]): CutsceneAreaBlock[] | null {
  const byKey = new Map<string, CutsceneAreaBlock>()
  for (const a of areas) {
    if (a.regionX % TILES_PER_REGION !== 0 || a.regionY % TILES_PER_REGION !== 0) return null
    if (a.plane !== a.cutscenePlane) return null
    const key = [a.regionX, a.regionY, a.width, a.length, a.chunkBaseX, a.chunkBaseY, a.rotation].join('|')
    const existing = byKey.get(key)
    if (existing) { if (!existing.planes.includes(a.plane)) existing.planes.push(a.plane); continue }
    byKey.set(key, {
      regionX: a.regionX / TILES_PER_REGION,
      regionY: a.regionY / TILES_PER_REGION,
      chunkX: a.chunkBaseX,
      chunkY: a.chunkBaseY,
      width: a.width,
      length: a.length,
      rotation: a.rotation,
      planes: [a.plane],
    })
  }
  for (const b of byKey.values()) b.planes.sort((x, y) => x - y)
  return [...byKey.values()]
}

/** A blank cutscene: the given areas (or one full region at 3200,3200 per
 *  plane), the fade-in every shipped cutscene opens with, and the FINISHED the
 *  client needs to hand control back. Nothing else — the editor fills it in. */
export function newCutsceneDef(id: number, areas?: CutsceneAreaDef[]): CutsceneDef {
  const regionX = 3200, regionY = 3200
  return {
    id,
    // the dumped names are swapped — aspect = viewportHeight/viewportWidth,
    // and every shipped 4:3 cutscene stores 640/480 exactly like this
    viewportHeight: 640,
    viewportWidth: 480,
    areas: areas ?? [0, 1, 2, 3].map((plane) => ({
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

  // `createItemWith` isn't part of CacheLoader — App reaches for it by name for
  // the cutscenes entry, because Add asks which regions to build from first.

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

/** Create a cutscene with a chosen map, for App's "Add" flow — the same write
 *  `createItem` does, minus the guess about which region you meant. */
export async function createCutsceneWithAreas(
  dirHandle: FileSystemDirectoryHandle,
  areas: CutsceneAreaDef[],
): Promise<{ id: number; name: string }> {
  const id = await nextFreeJsonId(dirHandle)
  await writeJsonItem(dirHandle, id, newCutsceneDef(id, areas))
  return { id, name: String(id) }
}

export default loader
