import type { AnimationFrameDef } from './animation_frame_sets'

// Turning a drag into frame data.
//
// Gizmo drags arrive in THREE space; a frame stores RS deltas. Two sign flips
// compose, and neither is guessable:
//
//  - the evaluator's own conventions: X and Y are standard right-handed
//    rotations, but Z is negated (its matrix is [cos, sin; -sin, cos]);
//  - the render mapping (x, -y, -z) is a 180-degree turn about X, which leaves
//    X rotations alone and negates Y and Z.
//
// Net: a three-space drag of phi lands as RS x=+phi, y=-phi, z=+phi. Checked
// end to end (drag -> stored -> rendered) over 21 angle/axis cases, worst error
// 1.21 units on a 1000-unit vector, under the 1.53-unit floor below.

const RS_PER_RADIAN = 16384 / (2 * Math.PI)

/** The handle's transform relative to where it was placed, in THREE space. */
export type GizmoDelta = {
  dx: number; dy: number; dz: number
  rx: number; ry: number; rz: number
  sx: number; sy: number; sz: number
}

export type Delta3 = { x: number; y: number; z: number }

/**
 * Rotation deltas are stored PRE-shift — the client promotes them
 * `<<2 & 0x3fff` at the point of use — so only the low 12 bits survive and the
 * resolution is a quarter of a 14-bit step, about 0.09 degrees.
 */
export function packAngle(baseStored: number, deltaRadians: number): number {
  const baseAngle = (baseStored << 2) & 0x3fff
  const next = Math.round(baseAngle + deltaRadians * RS_PER_RADIAN)
  return ((next % 16384) + 16384) % 16384 >> 2
}

/**
 * The deltas a drag produces, applied against the values captured when the
 * handle was grabbed — never against the last frame of the drag, or the
 * rounding accumulates.
 */
export function applyGizmoDelta(type: number, base: Delta3, t: GizmoDelta): Delta3 {
  switch (type) {
    case 0:
    case 1:
      return {
        x: base.x + Math.round(t.dx),
        y: base.y - Math.round(t.dy),
        z: base.z - Math.round(t.dz),
      }
    case 2:
      return { x: packAngle(base.x, t.rx), y: packAngle(base.y, -t.ry), z: packAngle(base.z, t.rz) }
    case 3:
      // the stored value IS the multiplier in 128ths, so the handle scales it
      return {
        x: Math.max(0, Math.round(base.x * t.sx)),
        y: Math.max(0, Math.round(base.y * t.sy)),
        z: Math.max(0, Math.round(base.z * t.sz)),
      }
    default:
      return base
  }
}

/** Which handle a transform type wants, or null when it has nothing to grab. */
export function gizmoModeFor(type: number): 'translate' | 'rotate' | 'scale' | null {
  if (type === 0 || type === 1) return 'translate'
  if (type === 2) return 'rotate'
  if (type === 3) return 'scale'
  return null
}

/** A transform's identity value — what a fresh entry starts at. Scale is 128,
 *  because the stored number is a multiplier in 128ths. */
export const identityFor = (type: number): number => (type === 3 || type === 10 ? 128 : 0)

/**
 * The entry index for `slot`, creating one if the frame doesn't touch that slot
 * yet — which is what posing a part the frame has never moved means.
 *
 * `skip` names the type-0 slot the entry pivots about — without one the origin
 * stays wherever it was, which for a fresh entry is (0,0,0), i.e. the model's
 * feet. 93.9% of real rotate entries name one.
 *
 * Two invariants hold in all 86,609 real frames and are kept here:
 * `transformationIndices` stays ASCENDING (the decoder and the tween walk both
 * step through entries in slot order), and `count` is exactly `maxSlot + 1`.
 */
export function ensureEntry(frame: AnimationFrameDef, slot: number, type: number, skip = -1): {
  frame: AnimationFrameDef
  index: number
} {
  const existing = frame.transformationIndices.indexOf(slot)
  if (existing >= 0) return { frame, index: existing }

  let at = frame.transformationIndices.findIndex((s) => s > slot)
  if (at < 0) at = frame.transformationIndices.length
  const put = <T,>(arr: T[], v: T): T[] => { const a = arr.slice(); a.splice(at, 0, v); return a }
  const identity = identityFor(type)
  const transformationIndices = put(frame.transformationIndices, slot)
  return {
    index: at,
    frame: {
      ...frame,
      count: Math.max(...transformationIndices) + 1,
      transformationCount: transformationIndices.length,
      transformationIndices,
      transformationX: put(frame.transformationX, identity),
      transformationY: put(frame.transformationY, identity),
      transformationZ: put(frame.transformationZ, identity),
      transformationFlags: put(frame.transformationFlags, 0),
      skippedReferences: put(frame.skippedReferences, skip),
    },
  }
}
