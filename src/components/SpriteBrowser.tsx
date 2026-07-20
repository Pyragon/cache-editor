import { useEffect, useRef, useState } from 'react'
import type { SpriteMeta } from '../loaders/sprites'
import { renderFrame } from './spriteRender'
import './SpriteBrowser.css'

type Match = { id: number; meta: SpriteMeta }

type Props = {
  spritesDir: FileSystemDirectoryHandle
  /** Only sprites with exactly these full-frame dimensions are listed. */
  filterSize?: { w: number; h: number }
  /** Highlighted as the current pick. */
  selectedId?: number
  title?: string
  onPick: (id: number, meta: SpriteMeta) => void
  onCancel: () => void
}

function Thumb({ meta }: { meta: SpriteMeta }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) renderFrame(ref.current, meta, 0)
  }, [meta])
  return <canvas ref={ref} className="sprite-browser-thumb" />
}

/** Modal picker over the sprites entry: scans every archive's meta (streamed
 *  in chunks with progress — the full index is ~12k JSONs), lists the ones
 *  matching `filterSize`, and resolves with the clicked sprite id. */
export default function SpriteBrowser({ spritesDir, filterSize, selectedId, title, onPick, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [matches, setMatches] = useState<Match[]>([])
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    let cancelled = false
    async function scan() {
      const ids: number[] = []
      for await (const handle of spritesDir.values()) {
        if (handle.kind !== 'directory') continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id)) ids.push(id)
      }
      if (cancelled) return
      ids.sort((a, b) => a - b)
      setTotal(ids.length)

      const CHUNK = 64
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        const found = await Promise.all(chunk.map(async (id): Promise<Match | null> => {
          try {
            const sub = await spritesDir.getDirectoryHandle(String(id))
            const file = await (await sub.getFileHandle(`${id}.json`)).getFile()
            const meta = JSON.parse(await file.text()) as SpriteMeta
            if (!filterSize || (meta.width === filterSize.w && meta.height === filterSize.h)) {
              return { id, meta }
            }
          } catch { /* unreadable archive — skip it */ }
          return null
        }))
        if (cancelled) return
        setScanned((prev) => prev + chunk.length)
        const good = found.filter((m): m is Match => m != null)
        if (good.length > 0) setMatches((prev) => [...prev, ...good])
      }
      setDone(true)
    }
    scan()
    return () => { cancelled = true }
  }, [spritesDir, filterSize])

  return (
    <dialog
      ref={dialogRef}
      className="sprite-browser-dialog"
      onCancel={(e) => { e.preventDefault(); onCancel() }}
    >
      <div className="sprite-browser-body">
        <h3 className="confirm-dialog-title">{title ?? 'Pick a sprite'}</h3>
        <span className="sprite-browser-status">
          {done
            ? `${matches.length} matching sprite${matches.length === 1 ? '' : 's'}`
            : `Scanning… ${scanned}${total != null ? ` / ${total}` : ''} (${matches.length} found)`}
        </span>
        <div className="sprite-browser-grid">
          {matches.map(({ id, meta }) => (
            <button
              key={id}
              type="button"
              className={`sprite-browser-item${id === selectedId ? ' selected' : ''}`}
              title={`Sprite ${id}`}
              onClick={() => onPick(id, meta)}
            >
              <Thumb meta={meta} />
              <span className="sprite-browser-item-id">{id}</span>
            </button>
          ))}
          {done && matches.length === 0 && (
            <p className="sprite-browser-empty">No sprites match the size filter.</p>
          )}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="save-bar-discard" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </dialog>
  )
}
