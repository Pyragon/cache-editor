import type { CacheLoader, LoadedItem } from './types'

// Read-only loader for the dumped shaders index (JS5 index 31). The cryogen
// ShaderDefinitions dumper writes: glsl/<a>_<f>.vert|frag (readable OpenGL
// source — what we mirror in three.js), dxbc/<a>_<f>.dxbc (compiled DirectX
// bytecode), <Name>__<a>_<f>/manifest.json (program/uniform manifest), and a
// top-level index.json listing every entry.

export type ShaderIndexEntry = {
  archive: number
  file: number
  type?: 'glsl' | 'dxbc'
  kind?: string
  file_path?: string
  chars?: number
  strings?: string[]
  // manifest entries
  dir?: string
  name?: string
  vertexShaders?: number
  pixelShaders?: number
  programs?: number
}

export type ShaderData =
  | { kind: 'glsl'; lang: string; path: string; source: string }
  | { kind: 'dxbc'; path: string; strings: string[] }
  | { kind: 'manifest'; name: string; json: unknown }
  | { kind: 'error'; message: string }

async function readIndex(dir: FileSystemDirectoryHandle): Promise<ShaderIndexEntry[]> {
  try {
    const f = await (await dir.getFileHandle('index.json')).getFile()
    return JSON.parse(await f.text()) as ShaderIndexEntry[]
  } catch {
    return []
  }
}

async function readTextAtPath(dir: FileSystemDirectoryHandle, path: string): Promise<string> {
  const parts = path.split('/')
  let d = dir
  for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i])
  const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile()
  return f.text()
}

function labelFor(e: ShaderIndexEntry): string {
  if (e.type === 'glsl') return `${e.archive}/${e.file} · ${e.kind ?? 'glsl'}`
  if (e.type === 'dxbc') return `${e.archive}/${e.file} · dxbc`
  return `${e.name ?? 'shader'} · manifest ${e.archive}/${e.file}`
}

export const shadersLoader: CacheLoader = {
  async *streamItems(dir: FileSystemDirectoryHandle): AsyncGenerator<LoadedItem> {
    const idx = await readIndex(dir)
    // GLSL first (the useful source), then manifests, then dxbc
    const order = (e: ShaderIndexEntry) => (e.type === 'glsl' ? 0 : e.type === 'dxbc' ? 2 : 1)
    const withId = idx.map((e, i) => ({ e, i }))
    withId.sort((a, b) => order(a.e) - order(b.e) || a.i - b.i)
    for (const { e, i } of withId) yield { id: i, name: labelFor(e) }
  },

  async loadItem(dir: FileSystemDirectoryHandle, item: LoadedItem): Promise<ShaderData> {
    const idx = await readIndex(dir)
    const e = idx[item.id]
    if (!e) return { kind: 'error', message: 'shader entry not found' }
    try {
      if (e.type === 'glsl' && e.file_path) {
        return { kind: 'glsl', lang: e.kind ?? 'glsl', path: e.file_path, source: await readTextAtPath(dir, e.file_path) }
      }
      if (e.type === 'dxbc' && e.file_path) {
        return { kind: 'dxbc', path: e.file_path, strings: e.strings ?? [] }
      }
      if (e.dir) {
        const json = JSON.parse(await readTextAtPath(dir, `${e.dir}/manifest.json`))
        return { kind: 'manifest', name: e.name ?? e.dir, json }
      }
      return { kind: 'error', message: 'unrecognised shader entry' }
    } catch (err) {
      return { kind: 'error', message: String(err) }
    }
  },
}
