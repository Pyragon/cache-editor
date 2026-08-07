/**
 * The generator's ground-material vocabulary, and its binding to THIS cache.
 *
 * A plan says `grass` or `mud`, never a number — for the same reason it says
 * `tree_oak` rather than an object id (see `scenery.ts`). Ids differ between
 * caches, mean nothing to a language model, and make a plan unportable.
 *
 * The cache does not say which underlay is "dead grass" — it says rgb, texture
 * and scale. So the bindings were MEASURED rather than guessed: 15 settlements
 * and their surrounding countryside were surveyed straight from the map dumps,
 * and each role given the material that actually fills that job in the game.
 * The working is in `docs/procgen-reference.md`. The picker exists to re-point
 * them for a cache that numbers things differently.
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
  'grass', 'grassLush', 'grassMid', 'grassDark', 'grassDead',
  'dirt', 'mud', 'townEarth', 'trackEarth', 'sand', 'gravel', 'stone', 'snow',
] as const
/** Roles backed by an OVERLAY — drawn on top of the underlay, often shaped. */
export const OVERLAY_ROLES = ['path', 'pathDirt', 'water', 'rock'] as const

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
  grass: { label: 'Grass', blurb: 'The workhorse green. Measured as the most consistent ground across every surveyed settlement.' },
  grassLush: { label: 'Lush grass', blurb: 'A brighter, greener relative. Used sparingly in the mix to keep a field from reading as one flat colour.' },
  grassMid: { label: 'Mid grass', blurb: 'The third green. The real map leans on near-identical variants of the same colour to stop ground repeating, and this is one of them.' },
  grassDark: { label: 'Dark grass', blurb: 'The deepest green. Commonest single underlay in the real map; the base of most open country.' },
  grassDead: { label: 'Dry grass', blurb: 'Parched, yellowed grass. Hot and rough country, and the ground of blighted places.' },
  dirt: { label: 'Dirt', blurb: 'Mid-brown bare earth. Worn ground, clearings and field edges.' },
  mud: { label: 'Mud', blurb: 'Dark wet earth. Hollows and low ground - and in the real map, also what shows on steep slopes.' },
  trackEarth: { label: 'Track earth', blurb: 'The bare brown ground a country track is worn into. In the real map an unpaved road is this underlay with no overlay at all - not a paved surface.' },
  townEarth: { label: 'Town ground', blurb: 'The packed earth of a settlement floor. Three times commoner inside a town than outside one, so it is what marks somewhere as built-up.' },
  sand: { label: 'Sand', blurb: 'Loose pale sand. Beaches, shores and dunes.' },
  gravel: { label: 'Gravel', blurb: 'Loose stone chips. Quarry floors, hard standing and reserved building plots.' },
  stone: { label: 'Stone', blurb: 'Bare rocky ground. Coastal rock, highland tops and cliff shoulders.' },
  snow: { label: 'Snow', blurb: 'Snow or ice, for high ground.' },
  path: { label: 'Path', blurb: 'The main road surface. Wants to be one that blends into the ground at its edges rather than cutting a hard border.' },
  pathDirt: { label: 'Dirt track', blurb: 'The rougher, shorter-run road surface - what a track in open country is made of, as opposed to a road through a town.' },
  water: { label: 'Water', blurb: "Water surface, painted below the plan's water level." },
  rock: { label: 'Exposed rock', blurb: 'Rock face showing through on steep ground.' },
}

/**
 * MEASURED, not guessed. Every id below was read out of the real map dumps -
 * 15 settlements and their surrounding countryside, ~550k tiles - and picked
 * as the material that actually fills that role in the game. The working is in
 * `docs/procgen-reference.md`.
 *
 * They remain defaults rather than constants: another cache or revision can
 * number these differently, which is what the picker is for.
 */
export const DEFAULT_PALETTE: GroundPalette = {
  grass: 48,        // #58680b olive - 11-20% of every zone surveyed
  grassLush: 47,    // #35720a brighter green
  grassMid: 160,    // #29380f - third commonest underlay in the real map (10.7% of open)
  grassDark: 162,   // #20250a - the commonest single underlay in the real map
  grassDead: 49,    // #78680b dry yellow-olive - 56% of built Brimhaven
  dirt: 63,         // #644e1e mid brown
  mud: 62,          // #3d2b0b dark brown - also the steep-slope material
  townEarth: 163,   // #1c1813 - 18.5% of built tiles vs 5.9% of open
  trackEarth: 64,   // #654d0b tex 510 - long thin runs, 75% of them away from buildings
  sand: 61,         // #d0c074 - 28% of open Brimhaven
  gravel: 95,       // #4b3e14
  stone: 54,        // #767676 - 19% of open Rimmington, the rocky coast
  snow: 25,         // #e6e6eb - the high ground above Catherby and Taverley
  path: 235,        // #35302d tex 928, blends - 96 components, mean span 33 tiles
  pathDirt: 187,    // #4e4329 tex 441, blends - the rougher track
  water: 111,       // #60769a
  rock: 81,         // #5c5444 - 17% of overlays on slopes above 10
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

/** Roles nobody has looked at for THIS cache - still on the surveyed default.
 *  Not wrong, just unreviewed: the defaults were measured from the real map,
 *  so they are a good starting point rather than a placeholder. */
export function unboundRoles(palette: GroundPalette): PaletteRole[] {
  return (Object.keys(ROLE_INFO) as PaletteRole[])
    .filter((r) => palette[r] === DEFAULT_PALETTE[r])
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
