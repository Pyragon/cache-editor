import { getEntryPath, resolveEntryHandle } from './entryOrder'

// Object URLs for the cache's own UI sprites, so editor chrome can be dressed
// in the real client art (the equipment screen's slot tiles, for instance)
// rather than an approximation.
//
// Deliberately never revoked: the same handful of sprites is reused every time
// a panel mounts, and the cache outlives any one component. Keyed per
// cache-root in a WeakMap, matching how MapSymbolPicker caches its thumbnails.

type SpriteCache = Map<string, Promise<string | null>>

const roots = new WeakMap<FileSystemDirectoryHandle, SpriteCache>()

/** `sprites/<id>/<id>_<frame>.png` as an object URL; null when absent. */
export function loadUiSprite(
  rootHandle: FileSystemDirectoryHandle,
  id: number,
  frame = 0,
): Promise<string | null> {
  let cache = roots.get(rootHandle)
  if (!cache) {
    cache = new Map()
    roots.set(rootHandle, cache)
  }
  const key = `${id}_${frame}`
  const hit = cache.get(key)
  if (hit) return hit

  const pending = (async () => {
    try {
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('sprites'))
      if (!dir) return null
      const sub = await dir.getDirectoryHandle(String(id))
      const png = await (await sub.getFileHandle(`${id}_${frame}.png`)).getFile()
      return URL.createObjectURL(png)
    } catch {
      return null
    }
  })()

  cache.set(key, pending)
  return pending
}

/** Resolves several sprites at once into an id -> url map, skipping misses. */
export async function loadUiSprites(
  rootHandle: FileSystemDirectoryHandle,
  ids: number[],
): Promise<Map<number, string>> {
  const entries = await Promise.all(ids.map(async (id) => [id, await loadUiSprite(rootHandle, id)] as const))
  const out = new Map<number, string>()
  for (const [id, url] of entries) if (url) out.set(id, url)
  return out
}
