import type { CacheLoader } from './types'

// World map terrain + locations (IndexType.MAPS). One region is 64x64 tiles
// across 4 planes. Dumped by cryogen MapDefinitions as one JSON per region
// (id = (regionX << 8) | regionY), with per-tile channels packed into
// base64'd byte arrays (plane-major, then x, then y) rather than verbose
// nested JSON — 2000+ regions of per-tile objects would be enormous.
export type MapRegionDef = {
  id: number
  regionX: number
  regionY: number
  hasTerrain: boolean
  hasLocations: boolean
  underlayIds: string
  overlayIds: string
  overlayShapeRot: string
  tileFlags: string
  heightPresence: string
  heightValue: string
  /** [objectId, type, rotation, x, y, plane] per placed object. */
  objects: [number, number, number, number, number, number][]
}

export const PLANES = 4
export const SIZE = 64
export const TILES = PLANES * SIZE * SIZE

export function tileIndex(plane: number, x: number, y: number): number {
  return plane * SIZE * SIZE + x * SIZE + y
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Decoded, mutable view of one region's terrain channels.
export type MapTerrain = {
  underlayIds: Uint8Array
  overlayIds: Uint8Array
  /** Packed (pathShape << 2) | rotation. */
  overlayShapeRot: Uint8Array
  tileFlags: Uint8Array
  heightPresence: Uint8Array
  heightValue: Uint8Array
}

export function decodeTerrain(def: MapRegionDef): MapTerrain {
  return {
    underlayIds: b64ToBytes(def.underlayIds),
    overlayIds: b64ToBytes(def.overlayIds),
    overlayShapeRot: b64ToBytes(def.overlayShapeRot),
    tileFlags: b64ToBytes(def.tileFlags),
    heightPresence: b64ToBytes(def.heightPresence),
    heightValue: b64ToBytes(def.heightValue),
  }
}

export function encodeTerrain(def: MapRegionDef, terrain: MapTerrain): MapRegionDef {
  return {
    ...def,
    underlayIds: bytesToB64(terrain.underlayIds),
    overlayIds: bytesToB64(terrain.overlayIds),
    overlayShapeRot: bytesToB64(terrain.overlayShapeRot),
    tileFlags: bytesToB64(terrain.tileFlags),
    heightPresence: bytesToB64(terrain.heightPresence),
    heightValue: bytesToB64(terrain.heightValue),
  }
}

// Minimal underlay/overlay colour lookups for the preview — id -> raw RGB
// (0 / NO_COLOR sentinel handling happens in the viewer).
export type ColorLookup = Map<number, number>

export type MapData = {
  id: number
  def: MapRegionDef
  terrain: MapTerrain
  underlayColors: ColorLookup
  overlayColors: ColorLookup
}

async function loadColorLookup(
  rootHandle: FileSystemDirectoryHandle,
  entryName: string,
  colorKey: string,
): Promise<ColorLookup> {
  const lookup: ColorLookup = new Map()
  try {
    const configDir = await rootHandle.getDirectoryHandle('config')
    const dir = await configDir.getDirectoryHandle(entryName)
    const reads: Promise<void>[] = []
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.replace('.json', ''), 10)
      if (isNaN(id)) continue
      reads.push((async () => {
        try {
          const file = await handle.getFile()
          const json = JSON.parse(await file.text())
          lookup.set(id, json[colorKey] ?? 0)
        } catch {
          // skip unreadable entries
        }
      })())
    }
    await Promise.all(reads)
  } catch {
    // underlays/overlays not dumped — preview falls back to a neutral grid
  }
  return lookup
}

// Cached across selections within a session — the same 170+247 tiny files
// back every region's preview, no need to re-read them per region.
let _cachedRoot: FileSystemDirectoryHandle | null = null
let _underlayColors: ColorLookup | null = null
let _overlayColors: ColorLookup | null = null

async function getColorLookups(rootHandle: FileSystemDirectoryHandle): Promise<[ColorLookup, ColorLookup]> {
  if (_cachedRoot !== rootHandle || !_underlayColors || !_overlayColors) {
    _cachedRoot = rootHandle
    ;[_underlayColors, _overlayColors] = await Promise.all([
      loadColorLookup(rootHandle, 'underlays', 'rgb'),
      loadColorLookup(rootHandle, 'overlays', 'colorRgb'),
    ])
  }
  return [_underlayColors, _overlayColors]
}

const loader: CacheLoader = {
  // Named by region coordinates (not just the numeric regionId), so typing
  // "52,52" in the sidebar filter finds a region directly — world tile
  // (x, y) is (regionX*64 + localX, regionY*64 + localY).
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (isNaN(id)) continue
      const regionX = id >> 8
      const regionY = id & 0xff
      yield { id, name: `${regionX},${regionY}` }
    }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as MapRegionDef
    const terrain = decodeTerrain(def)

    const [underlayColors, overlayColors] = rootHandle
      ? await getColorLookups(rootHandle)
      : [new Map(), new Map()]

    return { id: item.id, def, terrain, underlayColors, overlayColors } satisfies MapData
  },

  async saveItem(dirHandle, item, data) {
    const { def, terrain } = data as MapData
    const encoded = encodeTerrain(def, terrain)
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(encoded))
    await writable.close()
  },
}

export default loader
