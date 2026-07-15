import { useEffect, useState } from 'react'
import type { MaterialDefinition, TextureDefinition } from '../loaders/textures'
import { loadMaterial, loadTextureDef } from '../loaders/textures'
import { renderMaterial, renderMaterialRgb, unsupportedOps } from '../loaders/textureRender'
import type { RenderDeps } from '../loaders/textureRender'
import { loadSpriteMeta, renderFrameToCanvas } from './spriteRender'

export type PreviewState =
  | { status: 'rendered'; pixels: ImageData }
  | { status: 'unsupported'; ops: number[] }
  | { status: 'error'; message: string }
  | { status: 'loading' }

// Every material reachable through op 36, so the support check can see into them.
async function loadNested(
  material: MaterialDefinition,
  texturesDir: FileSystemDirectoryHandle,
  found = new Map<number, MaterialDefinition>(),
): Promise<Map<number, MaterialDefinition>> {
  for (const op of material.textureOperations ?? []) {
    if (op.type !== 36) continue
    const id = typeof op.materialId === 'number' ? op.materialId : -1
    if (id < 0 || found.has(id)) continue

    const nested = await loadMaterial(texturesDir, id)
    if (!nested) continue
    found.set(id, nested)
    await loadNested(nested, texturesDir, found)
  }
  return found
}

// Materials can sample sprites and nest other materials, so a preview needs those
// resolved before it can render. They're pulled once per texture and cached.
async function collectDeps(
  material: MaterialDefinition,
  texturesDir: FileSystemDirectoryHandle,
  defsDir: FileSystemDirectoryHandle | null,
  spritesDir: FileSystemDirectoryHandle | null,
): Promise<RenderDeps> {
  const sprites = new Map<number, { pixels: Int32Array; width: number; height: number } | null>()
  const materials = new Map<number, { pixels: Int32Array; width: number; height: number } | null>()

  const spriteIds = new Set<number>()
  const materialIds = new Set<number>()
  for (const op of material.textureOperations ?? []) {
    if (op.type === 39 || op.type === 18) spriteIds.add(Number(op.spriteId ?? -1))
    if (op.type === 36) materialIds.add(Number(op.materialId ?? -1))
  }

  for (const id of spriteIds) {
    if (id < 0 || !spritesDir) {
      sprites.set(id, null)
      continue
    }
    try {
      const meta = await loadSpriteMeta(spritesDir, id)
      if (!meta || meta.width <= 0) {
        sprites.set(id, null)
        continue
      }
      const canvas = renderFrameToCanvas(meta)
      if (!canvas) {
        sprites.set(id, null)
        continue
      }
      const ctx = canvas.getContext('2d')!
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const pixels = new Int32Array(canvas.width * canvas.height)
      for (let p = 0; p < pixels.length; p++) {
        pixels[p] = (data.data[p * 4] << 16) | (data.data[p * 4 + 1] << 8) | data.data[p * 4 + 2]
      }
      sprites.set(id, { pixels, width: canvas.width, height: canvas.height })
    } catch {
      sprites.set(id, null)
    }
  }

  const deps: RenderDeps = {
    sprite: (id) => sprites.get(id) ?? null,
    material: (id) => materials.get(id) ?? null,
  }

  for (const id of materialIds) {
    if (id < 0) {
      materials.set(id, null)
      continue
    }
    try {
      const nested = await loadMaterial(texturesDir, id)
      const def: TextureDefinition | null = defsDir ? await loadTextureDef(defsDir, id) : null
      if (!nested || unsupportedOps(nested).length) {
        materials.set(id, null)
        continue
      }
      const size = def?.isHalfSize ? 64 : 128
      // nested materials are sampled through getPixelsRgb: gamma 1.0, and
      // transposed when the nested material is a brick tile
      const pixels = renderMaterialRgb(nested, size, deps, 1.0, Boolean(def?.isBrickTile))
      materials.set(id, { pixels, width: size, height: size })
    } catch {
      materials.set(id, null)
    }
  }

  return deps
}

/** Re-renders the material whenever the draft graph changes. */
export function useTexturePreview(
  material: MaterialDefinition | null,
  def: TextureDefinition | null,
  texturesDir: FileSystemDirectoryHandle | null,
  defsDir: FileSystemDirectoryHandle | null,
  spritesDir: FileSystemDirectoryHandle | null,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })

  // The graph is the only thing that changes as you edit, so key the work on it.
  const key = material ? JSON.stringify(material) : ''

  useEffect(() => {
    let cancelled = false

    if (!material || !texturesDir) {
      setState({ status: 'error', message: 'No op graph loaded for this texture.' })
      return
    }

    // Evaluating the graph for a 128x128 tile is milliseconds of work, but dragging
    // in the colour picker fires a change for every colour it passes through, and
    // rendering each one made the drag crawl. Coalesce those into one render once
    // the value settles — fast enough to still feel live.
    const timer = setTimeout(run, 80)

    async function run() {
      try {
        // Nested materials have to be resolved BEFORE the support check: a texture
        // whose nested material uses an op we can't evaluate must fall back to the
        // dumped PNG, not render as a black square.
        const nested = await loadNested(material!, texturesDir!)
        if (cancelled) return

        const missing = unsupportedOps(material!, (id) => nested.get(id) ?? null)
        if (missing.length) {
          setState({ status: 'unsupported', ops: missing })
          return
        }

        const deps = await collectDeps(material!, texturesDir!, defsDir, spritesDir)
        if (cancelled) return

        const size = def?.isHalfSize ? 64 : 128
        const argb = renderMaterial(material!, size, deps, 0.7)

        const image = new ImageData(size, size)
        for (let p = 0; p < argb.length; p++) {
          const v = argb[p]
          image.data[p * 4] = (v >> 16) & 0xff
          image.data[p * 4 + 1] = (v >> 8) & 0xff
          image.data[p * 4 + 2] = v & 0xff
          image.data[p * 4 + 3] = (v >>> 24) & 0xff
        }
        if (!cancelled) setState({ status: 'rendered', pixels: image })
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, def?.isHalfSize, texturesDir, defsDir, spritesDir])

  return state
}
