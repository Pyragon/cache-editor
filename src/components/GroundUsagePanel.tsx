// "Where in the world is this ground material used?" for the underlay and
// overlay editors. The index it reads has to be built by walking every region
// dump (see loaders/groundUsage.ts), so the scan is a deliberate button press
// and the result is cached — both pages share one index.
import { useEffect, useRef, useState } from 'react'
import type { GroundUsage, ScanProgress, UsageEntry } from '../loaders/groundUsage'
import { TOP_REGIONS, clearCachedUsage, loadCachedUsage, scanGroundUsage } from '../loaders/groundUsage'
import './GroundUsagePanel.css'

type Props = {
  rootHandle: FileSystemDirectoryHandle | undefined
  kind: 'underlay' | 'overlay'
  /** 0-based definition id. */
  id: number
  /** Jump to a region in the maps entry. */
  onOpenRegion?: (regionId: number) => void
}

function formatScanned(at: number): string {
  const d = new Date(at)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export default function GroundUsagePanel({ rootHandle, kind, id, onOpenRegion }: Props) {
  const [usage, setUsage] = useState<GroundUsage | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadCachedUsage().then((u) => { if (!cancelled) setUsage(u) })
    return () => { cancelled = true }
  }, [])

  // A scan in flight when the page changes would keep writing progress into an
  // unmounted panel — and the user almost certainly moved on.
  useEffect(() => () => abortRef.current?.abort(), [])

  async function runScan() {
    if (!rootHandle) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setProgress({ done: 0, total: 0 })
    try {
      await clearCachedUsage()
      const next = await scanGroundUsage(rootHandle, setProgress, controller.signal)
      setUsage(next)
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Scan failed.')
      }
    } finally {
      setProgress(null)
    }
  }

  const entry: UsageEntry | undefined = usage?.[kind]?.[id]
  const scanning = progress !== null
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="ground-usage">
      <div className="ground-usage-bar">
        <button type="button" className="add-row-btn" onClick={() => void runScan()} disabled={scanning || !rootHandle}>
          {scanning ? 'Scanning…' : usage ? 'Rescan world' : 'Scan world'}
        </button>
        {usage && !scanning && (
          <span className="ground-usage-meta">
            {usage.regions.toLocaleString()} regions indexed · {formatScanned(usage.scannedAt)}
            {usage.skipped > 0 && ` · ${usage.skipped} unreadable`}
          </span>
        )}
        {scanning && (
          <span className="ground-usage-meta">
            {progress.total > 0 ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} regions (${pct}%)` : 'listing regions…'}
          </span>
        )}
      </div>

      {scanning && (
        <div className="ground-usage-progress"><div className="ground-usage-progress-fill" style={{ width: `${pct}%` }} /></div>
      )}

      {error && <p className="tex-op-note ground-usage-error">{error}</p>}

      {!usage && !scanning && !error && (
        <p className="tex-op-note">
          Nothing indexed yet. Scanning reads every region dump once (a few thousand files) and
          remembers the result in this browser, so later visits are instant. Re-scan after
          re-dumping the cache or editing terrain.
        </p>
      )}

      {usage && !entry && (
        <p className="tex-op-note">
          This {kind} is not placed on any tile in the world — it is defined but unused.
        </p>
      )}

      {usage && entry && (
        <>
          <p className="tex-op-note">
            Used on <strong>{entry.totalTiles.toLocaleString()}</strong> tiles across{' '}
            <strong>{entry.regionCount.toLocaleString()}</strong>{' '}
            {entry.regionCount === 1 ? 'region' : 'regions'}
            {entry.regionCount > entry.top.length && ` — the ${TOP_REGIONS} heaviest are listed`}.
          </p>
          <div className="quest-table-wrap ground-usage-wrap">
            <table className="quest-table">
              <thead>
                <tr><th>Region</th><th>World coords</th><th>Tiles</th><th /></tr>
              </thead>
              <tbody>
                {entry.top.map((r) => {
                  // Same convention as the map viewer's loc/marker lists:
                  // world tile = regionX * 64 + tileX. A region's origin is its
                  // south-west corner and it spans 64 tiles each way.
                  const wx = r.rx * 64
                  const wy = r.ry * 64
                  return (
                  <tr key={r.region}>
                    <td>{r.region}</td>
                    <td
                      className="ground-usage-coords"
                      title={`Region ${r.rx}, ${r.ry} — tiles ${wx}–${wx + 63} by ${wy}–${wy + 63}`}
                    >
                      {wx}, {wy}
                    </td>
                    <td>{r.tiles.toLocaleString()}</td>
                    <td>
                      {onOpenRegion && (
                        <button type="button" className="field-link-btn" onClick={() => onOpenRegion(r.region)}>
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
