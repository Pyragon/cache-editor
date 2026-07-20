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

/** One placed-object entry: [objectId, type, rotation, x, y, plane]. */
export type LocEntry = MapRegionDef['objects'][number]

// cryogen Region.OBJECT_SLOTS — which of the 4 placement slots a location's
// `type` (0-22) occupies: 0 wall, 1 wall decoration, 2 floor (scenery, by
// far the most common), 3 floor decoration (ground-item-like).
export const OBJECT_SLOTS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3]
export const SLOT_COLORS = ['#ff5a5a', '#ffa64d', '#4d9fff', '#4dd97f']
export const SLOT_LABELS = ['Wall', 'Wall Decoration', 'Floor', 'Floor Decoration']

/** Friendly names for all 23 placement types — darkan ObjectShapes.kt. */
export const LOC_TYPE_LABELS = [
  'Straight wall', // WALL_STRAIGHT
  'Diagonal corner wall', // WALL_DIAGONAL_CORNER
  'Whole corner wall', // WALL_WHOLE_CORNER
  'Straight corner wall', // WALL_STRAIGHT_CORNER
  'Wall decoration (straight, inside)', // STRAIGHT_INSIDE_WALL_DEC
  'Wall decoration (straight, outside)', // STRAIGHT_OUSIDE_WALL_DEC
  'Wall decoration (diagonal, outside)', // DIAGONAL_OUTSIDE_WALL_DEC
  'Wall decoration (diagonal, inside)', // DIAGONAL_INSIDE_WALL_DEC
  'Wall decoration (in-wall)', // DIAGONAL_INWALL_DEC
  'Diagonal wall', // WALL_INTERACT
  'Scenery', // SCENERY_INTERACT
  'Diagonal scenery', // GROUND_INTERACT
  'Roof (straight slope)', // STRAIGHT_SLOPE_ROOF
  'Roof (diagonal slope)', // DIAGONAL_SLOPE_ROOF
  'Roof (diagonal slope, connector)', // DIAGONAL_SLOPE_CONNECT_ROOF
  'Roof (slope corner, connector)', // STRAIGHT_SLOPE_CORNER_CONNECT_ROOF
  'Roof (slope corner)', // STRAIGHT_SLOPE_CORNER_ROOF
  'Roof (flat)', // STRAIGHT_FLAT_ROOF
  'Roof edge (straight)', // STRAIGHT_BOTTOM_EDGE_ROOF
  'Roof edge (diagonal, connector)', // DIAGONAL_BOTTOM_EDGE_CONNECT_ROOF
  'Roof edge (straight, connector)', // STRAIGHT_BOTTOM_EDGE_CONNECT_ROOF
  'Roof edge (corner, connector)', // STRAIGHT_BOTTOM_EDGE_CONNECT_CORNER_ROOF
  'Ground decoration', // GROUND_DECORATION
]

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

/** Build a brand-new region def, optionally pre-filled with a flat plane-0
 *  ground slab (explicit height 0 + the given underlay), so there's a
 *  clickable surface to start building on. Without the fill the region is an
 *  empty void — no tiles emit geometry, so nothing can be clicked or placed. */
export function createRegionDef(regionX: number, regionY: number, fill?: { underlayId: number }): MapRegionDef {
  const terrain: MapTerrain = {
    underlayIds: new Uint8Array(TILES),
    overlayIds: new Uint8Array(TILES),
    overlayShapeRot: new Uint8Array(TILES),
    tileFlags: new Uint8Array(TILES),
    heightPresence: new Uint8Array(TILES / 8),
    heightValue: new Uint8Array(TILES),
  }
  if (fill) {
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        const idx = tileIndex(0, x, y)
        terrain.underlayIds[idx] = fill.underlayId & 0xff
        // explicit flat height 0 (stored value 1 is the height-0 sentinel) —
        // otherwise plane 0 rolls with the client's default Perlin noise
        terrain.heightValue[idx] = 1
        terrain.heightPresence[idx >> 3] |= 1 << (idx & 0x7)
      }
    }
  }
  const skeleton: MapRegionDef = {
    id: (regionX << 8) | regionY,
    regionX,
    regionY,
    hasTerrain: true,
    hasLocations: true,
    underlayIds: '', overlayIds: '', overlayShapeRot: '',
    tileFlags: '', heightPresence: '', heightValue: '',
    objects: [],
  }
  return encodeTerrain(skeleton, terrain)
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
  /** Cache root, for the 3D scene view's on-demand config/model loads. */
  rootHandle?: FileSystemDirectoryHandle
}

/** The maps entry is a single world viewer (noPanel), not a per-region item
 *  list — its "content" is just the handles the viewer loads regions through. */
export type WorldMapData = {
  kind: 'world'
  mapsDir: FileSystemDirectoryHandle
  rootHandle?: FileSystemDirectoryHandle
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

/** Load one region (id = (regionX << 8) | regionY) with its colour lookups.
 *  Throws if that region isn't in the dump. */
export async function loadRegion(
  mapsDir: FileSystemDirectoryHandle,
  rootHandle: FileSystemDirectoryHandle | undefined,
  regionId: number,
): Promise<MapData> {
  const fileHandle = await mapsDir.getFileHandle(`${regionId}.json`)
  const file = await fileHandle.getFile()
  const def = JSON.parse(await file.text()) as MapRegionDef
  const terrain = decodeTerrain(def)

  const [underlayColors, overlayColors] = rootHandle
    ? await getColorLookups(rootHandle)
    : [new Map<number, number>(), new Map<number, number>()]

  return { id: regionId, def, terrain, underlayColors, overlayColors, rootHandle }
}

/** Persist a region's terrain back to its own <regionId>.json. */
export async function saveRegion(mapsDir: FileSystemDirectoryHandle, data: MapData): Promise<void> {
  const encoded = encodeTerrain(data.def, data.terrain)
  const fileHandle = await mapsDir.getFileHandle(`${data.id}.json`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(encoded))
  await writable.close()
}

const loader: CacheLoader = {
  noPanel: true,

  // noPanel: never called, but the interface requires it.
  // eslint-disable-next-line require-yield
  async *streamItems() {},

  // The world viewer loads/saves regions on demand through these handles as
  // the user moves around — there is no per-region "selected item".
  async loadItem(dirHandle, _item, rootHandle) {
    return { kind: 'world', mapsDir: dirHandle, rootHandle } satisfies WorldMapData
  },
}

export default loader
