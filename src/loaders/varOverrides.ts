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

export type VarKind = 'varbit' | 'varp' | 'stat'

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
    const kind: VarKind = e?.kind === 'varp' ? 'varp' : e?.kind === 'stat' ? 'stat' : 'varbit'
    out.push({ kind, id: Math.trunc(id), value: Math.trunc(value) })
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

// ---------------------------------------------------------------------------
// The player behind the interface previews
// ---------------------------------------------------------------------------
//
// Interface scripts don't paint the HUD from constants — they interrogate the
// client for player state and size/colour/label things from the answers. The
// four gameframe orbs, traced hook by hook:
//
//   hitpoints  748  script_2923  poison/disease variant (varp 102 / varp 456)
//                   script_808   fill from varbit 7198 over stat_base(3) × 10
//   prayer     749  script_817(5)/801  varbit 9816 over stat_base(5) × 10
//   run        750  script_2306/1184   run energy over 100
//   summoning  747  script_817(23)     stat(23) over stat_base(23)
//
// and the colour helpers (script_805/806) step green → yellow → orange → red at
// 75/50/25 percent. So these values decide whether the frame looks like a real
// logged-in player or a dying account, which is why they're editable.

/** Client state that isn't a varp/varbit but the scripts still ask for. */
export type PlayerState = {
  /** get_displayname / chat_playername — the chatbox's "Player" */
  displayName: string
  /** runenergy_visible(), 0–100 */
  runEnergy: number
  /** map_members / playermember */
  members: boolean
}

export const PLAYER_STATE_KEY = 'cache-editor:player-state-v1'

/** A brand-new account: every skill level 1, full orbs, full energy. Matching
 *  the fresh-world default the morph overrides above already assume. */
export const DEFAULT_PLAYER_STATE: PlayerState = {
  displayName: 'Player',
  runEnergy: 100,
  members: true,
}

/** Every skill's level unless a 'stat' override names it. */
export const DEFAULT_SKILL_LEVEL = 1

export const SKILL_CONSTITUTION = 3
export const SKILL_PRAYER = 5
export const SKILL_SUMMONING = 23

export const VARP_POISON = 102
export const VARP_DISEASE = 456
export const VARBIT_LIFE_POINTS = 7198
export const VARBIT_PRAYER_POINTS = 9816

/** Named world state, so the Variables table can say what a row DOES instead
 *  of showing a bare id. `derive` supplies the value when the row is absent —
 *  life and prayer points default to full for the current level, so raising a
 *  level doesn't leave the orb looking half-drained. */
export type KnownVar = {
  kind: VarKind
  id: number
  name: string
  what: string
  derive?: (level: (skill: number) => number) => number
}

export const KNOWN_VARS: KnownVar[] = [
  { kind: 'stat', id: SKILL_CONSTITUTION, name: 'Constitution level', what: 'Max life points = level × 10 (hitpoints orb)' },
  { kind: 'varbit', id: VARBIT_LIFE_POINTS, name: 'Life points', what: 'Current life points — fills the hitpoints orb', derive: (level) => Math.max(1, level(SKILL_CONSTITUTION)) * 10 },
  { kind: 'stat', id: SKILL_PRAYER, name: 'Prayer level', what: 'Max prayer points = level × 10 (prayer orb)' },
  { kind: 'varbit', id: VARBIT_PRAYER_POINTS, name: 'Prayer points', what: 'Current prayer points — fills the prayer orb', derive: (level) => Math.max(1, level(SKILL_PRAYER)) * 10 },
  { kind: 'stat', id: SKILL_SUMMONING, name: 'Summoning level', what: 'Max summoning points (summoning orb)' },
  { kind: 'varp', id: VARP_POISON, name: 'Poisoned', what: 'Above 0 swaps the hitpoints orb to its "Use cure (p)" variant' },
  { kind: 'varp', id: VARP_DISEASE, name: 'Diseased', what: 'Above 0 swaps the hitpoints orb to its "Use cure (d)" variant' },
]

export function knownVar(kind: VarKind, id: number): KnownVar | null {
  return KNOWN_VARS.find((k) => k.kind === kind && k.id === id) ?? null
}

let player: PlayerState | null = null

export function loadPlayerState(): PlayerState {
  if (!player) {
    try {
      const stored = localStorage.getItem(PLAYER_STATE_KEY)
      const raw = stored ? (JSON.parse(stored) as Partial<PlayerState>) : {}
      player = {
        displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : DEFAULT_PLAYER_STATE.displayName,
        runEnergy: Number.isFinite(raw.runEnergy) ? Math.max(0, Math.min(100, Math.trunc(raw.runEnergy as number))) : DEFAULT_PLAYER_STATE.runEnergy,
        members: raw.members !== false,
      }
    } catch {
      player = { ...DEFAULT_PLAYER_STATE }
    }
  }
  return { ...player }
}

export function savePlayerState(next: PlayerState): void {
  player = {
    displayName: next.displayName || DEFAULT_PLAYER_STATE.displayName,
    runEnergy: Math.max(0, Math.min(100, Math.trunc(next.runEnergy))),
    members: next.members,
  }
  try {
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(player))
  } catch {
    // storage disabled/full — the values still apply for this session
  }
  for (const listener of listeners) listener()
}

/** A skill's level: its 'stat' override, else level 1. */
export function skillLevel(id: number): number {
  const set = varValue('stat', id)
  return set === -1 ? DEFAULT_SKILL_LEVEL : set
}

/** The var value a script should read: an explicit override, else the known
 *  default (points full for the level), else 0. */
export function playerVar(kind: VarKind, id: number): number {
  const set = varValue(kind, id)
  if (set !== -1) return set
  return knownVar(kind, id)?.derive?.(skillLevel) ?? 0
}
