import * as THREE from 'three'
import { hslToRgb } from '../loaders/models'
import type { ModelData } from '../loaders/models'
import { loadModelComposite, npcCompositeSpec } from '../loaders/npcComposite'

// ---------------------------------------------------------------------------
// NPC thumbnail icons: when an NPC page opens, its full composite model
// (npcComposite.ts — translations, recolours, scale, tint) is rendered once
// into a small transparent PNG data-URL, session-cached, and shown beside the
// NPC's name and in its sidebar row.
//
// Deliberately texture-less for now — faces render their flat HSL16 colour
// even when they carry a texture. TO ADD TEXTURES LATER: the composite's
// ModelData already carries everything needed — `faceTextures` (per-face
// texture id), `textures` (Map<id, Blob> of the rendered material PNGs) and
// the texture-mapping arrays. Follow ModelViewer.tsx's build: bucket faces by
// texture id into geometry groups, one MeshBasicMaterial per group with
// `map` = a THREE.Texture from `await createImageBitmap(blob)` (colorSpace
// SRGBColorSpace, RepeatWrapping), and copy its writeUVs() logic for the UV
// attribute (planar P/M/N triangles plus the type 1–3 cylinder/cube/sphere
// projections). The only structural change here is that snapshot() becomes
// async across the bitmap decodes before it can render — everything else
// (camera, lighting, caching) stays as is. Face colour still tints the
// texture (the material PNGs are greyscale detail maps), so keep vertexColors
// on. See also memory: project_npc_icon_textures.
// ---------------------------------------------------------------------------

const ICON_SIZE = 128

// dataURL, or null when the NPC has no renderable models (both cached so we
// don't retry failures every visit)
const cache = new Map<number, string | null>()
const inFlight = new Map<number, Promise<string | null>>()

// same idea keyed by single model id (the NPC part-table row icons)
const modelCache = new Map<number, string | null>()
const modelInFlight = new Map<number, Promise<string | null>>()

export function peekNpcIcon(id: number): string | null | undefined {
  return cache.get(id)
}

/** Call after saving an NPC so its icon regenerates from the new def. */
export function invalidateNpcIcon(id: number): void {
  cache.delete(id)
}

// One shared renderer for every snapshot — WebGL contexts are a scarce
// browser resource (~16 per page), so never one per icon.
let renderer: THREE.WebGLRenderer | null = null
function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setSize(ICON_SIZE, ICON_SIZE)
    renderer.setClearColor(0x000000, 0) // transparent background
  }
  return renderer
}

// Palette RGB is sRGB; three works linear and encodes on output (same
// double-encode trap ModelViewer documents).
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Flat-colour render of the composite to a transparent PNG data-URL. */
function snapshot(model: ModelData): string | null {
  const { vertexCount, faceCount, vertexX, vertexY, vertexZ, triangleX, triangleY, triangleZ, faceColor, faceAlpha } = model

  // count visible faces first (skip fully-transparent marker faces)
  const faces: number[] = []
  for (let f = 0; f < faceCount; f++) {
    if (faceAlpha[f] === -1) continue
    const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
    if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue
    faces.push(f)
  }
  if (faces.length === 0) return null

  const positions = new Float32Array(faces.length * 9)
  const colors = new Float32Array(faces.length * 9)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  let vert = 0
  for (const f of faces) {
    const corners = [triangleX[f], triangleY[f], triangleZ[f]]
    const rgb = hslToRgb(faceColor[f] & 0xffff)
    const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
    const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
    const b = srgbToLinear((rgb & 0xff) / 255)
    for (const v of corners) {
      const base = vert * 3
      // same RS → three mapping as ModelViewer: (x, −y, −z)
      const x = vertexX[v], y = -vertexY[v], z = -vertexZ[v]
      positions[base] = x; positions[base + 1] = y; positions[base + 2] = z
      colors[base] = r; colors[base + 1] = g; colors[base + 2] = b
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
      vert++
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false

  const scene = new THREE.Scene()
  scene.add(mesh)

  // 3/4 view: slight yaw so the icon reads as a figure, slight look-down
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)
  const camera = new THREE.PerspectiveCamera(40, 1, span * 0.01, span * 10)
  const dist = span * 1.7
  const yaw = Math.PI / 7
  camera.position.set(cx + Math.sin(yaw) * dist, cy + span * 0.35, cz + Math.cos(yaw) * dist)
  camera.lookAt(cx, cy, cz)
  camera.updateProjectionMatrix()

  const r3 = getRenderer()
  r3.render(scene, camera)
  const url = r3.domElement.toDataURL('image/png')

  geo.dispose()
  mat.dispose()
  return url
}

/** Load + render (or serve from the session cache) this NPC's icon. */
export function getNpcIcon(
  cacheRoot: FileSystemDirectoryHandle,
  npcId: number,
  def: Record<string, unknown>,
): Promise<string | null> {
  const cached = cache.get(npcId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = inFlight.get(npcId)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      const spec = npcCompositeSpec(def)
      if (spec.modelIds.length === 0) return null
      const composite = await loadModelComposite(cacheRoot, spec)
      return snapshot(composite)
    } catch {
      return null // unreadable models — cache the miss, don't retry each visit
    }
  })()
  inFlight.set(npcId, task)
  task.then((url) => {
    cache.set(npcId, url)
    inFlight.delete(npcId)
  })
  return task
}

export function peekModelIcon(modelId: number): string | null | undefined {
  return modelCache.get(modelId)
}

/** Icon of a single raw model (the NPC part-table rows) — no translations,
 *  recolours or marker hiding, just the part as it is on disk. */
export function getModelIcon(
  cacheRoot: FileSystemDirectoryHandle,
  modelId: number,
): Promise<string | null> {
  const cached = modelCache.get(modelId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = modelInFlight.get(modelId)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      if (modelId < 0) return null
      const model = await loadModelComposite(cacheRoot, { modelIds: [modelId] })
      return snapshot(model)
    } catch {
      return null
    }
  })()
  modelInFlight.set(modelId, task)
  task.then((url) => {
    modelCache.set(modelId, url)
    modelInFlight.delete(modelId)
  })
  return task
}
