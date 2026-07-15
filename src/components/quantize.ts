// Median-cut colour quantizer for image uploads. RS sprites are palettized —
// at most 255 distinct colours plus the reserved transparent index 0 — so
// images with more colours must be reduced before applyImageToMeta can index
// them. Fully transparent pixels never consume a palette slot and pass
// through untouched; partial alpha is preserved as-is (it lives in the
// sprite's alpha channel, not the palette).

export type QuantizeResult = {
  image: ImageData
  /** Distinct colours in the returned image. */
  colorCount: number
  /** Distinct colours in the source image. */
  originalCount: number
}

type Entry = { r: number; g: number; b: number; n: number }
type Box = { start: number; end: number }

export function quantizeImage(source: ImageData, maxColors = 255): QuantizeResult {
  const { width, height, data } = source

  const counts = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1)
  }
  const originalCount = counts.size
  if (originalCount <= maxColors) {
    return { image: source, colorCount: originalCount, originalCount }
  }

  // Median cut over the unique colours, weighted by pixel count: repeatedly
  // split the box with the widest RGB channel span at its weighted median
  // until we have maxColors boxes, then average each box into one colour.
  const entries: Entry[] = []
  for (const [rgb, n] of counts) {
    entries.push({ r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff, n })
  }

  const boxes: Box[] = [{ start: 0, end: entries.length }]

  function widestChannel(box: Box): { span: number; channel: 'r' | 'g' | 'b' } {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0
    for (let i = box.start; i < box.end; i++) {
      const e = entries[i]
      if (e.r < rMin) rMin = e.r
      if (e.r > rMax) rMax = e.r
      if (e.g < gMin) gMin = e.g
      if (e.g > gMax) gMax = e.g
      if (e.b < bMin) bMin = e.b
      if (e.b > bMax) bMax = e.b
    }
    const rSpan = rMax - rMin, gSpan = gMax - gMin, bSpan = bMax - bMin
    if (rSpan >= gSpan && rSpan >= bSpan) return { span: rSpan, channel: 'r' }
    if (gSpan >= bSpan) return { span: gSpan, channel: 'g' }
    return { span: bSpan, channel: 'b' }
  }

  while (boxes.length < maxColors) {
    let bestIdx = -1
    let bestSpan = 0
    let bestChannel: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.end - box.start < 2) continue
      const { span, channel } = widestChannel(box)
      if (span > bestSpan) {
        bestSpan = span
        bestIdx = i
        bestChannel = channel
      }
    }
    if (bestIdx === -1) break // every box is a single colour already

    const box = boxes[bestIdx]
    const slice = entries.slice(box.start, box.end)
    slice.sort((a, b) => a[bestChannel] - b[bestChannel])
    for (let i = 0; i < slice.length; i++) entries[box.start + i] = slice[i]

    let total = 0
    for (let i = box.start; i < box.end; i++) total += entries[i].n
    let acc = 0
    let split = box.start + 1
    for (let i = box.start; i < box.end - 1; i++) {
      acc += entries[i].n
      if (acc * 2 >= total) {
        split = i + 1
        break
      }
    }

    boxes[bestIdx] = { start: box.start, end: split }
    boxes.push({ start: split, end: box.end })
  }

  const mapTo = new Map<number, number>()
  const finalColors = new Set<number>()
  for (const box of boxes) {
    let r = 0, g = 0, b = 0, n = 0
    for (let i = box.start; i < box.end; i++) {
      const e = entries[i]
      r += e.r * e.n
      g += e.g * e.n
      b += e.b * e.n
      n += e.n
    }
    const packed = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
    finalColors.add(packed)
    for (let i = box.start; i < box.end; i++) {
      const e = entries[i]
      mapTo.set((e.r << 16) | (e.g << 8) | e.b, packed)
    }
  }

  const out = new ImageData(width, height)
  const od = out.data
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    od[i + 3] = a
    if (a === 0) continue
    const mapped = mapTo.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])!
    od[i] = (mapped >> 16) & 0xff
    od[i + 1] = (mapped >> 8) & 0xff
    od[i + 2] = mapped & 0xff
  }

  return { image: out, colorCount: finalColors.size, originalCount }
}

/** Average colour of an image's non-transparent pixels, or null if fully transparent. */
export function averageImageColor(image: ImageData): { r: number; g: number; b: number } | null {
  const { data } = image
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    n++
  }
  if (n === 0) return null
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
}
