import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Note: the dump has no id field inside inventory JSONs — just the length
// and (optionally) parallel default-stock arrays.
export type InventoryDef = {
  length: number
  ids?: number[]
  amounts?: number[]
}

export type InventoryData = JsonDefData<InventoryDef>

export default makeJsonDefLoader<InventoryDef>(() => ({ length: 0 }))
