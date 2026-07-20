import { useState } from 'react'
import { ItemIcon, SortableTh } from './defFields'
import type { SortState } from './defFields'
import type { ItemUse, NpcUse, SpotUse } from '../loaders/animCompat'
import './AnimCompatTables.css'

// Shared result tables for the animation-compatibility index (animCompat.ts),
// used by the animation and BAS viewers. Rendering is capped — the humanoid
// skeleton alone matches thousands of NPCs — with the filter as the way in.
const ROW_CAP = 400

export function NpcFitTable({ npcs, emptyText, onNavigate, onPreviewAnim }: {
  npcs: NpcUse[]
  emptyText: string
  onNavigate?: (entryName: string, itemId: number) => void
  /** When set, rows get a "View Anim" button (e.g. preview the open animation on this NPC's model). */
  onPreviewAnim?: (npc: NpcUse) => void
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
                      <button
                        type="button"
                        className="field-link-btn"
                        title={`Preview this animation on model ${n.modelIds[0]}`}
                        onClick={() => onPreviewAnim(n)}
                      >
                        View Anim
                      </button>
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
