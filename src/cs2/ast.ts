// AST for the decompiled CS2 language. Kept deliberately close to the
// emitted shapes — this is an interpreter's AST, not a compiler's.

export type Cs2Type = 'int' | 'string' | 'void' | string

export type Cs2Script = {
  id: number
  name: string
  params: { name: string; type: Cs2Type }[]
  returns: Cs2Type[]
  body: Stmt[]
}

export type Stmt =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'assign'; targets: string[]; expr: Expr }
  | { kind: 'storeIndex'; name: string; index: Expr; expr: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null }
  | { kind: 'while'; cond: Expr; body: Stmt[] }
  | { kind: 'switch'; value: Expr; cases: { values: (number | string)[] | null; body: Stmt[] }[] }
  | { kind: 'return'; values: Expr[] }
  | { kind: 'break' }
  | { kind: 'continue' }

export type Expr =
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'char'; value: string }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'ident'; name: string }
  | { kind: 'index'; name: string; index: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'unary'; op: string; operand: Expr }
