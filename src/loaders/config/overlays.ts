import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'

// Sentinel raw RGB the client treats as "no colour" (rgbToHsl's special
// case) — matches cryogen OverlayDefinitions.NO_COLOR.
export const NO_COLOR = 0xff00ff

// Ground tile overlays (CONFIG file type 4) — paths, water, and other flat
// regions painted on top of the underlay. cryogen OverlayDefinitions, decoded
// per darkan FloType.kt. Colours are the raw 24-bit RGB the cache stores
// (not the client's derived/quantised HSL16 runtime form).
export type OverlayDef = {
  id: number
  colorRgb: number
  texture: number
  occlude: boolean
  minimapColorRgb: number
  textureScale: number
  shadowed: boolean
  slot: number
  blendsWithUnderlay: boolean
  waterColor: number
  waterFogDepth: number
  waterIntensity: number
  opcode20: number
  unusedOpcode21: number
  unusedOpcode22: number
}

export type OverlayData = JsonDefData<OverlayDef>

export default makeJsonDefLoader<OverlayDef>((id) => ({
  id,
  colorRgb: NO_COLOR,
  texture: -1,
  occlude: true,
  minimapColorRgb: NO_COLOR,
  textureScale: 512,
  shadowed: true,
  slot: 8,
  blendsWithUnderlay: false,
  waterColor: 1190717,
  waterFogDepth: 512,
  waterIntensity: 255,
  opcode20: 63,
  unusedOpcode21: 0,
  unusedOpcode22: 64,
}))
