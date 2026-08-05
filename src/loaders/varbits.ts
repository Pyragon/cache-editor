import { makeJsonDefLoader } from './common'
import type { JsonDefData } from './common'
import type { CacheLoader } from './types'

// A varbit is a named slice of bits inside a VARP (a player variable, which is
// one 32-bit int). Ported from darkan's VarpbitType: opcode 1 reads
// `configIndex` (the varp id — dumped here as `baseVar`), then startBit and
// endBit as unsigned bytes. `endBit` is INCLUSIVE — the client reads the value
// as `activeVars[baseVar] >> startBit & BIT_MASKS[endBit - startBit]`, where
// BIT_MASKS[i] is 2^(i+1) − 1.
export type VarbitDef = {
  id: number
  baseVar: number
  startBit: number
  endBit: number
}

export type VarbitData = JsonDefData<VarbitDef> & {
  // The planner writes new varps (a different entry) as well as new varbits.
  rootHandle?: FileSystemDirectoryHandle
}

const base = makeJsonDefLoader<VarbitDef>((id) => ({ id, baseVar: 0, startBit: 0, endBit: 0 }))

const loader: CacheLoader = {
  streamItems: base.streamItems,
  saveItem: base.saveItem,
  createItem: base.createItem,
  deleteItem: base.deleteItem,
  // Deliberately NO cloneItem. A clone copies baseVar/startBit/endBit verbatim,
  // so the copy claims exactly the same bits of the same var as the original —
  // two varbits over one slice, silently corrupting each other. Adding one goes
  // through the planner instead, which picks free bits.

  async loadItem(dirHandle, item, rootHandle) {
    const data = await base.loadItem(dirHandle, item, rootHandle) as VarbitData
    return { ...data, rootHandle } satisfies VarbitData
  },
}

export default loader
