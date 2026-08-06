import { useEffect, useState } from 'react'
import type { CursorDef } from '../loaders/config/cursors'
import { loadSpriteMeta, renderFrameToCanvas } from './spriteRender'
import { getModelIcon, peekModelIcon, getInventoryItemIcon, peekInventoryItemIcon } from './npcSnapshot'

// Small preview cards backed by the sprites entry, shared by the item and
// NPC viewers. Both reuse the .item-cursor-* card styles (ItemViewer.css).

/** A cursor's sprite: config/cursors/<id>.json → spriteId → sprite meta →
 *  canvas. Tracks the DRAFT id so editing the field updates it live. */
export function CursorPreview({ cursorsDir, spritesDir, cursorId, label, onOpen }: {
  cursorsDir: FileSystemDirectoryHandle | null
  spritesDir: FileSystemDirectoryHandle | null
  cursorId: number
  label: string
  onOpen?: (id: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (cursorId < 0 || !cursorsDir || !spritesDir) return
    ;(async () => {
      try {
        const file = await (await cursorsDir.getFileHandle(`${cursorId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as CursorDef
        if (def.spriteId < 0) return
        const meta = await loadSpriteMeta(spritesDir, def.spriteId)
        if (!meta || cancelled) return
        const canvas = renderFrameToCanvas(meta)
        if (canvas && !cancelled) setUrl(canvas.toDataURL())
      } catch {
        // missing cursor def or sprite — no preview
      }
    })()
    return () => { cancelled = true }
  }, [cursorsDir, spritesDir, cursorId])

  if (cursorId < 0) return null
  return (
    <div className="item-cursor-card">
      {url
        ? <img className="item-cursor-img" src={url} alt="" />
        : <span className="item-cursor-img item-cursor-missing">?</span>}
      <span className="item-cursor-label">{label} · {cursorId}</span>
      {onOpen && (
        <button type="button" className="cursor-pick-btn" onClick={() => onOpen(cursorId)}>
          View
        </button>
      )}
    </div>
  )
}

/** Tiny snapshot of a single model (npcSnapshot.ts session cache), for the
 *  NPC part-table rows. Tracks the DRAFT id so editing the cell updates it. */
export function ModelSnapshotIcon({ cacheRoot, modelId }: {
  cacheRoot: FileSystemDirectoryHandle | null
  modelId: number
}) {
  const [url, setUrl] = useState<string | null>(peekModelIcon(modelId) ?? null)

  useEffect(() => {
    let cancelled = false
    setUrl(peekModelIcon(modelId) ?? null)
    if (!cacheRoot || modelId < 0) return
    getModelIcon(cacheRoot, modelId).then((u) => { if (!cancelled) setUrl(u) })
    return () => { cancelled = true }
  }, [cacheRoot, modelId])

  return url
    ? <img className="npc-model-row-icon" src={url} alt="" />
    : <span className="npc-model-row-icon" />
}

/** An item's inventory icon RENDERED from its def — the model in the item's
 *  own icon pose, recolours applied — instead of the pre-baked public/icons
 *  PNGs. Falls back to the static PNG while rendering (and permanently when
 *  the item has no model). */
export function RenderedItemIcon({ cacheRoot, itemId, className = 'item-icon' }: {
  cacheRoot: FileSystemDirectoryHandle | null
  itemId: number
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(peekInventoryItemIcon(itemId) ?? null)
  // peek: undefined = not tried yet, null = tried and failed (cached failure)
  const [failed, setFailed] = useState(peekInventoryItemIcon(itemId) === null)

  useEffect(() => {
    let cancelled = false
    const peeked = peekInventoryItemIcon(itemId)
    setUrl(peeked ?? null)
    setFailed(peeked === null)
    if (!cacheRoot || itemId < 0) return
    getInventoryItemIcon(cacheRoot, itemId).then((u) => {
      if (cancelled) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => { cancelled = true }
  }, [cacheRoot, itemId])

  if (url) return <img className={className} src={url} alt="" />
  if (itemId < 0) return <span className={`${className} item-icon-empty`} />
  // Deliberately NO static-PNG fallback: those were scraped from a later
  // revision and quietly wrong, and a fallback hides render bugs. A failed
  // render should look failed.
  if (failed) return <span className={`${className} item-icon-missing`} title={`item ${itemId}: icon failed to render`}>?</span>
  return <span className={`${className} item-icon-empty`} />
}

/** One frame of a sprite group, straight from the sprites entry (an NPC's
 *  overhead sprite, or a head icon's frame within headicons_prayer). */
export function SpriteFramePreview({ spritesDir, spriteId, frameIndex = 0, label, onOpen }: {
  spritesDir: FileSystemDirectoryHandle | null
  spriteId: number
  frameIndex?: number
  label: string
  onOpen?: (id: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (spriteId < 0 || !spritesDir) return
    ;(async () => {
      const meta = await loadSpriteMeta(spritesDir, spriteId)
      if (!meta || cancelled) return
      const canvas = renderFrameToCanvas(meta, frameIndex)
      if (canvas && !cancelled) setUrl(canvas.toDataURL())
    })()
    return () => { cancelled = true }
  }, [spritesDir, spriteId, frameIndex])

  if (spriteId < 0) return null
  return (
    <div className="item-cursor-card">
      {url
        ? <img className="item-cursor-img" src={url} alt="" />
        : <span className="item-cursor-img item-cursor-missing">?</span>}
      <span className="item-cursor-label">{label}</span>
      {onOpen && (
        <button type="button" className="cursor-pick-btn" onClick={() => onOpen(spriteId)}>
          View
        </button>
      )}
    </div>
  )
}
