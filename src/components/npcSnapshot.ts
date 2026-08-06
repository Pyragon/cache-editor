import * as THREE from 'three'
import type { ModelData } from '../loaders/models'
import { loadModelComposite, npcCompositeSpec, objectCompositeSpec } from '../loaders/npcComposite'
import { applyLookPalette, buildIdentikitPart, loadRecolorPalette } from '../loaders/playerAppearance'
import { buildTexturedModelMesh } from './modelMesh'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'

// ---------------------------------------------------------------------------
// NPC thumbnail icons: when an NPC page opens, its full composite model
// (npcComposite.ts — translations, recolours, scale, tint) is rendered once
// into a small transparent PNG data-URL, session-cached, and shown beside the
// NPC's name and in its sidebar row. Rendering goes through modelMesh.ts, so
// faces with a dumped material PNG draw textured (face colour tints the
// greyscale detail map, like the client); the rest keep their flat HSL16.
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

/** Textured render of the composite to a transparent PNG data-URL. */
async function snapshot(model: ModelData): Promise<string | null> {
  const built = await buildTexturedModelMesh(model)
  if (!built) return null

  const scene = new THREE.Scene()
  scene.add(built.mesh)

  built.mesh.geometry.computeBoundingBox()
  const bb = built.mesh.geometry.boundingBox!
  const minX = bb.min.x, maxX = bb.max.x
  const minY = bb.min.y, maxY = bb.max.y
  const minZ = bb.min.z, maxZ = bb.max.z

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

  built.dispose()
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

// object composites (the ObjectViewer header icon), keyed by object id
const objectCache = new Map<number, string | null>()
const objectInFlight = new Map<number, Promise<string | null>>()

export function peekObjectIcon(id: number): string | null | undefined {
  return objectCache.get(id)
}

/** Call after saving an object so its icon regenerates from the new def. */
export function invalidateObjectIcon(id: number): void {
  objectCache.delete(id)
}

/** Load + render (or serve from the session cache) an object's icon —
 *  its shape-10 (or first-shape) composite with recolours/scale/tint. */
export function getObjectIcon(
  cacheRoot: FileSystemDirectoryHandle,
  objectId: number,
  def: Record<string, unknown>,
): Promise<string | null> {
  const cached = objectCache.get(objectId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = objectInFlight.get(objectId)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      const spec = objectCompositeSpec(def)
      if (spec.modelIds.length === 0) return null
      const composite = await loadModelComposite(cacheRoot, spec)
      return snapshot(composite)
    } catch {
      return null
    }
  })()
  objectInFlight.set(objectId, task)
  task.then((url) => {
    objectCache.set(objectId, url)
    objectInFlight.delete(objectId)
  })
  return task
}

export function peekModelIcon(modelId: number): string | null | undefined {
  return modelCache.get(modelId)
}

// identikit composites (body models merged + the kit's own recolours, then the
// character colour palette), for the default-player editor's look slots.
// Keyed by kit AND colour choices: without the palette a hairstyle previews in
// its placeholder tones — the vivid magenta marker the game always replaces —
// and a colour change has to invalidate the thumbnail.
const idkCache = new Map<string, string | null>()
const idkInFlight = new Map<string, Promise<string | null>>()

const idkKey = (id: number, colour?: number[]) => `${id}:${colour?.join(',') ?? ''}`

export function peekIdentikitIcon(id: number, colour?: number[]): string | null | undefined {
  return idkCache.get(idkKey(id, colour))
}

/** Call after saving an identikit so its icon regenerates from the new def —
 *  drops every colour variant of that kit. */
export function invalidateIdentikitIcon(id: number): void {
  const prefix = `${id}:`
  for (const key of [...idkCache.keys()]) {
    if (key.startsWith(prefix)) idkCache.delete(key)
  }
}

/** Icon of one identikit's body composite — the same mesh the player assembler
 *  uses for that part, so a look slot shows the actual part. Pass a look's
 *  `colour` array to see it in the colours a player would wear it in. */
export function getIdentikitIcon(
  cacheRoot: FileSystemDirectoryHandle,
  id: number,
  colour?: number[],
): Promise<string | null> {
  const key = idkKey(id, colour)
  const cached = idkCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = idkInFlight.get(key)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      if (id < 0) return null
      const model = await buildIdentikitPart(cacheRoot, id)
      if (!model) return null
      if (colour) {
        // Same order as the real assembler: the part's own recolours are
        // already baked in, the character palette goes over the top.
        const palette = await loadRecolorPalette(cacheRoot)
        if (palette) applyLookPalette(model, colour, palette)
      }
      return snapshot(model)
    } catch {
      return null
    }
  })()
  idkInFlight.set(key, task)
  task.then((url) => {
    idkCache.set(key, url)
    idkInFlight.delete(key)
  })
  return task
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

// ---------------------------------------------------------------------------
// Inventory item icons, rendered with the item's OWN icon pose (zoom and
// 2048ths rotations from the def) instead of the generic 3/4 NPC view — a
// coin lies flat and a sword angles exactly as the client draws them. The
// recolours/retextures the def carries are baked in via the composite spec.
// Replaces the static public/icons PNGs wherever a live render is wanted.
// ---------------------------------------------------------------------------

const itemCache = new Map<number, string | null>()
const itemInFlight = new Map<number, Promise<string | null>>()

export function peekInventoryItemIcon(id: number): string | null | undefined {
  return itemCache.get(id)
}

/** Call after saving an item so its icon regenerates from the new def. */
export function invalidateInventoryItemIcon(id: number): void {
  itemCache.delete(id)
  itemInFlight.delete(id)
}

const ICON_FOV = 2 * Math.atan(16 / 512) * (180 / Math.PI)

export function getInventoryItemIcon(
  cacheRoot: FileSystemDirectoryHandle,
  itemId: number,
): Promise<string | null> {
  const cached = itemCache.get(itemId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = itemInFlight.get(itemId)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath('items'))
      if (!dir) return null
      const def = JSON.parse(await (await (await dir.getFileHandle(`${itemId}.json`)).getFile()).text()) as Record<string, unknown>
      const modelId = typeof def.modelId === 'number' ? def.modelId : -1
      if (modelId < 0) return null
      const composite = await loadModelComposite(cacheRoot, {
        modelIds: [modelId],
        // dump spelling per itemIconDisplayParams: British "Colours"
        recolor: {
          from: def.originalModelColours as number[] | undefined,
          to: def.modifiedModelColours as number[] | undefined,
          textureFrom: def.originalTextureIds as number[] | undefined,
          textureTo: def.modifiedTextureIds as number[] | undefined,
        },
      })
      const built = await buildTexturedModelMesh(composite)
      if (!built) return null

      // The client's icon transform (ItemDefinitions.getSprite), conjugated
      // through the (x, -y, -z) render mapping — same maths as ModelViewer's
      // item pose: roll and yaw negate, pitch survives, camera a straight
      // zoom away with the narrow 512-focal viewport FOV.
      const scene = new THREE.Scene()
      const group = new THREE.Group()
      group.add(built.mesh)
      scene.add(group)

      built.mesh.geometry.computeBoundingBox()
      const bb = built.mesh.geometry.boundingBox!
      built.mesh.position.set(
        -(bb.min.x + bb.max.x) / 2,
        -(bb.min.y + bb.max.y) / 2,
        -(bb.min.z + bb.max.z) / 2,
      )
      const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1)

      const num = (k: string) => (typeof def[k] === 'number' ? (def[k] as number) : 0)
      const rad = (units: number) => (units * Math.PI) / 1024
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rad(num('modelRotationX')))
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -rad(num('modelRotationY')))
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad(num('modelRotationZ')))
      group.quaternion.copy(qx).multiply(qy).multiply(qz)
      group.scale.set(
        (typeof def.resizeX === 'number' && def.resizeX > 0 ? def.resizeX : 128) / 128,
        (typeof def.resizeY === 'number' && def.resizeY > 0 ? def.resizeY : 128) / 128,
        (typeof def.resizeZ === 'number' && def.resizeZ > 0 ? def.resizeZ : 128) / 128,
      )
      group.position.copy(new THREE.Vector3(num('modelOffsetX'), -num('modelOffsetY'), -num('modelOffsetY')).applyQuaternion(qx))

      const zoom = num('modelZoom') > 0 ? num('modelZoom') : span * 2.4
      const camera = new THREE.PerspectiveCamera(ICON_FOV, 1, Math.max(zoom * 0.01, 0.1), zoom * 10 + span * 100)
      camera.position.set(0, 0, zoom)
      camera.updateProjectionMatrix()

      const r3 = getRenderer()
      r3.render(scene, camera)
      const url = r3.domElement.toDataURL('image/png')
      built.dispose()
      return url
    } catch {
      return null
    }
  })().then((url) => {
    itemCache.set(itemId, url)
    itemInFlight.delete(itemId)
    return url
  })
  itemInFlight.set(itemId, task)
  return task
}
