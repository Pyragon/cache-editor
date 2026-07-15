import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// Field names per darkan-bot-refactor MaterialType.kt (isHalfSize kept over
// darkan's "isSmall"; aBool2087 is unidentified in darkan too).
export type TextureDefinition = {
  id: number
  detailsOnly: boolean
  isHalfSize: boolean
  skipTriangles: boolean
  brightness: number
  alpha: number
  effectId: number
  effectParam1: number
  effectParam2: number
  colorHsl: number
  textureSpeedU: number
  textureSpeedV: number
  aBool2087: boolean
  isBrickTile: boolean
  mipmapping: number
  repeatS: boolean
  repeatT: boolean
  hdr: boolean
  combineMode: number
  effectCombiner: number
}

// One node of the material's operation graph. `type` selects the operation
// (see textureOps.ts); the remaining keys are that operation's own parameters,
// so they're deliberately loose.
export type TextureOperation = {
  type: number
  monochrome: boolean
  imageCacheCapacity: number
  [key: string]: unknown
}

// textures/<id>/<id>.json — the op graph the client evaluates to render the
// material. `operationIndices[i]` are the node indices wired into node i's
// inputs, and the three root indices pick which node produces the colour, the
// opacity and the HDR channel.
export type MaterialDefinition = {
  id: number
  textureOperations: TextureOperation[]
  operationIndices: number[][]
  opaqueOperationIndex: number
  opacityOperationIndex: number
  hdrOperationIndex: number
}

// The `textures` and `texture_definitions` entries are two halves of the same
// thing (same id space: the rendered material PNG plus the op graph that draws
// it, and the flags that control how it's applied), so both loaders return this
// shape and open the same viewer. Flags save to texture_definitions/<id>.json
// and the op graph saves to textures/<id>/<id>.json, wherever you opened from.
export type TextureData = {
  id: number
  png: Blob | null
  def: TextureDefinition | null
  defsDir: FileSystemDirectoryHandle | null
  material: MaterialDefinition | null
  texturesDir: FileSystemDirectoryHandle | null
  /** For the Sprite / Tiled Sprite ops, which sample the sprites index. */
  spritesDir: FileSystemDirectoryHandle | null
}

export async function resolveSpritesDir(
  rootHandle: FileSystemDirectoryHandle | undefined,
): Promise<FileSystemDirectoryHandle | null> {
  if (!rootHandle) return null
  try {
    return await rootHandle.getDirectoryHandle('sprites')
  } catch {
    return null
  }
}

export async function loadTexturePng(
  texturesDir: FileSystemDirectoryHandle,
  id: number,
): Promise<Blob | null> {
  try {
    const subHandle = await texturesDir.getDirectoryHandle(String(id))
    return await (await subHandle.getFileHandle(`${id}.png`)).getFile()
  } catch {
    return null
  }
}

export async function loadTextureDef(
  defsDir: FileSystemDirectoryHandle,
  id: number,
): Promise<TextureDefinition | null> {
  try {
    const file = await (await defsDir.getFileHandle(`${id}.json`)).getFile()
    return JSON.parse(await file.text()) as TextureDefinition
  } catch {
    return null
  }
}

export async function writeTextureDef(
  defsDir: FileSystemDirectoryHandle,
  def: TextureDefinition,
): Promise<void> {
  const fileHandle = await defsDir.getFileHandle(`${def.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(def, null, 2))
  await writable.close()
}

export async function loadMaterial(
  texturesDir: FileSystemDirectoryHandle,
  id: number,
): Promise<MaterialDefinition | null> {
  try {
    const subHandle = await texturesDir.getDirectoryHandle(String(id))
    const file = await (await subHandle.getFileHandle(`${id}.json`)).getFile()
    return JSON.parse(await file.text()) as MaterialDefinition
  } catch {
    return null
  }
}

export async function writeMaterial(
  texturesDir: FileSystemDirectoryHandle,
  material: MaterialDefinition,
): Promise<void> {
  const subHandle = await texturesDir.getDirectoryHandle(String(material.id), { create: true })
  const fileHandle = await subHandle.getFileHandle(`${material.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(material, null, 2))
  await writable.close()
}

// The two halves of a texture live in different folders, so a save can touch
// both: the flags go to texture_definitions/<id>.json and the op graph to
// textures/<id>/<id>.json. Both are repacked by cryogen's getActions().
export async function saveTextureData(data: TextureData): Promise<void> {
  const { def, defsDir, material, texturesDir } = data
  if (def && defsDir) await writeTextureDef(defsDir, def)
  if (material && texturesDir) await writeMaterial(texturesDir, material)
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const png = await loadTexturePng(dirHandle, item.id)
    const material = await loadMaterial(dirHandle, item.id)

    let defsDir: FileSystemDirectoryHandle | null = null
    let def: TextureDefinition | null = null
    if (rootHandle) {
      try {
        defsDir = await rootHandle.getDirectoryHandle('texture_definitions')
        def = await loadTextureDef(defsDir, item.id)
      } catch {
        // texture_definitions not dumped — viewer renders the image and ops only
      }
    }

    const spritesDir = await resolveSpritesDir(rootHandle)
    return { id: item.id, png, def, defsDir, material, texturesDir: dirHandle, spritesDir } satisfies TextureData
  },

  saveItem: (_dirHandle, _item, data) => saveTextureData(data as TextureData),
}

export default loader
