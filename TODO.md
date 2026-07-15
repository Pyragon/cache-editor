# TODO

## Maps (when the maps index gets dumped/decoded someday)

- **REMINDER: relook at skyboxes if maps reference them.** Skyboxes were signed off 2026-07-13 with the sun fields legitimately empty (rev 727 ships no sun definitions, so no skybox references one). But map/environment data may reference skybox ids (which environment uses which sky) — if the maps work surfaces such references, revisit the skybox editor to surface them (and reconsider the sun linkage).
- **REMINDER: verify object-placed map icons.** Config `areas` (MECType) was signed off 2026-07-13 with only *static-element* placements visible in the editor (the Placed At list). The other — and much more common — placement mechanism is objects: an object def's `mapCategoryId` puts that area's icon at every placed instance of the object, and those placements live in the maps/landscape index, which isn't dumped yet. When maps work happens, check those icons resolve correctly and consider extending the Placed At list to include object-based placements.

## Map Areas

- **World map preview** — render a visual of the area's rects (game-world rectangles → their map placement) so you can see what region of the world an area covers instead of reading raw coordinates. Could start as a simple 2D canvas plotting the rects to scale (game coords vs map coords side by side), and eventually underlay actual map tiles if we ever load them. (Signed off 2026-07-13 without it; nice-to-have.)

## Textures / Texture Definitions

- **`TextureDefinitions.getActions()` still returns `null`** in cryogen, so the *flag* edits the editor saves to `texture_definitions/<id>.json` never reach the cache. (`MaterialDefinitions.getActions()` is now implemented, so the op graph repacks fine — this is the other half.) It needs an `encode()` for its parallel-array blob.
- **Live preview: port the Rasterizer (op 29).** The TS renderer (`src/loaders/textureRender.ts`) covers 37 of 38 op types and renders **2185/2185 textures pixel-identical to cryogen**. The one gap is op 29, which leaves **406 textures** (16%) falling back to the dumped PNG. It needs the shape rasterizers in cryogen's `texture/rasterizers/`. Only four shape/mode combinations actually occur in the cache, so only these paths are needed:
  - `LineRasterizer` stroked (1539 shapes) — `method6159` + `method11220` (Bresenham with clipping)
  - `EllipseRasterizer` filled+stroked (906) — `method5316` and its helpers `method2637` / `method1174` / `method12838` / `method15241` (~470 lines, the bulk of the work)
  - `RectangleRasterizer` filled+stroked (674) — `method744` + `method4561` / `method1388`
  - `BezierCurveRasterizer` stroked (499) — `method12399` → `method12117` / `method4779`

  Verify with the harness: `RenderRefDump.java` + `SpriteRefDump.java` in cryogen dump reference pixels, and the scratchpad `verify-render.mjs` diffs every texture against them. Note the renderer must keep reproducing the row-cache aliasing (see `textureCaches.ts`) — a full-image evaluation gives different pixels.
- **No way to add/remove/reorder op nodes yet** — the editor edits existing nodes and rewires inputs, but can't grow the graph. Adding a node means appending to `textureOperations` *and* `operationIndices` together, and re-checking the three root indices.
- **Image upload for textures** only makes sense on top of a live preview: for sprite-backed materials it can write a new sprite and repoint the sampler op; for procedural ones it would mean replacing the whole graph with a single sprite sampler (destructive — should be an explicit, warned action).

## Item Icons

- **Generate item icons from our own cache instead of itemdb.biz.** The current set (`public/icons/`, fetched by `scripts/download-icons.mjs`) is scraped from itemdb.biz, which renders from the *latest* RS cache — a number of icons have changed since rev 727, so ours are subtly wrong. The proper fix is rendering them ourselves the way the client builds inventory icons: render the item's model (`inventoryModelId`) with the item's 2D params (zoom2d, xan2d/yan2d/zan2d, xOffset2d/yOffset2d) into a 32×32 canvas — the Three.js model pipeline in ModelViewer already does most of the heavy lifting. Check darkan's icon/sprite rendering code for the exact camera math before porting (see CLAUDE.md reference-repo rules).

## Quests

Architecture note (investigated 2026-07-12): a quest lives in **two places** — the server-side quest JSON (`config/quests/<id> - <name>.json`) and the client-facing **cache struct** (`config/structs/<structId>.json`). Link: quest id → slot id (hardcoded `QUEST_ID_TO_SLOT`) → struct id (via enum `2252`, slot→struct). The viewer's "(cache)" sections edit the struct; the plain sections edit the quest JSON. The two hold overlapping/duplicated copies of the same data, and they can drift out of sync (confirmed: "Love Story" JSON lists 2 prereqs `[48,163]` but its struct only stores 1).

- **Slot ID mapping is hardcoded** — `QUEST_ID_TO_SLOT` in `quests.ts` was extracted manually from `Quests.java`. Figure out if/how this mapping can be derived directly from the cache so it doesn't go stale.
- **`_levelRequirements` (quest JSON) and struct skill-reqs (keys 871+) are the SAME data** (both `[skillId, level]` lists; confirmed identical on Love Story). The client reads the struct; the JSON field is a server mirror. Decide whether to keep both UI sections or merge into one that writes both locations on save.
- **`_questPrerequisiteIds` (quest JSON, stores quest ids) and struct prereqs (keys 859–870, store slot ids) are the same concept, two encodings.** Same merge/reconcile decision. Also handle the drift case (JSON and struct disagreeing on count).
- **`preReqSkillReqs` (accumulated from prereq tree)** was removed from the UI. May want to add it back as a read-only computed display to show total skill requirements including all prerequisites.
- **Get the rest of quest structs within the editor to edit the quest start interface** — the struct has many more keys than the viewer currently surfaces (e.g. 845/846 name+sort, 848, 856, 898, 948–952 journal text / requirement descriptions / reward text). Expose the rest for editing.

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

- **Detail viewers still missing** (raw-JSON fallback only): `animations` (+ `animation_frame_sets`/`frame_bases`), `spot_animations`, `interfaces`, `cs2`, `sound_effects`, `midi_instruments`, and config `identikits` (which also needs its dump format flattened first).
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
