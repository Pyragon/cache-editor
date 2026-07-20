import type { CacheLoader } from '../types'
import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// BAS ("base animation set" / render animations, CONFIG file type 32).
// Referenced by NPC/item configs to pick the sequences an entity plays for
// each movement state. Fields per darkan-bot-refactor BasType.kt; JSON dumped
// by cryogen BASDefinitions.
//
// Sequence ids are top-level `animations` entries; -1 = unset. The dirN
// sequences replace the main one when the entity moves at an angle to its
// facing: dir1 ≈ 90°, dir2 ≈ 270°, dir3 = backwards (PathingEntity.kt).
export type BasDef = {
  id?: number
  standAnimation: number
  walkAnimation: number
  runningAnimation: number
  teleportingAnimation: number
  standTurnCcwSequence: number
  standTurnCwSequence: number
  walkDir1: number
  walkDir2: number
  walkDir3: number
  walkTurnCcwSequence: number
  walkTurnCwSequence: number
  runDir1: number
  runDir2: number
  runDir3: number
  runTurnCcwSequence: number
  runTurnCwSequence: number
  teleDir1: number
  teleDir2: number
  teleDir3: number
  teleTurnCcwSequence: number
  teleTurnCwSequence: number
  /** Opcode 52, paired with chances (out of the pair sum). */
  randomStandSequences?: number[]
  randomStandSequenceChances?: number[]
  /** Opcode 26 — stored /4 in the cache, so keep these multiples of 4. */
  modelWidth: number
  modelLength: number
  /** Opcode 27 — per obj slot [tx, ty, tz, rx, ry, rz]; null = slot unset. */
  objVerticeTransformations?: (number[] | null)[]
  /** Opcode 28 — -1 entries mean hidden. */
  objVisibility?: number[]
  yawAcceleration: number
  yawMaxVelocity: number
  rollAcceleration: number
  rollMaxVelocity: number
  rollTargetAngle: number
  pitchAcceleration: number
  pitchMaxVelocity: number
  pitchTargetAngle: number
  unusedOpcode37: number
  /** Opcodes 43/44 — read-and-discarded by clients; absent = not written. */
  unusedOpcode43?: number
  unusedOpcode44?: number
  iconHeightOverride: number
  rendersShadow: boolean
  /** Opcode 54 — stored >>6 in the cache, so keep these multiples of 64. */
  hillRotateX: number
  hillRotateZ: number
  /** Opcode 55 — per obj slot; null = slot unset. */
  turnAngleAdjustment?: (number | null)[]
  /** Opcode 56 — per obj slot [x, y, z]; null = slot unset. */
  projectionOffset?: (number[] | null)[]
}

export const NEW_BAS_DEFAULTS: Omit<BasDef, 'id'> = {
  standAnimation: -1,
  walkAnimation: -1,
  runningAnimation: -1,
  teleportingAnimation: -1,
  standTurnCcwSequence: -1,
  standTurnCwSequence: -1,
  walkDir1: -1,
  walkDir2: -1,
  walkDir3: -1,
  walkTurnCcwSequence: -1,
  walkTurnCwSequence: -1,
  runDir1: -1,
  runDir2: -1,
  runDir3: -1,
  runTurnCcwSequence: -1,
  runTurnCwSequence: -1,
  teleDir1: -1,
  teleDir2: -1,
  teleDir3: -1,
  teleTurnCcwSequence: -1,
  teleTurnCwSequence: -1,
  modelWidth: 0,
  modelLength: 0,
  yawAcceleration: 0,
  yawMaxVelocity: 0,
  rollAcceleration: 0,
  rollMaxVelocity: 0,
  rollTargetAngle: 0,
  pitchAcceleration: 0,
  pitchMaxVelocity: 0,
  pitchTargetAngle: 0,
  unusedOpcode37: -1,
  iconHeightOverride: -1,
  rendersShadow: true,
  hillRotateX: 0,
  hillRotateZ: 0,
}

export type BasData = JsonDefData<BasDef>

/** Customizable obj slots per entity — 15 at rev 727 (defaults/equipment). */
export const OBJ_SLOT_COUNT = 15

const loader: CacheLoader = makeJsonDefLoader<BasDef>((id) => ({ id, ...NEW_BAS_DEFAULTS }))

export default loader
