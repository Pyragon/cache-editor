import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Client string variables (VARC_STRING, CONFIG file type 15). The cache
// stores no fields at all — every blob is a bare terminator, and darkan has
// no decoder for them — so these are pure presence records reserving the id.
export type VarcStringDef = {
  id: number
}

export type VarcStringData = JsonDefData<VarcStringDef>

export default makeJsonDefLoader<VarcStringDef>((id) => ({ id }))
