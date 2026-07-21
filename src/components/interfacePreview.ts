import * as THREE from 'three'
import type { IComponentDefinition } from '../loaders/interfaces'
import type { SpriteMeta } from '../loaders/sprites'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import { loadSpriteMeta, renderFrame } from './spriteRender'

// Faithful 2D preview of an interface, ported from the darkan-game-client
// draw path (IComponentDefinitions.render + FontRenderer.method373/371 +
// Class484/Class246 layout). Sprites come from sprites/<id>, text is drawn
// with the real cache fonts (glyph bitmaps are the 256 frames of the font's
// sprite archive, advances/line metrics from fonts/metrics/<id>.json), and
// RAW_MODEL components render through an offscreen Three.js pass that
// replicates the client's model matrix (yaw/roll/translate/pitch, 2048-unit
// angles, spriteScale zoom at 512 focal length).

export type LayoutRect = { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------
// Layout — absolute screen rects (client lays out per-parent, children resolve
// against the container's scrollWidth/Height when set: Class480.method8044)
// ---------------------------------------------------------------------------

function resolveSize(c: IComponentDefinition, parentW: number, parentH: number): { width: number; height: number } {
  let width = c.baseWidth
  let height = c.baseHeight
  if (c.aspectWidthType === 1) width = parentW - c.baseWidth
  else if (c.aspectWidthType === 2) width = (c.baseWidth * parentW) >> 14
  if (c.aspectHeightType === 1) height = parentH - c.baseHeight
  else if (c.aspectHeightType === 2) height = (parentH * c.baseHeight) >> 14
  if (c.aspectWidthType === 4) width = Math.floor((c.aspectWidth * height) / c.aspectHeight)
  if (c.aspectHeightType === 4) height = Math.floor((width * c.aspectHeight) / c.aspectWidth)
  return { width, height }
}

function resolvePosition(c: IComponentDefinition, parentW: number, parentH: number, width: number, height: number): { x: number; y: number } {
  let x: number
  switch (c.aspectXType) {
    case 0: x = c.basePositionX; break
    case 1: x = c.basePositionX + ((parentW - width) >> 1); break
    case 2: x = parentW - width - c.basePositionX; break
    case 3: x = (c.basePositionX * parentW) >> 14; break
    case 4: x = ((parentW - width) >> 1) + ((c.basePositionX * parentW) >> 14); break
    default: x = parentW - width - ((c.basePositionX * parentW) >> 14)
  }
  let y: number
  switch (c.aspectYType) {
    case 0: y = c.basePositionY; break
    case 1: y = ((parentH - height) >> 1) + c.basePositionY; break
    case 2: y = parentH - height - c.basePositionY; break
    case 3: y = (parentH * c.basePositionY) >> 14; break
    case 4: y = ((parentH - height) >> 1) + ((parentH * c.basePositionY) >> 14); break
    default: y = parentH - height - ((parentH * c.basePositionY) >> 14)
  }
  return { x, y }
}

/** Children of each parent id, in components-array order (the client's sibling draw order). */
export function childrenByParent(components: (IComponentDefinition | null)[]): Map<number, IComponentDefinition[]> {
  const byParent = new Map<number, IComponentDefinition[]>()
  for (const c of components) {
    if (!c) continue
    const parentId = c.parent === -1 ? -1 : c.parent & 0xffff
    let arr = byParent.get(parentId)
    if (!arr) byParent.set(parentId, (arr = []))
    arr.push(c)
  }
  return byParent
}

/** Absolute screen rect per componentId for a given root viewport. */
export function resolveAbsoluteLayout(
  components: (IComponentDefinition | null)[],
  viewportWidth = 765,
  viewportHeight = 503,
): Map<number, LayoutRect> {
  const rects = new Map<number, LayoutRect>()
  const byParent = childrenByParent(components)

  function walk(parentId: number, originX: number, originY: number, basisW: number, basisH: number, depth: number) {
    if (depth > 32) return // cyclic parent guard
    const children = byParent.get(parentId)
    if (!children) return
    for (const c of children) {
      const { width, height } = resolveSize(c, basisW, basisH)
      const { x, y } = resolvePosition(c, basisW, basisH, width, height)
      rects.set(c.componentId, { x: originX + x, y: originY + y, width, height })
      if (c.type === 'CONTAINER') {
        walk(
          c.componentId,
          originX + x,
          originY + y,
          c.scrollWidth !== 0 ? c.scrollWidth : width,
          c.scrollHeight !== 0 ? c.scrollHeight : height,
          depth + 1,
        )
      }
    }
  }

  walk(-1, 0, 0, viewportWidth, viewportHeight, 0)
  return rects
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type FontMetricsJson = {
  id: number
  glyphWidths: number[] // signed bytes — mask with 0xff
  verticalSpacing: number
  topPadding: number
  bottomPadding: number
}

export type CacheFont = {
  metrics: FontMetricsJson
  glyphMeta: SpriteMeta
  glyphs: (HTMLCanvasElement | null | undefined)[] // lazily rendered, undefined = not tried yet
}

function fontGlyph(font: CacheFont, code: number): HTMLCanvasElement | null {
  let g = font.glyphs[code]
  if (g === undefined) {
    const canvas = document.createElement('canvas')
    renderFrame(canvas, font.glyphMeta, code)
    const empty = (font.glyphMeta.subWidths[code] ?? 0) <= 0 || (font.glyphMeta.subHeights[code] ?? 0) <= 0
    g = empty ? null : canvas
    font.glyphs[code] = g
  }
  return g ?? null
}

function advanceOf(font: CacheFont, code: number): number {
  return (font.metrics.glyphWidths[code] ?? 0) & 0xff
}

// Windows-1252 mapping for the 0x80-0x9F range (the client's getByteForChar);
// everything else <= 0xFF maps straight through.
const CP1252: Record<number, number> = {
  0x20ac: 128, 0x201a: 130, 0x192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135,
  0x2c6: 136, 0x2030: 137, 0x160: 138, 0x2039: 139, 0x152: 140, 0x17d: 142, 0x2018: 145,
  0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2dc: 152,
  0x2122: 153, 0x161: 154, 0x203a: 155, 0x153: 156, 0x17e: 158, 0x178: 159,
}

function byteForChar(ch: number): number {
  if (ch < 256) return ch
  return CP1252[ch] ?? 63 // '?'
}

// One text "token" after tag parsing: a drawable character, or a colour change.
type TextToken = { ch: number } | { color: number | null } // color null = reset to base

const ENTITIES: Record<string, number> = {
  lt: 60, gt: 62, nbsp: 160, shy: 173, times: 215, euro: 8364, copy: 169, reg: 174,
}

/** Client tag handling (FontRenderer.method371/369): entities, <col=>, </col>, unknown tags stripped. */
function tokenizeLine(line: string): TextToken[] {
  const tokens: TextToken[] = []
  let i = 0
  while (i < line.length) {
    const ch = line.charCodeAt(i)
    if (ch === 60) {
      const close = line.indexOf('>', i + 1)
      if (close === -1) { i++; continue }
      const tag = line.slice(i + 1, close)
      i = close + 1
      const entity = ENTITIES[tag]
      if (entity !== undefined) {
        tokens.push({ ch: byteForChar(entity) })
      } else if (tag.startsWith('col=')) {
        const rgb = parseInt(tag.slice(4), 16)
        if (!isNaN(rgb)) tokens.push({ color: rgb & 0xffffff })
      } else if (tag === '/col') {
        tokens.push({ color: null })
      }
      // <img=n>, <str>, <u>, unknown → stripped (client draws mod icons here; out of scope)
      continue
    }
    tokens.push({ ch: byteForChar(ch) })
    i++
  }
  return tokens
}

function tokensWidth(font: CacheFont, tokens: TextToken[]): number {
  let w = 0
  for (const t of tokens) if ('ch' in t) w += advanceOf(font, t.ch)
  return w
}

/** Word wrap one <br>-free segment to maxWidth, splitting on spaces (client method6987). */
function wrapTokens(font: CacheFont, tokens: TextToken[], maxWidth: number): TextToken[][] {
  if (maxWidth <= 0) return [tokens]
  const lines: TextToken[][] = []
  let line: TextToken[] = []
  let lineW = 0
  let lastSpace = -1 // index in `line` of the last space
  for (const t of tokens) {
    line.push(t)
    if (!('ch' in t)) continue
    if (t.ch === 32) lastSpace = line.length - 1
    lineW += advanceOf(font, t.ch)
    if (lineW > maxWidth && line.length > 1) {
      if (lastSpace >= 0) {
        const rest = line.slice(lastSpace + 1)
        line.length = lastSpace // drop the space too
        lines.push(line)
        line = rest
      } else {
        const overflow = line.pop()!
        lines.push(line)
        line = [overflow]
      }
      lineW = tokensWidth(font, line)
      lastSpace = -1
    }
  }
  lines.push(line)
  return lines
}

// ---------------------------------------------------------------------------
// Asset cache + model rendering
// ---------------------------------------------------------------------------

type SpriteAsset = { meta: SpriteMeta; canvas: HTMLCanvasElement } | null

export class InterfaceAssets {
  private root: FileSystemDirectoryHandle
  private sprites = new Map<number, Promise<SpriteAsset>>()
  private fonts = new Map<number, Promise<CacheFont | null>>()
  private models = new Map<number, Promise<ModelData | null>>()
  private modelRenders = new Map<string, Promise<HTMLCanvasElement | null>>()
  private threeRenderer: THREE.WebGLRenderer | null = null

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  dispose() {
    this.threeRenderer?.dispose()
    this.threeRenderer = null
  }

  getSprite(id: number): Promise<SpriteAsset> {
    let p = this.sprites.get(id)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(this.root, getEntryPath('sprites'))
          if (!dir) return null
          const meta = await loadSpriteMeta(dir, id)
          if (!meta || meta.width <= 0 || meta.height <= 0) return null
          const canvas = document.createElement('canvas')
          renderFrame(canvas, meta, 0)
          return { meta, canvas }
        } catch {
          return null
        }
      })()
      this.sprites.set(id, p)
    }
    return p
  }

  getFont(id: number): Promise<CacheFont | null> {
    let p = this.fonts.get(id)
    if (!p) {
      p = (async () => {
        try {
          const [spritesDir, metricsDir] = await Promise.all([
            resolveEntryHandle(this.root, getEntryPath('sprites')),
            resolveEntryHandle(this.root, getEntryPath('font_metrics')),
          ])
          if (!spritesDir || !metricsDir) return null
          const glyphMeta = await loadSpriteMeta(spritesDir, id)
          if (!glyphMeta) return null
          const metricsFile = await (await metricsDir.getFileHandle(`${id}.json`)).getFile()
          const metrics = JSON.parse(await metricsFile.text()) as FontMetricsJson
          if (!metrics.glyphWidths) return null
          return { metrics, glyphMeta, glyphs: new Array(256).fill(undefined) }
        } catch {
          return null
        }
      })()
      this.fonts.set(id, p)
    }
    return p
  }

  /** Seed a prebuilt model under a synthetic id — the chathead preview
   *  merges an NPC's head models and needs the composite to flow through
   *  the normal MODEL-component render path. */
  primeModel(id: number, model: ModelData): void {
    this.models.set(id, Promise.resolve(model))
  }

  getModel(id: number): Promise<ModelData | null> {
    let p = this.models.get(id)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(this.root, getEntryPath('models'))
          const loader = getLoader('models')
          if (!dir || !loader) return null
          return (await loader.loadItem(dir, { id, name: `${id}` }, this.root)) as ModelData
        } catch {
          return null
        }
      })()
      this.models.set(id, p)
    }
    return p
  }

  /** Offscreen render of a RAW_MODEL component. The canvas covers the CLIP
   *  rect (models overflow their component rect in the client — only the
   *  parent container clips them), with the projection centred on the
   *  component rect's centre plus the origin shift. */
  getModelRender(c: IComponentDefinition, rect: LayoutRect, clip: LayoutRect): Promise<HTMLCanvasElement | null> {
    const key = [
      c.modelId, rect.x - clip.x, rect.y - clip.y, rect.width, rect.height, clip.width, clip.height,
      c.spritePitch, c.spriteRoll, c.spriteYaw, c.spriteScale,
      c.hasOrigin ? 1 : 0, c.usesOrthogonal ? 1 : 0, c.originX, c.originY, c.originZ,
      c.aspectWidth, c.aspectHeight,
    ].join('|')
    let p = this.modelRenders.get(key)
    if (!p) {
      p = (async () => {
        const model = await this.getModel(c.modelId)
        if (!model || rect.width <= 0 || rect.height <= 0 || clip.width <= 0 || clip.height <= 0) return null
        try {
          return this.renderModel(model, c, rect, clip)
        } catch {
          return null
        }
      })()
      this.modelRenders.set(key, p)
    }
    return p
  }

  /** One-shot uncached render of a prebuilt model through the MODEL
   *  component projection — the chathead preview re-renders each posed
   *  animation frame this way. */
  renderModelFrame(model: ModelData, c: IComponentDefinition, rect: LayoutRect, clip: LayoutRect): HTMLCanvasElement | null {
    try {
      return this.renderModel(model, c, rect, clip)
    } catch {
      return null
    }
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (!this.threeRenderer) {
      this.threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      this.threeRenderer.setPixelRatio(1)
    }
    return this.threeRenderer
  }

  // Client model-component path (IComponentDefinitions.render MODEL branch):
  // matrix = Rz(-yaw<<3) · Ry(roll<<3) · translate · Rx(pitch<<3) applied to
  // row vectors (angles in 2048ths of a turn when !hasOrigin, plain degrees
  // when hasOrigin), then a 512-focal perspective with per-axis pixel scale
  // (width<<9)/aspectWidth. Three.js uses column vectors and (x,−y,−z) space,
  // so axes conjugate: yaw keeps sign flipped back, roll negates.
  private renderModel(model: ModelData, c: IComponentDefinition, rect: LayoutRect, clip: LayoutRect): HTMLCanvasElement | null {
    const width = Math.round(clip.width)
    const height = Math.round(clip.height)
    const renderer = this.ensureRenderer()
    renderer.setSize(width, height)
    renderer.setClearColor(0x000000, 0)

    const scene = new THREE.Scene()
    const geo = buildModelGeometry(model)
    if (!geo) return null

    // focal lengths derive from the COMPONENT size (client i_24/i_25)
    const fx = c.aspectWidth > 0 ? Math.floor((rect.width << 9) / c.aspectWidth) : 512
    const fy = c.aspectHeight > 0 ? Math.floor((rect.height << 9) / c.aspectHeight) : 512

    const m = new THREE.Matrix4()
    if (c.hasOrigin) {
      // degrees; translate(origin) last
      const pitch = THREE.MathUtils.degToRad(c.spritePitch)
      const roll = THREE.MathUtils.degToRad(c.spriteRoll)
      const yaw = THREE.MathUtils.degToRad(c.spriteYaw)
      m.makeRotationX(pitch)
      m.premultiply(new THREE.Matrix4().makeRotationY(-roll))
      m.premultiply(new THREE.Matrix4().makeRotationZ(-yaw))
      m.premultiply(new THREE.Matrix4().makeTranslation(c.originX, -c.originY, -c.originZ))
    } else {
      // 2048ths of a turn; zoom-translate between roll and pitch. The client's
      // offsetX/offsetY in this translate are runtime-only (CS2/item hooks),
      // 0 for a cache-defined component; the decoded originX/originY are the
      // screen-centre shift applied to the projection instead.
      const toRad = (v: number) => (v * Math.PI) / 1024
      const pitch = toRad(c.spritePitch)
      const roll = toRad(c.spriteRoll)
      const yaw = toRad(c.spriteYaw)
      const zoom = c.spriteScale << 2
      const ty = Math.sin(pitch) * zoom
      const tz = Math.cos(pitch) * zoom
      m.makeRotationZ(yaw) // RS Rz(-yaw) → three Rz(+yaw)
      m.premultiply(new THREE.Matrix4().makeRotationY(-roll))
      m.premultiply(new THREE.Matrix4().makeTranslation(0, -ty, -tz))
      m.premultiply(new THREE.Matrix4().makeRotationX(pitch))
    }
    // Baking the transform into the geometry sidesteps Object3D matrix
    // propagation entirely — the render is one-shot, so there's no reuse cost.
    geo.geometry.applyMatrix4(m)
    const mesh = new THREE.Mesh(geo.geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    mesh.frustumCulled = false
    scene.add(mesh)

    // Projection centre in canvas px: component centre (canvas covers the clip
    // rect) plus the client's origin shift of (fx*originX>>9, fy*originY>>9).
    let centerX = rect.x - clip.x + rect.width / 2
    let centerY = rect.y - clip.y + rect.height / 2
    if (!c.hasOrigin) {
      centerX += (fx * c.originX) >> 9
      centerY += (fy * c.originY) >> 9
    }
    const offX = centerX - width / 2
    const offY = centerY - height / 2

    let camera: THREE.Camera
    if (c.usesOrthogonal) {
      const zoom = (c.spriteScale << 2) || 512
      const halfW = ((width / 2) * zoom) / fx
      const halfH = ((height / 2) * zoom) / fy
      const ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -100000, 100000)
      if (offX !== 0 || offY !== 0) ortho.setViewOffset(width, height, -offX, -offY, width, height)
      camera = ortho
    } else {
      const persp = new THREE.PerspectiveCamera(
        THREE.MathUtils.radToDeg(2 * Math.atan(height / 2 / fy)),
        (width * fy) / (height * fx),
        8, 100000,
      )
      if (offX !== 0 || offY !== 0) persp.setViewOffset(width, height, -offX, -offY, width, height)
      camera = persp
    }

    renderer.render(scene, camera)

    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    out.getContext('2d')!.drawImage(renderer.domElement, 0, 0)

    geo.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    return out
  }
}

function buildModelGeometry(model: ModelData): { geometry: THREE.BufferGeometry } | null {
  const { vertexCount, faceCount, vertexX, vertexY, vertexZ, triangleX, triangleY, triangleZ, faceColor, faceAlpha } = model
  // Pre-v13 meshes are stored at 1× and upscaled <<2 by the client before
  // rendering (RSMesh.upscale) — without this they draw at quarter size.
  const upscale = model.version < 13 ? 4 : 1
  const faces: number[] = []
  for (let f = 0; f < faceCount; f++) {
    if (faceAlpha[f] === -1) continue // fully transparent
    const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
    if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue
    faces.push(f)
  }
  if (faces.length === 0) return null

  // The palette RGB is a display (sRGB) value, but three's renderer works in
  // linear space and gamma-encodes on output — fed in raw, vertex colours get
  // double-encoded and wash out to near-white (same trap ModelViewer notes).
  const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

  // Client vertex-lit shading (same math as ModelViewer's icon-lighting path,
  // at the default ambient/contrast an interface model gets): base lightness
  // halved (ambient 64/128), each corner modulated by 1 + cos against the
  // (−50, −10, −50) light using smooth vertex normals. Flat unlit colours
  // made chatheads look like paper cutouts — no hair highlights, no depth.
  const normSumX = new Float32Array(vertexCount)
  const normSumY = new Float32Array(vertexCount)
  const normSumZ = new Float32Array(vertexCount)
  const normCount = new Uint16Array(vertexCount)
  for (const f of faces) {
    if (model.faceType && model.faceType[f] === 2) continue
    const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
    const e1x = vertexX[ib] - vertexX[ia], e1y = vertexY[ib] - vertexY[ia], e1z = vertexZ[ib] - vertexZ[ia]
    const e2x = vertexX[ic] - vertexX[ia], e2y = vertexY[ic] - vertexY[ia], e2z = vertexZ[ic] - vertexZ[ia]
    const nx = e1y * e2z - e2y * e1z
    const ny = e1z * e2x - e2z * e1x
    const nz = e1x * e2y - e2x * e1y
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len === 0) continue
    for (const v of [ia, ib, ic]) {
      normSumX[v] += nx / len
      normSumY[v] += ny / len
      normSumZ[v] += nz / len
      normCount[v]++
    }
  }
  const LIGHT_LEN = Math.sqrt(50 * 50 + 10 * 10 + 50 * 50)
  const LX = -50 / LIGHT_LEN, LY = -10 / LIGHT_LEN, LZ = -50 / LIGHT_LEN
  const litHsl = (hsl: number) => {
    let lum = ((hsl & 0x7f) * 64) >> 7
    if (lum < 2) lum = 2
    else if (lum > 126) lum = 126
    return (hsl & 0xff80) + lum
  }

  const positions = new Float32Array(faces.length * 9)
  const colors = new Float32Array(faces.length * 9)
  let vert = 0
  for (const f of faces) {
    const idx = [triangleX[f], triangleY[f], triangleZ[f]]
    const rgb = hslToRgb(litHsl(faceColor[f] & 0xffff))
    const br = (rgb >> 16) & 0xff
    const bg = (rgb >> 8) & 0xff
    const bb = rgb & 0xff
    for (let i = 0; i < 3; i++) {
      const v = idx[i]
      const base = (vert + i) * 3
      // RS → three: (x, −y, −z)
      positions[base] = vertexX[v] * upscale
      positions[base + 1] = -vertexY[v] * upscale
      positions[base + 2] = -vertexZ[v] * upscale
      const n = normCount[v]
      const cos = n > 0 ? (LX * normSumX[v] + LY * normSumY[v] + LZ * normSumZ[v]) / n : 0
      const f30 = 1 + cos
      colors[base] = srgbToLinear(Math.min(Math.max((br * f30) / 255, 0), 1))
      colors[base + 1] = srgbToLinear(Math.min(Math.max((bg * f30) / 255, 0), 1))
      colors[base + 2] = srgbToLinear(Math.min(Math.max((bb * f30) / 255, 0), 1))
    }
    vert += 3
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return { geometry }
}

// ---------------------------------------------------------------------------
// Painter
// ---------------------------------------------------------------------------

export type PreviewOptions = {
  showHidden: boolean
  showContainerOutlines: boolean
}

type ResolvedAssets = {
  sprites: Map<number, SpriteAsset>
  fonts: Map<number, CacheFont | null>
  modelRenders: Map<number, HTMLCanvasElement | null> // componentId → render (at clip-rect size)
  clips: Map<number, LayoutRect> // componentId → effective clip rect
}

/** Effective clip rect per component: its parent chain's intersected bounds. */
function computeClipRects(
  components: (IComponentDefinition | null)[],
  layout: Map<number, LayoutRect>,
  viewportW: number,
  viewportH: number,
): Map<number, LayoutRect> {
  const clips = new Map<number, LayoutRect>()
  const byParent = childrenByParent(components)

  function walk(parentId: number, clip: LayoutRect, depth: number) {
    if (depth > 32) return
    for (const c of byParent.get(parentId) ?? []) {
      const rect = layout.get(c.componentId)
      if (!rect) continue
      clips.set(c.componentId, clip)
      if (c.type === 'CONTAINER') {
        const left = Math.max(rect.x, clip.x)
        const top = Math.max(rect.y, clip.y)
        const right = Math.min(rect.x + rect.width, clip.x + clip.width)
        const bottom = Math.min(rect.y + rect.height, clip.y + clip.height)
        walk(c.componentId, { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, depth + 1)
      }
    }
  }

  walk(-1, { x: 0, y: 0, width: viewportW, height: viewportH }, 0)
  return clips
}

/** Everything the paint pass needs, fetched up front so painting is synchronous. */
export async function loadPreviewAssets(
  assets: InterfaceAssets,
  components: (IComponentDefinition | null)[],
  layout: Map<number, LayoutRect>,
  viewportW: number,
  viewportH: number,
  opts: PreviewOptions,
): Promise<ResolvedAssets> {
  const spriteIds = new Set<number>()
  const fontIds = new Set<number>()
  const modelComps: IComponentDefinition[] = []
  for (const c of components) {
    if (!c || (c.hidden && !opts.showHidden)) continue
    if (c.type === 'SPRITE' && c.spriteId >= 0) spriteIds.add(c.spriteId)
    if (c.type === 'TEXT' && c.fontId >= 0) fontIds.add(c.fontId)
    if (c.type === 'MODEL' && c.modelType === 'RAW_MODEL' && c.modelId >= 0) modelComps.push(c)
  }

  const clips = computeClipRects(components, layout, viewportW, viewportH)
  const sprites = new Map<number, SpriteAsset>()
  const fonts = new Map<number, CacheFont | null>()
  const modelRenders = new Map<number, HTMLCanvasElement | null>()
  await Promise.all([
    ...[...spriteIds].map(async (id) => sprites.set(id, await assets.getSprite(id))),
    ...[...fontIds].map(async (id) => fonts.set(id, await assets.getFont(id))),
    ...modelComps.map(async (c) => {
      const rect = layout.get(c.componentId)
      const clip = clips.get(c.componentId)
      if (!rect || !clip) return
      modelRenders.set(c.componentId, await assets.getModelRender(c, rect, clip))
    }),
  ])
  return { sprites, fonts, modelRenders, clips }
}

function cssRgb(rgb: number, alpha = 1): string {
  return `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, ${alpha})`
}

// Multiply-tint a sprite canvas by an RGB colour, preserving alpha.
function tintCanvas(src: HTMLCanvasElement, rgb: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(src, 0, 0)
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = cssRgb(rgb)
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(src, 0, 0)
  return out
}

const glyphTintCache = new Map<string, HTMLCanvasElement>()

function tintedGlyph(font: CacheFont, fontId: number, code: number, rgb: number): HTMLCanvasElement | null {
  const glyph = fontGlyph(font, code)
  if (!glyph) return null
  if ((rgb & 0xffffff) === 0xffffff) return glyph
  const key = `${fontId}|${code}|${rgb & 0xffffff}`
  let tinted = glyphTintCache.get(key)
  if (!tinted) {
    tinted = tintCanvas(glyph, rgb)
    if (glyphTintCache.size > 4096) glyphTintCache.clear()
    glyphTintCache.set(key, tinted)
  }
  return tinted
}

// ---------------------------------------------------------------------------
// Standalone cache-font text API (the NPC right-click menu preview draws with
// the real b12 glyphs instead of a browser font).
// ---------------------------------------------------------------------------

const standaloneFonts = new Map<number, Promise<CacheFont | null>>()

/** Load a sprite font + metrics outside an InterfaceAssets instance
 *  (session-cached per font id). */
export function loadCacheFont(root: FileSystemDirectoryHandle, fontId: number): Promise<CacheFont | null> {
  let p = standaloneFonts.get(fontId)
  if (!p) {
    p = (async (): Promise<CacheFont | null> => {
      try {
        const [spritesDir, metricsDir] = await Promise.all([
          resolveEntryHandle(root, getEntryPath('sprites')),
          resolveEntryHandle(root, getEntryPath('font_metrics')),
        ])
        if (!spritesDir || !metricsDir) return null
        const glyphMeta = await loadSpriteMeta(spritesDir, fontId)
        if (!glyphMeta) return null
        const metricsFile = await (await metricsDir.getFileHandle(`${fontId}.json`)).getFile()
        const metrics = JSON.parse(await metricsFile.text()) as FontMetricsJson
        if (!metrics.glyphWidths) return null
        return { metrics, glyphMeta, glyphs: new Array(256).fill(undefined) }
      } catch {
        return null
      }
    })()
    standaloneFonts.set(fontId, p)
  }
  return p
}

/** Tag-aware pixel width of one line (entities and <col=> handled). */
export function measureCacheText(font: CacheFont, text: string): number {
  return tokensWidth(font, tokenizeLine(text))
}

/** Draw one tag-aware line. `lineY` uses the client's renderPlain anchor
 *  (glyph tops sit at lineY − verticalSpacing, like drawTextComponent). */
export function drawCacheText(
  ctx: CanvasRenderingContext2D,
  font: CacheFont,
  fontId: number,
  text: string,
  x: number,
  lineY: number,
  baseColor: number,
  shadow: boolean,
): void {
  const glyphY = lineY - font.metrics.verticalSpacing
  let penX = x
  let color = baseColor & 0xffffff
  for (const t of tokenizeLine(text)) {
    if ('color' in t) {
      color = t.color ?? (baseColor & 0xffffff)
      continue
    }
    if (t.ch !== 32) {
      if (shadow) {
        const shadowGlyph = tintedGlyph(font, fontId, t.ch, 0)
        if (shadowGlyph) ctx.drawImage(shadowGlyph, penX + 1, glyphY + 1)
      }
      const glyph = tintedGlyph(font, fontId, t.ch, color)
      if (glyph) ctx.drawImage(glyph, penX, glyphY)
    }
    penX += advanceOf(font, t.ch)
  }
}

function drawTextComponent(
  ctx: CanvasRenderingContext2D,
  c: IComponentDefinition,
  rect: LayoutRect,
  font: CacheFont,
  fontId: number,
) {
  const text = c.text
  if (!text) return
  const { metrics } = font
  let lineHeight = c.lineSpacing !== 0 ? c.lineSpacing : metrics.verticalSpacing

  // Wrap: <br> splits always; word wrap only when the box fits 2+ lines (client method373).
  const canWrap = rect.height >= lineHeight + metrics.topPadding + metrics.bottomPadding || rect.height >= lineHeight * 2
  let lines: TextToken[][] = []
  for (const seg of text.split(/<br>/i)) {
    const tokens = tokenizeLine(seg)
    if (canWrap) lines.push(...wrapTokens(font, tokens, rect.width))
    else lines.push(tokens)
  }

  let maxLines = c.maxTextLines
  if (maxLines === -1) maxLines = Math.max(1, Math.floor(rect.height / lineHeight))
  if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(0, maxLines)

  let vAlign = c.textVerticalAli
  if (vAlign === 3 && lines.length === 1) vAlign = 1
  let lineY: number
  if (vAlign === 0) {
    lineY = rect.y + metrics.topPadding
  } else if (vAlign === 1) {
    lineY = rect.y + metrics.topPadding + Math.floor((rect.height - metrics.topPadding - metrics.bottomPadding - lineHeight * (lines.length - 1)) / 2)
  } else if (vAlign === 2) {
    lineY = rect.y + rect.height - metrics.bottomPadding - lineHeight * (lines.length - 1)
  } else {
    const gap = Math.max(0, Math.floor((rect.height - metrics.topPadding - metrics.bottomPadding - lineHeight * (lines.length - 1)) / (lines.length + 1)))
    lineY = rect.y + metrics.topPadding + gap
    lineHeight += gap
  }

  const alpha = (255 - (c.transparency & 0xff)) / 255
  const baseColor = c.color & 0xffffff
  ctx.save()
  ctx.globalAlpha *= alpha

  for (const line of lines) {
    let penX: number
    const lineW = tokensWidth(font, line)
    if (c.textHorizontalAli === 1) penX = rect.x + Math.floor((rect.width - lineW) / 2)
    else if (c.textHorizontalAli === 2) penX = rect.x + rect.width - lineW
    else penX = rect.x

    // glyph canvas top sits at lineY − verticalSpacing (FontRenderer.method371)
    const glyphY = lineY - metrics.verticalSpacing
    let color = baseColor
    for (const t of line) {
      if ('color' in t) {
        color = t.color ?? baseColor
        continue
      }
      if (t.ch !== 32) {
        if (c.shadow) {
          const shadowGlyph = tintedGlyph(font, fontId, t.ch, 0)
          if (shadowGlyph) ctx.drawImage(shadowGlyph, penX + 1, glyphY + 1)
        }
        const glyph = tintedGlyph(font, fontId, t.ch, color)
        if (glyph) ctx.drawImage(glyph, penX, glyphY)
      }
      penX += advanceOf(font, t.ch)
    }
    lineY += lineHeight
  }
  ctx.restore()
}

function drawSpriteComponent(
  ctx: CanvasRenderingContext2D,
  c: IComponentDefinition,
  rect: LayoutRect,
  sprite: SpriteAsset,
) {
  if (!sprite) {
    // missing sprite id — subtle placeholder so the slot is visible
    if (c.spriteId >= 0) {
      ctx.save()
      ctx.fillStyle = 'rgba(120, 120, 140, 0.15)'
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      ctx.restore()
    }
    return
  }
  let img: HTMLCanvasElement = sprite.canvas
  if (c.color !== 0) img = tintCanvas(img, c.color & 0xffffff)
  if (c.flipHorizontal || c.flipVertical) {
    const flipped = document.createElement('canvas')
    flipped.width = img.width
    flipped.height = img.height
    const fctx = flipped.getContext('2d')!
    fctx.translate(c.flipHorizontal ? img.width : 0, c.flipVertical ? img.height : 0)
    fctx.scale(c.flipHorizontal ? -1 : 1, c.flipVertical ? -1 : 1)
    fctx.drawImage(img, 0, 0)
    img = flipped
  }

  ctx.save()
  ctx.globalAlpha *= (255 - (c.transparency & 0xff)) / 255
  ctx.imageSmoothingEnabled = false

  if (c.tiling) {
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const pattern = ctx.createPattern(img, 'repeat')!
    ctx.translate(rect.x, rect.y)
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, rect.width, rect.height)
  } else if (c.angle2d !== 0) {
    // rotation about the rect centre, uniform scale from width (client method2758)
    const scale = rect.width / img.width
    ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2)
    ctx.rotate((c.angle2d * 2 * Math.PI) / 16384)
    ctx.scale(scale, scale)
    ctx.drawImage(img, -img.width / 2, -img.height / 2)
  } else if (img.width === rect.width && img.height === rect.height) {
    ctx.drawImage(img, rect.x, rect.y)
  } else {
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height)
  }
  ctx.restore()
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, rect: LayoutRect, label: string, hue: number) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()
  ctx.fillStyle = `hsla(${hue}, 60%, 50%, 0.10)`
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.strokeStyle = `hsla(${hue}, 70%, 60%, 0.45)`
  ctx.setLineDash([4, 3])
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)
  if (rect.width > 30 && rect.height > 11) {
    ctx.fillStyle = `hsla(${hue}, 70%, 70%, 0.9)`
    ctx.font = '9px system-ui'
    ctx.textBaseline = 'top'
    ctx.fillText(label, rect.x + 3, rect.y + 2, rect.width - 6)
  }
  ctx.restore()
}

/** Paint one interface. Assets must be pre-loaded (loadPreviewAssets). */
export function paintInterface(
  ctx: CanvasRenderingContext2D,
  components: (IComponentDefinition | null)[],
  layout: Map<number, LayoutRect>,
  resolved: ResolvedAssets,
  viewportW: number,
  viewportH: number,
  opts: PreviewOptions,
) {
  const byParent = childrenByParent(components)

  function paintChildren(parentId: number, clip: LayoutRect, depth: number) {
    if (depth > 32) return
    const children = byParent.get(parentId)
    if (!children) return
    for (const c of children) {
      if (c.hidden && !opts.showHidden) continue
      const rect = layout.get(c.componentId)
      if (!rect) continue
      // client: bounds = intersection with parent clip; skip when empty
      const left = Math.max(rect.x, clip.x)
      const top = Math.max(rect.y, clip.y)
      const right = Math.min(rect.x + rect.width + (c.type === 'LINE' ? 1 : 0), clip.x + clip.width)
      const bottom = Math.min(rect.y + rect.height + (c.type === 'LINE' ? 1 : 0), clip.y + clip.height)
      if (left >= right || top >= bottom) continue
      const childClip: LayoutRect = { x: left, y: top, width: right - left, height: bottom - top }

      ctx.save()
      ctx.beginPath()
      // The client only scissors draws to the PARENT container's bounds — a
      // component's own rect never clips its content (text overruns its box,
      // models overflow their rect). The rect ∩ parent intersection is only
      // the skip test above; tiling sprites self-clip in drawSpriteComponent.
      ctx.rect(clip.x, clip.y, clip.width, clip.height)
      ctx.clip()
      if (c.hidden) ctx.globalAlpha *= 0.35 // showHidden mode: ghost them

      if (c.contentType !== 0) {
        drawPlaceholder(ctx, rect, `content ${c.contentType}`, 275)
      } else {
        switch (c.type) {
          case 'FIGURE': {
            const alpha = (255 - (c.transparency & 0xff)) / 255
            if (c.filled) {
              ctx.fillStyle = cssRgb(c.color, alpha)
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
            } else {
              ctx.strokeStyle = cssRgb(c.color, alpha)
              ctx.lineWidth = 1
              ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)
            }
            break
          }
          case 'TEXT': {
            const font = resolved.fonts.get(c.fontId)
            if (font) drawTextComponent(ctx, c, rect, font, c.fontId)
            break
          }
          case 'SPRITE':
            drawSpriteComponent(ctx, c, rect, resolved.sprites.get(c.spriteId) ?? null)
            break
          case 'MODEL': {
            if (c.modelType === 'RAW_MODEL' && c.modelId >= 0) {
              const render = resolved.modelRenders.get(c.componentId)
              const modelClip = resolved.clips.get(c.componentId)
              // render canvas covers the whole parent clip (models overflow
              // their own rect in the client)
              if (render && modelClip) ctx.drawImage(render, modelClip.x, modelClip.y)
              else drawPlaceholder(ctx, rect, `model ${c.modelId}`, 210)
            } else if (c.modelType !== 'NONE') {
              drawPlaceholder(ctx, rect, `${c.modelType.toLowerCase()} ${c.modelId}`, 210)
            }
            break
          }
          case 'LINE': {
            ctx.strokeStyle = cssRgb(c.color)
            ctx.lineWidth = Math.max(1, c.lineWidth)
            ctx.beginPath()
            if (c.lineDirection) {
              ctx.moveTo(rect.x, rect.y + rect.height)
              ctx.lineTo(rect.x + rect.width, rect.y)
            } else {
              ctx.moveTo(rect.x, rect.y)
              ctx.lineTo(rect.x + rect.width, rect.y + rect.height)
            }
            ctx.stroke()
            break
          }
          case 'CONTAINER':
            if (opts.showContainerOutlines) {
              ctx.strokeStyle = 'rgba(255,255,255,0.07)'
              ctx.lineWidth = 1
              ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)
            }
            break
          default:
            break
        }
      }

      if (c.type === 'CONTAINER') paintChildren(c.componentId, childClip, depth + 1)
      ctx.restore()
    }
  }

  paintChildren(-1, { x: 0, y: 0, width: viewportW, height: viewportH }, 0)
}
