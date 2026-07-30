// The dumped material PNG for a texture id, as a small swatch. Ground
// materials reference textures by id and nothing else on the page tells you
// which one that is — the 3D preview shows it in situ, this shows it flat.
import { useEffect, useState } from 'react'
import { loadTexturePng } from '../loaders/textures'
import './TextureThumb.css'

/** id → object URL per cache root. Never revoked: the same handful of ground
 *  textures get re-shown constantly while browsing definitions, and a revoked
 *  URL cannot be re-created without re-reading the file. */
const URLS = new WeakMap<FileSystemDirectoryHandle, Map<number, Promise<string | null>>>()

function thumbUrl(root: FileSystemDirectoryHandle, id: number): Promise<string | null> {
  let cache = URLS.get(root)
  if (!cache) URLS.set(root, (cache = new Map()))
  let pending = cache.get(id)
  if (!pending) {
    cache.set(id, (pending = (async () => {
      try {
        const dir = await root.getDirectoryHandle('textures')
        const png = await loadTexturePng(dir, id)
        return png ? URL.createObjectURL(png) : null
      } catch {
        return null
      }
    })()))
  }
  return pending
}

export default function TextureThumb({ rootHandle, id, onOpen }: {
  rootHandle: FileSystemDirectoryHandle | undefined
  id: number
  onOpen?: (id: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setMissing(false)
    if (!rootHandle || id < 0) return
    void thumbUrl(rootHandle, id).then((u) => {
      if (cancelled) return
      if (u) setUrl(u)
      else setMissing(true)
    })
    return () => { cancelled = true }
  }, [rootHandle, id])

  if (id < 0) {
    return <span className="texture-thumb texture-thumb-none" title="No texture — the tile draws as flat colour">none</span>
  }

  return (
    <span className="texture-thumb-row">
      <span className={`texture-thumb${missing ? ' texture-thumb-none' : ''}`} title={`Texture ${id}`}>
        {url ? <img src={url} alt="" /> : missing ? '?' : ''}
      </span>
      {onOpen && (
        <button type="button" className="field-link-btn" title={`Open texture ${id}`} onClick={() => onOpen(id)}>
          View
        </button>
      )}
    </span>
  )
}
