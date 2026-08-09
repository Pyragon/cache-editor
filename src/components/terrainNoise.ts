/**
 * Terrain default-height noise (TileUtils / Class159 / Class430).
 *
 * Lifted out of `mapScene.ts` verbatim so non-rendering code can use it
 * without pulling in three.js — the scenery scan needs it because a tile with
 * NO stored height is not flat, it falls back to this. Treating absent as zero
 * invents cliffs wherever stored and procedural ground meet.
 *
 * Do not "clean up" the integer ops: `>>`, `|0` and `Math.imul` are 32-bit
 * here and the client's output depends on the exact overflow behaviour.
 */

// Trig.COSINE has 16384 entries at amplitude 16384, but the interpolation
// subtracts it from 65536 — an authentic client quirk, kept verbatim.
const NOISE_STEP = 3.834951969714103e-4
const COS16K = new Int32Array(16384)
for (let i = 0; i < 16384; i++) COS16K[i] = Math.trunc(16384.0 * Math.cos(i * NOISE_STEP))

function randomNoise(x: number, y: number): number {
  let n = (Math.imul(y, 57) + x) | 0
  n ^= n << 13
  const value = (Math.imul(n, Math.imul(Math.imul(n, n), 15731) + 789221) + 1376312589) & 0x7fffffff
  return (value >> 19) & 0xff
}

function noiseWeighedSum(x: number, y: number): number {
  const corners = randomNoise(x - 1, y - 1) + randomNoise(x + 1, y - 1) + randomNoise(x - 1, y + 1) + randomNoise(x + 1, y + 1)
  const sides = randomNoise(x - 1, y) + randomNoise(x + 1, y) + randomNoise(x, y - 1) + randomNoise(x, y + 1)
  const center = randomNoise(x, y)
  return Math.trunc(corners / 16) + Math.trunc(sides / 8) + Math.trunc(center / 4)
}

function cosInterpolate(a: number, b: number, angle: number, freq: number): number {
  const cos = (65536 - COS16K[Math.trunc((angle * 8192) / freq)]) >> 1
  return (((65536 - cos) * a) >> 16) + ((cos * b) >> 16)
}

function perlinNoise(x: number, y: number, freq: number): number {
  const adjX = Math.trunc(x / freq)
  const angleX = x & (freq - 1)
  const adjY = Math.trunc(y / freq)
  const angleY = y & (freq - 1)
  const base = noiseWeighedSum(adjX, adjY)
  const east = noiseWeighedSum(adjX + 1, adjY)
  const south = noiseWeighedSum(adjX, adjY + 1)
  const southEast = noiseWeighedSum(adjX + 1, adjY + 1)
  const north = cosInterpolate(base, east, angleX, freq)
  const southI = cosInterpolate(south, southEast, angleX, freq)
  return cosInterpolate(north, southI, angleY, freq)
}

export function calculateTileHeight(x: number, y: number): number {
  let height =
    perlinNoise(45365 + x, y + 91923, 4) - 128 +
    ((perlinNoise(x + 10294, 37821 + y, 2) - 128) >> 1) +
    ((perlinNoise(x, y, 1) - 128) >> 2)
  height = Math.trunc(height * 0.3) + 35
  if (height < 10) height = 10
  else if (height > 60) height = 60
  return height
}
