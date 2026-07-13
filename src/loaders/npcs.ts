import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, writeJsonItem } from './common'

// Known fields (post-rename dumper, per darkan-bot-refactor NPCType.kt);
// the index signature keeps any extra/unknown keys intact through edits.
export type NpcDef = {
  id?: number
  name: string
  options?: (string | null)[]
  membersOptions?: (string | null)[]
  modelIds?: number[]
  headModels?: number[]
  originalColors?: number[]
  modifiedColors?: number[]
  originalTextures?: number[]
  modifiedTextures?: number[]
  recolorDPalette?: number[]
  transformTo?: number[]
  quests?: number[]
  // Sized to modelIds; each slot is null or an [x, y, z] nudge for that model.
  modelTranslation?: (number[] | null)[]
  parameters?: Record<string, number | string>
  respawnDirection?: string
  movementType?: string
  [key: string]: unknown
}

export type NpcData = {
  id: number
  npc: NpcDef
}

// Mirrors NPCDefinitions' field initializers in cryogen.
const NEW_NPC_DEFAULTS: NpcDef = {
  name: 'null',
  size: 1,
  gameType: -1,
  basId: -1,
  primaryCursor: -1, secondaryCursor: -1,
  primaryCursorActionIndex: -1, secondaryCursorActionIndex: -1,
  attackCursor: -1,
  displayOnMinimap: true,
  combatLevel: -1,
  scaleXZ: 128, scaleY: 128,
  highPriority: false, mediumPriority: false, lowPriority: false,
  ambient: 0, contrast: 0,
  headIcons: -1,
  overheadSprite: -1,
  turnDirection: 32,
  varpBit: -1, varp: -1,
  visible: true,
  delayMovement: true,
  shadowed: true,
  shadowColorSrc: 0, shadowColorDst: 0,
  shadowAlphaSrc: -96, shadowAlphaDst: -16,
  walkMask: 0,
  walkingSoundEffect: -1, teleportSoundEffect: -1,
  idleSoundEffect: -1, runningSoundEffect: -1,
  ambientSoundMinHearDistance: 0, ambientSoundMaxHearDistance: 0,
  ambientSoundVolume: 255,
  ambientSoundMaxDelay: 256, ambientSoundMinDelay: 256,
  iconHeight: -1,
  mecId: -1,
  shadowSize: -1,
  sizeShift: 0,
  hasTint: true,
  tintHue: 0, tintSaturation: 0, tintLightness: 0, tintOpacity: 0,
  instrumentSoundEffect: false,
  respawnDirection: 'SOUTH',
  options: [null, null, null, null, null],
  membersOptions: [null, null, null, null, null],
}

const NAME_REGEX = /"name":\s*"((?:[^"\\]|\\.)*)"/

const loader: CacheLoader = {
  // Reads every npc file to surface names in the list, batched in parallel.
  async *streamItems(dirHandle) {
    const ids: number[] = []
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (!isNaN(id)) ids.push(id)
      }
    }

    const CHUNK = 250
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const results = await Promise.all(chunk.map(async (id) => {
        try {
          const fileHandle = await dirHandle.getFileHandle(`${id}.json`)
          const text = await (await fileHandle.getFile()).text()
          const match = text.match(NAME_REGEX)
          const name = match ? JSON.parse(`"${match[1]}"`) as string : 'null'
          return { id, name: `${id} - ${name}` }
        } catch {
          return { id, name: String(id) }
        }
      }))
      yield* results
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as NpcDef
    return { id: item.id, npc: def } satisfies NpcData
  },

  async saveItem(dirHandle, item, data) {
    const { npc: def } = data as NpcData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...NEW_NPC_DEFAULTS, id })
    return { id, name: `${id} - null` }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as NpcDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: `${id} - ${source.name ?? 'null'}` }
  },
}

export default loader
