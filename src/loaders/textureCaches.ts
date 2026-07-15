// Faithful port of cryogen's ColorImageCache / MonochromeImageCache.
//
// These look like a pure memory optimisation, but they are NOT: an op hands out a
// REFERENCE to a cached row, and if something else then asks the same op for a
// different row, the LRU can hand back the very same buffer and overwrite it. The
// composition step in getPixelsArgb grabs the colour row first and the opacity row
// second — and the opacity chain can evict the colour row it is still holding.
//
// That aliasing is baked into the textures the client ships, so reproducing it is
// required, not optional. Which also means `imageCacheCapacity` matters.

class Entry {
  next: Entry | null = null
  previous: Entry | null = null
  readonly row: number
  readonly slot: number

  constructor(row: number, slot: number) {
    this.row = row
    this.slot = slot
  }

  unlink() {
    if (this.previous) {
      this.previous.next = this.next
      this.next!.previous = this.previous
      this.next = null
      this.previous = null
    }
  }
}

// A sentinel-headed doubly-linked list: insertFront on access, and getNext()
// returns head.previous — the least recently used entry.
class Lru {
  private head = new Entry(-1, -1)

  constructor() {
    this.head.next = this.head
    this.head.previous = this.head
  }

  insertFront(entry: Entry) {
    if (entry.previous) entry.unlink()
    entry.previous = this.head
    entry.next = this.head.next
    entry.previous.next = entry
    entry.next!.previous = entry
  }

  /** The eviction victim. */
  getNext(): Entry | null {
    const node = this.head.previous!
    return node === this.head ? null : node
  }
}

export class ColorImageCache {
  dirty = false
  private entries: (Entry | null)[]
  private data: [Int32Array, Int32Array, Int32Array][]
  private lru = new Lru()
  private cachedRowCount = 0
  private lastAccessedRow = -1

  readonly maxCachedRows: number
  readonly totalRows: number

  constructor(maxCachedRows: number, totalRows: number, width: number) {
    this.maxCachedRows = maxCachedRows
    this.totalRows = totalRows
    this.data = []
    for (let i = 0; i < maxCachedRows; i++) {
      this.data.push([new Int32Array(width), new Int32Array(width), new Int32Array(width)])
    }
    this.entries = new Array(totalRows).fill(null)
  }

  getPalette(row: number): [Int32Array, Int32Array, Int32Array] {
    if (this.totalRows === this.maxCachedRows) {
      this.dirty = this.entries[row] === null
      this.entries[row] = SENTINEL
      return this.data[row]
    }

    if (this.maxCachedRows === 1) {
      this.dirty = this.lastAccessedRow !== row
      this.lastAccessedRow = row
      return this.data[0]
    }

    let entry = this.entries[row]
    if (entry === null) {
      this.dirty = true
      if (this.cachedRowCount >= this.maxCachedRows) {
        const victim = this.lru.getNext()!
        entry = new Entry(row, victim.slot)
        this.entries[victim.row] = null
        victim.unlink()
      } else {
        entry = new Entry(row, this.cachedRowCount++)
      }
      this.entries[row] = entry
    } else {
      this.dirty = false
    }
    this.lru.insertFront(entry)
    return this.data[entry.slot]
  }

  /** Only valid when every row is resident — the ops that draw the whole tile at once. */
  getAllPalettes(): [Int32Array, Int32Array, Int32Array][] {
    if (this.maxCachedRows !== this.totalRows) throw new Error('getAllPalettes needs a full-height cache')
    for (let i = 0; i < this.maxCachedRows; i++) this.entries[i] = SENTINEL
    return this.data
  }
}

export class MonochromeImageCache {
  dirty = false
  private entries: (Entry | null)[]
  private data: Int32Array[]
  private lru = new Lru()
  private allocated = 0
  private lastUsed = -1

  readonly paletteSize: number
  readonly maxCachedEntries: number

  constructor(paletteSize: number, maxCachedEntries: number, width: number) {
    this.paletteSize = paletteSize
    this.maxCachedEntries = maxCachedEntries
    this.data = []
    for (let i = 0; i < paletteSize; i++) this.data.push(new Int32Array(width))
    this.entries = new Array(maxCachedEntries).fill(null)
  }

  getPalette(row: number): Int32Array {
    if (this.maxCachedEntries === this.paletteSize) {
      this.dirty = this.entries[row] === null
      this.entries[row] = SENTINEL
      return this.data[row]
    }

    if (this.paletteSize !== 1) {
      let entry = this.entries[row]
      if (entry === null) {
        this.dirty = true
        if (this.allocated >= this.paletteSize) {
          const victim = this.lru.getNext()!
          entry = new Entry(row, victim.slot)
          this.entries[victim.row] = null
          victim.unlink()
        } else {
          entry = new Entry(row, this.allocated++)
        }
        this.entries[row] = entry
      } else {
        this.dirty = false
      }
      this.lru.insertFront(entry)
      return this.data[entry.slot]
    }

    this.dirty = this.lastUsed !== row
    this.lastUsed = row
    return this.data[0]
  }

  getAllPaletteData(): Int32Array[] {
    if (this.paletteSize !== this.maxCachedEntries) throw new Error('getAllPaletteData needs a full-height cache')
    for (let i = 0; i < this.paletteSize; i++) this.entries[i] = SENTINEL
    return this.data
  }
}

const SENTINEL = new Entry(0, 0)
