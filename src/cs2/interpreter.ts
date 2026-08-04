// Tree-walking interpreter for the decompiled CS2 language. Scripts load
// lazily from the dump (cs2/<id>.cs2), parse once per session, and run
// against an environment that implements the builtin ops — the interface
// preview's environment lives in cs2Ops.ts.

import { parseScript } from './parser'
import type { Cs2Script, Stmt, Expr } from './ast'


export type Cs2Value = number | string | Cs2Value[]

export type Cs2Env = {
  /** Load a script's decompiled source, or null when it isn't in the dump. */
  loadScriptSource(id: number): Promise<string | null>
  /** Builtin dispatch. Returns the op's values ([] / single / tuple), sync
   *  or as a promise (ops that lazy-load dump data: enums, fonts). Throw
   *  Cs2Abort to stop the whole run. Unknown ops should warn and return
   *  zeros — the callers of this interpreter want best-effort previews. */
  callBuiltin(name: string, args: Cs2Value[]): Cs2Value[] | Cs2Value | undefined | Promise<Cs2Value[] | Cs2Value | undefined>
  warn(message: string): void
}

export class Cs2Abort extends Error {}

/** Sum type for control flow bubbling out of statement lists. */
type Flow =
  | { kind: 'normal' }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'return'; values: Cs2Value[] }

const NORMAL: Flow = { kind: 'normal' }

/** Ceiling on interpreted statements per run — a preview must never hang on
 *  a while-loop that waits for client state we don't simulate. */
const MAX_STEPS = 250_000

export class Cs2Interpreter {
  private cache: Map<number, Cs2Script | null>
  private steps = 0
  private env: Cs2Env

  constructor(env: Cs2Env, sharedScriptCache?: Map<number, Cs2Script | null>) {
    this.env = env
    this.cache = sharedScriptCache ?? new Map()
  }

  private async load(id: number): Promise<Cs2Script | null> {
    if (this.cache.has(id)) return this.cache.get(id)!
    let script: Cs2Script | null = null
    try {
      const src = await this.env.loadScriptSource(id)
      if (src != null) script = parseScript(src, id)
    } catch (e) {
      this.env.warn(`script ${id} failed to parse: ${e instanceof Error ? e.message : e}`)
    }
    this.cache.set(id, script)
    return script
  }

  /** Run script `id` with positional args (ints/strings, matched to the
   *  declared params in order). Returns the script's return values. */
  async run(id: number, args: Cs2Value[]): Promise<Cs2Value[]> {
    this.steps = 0
    return this.call(id, args)
  }

  private async call(id: number, args: Cs2Value[]): Promise<Cs2Value[]> {
    const script = await this.load(id)
    if (!script) {
      this.env.warn(`script ${id} missing from the dump — call skipped`)
      return []
    }
    const locals = new Map<string, Cs2Value>()
    for (const [name, value] of bindParams(script.params, args)) locals.set(name, value)
    const flow = await this.execBlock(script.body, locals)
    return flow.kind === 'return' ? flow.values : []
  }

  private async execBlock(stmts: Stmt[], locals: Map<string, Cs2Value>): Promise<Flow> {
    for (const stmt of stmts) {
      const flow = await this.exec(stmt, locals)
      if (flow.kind !== 'normal') return flow
    }
    return NORMAL
  }

  private async exec(stmt: Stmt, locals: Map<string, Cs2Value>): Promise<Flow> {
    if (++this.steps > MAX_STEPS) throw new Cs2Abort('cs2 step budget exhausted')
    switch (stmt.kind) {
      case 'expr':
        await this.eval(stmt.expr, locals)
        return NORMAL
      case 'assign': {
        const value = await this.evalMulti(stmt.expr, locals, stmt.targets.length)
        for (let i = 0; i < stmt.targets.length; i++) {
          const t = stmt.targets[i]
          const v = value[i] ?? (t.startsWith('string') ? '' : 0)
          // game-var stores are assignment SYNTAX (`varc_5 = 1;`) — they
          // persist through the environment so one hook's writes are visible
          // to the next hook's reads
          const m = /^(varp|varpbit|varbit|varc_string|varc|clan_\w+)_(\d+)$/.exec(t)
          if (m && !locals.has(t)) {
            await this.env.callBuiltin(`__set_${m[1]}`, [Number(m[2]), v])
          } else {
            locals.set(t, v)
          }
        }
        return NORMAL
      }
      case 'if': {
        const cond = asInt(await this.eval(stmt.cond, locals))
        if (cond !== 0) return this.execBlock(stmt.then, locals)
        if (stmt.else) return this.execBlock(stmt.else, locals)
        return NORMAL
      }
      case 'while': {
        while (asInt(await this.eval(stmt.cond, locals)) !== 0) {
          if (++this.steps > MAX_STEPS) throw new Cs2Abort('cs2 step budget exhausted')
          const flow = await this.execBlock(stmt.body, locals)
          if (flow.kind === 'break') break
          if (flow.kind === 'return') return flow
        }
        return NORMAL
      }
      case 'switch': {
        const value = await this.eval(stmt.value, locals)
        let chosen = stmt.cases.find((c) => c.values !== null && c.values.some((v) => v === value))
        if (!chosen) chosen = stmt.cases.find((c) => c.values === null)
        if (!chosen) return NORMAL
        const flow = await this.execBlock(chosen.body, locals)
        return flow.kind === 'break' ? NORMAL : flow
      }
      case 'return': {
        const values: Cs2Value[] = []
        for (const e of stmt.values) values.push(await this.eval(e, locals))
        return { kind: 'return', values }
      }
      case 'storeIndex': {
        const arr = locals.get(stmt.name)
        const idx = asInt(await this.eval(stmt.index, locals))
        const value = await this.eval(stmt.expr, locals)
        if (Array.isArray(arr)) arr[idx] = value
        else {
          const fresh: Cs2Value[] = []
          fresh[idx] = value
          locals.set(stmt.name, fresh)
        }
        return NORMAL
      }
      case 'break':
        return { kind: 'break' }
      case 'continue':
        return { kind: 'continue' }
    }
  }

  /** Evaluate an expression that may produce multiple values (a script or
   *  builtin call in a multi-assign). */
  private async evalMulti(expr: Expr, locals: Map<string, Cs2Value>, want: number): Promise<Cs2Value[]> {
    if (expr.kind === 'call') {
      const values = await this.evalCall(expr, locals)
      if (want > 1) return values
      return values.length > 0 ? [values[0]] : [0]
    }
    return [await this.eval(expr, locals)]
  }

  private async eval(expr: Expr, locals: Map<string, Cs2Value>): Promise<Cs2Value> {
    if (++this.steps > MAX_STEPS) throw new Cs2Abort('cs2 step budget exhausted')
    switch (expr.kind) {
      case 'int': return expr.value
      case 'string': return expr.value
      case 'char': return expr.value.charCodeAt(0) | 0
      case 'array': {
        const items: Cs2Value[] = []
        for (const item of expr.items) items.push(await this.eval(item, locals))
        return items
      }
      case 'index': {
        const arr = locals.get(expr.name)
        const idx = asInt(await this.eval(expr.index, locals))
        if (Array.isArray(arr)) return arr[idx] ?? 0
        return 0
      }
      case 'ident': {
        if (locals.has(expr.name)) return locals.get(expr.name)!
        // a bare script_N is a callback reference — passed around as a string
        // token; the hook-installer builtins that receive them are no-ops
        if (expr.name.startsWith('script_')) return expr.name
        if (expr.name === 'true') return 1
        if (expr.name === 'false') return 0
        if (expr.name === 'null') return -1
        // varp_383 / varbit_N / varc_N / varcstring_N read as bare idents —
        // routed through the environment like any other state query
        const m = /^(varp|varpbit|varbit|varc_string|varc|varcstring|clan_\w+?)_(\d+)$/.exec(expr.name)
        if (m) {
          const r = await this.env.callBuiltin(`__get_${m[1]}`, [Number(m[2])])
          return Array.isArray(r) ? (r[0] ?? 0) : (r ?? 0)
        }
        this.env.warn(`unknown identifier ${expr.name} — treated as 0`)
        return 0
      }
      case 'call': {
        const values = await this.evalCall(expr, locals)
        return values.length > 0 ? values[0] : 0
      }
      case 'binary': {
        const l = await this.eval(expr.left, locals)
        // short-circuit forms first
        if (expr.op === '&&') return asInt(l) !== 0 && asInt(await this.eval(expr.right, locals)) !== 0 ? 1 : 0
        if (expr.op === '||') return asInt(l) !== 0 || asInt(await this.eval(expr.right, locals)) !== 0 ? 1 : 0
        const r = await this.eval(expr.right, locals)
        if (typeof l === 'string' || typeof r === 'string') {
          // the only string binary the printer emits is concatenation, plus
          // (in)equality comparisons
          if (expr.op === '+') return `${asStr(l)}${asStr(r)}`
          if (expr.op === '==') return l === r ? 1 : 0
          if (expr.op === '!=') return l !== r ? 1 : 0
        }
        const a = asInt(l), b = asInt(r)
        switch (expr.op) {
          case '+': return (a + b) | 0
          case '-': return (a - b) | 0
          case '*': return Math.imul(a, b)
          case '/': return b === 0 ? 0 : (a / b) | 0
          case '%': return b === 0 ? 0 : a % b
          case '==': return a === b ? 1 : 0
          case '!=': return a !== b ? 1 : 0
          case '<': return a < b ? 1 : 0
          case '>': return a > b ? 1 : 0
          case '<=': return a <= b ? 1 : 0
          case '>=': return a >= b ? 1 : 0
          case '&': return a & b
          case '|': return a | b
          case '<<': return a << b
          case '>>': return a >> b
          default:
            this.env.warn(`unknown operator ${expr.op} — result 0`)
            return 0
        }
      }
      case 'unary': {
        const v = asInt(await this.eval(expr.operand, locals))
        if (expr.op === '-') return (-v) | 0
        if (expr.op === '!') return v === 0 ? 1 : 0
        this.env.warn(`unknown unary ${expr.op}`)
        return 0
      }
    }
  }

  private async evalCall(expr: Extract<Expr, { kind: 'call' }>, locals: Map<string, Cs2Value>): Promise<Cs2Value[]> {
    const args: Cs2Value[] = []
    for (const a of expr.args) args.push(await this.eval(a, locals))
    if (expr.name.startsWith('script_')) {
      const id = Number(expr.name.slice('script_'.length))
      if (Number.isFinite(id)) return this.call(id, args)
    }
    const result = await this.env.callBuiltin(expr.name, args)
    if (result === undefined) return []
    return Array.isArray(result) ? result : [result]
  }
}

/**
 * Bind call arguments to a script's parameters BY TYPE, not by position.
 *
 * CS2 has separate int and string stacks. A caller pushes each argument onto
 * the stack for its type, and the callee pops its parameters off those stacks
 * — so the argument ORDER at the call site has nothing to do with the
 * parameter order in the signature, beyond ordering within each type. The
 * client does exactly this when it invokes a hook
 * (`CS2Executor.executeHookInner` fills `intLocals` and `objectLocals` from
 * two independent counters), and the decompiler prints call arguments in
 * push order for the same reason.
 *
 * Positional binding looked right on the vast majority of scripts, which take
 * only ints — and then silently corrupted every mixed-type one. Interface
 * 11:18's tooltip is the type specimen: the hook carries
 * `[comp, 720922, "Empty your backpack into your bank", 25, 150]` and
 * `script_38` declares `(int0, int1, int2, int3, string0)` — ints first,
 * string last. Positionally the text landed in `int2` and the tooltip
 * rendered the leftover number instead of the string.
 *
 * Anything not a string counts as an int here; arrays are passed by reference
 * through the same slot and there is no separate array parameter type in the
 * emitted signatures.
 */
export function bindParams(
  params: { name: string; type: string }[],
  args: Cs2Value[],
): [string, Cs2Value][] {
  const ints: Cs2Value[] = []
  const strings: Cs2Value[] = []
  for (const a of args) (typeof a === 'string' ? strings : ints).push(a)
  let intAt = 0
  let stringAt = 0
  return params.map((p) => {
    const isString = p.type === 'string'
    const value = isString ? strings[stringAt++] : ints[intAt++]
    return [p.name, value ?? (isString ? '' : 0)]
  })
}

export function asInt(v: Cs2Value): number {
  if (typeof v === 'number') return v | 0
  if (typeof v === 'string') return v === '' ? 0 : 1
  return v.length
}

export function asStr(v: Cs2Value): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return v.map(asStr).join(',')
}
