import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, writeJsonItem } from './common'

// Known fields (post-rename dumper, per darkan-bot-refactor ItemType.kt);
// the index signature keeps any extra/unknown keys intact through edits.
export type ItemDef = {
  id: number
  name: string
  groundOptions?: (string | null)[]
  inventoryOptions?: (string | null)[]
  originalModelColours?: number[]
  modifiedModelColours?: number[]
  originalTextureIds?: number[]
  modifiedTextureIds?: number[]
  stackIds?: number[]
  stackTriggerAmount?: number[]
  quests?: number[]
  clientScriptData?: Record<string, number | string>
  [key: string]: unknown
}

export type ItemData = {
  id: number
  item: ItemDef
}

const NEW_ITEM_DEFAULTS: Omit<ItemDef, 'id'> = {
  loaded: true,
  modelId: 0,
  name: 'null',
  modelZoom: 2000,
  modelRotationX: 0, modelRotationY: 0, modelRotationZ: 0,
  modelOffsetX: 0, modelOffsetY: 0,
  realOffsetX: 0, realOffsetY: 0,
  stackable: 0,
  value: 1,
  membersOnly: false,
  tradeable: false,
  maleEquip1: -1, maleEquip2: -1, maleEquip3: -1,
  femaleEquip1: -1, femaleEquip2: -1, femaleEquip3: -1,
  maleHead1: 0, maleHead2: 0, femaleHead1: 0, femaleHead2: 0,
  groundOptions: [null, null, 'take', null, null],
  inventoryOptions: [null, null, null, null, 'drop'],
  unknownInt6: 0,
  certId: -1, certTemplateId: -1,
  lendId: -1, lendTemplateId: -1,
  bindId: -1, bindTemplateId: -1,
  resizeX: 0, resizeY: 0, resizeZ: 128,
  ambient: 0, contrast: 0,
  teamId: -1,
  maleWearXOffset: 0, maleWearYOffset: 0, maleWearZOffset: 0,
  femaleWearXOffset: 0, femaleWearYOffset: 0, femaleWearZOffset: 0,
  primaryCursorActionIndex: 0, primaryCursor: 0,
  secondaryCursorActionIndex: 0, secondaryCursor: 0,
  customCursorOp1: 0, customCursorId1: 0,
  customCursorOp2: 0, customCursorId2: 0,
  wearPos: -1, wearPos2: -1, wearPos3: -1,
  noted: false,
  lended: false,
  multiStackSize: 0,
  pickSizeShift: 0,
  i_96_: 0, i_97_: 0,
}

const NAME_REGEX = /"name":\s*"((?:[^"\\]|\\.)*)"/

const loader: CacheLoader = {
  // Reads every item file to surface names in the list ("4151 - Abyssal
  // whip"), batched in parallel so 25k+ files stay tolerable.
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
    const def = JSON.parse(await file.text()) as ItemDef
    return { id: item.id, item: def } satisfies ItemData
  },

  async saveItem(dirHandle, item, data) {
    const { item: def } = data as ItemData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { id, ...NEW_ITEM_DEFAULTS })
    return { id, name: `${id} - null` }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as ItemDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: `${id} - ${source.name ?? 'null'}` }
  },
}

export default loader
