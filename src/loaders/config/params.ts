import type { CacheLoader } from '../types'
import { loadJsonItem, streamJsonItems } from '../common'

const loader: CacheLoader = {
  streamItems: streamJsonItems,
  loadItem: loadJsonItem,
}

export default loader
