// The player "look" — the 7 identikit body parts and 10 palette colour choices
// that make up a character — plus the editor's stored default look per gender.
//
// SLOT LAYOUT (verified three independent ways, 2026-07-29):
//   1. darkan-bot-refactor `PlayerAppearance.IDK_PART_TABLE = [8,11,4,6,9,7,10,0]`
//      maps an identikit part index to its position in the 15-wide appearance
//      array.
//   2. darkan-world-server `Appearance.generateAppearanceData()` writes
//      `lookI[2]` into the chest position, `lookI[3]` into arms, `lookI[5]`
//      legs, `lookI[0]` hair, `lookI[4]` hands, `lookI[6]` feet, `lookI[1]`
//      beard — which is exactly IDK_PART_TABLE[0..6] in order.
//   3. cryogen's own `renderPlayerBody()` composes the same seven meshes with
//      the same fallbacks.
// So look index i lives at appearance position IDK_PART_TABLE[i], and the
// table's 8th entry (position 0, the hat slot) is equipment-only.
export const LOOK_PART_COUNT = 7
export const LOOK_COLOUR_COUNT = 10

/** look[] index -> body part. Names follow the server's own setters
 *  (`setTopStyle`, `setArmsStyle`, `setWristsStyle`, …) and the
 *  character-creation stage order in `PlayerLook.java`. Note slot 4 is
 *  **Wrists**, not "hands" — cryogen's comment calls it hands, but the setter
 *  is `setWristsStyle` and the outfit-set param that fills it (1184) lands on
 *  identikit category 4 every time. */
export const LOOK_PART_LABELS = ['Hair', 'Beard', 'Torso', 'Arms', 'Wrists', 'Legs', 'Feet']

/** The beard part, which only males wear — see `lookPartAppliesTo`. */
export const LOOK_PART_BEARD = 1

export const LOOK_PART_TOP = 2
export const LOOK_PART_ARMS = 3
export const LOOK_PART_WRISTS = 4
export const LOOK_PART_LEGS = 5

/** Whether a gender wears this part at all.
 *
 *  Only the beard is gendered, and the gate is SERVER-side: both
 *  darkan-world-server's `Appearance.generateAppearanceData()` and cryogen's
 *  `renderPlayerBody()` open the beard test with `male &&`, so a female's
 *  beard position is written empty no matter what `look[1]` holds. The client
 *  itself would happily draw a beard mesh it was handed — it just never is.
 *  The cache agrees: identikit category 8 ("female beard") has zero kits,
 *  the one gap in an otherwise contiguous 0-13 range. */
export function lookPartAppliesTo(part: number, female: boolean): boolean {
  return !(female && part === LOOK_PART_BEARD)
}

/** Recolour palette group -> what it tints. Named from darkan-world-server's
 *  own setters (setHairColor -> colour[0], setTopColor -> [1], setLegsColor ->
 *  [2], setBootsColor -> [3], setSkinColor -> [4]). Groups 5-9 exist in the
 *  format but carry no palette in this cache, so they tint nothing. */
export const LOOK_COLOUR_LABELS = ['Hair', 'Torso', 'Legs', 'Boots', 'Skin', '—', '—', '—', '—', '—']

/** Equipment and identikit parts share ONE 15-wide index space — the client's
 *  appearance array, where a slot holds either an item or a body part (see
 *  IDK_PART_TABLE in playerAppearance.ts). So an equipped chest at index 4
 *  displaces the torso kit that otherwise sits there. */
export const EQUIPMENT_SLOT_COUNT = 15

export type PlayerLook = {
  /** LOOK_PART_COUNT identikit ids; -1 = that part is not worn. */
  look: number[]
  /** LOOK_COLOUR_COUNT palette choice indices (see LOOK_COLOUR_LABELS). */
  colour: number[]
  /** EQUIPMENT_SLOT_COUNT item ids; -1 = nothing equipped in that slot. */
  equipment: number[]
}

const emptyEquipment = () => new Array<number>(EQUIPMENT_SLOT_COUNT).fill(-1)

export type PlayerLooks = { male: PlayerLook; female: PlayerLook }

// The server's own starting characters (darkan-world-server Appearance.male()
// / .female()). Note `look[3]` (arms) is -1 in both: the torso kit carries the
// arms, and the client only substitutes the bare-arms kit (26 male / 61
// female) when a chest item hides them.
//
// One deliberate divergence: the server writes skin (`colour[4]`) as **110**,
// which overruns that group's 14 choices — the client clamps an out-of-range
// choice to 0 both on read and at render, so 110 has always *meant* 0. We
// store the 0 it resolves to rather than carrying a value that only works by
// falling over.
export const DEFAULT_MALE_LOOK: PlayerLook = {
  look: [310, 16, 452, -1, 371, 627, 433],
  colour: [12, 218, 218, 180, 0, 0, 0, 0, 0, 0],
  equipment: emptyEquipment(),
}

export const DEFAULT_FEMALE_LOOK: PlayerLook = {
  look: [274, -1, 561, -1, 514, 482, 547],
  colour: [12, 218, 218, 180, 0, 0, 0, 0, 0, 0],
  equipment: emptyEquipment(),
}

const cloneLook = (look: PlayerLook): PlayerLook => ({
  look: [...look.look],
  colour: [...look.colour],
  equipment: [...look.equipment],
})

export function defaultPlayerLooks(): PlayerLooks {
  return { male: cloneLook(DEFAULT_MALE_LOOK), female: cloneLook(DEFAULT_FEMALE_LOOK) }
}

/** An identikit's `category` byte (opcode 1) encodes BOTH gender and which
 *  body part the kit is for: `category = (female ? 7 : 0) + partIndex`.
 *
 *  The client reads and discards this byte (`IdkType.decode` opcode 1) — the
 *  character-creation screen groups kits through CS2/enum lookups instead — so
 *  this is an empirical result, not a decode. It holds across all 651 dumped
 *  kits: categories 0-6 and 9-13 are populated, category 8 ("female beard")
 *  is correctly empty, and every one of the twelve ids in the two default
 *  looks lands on its expected category. */
export function lookSlotFromCategory(category: number): { female: boolean; part: number } | null {
  if (!Number.isInteger(category) || category < 0 || category > 13) return null
  return { female: category >= LOOK_PART_COUNT, part: category % LOOK_PART_COUNT }
}

export const PLAYER_LOOK_KEY = 'cache-editor:player-look-v1'

export const PLAYER_GENDER_KEY = 'cache-editor:player-gender-v1'

/** Which of the two stored looks IS you. Both are kept and editable, but a
 *  cutscene's player entity can only wear one, so the Player Look modal's
 *  Male/Female pill records which is the character rather than just which one
 *  you happen to be editing. */
export function loadPlayerGender(): boolean {
  try {
    return localStorage.getItem(PLAYER_GENDER_KEY) === 'female'
  } catch {
    return false
  }
}

export function savePlayerGender(female: boolean): void {
  try {
    localStorage.setItem(PLAYER_GENDER_KEY, female ? 'female' : 'male')
  } catch {
    // storage disabled/full — the choice still applies for this session
  }
}

function sanitizeLook(raw: unknown, fallback: PlayerLook): PlayerLook {
  const src = (raw ?? {}) as Partial<PlayerLook>
  const pick = (list: unknown, count: number, base: number[]) => {
    const arr = Array.isArray(list) ? list : []
    return Array.from({ length: count }, (_, i) => {
      const v = Number(arr[i])
      return Number.isFinite(v) ? Math.trunc(v) : base[i]
    })
  }
  return {
    look: pick(src.look, LOOK_PART_COUNT, fallback.look),
    colour: pick(src.colour, LOOK_COLOUR_COUNT, fallback.colour),
    equipment: pick(src.equipment, EQUIPMENT_SLOT_COUNT, fallback.equipment),
  }
}

/** Reads the stored default looks, falling back to the built-in ones for
 *  anything missing or malformed (a truncated array keeps the default in the
 *  slots it didn't cover, rather than dropping the whole record). */
export function loadPlayerLooks(): PlayerLooks {
  const defaults = defaultPlayerLooks()
  try {
    const stored = localStorage.getItem(PLAYER_LOOK_KEY)
    if (!stored) return defaults
    const parsed = JSON.parse(stored) as Partial<PlayerLooks>
    return {
      male: sanitizeLook(parsed?.male, defaults.male),
      female: sanitizeLook(parsed?.female, defaults.female),
    }
  } catch {
    return defaults
  }
}

export function savePlayerLooks(looks: PlayerLooks): void {
  try {
    localStorage.setItem(PLAYER_LOOK_KEY, JSON.stringify(looks))
  } catch {
    // storage disabled/full — the in-memory look still applies for this session
  }
}
