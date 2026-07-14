import { loadGlyphsFromSprites } from '../loaders/font_metrics'
import type { FontMetricsDef } from '../loaders/font_metrics'

// Shared cache-font text rendering, so previews (hitsplats, and anything else
// that draws in-game text) use the real font instead of a web-font stand-in.
//
// A font is two halves keyed by one file id: the metrics (advance widths, line
// height) in fonts/metrics/<id>.json, and the glyph bitmaps. The client reads
// those glyphs from either the dedicated font index or the sprites index (see
// darkan ClientStartup, which builds FontCombo from Resource.FONT in one stage
// and Resource.SPRITES in another) — in practice the fonts the game uses live
// in sprites/<id>/.
export type CacheFont = {
  id: number
  metrics: FontMetricsDef
  glyphs: Map<number, ImageBitmap>
}

const fontCache = new Map<number, Promise<CacheFont | null>>()

export function loadCacheFont(
  rootHandle: FileSystemDirectoryHandle,
  fontId: number,
): Promise<CacheFont | null> {
  const cached = fontCache.get(fontId)
  if (cached) return cached

  const promise = (async (): Promise<CacheFont | null> => {
    try {
      const fontsDir = await rootHandle.getDirectoryHandle('fonts')
      const metricsDir = await fontsDir.getDirectoryHandle('metrics')
      const file = await (await metricsDir.getFileHandle(`${fontId}.json`)).getFile()
      const metrics = JSON.parse(await file.text()) as FontMetricsDef

      const blobs = await loadGlyphsFromSprites(rootHandle, fontId)
      if (blobs.size === 0) return null

      const glyphs = new Map<number, ImageBitmap>()
      await Promise.all([...blobs.entries()].map(async ([code, blob]) => {
        glyphs.set(code, await createImageBitmap(blob))
      }))

      return { id: fontId, metrics, glyphs }
    } catch {
      return null
    }
  })()

  fontCache.set(fontId, promise)
  return promise
}

// Advance-width sum — the client's own text measurement.
export function measureCacheText(font: CacheFont, text: string): number {
  const widths = font.metrics.glyphWidths ?? []
  let width = 0
  for (const ch of text) width += widths[ch.charCodeAt(0)] ?? 0
  return width
}

export function cacheTextHeight(font: CacheFont): number {
  let tallest = 0
  for (const bitmap of font.glyphs.values()) {
    if (bitmap.height > tallest) tallest = bitmap.height
  }
  return Math.max(tallest, font.metrics.verticalSpacing || 12)
}

// Draws text with `x` as the LEFT edge and `y` as the TOP of the glyph line.
// The glyph bitmaps are masks, so the whole run is tinted afterwards.
export function drawCacheText(
  ctx: CanvasRenderingContext2D,
  font: CacheFont,
  text: string,
  x: number,
  y: number,
  color: string,
) {
  const widths = font.metrics.glyphWidths ?? []
  const width = measureCacheText(font, text)
  const height = cacheTextHeight(font)
  if (width <= 0 || height <= 0) return

  // Tinting has to happen off-screen: 'source-in' against the live canvas would
  // wipe everything already drawn (the splat sprites underneath).
  const layer = document.createElement('canvas')
  layer.width = width
  layer.height = height
  const layerCtx = layer.getContext('2d')!

  let penX = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    const bitmap = font.glyphs.get(code)
    if (bitmap && bitmap.width > 0) {
      try {
        layerCtx.drawImage(bitmap, penX, 0)
      } catch {
        // detached bitmap — skip this glyph
      }
    }
    penX += widths[code] ?? 0
  }

  layerCtx.globalCompositeOperation = 'source-in'
  layerCtx.fillStyle = color
  layerCtx.fillRect(0, 0, width, height)

  ctx.drawImage(layer, Math.round(x), Math.round(y))
}
