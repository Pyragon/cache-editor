import { useEffect, useState } from 'react'
import type { CursorDef } from '../loaders/config/cursors'
import { loadSpriteMeta, renderFrameToCanvas } from './spriteRender'
import { getModelIcon, peekModelIcon } from './npcSnapshot'

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
