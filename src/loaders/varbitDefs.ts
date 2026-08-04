import { getEntryPath, resolveEntryHandle } from './entryOrder'

// A varbit is a named bit range inside a varp — `baseVar` says which one:
//
//   { "id": 7198, "baseVar": 1240, "startBit": 1, "endBit": 15 }
//
// That indirection is why an interface's transmit filter lists VARPS and never
// varbits. The server sends varp 1240; every component with 1240 in its
// `varps` fires; those scripts then read `varpbit_7198` out of it. So "which
// hook fires when I change varbit 7198" is only answerable by resolving the
// varbit to its base varp first — which is what the gameframe console needs to
// explain why a Variables edit did nothing.

export type VarbitDef = {
  id: number
  baseVar: number
  startBit: number
  endBit: number
}

/** id → def, or null for "looked and it isn't there". Session-scoped: the
 *  console re-runs this on every repaint and the answer never changes. */
const cache = new Map<number, Promise<VarbitDef | null>>()

export function loadVarbitDef(root: FileSystemDirectoryHandle, id: number): Promise<VarbitDef | null> {
  let hit = cache.get(id)
  if (!hit) {
    hit = (async () => {
      try {
        const dir = await resolveEntryHandle(root, getEntryPath('varbits'))
        if (!dir) return null
        const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
        const def = JSON.parse(await file.text()) as VarbitDef
        return Number.isFinite(def?.baseVar) ? def : null
      } catch {
        return null
      }
    })()
    cache.set(id, hit)
  }
  return hit
}
