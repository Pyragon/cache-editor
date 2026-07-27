import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ShaderViewer from './components/ShaderViewer'
import { shadersLoader, type ShaderData } from './loaders/shaders'
import './index.css'
const p = new URLSearchParams(location.search)
const BASE = `http://127.0.0.1:${p.get('dump') ?? '8787'}`
function fileHandle(path: string, name: string): any { return { kind:'file', name, async getFile(){ const r=await fetch(`${BASE}/${path?path+'/':''}${name}`); if(!r.ok) throw new Error(`${r.status} ${path}/${name}`); return new Blob([await r.arrayBuffer()]) } } }
function fetchDir(path: string, name=''): any { return { kind:'directory', name,
  async getDirectoryHandle(n:string){ return fetchDir(path?`${path}/${n}`:n, n) },
  async getFileHandle(n:string){ return fileHandle(path,n) },
  async *values(){ const r=await fetch(`${BASE}/__ls?path=${encodeURIComponent(path)}`); if(!r.ok) return; for(const e of await r.json() as any[]) yield e.kind==='directory'?fetchDir(path?`${path}/${e.name}`:e.name,e.name):fileHandle(path,e.name) } } }
function Harness(){
  const [data,setData]=useState<ShaderData|null>(null)
  useEffect(()=>{(async()=>{
    try{
      const dir=await fetchDir('').getDirectoryHandle('shaders')
      const items:any[]=[]; for await(const it of shadersLoader.streamItems(dir)) items.push(it)
      const which = p.get('name')
      const pick = which ? items.find(i=>i.name.includes(which)) : items.find(i=>i.name.includes('frag')) ?? items[0]
      setData(await shadersLoader.loadItem(dir, pick) as ShaderData)
      ;(window as any).__done=true
    }catch(e:any){ (window as any).__error=String(e?.stack??e); (window as any).__done=true }
  })()},[])
  if(!data) return null
  return <div style={{width:1100,height:800}}><ShaderViewer data={data}/></div>
}
createRoot(document.getElementById('root')!).render(<Harness/>)
