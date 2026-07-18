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

export default makeJsonDefLoader<AnimationFrameBaseDef>((id) => ({
  id, count: 0, transformationTypes: [], submeshes: [], shadowed: [], labels: [],
}))
