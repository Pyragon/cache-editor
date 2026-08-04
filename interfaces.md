# Interfaces — the big push

Working doc for the interface-editor overhaul. Keep this current: every session
that touches interfaces starts by reading it and ends by updating it.

## Goals (Cody, 2026-08-02)

1. **In-game gameframe preview** (the priority): render an interface the way
   the client would show it in game — inside the real gameframe with minimap,
   chatbox and tabs around it (those are interfaces too), with the preview
   RESIZABLE like a client window so layout behaviour can be checked at any
   size.
2. **InterfaceViewer redesign**: the current viewer's segmented right-side
   sections hide type-specific info (clicking a model component shows nothing
   about the model unless the "model" section is also selected) and the cells
   below the preview are laid out badly. Rebuild as a proper canvas-editor
   layout: every relevant field for the selected component visible at once.
3. **CS2 in interfaces** (stretch): many components carry scripts
   (`usesScripts`); the client runs CS2 hooks for layout/behaviour. Long-term
   we want at least the load-time hooks simulated.

## Dump facts (verified against cryogen-cache/unpacked)

- `interfaces/<id>/<componentId>.json` — 1,324 interfaces; e.g. 548 has 425
  components (548 is the FIXED gameframe root, see below).
- Component JSON carries (sample: interfaces/548/0.json):
  - identity: `interfaceId`, `componentId`, `type` (string) + `typeId` (int),
    `contentType`, `revision`
  - layout: `basePositionX/Y`, `baseWidth/Height`,
    `aspectXType/YType/WidthType/HeightType`, `aspectWidth/Height`,
    `parent` (packed `(interfaceId<<16)|componentId`; top-level = parent of
    another interface's component or -1), `hidden`, `scrollWidth/Height`
  - per-type payloads: sprite (`spriteId`, `angle2d`, `tiling`, `flipH/V`,
    `spriteShadow`...), model (`modelType`, `modelId`, `spritePitch/Roll/Yaw`,
    `spriteScale`, `animation`, `originX/Y/Z`, `usesOrthogonal`...), text
    (`fontId`, `text`, `color`, `textHorizontalAli/VerticalAli`,
    `lineSpacing`, `shadow`...), rect (`filled`, `transparency`,
    `borderThickness`?...), 
  - interaction: `hasInteraction`, `opBase`, `targetVerb`, cursors, drag
    fields, `menuOptionsCount`, `clickMask`
  - `usesScripts` — CS2 attached

## Client layout semantics

- **Already ported**: `interfacePreview.ts` `resolveSize`/`resolvePosition` (lines
  ~26-58) carry the client's aspect-mode formulas:
  - width/height: type 1 → `parent − base`; 2 → `(base·parent) >> 14`;
    4 → aspect-ratio from `aspectWidth/aspectHeight`; else absolute `base`.
  - x: 0 absolute; 1 centred+offset; 2 right-anchored; 3 `(base·parent)>>14`;
    4 centred+proportional; default right-anchored proportional. y mirrors.
  - `resolveAbsoluteLayout(components, viewportW, viewportH)` recurses through
    CONTAINERs (scrollWidth/Height as child basis when non-zero).
- A sub-interface opened on a component lays out with THAT COMPONENT'S rect as
  its viewport (IF_OPENSUB parent uid = `(interfaceId<<16)|componentId`).
- Clipping: a component clips to its PARENT CONTAINER's bounds only, never its
  own rect (models deliberately overflow).

## Gameframe IDs (cryogen InterfaceManager.java — traced 2026-08-02)

**Roots**: FIXED top = **548** (client canvas 765×503), RESIZABLE top = **746**
(displayMode 0/1 = fixed, 2/3 = resizable). Other panes: 755 world map, 475
orb of oculus, 56 cutscene, 1253 SoF, 1163/1173 Dominion.

**Always-on HUD** (interface → 548 slot / 746 slot):
| iface | what | 548 | 746 |
|---|---|---|---|
| 752 | chatbox window | 168 | 22 |
| 751 | chat bar/filter | 53 | 23 |
| 745 | multicombat indicator | 40 | 16 |
| 754 | system update | 42 | 25 |
| 748 | hitpoints orb | 160 | 196 |
| 749 | prayer orb | 161 | 197 |
| 750 | run orb (Tab.RUN) | 162 | 198 |
| 747 | summoning orb | 164 | 199 |
| 182 | logout | 194 | 130 |
| 1321 | ? | 3 | 458 |
| 137 | chat message area → 752:9 | — | — |
| hide | money pouch: IFSetHide 548:167 / 746:208 | | |

Minimap: baked into the root pane itself, no separate interface.

**Chatbox internals**: 752:13 = dialogue slot, 752:11 = real chat text area
(replaceable), 752:9 ← 137 message area, 752:7 ← 389 GE search.

**Tabs** (content interface → 548 slot / 746 slot): combat 884→176/112,
achievement 1056→177/113, skills 320→178/114, quest 190→179/115, inventory
**679**→180/116, equipment 387→181/117, prayer 271→182/118, magic
(spellbook, dynamic)→183/119, misc −1→184/120, friends 550→185/121,
friends-chat 1109→186/122, clan 1110→187/123, settings 261→188/124, emotes
590→189/125, music 187→190/126, notes 34→191/127. Tab BUTTONS are components
of the root pane itself.

**Other root slots** (548 / 746): central=44/29, inventory-sub=172/109,
overlay=3/12, fullscreen-overlay=28/1, fullscreen-sub=15/—, XP popup
1213→16/39, XP counter 1215→29/28, fading=15/13, screen-interface
bg=249/44 + content=204/45.

**CS2 in gameframe setup: NONE.** The server builds the frame purely with
IF_OPENTOP + IF_OPENSUB + IFSetHide + varbits. CS2 matters per-interface
(scripts on components), not for frame assembly. Known script ids used by the
server generally: 150/695 (container options setup), 143 (flash), 108/109/110
(input), 570 (GE search), 948.

## Plan / status

1. [x] Trace + record layout semantics and gameframe tables (above)
2. [x] `src/components/gameframe.ts` — slot tables + scene assembly
       (`loadGameframeScene`) + recursive compositor (`paintGameframe`).
       Each attached interface lays out and clips inside its parent
       component's rect (scroll size as basis when set, per Class480).
3. [x] `src/components/GameframePreview.tsx` (+CSS) — the "client window":
       fixed 765×553 or resizable (drag corner handle + presets, min
       800×600 per the client's clamp), slot picker for where the edited
       interface goes (central / overlay / chat dialogue / inventory-sub /
       tab / fullscreen / none). Fed the LIVE DRAFT, so edits preview
       immediately — including editing 548/746/752 themselves.
4. [x] InterfaceViewer redesign: three-column layout (tree | canvas |
       inspector). The old exclusive section rail is gone — the inspector
       shows every relevant group at once (type payload FIRST, then layout,
       ops, scripts), collapsible but never hidden. Aspect modes are now
       named dropdowns (the traced semantics), scroll sizes editable on
       containers, parent is a click-to-select link. "In-game preview"
       button in the header swaps the canvas for the gameframe.
5. [x] Verified headless (scripts/render-rig + iface-test.html harness,
       `?iface=<id>`): fixed mode renders banner strip, minimap disc +
       orbs, tab strip, stone tab backdrop, full chatbox (parchment 137 +
       751 filter buttons); resizable renders the steel minimap ring,
       stacked orbs, the icon tab strip, and the slotted interface
       stretching with the window.
6. [ ] CS2: interpreter runs the load/transmit/timer hooks against the
       simulated player, with a console showing what ran and what it changed.
       Interaction hooks (mouse/key/resize) still don't fire — see gaps.
7. [ ] Editing polish: hit-test/select INSIDE the gameframe preview,
       drag-to-move components on the canvas, add/delete components.

## Known gaps (all traced to CS2/varc visibility we don't run)

- The fixed/resizable top BANNER (Home/Support/Forums/Clans) renders —
  in-game it's hidden by scripts/varcs. Same class: some lobby-era strips.
- Tab CONTENT: only inventory 679 is attached (the client shows one tab at a
  time via varc 168 + CS2; we attach the default). Tab-strip highlight
  states don't render (varc-driven).
- Item containers (contentType inventories) draw as placeholders — item
  sprite rendering not implemented.
- Text `<img=n>` mod icons, `<str>`, `<u>` are stripped; scrollbars not
  drawn; `spriteShadow`/`borderThickness`/`monospaced` not honored.
- The 3D world (contentType 1407) fills a dark gradient wash; minimap
  (1401 mini-minimap, 1338 main minimap) is a dark disc.
- ct 1338/1339 (minimap/compass) SPRITE comps: their own sprite (1185/8729)
  is a pure black disc — the MASK the client composites the map / rotated
  compass through, NOT chrome. We draw the disc (fills the stone frame's
  round cutout) and for 1339 draw the compass rose north-up, ellipse-clipped.
  The rose is looked up BY NAME: `getArchiveId("compass")` → sprite 169 in
  this cache (js5 name table = Java lowercase hashCode; scratchpad
  findname.mjs parses idx255 to resolve names — mapdots=300, hint_mapedge=14,
  name_icons=1455, floorshadows=1243).
- Compositor paints each parent interface fully before its attachments
  (real z-order interleaves at the container's position) — invisible for
  the gameframe's dedicated slots.

## Files

- `src/components/gameframe.ts` — tables + compositor
- `src/components/GameframePreview.tsx/.css` — the resizable client preview
- `src/components/InterfaceViewer.tsx/.css` — redesigned viewer
- `src/components/interfacePreview.ts` — layout/paint engine (pre-existing;
  gained CONTENT_TYPE_LABELS + dark world/minimap fills)
- `iface-test.html` + `src/iface-test.tsx` — render-rig harness
  (dump-server on :8787, vite :5199, screenshot via puppeteer — same
  workflow as cutscene-test)

## CS2 (built 2026-08-02, second autonomous stretch)

The cs2 dump is the DECOMPILED SOURCE from cryogen's pipeline (6,568 .cs2
files, TS-flavoured). We interpret that source directly — no bytecode VM.

**Modules** (`src/cs2/`):
- `lexer.ts` / `parser.ts` / `ast.ts` — the full decompiled grammar.
  **6,565 of 6,568 scripts parse**; the 3 failures (568, 4738, 5268) are the
  decompiler's own asm-form fallback files, skipped with a warning.
  Grammar notes that mattered: `@1` op suffix = the client's second active-
  component bank; `[a, b] = call()` multi-assign; `x++`; array `new_array`/
  indexing; `varp_383`-style vars are BARE IDENT syntax (reads AND writes —
  assignments to them persist through the env); `-1L` longs; `@name(...)`
  annotations; plain `default:` cases; `>>`/`<<` only in bit-op sugar.
- `interpreter.ts` — tree-walker, async builtins, 250k-step budget per hook
  (runaway wait-loops abort with a warning, e.g. quest tab's script 4497).
  **Arguments bind by TYPE, not position** (`bindParams`): CS2 has separate
  int and string stacks, so a call site's argument order only orders within
  each type. `script_38(int0, int1, int2, int3, string0)` invoked with
  `[comp, 720922, "…", 25, 150]` must put the string in `string0`, not
  `int2`. Positional binding is right for the int-only majority and silently
  wrong for every mixed-type script — see EDITOR.md.
- `runtime.ts` — `Cs2InterfaceScene`: CLONED components per run (pristine
  defs never mutate), dynamic children with the client's (parentHash,
  childIndex) keyed-replace semantics, two active banks, client-side subs.
- `ops.ts` — the op implementations + the honest warning ledger.

**Implemented op families** (signatures from cryogen's CS2Opcode table —
the authoritative source, `cache/loaders/cs2/CS2Opcode.java`):
- addressing: get_comp, cc_create/cc_find/cc_setchild/cc_delete/
  cc_deleteall, if_getnextsubid, if_isopen(_withid)
- geometry: set/get position, size, hide, scroll size; x/y/width/height
  getters run the REAL layout engine at the interface's slot basis
- graphics: setgraphic, color (fromRGB), trans, fill, outline, tiling,
  h/vflip, sprite scale/shadow, 2d angle, line width/direction
- text: settext, font, align (h/v/lineheight), shadow, maxlines; paramheight/
  parawidth/stringwidth measure with the REAL cache font metrics
- models/items: setmodel(+anim/zoom/orthog), setitem* (ITEM placeholder),
  setnpchead
- subs: **if_opensubclient / if_closesubclient actually open interfaces**
  (loaded from the dump, composed into the paint)
- state: varp/varpbit/varc/varc_string stores+reads (session-scoped, zero
  defaults); enum()/enum_string() read REAL dump enums — **the top-level
  `enums/` dump (1,733 files, defaultIntValue/defaultStringValue/values),
  NOT config/enums** (sparse different archive; kept as fallback), typed by
  the value char ('s' → string, else int, default −1). struct_param reads
  struct JSONs' **`values`** field (items/npcs use `parameters`); param
  file loads are cached per id. Getting these paths wrong starved every
  list-building script (0 instead of −1 terminators = the step-budget
  runaways) — with them right, the quest tab counts its real 183 quests
  and cc_creates a working scrollbar.
- env: windowed_getmode (mode-aware!), world_language 0, stat/stat_base 1,
  runenergy 100, membership 1, displayname "Player", scale/min/max/
  interpolate/pow, the string library
- hooks (mouse/timer/resize installers): intentional no-ops — recognised by
  name (if_seton*/hook_*/cc_seton*), by the COMPONENT_HOOK instr id list,
  and by SHAPE (any instrN whose args carry a script_N ref + signature)

**Placement pills** (2026-08-02, after Cody's note): nothing in the DATA says
where an interface displays — the client learns it from which server call
sends it (sendTab / sendChatBoxInterface / sendInterface / setOverlay, all
IF_OPENSUB with different parent slots). The preview therefore offers pill
buttons: **In screen / In tab / In chatbox / In overlay / None**. Two
mechanics behind them: choosing "In tab" replaces the default inventory
attachment (same slot hash — one tab at a time, like the client), and the tab
content containers (548:180-191 / 746:112-127) SHIP HIDDEN — the client
unhides the selected one via varc 168 + CS2, so the scene force-shows the
slot it attaches to (`GameframeScene.shown`). Verified headless: quest tab
190 renders correctly inside the tab panel in both modes.

**Gameframe pipeline**: `runGameframeCs2` clones the scene, computes each
interface's slot basis, runs the hooks (below), and returns mutated components
+ CS2-opened subs + warnings + the run trace. GameframePreview runs it per
paint (toggle in the toolbar).

**Hook passes** (2026-08-03 — onLoad alone was not enough): four passes over
the whole frame, one per hook field, in the order a freshly logged-in client
fires them — `onLoadScript`, then `onVarpTransmit`, `onStatTransmit`,
`onTimer` (`HOOK_PASSES` in `gameframe.ts`). The client fires a transmit hook
per var arrival and a timer hook per cycle; a preview has one static world
state, so one pass each is the faithful equivalent of "the server has just
sent the player block, and one tick has passed". This is what makes the orbs
respond to the Variables modal at all: the prayer and summoning fills
(`script_801`) hang off `onStatTransmit`, the hitpoints low-HP flash
(`script_808`) off `onTimer`, the poison/disease orb variants
(`script_2923`) off `onVarpTransmit`.

**Hover passes** (2026-08-03, traced in `client.java` around the per-component
`aBool1440` "is hovered" flag): after the frame passes, the pointer's own
hooks fire —

| transition | slot | installer opcode | dumped as | fires |
| --- | --- | --- | --- | --- |
| `!hovered && over` | 2 | `HOOK_MOUSE_ENTER` (968) | `onMouseOver` | once, on entering |
| `hovered && over` | 12 | `IF_SETONMOUSEOVER` (753) | `popupScript` | **every cycle** while inside |
| `hovered && !over` | 3 | `HOOK_MOUSE_EXIT` (600) | `onMouseLeaveScript` | once, on leaving |

**The dumped names for slots 2 and 12 are crossed**, which is why a hover can
log as `popup`. The installer opcodes settle it — cryogen's `CS2Opcode` table
and the client's `CS2Instruction` agree on all four values, and the client's
`hookMouseEnter` → `method6289` writes slot 2 while `ifSetOnMouseOver` →
`setOnMouseOver` writes slot 12. So `popupScript` is not a popup: it is the
real continuous "while the mouse is over" hook. Interface 9's components 5 and
6 are the type specimen — `popupScript: script_45(SELF, 16777215)` paired with
`onMouseLeaveScript: script_45(SELF, 12875312)`, a highlight held while over
and restored on exit. The console and `InterfaceViewer` both label by opcode
and keep the dumped name in the tooltip.

All three receive the mouse position **relative to the component**
(`getMouseX() - x`), which is what the `-2147483647/-46` sentinels resolve to.
The fixed gameframe carries 28 slot-2 and 31 slot-3 hooks — mostly tab-strip
and banner buttons doing sprite swaps via `script_44(comp, sprite)`, so hover
is visibly live.

**Hover is a SET, not one component.** The client has no topmost-wins rule
here: it walks every component of every open interface and sets that
component's own `bool_48` from a plain bounds test
(`mouseX >= leftBound && … && mouseY < upperBound`, plus a per-row opacity
refinement for `clickMask` sprites). A pointer over an icon is therefore
simultaneously over the icon, the container holding it, and that container's
parent, and **all** of their hover hooks fire. `hoverTargets` returns every
containing component; `hitTestComponent` — which picks the deepest/smallest —
stays the right answer for click-to-select, where you want one specific thing.

`GameframePreview` diffs that set each move into the client's three guards
(`entered` / `over` / `exited`) and hands them to the next run. `entered` and
`exited` are one-shot edges, cleared after the run that observed them; `over`
persists, because its hook is per-cycle by design. The repaint is
**conditional on an entered or exited component actually having a hover hook**
(`hasHoverHook`) — components already in the set have had their effect
applied, so nothing needs re-running for them.

**The frame run is cached, and hover layers over it.** This is a latency fix,
not a nicety: hovering originally re-ran all ~60 frame hooks through the async
tree-walking interpreter, which took 1–2 seconds to produce a frame identical
except for one sprite — the highlight landed long after the pointer had moved
on. `runGameframeCs2` now returns a `GameframeRun` (the post-frame-pass
components plus the var store, basis and caches), held by `GameframePreview`
under a key of everything a pointer move does NOT affect —
`sceneGen | mode | WxH | varsGen`. `applyGameframeHover` clones that base into
a fresh `Cs2InterfaceScene` and runs at most three hooks on top.

Two things fall out of the base never being mutated: leave is correct without
the leave script having to undo anything (the base simply has no hover
applied), and a hover-only repaint's trace contains **only** the hover hooks —
the frame didn't re-run, and re-listing 60 cached entries would bury the two
that are news. On a cache miss the two traces concatenate and are renumbered,
since each is sequenced from its own scene.

⚠ **`mouseLeaveScript` (decode slot 7) is not a mouse hook and must never be
fired as one.** cryogen, darkan-bot-refactor and the client's own deobfuscated
source all carry that name, but the client's dispatch for it is
transmit-shaped: a global counter against a per-component cursor, scanning a
32-entry ring buffer of recently-changed ids against `mouseLeaveArrayParams`.
That's the same shape as the varp and stat transmit hooks it decodes between,
and its filter list sits between `varps` and `statTransmitFilter` — the
classic varp/**inv**/stat trio. It is an inventory transmit hook. See EDITOR.md.

**Hook arg sentinels** (traced to darkan-game-client
`CS2Executor.executeHookInner`): a hook's stored args contain placeholders the
client swaps for live event state before the script starts —
`-2147483647/-46` mouse x/y, **`-2147483645` = the hook's own component
hash**, `-2147483644` op index, `-43` source slot, `-42/-41` the drag-target
component + slot, `-40/-39` typed key code/char, and the string
`"event_opbase"` for the hovered op name. Only `self` has an answer in a
static preview; the rest resolve to the client's own absent value
(`HOOK_ARG_SENTINELS`). **Passing these through raw was a silent killer**:
`script_801`'s entire body is `if_*` calls on arg 0, so with arg 0 =
−2147483645 every setter resolved to a component that isn't in the scene and
did nothing, with no warning — 28 hooks across the gameframe carry the self
sentinel, including both root panes, the chatbox, the logout button and the
inventory. `if_*` setters now log an unresolvable target to the console.

**Console** (`Cs2Console.tsx`): the run trace under the preview — every hook
in fire order with the client's reason for firing it, and every component
field it changed (`from → to`). A transmit hook's reason names the vars from
its filter list **and the value each one holds**
(`transmitted: Poisoned (varp 102) = 0, …`), read from the LIVE `Cs2VarStore`
just before the hook runs rather than from the saved overrides — an earlier
hook may have written the var, and the line has to report what the script is
about to see. Component refs select in the editor when they
belong to the interface being edited; script ids open `Cs2ScriptModal`, whose
**Edit** button navigates to the `cs2` entry (script ids ARE that entry's item
ids) to change the script — it edits whatever is on screen, so following a
call chain and then hitting Edit lands on what you're reading. The
stubbed-op ledger moved here as a second tab (it used to be a toolbar
popover), so there's one place to look when the preview and client disagree.
It **accumulates**: each repaint is a fresh CS2 run, appended newest-first
under a run header, capped at 12 (Clear resets). A console that replaced its
contents couldn't answer "what did my last edit change" — before and after
were never on screen together. Repaints producing an identical run fold into a
`×N` repeat count, so a resize drag doesn't bury the run you were reading.

**Variable routing** (the per-run lines above the hooks): one line per set
variable that a hook in this frame **actually fires on**. It exists because of
a genuinely invisible indirection — **a varbit is a bit range inside a varp**
(`baseVar` in the `varbits/` dump), and transmit filter lists only ever name
the varp. Setting varbit 455 fires the hooks watching **varp 449**, and nothing
else on screen connects those two numbers, so without this the log reads as
though it's discussing a var you never touched.

Variables nothing here watches are **not** reported. An earlier version warned
about them, reasoning that "nothing watches this" answers "why did my edit do
nothing" — but the Variables list is global and mostly describes world state
for the map and cutscene previews, so on any given interface most of it is
simply irrelevant. Warning once per variable per run buried the log in notices
about a normal situation that no script present is even asking about.

Two filters, both default-off so the log starts honest: "No-ops" hides rows
that changed nothing (a hook that ran and moved nothing is usually correct,
but it's also exactly what a broken hook looks like, so it's one click away
rather than invisible), and "Only this interface" drops the rest of the gameframe — chatbox, orbs, tab
strip — when you only care about the interface you're editing. That second one
keeps a hook if it hangs off the edited interface **or if it changed one of its
components**: a gameframe script reaching into your interface is the most
interesting line in the log, and filtering purely by which interface owns the
hook would hide exactly that.

"Only this interface" also **stops runs that touched nothing of yours from
being recorded**, rather than merely hiding their rows. Hover fires a hook per
pointer transition, so sweeping across the frame produced a run per gameframe
component — each leaving a bare header and, worse, evicting the runs you cared
about from the capped history. Runs filtered down to nothing are dropped whole
for the same reason.

**Verified headless**: quest tab 190 renders its script-generated text
("Showing all 0 items"), orbs draw their icons + values, the top banner picks
its world_language sprite set, chat shows the display name. Coverage on the
full gameframe run went 3,718 stubbed calls → **113 across 10 ops**.

**Unsure / not implemented (Cody: this is the honest list)**:
- `instr6073`, `instr6075`, `instr6443` (1 arg, ~30 calls each on the quest
  tab), `instr6220` (1 arg), `instr6225` (0 args), `instr6289` (1 arg),
  `instr6657` (12 args, once) — unnamed in the op table, semantics unknown.
- `cc_set_depth_child(a, b)` — real op, but the table doesn't pin which arg
  is the component; corpus only shows `(int0, -1)`. Skipped rather than
  guessed.
- `world_isquickchat` — returns? Stubbed 0.
- Ops the table itself can't decode (null signatures): cc_setmodelorigin,
  cc_setmodeltint, cc_setrecol, cc_setopkey, if_delete(all), if_dragpickup,
  if_setaspect and friends — any script using them already fails cryogen's
  decompiler, so they can't reach us anyway.
- Load/transmit/timer, HOVER and CLICK hooks run. Still don't: onClickRepeat,
  onHold (both need a HELD button, which a single click never reaches), drag,
  key, scroll wheel, onResize.
- Clicking the canvas has two modes, chosen by a toolbar pill: **Click
  selects** (pick a component to edit — the default, and scoped to the edited
  interface) or **Click fires onClick**, which behaves like the client and
  runs the clicked component's `onClick` then `onRelease` — a press and a
  release being what one click is. Same set semantics as hover: every
  component whose bounds contain the point, not just the topmost. Click hooks
  are rare — one component in 425 on root pane 548, none at all on interface
  11 — so most clicks log nothing, which is correct: a component with no click
  script has nothing to report.
- `onTimer` runs exactly once, so anything animated off it shows only its
  first tick. `client_clock()` DOES advance, but only while the hover ticker
  is running (`GameframePreview`, 20ms, bounded to `TICK_BUDGET` cycles per
  hover change) — there is no free-running clock, so script_808's low-HP
  flash (`client_clock() % 32`) still shows one frame.
- Step-budget aborts: quest tab script 4497 spins waiting for state we don't
  simulate — aborted safely, warned.
- `if_setscrollpos` accepted but scroll offsets aren't modelled in paint.

## Page zoom vs pixel-accurate previews

Cache art is 1px-detail art, so any display scale under 1 device pixel per
drawn pixel deletes strokes instead of shrinking them — small text goes
unreadable while large text survives. Browser PAGE ZOOM folds into
`window.devicePixelRatio` (90% zoom → 0.9), which silently made
`canvas.width = w * dpr` render the whole frame into a smaller buffer.

Handled in `src/pixelScale.ts`: `renderScale()` floors the ratio at 1× so we
never pre-shrink our own drawing, `preparePixelCanvas()` wraps the canvas
setup, and `watchPixelScale()` marks `<html class="zoomed-out">` so the global
rule in `index.css` lets the browser FILTER (blur) rather than nearest-drop
when it must squeeze. GameframePreview also shows a "page zoom N% — not
pixel-accurate" badge, because this presents exactly like a renderer bug.

Diagnostic that settles it in one step: measure a text run's ink span in a
screenshot and compare with `sum(glyphWidths)` from `fonts/metrics/<id>.json`
— the ratio is the display scale.

## Session log

- 2026-08-02 (Claude, autonomous while Cody out): recon (3 agents), doc
  created, gameframe preview built + headless-verified, viewer redesigned.
  All uncommitted, awaiting Cody's review. NOTE: a stray Vite dev server
  may be listening on :5199 from the verification run.
- 2026-08-02 (later, Cody's ask "add CS2 functionality"): full decompiled-
  source interpreter + interface op layer built and wired into the gameframe
  preview (see the CS2 section). 6,565/6,568 scripts parse; gameframe run
  down to 113 stubbed calls over 10 unknown ops. Uncommitted.
- 2026-08-03 ("XP button has black around it"): three separate fixes came
  out of this. (1) ct-1338/1339 mask-sprite comps now render the mask disc
  + compass rose (see Known gaps entry for the name-lookup trail). (2) The
  1407 world fill got a gradient wash. (3) THE ACTUAL BUG, found by Cody
  pulling up sprite 2730 in the viewer: the XP button sprite ships black
  corners under an all-255 alpha plane — the client discards all-255 alpha
  channels and then treats pure-black palette colours as transparent; our
  decode honoured the dumped channel and drew the corners opaque. Fixed
  client-faithfully in spriteRender.ts (`clientAlphaChannel`); details in
  EDITOR.md "Sprite transparency". Uncommitted.
- 2026-08-03 ("text on the in-game preview is messed up"): NOT a renderer bug
  — the browser was at ~90% page zoom, so devicePixelRatio was 0.9 and the
  frame was being drawn into a sub-1× buffer. Proven by measuring: our own
  offline render of the same string is 120×9px, the capture was 106×8px.
  Guards + badge added, see "Page zoom vs pixel-accurate previews".
