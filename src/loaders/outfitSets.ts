import { getEntryPath, resolveEntryHandle } from './entryOrder'

// Outfit "sets" — the reason you can't mix an arbitrary torso with arbitrary
// arms.
//
// TRACED 2026-07-29 from darkan-world-server `Appearance.verifyArms()` /
// `getSetByStyle()` / `getSetStruct()`. Choosing a top does not leave the arms
// alone: the server looks the top up in a set and *overwrites* the arms and
// wrists with the ones that set names. So a top either carries its own arm
// geometry (its set lists `arms: -1`) or it is sleeveless and its set names
// the arms kit that completes it. Nothing hides an extra pair of arms at
// render time — the pairing is simply never allowed to be wrong.
//
// The chain:
//   enum 5735            -> family struct ids (20 of them: Adventurer, Thief…)
//   family struct        -> up to 6 set-struct ids per gender
//                           (male params 1169-1174, female 1175-1180)
//   set struct           -> 1182 top · 1183 arms · 1184 wrists · 1185 legs
//
// Verified end to end: the stock male look [_, _, 452, -1, 371, 627, _] IS set
// 1100 ("Thief": top 452, arms -1, wrists 371, legs 627) and the stock female
// look is its 1101 counterpart. That is the proof that `arms: -1` in the
// default look is deliberate — the Thief top has sleeves — and not a hole to
// be patched.

const SETS_ENUM = 5735

/** Family-struct param -> the set struct for slot 0-5, per gender. */
const SET_SLOT_PARAM = {
  male: [1169, 1170, 1171, 1172, 1173, 1174],
  female: [1175, 1176, 1177, 1178, 1179, 1180],
}

const PARAM_NAME = 1160
const PARAM_TOP = 1182
const PARAM_ARMS = 1183
const PARAM_WRISTS = 1184
const PARAM_LEGS = 1185

/** The character-creation pick lists the server validates against
 *  (`verifyArms`'s else-branch), and its hardcoded fallbacks. */
const SELECTABLE = {
  arms: { male: 711, female: 693, fallback: { male: 26, female: 61 } },
  wrists: { male: 749, female: 751, fallback: { male: 34, female: 68 } },
}

export type OutfitSet = {
  female: boolean
  name: string
  /** -1 where the set doesn't name that part. `arms: -1` means the top
   *  carries its own arms. */
  top: number
  arms: number
  wrists: number
  legs: number
}

export type OutfitData = {
  sets: OutfitSet[]
  /** Ids the character-creation screen offers, by gender. */
  selectableArms: { male: number[]; female: number[] }
  selectableWrists: { male: number[]; female: number[] }
}

type StructValues = Record<string, number | string>

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown | null> {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text())
  } catch {
    return null
  }
}

function num(values: StructValues | undefined, param: number): number {
  const v = values?.[String(param)]
  return typeof v === 'number' ? v : -1
}

const cache = new WeakMap<FileSystemDirectoryHandle, Promise<OutfitData | null>>()

/** Reads the set table out of the cache. Cached per cache-root — it touches
 *  ~85 small files (one enum, 20 family structs, 64 set structs). */
export function loadOutfitSets(rootHandle: FileSystemDirectoryHandle): Promise<OutfitData | null> {
  const hit = cache.get(rootHandle)
  if (hit) return hit
  const pending = readOutfitSets(rootHandle)
  cache.set(rootHandle, pending)
  return pending
}

async function readOutfitSets(rootHandle: FileSystemDirectoryHandle): Promise<OutfitData | null> {
  try {
    const enumsDir = await resolveEntryHandle(rootHandle, getEntryPath('enums'))
    const structsDir = await resolveEntryHandle(rootHandle, getEntryPath('config_structs'))
    if (!enumsDir || !structsDir) return null

    const readEnumValues = async (id: number): Promise<number[]> => {
      const def = await readJson(enumsDir, `${id}.json`) as { values?: Record<string, number> } | null
      return def?.values ? Object.values(def.values).filter((v): v is number => typeof v === 'number') : []
    }
    const readStruct = async (id: number): Promise<StructValues | undefined> => {
      const def = await readJson(structsDir, `${id}.json`) as { values?: StructValues } | null
      return def?.values
    }

    const familyIds = await readEnumValues(SETS_ENUM)
    if (familyIds.length === 0) return null

    const sets: OutfitSet[] = []
    await Promise.all(familyIds.map(async (familyId) => {
      const family = await readStruct(familyId)
      if (!family) return
      const name = String(family[String(PARAM_NAME)] ?? '')
      for (const female of [false, true]) {
        const params = female ? SET_SLOT_PARAM.female : SET_SLOT_PARAM.male
        await Promise.all(params.map(async (param) => {
          const setId = num(family, param)
          if (setId === -1) return
          const set = await readStruct(setId)
          if (!set) return
          sets.push({
            female,
            name,
            top: num(set, PARAM_TOP),
            arms: num(set, PARAM_ARMS),
            wrists: num(set, PARAM_WRISTS),
            legs: num(set, PARAM_LEGS),
          })
        }))
      }
    }))

    const [armsM, armsF, wristsM, wristsF] = await Promise.all([
      readEnumValues(SELECTABLE.arms.male),
      readEnumValues(SELECTABLE.arms.female),
      readEnumValues(SELECTABLE.wrists.male),
      readEnumValues(SELECTABLE.wrists.female),
    ])

    return {
      sets,
      selectableArms: { male: armsM, female: armsF },
      selectableWrists: { male: wristsM, female: wristsF },
    }
  } catch {
    return null
  }
}

const byGender = (data: OutfitData, female: boolean) => data.sets.filter((s) => s.female === female)

/** The set a top belongs to — `getSetByStyle(top, 3, female)`. */
export function setForTop(data: OutfitData, top: number, female: boolean): OutfitSet | null {
  if (top < 0) return null
  return byGender(data, female).find((s) => s.top === top) ?? null
}

/** The set an arms kit belongs to — `getSetByStyle(arms, 4, female)`. */
export function setForArms(data: OutfitData, arms: number, female: boolean): OutfitSet | null {
  if (arms < 0) return null
  return byGender(data, female).find((s) => s.arms === arms) ?? null
}

/** Whether a top is known to leave the arms visible — i.e. its set names an
 *  arms kit, so the top itself is sleeveless.
 *
 *  False for a top in no set as well as for a sleeved one: 14 of the 46 male
 *  tops belong to no set and nothing in the data says whether they have
 *  sleeves, so "unknown" is treated as "might hide the arms". Callers wanting
 *  to *show* an arms kit should substitute in that case. */
export function topShowsArms(data: OutfitData, top: number, female: boolean): boolean {
  const set = setForTop(data, top, female)
  return set != null && set.arms !== -1
}

/** A top that leaves the arms visible, for showing an arms kit that belongs
 *  to no set (the bare-arms family the client only pairs with equipment).
 *  Any set naming an arms kit must have a sleeveless top, so the lowest-id
 *  one of those is a deterministic, data-derived choice. */
export function sleevelessTop(data: OutfitData, female: boolean): number {
  const tops = byGender(data, female).filter((s) => s.arms !== -1 && s.top >= 0).map((s) => s.top)
  return tops.length > 0 ? Math.min(...tops) : -1
}

export function selectableArms(data: OutfitData, female: boolean): number[] {
  return female ? data.selectableArms.female : data.selectableArms.male
}

export function selectableWrists(data: OutfitData, female: boolean): number[] {
  return female ? data.selectableWrists.female : data.selectableWrists.male
}

export const armsFallbackKit = (female: boolean) => female ? SELECTABLE.arms.fallback.female : SELECTABLE.arms.fallback.male
export const wristsFallbackKit = (female: boolean) => female ? SELECTABLE.wrists.fallback.female : SELECTABLE.wrists.fallback.male
