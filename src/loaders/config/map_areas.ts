import type { CacheLoader } from '../types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from '../common'

// Map element config ("areas") — fields per darkan-bot-refactor MECType.kt.
// Dumped from FileType.MAP_AREAS as flat <id>.json.
export type AreaDef = {
  id?: number
  defaultIconArchive: number
  mouseOverIconArchive: number
  areaName?: string
  defaultTextColor: number
  mouseOverTextColor: number
  baseTextzoom: number
  displayedOnWorldmap: boolean
  displayedOnMinimap: boolean
  hasRandomisedMinimapPosition: boolean
  primaryVarpbit: number
  primaryVarp: number
  primaryVariableMinValue: number
  primaryVariableMaxValue: number
  minimenuActions: (string | null)[]
  offsets?: number[]
  lineColor: number
  colors?: number[]
  colorPointers?: number[]
  visible: boolean
  minimenuName?: string
  spriteId: number
  categoryId: number
  secondaryVarpbit: number
  secondaryVarp: number
  secondaryVariableMinValue: number
  secondaryVariableMaxValue: number
  outlineColor: number
  backgroundColor: number
  dashLineSpacing: number
  dashLineLength: number
  dashLineOffset: number
  labelOffsetX: number
  labelOffsetY: number
  parameters?: Record<string, number | string>
}

export type AreaData = {
  id: number
  def: AreaDef
  spritesDir: FileSystemDirectoryHandle | null
}

const NEW_AREA_DEFAULTS: Omit<AreaDef, 'id'> = {
  defaultIconArchive: -1,
  mouseOverIconArchive: -1,
  defaultTextColor: 0,
  mouseOverTextColor: -1,
  baseTextzoom: 0,
  displayedOnWorldmap: true,
  displayedOnMinimap: false,
  hasRandomisedMinimapPosition: true,
  primaryVarpbit: -1,
  primaryVarp: -1,
  primaryVariableMinValue: 0,
  primaryVariableMaxValue: 0,
  minimenuActions: [null, null, null, null, null],
  lineColor: 0,
  visible: true,
  spriteId: -1,
  categoryId: -1,
  secondaryVarpbit: -1,
  secondaryVarp: -1,
  secondaryVariableMinValue: 0,
  secondaryVariableMaxValue: 0,
  outlineColor: 0,
  backgroundColor: 0,
  dashLineSpacing: -1,
  dashLineLength: -1,
  dashLineOffset: -1,
  labelOffsetX: 0,
  labelOffsetY: 0,
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as AreaDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // no sprites entry in this dump — icon previews unavailable
      }
    }

    return { id: item.id, def, spritesDir } satisfies AreaData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as AreaData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_AREA_DEFAULTS })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as AreaDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
