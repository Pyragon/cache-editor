import { createRoot } from 'react-dom/client'
import MapViewer from './components/MapViewer'
import type { WorldMapData } from './loaders/maps'
import { resolveEntryHandle, getEntryPath } from './loaders/entryOrder'
import './index.css'

const params = new URLSearchParams(location.search)
const BASE = `http://127.0.0.1:${params.get('dump') ?? '8787'}`

function fileHandle(path: string, name: string): any {
  return { kind: 'file', name, async getFile() {
    const res = await fetch(`${BASE}/${path ? path + '/' : ''}${name}`)
    if (!res.ok) throw new Error(`${res.status} ${path}/${name}`)
    return new Blob([await res.arrayBuffer()])
  } }
}
function fetchDir(path: string, name = ''): any {
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(n: string) { return fetchDir(path ? `${path}/${n}` : n, n) },
    async getFileHandle(n: string) { return fileHandle(path, n) },
    async *values() {
      const res = await fetch(`${BASE}/__ls?path=${encodeURIComponent(path)}`)
      if (!res.ok) return
      for (const e of await res.json() as { name: string; kind: string }[]) {
        yield e.kind === 'directory'
          ? fetchDir(path ? `${path}/${e.name}` : e.name, e.name)
          : fileHandle(path, e.name)
      }
    },
  }
}

;(async () => {
  try {
    const root = fetchDir('') as unknown as FileSystemDirectoryHandle
    const mapsDir = await resolveEntryHandle(root, getEntryPath('maps'))
    if (!mapsDir) throw new Error('no maps dir')
    const world: WorldMapData = { kind: 'world', mapsDir, rootHandle: root }
    createRoot(document.getElementById('root')!).render(<MapViewer world={world} onDirtyChange={() => {}} />)
  } catch (e: any) { (window as any).__error = String(e?.stack ?? e) }
})()
