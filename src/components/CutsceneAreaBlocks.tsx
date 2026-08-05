import { useMemo, useState } from 'react'
import { ALL_PLANES, CUTSCENE_CHUNKS, blockLabel, nextBlock } from '../loaders/cutscenes'
import type { CutsceneAreaBlock } from '../loaders/cutscenes'
import { NumberInput } from './defFields'
import './CutscenePianoRoll.css'

// The map a cutscene plays on, as the thing it actually is: source regions
// placed into a 13x13-chunk destination grid.
//
// The format stores one row per plane, but every block in the cache is the same
// four planes of the same region block, so a row is never the unit anyone
// reasons about — "this chunk gets built at 0,0, this one at 8,8" is. Shared by
// the new-cutscene modal and the editor's map section so both speak that way.

const SWATCHES = ['camera', 'entity', 'object', 'gfx', 'sound', 'misc']
const CHUNKS_PER_REGION = 8

type Props = {
  blocks: CutsceneAreaBlock[]
  onChange: (blocks: CutsceneAreaBlock[]) => void
  /** Open the world map viewer on a region — absent in the new-cutscene modal,
   *  which has nowhere to navigate to. */
  onNavigate?: (entryName: string, itemId: number) => void
  /** Keep at least one block — the new-cutscene flow has nothing to build from
   *  otherwise, while an existing cutscene may legitimately drop to zero. */
  minBlocks?: number
}

export default function CutsceneAreaBlocks({ blocks, onChange, onNavigate, minBlocks = 0 }: Props) {
  /** Region coords are what the format stores; world tiles are what everything
   *  else in the editor (and the map viewer) talks in. Same number either way,
   *  x64 apart — the toggle just picks which one you type. */
  const [worldCoords, setWorldCoords] = useState(false)
  const toRegion = (v: number) => (worldCoords ? Math.floor(v / 64) : v)
  const fromRegion = (v: number) => (worldCoords ? v * 64 : v)

  const patch = (i: number, p: Partial<CutsceneAreaBlock>) =>
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...p } : b)))

  const { owner, overlaps } = useMemo(() => {
    const owner = new Map<string, number>()
    let overlaps = 0
    blocks.forEach((b, i) => {
      for (let x = b.chunkX; x < b.chunkX + b.width; x++) {
        for (let y = b.chunkY; y < b.chunkY + b.length; y++) {
          if (x >= CUTSCENE_CHUNKS || y >= CUTSCENE_CHUNKS) continue
          const key = `${x},${y}`
          if (owner.has(key)) overlaps++
          owner.set(key, i)
        }
      }
    })
    return { owner, overlaps }
  }, [blocks])

  const offGrid = blocks.filter((b) => b.chunkX + b.width > CUTSCENE_CHUNKS || b.chunkY + b.length > CUTSCENE_CHUNKS)
  const rows = blocks.reduce((n, b) => n + b.planes.length, 0)

  return (
    <>
      <div className="cutscene-newmap-head">
        <span className="btn-pill">
          <button
            type="button"
            className={`zoom-btn${worldCoords ? '' : ' active'}`}
            title="Address the source as a region coordinate, the way the format stores it"
            onClick={() => setWorldCoords(false)}
          >
            Region x/y
          </button>
          <button
            type="button"
            className={`zoom-btn${worldCoords ? ' active' : ''}`}
            title="Address the source as a world tile — the region's base corner"
            onClick={() => setWorldCoords(true)}
          >
            World tiles
          </button>
        </span>
      </div>
      <div className="cutscene-newmap">
        <div className="cutscene-newmap-blocks">
        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr>
                <th /><th>{worldCoords ? 'Tile X' : 'Region X'}</th><th>{worldCoords ? 'Tile Y' : 'Region Y'}</th><th>Region id</th>
                <th>Dest X</th><th>Dest Y</th><th>W</th><th>L</th><th>Rot</th><th>Planes</th><th />
              </tr>
            </thead>
            <tbody>
              {blocks.map((b, i) => (
                <tr key={i}>
                  <td><span className={`cutscene-swatch piano-roll-${SWATCHES[i % SWATCHES.length]}`} /></td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={fromRegion(b.regionX)}
                      min={0}
                      max={worldCoords ? 255 * 64 : 255}
                      step={worldCoords ? 64 : 1}
                      onChange={(v) => patch(i, { regionX: toRegion(v) })}
                    />
                  </td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={fromRegion(b.regionY)}
                      min={0}
                      max={worldCoords ? 255 * 64 : 255}
                      step={worldCoords ? 64 : 1}
                      onChange={(v) => patch(i, { regionY: toRegion(v) })}
                    />
                  </td>
                  <td>
                    <NumberInput
                      className="cell-input"
                      value={(b.regionX << 8) | b.regionY}
                      min={0}
                      title="The same region, addressed the way the maps entry names it"
                      onChange={(v) => patch(i, { regionX: (v >> 8) & 0xff, regionY: v & 0xff })}
                    />
                  </td>
                  <td className="cutscene-narrow"><NumberInput className="cell-input" value={b.chunkX} min={0} max={CUTSCENE_CHUNKS - 1} onChange={(v) => patch(i, { chunkX: v })} /></td>
                  <td className="cutscene-narrow"><NumberInput className="cell-input" value={b.chunkY} min={0} max={CUTSCENE_CHUNKS - 1} onChange={(v) => patch(i, { chunkY: v })} /></td>
                  <td className="cutscene-narrow"><NumberInput className="cell-input" value={b.width} min={1} max={CHUNKS_PER_REGION} onChange={(v) => patch(i, { width: v })} /></td>
                  <td className="cutscene-narrow"><NumberInput className="cell-input" value={b.length} min={1} max={CHUNKS_PER_REGION} onChange={(v) => patch(i, { length: v })} /></td>
                  <td className="cutscene-narrow"><NumberInput className="cell-input" value={b.rotation} min={0} max={3} onChange={(v) => patch(i, { rotation: v })} /></td>
                  <td className="cutscene-planes">
                    <span className="btn-pill">
                      {ALL_PLANES.map((p) => {
                        const on = b.planes.includes(p)
                        return (
                          <button
                            key={p}
                            type="button"
                            className={`zoom-btn${on ? ' active' : ''}`}
                            title={`${on ? 'Stop copying' : 'Copy'} plane ${p}`}
                            onClick={() => patch(i, {
                              planes: on
                                ? b.planes.filter((x) => x !== p)
                                : [...b.planes, p].sort((x, y) => x - y),
                            })}
                          >
                            {p}
                          </button>
                        )
                      })}
                    </span>
                  </td>
                  <td>
                    <span className="anim-fit-actions">
                      {onNavigate && (
                        <button
                          type="button"
                          className="field-link-btn"
                          title={`Open the world map at ${blockLabel(b)}`}
                          onClick={() => onNavigate('maps', (b.regionX << 8) | b.regionY)}
                        >
                          Go to
                        </button>
                      )}
                      <button
                        type="button"
                        className="row-remove-btn"
                        disabled={blocks.length <= minBlocks}
                        onClick={() => onChange(blocks.filter((_, j) => j !== i))}
                      >×</button>
                    </span>
                  </td>
                </tr>
              ))}
              {blocks.length === 0 && (
                <tr><td colSpan={11} className="cutscene-editor-empty">No map — the scene will be empty.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="cutscene-editor-addrow">
          <button type="button" className="add-row-btn" onClick={() => onChange([...blocks, nextBlock(blocks)])}>
            + Add a region block
          </button>
          <span className="map-sprite-hint">
            {blocks.length} block{blocks.length === 1 ? '' : 's'} · {rows} area row{rows === 1 ? '' : 's'}
            {overlaps > 0 && ` · ${overlaps} chunk${overlaps === 1 ? '' : 's'} claimed twice`}
          </span>
        </div>
        </div>

        {/* The destination map, one square per chunk. Chunk 0,0 is the world's
            bottom-left, so rows are drawn from the highest Y down. */}
        <div className="cutscene-grid" aria-label="Destination chunk grid">
          {Array.from({ length: CUTSCENE_CHUNKS }, (_, row) => {
            const y = CUTSCENE_CHUNKS - 1 - row
            return (
              <div key={y} className="cutscene-grid-row">
                {Array.from({ length: CUTSCENE_CHUNKS }, (_, x) => {
                  const who = owner.get(`${x},${y}`)
                  return (
                    <span
                      key={x}
                      className={`cutscene-grid-cell ${who != null ? `piano-roll-${SWATCHES[who % SWATCHES.length]}` : 'empty'}`}
                      title={who != null ? `chunk ${x},${y} — ${blockLabel(blocks[who])}` : `chunk ${x},${y} — empty`}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {offGrid.length > 0 && (
        <p className="varbit-problem">
          {offGrid.length} block{offGrid.length === 1 ? '' : 's'} run past the edge of the{' '}
          {CUTSCENE_CHUNKS}×{CUTSCENE_CHUNKS}-chunk map — the part that falls outside won’t be copied.
        </p>
      )}
    </>
  )
}
