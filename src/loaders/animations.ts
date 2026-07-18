import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'

// A "sequence" (darkan SeqType.kt): playback metadata for one animation —
// which frames to show in what order/timing, priority, footstep-sound
// cues, left/right-hand item overrides for held-weapon substitution, etc.
// The actual pose data lives in the referenced frame sets/bases
// (frameSetIds -> animation_frame_sets -> animation_frame_bases).
export type AnimationDef = {
  id: number
  frameDurations?: number[]
  /** (frameSetId << 16) | fileIdInFrameSet, parallel to frameDurations/frameSetIds — kept in sync by the editor, not hand-edited directly. */
  frameHashes?: number[]
  frameSetIds?: number[]
  loopDelay: number
  interLeaveOrder?: boolean[]
  priority: number
  leftHandItem: number
  rightHandItem: number
  maxLoops: number
  animatingPrecedence: number
  walkingPrecedence: number
  replayMode: number
  interfaceFrames?: number[]
  soundSettings?: (number[] | null)[]
  lights: boolean
  tweened: boolean
  vorbis: boolean
  frameSoundVolume?: number[]
  soundMaxDelay?: number[]
  soundMinDelay?: number[]
  clientScriptMap: Record<string, string | number>
}

export type AnimationData = {
  id: number
  def: AnimationDef
  // So the viewer can fetch models/animation_frame_sets/animation_frame_bases
  // directly for the "preview on model" frame stepper.
  rootHandle?: FileSystemDirectoryHandle
}

// Derived helper: file id within frameSetIds[i]'s frame set, for display/edit.
export function frameFileId(def: AnimationDef, i: number): number {
  return (def.frameHashes?.[i] ?? 0) & 0xffff
}

export function setFrameRef(def: AnimationDef, i: number, frameSetId: number, fileId: number): AnimationDef {
  const frameSetIds = (def.frameSetIds ?? []).slice()
  const frameHashes = (def.frameHashes ?? []).slice()
  frameSetIds[i] = frameSetId
  frameHashes[i] = ((frameSetId & 0xffff) << 16) | (fileId & 0xffff)
  return { ...def, frameSetIds, frameHashes }
}

function newDefaults(id: number): AnimationDef {
  return {
    id,
    loopDelay: -1,
    priority: -1,
    leftHandItem: 65535,
    rightHandItem: 65535,
    maxLoops: 1,
    animatingPrecedence: -1,
    walkingPrecedence: -1,
    replayMode: 2,
    lights: false,
    tweened: false,
    vorbis: false,
    clientScriptMap: {},
  }
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as AnimationDef
    return { id: item.id, def, rootHandle } satisfies AnimationData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as AnimationData
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
    const source = JSON.parse(await file.text()) as AnimationDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
