import { makeJsonDefLoader } from './common'
import type { JsonDefData } from './common'

// A "skeleton": the bone-group structure animation frames transform
// against. Ported from darkan AnimBase.kt via cryogen's AnimationFrameBase —
// labels[i] is the set of vertex-group ids transformationTypes[i] applies
// to (a model's own mesh carries a per-vertex group id — see
// ModelData.vertexSkins — which frame data indexes into via these labels).
export type AnimationFrameBaseDef = {
  id: number
  count: number
  transformationTypes: number[]
  /** Bitmask of submesh(es) this transform applies to — gates equipment-piece-specific animation. */
  submeshes: number[]
  shadowed: boolean[]
  labels: number[][]
  /** A couple of real archives reference orphaned data past what count implies — preserved verbatim, not editable. */
  trailingUnreadBytes?: number[]
}

export type AnimationFrameBaseData = JsonDefData<AnimationFrameBaseDef>

/** Slot type names, as implemented in `skeletalAnimation.ts`. Shared by the
 *  frame-base and frame-set editors. Type 4 appears in exactly 3 slots across
 *  the whole cache and is decoded by neither cryogen nor darkan. */
export const TRANSFORM_TYPE_NAMES: Record<number, string> = {
  0: 'origin marker',
  1: 'translate',
  2: 'rotate',
  3: 'scale',
  4: 'unknown',
  5: 'alpha',
  7: 'colour',
  8: 'billboard offset',
  9: 'billboard roll',
  10: 'billboard scale',
}

/** One line per slot type explaining what it does to the model — the frame
 *  editor shows this next to the slot you're editing, since the raw X/Y/Z
 *  numbers mean something completely different per type. */
export const TRANSFORM_TYPE_HELP: Record<number, string> = {
  0: 'Moves the PIVOT only, never geometry: sets it to the centre of these groups’ current positions, offset by the delta. Every later rotate/scale in this frame turns about it.',
  1: 'Shifts these vertex groups by the delta, in model units.',
  2: 'Rotates these vertex groups about the current pivot. Angles are 14-bit — 16384 is a full turn — and the stored delta is pre-shift (the client promotes it by <<2).',
  3: 'Scales these vertex groups about the current pivot, per axis, by delta/128. 128 is unchanged.',
  4: 'Unrecognised slot type — not decoded by cryogen, darkan or this editor. It is preserved on save but does nothing in the preview.',
  5: 'Fades the FACE groups with these labels: alpha += Δx × 8, clamped 0–255, where 255 is fully invisible.',
  7: 'Recolours the FACE groups with these labels in HSL16: hue += Δx (wraps at 64), saturation += Δy (0–7), lightness += Δz (0–127).',
  8: 'Offsets the billboard sprites in these groups in view space. A label here is a billboard GROUP id (the attachment’s depth byte), not a vertex group.',
  9: 'Rolls the billboard sprites in these groups. 16384 is a full turn; the stored delta is pre-shift like type 2.',
  10: 'Scales the billboard sprites in these groups by Δx/128 wide and Δy/128 tall, accumulating across entries.',
}

export default makeJsonDefLoader<AnimationFrameBaseDef>((id) => ({
  id, count: 0, transformationTypes: [], submeshes: [], shadowed: [], labels: [],
}))
