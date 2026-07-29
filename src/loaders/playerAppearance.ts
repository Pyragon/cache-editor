import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { getLoader } from './index'
import type { ModelData } from './models'
import { applyRecolor, mergeModels } from './models'
import { loadModelComposite } from './npcComposite'
import { getItem } from './itemSlots'
import type { IdentikitDef } from './config/identikit'
import type { PlayerLook } from './playerLook'
import {
  LOOK_COLOUR_COUNT, LOOK_PART_ARMS, LOOK_PART_COUNT, LOOK_PART_TOP, LOOK_PART_WRISTS,
  lookPartAppliesTo,
} from './playerLook'
import {
  armsFallbackKit, loadOutfitSets, selectableArms, selectableWrists,
  setForArms, setForTop, sleevelessTop, topShowsArms, wristsFallbackKit,
} from './outfitSets'

// Player appearance assembly — ports darkan `PlayerAppearance.kt`.
//
// The client's `appearance: IntArray` is a fixed-width slot table (the dumped
// defaults/equipment.json lists 15 customizable slots); each slot holds 0
// (empty), `itemId | 0x40000000` (an equipped item's mesh), or
// `identikitId | 0x80000000` (an identikit body part). Only 8 of the 15 are
// identikit-driven, and `IDK_PART_TABLE` says which — see playerLook.ts for
// the three-source verification of that ordering.
export const APPEARANCE_SLOT_COUNT = 15

/** Identikit part index (0-7) -> position in the 15-wide appearance array.
 *  Entries 0-6 are the seven `look[]` parts; entry 7 (position 0) is the hat
 *  slot, which only equipment fills. */
export const IDK_PART_TABLE = [8, 11, 4, 6, 9, 7, 10, 0]

/** The chest position — where an equipped body item displaces the torso kit. */
const LOOK_PART_TABLE_CHEST = 4

// ---------------------------------------------------------------------------
// Global recolour palette (defaults/entity.json, ENTITY opcode 7)
// ---------------------------------------------------------------------------

/** The character-creation colour palettes: 10 groups × 4 source colours, each
 *  source carrying its own list of replacements. A look's `colour[g]` picks
 *  one index across the whole of group `g`. */
export type RecolorPalette = {
  /** `src[group][slot]` — the HSL16 colour to find; -1 = unused slot. */
  src: number[][]
  /** `dst[group][slot][choice]` — the replacement HSL16. */
  dst: number[][][]
}

/** Reads the palettes out of the `defaults` entity blob. Null when the entry
 *  isn't dumped or carries no opcode-7 record — callers then render with only
 *  each part's own baked-in recolours, which is what the editor did before. */
const paletteCache = new WeakMap<FileSystemDirectoryHandle, Promise<RecolorPalette | null>>()

export function loadRecolorPalette(rootHandle: FileSystemDirectoryHandle): Promise<RecolorPalette | null> {
  const hit = paletteCache.get(rootHandle)
  if (hit) return hit
  const pending = readRecolorPalette(rootHandle)
  paletteCache.set(rootHandle, pending)
  return pending
}

async function readRecolorPalette(rootHandle: FileSystemDirectoryHandle): Promise<RecolorPalette | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('defaults'))
    if (!dir) return null
    const file = await (await dir.getFileHandle('entity.json')).getFile()
    const def = JSON.parse(await file.text()) as { recolorPaletteSrc?: number[][]; recolorPaletteDst?: number[][][] }
    if (!Array.isArray(def.recolorPaletteSrc) || !Array.isArray(def.recolorPaletteDst)) return null
    return { src: def.recolorPaletteSrc, dst: def.recolorPaletteDst }
  } catch {
    return null
  }
}

/** Applies a look's 10 colour choices to an assembled avatar, mirroring the
 *  recolour loop in `PlayerAppearance.getBodyModel()` — which runs on the
 *  COMBINED mesh, after every part has had its own recolours applied.
 *
 *  Two client behaviours are reproduced deliberately:
 *  - A choice past the end of the group's list falls back to 0, the way
 *    `PlayerEntity` clamps it while reading the appearance block. The stock
 *    looks rely on this: their skin choice is 110 against a 14-entry palette,
 *    so the shipped characters render with skin 0.
 *  - Per source slot, the pair is skipped when that slot's own list is
 *    shorter than the choice, matching the client's inner `<` guard. */
export function applyLookPalette(model: ModelData, colour: number[], palette: RecolorPalette): void {
  const from: number[] = []
  const to: number[] = []
  for (let group = 0; group < LOOK_COLOUR_COUNT; group++) {
    const groupSrc = palette.src[group]
    const groupDst = palette.dst[group]
    if (!groupSrc || !groupDst) continue

    let choice = Number(colour[group] ?? 0)
    if (!Number.isFinite(choice) || choice < 0 || choice >= (groupDst[0]?.length ?? 0)) choice = 0

    for (let slot = 0; slot < groupSrc.length; slot++) {
      const src = groupSrc[slot]
      const list = groupDst[slot]
      if (src === -1 || !list || choice >= list.length) continue
      from.push(src)
      to.push(list[choice])
    }
  }
  // One ordered pass per pair, exactly as the client's nested loop does.
  if (from.length > 0) applyRecolor(model, from, to, [], [])
}

/** Java's `(short)` cast — palette sources are dumped signed, face colours are
 *  unsigned, so hue >= 32 (the whole cyan/blue/magenta half) only matches in
 *  signed space. The marker tones live there, so this is load-bearing. */
const s16 = (v: number): number => (v << 16) >> 16

export type PaletteToneUse = {
  group: number
  /** Which of the group's up-to-4 source colours this is. */
  slot: number
  /** The packed HSL16 the mesh is painted in. */
  source: number
  faces: number
}

/** Which palette source colours a mesh is actually painted in.
 *
 *  Why it matters for the UI: a kit's own preview shows raw mesh colours, but
 *  the player palette replaces these before anything reaches the game. At
 *  choice 0 most slots map to themselves — so they look like real colours —
 *  while a few are pure markers that are always replaced, and those render as
 *  something startling (identikit 323's second hair tone is vivid magenta).
 *  A viewer showing an unrecoloured mesh should say so. */
export function paletteTonesUsed(model: ModelData, palette: RecolorPalette): PaletteToneUse[] {
  const used: PaletteToneUse[] = []
  for (let group = 0; group < LOOK_COLOUR_COUNT; group++) {
    const groupSrc = palette.src[group]
    const groupDst = palette.dst[group]
    if (!groupSrc || !groupDst) continue
    for (let slot = 0; slot < groupSrc.length; slot++) {
      const source = groupSrc[slot]
      if (source === -1 || !groupDst[slot]?.length) continue
      let faces = 0
      for (let f = 0; f < model.faceCount; f++) {
        if (s16(model.faceColor[f]) === source) faces++
      }
      if (faces > 0) used.push({ group, slot, source, faces })
    }
  }
  return used
}

/** True when the palette leaves this tone alone at choice 0 — i.e. the mesh is
 *  painted in a real colour rather than a marker that is always swapped out. */
export function toneIsItsOwnDefault(palette: RecolorPalette, group: number, slot: number): boolean {
  return palette.dst[group]?.[slot]?.[0] === palette.src[group]?.[slot]
}

// ---------------------------------------------------------------------------
// Building the avatar
// ---------------------------------------------------------------------------

async function loadIdentikitDef(rootHandle: FileSystemDirectoryHandle, id: number): Promise<IdentikitDef | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('config_identikit'))
    const loader = getLoader('config_identikit')
    if (!dir || !loader) return null
    const data = await loader.loadItem(dir, { id, name: `${id}` }, rootHandle) as { def: IdentikitDef }
    return data.def
  } catch {
    return null
  }
}

/** One identikit's own composite: its body models merged, then its own
 *  recolour/retexture pairs applied — `IdkType.getBodyMesh()`. Routed through
 *  `loadModelComposite` so pre-v13 meshes get the client's `<<2` upscale
 *  before the merge (`getBodyMesh` upscales each part too); without it an
 *  old-format part assembles at a quarter of everything else's size. */
export async function buildIdentikitPart(
  rootHandle: FileSystemDirectoryHandle,
  id: number,
  def?: IdentikitDef | null,
): Promise<ModelData | null> {
  try {
    const resolved = def ?? await loadIdentikitDef(rootHandle, id)
    if (!resolved?.bodyModels || resolved.bodyModels.length === 0) return null
    return await loadModelComposite(rootHandle, {
      modelIds: [...resolved.bodyModels],
      recolor: {
        from: resolved.originalColours,
        to: resolved.replacementColours,
        textureFrom: resolved.originalTextures,
        textureTo: resolved.replacementTextures,
      },
    })
  } catch {
    return null
  }
}

/** One equipped item's body composite for a gender — its equip1-3 models
 *  merged with the item's own recolours, mirroring `ItemType.getBodyMesh()`. */
export async function buildItemPart(
  rootHandle: FileSystemDirectoryHandle,
  id: number,
  female: boolean,
): Promise<ModelData | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('items'))
    if (!dir) return null
    const def = JSON.parse(await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text()) as Record<string, unknown>
    const keys = female
      ? ['femaleEquip1', 'femaleEquip2', 'femaleEquip3']
      : ['maleEquip1', 'maleEquip2', 'maleEquip3']
    const modelIds = keys.map((k) => Number(def[k] ?? -1)).filter((v) => v >= 0)
    if (modelIds.length === 0) return null
    return await loadModelComposite(rootHandle, {
      modelIds,
      recolor: {
        from: def.originalModelColours as number[] | undefined,
        to: def.modifiedModelColours as number[] | undefined,
        textureFrom: def.originalTextureIds as number[] | undefined,
        textureTo: def.modifiedTextureIds as number[] | undefined,
      },
    })
  } catch {
    return null
  }
}

/** Swaps one look part for the def being previewed. `def` short-circuits the
 *  identikit load when the caller already has it (the viewer's live draft, so
 *  unsaved edits preview). */
export type LookPartOverride = {
  part: number
  identikitId: number
  def?: IdentikitDef | null
}

/** Where a part's id came from. `set` = the outfit set the top (or previewed
 *  arms kit) belongs to overrode the look, exactly as `verifyArms` does in
 *  game. `fallback` = neither the look nor a set supplied a usable id, so the
 *  client's hardcoded default stood in. */
export type LookPartSource = 'look' | 'override' | 'set' | 'fallback'

export type LookPartResult = {
  part: number
  identikitId: number
  overridden: boolean
  source: LookPartSource
  /** `empty` = the look leaves this part off (id -1), which is normal — both
   *  stock looks carry no arms part. `missing` = it should have rendered but
   *  the def or its models wouldn't load. `n/a` = this gender doesn't wear
   *  the part (only ever a female beard). */
  status: 'ok' | 'empty' | 'missing' | 'n/a'
}

export type LookModel = {
  model: ModelData | null
  parts: LookPartResult[]
  /** False when the `defaults` entity blob carried no palettes, so the colour
   *  choices did nothing — the UI says so rather than silently ignoring them. */
  paletteApplied: boolean
}

/** Assembles the seven look parts into one avatar and applies the look's
 *  colour choices, mirroring the client's order: each part recoloured on its
 *  own, merged, then the global palette over the combined mesh.
 *
 *  Equipment is not layered in yet — with nothing equipped the client's body
 *  recipe reduces to exactly these seven meshes. */
export async function buildLookModel(
  rootHandle: FileSystemDirectoryHandle,
  look: PlayerLook,
  override?: LookPartOverride | null,
  female = false,
): Promise<LookModel> {
  const ids = Array.from({ length: LOOK_PART_COUNT }, (_, i) => look.look[i] ?? -1)
  const overridePart = override && override.part >= 0 && override.part < LOOK_PART_COUNT ? override.part : -1
  if (overridePart >= 0 && override) ids[overridePart] = override.identikitId

  // A part the gender doesn't wear is dropped before it can render, the way
  // the server drops it out of the appearance block — so a stray beard id on
  // a female look shows nothing here either.
  const applies = ids.map((_, part) => lookPartAppliesTo(part, female))

  // Tops and arms are not independent: choosing a top makes the server
  // rewrite the arms and wrists from the outfit set that top belongs to
  // (`Appearance.verifyArms`). Mirroring that is what keeps a sleeveless top
  // from rendering armless AND a sleeved one from wearing two pairs of arms —
  // the client has no render-time trick for the latter, it just never lets
  // the combination arise. The part being previewed is never overwritten.
  const source: LookPartSource[] = ids.map(() => 'look')
  if (overridePart >= 0) source[overridePart] = 'override'

  const outfit = await loadOutfitSets(rootHandle)
  if (outfit) {
    const assign = (part: number, value: number, from: LookPartSource) => {
      if (part === overridePart) return
      ids[part] = value
      source[part] = from
    }

    if (overridePart === LOOK_PART_ARMS) {
      // No client analogue — it only ever derives arms FROM the top — so to
      // show an arms kit we work backwards to the top that completes it.
      const set = setForArms(outfit, ids[LOOK_PART_ARMS], female)
      if (set) {
        if (set.top >= 0) assign(LOOK_PART_TOP, set.top, 'set')
        if (set.wrists >= 0) assign(LOOK_PART_WRISTS, set.wrists, 'set')
      } else {
        // A bare-arms kit, which belongs to no set because the client only
        // pairs it with an equipped chest item. Keep the look's own top when
        // it's known to leave the arms visible; otherwise stand the kit on a
        // sleeveless one so it isn't buried under sleeves.
        if (!topShowsArms(outfit, ids[LOOK_PART_TOP], female)) {
          const top = sleevelessTop(outfit, female)
          if (top >= 0) assign(LOOK_PART_TOP, top, 'fallback')
        }
        // Whichever top won, take its set's wrists so the outfit stays whole.
        const topSet = setForTop(outfit, ids[LOOK_PART_TOP], female)
        if (topSet && topSet.wrists >= 0) assign(LOOK_PART_WRISTS, topSet.wrists, 'set')
      }
    } else {
      const set = setForTop(outfit, ids[LOOK_PART_TOP], female)
      if (set) {
        assign(LOOK_PART_ARMS, set.arms, 'set')
        assign(LOOK_PART_WRISTS, set.wrists, 'set')
      } else {
        if (!selectableArms(outfit, female).includes(ids[LOOK_PART_ARMS])) {
          assign(LOOK_PART_ARMS, armsFallbackKit(female), 'fallback')
        }
        if (!selectableWrists(outfit, female).includes(ids[LOOK_PART_WRISTS])) {
          assign(LOOK_PART_WRISTS, wristsFallbackKit(female), 'fallback')
        }
      }
    }
  }

  const built = await Promise.all(ids.map((id, part) => {
    if (!applies[part] || !Number.isFinite(id) || id < 0) return Promise.resolve(null)
    return buildIdentikitPart(rootHandle, id, part === overridePart ? override?.def : undefined)
  }))

  const parts: LookPartResult[] = ids.map((id, part) => ({
    part,
    identikitId: id,
    overridden: part === overridePart,
    source: source[part],
    status: !applies[part]
      ? 'n/a'
      : !Number.isFinite(id) || id < 0 ? 'empty' : built[part] ? 'ok' : 'missing',
  }))


  // ---- equipment ---------------------------------------------------------
  // Items and identikit parts share the 15-wide appearance array, so an
  // equipped item simply occupies its `wearPos` and the slots it COVERS
  // (`wearPos2`/`wearPos3` — the client's `isEquipType`) are emptied. That one
  // rule reproduces hideArms/hideHair/hideBeard and a two-hander clearing the
  // shield, without a special case each.
  const equipment = Array.isArray(look.equipment) ? look.equipment : []
  const wornIds = equipment.map((id, slot) => ({ id: Number(id) || -1, slot })).filter((e) => e.id >= 0)
  const worn = await Promise.all(wornIds.map(async (e) => ({ ...e, brief: await getItem(rootHandle, e.id) })))

  const hidden = new Set<number>()
  for (const item of worn) {
    for (const slot of item.brief?.covers ?? []) hidden.add(slot)
  }

  // A chest ITEM that doesn't hide the arms exposes them, and the look may
  // name no arms kit — that's what the bare-arms fallback is for
  // (`Appearance.getOldArms`).
  const chestItem = worn.find((e) => e.slot === LOOK_PART_TABLE_CHEST)
  if (chestItem && !hidden.has(IDK_PART_TABLE[LOOK_PART_ARMS]) && !(ids[LOOK_PART_ARMS] >= 0)) {
    ids[LOOK_PART_ARMS] = armsFallbackKit(female)
    source[LOOK_PART_ARMS] = 'fallback'
  }

  const equipMeshes = (await Promise.all(
    worn.map((e) => (hidden.has(e.slot) ? Promise.resolve(null) : buildItemPart(rootHandle, e.id, female))),
  )).filter((m): m is ModelData => m != null)

  const meshes = [
    ...built.filter((m, part): m is ModelData => m != null && !hidden.has(IDK_PART_TABLE[part])),
    ...equipMeshes,
  ]
  if (meshes.length === 0) return { model: null, parts, paletteApplied: false }

  const merged = meshes.length === 1 ? meshes[0] : mergeModels(meshes)

  const palette = await loadRecolorPalette(rootHandle)
  if (palette) applyLookPalette(merged, look.colour, palette)

  return { model: merged, parts, paletteApplied: palette != null }
}
