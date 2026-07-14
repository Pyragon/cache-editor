// Joins the per-player chat logs into a single corpus file for the Huffman
// regenerate-from-corpus panel, stripping the "[<timestamp>] " prefix from
// every line so only the chat text itself remains.
//
//   node scripts/build-chat-corpus.mjs [chatDir] [outFile]
//
// Input files are read as latin1 (2013-era logs are typically cp1252) and the
// corpus is written as UTF-8, so single-byte characters survive byte-accurate
// into the browser's file.text() decode.
import fs from 'node:fs'
import path from 'node:path'

const CHAT_DIR = process.argv[2] ?? 'D:/workspace/github/cryogen-cache/chat'
const OUT_FILE = process.argv[3] ?? 'D:/workspace/github/cryogen-cache/chat_corpus.txt'

const TIMESTAMP_PREFIX = /^\[[^\]]*\]\s?/

let files = 0
let lines = 0
let unprefixed = 0
const out = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' })

for (const name of fs.readdirSync(CHAT_DIR)) {
  if (!name.endsWith('.txt')) continue
  const text = fs.readFileSync(path.join(CHAT_DIR, name), 'latin1')
  files++
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = rawLine.replace(TIMESTAMP_PREFIX, '')
    if (stripped.trim() === '') continue
    if (stripped === rawLine) unprefixed++
    out.write(stripped + '\n')
    lines++
  }
}

out.end(() => {
  const size = fs.statSync(OUT_FILE).size
  console.log(`${files.toLocaleString()} files -> ${lines.toLocaleString()} chat lines, ${(size / 1024 / 1024).toFixed(1)} MB`)
  if (unprefixed > 0) console.log(`note: ${unprefixed.toLocaleString()} lines had no [timestamp] prefix (kept as-is — spot-check if that seems high)`)
  console.log(`corpus: ${OUT_FILE}`)
})
