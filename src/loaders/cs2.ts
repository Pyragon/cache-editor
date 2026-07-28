import type { CacheLoader, LoadedItem } from './types'

// CS2 scripts are dumped by cryogen as decompiled TypeScript-style source (docs/cs2.md).
// Scripts the decompiler couldn't structure (or that failed byte-identity verification) are
// dumped in assembly text form instead, marked by a "// FALLBACK" first line — those are listed
// with an "· asm" suffix so they can be studied as a group (filter the sidebar for "asm").
// Saving writes the text back; cryogen's CacheBuilder recompiles it on repack.

export interface CS2Script {
  id: number
  source: string
  isFallback: boolean
  /** The reason the script fell back to asm form (from its first line), if it did. */
  fallbackReason: string | null
  /** True when the file holds raw bytecode (a stray/corrupt file), not text. */
  isBinary: boolean
}

const FALLBACK_PREFIX = '// FALLBACK'

const loader: CacheLoader = {
  async *streamItems(dirHandle) {
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.cs2')) continue
      const id = parseInt(handle.name.slice(0, -4), 10)
      if (isNaN(id)) continue
      // sniff just the head for the fallback marker — cheap even across ~6.5k files
      const file = await (handle as FileSystemFileHandle).getFile()
      const head = await file.slice(0, FALLBACK_PREFIX.length).text()
      const isFallback = head === FALLBACK_PREFIX
      yield { id, name: isFallback ? `${id} · asm` : String(id) } satisfies LoadedItem
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.cs2`)
    const file = await fileHandle.getFile()
    const source = await file.text()
    const isFallback = source.startsWith(FALLBACK_PREFIX)
    const fallbackReason = isFallback
      ? source.slice(0, source.indexOf('\n')).replace(`${FALLBACK_PREFIX} (asm form): `, '')
      : null
    return { id: item.id, source, isFallback, fallbackReason, isBinary: source.includes('\0') } satisfies CS2Script
  },

  async saveItem(dirHandle, item, data) {
    const script = data as CS2Script
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.cs2`, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(script.source)
    await writable.close()
  },

  async createItem(dirHandle) {
    // next free id, then a minimal compilable skeleton: no args, void return
    let maxId = -1
    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.cs2')) continue
      const id = parseInt(handle.name.slice(0, -4), 10)
      if (!isNaN(id) && id > maxId) maxId = id
    }
    const id = maxId + 1
    const source = `function script_${id}(): void {\n\treturn;\n}\n`
    const fileHandle = await dirHandle.getFileHandle(`${id}.cs2`, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(source)
    await writable.close()
    return { id, name: String(id) }
  },

  async deleteItem(dirHandle, item) {
    await dirHandle.removeEntry(`${item.id}.cs2`)
  },
}

export default loader
