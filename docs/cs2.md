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
| Structured decompiler | cryogen `com.cryo.cs2.decompiler` (+ `results/`, `statements/`) | **6279/6568 verified** |
| Recompiler (parser → codegen) | cryogen `com.cryo.cs2.compiler` | **6279/6568 recompile byte-identically; 289 asm fallback — 100% total, all provable** |
| Dumper/packer wiring | cryogen `CS2DefinitionDumper` | still dumps raw binary |
| Editor page | cache-editor | raw text fallback only |

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
- **DEFERRED shapes (asm fallback, ~213 scripts / 3.2%)**: break-GOTO *ladders* (an early break
  inside a case hops to the next case's terminal break, which hops to the join — script 36) often
  combined with **case fall-through** (a case body without a terminal break running into the next
  case); complex condition trees beyond AND-of-ORs (scripts 376/373); while-loops whose back-jump
  doesn't land on the tracked condition start (script 366/125 — likely loop-head variants);
  interleaved/partial tuple-store runs (scripts 661/73/23); ~12 scripts with wrong bootstrap
  return signatures (script 108 — fix by inferring signatures ourselves from RETURN sites).

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
