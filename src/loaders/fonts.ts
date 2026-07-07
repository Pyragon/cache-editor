import type { CacheLoader } from './types'
import { loadJsonItem, streamJsonItems } from './common'

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    const metricsHandle = await dirHandle.getDirectoryHandle('metrics')
    yield* streamJsonItems(metricsHandle)
  },

  async loadItem(dirHandle, item) {
    const metricsHandle = await dirHandle.getDirectoryHandle('metrics')
    return loadJsonItem(metricsHandle, item)
  },
}

export default loader
