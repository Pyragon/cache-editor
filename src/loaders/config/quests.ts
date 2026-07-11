import type { CacheLoader, LoadedItem, QuestServerData } from '../types'

// Quest ID (from quest JSON "id" field) → Slot ID (from Quests.java)
const QUEST_ID_TO_SLOT: Record<number, number> = {
  6: 1,   51: 2,   99: 3,   66: 4,   15: 5,  137: 6,  72: 7,  152: 8,  60: 9,  64: 10,
  27: 11, 186: 12,  55: 13, 185: 14,  63: 15, 132: 16, 179: 17,  43: 18,  57: 19, 102: 20,
  128: 21,   0: 22,  44: 23, 158: 24, 104: 25,  92: 26,  26: 27,  13: 28, 140: 29, 135: 30,
  123: 31,  69: 32, 111: 33,  34: 34,  75: 35, 149: 36,   8: 37,  94: 38,  97: 39, 107: 40,
  143: 41,  73: 42, 154: 43, 116: 44, 136: 45, 106: 46,  76: 47,  98: 48,  50: 49,  93: 50,
  118: 51, 138: 52,  82: 53, 134: 54,   3: 55,  65: 56, 150: 57, 120: 58, 125: 59,  38: 60,
  112: 61, 105: 62, 141: 63,  21: 64,  19: 65,  59: 66, 119: 67,  42: 68,  37: 69,  24: 70,
  124: 71, 108: 72, 130: 73, 147: 74, 151: 75, 156: 76, 129: 77,  28: 78,  22: 79, 133: 80,
   54: 81, 146: 82,  58: 83,   9: 84,  68: 85,  67: 86,  30: 87,  62: 88, 100: 89, 110: 90,
  127: 91, 101: 92,   2: 93, 121: 94,  12: 95,  10: 96,  71: 97,  39: 98,  70: 99,  36: 100,
   46: 101,  48: 102,  89: 103,  45: 104,  81: 105, 126: 106, 157: 107, 113: 108,   7: 109,  78: 110,
   40: 111,  90: 112,  85: 113,  31: 114, 103: 115,  16: 116, 145: 117, 148: 118,   1: 119,  88: 120,
  144: 121, 153: 122, 155: 123,  79: 124,  32: 125,  61: 126,   5: 127,  49: 128,  91: 129,  25: 130,
   52: 131,  41: 132,  23: 133,  96: 134,  47: 135, 109: 136, 139: 137,  80: 138,   4: 139,  14: 140,
  142: 141,  29: 142,  95: 143,  56: 144,  86: 145,  87: 146,  74: 148, 115: 149,  18: 150, 122: 151,
  114: 152,  20: 153,  33: 154,  77: 155, 117: 156, 168: 157, 175: 158,  53: 159,  35: 160, 167: 161,
  170: 162, 169: 163, 171: 165, 174: 167,  11: 168, 172: 170, 177: 171, 176: 172,  83: 173, 180: 174,
  194: 176, 203: 178, 183: 179, 187: 180, 188: 181, 191: 182, 192: 183, 193: 184, 196: 187, 200: 188,
  201: 190, 199: 191, 202: 192,
}

const SLOT_TO_QUEST_ID: Record<number, number> = Object.fromEntries(
  Object.entries(QUEST_ID_TO_SLOT).map(([questId, slotId]) => [slotId, Number(questId)])
)

// Module-level cache — invalidated when root handle reference changes
let _cachedRoot: FileSystemDirectoryHandle | null = null
let _slotToStruct: Record<number, number> = {}
let _structCache = new Map<number, Record<string, unknown>>()

function maybeInvalidate(rootHandle: FileSystemDirectoryHandle) {
  if (_cachedRoot !== rootHandle) {
    _cachedRoot = rootHandle
    _slotToStruct = {}
    _structCache.clear()
  }
}

async function getSlotToStruct(rootHandle: FileSystemDirectoryHandle): Promise<Record<number, number>> {
  maybeInvalidate(rootHandle)
  if (Object.keys(_slotToStruct).length > 0) return _slotToStruct
  const enumsHandle = await rootHandle.getDirectoryHandle('enums')
  const fileHandle = await enumsHandle.getFileHandle('2252.json')
  const file = await fileHandle.getFile()
  const json = JSON.parse(await file.text())
  const result: Record<number, number> = {}
  for (const [slot, structId] of Object.entries(json.values as Record<string, number>)) {
    if (structId !== -1) result[Number(slot)] = structId
  }
  _slotToStruct = result
  return result
}

async function getStructsHandle(rootHandle: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  const configHandle = await rootHandle.getDirectoryHandle('config')
  return configHandle.getDirectoryHandle('structs')
}

async function getStructValues(rootHandle: FileSystemDirectoryHandle, structId: number): Promise<Record<string, unknown>> {
  maybeInvalidate(rootHandle)
  if (_structCache.has(structId)) return _structCache.get(structId)!
  const structsHandle = await getStructsHandle(rootHandle)
  const fileHandle = await structsHandle.getFileHandle(`${structId}.json`)
  const file = await fileHandle.getFile()
  const json = JSON.parse(await file.text())
  const values = (json.values ?? {}) as Record<string, unknown>
  _structCache.set(structId, values)
  return values
}

function decodeWorldTile(hash: number) {
  return {
    x: (hash >> 14) & 0x3fff,
    y: hash & 0x3fff,
    plane: (hash >>> 28) & 0x3,
  }
}

function encodeWorldTile(x: number, y: number, plane: number): number {
  return ((plane & 0x3) << 28) | ((x & 0x3fff) << 14) | (y & 0x3fff)
}

function extractSkillReqs(values: Record<string, unknown>): [number, number][] {
  const reqs: [number, number][] = []
  for (let i = 0; ; i++) {
    const skill = values[String(871 + i * 2)] as number | undefined
    const level = values[String(872 + i * 2)] as number | undefined
    if (skill == null) break
    reqs.push([skill, level ?? 0])
  }
  return reqs
}

function extractPrereqSlots(values: Record<string, unknown>): number[] {
  const slots: number[] = []
  for (let key = 859; key <= 870; key++) {
    const val = values[String(key)] as number | undefined
    if (val != null) slots.push(val)
  }
  return slots
}

async function writeStruct(
  rootHandle: FileSystemDirectoryHandle,
  structId: number,
  server: QuestServerData
): Promise<void> {
  const structsHandle = await getStructsHandle(rootHandle)
  const fileHandle = await structsHandle.getFileHandle(`${structId}.json`)

  const file = await fileHandle.getFile()
  const json = JSON.parse(await file.text())
  const values: Record<string, unknown> = json.values ?? {}

  // startNpc
  if (server.startNpc >= 0) values['691'] = server.startNpc
  else delete values['691']

  // slotId
  values['847'] = server.slotId

  // startLocation
  const { x, y, plane } = server.startLocation
  if (x !== 0 || y !== 0 || plane !== 0) values['850'] = encodeWorldTile(x, y, plane)
  else delete values['850']

  // Prereq quest IDs → slot IDs stored in keys 859-870
  for (let key = 859; key <= 870; key++) delete values[String(key)]
  server.prereqQuestIds
    .map((id) => QUEST_ID_TO_SLOT[id])
    .filter((slot): slot is number => slot != null)
    .forEach((slot, i) => { values[String(859 + i)] = slot })

  // Skill reqs → keys 871/872, 873/874, ...
  for (let i = 0; i < 7; i++) {
    delete values[String(871 + i * 2)]
    delete values[String(872 + i * 2)]
  }
  server.skillReqs.forEach(([skill, level], i) => {
    values[String(871 + i * 2)] = skill
    values[String(872 + i * 2)] = level
  })

  json.values = values
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(json, null, 2))
  await writable.close()

  _structCache.set(structId, values)
}

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const match = handle.name.match(/^(\d+) - (.+)\.json$/)
      if (!match) continue
      const id = parseInt(match[1], 10)
      const name = match[2]
      yield { id, name: `${id} - ${name}` } satisfies LoadedItem
    }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    const quest = JSON.parse(await file.text())

    if (!rootHandle) return { quest, server: null }

    try {
      const slotToStruct = await getSlotToStruct(rootHandle)
      const slotId = QUEST_ID_TO_SLOT[quest.id as number]
      if (slotId == null) return { quest, server: null }

      const structId = slotToStruct[slotId]
      if (!structId) return { quest, server: null }

      const values = await getStructValues(rootHandle, structId)

      const startNpc = (values['691'] as number | undefined) ?? -1
      const slotIdFromStruct = (values['847'] as number | undefined) ?? -1
      const locHash = values['850'] as number | undefined
      const startLocation = locHash != null ? decodeWorldTile(locHash) : { x: 0, y: 0, plane: 0 }

      const skillReqs = extractSkillReqs(values)
      const prereqSlots = extractPrereqSlots(values)
      const prereqQuestIds = prereqSlots
        .map((slot) => SLOT_TO_QUEST_ID[slot])
        .filter((id): id is number => id != null)

      const server: QuestServerData = { startNpc, startLocation, slotId: slotIdFromStruct, prereqQuestIds, skillReqs }
      return { quest, server }
    } catch {
      return { quest, server: null }
    }
  },

  async saveItem(dirHandle, item, data) {
    const { quest, server } = data as { quest: Record<string, unknown>; server: QuestServerData | null }

    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(quest, null, 2))
    await writable.close()

    if (server && _cachedRoot) {
      const slotId = QUEST_ID_TO_SLOT[quest.id as number]
      if (slotId != null) {
        const structId = _slotToStruct[slotId]
        if (structId) await writeStruct(_cachedRoot, structId, server)
      }
    }
  },
}

export default loader
