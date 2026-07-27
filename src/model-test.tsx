import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ModelViewer from './components/ModelViewer'
import { getLoader } from './loaders'
import { loadModelComposite, objectCompositeSpec } from './loaders/npcComposite'
import type { ModelData } from './loaders/models'
import './index.css'

const p = new URLSearchParams(location.search)
const BASE = `http://127.0.0.1:${p.get('dump') ?? '8787'}`

// Minimal read-only fetch-backed FileSystemDirectoryHandle shim (dump server).
function fetchDir(path: string): any {
  return {
    async getDirectoryHandle(name: string) { return fetchDir(path ? `${path}/${name}` : name) },
    async getFileHandle(name: string) {
      const url = `${BASE}/${path ? path + '/' : ''}${name}`
      return { async getFile() {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status} ${url}`)
        return new Blob([await res.arrayBuffer()])
      } }
    },
  }
}

function Harness() {
  const [data, setData] = useState<ModelData | null>(null)
  useEffect(() => {
    (async () => {
      try {
        const root = fetchDir('')
        const obj = p.get('obj')
        let d: ModelData
        if (obj) {
          const defBlob = await (await (await root.getDirectoryHandle('objects')).getFileHandle(`${obj}.json`)).getFile()
          const def = JSON.parse(await defBlob.text())
          d = await loadModelComposite(root, objectCompositeSpec(def))
        } else {
          const id = Number(p.get('model') ?? '1637')
          const dir = await root.getDirectoryHandle('models')
          d = await getLoader('models')!.loadItem(dir, { id, name: `${id}` }, root) as ModelData
        }
        setData(d)
        setTimeout(() => { (window as any).__done = true }, 1200)
      } catch (e: any) {
        (window as any).__error = String(e?.stack ?? e?.message ?? e); (window as any).__done = true
      }
    })()
  }, [])
  if (!data) return null
  return <div style={{ width: 900, height: 700 }}><ModelViewer data={data} /></div>
}
createRoot(document.getElementById('root')!).render(<Harness />)
