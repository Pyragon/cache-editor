import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { getLoader } from './index'
import type { ModelData } from './models'
import { mergeModels, applyRecolor } from './models'
import type { IdentikitDef } from './config/identikit'
import type { ItemDef } from './items'

// Player appearance assembly — ports darkan PlayerAppearance.kt. The client's
// `appearance: IntArray` is a fixed-width slot table (customizableObjSlots in
// the dumped defaults/equipment.json has 15 entries, indices 0-14); each slot
// holds either 0 (empty), `itemId | 0x40000000` (an equipped item's mesh), or
// `identikitId | 0x80000000` (an identikit body part). Only 8 of the 15 slots
// are identikit-driven (IDK_PART_TABLE below); the rest are equipment-only.
// Two slots are independently confirmed from the real cache dump
// (defaults/equipment.json): weaponSlot=3, shieldSlot=5. The remaining
// slots' exact semantic names (cape, amulet, etc.) aren't verified here, so
// this tool labels them by raw slot number rather than guessing.
export const APPEARANCE_SLOT_COUNT = 15

// IDK_PART_TABLE: identikit render slot (0-7, what the character-creation
// screen calls e.g. "hair", "torso", "legs") -> appearance array position.
export const IDK_PART_TABLE = [8, 11, 4, 6, 9, 7, 10, 0]

export type AppearanceSlot =
  | { kind: 'empty' }
  | { kind: 'identikit'; id: number }
  | { kind: 'item'; id: number }

export function defaultAppearanceSlots(): AppearanceSlot[] {
  return new Array(APPEARANCE_SLOT_COUNT).fill(null).map(() => ({ kind: 'empty' }) as AppearanceSlot)
}

export function slotLabel(position: number): string {
  const idkSlot = IDK_PART_TABLE.indexOf(position)
  if (idkSlot >= 0) return `Body Part ${idkSlot} (slot ${position})`
  if (position === 3) return 'Weapon (slot 3)'
  if (position === 5) return 'Shield (slot 5)'
  return `Slot ${position}`
}

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

async function loadItemDef(rootHandle: FileSystemDirectoryHandle, id: number): Promise<ItemDef | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('items'))
    const loader = getLoader('items')
    if (!dir || !loader) return null
    const data = await loader.loadItem(dir, { id, name: `${id}` }, rootHandle) as { item: ItemDef }
    return data.item
  } catch {
    return null
  }
}

async function loadModel(rootHandle: FileSystemDirectoryHandle, id: number): Promise<ModelData | null> {
  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('models'))
    const loader = getLoader('models')
    if (!dir || !loader) return null
    return await loader.loadItem(dir, { id, name: `${id}` }, rootHandle) as ModelData
  } catch {
    return null
  }
}

// One identikit's own composite (bodyModels merged, its own recolor/retexture
// applied) — mirrors IdentiKitDefinitions.renderBody().
async function buildIdentikitPart(rootHandle: FileSystemDirectoryHandle, id: number): Promise<ModelData | null> {
  const def = await loadIdentikitDef(rootHandle, id)
  if (!def?.bodyModels || def.bodyModels.length === 0) return null
  const parts = (await Promise.all(def.bodyModels.map((mid) => loadModel(rootHandle, mid)))).filter((m): m is ModelData => m != null)
  if (parts.length === 0) return null
  const merged = mergeModels(parts)
  if (def.originalColours) {
    applyRecolor(merged, def.originalColours, def.replacementColours ?? [], def.originalTextures ?? [], def.replacementTextures ?? [])
  }
  return merged
}

// One equipped item's own composite for the given gender (equip1-3 merged,
// its own recolor/retexture applied) — mirrors ItemType.getBodyMesh().
async function buildItemPart(rootHandle: FileSystemDirectoryHandle, id: number, female: boolean): Promise<ModelData | null> {
  const def = await loadItemDef(rootHandle, id)
  if (!def) return null
  const keys = female ? ['femaleEquip1', 'femaleEquip2', 'femaleEquip3'] : ['maleEquip1', 'maleEquip2', 'maleEquip3']
  const modelIds = keys.map((k) => Number(def[k] ?? -1)).filter((v) => v >= 0)
  if (modelIds.length === 0) return null
  const parts = (await Promise.all(modelIds.map((mid) => loadModel(rootHandle, mid)))).filter((m): m is ModelData => m != null)
  if (parts.length === 0) return null
  const merged = mergeModels(parts)
  const recolorFrom = def.originalModelColours ?? []
  const recolorTo = def.modifiedModelColours ?? []
  const retextureFrom = def.originalTextureIds ?? []
  const retextureTo = def.modifiedTextureIds ?? []
  if (recolorFrom.length > 0 || retextureFrom.length > 0) applyRecolor(merged, recolorFrom, recolorTo, retextureFrom, retextureTo)
  return merged
}

// Assembles every non-empty slot into one composite avatar model.
export async function buildPlayerModel(
  slots: AppearanceSlot[],
  female: boolean,
  rootHandle: FileSystemDirectoryHandle,
): Promise<ModelData | null> {
  const parts = (await Promise.all(slots.map((slot) => {
    if (slot.kind === 'identikit') return buildIdentikitPart(rootHandle, slot.id)
    if (slot.kind === 'item') return buildItemPart(rootHandle, slot.id, female)
    return Promise.resolve(null)
  }))).filter((m): m is ModelData => m != null)

  if (parts.length === 0) return null
  return mergeModels(parts)
}
