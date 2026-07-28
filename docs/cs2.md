# CS2 scripts: format, pipeline, and decompiler spec

Status 2026-07-27. The CS2 toolchain lives in **cryogen** (`com.cryo.cs2`), like every other
definition type: cryogen dumps decompiled **text** into `unpacked/cs2/`, the cache-editor edits
that text, and repack recompiles it to bytecode. Signed off by Cody: **byte-identical round trip**
(`recompile(decompile(x)) == x` for every script) and **v2 TypeScript-style syntax**
(`function script_10(int0: int, string0: string): void { ... }`), architecture kept readable in
the style of `D:\workspace\github\cs2-decompiler-v2` (class per instruction kind, class per
result kind).

## State

| Piece | Where | Status |
|---|---|---|
| Opcode table (1006 entries) | cryogen `com.cryo.cs2.CS2Opcode` (generated) | done |
| Container codec | cryogen `com.cryo.cs2.CS2ScriptContainer` | **proven: 6568/6568 byte-identical** |
| Asm text form (fallback + study tool) | cryogen `com.cryo.cs2.CS2Assembly`, `CS2Print` | **proven: 6568/6568 byte-identical** |
| Verifier | cryogen `com.cryo.cs2.CS2RoundTrip` | done, run after every change |
| Tail scoreboard | cryogen `com.cryo.cs2.CS2Tail` | classifies every script OK/STRUCT/DIFF, writes `tail.txt` |
| Signature arity probe | cryogen `com.cryo.cs2.CS2ArityProbe` | finds wrong opcode signatures from the corpus |
| Structured decompiler | cryogen `com.cryo.cs2.decompiler` (+ `results/`, `statements/`) | **6556/6568** |
| Recompiler (parser → codegen) | cryogen `com.cryo.cs2.compiler` | **6556/6568 recompile byte-identically; 12 asm fallback — 100% total, all provable** |
| Script signatures | cryogen `com.cryo.cs2.decompiler.ScriptSignatures` | inferred from the cache alone (no external bootstrap) |
| Dumper/packer wiring | cryogen `CS2DefinitionDumper` | dumps decompiled text; `buildAddEdit` compiles it back |
| Editor page | cache-editor `CS2Viewer` | done (CodeMirror IDE, see README) |

The **old cryogen decompiler is deleted** (Cody's call, 2026-07-27): `com.cryo.cache.loaders.cs2`
lost everything except `CS2Type`/`CS2ParamDefs` (kept — they're the enums/structs/params type
system), `com.cryo.utils.cs2` lost everything except `TextUtils`/`GenericsUtils` (CS2Type deps);
`InterfaceBuilderException` moved to the interfaces package. `ScriptDBBuilder`/`InstructionDBBuilder`
load calls were stripped from `Cache`, `Launcher`, `ObjectExaminesDumper`, `MultiUse`.

Build/run (cryogen is Maven; **use JDK 17** — the pom's Lombok 1.18.20 breaks under newer javac):

```
JAVA_HOME="C:/Program Files/Java/jdk-17" mvn -q -o compile          # full build
javac --release 17 -cp "target/classes;$(cat cp.txt)" -d target/classes src/main/java/com/cryo/cs2/*.java
java -cp "target/classes;$(cat cp.txt)" com.cryo.cs2.CS2RoundTrip   # the proof
java -cp "target/classes;$(cat cp.txt)" com.cryo.cs2.CS2Print <id>  # disassemble one script
```

## Container binary format (per script archive, file 0)

```
[ name: null-terminated cp1252 string, or single 0 byte ]
[ instructions: opcode u16, then operand:
    PUSH_STRING -> 0-terminated cp1252 string
    PUSH_LONG   -> i64
    op.intOperand ? i32 : u8 ]
[ footer: codeSize i32, intLocals u16, stringLocals u16, longLocals u16,
          intArgs u16, stringArgs u16, longArgs u16 ]
[ switch block: count u8, per table: numCases u16 + (caseValue i32, caseAddr i32) pairs ]
[ trailer: switchBlockSize u16 ]   // = 1 + Σ(2 + 8·cases); instructionLength = len − 2 − sbs − 16
```

Facts proven against this cache: codeSize always equals the instruction count; only 4 scripts
carry names, all `scriptN` placeholders (so `script_N` naming loses nothing); switch-table order
must be preserved as-read (client hashes them, but re-encode must not reorder); no script contains
the five cp1252-unmappable bytes, so Java Strings are safe carriers.

## Opcode table facts

- Sources & authority: darkan-game-client `CS2Instruction` for opcode numbers + operand widths
  (cryogen's old table had `POP_INT` marked as int-operand — wrong; the client wins). Names and
  stack signatures overlaid from cs2-decompiler-v2 (`data/instructions.json` = popOrder/returnType
  for 616 opcodes — the irreplaceable part of that repo; regen script: session scratchpad `regen.js`).
- 712 distinct opcodes are used by the 6568 scripts. **Zero used opcodes have UNKNOWN kind**, and
  every used non-hook opcode has a full stack signature. The ~50 signature-less used opcodes are
  all HOOK kind (generic trailing-signature handling) plus `POP_2_INT`(65), used once.

## Bytecode semantics (observed from real scripts, not ported from anywhere)

- **Jumps**: `target = index + operand + 1` — operand counts instructions, not bytes. Same for
  switch-table case addresses (relative to the SWITCH instruction).
- **Conditional branch ops** (`INT_EQ`, `INT_LT`, … `BRANCH_EQ0/1`, `LONG_*`) pop two operands
  and jump when the comparison holds.
- **if**: `[cond pushes] BRANCH(+1) GOTO(+bodyLen) [body]` — branch hops over the GOTO into the
  body; the GOTO is the false-exit.
- **while**: identical head; body's last instruction is `GOTO` with a negative operand back to
  the first condition push. The false-exit GOTO points past the back-jump.
- **switch**: `[selector push] SWITCH(tableIdx) GOTO(+default/end)`; each case body ends with a
  break `GOTO` to the common join — **emitted even directly after a RETURN** (dead instruction;
  script 1000 index 16). The recompiler must reproduce these dead breaks for byte-identity.
- **Multi-value return**: values pushed per-type before `RETURN 0`; tuple order in source is the
  per-type pop order interleaved by the script's return signature (e.g. script 1000 pushes
  `10, 3224` and prints `[3224, 10, …]`).
- **CALL_CS2(scriptId)**: args consumed per the callee's own header counts; multi-returns are
  consumed by consecutive STOREs (tuple assignment in source).
- **MERGE_STRINGS(n)**: pops n strings, pushes the concatenation.
- **ARRAY_NEW/LOAD/STORE(arrayId)**: operand byte is the array id.
- **Hooks** (50 opcodes, `Flag.HOOK_TAIL`): pop order per v2's `HookInstruction` — optional
  component hash, then the signature string literal, then (if signature ends `Y`) a count int and
  that many ints, then one value per signature char (reversed), then the hook script id literal.
  Which hook opcodes take the component pop is not yet confirmed per-opcode — the stack-integrity
  check in the decompiler will pin this down (wrong arity breaks the typed stacks immediately).
- **`||` (confirmed, script 19 @171-189)**: N conditions in sequence, each ending in a BRANCH
  targeting the shared body start (operands descending: 16, 13, 10, 7, 4, 1 — each condition is
  3 instructions here); the last BRANCH is `+1` and is followed by the false-exit
  `GOTO(+bodyLen)`. So only the final condition uses the `BRANCH(+1) GOTO` head; earlier ones
  jump straight into the body.
- **`&&` vs nested if**: `if(A && B){...}` and `if(A){ if(B){...} }` (with no extra statements)
  emit identical bytecode — consecutive `BRANCH(+1) GOTO(→same end)` pairs. The decompiler must
  pick ONE canonical source form (use `&&` when the false-exits coincide and nothing sits between
  the heads) and the recompiler inverts that same choice; byte-identity holds either way as long
  as both sides agree.
- **Tails and dead code (survey of all 6568)**: 11,148 GOTOs directly follow a RETURN (mostly
  dead case-breaks), 133 scripts end `RETURN RETURN`, 125 end `GOTO RETURN`, 788 end
  `PUSH_INT RETURN` (typed default-value tails; also PUSH_STRING variants). v2's
  "remove the last two instructions" hack was papering over representable code — never strip;
  represent faithfully. 435 scripts contain loops. Branch operand distribution: 20,892 of ~22k
  branches are `+1` (plain if/while heads); the rest are `||` chain links.

## Shapes confirmed while building the structurer (2026-07-27, second pass)

- **Conditions are AND-chains of OR-groups**: `(a || b) && c` → each group's || links jump to the
  instruction right after the group's closing GOTO (= next group start, or the body for the last
  group); every group's false-exit GOTO shares one target. `if(A && B)` without else IS
  byte-identical to nested ifs, but with an else, or as a loop condition, it is NOT — real &&
  support is required (the second group's false-exit goes to the else/loop-exit).
- **Switch layout variants**: (a) normal — SWITCH, default GOTO, cases, each non-last case ends
  with a break GOTO to the join, the LAST case omits it (zero-distance jump); (b) fall-through
  default — no default GOTO, the default body sits INLINE right after SWITCH ending with its own
  break, cases follow (script 213); (c) same but with no inline body: unmatched selectors fall
  into the first case (first case doubles as `default`).
- **Dead code is real code**: default-value tails (`PUSH_INT 0, RETURN` after a return), double
  RETURNs, dead breaks after case returns — decompile as ordinary statements after the return;
  re-emitting them in order reproduces the bytes.
- **Tail-call tuple forwarding**: `return script_981(int1);` — a callee's whole multi-value
  result consumed directly by RETURN. Recognised from the stacks (all values = components of one
  call), NOT from the bootstrap signatures, which over/under-count some scripts.
- **Return-tuple order is canonical**: ints, then strings, then longs (same as arguments); v2's
  scripts.json tuple order is its own inference and inconsistent — only its counts are used.
## Shapes added while chasing the tail (2026-07-28: 289 fallbacks → 12)

Everything below is verified by `CS2Tail` (decompile → recompile → compare bytes over all 6568).

- **Conditions are arbitrary short-circuit trees**, not the && -of-|| special case that was
  originally assumed. Each test compiles to either `BRANCH(→success)` (fails through to the next
  test — an || link) or `BRANCH(+1) GOTO(→fail)` (holds through to the next — an && link), so a
  head is a flat run of tests wired by jump targets. Merging adjacent tests back into && / || pairs
  recovers `a || (b && c)` and `(a || b) && c` alike. Which merge to take first **is not decidable
  locally** — in `(a && b) || c` the b/c pair also satisfies the || rule but leads nowhere — so the
  decompiler walks every grouping (an interval DP) and keeps whatever reduces completely.
- **How far a head reaches also isn't decidable one test at a time**: a group may only merge once
  its own successors have, so the longest run that reduces to a single node landing on the code
  right after it wins. Two guards keep that from swallowing the body: only value-producing
  instructions may sit between tests, and **a head never reaches past a back-jump target**, since
  that is where a loop's own condition starts (script 89).
- **A loop's back-jump must land on the head's condition start.** A back-jump to anywhere else
  belongs to a loop nested at the end of the body — the enclosing construct is a plain if, and the
  body region structures that loop itself (script 366).
- **An if with an empty body** leaves the head's own false-exit GOTO in the position where a body's
  trailing jump would sit; reading it as one invents an `else` and emits a jump that never existed
  (script 112).
- **Switch clauses are positional.** The default body is usually last, sometimes inline before the
  first case, and occasionally **wedged between two cases** (script 385 keeps a `case -1` after it),
  so `SwitchStatement` records its index among the cases. A clause's trailing `break` is a real
  instruction that is mandatory except on the clause running into the join, so it can't be derived
  from position — the source carries an explicit `break;`. A GOTO in the break position that is a
  preceding BRANCH's false-exit is **not** a break. A switch with an empty table and no default
  jump is just its selector being evaluated (script 4656).
- **Tuple values are ordinary pushes.** They can be stored (`[a, b] = f()`), fed straight into
  another call as arguments (`if_setsize(getdimensions(), 0, 0, comp)`), or discarded — one POP per
  returned value, in the callee's signature order. Store runs are **not** in descending component
  order: components live on their own typed stacks, so a `[int, string]` pair stores whichever type
  the compiler emitted first; the run is however many consecutive stores consume every component
  once, and the source order is the reverse of the store order.
- **A store with more than one value pending is a batch** (`[a, b] = [e1, e2]`), not a run of
  assignments: the compiler evaluated every right-hand side before storing any of them, which
  differs whenever a later expression reads an earlier target.
- **Return signatures come from the cache, not from cs2-decompiler-v2.** A RETURN takes whatever is
  pending, so reading it off the stacks makes a script's header a result of decompiling rather than
  an input to it; the corpus is then iterated to a fixed point because a script's returns can only
  be read once its callees' are. Recursive scripts (1467 calls itself) are seeded from how their
  call sites consume the result — the store run most call sites agree on. Dropping the v2 bootstrap
  scored **better** than keeping it: its wrong guesses were worse than starting from nothing.
- **Four opcode signatures were wrong**, found by `CS2ArityProbe` rather than by reading the client
  one handler at a time: control never transfers with values pending, so between two jumps a correct
  table's pushes and pops cancel exactly, and an op that appears only in unbalanced runs is a bug
  with its correction attached. `IF_SETMODELTINT` pops the component too, `DETAILCANSET_*` take
  their setting argument, `IF_SETMOUSEOVERCURSOR` is a setter that pushes nothing, `POP_2_INT`
  discards two ints. Every `X_PARAM` op pops the subject it queries (only `instr6771` doesn't — its
  subject is the hooked component). All confirmed against darkan's interpreter.
- **Long-typed hook params**: the long-stack type characters are 0xCF/0x8C/0xA7/0xFB/0xC2 (the five
  `createLongJagexType` entries in `CS2Type`), not `l`.
- **Hook opcodes carry an `@N` operand** (which target the bind applies to) and four scripts carry a
  container **name** field; both are now in the syntax (`cc_setonop@1(…)`, `@name("script722")`).

- **DEFERRED shapes (asm fallback, 12 scripts / 0.18%)**: return values pushed *before* later
  statements run (script 564 — needs a way to write an early push); conditional exits leaving the
  region (1230/1231/4908); value-carrying arms (948/4737); batched stores that strand a value
  (4738/5268); calls whose results are consumed in ways the stack walk can't follow (568/4361); a
  param lookup with a non-literal param id, where the result type can't be resolved (6567).

## Design constraints for the structurer/recompiler pair

- Structuring is **pattern-exact, not best-effort**: the decompiler recognizes precisely the
  shapes the recompiler emits. Any script that doesn't fit dumps in the asm text form
  (`CS2Assembly` — one instruction per line, still editable, still byte-identical through
  repack), and the verifier reports it. Coverage grows pattern by pattern with proof at every step.
- The `.cs2` files in `unpacked/cs2/` will hold either form; the parser distinguishes them
  (asm files start with the `// script_N` + `args:`/`locals:` header block, structured files
  with `function `).
- cache-editor side (later): swap the cs2 loader from binary to text, IDE-style page, and keep
  the asm form editable too.
