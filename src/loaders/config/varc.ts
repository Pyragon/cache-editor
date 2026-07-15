import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Client variables (VARC, CONFIG file type 19) — cryogen VarcDefinitions,
// decoded per darkan VarcType.kt. persistenceType 0 (opcode 2) means the
// value is saved across sessions; 1 (default) is session-only.
export type VarcDef = {
  id: number
  paramType: string
  persistenceType: number
}

export type VarcData = JsonDefData<VarcDef>

// The NUL character is the dump's "no type" value for paramType.
export default makeJsonDefLoader<VarcDef>((id) => ({ id, paramType: '\u0000', persistenceType: 1 }))
