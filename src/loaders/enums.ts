import type { CacheLoader } from './types'
import { loadJsonItem, streamJsonItems } from './common'

export type EnumValue = number | string

export type EnumData = {
  id: number
  keyTypeChar: string
  valueTypeChar: string
  defaultStringValue: string
  defaultIntValue: number
  values: Record<string, EnumValue>
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item) {
    const raw = await loadJsonItem(dirHandle, item) as Omit<EnumData, 'id'>
    return { id: item.id, ...raw } satisfies EnumData
  },

  async saveItem(dirHandle, item, data) {
    const { id: _id, ...raw } = data as EnumData
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(raw, null, 2))
    await writable.close()
  },
}

export default loader
