import { getEntryPath, resolveEntryHandle } from './entryOrder'

// The "render emote" — the BAS (base animation set) a player animates with.
//
// TRACED 2026-07-29 through darkan-world-server `Appearance.getRenderEmote()`:
//
//   if (bas >= 0)              return bas;                    // explicit override
//   if (transformedNpcId >= 0) return npcDefs.basId;          // morphed into an NPC
//   return equipment.getWeaponBAS();
//
// and `Equipment.getWeaponBAS()`:
//
//   Item weapon = items.get(3);
//   if (weapon == null) return 1426;
//   return weapon.getDefinitions().getRenderAnimId();
//
// with `getRenderAnimId()` (cryogen `ItemDefinitions:475`) reading the item's
// **client-script param 644**, falling back to 1426.
//
// So a stored -1 is not "no animation" — it means "derive it", and an unarmed
// player derives **BAS 1426**, whose stand animation is **808**. That matches
// cryogen's own `getStandAnimation`, which falls back to 808 when a BAS is
// missing.

/** The unarmed default, used whenever nothing else supplies a BAS. */
export const DEFAULT_BAS = 1426

/** Stand animation used when a BAS record can't be read at all. */
export const DEFAULT_STAND_ANIMATION = 808

/** The weapon's appearance/equipment slot. */
const WEAPON_SLOT = 3

/** Item client-script param carrying the render anim (BAS) id. */
const RENDER_ANIM_PARAM = 644

export type RenderEmote = {
  bas: number
  /** Where the value came from, for the UI to explain itself. */
  source: 'override' | 'weapon' | 'unarmed'
  weaponId: number
}

/** Resolves the BAS a look animates with. `basOverride` mirrors the server's
 *  own `bas` field: >= 0 wins outright, -1 means derive from the weapon. */
export async function resolveRenderEmote(
  rootHandle: FileSystemDirectoryHandle,
  equipment: number[],
  basOverride = -1,
): Promise<RenderEmote> {
  if (basOverride >= 0) return { bas: basOverride, source: 'override', weaponId: -1 }

  const weaponId = Number(equipment?.[WEAPON_SLOT] ?? -1)
  if (!(weaponId >= 0)) return { bas: DEFAULT_BAS, source: 'unarmed', weaponId: -1 }

  try {
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('items'))
    if (dir) {
      const def = JSON.parse(await (await (await dir.getFileHandle(`${weaponId}.json`)).getFile()).text()) as {
        clientScriptData?: Record<string, number | string>
      }
      const raw = def.clientScriptData?.[String(RENDER_ANIM_PARAM)]
      if (typeof raw === 'number') return { bas: raw, source: 'weapon', weaponId }
    }
  } catch { /* unreadable item — the unarmed default still applies */ }

  return { bas: DEFAULT_BAS, source: 'weapon', weaponId }
}

/** A BAS's standing animation, or the client's 808 fallback. */
export async function loadStandAnimation(
  rootHandle: FileSystemDirectoryHandle,
  bas: number,
): Promise<number> {
  try {
    if (bas < 0) return DEFAULT_STAND_ANIMATION
    const dir = await resolveEntryHandle(rootHandle, getEntryPath('config_bas'))
    if (!dir) return DEFAULT_STAND_ANIMATION
    const def = JSON.parse(await (await (await dir.getFileHandle(`${bas}.json`)).getFile()).text()) as {
      standAnimation?: number
    }
    return typeof def.standAnimation === 'number' && def.standAnimation >= 0
      ? def.standAnimation
      : DEFAULT_STAND_ANIMATION
  } catch {
    return DEFAULT_STAND_ANIMATION
  }
}
