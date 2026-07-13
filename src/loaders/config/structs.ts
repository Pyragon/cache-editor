import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

export type StructDef = {
  id: number
  values: Record<string, number | string>
}

export type StructData = JsonDefData<StructDef>

export default makeJsonDefLoader<StructDef>((id) => ({ id, values: {} }))
