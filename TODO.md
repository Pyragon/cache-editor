# TODO

## Maps

The `maps` entry is now dumped/decoded (2026-07-15) — cryogen `MapDefinitions` decodes/encodes terrain ("m" archives) and XTEA-encrypted placed objects ("l" archives), one JSON per region (2,407 total, ~350MB, base64-packed per-tile channels to keep file size sane). The editor renders a top-down coloured preview per plane with click-to-edit tile fields (underlay/overlay id, shape, rotation, flags, explicit height). Verified: terrain functional round-trip 100%, locations byte-identical round-trip on the test region (13364 / world tile 3333,3333).

Deferred for a future pass:
- **Object placement editing.** Placed objects (up to ~2000 per region) are rendered as coloured dots on the preview but aren't editable yet — needs a practical UI given the scale (a raw table would need virtualization/pagination/plane-filtering; the encode side — `MapDefinitions.encodeLocations` — already round-trips correctly, so this is purely an editor-UI gap).
- **Object name resolution in the hover tooltip.** Currently shows the numeric object `type`/id only; resolving to the real object name means reading `objects/<id>.json` per placed object (up to ~2000 file reads per region) — needs batching/caching before it's practical.
- **Height defaults.** Tiles without an explicit height opcode get a smooth procedural default from the client's terrain noise function (`TileUtils.calculateTileheight`), which isn't reproduced — the preview is a flat top-down view so this doesn't currently matter, but would if a 3D preview is ever built.
- **Verify the full write pipeline in-game** (same caveat as game tips): the encode/decode symmetry is proven, but an actual save → repack → client boot hasn't been exercised, and location repacks depend on a cryogen fix made alongside this work (`Index.putFile` never actually re-encrypted XTEA archives on write — `keys` was only used to decrypt sibling files when consolidating a multi-file archive, never passed to the output `Archive`'s own `keys` field before `compress()`; fixed by setting it explicitly).
- **REMINDER: relook at skyboxes if maps reference them.** Skyboxes were signed off 2026-07-13 with the sun fields legitimately empty (rev 727 ships no sun definitions, so no skybox references one). But map/environment data may reference skybox ids (which environment uses which sky) — check whether terrain data surfaces such references, and revisit the skybox editor to surface them (and reconsider the sun linkage).
- **REMINDER: verify object-placed map icons.** Config `areas` (MECType) was signed off 2026-07-13 with only *static-element* placements visible in the editor (the Placed At list). The other — and much more common — placement mechanism is objects: an object def's `mapCategoryId` puts that area's icon at every placed instance of the object, and those placements live in the maps/landscape index, which is now dumped — check those icons resolve correctly and consider extending the Placed At list to include object-based placements.

## Map Areas

- **World map preview** — render a visual of the area's rects (game-world rectangles → their map placement) so you can see what region of the world an area covers instead of reading raw coordinates. Could start as a simple 2D canvas plotting the rects to scale (game coords vs map coords side by side), and eventually underlay actual map tiles if we ever load them. (Signed off 2026-07-13 without it; nice-to-have.)

## Textures / Texture Definitions

- **Live preview: port the Rasterizer (op 29).** The TS renderer (`src/loaders/textureRender.ts`) covers 37 of 38 op types and renders **2185/2185 textures pixel-identical to cryogen**. The one gap is op 29, which leaves **406 textures** (16%) falling back to the dumped PNG. It needs the shape rasterizers in cryogen's `texture/rasterizers/`. Only four shape/mode combinations actually occur in the cache, so only these paths are needed:
  - `LineRasterizer` stroked (1539 shapes) — `method6159` + `method11220` (Bresenham with clipping)
  - `EllipseRasterizer` filled+stroked (906) — `method5316` and its helpers `method2637` / `method1174` / `method12838` / `method15241` (~470 lines, the bulk of the work)
  - `RectangleRasterizer` filled+stroked (674) — `method744` + `method4561` / `method1388`
  - `BezierCurveRasterizer` stroked (499) — `method12399` → `method12117` / `method4779`

  Verify with the harness: `RenderRefDump.java` + `SpriteRefDump.java` in cryogen dump reference pixels, and the scratchpad `verify-render.mjs` diffs every texture against them. Note the renderer must keep reproducing the row-cache aliasing (see `textureCaches.ts`) — a full-image evaluation gives different pixels.
- **No way to add/remove/reorder op nodes yet** — the editor edits existing nodes and rewires inputs, but can't grow the graph. Adding a node means appending to `textureOperations` *and* `operationIndices` together, and re-checking the three root indices.
- **Replace an *existing* texture's image.** "New from image" covers creating a texture from an upload, but swapping the image of an existing material is still missing: for sprite-backed materials it can write a new sprite and repoint the sampler op; for procedural ones it would mean replacing the whole graph with a single sprite sampler (destructive — should be an explicit, warned action).

## Item Icons

- **Generate item icons from our own cache instead of itemdb.biz.** The current set (`public/icons/`, fetched by `scripts/download-icons.mjs`) is scraped from itemdb.biz, which renders from the *latest* RS cache — a number of icons have changed since rev 727, so ours are subtly wrong. The proper fix is rendering them ourselves the way the client builds inventory icons: render the item's model (`inventoryModelId`) with the item's 2D params (zoom2d, xan2d/yan2d/zan2d, xOffset2d/yOffset2d) into a 32×32 canvas — the Three.js model pipeline in ModelViewer already does most of the heavy lifting. Check darkan's icon/sprite rendering code for the exact camera math before porting (see CLAUDE.md reference-repo rules).

## Game Tips

- **Verify game tips repack in-game (future).** The editor + dumper are done (31/31 byte-identical round-trips), but an actual save → CacheBuilder repack → client boot hasn't been exercised: confirm an edited tip (text/timing/rotation) shows correctly on the real loading screen, and that the stage-table regeneration (master rotation editing rewrites all 36 stages) doesn't upset the client's preference-cursor stage selection.

## Interfaces

The `interfaces` entry now has a real dumper/encoder/viewer (2026-07-15). cryogen `IComponentDefinitions` dumps `interfaces/<interfaceId>/<componentId>.json` — one folder per interface, one JSON file per component (no `components/` subfolder, no per-interface screenshot; both the old nested-with-screenshot layout and an intermediate flat-array-per-interface layout were tried and replaced before landing here). Field names were cross-referenced against darkan-bot-refactor's `Component.kt` and renamed (~35 fields); ~15 fields remain unidentified obfuscated names (`anObjectArray1413` etc. — CS2 script hooks whose purpose wasn't cross-referenced yet).

Writing this dumper for the first time surfaced three real, previously-invisible bugs in the (pre-existing) `encode()` — nothing to do with the rename, all confirmed via a byte-identical round-trip test (`IComponentRoundTripTest`, package `com.cryo.cache.loaders.interfaces`, left in the repo per the existing `*RoundTripTest` convention) against all 1,323 interfaces / 65,259 components:
- **MODEL components**: the transform/origin/orthogonal/priority-render flag byte was computed but never written — every MODEL component's encode was 1 byte short.
- **Menu option cursors**: the packed byte combining option count + cursor mask only ever wrote the count (cursor mask nibble was always 0 on encode, so the whole cursor-mask branch was dead), *and* the cursor value itself was read from the wrong array index (`length-2` instead of `length-1`).
- **Cycle-step / key-trigger entries**: `decode()` reused a single field as both the persistent value and the loop's scratch variable, so by the time decode finished the field held the loop's terminal value (usually 0) instead of the real one — encode's `if (hash != 0)` guard almost never fired, silently dropping these entries. Also separately, encode wrote each entry as a 4-byte int instead of the real ~2-byte packed format. Both fixed; `decode()` now uses a local loop variable and doesn't clobber persistent state.

The `decode()` text mutation that silently rewrote "RuneScape" → "Darkan" in TEXT components (a leftover from some earlier rebranding experiment — it would have permanently overwritten the live cache's original strings on any save) has been removed entirely; `text` now round-trips as dumped.

Two more root causes were found and fixed chasing full byte-identical fidelity:
- **`InputStream.readString()`/`OutputStream.writeString()` had no real charset table at all.** `readString()` sign-extended each raw signed Java `byte` straight into a `char`, corrupting every codepoint ≥0x80 into the wrong Unicode range. `writeString()` used `String.getBytes()` with no charset argument — the JVM platform-default (confirmed `windows-1252` on this JDK17/Windows setup, not UTF-8), non-deterministic and wrong regardless. RS text is actually Windows-1252 with a real 32-entry special-character table for bytes 0x80-0x9f (curly quotes, em-dash, euro sign, etc.). Ported the exact table from darkan-game-client (`Class490.aCharArray5766` for decode, `Index.method5693` for encode) into both classes — this is shared low-level infra, so it should also fix special characters in any other entry's text, not just interfaces.
- **The JSON dump writer itself wasn't UTF-8.** `dumpFiles()`/`fromFile()` used `new FileWriter(file)`/`new FileReader(file)` with no charset, defaulting to the same platform `windows-1252` — any non-ASCII character was written as a single raw byte, invalid UTF-8, which every reader (the browser, Node, this editor) rendered as `�`. Fixed by writing/reading with explicit UTF-8 in `IComponentDefinitions`. **This exact `new FileWriter`/`new FileReader` pattern (no charset argument) exists in ~62 other files across cryogen** — only this one was touched; any other entry with non-ASCII text in its dump likely has the same silent corruption and would need the same fix.
- **One genuinely inert byte, preserved rather than dropped.** One real component (interface 1320/component 1) has an extra bit (0x20) set in its MODEL flag byte that darkan's actual client decode never reads (confirmed against source — it only tests bits 0x1/0x2/0x4/0x8). Rather than silently losing it on re-encode, it's now captured (`modelFlagUnusedBits`) and written back verbatim. A second, more general safety net was added alongside it: any bytes at all that `decode()` doesn't consume for a given component are captured as `trailingUnreadBytes` and appended back on `encode()`, so any other not-yet-understood trailing data (should any exist) round-trips instead of being silently dropped.

After all fixes: **65,259/65,259 components (100%) byte-identical.**

Editor side: `src/loaders/interfaces.ts` (full typed loader, matches the JSON field-for-field), `src/loaders/interfaceLayout.ts` (ports darkan's `Class484.initSizes` / `Class246.method4204` aspect-ratio layout resolution — the same recursive parent→children walk `InteractableObject.method16099` does at runtime), `src/components/InterfaceViewer.tsx` (component tree, per-type field editing, CS2 script hooks shown as raw editable tagged-arg lists, and a live 2D layout preview canvas).

Deferred / not done in this pass (the user asked to "begin setting up" a fully interactive editor, not necessarily finish it):
- **Three.js MODEL preview is on-demand, not composited into the layout.** Clicking a MODEL component's "Preview" link loads the target model (via the existing `models` loader) and mounts the existing `ModelViewer` component inline — this reuses well-tested rendering rather than risking new Three.js bugs, but it isn't a true live composite of the whole interface (a MODEL component just renders as a placeholder "3D" box in the 2D preview canvas until clicked). NPC/PLAYER/ITEM_CONTAINER model types (composite equipment/identikit models) aren't previewable at all yet — only `RAW_MODEL`/`ITEM` will resolve through the plain models loader.
- **CS2 scripts are edited as raw tagged-arg lists, not decompiled.** No attempt was made to interpret opcodes — `onClick`/`onLoad`/etc. show as a comma-separated list of ints/strings, editable but opaque.
- **TEXT rendering in the preview canvas uses the browser's font, not the real cache font/glyphs** (unlike Game Tips' preview, which loads actual cache fonts) — a faithful pass would reuse `loadCacheFont`/`drawCacheText` from `fontRender.ts` here too.
- **No add/remove component support** — the tree only edits existing components, componentId 0..N-1 as dumped.
- **Not tested in a real browser session yet** (no headless-browser tool available to click through the File System Access flow) — needs the user's hands-on pass: open a real cache, browse a few interfaces (try a MODEL-heavy one and a TEXT-heavy one), confirm the preview and field edits look right, and confirm Save round-trips before trusting it for real edits.

## NPCs

- **Model Translations table desync risk.** The table is positional — slot N of `modelTranslation` pairs with the Nth entry of `modelIds` (per the cache format, opcode 121). Two things to harden: (a) when the Model IDs comma-list is edited on an NPC that has translations, the `modelIds` and `modelTranslation` arrays are edited independently and can desync (wrong translation paired with wrong model, or length mismatch); (b) ideally the UI should present translations *joined* to their model row so they can't drift, rather than as a separate free-edit list. Verified the basic pages work post-redump, but this pairing logic is fiddly and was deferred.

## Vars

- **Triple-check the vars entry is really complete.** Marked done after diffing cryogen `VarDefinitions` against darkan `VarpType` — both decode only opcode 1 (`paramType`, cp1252 char) and opcode 5 (`clientCode`, ushort), so the dump being almost entirely `{paramType: none, clientCode: 0}` (2708/2716 empty; only var 2715 has paramType `i`, 8 have a non-zero clientCode) appears correct. Still felt suspiciously sparse — before fully trusting it, confirm: (1) the cache `FileType.VARS` table really maps to darkan's *old* `VarpType` format (darkan comments it as "Old varp format" — make sure there isn't a newer/richer varp format for rev 727 that cryogen is decoding with the wrong class), and (2) spot-check a couple of the known-meaningful varps (run energy, weight, special-attack) against a live client to be sure clientCode values line up. The real per-varp structure lives in **varbits** (`VarpbitType`), so cross-check that table too.

## Map Sprites

- **Add a 'preview' to map_sprites to show what they would look like on a proper minimap.**

## Hitsplats / Hitbars

- **Find a better placement for the page-wide zoom control** — currently it's a label + stacked buttons block right under the viewer title (shared by both the hitbar and hitsplat viewers). It works but feels awkward there; experiment with a cleaner spot/layout that still makes it obvious the zoom affects every preview on the page.

## Hitsplats

- **Verify hitsplat 24's right cap in-game** — its `rightCap` reuses the inner-left sprite (4497) un-flipped. Investigation found NO flip/rotate flag anywhere: not in the JSON, not in the client (darkan `EntityUpdating.kt` draws all caps with a plain `draw(x, y, combineMode, color, blend)` — no mirror param), and the cap sprites aren't clean horizontal flips of each other. So the preview *should* match the client. Confirm by looking at hitsplat 24 in the actual game: if in-game also shows the un-flipped right cap, this is just a data quirk and no further action is needed; if the game closes off the right side, there's a flip path we haven't found and it needs deeper investigation.

## Models

- **Import a Blender model and convert it to the RS mesh format.** Not `.blend` directly (proprietary, no parser) — the route is Blender's **glTF or OBJ export**, converted client-side into a new-format 727 mesh. Needs, in order: (1) a mesh **encoder** in TS (`models.ts` only decodes today) — vertices as delta-smart2 streams, faces, per-face HSL colours quantised from vertex/material colours, the 23-byte footer; (2) cryogen `ModelDefinitions.getActions()` so the written `model.dat` actually repacks (check whether models repack at all today); (3) an Upload button on the model viewer with the usual staged-upload pattern + upload-safety disclaimers. Constraints to enforce at import: ≤65k verts/faces (shorts), tri-only geometry, and textures mapped to the closest RS mechanism (planar PNM per face) or dropped to flat colours in v1.

- **Per-face translucency isn't rendered.** Fully transparent faces (alpha 255) are now hidden, but partially transparent ones (glass, ghosts — alpha 1–254) still draw opaque. Fixing it means a 4-component colour attribute + `transparent` materials in ModelViewer, and accepting the sorting artifacts that come with double-sided transparency.

## General Editor

- **REMINDER: set up proper production hosting when the editor is nearly feature-complete** (user asked 2026-07-14 to be reminded "much later once we get almost everything finished"). The app is backend-less, so production = `npm run build` + Caddy `file_server` on `dist/` (no Node process at runtime, nothing to restart — unlike the dev server, whose week-old instance developed 20-second event-loop stalls). Content-hashed assets can take the same `immutable` caching the `/icons/*` Caddy route already has.
- **Detail viewers still missing** (raw-JSON fallback only): `animations` (+ `animation_frame_sets`/`frame_bases`), `spot_animations`, `cs2`, `sound_effects`, `midi_instruments`, and config `identikits` (which also needs its dump format flattened first).
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
