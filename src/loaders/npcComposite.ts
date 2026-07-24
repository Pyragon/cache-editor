import { getEntryPath, resolveEntryHandle } from './entryOrder'
import { getLoader } from './index'
import { applyRecolor, mergeModels } from './models'
import type { ModelData } from './models'

// Assembling "the model the client actually renders" from a def: load the
// part models, nudge each by its translation, merge, recolour/retexture,
// scale (v·s >> 7) and tint (per-face HSL16 blend by opacity/128) — the same
// order the client composes in. Shared by the model preview modal and the
// NPC snapshot icons.

export type ModelCompositeSpec = {
  modelIds: number[]
  /** Per-model [x, y, z] vertex nudges, paired positionally with modelIds. */
  translations?: (number[] | null)[]
  recolor?: { from?: number[]; to?: number[]; textureFrom?: number[]; textureTo?: number[] }
  /** 128 = unscaled (NPCs share one value for x/z; objects scale each axis). */
  scale?: { x: number; y: number; z: number }
  /** Ignored when opacity is 0; −1 components leave that channel untouched. */
  tint?: { hue: number; saturation: number; lightness: number; opacity: number }
  /** Hide faces whose corners all carry skin label 255. Those are static
   *  markers no skeleton addresses (bases label up to ~101) — e.g. baby
   *  impling model 26367's stacked green quads, confirmed invisible in-game
   *  despite carrying no alpha/render-type/particle data. Set for NPC
   *  composites; left off for items, where unbound verts may be routine. */
  hideMarkerFaces?: boolean
}

/** The composite spec an NPC def describes (works on a raw def record). */
export function npcCompositeSpec(def: Record<string, unknown>): ModelCompositeSpec {
  const modelIds = (def.modelIds as number[] | undefined) ?? []
  const translations = (def.modelTranslation as (number[] | null)[] | undefined) ?? []
  return {
    hideMarkerFaces: true,
    modelIds: [...modelIds],
    translations: modelIds.map((_, i) => translations[i] ?? null),
    recolor: {
      from: def.originalColors as number[] | undefined,
      to: def.modifiedColors as number[] | undefined,
      textureFrom: def.originalTextures as number[] | undefined,
      textureTo: def.modifiedTextures as number[] | undefined,
    },
    scale: {
      x: Number(def.scaleXZ ?? 128) || 128,
      y: Number(def.scaleY ?? 128) || 128,
      z: Number(def.scaleXZ ?? 128) || 128,
    },
    tint: {
      hue: Number(def.tintHue ?? 0),
      saturation: Number(def.tintSaturation ?? 0),
      lightness: Number(def.tintLightness ?? 0),
      opacity: Number(def.tintOpacity ?? 0),
    },
  }
}

/** The composite spec an OBJECT def describes: the model list of its shape-10
 *  row (centrepiece scenery) or the first shape row, with the def's
 *  recolours, per-axis scale and tint. */
export function objectCompositeSpec(def: Record<string, unknown>): ModelCompositeSpec {
  const shapes = (def.shapes as number[] | undefined) ?? []
  const modelLists = (def.objectModelIds as number[][] | undefined) ?? []
  let shapeIndex = shapes.indexOf(10)
  if (shapeIndex < 0) shapeIndex = 0
  return {
    hideMarkerFaces: true,
    modelIds: [...(modelLists[shapeIndex] ?? [])],
    recolor: {
      from: def.originalColors as number[] | undefined,
      to: def.modifiedColors as number[] | undefined,
      textureFrom: def.originalTextures as number[] | undefined,
      textureTo: def.modifiedTextures as number[] | undefined,
    },
    scale: {
      x: Number(def.scaleX ?? 128) || 128,
      y: Number(def.scaleY ?? 128) || 128,
      z: Number(def.scaleZ ?? 128) || 128,
    },
    tint: {
      hue: Number(def.tintHue ?? 0),
      saturation: Number(def.tintSaturation ?? 0),
      lightness: Number(def.tintLightness ?? 0),
      opacity: Number(def.tintOpacity ?? 0),
    },
  }
}

/** Load and compose; throws when the models entry or a part is unreadable. */
export async function loadModelComposite(
  cacheRoot: FileSystemDirectoryHandle,
  spec: ModelCompositeSpec,
): Promise<ModelData> {
  const dir = await resolveEntryHandle(cacheRoot, getEntryPath('models'))
  const loader = getLoader('models')
  if (!dir || !loader) throw new Error('models entry not available')

  const parts = await Promise.all(spec.modelIds.map((id) =>
    loader.loadItem(dir, { id, name: `${id}` }, cacheRoot) as Promise<ModelData>,
  ))

  // Each part is a fresh load, so mutating it in place is safe.
  parts.forEach((part, i) => {
    // Pre-v13 meshes are stored at 1× — the client upscales them (<<2,
    // Mesh.upscale) BEFORE translating/animating (NPCType.kt does this for
    // both body and head models), and animation deltas + def translations
    // are in that upscaled space. Skipping this made old-format chatheads
    // animate with 4×-too-strong translations (the gaping-jaw bug). Marked
    // v13 afterwards so renderers don't apply their own ×4 again.
    if (part.version < 13) {
      for (let v = 0; v < part.vertexCount; v++) {
        part.vertexX[v] <<= 2
        part.vertexY[v] <<= 2
        part.vertexZ[v] <<= 2
      }
      part.version = 13
    }
    const t = spec.translations?.[i]
    if (!t) return
    for (let v = 0; v < part.vertexCount; v++) {
      part.vertexX[v] += t[0] ?? 0
      part.vertexY[v] += t[1] ?? 0
      part.vertexZ[v] += t[2] ?? 0
    }
  })

  const merged = parts.length === 1 ? parts[0] : mergeModels(parts)

  const { recolor, scale, tint } = spec
  if (recolor && ((recolor.from?.length ?? 0) > 0 || (recolor.textureFrom?.length ?? 0) > 0)) {
    applyRecolor(merged, recolor.from ?? [], recolor.to ?? [], recolor.textureFrom ?? [], recolor.textureTo ?? [])
  }

  // applyRecolor may retexture faces onto materials the base parts never loaded
  // (a tree swapping its leaf detail texture) — the parts' loadItem only fetched
  // PNGs for the ORIGINAL faceTextures, so pull any now-referenced-but-missing
  // material PNGs (and scroll speeds) into the merged maps, else those faces fall
  // back to flat colour (the "leaves are green blobs" bug).
  if (merged.faceTextures) {
    const missing = new Set<number>()
    for (const id of merged.faceTextures) if (id >= 0 && !merged.textures.has(id)) missing.add(id)
    if (missing.size > 0) {
      let texturesDir: FileSystemDirectoryHandle | null = null
      let defsDir: FileSystemDirectoryHandle | null = null
      try { texturesDir = await cacheRoot.getDirectoryHandle('textures') } catch { /* not dumped */ }
      try { defsDir = await cacheRoot.getDirectoryHandle('texture_definitions') } catch { /* not dumped */ }
      await Promise.all([...missing].map(async (id) => {
        if (texturesDir) {
          try {
            const dir = await texturesDir.getDirectoryHandle(String(id))
            merged.textures.set(id, await (await dir.getFileHandle(`${id}.png`)).getFile())
          } catch { /* missing texture — flat fallback */ }
        }
        if (defsDir) {
          try {
            const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
            const def = JSON.parse(await file.text())
            const u = def.textureSpeedU ?? 0, v = def.textureSpeedV ?? 0
            if (u !== 0 || v !== 0) merged.textureSpeeds.set(id, { u, v })
          } catch { /* no definition */ }
        }
      }))
    }
  }

  // Client Model.scale: v · scale >> 7 per axis.
  if (scale && (scale.x !== 128 || scale.y !== 128 || scale.z !== 128)) {
    for (let v = 0; v < merged.vertexCount; v++) {
      merged.vertexX[v] = (merged.vertexX[v] * scale.x) >> 7
      merged.vertexY[v] = (merged.vertexY[v] * scale.y) >> 7
      merged.vertexZ[v] = (merged.vertexZ[v] * scale.z) >> 7
    }
  }

  // Static marker faces (all corners skin 255): hide them the same way the
  // client hides invisible faces — alpha −1, which every renderer here
  // (ModelViewer, the snapshot) already skips.
  if (spec.hideMarkerFaces && merged.vertexSkins) {
    const skins = merged.vertexSkins
    for (let f = 0; f < merged.faceCount; f++) {
      if (skins[merged.triangleX[f]] === 255 && skins[merged.triangleY[f]] === 255 && skins[merged.triangleZ[f]] === 255) {
        merged.faceAlpha[f] = -1
      }
    }
  }

  // Client ModelSM.tint: per-face HSL16 components step toward the tint by
  // opacity/128; −1 leaves a channel untouched.
  if (tint && (tint.opacity & 0xff) !== 0) {
    const opacity = tint.opacity & 0xff
    for (let f = 0; f < merged.faceCount; f++) {
      const hsl = merged.faceColor[f] & 0xffff
      let h = (hsl >> 10) & 0x3f
      let s = (hsl >> 7) & 0x7
      let l = hsl & 0x7f
      if (tint.hue !== -1) h += (opacity * (tint.hue - h)) >> 7
      if (tint.saturation !== -1) s += (opacity * (tint.saturation - s)) >> 7
      if (tint.lightness !== -1) l += (opacity * (tint.lightness - l)) >> 7
      merged.faceColor[f] = (h << 10) | (s << 7) | l
    }
  }

  return merged
}
