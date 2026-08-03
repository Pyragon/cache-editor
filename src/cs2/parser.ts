// Recursive-descent parser for the decompiled CS2 source. The language is
// the cryogen decompiler's output (round-trips through its compiler), so the
// forms here mirror what that printer emits:
//
//   function script_29(int0: int, string0: string): void { ... }
//   function script_5(...): int, string { ... }   (multi-return)
//   assignments:  int11 = expr;   (locals are implicit; multi-assign
//                 int1, string0 = script_5(...);)
//   if (expr) { ... } else if (...) { ... } else { ... };
//   while (expr) { ... };
//   switch (expr) { case 1: { ... }; case 2, 3: { ... }; case default: {...} }
//   return; / return expr, expr;
//   calls, break;, continue;
//   expressions: ints, hex, strings, 'chars', [array, literals], idents
//   (script_N refs are plain idents), calls, parenthesised binaries, unary -/!
//
// Statement blocks are `{ ... }` and the printer terminates block statements
// with a trailing `;` — accepted and skipped anywhere.

import { lex } from './lexer'
import type { Token } from './lexer'
import type { Cs2Script, Stmt, Expr, Cs2Type } from './ast'

// binary precedence (the printer parenthesises everything, but be permissive)
const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '&': 4,
  '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6,
  '<<': 7, '>>': 7,
  '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
}

export function parseScript(src: string, id: number): Cs2Script {
  const tokens = lex(src)
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const at = (type: Token['type'], value?: string) => {
    const t = tokens[pos]
    return t.type === type && (value === undefined || t.value === value)
  }
  const eat = (type: Token['type'], value?: string): Token => {
    if (!at(type, value)) {
      const t = tokens[pos]
      throw new Error(`cs2 parse (script ${id}): expected ${value ?? type}, got ${t.type} ${JSON.stringify(t.value)} at line ${t.line}`)
    }
    return next()
  }
  const tryEat = (type: Token['type'], value?: string): boolean => {
    if (at(type, value)) { next(); return true }
    return false
  }

  // ---- header ----
  // skip decompiler annotations (`@name("script1222")`) before the function
  while (at('ident') && peek().value.startsWith('@')) {
    next()
    if (tryEat('punct', '(')) {
      let depth = 1
      while (depth > 0) {
        const t = next()
        if (t.type === 'punct' && t.value === '(') depth++
        if (t.type === 'punct' && t.value === ')') depth--
        if (t.type === 'eof') throw new Error(`cs2 parse (script ${id}): unterminated annotation`)
      }
    }
  }
  eat('ident', 'function')
  const name = eat('ident').value
  eat('punct', '(')
  const params: { name: string; type: Cs2Type }[] = []
  while (!at('punct', ')')) {
    const pname = eat('ident').value
    eat('punct', ':')
    params.push({ name: pname, type: parseType() })
    if (!tryEat('punct', ',')) break
  }
  eat('punct', ')')
  eat('punct', ':')
  const returns: Cs2Type[] = []
  if (tryEat('punct', '[')) {
    // multi-return: `: [int, int, string]`
    returns.push(parseType())
    while (tryEat('punct', ',')) returns.push(parseType())
    eat('punct', ']')
  } else {
    returns.push(parseType())
    while (tryEat('punct', ',')) returns.push(parseType())
  }
  const body = parseBlock()
  return { id, name, params, returns, body }

  function parseType(): Cs2Type {
    let t = eat('ident').value
    if (tryEat('punct', '[')) { eat('punct', ']'); t += '[]' }
    return t
  }

  // ---- statements ----
  function parseBlock(): Stmt[] {
    eat('punct', '{')
    const stmts: Stmt[] = []
    while (!at('punct', '}')) stmts.push(parseStmt())
    eat('punct', '}')
    tryEat('punct', ';') // the printer's trailing `;` after blocks
    return stmts
  }

  function parseStmt(): Stmt {
    if (at('ident', 'if')) return parseIf()
    if (at('ident', 'while')) {
      next()
      eat('punct', '(')
      const cond = parseExpr()
      eat('punct', ')')
      const body = parseBlock()
      return { kind: 'while', cond, body }
    }
    if (at('ident', 'switch')) return parseSwitch()
    if (at('ident', 'return')) {
      next()
      const values: Expr[] = []
      if (!at('punct', ';')) {
        values.push(parseExpr())
        while (tryEat('punct', ',')) values.push(parseExpr())
      }
      eat('punct', ';')
      return { kind: 'return', values }
    }
    if (at('ident', 'break')) { next(); eat('punct', ';'); return { kind: 'break' } }
    if (at('ident', 'continue')) { next(); eat('punct', ';'); return { kind: 'continue' } }

    // `[a, b] = call(...);` — the printer's multi-assign form
    if (at('punct', '[')) {
      next()
      const targets: string[] = [eat('ident').value]
      while (tryEat('punct', ',')) targets.push(eat('ident').value)
      eat('punct', ']')
      eat('op', '=')
      const expr = parseExpr()
      eat('punct', ';')
      return { kind: 'assign', targets, expr }
    }

    // assignment (single or multi) vs expression statement: scan for `=`
    // before the terminating `;` at depth 0 — assignments start with a plain
    // ident list, so lookahead is cheap.
    if (at('ident')) {
      const save = pos
      const first = next().value
      // `x++;` / `x--;` — printer sugar for x = x ± 1
      if (at('op', '++') || at('op', '--')) {
        const op = next().value === '++' ? '+' : '-'
        eat('punct', ';')
        return {
          kind: 'assign', targets: [first],
          expr: { kind: 'binary', op, left: { kind: 'ident', name: first }, right: { kind: 'int', value: 1 } },
        }
      }
      // `arr[i] = v;`
      if (at('punct', '[')) {
        next()
        const index = parseExpr()
        eat('punct', ']')
        if (tryEat('op', '=')) {
          const expr = parseExpr()
          eat('punct', ';')
          return { kind: 'storeIndex', name: first, index, expr }
        }
        pos = save
      } else {
        const targets: string[] = [first]
        let isAssign = false
        while (true) {
          if (at('op', '=')) { isAssign = true; next(); break }
          if (at('punct', ',') && tokens[pos + 1]?.type === 'ident') {
            next()
            targets.push(next().value)
            continue
          }
          break
        }
        if (isAssign) {
          const expr = parseExpr()
          eat('punct', ';')
          return { kind: 'assign', targets, expr }
        }
        pos = save
      }
    }
    const expr = parseExpr()
    eat('punct', ';')
    return { kind: 'expr', expr }
  }

  function parseIf(): Stmt {
    eat('ident', 'if')
    eat('punct', '(')
    const cond = parseExpr()
    eat('punct', ')')
    const then = parseBlock()
    let elseBody: Stmt[] | null = null
    if (at('ident', 'else')) {
      next()
      if (at('ident', 'if')) elseBody = [parseIf()]
      else elseBody = parseBlock()
    }
    return { kind: 'if', cond, then, else: elseBody }
  }

  function parseSwitch(): Stmt {
    eat('ident', 'switch')
    eat('punct', '(')
    const value = parseExpr()
    eat('punct', ')')
    eat('punct', '{')
    const cases: { values: (number | string)[] | null; body: Stmt[] }[] = []
    while (!at('punct', '}')) {
      let values: (number | string)[] | null = []
      if (at('ident', 'default')) {
        next()
        values = null
      } else {
        eat('ident', 'case')
        if (at('ident', 'default')) { next(); values = null; eat('punct', ':'); cases.push({ values, body: parseBlock() }); continue }
        values.push(caseValue())
        while (tryEat('punct', ',')) values.push(caseValue())
      }
      eat('punct', ':')
      const body = parseBlock()
      cases.push({ values, body })
    }
    eat('punct', '}')
    tryEat('punct', ';')
    return { kind: 'switch', value, cases }
  }

  function caseValue(): number | string {
    if (at('op', '-')) {
      next()
      return -eat('int').num!
    }
    if (at('int')) return next().num!
    if (at('string')) return next().value
    const t = next()
    throw new Error(`cs2 parse (script ${id}): bad case value ${JSON.stringify(t.value)} at line ${t.line}`)
  }

  // ---- expressions ----
  function parseExpr(minPrec = 1): Expr {
    let left = parseUnary()
    while (true) {
      const t = peek()
      if (t.type !== 'op') break
      const prec = PREC[t.value]
      if (prec === undefined || prec < minPrec) break
      next()
      const right = parseExpr(prec + 1)
      left = { kind: 'binary', op: t.value, left, right }
    }
    return left
  }

  function parseUnary(): Expr {
    if (at('op', '-')) { next(); return { kind: 'unary', op: '-', operand: parseUnary() } }
    if (at('op', '!')) { next(); return { kind: 'unary', op: '!', operand: parseUnary() } }
    return parsePostfix()
  }

  function parsePostfix(): Expr {
    if (tryEat('punct', '(')) {
      const e = parseExpr()
      eat('punct', ')')
      return e
    }
    if (at('int')) return { kind: 'int', value: next().num! }
    if (at('string')) return { kind: 'string', value: next().value }
    if (at('char')) return { kind: 'char', value: next().value }
    if (tryEat('punct', '[')) {
      const items: Expr[] = []
      while (!at('punct', ']')) {
        items.push(parseExpr())
        if (!tryEat('punct', ',')) break
      }
      eat('punct', ']')
      return { kind: 'array', items }
    }
    if (at('ident')) {
      const name = next().value
      if (at('punct', '[') && !(tokens[pos + 1]?.type === 'punct' && tokens[pos + 1]?.value === ']')) {
        // index read `arr[expr]` — but NOT a bare `arr[]`
        next()
        const index = parseExpr()
        eat('punct', ']')
        return { kind: 'index', name, index }
      }
      if (tryEat('punct', '(')) {
        const args: Expr[] = []
        while (!at('punct', ')')) {
          args.push(parseExpr())
          if (!tryEat('punct', ',')) break
        }
        eat('punct', ')')
        return { kind: 'call', name, args }
      }
      return { kind: 'ident', name }
    }
    const t = next()
    throw new Error(`cs2 parse (script ${id}): unexpected ${t.type} ${JSON.stringify(t.value)} at line ${t.line}`)
  }
}
