import type { CutsceneDef } from '../loaders/cutscenes'
import { createRegionDef, decodeTerrain, tileIndex } from '../loaders/maps'
import type { MapRegionDef, MapTerrain } from '../loaders/maps'
import { calculateTileHeight } from './mapScene'

// Assembles the cutscene's scene the way the client does (MapRegion's cutscene
// branch): each CutsceneArea copies a w×l block of 8-tile chunks from a live
// map region into the scene at chunkBase, on the same plane. Every area in the
// shipped cache uses rotation 0 and an identity plane mapping (verified across
// all 16 cutscenes), so chunk rotation isn't implemented here — an area with a
// rotation is copied unrotated and reported via `warnings`.
//
// The result is a 2×2 grid of synthetic regions (128×128 tiles — the real
// scene is 104×104, chunk coords are small) that the existing SceneMosaic /
// buildTerrainMesh / buildLocsMesh pipeline consumes unchanged.

export type CutsceneSceneCell = {
  /** Scene-region coords (0 or 1 on each axis). */
  rx: number
  ry: number
  def: MapRegionDef
  terrain: MapTerrain
}

export type CutsceneScene = {
  cells: CutsceneSceneCell[]
  warnings: string[]
}

/** Effective source height delta byte for one tile+plane, replicating the
 *  computeHeights rules: explicit value when present, else the plane-0 Perlin
 *  fallback at SOURCE world coords (the client decodes chunks from the source
 *  region stream, so its fallback also uses source coords) or the fixed 960
 *  (=30) upper-plane spacing. */
function effectiveHeightByte(src: MapTerrain, plane: number, x: number, y: number, srcAbsX: number, srcAbsY: number): number {
  const idx = tileIndex(plane, x, y)
  const present = (src.heightPresence[idx >> 3] & (1 << (idx & 0x7))) !== 0
  if (present) return src.heightValue[idx] & 0xff || 1
  if (plane === 0) {
    const v = calculateTileHeight(srcAbsX + 932731, srcAbsY + 556238)
    return v === 0 ? 1 : v & 0xff
  }
  return 30
}

export async function assembleCutsceneScene(
  def: CutsceneDef,
  mapsDir: FileSystemDirectoryHandle,
): Promise<CutsceneScene> {
  const warnings: string[] = []

  // Synthetic 2×2 destination grid.
  const cells: CutsceneSceneCell[] = []
  for (let rx = 0; rx < 2; rx++) {
    for (let ry = 0; ry < 2; ry++) {
      const regionDef = createRegionDef(rx, ry)
      cells.push({ rx, ry, def: regionDef, terrain: decodeTerrain(regionDef) })
    }
  }
  const cellAt = (rx: number, ry: number) => cells.find((c) => c.rx === rx && c.ry === ry) ?? null

  // Source regions, loaded once each.
  const srcCache = new Map<number, Promise<{ def: MapRegionDef; terrain: MapTerrain } | null>>()
  const loadSrc = (regionId: number) => {
    let p = srcCache.get(regionId)
    if (!p) {
      p = (async () => {
        try {
          const file = await (await mapsDir.getFileHandle(`${regionId}.json`)).getFile()
          const regionDef = JSON.parse(await file.text()) as MapRegionDef
          return { def: regionDef, terrain: decodeTerrain(regionDef) }
        } catch {
          return null
        }
      })()
      srcCache.set(regionId, p)
    }
    return p
  }

  for (const area of def.areas) {
    if (area.rotation !== 0) {
      warnings.push(`area rotation ${area.rotation} isn't simulated (copied unrotated)`) // not in any shipped cutscene
    }
    // Source: tile coords → global chunk coords.
    const srcChunkX = area.regionX >> 3
    const srcChunkY = area.regionY >> 3
    for (let cx = 0; cx < area.width; cx++) {
      for (let cy = 0; cy < area.length; cy++) {
        const gChunkX = srcChunkX + cx
        const gChunkY = srcChunkY + cy
        const srcRegionId = ((gChunkX >> 3) << 8) | (gChunkY >> 3)
        const src = await loadSrc(srcRegionId)
        if (!src) {
          warnings.push(`source region ${srcRegionId} isn't in the dump`)
          continue
        }
        const srcTileX = (gChunkX & 0x7) * 8
        const srcTileY = (gChunkY & 0x7) * 8

        // Destination: scene chunk → synthetic region + tile base.
        const dstChunkX = area.chunkBaseX + cx
        const dstChunkY = area.chunkBaseY + cy
        const cell = cellAt(dstChunkX >> 3, dstChunkY >> 3)
        if (!cell) {
          warnings.push(`dest chunk ${dstChunkX},${dstChunkY} is outside the 2x2 scene grid`)
          continue
        }
        const dstTileX = (dstChunkX & 0x7) * 8
        const dstTileY = (dstChunkY & 0x7) * 8
        const srcPlane = area.plane
        const dstPlane = area.cutscenePlane

        for (let tx = 0; tx < 8; tx++) {
          for (let ty = 0; ty < 8; ty++) {
            const sIdx = tileIndex(srcPlane, srcTileX + tx, srcTileY + ty)
            const dIdx = tileIndex(dstPlane, dstTileX + tx, dstTileY + ty)
            cell.terrain.underlayIds[dIdx] = src.terrain.underlayIds[sIdx]
            cell.terrain.overlayIds[dIdx] = src.terrain.overlayIds[sIdx]
            cell.terrain.overlayShapeRot[dIdx] = src.terrain.overlayShapeRot[sIdx]
            cell.terrain.tileFlags[dIdx] = src.terrain.tileFlags[sIdx]
            // Heights become explicit at the destination so the Perlin fallback
            // (which is world-coordinate-based) can't re-derive them wrongly.
            cell.terrain.heightValue[dIdx] = effectiveHeightByte(
              src.terrain, srcPlane, srcTileX + tx, srcTileY + ty,
              (srcRegionId >> 8) * 64 + srcTileX + tx, (srcRegionId & 0xff) * 64 + srcTileY + ty,
            )
            cell.terrain.heightPresence[dIdx >> 3] |= 1 << (dIdx & 0x7)
          }
        }

        // Locations inside the source chunk move with it.
        for (const [objectId, type, rotation, x, y, plane] of src.def.objects) {
          if (plane !== srcPlane) continue
          if (x < srcTileX || x >= srcTileX + 8 || y < srcTileY || y >= srcTileY + 8) continue
          cell.def.objects.push([objectId, type, rotation, dstTileX + (x - srcTileX), dstTileY + (y - srcTileY), dstPlane])
        }
      }
    }
  }

  for (const cell of cells) cell.def.hasLocations = cell.def.objects.length > 0
  return { cells, warnings }
}
