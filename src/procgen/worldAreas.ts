/**
 * WHICH REGIONS ARE THE ACTUAL GAME WORLD — from the cache's own world map.
 *
 * ## The bug this exists to kill
 *
 * Every mined vocabulary in this folder — scenery frequency, the context model,
 * the archetype signatures, the dock families, the wall families and doors —
 * was learned by walking **every region file in `maps/`**, all 2,413 of them,
 * with no filter whatsoever. A cache dump is not a game world: it is the game
 * world plus every dungeon, cave, minigame arena, tutorial cellar, holiday
 * event and test area ever built, and the mine treated them all as equally
 * representative of "what the map does".
 *
 * The result was exactly as bad as that sounds. Measured 2026-08-09 against
 * this cache, with regions classified by the areas below:
 *
 * - **Door 3626** ("Wall", with an Open option) has **1,459 placements in ONE
 *   region** — 11591, which is not surface and not any named dungeon. Nothing
 *   else comes close, so `pickDoorId`, which weighted by raw placement count,
 *   handed it to roughly every building synthesised. It has **zero** placements
 *   anywhere on the RuneScape surface.
 * - **Every one of the top 20 dock deck candidates had zero surface presence.**
 *   The commonest, 27639, is 29,677 placements across 9 non-surface regions.
 *   The ids that `docks.ts` names as real piers — 2759, 9453, 9454, 64496 —
 *   were being outvoted by two orders of magnitude, which is why a jetty came
 *   out as red slabs and a map-link anchor.
 * - The wall families were mostly dungeon masonry, which is why houses on a
 *   green coast were built out of cave brick.
 *
 * ## Why this file and not a coordinate rule
 *
 * The obvious hack is "underground is worldY >= 9216". It is also wrong: the
 * measurement above puts non-surface content at region Y 64-111 as well, which
 * is nowhere near that band, and it would have to be re-guessed for every cache
 * revision. The cache already ships the answer. `map_areas/` is the world map's
 * own definition of what exists and where, one entry per named area, and one of
 * them is literally called **"RuneScape Surface"**.
 *
 * ## Underground areas are CLASSIFIED, not discarded
 *
 * `areaOf` keeps the mapping for every region a named area claims, so "mine the
 * vocabulary of Taverley Dungeon" is a filter swap rather than a rewrite. The
 * surface restriction is the default because that is what a fishing village is
 * made of; it is not a statement that the rest is worthless.
 */

export type WorldArea = {
  id: number
  name: string
  /** region ids this area's rects cover */
  regions: number[]
}

export type WorldAreaMap = {
  /** the RuneScape Surface region set — the default mining corpus */
  surface: Set<number>
  /** every named area, surface included, for mining somewhere else later */
  areas: WorldArea[]
  /** region id → the non-surface area that claims it, if any */
  areaOf: Map<number, { id: number; name: string }>
}

/**
 * A world-map area as cryogen dumps it.
 *
 * `startX/startY/endX/endY` are the rect's REAL world tile coords; `mapMin*`
 * is where the world map draws it, and the two differ for areas that are
 * displayed somewhere other than where their data lives. Region classification
 * wants the real coords — the displayed ones would file a dungeon under the
 * town it appears beneath.
 */
type AreaRect = { startX: number; startY: number; endX: number; endY: number }
type AreaFile = { id?: number; areaName?: string; areaRects?: AreaRect[] }

/** The world map's own name for the overworld. */
const SURFACE_NAME = 'runescape surface'

const regionsOfRects = (rects: AreaRect[] | undefined): number[] => {
  const s = new Set<number>()
  for (const r of rects ?? []) {
    // A rect can be stored either way round; normalise rather than trusting it.
    const x0 = Math.min(r.startX, r.endX) >> 6, x1 = Math.max(r.startX, r.endX) >> 6
    const y0 = Math.min(r.startY, r.endY) >> 6, y1 = Math.max(r.startY, r.endY) >> 6
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) s.add((x << 8) | y)
  }
  return [...s]
}

/**
 * Read `map_areas/` and work out which regions are the overworld.
 *
 * Returns null when the folder is missing or carries no usable rects, and the
 * caller must then mine unfiltered and SAY SO — silently falling back to "all
 * 2,413 regions" is precisely the behaviour that produced the doors and decks
 * described at the top of this file.
 */
export async function loadWorldAreas(
  dir: FileSystemDirectoryHandle | null | undefined,
): Promise<WorldAreaMap | null> {
  if (!dir) return null
  const areas: WorldArea[] = []
  try {
    for await (const h of dir.values()) {
      if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
      try {
        const text = await (await (h as FileSystemFileHandle).getFile()).text()
        const a = JSON.parse(text) as AreaFile
        const regions = regionsOfRects(a.areaRects)
        if (!regions.length) continue
        areas.push({ id: a.id ?? -1, name: a.areaName ?? '', regions })
      } catch { /* unreadable area — skip */ }
    }
  } catch { return null }
  if (!areas.length) return null

  // By name, because an id is a dump-order accident. The fallback is the
  // largest area by region count, which the surface wins by an order of
  // magnitude (734 regions against 23 for the next biggest) — but only as a
  // fallback, since a cache with no surface entry at all would otherwise
  // silently crown a dungeon.
  let surfaceArea = areas.find((a) => a.name.trim().toLowerCase() === SURFACE_NAME)
  if (!surfaceArea) {
    surfaceArea = areas.reduce((best, a) => (a.regions.length > best.regions.length ? a : best), areas[0])
  }
  const surface = new Set(surfaceArea.regions)

  const areaOf = new Map<number, { id: number; name: string }>()
  for (const a of areas) {
    if (a === surfaceArea) continue
    for (const r of a.regions) if (!areaOf.has(r)) areaOf.set(r, { id: a.id, name: a.name })
  }
  return { surface, areas, areaOf }
}

/**
 * What a region is, for reporting. `unclaimed` is its own answer rather than
 * being folded into `dungeon`: 1,622 on-disk regions are claimed by no world
 * map area at all, and calling them dungeons would be a guess. They are
 * excluded from mining for the same reason dungeons are — nothing says they
 * are the overworld — but the honest label is "the world map does not list it".
 */
export function classifyRegion(
  map: WorldAreaMap | null, rid: number,
): 'surface' | 'named-area' | 'unclaimed' | 'unknown' {
  if (!map) return 'unknown'
  if (map.surface.has(rid)) return 'surface'
  return map.areaOf.has(rid) ? 'named-area' : 'unclaimed'
}
