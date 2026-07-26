import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import MapSymbolPicker from './MapSymbolPicker'
import type { SymbolKind } from './MapSymbolPicker'
import type { ObjectDefJson } from './mapScene'

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

/** Editor for the fields of an object DEFINITION (`objects/<id>.json`).
 *
 *  Shared by the map scene's marker and object panels — a marker IS an object,
 *  so the only difference between them is which sections are worth showing.
 *  The parent owns the draft and the dirty/Apply flow; this only edits.
 *
 *  Labels use cryogen's dumped field names (what you'd search the JSON for);
 *  the client's own names and the opcodes are in the tooltips, since the two
 *  disagree on most of the sound fields. `EDITOR.md` has the full mapping. */
export default function ObjectDefEditor({ draft, canEdit, onChange, sections, root, loadSprite, loadArea }: {
  draft: ObjectDefJson
  canEdit: boolean
  onChange: (next: ObjectDefJson) => void
  sections: DefSection[]
  /** cache root, for the sprite/icon browsers — no browsing without it */
  root: FileSystemDirectoryHandle | null
  loadSprite: (id: number) => Promise<MapSpriteInfo | null>
  loadArea: (id: number) => Promise<AreaInfo | null>
}) {
  const set = <K extends keyof ObjectDefJson>(key: K, value: ObjectDefJson[K]) =>
    onChange({ ...draft, [key]: value })

  const spriteId = draft.mapSpriteId ?? -1
  const categoryId = draft.mapCategoryId ?? -1
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
        <label className="mapscene-toggle">
          <input type="checkbox" checked={value} onChange={(e) => onValue(e.target.checked)} />
          {value ? 'yes' : 'no'}
        </label>
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
          <div className="item-field is-wide" title="Model ids per shape entry (opcode 1). Read-only here — swapping meshes belongs in the model tools.">
            <span className="item-field-label">Models</span>
            <span className="mapscene-field-value">{(draft.objectModelIds ?? []).flat().join(', ') || '—'}</span>
          </div>
          <div className="item-field is-wide" title="Which loc shape each model group is for, parallel to Models">
            <span className="item-field-label">Shapes</span>
            <span className="mapscene-field-value">{(draft.shapes ?? []).join(', ') || '—'}</span>
          </div>
          <label className="item-field is-wide" title="Idle sequence ids the object cycles through (opcodes 24/106) — waving flags, turning windmills. Comma-separated.">
            <span className="item-field-label">Animations</span>
            {canEdit ? (
              <input
                className="item-field-input"
                type="text"
                value={(draft.animations ?? []).join(', ')}
                placeholder="—"
                onChange={(e) => {
                  const ids = e.target.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
                  set('animations', ids.length > 0 ? ids : undefined)
                }}
              />
            ) : <span className="mapscene-field-value">{(draft.animations ?? []).join(', ') || '—'}</span>}
          </label>
          {num('Varbit', 'Opcodes 77/92 — the varbit whose value picks the morph target. -1 = none.', draft.varpBit ?? -1, (v) => set('varpBit', v))}
          {num('Varp', 'Opcodes 77/92 — the varp whose value picks the morph target. -1 = none.', draft.varp ?? -1, (v) => set('varp', v))}
          <label className="item-field is-wide" title="Multiloc targets: the client swaps this def for transformTo[var]. The LAST entry is the out-of-range fallback (often -1 = invisible). Comma-separated.">
            <span className="item-field-label">Transform to</span>
            {canEdit ? (
              <input
                className="item-field-input"
                type="text"
                value={(draft.transformTo ?? []).join(', ')}
                placeholder="—"
                onChange={(e) => {
                  const ids = e.target.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
                  set('transformTo', ids.length > 0 ? ids : undefined)
                }}
              />
            ) : <span className="mapscene-field-value">{(draft.transformTo ?? []).join(', ') || '—'}</span>}
          </label>
          <div className="item-field is-wide" title="Colour swaps applied to the model (opcode 40): each original HSL16 is replaced by the modified one at the same index.">
            <span className="item-field-label">Recolours</span>
            <span className="mapscene-field-value">
              {(draft.originalColors ?? []).length
                ? (draft.originalColors ?? []).map((c, i) => `${c}→${draft.modifiedColors?.[i] ?? '?'}`).join(', ')
                : '—'}
            </span>
          </div>
          <div className="item-field is-wide" title="Texture swaps applied to the model (opcode 41)">
            <span className="item-field-label">Retextures</span>
            <span className="mapscene-field-value">
              {(draft.originalTextures ?? []).length
                ? (draft.originalTextures ?? []).map((t, i) => `${t}→${draft.modifiedTextures?.[i] ?? '?'}`).join(', ')
                : '—'}
            </span>
          </div>
        </div>
      </>}

      {show('sprite') && <>
        <div className="mapscene-side-section">Map sprite — the minimap symbol</div>
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
            {canEdit ? (
              <input
                className="item-field-input"
                type="text"
                value={(draft.soundGroupIds ?? []).join(', ')}
                placeholder="e.g. 3896, 3892"
                onChange={(e) => {
                  const ids = e.target.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
                  set('soundGroupIds', ids.length > 0 ? ids : undefined)
                }}
              />
            ) : <span className="mapscene-field-value">{(draft.soundGroupIds ?? []).join(', ') || '—'}</span>}
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
