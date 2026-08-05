import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getNpcIcon, getObjectIcon, peekNpcIcon, peekObjectIcon } from './npcSnapshot'

// Names and snapshot icons for the NPCs and locs a cutscene uses.
//
// An id on its own says nothing about what appears on screen — cutscene 0's
// battle crowd is loc-spawned fighters — so both the read-only page and the
// editor put a picture next to it. The read-only page grew this first; this is
// the shared version so the editor doesn't carry a second copy.

export type CutsceneDefInfo = { name: string; icon: string | null }

/** Icons arrive one at a time; batching keeps a long cast from re-rendering the
 *  page (and the piano roll with it) once per NPC while it loads. */
const FLUSH_MS = 250

export function useCutsceneDefInfo(
  cacheRoot: FileSystemDirectoryHandle | null,
  ids: number[],
  kind: 'npcs' | 'objects',
): Map<number, CutsceneDefInfo> {
  const [info, setInfo] = useState<Map<number, CutsceneDefInfo>>(new Map())
  // by value, or a fresh array each render would restart the scan forever
  const key = ids.join(',')
  const infoRef = useRef(info)
  infoRef.current = info

  useEffect(() => {
    if (!cacheRoot) return
    let cancelled = false
    const wanted = key === '' ? [] : key.split(',').map(Number)

    void (async () => {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath(kind))
      if (!dir || cancelled) return
      const pending = new Map(infoRef.current)
      let dirty = false
      let last = performance.now()
      const flush = () => {
        if (!dirty || cancelled) return
        dirty = false
        setInfo(new Map(pending))
      }

      for (const id of wanted) {
        if (cancelled) return
        if (pending.has(id)) continue
        try {
          const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
          const def = JSON.parse(await file.text()) as Record<string, unknown>
          const fallback = kind === 'npcs' ? `NPC ${id}` : `Object ${id}`
          const name = typeof def.name === 'string' && def.name !== 'null' ? def.name : fallback
          const icon = kind === 'npcs'
            ? peekNpcIcon(id) ?? await getNpcIcon(cacheRoot, id, def)
            : peekObjectIcon(id) ?? await getObjectIcon(cacheRoot, id, def)
          if (cancelled) return
          pending.set(id, { name, icon })
          dirty = true
        } catch {
          // def unreadable — the row still shows its id
        }
        if (performance.now() - last > FLUSH_MS) { last = performance.now(); flush() }
      }
      flush()
    })()

    return () => { cancelled = true }
  }, [cacheRoot, key, kind])

  return info
}
