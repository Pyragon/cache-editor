import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'

// A "spot animation" (darkan SpotAnimType.kt) — what players call a "gfx"/
// graphic: a model + a sequence to play on it, spawned at a location or on
// an entity for a duration (spell splashes, teleport effects, special-attack
// visuals). Renders through the same pipeline as any other animated entity —
// no separate flipbook system, no AoE/breadth-depth fields at rev 727.
export type SpotAnimationDef = {
  id: number
  modelId: number
  /** References the `animations` (sequence) index. */
  sequenceId: number
  scaleXZ: number
  scaleY: number
  rotation: number
  ambient: number
  contrast: number
  replay: boolean
  /** Ground-contour blending (how the mesh height-blends to terrain, e.g. blood/scorch marks): 0 = none, 1/4/5 = fixed presets, 2/3 use contourModifier. */
  contourType: number
  contourModifier: number
  originalColours?: number[]
  modifiedColours?: number[]
  originalTextures?: number[]
  modifiedTextures?: number[]
}

export type SpotAnimationData = {
  id: number
  def: SpotAnimationDef
  // So the viewer can fetch the model + sequence directly for a live preview.
  rootHandle?: FileSystemDirectoryHandle
}

function newDefaults(id: number): SpotAnimationDef {
  return {
    id, modelId: 0, sequenceId: -1,
    scaleXZ: 128, scaleY: 128,
    rotation: 0, ambient: 0, contrast: 0,
    replay: false, contourType: 0, contourModifier: -1,
  }
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as SpotAnimationDef
    return { id: item.id, def, rootHandle } satisfies SpotAnimationData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as SpotAnimationData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, newDefaults(id))
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as SpotAnimationDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
