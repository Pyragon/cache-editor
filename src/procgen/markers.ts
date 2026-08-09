/**
 * MARKER OBJECTS — the things the client never draws, and the mine must never
 * choose.
 *
 * ## What they are
 *
 * A handful of "objects" in the cache are not scenery at all. They are anchors:
 * ambient sound emitters, minimap map-icon and mapscene-sprite anchors, and
 * invisible barrier walls (the collision at a bridge edge). They carry a real
 * def, a real shape, a real rotation and a real model — but the model is a
 * degenerate quad painted entirely in a sentinel colour, and **the shipped
 * client simply never renders it**. There is no hide flag in the def or the
 * mesh; the colour IS the flag.
 *
 * `mapScene.ts` already knows this and has for a long time — it replaces their
 * quads with the floating teal/violet/red editor diamonds. The test is its
 * `isMarkerModel`, reproduced here rather than imported so procgen does not
 * depend on the renderer:
 *
 *   a model of 1-4 faces, EVERY face painted HSL16 29113 (teal) or 20287 (green).
 *
 * ## Why the mine has to care
 *
 * A barrier wall is shape 0 with a rotation, sits on a building's perimeter and
 * encloses interior space, so `observeBuildings` counted it as masonry and
 * `pickWallId` cheerfully built houses out of it. On screen those came out as
 * floating diamonds standing where a wall should be — Cody's "map anchors
 * placed as walls", and the cyan diamonds visible in the dock screenshot.
 *
 * The region filter (`worldAreas.ts`) did not touch this: barrier walls are all
 * over the OVERWORLD, because that is where bridges are.
 *
 * ## Why it is checked here and not from the def
 *
 * `mapCategoryId >= 0` / `mapSpriteId >= 0` are def-only tests and they
 * over-reach: a real anvil has a minimap sprite and is still an anvil. The only
 * honest test is what the client tests — the geometry. So this decodes the
 * models, but ONLY for the few hundred ids that actually reached a mined
 * vocabulary, never for all 73,913 objects.
 */

import { parseModel } from '../loaders/models'

/** Sentinel face colours. Teal = sound/icon anchors, green = barrier walls. */
const MARKER_HSLS = new Set([29113, 20287])
/** Above this, it is real geometry whatever it is painted. */
const MAX_MARKER_FACES = 4

/**
 * Decide, for each id, whether EVERY one of its models is a marker.
 *
 * "Every" rather than "any" is deliberate: an object may legitimately carry a
 * marker model alongside real geometry (161 models in this cache are a sentinel
 * face whose whole job is to anchor a particle emitter, and some of those hang
 * off objects that are otherwise perfectly real). Only an object that is
 * NOTHING BUT anchors is unusable as scenery.
 *
 * Unreadable or missing models count as "not a marker" — refusing to place an
 * object because its model failed to load would be a different bug wearing this
 * one's clothes.
 */
export async function findMarkerObjects(
  modelsDir: FileSystemDirectoryHandle | null | undefined,
  /** object id → the model ids its def lists, flattened across shapes */
  modelIdsOf: Map<number, number[]>,
  ids: Iterable<number>,
): Promise<Set<number>> {
  const markers = new Set<number>()
  if (!modelsDir) return markers

  /** model id → is it a marker mesh; decoded at most once each */
  const cache = new Map<number, boolean>()
  const isMarkerModel = async (modelId: number): Promise<boolean> => {
    const hit = cache.get(modelId)
    if (hit !== undefined) return hit
    let verdict = false
    try {
      // `models/<id>/model.dat`, NOT `models/<id>`. Each model is a FOLDER in
      // this dump. Getting this wrong is silent: every lookup throws, every
      // verdict falls back to "not a marker", and the filter reports a clean
      // pass while doing nothing at all — which is exactly what it did on the
      // first run, 0 hits out of 13,707 wall-capable objects.
      const sub = await modelsDir.getDirectoryHandle(String(modelId))
      const buf = await (await (await sub.getFileHandle('model.dat')).getFile()).arrayBuffer()
      const m = parseModel(new Uint8Array(buf), modelId)
      if (m.faceCount > 0 && m.faceCount <= MAX_MARKER_FACES) {
        verdict = true
        for (let f = 0; f < m.faceCount; f++) {
          if (!MARKER_HSLS.has(m.faceColor[f] & 0xffff)) { verdict = false; break }
        }
      }
    } catch { verdict = false }
    cache.set(modelId, verdict)
    return verdict
  }

  for (const id of ids) {
    const models = modelIdsOf.get(id)
    // No models listed at all is not evidence of a marker — it is evidence of
    // nothing, and the caller's other filters already handle unusable defs.
    if (!models?.length) continue
    let all = true
    for (const m of models) {
      if (!(await isMarkerModel(m))) { all = false; break }
    }
    if (all) markers.add(id)
  }
  return markers
}

/**
 * Strike every marker id out of the mined structural vocabularies.
 *
 * A family is dropped ENTIRELY if any of its members is a marker, rather than
 * having that member removed: a family is a co-occurrence set describing one
 * real building's masonry, and a set that included a barrier wall was never a
 * masonry style in the first place — it was a building with a bridge edge
 * running through it. Editing it down would leave a plausible-looking family
 * that no real building ever had.
 */
export function dropMarkerObjects(
  buildings: {
    families: { ids: number[] }[]
    parts: Record<number, unknown>
    doors: { id: number }[]
    furniture: { id: number }[]
  },
  docks: {
    families: { ids: number[] }[]
    parts: Record<number, unknown>
    trim: { id: number }[]
  },
  markers: Set<number>,
) {
  if (!markers.size) return
  buildings.families = buildings.families.filter((f) => !f.ids.some((id) => markers.has(id)))
  buildings.doors = buildings.doors.filter((d) => !markers.has(d.id))
  buildings.furniture = buildings.furniture.filter((e) => !markers.has(e.id))
  docks.families = docks.families.filter((f) => !f.ids.some((id) => markers.has(id)))
  docks.trim = docks.trim.filter((t) => !markers.has(t.id))
  for (const id of markers) {
    delete buildings.parts[id]
    delete docks.parts[id]
  }
}

/** Flatten a def's `objectModelIds`, which is per-shape and may be ragged. */
export function flattenModelIds(raw: unknown): number[] {
  const out: number[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'number') { out.push(v); return }
    if (Array.isArray(v)) for (const e of v) walk(e)
  }
  walk(raw)
  return out
}
