/**
 * Persistence for the context model.
 *
 * IndexedDB rather than localStorage, which the rest of this app uses: the
 * model is per-object histograms over ~2.7k objects and runs to a few MB, well
 * past localStorage's ~5MB-for-everything budget. Failing to store it is not
 * fatal — the model just gets rebuilt on the next generate — so every call here
 * resolves rather than rejects.
 *
 * Nothing here leaves the browser. The scan reads the user's own cache from
 * their disk and the result stays in their own origin's storage, which is what
 * keeps this per-user with no server involved.
 */

import type { ContextModel } from './context'
import type { ArchetypeModel } from './archetypes'

/**
 * Its OWN database, not a store inside the shared `cache-editor` one.
 *
 * That is not a style preference, it is the fix for a total silent failure.
 * `loaders/cachePersist.ts` opens a database called `cache-editor` at version
 * 1 during app startup and creates only its own `handles` store. Opening the
 * same name at the same version later does NOT fire `onupgradeneeded`, so
 * `procgen-context` was never created; every transaction then threw
 * `NotFoundError`, was caught, and resolved to null. The context model and the
 * archetypes appeared to save, and were simply gone on the next load — with
 * nothing reported, because failing to store them is meant to be non-fatal.
 *
 * Bumping the version instead would be worse: `cachePersist` still opens at 1,
 * and the lower open fails with a VersionError once the higher one upgrades.
 * A separate database is what `loaders/groundUsage.ts` already does.
 */
const DB_NAME = 'cache-editor-procgen'
const DB_VERSION = 1
const STORE = 'procgen-context'
/** the single row; the model carries its own fingerprint for validation */
const KEY = 'model'
/** the archetype row, in the same store — same lifecycle, same validation */
const ARCHETYPE_KEY = 'archetypes'

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      // Belt and braces after the collision above: if the store somehow isn't
      // there, say so once rather than letting every call throw NotFoundError
      // into a catch and look like "nothing was ever saved".
      if (!db.objectStoreNames.contains(STORE)) {
        console.warn(`[procgen] IndexedDB "${DB_NAME}" has no "${STORE}" store — `
          + 'the context model and place types cannot be cached between sessions.')
        db.close()
        resolve(null)
        return
      }
      resolve(db)
    }
    req.onerror = () => resolve(null)
    // Private browsing and some lockdown modes never fire either callback.
    // Without this the first generate would hang on an await that never
    // settles, which looks exactly like a frozen scan.
    setTimeout(() => resolve(null), 3000)
  })
}

export async function loadContextModel(fingerprint: string): Promise<ContextModel | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        const m = req.result as ContextModel | undefined
        // A model built from another cache is worse than none: it would score
        // this dump's objects against another dump's ground.
        resolve(m && m.version === 3 && m.fingerprint === fingerprint ? m : null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      db.close()
    }
  })
}

export async function saveContextModel(model: ContextModel): Promise<boolean> {
  const db = await open()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(model, KEY)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    } finally {
      db.close()
    }
  })
}

export async function loadArchetypes(fingerprint: string): Promise<ArchetypeModel | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(ARCHETYPE_KEY)
      req.onsuccess = () => {
        const m = req.result as ArchetypeModel | undefined
        // Archetypes stay at v2: the region clustering is unaffected by the
        // buildings work, so there is nothing to relearn. Only the CONTEXT
        // model went to v3, and it is a separate record.
        resolve(m && m.version === 2 && m.fingerprint === fingerprint ? m : null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      db.close()
    }
  })
}

export async function saveArchetypes(model: ArchetypeModel): Promise<boolean> {
  const db = await open()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(model, ARCHETYPE_KEY)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    } finally {
      db.close()
    }
  })
}

export async function clearContextModel(): Promise<void> {
  const db = await open()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      // Archetypes go with it: they are mined from the same pass over the same
      // cache, so keeping one without the other would leave the generator
      // describing a cache it can no longer score against.
      tx.objectStore(STORE).delete(KEY)
      tx.objectStore(STORE).delete(ARCHETYPE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    } finally {
      db.close()
    }
  })
}
