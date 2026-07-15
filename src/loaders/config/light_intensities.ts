import type { CacheLoader } from '../types'
import { deleteJsonItem, loadJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'

// Flickering point-light configs (CONFIG file type 31). Placed map lights
// whose packed type is 31 reference one of these by id; the client feeds it
// into FlickeringEffect.setType(effect, duration, ticker, surrounding).
// Fields per darkan-bot-refactor LightType.kt.
export type LightIntensityDef = {
  id?: number
  /** Waveform: 0 steady, 1 sine, 2 sawtooth, 3 perlin flicker, 4 strobe, 5 triangle. */
  effect: number
  /** Cycle speed — rotation advances duration units per client frame ÷ 50; 2048 = one cycle/second. */
  duration: number
  /** Waveform amplitude, in 2048ths. */
  ticker: number
  /** Base intensity added under the waveform, in 2048ths (signed). */
  surrounding: number
}

export type LightIntensityData = {
  id: number
  light: LightIntensityDef
}

const NEW_LIGHT_DEFAULTS: Omit<LightIntensityDef, 'id'> = {
  effect: 0,
  duration: 2048,
  ticker: 2048,
  surrounding: 0,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item) {
    const light = await loadJsonItem(dirHandle, item) as LightIntensityDef
    return { id: item.id, light } satisfies LightIntensityData
  },

  async saveItem(dirHandle, item, data) {
    const { light } = data as LightIntensityData
    await writeJsonItem(dirHandle, item.id, light)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_LIGHT_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const source = await loadJsonItem(dirHandle, item) as LightIntensityDef
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
