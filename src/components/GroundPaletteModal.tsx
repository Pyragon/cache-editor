// Binding the generator's ground-material roles to real ids in THIS cache.
//
// The cache does not name its ground materials — `config/underlays/163.json`
// is an rgb, a texture id and a scale. So which underlay is "dead grass" is a
// judgement only someone looking at it can make, and the generator's shipped
// numbers are guesses (see `procgen/palette.ts`). This is where they get
// replaced, once per cache.
//
// The swatch shows the TEXTURE, not just the colour, because for a textured
// material the colour is a tint and choosing by it is actively misleading:
// underlay 163 — the one id known to be right — has an ORANGE rgb and renders
// as green grass. Materials with no texture do draw as their flat colour, and
// those show the chip alone.
import { useEffect, useMemo, useState } from 'react'
import TextureThumb from './TextureThumb'
import {
  DEFAULT_PALETTE, OVERLAY_ROLES, ROLE_INFO, UNDERLAY_ROLES,
  loadGroundMaterials, type GroundMaterial, type GroundPalette, type PaletteRole,
} from '../procgen/palette'
import './GroundPaletteModal.css'

const hex = (rgb: number) => `#${(rgb >>> 0).toString(16).padStart(6, '0').slice(-6)}`

function Swatch({ rootHandle, mat }: { rootHandle: FileSystemDirectoryHandle | undefined; mat: GroundMaterial | undefined }) {
  if (!mat) return <span className="texture-thumb texture-thumb-none">?</span>
  if (mat.texture < 0) {
    return (
      <span
        className="gpal-chip"
        style={{ background: hex(mat.rgb) }}
        title={`Flat colour ${hex(mat.rgb)} — no texture`}
      />
    )
  }
  return <TextureThumb rootHandle={rootHandle} id={mat.texture} />
}

export default function GroundPaletteModal({
  rootHandle, palette, onChange, onClose,
}: {
  rootHandle: FileSystemDirectoryHandle | undefined
  palette: GroundPalette
  onChange: (next: GroundPalette) => void
  onClose: () => void
}) {
  const [mats, setMats] = useState<{ underlays: GroundMaterial[]; overlays: GroundMaterial[] } | null>(null)
  const [error, setError] = useState('')
  /** the role currently being re-bound; null = just showing the bindings */
  const [choosing, setChoosing] = useState<PaletteRole | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!rootHandle) { setError('No cache open.'); return }
    void loadGroundMaterials(rootHandle)
      .then((m) => { if (!cancelled) setMats(m) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [rootHandle])

  const isOverlayRole = choosing != null && (OVERLAY_ROLES as readonly string[]).includes(choosing)
  const pool = useMemo(() => {
    if (!mats || !choosing) return []
    const list = isOverlayRole ? mats.overlays : mats.underlays
    const q = filter.trim().toLowerCase()
    if (!q) return list
    // id match, or hex-colour match, so "8b" finds brownish tints
    return list.filter((m) => String(m.id) === q || String(m.id).startsWith(q) || hex(m.rgb).includes(q))
  }, [mats, choosing, filter, isOverlayRole])

  const byId = useMemo(() => {
    const u = new Map<number, GroundMaterial>()
    const o = new Map<number, GroundMaterial>()
    for (const m of mats?.underlays ?? []) u.set(m.id, m)
    for (const m of mats?.overlays ?? []) o.set(m.id, m)
    return { u, o }
  }, [mats])

  function bind(id: number) {
    if (!choosing) return
    onChange({ ...palette, [choosing]: id })
    setChoosing(null)
    setFilter('')
  }

  function roleRow(role: PaletteRole, overlay: boolean) {
    const info = ROLE_INFO[role]
    const id = palette[role]
    const mat = overlay ? byId.o.get(id) : byId.u.get(id)
    const isGuess = palette[role] === DEFAULT_PALETTE[role] && role !== 'grass'
    return (
      <div key={role} className="gpal-row">
        <Swatch rootHandle={rootHandle} mat={mat} />
        <span className="gpal-role">
          <strong>{info.label}</strong>
          <span className="tex-op-note gpal-blurb">{info.blurb}</span>
        </span>
        <span className="map-picker-selcount gpal-id">
          {mat ? `id ${id}` : `id ${id} — not in this cache`}
          {isGuess && <span className="gpal-guess" title="Still the shipped guess — nobody has looked at it"> guess</span>}
        </span>
        <button type="button" className="save-bar-discard" onClick={() => { setChoosing(role); setFilter('') }}>
          Choose…
        </button>
      </div>
    )
  }

  return (
    <div className="map-picker-overlay" onClick={onClose}>
      <div className="map-picker gpal-modal" onClick={(e) => e.stopPropagation()}>
        <div className="map-picker-head">
          <span className="enum-title map-picker-title">
            {choosing ? `Choose a material for “${ROLE_INFO[choosing].label}”` : 'Ground materials'}
          </span>
          <button type="button" className="map-picker-close" onClick={choosing ? () => setChoosing(null) : onClose}>
            {choosing ? 'Back' : 'Close'}
          </button>
        </div>

        {error && <div className="map-picker-msg procgen-error">{error}</div>}
        {!mats && !error && <div className="map-picker-msg">reading ground materials…</div>}

        {mats && !choosing && (
          <>
            <p className="tex-op-note">
              The generator plans in words — “dirt”, “dead grass” — and these bindings
              turn them into ids for this cache. The cache names none of its ground
              materials, so only you can say which is which. Saved per cache; you only
              do this once.
            </p>
            <div className="gpal-list">
              {UNDERLAY_ROLES.map((r) => roleRow(r, false))}
              <div className="gpal-sep">Overlays — drawn on top of the underlay</div>
              {OVERLAY_ROLES.map((r) => roleRow(r, true))}
            </div>
            <div className="map-picker-actions">
              <span className="map-picker-selcount">
                {mats.underlays.length} underlays · {mats.overlays.length} overlays in this cache
              </span>
              <button type="button" className="save-bar-discard" onClick={() => onChange({ ...DEFAULT_PALETTE })}>
                Reset to defaults
              </button>
              <button type="button" className="save-bar-save" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {mats && choosing && (
          <>
            <p className="tex-op-note">{ROLE_INFO[choosing].blurb}</p>
            <input
              className="map-coord-input gpal-filter"
              placeholder="filter by id or colour, e.g. 16 or 8b"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="gpal-grid">
              {pool.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`gpal-cell${palette[choosing] === m.id ? ' selected' : ''}`}
                  title={`id ${m.id} · tint ${hex(m.rgb)} · ${m.texture < 0 ? 'no texture' : `texture ${m.texture}`}`}
                  onClick={() => bind(m.id)}
                >
                  <Swatch rootHandle={rootHandle} mat={m} />
                  <span className="gpal-cell-id">{m.id}</span>
                </button>
              ))}
              {pool.length === 0 && <div className="map-picker-msg">nothing matches that filter</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
