import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import GameframePreview from './components/GameframePreview'
import Cs2ScriptModal from './components/Cs2ScriptModal'
import { InterfaceAssets } from './components/interfacePreview'
import { loadInterfaceById } from './loaders/interfaces'
import type { InterfaceData } from './loaders/interfaces'
import './index.css'
// The app bundles every component stylesheet into one global sheet, so rules
// from viewers this page never renders still apply in the real app. Pull the
// shared ones in or the harness tests a DIFFERENT cascade than production —
// which is how `.anim-preview-body`'s hard 960px width passed a rig check and
// still broke the script modal on screen.
import './components/AnimationViewer.css'
import './components/ItemViewer.css'
import './components/QuestViewer.css'
import './components/InterfaceViewer.css'

// Render-rig harness for the gameframe preview (see scripts/render-rig):
// mounts GameframePreview against the dump-server's fake directory handle.
// `?iface=<id>` picks the interface plugged into the central slot (default
// 190, the quest tab — a small, sprite-and-text interface).
// `?script=<id>` instead mounts the read-only CS2 script modal, for checking
// that it sizes itself to the script it's showing.

const params = new URLSearchParams(location.search)
const BASE = `http://127.0.0.1:${params.get('dump') ?? '8787'}`

function fileHandle(path: string, name: string): unknown {
  return { kind: 'file', name, async getFile() {
    const res = await fetch(`${BASE}/${path ? path + '/' : ''}${name}`)
    if (!res.ok) throw new Error(`${res.status} ${path}/${name}`)
    return new Blob([await res.arrayBuffer()])
  } }
}
function fetchDir(path: string, name = ''): unknown {
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

function ScriptHarness({ id }: { id: number }) {
  const root = fetchDir('') as FileSystemDirectoryHandle
  useEffect(() => { (window as unknown as Record<string, unknown>).__ifaceReady = true }, [])
  return <Cs2ScriptModal rootHandle={root} scriptId={id} onClose={() => {}} />
}

function Harness() {
  const [data, setData] = useState<InterfaceData | null>(null)
  const [assets, setAssets] = useState<InterfaceAssets | null>(null)
  useEffect(() => {
    const root = fetchDir('') as FileSystemDirectoryHandle
    const id = Number(params.get('iface') ?? '190')
    ;(async () => {
      try {
        const loaded = await loadInterfaceById(root, id)
        if (!loaded) throw new Error(`interface ${id} missing`)
        setData({ ...loaded, rootHandle: root })
        setAssets(new InterfaceAssets(root))
        ;(window as unknown as Record<string, unknown>).__ifaceReady = true
      } catch (e) { (window as unknown as Record<string, unknown>).__error = String(e) }
    })()
  }, [])
  if (!data) return <div>loading…</div>
  return <GameframePreview data={data} assets={assets} opts={{ showHidden: false, showContainerOutlines: false }} />
}

const scriptParam = params.get('script')
createRoot(document.getElementById('root')!).render(
  scriptParam ? <ScriptHarness id={Number(scriptParam)} /> : <Harness />,
)
