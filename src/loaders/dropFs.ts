// A read-only FileSystemDirectoryHandle shim for browsers without the File System
// Access API (Firefox), backed by a dragged-in folder.
//
// Why drag-and-drop rather than <input webkitdirectory>: an unpacked cache is ~980,000
// files, and webkitdirectory enumerates the WHOLE tree eagerly into a FileList before
// handing it over. Firefox would spend minutes and hundreds of MB doing that before the
// app saw a single byte. `DataTransferItem.webkitGetAsEntry()` gives a
// FileSystemDirectoryEntry whose readEntries() is lazy, one directory at a time — the
// same shape as the real handle API, so the loaders don't know the difference.
//
// Writes can't go back to disk (no browser API for it outside Chromium), so instead
// they're CAPTURED here, keyed by their path relative to the cache root. App.tsx then
// offers them as a download. Doing it at this layer means every loader's save path —
// including the ones that touch several files at once, like textures writing both
// texture_definitions/<id>.json and textures/<id>/<id>.json — works untouched.

// --- the legacy Entry API, which TS doesn't ship types for -------------------
type FsEntry = {
  name: string
  isFile: boolean
  isDirectory: boolean
  file(cb: (file: File) => void, err?: (e: unknown) => void): void
  createReader(): { readEntries(cb: (entries: FsEntry[]) => void, err?: (e: unknown) => void): void }
}

export type CapturedFile = { path: string; blob: Blob }

/** Files a save produced, keyed by path relative to the cache root. */
export class WriteCapture {
  private files = new Map<string, Blob>()

  add(path: string, blob: Blob) {
    this.files.set(path, blob)
  }

  take(): CapturedFile[] {
    const out = [...this.files].map(([path, blob]) => ({ path, blob }))
    this.files.clear()
    return out
  }

  get size() {
    return this.files.size
  }
}

// readEntries only returns a batch at a time (100 in most engines) and signals the
// end with an empty array, so it has to be drained in a loop.
function readAll(entry: FsEntry): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader()
    const found: FsEntry[] = []

    const next = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(found)
          return
        }
        found.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

function toFile(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

class DropFileHandle {
  readonly kind = 'file' as const
  readonly name: string
  private entry: FsEntry | null
  private path: string
  private capture: WriteCapture

  constructor(name: string, entry: FsEntry | null, path: string, capture: WriteCapture) {
    this.name = name
    this.entry = entry
    this.path = path
    this.capture = capture
  }

  async getFile(): Promise<File> {
    if (!this.entry) throw new DOMException(`${this.name} not found`, 'NotFoundError')
    return toFile(this.entry)
  }

  // Nothing reaches disk — the bytes are collected and offered as a download.
  async createWritable() {
    const chunks: BlobPart[] = []
    const path = this.path
    const capture = this.capture

    return {
      async write(data: BlobPart) {
        chunks.push(data)
      },
      async close() {
        capture.add(path, new Blob(chunks))
      },
    }
  }
}

class DropDirectoryHandle {
  readonly kind = 'directory' as const
  readonly name: string
  private children: Promise<Map<string, FsEntry>> | null = null
  private entry: FsEntry
  private path: string
  private capture: WriteCapture

  constructor(name: string, entry: FsEntry, path: string, capture: WriteCapture) {
    this.name = name
    this.entry = entry
    this.path = path
    this.capture = capture
  }

  private list(): Promise<Map<string, FsEntry>> {
    // cached, because the sidebar and the loaders both walk the same folders
    this.children ??= readAll(this.entry).then((entries) => new Map(entries.map((e) => [e.name, e])))
    return this.children
  }

  private child(name: string) {
    return this.path ? `${this.path}/${name}` : name
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DropDirectoryHandle> {
    const found = (await this.list()).get(name)
    if (!found || !found.isDirectory) {
      // `create` can't make a real folder, but a save writing into a new folder
      // (textures/<id>/) still needs somewhere to put its file — so hand back a
      // handle that exists only to build the captured path.
      if (options?.create) {
        return new DropDirectoryHandle(name, MISSING, this.child(name), this.capture)
      }
      throw new DOMException(`${name} not found`, 'NotFoundError')
    }
    return new DropDirectoryHandle(name, found, this.child(name), this.capture)
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<DropFileHandle> {
    const found = (await this.list()).get(name)
    if (!found || !found.isFile) {
      if (options?.create) {
        return new DropFileHandle(name, null, this.child(name), this.capture)
      }
      throw new DOMException(`${name} not found`, 'NotFoundError')
    }
    return new DropFileHandle(name, found, this.child(name), this.capture)
  }

  async *values(): AsyncGenerator<DropDirectoryHandle | DropFileHandle> {
    for (const entry of (await this.list()).values()) {
      yield entry.isDirectory
        ? new DropDirectoryHandle(entry.name, entry, this.child(entry.name), this.capture)
        : new DropFileHandle(entry.name, entry, this.child(entry.name), this.capture)
    }
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of (await this.list()).keys()) yield name
  }

  async *entries(): AsyncGenerator<[string, DropDirectoryHandle | DropFileHandle]> {
    for await (const handle of this.values()) yield [handle.name, handle]
  }

  async removeEntry(_name: string): Promise<void> {
    throw new DOMException('This browser cannot delete files in the cache folder.', 'NotAllowedError')
  }
}

// A stand-in for a folder that doesn't exist on disk yet; only ever used to build
// paths for captured writes, so listing it is legitimately empty.
const MISSING: FsEntry = {
  name: '',
  isFile: false,
  isDirectory: true,
  file: (_cb, err) => err?.(new DOMException('not on disk', 'NotFoundError')),
  createReader: () => ({ readEntries: (cb) => cb([]) }),
}

/** Builds a read-only cache root from a dropped folder, or null if it wasn't one. */
export function dropToDirectoryHandle(
  item: DataTransferItem,
  capture: WriteCapture,
): FileSystemDirectoryHandle | null {
  const entry = (item as unknown as { webkitGetAsEntry(): FsEntry | null }).webkitGetAsEntry()
  if (!entry || !entry.isDirectory) return null

  // The shim implements the subset the app actually uses; the structural cast keeps
  // every loader on the real type.
  return new DropDirectoryHandle(entry.name, entry, '', capture) as unknown as FileSystemDirectoryHandle
}

// --- downloading what a save produced ---------------------------------------

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A minimal STORED (uncompressed) zip. The cache dump is mostly small JSON, and this
 * avoids pulling in a compression dependency for a fallback path.
 */
async function zip(files: CapturedFile[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const local: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0

  for (const { path, blob } of files) {
    const name = encoder.encode(path)
    const data = new Uint8Array(await blob.arrayBuffer())
    const sum = crc32(data)

    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 0, true)
    header.setUint16(8, 0, true) // stored
    header.setUint16(10, 0, true)
    header.setUint16(12, 0, true)
    header.setUint32(14, sum, true)
    header.setUint32(18, data.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, name.length, true)
    header.setUint16(28, 0, true)

    local.push(header.buffer, name, data)

    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0, true)
    entry.setUint16(10, 0, true)
    entry.setUint16(12, 0, true)
    entry.setUint16(14, 0, true)
    entry.setUint32(16, sum, true)
    entry.setUint32(20, data.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint16(30, 0, true)
    entry.setUint16(32, 0, true)
    entry.setUint16(34, 0, true)
    entry.setUint16(36, 0, true)
    entry.setUint32(38, 0, true)
    entry.setUint32(42, offset, true)

    central.push(entry.buffer, name)
    offset += 30 + name.length + data.length
  }

  const centralSize = central.reduce((n, part) => n + (part as ArrayBuffer | Uint8Array).byteLength, 0)

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  end.setUint16(20, 0, true)

  return new Blob([...local, ...central, end.buffer], { type: 'application/zip' })
}

/**
 * Hands the files a save produced to the user, since they can't be written in place.
 * A single file downloads as itself; several download as one zip whose paths mirror
 * the cache layout, so it can be extracted straight over `unpacked/`.
 */
export async function downloadCaptured(files: CapturedFile[], label: string): Promise<string> {
  if (!files.length) return ''

  if (files.length === 1) {
    const { path, blob } = files[0]
    const name = path.split('/').pop() ?? 'file'
    download(blob, name)
    return `Downloaded ${name} — copy it over unpacked/${path}`
  }

  download(await zip(files), `${label}.zip`)
  return `Downloaded ${label}.zip with ${files.length} files — extract it over your unpacked/ folder (paths already match).`
}
