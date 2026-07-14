import type { CacheLoader, LoadedItem } from './types'

// Fields per darkan-bot-refactor WorldMapElement.kt / WorldMapPlacement.kt
// (areaName kept over darkan's displayName; dump filenames are "<id> - <areaName>.json").
export type MapAreaRect = {
  plane: number
  startX: number
  startY: number
  endX: number
  endY: number
  mapMinX: number
  mapMinY: number
  mapMaxX: number
  mapMaxY: number
}

export type MapAreaDef = {
  id: number
  filenamePrefix: string
  areaName: string
  bitpackedPlacement: number
  color: number
  shouldRender: boolean
  defaultZoomLevel: number
  mapSize: string
  boundsMinX: number
  boundsMaxX: number
  boundsMinY: number
  boundsMaxY: number
  areaRects: MapAreaRect[]
}

export type MapAreaData = {
  id: number
  def: MapAreaDef
}

function fileNameFor(def: MapAreaDef): string {
  return `${def.id} - ${def.areaName}.json`
}

// The bounds fields aren't part of the cache encoding — cryogen derives them
// from the rects' map coordinates on load. Keep them consistent on save.
function recomputeBounds(def: MapAreaDef): MapAreaDef {
  let minX = 12800, maxX = 0, minY = 12800, maxY = 0
  for (const rect of def.areaRects ?? []) {
    if (rect.mapMinX < minX) minX = rect.mapMinX
    if (rect.mapMaxX > maxX) maxX = rect.mapMaxX
    if (rect.mapMinY < minY) minY = rect.mapMinY
    if (rect.mapMaxY > maxY) maxY = rect.mapMaxY
  }
  return { ...def, boundsMinX: minX, boundsMaxX: maxX, boundsMinY: minY, boundsMaxY: maxY }
}

async function writeDef(dirHandle: FileSystemDirectoryHandle, def: MapAreaDef) {
  const fileHandle = await dirHandle.getFileHandle(fileNameFor(def), { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(def, null, 2))
  await writable.close()
}

async function nextFreeId(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let maxId = -1
  for await (const handle of dirHandle.values()) {
    const match = handle.name.match(/^(\d+) - /)
    if (match) maxId = Math.max(maxId, parseInt(match[1], 10))
  }
  return maxId + 1
}

const NEW_AREA_DEFAULTS: Omit<MapAreaDef, 'id' | 'areaName'> = {
  filenamePrefix: '',
  bitpackedPlacement: 0,
  color: -1,
  shouldRender: true,
  defaultZoomLevel: 0,
  mapSize: 'SIZE_104',
  boundsMinX: 12800,
  boundsMaxX: 0,
  boundsMinY: 12800,
  boundsMaxY: 0,
  areaRects: [],
}

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      // (.*) not (.+) — area 44 has an empty name ("44 - .json")
      const match = handle.name.match(/^(\d+) - (.*)\.json$/)
      if (!match) continue
      yield { id: parseInt(match[1], 10), name: `${match[1]} - ${match[2]}` } satisfies LoadedItem
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as MapAreaDef
    return { id: item.id, def } satisfies MapAreaData
  },

  async saveItem(dirHandle, item, data) {
    const def = recomputeBounds((data as MapAreaData).def)
    await writeDef(dirHandle, def)
    // Renaming the area changes the dump filename — drop the old file.
    if (fileNameFor(def) !== `${item.name}.json`) {
      try {
        await dirHandle.removeEntry(`${item.name}.json`)
      } catch {
        // old file already gone
      }
    }
  },

  async createItem(dirHandle) {
    const id = await nextFreeId(dirHandle)
    const def: MapAreaDef = { id, areaName: `Area ${id}`, ...NEW_AREA_DEFAULTS }
    await writeDef(dirHandle, def)
    return { id, name: `${id} - ${def.areaName}` }
  },

  async deleteItem(dirHandle, item) {
    await dirHandle.removeEntry(`${item.name}.json`)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.name}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as MapAreaDef

    const id = await nextFreeId(dirHandle)
    const def = { ...source, id }
    await writeDef(dirHandle, def)
    return { id, name: `${id} - ${def.areaName}` }
  },
}

export default loader
