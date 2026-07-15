import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Clan variables (CONFIG file type 47) — cryogen ClanVarDefinitions, decoded
// per darkan ClanVarType.kt. The baseVar/startBit/endBit triple packs this
// var into bits of a base clan var, exactly like varbits pack into varps.
export type ClanVarDef = {
  id: number
  paramType: string
  baseVar: number
  startBit: number
  endBit: number
}

export type ClanVarData = JsonDefData<ClanVarDef>

export default makeJsonDefLoader<ClanVarDef>((id) => ({ id, paramType: '\u0000', baseVar: 0, startBit: 0, endBit: 0 }))
