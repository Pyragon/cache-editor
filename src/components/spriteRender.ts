import type { SpriteMeta } from '../loaders/sprites'

// Load a sprite's meta JSON from the sprites entry, or null if missing.
export async function loadSpriteMeta(
  spritesDir: FileSystemDirectoryHandle,
  id: number,
): Promise<SpriteMeta | null> {
  try {
    const subHandle = await spritesDir.getDirectoryHandle(String(id))
    const fileHandle = await subHandle.getFileHandle(`${id}.json`)
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text()) as SpriteMeta
  } catch {
    return null
  }
}

// Render one of a sprite's frames onto a fresh canvas, or null if empty.
export function renderFrameToCanvas(meta: SpriteMeta, frameIndex = 0): HTMLCanvasElement | null {
  if (meta.width <= 0 || meta.height <= 0) return null
  if (frameIndex < 0 || frameIndex >= meta.usesAlpha.length) return null
  const canvas = document.createElement('canvas')
  renderFrame(canvas, meta, frameIndex)
  return canvas
}

// Average colour of a sprite frame's opaque pixels, as a #rrggbb hex string
// (or null if the frame has no visible pixels). Useful for tinting UI to match
// a sprite whose name doesn't reflect its actual colour.
export function averageSpriteColor(meta: SpriteMeta, frameIndex = 0): string | null {
  const px = meta.pixelIndices[frameIndex]
  if (!px) return null
  const sw = meta.subWidths[frameIndex] ?? 0
  const sh = meta.subHeights[frameIndex] ?? 0
  const frameAlpha = meta.alpha?.[frameIndex]
  const hasAlpha = meta.usesAlpha[frameIndex] && frameAlpha != null

  let r = 0, g = 0, b = 0, n = 0
  for (let x = 0; x < sw; x++) {
    const col = px[x]
    if (!col) continue
    for (let y = 0; y < sh; y++) {
      const idx = col[y] & 0xff
      if (hasAlpha) {
        if ((frameAlpha[y * sw + x] & 0xff) === 0) continue
      } else if (idx === 0) {
        continue
      }
      const rgb = meta.palette[idx] ?? 0
      r += (rgb >> 16) & 0xff
      g += (rgb >> 8) & 0xff
      b += rgb & 0xff
      n++
    }
  }
  if (n === 0) return null
  r = Math.round(r / n)
  g = Math.round(g / n)
  b = Math.round(b / n)
  return `#${(((r << 16) | (g << 8) | b) >>> 0).toString(16).padStart(6, '0')}`
}

// Render a sprite's first frame and trigger a PNG download of it.
export function downloadSpritePng(meta: SpriteMeta, filename: string) {
  const canvas = document.createElement('canvas')
  renderFrame(canvas, meta, 0)
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

// Decode an uploaded image file (or any image Blob) to raw RGBA pixels.
export async function imageDataFromFile(file: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(file)
  const offscreen = document.createElement('canvas')
  offscreen.width  = bitmap.width
  offscreen.height = bitmap.height
  const ctx = offscreen.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx.getImageData(0, 0, offscreen.width, offscreen.height)
}

// ---------------------------------------------------------------------------
// Image → SpriteMeta conversion  (mirrors Java's generatePalette logic)
// ---------------------------------------------------------------------------

export function applyImageToMeta(
  imageData: ImageData,
  frameIndex: number,
  meta: SpriteMeta,
): SpriteMeta {
  const { width: imgW, height: imgH, data } = imageData

  // Build new palette, seeding with colours from frames we are NOT replacing
  // so their pixel indices remain valid after the rebuild.
  const palette: number[] = [0] // index 0 = transparent (reserved)
  const rgbToIdx = new Map<number, number>([[0, 0]])

  function getOrAdd(rgb: number): number {
    if (rgbToIdx.has(rgb)) return rgbToIdx.get(rgb)!
    if (palette.length >= 256) throw new Error(`Too many colours (${palette.length}); max is 256`)
    const idx = palette.length
    palette.push(rgb)
    rgbToIdx.set(rgb, idx)
    return idx
  }

  // Pass 1 — seed palette with all colours used by other frames
  const frameCount = meta.usesAlpha.length
  for (let f = 0; f < frameCount; f++) {
    if (f === frameIndex) continue
    const frame = meta.pixelIndices[f] ?? []
    const sw = meta.subWidths[f] ?? 0
    const sh = meta.subHeights[f] ?? 0
    for (let x = 0; x < sw; x++) {
      for (let y = 0; y < sh; y++) {
        const idx = frame[x]?.[y] ?? 0
        if (idx !== 0) getOrAdd(meta.palette[idx] ?? 1)
      }
    }
  }

  // Pass 2 — re-index other frames using the new palette
  const newPixelIndices: number[][][] = Array.from({ length: frameCount }, (_, f) => {
    if (f === frameIndex) return [] // filled below
    const oldFrame = meta.pixelIndices[f] ?? []
    const sw = meta.subWidths[f] ?? 0
    const sh = meta.subHeights[f] ?? 0
    const newFrame: number[][] = Array.from({ length: sw }, () => new Array(sh).fill(0))
    for (let x = 0; x < sw; x++) {
      for (let y = 0; y < sh; y++) {
        const oldIdx = oldFrame[x]?.[y] ?? 0
        if (oldIdx !== 0) newFrame[x][y] = getOrAdd(meta.palette[oldIdx] ?? 1)
      }
    }
    return newFrame
  })

  // Pass 3 — build pixel data from the uploaded image
  // Following generatePalette: usesAlpha = true whenever any pixel has alpha != 0
  const newFramePixels: number[][] = Array.from({ length: imgW }, () => new Array(imgH).fill(0))
  const newFrameAlpha: number[] = new Array(imgW * imgH).fill(0)
  let frameUsesAlpha = false

  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const pos = (y * imgW + x) * 4
      const r = data[pos], g = data[pos + 1], b = data[pos + 2], a = data[pos + 3]
      newFrameAlpha[y * imgW + x] = a
      if (a !== 0) {
        frameUsesAlpha = true
        const rgb = (r << 16) | (g << 8) | b
        newFramePixels[x][y] = getOrAdd(rgb)
      }
    }
  }

  newPixelIndices[frameIndex] = newFramePixels

  const newAlpha = [...meta.alpha]
  newAlpha[frameIndex] = newFrameAlpha

  const newUsesAlpha = [...meta.usesAlpha]
  newUsesAlpha[frameIndex] = frameUsesAlpha

  const newSubWidths = [...meta.subWidths]
  const newSubHeights = [...meta.subHeights]
  newSubWidths[frameIndex] = imgW
  newSubHeights[frameIndex] = imgH

  const offsetX = meta.offsetsX[frameIndex] ?? 0
  const offsetY = meta.offsetsY[frameIndex] ?? 0

  return {
    ...meta,
    width:        Math.max(meta.width,  offsetX + imgW),
    height:       Math.max(meta.height, offsetY + imgH),
    palette,
    pixelIndices: newPixelIndices,
    alpha:        newAlpha,
    usesAlpha:    newUsesAlpha,
    subWidths:    newSubWidths,
    subHeights:   newSubHeights,
  }
}

/** Render one frame at its own sub-frame size with no canvas offsets — the
 *  exact image cryogen's dumper writes as `<id>_<frame>.png` (getBufferedImage
 *  is called with the SUB dimensions), so regenerated PNGs match the dump. */
export function renderSubFrame(canvas: HTMLCanvasElement, meta: SpriteMeta, frameIndex: number) {
  const subWidth = meta.subWidths[frameIndex] ?? 0
  const subHeight = meta.subHeights[frameIndex] ?? 0
  const framePixels = meta.pixelIndices[frameIndex]
  const frameAlpha = meta.alpha?.[frameIndex]
  const hasAlpha = meta.usesAlpha[frameIndex] && frameAlpha != null
  canvas.width = Math.max(1, subWidth)
  canvas.height = Math.max(1, subHeight)
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (subWidth <= 0 || subHeight <= 0) return
  const imageData = ctx.createImageData(subWidth, subHeight)
  const px = imageData.data
  for (let x = 0; x < subWidth; x++) {
    const col = framePixels?.[x]
    if (!col) continue
    for (let y = 0; y < subHeight; y++) {
      const paletteIdx = col[y] & 0xff
      const pos = (y * subWidth + x) * 4
      if (hasAlpha) {
        const a = frameAlpha[y * subWidth + x] & 0xff
        if (a === 0) continue
        const rgb = meta.palette[paletteIdx] ?? 0
        px[pos] = (rgb >> 16) & 0xff
        px[pos + 1] = (rgb >> 8) & 0xff
        px[pos + 2] = rgb & 0xff
        px[pos + 3] = a
      } else {
        if (paletteIdx === 0) continue
        const rgb = meta.palette[paletteIdx] ?? 0
        px[pos] = (rgb >> 16) & 0xff
        px[pos + 1] = (rgb >> 8) & 0xff
        px[pos + 2] = rgb & 0xff
        px[pos + 3] = 255
      }
    }
  }
  ctx.putImageData(imageData, 0, 0)
}

/** PNG blob of a frame's dump-convention image (sub-frame size). */
export function spriteFramePngBlob(meta: SpriteMeta, frameIndex: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  renderSubFrame(canvas, meta, frameIndex)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png')
  })
}

export function renderFrame(canvas: HTMLCanvasElement, meta: SpriteMeta, frameIndex: number) {
  const { width, height, palette, pixelIndices, alpha, usesAlpha } = meta
  const subWidth  = meta.subWidths[frameIndex]  ?? 0
  const subHeight = meta.subHeights[frameIndex] ?? 0
  const offsetX   = meta.offsetsX[frameIndex]   ?? 0
  const offsetY   = meta.offsetsY[frameIndex]   ?? 0
  const framePixels = pixelIndices[frameIndex]
  const frameAlpha  = alpha?.[frameIndex]
  const hasAlpha    = usesAlpha[frameIndex] && frameAlpha != null

  canvas.width  = width
  canvas.height = height

  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const px = imageData.data

  for (let x = 0; x < subWidth; x++) {
    const col = framePixels?.[x]
    if (!col) continue
    for (let y = 0; y < subHeight; y++) {
      const paletteIdx = col[y] & 0xFF
      const cx = x + offsetX
      const cy = y + offsetY
      if (cx >= width || cy >= height) continue

      const pos = (cy * width + cx) * 4

      if (hasAlpha) {
        const a = frameAlpha[y * subWidth + x] & 0xFF
        if (a === 0) continue
        const rgb = palette[paletteIdx] ?? 0
        px[pos]     = (rgb >> 16) & 0xFF
        px[pos + 1] = (rgb >> 8)  & 0xFF
        px[pos + 2] =  rgb        & 0xFF
        px[pos + 3] = a
      } else {
        if (paletteIdx === 0) continue
        const rgb = palette[paletteIdx] ?? 0
        px[pos]     = (rgb >> 16) & 0xFF
        px[pos + 1] = (rgb >> 8)  & 0xFF
        px[pos + 2] =  rgb        & 0xFF
        px[pos + 3] = 255
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
}
