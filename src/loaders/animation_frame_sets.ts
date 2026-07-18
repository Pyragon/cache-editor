import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// One keyframe: a sparse set of per-bone-group transforms (translate/
// rotate/scale/etc, per AnimationFrameBaseDef.transformationTypes) relative
// to a specific frame base's "skeleton". Ported from darkan AnimFrame.kt via
// cryogen's AnimationFrame — transformationFlags here is darkan's
// tweeningProperties; skippedReferences is darkan's oddly-named "labels",
// NOT the same concept as AnimationFrameBaseDef.labels.
//
// One deliberate deviation from the raw client format: for
// transformationTypes 2 and 9 (rotation-ish), the client applies a
// `<<2 & 0x3fff` promotion to the raw smart-read delta before it's usable —
// but that mask isn't reliably invertible after the fact (readSmart's full
// range is -16384..16383, well past what survives the mask), so this dump
// stores the UNSHIFTED raw delta instead, letting the repack stay
// byte-identical. Anything reading transformationX/Y/Z for playback needs
// to apply that shift itself for type 2/9 entries.
export type AnimationFrameDef = {
  /** Raw header byte, offset 0 — unidentified purpose in both cryogen and darkan, preserved verbatim. */
  unknownByte0: number
  /** Total transform slots scanned against the frame base — NOT the same as how many were actually present. */
  count: number
  frameBaseId: number
  transformationCount: number
  transformationIndices: number[]
  transformationX: number[]
  transformationY: number[]
  transformationZ: number[]
  /** 2-bit tweening flag per present transform. */
  transformationFlags: number[]
  /** Per-present-transform "skip to this origin-marker index" chain, -1 = none. */
  skippedReferences: number[]
  modifiesAlpha: boolean
  modifiesColor: boolean
  aBool988: boolean
  /** Set only when the frame data doesn't parse against its own frame base
   *  (a real archive, frame set 162, references an orphaned/hollowed-out
   *  frame base) — present, none of the other fields are meaningful, and
   *  saving round-trips this verbatim rather than attempting to re-derive it. */
  rawFallbackBytes?: number[]
}

export type AnimationFrameSetData = {
  id: number
  /** Keyed by raw file id within the archive (sparse, not necessarily 0..n contiguous). */
  frames: Map<number, AnimationFrameDef>
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const setDir = await dirHandle.getDirectoryHandle(String(item.id))
    const frames = new Map<number, AnimationFrameDef>()
    for await (const handle of setDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const fileId = parseInt(handle.name.slice(0, -5), 10)
      if (isNaN(fileId)) continue
      const file = await handle.getFile()
      frames.set(fileId, JSON.parse(await file.text()) as AnimationFrameDef)
    }
    return { id: item.id, frames } satisfies AnimationFrameSetData
  },

  async saveItem(dirHandle, item, data) {
    const { frames } = data as AnimationFrameSetData
    const setDir = await dirHandle.getDirectoryHandle(String(item.id), { create: true })

    for await (const handle of setDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const fileId = parseInt(handle.name.slice(0, -5), 10)
      if (isNaN(fileId)) continue
      if (!frames.has(fileId)) await setDir.removeEntry(handle.name)
    }

    for (const [fileId, frame] of frames) {
      const fileHandle = await setDir.getFileHandle(`${fileId}.json`, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(JSON.stringify(frame))
      await writable.close()
    }
  },
}

export default loader
