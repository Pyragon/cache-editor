// Editor-set variable values, standing in for the player vars the client reads.
//
// A morph ("multiloc") picks its appearance from a varbit or varp:
// `ObjectType.getMultiLoc` uses the value as an index into `transformTo`, and
// the LAST entry is the default the var can never select. There is no player
// here, so without an override every morph renders that default — correct for
// a fresh world, but it hides every other state a loc can be in (a door open,
// a quest area mid-chain, an intact roof against its smashed twin).
//
// Cutscenes have the same need and no data to satisfy it: `CutsceneVarDomain`
// reads the cutscene's own SET_VARIABLE / SET_BIT_VARIABLE actions first and
// falls back to the player's vars — and no cutscene in this cache sets a single
// variable, so a scene authored around a mid-quest world can't be reproduced
// from the cache alone. These overrides are that missing world state.

export type VarKind = 'varbit' | 'varp'

export type VarOverride = {
  kind: VarKind
  id: number
  value: number
}

export const VAR_OVERRIDES_KEY = 'cache-editor:var-overrides-v1'

let overrides: VarOverride[] = []
let loaded = false

function sanitize(raw: unknown): VarOverride[] {
  if (!Array.isArray(raw)) return []
  const out: VarOverride[] = []
  for (const entry of raw) {
    const e = entry as Partial<VarOverride>
    const id = Number(e?.id)
    const value = Number(e?.value)
    if (!Number.isFinite(id) || id < 0 || !Number.isFinite(value)) continue
    out.push({ kind: e?.kind === 'varp' ? 'varp' : 'varbit', id: Math.trunc(id), value: Math.trunc(value) })
  }
  return out
}

export function loadVarOverrides(): VarOverride[] {
  if (!loaded) {
    try {
      const stored = localStorage.getItem(VAR_OVERRIDES_KEY)
      overrides = stored ? sanitize(JSON.parse(stored)) : []
    } catch {
      overrides = []
    }
    loaded = true
  }
  return overrides.map((o) => ({ ...o }))
}

type Listener = () => void
const listeners = new Set<Listener>()

/** Notified after a save, so open scenes can re-resolve the locs that changed
 *  rather than rebuilding from scratch. */
export function onVarOverridesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function saveVarOverrides(next: VarOverride[]): void {
  overrides = sanitize(next)
  loaded = true
  try {
    localStorage.setItem(VAR_OVERRIDES_KEY, JSON.stringify(overrides))
  } catch {
    // storage disabled/full — the values still apply for this session
  }
  for (const listener of listeners) listener()
}

/** The value set for a var, or −1 for "not set" — the same sentinel
 *  `getMultiLoc` starts its index at when a def names neither var. */
export function varValue(kind: VarKind, id: number): number {
  if (!loaded) loadVarOverrides()
  const match = overrides.find((o) => o.kind === kind && o.id === id)
  return match ? match.value : -1
}

/** A def's morph target list and the vars that select from it. Kept structural
 *  so this module doesn't have to import a def type from the renderer. */
export type MultiLocDef = {
  transformTo?: number[]
  varpBit?: number
  varp?: number
}

/**
 * The id a morph resolves to, mirroring `ObjectType.getMultiLoc`:
 *
 *   index = the varbit's value, else the varp's, else −1
 *   if (index >= 0 && index < ids.length − 1 && ids[index] !== −1) → ids[index]
 *   else                                                          → ids[last]
 *
 * Returns null when that lands on −1, which is the client's "draw nothing".
 * `null` is also returned for a def with no morph list, so callers can treat
 * "no change" and "nothing" distinctly by checking `transformTo` themselves.
 */
export function resolveMultiLocId(def: MultiLocDef): number | null {
  const ids = def.transformTo
  if (!ids || ids.length === 0) return null
  let index = -1
  if (def.varpBit != null && def.varpBit !== -1) index = varValue('varbit', def.varpBit)
  else if (def.varp != null && def.varp !== -1) index = varValue('varp', def.varp)
  if (index >= 0 && index < ids.length - 1 && ids[index] !== -1) return ids[index]
  const last = ids[ids.length - 1]
  return last === -1 ? null : last
}
