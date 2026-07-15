// RS 16-bit HSL → RGB, ported verbatim from cryogen Utilities' HSL_2_RGB
// palette generation (utils/Utilities.java). The packed HSL value indexes
// this 65536-entry table directly: bits 15–7 = hue(6)+saturation(3),
// bits 6–0 = lightness(7). Built once, lazily.
let table: Int32Array | null = null

function buildTable(): Int32Array {
  const rgb = new Int32Array(65536)
  const d = 0.7
  let i = 0
  for (let i1 = 0; i1 !== 512; ++i1) {
    const f = ((i1 >> 3) / 64.0 + 0.0078125) * 360.0
    const f1 = 0.0625 + (7 & i1) / 8.0
    for (let i2 = 0; i2 !== 128; ++i2) {
      const f2 = i2 / 128.0
      let f3 = 0.0, f4 = 0.0, f5 = 0.0
      const f6 = f / 60.0
      const i3 = Math.trunc(f6)
      const i4 = i3 % 6
      const f7 = f6 - i3
      const f8 = f2 * (-f1 + 1.0)
      const f9 = f2 * (-(f7 * f1) + 1.0)
      const f10 = (1.0 - f1 * (-f7 + 1.0)) * f2
      if (i4 === 0) { f3 = f2; f5 = f8; f4 = f10 }
      else if (i4 === 1) { f5 = f8; f3 = f9; f4 = f2 }
      else if (i4 === 2) { f3 = f8; f4 = f2; f5 = f10 }
      else if (i4 === 3) { f4 = f9; f3 = f8; f5 = f2 }
      else if (i4 === 4) { f5 = f2; f3 = f10; f4 = f8 }
      else { f4 = f8; f5 = f9; f3 = f2 }
      rgb[i++] =
        (Math.trunc(Math.pow(f3, d) * 256.0) << 16) |
        (Math.trunc(Math.pow(f4, d) * 256.0) << 8) |
        Math.trunc(Math.pow(f5, d) * 256.0)
    }
  }
  return rgb
}

// Packed HSL short → "#rrggbb". Values are signed shorts in the cache;
// the low 16 bits are the palette index. -1 is the "no colour" sentinel.
export function hslToHex(hsl: number): string | null {
  if (hsl === -1) return null
  if (table === null) table = buildTable()
  const rgb = table[hsl & 0xffff] & 0xffffff
  return `#${rgb.toString(16).padStart(6, '0')}`
}

// Nearest packed-HSL index for an RGB colour — inverse lookup over the same
// palette table, so it round-trips with hslToHex. Linear scan of the 65536
// entries; fine for one-off conversions like a new texture's flat colour.
export function rgbToHsl16(r: number, g: number, b: number): number {
  if (table === null) table = buildTable()
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < 65536; i++) {
    const rgb = table[i]
    const dr = ((rgb >> 16) & 0xff) - r
    const dg = ((rgb >> 8) & 0xff) - g
    const db = (rgb & 0xff) - b
    const dist = dr * dr + dg * dg + db * db
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}
