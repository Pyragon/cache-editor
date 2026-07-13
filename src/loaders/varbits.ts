import { makeJsonDefLoader } from './common'
import type { JsonDefData } from './common'

export type VarbitDef = {
  id: number
  baseVar: number
  startBit: number
  endBit: number
}

export type VarbitData = JsonDefData<VarbitDef>

export default makeJsonDefLoader<VarbitDef>((id) => ({ id, baseVar: 0, startBit: 0, endBit: 0 }))
