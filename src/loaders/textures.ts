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

export type TextureData = {
  id: number
  png: Blob
  definition: TextureDefinition | null
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item, rootHandle) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const pngHandle = await subHandle.getFileHandle(`${item.id}.png`)
    const png = await pngHandle.getFile()

    let definition: TextureDefinition | null = null
    if (rootHandle) {
      try {
        const defsDir = await rootHandle.getDirectoryHandle('texture_definitions')
        const defHandle = await defsDir.getFileHandle(`${item.id}.json`)
        const defFile = await defHandle.getFile()
        definition = JSON.parse(await defFile.text()) as TextureDefinition
      } catch {
        // no matching definition — viewer renders without it
      }
    }

    return { id: item.id, png, definition } satisfies TextureData
  },
}

export default loader
