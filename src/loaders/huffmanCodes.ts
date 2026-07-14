// Huffman table construction + verification for the regenerate-from-corpus
// editor. The cache's source of truth is only the 256-entry code-length
// array; canonical codes and the decode table are derived from it exactly
// like cryogen's HuffmanDefinitions(byte[]) constructor (ported below).

// Maximum code length the format allows (per TODO/cryogen notes). The stock
// table marks its never-used bytes with length 22; we cap regenerated codes
// at 21 so every produced code is unambiguously valid.
export const MAX_CODE_LENGTH = 21

// Direct port of cryogen HuffmanDefinitions(byte[] codeLengths): derives the
// canonical code for every symbol and builds the decode table (a flat tree:
// bit 1 jumps to table[node], bit 0 steps to node+1, negative = ~symbol leaf).
// JS bitwise ops are 32-bit signed like Java's, so the arithmetic matches.
export function deriveCodesAndTable(lengths: number[]): { codes: number[]; table: number[] } {
  const size = lengths.length
  const codes = new Array<number>(size).fill(0)
  const fill = new Array<number>(33).fill(0)
  let table = new Array<number>(8).fill(0)
  let nextFree = 0

  for (let sym = 0; sym < size; sym++) {
    const len = lengths[sym]
    if (len === 0) continue

    const bit = 1 << (32 - len)
    const code = fill[len]
    codes[sym] = code

    let next: number
    if ((code & bit) !== 0) {
      next = fill[len - 1]
    } else {
      next = code | bit
      for (let i = len - 1; i >= 1; i--) {
        const current = fill[i]
        if (current !== code) break
        const higherBit = 1 << (32 - i)
        if ((current & higherBit) !== 0) {
          fill[i] = fill[i - 1]
          break
        }
        fill[i] = current | higherBit
      }
    }
    fill[len] = next
    for (let i = len + 1; i <= 32; i++) {
      if (fill[i] === code) fill[i] = next
    }

    let node = 0
    for (let i = 0; i < len; i++) {
      const mask = 0x80000000 >>> i
      if ((code & mask) !== 0) {
        if (table[node] === 0) table[node] = nextFree
        node = table[node]
      } else {
        node++
      }
      if (node >= table.length) {
        const bigger = new Array<number>(table.length * 2).fill(0)
        for (let j = 0; j < table.length; j++) bigger[j] = table[j]
        table = bigger
      }
    }
    table[node] = ~sym
    if (node >= nextFree) nextFree = node + 1
  }

  return { codes, table }
}

// Optimal length-limited Huffman code lengths via package-merge. Every
// frequency must be >= 1 (callers floor the counts) so all symbols get a code.
export function buildLengthLimitedLengths(freqs: number[], maxLen = MAX_CODE_LENGTH): number[] {
  const n = freqs.length
  type Item = { weight: number; syms: number[] }

  let prev: Item[] = []
  for (let level = 0; level < maxLen; level++) {
    const items: Item[] = freqs.map((weight, i) => ({ weight, syms: [i] }))
    for (let i = 0; i + 1 < prev.length; i += 2) {
      items.push({
        weight: prev[i].weight + prev[i + 1].weight,
        syms: [...prev[i].syms, ...prev[i + 1].syms],
      })
    }
    items.sort((a, b) => a.weight - b.weight)
    prev = items
  }

  const lengths = new Array<number>(n).fill(0)
  for (let i = 0; i < 2 * n - 2; i++) {
    for (const sym of prev[i].syms) lengths[sym]++
  }
  return lengths
}

// Kraft–McMillan check: a valid prefix code's lengths satisfy Σ 2^-len <= 1
// (== 1 when the tree is full, which package-merge produces).
export function kraftSum(lengths: number[]): number {
  let sum = 0
  for (const len of lengths) {
    if (len > 0) sum += Math.pow(2, -len)
  }
  return sum
}

// Encode a byte sequence with the given codes/lengths and decode it back
// through the table — proves the whole derived structure is self-consistent
// before a table is allowed to be saved.
export function roundTripTest(lengths: number[], codes: number[], table: number[], bytes: number[]): boolean {
  const bits: number[] = []
  for (const byte of bytes) {
    const len = lengths[byte]
    if (len <= 0) return false
    const code = codes[byte]
    for (let i = 0; i < len; i++) bits.push((code >>> (31 - i)) & 1)
  }

  const decoded: number[] = []
  let node = 0
  for (const bit of bits) {
    node = bit ? table[node] : node + 1
    if (node < 0 || node >= table.length) return false
    if (table[node] < 0) {
      decoded.push(~table[node])
      node = 0
    }
  }

  return decoded.length === bytes.length && decoded.every((value, i) => value === bytes[i])
}
