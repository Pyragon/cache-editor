import * as THREE from 'three'
import type { MapTerrain } from '../loaders/maps'
import { SIZE, tileIndex } from '../loaders/maps'
import type { ModelData } from '../loaders/models'
import { hslToRgb, adjustLuminance, AMBIENT_DEFAULT, CONTRAST_DEFAULT, parseModel, applyRecolor, computeModelLitRgb, modelUpscale, upscaleModel, DEFAULT_MODEL_SUN, type ModelSun, type PointLight } from '../loaders/models'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { makeUVWriter } from './modelUVs'
import type { UVWriter } from './modelUVs'
import type { PosedVertices } from '../loaders/skeletalAnimation'

// Builds a Three.js scene for one map region, ported from the darkan client
// scene pipeline (MapLoader/SceneGraph/GroundSM in darkan-bot-refactor and the
// matching darkan-game-client decompile):
// - tile heights incl. the plane-0 Perlin default (TileUtils.calculateTileheight,
//   preserving the shipped quirk that the 65536-based cosine interpolation reads
//   Trig's 16384-amplitude table)
// - underlay colours via the client's 11×11 HSL box blur (calculateUnderlayPalette)
// - the 13 overlay tile shapes with rotation (SHAPE_VERTEX_* + tileSizeDeltas)
// - vertex lighting per HardwareGround (the DX ground, low-detail path):
//   palette[lightness·(74−shadow)/128] × (ambient + N·L·(sun|backlight)) —
//   NOT GroundSM's software bake, which this originally copied (2026-07-26)
// - locs placed per SceneGraph.addObject (average height over the loc footprint,
//   rotation-swapped sizes), models merged into one geometry per plane.
// RS scene space → three: x stays, y (down) → -y, tile "north" y-axis → -z.

// ---------------------------------------------------------------------------
// Client colour math (ColorUtil + FluType.calculateHsl16)
// ---------------------------------------------------------------------------

/** ColorUtil.rgbToHsl24 — 24-bit RGB → packed HSL16 (used by flo tile colours). */
export function rgbToHsl16(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 256.0
  const g = ((rgb >> 8) & 0xff) / 256.0
  const b = (rgb & 0xff) / 256.0
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let hue = 0
  let sat = 0
  const light = (max + min) / 2.0
  if (max !== min) {
    sat = light < 0.5 ? (max - min) / (max + min) : (max - min) / (2.0 - max - min)
    if (r === max) hue = (g - b) / (max - min)
    else if (g === max) hue = 2.0 + (b - r) / (max - min)
    else hue = 4.0 + (r - g) / (max - min)
  }
  hue /= 6.0
  const h = Math.trunc(256.0 * hue)
  let s = Math.min(255, Math.max(0, Math.trunc(sat * 256.0)))
  const l = Math.min(255, Math.max(0, Math.trunc(light * 256.0)))
  if (l > 243) s >>= 4
  else if (l > 217) s >>= 3
  else if (l > 192) s >>= 2
  else if (l > 179) s >>= 1
  return (((h & 0xff) >> 2) << 10) + (l >> 1) + ((s >> 5) << 7)
}

/** FluType.calculateHsl16 — underlay rgb → blur accumulator components. */
export function fluComponents(rgb: number): { hue: number; saturation: number; lightness: number; divisor: number } {
  const r = ((rgb >> 16) & 0xff) / 256.0
  const g = ((rgb >> 8) & 0xff) / 256.0
  const b = (rgb & 0xff) / 256.0
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let hue = 0
  let sat = 0
  const light = (max + min) / 2.0
  if (max !== min) {
    sat = light < 0.5 ? (max - min) / (max + min) : (max - min) / (2.0 - max - min)
    if (r === max) hue = (g - b) / (max - min)
    else if (g === max) hue = 2.0 + (b - r) / (max - min)
    else hue = (r - g) / (max - min) + 4.0
  }
  hue /= 6.0
  const saturation = Math.min(255, Math.max(0, Math.trunc(sat * 256.0)))
  const lightness = Math.min(255, Math.max(0, Math.trunc(light * 256.0)))
  let divisor = light > 0.5 ? Math.trunc(sat * (1.0 - light) * 512.0) : Math.trunc(sat * light * 512.0)
  if (divisor < 1) divisor = 1
  return { hue: Math.trunc(hue * divisor), saturation, lightness, divisor }
}

/** ColorUtil.hsl16to24 — blurred components → packed HSL16 (name is Jagex's). */
function packBlurredHsl(hue: number, saturation: number, lightness: number): number {
  let s = saturation
  if (lightness > 243) s >>= 4
  else if (lightness > 217) s >>= 3
  else if (lightness > 192) s >>= 2
  else if (lightness > 179) s >>= 1
  return (((hue & 0xff) >> 2) << 10) + (lightness >> 1) + ((s >> 5) << 7)
}

/** ColorUtil.blend — interpolate two packed HSL16 colours, factor 0-128. */
function blendHsl16(colorA: number, colorB: number, factor: number): number {
  if (colorA === colorB) return colorA
  const inv = 128 - factor
  const light = (inv * (colorA & 0x7f) + factor * (colorB & 0x7f)) >> 7
  const sat = (inv * (colorA & 0x380) + factor * (colorB & 0x380)) >> 7
  const hue = (inv * (colorA & 0xfc00) + factor * (colorB & 0xfc00)) >> 7
  return (hue & 0xfc00) | (sat & 0x380) | (light & 0x7f)
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Binary-alpha cutout for effectCombiner-1 materials: black texels → fully
 *  transparent, everything else opaque (client getTextureForMaterial). Turns an
 *  opaque foliage PNG into a see-through leaf/fence texture. */
function binaryAlphaTexture(bitmap: ImageBitmap): THREE.CanvasTexture {
  const w = bitmap.width, h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] < 8) d[i + 3] = 0 // near-black → transparent
  }
  ctx.putImageData(img, 0, 0)
  return new THREE.CanvasTexture(canvas)
}

/**
 * Materials drawn with one of the client's two reflective effects — effectId 1
 * (`Class141_Sub1`, a specular highlight) and 7 (`Class141_Sub7`, a sky env-map
 * reflection) — whose texture alpha is NOT opacity.
 *
 * Both build their fixed-function chain the same way: the last texture unit is
 * set to `COMBINE_ALPHA = GL_REPLACE` with `SRC0_ALPHA = GL_PRIMARY_COLOR`
 * (`method13717(_, 7681)` + `method13616(0, 34167)`), and the unbind display
 * list puts it back to `GL_TEXTURE`. So while such a material is bound, the
 * fragment's alpha is the vertex alpha and nothing else — the material's own
 * alpha channel is consumed earlier, as the gloss mask that scales the specular
 * cubemap into RGB (effect 1) or as the interpolation factor between the base
 * colour and the sky (effect 7).
 *
 * It has to be read off the data as well: these are the ground detail maps,
 * and they sit at alpha 1-76 (texture 494 is underlays 1/2/3, texture 407 is
 * 15/58/59/135/157). Treated as opacity, grass would draw at 15% and vanish.
 */
function effectIgnoresTextureAlpha(meta: MaterialMeta): boolean {
  // ...except on a cutout. effectCombiner 1 means `getTexture` SYNTHESISED the
  // alpha channel (black texels → clear) because our dumped PNGs are opaque —
  // it's the only thing making that geometry see-through, and it isn't the
  // alpha the specular chain consumes. 17 materials are both; they keep their
  // cutout. None of them is a floor, so the ground fix is unaffected.
  if (meta.effectCombiner === 1) return false
  return meta.effectId === 1 || meta.effectId === 7
}

/**
 * Drop the sampled alpha so only the vertex alpha survives, mirroring that
 * `COMBINE_ALPHA = REPLACE`. Done in the shader rather than by rewriting the
 * texture: stripping the alpha channel on a 2D canvas means a round trip
 * through its premultiplied store, which mangles exactly these materials —
 * texture 407 comes back off the canvas with per-texel errors up to 30 and
 * visible hue shifts, because its alpha bottoms out at 1.
 *
 * Shared module-level function on purpose. Three's default
 * `customProgramCacheKey` is `onBeforeCompile.toString()`, so every material
 * patched here keys to the same string and they all share one compiled program.
 */
const dropMapAlpha = (shader: { fragmentShader: string }) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    '#ifdef USE_MAP\n\tdiffuseColor.rgb *= texture2D( map, vMapUv ).rgb;\n#endif',
  )
}

// --- effectId 1: the specular highlight -------------------------------------
//
// `Class141_Sub1` bakes three specular cubemaps at construction, each face
// texel holding `pow(dot(dir, axis), n) * 127` for n = 96, 36 and 12 (0 where
// the dot is negative), and `method2399` binds
// `aClass137_Sub2Array9027[effectParam1 - 1]` — so effectParam1 1/2/3 selects
// the exponent. The 127 is `i_2` in the full-quality path (48 on the reduced
// one), i.e. the term peaks at 127/255 of a channel.
const SPECULAR_EXPONENT = [96, 36, 12]
const SPECULAR_PEAK = 127 / 255

/** The Phong exponent for a material, or 0 if it takes no specular. */
function specularExponent(meta: MaterialMeta): number {
  if (meta.effectId !== 1 || meta.effectCombiner === 1) return 0
  return SPECULAR_EXPONENT[meta.effectParam1 - 1] ?? 0
}

type ShaderPatch = (shader: { vertexShader: string; fragmentShader: string }) => void

const specularPatches = new Map<string, ShaderPatch>()

/**
 * `onBeforeCompile` adding the client's specular term on top of the alpha drop.
 *
 * The GL fixed-function path fakes this with `GL_REFLECTION_MAP` texgen into
 * the baked cubemap, but the shader path states it directly — `1_12.vert`'s
 * `ShaderMode == 1` branch, the same shader our Gouraud lighting is ported
 * from, emits `SpecularColour.xyz = reflect(-SunDir, N)` and
 * `ReflectedViewVector = normalize(EyePos - vertex)` (misnomer: it's the plain
 * view vector). The cubemap lookup those feed is `pow(R·V, n)`, textbook Phong.
 *
 * The combine is the traced 3-unit chain: unit 0 gives `texture.rgb ×
 * primary.rgb`, unit 1 puts `cubemap × texture.alpha` in alpha, and unit 2 does
 * `COMBINE_RGB = GL_ADD` with `SRC1_RGB = PREVIOUS` operand `GL_SRC_ALPHA` —
 * folding that alpha back into RGB. So:
 *
 *     rgb = texture.rgb * vertexColour + pow(R·V, n) * 127/255 * texture.alpha
 *
 * added equally to all three channels (the operand replicates alpha), which is
 * why the highlight is always white regardless of the material's colour.
 *
 * `sunDir` and the exponent are inlined as literals rather than passed as
 * uniforms: adding uniforms through `onBeforeCompile` on a built-in material
 * means sharing three's cached uniform group, and the sun is already fixed at
 * mesh-build time anyway (the Gouraud pass bakes it into vertex colours, so
 * changing it rebuilds the mesh regardless). Patches are cached by
 * sun+exponent so the handful of variants share compiled programs.
 */
function specularPatch(sun: ModelSun, exponent: number): ShaderPatch {
  const l = Math.hypot(sun.dir[0], sun.dir[1], sun.dir[2]) || 1
  const sx = (sun.dir[0] / l).toFixed(6)
  const sy = (sun.dir[1] / l).toFixed(6)
  const sz = (sun.dir[2] / l).toFixed(6)
  const key = `${sx},${sy},${sz}|${exponent}`
  let patch = specularPatches.get(key)
  if (patch) return patch

  // The client's fixed-function chain has no notion of sRGB — it adds the
  // specular in display space. Our vertex colours are linearised
  // (`computeModelLitRgb` ends in srgbToLinear) and the texture decodes to
  // linear too, so to land in the same place the add has to happen in display
  // space and come back. Same convention the point lights already follow, which
  // sum into the diffuse term before that srgbToLinear.
  const helpers = `
vec3 rsToDisplay( vec3 c ) {
	return mix( pow( c, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), c * 12.92, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) );
}
vec3 rsToLinear( vec3 c ) {
	return mix( pow( c * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), c * 0.0773993808, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}`

  patch = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRsSpecR;\nvarying vec3 vRsSpecV;')
      // after project_vertex so `transformed` is final (batching/morph applied)
      .replace('#include <project_vertex>', `#include <project_vertex>
	vRsSpecR = reflect( -vec3( ${sx}, ${sy}, ${sz} ), normalize( mat3( modelMatrix ) * normal ) );
	vRsSpecV = cameraPosition - ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRsSpecR;\nvarying vec3 vRsSpecV;${helpers}`)
      // map_fragment runs BEFORE color_fragment, so diffuseColor is still the
      // flat material colour here — take the texture's rgb (never its alpha)
      // and hold the gloss mask until the vertex colour has been applied.
      .replace('#include <map_fragment>', `float rsGloss = 0.0;
	#ifdef USE_MAP
		vec4 rsTexel = texture2D( map, vMapUv );
		diffuseColor.rgb *= rsTexel.rgb;
		rsGloss = rsTexel.a;
	#endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	float rsSpec = pow( max( dot( normalize( vRsSpecR ), normalize( vRsSpecV ) ), 0.0 ), ${exponent.toFixed(1)} ) * ${SPECULAR_PEAK.toFixed(6)} * rsGloss;
	diffuseColor.rgb = rsToLinear( rsToDisplay( diffuseColor.rgb ) + rsSpec );`)
  }
  specularPatches.set(key, patch)
  return patch
}

/** Final per-vertex ground colour (GroundGL): two stages — (1) scale the tile
 *  colour's HSL lightness by `lightStrength/128` (ambient 74 minus static shadow,
 *  the source of the ground's shading), then (2) multiply the resulting RGB by
 *  the directional sun multiplier. Both clamped like the client. */
function litColor(hsl: number, mul: number): [number, number, number] {
  const rgb = hslToRgb(hsl)
  return [
    srgbToLinear(Math.min(1, (((rgb >> 16) & 0xff) / 255) * mul)),
    srgbToLinear(Math.min(1, (((rgb >> 8) & 0xff) / 255) * mul)),
    srgbToLinear(Math.min(1, ((rgb & 0xff) / 255) * mul)),
  ]
}

// ---------------------------------------------------------------------------
// Terrain default-height noise (TileUtils / Class159 / Class430)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tile shape tables (MapLoader companion)
// ---------------------------------------------------------------------------

const OVERLAY_FACE_COUNT = [2, 1, 1, 1, 2, 2, 2, 1, 3, 3, 3, 2, 0, 4, 0]
const UNDERLAY_FACE_COUNT = [0, 1, 2, 2, 1, 1, 2, 3, 1, 3, 3, 4, 2, 0, 4]
const SHAPE_VERTEX_A = [
  [0, 2], [0, 2], [0, 0, 2], [2, 0, 0], [0, 2, 0], [0, 0, 2], [0, 5, 1, 4],
  [0, 4, 4, 4], [4, 4, 4, 0], [6, 6, 6, 2, 2, 2], [2, 2, 2, 6, 6, 6],
  [0, 11, 6, 6, 6, 4], [0, 2], [0, 4, 4, 4], [0, 4, 4, 4],
]
const SHAPE_VERTEX_B = [
  [2, 4], [2, 4], [5, 2, 4], [4, 5, 2], [2, 4, 5], [5, 2, 4], [1, 6, 2, 5],
  [1, 6, 7, 1], [6, 7, 1, 1], [0, 8, 9, 8, 9, 4], [8, 9, 4, 0, 8, 9],
  [2, 10, 0, 10, 11, 11], [2, 4], [1, 6, 7, 1], [1, 6, 7, 1],
]
const SHAPE_VERTEX_C = [
  [6, 6], [6, 6], [6, 5, 5], [5, 6, 5], [5, 5, 6], [6, 5, 5], [5, 0, 4, 1],
  [7, 7, 1, 2], [7, 1, 2, 7], [8, 9, 4, 0, 8, 9], [0, 8, 9, 8, 9, 4],
  [11, 0, 10, 11, 4, 2], [6, 6], [7, 7, 1, 2], [7, 7, 1, 2],
]
// The other two tile-shape families, `Class329.method5849`. Three exist:
//
//   unblendable  SHAPE_VERTEX_A/B/C above + OVERLAY/UNDERLAY_FACE_COUNT
//                (client 3824/3860/3815) — a plain overlay with no neighbour
//                asking anything of it. 15 entries, no edge table.
//   blending     the overlay sets `blendsWithUnderlay` (client 3775/3821/3836)
//   non-blending anything else (client 3774/3830/3831)
//
// The last two are 13 entries and carry an extra per-EDGE table giving the
// index of the face lying on that edge, or -1 (client 3833 / 3828). The
// overlay face counts are identical across all three; what a blending tile
// buys is a finer UNDERLAY subdivision on the shaped tiles — shape 1 goes 2→4
// faces, 2 and 3 go 2→3, 7 and 9 go 3→5, 11 goes 4→6 — which is the geometry
// the path-into-grass gradient runs through on a diagonal border.
const NB_VERTEX_A = [
  [0, 2, 4, 6], [6, 0, 2, 4], [6, 0, 2], [2, 6, 0], [0, 2, 6], [6, 0, 2],
  [5, 6, 0, 1, 2, 4], [7, 2, 4, 4], [2, 4, 4, 7], [6, 6, 4, 0, 2, 2],
  [0, 2, 2, 6, 6, 4], [0, 2, 2, 4, 6, 6], [0, 2, 4, 6],
]
const NB_VERTEX_B = [
  [2, 4, 6, 0], [0, 2, 4, 6], [0, 2, 4], [4, 0, 2], [2, 4, 0], [0, 2, 4],
  [6, 0, 1, 2, 4, 5], [0, 4, 7, 6], [4, 7, 6, 0], [0, 8, 6, 2, 9, 4],
  [2, 9, 4, 0, 8, 6], [2, 11, 4, 6, 10, 0], [2, 4, 6, 0],
]
const NB_VERTEX_C = [
  [12, 12, 12, 12], [12, 12, 12, 12], [5, 5, 5], [5, 5, 5], [5, 5, 5], [5, 5, 5],
  [12, 12, 12, 12, 12, 12], [1, 1, 1, 7], [1, 1, 7, 1], [8, 9, 9, 8, 8, 9],
  [8, 8, 9, 8, 9, 9], [10, 10, 11, 11, 11, 10], [12, 12, 12, 12],
]
const NB_EDGE_FACE = [
  [0, 1, 2, 3], [1, 2, 3, 0], [1, 2, -1, 0], [2, 0, -1, 1], [0, 1, -1, 2],
  [1, 2, -1, 0], [-1, 4, -1, 1], [-1, 1, 3, -1], [-1, 0, 2, -1], [3, 5, 2, 0],
  [0, 2, 5, 3], [0, 2, 3, 5], [0, 1, 2, 3],
]
const NB_OVERLAY_FACES = [4, 2, 1, 1, 2, 2, 3, 1, 3, 3, 3, 2, 0]
const NB_UNDERLAY_FACES = [0, 2, 2, 2, 1, 1, 3, 3, 1, 3, 3, 4, 4]

const BL_VERTEX_A = [
  [0, 2, 4, 6], [6, 0, 2, 3, 5, 3], [6, 0, 2, 4], [2, 5, 6, 1], [0, 2, 6], [6, 0, 2],
  [5, 6, 0, 1, 2, 4], [7, 7, 1, 2, 4, 6], [2, 4, 4, 7], [6, 6, 4, 0, 1, 1, 3, 3],
  [0, 2, 2, 6, 6, 4], [0, 2, 2, 3, 7, 0, 4, 3], [0, 2, 4, 6],
]
const BL_VERTEX_B = [
  [2, 4, 6, 0], [0, 2, 3, 5, 6, 4], [0, 1, 4, 5], [4, 6, 0, 2], [2, 4, 0], [0, 2, 4],
  [6, 0, 1, 2, 4, 5], [0, 1, 2, 4, 6, 7], [4, 7, 6, 0], [0, 8, 6, 1, 9, 2, 9, 4],
  [2, 9, 4, 0, 8, 6], [2, 11, 3, 7, 10, 10, 6, 6], [2, 4, 6, 0],
]
const BL_VERTEX_C = [
  [12, 12, 12, 12], [12, 12, 12, 12, 12, 5], [5, 5, 1, 1], [5, 1, 1, 5], [5, 5, 5], [5, 5, 5],
  [12, 12, 12, 12, 12, 12], [1, 12, 12, 12, 12, 12], [1, 1, 7, 1], [8, 9, 9, 8, 8, 3, 1, 9],
  [8, 8, 9, 8, 9, 9], [10, 10, 11, 11, 11, 7, 3, 7], [12, 12, 12, 12],
]
const BL_EDGE_FACE = [
  [0, 1, 2, 3], [1, -1, -1, 0], [-1, 2, -1, 0], [-1, 0, -1, 2], [0, 1, -1, 2],
  [1, 2, -1, 0], [-1, 4, -1, 1], [-1, 3, 4, -1], [-1, 0, 2, -1], [-1, -1, 2, 0],
  [0, 2, 5, 3], [0, -1, 6, -1], [0, 1, 2, 3],
]
const BL_OVERLAY_FACES = [4, 2, 1, 1, 2, 2, 3, 1, 3, 3, 3, 2, 0]
const BL_UNDERLAY_FACES = [0, 4, 3, 3, 1, 1, 3, 5, 1, 5, 3, 6, 4]

// Per shape, whether the shape already puts a face on each of its four edges
// (client aBoolArrayArray3816 non-blending / 3793 blending). A tile only asks a
// neighbour for an extra edge face where its own shape has none, so the feather
// is cooperative: a blending shape makes its neighbours subdivide too.
const NB_EDGE_HAS_FACE: boolean[][] = [
  [false, false, false, false], [false, false, false, false],
  [false, false, true, false], [false, false, true, false],
  [false, false, true, false], [false, false, true, false],
  [true, false, true, false], [true, false, false, true],
  [true, false, false, true], [false, false, false, false],
  [false, false, false, false], [false, false, false, false],
  [false, false, false, false],
]
const BL_EDGE_HAS_FACE: boolean[][] = [
  [false, false, false, false], [false, true, true, false],
  [true, false, true, false], [true, false, true, false],
  [false, false, true, false], [false, false, true, false],
  [true, false, true, false], [true, false, false, true],
  [true, false, false, true], [true, true, false, false],
  [false, false, false, false], [false, true, false, true],
  [false, false, false, false],
]

// Vertex index → position within the 512-unit tile (0-7 perimeter ring from
// the SW corner, 8-11 interior, 12 centre).
const VERTEX_DELTA_X = [0, 256, 512, 512, 512, 256, 0, 0, 128, 256, 128, 384, 256]
const VERTEX_DELTA_Y = [0, 0, 0, 256, 512, 512, 512, 256, 256, 384, 128, 128, 256]

// MapLoader.OVERLAY_SHAPE_SUPPORTS_HEIGHT — per shape, which vertex ids (in
// UNROTATED shape space) belong to the overlay portion of the tile.
const OVERLAY_SHAPE_COVERS: boolean[][] = [
  [true, true, true, true, true, true, true, true, true, true, true, true, true],
  [true, true, true, false, false, false, true, true, false, false, false, false, true],
  [true, false, false, false, false, true, true, true, false, false, false, false, false],
  [false, false, true, true, true, true, false, false, false, false, false, false, false],
  [true, true, true, true, true, true, false, false, false, false, false, false, false],
  [true, true, true, false, false, true, true, true, false, false, false, false, false],
  [true, true, false, false, false, true, true, true, false, false, false, false, true],
  [true, true, false, false, false, false, false, true, false, false, false, false, false],
  [false, true, true, true, true, true, true, true, false, false, false, false, false],
  [true, false, false, false, true, true, true, true, true, true, false, false, false],
  [true, true, true, true, true, false, false, false, true, true, false, false, false],
  [true, true, true, false, false, false, false, false, false, false, true, true, false],
  [false, false, false, false, false, false, false, false, false, false, false, false, false],
  [true, true, true, true, true, true, true, true, true, true, true, true, true],
  [false, false, false, false, false, false, false, false, false, false, false, false, false],
]

/** Does a tile's overlay (shape+rotation) cover the tile corner? Corner ids
 *  in position space: 0=SW(0,0), 2=SE(512,0), 4=NE(512,512), 6=NW(0,512);
 *  the client's rotation algebra maps a position back to the unrotated
 *  vertex id as (corner + 2·rotation) & 7. */
function overlayCoversCorner(shape: number, rotation: number, cornerId: number): boolean {
  return OVERLAY_SHAPE_COVERS[shape]?.[(cornerId + 2 * rotation) & 0x7] === true
}

// ---------------------------------------------------------------------------
// Config inputs
// ---------------------------------------------------------------------------

export type FluJson = { id: number; rgb?: number; texture?: number; scale?: number }
export type FloJson = {
  id: number
  colorRgb?: number
  texture?: number
  textureScale?: number
  /** Opcode 7 — the client's `secondaryRGB`. `minimapColorRgb` is what dumps
   *  made before 2026-07-25 call it; `floSecondaryRgb` reads either. */
  secondaryRgb?: number
  minimapColorRgb?: number
  waterColor?: number
  blendsWithUnderlay?: boolean
  /** layering priority for corner-colour blending between overlays. */
  slot?: number
}

export type SceneConfigs = {
  underlays: Map<number, FluJson>
  overlays: Map<number, FloJson>
}

/** Does this overlay's colour bleed into neighbouring ground vertices? */
function isCornerBlendable(flo: FloJson | undefined): boolean {
  return flo !== undefined && flo.blendsWithUnderlay === true
}

/** Client slot priority is a composite: (slot << 8) | overlayId (FloType.postDecode). */
function floSlotKey(flo: FloJson, id: number): number {
  return ((flo.slot ?? 8) << 8) | id
}

export async function loadSceneConfigs(rootHandle: FileSystemDirectoryHandle): Promise<SceneConfigs> {
  async function loadDir(name: string): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>()
    try {
      const configDir = await rootHandle.getDirectoryHandle('config')
      const dir = await configDir.getDirectoryHandle(name)
      const reads: Promise<void>[] = []
      for await (const handle of dir.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (isNaN(id)) continue
        reads.push((async () => {
          try {
            out.set(id, JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()))
          } catch { /* skip unreadable */ }
        })())
      }
      await Promise.all(reads)
    } catch { /* entry not dumped */ }
    return out
  }
  const [underlays, overlays] = await Promise.all([loadDir('underlays'), loadDir('overlays')])
  return { underlays: underlays as Map<number, FluJson>, overlays: overlays as Map<number, FloJson> }
}

// The magic RGB that means "no colour" for flo colours (16711935 = pure magenta).
const NO_COLOR = 16711935

// The map dumper's hand-made 4×4 overlay pixel masks (cryogen-website
// MapImageDumper/MapConstants.TILE_SHAPES) — row-major with rows TOP-DOWN
// (canvas order), indexed by overlay shape 0-11; TILE_ROTATIONS permutes
// pixel indices per rotation. Missing shapes fall back to a full square.
const DUMP_TILE_SHAPES: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
]
const DUMP_TILE_ROTATIONS: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [12, 8, 4, 0, 13, 9, 5, 1, 14, 10, 6, 2, 15, 11, 7, 3],
  [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  [3, 7, 11, 15, 2, 6, 10, 14, 1, 5, 9, 13, 0, 4, 8, 12],
]

/** Map-style minimap ground for one region+plane, 4px per tile — ported from
 *  cryogen-website's MapImageDumper (the /map route): per-tile underlay RGBs
 *  box-blurred in plain RGB space (no lighting/shadows/HSL — the clean
 *  classic map look, with no quantisation steps to see), then overlays
 *  painted flat through the dumper's hand-made pixel masks. Bridge tiles
 *  (linked/visible-below on the plane above) draw the plane-above overlay.
 *  `blurred` comes from SceneMosaic.underlayRgbBlurFor (cross-region, so no
 *  seams at region borders). 256×256 RGBA. */
export async function renderMinimapGround(
  terrain: MapTerrain,
  configs: SceneConfigs,
  plane: number,
  blurred: Int32Array,
  assets: LocAssets,
): Promise<Uint8ClampedArray> {
  const W = SIZE * 4
  const out = new Uint8ClampedArray(W * W * 4)

  // per-overlay colour — the dumper's getOverlayRGB rule: colorRgb unless
  // invalid (absent/0/-1/magenta), else the secondary colour; the texture's
  // average colour only when still unresolved
  const invalidCol = (c: number | undefined): boolean => c === undefined || c === 0 || c === -1 || c === NO_COLOR
  const overlayCol = new Map<number, number>()
  const overlayIdsUsed = new Set<number>()
  for (let i = 0; i < terrain.overlayIds.length; i++) {
    const id = terrain.overlayIds[i] & 0xff
    if (id !== 0) overlayIdsUsed.add(id)
  }
  for (const id of overlayIdsUsed) {
    const flo = configs.overlays.get(id - 1)
    let col = !flo || invalidCol(flo.colorRgb) ? floSecondaryRgb(flo) : flo.colorRgb!
    if (invalidCol(col)) col = 0
    if (col === 0 && flo?.texture !== undefined && flo.texture >= 0) {
      const meta = await assets.getMaterialMeta(flo.texture)
      if (meta && meta.avgRgb !== -1) col = meta.avgRgb
    }
    overlayCol.set(id, col)
  }

  // ground: the blurred underlay colour, flat per tile (empty tiles stay black)
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const rgb = blurred[x * SIZE + y]
      const rowBase = (SIZE - 1 - y) * 4 // north up
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const o = ((rowBase + py) * W + x * 4 + px) * 4
          if (rgb >= 0) {
            out[o] = (rgb >> 16) & 0xff
            out[o + 1] = (rgb >> 8) & 0xff
            out[o + 2] = rgb & 0xff
          }
          out[o + 3] = 255
        }
      }
    }
  }

  // overlays through the dumper masks (rows are canvas top-down)
  const drawOverlay = (x: number, y: number, p: number) => {
    const idx = tileIndex(p, x, y)
    const overlayId = terrain.overlayIds[idx] & 0xff
    if (overlayId === 0) return
    const col = overlayCol.get(overlayId) ?? 0
    // fully colourless overlays (e.g. the invisible plane-1 marker overlay
    // 42, all channels magenta) — the dumper paints these black, but the
    // ground showing through is what the client does
    if (col === 0) return
    const shapeRot = terrain.overlayShapeRot[idx] & 0xff
    const shapeMask = DUMP_TILE_SHAPES[shapeRot >> 2]
    const rotIdx = DUMP_TILE_ROTATIONS[shapeRot & 0x3]
    const rowBase = (SIZE - 1 - y) * 4
    for (let si = 0; si < 16; si++) {
      if (shapeMask !== undefined && shapeMask[rotIdx[si]] === 0) continue
      const o = ((rowBase + (si >> 2)) * W + x * 4 + (si & 0x3)) * 4
      out[o] = (col >> 16) & 0xff
      out[o + 1] = (col >> 8) & 0xff
      out[o + 2] = col & 0xff
      out[o + 3] = 255
    }
  }
  // linked below (0x2, bridges) or visible below (0x8)
  const belowFlagged = (p: number, x: number, y: number) => (terrain.tileFlags[tileIndex(p, x, y)] & 0xa) !== 0
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (plane === 0 || !belowFlagged(plane, x, y)) drawOverlay(x, y, plane)
      if (plane < 3 && belowFlagged(plane + 1, x, y)) drawOverlay(x, y, plane + 1)
    }
  }
  return out
}

/** Opcode 7, under either spelling — see `FloJson.secondaryRgb`. Returns -1
 *  ("no colour") for the magenta sentinel, matching the client, whose decode
 *  runs the same rgb→hsl conversion with its magenta special case. */
function floSecondaryRgb(flo: FloJson | undefined): number {
  const v = flo?.secondaryRgb ?? flo?.minimapColorRgb
  return v === undefined || v === NO_COLOR ? -1 : v
}

function floTileHsl(flo: FloJson | undefined): number {
  if (!flo) return -1
  // The secondary colour (opcode 7) is deliberately NOT a fallback here. The
  // client sets the tile colour from primaryRGB alone (`anInt3850`), so an
  // overlay with no tile colour and no texture is invisible in the main view
  // (e.g. bridge decks, where the bridge MODEL provides the visible surface)
  // even though it still paints the minimap. Its other two jobs — the material
  // colour channel, and gating whether the overlay counts at all — are
  // separate; see EDITOR.md.
  if (flo.colorRgb !== undefined && flo.colorRgb !== NO_COLOR) return rgbToHsl16(flo.colorRgb)
  return -1
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

const VERTS = SIZE + 1 // 65 vertices per axis
const CHUNK = 8 // tiles per chunk — 8×8 chunks per region axis

/** Per-plane 65×65 vertex heights in RS units (negative = up). MapLoader.decodeTile. */
export function computeHeights(terrain: MapTerrain, regionX: number, regionY: number): Int32Array[] {
  const planes: Int32Array[] = []
  const presence = terrain.heightPresence
  const values = terrain.heightValue
  for (let plane = 0; plane < 4; plane++) {
    const heights = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        // vertex (x, y) is decoded from tile (x, y); the 65th row/column comes
        // from the neighbouring region in the client — approximate by
        // duplicating the edge tile (the noise path stays exact, it's global)
        const tx = Math.min(x, SIZE - 1)
        const ty = Math.min(y, SIZE - 1)
        const idx = tileIndex(plane, tx, ty)
        const hasHeight = (presence[idx >> 3] & (1 << (idx & 0x7))) !== 0
        let h: number
        if (hasHeight) {
          let v = values[idx] & 0xff
          if (v === 1) v = 0
          if (plane === 0) h = -((v * 8) << 2)
          else h = planes[plane - 1][x * VERTS + y] - ((v * 8) << 2)
        } else if (plane === 0) {
          const absX = regionX * 64 + x
          const absY = regionY * 64 + y
          h = -calculateTileHeight(absX + 932731, absY + 556238) * 8 << 2
        } else {
          h = planes[plane - 1][x * VERTS + y] - 960
        }
        heights[x * VERTS + y] = h
      }
    }
    planes.push(heights)
  }
  return planes
}

/** Per-vertex water depth grid from the underwater ("um") terrain: the um
 *  explicit-height value (client units, heightValue*32) at each vertex corner,
 *  0 where absent. This is the riverbed's downward offset from the water
 *  surface — the client's texcoord0.z that drives shoreFactor. */
export function computeWaterDepth(underwater: MapTerrain): Int32Array[] {
  const presence = underwater.heightPresence
  const values = underwater.heightValue
  const planes: Int32Array[] = []
  for (let plane = 0; plane < 4; plane++) {
    const depth = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const tx = Math.min(x, SIZE - 1)
        const ty = Math.min(y, SIZE - 1)
        const idx = tileIndex(plane, tx, ty)
        const hasHeight = (presence[idx >> 3] & (1 << (idx & 0x7))) !== 0
        // um heights are stored positive = downward depth (client i_13*8 << 2).
        depth[x * VERTS + y] = hasHeight ? ((values[idx] & 0xff) * 8) << 2 : 0
      }
    }
    planes.push(depth)
  }
  return planes
}

/** Riverbed vertex heights = surface height + water depth (deeper = more
 *  positive in the decode convention, i.e. lower once rendered as Y = -h).
 *  Feeding these to buildTerrainMesh with the underwater terrain draws the
 *  submerged bed beneath the transparent water. */
export function computeRiverbedHeights(surface: Int32Array[], depth: Int32Array[]): Int32Array[] {
  return surface.map((plane, p) => {
    const out = new Int32Array(plane.length)
    for (let i = 0; i < plane.length; i++) out[i] = plane[i] + depth[p][i]
    return out
  })
}

/** Ground.getAverageHeight — bilinear height at 512-scale scene coords. */
export function averageHeight(heights: Int32Array, sceneX: number, sceneY: number): number {
  const tileX = sceneX >> 9
  const tileY = sceneY >> 9
  if (tileX < 0 || tileY < 0 || tileX > VERTS - 2 || tileY > VERTS - 2) {
    const cx = Math.min(Math.max(tileX, 0), VERTS - 1)
    const cy = Math.min(Math.max(tileY, 0), VERTS - 1)
    return heights[cx * VERTS + cy]
  }
  const offX = sceneX & 511
  const offY = sceneY & 511
  const h1 = (heights[tileX * VERTS + tileY] * (512 - offX) + offX * heights[(tileX + 1) * VERTS + tileY]) >> 9
  const h2 = (heights[tileX * VERTS + tileY + 1] * (512 - offX) + heights[(tileX + 1) * VERTS + tileY + 1] * offX) >> 9
  return (h2 * offY + h1 * (512 - offY)) >> 9
}

// ---------------------------------------------------------------------------
// Terrain geometry
// ---------------------------------------------------------------------------

/** Region sun parameters (from the map environment tail), client defaults. */
export type SunConfig = {
  /** RS-space direction, environment `sunPosition` (client shifts <<2). */
  x: number
  y: number
  z: number
  /** environment sunAmbient — client: intensity = (0.7 + brightness·0.1) · ambient · 65535 */
  ambient: number
}

export const DEFAULT_SUN: SunConfig = { x: -50, y: -60, z: -50, ambient: 1.1523438 }

// Ground light grid — per-vertex f_53 from the height-gradient normal, the
// client formula below (two-sided, full range). The old half-Lambert grid this
// replaced was described as "OpenGLGround/the Model GLSL", i.e. neither the
// hardware ground nor the low-detail path the reference client runs.
// Client HardwareGround vertex lighting (the DX/hardware ground, low lighting
// detail — the path Cody's client runs). HardwareGround.java:907-965:
//   strength  = 74 − staticShadow                       (byte b_51 = 74)
//   lightness'= (hsl & 0x7f) · strength >> 7, clamp 2..126   ← INSIDE the HSL
//   f_53      = ambient + N·L · (N·L > 0 ? sunLight : backlight)
//   colour    = palette[hsl&0xff80 | lightness'] · f_53, clamped per channel
// This replaced a GroundSM/half-Lambert hybrid on 2026-07-26 — the old grid
// was `hl·1.0 + 0.3` with the shadow as a separate RGB multiply, which matched
// on flat unshadowed ground by numeric coincidence (0.578^0.7·1.604 ≈ 1.123)
// but had the wrong shadow curve and compressed slope contrast.
const GROUND_STRENGTH_BASE = 74
const GROUND_AMBIENT = DEFAULT_MODEL_SUN.ambientColour[0] // 1.1523438
const GROUND_SUN = DEFAULT_MODEL_SUN.sunColour[0] // 0.69921875
const GROUND_BACKLIGHT = DEFAULT_MODEL_SUN.antiSunColour[0] // 1.2
// display-space factor a full-strength lightness cut works out to through the
// palette's pow-0.7 — the textured (neutral-tint) path has no lightness to
// scale, so it takes the equivalent multiplier instead
const GROUND_CUT_DISPLAY = Math.pow(GROUND_STRENGTH_BASE / 128, 0.7) // ≈0.681
function computeVertexLightGrid(heights: Int32Array, verts: number, brightness = 1): Float32Array {
  const sl = Math.hypot(DEFAULT_MODEL_SUN.dir[0], DEFAULT_MODEL_SUN.dir[1], DEFAULT_MODEL_SUN.dir[2]) || 1
  const sdx = DEFAULT_MODEL_SUN.dir[0] / sl, sdy = DEFAULT_MODEL_SUN.dir[1] / sl, sdz = DEFAULT_MODEL_SUN.dir[2] / sl
  const light = new Float32Array(verts * verts)
  for (let x = 0; x < verts; x++) {
    for (let y = 0; y < verts; y++) {
      // client computes 1..size-1 only; clamp neighbours so edges get lit too
      const xm = Math.max(x - 1, 0), xp = Math.min(x + 1, verts - 1)
      const ym = Math.max(y - 1, 0), yp = Math.min(y + 1, verts - 1)
      const dhx = heights[xp * verts + y] - heights[xm * verts + y]
      const dhy = heights[x * verts + yp] - heights[x * verts + ym]
      // GL ground normal from the height surface (positions are (x, −h, −y)):
      // n = normalize(dhx, 1024, −dhy) → flat ground points +y (up).
      const len = Math.hypot(dhx, 1024, dhy) || 1
      const nx = dhx / len, ny = 1024 / len, nz = -dhy / len
      // client f_53 — two-sided, full range, no half-Lambert compression
      // The client Brightness preference scales ONLY the ambient term:
      // Class239:141 — IA((0.7 + brightness·0.1) · 1.1523438). Default 3 → ×1.
      const ndl = sdx * nx + sdy * ny + sdz * nz
      light[x * verts + y] = GROUND_AMBIENT * brightness + ndl * (ndl > 0 ? GROUND_SUN : GROUND_BACKLIGHT)
    }
  }
  return light
}

function computeVertexLight(heights: Int32Array, brightness = 1): Float32Array {
  return computeVertexLightGrid(heights, VERTS, brightness)
}

/** Bilinear brightness multiplier at 512-scale coords (GL ground vertex light). */
function lightAt(light: Float32Array, sceneX: number, sceneY: number): number {
  const tileX = Math.min(sceneX >> 9, VERTS - 2)
  const tileY = Math.min(sceneY >> 9, VERTS - 2)
  const offX = sceneX & 511
  const offY = sceneY & 511
  const la = light[(tileX + 1) * VERTS + tileY] * offX + light[tileX * VERTS + tileY] * (512 - offX)
  const lb = light[tileX * VERTS + tileY + 1] * (512 - offX) + light[(tileX + 1) * VERTS + tileY + 1] * offX
  return (la * (512 - offY) + lb * offY) / (512 * 512)
}

// ---------------------------------------------------------------------------
// Cross-region mosaic: heights, lighting and underlay blur computed over the
// whole 3×3 neighbourhood in one grid, then sliced per region — adjacent
// slices share identical boundary values, so region seams vanish.
// ---------------------------------------------------------------------------

const MOSAIC = 3 * SIZE // 192 tiles across the 3×3
const MVERTS = MOSAIC + 1

export class SceneMosaic {
  private heights: Int32Array[] = [] // per plane, MVERTS²
  private lights: Float32Array[] = []
  private sliceCache = new Map<string, { heights: Int32Array[]; lights: Float32Array[] }>()
  /** regions[dx+1][dy+1]; null when that neighbour isn't dumped. */
  private regions: (MapTerrain | null)[][]
  private regionX: number
  private regionY: number
  private configs: SceneConfigs

  constructor(
    regions: (MapTerrain | null)[][],
    regionX: number,
    regionY: number,
    configs: SceneConfigs,
    _sun: SunConfig = DEFAULT_SUN,
    /** client Brightness preference factor (0.7 + 0.1·pref); ambient only */
    brightness = 1,
  ) {
    this.regions = regions
    this.regionX = regionX
    this.regionY = regionY
    this.configs = configs
    for (let plane = 0; plane < 4; plane++) {
      const h = new Int32Array(MVERTS * MVERTS)
      const prev = plane > 0 ? this.heights[plane - 1] : null
      for (let gx = 0; gx < MVERTS; gx++) {
        for (let gy = 0; gy < MVERTS; gy++) {
          const tx = Math.min(gx, MOSAIC - 1)
          const ty = Math.min(gy, MOSAIC - 1)
          const rdx = Math.floor(tx / SIZE)
          const rdy = Math.floor(ty / SIZE)
          const terrain = this.regions[rdx]?.[rdy]
          let presence = false
          let value = 0
          if (terrain) {
            const idx = tileIndex(plane, tx - rdx * SIZE, ty - rdy * SIZE)
            presence = (terrain.heightPresence[idx >> 3] & (1 << (idx & 0x7))) !== 0
            value = terrain.heightValue[idx] & 0xff
          }
          let out: number
          if (presence) {
            if (value === 1) value = 0
            out = plane === 0 ? -((value * 8) << 2) : prev![gx * MVERTS + gy] - ((value * 8) << 2)
          } else if (plane === 0) {
            const absX = (this.regionX - 1) * 64 + gx
            const absY = (this.regionY - 1) * 64 + gy
            out = -calculateTileHeight(absX + 932731, absY + 556238) * 8 << 2
          } else {
            out = prev![gx * MVERTS + gy] - 960
          }
          h[gx * MVERTS + gy] = out
        }
      }
      this.heights.push(h)
      this.lights.push(computeVertexLightGrid(h, MVERTS, brightness))
    }
  }

  /** 65×65 per-plane height slices for one region (region-local layout). */
  slicesFor(dx: number, dy: number): { heights: Int32Array[]; lights: Float32Array[] } {
    const key = `${dx},${dy}`
    let cached = this.sliceCache.get(key)
    if (cached) return cached
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const heights: Int32Array[] = []
    const lights: Float32Array[] = []
    for (let plane = 0; plane < 4; plane++) {
      const h = new Int32Array(VERTS * VERTS)
      const l = new Float32Array(VERTS * VERTS)
      for (let x = 0; x < VERTS; x++) {
        for (let y = 0; y < VERTS; y++) {
          h[x * VERTS + y] = this.heights[plane][(baseX + x) * MVERTS + baseY + y]
          l[x * VERTS + y] = this.lights[plane][(baseX + x) * MVERTS + baseY + y]
        }
      }
      heights.push(h)
      lights.push(l)
    }
    cached = { heights, lights }
    this.sliceCache.set(key, cached)
    return cached
  }

  /** Cross-region 11×11 blurred underlay palette for one region+plane.
   *  65×65 (VERTS²): entry [x][y] is the blur centred on tile (x, y), with
   *  the 65th row/column sampled from the neighbouring region — tile corner
   *  vertices blend between the palettes of the 4 tiles meeting there
   *  (addUnderlayTiles), so consumers need one tile beyond the region. */
  paletteFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const palette = new Int32Array(VERTS * VERTS).fill(-1)
    const fluCache = new Map<number, { hue: number; saturation: number; lightness: number; divisor: number }>()
    const compAt = (gx: number, gy: number) => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return null
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return null
      const id = terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
      if (id === 0) return null
      let c = fluCache.get(id)
      if (!c) {
        const flu = this.configs.underlays.get(id - 1)
        c = fluComponents(flu?.rgb ?? 0)
        fluCache.set(id, c)
      }
      return c
    }
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        let hue = 0, sat = 0, light = 0, div = 0, n = 0
        for (let ox = -5; ox <= 5; ox++) {
          for (let oy = -5; oy <= 5; oy++) {
            const c = compAt(baseX + x + ox, baseY + y + oy)
            if (c) {
              hue += c.hue
              sat += c.saturation
              light += c.lightness
              div += c.divisor
              n++
            }
          }
        }
        if (div > 0 && n > 0) {
          palette[x * VERTS + y] = packBlurredHsl(
            Math.trunc((hue * 256) / div),
            Math.trunc(sat / n),
            Math.trunc(light / n),
          )
        }
      }
    }
    return palette
  }

  /** Cross-region blendable-overlay corner field (VERTS²): for each tile
   *  corner, the id of the highest-slot `blendsWithUnderlay` overlay whose
   *  shape covers that corner among the 4 tiles meeting there, or -1. Ground
   *  vertices at these corners take the overlay's colour instead of the
   *  blurred palette (the client's calculateOverlayDisplay slot machinery) —
   *  this is what melts roads/mud patches into the surrounding ground. */
  overlayCornerFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(VERTS * VERTS).fill(-1)
    const tileAt = (gx: number, gy: number): number => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return 0
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return 0
      const idx = tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)
      const oid = terrain.overlayIds[idx] & 0xff
      if (oid === 0) return 0
      // pack id + shapeRot so the caller-side check has both
      return oid | ((terrain.overlayShapeRot[idx] & 0xff) << 8)
    }
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const gx = baseX + x
        const gy = baseY + y
        let best = -1
        let bestSlot = -Infinity
        // (tile dx, tile dy, corner id of this vertex within that tile)
        const candidates: [number, number, number][] = [
          [gx - 1, gy - 1, 4], // vertex is that tile's NE corner
          [gx, gy - 1, 6],     // NW
          [gx - 1, gy, 2],     // SE
          [gx, gy, 0],         // SW
        ]
        for (const [tx, ty, corner] of candidates) {
          const packed = tileAt(tx, ty)
          if (packed === 0) continue
          const oid = packed & 0xff
          const flo = this.configs.overlays.get(oid - 1)
          if (!flo || !isCornerBlendable(flo)) continue
          const shapeRot = packed >> 8
          if (!overlayCoversCorner(shapeRot >> 2, shapeRot & 0x3, corner)) continue
          const slot = floSlotKey(flo, oid)
          if (slot >= bestSlot) {
            bestSlot = slot
            best = oid
          }
        }
        out[x * VERTS + y] = best
      }
    }
    return out
  }

  /** Per-tile underlay RGB box-blurred in plain RGB space — the map dumper's
   *  blendUnderlay (cryogen-website MapImageDumper), with its exact window
   *  (canvas [-3,+2] each axis → tile x [-3,+2], tile y [-2,+3]) and its
   *  skip-empties rule, but sampling neighbour regions through the mosaic so
   *  region borders don't seam. -1 = tile has no underlay (stays black). */
  underlayRgbBlurFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(SIZE * SIZE).fill(-1)
    const rgbCache = new Map<number, number>()
    const rgbAt = (gx: number, gy: number): number => {
      if (gx < 0 || gy < 0 || gx >= MOSAIC || gy >= MOSAIC) return -1
      const rdx = Math.floor(gx / SIZE)
      const rdy = Math.floor(gy / SIZE)
      const terrain = this.regions[rdx]?.[rdy]
      if (!terrain) return -1
      const id = terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
      if (id === 0) return -1
      let c = rgbCache.get(id)
      if (c === undefined) {
        c = this.configs.underlays.get(id - 1)?.rgb ?? -1
        rgbCache.set(id, c)
      }
      return c
    }
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        // (the dumper skips tiles with no own underlay, leaving black
        // pinholes under some trees — averaging the window regardless fills
        // them with the surrounding ground instead)
        let r = 0, g = 0, b = 0, n = 0
        for (let ox = -3; ox <= 2; ox++) {
          for (let oy = -2; oy <= 3; oy++) {
            const c = rgbAt(baseX + x + ox, baseY + y + oy)
            if (c === -1) continue
            r += (c >> 16) & 0xff
            g += (c >> 8) & 0xff
            b += c & 0xff
            n++
          }
        }
        if (n > 0) out[x * SIZE + y] = (Math.trunc(r / n) << 16) | (Math.trunc(g / n) << 8) | Math.trunc(b / n)
      }
    }
    return out
  }

  /** Cross-region per-tile underlay ids at 65×65 (the 65th row/column from
   *  the neighbouring region) — each terrain vertex renders the TEXTURE of
   *  the tile whose origin sits at that corner (addUnderlayTiles), which the
   *  splatting passes crossfade between. */
  underlayCornerFor(dx: number, dy: number, plane: number): Int32Array {
    const baseX = (dx + 1) * SIZE
    const baseY = (dy + 1) * SIZE
    const out = new Int32Array(VERTS * VERTS)
    for (let x = 0; x < VERTS; x++) {
      for (let y = 0; y < VERTS; y++) {
        const gx = Math.min(baseX + x, MOSAIC - 1)
        const gy = Math.min(baseY + y, MOSAIC - 1)
        const rdx = Math.floor(gx / SIZE)
        const rdy = Math.floor(gy / SIZE)
        const terrain = this.regions[rdx]?.[rdy]
        out[x * VERTS + y] = terrain
          ? terrain.underlayIds[tileIndex(plane, gx - rdx * SIZE, gy - rdy * SIZE)] & 0xff
          : 0
      }
    }
    return out
  }
}

/** Single-region fallback of SceneMosaic.underlayCornerFor (edges clamp). */
function computeUnderlayCornerIds(terrain: MapTerrain, plane: number): Int32Array {
  const out = new Int32Array(VERTS * VERTS)
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      const tx = Math.min(x, SIZE - 1)
      const ty = Math.min(y, SIZE - 1)
      out[x * VERTS + y] = terrain.underlayIds[tileIndex(plane, tx, ty)] & 0xff
    }
  }
  return out
}

/**
 * Per-tile perimeter overlay winners — a port of `Class329.method5848`
 * (bot-refactor: `calculateOverlayDisplay`), the machinery that feathers a
 * `blendsWithUnderlay` overlay into whatever it borders.
 *
 * The client keeps five parallel 8-slot arrays per tile — colour, blend
 * colour, texture, texture scale and slot (`anIntArray3838/3839/3813/3827/
 * 3842`) — one entry per vertex of the tile's PERIMETER RING (ids 0-7, the
 * four corners interleaved with the four edge midpoints). Each slot records
 * the highest-`slot` blendable overlay of the neighbouring tiles that reaches
 * that vertex. `method5850` then gives any overlay vertex whose winner
 * outranks the tile's own overlay the winner's colour AND texture AND scale,
 * so the GPU interpolates one material into the other across the face.
 *
 * We only store the winning overlay id here (0/-1 = none); colour, texture and
 * scale are looked up from its FloType at emit time.
 *
 * Two passes, in the client's order:
 *  - the four DIAGONAL neighbours each claim one corner outright, no slot test
 *  - the four EDGE neighbours then sweep three consecutive perimeter vertices
 *    each, taking the slot on `<=` so a tie goes to the later writer
 *
 * `q` walks the neighbour's own ring in the opposite direction to `p` — the
 * two tiles meet mirrored across the shared edge — and is converted into the
 * neighbour's UNROTATED shape space (`+ 2*rot`) to test its coverage table.
 *
 * Returns SIZE*SIZE*8. Single-region: this doesn't reach across the mosaic, so
 * a blend that should cross a region seam stops at it (the same limitation
 * `computeOverlayCorners` has against `SceneMosaic.overlayCornerFor`).
 */
function computeOverlayPerimeter(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const out = new Int32Array(SIZE * SIZE * 8).fill(-1)
  const slots = new Int32Array(8)
  const at = (tx: number, ty: number): { id: number; shape: number; rot: number; flo: FloJson } | null => {
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return null
    const idx = tileIndex(plane, tx, ty)
    const id = terrain.overlayIds[idx] & 0xff
    if (id === 0) return null
    const flo = configs.overlays.get(id - 1)
    if (!flo || !isCornerBlendable(flo)) return null
    const sr = terrain.overlayShapeRot[idx] & 0xff
    return { id, shape: sr >> 2, rot: sr & 0x3, flo }
  }
  // shape-space coverage test, `aBoolArrayArray3822[shape][q]`
  const covers = (shape: number, q: number) => OVERLAY_SHAPE_COVERS[shape]?.[q & 0x7] === true
  // (dx, dy, perimeter vertex it claims, offset into the neighbour's ring)
  const DIAGONALS: [number, number, number, number][] = [
    [-1, -1, 0, 4], [+1, -1, 2, 6], [-1, +1, 6, 2], [+1, +1, 4, 0],
  ]
  // (dx, dy, first perimeter vertex, its step, first neighbour ring index, its step)
  const EDGES: [number, number, number, number, number, number][] = [
    [0, -1, 2, -1, 4, +1], // south
    [0, +1, 4, +1, 2, -1], // north
    [-1, 0, 6, +1, 4, -1], // west
    [+1, 0, 4, -1, 6, +1], // east
  ]
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const base = (x * SIZE + y) * 8
      slots.fill(-1)
      let wrote = false
      for (const [dx, dy, p, q0] of DIAGONALS) {
        const n = at(x + dx, y + dy)
        if (!n || !covers(n.shape, n.rot * 2 + q0)) continue
        out[base + p] = n.id
        slots[p] = floSlotKey(n.flo, n.id)
        wrote = true
      }
      for (const [dx, dy, p0, pStep, q0, qStep] of EDGES) {
        const n = at(x + dx, y + dy)
        if (!n) continue
        const key = floSlotKey(n.flo, n.id)
        for (let k = 0; k < 3; k++) {
          const p = (p0 + pStep * k) & 0x7
          const q = (n.rot * 2 + q0 + qStep * k) & 0x7
          if (!covers(n.shape, q) || slots[p] > key) continue
          out[base + p] = n.id
          slots[p] = key
          wrote = true
        }
      }
      if (!wrote) continue
    }
  }
  return out
}

/** Single-region fallback of SceneMosaic.overlayCornerFor (edges clamp). */
function computeOverlayCorners(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const out = new Int32Array(VERTS * VERTS).fill(-1)
  const tileAt = (tx: number, ty: number): number => {
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return 0
    const idx = tileIndex(plane, tx, ty)
    const oid = terrain.overlayIds[idx] & 0xff
    if (oid === 0) return 0
    return oid | ((terrain.overlayShapeRot[idx] & 0xff) << 8)
  }
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      let best = -1
      let bestSlot = -Infinity
      const candidates: [number, number, number][] = [
        [x - 1, y - 1, 4],
        [x, y - 1, 6],
        [x - 1, y, 2],
        [x, y, 0],
      ]
      for (const [tx, ty, corner] of candidates) {
        const packed = tileAt(tx, ty)
        if (packed === 0) continue
        const oid = packed & 0xff
        const flo = configs.overlays.get(oid - 1)
        if (!flo || !isCornerBlendable(flo)) continue
        const shapeRot = packed >> 8
        if (!overlayCoversCorner(shapeRot >> 2, shapeRot & 0x3, corner)) continue
        const slot = floSlotKey(flo, oid)
        if (slot >= bestSlot) {
          bestSlot = slot
          best = oid
        }
      }
      out[x * VERTS + y] = best
    }
  }
  return out
}

/** MapLoader.calculateUnderlayPalette — 11×11 box-blurred underlay HSL16 per
 *  tile, 65×65 (VERTS²) like SceneMosaic.paletteFor; the 65th row/column
 *  reuses the edge tiles (no neighbour region in this fallback path). */
function computeUnderlayPalette(terrain: MapTerrain, plane: number, configs: SceneConfigs): Int32Array {
  const palette = new Int32Array(VERTS * VERTS).fill(-1)
  type Acc = { hue: number; sat: number; light: number; div: number; n: number }
  // Precompute per-tile components
  const comp: ({ hue: number; saturation: number; lightness: number; divisor: number } | null)[] = new Array(SIZE * SIZE).fill(null)
  const fluCache = new Map<number, { hue: number; saturation: number; lightness: number; divisor: number }>()
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const id = terrain.underlayIds[tileIndex(plane, x, y)] & 0xff
      if (id > 0) {
        let c = fluCache.get(id)
        if (!c) {
          const flu = configs.underlays.get(id - 1)
          c = fluComponents(flu?.rgb ?? 0)
          fluCache.set(id, c)
        }
        comp[x * SIZE + y] = c
      }
    }
  }
  // Direct 11×11 window sum (simple; 64×64 region is small enough)
  const acc: Acc = { hue: 0, sat: 0, light: 0, div: 0, n: 0 }
  for (let x = 0; x < VERTS; x++) {
    for (let y = 0; y < VERTS; y++) {
      acc.hue = 0; acc.sat = 0; acc.light = 0; acc.div = 0; acc.n = 0
      for (let dx = -5; dx <= 5; dx++) {
        const cx = Math.min(x, SIZE - 1) + dx
        if (cx < 0 || cx >= SIZE) continue
        for (let dy = -5; dy <= 5; dy++) {
          const cy = Math.min(y, SIZE - 1) + dy
          if (cy < 0 || cy >= SIZE) continue
          const c = comp[cx * SIZE + cy]
          if (c) {
            acc.hue += c.hue
            acc.sat += c.saturation
            acc.light += c.lightness
            acc.div += c.divisor
            acc.n++
          }
        }
      }
      if (acc.div > 0 && acc.n > 0) {
        palette[x * VERTS + y] = packBlurredHsl(
          Math.trunc((acc.hue * 256) / acc.div),
          Math.trunc(acc.sat / acc.n),
          Math.trunc(acc.light / acc.n),
        )
      }
    }
  }
  return palette
}

// ---------------------------------------------------------------------------
// Texture-bucketed geometry assembly
// ---------------------------------------------------------------------------

/** Still water (rivers/sea): a self-coloured blue material with no scroll —
 *  the client animates these with its rippling-water effect; the viewer uses
 *  a gentle UV drift instead. Blue band of the 6-bit HSL16 hue wheel. */
export function isWaterMaterial(meta: MaterialMeta): boolean {
  if (meta.detailsOnly || meta.colorHsl < 0) return false
  const hue = (meta.colorHsl >> 10) & 0x3f
  return hue >= 34 && hue <= 45
}

type Bucket = { positions: number[]; colors: number[]; uvs: number[]; owners: number[]; alphas: number[]; depths: number[]; normals: number[] }

// blend buckets (terrain texture splatting) share the map under offset keys
const BLEND_KEY = 1 << 20
// Loc faces the client counts as transparent (`faceAlpha != 0 || blendType != 0`).
// The client's baked sort key is priority → transparent-flag → texture, with
// opaque ALWAYS before transparent (MeshRasterizer_Sub3's ctor). Buckets are
// emitted in ascending key order, so this reproduces the opaque-before-
// transparent half — the part that's meaningful here.
// `facePriorities` IS in the key: transparent loc faces are accumulated per loc
// (one mesh per loc, like the client), so priority orders faces within a single
// model — exactly what the client uses it for.
const TRANS_KEY = 1 << 22
const TRANS_PRIORITY_STEP = 1 << 12 // > any texture id (~2600)
/** Transparent faces a loc needs before it earns its own sortable mesh. */
const TRANSPARENT_OWN_MESH_FACES = 100

class BucketSet {
  buckets = new Map<number, Bucket>()

  get(textureId: number): Bucket {
    let b = this.buckets.get(textureId)
    if (!b) this.buckets.set(textureId, (b = { positions: [], colors: [], uvs: [], owners: [], alphas: [], depths: [], normals: [] }))
    return b
  }

  /** Transparent crossfade pass for terrain texture splatting: same geometry,
   *  per-vertex alpha fades this texture over the base pass. */
  getBlend(textureId: number): Bucket {
    return this.get(BLEND_KEY + textureId)
  }

  /** A loc face the client treats as transparent — ordered by face priority,
   *  then texture, after every opaque face. */
  getTransparent(textureId: number, priority = 0): Bucket {
    return this.get(TRANS_KEY + (priority & 0xff) * TRANS_PRIORITY_STEP + textureId + 1)
  }

  hasAny(): boolean {
    for (const b of this.buckets.values()) if (b.positions.length > 0) return true
    return false
  }

  faceCount(): number {
    let n = 0
    for (const b of this.buckets.values()) n += b.positions.length / 9
    return n
  }

  /** Fold another set's buckets into this one (same keys concatenate). */
  mergeFrom(other: BucketSet) {
    for (const [key, src] of other.buckets) {
      if (src.positions.length === 0) continue
      const dst = this.get(key)
      for (const v of src.positions) dst.positions.push(v)
      for (const v of src.colors) dst.colors.push(v)
      for (const v of src.uvs) dst.uvs.push(v)
      for (const v of src.owners) dst.owners.push(v)
      for (const v of src.alphas) dst.alphas.push(v)
      for (const v of src.depths) dst.depths.push(v)
      for (const v of src.normals) dst.normals.push(v)
    }
  }

  /** One mesh with a material group per texture (index -1 = plain vertex
   *  colours). Per-triangle owner ids (whatever the producer pushed) end up
   *  in mesh.userData.triangleOwners, aligned with raycast faceIndex.
   *  Materials with a UV scroll speed get userData.scroll (client convention:
   *  offset = seconds*speed/64); still-water materials (blue-hued,
   *  non-detail, no scroll) get userData.water for the ripple drift. */
  async toMesh(
    getTexture: (id: number) => Promise<THREE.Texture | null>,
    getMeta?: (id: number) => Promise<MaterialMeta | null>,
    // Locs bake their lit colour but not the detail-map normalisation the
    // terrain path does inline — set true so greyscale detail maps (tree leaves,
    // bark) don't darken the baked colour (255/avgLuma, same as emitTri).
    boostDetailMaps = false,
    // Which buckets to emit. The client draws opaque objects, then the ground,
    // then transparent objects (SceneObjectManager.method3441), so locs are
    // built as two meshes that the scene gives different renderOrders.
    select: 'all' | 'opaque' | 'transparent' = 'all',
    // Shared per-texture materials. With one mesh per transparent loc there are
    // hundreds of meshes drawing the same few leaf textures — reusing the
    // material keeps GPU state changes (and allocation) down.
    materialCache?: Map<number, THREE.Material>,
    /** Face culling. The client culls back faces and never turns it off —
     *  `DirectXRenderer` sets `D3DRS_CULLMODE = D3DCULL_CW` once at init and
     *  `OpenGLRenderer` does `glEnable(GL_CULL_FACE); glCullFace(GL_BACK)`.
     *  Loc meshes pass FrontSide to match; terrain and the skybox still default
     *  to DoubleSide because they haven't been checked for winding yet. */
    side: THREE.Side = THREE.DoubleSide,
  ): Promise<THREE.Mesh | null> {
    const entries = [...this.buckets.entries()].filter(([key, b]) => {
      if (b.positions.length === 0) return false
      if (select === 'opaque') return key < TRANS_KEY
      if (select === 'transparent') return key >= TRANS_KEY
      return true
    })
      // ascending key = opaque buckets, then crossfade, then transparent
      .sort(([a], [b]) => a - b)
    if (entries.length === 0) return null
    let total = 0
    for (const [, b] of entries) total += b.positions.length / 3
    const positions = new Float32Array(total * 3)
    const colors = new Float32Array(total * 4).fill(1)
    const uvs = new Float32Array(total * 2)
    const owners = new Int32Array(total / 3)
    // Per-vertex water depth (0 for non-water verts) — drives the water
    // surface shader's shore/transparency fade. Only populated when the caller
    // passed a depth grid and the vertex belongs to a water material.
    const waterDepth = new Float32Array(total)
    let anyDepth = false
    // Vertex normals, only for the specular materials that need them — the face
    // loops push normals per bucket, so most scenes allocate nothing here.
    const normals = entries.some(([, b]) => b.normals.length > 0) ? new Float32Array(total * 3) : null
    const geometry = new THREE.BufferGeometry()
    const materials: THREE.Material[] = []
    let vert = 0
    for (const [key, b] of entries) {
      const trans = key >= TRANS_KEY
      const blend = !trans && key >= BLEND_KEY
      const textureId = trans
        ? ((key - TRANS_KEY) % TRANS_PRIORITY_STEP) - 1
        : blend ? key - BLEND_KEY : key
      const count = b.positions.length / 3
      positions.set(b.positions, vert * 3)
      // Fetch material meta up front so the detail-map boost can scale the
      // baked colours as they're copied (leaves/bark greyscale-neutralised).
      const meta = textureId >= 0 && getMeta ? await getMeta(textureId) : null
      const boost = boostDetailMaps && meta?.detailsOnly ? 255 / meta.avgLuma : 1
      for (let i = 0; i < count; i++) {
        colors[(vert + i) * 4] = b.colors[i * 3] * boost
        colors[(vert + i) * 4 + 1] = b.colors[i * 3 + 1] * boost
        colors[(vert + i) * 4 + 2] = b.colors[i * 3 + 2] * boost
        if (b.alphas.length > 0) colors[(vert + i) * 4 + 3] = b.alphas[i]
      }
      if (b.depths.length > 0) {
        waterDepth.set(b.depths, vert)
        anyDepth = true
      }
      if (normals && b.normals.length > 0) normals.set(b.normals, vert * 3)
      uvs.set(b.uvs, vert * 2)
      owners.set(b.owners, vert / 3)
      geometry.addGroup(vert, count, materials.length)
      const cached = materialCache?.get(key)
      if (cached) {
        materials.push(cached)
        vert += count
        continue
      }
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, side })
      if (blend) {
        // terrain crossfade pass: coplanar with its base face (depthFunc
        // LEQUAL), alpha-faded per vertex, never writes depth
        material.transparent = true
        material.depthWrite = false
      } else if (trans) {
        // Client-transparent loc faces: blended, depth-TESTED against the opaque
        // scene but not depth-WRITING. Writing depth makes leaf faces inside one
        // merged mesh reject each other — the winner depends on bucket order, so
        // fronds pop in and out as the camera turns (willow-over-water showed the
        // water through the canopy). The client can't hit that: its alpha test is
        // a no-op (ALPHAREF=0/GREATEREQUAL, set once in DirectXRenderer init and
        // never changed), so it is pure ordered blending. Correct compositing
        // against the ground comes from pass order (renderOrder), not depth.
        material.transparent = true
        material.depthWrite = false
      }
      if (textureId >= 0) {
        const texture = await getTexture(textureId)
        if (texture) {
          // each animated material needs its own texture instance so offsets
          // don't leak across materials sharing a cached THREE.Texture
          const animated = meta && (meta.speedU !== 0 || meta.speedV !== 0 || isWaterMaterial(meta))
          material.map = animated ? texture.clone() : texture
          // NO alpha test, ever — the client's is a no-op (ALPHAREF=0,
          // GREATEREQUAL, set once in DirectXRenderer init and never changed)
          // and none of the 18 dumped fragment shaders discards.
          //
          // This used to cut opaque faces at 0.35, left over from before the
          // transparency trace, and it silently deleted every surface textured
          // with an `effectId: 1` material: that's the client's specular /
          // env-mapped shader mode (MeshRasterizer_Sub3 switches on effectId,
          // and 1_12.vert's `ShaderMode == 1` branch builds a reflected view
          // vector), where the texture's ALPHA IS A GLOSS MASK, not opacity.
          // Textures 90/91/109/266 sit at alpha 38-70, i.e. 100% below the
          // threshold, so barrel rings, the Lumbridge sink and cooking range,
          // and every grey stone trim vanished entirely. Cutout foliage is
          // unaffected: the leaf texture that actually carries a soft alpha
          // mask (922) is `effectCombiner: 2`, so it takes the blended path
          // where the threshold was already 0.
          material.alphaTest = 0
          // Reflective materials: the client replaces the sampled alpha with
          // the vertex alpha, so it must not multiply into opacity here. Matters
          // for the crossfade and transparent buckets, where it would otherwise
          // fade a blended ground seam down to its texture's alpha (~15-25%).
          // effectId 1 additionally gets its specular highlight back — but only
          // where the bucket carries normals to compute it from.
          if (meta && effectIgnoresTextureAlpha(meta)) {
            const exponent = b.normals.length > 0 ? specularExponent(meta) : 0
            // DEFAULT_MODEL_SUN is the whole scene's sun — the loc Gouraud bake
            // and computeVertexLightGrid both pin it — and the highlight has to
            // agree with the diffuse shading it sits on top of.
            material.onBeforeCompile = exponent > 0 ? specularPatch(DEFAULT_MODEL_SUN, exponent) : dropMapAlpha
          }
          // HDR overbright: push the material past 1.0 so the bloom pass sees it.
          // Recorded in userData too — the scene's sun tint re-writes material.color
          // and must multiply by this rather than overwrite it.
          if (meta && meta.hdrMultiplier > 1) {
            material.userData.hdrMultiplier = meta.hdrMultiplier
            material.color.setScalar(meta.hdrMultiplier)
          }
          material.needsUpdate = true
          if (meta && (meta.speedU !== 0 || meta.speedV !== 0)) {
            material.userData.scroll = { u: meta.speedU, v: meta.speedV }
          } else if (meta && isWaterMaterial(meta)) {
            material.userData.water = true
          }
        }
      }
      materialCache?.set(key, material)
      materials.push(material)
      vert += count
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    if (anyDepth) geometry.setAttribute('waterDepth', new THREE.BufferAttribute(waterDepth, 1))
    const mesh = new THREE.Mesh(geometry, materials)
    mesh.userData.triangleOwners = owners
    return mesh
  }

}

/** Bridge flag: tile columns marked 0x2 on decoded plane 1 shift down one
 *  render plane (Scene.linkBelow) — the deck decoded on plane 1 IS ground
 *  level, with the river decoded on plane 0 underneath it. */
export function isBridgeTile(terrain: MapTerrain, x: number, y: number): boolean {
  return (terrain.tileFlags[tileIndex(1, x, y)] & 0x2) !== 0
}

/** One RENDER plane's terrain as a textured, vertex-lit mesh (addRegularTile
 *  port + the client's bridge plane-shift). `pre` supplies mosaic-computed
 *  lighting/palettes per decoded plane (seam-free across regions); without it
 *  they're computed for this region alone. */
export async function buildTerrainMesh(
  terrain: MapTerrain,
  renderPlane: number,
  heightsAll: Int32Array[],
  configs: SceneConfigs,
  assets: LocAssets,
  pre?: { lights: Float32Array[]; shadows?: Float32Array[]; palettes: Int32Array[]; overlayCorners?: Int32Array[]; underlayCorners?: Int32Array[] },
  // Per-plane water-depth grids (VERTS×VERTS, client units) — riverbed minus
  // surface height. When present, water-material vertices get a `waterDepth`
  // attribute for the shore/transparency fade.
  waterDepthAll?: Int32Array[],
): Promise<THREE.Mesh | null> {
  const lightCache: (Float32Array | null)[] = [null, null, null, null]
  const paletteCache: (Int32Array | null)[] = [null, null, null, null]
  const cornerCache: (Int32Array | null)[] = [null, null, null, null]
  const fluCornerCache: (Int32Array | null)[] = [null, null, null, null]
  const lightOf = (dp: number) =>
    (lightCache[dp] ??= pre?.lights?.[dp] ?? computeVertexLight(heightsAll[dp], assets.brightness))
  // Blurred static-shadow grid per plane (0 = no shadow). Subtracted from the
  // GroundGL base strength; empty when no locs have been built yet.
  const shadowOf = (dp: number): Float32Array | null => pre?.shadows?.[dp] ?? null
  const paletteOf = (dp: number) =>
    (paletteCache[dp] ??= pre?.palettes?.[dp] ?? computeUnderlayPalette(terrain, dp, configs))
  const cornersOf = (dp: number) =>
    (cornerCache[dp] ??= pre?.overlayCorners?.[dp] ?? computeOverlayCorners(terrain, dp, configs))
  const fluCornersOf = (dp: number) =>
    (fluCornerCache[dp] ??= pre?.underlayCorners?.[dp] ?? computeUnderlayCornerIds(terrain, dp))
  const perimeterCache: (Int32Array | null)[] = [null, null, null, null]
  const perimeterOf = (dp: number) =>
    (perimeterCache[dp] ??= computeOverlayPerimeter(terrain, dp, configs))
  const buckets = new BucketSet()
  // lighting-only tint for self-coloured textures (water etc.): the scene light
  // multiplier as a grey the texture multiplies.
  const neutral = (mul: number): [number, number, number] => {
    const c = srgbToLinear(Math.min(1, mul))
    return [c, c, c]
  }

  // Material metadata for every texture this plane can reference, fetched up
  // front: detailsOnly maps get tinted by the tile colour (brightness-
  // normalised by the map's average luma so the tint's own brightness is
  // preserved — the client layers detail maps neutrally in HD); textures
  // that aren't detail maps carry their own colour and only take lighting.
  const usedTextureIds = new Set<number>()
  for (const flo of configs.overlays.values()) if (flo.texture !== undefined && flo.texture >= 0) usedTextureIds.add(flo.texture)
  for (const flu of configs.underlays.values()) if (flu.texture !== undefined && flu.texture >= 0) usedTextureIds.add(flu.texture)
  const metas = new Map<number, MaterialMeta | null>()
  await Promise.all([...usedTextureIds].map(async (id) => metas.set(id, await assets.getMaterialMeta(id))))

  // corner-override colour per blendable overlay id (keyed by raw 1-based id):
  // the tile colour, or the texture's average colour for texture-only
  // overlays (the client's getOverlayColorHsl equivalent)
  const overlayCornerHsl = new Map<number, number>()
  for (const [key, flo] of configs.overlays) {
    if (!isCornerBlendable(flo)) continue
    let hsl = floTileHsl(flo)
    if (hsl === -1 && flo.texture !== undefined && flo.texture >= 0) {
      const meta = metas.get(flo.texture)
      if (meta && meta.avgRgb !== -1) hsl = rgbToHsl16(meta.avgRgb)
    }
    if (hsl !== -1) overlayCornerHsl.set(key + 1, hsl)
  }

  function emitTile(plane: number, x: number, y: number) {
      const heights = heightsAll[plane]
      const light = lightOf(plane)
      const shadow = shadowOf(plane)
      const palette = paletteOf(plane)
      const ocorners = cornersOf(plane)
      const fcorners = fluCornersOf(plane)
      const operim = perimeterOf(plane)
      const idx = tileIndex(plane, x, y)
      const overlayId = terrain.overlayIds[idx] & 0xff
      const underlayId = terrain.underlayIds[idx] & 0xff
      const shapeRot = terrain.overlayShapeRot[idx] & 0xff
      let shape = shapeRot >> 2
      const rotation = shapeRot & 0x3
      const flo = overlayId !== 0 ? configs.overlays.get(overlayId - 1) : undefined
      const flu = underlayId !== 0 ? configs.underlays.get(underlayId - 1) : undefined
      if (shape === 0 && !flo) shape = 12
      const overlayTexture = flo?.texture !== undefined && flo.texture >= 0 ? flo.texture : -1
      const underlayTexture = flu?.texture !== undefined && flu.texture >= 0 ? flu.texture : -1
      const overlayHsl = floTileHsl(flo)
      const underlayHsl = underlayId !== 0 ? palette[x * VERTS + y] : -1
      const hasOverlay = flo !== undefined && (overlayHsl !== -1 || overlayTexture !== -1)
      const hasUnderlay = underlayId !== 0 && (underlayHsl !== -1 || underlayTexture !== -1)
      if (!hasOverlay && !hasUnderlay) return

      // `overlaySupportsBlending`: the client only treats an overlay as blending
      // when the tile actually has an underlay to blend INTO and a real shape
      // (method5848's `initialOverlay.blendsWithUnderlay` guard).
      const ownBlends = flo !== undefined && isCornerBlendable(flo) && flu !== undefined && shape !== 0

      // `hasFacesOn[e]` — does the neighbour across edge e want an extra face
      // from us? Port of the four edge blocks in method5848: an edge only asks
      // where OUR shape has no face on it already, and what it asks for comes
      // from the NEIGHBOUR's own table (blending or not). Edges are
      // 0 = south (y-1), 1 = east (x+1), 2 = north (y+1), 3 = west (x-1); the
      // neighbour is consulted at its edge (e+2)&3, the one facing us.
      const ownEdgeTable = ownBlends ? BL_EDGE_HAS_FACE : NB_EDGE_HAS_FACE
      const ownEdges = ownEdgeTable[shape] ?? NB_EDGE_HAS_FACE[0]
      const hasFacesOn = [false, false, false, false]
      {
        const EDGE_N: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
        for (let e = 0; e < 4; e++) {
          if (ownEdges[(rotation + e) & 0x3]) continue
          const nx = x + EDGE_N[e][0], ny = y + EDGE_N[e][1]
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          const nIdx = tileIndex(plane, nx, ny)
          const nId = terrain.overlayIds[nIdx] & 0xff
          if (nId === 0) continue
          const nFlo = configs.overlays.get(nId - 1)
          if (!nFlo || floTileHsl(nFlo) === -1) continue
          const nsr = terrain.overlayShapeRot[nIdx] & 0xff
          const nTable = isCornerBlendable(nFlo) ? BL_EDGE_HAS_FACE : NB_EDGE_HAS_FACE
          hasFacesOn[e] = nTable[nsr >> 2]?.[((nsr & 0x3) + ((e + 2) & 0x3)) & 0x3] === true
        }
      }
      // method5849's three-way pick. `unblendable` — no blend and nobody asking
      // — keeps the simple 15-entry family; everything else takes a 13-entry one
      // plus its edge->face table, which drives the midpoint splits below.
      const unblendable = !ownBlends && !hasFacesOn[0] && !hasFacesOn[1] && !hasFacesOn[2] && !hasFacesOn[3]
      const shaped = shape < 13
      const useBlend = !unblendable && ownBlends && shaped
      const useNonBlend = !unblendable && !ownBlends && shaped
      const overlayFaces = useBlend ? BL_OVERLAY_FACES[shape] : useNonBlend ? NB_OVERLAY_FACES[shape] : OVERLAY_FACE_COUNT[shape]
      const underlayFaces = useBlend ? BL_UNDERLAY_FACES[shape] : useNonBlend ? NB_UNDERLAY_FACES[shape] : UNDERLAY_FACE_COUNT[shape]
      const va = useBlend ? BL_VERTEX_A[shape] : useNonBlend ? NB_VERTEX_A[shape] : SHAPE_VERTEX_A[shape]
      const vb = useBlend ? BL_VERTEX_B[shape] : useNonBlend ? NB_VERTEX_B[shape] : SHAPE_VERTEX_B[shape]
      const vc = useBlend ? BL_VERTEX_C[shape] : useNonBlend ? NB_VERTEX_C[shape] : SHAPE_VERTEX_C[shape]
      const edgeFace = useBlend ? BL_EDGE_FACE[shape] : useNonBlend ? NB_EDGE_FACE[shape] : null

      // vertex position within tile, rotated (addRegularTile sizesX/sizesY)
      const vx = (v: number): number => {
        const dx = VERTEX_DELTA_X[v]
        const dy = VERTEX_DELTA_Y[v]
        if (rotation === 0) return dx
        if (rotation === 1) return dy
        if (rotation === 2) return 512 - dx
        return 512 - dy
      }
      const vy = (v: number): number => {
        const dx = VERTEX_DELTA_X[v]
        const dy = VERTEX_DELTA_Y[v]
        if (rotation === 0) return dy
        if (rotation === 1) return 512 - dx
        if (rotation === 2) return 512 - dy
        return dx
      }

      // Corner-blended underlay colour (addUnderlayTiles): a vertex at a tile
      // corner takes the blurred palette of the tile whose origin sits there —
      // unless a blendable overlay covers that corner, in which case the
      // overlay's colour wins (calculateOverlayDisplay slot machinery; this
      // feathers roads/mud into the surrounding ground). Mid-tile vertices
      // bilinearly blend the 4 corner colours. Gouraud interpolation between
      // those vertices is what makes ground colours flow smoothly across
      // tiles instead of rendering per-tile patches.
      const palAt = (tx: number, ty: number): number => {
        const p = palette[tx * VERTS + ty]
        return p !== -1 ? p : underlayHsl
      }
      const cornerBaseHsl = (tx: number, ty: number): number => {
        const ov = ocorners[tx * VERTS + ty]
        if (ov > 0) {
          const h = overlayCornerHsl.get(ov)
          if (h !== undefined) return h
        }
        return palAt(tx, ty)
      }
      // Exact corners take the override-or-palette colour; every other
      // position blends the pure PALETTE only (the client's 6-vertex splits
      // give edge midpoints the palette colour, so a neighbouring overlay's
      // colour reaches only half a tile — full-quad interpolation would
      // flood whole tiles with road colour)
      const underlayVertexHsl = (px: number, py: number): number => {
        const win = perimAt(px, py)
        if (win !== null) {
          const h = overlayCornerHsl.get(win.id)
          if (h !== undefined) return h
        }
        if (px === 0 && py === 0) return cornerBaseHsl(x, y)
        if (px === 0 && py === 512) return cornerBaseHsl(x, y + 1)
        if (px === 512 && py === 512) return cornerBaseHsl(x + 1, y + 1)
        if (px === 512 && py === 0) return cornerBaseHsl(x + 1, y)
        const fx = px >> 2 // 0-128 blend factor, like sizeX << 7 >> 9
        const fy = py >> 2
        return blendHsl16(
          blendHsl16(palAt(x, y), palAt(x + 1, y), fx),
          blendHsl16(palAt(x, y + 1), palAt(x + 1, y + 1), fx),
          fy,
        )
      }
      // The perimeter winner for one of THIS overlay's shape vertices, or null.
      // Shape vertex -> world ring index is `id - 2*rotation` (one rotation
      // step moves two ring positions); the winners are stored in world space.
      // `method5850` only defers to a winner that strictly outranks the tile's
      // own overlay, and only for ring vertices (ids 0-7) — interior and centre
      // vertices always keep the overlay's own material.
      const ownSlot = flo !== undefined ? floSlotKey(flo, overlayId) : -1
      const perimRaw = (ring: number): { id: number; flo: FloJson } | null => {
        if (ring < 0) return null
        const oid = operim[(x * SIZE + y) * 8 + ring]
        if (oid <= 0) return null
        const w = configs.overlays.get(oid - 1)
        return w ? { id: oid, flo: w } : null
      }
      const perimWinner = (id: number | undefined): { id: number; flo: FloJson } | null => {
        if (id === undefined || id >= 8 || flo === undefined) return null
        const w = perimRaw((id - 2 * rotation) & 0x7)
        return w && floSlotKey(w.flo, w.id) > ownSlot ? w : null
      }
      // Ring index of a position within the tile, or -1. The perimeter array is
      // in world space and the ring positions are fixed, so the underlay path —
      // which works in positions, not shape vertex ids — can look up the same
      // winners. `method5851` applies them with NO slot test (`>= 0`): an
      // underlay face has no overlay to outrank, so any winner takes the vertex.
      // That is the path-into-grass feather: it is the GRASS tile's vertices
      // that pick up the path's colour, texture and scale.
      const RING_POS: [number, number][] = [
        [0, 0], [256, 0], [512, 0], [512, 256], [512, 512], [256, 512], [0, 512], [0, 256],
      ]
      const perimAt = (px: number, py: number): { id: number; flo: FloJson } | null => {
        for (let r = 0; r < 8; r++) if (RING_POS[r][0] === px && RING_POS[r][1] === py) return perimRaw(r)
        return null
      }

      // Blendable overlay faces keep their own colour except at corners a
      // (possibly different, higher-slot) blendable overlay covers — the
      // cross-overlay gradient between adjacent mud/dirt/path tiles.
      const overlayVertexHsl = (px: number, py: number, own: number, id?: number): number => {
        // Ring vertices (0-7) go through the client's perimeter winners, which
        // cover the edge midpoints as well as the corners — that midpoint is
        // what carries the gradient half a tile in from the border.
        const win = perimWinner(id)
        if (win !== null) {
          const h = overlayCornerHsl.get(win.id)
          if (h !== undefined) return h
        }
        const cx = px === 0 ? x : px === 512 ? x + 1 : -1
        const cy = py === 0 ? y : py === 512 ? y + 1 : -1
        if (cx < 0 || cy < 0) return own
        const ov = ocorners[cx * VERTS + cy]
        if (ov > 0) {
          const h = overlayCornerHsl.get(ov)
          if (h !== undefined) return h
        }
        return own
      }

      // mode: 0 = flat (non-blendable overlay), 1 = underlay corner blend,
      // 2 = blendable overlay (own colour + cross-overlay corner overrides).
      // `alphas` puts the triangle in a transparent crossfade bucket instead
      // (terrain texture splatting between adjacent underlay textures).
      // `vertHsl` forces a vertex's colour, bypassing the mode's own rule. Used
      // by the underlay path for `method5851`'s blending branch, where a vertex
      // inside the overlay's shape takes the overlay's colour outright.
      const emitTri = (pts: [number, number][], hsl: number, textureId: number, texScale: number, mode: number, alphas?: [number, number, number], ids?: [number, number, number], vertHsl?: (number | null)[]) => {
        const meta = textureId >= 0 ? metas.get(textureId) : null
        const bucket = alphas ? buckets.getBlend(textureId) : buckets.get(textureId)
        bucket.owners.push(x * SIZE + y) // tile index, for terrain picking
        // detail maps modulate the tile colour; normalise by the map's own
        // average so the modulation is brightness-neutral
        const boost = textureId >= 0 && meta?.detailsOnly && hsl !== -1 ? 255 / meta.avgLuma : 1
        const useTint = textureId < 0 || (meta?.detailsOnly === true && hsl !== -1)
        // water tiles carry a per-vertex depth (surface→riverbed height gap, in
        // client units) so the water shader can fade to transparent at shallow
        // shores. Non-water buckets leave depths empty (default 0 in toMesh).
        const isWater = meta ? isWaterMaterial(meta) : false
        // Ground materials take a specular too (Node_Sub3 binds the effect for
        // its chunks just like a model does), so specular buckets get a normal
        // per vertex — the same height-gradient normal computeVertexLightGrid
        // derives its half-Lambert from, sampled at the vertex.
        const specular = meta ? specularExponent(meta) > 0 : false
        for (let vi = 0; vi < 3; vi++) {
          const [px, py] = pts[vi]
          const sceneX = (x << 9) + px
          const sceneY = (y << 9) + py
          const h = averageHeight(heights, sceneX, sceneY)
          bucket.positions.push(sceneX, -h, -sceneY)
          if (specular) {
            const dhx = averageHeight(heights, sceneX + 512, sceneY) - averageHeight(heights, sceneX - 512, sceneY)
            const dhy = averageHeight(heights, sceneX, sceneY + 512) - averageHeight(heights, sceneX, sceneY - 512)
            const nl = Math.hypot(dhx, 1024, dhy) || 1
            bucket.normals.push(dhx / nl, 1024 / nl, -dhy / nl)
          }
          if (isWater) {
            bucket.depths.push(waterDepthAll ? averageHeight(waterDepthAll[plane], sceneX, sceneY) : 0)
          }
          // Client HardwareGround (low lighting detail): the directional term
          // f_53 multiplies a palette colour whose LIGHTNESS was already cut
          // to (74 − staticShadow)/128 — shadows deepen the base colour, they
          // don't scale the light.
          const f53 = Math.max(0, lightAt(light, sceneX, sceneY))
          const shadowVal = shadow ? lightAt(shadow, sceneX, sceneY) : 0
          const strength = Math.max(0, GROUND_STRENGTH_BASE - shadowVal)
          const forced = vertHsl?.[vi]
          const vHsl = forced !== undefined && forced !== null ? forced
            : hsl === -1 ? hsl
            : mode === 1 ? underlayVertexHsl(px, py)
            : mode === 2 ? overlayVertexHsl(px, py, hsl, ids?.[vi])
            : hsl
          let rgb: [number, number, number]
          if (useTint && vHsl !== -1) rgb = litColor(adjustLuminance(vHsl, strength), f53)
          // textured tiles have no lightness to cut, so they take the
          // display-space equivalent of the same strength scale
          else rgb = neutral(f53 * GROUND_CUT_DISPLAY * Math.pow(strength / GROUND_STRENGTH_BASE, 0.7))
          bucket.colors.push(rgb[0] * boost, rgb[1] * boost, rgb[2] * boost)
          if (alphas) bucket.alphas.push(alphas[vi])
          // world-planar UVs: one repeat per `texScale` scene units
          bucket.uvs.push(sceneX / texScale, sceneY / texScale)
        }
      }


      let faceIdx = 0
      const overlayMode = flo !== undefined && isCornerBlendable(flo) ? 2 : 0
      // method5850/5851's edge split: when the neighbour across shape-edge j
      // has asked for a face and THIS face is the one lying on that edge
      // (`anIntArray3832[j] == faceIndex`), the triangle is emitted as two —
      // A-mid-C and mid-B-C — hinged on that edge's midpoint vertex (2j+1).
      // Shape edge j maps to world edge (j - rotation) & 3.
      const splitFace = (faceIndex: number, a: number, b: number, c: number): [number, number, number][] => {
        if (edgeFace !== null) {
          for (let j = 0; j < 4; j++) {
            if (edgeFace[j] !== faceIndex) continue
            if (!hasFacesOn[(j - rotation) & 0x3]) continue
            const mid = 2 * j + 1
            return [[a, mid, c], [mid, b, c]]
          }
        }
        return [[a, b, c]]
      }

      const ownScale = flo?.textureScale || 512
      for (let i = 0; i < overlayFaces; i++, faceIdx++) {
        if (!hasOverlay) continue
        for (const [a, b, c] of splitFace(i, va[faceIdx], vb[faceIdx], vc[faceIdx])) {
          const ids: [number, number, number] = [a, b, c]
          const pts: [number, number][] = [[vx(a), vy(a)], [vx(b), vy(b)], [vx(c), vy(c)]]
          emitTri(pts, overlayHsl, overlayTexture, ownScale, overlayMode, undefined, ids)
          // `method5850` gives an outranked ring vertex the winner's TEXTURE and
          // SCALE as well as its colour, so the material itself dissolves across
          // the face rather than stopping at the tile border. We can't vary the
          // sampler per vertex in one draw, so do it the way the underlay splat
          // already does: keep the base pass, then add one crossfade pass per
          // distinct winning texture, opaque at the vertices that texture won and
          // transparent at the others.
          if (overlayMode !== 2) continue
          const wins = [perimWinner(a), perimWinner(b), perimWinner(c)]
          const texOf = (w: { flo: FloJson } | null) =>
            w && w.flo.texture !== undefined && w.flo.texture >= 0 ? w.flo.texture : -1
          const done = new Set<number>([overlayTexture])
          for (let k = 0; k < 3; k++) {
            const t = texOf(wins[k])
            if (t < 0 || done.has(t)) continue
            done.add(t)
            emitTri(pts, overlayHsl, t, wins[k]!.flo.textureScale || 512, overlayMode,
              [texOf(wins[0]) === t ? 1 : 0, texOf(wins[1]) === t ? 1 : 0, texOf(wins[2]) === t ? 1 : 0], ids)
          }
        }
      }
      // Underlay faces render per-vertex corner TEXTURES (addUnderlayTiles):
      // each vertex takes the texture of the tile whose origin sits at its
      // corner. Uniform faces go straight to that texture's bucket; mixed
      // faces draw the own texture as an opaque base plus one transparent
      // crossfade pass per neighbouring texture — the client's ground
      // texture splatting, which removes hard texture seams at tile edges.
      const cornerFluAt = (px: number, py: number): number => {
        const tx = px < 256 ? x : x + 1
        const ty = py < 256 ? y : y + 1
        const id = fcorners[tx * VERTS + ty]
        return id !== 0 ? id : underlayId
      }
      const texOfFlu = (id: number): number => {
        const f = configs.underlays.get(id - 1)
        return f?.texture !== undefined && f.texture >= 0 ? f.texture : -1
      }
      // Any blendable-overlay override on this tile's corners? Then the
      // client subdivides the ground faces (its 6-vertex fans) so the
      // overlay colour fades out by the tile midpoints — emulate with a
      // midpoint split of each triangle. Blending tiles are exempt: their
      // shape family already subdivides (mechanism 2) and the split's
      // synthetic midpoints have no shape-vertex id, which the intra-tile
      // blend below needs.
      const hasOverride = !ownBlends && (ocorners[x * VERTS + y] > 0 || ocorners[(x + 1) * VERTS + y] > 0
        || ocorners[x * VERTS + y + 1] > 0 || ocorners[(x + 1) * VERTS + y + 1] > 0)
      for (let i = 0; i < underlayFaces; i++, faceIdx++) {
        if (!hasUnderlay) continue
        for (const [A, B, C] of splitFace(overlayFaces + i, va[faceIdx], vb[faceIdx], vc[faceIdx])) {
          const pa: [number, number] = [vx(A), vy(A)]
          const pb: [number, number] = [vx(B), vy(B)]
          const pc: [number, number] = [vx(C), vy(C)]
          let tris: [number, number][][]
          let triIds: (number | null)[][]
          if (hasOverride) {
            const mid = (p: [number, number], q: [number, number]): [number, number] =>
              [(p[0] + q[0]) >> 1, (p[1] + q[1]) >> 1]
            const ab = mid(pa, pb), bc = mid(pb, pc), ca = mid(pc, pa)
            tris = [[pa, ab, ca], [ab, pb, bc], [ca, bc, pc], [ab, bc, ca]]
            triIds = [[A, null, null], [null, B, null], [null, null, C], [null, null, null]]
          } else {
            tris = [[pa, pb, pc]]
            triIds = [[A, B, C]]
          }
          for (let t = 0; t < tris.length; t++) {
            const tri = tris[t]
            const ids = triIds[t]
            // Per vertex: a blendable overlay reaching this ring position wins
            // outright (method5851's `anIntArray3842[i_35] >= 0` branch, which
            // takes its texture and scale, not just its colour); otherwise the
            // vertex keeps the underlay-corner texture the splat already used.
            const wins = tri.map(([px, py]) => perimAt(px, py))
            const flus = tri.map(([px, py]) => cornerFluAt(px, py))
            // `method5851:1218` — on a tile whose own overlay blends, an underlay
            // vertex that the OVERLAY's shape covers takes the overlay's colour,
            // texture and scale. Note the absence of an `i_34 < 8` guard: unlike
            // the perimeter blend this reaches the interior vertices (8-11) and
            // the tile CENTRE (12), so the falloff runs from the shape boundary
            // out across the underlay half of the tile. This is the feather
            // *inside* a tile; without it a curved shape (9/10) draws a hard arc.
            // `hasOverlay` stands in for the client nulling out an overlay that
            // has neither a primary nor a secondary colour before it ever sets
            // `aBool3810` (method5846:633).
            const blends = ids.map((v) =>
              ownBlends && hasOverlay && v !== null && OVERLAY_SHAPE_COVERS[shape]?.[v] === true)
            const texes = tri.map((_, vi) => {
              const w = wins[vi]
              if (w && w.flo.texture !== undefined && w.flo.texture >= 0) return w.flo.texture
              if (blends[vi]) return overlayTexture
              return texOfFlu(flus[vi])
            })
            const scaleAt = (vi: number) => {
              const w = wins[vi]
              if (w && w.flo.texture !== undefined && w.flo.texture >= 0) return w.flo.textureScale || 512
              if (blends[vi]) return ownScale
              return (flus[vi] === underlayId ? flu : configs.underlays.get(flus[vi] - 1))?.scale || 512
            }
            // The winner branch runs first in the client, so only a vertex with
            // no perimeter winner falls through to the overlay's own colour.
            const vertHsl = tri.map((_, vi) =>
              wins[vi] === null && blends[vi] && overlayHsl !== -1 ? overlayHsl : null)
            if (texes[0] === texes[1] && texes[0] === texes[2]) {
              emitTri(tri, underlayHsl, texes[0], scaleAt(0), 1, undefined, undefined, vertHsl)
            } else {
              emitTri(tri, underlayHsl, underlayTexture, flu?.scale || 512, 1, undefined, undefined, vertHsl)
              const done = new Set<number>([underlayTexture])
              for (let vi = 0; vi < 3; vi++) {
                const tx = texes[vi]
                if (tx < 0 || done.has(tx)) continue
                done.add(tx)
                emitTri(tri, underlayHsl, tx, scaleAt(vi), 1,
                  [texes[0] === tx ? 1 : 0, texes[1] === tx ? 1 : 0, texes[2] === tx ? 1 : 0],
                  undefined, vertHsl)
              }
            }
          }
        }
      }
  }

  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (isBridgeTile(terrain, x, y)) {
        // bridge column: decoded plane renderPlane+1 draws here; render plane
        // 0 also keeps the decoded-0 river underneath the deck
        if (renderPlane === 0) emitTile(0, x, y)
        if (renderPlane + 1 < 4) emitTile(renderPlane + 1, x, y)
      } else {
        emitTile(renderPlane, x, y)
      }
    }
  }

  const mesh = await buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id))
  if (mesh) mesh.userData.isTerrain = true
  return mesh
}

// ---------------------------------------------------------------------------
// Locs
// ---------------------------------------------------------------------------

export type ObjectDefJson = {
  id: number
  shapes?: number[]
  objectModelIds?: number[][]
  sizeX?: number
  sizeY?: number
  scaleX?: number
  scaleY?: number
  scaleZ?: number
  offsetX?: number
  offsetY?: number
  offsetZ?: number
  inverted?: boolean
  /** How far a wall pushes the decorations hanging on it (default 64). Read off
   *  the WALL, not the decoration — see buildLocsMesh's wallDisplacement. */
  decorDisplacement?: number
  /** Morph ("multiloc") targets: the client swaps this def for `transformTo[v]`
   *  where v is the value of `varpBit`/`varp` (ObjectDefinition.getMultiLoc).
   *  The last entry is its fallback when the var is out of range. */
  transformTo?: number[]
  transforms?: boolean
  varpBit?: number
  varp?: number
  originalColors?: number[]
  modifiedColors?: number[]
  // Loc texture-swap fields as named in the dumped object JSON (ObjectViewer /
  // objects.ts loader use the same). Reading them as *TextureIds silently
  // disabled all loc retexturing — trees kept their base leaf textures.
  originalTextures?: number[]
  modifiedTextures?: number[]
  name?: string
  options?: (string | null)[]
  /** Movement blocking. Default true; opcodes 17/18 clear it. */
  blocks?: boolean
  /** Clip mode — default 2 (opcode 17 sets 0 alongside `blocks`, 24 sets 1) */
  clipType?: number
  /** opcode 69 — hides the ground decoration beneath the object */
  obstructsGround?: boolean
  /** opcode 71 — whether ground items stack on it (-1 = unset) */
  supportsItems?: number
  staticShadow?: boolean
  // Sound fields. Names are cryogen's dumped ones; the client (darkan
  // `ObjectType`) calls several of them something else, noted per field, and
  // the opcodes are identical between the two decoders. An unset id is dumped
  // as -1, never omitted — see markerKindFromDef.
  /** not present in this dump (0 of 73913 objects); kept for other revisions */
  soundId?: number
  /** client `soundId`, opcode 78 — the looping ambient sound_effects id */
  ambientSoundId?: number
  /** client `soundRadius`, opcodes 78/79 — tiles the sound carries */
  ambientSoundHearDistance?: number
  /** client `ambientSoundMaxHearDistance`, opcode 178 */
  ambientSoundMaxHearDistance?: number
  /** client `soundVolume`, opcode 104. -1 = opcode absent, which the client
   *  reads as its own default of 255 — the two spellings of "full volume". */
  ambientSoundVolume?: number
  /** opcode 79 — gap between plays, in ticks */
  soundMinInterval?: number
  soundMaxInterval?: number
  /** opcode 173 — client defaults are 256 for both */
  ambientSoundMinDelay?: number
  ambientSoundMaxDelay?: number
  /** opcode 168 / 169 */
  instrumentSoundEffect?: boolean
  instrumentAmbientSound?: boolean
  /** opcode 79 — sounds picked from at random; never holds a negative */
  soundGroupIds?: number[]
  /** client `mapCategoryid`, opcode 107 — the config/areas record whose icon
   *  every placement of this object pins on the map. -1 = none. */
  mapCategoryId?: number
  /** config/map_sprites id — the "mapscene" symbol drawn on the minimap. */
  mapSpriteId?: number
  /** client `mapIconRotation`, opcode 101 — quarter turns */
  mapSpriteRotation?: number
  /** client `mapIconFlipped`, opcode 105 */
  flipMapSprite?: boolean
  /** client `mapIconRotates`, opcode 97 — when false the client forces the
   *  sprite's rotation to 0 instead of adding the placement's */
  adjustMapSceneRotation?: boolean
  /** Ground-contour ("hillskew") mode — 0 none, 1 follow ground, 2 partial,
   *  4/5 stretch to the next plane (bridges/raised floors). */
  groundContourType?: number
  groundContourModifier?: number
  /** Model lighting, as the raw dumped bytes. The client feeds
   *  `createMeshRasterizer` with `64 + ambient` and `850 + contrast * 5`
   *  (`ObjectDefinition:448-449`, which folds the ·5 in at decode), then scales
   *  the sun by `768 / contrastArg` — so contrast is a divisor, higher = flatter.
   *  NOTE our loc bake reads neither: see the TODO entry. */
  ambient?: number
  contrast?: number
  /** Cursor overrides — a cursor id (config/cursors) plus which right-click
   *  option it applies to. Opcodes 99 (primary) and 100 (secondary). */
  primaryCursor?: number
  primaryCursorActionIndex?: number
  secondaryCursor?: number
  secondaryCursorActionIndex?: number
  /** opcode 19 — whether the object takes interactions at all (-1 = unset) */
  interactable?: number
  /** opcode 91 */
  members?: boolean
  /** opcode 88 clears this — the GPU sun-following shadow */
  dynamicShadow?: boolean
  /** opcode 22 */
  delayShading?: boolean
  /** opcode 82 — only drawn when textures are enabled */
  requiresTextures?: boolean
  /** client `occlusionMode`: opcode 23 sets 1, opcode 103 sets 0 (-1 = unset) */
  occludes?: number
  groundDecorationHeight?: number
  /** Sequence ids this loc idles through (ObjectType animation array) — e.g. a
   *  waving flag. Empty/absent = static. The scene animates these. */
  animations?: number[]
}

export type MaterialMeta = {
  detailsOnly: boolean
  avgLuma: number
  /** average opaque RGB of the texture PNG (-1 if unreadable) — the minimap
   *  colour for texture-only overlays, like the client's getMaterialColor */
  avgRgb: number
  speedU: number
  speedV: number
  colorHsl: number
  /** Material alpha mode (client anInt1226): 0 = opaque, 1 = binary alpha
   *  (black texels → transparent, foliage/fence cutouts), 2 = per-pixel alpha
   *  from an opacity op the dump doesn't bake. */
  effectCombiner: number
  /** Which of the client's fixed-function "effects" the material is drawn with
   *  (Class146's effect table). 1 and 7 are the two specular effects — see
   *  `effectIgnoresTextureAlpha`. */
  effectId: number
  /** Effect parameter — for effectId 1 it picks the specular exponent, see
   *  `SPECULAR_EXPONENT`. */
  effectParam1: number
  /** Overbright multiplier for `hdr` materials. The client uploads these as FLOAT
   *  textures (`Class66` -> `renderMaterialPixelsF`) and scales colour by
   *  `1 + hdrOp*31/4096` — up to 32x — which is what makes flames glow once bloom
   *  picks them up. Our 8-bit PNG can't hold that, so the scalar is applied to the
   *  material instead. 1 = not HDR / not recoverable. */
  hdrMultiplier: number
  /** Client `TextureDetails.shadowFactor` — dumped as `alpha` by cryogen (the
   *  decode-order field between `brightness` and `effectId`; the name is a
   *  misnomer). 0..255: how much of the face colour a textured face REPLACES
   *  with ambient-grey before lighting (`MeshRasterizer_Sub3.method14282`).
   *  Self-coloured textures (leaf sprites, 951/956/952 et al) carry 255, so
   *  the sprite's own colour stands instead of being tinted green-on-green —
   *  skipping this is what made every tree canopy dark and oversaturated. */
  shadowFactor: number
  /** Client `TextureDetails.brightness` — post-mix multiplier (256+b)/256. */
  texBrightness: number
}

/** distinct texture ids per model — a model is reused across many placements */
const modelTextureIds = new WeakMap<ModelData, number[]>()

/** Client `MeshRasterizer_Sub3.method14282`: a textured face's base colour
 *  after the texture's shadowFactor grey-mix and brightness boost, before the
 *  shader's diffuse multiplies it.
 *
 *  shadowFactor mixes the face colour toward `ambient·0x020202` — mid-grey
 *  (128) at the default ambient of 64 — so a self-coloured texture (leaf
 *  sprites: green pixels IN the texture) isn't tinted by a green face colour
 *  on top of its own green. At 255 (dumped as `alpha: -1`) the face colour is
 *  all but replaced: the texture's own colour is the colour. Detail maps
 *  (bark, texture 923) carry 0 and keep the face tint entirely. */
function texturedBaseRgb(paletteRgb: number, shade: number, ambient = 64): number {
  const sf = shade & 0xff
  const bright = (shade >> 8) & 0xff
  let r = (paletteRgb >> 16) & 0xff, g = (paletteRgb >> 8) & 0xff, b = paletteRgb & 0xff
  if (sf !== 0) {
    const grey = ambient * 2
    const keep = 256 - sf
    r = (grey * sf + r * keep) >> 8
    g = (grey * sf + g * keep) >> 8
    b = (grey * sf + b * keep) >> 8
  }
  if (bright !== 0) {
    const m = 256 + bright
    r = Math.min(65535, r * m) >> 8
    g = Math.min(65535, g * m) >> 8
    b = Math.min(65535, b * m) >> 8
  }
  return (r << 16) | (g << 8) | b
}

export class LocAssets {
  private root: FileSystemDirectoryHandle
  private defs = new Map<number, Promise<ObjectDefJson | null>>()
  private models = new Map<number, Promise<ModelData | null>>()
  private textures = new Map<number, Promise<THREE.Texture | null>>()
  private materialMeta = new Map<number, Promise<MaterialMeta | null>>()
  /** blendType (= texture-def effectCombiner) per texture, filled as metas
   *  resolve — lets the synchronous face loop classify transparency. */
  private blendTypes = new Map<number, number>()
  /** texture-def effectId per texture, filled alongside blendTypes */
  private effectIds = new Map<number, number>()
  /** overbright multiplier per texture, filled as metas resolve */
  private hdrMults = new Map<number, number>()
  /** shadowFactor | brightness<<8 per texture (method14282 params), filled as
   *  metas resolve — the face loop's grey-mix needs them synchronously. */
  private shadeParams = new Map<number, number>()
  /** The client Brightness preference as its ambient factor `0.7 + 0.1·pref`
   *  (default pref 3 → ×1.0). Scales ONLY the ambient term of the loc bake and
   *  the ground light grid, exactly like `Class239:141`'s `IA(...)` — never the
   *  sun/backlight terms or the per-def base ambient. Baked into vertex
   *  colours, so a change needs a scene rebuild. */
  brightness = 1
  /** Phong exponent per texture (0 = no specular), filled as metas resolve */
  private specExponents = new Map<number, number>()
  // single-flight directory resolution: cache the PROMISE, not the result —
  // dozens of parallel first calls must not each re-resolve the folder
  /** Unsaved object-def edits, keyed by object id — the marker/loc panels' draft
   *  state. Checked ahead of the file in `getDef`, so every consumer (marker
   *  classification, models, recolours) previews the edit without the file
   *  changing and without invalidating the read cache: dropping an override
   *  falls straight back to the already-cached file read. */
  private defOverrides: ReadonlyMap<number, ObjectDefJson> = new Map()
  private objectsDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private modelsDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private texturesDirP: Promise<FileSystemDirectoryHandle | null> | undefined
  private textureDefsDirP: Promise<FileSystemDirectoryHandle | null> | undefined

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  private texturesDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.texturesDirP) {
      this.texturesDirP = this.root.getDirectoryHandle('textures').catch(() => null)
    }
    return this.texturesDirP
  }

  private textureDefsDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.textureDefsDirP) {
      this.textureDefsDirP = this.root.getDirectoryHandle('texture_definitions').catch(() => null)
    }
    return this.textureDefsDirP
  }

  async dispose() {
    for (const p of this.textures.values()) {
      const texture = await p.catch(() => null)
      texture?.dispose()
    }
    this.textures.clear()
  }

  /** Cached blendType for a texture (0 = opaque, 1 = binary cutout, 2 = smooth
   *  alpha). Synchronous — `primeBlendTypes` must have run for this id. */
  blendTypeOf(id: number): number {
    return this.blendTypes.get(id) ?? 0
  }

  /** Cached texture-def effectId — a tiebreak in the client's baked face sort
   *  key. Sync — needs primeBlendTypes. */
  effectIdOf(id: number): number {
    return this.effectIds.get(id) ?? 0
  }

  /** Cached HDR overbright multiplier (1 = not HDR). Sync — needs primeBlendTypes. */
  hdrMultiplierOf(id: number): number {
    return this.hdrMults.get(id) ?? 1
  }

  /** Cached `shadowFactor | brightness<<8` (method14282's texture params).
   *  Sync — needs primeBlendTypes. 0 = no grey-mix, no brightness boost. */
  shadeParamsOf(id: number): number {
    return this.shadeParams.get(id) ?? 0
  }

  /** Cached specular exponent (0 = the material takes no specular, which is the
   *  overwhelming majority). Sync — needs primeBlendTypes. Used by the face
   *  loops to decide whether a bucket has to carry vertex normals. */
  specularExponentOf(id: number): number {
    return this.specExponents.get(id) ?? 0
  }

  /** Resolve (and cache) the blendType of every texture a model uses, so the
   *  synchronous face loop can classify transparency the way the client does. */
  async primeBlendTypes(model: ModelData): Promise<void> {
    const tex = model.faceTextures
    if (!tex) return
    let ids = modelTextureIds.get(model)
    if (!ids) {
      const set = new Set<number>()
      for (let f = 0; f < model.faceCount; f++) {
        const t = tex[f]
        if (t >= 0) set.add(t)
      }
      modelTextureIds.set(model, (ids = [...set]))
    }
    for (const id of ids) {
      if (!this.blendTypes.has(id)) await this.getMaterialMeta(id)
    }
  }

  /** textures/<id>/<id>.png as a repeating sRGB THREE texture. */
  getTexture(id: number): Promise<THREE.Texture | null> {
    let p = this.textures.get(id)
    if (!p) {
      p = (async () => {
        try {
          const texturesDir = await this.texturesDir()
          if (!texturesDir) return null
          const dir = await texturesDir.getDirectoryHandle(String(id))
          const file = await (await dir.getFileHandle(`${id}.png`)).getFile()
          // premultiplyAlpha MUST be 'none'. Chromium's default for
          // createImageBitmap is to premultiply, and three uploads an
          // ImageBitmap as-is (UNPACK_PREMULTIPLY_ALPHA_WEBGL doesn't apply to
          // bitmap sources), so the shader then samples rgb·a and reads it as
          // straight colour. Every material whose PNG carries a sub-255 alpha —
          // ~1200 of the 2591 dumped, all 380 of the effectId 1/7 specular
          // detail maps among them — arrived darkened by its own alpha. Texture
          // 90 uploads as rgb 46 instead of 197, which is why the Lumbridge
          // kitchen's grey stone (range, sink, rock pile, dresser) rendered
          // black once the alpha test stopped deleting it outright.
          const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none' })
          // effectCombiner 1 materials (leaf/foliage/fence cutouts) carry their
          // shape as black texels the client turns transparent (binary alpha).
          // Our dumped PNGs are opaque, so derive that alpha here, else the
          // canopy renders as a solid dark mass instead of see-through leaves.
          const combiner = (await this.getMaterialMeta(id))?.effectCombiner ?? 0
          const texture = combiner === 1 ? binaryAlphaTexture(bitmap) : new THREE.Texture(bitmap)
          texture.wrapS = THREE.RepeatWrapping
          texture.wrapT = THREE.RepeatWrapping
          texture.colorSpace = THREE.SRGBColorSpace
          texture.needsUpdate = true
          return texture
        } catch {
          return null
        }
      })()
      this.textures.set(id, p)
    }
    return p
  }

  /** Material metadata: detailsOnly (greyscale detail map tinted by the tile
   *  colour) vs self-coloured, the PNG's average luma for brightness
   *  normalisation, UV scroll speed (waterfalls/lava — client scrolls
   *  offset = seconds*speed/64), and the material's average HSL (used to
   *  recognise still water for the ripple drift). */
  getMaterialMeta(id: number): Promise<MaterialMeta | null> {
    let p = this.materialMeta.get(id)
    if (!p) {
      p = (async () => {
        try {
          let detailsOnly = false
          let speedU = 0
          let speedV = 0
          let colorHsl = -1
          let effectCombiner = 0
          let effectId = 0
          let effectParam1 = 0
          let isHdr = false
          let hdrMultiplier = 1
          let shadowFactor = 0
          let texBrightness = 0
          try {
            const defsDir = await this.textureDefsDir()
            if (!defsDir) throw new Error('no texture_definitions')
            const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
            const def = JSON.parse(await file.text())
            detailsOnly = def.detailsOnly === true
            speedU = def.textureSpeedU ?? 0
            speedV = def.textureSpeedV ?? 0
            colorHsl = def.colorHsl ?? -1
            effectCombiner = def.effectCombiner ?? 0
            effectId = def.effectId ?? 0
            effectParam1 = def.effectParam1 ?? 0
            isHdr = def.hdr === true
            shadowFactor = (def.alpha ?? 0) & 0xff
            texBrightness = (def.brightness ?? 0) & 0xff
          } catch { /* definition missing — treat as self-coloured */ }
          if (isHdr) {
            // The overbright factor lives in the material op graph, not the
            // texture def. Only a constant-fill op gives a single scalar (87 of
            // the 367 hdr materials); the rest are real op graphs whose per-pixel
            // HDR channel we don't evaluate yet, so they stay at 1.
            try {
              const texturesDir = await this.texturesDir()
              const dir = await texturesDir!.getDirectoryHandle(String(id))
              const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
              const mat = JSON.parse(await file.text())
              const op = mat.hdrOperationIndex != null ? mat.textureOperations?.[mat.hdrOperationIndex] : null
              if (op && op.type === 0 && typeof op.fillValue === 'number') {
                hdrMultiplier = 1 + (op.fillValue * 31) / 4096
              }
            } catch { /* no op graph — leave at 1 */ }
          }
          let avgLuma = 128
          let avgRgb = -1
          try {
            const texturesDir = await this.texturesDir()
            if (!texturesDir) throw new Error('no textures')
            const dir = await texturesDir.getDirectoryHandle(String(id))
            const file = await (await dir.getFileHandle(`${id}.png`)).getFile()
            // 'none' for the same reason getTexture needs it — a premultiplied
            // bitmap only round-trips back to straight rgb here through the
            // canvas's own premultiplied store, which quantises hard at low
            // alpha and skews avgLuma/avgRgb for exactly the detail maps that
            // depend on them.
            const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none' })
            const size = 16
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(bitmap, 0, 0, size, size)
            bitmap.close()
            const px = ctx.getImageData(0, 0, size, size).data
            let sum = 0, n = 0, sr = 0, sg = 0, sb = 0
            for (let i = 0; i < px.length; i += 4) {
              if (px[i + 3] === 0) continue
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3
              sr += px[i]
              sg += px[i + 1]
              sb += px[i + 2]
              n++
            }
            if (n > 0) {
              avgLuma = sum / n
              avgRgb = (Math.round(sr / n) << 16) | (Math.round(sg / n) << 8) | Math.round(sb / n)
            }
          } catch { /* keep default */ }
          const meta: MaterialMeta = {
            detailsOnly, avgLuma: Math.max(32, avgLuma), avgRgb, speedU, speedV, colorHsl,
            effectCombiner, effectId, effectParam1, hdrMultiplier, shadowFactor, texBrightness,
          }
          this.blendTypes.set(id, effectCombiner)
          this.effectIds.set(id, effectId)
          this.hdrMults.set(id, hdrMultiplier)
          this.shadeParams.set(id, shadowFactor | (texBrightness << 8))
          this.specExponents.set(id, specularExponent(meta))
          return meta
        } catch {
          return null
        }
      })()
      this.materialMeta.set(id, p)
    }
    return p
  }

  setDefOverrides(overrides: ReadonlyMap<number, ObjectDefJson>) {
    this.defOverrides = overrides
  }

  /** The draft def for `id`, or undefined when it isn't being edited. */
  defOverride(id: number): ObjectDefJson | undefined {
    return this.defOverrides.get(id)
  }

  async getDef(id: number): Promise<ObjectDefJson | null> {
    const override = this.defOverrides.get(id)
    if (override) return override
    let p = this.defs.get(id)
    if (!p) {
      p = (async () => {
        try {
          if (!this.objectsDirP) {
            this.objectsDirP = resolveEntryHandle(this.root, getEntryPath('objects'))
          }
          const objectsDir = await this.objectsDirP
          if (!objectsDir) return null
          const file = await (await objectsDir.getFileHandle(`${id}.json`)).getFile()
          return JSON.parse(await file.text()) as ObjectDefJson
        } catch {
          return null
        }
      })()
      this.defs.set(id, p)
    }
    return p
  }

  async getModel(id: number): Promise<ModelData | null> {
    let p = this.models.get(id)
    if (!p) {
      p = (async () => {
        try {
          if (!this.modelsDirP) {
            this.modelsDirP = resolveEntryHandle(this.root, getEntryPath('models'))
          }
          const modelsDir = await this.modelsDirP
          if (!modelsDir) return null
          const sub = await modelsDir.getDirectoryHandle(String(id))
          const file = await (await sub.getFileHandle('model.dat')).getFile()
          // Bake the pre-13 <<2 in at decode, which is where the client does it
          // for locs: ObjectDefinition calls `mesh.upscale()` on a version < 13
          // mesh right after decodeMesh, BEFORE recolour, rotation, resize,
          // offset and the ground contour. Everything downstream therefore sees
          // one coordinate space. `modelUpscale` returns 1 once it's baked, so
          // ModelAccumulator won't apply it a second time and the geometry is
          // unchanged — what this buys is a mesh that can actually be contoured
          // and placed against the terrain, which is in fine scene units.
          return upscaleModel(parseModel(new Uint8Array(await file.arrayBuffer()), id))
        } catch {
          return null
        }
      })()
      this.models.set(id, p)
    }
    return p
  }
}

// Marker locs use tiny models painted entirely in one sentinel colour:
// teal HSL16 29113 (ambient-sound emitters, map-icon anchors) or green 20287
// (invisible barrier walls, e.g. bridge edges). No hide flag exists in the
// mesh or the def; the shipped client simply never shows them. Their quads
// are replaced with floating editor markers (MarkerInfo/buildMarkersMesh).
const MARKER_HSLS = new Set([29113, 20287])
const BARRIER_HSL = 20287
function isMarkerModel(model: ModelData): boolean {
  if (model.faceCount === 0 || model.faceCount > 4) return false
  for (let f = 0; f < model.faceCount; f++) {
    if (!MARKER_HSLS.has(model.faceColor[f] & 0xffff)) return false
  }
  return true
}

/**
 * Each vertex's local x/z after everything `ObjectDefinition.method7971` bakes
 * into the mesh before the ground contour runs: mirror (`wa`, negate RS z), the
 * rotation≥4 extras (45° then the (180, 0, -180) shift), the 90°·rotation steps
 * (`S`: x' = sin·z + cos·x, z' = cos·z − sin·x), then resize and the def offset.
 *
 * Only x/z matter — the contour rewrites y, and a Y-axis rotation leaves y
 * alone, so the contoured values stay valid once the placement matrix rotates
 * the mesh. (`scaleY` is the one gap: the client contours post-resize, we do it
 * pre-resize, so a Y-scaled contoured loc would scale its ground term too. No
 * loc in the dump is both.)
 */
function placedXZ(
  model: ModelData,
  piece: { rot: number; mirror: boolean; variant: 'plain' | 'decor' | 'rot45' },
  def: ObjectDefJson,
): [Int32Array, Int32Array] {
  const n = model.vertexCount
  const outX = new Int32Array(n)
  const outZ = new Int32Array(n)
  const scaleX = (def.scaleX ?? 128) / 128
  const scaleZ = (def.scaleZ ?? 128) / 128
  const rot = piece.rot & 0x3
  const C45 = Math.SQRT1_2
  for (let v = 0; v < n; v++) {
    let x = model.vertexX[v]
    let z = piece.mirror ? -model.vertexZ[v] : model.vertexZ[v]
    if (piece.variant !== 'plain') {
      const nx = C45 * z + C45 * x
      z = C45 * z - C45 * x
      x = nx
      if (piece.variant === 'decor') { x += 180; z -= 180 }
    }
    if (rot === 1) { const t = x; x = z; z = -t }
    else if (rot === 2) { x = -x; z = -z }
    else if (rot === 3) { const t = x; x = -z; z = t }
    outX[v] = Math.round(x * scaleX) + (def.offsetX ?? 0)
    outZ[v] = Math.round(z * scaleZ) + (def.offsetZ ?? 0)
  }
  return [outX, outZ]
}

// Ground-contour ("hillskew") for locs — port of ModelSM.contourToGround. RS
// loc models can be deformed so their vertices follow the terrain: paths/floors
// hug the ground (type 1/2), and — crucially for bridges/raised buildings —
// their tops stretch up to the NEXT plane's heightmap (type 4/5). Without it a
// bridge stays flat (its stone arch sinks under the water surface and is
// occluded) and hillside decorations float. Returns a contoured copy of the
// model's vertexY (RS units, relative to the tile so the render matrix's
// −avgHeight translate still applies), or null if the contour can't run.
//
// heights/nextHeights are VERTS×VERTS RS height grids (heights[x*VERTS+y]);
// worldX/Z are fine scene coords (512/tile), so the mesh has to be in that same
// space to be contoured. Pre-13 meshes reach here already upscaled (getModel
// bakes the <<2 in at decode, as ObjectDefinition does) — the guard below is
// just a backstop for any caller that hands over a raw 1× mesh.
function contourVertexY(
  model: ModelData,
  contourType: number,
  contourModifier: number,
  heights: Int32Array,
  nextHeights: Int32Array | undefined,
  sceneX: number,
  sceneY: number,
  avgHeight: number,
  /** Per-vertex PLACED local x/z (rotation, mirror and def scale/offset already
   *  applied) — the ground is sampled under the vertex's real world position.
   *  The client contours the mesh in `method7971` AFTER baking those in, so
   *  sampling with raw model coords rotates the deformation away from the
   *  terrain: a rotated staircase came out twisted into the hillside. */
  placedX?: Int32Array,
  placedZ?: Int32Array,
): Int32Array | null {
  if (modelUpscale(model) !== 1) return null
  const { vertexCount, vertexX, vertexY, vertexZ } = model
  // interpolated ground height at a fine world position (MeshRasterizer bilerp)
  const groundAt = (h: Int32Array, wx: number, wz: number): number | null => {
    const tx = wx >> 9, tz = wz >> 9
    if (tx < 0 || tz < 0 || tx >= VERTS - 1 || tz >= VERTS - 1) return null
    const rx = wx & 511, rz = wz & 511
    const a = (h[tx * VERTS + tz] * (512 - rx) + rx * h[(tx + 1) * VERTS + tz]) >> 9
    const b = (h[tx * VERTS + tz + 1] * (512 - rx) + rx * h[(tx + 1) * VERTS + tz + 1]) >> 9
    return (a * (512 - rz) + b * rz) >> 9
  }
  const out = new Int32Array(vertexCount)
  let minY = 0, maxY = 0
  for (let v = 0; v < vertexCount; v++) { if (vertexY[v] < minY) minY = vertexY[v]; if (vertexY[v] > maxY) maxY = vertexY[v] }

  for (let v = 0; v < vertexCount; v++) {
    const wx = sceneX + (placedX ? placedX[v] : vertexX[v])
    const wz = sceneY + (placedZ ? placedZ[v] : vertexZ[v])
    let ny = vertexY[v]
    if (contourType === 1) {
      const g = groundAt(heights, wx, wz)
      if (g !== null) ny = g + vertexY[v] - avgHeight
    } else if (contourType === 2) {
      if (minY !== 0) {
        const frac = (vertexY[v] << 16) / minY
        if (frac < contourModifier) {
          const g = groundAt(heights, wx, wz)
          if (g !== null) ny = vertexY[v] + ((g - avgHeight) * (contourModifier - frac)) / contourModifier
        }
      }
    } else if ((contourType === 4 || contourType === 5) && nextHeights) {
      const gn = groundAt(nextHeights, wx, wz)
      if (gn === null) return null
      if (contourType === 4) {
        ny = vertexY[v] + (maxY - minY) + (gn - avgHeight)
      } else {
        const g = groundAt(heights, wx, wz)
        if (g === null) return null
        const sizeY = maxY - minY
        if (sizeY === 0) return null
        ny = (((g - gn - contourModifier) * ((vertexY[v] << 8) / sizeY)) >> 8) - (avgHeight - g)
      }
    }
    out[v] = Math.round(ny)
  }
  return out
}

const WINDING_NORMAL = [0, 1, 2] as const
const WINDING_FLIPPED = [0, 2, 1] as const

/** Accumulates transformed model triangles into texture buckets. */
class ModelAccumulator {
  buckets = new BucketSet()
  private uvWriters = new WeakMap<ModelData, UVWriter>()
  private uvScratch = new Float32Array(6)

  addModel(
    model: ModelData,
    matrix: THREE.Matrix4,
    owner = -1,
    light?: { sun?: ModelSun; points?: PointLight[]; ambient?: number; contrast?: number },
    blendTypeOf?: (texId: number) => number,
    hdrOf?: (texId: number) => number,
    // Transparent faces go here instead of the shared buckets — the client
    // renders one mesh per loc so its faces can be ordered and depth-sorted as
    // a unit. Opaque faces always stay merged (order-independent).
    transparentTarget?: BucketSet,
    // Phong exponent per texture (0 = none). Only buckets whose material takes
    // a specular carry vertex normals, so a scene with none costs nothing.
    specularOf?: (texId: number) => number,
    // shadowFactor | brightness<<8 per texture (LocAssets.shadeParamsOf) — the
    // client's textured-face grey-mix. See texturedBaseRgb.
    shadeOf?: (texId: number) => number,
  ) {
    const upscale = modelUpscale(model)
    // A mirrored placement reflects the mesh, which flips its triangle winding
    // and would render every mirrored loc inside-out once we cull. The client
    // has the same problem and solves it in the mesh: `wa()` negates vertexZ
    // AND swaps two of the three triangle index arrays. We mirror with a
    // scale(1, 1, -1) on the placement matrix instead, so compensate here.
    // ~9% of placements in region 12850 are mirrored, so this is not an edge case.
    const flipWinding = matrix.determinant() < 0
    const v = new THREE.Vector3()
    let uvWriter = this.uvWriters.get(model)
    if (!uvWriter) this.uvWriters.set(model, (uvWriter = makeUVWriter(model)))
    // Client "Model" shader lighting (dumped GLSL): per-vertex half-Lambert in
    // WORLD space, so lighting depends on the loc's rotation — computed per
    // placement (the world normal matrix isn't shared across placements).
    const normalMat = new THREE.Matrix3().getNormalMatrix(matrix).elements
    const points = light?.points?.length
      ? { lights: light.points, matrix: matrix.elements, upscale }
      : undefined
    // Model-local normals, only when some texture on this model is specular.
    const wantsNormals = specularOf !== undefined && modelHasSpecular(model, specularOf)
    const localNormals = wantsNormals ? new Float32Array(model.faceCount * 9) : undefined
    const ambient = light?.ambient ?? AMBIENT_DEFAULT
    const contrast = light?.contrast ?? CONTRAST_DEFAULT
    const texArr = model.faceTextures
    const baseOf = shadeOf && texArr
      ? (f: number) => {
          const t = texArr[f]
          if (t < 0) return null
          const shade = shadeOf(t)
          if (shade === 0) return null
          return texturedBaseRgb(hslToRgb(adjustLuminance(model.faceColor[f] & 0xffff, ambient)), shade, ambient)
        }
      : undefined
    const lit = computeModelLitRgb(model, normalMat, light?.sun, points, localNormals, baseOf, ambient, contrast)
    if (hdrOf) unlitHdrFaces(model, lit, hdrOf)
    for (let f = 0; f < model.faceCount; f++) {
      if (model.faceAlpha[f] === -1) continue
      const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
      if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
      const textureId = model.faceTextures?.[f] ?? -1
      // UVs computed up front: a non-finite result is the client's degenerate
      // zero-scale mapping (it draws NaN UVs as an invisible smear) — drop the
      // face before it books anything into a bucket.
      if (textureId >= 0 && !uvWriter(f, ia, ib, ic, this.uvScratch, 0)) continue
      // Client transparency test (MeshRasterizer_Sub3 ctor):
      // faceAlpha != 0 || blendType != 0. Transparent faces are ordered after
      // every opaque one, by face priority — the client's baked draw order.
      const transparent = blendTypeOf
        ? model.faceAlpha[f] !== 0 || (textureId >= 0 && blendTypeOf(textureId) !== 0)
        : false
      const bucket = transparent
        ? (transparentTarget ?? this.buckets).getTransparent(textureId, model.facePriorities?.[f] ?? model.priority)
        : this.buckets.get(textureId)
      bucket.owners.push(owner)
      // Baked per-face alpha IS the face's opacity — RS stores 0 = opaque up to
      // 255 = invisible, so GL opacity is the complement. Only transparent
      // buckets carry it (an opaque bucket is by definition all faceAlpha 0),
      // which keeps `alphas` all-or-nothing per bucket the way toMesh expects.
      // Without this every translucent loc face drew fully opaque: the fountain
      // basin's water sits at faceAlpha 150 (~41%), and at full opacity its
      // Gouraud shading reads as flat dark navy instead of pale water.
      if (transparent) {
        const a = (255 - (model.faceAlpha[f] & 0xff)) / 255
        bucket.alphas.push(a, a, a)
      }
      if (textureId >= 0) {
        // this.uvScratch still holds the values from the up-front call
        if (flipWinding) {
          const u = this.uvScratch[2], vv = this.uvScratch[3]
          this.uvScratch[2] = this.uvScratch[4]; this.uvScratch[3] = this.uvScratch[5]
          this.uvScratch[4] = u; this.uvScratch[5] = vv
        }
        bucket.uvs.push(...this.uvScratch)
      } else {
        bucket.uvs.push(0, 0, 0, 0, 0, 0)
      }
      // face colour tints the material texture — the dumped material PNGs are
      // (mostly) greyscale detail maps the client multiplies by face colour. The
      // lit colour is per-vertex so untextured scenery gets smooth Gouraud shading.
      const corners = [ia, ib, ic]
      // `order` reverses the two trailing corners for a mirrored placement —
      // see flipWinding. Everything indexed per-corner (lit colour, normals,
      // and the UVs above) has to follow the same permutation.
      const order = flipWinding ? WINDING_FLIPPED : WINDING_NORMAL
      // Specular buckets carry a normal per vertex. This mesh bakes every
      // placement into one buffer, so the normal goes in with the placement's
      // normal matrix already applied — mesh-local, matching the positions.
      const emitNormal = localNormals !== undefined && textureId >= 0 && specularOf!(textureId) > 0
      for (let k = 0; k < 3; k++) {
        const src = order[k]
        const base = (f * 3 + src) * 3
        const vi = corners[src]
        v.set(model.vertexX[vi] * upscale, -model.vertexY[vi] * upscale, -model.vertexZ[vi] * upscale)
        v.applyMatrix4(matrix)
        bucket.positions.push(v.x, v.y, v.z)
        bucket.colors.push(lit[base], lit[base + 1], lit[base + 2])
        if (emitNormal) {
          const lx = localNormals[base], ly = localNormals[base + 1], lz = localNormals[base + 2]
          const m = normalMat
          const nx = m[0] * lx + m[3] * ly + m[6] * lz
          const ny = m[1] * lx + m[4] * ly + m[7] * lz
          const nz = m[2] * lx + m[5] * ly + m[8] * lz
          const nl = Math.hypot(nx, ny, nz) || 1
          bucket.normals.push(nx / nl, ny / nl, nz / nl)
        }
      }
    }
  }
}

/** Does any face of this model use a material that takes a specular highlight? */
function modelHasSpecular(model: ModelData, specularOf: (texId: number) => number): boolean {
  const tex = model.faceTextures
  if (!tex) return false
  for (let f = 0; f < model.faceCount; f++) {
    const t = tex[f]
    if (t >= 0 && specularOf(t) > 0) return true
  }
  return false
}


/** Emissive (HDR) faces are not directionally shaded.
 *
 *  Measured on the Lumbridge fireplace (model 35878, texture 110): Gouraud
 *  shading spread its flame faces over a 16x range (max-channel 0.062 .. 1.000).
 *  After the 4.03x overbright that leaves the bright faces clipping to pale
 *  yellow but the dark ones at ~0.25 — nowhere near overbright — which is
 *  exactly the orange band the client doesn't have. The client's flame is
 *  uniformly bright, so these faces take their colour at full value and skip the
 *  directional term entirely. */
function unlitHdrFaces(model: ModelData, lit: Float32Array, hdrOf: (texId: number) => number) {
  const tex = model.faceTextures
  if (!tex) return
  for (let f = 0; f < model.faceCount; f++) {
    const t = tex[f]
    if (t < 0 || hdrOf(t) <= 1) continue
    const rgb = hslToRgb(model.faceColor[f] & 0xffff)
    const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
    const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
    const b = srgbToLinear((rgb & 0xff) / 255)
    for (let k = 0; k < 3; k++) {
      const base = (f * 3 + k) * 3
      lit[base] = r; lit[base + 1] = g; lit[base + 2] = b
    }
  }
}

/** A placed loc that idles through a sequence (e.g. a waving flag) — kept out
 *  of the merged static loc mesh so the scene can pose it per frame. `matrix`
 *  is the region-local placement transform; `model` already has recolour /
 *  ground-contour applied and retains its vertexSkins for the pose math. */
export type AnimatedLoc = {
  model: ModelData
  matrix: THREE.Matrix4
  animationId: number
  owner: LocRef
  /** the region point lights this placement is lit by (already picked, ≤4) */
  points?: PointLight[]
  /** the def's TOTAL ambient / contrast (64+ambient, 850+contrast·5) */
  ambient: number
  contrast: number
}

/** A built animatable loc: its three.js mesh (geometry in model-local space —
 *  the caller sets `mesh.matrix` to the placement transform) plus an `update`
 *  that rewrites the position buffer from a posed animation frame. */
export type AnimatedLocMesh = {
  mesh: THREE.Mesh
  update: (posed: PosedVertices) => void
}

/** Build a single-model animatable mesh (mirrors ModelViewer's non-indexed
 *  per-face buffer + ModelAccumulator's map-scene coord/upscale/lighting), and
 *  return an in-place per-frame position updater. Geometry is in model-local
 *  flipped space (x, −y, −z)·upscale so the caller can drive it with the
 *  placement matrix as the mesh transform and re-pose cheaply without a
 *  per-vertex matrix multiply. Lighting is baked once from the placement's
 *  world-normal matrix (a waving flag's Gouraud shading barely shifts). */
export async function buildAnimatedLocMesh(
  model: ModelData,
  matrix: THREE.Matrix4,
  assets: LocAssets,
  sun?: ModelSun,
  owner?: LocRef,
  pointLights?: PointLight[],
  /** the def's TOTAL ambient / contrast — see AnimatedLoc */
  ambient = AMBIENT_DEFAULT,
  contrast = CONTRAST_DEFAULT,
): Promise<AnimatedLocMesh | null> {
  const upscale = modelUpscale(model)
  const uvWriter = makeUVWriter(model)
  const normalMat = new THREE.Matrix3().getNormalMatrix(matrix).elements
  // primed first so specularExponentOf is answerable while the normals are baked
  await assets.primeBlendTypes(model)
  const specularOf = (t: number) => assets.specularExponentOf(t)
  // Model-LOCAL normals here (unlike the merged mesh): this geometry stays in
  // model space with the placement on mesh.matrix, so the shader's
  // mat3(modelMatrix) applies the rotation itself.
  const localNormals = modelHasSpecular(model, specularOf) ? new Float32Array(model.faceCount * 9) : undefined
  // Brightness preference scales the ambient, same as the merged-mesh path
  const effSun: ModelSun | undefined = sun ?? (assets.brightness === 1 ? undefined : {
    ...DEFAULT_MODEL_SUN,
    ambientColour: DEFAULT_MODEL_SUN.ambientColour.map((c) => c * assets.brightness) as [number, number, number],
  })
  const texFaceArr = model.faceTextures
  const lit = computeModelLitRgb(model, normalMat, effSun,
    pointLights?.length ? { lights: pointLights, matrix: matrix.elements, upscale } : undefined,
    localNormals,
    texFaceArr
      ? (f) => {
          const t = texFaceArr[f]
          if (t < 0) return null
          const shade = assets.shadeParamsOf(t)
          if (shade === 0) return null
          return texturedBaseRgb(hslToRgb(adjustLuminance(model.faceColor[f] & 0xffff, ambient)), shade, ambient)
        }
      : undefined,
    ambient, contrast)
  unlitHdrFaces(model, lit, (t) => assets.hdrMultiplierOf(t))

  // Buckets in the client's baked face order (the MeshRasterizer_Sub3 ctor's
  // sort key): priority → opaque-before-transparent → effectId → texture id.
  // The client draws the sorted faces in ONE pass with z-write always on, so
  // a transparent face can OCCLUDE anything sorted after it — the fountain's
  // basin water (texture 638, faceAlpha 150, priority 5) hides its submerged
  // interior (opaque texture 72, priority 6) outright instead of blending
  // over it. Each bucket becomes a material group; three.js draws groups in
  // array order, and transparent groups keep z-write on (see below), which
  // reproduces the client's occlusion. (Skips stay: fully-transparent faces,
  // and textured faces whose mapping produces non-finite UVs — the client
  // draws those as an invisible NaN smear.)
  type LocBucket = { tex: number; faces: number[] }
  const buckets = new Map<number, LocBucket>()
  const scratch = new Float32Array(6)
  for (let f = 0; f < model.faceCount; f++) {
    if (model.faceAlpha[f] === -1) continue
    const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
    if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
    const tex = model.faceTextures?.[f] ?? -1
    if (tex >= 0 && !uvWriter(f, ia, ib, ic, scratch, 0)) continue
    const trans = model.faceAlpha[f] !== 0 || (tex >= 0 && assets.blendTypeOf(tex) !== 0)
    const prio = model.facePriorities?.[f] ?? model.priority
    const effectId = tex >= 0 ? assets.effectIdOf(tex) : 0
    // client: i_14 = prio<<17 | trans<<16 | effectId<<8 | effectParam, then
    // texture, then face index (push order below) — effectParam omitted
    const key = ((((prio & 0xff) * 2 + (trans ? 1 : 0)) * 256 + (effectId & 0xff)) * 4096) + tex + 1
    const b = buckets.get(key)
    if (b) b.faces.push(f)
    else buckets.set(key, { tex, faces: [f] })
  }
  const order = [...buckets.entries()].sort(([a], [b]) => a - b).map(([, b]) => b)
  const validFaces = order.reduce((n, b) => n + b.faces.length, 0)
  if (validFaces === 0) return null

  // Detail-map normalisation, per texture — the same 255/avgLuma the merged loc
  // mesh gets via toMesh's `boostDetailMaps`. A `detailsOnly` texture carries no
  // colour of its own, only luminance detail, so multiplying the lit face colour
  // by it darkens the result by the map's average brightness; the client layers
  // detail maps neutrally. This path never did it, so EVERY animated loc came
  // out too dark. Lumbridge's fountain (object 36781, model 24520) is the
  // worked example: its basin water is texture 638 at avgLuma 151 (1.68x too
  // dark), the rim stone texture 176 at 170 (1.50x) and the bowl texture 127 at
  // 206 (1.24x) — which is why the whole thing read as dark navy stone-grey
  // against the client's pale blue and tan.
  const boosts = new Map<number, number>()
  for (const { tex } of order) {
    if (boosts.has(tex)) continue
    const meta = tex >= 0 ? await assets.getMaterialMeta(tex) : null
    boosts.set(tex, meta?.detailsOnly ? 255 / meta.avgLuma : 1)
  }

  const positions = new Float32Array(validFaces * 9)
  // RGBA: the alpha channel carries the type-5 face-alpha animation
  // (1 = opaque; stays 1 until a frame drives it)
  const colors = new Float32Array(validFaces * 12)
  const uvs = new Float32Array(validFaces * 6)
  const cornerVertex = new Int32Array(validFaces * 3)
  // model face each rendered corner came from (faces are reordered by texture
  // bucket) so the per-frame update can address type-5 face effects
  const cornerFace = new Int32Array(validFaces * 3)
  // material index per rendered face — type-5 alpha is applied PER MATERIAL, so a
  // flame texture can blend while the same model's stone stays opaque
  const faceMat = new Int32Array(validFaces)
  const normals = localNormals ? new Float32Array(validFaces * 9) : null
  // Does this material have any face the MODEL bakes as translucent? Separate
  // from the type-5 animation — that fades faces over time on top of this.
  const matBakedAlpha: boolean[] = []
  const geometry = new THREE.BufferGeometry()
  const materials: THREE.Material[] = []
  let vert = 0
  for (const { tex, faces } of order) {
    const boost = boosts.get(tex) ?? 1
    geometry.addGroup(vert, faces.length * 3, materials.length)
    for (const f of faces) {
      const ia = model.triangleX[f], ib = model.triangleY[f], ic = model.triangleZ[f]
      const corners = [ia, ib, ic]
      if (tex >= 0) { uvWriter(f, ia, ib, ic, scratch, 0); uvs.set(scratch, vert * 2) }
      // Baked opacity, RS's 0 = opaque … 255 = invisible complemented. The
      // type-5 animation overwrites this per frame when it drives a face.
      const baked = model.faceAlpha[f] & 0xff
      const bakedOpacity = (255 - baked) / 255
      if (baked !== 0) matBakedAlpha[materials.length] = true
      for (let k = 0; k < 3; k++) {
        const vi = corners[k]
        const p = (vert + k) * 3
        positions[p] = model.vertexX[vi] * upscale
        positions[p + 1] = -model.vertexY[vi] * upscale
        positions[p + 2] = -model.vertexZ[vi] * upscale
        const lb = (f * 3 + k) * 3
        const pc = (vert + k) * 4
        colors[pc] = lit[lb] * boost; colors[pc + 1] = lit[lb + 1] * boost; colors[pc + 2] = lit[lb + 2] * boost; colors[pc + 3] = bakedOpacity
        if (normals && localNormals) {
          normals[p] = localNormals[lb]
          normals[p + 1] = localNormals[lb + 1]
          normals[p + 2] = localNormals[lb + 2]
        }
        cornerVertex[vert + k] = vi
        cornerFace[vert + k] = f
      }
      faceMat[vert / 3] = materials.length
      vert += 3
    }
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    if (tex >= 0) {
      const texture = await assets.getTexture(tex)
      if (texture) {
        material.map = texture
        const tmeta = await assets.getMaterialMeta(tex)
        const blendType = tmeta?.effectCombiner ?? 0
        material.userData.blendType = blendType
        // Base state — and exactly what setMatBlended's "off" branch restores.
        // It has to be applied HERE as well: setMatBlended early-returns when
        // the requested state already matches its cached flag, and that cache
        // starts `false`, so the off branch never runs on a material the
        // animation never fades. 60a4551 moved these two lines into that branch
        // and they silently stopped being applied at all, leaving every
        // blendType-2 material opaque — that's half the broken fountain. Its
        // water is texture 451 (`effectCombiner: 2`, 290 of model 24520's 878
        // faces), which carries translucency as per-pixel alpha AND a baked
        // faceAlpha of 150 (~41%); rendered opaque, its Gouraud shading reads
        // as flat dark navy instead of pale water.
        material.transparent = blendType === 2 || matBakedAlpha[materials.length] === true
        // z-write stays ON even when blending — the client's. `method13904`
        // only toggles D3D states 15 (ALPHATESTENABLE) and 27
        // (ALPHABLENDENABLE); z-write is state 14, gated by
        // `aBool8755 && aBool8756`, and the 3D model pass (`method14004`)
        // enables it via `method13942(true)`. Dropping it stops a translucent
        // object occluding ITSELF: the fountain's water column (texture 451) is
        // a closed 290-face tube, and without z-write you see its far wall
        // straight through its near wall — the "water coming down on the other
        // side only" that follows the camera round.
        material.depthWrite = true
        // as in toMesh — a specular material's alpha is not opacity, and this
        // path can blend (a type-5 face-alpha animation flips the material to
        // transparent), so the sampled alpha must not scale the fade.
        if (tmeta && effectIgnoresTextureAlpha(tmeta)) {
          const exponent = normals ? specularExponent(tmeta) : 0
          material.onBeforeCompile = exponent > 0 ? specularPatch(sun ?? DEFAULT_MODEL_SUN, exponent) : dropMapAlpha
        }
        if (tmeta && tmeta.hdrMultiplier > 1) {
          material.userData.hdrMultiplier = tmeta.hdrMultiplier
          material.color.setScalar(tmeta.hdrMultiplier)
        }
        material.needsUpdate = true
      }
    }
    materials.push(material)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  // Rest-pose normals: not re-derived as the mesh deforms, same call the baked
  // Gouraud colours already make (a waving flag's shading barely shifts).
  if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  // Rest-pose bounding sphere, padded so gentle animation never exceeds it —
  // lets three.js frustum-cull the DRAW of off-screen animated locs (we don't
  // recompute bounds per frame). frustumCulled stays at its default (true).
  geometry.computeBoundingSphere()
  if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.5
  const mesh = new THREE.Mesh(geometry, materials)
  // Transparent-sort key: the client sorts an object by the view depth of its
  // vertical CENTRE (base + half the model height), not its origin — so record
  // the local centre-Y offset for the renderer's transparent sort to apply.
  geometry.computeBoundingBox()
  if (geometry.boundingBox) {
    mesh.userData.sortCentreY = (geometry.boundingBox.min.y + geometry.boundingBox.max.y) / 2
  }
  // Click-picking, same convention as the merged loc mesh: faceIndex indexes
  // triangleOwners, which indexes locs. Every triangle here belongs to the one
  // loc, so owners is all-zero and locs holds a single entry — resolveLocAt
  // needs no special case. animatedLoc marks the geometry as deforming, which
  // the highlight uses to follow the pose instead of snapshotting it.
  if (owner) {
    mesh.userData.locs = [owner]
    mesh.userData.triangleOwners = new Int32Array(validFaces)
    mesh.userData.animatedLoc = true
  }
  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute
  // Which materials are currently blended for a type-5 alpha animation. Applied
  // PER MATERIAL: flipping the whole mesh made the fireplace's opaque STONE stop
  // writing depth, so its own back faces painted over its front faces (and over
  // the logs). Only the material whose faces the animation actually fades — the
  // flame texture — may blend; everything else keeps depthWrite and stays opaque.
  const matBlended: boolean[] = materials.map(() => false)
  const setMatBlended = (mi: number, on: boolean) => {
    if (matBlended[mi] === on) return
    matBlended[mi] = on
    const mm = materials[mi] as THREE.MeshBasicMaterial
    if (on) {
      mm.transparent = true
      // z-write stays on while blending, as above — the client never drops it
      mm.depthWrite = true
      mm.alphaTest = 0
    } else {
      // back to the material's own base state — which includes staying
      // transparent when the MODEL bakes translucent faces into it
      mm.transparent = mm.userData.blendType === 2 || matBakedAlpha[mi] === true
      mm.depthWrite = true
      // never an alpha test — the client's is a no-op (ALPHAREF 0/GREATEREQUAL)
      mm.alphaTest = 0
    }
    mm.needsUpdate = true
  }
  const matNeedsBlend: boolean[] = materials.map(() => false)

  const update = (posed: PosedVertices) => {
    if (posed.x.length !== model.vertexCount) return
    const X = posed.x, Y = posed.y, Z = posed.z
    for (let i = 0; i < cornerVertex.length; i++) {
      const v = cornerVertex[i]
      positions[i * 3] = X[v] * upscale
      positions[i * 3 + 1] = -Y[v] * upscale
      positions[i * 3 + 2] = -Z[v] * upscale
    }
    positionAttr.needsUpdate = true

    // Type-5 face alpha: RS stores 0 = opaque … 255 = invisible, GL opacity is
    // the complement. Only materials that actually get a faded face blend.
    const pa = posed.faceAlpha
    matNeedsBlend.fill(false)
    if (pa) {
      for (let i = 0; i < cornerFace.length; i++) {
        const a = pa[cornerFace[i]] & 0xff
        colors[i * 4 + 3] = (255 - a) / 255
        if (a !== 0) matNeedsBlend[faceMat[(i / 3) | 0]] = true
      }
    } else {
      // no type-5 frame driving alpha — fall back to the model's BAKED face
      // alpha, not to 1, or a translucent face turns opaque the first time the
      // loc is posed (this is what flattened the fountain's water)
      for (let i = 0; i < cornerFace.length; i++) {
        colors[i * 4 + 3] = (255 - (model.faceAlpha[cornerFace[i]] & 0xff)) / 255
      }
    }
    for (let mi = 0; mi < materials.length; mi++) setMatBlended(mi, matNeedsBlend[mi])
    colorAttr.needsUpdate = true
  }

  return { mesh, update }
}

// Which way a wall decoration is pushed off its wall, per rotation — the
// client's own tables (Class329_Sub1.anIntArray7724/7720 for the straight
// decorations, 7721/7713 for the diagonal ones), in RS x/z.
const DECOR_DX = [1, 0, -1, 0]
const DECOR_DZ = [0, -1, 0, 1]
const DECOR_DIAG_DX = [1, -1, -1, 1]
const DECOR_DIAG_DZ = [-1, -1, 1, 1]

/** An invisible utility loc (sound emitter / map-icon anchor) worth showing
 *  as an editor marker instead of its teal quad. Scene-local coordinates. */
export type MarkerInfo = {
  x: number
  y: number
  z: number
  objectId: number
  kind: 'sound' | 'mapicon' | 'mapsprite' | 'barrier' | 'other'
  /** What `kind` falls back to when the def carries none of the three id fields
   *  — decided by the model's sentinel colour, which only the build knows. Kept
   *  on the record so an edit can re-derive `kind` without a scene rebuild. */
  fallback: 'barrier' | 'other'
  /** the placement's shape (0-22) — decides its slot, which is what says
   *  whether the client would ever draw its map sprite */
  type: number
  tileX: number
  tileY: number
  /** the placement's own plane (what the maps file says), for the marker list —
   *  not necessarily the plane group the diamond renders in */
  plane: number
}

/** One placed loc in a merged mesh, for click-picking via triangleOwners. */
export type LocRef = {
  objectId: number
  shape: number
  rotation: number
  x: number
  y: number
  plane: number
}

/** Which marker kind a def's own fields imply, or null if none of them do.
 *  Callers add their own fallback for the kinds that aren't in the def (the
 *  colour-sentinel 'barrier'/'other').
 *
 *  Every test is `>= 0`, NOT `!== undefined`: the dump emits these fields on
 *  every object whether they're set or not — all 73913 carry `ambientSoundId`,
 *  `-1` when there's no sound — so a presence test says "sound emitter" for
 *  literally everything, which is how all 206 nameless map-icon anchors (the
 *  musician icon among them) ended up listed as sound emitters. `soundId`
 *  isn't in this dump at all (0 objects) but is kept for other revisions;
 *  `soundGroupIds` is absent unless populated and never holds a negative
 *  (384 objects carry one, lowest entry 710), and 340 of those are emitters
 *  whose only sound is the group, so it has to stay part of the test. */
export function markerKindFromDef(def: ObjectDefJson): 'sound' | 'mapicon' | 'mapsprite' | null {
  if ((def.soundId ?? -1) >= 0 || (def.ambientSoundId ?? -1) >= 0 || (def.soundGroupIds?.some((s) => s >= 0) ?? false)) return 'sound'
  if ((def.mapCategoryId ?? -1) >= 0) return 'mapicon'
  if ((def.mapSpriteId ?? -1) >= 0) return 'mapsprite'
  return null
}

export const MARKER_COLORS: Record<MarkerInfo['kind'], number> = {
  sound: 0xff9d3a, // orange — ambient sound emitters
  mapicon: 0xb47aff, // violet — map icon anchors
  mapsprite: 0x3ad0c8, // teal — minimap "mapscene" sprite anchors
  barrier: 0xff5a5a, // red — invisible barrier walls
  other: 0xe8e8e8,
}

/** Floating diamond per marker (one merged mesh per kind), plus a thin stem
 *  down to the ground so the anchor tile is obvious. */
export function buildMarkersMesh(markers: MarkerInfo[]): THREE.Group | null {
  if (markers.length === 0) return null
  const group = new THREE.Group()
  const SIZE_U = 52
  const FLOAT = 140
  // octahedron vertex/face template
  const o = [
    [SIZE_U, 0, 0], [-SIZE_U, 0, 0], [0, SIZE_U, 0], [0, -SIZE_U, 0], [0, 0, SIZE_U], [0, 0, -SIZE_U],
  ]
  const faces = [
    [2, 0, 4], [2, 4, 1], [2, 1, 5], [2, 5, 0],
    [3, 4, 0], [3, 1, 4], [3, 5, 1], [3, 0, 5],
  ]
  const byKind = new Map<MarkerInfo['kind'], MarkerInfo[]>()
  for (const m of markers) {
    let arr = byKind.get(m.kind)
    if (!arr) byKind.set(m.kind, (arr = []))
    arr.push(m)
  }
  for (const [kind, list] of byKind) {
    const positions: number[] = []
    for (const m of list) {
      const cy = m.y + FLOAT
      for (const [a, b, c] of faces) {
        positions.push(
          m.x + o[a][0], cy + o[a][1], m.z + o[a][2],
          m.x + o[b][0], cy + o[b][1], m.z + o[b][2],
          m.x + o[c][0], cy + o[c][1], m.z + o[c][2],
        )
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    const diamonds = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: MARKER_COLORS[kind] }))
    // 8 triangles per diamond → raycast faceIndex >> 3 indexes this list
    diamonds.userData.markers = list
    group.add(diamonds)

    const stems: number[] = []
    for (const m of list) stems.push(m.x, m.y, m.z, m.x, m.y + FLOAT, m.z)
    const stemGeometry = new THREE.BufferGeometry()
    stemGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stems), 3))
    group.add(new THREE.LineSegments(stemGeometry, new THREE.LineBasicMaterial({ color: MARKER_COLORS[kind], transparent: true, opacity: 0.6 })))
  }
  return group
}

/** One `lights[]` record — the client's `Class287` constructor, field for field. */
export type RegionLight = {
  /** the light's own plane; `grows*` extend the range it registers on */
  plane: number
  growsUpwards: boolean
  growsDownwards: boolean
  /** region-local world units (the record stores `u16 << 2`) */
  x: number
  z: number
  /** height, world units */
  y: number
  size2d: number
  /** Per-tile-row spans of the light's footprint: `s >>> 8` is the row's x
   *  offset, `s & 0xff` its length. `size2d*2+1` entries. NOT a radius — the
   *  client only uses these to register the light into its per-tile grid. */
  ranges: number[]
  /** packed HSV (not HSL) — see `lightHsvToHsl16` */
  colorHsl: number
  /** flicker preset 0-30, or 31 = "use `lightTypeId`" (config/light_intensities) */
  type: number
  /** flicker phase offset, `(packed & 0xe0) << 3` */
  rotationOffset: number
  lightTypeId?: number
}

// SceneObjectManager.anInt2592 / anInt2594 — the scene's tile shift and half-tile.
const LIGHT_TILE_SHIFT = 9
const LIGHT_HALF_TILE = (1 << LIGHT_TILE_SHIFT) >> 1

/**
 * `VarDefinitions.method6362` — a light's stored colour is packed HSV, and the
 * client converts it to the standard HSL16 palette index before the lookup in
 * `Class335.HSL_TO_RGB`. Straight `hslToRgb(colorHsl)` gives the wrong colour.
 */
export function lightHsvToHsl16(hsv: number): number {
  const hue = (hsv >> 10) & 0x3f
  const value = hsv & 0x7f
  let sat = (hsv >> 3) & 0x70
  sat = value <= 64 ? (value * sat) >> 7 : (sat * (127 - value)) >> 7
  const sum = sat + value
  const s = sum !== 0 ? ((sat << 8) / sum) | 0 : sat << 1
  return ((hue << 10) | ((s >> 4) << 7) | sum) & 0xffff
}

/** A light's reach in world units — `Class287` line 52. */
export function lightRadius(rec: RegionLight): number {
  return (rec.size2d << LIGHT_TILE_SHIFT) + LIGHT_HALF_TILE
}

/** A light's rendered colour from its stored `colorHsl` (packed HSV -> HSL16
 *  -> palette RGB). */
export function lightRgb(colorHsl: number): number {
  return hslToRgb(lightHsvToHsl16(colorHsl))
}

/**
 * Where a light record sits in scene space. Its stored `y` is a height ABOVE
 * its tile, not a render coordinate: Class329_Sub1 repositions the light to
 * `tileHeights[plane][tx][tz] - y`. Terrain heights are negative-up, so
 * scene y = -(ground - y) = -ground + y.
 */
export function lightScenePos(rec: RegionLight, heightsAll: Int32Array[]): { x: number; y: number; z: number; ground: number } {
  const tx = Math.min(Math.max(rec.x >> LIGHT_TILE_SHIFT, 0), VERTS - 1)
  const tz = Math.min(Math.max(rec.z >> LIGHT_TILE_SHIFT, 0), VERTS - 1)
  const ground = heightsAll[Math.min(Math.max(rec.plane, 0), heightsAll.length - 1)]?.[tx * VERTS + tz] ?? 0
  // world -> scene, the same flip loc placements use
  return { x: rec.x, y: -ground + rec.y, z: -rec.z, ground: -ground }
}

/**
 * Footprint spans for a light of the given `size2d`, as the editor writes them
 * when a light is created or resized: one row per tile of the bounding box,
 * each covering the full width (`offset 0, length size2d*2+1`).
 *
 * The real records carry hand-authored shapes — some are full squares like
 * this, others carve out a rough circle (e.g. size2d 3 dumps as
 * `[0, 261 x5, 0]` = a 5-wide band inside a 7x7 box). The client only uses
 * them to decide which tiles the light registers on, so a full box is the
 * safe, maximal choice; existing records keep whatever they already had.
 */
export function lightRangesFor(size2d: number): number[] {
  const rows = size2d * 2 + 1
  return new Array(rows).fill(rows)
}

/** Per-tile point lights for a region, mirroring the client's tile grid. */
export type LightGrid = {
  /** The ≤4 lights the client would bind for an object covering these tiles.
   *  `extra` adds tiles outside the footprint rect — see `wallLightTiles`. */
  at(plane: number, x0: number, y0: number, x1: number, y1: number, extra?: readonly (readonly [number, number])[]): PointLight[]
  /** how many light records went in (0 = nothing to bake) */
  count: number
}

// Wall side flags -> the tile the wall's OUTWARD face points into.
// `Engine.method4777`: shapes 0 and 2 take their flag from {1,2,4,8}[rot] (the
// W/N/E/S edge the wall sits on), shapes 1 and 3 from {16,32,64,128}[rot] (the
// diagonal corners). The offsets are the branch table at the bottom of
// `GraphNode_Sub1_Sub5.method13036`.
const WALL_EDGE_SIDES = [[-1, 0], [0, 1], [1, 0], [0, -1]] as const   // flags 1, 2, 4, 8
const WALL_CORNER_SIDES = [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const // flags 16, 32, 64, 128

/**
 * The tiles a wall ALSO takes its lights from, on top of its own.
 *
 * `GraphNode_Sub1_Sub5.method13036` doesn't use the wall's own tile
 * unconditionally the way scenery does. It tests the wall's side flag against
 * `anIntArray9618[i]`, indexed by where the CAMERA sits relative to the wall's
 * tile, and when the face you can see is the one pointing away from its own
 * tile it reads the light grid at the tile on the other side of the wall
 * instead. That's how a torch lights the walls flanking it: their own tiles are
 * outside the light's footprint, but the tiles their visible faces point into
 * are inside it.
 *
 * We bake into vertex colours, so we can't re-pick per camera position the way
 * the client does per frame — we take BOTH tiles, which is the union of the two
 * answers the client can give and so always contains the right one. The cost is
 * that a wall separating a lit room from a dark one lights on both faces
 * instead of only the lit side.
 *
 * Shape 2 (`WALL_WHOLE_CORNER`) is two wall nodes in the client — rotations
 * `r + 4` and `r + 1`, i.e. flags for `r` and `r + 1` — so it has two.
 * Shape 9 (`WALL_INTERACT`, the diagonal walls) is NOT a wall node: it goes
 * through the generic object path and uses its footprint, so it gets nothing
 * here.
 */
export function wallLightTiles(shape: number, rotation: number, x: number, y: number): (readonly [number, number])[] {
  const r = rotation & 3
  const at = (d: readonly [number, number]) => [x + d[0], y + d[1]] as const
  if (shape === 0) return [at(WALL_EDGE_SIDES[r])]
  if (shape === 1 || shape === 3) return [at(WALL_CORNER_SIDES[r])]
  if (shape === 2) return [at(WALL_EDGE_SIDES[r]), at(WALL_EDGE_SIDES[(r + 1) & 3])]
  return []
}

const NO_LIGHTS: PointLight[] = []

/**
 * Build the region's point-light lookup, following `Class287` +
 * `SceneObjectManager.method3441`:
 *
 *  - radius  = `(size2d << 9) + 256` world units (`Class287` line 52)
 *  - colour  = HSV -> HSL16 -> palette
 *  - footprint = one tile row per `ranges[]` entry, registered on every plane
 *    from the light's own up/down to the ones its grow flags reach
 *
 * The client caps each tile at 4 lights (its grid packs four 16-bit ids into a
 * long), and an object takes the first 4 distinct lights across its footprint.
 *
 * Intensity is baked at 1.0, which is what the client uses with "Flickering
 * effects" off — every built-in preset has `ticker + surrounding == 2048`, so
 * the unflickered value is exactly 1.0. Animating it would need the lights as
 * shader uniforms rather than baked vertex colours.
 */
export function buildLightGrid(
  regionLights: RegionLight[] | undefined,
  heightsAll: Int32Array[],
  planeCount = 4,
): LightGrid {
  if (!regionLights?.length) return { at: () => NO_LIGHTS, count: 0 }
  const cells: (PointLight[] | undefined)[] = new Array(planeCount * SIZE * SIZE)
  let count = 0

  for (const rec of regionLights) {
    if (!rec.ranges?.length) continue
    const radius = lightRadius(rec)
    const rgb = lightRgb(rec.colorHsl)
    const pos = lightScenePos(rec, heightsAll)
    const light: PointLight = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      radiusSq: radius * radius,
      r: ((rgb >> 16) & 0xff) / 255,
      g: ((rgb >> 8) & 0xff) / 255,
      b: (rgb & 0xff) / 255,
    }
    count++

    const p0 = rec.growsDownwards ? 0 : rec.plane
    const p1 = rec.growsUpwards ? planeCount - 1 : rec.plane
    const rowBase = (rec.z - radius + LIGHT_HALF_TILE) >> LIGHT_TILE_SHIFT
    const colBase = (rec.x - radius + LIGHT_HALF_TILE) >> LIGHT_TILE_SHIFT
    for (let p = Math.max(p0, 0); p <= Math.min(p1, planeCount - 1); p++) {
      for (let row = 0; row < rec.ranges.length; row++) {
        const ty = rowBase + row
        if (ty < 0 || ty >= SIZE) continue
        // Class287 clamps each span into the footprint as it decodes; cryogen
        // dumps the raw shorts, so apply it here.
        const span = rec.ranges[row]
        const rows = rec.ranges.length
        const offset = Math.min(span >>> 8, rows - 1)
        const length = Math.min(span & 0xff, rows - offset)
        const from = Math.max(colBase + offset, 0)
        const to = Math.min(colBase + offset + length - 1, SIZE - 1)
        for (let tx = from; tx <= to; tx++) {
          const key = (p * SIZE + tx) * SIZE + ty
          const list = cells[key] ?? (cells[key] = [])
          if (list.length < 4) list.push(light)
        }
      }
    }
  }

  return {
    count,
    at(plane, x0, y0, x1, y1, extra) {
      if (plane < 0 || plane >= planeCount) return NO_LIGHTS
      let out: PointLight[] | null = null
      // the client stops at 4 (its grid packs four 16-bit ids into a long), so
      // the footprint goes first and the across-the-wall tiles only fill what's
      // left — a wall standing in its own light keeps that light
      const take = (tx: number, ty: number): boolean => {
        if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return false
        const list = cells[(plane * SIZE + tx) * SIZE + ty]
        if (!list) return false
        for (const l of list) {
          if (!out) out = []
          else if (out.includes(l)) continue
          out.push(l)
          if (out.length === 4) return true
        }
        return false
      }
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) if (take(tx, ty)) return out!
      }
      if (extra) {
        for (const [tx, ty] of extra) if (take(tx, ty)) return out!
      }
      return out ?? NO_LIGHTS
    },
  }
}

/**
 * Editor gizmos for a region's point lights: a floating diamond in the light's
 * own colour, a stem down to the ground, and a ring at its radius.
 *
 * These DO depth-test (they just don't write depth). An earlier version drew
 * them x-ray so a light buried inside the loc it lights stayed reachable — but
 * picking raycasts geometry, not the depth buffer, so `pickLight` finds an
 * occluded light either way, and a solid flame-orange octahedron shining
 * through the floor reads as stray scene geometry. Only the SELECTED light's
 * ring and stalk stay x-ray, so you can always see what you have in hand.
 *
 * `indices` are positions in the region's `lights[]` array; the diamonds mesh
 * carries them so a raycast (8 triangles per diamond -> `faceIndex >> 3`)
 * resolves back to the record being edited.
 */
export function buildLightsMesh(
  lights: RegionLight[],
  heightsAll: Int32Array[],
  indices: number[],
): THREE.Group | null {
  if (indices.length === 0) return null
  const SIZE_U = 44
  const ORDER = 4000
  const group = new THREE.Group()
  const o = [
    [SIZE_U, 0, 0], [-SIZE_U, 0, 0], [0, SIZE_U, 0], [0, -SIZE_U, 0], [0, 0, SIZE_U], [0, 0, -SIZE_U],
  ]
  const faces = [
    [2, 0, 4], [2, 4, 1], [2, 1, 5], [2, 5, 0],
    [3, 4, 0], [3, 1, 4], [3, 5, 1], [3, 0, 5],
  ]
  const positions: number[] = []
  const colors: number[] = []
  const stems: number[] = []
  const stemColors: number[] = []
  const rings: number[] = []
  const ringColors: number[] = []
  const RING_SEGMENTS = 24

  for (const index of indices) {
    const rec = lights[index]
    if (!rec) continue
    const p = lightScenePos(rec, heightsAll)
    const rgb = lightRgb(rec.colorHsl)
    // gizmos are tint-only overlays, so keep them readable even for a very
    // dark light colour: lift the floor without washing out the hue
    const r = Math.max(((rgb >> 16) & 0xff) / 255, 0.15)
    const g = Math.max(((rgb >> 8) & 0xff) / 255, 0.15)
    const b = Math.max((rgb & 0xff) / 255, 0.15)
    for (const [a, b2, c] of faces) {
      for (const vi of [a, b2, c]) {
        positions.push(p.x + o[vi][0], p.y + o[vi][1], p.z + o[vi][2])
        colors.push(r, g, b)
      }
    }
    stems.push(p.x, p.y, p.z, p.x, p.ground, p.z)
    for (let i = 0; i < 2; i++) stemColors.push(r, g, b)
    // radius ring at the light's own height — how far it actually reaches
    const radius = lightRadius(rec)
    for (let s = 0; s < RING_SEGMENTS; s++) {
      const a0 = (s / RING_SEGMENTS) * Math.PI * 2
      const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2
      rings.push(
        p.x + Math.cos(a0) * radius, p.y, p.z + Math.sin(a0) * radius,
        p.x + Math.cos(a1) * radius, p.y, p.z + Math.sin(a1) * radius,
      )
      for (let i = 0; i < 2; i++) ringColors.push(r, g, b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  const diamonds = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, depthWrite: false, fog: false,
  }))
  diamonds.renderOrder = ORDER
  diamonds.userData.lights = lights
  diamonds.userData.lightIndices = indices
  group.add(diamonds)

  const stemGeometry = new THREE.BufferGeometry()
  stemGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stems), 3))
  stemGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(stemColors), 3))
  const stemLines = new THREE.LineSegments(stemGeometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
  }))
  stemLines.renderOrder = ORDER
  group.add(stemLines)

  const ringGeometry = new THREE.BufferGeometry()
  ringGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rings), 3))
  ringGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ringColors), 3))
  const ringLines = new THREE.LineSegments(ringGeometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, fog: false,
  }))
  ringLines.renderOrder = ORDER
  group.add(ringLines)

  return group
}

/** Region environment JSON (map_environments/<regionId>.json — the terrain
 *  archive's environment tail, dumped by cryogen MapEnvironmentDumper). */
export type RegionEnvironment = {
  environment?: {
    flags: number
    sunColour?: number
    sunAmbient?: number
    sunLight?: number
    sunBacklight?: number
    sunPosition?: [number, number, number]
    fogColour?: number
    fogDepth?: number
    cubeTexture?: number[]
  }
  skybox?: { id: number; x: number; y: number; z: number; rotation: number }
  lights?: RegionLight[]
  /** Bloom filter parameters for this region (map-environment opcode 2 ->
   *  darkan `Atmosphere`). Each is a byte * 8/255, so 0..8. They feed the
   *  FilterBloom `params` uniform: threshold = params.x, strength = params.y,
   *  whitePoint = params.z. Absent for regions that don't override the
   *  defaults of 1.0 / 0.25 / 1.0. */
  hdr?: { whitePoint: number; bloomStrength: number; bloomThreshold: number }
  /** Static lighting grid (opcode 129), carried verbatim as base64 by the
   *  dumper — we don't render it, and must not lose it on save. */
  lightingGrid?: string
  /** The order this region's tail listed its opcodes in. The cache isn't
   *  consistently ascending, and cryogen re-emits in this order so an unedited
   *  region repacks to identical bytes. Opaque here — pass it through. */
  opcodeOrder?: number[]
  /** Legacy marker from the first environment dump (grid present but its bytes
   *  not recorded). cryogen refuses to pack such a file; kept on the type so a
   *  save round-trips it instead of quietly dropping the warning flag. */
  hasLightingGrid?: boolean
  regionX?: number
  regionY?: number
}

export async function loadRegionEnvironment(
  rootHandle: FileSystemDirectoryHandle,
  regionId: number,
): Promise<RegionEnvironment | null> {
  try {
    const dir = await rootHandle.getDirectoryHandle('map_environments')
    const file = await (await dir.getFileHandle(`${regionId}.json`)).getFile()
    return JSON.parse(await file.text()) as RegionEnvironment
  } catch {
    return null
  }
}

/**
 * Write a region's environment JSON back, creating the folder/file if the dump
 * doesn't have one yet (a region can have lights added where it had no
 * environment tail at all).
 *
 * NOTE: cryogen dumps map_environments as read-only editor data — its map
 * repacker re-encodes only the tile section, so edits here reach the dump but
 * not the packed cache until the dumper learns to round-trip the tail.
 */
export async function saveRegionEnvironment(
  rootHandle: FileSystemDirectoryHandle,
  regionId: number,
  env: RegionEnvironment,
): Promise<void> {
  const dir = await rootHandle.getDirectoryHandle('map_environments', { create: true })
  const fileHandle = await dir.getFileHandle(`${regionId}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(env))
  await writable.close()
}

/** The region's sky dome (config/skyboxes → archiveId model, textured with
 *  its own sky/cloud materials), built for rendering around the camera. */
export async function buildSkyboxMesh(
  rootHandle: FileSystemDirectoryHandle,
  assets: LocAssets,
  skyboxId: number,
  rotation: number,
): Promise<THREE.Mesh | null> {
  try {
    const configDir = await rootHandle.getDirectoryHandle('config')
    const dir = await configDir.getDirectoryHandle('skyboxes')
    const file = await (await dir.getFileHandle(`${skyboxId}.json`)).getFile()
    const def = JSON.parse(await file.text()) as { archiveId?: number }
    if (def.archiveId === undefined || def.archiveId < 0) return null
    const model = await assets.getModel(def.archiveId)
    if (!model) return null

    const acc = new ModelAccumulator()
    acc.addModel(model, new THREE.Matrix4())
    const mesh = await acc.buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true)
    if (!mesh) return null
    for (const m of mesh.material as THREE.MeshBasicMaterial[]) {
      m.fog = false // the dome must not be fogged out
      m.depthWrite = false
      m.side = THREE.DoubleSide
      // sky textures draw untinted — the dome model's face colours are junk
      // (they'd tint the clouds green); untextured faces keep vertex colours
      if (m.map) m.vertexColors = false
      m.needsUpdate = true
    }
    mesh.renderOrder = -1000
    mesh.frustumCulled = false
    // skybox rotation is in 16384ths of a turn like everything else
    mesh.rotation.y = -(rotation / 16384) * Math.PI * 2
    return mesh
  } catch {
    return null
  }
}

/** A terrain-following 8×8 chunk grid over one region (plane-0 heights),
 *  floated slightly above ground. Chunks are the unit the maps index packs
 *  loc coordinates in (`x<<6 | y<<3 | plane`), so the grid shows where a
 *  placement's chunk-relative coords roll over. The outermost lines are the
 *  region boundary and are drawn in the brighter colour.
 *
 *  Each line is subdivided per tile so it follows the ground contour instead
 *  of cutting through hills. */
export function buildChunkGrid(heights: Int32Array, edgeColor = 0x2f8fff, chunkColor = 0x1d5c96): THREE.LineSegments {
  const LIFT = 24
  const points: number[] = []
  const colors: number[] = []
  const edge = new THREE.Color(edgeColor)
  const inner = new THREE.Color(chunkColor)
  const push = (tx: number, ty: number, c: THREE.Color) => {
    points.push(tx * 512, -heights[tx * VERTS + ty] + LIFT, -(ty * 512))
    colors.push(c.r, c.g, c.b)
  }
  for (let i = 0; i <= SIZE; i += CHUNK) {
    const c = i === 0 || i === SIZE ? edge : inner
    for (let j = 0; j < SIZE; j++) {
      push(i, j, c); push(i, j + 1, c) // the line at x = i
      push(j, i, c); push(j + 1, i, c) // the line at y = i
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }))
}

/** All placed locs of one plane merged into one textured mesh. */
export async function buildLocsMesh(
  terrain: MapTerrain,
  objects: [number, number, number, number, number, number][],
  renderPlane: number,
  heightsAll: Int32Array[],
  assets: LocAssets,
  onProgress?: (done: number, total: number) => void,
  lightGrid?: LightGrid,
): Promise<{ mesh: THREE.Mesh | null; transparentLocs: THREE.Mesh[]; markers: MarkerInfo[]; shadows: Uint8Array; animated: AnimatedLoc[] }> {
  // the Brightness preference scales the scene ambient — bake it into the sun
  // handed to every placement rather than special-casing computeModelLitRgb
  const bakeSun: ModelSun | undefined = assets.brightness === 1 ? undefined : {
    ...DEFAULT_MODEL_SUN,
    ambientColour: DEFAULT_MODEL_SUN.ambientColour.map((c) => c * assets.brightness) as [number, number, number],
  }
  const acc = new ModelAccumulator()
  const markers: MarkerInfo[] = []
  const locRefs: LocRef[] = []
  // locs with an idle sequence (waving flags etc.) — collected out of the merged
  // static mesh so the scene can pose them per frame.
  const animated: AnimatedLoc[] = []
  // one mesh per loc that has transparent faces + the materials they share
  const transparentLocs: THREE.Mesh[] = []
  const transMaterials = new Map<number, THREE.Material>()
  // small transparent locs (ground clutter) share one mesh — see the threshold
  const sharedTrans = new BucketSet()
  // SceneGraph static shadows: values SUBTRACTED from the vertex lights.
  // Walls darken their edge's two corners by 50; scenery darkens every
  // footprint corner by the model's shadow displacement (size2d/4, clamped
  // 30 — which virtually all scenery hits, so we use the clamp).
  const shadows = new Uint8Array(VERTS * VERTS)
  const setShadow = (vx: number, vy: number, d: number) => {
    if (vx < 0 || vy < 0 || vx >= VERTS || vy >= VERTS) return
    if (shadows[vx * VERTS + vy] < d) shadows[vx * VERTS + vy] = d
  }
  // bridge columns shift down one render plane (deck = ground level)
  const planeObjects = objects.filter(([, , , x, y, p]) => {
    const bridge = x >= 0 && y >= 0 && x < SIZE && y < SIZE && isBridgeTile(terrain, x, y)
    return (bridge ? Math.max(p - 1, 0) : p) === renderPlane
  })

  // Wall decorations are pushed away from the wall they hang on by that WALL's
  // `decorDisplacement` (Class329_Sub1.method12465 reads it off getWall for the
  // decoration's own tile). Only walls — shapes 0-3, the ones the client files
  // under method3395 — are wall nodes, and only non-default values are worth
  // storing: with no wall the client falls back to 64, which is the default.
  const wallDisplacement = new Map<number, number>()
  for (const [objectId, shape, , x, y] of planeObjects) {
    if (shape > 3 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
    const dd = (await assets.getDef(objectId))?.decorDisplacement
    if (dd !== undefined && dd !== 64) wallDisplacement.set(x * SIZE + y, dd)
  }

  let done = 0
  for (const [objectId, shape, rotation, x, y, decodedPlane] of planeObjects) {
    const heights = heightsAll[decodedPlane]
    done++
    if (onProgress && done % 64 === 0) onProgress(done, planeObjects.length)
    let def = await assets.getDef(objectId)
    // Morph ("multiloc") objects carry no models of their own — the client
    // swaps the whole def for `transformTo[varbit]` (getMultiLoc). There's no
    // player here to read a varbit from, so take the first real target, which
    // is what a fresh world shows (an unset varbit is 0). Without this the loc
    // renders as nothing at all: object 69836 in Lumbridge is one.
    if (def && (!def.objectModelIds || def.objectModelIds.length === 0) && def.transformTo?.length) {
      const target = def.transformTo.find((id) => id !== -1 && id !== undefined)
      if (target !== undefined) def = await assets.getDef(target) ?? def
    }
    if (!def || !def.objectModelIds || def.objectModelIds.length === 0) continue
    const isAnimated = (def.animations?.length ?? 0) > 0

    // model list for this loc shape (ObjectType: shapes[] parallel to objectModelIds[])
    let shapeIdx = def.shapes ? def.shapes.indexOf(shape) : -1
    if (shapeIdx === -1) {
      // wall decorations reuse shape 4's models for 5-8, and everything falls
      // back to the first entry rather than vanishing
      if (def.shapes && shape >= 5 && shape <= 8) shapeIdx = def.shapes.indexOf(4)
      if (shapeIdx === -1) shapeIdx = 0
    }
    const modelIds = def.objectModelIds[Math.min(shapeIdx, def.objectModelIds.length - 1)]
    if (!modelIds || modelIds.length === 0) continue

    // SceneGraph.addObject: swap footprint for rotations 1/3, centre + average height
    const sizeX = (rotation === 1 || rotation === 3 ? def.sizeY : def.sizeX) ?? 1
    const sizeY = (rotation === 1 || rotation === 3 ? def.sizeX : def.sizeY) ?? 1

    if (def.staticShadow !== false) {
      if (shape <= 3) {
        // straight/corner walls: two corners of the wall's edge, 50
        if (rotation === 0) { setShadow(x, y, 50); setShadow(x, y + 1, 50) }
        else if (rotation === 1) { setShadow(x, y + 1, 50); setShadow(x + 1, y + 1, 50) }
        else if (rotation === 2) { setShadow(x + 1, y, 50); setShadow(x + 1, y + 1, 50) }
        else { setShadow(x, y, 50); setShadow(x + 1, y, 50) }
      } else if (shape >= 9 && shape <= 11) {
        // interactive scenery: whole footprint, shadow displacement 30
        for (let dx = 0; dx <= sizeX; dx++) {
          for (let dy = 0; dy <= sizeY; dy++) setShadow(x + dx, y + dy, 30)
        }
      }
    }
    const xA = x + (sizeX >> 1)
    const xB = x + ((sizeX + 1) >> 1)
    const yA = y + (sizeY >> 1)
    const yB = y + ((sizeY + 1) >> 1)
    // clamped: border-ring locs from neighbour regions sit at tile -1 / 64
    const hAt = (tx: number, ty: number) =>
      heights[Math.min(Math.max(tx, 0), VERTS - 1) * VERTS + Math.min(Math.max(ty, 0), VERTS - 1)]
    const avgHeight = (hAt(xA, yA) + hAt(xB, yA) + hAt(xA, yB) + hAt(xB, yB)) >> 2
    const sceneX = (x << 9) + (sizeX << 8)
    const sceneY = (y << 9) + (sizeY << 8)
    // the ≤4 region lights this placement is bound to, picked over its footprint
    // exactly as GraphNode_Sub1_Sub1.method13036 does — plus, for wall shapes,
    // the tile the wall's outward face points into, which is the tile the
    // client's own wall node reads when that's the face you're looking at
    // (see wallLightTiles)
    const points = lightGrid?.count
      ? lightGrid.at(decodedPlane, x, y, x + sizeX - 1, y + sizeY - 1,
          shape <= 3 ? wallLightTiles(shape, rotation, x, y) : undefined)
      : undefined

    // `ObjectDefinition.method7971` applies, in model space and this order:
    // mirror (negate RS z, `wa`) → the rotation≥4 extras → rotate 90°·r
    // (`S(4096·r)`; RS x'=x·cos+z·sin ⇒ three −θ) → scale (resize) → translate
    // (offsetX/Y/Z). `variant` is that rotation≥4 branch:
    //   'decor'  shape 4 with rotation>3 — an extra 45° THEN a (180, 0, -180)
    //            model-space shift, which is how the client builds every
    //            diagonal wall decoration (types 6/7/8).
    //   'rot45'  shape 10 with rotation>3 — `method8012`'s `f(2048)`, the extra
    //            45° diagonal scenery (type 11) is drawn with, and no shift.
    // `offX/offZ` is the world-space displacement the scene node adds on top
    // (GraphNode_Sub1_Sub4_Sub1.method12990's `method5219`).
    type Piece = { rot: number; mirror: boolean; variant: 'plain' | 'decor' | 'rot45'; offX: number; offZ: number }
    const inverted = def.inverted ?? false
    const piece = (rot: number, variant: Piece['variant'] = 'plain', offX = 0, offZ = 0, mirror = inverted): Piece =>
      ({ rot, mirror, variant, offX, offZ })
    // the wall's displacement, defaulting to 64 exactly as the client does
    const wallDisp = wallDisplacement.get(x * SIZE + y) ?? 64
    const straightOff = wallDisp + 1
    const diagonalOff = (wallDisp >> 1) + 1
    let pieces: Piece[]
    if (shape === 2) {
      // whole-corner wall: two pieces, the first from the mirrored model
      // (rotation+4), the second rotated one step on (method12464)
      pieces = [piece(rotation, 'plain', 0, 0, true), piece((rotation + 1) & 0x3)]
    } else if (shape === 5) {
      pieces = [piece(rotation, 'plain', straightOff * DECOR_DX[rotation], straightOff * DECOR_DZ[rotation])]
    } else if (shape === 6) {
      pieces = [piece(rotation, 'decor', diagonalOff * DECOR_DIAG_DX[rotation], diagonalOff * DECOR_DIAG_DZ[rotation])]
    } else if (shape === 7) {
      pieces = [piece((rotation + 2) & 0x3, 'decor')]
    } else if (shape === 8) {
      // in-wall diagonal decoration: displaced outer piece + inner piece
      pieces = [
        piece(rotation, 'decor', diagonalOff * DECOR_DIAG_DX[rotation], diagonalOff * DECOR_DIAG_DZ[rotation]),
        piece((rotation + 2) & 0x3, 'decor'),
      ]
    } else if (shape === 11) {
      pieces = [piece(rotation, 'rot45')]
    } else {
      pieces = [piece(rotation)]
    }

    let markerModels = 0
    let markerIsBarrier = false
    // this loc's transparent faces — becomes its own mesh, like the client
    const locTrans = new BucketSet()
    for (const piece of pieces) {
      // the decoration displacement is a world-space shift of the placement
      // (RS x/z → scene x/−z), so it rides on the tile-centre translate
      const matrix = new THREE.Matrix4().makeTranslation(
        sceneX + piece.offX, -avgHeight, -(sceneY + piece.offZ))
      if (def.offsetX || def.offsetY || def.offsetZ) {
        matrix.multiply(new THREE.Matrix4().makeTranslation(def.offsetX ?? 0, -(def.offsetY ?? 0), -(def.offsetZ ?? 0)))
      }
      const scaleX = (def.scaleX ?? 128) / 128
      const scaleY = (def.scaleY ?? 128) / 128
      const scaleZ = (def.scaleZ ?? 128) / 128
      if (scaleX !== 1 || scaleY !== 1 || scaleZ !== 1) {
        matrix.multiply(new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ))
      }
      if (piece.rot !== 0) {
        matrix.multiply(new THREE.Matrix4().makeRotationY(-(piece.rot * Math.PI) / 2))
      }
      // rotation≥4 extras, applied BEFORE the 90° steps (the shift isn't
      // rotation-symmetric, so the order is load-bearing)
      if (piece.variant !== 'plain') {
        if (piece.variant === 'decor') {
          // `ia(180, 0, -180)` in RS model space — scene z is flipped
          matrix.multiply(new THREE.Matrix4().makeTranslation(180, 0, 180))
        }
        matrix.multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 4))
      }
      if (piece.mirror) {
        matrix.multiply(new THREE.Matrix4().makeScale(1, 1, -1))
      }

      for (const modelId of modelIds) {
        const model = await assets.getModel(modelId)
        if (!model) continue
        if (isMarkerModel(model)) {
          markerModels++
          if ((model.faceColor[0] & 0xffff) === BARRIER_HSL) markerIsBarrier = true
          continue
        }
        let m = model
        if (def.originalColors?.length || def.originalTextures?.length) {
          // applyRecolor mutates faceColor AND faceTextures — copy both so the
          // swap doesn't leak into the shared cached model (other locs reuse it).
          m = { ...model, faceColor: model.faceColor.slice(), faceTextures: model.faceTextures?.slice() ?? null }
          applyRecolor(m, def.originalColors ?? [], def.modifiedColors ?? [], def.originalTextures ?? [], def.modifiedTextures ?? [])
        }
        // Ground-contour ("hillskew"): deform the model to follow the terrain /
        // stretch up to the next plane (bridges, hillside floors, raised
        // buildings). The render matrix still applies its −avgHeight translate,
        // so the contoured vertexY stays tile-relative.
        const contourType = def.groundContourType ?? 0
        if (contourType !== 0) {
          const contoured = contourVertexY(
            m, contourType, def.groundContourModifier ?? 0,
            heights, heightsAll[decodedPlane + 1], sceneX + piece.offX, sceneY + piece.offZ, avgHeight,
            ...placedXZ(m, piece, def))
          // Keep the pre-contour vertexY: the client builds normals AND texture
          // coordinates once from the raw mesh and the contour never updates
          // either, so a run of identical pieces down a slope stays uniformly
          // lit and uniformly textured. See ModelData.preContourVertexY.
          if (contoured) m = { ...m, vertexY: contoured, preContourVertexY: m.vertexY }
        }
        if (isAnimated) {
          // keep out of the merged static mesh; the scene poses it per frame.
          // `getModel` has already baked the pre-13 <<2 in, which is what makes
          // posing correct (frame translations are authored in the upscaled
          // space); the call here is a no-op backstop for a raw 1x mesh.
          animated.push({
            model: upscaleModel(m),
            matrix: matrix.clone(),
            animationId: def.animations![0],
            owner: { objectId, shape, rotation, x, y, plane: decodedPlane },
            points,
            ambient: 64 + (def.ambient ?? 0),
            contrast: 850 + (def.contrast ?? 0) * 5,
          })
        } else {
          // resolve this model's texture blendTypes so addModel can split
          // opaque vs transparent faces synchronously
          await assets.primeBlendTypes(m)
          acc.addModel(m, matrix, locRefs.length,
            { sun: bakeSun, points, ambient: 64 + (def.ambient ?? 0), contrast: 850 + (def.contrast ?? 0) * 5 },
            (t) => assets.blendTypeOf(t), (t) => assets.hdrMultiplierOf(t), locTrans, (t) => assets.specularExponentOf(t), (t) => assets.shadeParamsOf(t))
        }
      }
    }
    // One mesh per transparent loc (the client's unit), recentred so its origin
    // IS the model centre — that makes three.js's frustum cull tight and its
    // per-object depth key exactly the client's (method3421 projects the centre).
    //
    // ...but only for locs big enough for ordering to be visible. Measured on
    // region 12850 plane 0: of 2073 transparent placements, 1560 sit in the
    // 21-100 face range (ground clutter — flowers, small bushes) and only ~195
    // exceed 100 faces, which is where the actual trees live (oak 738, willow
    // 670, mid trees 260-280). Giving every one its own mesh cost ~2000 draw
    // calls at 35fps; the clutter is small enough that a shared mesh's single
    // sort position is imperceptible, so it merges.
    //
    // The threshold is settled, not provisional: with it in place the scene
    // sits at ~575 draw calls fully zoomed out (signed off 2026-07-25), so the
    // per-loc meshes are comfortably affordable and there's no reason to
    // revisit the split. Note the readout that produced the old 2000/35fps
    // figure was itself under-reporting at the time — see the info.autoReset
    // fix in MapSceneViewer — so treat that number as indicative only.
    if (locTrans.faceCount() > TRANSPARENT_OWN_MESH_FACES) {
      const lm = await locTrans.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'transparent', transMaterials, THREE.FrontSide)
      if (lm) {
        lm.geometry.computeBoundingBox()
        const bb = lm.geometry.boundingBox
        if (bb) {
          const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2
          lm.geometry.translate(-cx, -cy, -cz)
          lm.position.set(cx, cy, cz)
        }
        lm.geometry.computeBoundingSphere()
        lm.userData.locs = locRefs
        lm.userData.locIndex = locRefs.length
        transparentLocs.push(lm)
      }
    } else if (locTrans.hasAny()) {
      sharedTrans.mergeFrom(locTrans)
    }
    locRefs.push({ objectId, shape, rotation, x, y, plane: decodedPlane })

    if (markerModels > 0) {
      const fallback = markerIsBarrier ? 'barrier' : 'other'
      const kind: MarkerInfo['kind'] = markerKindFromDef(def) ?? fallback
      markers.push({ x: sceneX, y: -avgHeight, z: -sceneY, objectId, kind, fallback, type: shape, tileX: x, tileY: y, plane: decodedPlane })
    }
  }
  // Opaque locs stay merged (order-independent). Transparent ones are the
  // per-loc meshes collected above, drawn after the ground.
  const mesh = await acc.buckets.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'opaque', undefined, THREE.FrontSide)
  if (mesh) mesh.userData.locs = locRefs
  if (sharedTrans.hasAny()) {
    const sm = await sharedTrans.toMesh((id) => assets.getTexture(id), (id) => assets.getMaterialMeta(id), true, 'transparent', transMaterials, THREE.FrontSide)
    if (sm) {
      sm.userData.locs = locRefs
      transparentLocs.push(sm)
    }
  }
  return { mesh, transparentLocs, markers, shadows, animated }
}
