import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, streamJsonItems, writeJsonItem } from './common'

// Loading-screen tips (GAME_TIPS index 33), dumped by cryogen
// GameTipsDefinitions. Archive/file 0 is the stage table (which tip plays per
// loading stage); every other id is a tip scene: an ordered list of typed
// draw components. Formats per darkan-bot-refactor config/gametip.
export type TipComponent = {
  type: string
  // BACKGROUND
  color?: number
  // anything anchored
  anchorX?: string
  anchorY?: string
  offsetX?: number
  offsetY?: number
  width?: number
  height?: number
  // loading bars (AnchoredElement base)
  textOffsetY?: number
  fileId?: number
  textColor?: number
  fillColor?: number
  outlineColor?: number
  unknownInt?: number
  backgroundColor?: number
  spriteFileId?: number
  spriteA?: number
  spriteB?: number
  spriteC?: number
  spriteD?: number
  spriteE?: number
  spriteF?: number
  scrollSpeed?: number
  // OUTLINED
  newsitemId?: number
  shadeColor?: number
  drawOutline?: boolean
  // SPRITE / ROTATED_SPRITE
  spriteId?: number
  angle?: number
  // ANCHORED_TEXT
  tipText?: string
  textAlignment?: number
  textVerticalAlignment?: number
  lineSpacing?: number
  textShadowColor?: number
}

export type StageUpdate = {
  tipFileId: number
  displayDurationMs: number
  timeBetweenUpdatesMs: number
}

export type Stage = {
  stage: number
  hasUpdates: boolean
  updates: StageUpdate[]
}

export type StageTable = {
  headerSize: number
  transformTypes: number[]
  totalStageCount: number
  tipsFileId: number
  displayDurationMs: number
  timeBetweenUpdatesMs: number
  definedStages: Stage[]
}

export type GameTipDef = {
  id: number
  components?: TipComponent[]
  stageTable?: StageTable
}

export type GameTipData = {
  id: number
  def: GameTipDef
  /** For the preview: sprites entry + the cache root (fonts) + this entry's
      own folder (the stage table renders thumbnails of referenced tips). */
  spritesDir: FileSystemDirectoryHandle | null
  rootHandle: FileSystemDirectoryHandle | null
  dir: FileSystemDirectoryHandle | null
}

const loader: CacheLoader = {
  streamItems: streamJsonItems,

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as GameTipDef

    let spritesDir: FileSystemDirectoryHandle | null = null
    if (rootHandle) {
      try {
        spritesDir = await rootHandle.getDirectoryHandle('sprites')
      } catch {
        // sprites not dumped — preview falls back to placeholders
      }
    }

    return { id: item.id, def, spritesDir, rootHandle: rootHandle ?? null, dir: dirHandle } satisfies GameTipData
  },

  async saveItem(dirHandle, item, data) {
    const { def } = data as GameTipData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, components: [] })
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as GameTipDef
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: String(id) }
  },
}

export default loader
