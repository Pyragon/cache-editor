import type { CacheLoader } from './types'
import { streamDirItems } from './common'

export type SpriteMeta = {
  width: number
  height: number
  palette: number[]
  pixelIndices: number[][][] // [frame][x][y] column-major
  alpha: number[][]          // [frame][y * subWidth + x]
  usesAlpha: boolean[]
  isVertical: boolean[]
  offsetsX: number[]
  offsetsY: number[]
  subWidths: number[]
  subHeights: number[]
}

export type SpriteData = {
  id: number
  meta: SpriteMeta
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const jsonHandle = await subHandle.getFileHandle(`${item.id}.json`)
    const jsonFile = await jsonHandle.getFile()
    const meta = JSON.parse(await jsonFile.text()) as SpriteMeta
    return { id: item.id, meta } satisfies SpriteData
  },

  async saveItem(dirHandle, item, data) {
    const { meta } = data as SpriteData
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const jsonHandle = await subHandle.getFileHandle(`${item.id}.json`)
    const jsonFile = await jsonHandle.getFile()
    const raw = JSON.parse(await jsonFile.text())

    raw.usesAlpha = meta.usesAlpha
    raw.isVertical = meta.isVertical
    raw.offsetsX = meta.offsetsX
    raw.offsetsY = meta.offsetsY
    raw.subWidths = meta.subWidths
    raw.subHeights = meta.subHeights

    const writable = await jsonHandle.createWritable()
    await writable.write(JSON.stringify(raw, null, 2))
    await writable.close()
  },
}

export default loader
