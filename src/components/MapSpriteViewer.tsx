import { NumberInput, SortableTh } from './defFields'
import type { SortState } from './defFields'
import { useEffect, useRef, useState } from 'react'
import { useZoom } from './useZoom'
import type { MapSpriteData, MapSpriteDef } from '../loaders/config/map_sprites'
import type { SpriteMeta } from '../loaders/sprites'
import { applyImageToMeta, imageDataFromFile, renderFrame } from './spriteRender'
import { nextFreeSpriteId } from '../loaders/spriteStore'
import SpriteBrowser from './SpriteBrowser'
import SpritePixelEditor from './SpritePixelEditor'
import './MapSpriteViewer.css'

type Props = {
  data: MapSpriteData
  onSave: (data: MapSpriteData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onOpenObject?: (id: number) => void
}

// ---------------------------------------------------------------------------
// "Used by objects" index: mapSpriteId -> the objects referencing it. Built by
// scanning every object def once (~74k JSONs, tens of seconds), then cached at
// module level for the rest of the session.
// ---------------------------------------------------------------------------

type SpriteUse = { id: number; name: string }

let usesIndex: Map<number, SpriteUse[]> | null = null
let usesIndexPromise: Promise<Map<number, SpriteUse[]>> | null = null

function buildUsesIndex(
  objectsDir: FileSystemDirectoryHandle,
  onProgress: (done: number, total: number) => void,
): Promise<Map<number, SpriteUse[]>> {
  if (usesIndexPromise) return usesIndexPromise
  usesIndexPromise = (async () => {
    const ids: number[] = []
    for await (const handle of objectsDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name.slice(0, -5), 10)
      if (!isNaN(id)) ids.push(id)
    }
    ids.sort((a, b) => a - b)

    const index = new Map<number, SpriteUse[]>()
    const CHUNK = 128
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      await Promise.all(chunk.map(async (id) => {
        try {
          const file = await (await objectsDir.getFileHandle(`${id}.json`)).getFile()
          const def = JSON.parse(await file.text()) as { name?: string; mapSpriteId?: number }
          const msId = def.mapSpriteId ?? -1
          if (msId >= 0) {
            let list = index.get(msId)
            if (!list) index.set(msId, list = [])
            list.push({ id, name: def.name ?? 'null' })
          }
        } catch { /* unreadable def — skip */ }
      }))
      onProgress(Math.min(i + CHUNK, ids.length), ids.length)
    }
    usesIndex = index
    return index
  })()
  return usesIndexPromise
}

const ZOOM_LEVELS = [1, 2, 4, 8]

// Mapscene stamps are uniformly 8×8 single-frame sprites (verified across the
// whole dump), so the browser only offers sprites at exactly that size.
// Module-level so the object identity is stable across renders.
const MAP_SPRITE_SIZE = { w: 8, h: 8 }

function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

function hexToRgbInt(hex: string): number {
  return parseInt(hex.slice(1), 16) || 0
}

export default function MapSpriteViewer({ data, onSave, onDirtyChange, onOpenObject }: Props) {
  const [draft, setDraft] = useState<MapSpriteDef>(data.mapSprite)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [zoom, setZoom] = useZoom('cache-editor:map-sprite-zoom', ZOOM_LEVELS, 1)
  const [sprite, setSprite] = useState<SpriteMeta | null>(null)
  const [spriteError, setSpriteError] = useState<string | null>(null)
  const [isSpriteDirty, setIsSpriteDirty] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [spriteReloadKey, setSpriteReloadKey] = useState(0)
  const [browsing, setBrowsing] = useState(false)
  const [editingPixels, setEditingPixels] = useState(false)
  const [usesReady, setUsesReady] = useState(usesIndex != null)
  const [usesFilter, setUsesFilter] = useState('')
  const [usesSort, setUsesSort] = useState<SortState>({ key: 'id', dir: 1 })
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(usesIndexPromise && !usesIndex ? { done: 0, total: 0 } : null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // True while an uploaded (not-yet-saved) sprite is staged — blocks the
  // disk-load effect from clobbering it when the allocated id is applied.
  const stagedUploadRef = useRef(false)

  useEffect(() => {
    setDraft(data.mapSprite)
    setIsDirty(false)
    setIsSpriteDirty(false)
    setUploadError(null)
    setSaveError(null)
    setBrowsing(false)
    setEditingPixels(false)
    setUsesFilter('')
    stagedUploadRef.current = false
  }, [data])

  async function handleScanUses() {
    if (!data.objectsDir) return
    setScanProgress({ done: 0, total: 0 })
    await buildUsesIndex(data.objectsDir, (done, total) => setScanProgress({ done, total }))
    setScanProgress(null)
    setUsesReady(true)
  }

  // Stages the edited stamp as a brand-new sprite (same convention as upload:
  // never overwrite a sprite other cache entries may share).
  async function handlePixelApply(edited: SpriteMeta) {
    setEditingPixels(false)
    if (!data.spritesDir) return
    const newId = await nextFreeSpriteId(data.spritesDir)
    stagedUploadRef.current = true
    setSprite(edited)
    setSpriteError(null)
    setIsSpriteDirty(true)
    set('spriteId', newId)
  }

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Load the referenced sprite's meta whenever the sprite id changes.
  useEffect(() => {
    if (!data.spritesDir) {
      setSprite(null)
      setSpriteError('No sprites entry found in this cache — preview unavailable.')
      return
    }
    if (stagedUploadRef.current) return
    if (draft.spriteId === -1) {
      setSprite(null)
      setSpriteError(null)
      return
    }
    let cancelled = false
    async function load() {
      try {
        const subHandle = await data.spritesDir!.getDirectoryHandle(String(draft.spriteId))
        const fileHandle = await subHandle.getFileHandle(`${draft.spriteId}.json`)
        const file = await fileHandle.getFile()
        const meta = JSON.parse(await file.text()) as SpriteMeta
        if (!cancelled) {
          setSprite(meta)
          setSpriteError(null)
          setIsSpriteDirty(false)
        }
      } catch {
        if (!cancelled) {
          setSprite(null)
          setSpriteError(`Sprite ${draft.spriteId} not found in the sprites entry.`)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [draft.spriteId, data.spritesDir, spriteReloadKey])

  useEffect(() => {
    if (sprite && canvasRef.current) renderFrame(canvasRef.current, sprite, 0)
  }, [sprite])

  function set<K extends keyof MapSpriteDef>(key: K, value: MapSpriteDef[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  // Manually editing the sprite id abandons any staged upload so the
  // disk-load effect fetches the typed id instead.
  function setSpriteId(value: number) {
    stagedUploadRef.current = false
    setIsSpriteDirty(false)
    set('spriteId', value)
  }

  function handleDownload() {
    if (!sprite) return
    const canvas = document.createElement('canvas')
    renderFrame(canvas, sprite, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `map_sprite_${data.id}_sprite_${draft.spriteId}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  function openUpload() {
    setUploadError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  // An upload never overwrites the referenced sprite (other cache entries
  // may share it). It stages a brand-new single-frame sprite under the next
  // free id and repoints the map sprite; nothing hits disk until Save.
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !data.spritesDir) return
    try {
      const imageData = await imageDataFromFile(file)
      const blankMeta: SpriteMeta = {
        width: 0, height: 0, palette: [0],
        pixelIndices: [[]], alpha: [[]],
        usesAlpha: [false], isVertical: [false],
        offsetsX: [0], offsetsY: [0], subWidths: [0], subHeights: [0],
      }
      const newSprite = applyImageToMeta(imageData, 0, blankMeta)

      let maxId = -1
      for await (const handle of data.spritesDir.values()) {
        if (handle.kind !== 'directory') continue
        const id = parseInt(handle.name, 10)
        if (!isNaN(id) && id > maxId) maxId = id
      }
      const newId = maxId + 1

      stagedUploadRef.current = true
      setSprite(newSprite)
      setSpriteError(null)
      setIsSpriteDirty(true)
      set('spriteId', newId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave() {
    // spriteId -1 is valid for map sprites ("no sprite"); anything else has
    // to resolve — `sprite` is only non-null when it loaded (or is staged).
    if (draft.spriteId !== -1 && !sprite) {
      setSaveError(`Sprite ${draft.spriteId} doesn't exist — pick a valid sprite id (or -1 for none) before saving.`)
      return
    }
    setSaveError(null)

    setIsSaving(true)
    let spritePng: Blob | null = null
    if (isSpriteDirty && sprite) {
      const canvas = document.createElement('canvas')
      renderFrame(canvas, sprite, 0)
      spritePng = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    }
    await onSave({ ...data, mapSprite: draft, sprite, spriteDirty: isSpriteDirty, spritePng })
    setIsSaving(false)
    setIsDirty(false)
    setIsSpriteDirty(false)
    stagedUploadRef.current = false
  }

  function handleDiscard() {
    stagedUploadRef.current = false
    setDraft(data.mapSprite)
    setIsDirty(false)
    setUploadError(null)
    setSaveError(null)
    if (isSpriteDirty) {
      setIsSpriteDirty(false)
      setSpriteReloadKey((k) => k + 1)
    }
  }

  return (
    <div className="map-sprite-viewer">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="map-sprite-header">
        <div className="map-sprite-title">
          <span className="map-sprite-id">Map Sprite {data.id}</span>
          {sprite && <span className="map-sprite-dims">{sprite.width} × {sprite.height}</span>}
          {sprite && (sprite.width !== 8 || sprite.height !== 8) && (
            <span
              className="map-sprite-warn"
              title="Every mapscene stamp in the real cache is 8×8 — the client draws them at native size (4 px per map tile), so other sizes will render off-scale."
            >
              ⚠ not 8×8
            </span>
          )}
        </div>
        <div className="sprite-zoom-row">
          <span className="sprite-zoom-label">Zoom</span>
          <span className="btn-pill">
            {ZOOM_LEVELS.map((z) => (
              <button
                key={z}
                type="button"
                className={`zoom-btn${zoom === z ? ' active' : ''}`}
                onClick={() => setZoom(z)}
              >
                {z}×
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="map-sprite-stats">
        <div className="stat-card">
          <span className="stat-label">Sprite ID</span>
          <NumberInput
            className="stat-input"
            value={draft.spriteId}
            onChange={setSpriteId}
          />
          {isSpriteDirty && <span className="map-sprite-hint">new — created on save</span>}
        </div>
        <div className="stat-card">
          <span className="stat-label">Background Colour</span>
          <div className="map-sprite-colour-row">
            <input
              type="color"
              className="map-sprite-colour-input"
              value={rgbIntToHex(draft.backgroundColour)}
              onChange={(e) => set('backgroundColour', hexToRgbInt(e.target.value))}
            />
            <span className="map-sprite-colour-hex">{rgbIntToHex(draft.backgroundColour)}</span>
          </div>
        </div>
        <div className="stat-card">
          <span
            className="stat-label"
            title="When set, the client stretches the stamp to the placed object's tile footprint (4 px per tile on the minimap, the loc's size on the world map) instead of drawing it at the sprite's native 8×8 — used by multi-tile scenery."
          >
            Requires Upscaling
          </span>
          <label className="sprite-toggle">
            <input
              type="checkbox"
              checked={draft.requiresUpscaling}
              onChange={(e) => set('requiresUpscaling', e.target.checked)}
            />
            <span className="sprite-toggle-track" />
          </label>
        </div>
      </div>

      <div className="map-sprite-actions">
        <button
          type="button"
          className="cursor-pick-btn"
          disabled={!data.spritesDir}
          onClick={() => setBrowsing(true)}
        >
          Browse…
        </button>
        <button type="button" className="cursor-pick-btn" onClick={openUpload}>
          Upload sprite
        </button>
        <button
          type="button"
          className="cursor-pick-btn"
          disabled={!sprite || !data.spritesDir}
          title="Edit the stamp in the pixel editor — applied edits are staged as a new sprite id and written on Save"
          onClick={() => setEditingPixels(true)}
        >
          Edit pixels
        </button>
        <button type="button" className="cursor-pick-btn" onClick={handleDownload} disabled={!sprite}>
          Download
        </button>
      </div>

      {spriteError && <p className="cursor-sprite-error">{spriteError}</p>}
      {uploadError && <p className="cursor-sprite-error">{uploadError}</p>}

      {draft.spriteId === -1 && !sprite ? (
        <p className="map-sprite-none">No sprite assigned (sprite id -1).</p>
      ) : sprite ? (
        <div
          className="sprite-canvas map-sprite-preview"
          style={{
            width: sprite.width * zoom,
            height: sprite.height * zoom,
            // 0 (black) is by far the dominant value in the dump and would
            // hide the transparency checkerboard, so only a non-zero colour
            // is painted behind the sprite.
            ...(draft.backgroundColour !== 0
              ? { background: rgbIntToHex(draft.backgroundColour) }
              : {}),
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: sprite.width * zoom,
              height: sprite.height * zoom,
              imageRendering: 'pixelated',
              display: 'block',
            }}
          />
        </div>
      ) : null}

      <div className="map-sprite-uses">
        <span className="stat-label">Used by objects</span>
        {!data.objectsDir ? (
          <p className="map-sprite-none">No objects entry in this cache — usage scan unavailable.</p>
        ) : scanProgress != null ? (
          <p className="map-sprite-none">
            Scanning object defs… {scanProgress.done.toLocaleString()}{scanProgress.total > 0 ? ` / ${scanProgress.total.toLocaleString()}` : ''}
          </p>
        ) : !usesReady ? (
          <div className="map-sprite-uses-scan">
            <button type="button" className="cursor-pick-btn" onClick={handleScanUses}>
              Scan object defs
            </button>
            <span className="map-sprite-hint">reads all ~74k object defs once, then cached for the session</span>
          </div>
        ) : (() => {
          const uses = usesIndex?.get(data.id) ?? []
          if (uses.length === 0) return <p className="map-sprite-none">No object references this map sprite.</p>
          const filter = usesFilter.trim().toLowerCase()
          const filtered = filter === ''
            ? uses
            : uses.filter(({ id, name }) => name.toLowerCase().includes(filter) || String(id).includes(filter))
          const sorted = [...filtered].sort((a, b) => {
            const byName = usesSort.key === 'name' ? a.name.localeCompare(b.name) : 0
            return usesSort.dir * (byName !== 0 ? byName : a.id - b.id)
          })
          return (
            <div className="map-sprite-uses-inner">
              <div className="map-sprite-uses-head">
                <span className="map-sprite-hint">
                  {uses.length.toLocaleString()} object{uses.length === 1 ? '' : 's'} stamp this sprite on the map
                  {filter !== '' && ` — ${filtered.length.toLocaleString()} shown`}
                </span>
                {uses.length > 8 && (
                  <input
                    type="text"
                    className="map-sprite-uses-filter"
                    placeholder="Filter by name or id…"
                    value={usesFilter}
                    onChange={(e) => setUsesFilter(e.target.value)}
                  />
                )}
              </div>
              <div className="quest-table-wrap map-sprite-uses-wrap">
                <table className="quest-table">
                  <thead>
                    <tr>
                      <SortableTh label="Object" sortKey="name" sort={usesSort} onSort={setUsesSort} />
                      <SortableTh label="ID" sortKey="id" sort={usesSort} onSort={setUsesSort} />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(({ id, name }) => (
                      <tr key={id}>
                        <td>{name}</td>
                        <td className="map-sprite-use-id">{id}</td>
                        <td>
                          {onOpenObject && (
                            <button
                              type="button"
                              className="field-link-btn"
                              title={`Open object ${id} in its viewer`}
                              onClick={() => onOpenObject(id)}
                            >
                              View
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}
      </div>

      {editingPixels && sprite && (
        <SpritePixelEditor
          meta={sprite}
          frameIndex={0}
          title={`Edit stamp — saves as a new sprite`}
          onApply={handlePixelApply}
          onCancel={() => setEditingPixels(false)}
        />
      )}

      {browsing && data.spritesDir && (
        <SpriteBrowser
          spritesDir={data.spritesDir}
          filterSize={MAP_SPRITE_SIZE}
          selectedId={draft.spriteId}
          title="Pick an 8×8 sprite"
          onPick={(id) => {
            setSpriteId(id)
            setBrowsing(false)
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">
            Unsaved changes
            {saveError && <span className="save-bar-error"> — {saveError}</span>}
          </span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
