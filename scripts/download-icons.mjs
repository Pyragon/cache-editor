// Download item icons from itemdb.biz for every item in the cache dump.
//
//   node scripts/download-icons.mjs [itemsDir] [outDir]
//
// Resumable: already-downloaded icons are skipped, so it can be re-run after
// an interruption. Ids with no icon (404 or non-PNG response) are recorded in
// <outDir>/_missing.txt and not retried on later runs.
import fs from 'node:fs'
import path from 'node:path'

const ITEMS_DIR = process.argv[2] ?? 'D:/workspace/github/cryogen-cache/unpacked/items'
const OUT_DIR = process.argv[3] ?? path.join(import.meta.dirname, '..', 'public', 'icons')
const URL_BASE = 'https://itemdb.biz/images/icons/'
const CONCURRENCY = 6
const RETRIES = 2

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

fs.mkdirSync(OUT_DIR, { recursive: true })

const missingPath = path.join(OUT_DIR, '_missing.txt')
const knownMissing = new Set(
  fs.existsSync(missingPath) ? fs.readFileSync(missingPath, 'utf8').split('\n').filter(Boolean) : [],
)

const ids = fs.readdirSync(ITEMS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((id) => /^\d+$/.test(id))
  .sort((a, b) => Number(a) - Number(b))
  .filter((id) => !knownMissing.has(id) && !fs.existsSync(path.join(OUT_DIR, `${id}.png`)))

console.log(`${ids.length} icons to fetch (of ${knownMissing.size} known-missing + already downloaded skipped)`)

let done = 0
let ok = 0
const missing = []
const failed = []

async function fetchIcon(id) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${URL_BASE}${id}.png`)
      if (res.status === 404) return 'missing'
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // Some sites serve an HTML placeholder with status 200 — only keep real PNGs.
      if (!buf.subarray(0, 4).equals(PNG_MAGIC)) return 'missing'
      fs.writeFileSync(path.join(OUT_DIR, `${id}.png`), buf)
      return 'ok'
    } catch (err) {
      if (attempt >= RETRIES) {
        console.error(`FAIL ${id}: ${err.message}`)
        return 'failed'
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

async function worker() {
  while (ids.length > 0) {
    const id = ids.shift()
    const result = await fetchIcon(id)
    if (result === 'ok') ok++
    else if (result === 'missing') missing.push(id)
    else failed.push(id)
    done++
    if (done % 1000 === 0) console.log(`${done} processed (${ok} ok, ${missing.length} missing, ${failed.length} failed)`)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

if (missing.length > 0) {
  fs.appendFileSync(missingPath, missing.join('\n') + '\n')
}
console.log(`done: ${ok} downloaded, ${missing.length} missing (recorded), ${failed.length} failed${failed.length ? ' — rerun to retry' : ''}`)
