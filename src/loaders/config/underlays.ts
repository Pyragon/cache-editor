import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Ground tile base colours (CONFIG file type 1) — cryogen UnderlayDefinitions,
// decoded per darkan FluType.kt. Every walkable tile references one of these
// (1-based id in the "m" map archive, 0 = none).
export type UnderlayDef = {
  id: number
  /** Raw 24-bit RGB, as stored in the cache. */
  rgb: number
  texture: number
  scale: number
  shadowed: boolean
  occlude: boolean
}

export type UnderlayData = JsonDefData<UnderlayDef>

export default makeJsonDefLoader<UnderlayDef>((id) => ({
  id, rgb: 0x7f7f7f, texture: -1, scale: 512, shadowed: true, occlude: true,
}))
