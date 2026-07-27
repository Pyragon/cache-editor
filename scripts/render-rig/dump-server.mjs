// Static file server over the unpacked cache dump, with the /__ls directory
// listing endpoint map-test.tsx's fake FileSystemDirectoryHandle expects.
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'

const ROOT = 'D:/workspace/github/cryogen-cache/unpacked'
const PORT = 8787

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/__ls') {
      const rel = url.searchParams.get('path') ?? ''
      const dir = normalize(join(ROOT, rel))
      if (!dir.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return }
      const names = await readdir(dir, { withFileTypes: true })
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(names.map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }))))
      return
    }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)))
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return }
    const s = await stat(file)
    if (!s.isFile()) { res.writeHead(404).end(); return }
    const data = await readFile(file)
    res.writeHead(200, { 'access-control-allow-origin': '*' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'access-control-allow-origin': '*' })
    res.end()
  }
}).listen(PORT, () => console.log(`dump server on :${PORT} over ${ROOT}`))
