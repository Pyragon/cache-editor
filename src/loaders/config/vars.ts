import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

export type VarDef = {
  id: number
  paramType: string
  // Opcode 5 — named clientCode per darkan's VarpType (cryogen previously
  // misnamed it defaultValue).
  clientCode: number
}

export type VarData = JsonDefData<VarDef>

// The NUL character is the dump's "no type" value for paramType.
export default makeJsonDefLoader<VarDef>((id) => ({ id, paramType: '\u0000', clientCode: 0 }))
