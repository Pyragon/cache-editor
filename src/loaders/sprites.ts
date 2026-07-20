import type { CacheLoader } from './types'
import { streamDirItems } from './common'
import { spriteFramePngBlob } from '../components/spriteRender'
import { nextFreeSpriteId, writeNewSprite } from './spriteStore'

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

    raw.width       = meta.width
    raw.height      = meta.height
    raw.palette     = meta.palette
    raw.pixelIndices = meta.pixelIndices
    raw.alpha       = meta.alpha
    raw.usesAlpha   = meta.usesAlpha
    raw.isVertical  = meta.isVertical
    raw.offsetsX    = meta.offsetsX
    raw.offsetsY    = meta.offsetsY
    raw.subWidths   = meta.subWidths
    raw.subHeights  = meta.subHeights

    const writable = await jsonHandle.createWritable()
    await writable.write(JSON.stringify(raw, null, 2))
    await writable.close()

    // Regenerate the per-frame PNGs alongside the JSON: cryogen's repack reads
    // only the JSON, but other editor pages (map scene markers, interfaces,
    // game tips…) read these PNGs as previews — a JSON-only save would leave
    // them stale. Written in the dump's convention (sub-frame size).
    const frameCount = meta.usesAlpha.length
    for (let i = 0; i < frameCount; i++) {
      const blob = await spriteFramePngBlob(meta, i)
      const pngHandle = await subHandle.getFileHandle(`${item.id}_${i}.png`, { create: true })
      const pngWritable = await pngHandle.createWritable()
      await pngWritable.write(blob)
      await pngWritable.close()
    }
    // and drop PNGs of frames that no longer exist
    const stale: string[] = []
    for await (const entry of subHandle.values()) {
      const m = entry.kind === 'file' ? entry.name.match(new RegExp(`^${item.id}_(\\d+)\\.png$`)) : null
      if (m && Number(m[1]) >= frameCount) stale.push(entry.name)
    }
    for (const name of stale) await subHandle.removeEntry(name)
  },

  // A blank transparent 32×32 single-frame sprite — draw on it with the
  // viewer's pixel editor (which can also resize it) or Replace with an image.
  async createItem(dirHandle) {
    const size = 32
    const id = await nextFreeSpriteId(dirHandle)
    const meta: SpriteMeta = {
      width: size,
      height: size,
      palette: [0],
      pixelIndices: [Array.from({ length: size }, () => new Array(size).fill(0))],
      alpha: [new Array(size * size).fill(0)],
      usesAlpha: [false],
      isVertical: [false],
      offsetsX: [0],
      offsetsY: [0],
      subWidths: [size],
      subHeights: [size],
    }
    await writeNewSprite(dirHandle, id, meta, await spriteFramePngBlob(meta, 0))
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await dirHandle.removeEntry(String(item.id), { recursive: true })
  },

  async cloneItem(dirHandle, item) {
    const srcHandle = await dirHandle.getDirectoryHandle(String(item.id))
    const jsonFile = await (await srcHandle.getFileHandle(`${item.id}.json`)).getFile()
    const raw = JSON.parse(await jsonFile.text())

    const id = await nextFreeSpriteId(dirHandle)
    raw.id = id
    const dstHandle = await dirHandle.getDirectoryHandle(String(id), { create: true })
    const jsonHandle = await dstHandle.getFileHandle(`${id}.json`, { create: true })
    const writable = await jsonHandle.createWritable()
    await writable.write(JSON.stringify(raw, null, 2))
    await writable.close()

    // copy the frame PNGs across under the new id
    for await (const entry of srcHandle.values()) {
      const m = entry.kind === 'file' ? entry.name.match(new RegExp(`^${item.id}_(\\d+)\\.png$`)) : null
      if (!m) continue
      const blob = await (await srcHandle.getFileHandle(entry.name)).getFile()
      const pngHandle = await dstHandle.getFileHandle(`${id}_${m[1]}.png`, { create: true })
      const pngWritable = await pngHandle.createWritable()
      await pngWritable.write(blob)
      await pngWritable.close()
    }
    return { id, name: String(id) }
  },
}

export default loader
