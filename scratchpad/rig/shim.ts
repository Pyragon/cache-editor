/**
 * Filesystem shim standing in for the File System Access API, so the REAL
 * `src/procgen` modules can be measured in Node without being reimplemented.
 * Only the three things procgen actually touches are provided: `.values()`,
 * `getFile().text()`, and a no-op localStorage.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

function fileHandle(dir: string, name: string): any {
  return {
    kind: 'file',
    name,
    async getFile() {
      return {
        async text() { return fs.readFile(path.join(dir, name), 'utf8') },
        // Models are raw bytes, not text — the marker-model filter parses them.
        async arrayBuffer() {
          const b = await fs.readFile(path.join(dir, name))
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
        },
      }
    },
  }
}

export function dirHandle(dir: string): any {
  return {
    kind: 'directory',
    name: path.basename(dir),
    async *values() {
      const names = await fs.readdir(dir, { withFileTypes: true })
      for (const e of names) {
        if (e.isFile()) yield fileHandle(dir, e.name)
        else yield dirHandle(path.join(dir, e.name))
      }
    },
    async getFileHandle(name: string) { return fileHandle(dir, name) },
    async getDirectoryHandle(name: string) { return dirHandle(path.join(dir, name)) },
  }
}

/** procgen persists its index to localStorage; in the rig that must be inert. */
export function installShims() {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  // modelStore writes to IndexedDB; every call there resolves rather than
  // rejects, so leaving it absent is safe, but be explicit about it.
  ;(globalThis as any).indexedDB = undefined
}
