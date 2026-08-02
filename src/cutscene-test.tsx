import { createRoot } from 'react-dom/client'
import CutscenePlayer from './components/CutscenePlayer'
import type { CutsceneDef } from './loaders/cutscenes'
import './index.css'

// Render-rig harness for the cutscene player (see scripts/render-rig): mounts
// CutscenePlayer against the dump-server's fake directory handle, the same way
// map-test.tsx mounts MapViewer. `?cs=<id>` picks the cutscene.

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
    const id = params.get('cs') ?? '12'
    const res = await fetch(`${BASE}/cutscenes/${id}.json`)
    if (!res.ok) throw new Error(`cutscene ${id}: ${res.status}`)
    const def = await res.json() as CutsceneDef
    createRoot(document.getElementById('root')!).render(
      <CutscenePlayer def={def} rootHandle={root} unit="cycles" />,
    )
  } catch (e: any) { (window as any).__error = String(e?.stack ?? e) }
})()
