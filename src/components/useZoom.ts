import { useCallback, useState } from 'react'

// Zoom that survives switching items and reloading the page.
//
// Every viewer with a zoom control used to reset it on each item change (or
// keep its own copy of this logic), so clicking through sprites/textures kept
// snapping back to the default. The value is validated against the viewer's
// allowed levels on read, so a stale or hand-edited entry can't produce a
// broken zoom.
export function useZoom(storageKey: string, levels: number[], fallback = 1) {
  const [zoom, setZoomState] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return levels.includes(saved) ? saved : fallback
  })

  const setZoom = useCallback((next: number) => {
    setZoomState(next)
    localStorage.setItem(storageKey, String(next))
  }, [storageKey])

  return [zoom, setZoom] as const
}
