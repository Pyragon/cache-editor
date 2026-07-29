// Remembering the cache folder across reloads.
//
// A `FileSystemDirectoryHandle` is structured-cloneable, so IndexedDB can hold
// it — localStorage cannot (it only stores strings). The handle survives, but
// the PERMISSION does not automatically: after a reload Chromium usually
// reports `prompt`, and re-granting needs a user gesture. So restoring is two
// steps — silently adopt when permission is still `granted`, otherwise offer a
// button that calls `requestPermission()` from the click.
//
// Nothing here throws: a browser without the API, a revoked folder, a private
// window with IndexedDB blocked, all just mean "no remembered cache".

const DB_NAME = 'cache-editor'
const STORE = 'handles'
const KEY = 'cacheRoot'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Remember this folder as the one to reopen next load. */
export async function rememberCacheRoot(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(handle, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}

export async function forgetCacheRoot(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}

async function readCacheRoot(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

export type RememberedCache =
  /** Permission survived — safe to adopt without asking. */
  | { state: 'ready'; handle: FileSystemDirectoryHandle }
  /** Handle is remembered but needs a click to re-grant access. */
  | { state: 'needs-permission'; handle: FileSystemDirectoryHandle }
  | { state: 'none' }

/** What we can do with the remembered folder, without prompting. */
export async function getRememberedCache(): Promise<RememberedCache> {
  try {
    const handle = await readCacheRoot()
    if (!handle) return { state: 'none' }
    // Not in older typings; absent entirely in browsers without the API.
    const query = (handle as unknown as {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>
    }).queryPermission
    if (typeof query !== 'function') return { state: 'needs-permission', handle }
    const status = await query.call(handle, { mode: 'readwrite' })
    return status === 'granted' ? { state: 'ready', handle } : { state: 'needs-permission', handle }
  } catch {
    return { state: 'none' }
  }
}

/** Re-grant access. MUST be called from a user gesture or the prompt is
 *  suppressed and this resolves false. */
export async function requestCachePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const request = (handle as unknown as {
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>
    }).requestPermission
    if (typeof request !== 'function') return false
    return await request.call(handle, { mode: 'readwrite' }) === 'granted'
  } catch {
    return false
  }
}
