import { loadTextureDef, loadTexturePng } from '../loaders/textures'
import type { ModelDisplayParams } from './ModelViewer'

// Shared helpers for posing an item's model the way the client draws its
// inventory icon — used by the items page, the App-level preview modal and
// the BAS viewer's item-row preview. Lives outside the component files so
// fast refresh keeps working there.

/** An item's inventory-icon display params (defaults per client
 *  ItemDefinitions — zoom 2000, resize 128). Takes a raw def record so
 *  callers holding an unparsed item JSON can build the same pose. */
export function itemIconDisplayParams(def: Record<string, unknown>, label: string): ModelDisplayParams {
  return {
    label,
    zoom: Number(def.modelZoom ?? 2000) || 2000,
    rotationX: Number(def.modelRotationX ?? 0),
    rotationY: Number(def.modelRotationY ?? 0),
    rotationZ: Number(def.modelRotationZ ?? 0),
    offsetX: Number(def.modelOffsetX ?? 0),
    offsetY: Number(def.modelOffsetY ?? 0),
    resizeX: Number(def.resizeX ?? 128) || 128,
    resizeY: Number(def.resizeY ?? 128) || 128,
    resizeZ: Number(def.resizeZ ?? 128) || 128,
    ambient: Number(def.ambient ?? 0),
    contrast: Number(def.contrast ?? 0),
    recolorFrom: (def.originalModelColours as number[] | undefined) ?? [],
    recolorTo: (def.modifiedModelColours as number[] | undefined) ?? [],
    retextureFrom: (def.originalTextureIds as number[] | undefined) ?? [],
    retextureTo: (def.modifiedTextureIds as number[] | undefined) ?? [],
  }
}

/** Fetch the rendered PNGs (and scroll speeds) for a display's texture-swap
 *  targets — they aren't among the textures the model's own loader fetches,
 *  since the mesh itself doesn't reference them. */
export async function resolveRetextureAssets(
  cacheRoot: FileSystemDirectoryHandle,
  display: ModelDisplayParams,
): Promise<ModelDisplayParams> {
  if (display.retextureTo.length === 0) return display
  const blobs = new Map<number, Blob>()
  const speeds = new Map<number, { u: number; v: number }>()
  try {
    const texturesDir = await cacheRoot.getDirectoryHandle('textures')
    await Promise.all(display.retextureTo.map(async (texId) => {
      const png = await loadTexturePng(texturesDir, texId)
      if (png) blobs.set(texId, png)
    }))
  } catch { /* textures not dumped — swapped faces fall back to flat colour */ }
  try {
    const defsDir = await cacheRoot.getDirectoryHandle('texture_definitions')
    await Promise.all(display.retextureTo.map(async (texId) => {
      const def = await loadTextureDef(defsDir, texId)
      if (def && (def.textureSpeedU !== 0 || def.textureSpeedV !== 0)) {
        speeds.set(texId, { u: def.textureSpeedU, v: def.textureSpeedV })
      }
    }))
  } catch { /* no definitions dumped — swapped textures stay still */ }
  return { ...display, retextureBlobs: blobs, retextureSpeeds: speeds }
}
