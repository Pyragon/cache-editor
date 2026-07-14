import type { SpriteMeta } from '../loaders/sprites'
import type { FontMetricsDef } from '../loaders/font_metrics'

// Rasterises an uploaded TTF/OTF into the cache's font shape: a 256-frame
// sprite archive (one bitmap per cp1252 character code) plus a metrics file
// (advance widths + line height).
//
// A TTF/OTF is a superset of what the cache stores — vector outlines, a
// Unicode cmap, per-glyph advances, ascent/descent, kerning. The cache font is
// bitmaps at ONE pixel size, indexed by a flat 256-entry cp1252 table, with no
// kerning (none of the 27 cache fonts set variadicWidth). So the conversion
// bakes a size and drops everything the format can't express.
//
// Browsers rasterise font files natively via the FontFace API, so no outline
// parsing is needed here.

// cp1252 differs from latin-1 only in 0x80-0x9F; those map to these codepoints.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

function charForCode(code: number): string | null {
  if (code < 32) return null                 // control codes have no glyph
  if (code < 0x80) return String.fromCharCode(code)
  const mapped = CP1252_HIGH[code]
  if (mapped) return String.fromCodePoint(mapped)
  if (code >= 0xa0) return String.fromCharCode(code) // latin-1 range
  return null
}

export type ImportOptions = {
  pixelSize: number
  bold: boolean
  // Off by default: cache fonts are hand-pixelled, and antialiasing at these
  // tiny sizes reads as mush. When off, coverage above the threshold becomes a
  // solid pixel.
  antialias: boolean
  threshold: number   // 0-255, only used when antialias is off
}

export type ImportedFont = {
  meta: SpriteMeta
  metrics: FontMetricsDef
  // Per-character preview + diagnostics for the UI.
  glyphCount: number
  emptyCodes: number[]
}

export const DEFAULT_IMPORT: ImportOptions = {
  pixelSize: 12,
  bold: false,
  antialias: false,
  threshold: 128,
}

// Loads the uploaded file as a usable font family. SECURITY: the file is only
// ever handed to the browser's font rasteriser as bytes — never executed,
// evaluated, or written to disk. The FontFace is removed again afterwards.
export async function loadFontFace(file: File): Promise<{ family: string; release: () => void }> {
  const family = `cache-editor-import-${Date.now()}`
  const face = new FontFace(family, await file.arrayBuffer())
  await face.load()
  document.fonts.add(face)
  return { family, release: () => document.fonts.delete(face) }
}

// Rasterises all 256 codes into a sprite meta + metrics.
export function rasteriseFont(
  family: string,
  options: ImportOptions,
  fontId: number,
): ImportedFont {
  const { pixelSize, bold, antialias, threshold } = options
  const cssFont = `${bold ? 'bold ' : ''}${pixelSize}px "${family}"`

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')!
  measureCtx.font = cssFont

  // Ascent/descent drive both the glyph box and the line height. Fall back to
  // the em box if the browser doesn't report them.
  const probe = measureCtx.measureText('Hg')
  const ascent = Math.ceil(probe.fontBoundingBoxAscent || pixelSize * 0.8)
  const descent = Math.ceil(probe.fontBoundingBoxDescent || pixelSize * 0.2)
  const glyphHeight = Math.max(ascent + descent, 1)

  const glyphWidths = new Array<number>(256).fill(0)
  const frames: (ImageData | null)[] = new Array(256).fill(null)
  const emptyCodes: number[] = []
  let maxWidth = 1
  let glyphCount = 0

  for (let code = 0; code < 256; code++) {
    const ch = charForCode(code)
    if (ch == null) { emptyCodes.push(code); continue }

    const advance = Math.round(measureCtx.measureText(ch).width)
    if (advance <= 0) { emptyCodes.push(code); continue }

    glyphWidths[code] = advance
    if (advance > maxWidth) maxWidth = advance

    // Draw into a box the size of the advance so the bitmap's origin lines up
    // with the pen position — the renderer blits at the pen and then advances.
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(advance, 1)
    canvas.height = glyphHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.font = cssFont
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#ffffff'
    ctx.imageSmoothingEnabled = antialias
    ctx.fillText(ch, 0, ascent)

    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    // Glyphs are masks: the renderer tints them. Force white + hard alpha so a
    // subpixel-antialiased draw doesn't leak colour fringes into the palette.
    let ink = 0
    for (let i = 0; i < image.data.length; i += 4) {
      const alpha = image.data[i + 3]
      const keep = antialias ? alpha : (alpha >= threshold ? 255 : 0)
      image.data[i] = 255
      image.data[i + 1] = 255
      image.data[i + 2] = 255
      image.data[i + 3] = keep
      if (keep > 0) ink++
    }

    if (ink === 0) {
      // Space and friends: a real advance but no pixels.
      frames[code] = image
      glyphCount++
      continue
    }

    frames[code] = image
    glyphCount++
  }

  // Assemble the sprite archive: 256 frames, one per code, sized to the widest
  // glyph so every frame shares the archive's canvas dimensions.
  const meta: SpriteMeta = {
    width: maxWidth,
    height: glyphHeight,
    palette: [0, 0xffffff],   // 0 = transparent, 1 = white (mask)
    pixelIndices: [],
    alpha: [],
    usesAlpha: [],
    isVertical: [],
    offsetsX: [],
    offsetsY: [],
    subWidths: [],
    subHeights: [],
  }

  for (let code = 0; code < 256; code++) {
    const image = frames[code]
    const subWidth = image ? image.width : 0
    const subHeight = image ? image.height : 0

    const indices: number[][] = []
    const alpha: number[] = new Array(subWidth * subHeight).fill(0)

    for (let x = 0; x < subWidth; x++) {
      indices[x] = new Array(subHeight).fill(0)
    }

    if (image) {
      for (let y = 0; y < subHeight; y++) {
        for (let x = 0; x < subWidth; x++) {
          const a = image.data[(y * subWidth + x) * 4 + 3]
          indices[x][y] = a > 0 ? 1 : 0
          alpha[y * subWidth + x] = a
        }
      }
    }

    meta.pixelIndices.push(indices)
    meta.alpha.push(alpha)
    meta.usesAlpha.push(true)
    meta.isVertical.push(false)
    meta.offsetsX.push(0)
    meta.offsetsY.push(0)
    meta.subWidths.push(subWidth)
    meta.subHeights.push(subHeight)
  }

  const metrics: FontMetricsDef = {
    id: fontId,
    glyphWidths,
    verticalSpacing: glyphHeight,
    topPadding: 0,
    bottomPadding: 0,
    variadicWidth: false,   // the cache's per-glyph tables; no cache font uses them
  }

  return { meta, metrics, glyphCount, emptyCodes }
}

// Renders one frame of the imported sprite to a canvas for the preview grid.
export function frameToCanvas(meta: SpriteMeta, frameIndex: number): HTMLCanvasElement | null {
  const w = meta.subWidths[frameIndex]
  const h = meta.subHeights[frameIndex]
  if (!w || !h) return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(w, h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = meta.alpha[frameIndex][y * w + x] ?? 0
      const i = (y * w + x) * 4
      image.data[i] = 255
      image.data[i + 1] = 255
      image.data[i + 2] = 255
      image.data[i + 3] = a
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}
