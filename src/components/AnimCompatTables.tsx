import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ItemIcon, SortableTh } from './defFields'
import type { SortState } from './defFields'
import type { ItemUse, NpcUse, SpotUse } from '../loaders/animCompat'
import './AnimCompatTables.css'

// Shared result tables for the animation-compatibility index (animCompat.ts),
// used by the animation and BAS viewers. Rendering is capped — the humanoid
// skeleton alone matches thousands of NPCs — with the filter as the way in.
const ROW_CAP = 400

/** One previewable sequence choice for the NpcFitTable dropdown (BAS viewer:
    the movement-matrix mains — Stand, Walk, Run, Teleport). */
export type PreviewAnimOption = { label: string; seqId: number }

// "View Anim ▾" — same outside-click-to-close pattern as QuestViewer's
// BadgeDropdown, reusing its shared .badge-dropdown-* classes. Unlike that
// one, the menu portals into document.body as position:fixed at the
// trigger's viewport rect: the fit tables live inside overflow scroll
// containers that clip an absolute menu, and an ancestor transform/filter
// re-bases fixed coords if the menu stays in the table's subtree (both
// happened). Fixed coords go stale on scroll, so any scroll/resize simply
// closes the menu.
function PreviewAnimDropdown({ options, onPick }: {
  options: PreviewAnimOption[]
  onPick: (seqId: number) => void
}) {
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | { left: number; bottom: number } | null>(null)
  const open = menuPos != null
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setMenuPos(null)
    }
    function onScrollOrResize() { setMenuPos(null) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  function toggle() {
    if (open) { setMenuPos(null); return }
    const rect = btnRef.current!.getBoundingClientRect()
    // keep the menu on-screen: clamp the left edge, flip upward when the
    // estimated height (~33px/item) wouldn't fit below the trigger
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 200))
    const estHeight = options.length * 33 + 10
    if (rect.bottom + 6 + estHeight > window.innerHeight) {
      setMenuPos({ left, bottom: window.innerHeight - rect.top + 6 })
    } else {
      setMenuPos({ left, top: rect.bottom + 6 })
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="field-link-btn"
        title="Preview one of this BAS's sequences on this NPC's model"
        onClick={toggle}
      >
        View Anim <span className="badge-dropdown-caret">▾</span>
      </button>
      {menuPos && createPortal(
        <div
          ref={menuRef}
          className="badge-dropdown-menu anim-preview-menu"
          style={{ position: 'fixed', top: 'auto', ...menuPos }}
        >
          {options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className="badge-dropdown-item"
              onClick={() => { setMenuPos(null); onPick(opt.seqId) }}
            >
              {opt.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

export function NpcFitTable({ npcs, emptyText, onNavigate, onPreviewAnim, previewOptions }: {
  npcs: NpcUse[]
  emptyText: string
  onNavigate?: (entryName: string, itemId: number) => void
  /** When set, rows get a "View Anim" button (e.g. preview the open animation on this NPC's model). */
  onPreviewAnim?: (npc: NpcUse, seqId?: number) => void
  /** When also set, the button becomes a dropdown of these sequences and
      onPreviewAnim receives the picked seqId (BAS viewer: stand/walk/run/teleport). */
  previewOptions?: PreviewAnimOption[]
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'id', dir: 1 })

  if (npcs.length === 0) return <p className="map-sprite-none">{emptyText}</p>

  const f = filter.trim().toLowerCase()
  const filtered = f === ''
    ? npcs
    : npcs.filter((n) => n.name.toLowerCase().includes(f) || String(n.id).includes(f) || n.modelIds.some((m) => String(m).includes(f)))
  const sorted = [...filtered].sort((a, b) => {
    const byName = sort.key === 'name' ? a.name.localeCompare(b.name) : 0
    return sort.dir * (byName !== 0 ? byName : a.id - b.id)
  })
  const shown = sorted.slice(0, ROW_CAP)

  return (
    <div className="map-sprite-uses-inner">
      <div className="map-sprite-uses-head">
        <span className="map-sprite-hint">
          {npcs.length.toLocaleString()} NPC{npcs.length === 1 ? '' : 's'}
          {f !== '' && ` — ${filtered.length.toLocaleString()} matching`}
          {sorted.length > ROW_CAP && ` — first ${ROW_CAP} shown, filter to narrow`}
        </span>
        {npcs.length > 8 && (
          <input
            type="text"
            className="map-sprite-uses-filter"
            placeholder="Filter by name, id or model id…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      <div className="quest-table-wrap map-sprite-uses-wrap">
        <table className="quest-table">
          <thead>
            <tr>
              <SortableTh label="NPC" sortKey="name" sort={sort} onSort={setSort} />
              <SortableTh label="ID" sortKey="id" sort={sort} onSort={setSort} />
              <th>Models</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td className="map-sprite-use-id">{n.id}</td>
                <td>
                  <span className="anim-fit-models">
                    {n.modelIds.map((m, i) => (
                      <button
                        key={i}
                        type="button"
                        className="field-link-btn"
                        title={`Open model ${m}`}
                        onClick={() => onNavigate?.('models', m)}
                      >
                        {m}
                      </button>
                    ))}
                  </span>
                </td>
                <td>
                  <span className="anim-fit-actions">
                    {onNavigate && (
                      <button type="button" className="field-link-btn" title={`Open NPC ${n.id}`} onClick={() => onNavigate('npcs', n.id)}>
                        View NPC
                      </button>
                    )}
                    {onPreviewAnim && n.modelIds.length > 0 && (
                      previewOptions ? (
                        previewOptions.length > 0 && (
                          <PreviewAnimDropdown
                            options={previewOptions}
                            onPick={(seqId) => onPreviewAnim(n, seqId)}
                          />
                        )
                      ) : (
                        <button
                          type="button"
                          className="field-link-btn"
                          title={`Preview this animation on model ${n.modelIds[0]}`}
                          onClick={() => onPreviewAnim(n)}
                        >
                          View Anim
                        </button>
                      )
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ItemUseTable({ items, emptyText, onNavigate }: {
  items: ItemUse[]
  emptyText: string
  onNavigate?: (entryName: string, itemId: number) => void
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'id', dir: 1 })

  if (items.length === 0) return <p className="map-sprite-none">{emptyText}</p>

  const f = filter.trim().toLowerCase()
  const filtered = f === ''
    ? items
    : items.filter((it) => it.name.toLowerCase().includes(f) || String(it.id).includes(f))
  const sorted = [...filtered].sort((a, b) => {
    const byName = sort.key === 'name' ? a.name.localeCompare(b.name) : 0
    return sort.dir * (byName !== 0 ? byName : a.id - b.id)
  })
  const shown = sorted.slice(0, ROW_CAP)

  return (
    <div className="map-sprite-uses-inner">
      <div className="map-sprite-uses-head">
        <span className="map-sprite-hint">
          {items.length.toLocaleString()} item{items.length === 1 ? '' : 's'}
          {f !== '' && ` — ${filtered.length.toLocaleString()} matching`}
          {sorted.length > ROW_CAP && ` — first ${ROW_CAP} shown, filter to narrow`}
        </span>
        {items.length > 8 && (
          <input
            type="text"
            className="map-sprite-uses-filter"
            placeholder="Filter by name or id…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      <div className="quest-table-wrap map-sprite-uses-wrap">
        <table className="quest-table">
          <thead>
            <tr>
              <th className="pair-icon-th" />
              <SortableTh label="Item" sortKey="name" sort={sort} onSort={setSort} />
              <SortableTh label="ID" sortKey="id" sort={sort} onSort={setSort} />
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((it) => (
              <tr key={it.id}>
                <td className="pair-icon-cell"><ItemIcon id={it.id} /></td>
                <td>{it.name}</td>
                <td className="map-sprite-use-id">{it.id}</td>
                <td>
                  {onNavigate && (
                    <button type="button" className="field-link-btn" title={`Open item ${it.id}`} onClick={() => onNavigate('items', it.id)}>
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
}

export function SpotFitTable({ spots, emptyText, onNavigate }: {
  spots: SpotUse[]
  emptyText: string
  onNavigate?: (entryName: string, itemId: number) => void
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'id', dir: 1 })

  if (spots.length === 0) return <p className="map-sprite-none">{emptyText}</p>

  const f = filter.trim()
  const filtered = f === ''
    ? spots
    : spots.filter((s) => String(s.id).includes(f) || String(s.modelId).includes(f) || String(s.sequenceId).includes(f))
  const key = sort.key as 'id' | 'model' | 'seq'
  const sorted = [...filtered].sort((a, b) => {
    const primary = key === 'model' ? a.modelId - b.modelId : key === 'seq' ? a.sequenceId - b.sequenceId : a.id - b.id
    return sort.dir * (primary !== 0 ? primary : a.id - b.id)
  })
  const shown = sorted.slice(0, ROW_CAP)

  const link = (entry: string, id: number) => (
    onNavigate ? (
      <button type="button" className="field-link-btn" title={`Open ${entry} ${id}`} onClick={() => onNavigate(entry, id)}>
        {id}
      </button>
    ) : (
      <span className="map-sprite-use-id">{id}</span>
    )
  )

  return (
    <div className="map-sprite-uses-inner">
      <div className="map-sprite-uses-head">
        <span className="map-sprite-hint">
          {spots.length.toLocaleString()} spot anim pairing{spots.length === 1 ? '' : 's'}
          {f !== '' && ` — ${filtered.length.toLocaleString()} matching`}
          {sorted.length > ROW_CAP && ` — first ${ROW_CAP} shown, filter to narrow`}
        </span>
        {spots.length > 8 && (
          <input
            type="text"
            className="map-sprite-uses-filter"
            placeholder="Filter by spot / model / sequence id…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      <div className="quest-table-wrap map-sprite-uses-wrap">
        <table className="quest-table">
          <thead>
            <tr>
              <SortableTh label="Spot Anim" sortKey="id" sort={sort} onSort={setSort} />
              <SortableTh label="Model" sortKey="model" sort={sort} onSort={setSort} />
              <SortableTh label="Sequence" sortKey="seq" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{link('spot_animations', s.id)}</td>
                <td>{link('models', s.modelId)}</td>
                <td>{link('animations', s.sequenceId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
