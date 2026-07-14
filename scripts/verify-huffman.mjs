// Verifies a dumped huffman.json is internally consistent: re-derives the
// canonical codes + decode table from its code-length array (must match the
// stored arrays exactly) and round-trips text through encode -> decode.
//
//   node scripts/verify-huffman.mjs [huffman.json] ["optional test message"]
//
// Bundles src/loaders/huffmanCodes.ts on the fly so the checked logic is the
// exact same source the editor uses (no drift from a duplicated copy).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HUFFMAN_JSON = process.argv[2] ?? 'D:/workspace/github/cryogen-cache/unpacked/huffman/huffman.json'
const TEST_MESSAGE = process.argv[3] ?? 'Selling lobsters at the Grand Exchange! 99 str btw :)'

const bundle = path.join(os.tmpdir(), `huffmanCodes-${Date.now()}.mjs`)
execSync(`npx esbuild "${path.join(import.meta.dirname, '..', 'src', 'loaders', 'huffmanCodes.ts')}" --bundle --format=esm --outfile="${bundle}" --log-level=error`, { stdio: 'inherit' })
const { deriveCodesAndTable, kraftSum, roundTripTest } = await import(pathToFileURL(bundle).href)
fs.unlinkSync(bundle)

const dump = JSON.parse(fs.readFileSync(HUFFMAN_JSON, 'utf8'))
const lengths = dump.originalByteData
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const { codes, table } = deriveCodesAndTable(lengths)
check('codes array matches derivation from lengths', dump.codes.length === codes.length && codes.every((c, i) => c === dump.codes[i]))
check('decode table matches derivation from lengths', dump.table.every((t, i) => t === (table[i] ?? 0)) && table.every((t, i) => t === (dump.table[i] ?? 0)))
check('Kraft sum is exactly 1 (complete prefix code)', Math.abs(kraftSum(lengths) - 1) < 1e-9)

const allBytes = []
for (let b = 0; b < 256; b++) if (lengths[b] > 0) allBytes.push(b)
check(`round-trip: all ${allBytes.length} coded bytes`, roundTripTest(lengths, codes, table, allBytes))

const messageBytes = [...TEST_MESSAGE].map((ch) => ch.charCodeAt(0)).filter((c) => c < 256 && lengths[c] > 0)
const messageBits = messageBytes.reduce((n, b) => n + lengths[b], 0)
check(`round-trip: "${TEST_MESSAGE}"`, roundTripTest(lengths, codes, table, messageBytes))
console.log(`\n"${TEST_MESSAGE}"`)
console.log(`  ${messageBytes.length * 8} bits raw -> ${messageBits} bits encoded (${(messageBits / messageBytes.length).toFixed(2)} bits/char, ${(100 - 100 * messageBits / (messageBytes.length * 8)).toFixed(1)}% smaller)`)

process.exit(failures === 0 ? 0 : 1)
