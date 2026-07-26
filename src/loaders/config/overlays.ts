import { makeJsonDefLoader } from '../common'
import type { JsonDefData } from '../common'
import type { CacheLoader } from '../types'

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
  /** Opcode 7. The client's own name is `secondaryRGB`, and it is NOT a
   *  minimap-only colour — see EDITOR.md's "naming trap". It is the ground
   *  MATERIAL colour (`VarNPCMap.method2617` prefers it over the tile colour),
   *  it paints the minimap tile (`Class291.method5164`), and an overlay with
   *  neither a primary nor a secondary colour is discarded before its blend
   *  flag is read (`Class329:633`). Dumps made before 2026-07-25 spell it
   *  `minimapColorRgb`; `loadItem` migrates those on read. */
  secondaryRgb: number
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

const base = makeJsonDefLoader<OverlayDef>((id) => ({
  id,
  colorRgb: NO_COLOR,
  texture: -1,
  occlude: true,
  secondaryRgb: NO_COLOR,
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

/** Migrates the pre-2026-07-25 `minimapColorRgb` spelling on read. Without this
 *  an older dump would show the field empty AND drop it on save, silently
 *  discarding opcode 7. */
export function migrateOverlayDef(def: OverlayDef): OverlayDef {
  const legacy = def as OverlayDef & { minimapColorRgb?: number }
  if (legacy.secondaryRgb === undefined && legacy.minimapColorRgb !== undefined) {
    legacy.secondaryRgb = legacy.minimapColorRgb
  }
  delete legacy.minimapColorRgb
  return def
}

export default {
  ...base,
  async loadItem(dirHandle, item, rootHandle) {
    const data = await base.loadItem(dirHandle, item, rootHandle) as OverlayData
    migrateOverlayDef(data.def)
    return data
  },
} satisfies CacheLoader
