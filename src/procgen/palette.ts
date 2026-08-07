/**
 * The generator's ground-material vocabulary, and its binding to THIS cache.
 *
 * A plan says `grass` or `mud`, never a number — for the same reason it says
 * `tree_oak` rather than an object id (see `scenery.ts`). Ids differ between
 * caches, mean nothing to a language model, and make a plan unportable.
 *
 * What a role binds to is a judgement only a human looking at the material can
 * make: the cache's own data does not say which underlay is "dead grass". The
 * shipped numbers are therefore GUESSES with one exception, and the picker
 * exists so they can be replaced by real choices, once per cache.
 *
 * ## Definition ids, not stored bytes
 *
 * Everything here is a DEFINITION id — `config/underlays/<id>.json`. The
 * per-tile byte in a region is `definition id + 1`, because 0 is reserved for
 * "no material here" (see `mapScene`'s `underlays.get(id - 1)`). That +1 is
 * applied once, where the plan lands in the tile field, and nowhere else.
 */

import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'

/** Roles backed by an UNDERLAY — the base material of a tile. */
export const UNDERLAY_ROLES = [
  'grass', 'grassDead', 'dirt', 'mud', 'sand', 'gravel', 'stone', 'snow',
] as const
/** Roles backed by an OVERLAY — drawn on top of the underlay, often shaped. */
export const OVERLAY_ROLES = ['path', 'water', 'rock'] as const

export type UnderlayRole = typeof UNDERLAY_ROLES[number]
export type OverlayRole = typeof OVERLAY_ROLES[number]
export type PaletteRole = UnderlayRole | OverlayRole

export type GroundPalette = Record<PaletteRole, number>

/**
 * What each role is FOR, in the terms someone picking a material would use.
 * Shown next to the swatch grid — the cache has no names for these things, so
 * this text is the only thing telling you what you are choosing.
 */
export const ROLE_INFO: Record<PaletteRole, { label: string; blurb: string }> = {
  grass: { label: 'Grass', blurb: 'Living green grass. The default ground of a healthy area.' },
  grassDead: { label: 'Dead grass', blurb: 'Dry, yellowed or blighted grass. The ground of gloomy and burnt places.' },
  dirt: { label: 'Dirt', blurb: 'Bare earth. Worn ground, clearings, and the floor of a settlement.' },
  mud: { label: 'Mud', blurb: 'Wet, dark earth. Low ground, hollows, swamp and marsh.' },
  sand: { label: 'Sand', blurb: 'Loose pale sand. Beaches, shores and dunes.' },
  gravel: { label: 'Gravel', blurb: 'Loose stone chips. Quarry floors and hard standing.' },
  stone: { label: 'Stone', blurb: 'Solid rock. Cliffs, steep slopes and highland tops.' },
  snow: { label: 'Snow', blurb: 'Snow or ice.' },
  path: { label: 'Path', blurb: 'The worn track a route is drawn with. In the wilds this wants to be dirt, not paving.' },
  water: { label: 'Water', blurb: 'Water surface, painted below the plan\'s water level.' },
  rock: { label: 'Exposed rock', blurb: 'Rock face showing through on steep ground.' },
}

/**
 * Shipped guesses. **Only `grass` is known right** — 163 is what the
 * create-region fill writes (as byte 164) and it is Lumbridge grass. Every
 * other number is a placeholder that happened to be plausible, and is exactly
 * what the picker is for.
 */
export const DEFAULT_PALETTE: GroundPalette = {
  grass: 163,
  grassDead: 163,
  dirt: 21,
  mud: 21,
  sand: 32,
  gravel: 46,
  stone: 46,
  snow: 58,
  path: 3,
  water: 5,
  rock: 14,
}

/** A material as the picker shows it. */
export type GroundMaterial = {
  id: number
  /** raw 24-bit tint. NOT what the tile looks like when `texture` is set. */
  rgb: number
  /** -1 when the tile draws as flat colour */
  texture: number
}

/** The per-tile byte for a definition id: 0 is "no material", so ids shift up. */
export const materialByte = (definitionId: number) => (definitionId + 1) & 0xff

const STORAGE_KEY = 'cache-editor:ground-palette'

/** Saved bindings, per cache. A palette from another cache is meaningless. */
export function loadPalette(fingerprint: string): GroundPalette {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PALETTE }
    const all = JSON.parse(raw) as Record<string, GroundPalette>
    // merge over the defaults so a palette saved before a role existed still
    // loads, with the new role falling back to its guess
    return { ...DEFAULT_PALETTE, ...(all[fingerprint] ?? {}) }
  } catch {
    return { ...DEFAULT_PALETTE }
  }
}

export function savePalette(fingerprint: string, palette: GroundPalette) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const all = raw ? JSON.parse(raw) as Record<string, GroundPalette> : {}
    all[fingerprint] = palette
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch { /* storage blocked — the palette still applies for this session */ }
}

/** Which roles are still on their shipped guess, for the "unset" warning. */
export function unboundRoles(palette: GroundPalette): PaletteRole[] {
  return (Object.keys(ROLE_INFO) as PaletteRole[])
    .filter((r) => palette[r] === DEFAULT_PALETTE[r] && r !== 'grass')
}

async function readAll(dir: FileSystemDirectoryHandle): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for await (const [name, handle] of (dir as unknown as {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  }).entries()) {
    if (!name.endsWith('.json') || handle.kind !== 'file') continue
    try {
      const file = await (handle as FileSystemFileHandle).getFile()
      out.push(JSON.parse(await file.text()) as Record<string, unknown>)
    } catch { /* skip an unreadable definition rather than failing the page */ }
  }
  return out.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))
}

/**
 * Every ground material in the cache, for the picker. Underlays carry `rgb`;
 * overlays call the same field `colorRgb` (and some only have a secondary), so
 * both are normalised to one shape here.
 */
export async function loadGroundMaterials(root: FileSystemDirectoryHandle): Promise<{
  underlays: GroundMaterial[]
  overlays: GroundMaterial[]
}> {
  const [uDir, oDir] = await Promise.all([
    resolveEntryHandle(root, getEntryPath('config_underlays')),
    resolveEntryHandle(root, getEntryPath('config_overlays')),
  ])
  // `resolveEntryHandle` returns null for an entry this dump doesn't carry —
  // an empty pool is a picker with nothing to choose, not a crash
  if (!uDir || !oDir) throw new Error("this cache has no config/underlays or config/overlays folder")
  const [uRaw, oRaw] = await Promise.all([readAll(uDir), readAll(oDir)])
  return {
    underlays: uRaw.map((d) => ({
      id: Number(d.id ?? 0),
      rgb: Number(d.rgb ?? 0),
      texture: Number(d.texture ?? -1),
    })),
    overlays: oRaw.map((d) => ({
      id: Number(d.id ?? 0),
      rgb: Number(d.colorRgb ?? d.secondaryRgb ?? d.minimapColorRgb ?? 0),
      texture: Number(d.texture ?? -1),
    })),
  }
}
