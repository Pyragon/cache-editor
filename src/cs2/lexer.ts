// Lexer for the decompiled CS2 source (.cs2 files in the dump) — the
// TS-flavoured language cryogen's decompiler emits and its compiler parses
// back byte-identically. The grammar is deliberately tiny; see interfaces.md.

export type TokenType =
  | 'ident' | 'int' | 'string' | 'char'
  | 'punct' // ( ) { } [ ] , ; :
  | 'op' // + - * / % == != <= >= < > = ! & | && ||
  | 'eof'

export type Token = {
  type: TokenType
  value: string
  /** parsed numeric value for int tokens */
  num?: number
  line: number
}

const PUNCT = new Set(['(', ')', '{', '}', '[', ']', ',', ';', ':'])

export function lex(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '\n') { line++; i++; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    // comments (the decompiler can emit // notes)
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '"') {
      let s = ''
      i++
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; continue }
        s += src[i]
        i++
      }
      i++ // closing quote
      tokens.push({ type: 'string', value: s, line })
      continue
    }
    if (ch === "'") {
      let s = ''
      i++
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; continue }
        s += src[i]
        i++
      }
      i++
      tokens.push({ type: 'char', value: s, line })
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++
        const text = src.slice(i, j)
        tokens.push({ type: 'int', value: text, num: parseInt(text, 16) | 0, line })
      } else {
        while (j < n && src[j] >= '0' && src[j] <= '9') j++
        const text = src.slice(i, j)
        // long literals carry an L suffix (clan vars) — precision beyond 2^53
        // doesn't matter for previews, so they ride the int token
        const isLong = src[j] === 'L'
        if (isLong) j++
        tokens.push({ type: 'int', value: text, num: isLong ? Number(text) : parseInt(text, 10) | 0, line })
      }
      i = j
      continue
    }
    if (/[A-Za-z_@]/.test(ch)) {
      let j = i
      // idents may carry an @N variant suffix (cc_create@1 — the second
      // active-component bank the client keeps for server-vs-client comps)
      while (j < n && /[A-Za-z0-9_@]/.test(src[j])) j++
      tokens.push({ type: 'ident', value: src.slice(i, j), line })
      i = j
      continue
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, line })
      i++
      continue
    }
    // operators, longest-match
    const two = src.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||' || two === '++' || two === '--' || two === '>>' || two === '<<') {
      tokens.push({ type: 'op', value: two, line })
      i += 2
      continue
    }
    if ('+-*/%<>=!&|^~'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, line })
      i++
      continue
    }
    throw new Error(`cs2 lex: unexpected character ${JSON.stringify(ch)} at line ${line}`)
  }
  tokens.push({ type: 'eof', value: '', line })
  return tokens
}
