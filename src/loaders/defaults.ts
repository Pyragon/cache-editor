import type { CacheLoader, LoadedItem } from './types'

// `defaults` isn't a numeric list — it's a fixed pair of named blobs
// (entity.json, equipment.json), one per DefaultsFile. Field names follow
// darkan-bot-refactor EntityDefaults.kt / EquipmentDefaultsType.kt.
export type EntityDefaultsDef = {
  maximumHits?: number
  hitOffsetsX?: number[]
  hitOffsetsY?: number[]
  maxVisibleHitbars?: number
  maxHitbars?: number
  defaultHitbarHeight?: number
  profilingMesh?: number
  alwaysShowContextMenu?: boolean
  npcMessagesEnabled?: boolean
  npcMessageDuration?: number
  enablePlayerMessages?: boolean
  playerMessageDuration?: number
  gameWidthDefault?: number
  gameHeightDefault?: number
  loginInterfaceId?: number
  lobbyWindow?: number
  recolorPaletteSrc?: number[][]
  recolorPaletteDst?: number[][][]
  [key: string]: unknown
}

export type EquipmentDefaultsDef = {
  customizableObjSlots?: number[]
  shieldSlot?: number
  weaponSlot?: number
  hiddenAnimationShieldSlots?: number[]
  hiddenAnimationWeaponSlots?: number[]
  [key: string]: unknown
}

export type DefaultsData = {
  name: 'entity' | 'equipment'
  def: EntityDefaultsDef | EquipmentDefaultsDef
}

// Display name (capitalized, shown in the list) → on-disk file basename.
const FILES: LoadedItem[] = [
  { id: 0, name: 'Entity' },
  { id: 1, name: 'Equipment' },
]

const fileBase = (name: string) => name.toLowerCase() as 'entity' | 'equipment'

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for (const item of FILES) {
      try {
        await dirHandle.getFileHandle(`${fileBase(item.name)}.json`)
        yield item
      } catch {
        // file absent in this dump — skip
      }
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${fileBase(item.name)}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text())
    return { name: fileBase(item.name), def } satisfies DefaultsData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as DefaultsData
    const fileHandle = await dirHandle.getFileHandle(`${fileBase(item.name)}.json`)
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(def, null, 2))
    await writable.close()
  },
}

export default loader
