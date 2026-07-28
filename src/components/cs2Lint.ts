// Error-tolerant linter for decompiled CS2 source: a positional re-implementation of the
// cryogen compiler's grammar (docs/cs2.md). Reports what the pack-time compiler would reject —
// unknown ops, malformed statements, stray tokens, unclosed blocks, bad references — plus
// arg-count warnings from the intellisense signatures. Type-level checks stay pack-side.

export interface CS2Diagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

interface OpInfo {
  kind: string
  args: { type: string, name: string | null }[] | null
}

type TokKind = 'ident' | 'int' | 'long' | 'string' | 'char' | 'punct' | 'eof'
interface Tok { kind: TokKind, text: string, from: number, to: number }

const MULTI_PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--']
const KEYWORDS = new Set(['if', 'else', 'while', 'switch', 'case', 'default', 'return', 'function'])

class StopLint extends Error {}

export function lintCS2(source: string, ops: Record<string, OpInfo>): CS2Diagnostic[] {
  // binary data (a stray bytecode file) is not lintable line-by-line — one clear error instead
  if (source.includes('\0'))
    return [{ from: 0, to: Math.min(source.length, 40), severity: 'error', message: 'This file is binary data, not CS2 source — it cannot be edited or packed as text.' }]

  const diags: CS2Diagnostic[] = []
  const tokens: Tok[] = []

  // game-var reference prefixes come from the op table (load_/get_ stripped off LOAD_GAMEVAR ops)
  const gameVarPrefixes = new Set<string>()
  for (const [name, info] of Object.entries(ops))
    if (info.kind === 'LOAD_GAMEVAR' || info.kind === 'STORE_GAMEVAR')
      gameVarPrefixes.add(name.replace(/^(load_|store_|get_)/, ''))

  // ---- tokenize ----
  {
    let i = 0
    const n = source.length
    while (i < n) {
      const c = source[i]
      if (/\s/.test(c)) { i++; continue }
      if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue }
      const start = i
      if (/[A-Za-z_]/.test(c)) {
        while (i < n && /[A-Za-z0-9_]/.test(source[i])) i++
        tokens.push({ kind: 'ident', text: source.slice(start, i), from: start, to: i })
      } else if (/\d/.test(c)) {
        while (i < n && /\d/.test(source[i])) i++
        let kind: TokKind = 'int'
        if (source[i] === 'L') { kind = 'long'; i++ }
        tokens.push({ kind, text: source.slice(start, i), from: start, to: i })
      } else if (c === '"') {
        i++
        let closed = false
        while (i < n) {
          if (source[i] === '\\') { i += 2; continue }
          if (source[i] === '"') { closed = true; i++; break }
          if (source[i] === '\n') break
          i++
        }
        if (!closed) diags.push({ from: start, to: i, severity: 'error', message: 'Unterminated string' })
        tokens.push({ kind: 'string', text: source.slice(start, i), from: start, to: i })
      } else if (c === "'") {
        if (i + 2 < n && source[i + 2] === "'") {
          tokens.push({ kind: 'char', text: source.slice(i, i + 3), from: i, to: i + 3 })
          i += 3
        } else {
          diags.push({ from: i, to: i + 1, severity: 'error', message: 'Bad character literal' })
          i++
        }
      } else {
        const two = source.slice(i, i + 2)
        if (MULTI_PUNCT.includes(two)) {
          tokens.push({ kind: 'punct', text: two, from: i, to: i + 2 })
          i += 2
        } else {
          tokens.push({ kind: 'punct', text: c, from: i, to: i + 1 })
          i++
        }
      }
    }
    tokens.push({ kind: 'eof', text: '', from: n, to: n })
  }

  // ---- parse (panic-mode recovery: skip to ; or } and continue) ----
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isPunct = (t: string) => peek().kind === 'punct' && peek().text === t
  const isIdent = (t: string) => peek().kind === 'ident' && peek().text === t

  function err(tok: Tok, message: string): never {
    diags.push({ from: tok.from, to: Math.max(tok.to, tok.from + 1), severity: 'error', message })
    throw new StopLint()
  }

  function expectPunct(t: string) {
    if (!isPunct(t)) err(peek(), `Expected '${t}'${peek().kind === 'eof' ? ' before end of file' : `, got '${peek().text}'`}`)
    next()
  }

  function recover() {
    // skip to just past the next ';', or stop before '}' / EOF
    while (peek().kind !== 'eof') {
      if (isPunct(';')) { next(); return }
      if (isPunct('}')) return
      next()
    }
  }

  function validCallName(name: string): boolean {
    return name in ops || name === 'fromRGB' || name === 'get_comp' || name === 'new_array' || /^script_\d*$/.test(name)
  }

  function validRefName(name: string): boolean {
    if (/^(int|string|long)\d+$/.test(name)) return true
    const split = name.lastIndexOf('_')
    if (split > 0 && /^\d+$/.test(name.slice(split + 1)) && gameVarPrefixes.has(name.slice(0, split))) return true
    return false
  }

  function callArgs(nameTok: Tok): number {
    if (isPunct('@')) { next(); if (peek().kind !== 'int') err(peek(), 'Expected an operand number after @'); next() }
    expectPunct('(')
    let count = 0
    while (!isPunct(')')) {
      if (peek().kind === 'eof') err(nameTok, 'Unclosed call — missing )')
      expression()
      count++
      if (isPunct(',')) next()
      else if (!isPunct(')')) err(peek(), `Expected ',' or ')' in arguments, got '${peek().text}'`)
    }
    next()
    return count
  }

  function checkArgCount(nameTok: Tok, argCount: number) {
    const info = ops[nameTok.text]
    if (!info || info.kind !== 'SIMPLE' || info.args == null) return
    if (info.args.length !== argCount)
      diags.push({
        from: nameTok.from, to: nameTok.to, severity: 'warning',
        message: `${nameTok.text} takes ${info.args.length} argument${info.args.length === 1 ? '' : 's'}, got ${argCount}`,
      })
  }

  function callExpr(nameTok: Tok) {
    if (!validCallName(nameTok.text))
      diags.push({ from: nameTok.from, to: nameTok.to, severity: 'error', message: `Unknown instruction or script '${nameTok.text}'` })
    checkArgCount(nameTok, callArgs(nameTok))
  }

  function unary() {
    const tok = peek()
    if (tok.kind === 'int' || tok.kind === 'long' || tok.kind === 'string' || tok.kind === 'char') { next(); return }
    if (tok.kind === 'punct' && tok.text === '[') {
      // a bracket list (hook params/triggers)
      next()
      while (!isPunct(']')) {
        if (peek().kind === 'eof') err(tok, 'Unclosed list — missing ]')
        expression()
        if (isPunct(',')) next()
      }
      next()
      return
    }
    if (tok.kind === 'punct' && (tok.text === '-' || tok.text === '~' || tok.text === '!')) { next(); unary(); return }
    if (tok.kind === 'punct' && tok.text === '(') {
      next()
      expression()
      const op = peek()
      if (op.kind === 'punct' && ['+', '-', '*', '/', '%', '&', '|', '<<', '>>', '==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op.text)) {
        next()
        expression()
        // condition chains can continue: (a == 1 || b == 2)
        while (peek().kind === 'punct' && ['&&', '||', '==', '!=', '<', '>', '<=', '>='].includes(peek().text)) { next(); expression() }
      }
      expectPunct(')')
      return
    }
    if (tok.kind === 'ident') {
      if (KEYWORDS.has(tok.text)) err(tok, `'${tok.text}' is not valid inside an expression`)
      next()
      if (isPunct('(') || isPunct('@')) { callExpr(tok); return }
      if (isPunct('[')) {
        if (!/^array\d+$/.test(tok.text)) err(tok, `'${tok.text}' is not an array (array0-array4)`)
        next(); expression(); expectPunct(']')
        return
      }
      // a bare script reference (hook targets): script_123, or script_-1 for a cleared hook
      if (/^script_\d+$/.test(tok.text)) return
      if (tok.text === 'script_') {
        if (isPunct('-')) { next(); if (peek().kind === 'int') { next(); return } }
        err(tok, 'Expected a script id after script_')
      }
      if (!validRefName(tok.text))
        diags.push({ from: tok.from, to: tok.to, severity: 'error', message: `Unknown variable '${tok.text}' — expected intN/stringN/longN or a game var like varp_123` })
      return
    }
    err(tok, tok.kind === 'eof' ? 'Unexpected end of file in expression' : `Unexpected '${tok.text}' in expression`)
  }

  function expression() {
    unary()
    while (peek().kind === 'punct' && ['+', '==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(peek().text)) {
      next()
      unary()
    }
  }

  function block() {
    expectPunct('{')
    while (!isPunct('}')) {
      if (peek().kind === 'eof') err(peek(), 'Unclosed block — missing }')
      statement()
    }
    next()
  }

  function statement() {
    try {
      statementInner()
    } catch (e) {
      if (!(e instanceof StopLint)) throw e
      recover()
    }
  }

  function statementInner() {
    const tok = peek()
    if (tok.kind === 'ident') {
      switch (tok.text) {
        case 'if': {
          next(); expectPunct('('); expression(); expectPunct(')'); block()
          if (isIdent('else')) {
            next()
            if (isIdent('if')) { statementInner(); return }
            block()
          }
          expectPunct(';')
          return
        }
        case 'while': {
          next(); expectPunct('('); expression(); expectPunct(')'); block(); expectPunct(';')
          return
        }
        case 'switch': {
          next(); expectPunct('('); expression(); expectPunct(')'); expectPunct('{')
          while (!isPunct('}')) {
            if (peek().kind === 'eof') err(peek(), 'Unclosed switch — missing }')
            if (isIdent('default')) { next(); expectPunct(':'); block(); expectPunct(';'); continue }
            if (!isIdent('case')) err(peek(), `Expected 'case', 'default' or '}' in switch, got '${peek().text}'`)
            next()
            while (true) {
              if (isIdent('default')) next()
              else if (isPunct('-')) { next(); if (peek().kind !== 'int') err(peek(), 'Expected a case value'); next() }
              else if (peek().kind === 'int') next()
              else err(peek(), 'Expected a case value')
              if (isPunct(',')) next()
              else break
            }
            expectPunct(':'); block(); expectPunct(';')
          }
          next(); expectPunct(';')
          return
        }
        case 'return': {
          next()
          if (isPunct('[')) {
            next()
            while (!isPunct(']')) {
              if (peek().kind === 'eof') err(peek(), 'Unclosed return tuple — missing ]')
              expression()
              if (isPunct(',')) next()
            }
            next()
          } else if (!isPunct(';')) {
            expression()
          }
          expectPunct(';')
          return
        }
        case 'else': case 'case': case 'default':
          err(tok, `'${tok.text}' without a matching statement`)
      }
      next()
      // arrayN[i] = expr;  |  arrayN = new_array('c', size);
      if (/^array\d+$/.test(tok.text) && (isPunct('[') || isPunct('='))) {
        if (isPunct('[')) { next(); expression(); expectPunct(']') }
        expectPunct('=')
        expression()
        expectPunct(';')
        return
      }
      // ref = expr;
      if (isPunct('=')) {
        if (!validRefName(tok.text))
          diags.push({ from: tok.from, to: tok.to, severity: 'error', message: `Unknown variable '${tok.text}'` })
        next()
        if (isPunct('[')) { next(); while (!isPunct(']')) { if (peek().kind === 'eof') err(peek(), 'Unclosed list'); expression(); if (isPunct(',')) next() } next() }
        else expression()
        expectPunct(';')
        return
      }
      // target++; / target--;
      if (isPunct('++') || isPunct('--')) {
        next()
        if (!validRefName(tok.text))
          diags.push({ from: tok.from, to: tok.to, severity: 'error', message: `Unknown variable '${tok.text}'` })
        expectPunct(';')
        return
      }
      // call;
      if (isPunct('(') || isPunct('@')) {
        callExpr(tok)
        expectPunct(';')
        return
      }
      err(tok, `Unexpected '${tok.text}' — expected a statement (call, assignment, if/while/switch/return)`)
    }
    if (tok.kind === 'punct' && tok.text === '[') {
      // [t1, t2] = expr;
      next()
      while (!isPunct(']')) {
        if (peek().kind === 'eof') err(peek(), 'Unclosed target list — missing ]')
        const target = peek()
        if (target.kind !== 'ident' || !validRefName(target.text)) err(target, `Expected a variable target, got '${target.text}'`)
        next()
        if (isPunct(',')) next()
      }
      next()
      expectPunct('=')
      if (isPunct('[')) { next(); while (!isPunct(']')) { if (peek().kind === 'eof') err(peek(), 'Unclosed list'); expression(); if (isPunct(',')) next() } next() }
      else expression()
      expectPunct(';')
      return
    }
    err(tok, tok.kind === 'eof' ? 'Unexpected end of file' : `Unexpected '${tok.text}'`)
  }

  // ---- function header + body ----
  try {
    if (!isIdent('function')) err(peek(), "Expected 'function' at the start of the script")
    next()
    const name = peek()
    if (name.kind !== 'ident' || !/^script_\d+$/.test(name.text)) err(name, 'Expected script_<id>')
    next()
    expectPunct('(')
    while (!isPunct(')')) {
      if (peek().kind === 'eof') err(peek(), 'Unclosed parameter list')
      if (peek().kind !== 'ident') err(peek(), 'Expected a parameter name')
      next()
      expectPunct(':')
      const type = peek()
      if (type.kind !== 'ident' || !['int', 'string', 'long'].includes(type.text)) err(type, 'Parameter type must be int, string or long')
      next()
      if (isPunct(',')) next()
    }
    next()
    expectPunct(':')
    if (isPunct('[')) { while (!isPunct(']') && peek().kind !== 'eof') next(); expectPunct(']') }
    else { if (peek().kind !== 'ident') err(peek(), 'Expected a return type'); next() }
    expectPunct('{')
    while (!isPunct('}')) {
      if (peek().kind === 'eof') err(peek(), 'Unclosed function body — missing }')
      statement()
    }
    next()
    const trailing = peek()
    if (trailing.kind !== 'eof')
      diags.push({ from: trailing.from, to: tokens[tokens.length - 2].to, severity: 'error', message: 'Unexpected content after the closing }' })
  } catch (e) {
    if (!(e instanceof StopLint)) throw e
  }

  return diags
}
