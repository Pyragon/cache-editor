# TODO

## Item Icons

- **Generate item icons from our own cache instead of itemdb.biz.** The current set (`public/icons/`, fetched by `scripts/download-icons.mjs`) is scraped from itemdb.biz, which renders from the *latest* RS cache — a number of icons have changed since rev 727, so ours are subtly wrong. The proper fix is rendering them ourselves the way the client builds inventory icons: render the item's model (`inventoryModelId`) with the item's 2D params (zoom2d, xan2d/yan2d/zan2d, xOffset2d/yOffset2d) into a 32×32 canvas — the Three.js model pipeline in ModelViewer already does most of the heavy lifting. Check darkan's icon/sprite rendering code for the exact camera math before porting (see CLAUDE.md reference-repo rules).

## Quests

Architecture note (investigated 2026-07-12): a quest lives in **two places** — the server-side quest JSON (`config/quests/<id> - <name>.json`) and the client-facing **cache struct** (`config/structs/<structId>.json`). Link: quest id → slot id (hardcoded `QUEST_ID_TO_SLOT`) → struct id (via enum `2252`, slot→struct). The viewer's "(cache)" sections edit the struct; the plain sections edit the quest JSON. The two hold overlapping/duplicated copies of the same data, and they can drift out of sync (confirmed: "Love Story" JSON lists 2 prereqs `[48,163]` but its struct only stores 1).

- **Slot ID mapping is hardcoded** — `QUEST_ID_TO_SLOT` in `quests.ts` was extracted manually from `Quests.java`. Figure out if/how this mapping can be derived directly from the cache so it doesn't go stale.
- **`_levelRequirements` (quest JSON) and struct skill-reqs (keys 871+) are the SAME data** (both `[skillId, level]` lists; confirmed identical on Love Story). The client reads the struct; the JSON field is a server mirror. Decide whether to keep both UI sections or merge into one that writes both locations on save.
- **`_questPrerequisiteIds` (quest JSON, stores quest ids) and struct prereqs (keys 859–870, store slot ids) are the same concept, two encodings.** Same merge/reconcile decision. Also handle the drift case (JSON and struct disagreeing on count).
- **`preReqSkillReqs` (accumulated from prereq tree)** was removed from the UI. May want to add it back as a read-only computed display to show total skill requirements including all prerequisites.
- **CONFIRMED BUG — `writeStruct` clears only 7 skill-req pairs (keys 871–884), but a quest struct exists with 10 pairs** (keys 871–890). Editing a quest with 8–10 reqs leaves the extra pairs orphaned/stale on save. Widen the clear loop (or make it dynamic up to the actual max, ~10).
- **Get the rest of quest structs within the editor to edit the quest start interface** — the struct has many more keys than the viewer currently surfaces (e.g. 845/846 name+sort, 848, 856, 898, 948–952 journal text / requirement descriptions / reward text). Expose the rest for editing.

## NPCs

- **Model Translations table desync risk.** The table is positional — slot N of `modelTranslation` pairs with the Nth entry of `modelIds` (per the cache format, opcode 121). Two things to harden: (a) when the Model IDs comma-list is edited on an NPC that has translations, the `modelIds` and `modelTranslation` arrays are edited independently and can desync (wrong translation paired with wrong model, or length mismatch); (b) ideally the UI should present translations *joined* to their model row so they can't drift, rather than as a separate free-edit list. Verified the basic pages work post-redump, but this pairing logic is fiddly and was deferred.

## Vars

- **Triple-check the vars entry is really complete.** Marked done after diffing cryogen `VarDefinitions` against darkan `VarpType` — both decode only opcode 1 (`paramType`, cp1252 char) and opcode 5 (`clientCode`, ushort), so the dump being almost entirely `{paramType: none, clientCode: 0}` (2708/2716 empty; only var 2715 has paramType `i`, 8 have a non-zero clientCode) appears correct. Still felt suspiciously sparse — before fully trusting it, confirm: (1) the cache `FileType.VARS` table really maps to darkan's *old* `VarpType` format (darkan comments it as "Old varp format" — make sure there isn't a newer/richer varp format for rev 727 that cryogen is decoding with the wrong class), and (2) spot-check a couple of the known-meaningful varps (run energy, weight, special-attack) against a live client to be sure clientCode values line up. The real per-varp structure lives in **varbits** (`VarpbitType`), so cross-check that table too.

## Sprites

- **Look into the vertical field in sprites, should they be rotated?**

## Map Sprites

- **Add a 'preview' to map_sprites to show what they would look like on a proper minimap.**

## Hitsplats / Hitbars

- **Find a better placement for the page-wide zoom control** — currently it's a label + stacked buttons block right under the viewer title (shared by both the hitbar and hitsplat viewers). It works but feels awkward there; experiment with a cleaner spot/layout that still makes it obvious the zoom affects every preview on the page.

## Hitsplats

- **Preview uses bold 11px Arial as a stand-in font** — once a fonts viewer/loader exists, render the damage number with the actual cache font referenced by `fontId` so the preview is pixel-accurate to the client. This is the last blocker before hitsplats can be marked done.
- **Verify hitsplat 24's right cap in-game** — its `rightCap` reuses the inner-left sprite (4497) un-flipped. Investigation found NO flip/rotate flag anywhere: not in the JSON, not in the client (darkan `EntityUpdating.kt` draws all caps with a plain `draw(x, y, combineMode, color, blend)` — no mirror param), and the cap sprites aren't clean horizontal flips of each other. So the preview *should* match the client. Confirm by looking at hitsplat 24 in the actual game: if in-game also shows the un-flipped right cap, this is just a data quirk and no further action is needed; if the game closes off the right side, there's a flip path we haven't found and it needs deeper investigation.

## Huffman

- **Regenerate-from-corpus editor** — make Huffman non-read-only by letting the user upload a chat corpus and rebuilding the table from it, so the compression can be re-tuned to a server's actual chat distribution. Details:
  - The cache's source of truth is only the per-byte **code-length array** (`originalByteData`); cryogen's `HuffmanDefinitions(byte[] codeLengths)` constructor derives the canonical `codes` + decode `table` (tree) from those lengths. So regeneration only needs to produce a good length-per-byte array — never hand-assign codes or build the tree.
  - Input: a plain-text chat corpus (upload a `.txt`; one message per line or concatenated). Count byte frequencies → run **length-limited Huffman** (package-merge, or plain Huffman + a depth-fixup pass) to cap code lengths at the format max (21 bits). Floor every byte to count ≥1 so all 256 keep a code and any future message can still encode.
  - Corpus size: representativeness matters more than raw size, but ~a few thousand messages (~200–500 KB) gives a solid table; ~1 MB is comfortable; below ~1,000 messages the rare chars get noisy. It degrades gracefully — won't break, just less optimal.
  - Add a **round-trip self-test** (encode a sample string, decode it back with the derived tree) before allowing save, so a bad table can't silently ship.
  - **File-upload safety (applies to ALL upload features, not just this one):** take every precaution with uploaded files — treat contents as untrusted, only ever read them as data (text/bytes), never execute, eval, or interpret them as code; validate type/size; and never write an uploaded file anywhere it could be run. The Huffman corpus should be parsed purely as text for frequency counting.
- The current viewer has a **Table / Visual** toggle (visual = code-length histogram + per-code bit-cell rows); it's read-only until the regeneration feature above lands.

## General Editor

- **Add/Remove/Clone buttons** are wired up via optional `createItem`/`deleteItem`/`cloneItem` loader methods. Implemented for the definition-style entries (cursors, map_sprites, items, objects, npcs, varbits, structs, params, vars, inventories, hitbars, hitsplats); entries whose loader lacks CRUD render the buttons disabled.
- **Detail viewers** for other cache types still show raw JSON: `items`, `npcs`, `objects`, `animations`, `areas`, `sprites`, `textures`, `interfaces`, `models`, `config` subfolders, etc.
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
