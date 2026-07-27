import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import MapSymbolPicker from './MapSymbolPicker'
import type { SymbolKind } from './MapSymbolPicker'
import type { ObjectDefJson } from './mapScene'
import { OBJECT_SLOTS, LOC_TYPE_LABELS } from '../loaders/maps'
import { hslToRgb, rgb24ToHsl16 } from '../loaders/models'

/** The placement slot whose `mapSpriteId` the client never reads.
 *
 *  Its per-tile minimap pass (`Static.method13042`) asks the scene for exactly
 *  three slots — `getWall` (0), `getInteractableObject` (2) and
 *  `getGroundDecoration` (3) — and checks `mapSpriteId` on each. It never asks
 *  for the wall-decoration slot, so a loc placed as type 4-8 cannot draw a map
 *  sprite however its definition is set. (The wall it hangs on draws its own.) */
const NO_MAP_SPRITE_SLOT = 1

/** What a map_sprites record resolved to: `spriteId: -1` is the record's own
 *  "blank" value, `url: null` with a real id means the PNG isn't dumped. */
export type MapSpriteInfo = { spriteId: number; url: string | null }

/** Resolved areas-config info for a mapCategoryId. */
export type AreaInfo = {
  name?: string
  spriteUrl: string | null
  bitmap: ImageBitmap | null
  minimap: boolean
  /** areas-config `defaultIconArchive`; -1 = the record deliberately has no
   *  icon. Kept so the panel can say "no icon" instead of silently drawing
   *  nothing, which is indistinguishable from a failed load. */
  iconArchive: number
}

export type DefSection = 'identity' | 'shape' | 'cursors' | 'appearance' | 'morph' | 'sprite' | 'icon' | 'sound'

/** Which right-click option a cursor override applies to. -1 = none. */
const CURSOR_SLOTS = [-1, 0, 1, 2, 3, 4]

/** cursor id → its sprite's object URL, per cache root. Same never-revoked
 *  session cache as the picker's: 183 records, tiny images, and the panel
 *  re-resolves them every time a cursor field changes. */
const CURSOR_URLS = new WeakMap<FileSystemDirectoryHandle, Map<number, Promise<string | null>>>()

function cursorSpriteUrl(root: FileSystemDirectoryHandle, id: number): Promise<string | null> {
  let cache = CURSOR_URLS.get(root)
  if (!cache) CURSOR_URLS.set(root, cache = new Map())
  let pending = cache.get(id)
  if (!pending) {
    cache.set(id, pending = (async () => {
      try {
        const cfg = await (await root.getDirectoryHandle('config')).getDirectoryHandle('cursors')
        const def = JSON.parse(await (await (await cfg.getFileHandle(`${id}.json`)).getFile()).text()) as { spriteId: number }
        if (def.spriteId < 0) return null
        const dir = await (await root.getDirectoryHandle('sprites')).getDirectoryHandle(String(def.spriteId))
        return URL.createObjectURL(await (await dir.getFileHandle(`${def.spriteId}_0.png`)).getFile())
      } catch {
        return null
      }
    })())
  }
  return pending
}

/** texture id → its dumped PNG's object URL, per cache root — same
 *  never-revoked session cache as the cursor sprites above. */
const TEXTURE_URLS = new WeakMap<FileSystemDirectoryHandle, Map<number, Promise<string | null>>>()

function textureThumbUrl(root: FileSystemDirectoryHandle, id: number): Promise<string | null> {
  let cache = TEXTURE_URLS.get(root)
  if (!cache) TEXTURE_URLS.set(root, cache = new Map())
  let pending = cache.get(id)
  if (!pending) {
    cache.set(id, pending = (async () => {
      try {
        const dir = await root.getDirectoryHandle('textures')
        const sub = await dir.getDirectoryHandle(String(id))
        return URL.createObjectURL(await (await sub.getFileHandle(`${id}.png`)).getFile())
      } catch {
        return null
      }
    })())
  }
  return pending
}

/** Comma-separated int list. Free text while focused so half-typed lists
 *  ("123, ") survive the keystroke — a plain controlled input re-normalizes
 *  on every change, which eats the comma you just typed and makes multi-value
 *  edits impossible. Commits the parsed ids on every valid keystroke; blur
 *  snaps the text back to the canonical form. */
function ListInput({ value, placeholder, onCommit, className = 'item-field-input' }: {
  value: number[]
  placeholder?: string
  onCommit: (ids: number[]) => void
  className?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const canonical = value.join(', ')
  return (
    <input
      className={className}
      type="text"
      value={text ?? canonical}
      placeholder={placeholder ?? '—'}
      onFocus={() => setText(canonical)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value
        if (!/^[\d\s,-]*$/.test(raw)) return
        setText(raw)
        onCommit(raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)))
      }}
    />
  )
}

/** HSL16 colour swatch. With onPick it wraps a native colour picker — the
 *  picked RGB snaps to the nearest representable HSL16, so the id and swatch
 *  always agree after a pick. */
function HslSwatch({ value, onPick }: { value: number; onPick?: (hsl16: number) => void }) {
  const hex = `#${hslToRgb(value & 0xffff).toString(16).padStart(6, '0')}`
  if (!onPick) return <span className="pair-swatch" title={`HSL16 ${value & 0xffff}`} style={{ background: hex }} />
  return (
    <label className="pair-swatch mapscene-swatch-pick" title={`HSL16 ${value & 0xffff} — click to pick a colour`} style={{ background: hex }}>
      <input
        type="color"
        className="mapscene-swatch-pick-input"
        value={hex}
        onChange={(e) => onPick(rgb24ToHsl16(parseInt(e.target.value.slice(1), 16)) & 0xffff)}
      />
    </label>
  )
}

/** Thumbnail of a texture's dumped PNG (textures/<id>/<id>.png); an empty
 *  box when there's no root or the PNG isn't dumped. */
function TexSwatch({ root, id }: { root: FileSystemDirectoryHandle | null; id: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (!root || id < 0) return
    void textureThumbUrl(root, id).then((u) => { if (!cancelled) setUrl(u) })
    return () => { cancelled = true }
  }, [root, id])
  return url
    ? <img className="mapscene-tex-swatch" src={url} alt="" title={`texture ${id}`} />
    : <span className="mapscene-tex-swatch is-empty" title={root ? `texture ${id} — no PNG dumped` : 'no cache root'} />
}

/** Editor for the fields of an object DEFINITION (`objects/<id>.json`).
 *
 *  Shared by the map scene's marker and object panels — a marker IS an object,
 *  so the only difference between them is which sections are worth showing.
 *  The parent owns the draft and the dirty/Apply flow; this only edits.
 *
 *  Labels use cryogen's dumped field names (what you'd search the JSON for);
 *  the client's own names and the opcodes are in the tooltips, since the two
 *  disagree on most of the sound fields. `EDITOR.md` has the full mapping. */
export default function ObjectDefEditor({ draft, canEdit, onChange, sections, root, loadSprite, loadArea, placementType, onNavigate, morphPreviewIndex, onMorphPreview }: {
  draft: ObjectDefJson
  canEdit: boolean
  onChange: (next: ObjectDefJson) => void
  sections: DefSection[]
  /** cache root, for the sprite/icon browsers — no browsing without it */
  root: FileSystemDirectoryHandle | null
  loadSprite: (id: number) => Promise<MapSpriteInfo | null>
  loadArea: (id: number) => Promise<AreaInfo | null>
  /** The placement's shape (0-22), when opened from one. Only used to close
   *  off the map-sprite fields where the client would ignore them; omit it and
   *  everything stays editable. */
  placementType?: number
  /** jump to another entry's item (View links); omit to hide the links */
  onNavigate?: (entryName: string, itemId: number) => void
  /** Transform-to row currently previewed in the 3D scene (highlighted). */
  morphPreviewIndex?: number | null
  /** Toggle the scene preview of a Transform-to row: (index, objectId) starts
   *  one, (null) restores the real object. Omit to hide the Preview buttons. */
  onMorphPreview?: (index: number | null, objectId?: number) => void
}) {
  const set = <K extends keyof ObjectDefJson>(key: K, value: ObjectDefJson[K]) =>
    onChange({ ...draft, [key]: value })

  const spriteId = draft.mapSpriteId ?? -1
  const categoryId = draft.mapCategoryId ?? -1
  const spriteBlocked = placementType !== undefined
    && (OBJECT_SLOTS[placementType] ?? 2) === NO_MAP_SPRITE_SLOT
  const [sprite, setSprite] = useState<MapSpriteInfo | null>(null)
  const [area, setArea] = useState<AreaInfo | null>(null)
  // which field the open browser writes back to — the cursor rows mean there
  // are now two possible targets per kind, so the kind alone isn't enough
  const [picking, setPicking] = useState<{ kind: SymbolKind; field: keyof ObjectDefJson; current: number } | null>(null)
  const [cursorUrls, setCursorUrls] = useState<Map<number, string>>(new Map())
  const loadSpriteRef = useRef(loadSprite); loadSpriteRef.current = loadSprite
  const loadAreaRef = useRef(loadArea); loadAreaRef.current = loadArea

  useEffect(() => {
    if (spriteId < 0) { setSprite(null); return }
    let cancelled = false
    void loadSpriteRef.current(spriteId).then((info) => { if (!cancelled) setSprite(info) })
    return () => { cancelled = true }
  }, [spriteId])
  useEffect(() => {
    if (categoryId < 0) { setArea(null); return }
    let cancelled = false
    void loadAreaRef.current(categoryId).then((info) => { if (!cancelled) setArea(info) })
    return () => { cancelled = true }
  }, [categoryId])

  const primaryCursor = draft.primaryCursor ?? -1
  const secondaryCursor = draft.secondaryCursor ?? -1
  useEffect(() => {
    if (!root) return
    let cancelled = false
    const ids = [primaryCursor, secondaryCursor].filter((id) => id >= 0)
    if (ids.length === 0) { setCursorUrls(new Map()); return }
    void Promise.all(ids.map(async (id) => [id, await cursorSpriteUrl(root, id)] as const))
      .then((pairs) => {
        if (cancelled) return
        const next = new Map<number, string>()
        for (const [id, url] of pairs) if (url) next.set(id, url)
        setCursorUrls(next)
      })
    return () => { cancelled = true }
  }, [root, primaryCursor, secondaryCursor])

  // A resolved-but-empty result is the interesting case: the record exists and
  // deliberately has no sprite/icon (map_sprites opcode 4, areas
  // defaultIconArchive -1). Drawing nothing there is indistinguishable from a
  // failed load, which is what sent us hunting for a bug in map sprite 22.
  const spriteNote = spriteId < 0 ? null
    : sprite === null ? 'record missing'
      : sprite.spriteId < 0 ? 'no sprite'
        : sprite.url === null ? `sprite ${sprite.spriteId} not dumped`
          : null
  const areaNote = categoryId < 0 ? null
    : area === null ? 'record missing'
      : area.iconArchive < 0 ? 'no icon'
        : area.spriteUrl === null ? `icon ${area.iconArchive} not dumped`
          : null

  const num = (label: string, title: string, value: number, onValue: (v: number) => void, min = -1, max = 65535) => (
    <label className="item-field" title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit
        ? <NumberInput value={value} onChange={onValue} min={min} max={max} />
        : <span className="mapscene-field-value">{value}</span>}
    </label>
  )
  const flag = (label: string, title: string, value: boolean, onValue: (v: boolean) => void) => (
    <div className="item-field" title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit ? (
        <span className="btn-pill mapscene-flag-pill">
          <button type="button" className={`zoom-btn${value ? ' active' : ''}`} onClick={() => onValue(true)}>yes</button>
          <button type="button" className={`zoom-btn${!value ? ' active' : ''}`} onClick={() => onValue(false)}>no</button>
        </span>
      ) : <span className="mapscene-field-value">{value ? 'yes' : 'no'}</span>}
    </div>
  )
  const text = (label: string, title: string, value: string, onValue: (v: string) => void, wide = false) => (
    <label className={`item-field${wide ? ' is-wide' : ''}`} title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit
        ? <input className="item-field-input" type="text" value={value} onChange={(e) => onValue(e.target.value)} />
        : <span className="mapscene-field-value">{value || '—'}</span>}
    </label>
  )
  /** Paired original→modified table (recolours/retextures) — the objects
   *  entry's PairTable, at side-panel size. Every cell edit writes BOTH
   *  parallel draft arrays so they can never fall out of step. */
  const pairTable = (
    label: string, title: string, dstLabel: string,
    origKey: 'originalColors' | 'originalTextures', modKey: 'modifiedColors' | 'modifiedTextures',
    swatch: (v: number, commit: (nv: number) => void) => React.ReactNode,
  ) => {
    const origs = draft[origKey] ?? []
    const mods = draft[modKey] ?? []
    const commit = (nextO: number[], nextM: number[]) => onChange({
      ...draft,
      [origKey]: nextO.length ? nextO : undefined,
      [modKey]: nextO.length ? nextM : undefined,
    })
    const setPair = (i: number, which: 0 | 1, v: number) => {
      const nextO = origs.slice()
      const nextM = mods.slice()
      while (nextM.length < nextO.length) nextM.push(0)
      if (which === 0) nextO[i] = v
      else nextM[i] = v
      commit(nextO, nextM)
    }
    const cell = (v: number, i: number, which: 0 | 1) => (
      <td>
        <span className="pair-cell-inner">
          {canEdit
            ? <NumberInput className="cell-input" value={v} onChange={(nv) => setPair(i, which, nv)} min={0} max={65535} />
            : <span className="mapscene-field-value">{v}</span>}
          {swatch(v, (nv) => setPair(i, which, nv))}
        </span>
      </td>
    )
    return (
      <div className="item-field is-wide" title={title}>
        <span className="item-field-label">{label}</span>
        {origs.length > 0 && (
          <div className="quest-table-wrap mapscene-def-table-wrap">
          <table className="quest-table mapscene-pair-table">
            <thead><tr><th>Original</th><th>{dstLabel}</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {origs.map((o, i) => (
                <tr key={i}>
                  {cell(o, i, 0)}
                  {cell(mods[i] ?? 0, i, 1)}
                  {canEdit && (
                    <td className="mapscene-pair-remove">
                      <button type="button" className="row-remove-btn" title="Remove this pair" onClick={() => commit(origs.filter((_, k) => k !== i), mods.filter((_, k) => k !== i))}>×</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {origs.length === 0 && !canEdit && <span className="mapscene-field-value">—</span>}
        {canEdit && (
          <button type="button" className="add-row-btn" onClick={() => commit([...origs, 0], [...mods.slice(0, origs.length), 0])}>
            + Add pair
          </button>
        )}
      </div>
    )
  }

  /** A cursor override: which option it applies to, the cursor id, its sprite,
   *  and a browser. The two halves are useless apart — a cursor with no action
   *  index never shows, and an index with no cursor is the default arrow. */
  const cursorPick = (
    label: string, title: string, field: 'primaryCursor' | 'secondaryCursor',
    cursorId: number, actionIndex: number,
    onCursor: (v: number) => void, onIndex: (v: number) => void,
  ) => (
    <div className="item-field is-wide" title={title}>
      <span className="item-field-label">{label} cursor</span>
      <div className="mapscene-cursor-row">
        {cursorUrls.get(cursorId)
          ? <img className="mapscene-cursor-img" src={cursorUrls.get(cursorId)!} alt="" />
          : <span className="mapscene-cursor-img is-empty">{cursorId < 0 ? '—' : '?'}</span>}
        {canEdit ? (
          <>
            <NumberInput value={cursorId} onChange={onCursor} min={-1} max={65535} />
            <button
              type="button"
              className="mapscene-browse-btn"
              disabled={!root}
              title={root ? 'Browse cursors by thumbnail' : 'No cache root — browsing needs the folder handle'}
              onClick={() => setPicking({ kind: 'cursor', field, current: cursorId })}
            >
              Browse…
            </button>
            <select
              className="item-stackable-select"
              value={actionIndex}
              onChange={(e) => onIndex(Number(e.target.value))}
              title="Which right-click option this cursor applies to"
            >
              {CURSOR_SLOTS.map((s) => (
                <option key={s} value={s}>{s < 0 ? 'no option' : `option ${s + 1}`}</option>
              ))}
            </select>
          </>
        ) : (
          <span className="mapscene-field-value">
            {cursorId < 0 ? '—' : `cursor ${cursorId}`}
            {actionIndex >= 0 ? ` on option ${actionIndex + 1}` : ''}
          </span>
        )}
      </div>
    </div>
  )

  /** numeric id paired with a thumbnail browser — ids alone are unguessable */
  const idPick = (label: string, title: string, value: number, kind: SymbolKind, onValue: (v: number) => void) => (
    <label className="item-field is-wide" title={title}>
      <span className="item-field-label">{label}</span>
      {canEdit ? (
        <span className="mapscene-id-pick">
          <NumberInput value={value} onChange={onValue} min={-1} max={65535} />
          <button
            type="button"
            className="mapscene-browse-btn"
            disabled={!root}
            title={root ? 'Browse the table by thumbnail' : 'No cache root — browsing needs the folder handle'}
            onClick={() => setPicking({
              kind,
              field: kind === 'mapsprite' ? 'mapSpriteId' : 'mapCategoryId',
              current: value,
            })}
          >
            Browse…
          </button>
        </span>
      ) : <span className="mapscene-field-value">{value}</span>}
    </label>
  )

  const options = draft.options ?? [null, null, null, null, null]
  const show = (s: DefSection) => sections.includes(s)

  return (
    <>
      {show('identity') && <>
        <div className="mapscene-side-section">Identity</div>
        <div className="mapscene-side-grid is-compact">
          {text('Name', 'Display name. "null" is the client\'s no-name value — an object with no name is never examinable.', draft.name ?? '', (v) => set('name', v), true)}
          {options.map((opt, i) => (
            <label className="item-field is-wide" key={i} title={`Right-click option ${i + 1} (opcodes 30–34). Empty = no option in that slot.`}>
              <span className="item-field-label">Option {i + 1}</span>
              {canEdit ? (
                <input
                  className="item-field-input"
                  type="text"
                  value={opt ?? ''}
                  placeholder="—"
                  onChange={(e) => {
                    const next = [...options]
                    next[i] = e.target.value === '' ? null : e.target.value
                    set('options', next)
                  }}
                />
              ) : <span className="mapscene-field-value">{opt ?? '—'}</span>}
            </label>
          ))}
        </div>
      </>}

      {show('shape') && <>
        <div className="mapscene-side-section">Footprint &amp; clipping</div>
        <div className="mapscene-side-grid is-compact">
          {num('Size X', 'Tiles occupied along x (opcode 14). Rotation swaps the two.', draft.sizeX ?? 1, (v) => set('sizeX', v), 1, 255)}
          {num('Size Y', 'Tiles occupied along y (opcode 15)', draft.sizeY ?? 1, (v) => set('sizeY', v), 1, 255)}
          {flag('Blocks', 'Blocks movement. Cleared by opcodes 17 and 18; the default is true.', draft.blocks ?? true, (v) => set('blocks', v))}
          {num('Clip type', 'Clip mode — default 2, opcode 17 sets 0 (with blocks off), opcode 24-ish sets 1', draft.clipType ?? 2, (v) => set('clipType', v), 0, 3)}
          {flag('Obstructs ground', 'Opcode 73 — hides the ground decoration under the object (darkan calls it forceDisplayDecoration)', draft.obstructsGround ?? false, (v) => set('obstructsGround', v))}
          {num('Supports items', 'Opcode 75 — whether ground items stack on top (-1 = unset)', draft.supportsItems ?? -1, (v) => set('supportsItems', v), -1, 255)}
          {num('Ground contour', 'Hillskew mode: 0 none, 1 follow ground, 2 partial, 4/5 stretch to the next plane (bridges/raised floors)', draft.groundContourType ?? 0, (v) => set('groundContourType', v), 0, 5)}
          {num('Contour modifier', 'Extra parameter for contour modes 2/5', draft.groundContourModifier ?? 0, (v) => set('groundContourModifier', v), -32768, 32767)}
        </div>
      </>}

      {show('cursors') && <>
        <div className="mapscene-side-section">Cursors</div>
        <p className="mapscene-side-note">
          Override the mouse cursor for one right-click option. The slot is which
          option it applies to; 9139 objects in this cache set at least one.
        </p>
        <div className="mapscene-side-grid is-compact">
          {cursorPick('Primary', 'Cursor shown over the option below (opcode 99). -1 = the default cursor.',
            'primaryCursor', primaryCursor, draft.primaryCursorActionIndex ?? -1,
            (v) => set('primaryCursor', v), (v) => set('primaryCursorActionIndex', v))}
          {cursorPick('Secondary', 'Second cursor override (opcode 100)',
            'secondaryCursor', secondaryCursor, draft.secondaryCursorActionIndex ?? -1,
            (v) => set('secondaryCursor', v), (v) => set('secondaryCursorActionIndex', v))}
          {num('Interactable', 'Opcode 19 — 0/1 flag for whether the object takes interactions at all (-1 = unset)', draft.interactable ?? -1, (v) => set('interactable', v), -1, 255)}
          {flag('Members only', 'Opcode 91 — members-world content', draft.members ?? false, (v) => set('members', v))}
        </div>
      </>}

      {show('appearance') && <>
        <div className="mapscene-side-section">Appearance</div>
        <div className="mapscene-side-grid is-compact">
          {num('Ambient', 'Opcode 29 — model ambient light offset (signed byte). Our bake uses 64 + this.', draft.ambient ?? 0, (v) => set('ambient', v), -128, 127)}
          {num('Contrast', 'Opcode 39 — raw byte, as dumped. The client lights the model with 850 + this*5 as a DIVISOR, so higher = flatter shading.', draft.contrast ?? 0, (v) => set('contrast', v), -128, 127)}
          {num('Scale X', 'Opcode 65 — 128 = 100%', draft.scaleX ?? 128, (v) => set('scaleX', v), 0, 65535)}
          {num('Scale Y', 'Opcode 66 — 128 = 100% (height)', draft.scaleY ?? 128, (v) => set('scaleY', v), 0, 65535)}
          {num('Scale Z', 'Opcode 67 — 128 = 100%', draft.scaleZ ?? 128, (v) => set('scaleZ', v), 0, 65535)}
          {num('Offset X', 'Opcode 70 — world-unit shift, stored as a short << 2', draft.offsetX ?? 0, (v) => set('offsetX', v), -32768, 32767)}
          {num('Offset Y', 'Opcode 71 — vertical shift (down is positive in RS model space)', draft.offsetY ?? 0, (v) => set('offsetY', v), -32768, 32767)}
          {num('Offset Z', 'Opcode 72 — world-unit shift', draft.offsetZ ?? 0, (v) => set('offsetZ', v), -32768, 32767)}
          {flag('Mirrored', 'Opcode 62 — the model is drawn inverted', draft.inverted ?? false, (v) => set('inverted', v))}
          {flag('Static shadow', 'Opcode 64 clears this — the darkened ring baked under the object', draft.staticShadow ?? true, (v) => set('staticShadow', v))}
          {flag('Dynamic shadow', 'Opcode 88 clears this — the GPU sun-following shadow', draft.dynamicShadow ?? true, (v) => set('dynamicShadow', v))}
          {flag('Delay shading', 'Opcode 22', draft.delayShading ?? false, (v) => set('delayShading', v))}
          {flag('Needs textures', 'Opcode 82 — only drawn when textures are enabled', draft.requiresTextures ?? false, (v) => set('requiresTextures', v))}
          {num('Occludes', 'Opcode 23 sets 1, opcode 103 sets 0 (client occlusionMode, -1 = unset)', draft.occludes ?? -1, (v) => set('occludes', v), -1, 2)}
          {num('Decor displacement', "Opcode 28 — how far this WALL pushes decorations hanging on it (default 64)", draft.decorDisplacement ?? 64, (v) => set('decorDisplacement', v), 0, 1020)}
          {num('Ground decor height', 'Opcode 81-ish — vertical offset for ground decoration', draft.groundDecorationHeight ?? 0, (v) => set('groundDecorationHeight', v), -32768, 32767)}
        </div>
      </>}

      {show('morph') && <>
        <div className="mapscene-side-section">Models &amp; morphing</div>
        <div className="mapscene-side-grid is-compact">
          {(() => {
            // one row per shape entry (opcode 1): the shape and its model ids
            // are parallel arrays, so the table edits them in lockstep
            const models = draft.objectModelIds ?? []
            const shapes = draft.shapes ?? []
            const rows = Math.max(models.length, shapes.length)
            const filled = (len: number) => {
              const nm = models.map((g) => g.slice())
              while (nm.length < len) nm.push([])
              const ns = shapes.slice()
              while (ns.length < len) ns.push(10)
              return { nm, ns }
            }
            const commit = (nm: number[][], ns: number[]) => onChange({
              ...draft,
              objectModelIds: nm.length ? nm : undefined,
              shapes: nm.length ? ns : undefined,
            })
            return (
              <div className="item-field is-wide" title="Model ids per shape entry (opcode 1): each row is one loc shape and the models the client draws for it. Shape numbers match the placement Type (0–22).">
                <span className="item-field-label">Models</span>
                {rows > 0 && (
                  <div className="quest-table-wrap mapscene-def-table-wrap">
                  <table className="quest-table mapscene-pair-table">
                    <thead><tr><th className="mapscene-models-shape">Shape</th><th>Model IDs</th>{canEdit && <th />}</tr></thead>
                    <tbody>
                      {Array.from({ length: rows }, (_, i) => (
                        <tr key={i}>
                          <td className="mapscene-models-shape" title={LOC_TYPE_LABELS[shapes[i] ?? -1] ?? ''}>
                            {canEdit
                              ? <NumberInput className="cell-input" value={shapes[i] ?? 10} onChange={(v) => { const { nm, ns } = filled(rows); ns[i] = v; commit(nm, ns) }} min={0} max={22} />
                              : <span className="mapscene-field-value">{shapes[i] ?? '—'}</span>}
                          </td>
                          <td>
                            {canEdit
                              ? <ListInput className="cell-input" value={models[i] ?? []} onCommit={(ids) => { const { nm, ns } = filled(rows); nm[i] = ids; commit(nm, ns) }} />
                              : <span className="mapscene-field-value">{(models[i] ?? []).join(', ') || '—'}</span>}
                          </td>
                          {canEdit && (
                            <td className="mapscene-pair-remove">
                              <button type="button" className="row-remove-btn" title="Remove this shape entry" onClick={() => { const { nm, ns } = filled(rows); commit(nm.filter((_, k) => k !== i), ns.filter((_, k) => k !== i)) }}>×</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
                {rows === 0 && !canEdit && <span className="mapscene-field-value">—</span>}
                {canEdit && (
                  <button type="button" className="add-row-btn" onClick={() => { const { nm, ns } = filled(rows); commit([...nm, []], [...ns, 10]) }}>
                    + Add shape entry
                  </button>
                )}
              </div>
            )
          })()}
          <label className="item-field is-wide" title="Idle sequence ids the object cycles through (opcodes 24/106) — waving flags, turning windmills. Comma-separated.">
            <span className="item-field-label">Animations</span>
            {canEdit
              ? <ListInput value={draft.animations ?? []} onCommit={(ids) => set('animations', ids.length > 0 ? ids : undefined)} />
              : <span className="mapscene-field-value">{(draft.animations ?? []).join(', ') || '—'}</span>}
          </label>
          {num('Varbit', 'Opcodes 77/92 — the varbit whose value picks the morph target. -1 = none.', draft.varpBit ?? -1, (v) => set('varpBit', v))}
          {num('Varp', 'Opcodes 77/92 — the varp whose value picks the morph target. -1 = none.', draft.varp ?? -1, (v) => set('varp', v))}
          {(() => {
            // positional like the objects entry's table: transformTo[var value]
            // is the object shown for that value, last slot = fallback
            const transforms = draft.transformTo ?? []
            // editing the list shifts indices, so any active scene preview is
            // dropped rather than left pointing at the wrong row
            const commit = (next: number[]) => {
              onMorphPreview?.(null)
              set('transformTo', next.length > 0 ? next : undefined)
            }
            return (
              <div className="item-field is-wide" title="Multiloc targets (opcodes 77/92): the client swaps this def for transformTo[var value]. The LAST entry is the out-of-range fallback (often -1 = invisible).">
                <span className="item-field-label">Transform to</span>
                {transforms.length > 0 && (
                  <div className="quest-table-wrap mapscene-def-table-wrap">
                  <table className="quest-table mapscene-pair-table">
                    <thead><tr><th className="mapscene-var-col">Var value</th><th className="mapscene-obj-col">Object</th>{onMorphPreview && <th />}<th />{canEdit && <th />}</tr></thead>
                    <tbody>
                      {transforms.map((objectId, i) => (
                        <tr key={i} className={morphPreviewIndex === i ? 'mapscene-preview-row' : undefined}>
                          <td className="mapscene-var-col">
                            <span className="mapscene-field-value">{i === transforms.length - 1 ? `${i} / fallback` : i}</span>
                          </td>
                          <td className="mapscene-obj-col">
                            {canEdit
                              ? <NumberInput className="cell-input" value={objectId} onChange={(v) => { const next = transforms.slice(); next[i] = v; commit(next) }} min={-1} max={131071} />
                              : <span className="mapscene-field-value">{objectId}</span>}
                          </td>
                          {onMorphPreview && (
                            <td className="mapscene-view-col">
                              <button
                                type="button"
                                className={`field-link-btn${morphPreviewIndex === i ? ' is-previewing' : ''}`}
                                title={objectId >= 0
                                  ? 'Show this placement as this object in the 3D view — preview only, nothing is saved. Click again to restore.'
                                  : 'Preview the invisible state (the placement disappears). Click again to restore.'}
                                onClick={() => (morphPreviewIndex === i ? onMorphPreview(null) : onMorphPreview(i, objectId))}
                              >
                                {morphPreviewIndex === i ? 'Restore' : 'Preview'}
                              </button>
                            </td>
                          )}
                          <td className="mapscene-view-col">
                            {onNavigate && objectId >= 0 && (
                              <button type="button" className="field-link-btn" title={`Open object ${objectId}`} onClick={() => onNavigate('objects', objectId)}>
                                View
                              </button>
                            )}
                          </td>
                          {canEdit && (
                            <td className="mapscene-pair-remove">
                              <button type="button" className="row-remove-btn" title="Remove this slot (later var values shift down)" onClick={() => commit(transforms.filter((_, k) => k !== i))}>×</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
                {transforms.length === 0 && !canEdit && <span className="mapscene-field-value">—</span>}
                {canEdit && (
                  <button type="button" className="add-row-btn" onClick={() => commit([...transforms, -1])}>+ Add transform</button>
                )}
              </div>
            )
          })()}
          {pairTable('Recolours', 'Colour swaps applied to the model (opcode 40): each original HSL16 is replaced by the recoloured one. The swatch shows the colour the id encodes — click it to pick a colour (snapped to the nearest HSL16).',
            'Recoloured', 'originalColors', 'modifiedColors',
            (v, commit) => <HslSwatch value={v} onPick={canEdit ? commit : undefined} />)}
          {pairTable('Retextures', 'Texture swaps applied to the model (opcode 41): each original texture id is replaced by the retextured one. The thumbnail is the texture’s dumped PNG.',
            'Retextured', 'originalTextures', 'modifiedTextures',
            (v) => <TexSwatch root={root} id={v} />)}
        </div>
      </>}

      {show('sprite') && <>
        <div className="mapscene-side-section">Map sprite — the minimap symbol</div>
        {spriteBlocked ? (
          <div className="mapscene-blocked-section">
            <p>
              <strong>Wall decorations don't draw a map sprite.</strong> This
              placement is a {(LOC_TYPE_LABELS[placementType!] ?? `type ${placementType}`).toLowerCase()} (type {placementType}),
              which the client files in the wall-decoration slot. Its per-tile
              minimap pass only reads <code>mapSpriteId</code> from the wall,
              scenery and floor-decoration slots — it never looks at
              wall decorations at all, so setting one here would do nothing in
              game. The wall it hangs on draws its own symbol.
            </p>
            <p className="mapscene-blocked-value">
              Stored value: <code>mapSpriteId {spriteId}</code>
              {spriteId >= 0 && ' — only ever drawn where this object is also placed in another slot.'}
            </p>
          </div>
        ) : <>
          <div className="mapscene-side-grid is-compact">
            {idPick('Sprite id', 'config/map_sprites record (client mapIconId, opcode 102). -1 = none', spriteId, 'mapsprite', (v) => set('mapSpriteId', v))}
            {num('Rotation', 'Quarter turns (client mapIconRotation, opcode 101)', draft.mapSpriteRotation ?? 0, (v) => set('mapSpriteRotation', v), 0, 3)}
            {flag('Flip', 'Draw the sprite flipped vertically (client mapIconFlipped, opcode 105)', draft.flipMapSprite ?? false, (v) => set('flipMapSprite', v))}
            {flag('Rotates', "Add the placement's rotation to the sprite's (client mapIconRotates, opcode 97). Off = always drawn unrotated.", draft.adjustMapSceneRotation ?? false, (v) => set('adjustMapSceneRotation', v))}
          </div>
          {spriteId >= 0 && (
            <div className="mapscene-sprite-previews">
              <div className="mapscene-sprite-preview">
                <span className="item-field-label">Minimap sprite</span>
                {sprite?.url
                  ? <img src={sprite.url} alt="map sprite" />
                  : <span className="mapscene-field-value">{spriteNote ?? 'loading…'}</span>}
              </div>
            </div>
          )}
        </>}
      </>}

      {show('icon') && <>
        <div className="mapscene-side-section">Map icon — the world-map/minimap pin</div>
        <div className="mapscene-side-grid is-compact">
          {idPick('Category id', 'config/areas record whose icon this object pins on the map (client mapCategoryid, opcode 107). -1 = none', categoryId, 'mapicon', (v) => set('mapCategoryId', v))}
        </div>
        {categoryId >= 0 && (
          <div className="mapscene-sprite-previews">
            <div className="mapscene-sprite-preview">
              <span className="item-field-label">{area?.name ?? 'Map icon'}</span>
              {area?.spriteUrl
                ? <img src={area.spriteUrl} alt="map icon" />
                : <span className="mapscene-field-value">{areaNote ?? 'loading…'}</span>}
            </div>
          </div>
        )}
      </>}

      {show('sound') && <>
        <div className="mapscene-side-section">Sound</div>
        <div className="mapscene-side-grid is-compact">
          {num('Ambient sound', 'sound_effects id played on loop (client soundId, opcode 78). -1 = silent', draft.ambientSoundId ?? -1, (v) => set('ambientSoundId', v))}
          {num('Hear distance', 'Tiles the sound carries (client soundRadius, opcodes 78/79)', draft.ambientSoundHearDistance ?? 0, (v) => set('ambientSoundHearDistance', v), 0, 255)}
          {num('Max hear dist', 'Client ambientSoundMaxHearDistance, opcode 178', draft.ambientSoundMaxHearDistance ?? 0, (v) => set('ambientSoundMaxHearDistance', v), 0, 255)}
          {num('Volume', 'Client soundVolume, opcode 104. -1 = unset, which the client reads as 255 (full)', draft.ambientSoundVolume ?? -1, (v) => set('ambientSoundVolume', v), -1, 255)}
          {num('Min interval', 'Shortest gap between plays, in ticks (opcode 79)', draft.soundMinInterval ?? 0, (v) => set('soundMinInterval', v), 0, 65535)}
          {num('Max interval', 'Longest gap between plays, in ticks (opcode 79)', draft.soundMaxInterval ?? 0, (v) => set('soundMaxInterval', v), 0, 65535)}
          {num('Min delay', 'Client ambientSoundMinDelay, opcode 173 (default 256)', draft.ambientSoundMinDelay ?? 256, (v) => set('ambientSoundMinDelay', v), 0, 65535)}
          {num('Max delay', 'Client ambientSoundMaxDelay, opcode 173 (default 256)', draft.ambientSoundMaxDelay ?? 256, (v) => set('ambientSoundMaxDelay', v), 0, 65535)}
          {flag('Instrument SFX', 'Client instrumentSoundEffect, opcode 168', draft.instrumentSoundEffect ?? false, (v) => set('instrumentSoundEffect', v))}
          {flag('Instrument amb.', 'Client instrumentAmbientSound, opcode 169', draft.instrumentAmbientSound ?? false, (v) => set('instrumentAmbientSound', v))}
          <label className="item-field is-wide" title="Sound ids picked from at random each play (opcode 79). Comma-separated; empty = none.">
            <span className="item-field-label">Sound group</span>
            {canEdit
              ? <ListInput value={draft.soundGroupIds ?? []} placeholder="e.g. 3896, 3892" onCommit={(ids) => set('soundGroupIds', ids.length > 0 ? ids : undefined)} />
              : <span className="mapscene-field-value">{(draft.soundGroupIds ?? []).join(', ') || '—'}</span>}
          </label>
        </div>
      </>}

      {picking && root && (
        <MapSymbolPicker
          root={root}
          kind={picking.kind}
          selectedId={picking.current}
          onPick={(id) => {
            onChange({ ...draft, [picking.field]: id })
            setPicking(null)
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  )
}
