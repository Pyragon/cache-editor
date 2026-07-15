import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'
import type { ClanVarDef } from './clan_var'

// Clan settings variables (CONFIG file type 54) — same shape as clan vars
// (darkan ClanVarSettingsType.kt); only the cache opcode for the bit-packing
// triple differs (2 instead of 3).
export type ClanVarSettingsData = JsonDefData<ClanVarDef>

export default makeJsonDefLoader<ClanVarDef>((id) => ({ id, paramType: '\u0000', baseVar: 0, startBit: 0, endBit: 0 }))
