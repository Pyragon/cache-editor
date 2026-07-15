import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems } from './common'

// Field names per darkan-bot-refactor ParticleProducerType.kt, matched opcode by
// opcode against cryogen's decoder.
//
// `fadeColor` deliberately keeps cryogen's name: darkan calls it faceColorRgb, but it
// is only ever used as the colour a particle fades TOWARD, so cryogen's is correct.
// `aBool572` is unidentified in darkan too.
//
// Everything the client derives in init() (the RGBA channels and their variance, the
// fade steps, the speed/size ramps) is transient and never dumped — it's rebuilt from
// minimumStartColorRgb / maximumStartColorRgb / fadeColor.
export type ParticleProducer = {
  id: number

  /** Emission cone, in 14-bit angle units (a full turn is 16384). */
  minimumAngleH: number
  maximumAngleH: number
  minimumAngleV: number
  maximumAngleV: number

  minimumSpeed: number
  maximumSpeed: number
  /** 0 none, 1 linear falloff with distance from the emitter, 2 quadratic. */
  speedUpdateType: number
  speedFallOffStep: number

  /** Shifted left by 14 — the world size is `size >> 14`. */
  minimumSize: number
  maximumSize: number

  minimumLifetime: number
  maximumLifetime: number
  /** Particles per tick, in 1/64ths. */
  minimumParticleRate: number
  maximumParticleRate: number

  /** Particle types (archive 1) whose motion offsets these particles inherit. */
  particleFileIds: number[] | null
  particleFileIds2: number[] | null
  effectiveVertexUids: number[] | null

  lowestDisplayPlane: number
  highestDisplayPlane: number
  updatesPerCycle: number

  /** Into the textures index — the same id space the material ops use. */
  materialId: number
  nonTexturedProducerId: number

  minimumStartColorRgb: number
  maximumStartColorRgb: number
  /** The colour particles fade toward; 0 disables fading entirely. */
  fadeColor: number
  colorFading: number
  alphaFading: number
  uniformColorVariance: boolean

  endSpeed: number
  speedChange: number
  endSize: number
  sizeChange: number

  activeFirst: boolean
  emissionEndTime: number
  lifetime: number
  periodic: boolean
  minimumSetting: number

  isTextured: boolean
  adjustsLightIntensity: boolean
  killOverlapping: boolean
  killAboveSurface: boolean
  aBool572: boolean
}

/** particles/types/<id>.json — archive 1: the motion offsets particles inherit. */
export type ParticleType = {
  id: number
  offsetX: number
  offsetY: number
  offsetZ: number
  /** 0 = the offset accelerates the particle; otherwise it displaces it directly. */
  currentOffset: number
  sizeMultiplier: number
  type: number
  // Effector (effective-vertex) fields — the attraction/repulsion mechanic when a
  // model binds this type to a vertex. All derived in ParticleArchive1Def.init()
  // and present in the dump.
  particleHandlingType: number
  verticeCalculationType: number
  /** Cone threshold the direction dot-product must reach (COSINE of `rotation`). */
  zan: number
  /** Length of the offset vector; scales the radial push and normalises the cone. */
  size3d: number
  /** Squared (or linear, per `type`) range within which the effector acts. */
  uid: number
}

export type ParticleData = {
  id: number
  producer: ParticleProducer | null
  /** Only the types this producer references, keyed by file id. */
  types: Map<number, ParticleType>
  /** The material's rendered PNG, used to draw each particle. */
  materialPng: Blob | null
  dirHandle: FileSystemDirectoryHandle
}

export async function loadProducer(
  dirHandle: FileSystemDirectoryHandle,
  id: number,
): Promise<ParticleProducer | null> {
  try {
    const file = await (await dirHandle.getFileHandle(`${id}.json`)).getFile()
    return JSON.parse(await file.text()) as ParticleProducer
  } catch {
    return null
  }
}

export async function writeProducer(
  dirHandle: FileSystemDirectoryHandle,
  producer: ParticleProducer,
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(`${producer.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(producer, null, 2))
  await writable.close()
}

export async function loadTypes(
  dirHandle: FileSystemDirectoryHandle,
  ids: number[],
): Promise<Map<number, ParticleType>> {
  const types = new Map<number, ParticleType>()
  if (!ids.length) return types

  let typesDir: FileSystemDirectoryHandle
  try {
    typesDir = await dirHandle.getDirectoryHandle('types')
  } catch {
    // an older dump without the types/ subfolder — the preview falls back to
    // straight-line motion and says so
    return types
  }

  for (const id of ids) {
    try {
      const file = await (await typesDir.getFileHandle(`${id}.json`)).getFile()
      types.set(id, JSON.parse(await file.text()) as ParticleType)
    } catch {
      // missing type — treated as no offset
    }
  }
  return types
}

export async function loadMaterialPng(
  rootHandle: FileSystemDirectoryHandle | undefined,
  materialId: number,
): Promise<Blob | null> {
  if (!rootHandle || materialId < 0) return null
  try {
    const texturesDir = await rootHandle.getDirectoryHandle('textures')
    const sub = await texturesDir.getDirectoryHandle(String(materialId))
    return await (await sub.getFileHandle(`${materialId}.png`)).getFile()
  } catch {
    // no material image — the preview falls back to a soft dot
    return null
  }
}

const NEW_PRODUCER: Omit<ParticleProducer, 'id'> = {
  minimumAngleH: 0,
  maximumAngleH: 16376,
  minimumAngleV: 0,
  maximumAngleV: 4096,
  minimumSpeed: 4194304,
  maximumSpeed: 8388608,
  speedUpdateType: 0,
  speedFallOffStep: 0,
  minimumSize: 163840,
  maximumSize: 327680,
  minimumLifetime: 30,
  maximumLifetime: 60,
  minimumParticleRate: 128,
  maximumParticleRate: 256,
  particleFileIds: null,
  particleFileIds2: null,
  effectiveVertexUids: null,
  lowestDisplayPlane: -2,
  highestDisplayPlane: -2,
  updatesPerCycle: 0,
  materialId: -1,
  nonTexturedProducerId: -1,
  minimumStartColorRgb: -1,
  maximumStartColorRgb: -1,
  fadeColor: 0,
  colorFading: 100,
  alphaFading: 100,
  uniformColorVariance: true,
  endSpeed: -1,
  speedChange: 100,
  endSize: -1,
  sizeChange: 100,
  activeFirst: true,
  emissionEndTime: -1,
  lifetime: -1,
  periodic: true,
  minimumSetting: 0,
  isTextured: false,
  adjustsLightIntensity: true,
  killOverlapping: false,
  killAboveSurface: true,
  aBool572: true,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const producer = await loadProducer(dirHandle, item.id)
    const types = producer
      ? await loadTypes(dirHandle, producer.particleFileIds ?? [])
      : new Map<number, ParticleType>()
    const materialPng = await loadMaterialPng(rootHandle, producer?.materialId ?? -1)

    return { id: item.id, producer, types, materialPng, dirHandle } satisfies ParticleData
  },

  async saveItem(dirHandle, _item, data) {
    const { producer } = data as ParticleData
    if (!producer) return
    await writeProducer(dirHandle, producer)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeProducer(dirHandle, { id, ...NEW_PRODUCER })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const source = await loadProducer(dirHandle, item.id)
    const id = await nextFreeJsonId(dirHandle)
    await writeProducer(dirHandle, { ...(source ?? NEW_PRODUCER), id })
    return { id, name: String(id) }
  },
}

export default loader
