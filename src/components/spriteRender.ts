import type { SpriteMeta } from '../loaders/sprites'

// Decode an uploaded image file to raw RGBA pixels.
export async function imageDataFromFile(file: File): Promise<ImageData> {
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
