// Average RGB of named rects in a PNG + crop each rect out for visual
// verification. Usage: node sample.mjs img.png outPrefix name:x,y,w,h ...
import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'

const [img, prefix, ...rects] = process.argv.slice(2)
const png = PNG.sync.read(readFileSync(img))
console.log(`${img}: ${png.width}x${png.height}`)
for (const spec of rects) {
  const [name, nums] = spec.split(':')
  const [x, y, w, h] = nums.split(',').map(Number)
  let r = 0, g = 0, b = 0, n = 0
  const crop = new PNG({ width: w, height: h })
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * png.width + (x + xx)) * 4
      const di = (yy * w + xx) * 4
      crop.data[di] = png.data[si]; crop.data[di + 1] = png.data[si + 1]
      crop.data[di + 2] = png.data[si + 2]; crop.data[di + 3] = 255
      r += png.data[si]; g += png.data[si + 1]; b += png.data[si + 2]; n++
    }
  }
  writeFileSync(`${prefix}-${name}.png`, PNG.sync.write(crop))
  const R = Math.round(r / n), G = Math.round(g / n), B = Math.round(b / n)
  console.log(`${name.padEnd(10)} avg ${R},${G},${B}  #${((R << 16) | (G << 8) | B).toString(16).padStart(6, '0')}  lum ${Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)}`)
}
