import type { CacheLoader, LoadedItem, QuestServerData } from '../types'

// A quest lives in TWO cache archives: the quest def (CONFIG archive 35,
// dumped to config/quests/<id> - <name>.json — the client's quest list reads
// these) and the quest-start-interface struct (CONFIG archive 26,
// config/structs/<structId>.json). The link is slot id → struct id via enum
// 2252; the quest↔slot pairing itself is derived below by matching the quest
// def's name against struct key 845 (validated: reproduces the old hardcoded
// Quests.java table 183/183 with staged exact → normalized → token matching).

// Skill reqs occupy contiguous key pairs from 871. The next known field sits
// at 895, so 12 pairs (871-894) is the hard ceiling before a write would
// clobber a neighbouring key; the dump's real maximum is 10 pairs.
const MAX_SKILL_REQ_PAIRS = 12

// Struct keys owned by dedicated UI fields; everything else is surfaced (and
// written back) through the raw extras table.
function isManagedKey(key: number): boolean {
  if (key === 691 || key === 845 || key === 846 || key === 847 || key === 850) return true
  if (key >= 859 && key <= 870) return true                       // prereq slots
  if (key >= 871 && key < 871 + MAX_SKILL_REQ_PAIRS * 2) return true // skill req pairs
  if (key >= 948 && key <= 951) return true                       // journal texts
  return false
}

// Module-level cache — invalidated when root handle reference changes
let _cachedRoot: FileSystemDirectoryHandle | null = null
let _slotToStruct: Record<number, number> = {}
let _structCache = new Map<number, Record<string, unknown>>()
let _questToSlot: Record<number, number> | null = null

function maybeInvalidate(rootHandle: FileSystemDirectoryHandle) {
  if (_cachedRoot !== rootHandle) {
    _cachedRoot = rootHandle
    _slotToStruct = {}
    _structCache.clear()
    _questToSlot = null
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

// ---------------------------------------------------------------------------
// Quest ↔ slot derivation (replaces the hardcoded Quests.java table)
// ---------------------------------------------------------------------------

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|a)\s+/, '')
    .replace(/[^a-z0-9]/g, '')
    .replaceAll('ll', 'l')
}

function nameTokens(s: string): Set<string> {
  const stripped = s.toLowerCase().replace(/^(the|a)\s+/, '')
  return new Set(stripped.match(/[a-z0-9]+/g) ?? [])
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false
  return true
}

async function getQuestToSlot(
  questsHandle: FileSystemDirectoryHandle,
  rootHandle: FileSystemDirectoryHandle,
): Promise<Record<number, number>> {
  maybeInvalidate(rootHandle)
  if (_questToSlot) return _questToSlot

  // Quest names straight from the dump's filenames ("<id> - <name>.json" is
  // written from the def's name field, so no file reads are needed).
  const questNames = new Map<number, string>()
  for await (const handle of questsHandle.values()) {
    if (handle.kind !== 'file') continue
    const match = handle.name.match(/^(\d+) - (.+)\.json$/)
    if (match) questNames.set(parseInt(match[1], 10), match[2])
  }

  const slotToStruct = await getSlotToStruct(rootHandle)
  const slotNames = new Map<number, string>()
  for (const [slot, structId] of Object.entries(slotToStruct)) {
    try {
      const values = await getStructValues(rootHandle, structId as number)
      const name = values['845']
      if (typeof name === 'string') slotNames.set(Number(slot), name)
    } catch {
      // struct missing from the dump — that slot just won't map
    }
  }

  // Staged matching, each stage consuming its matches: exact name, then
  // normalized (case / leading the-a / punctuation / ll→l), then a unique
  // token-subset for the stragglers ("Forgettable Tale..." ⊂ full title).
  const mapping: Record<number, number> = {}
  const questsLeft = new Map(questNames)
  const slotsLeft = new Map(slotNames)
  const take = (questId: number, slot: number) => {
    mapping[questId] = slot
    questsLeft.delete(questId)
    slotsLeft.delete(slot)
  }

  for (const pass of ['exact', 'norm'] as const) {
    const index = new Map<string, number[]>()
    for (const [qid, name] of questsLeft) {
      const key = pass === 'exact' ? name : normName(name)
      const list = index.get(key)
      if (list) list.push(qid)
      else index.set(key, [qid])
    }
    for (const [slot, name] of [...slotsLeft]) {
      const key = pass === 'exact' ? name : normName(name)
      const candidates = index.get(key) ?? []
      if (candidates.length === 1 && questsLeft.has(candidates[0])) take(candidates[0], slot)
    }
  }
  for (const [slot, name] of [...slotsLeft]) {
    const st = nameTokens(name)
    if (st.size === 0) continue
    const candidates = [...questsLeft].filter(([, qn]) => {
      const qt = nameTokens(qn)
      return isSubset(st, qt) || isSubset(qt, st)
    })
    if (candidates.length === 1) take(candidates[0][0], slot)
  }

  _questToSlot = mapping
  return mapping
}

// ---------------------------------------------------------------------------

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

// Max level per skill over this struct's reqs plus its whole prereq tree
// (slots → structs via enum 2252, cycle-safe).
async function accumulateSkillReqs(
  rootHandle: FileSystemDirectoryHandle,
  slotId: number,
): Promise<[number, number][]> {
  const slotToStruct = await getSlotToStruct(rootHandle)
  const best = new Map<number, number>()
  const visited = new Set<number>()

  async function visit(slot: number) {
    if (visited.has(slot)) return
    visited.add(slot)
    const structId = slotToStruct[slot]
    if (!structId) return
    let values: Record<string, unknown>
    try {
      values = await getStructValues(rootHandle, structId)
    } catch {
      return
    }
    for (const [skill, level] of extractSkillReqs(values)) {
      if ((best.get(skill) ?? 0) < level) best.set(skill, level)
    }
    for (const prereqSlot of extractPrereqSlots(values)) await visit(prereqSlot)
  }

  await visit(slotId)
  return [...best.entries()].sort((a, b) => a[0] - b[0])
}

async function writeStruct(
  rootHandle: FileSystemDirectoryHandle,
  structId: number,
  server: QuestServerData,
  questToSlot: Record<number, number>,
): Promise<void> {
  const structsHandle = await getStructsHandle(rootHandle)
  const fileHandle = await structsHandle.getFileHandle(`${structId}.json`)

  const file = await fileHandle.getFile()
  const json = JSON.parse(await file.text())
  const values: Record<string, unknown> = json.values ?? {}

  // startNpc
  if (server.startNpc >= 0) values['691'] = server.startNpc
  else delete values['691']

  // Interface name + sort name
  if (server.structName !== '') values['845'] = server.structName
  else delete values['845']
  if (server.structSortName !== '') values['846'] = server.structSortName
  else delete values['846']

  // slotId
  values['847'] = server.slotId

  // startLocation
  const { x, y, plane } = server.startLocation
  if (x !== 0 || y !== 0 || plane !== 0) values['850'] = encodeWorldTile(x, y, plane)
  else delete values['850']

  // Prereq quest IDs → slot IDs stored in keys 859-870
  for (let key = 859; key <= 870; key++) delete values[String(key)]
  server.prereqQuestIds
    .map((id) => questToSlot[id])
    .filter((slot): slot is number => slot != null)
    .forEach((slot, i) => { values[String(859 + i)] = slot })

  // Skill reqs → contiguous key pairs 871/872, 873/874, … Clearing a fixed 7
  // pairs left keys 885+ orphaned on the structs that carry more (the dump
  // goes up to 10 pairs / key 890 — struct 578), so clear the run that's
  // actually there. It stops at the first absent pair, which keeps the
  // unrelated fields just past the run (895, 898, …) untouched — verified
  // against the dump: every struct's pairs are contiguous with no gaps.
  for (let i = 0; i < MAX_SKILL_REQ_PAIRS; i++) {
    const skillKey = String(871 + i * 2)
    const levelKey = String(872 + i * 2)
    if (values[skillKey] === undefined && values[levelKey] === undefined) break
    delete values[skillKey]
    delete values[levelKey]
  }
  server.skillReqs.slice(0, MAX_SKILL_REQ_PAIRS).forEach(([skill, level], i) => {
    values[String(871 + i * 2)] = skill
    values[String(872 + i * 2)] = level
  })

  // Journal texts (948-951) — absent when empty, like the dump
  const journalKeys: [string, string][] = [
    ['948', server.journal.startHint],
    ['949', server.journal.requiredItems],
    ['950', server.journal.enemiesToDefeat],
    ['951', server.journal.rewards],
  ]
  for (const [key, text] of journalKeys) {
    if (text !== '') values[key] = text
    else delete values[key]
  }

  // Raw extras: the table owns every unmanaged key — drop the ones that were
  // removed, write the current rows (numeric strings become numbers so ids
  // stay ids).
  for (const key of Object.keys(values)) {
    if (!isManagedKey(Number(key))) delete values[key]
  }
  for (const [key, value] of server.extraValues) {
    if (isManagedKey(key)) continue
    values[String(key)] =
      typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value
  }

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
      const questToSlot = await getQuestToSlot(dirHandle, rootHandle)
      const slotId = questToSlot[quest.id as number]
      if (slotId == null) return { quest, server: null }

      const structId = slotToStruct[slotId]
      if (!structId) return { quest, server: null }

      const values = await getStructValues(rootHandle, structId)

      const startNpc = (values['691'] as number | undefined) ?? -1
      const slotIdFromStruct = (values['847'] as number | undefined) ?? -1
      const locHash = values['850'] as number | undefined
      const startLocation = locHash != null ? decodeWorldTile(locHash) : { x: 0, y: 0, plane: 0 }

      const skillReqs = extractSkillReqs(values)
      const slotToQuest: Record<number, number> = {}
      for (const [qid, slot] of Object.entries(questToSlot)) slotToQuest[slot] = Number(qid)
      const prereqQuestIds = extractPrereqSlots(values)
        .map((slot) => slotToQuest[slot])
        .filter((id): id is number => id != null)

      const journal = {
        startHint: (values['948'] as string | undefined) ?? '',
        requiredItems: (values['949'] as string | undefined) ?? '',
        enemiesToDefeat: (values['950'] as string | undefined) ?? '',
        rewards: (values['951'] as string | undefined) ?? '',
      }

      const extraValues: [number, string | number][] = Object.entries(values)
        .filter(([key]) => !isManagedKey(Number(key)))
        .map(([key, value]): [number, string | number] => [
          Number(key),
          typeof value === 'number' || typeof value === 'string' ? value : JSON.stringify(value),
        ])
        .sort((a, b) => a[0] - b[0])

      const preReqSkillReqs = await accumulateSkillReqs(rootHandle, slotIdFromStruct >= 0 ? slotIdFromStruct : slotId)

      const server: QuestServerData = {
        startNpc,
        startLocation,
        slotId: slotIdFromStruct,
        prereqQuestIds,
        skillReqs,
        structId,
        structName: (values['845'] as string | undefined) ?? '',
        structSortName: (values['846'] as string | undefined) ?? '',
        journal,
        extraValues,
        preReqSkillReqs,
      }
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

    if (server && _cachedRoot && server.structId) {
      const questToSlot = await getQuestToSlot(dirHandle, _cachedRoot)
      await writeStruct(_cachedRoot, server.structId, server, questToSlot)
    }
  },
}

export default loader
