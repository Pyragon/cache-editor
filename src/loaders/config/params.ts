import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

export type ParamDef = {
  id: number
  type: string
  defaultInt: number
  autoDisable: boolean
  typeName?: string
  [key: string]: unknown
}

export type ParamData = JsonDefData<ParamDef>

export default makeJsonDefLoader<ParamDef>((id) => ({ id, type: 'i', defaultInt: 0, autoDisable: true }))
