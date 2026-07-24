# TODO

Open work only — completed passes live in git history and README.

## Spot Animations ("gfx")

- **`scaleXZ`/`scaleY` aren't applied in the preview** — the model renders at its native size regardless of the def's scale fields. Cosmetic only, straightforward to add (a uniform scale on the posed geometry before handing it to `ModelViewer`).
- **Ground-contour blending isn't previewed** — needs real terrain height data the model previewer doesn't have; same deferral as `animations`.
- **Not verified in a live client or browser session** — no headless-browser tool available here, and no way to compare the transform math's output against real client rendering without one.

## Animations

- **REMINDER (2026-07-19): Cody found an animations issue while testing in the live client** — parked while other editors get finished; ask him what it was when animations come back up. (He never described it — don't guess.)
- **Not ported in `skeletalAnimation.ts`:**
  - **Frame interpolation/tweening** (`animatePartialtransform`, blending between two frames) — real animations use this for smooth playback between keyframes; playback currently poses one exact frame at a time.
  - **The BAS equipment-matrix branch inside `animateTransform`** (the `verticesData.isNotEmpty()` case, a full 3×3 rotation-matrix composition) — always empty/null in the base playback path (confirmed via every real call site), needed only for equipment-piece-specific pose adjustments.
  - **Billboard effect transform types** (8/9/10 offset/rotate/scale) — mutate billboard-group data no inverted index exists for yet.
  - **Submesh gating** (`verticesSubmeshes`, restricting a transform to specific equipment pieces in a composite) — not built into `mergeModels()`'s output yet, so multi-part composites (identikit/equipment stacks) can't be animated with full correctness.
- **Type-5 reveal limitation in ModelViewer's in-place path**: it can hide faces (collapse to a degenerate triangle) but can't REVEAL faces that were alpha-hidden at rest (they're never built into the buffer). The chathead preview rebuilds geometry per frame and handles both directions.
- **Transform math not verified against the live client** — a careful line-by-line port of darkan source, but treat it as unverified until someone compares stepped poses against real client rendering on a rigged model.

## Identikits / Player Preview

- **Slot semantics beyond weapon/shield aren't verified.** The remaining ~10 appearance-table positions (cape, amulet, gloves, boots, etc. by RS2 convention) aren't cross-checked against real item `wearPos` values, so the tool labels them by raw slot number rather than guessing wrong names.
- **No global recolour palette.** `PlayerAppearance.kt`'s 10-slot `recolorDstIndices`/shared palette system (hair colour, skin tone, etc. — the character-creation colour pickers) isn't wired up; only each identikit's/item's own baked-in recolour pairs are applied.
- **Head-specific compositing isn't in the Player Preview tool** (identikit's own `headModels`/item's `maleHead1-2`/`femaleHead1-2`) — only body meshes are assembled into the avatar.
- **Not tested in a real browser session** (File System Access API limitation; typecheck/lint/build pass, Java round-trip verified independently).

## Sound / Music

- **`sound_effects_midi` keymap is read-only** — the 128-note keymap renders as grouped ranges with resolved sample links; per-note editing across six 128-entry parallel arrays needs a better UI concept before it's worth building.
- **`sound_effects_midi` editor not tested in a real browser session** — typecheck/lint/build pass; the dumper/decoder is verified byte-identical independently.

## Maps

- **REVISIT: minimap fidelity is still not signed off (2026-07-19).** Cody isn't happy with the results yet and expects this may need a redo. Three approaches tried so far: (1) client-faithful HSL pipeline (corner-blended palette + Gouraud lights + blurred shadows), (2) that plus overlay corner blending/splatting, (3) the cryogen-website MapImageDumper port (current state). When picking this back up: compare against the live client side-by-side at the same regions before iterating, and consider that the true HD minimap is literally the textured 3D ground rendered top-down (GroundGL.renderMinimapFloor) — rendering our own terrain meshes orthographically into the minimap canvas may be the correct endgame rather than any per-tile approximation. Once resolved, ALSO add the deferred map_sprites minimap preview (see Map Sprites).
- **DECIDE: height-stroke semantics.** A held drag currently applies one uniform step across the stroke (heights derive from pre-stroke values, so overlaps don't compound); the alternative is continuous accumulation while the brush lingers ("terrain flows up under a held brush"). Ask Cody after he's felt the current behaviour in real use.
- **REMINDER: verify object-placed map icons.** Config `areas` (MECType) was signed off with only *static-element* placements visible in the editor. The other — much more common — placement mechanism is objects: an object def's `mapCategoryId` puts that area's icon at every placed instance, and those placements live in the maps index, now dumped — check those icons resolve correctly and consider extending the Placed At list to include object-based placements.
- **Verify the full write pipeline in-game**: encode/decode symmetry is proven, but an actual save → repack → client boot hasn't been exercised, and location repacks depend on the `Index.putFile` XTEA re-encryption fix made alongside that work.
- **EYEBALL LATER (per Cody, 2026-07-23): the env-mapped water colour is not signed off.** The underwater-map water is done and working (riverbed depth → transparent shore fade + procedural-sky reflection, mirrors client `EnvMappedWater`); Cody wants to eyeball the deep-water colour/saturation against his client before it's final. Knobs live in `MapSceneViewer.tsx` water uniforms: `uDeepTint` (deep body colour), `uSkyZenith`/`uSkyHorizon` (reflected sky gradient), `uSpecExp`/spec `*0.5` scale, wave amplitude. Tell me "darker / more teal / less sparkle" etc.
- **CLEANUP before committing the water work**: remove temp `UnderwaterTestDump.java` (cryogen) and the `__camera`/`__controls`/`__scene`/`__perf` rig hooks in `MapSceneViewer.tsx`.
- Water: still no per-material water effects beyond the env-mapped surface; alphaTest is a fixed 0.35 cutout on textured terrain.
- Wall-decoration displacement (`decorDisplacement` offsets toward the wall) is simplified to tile-centre placement.
- No ground-contouring for locs (`groundContourType`) — trees sit on flat average height.
- **Loc idle animations now play** (waving flags etc.): locs whose ObjectType `animations[]` is non-empty are kept out of the merged static mesh (`buildAnimatedLocMesh` in mapScene.ts + `LocAnimator` in locAnimator.ts) and posed via `applyAnimationFrame`. Verified working (8× amplification test showed clear flag deformation; the Lumbridge mosaic has ~326 animated locs). **Perf-hardened**: posing is culled to on-screen + visible-plane locs (frustum test in the RAF loop), so only ~8–27 of 326 solve per frame instead of all 326; vertex/face skin groups are cached per model in skeletalAnimation.ts; animated meshes keep three.js frustum culling (padded bounds) so off-screen ones don't draw. (The original whole-machine slowdown turned out to be Opera running WebGL in **software** — hardware acceleration was off. Culling stays as a safety margin; the 24fps pose throttle was removed once accel was re-enabled.) Remaining follow-ups: (1) castle flags sit on **planes 1/3 hidden by default** — enable those planes to see them; (2) animated locs aren't click-pickable (not in the merged mesh's triangleOwners); (3) type-5/7 face-alpha/colour transforms aren't applied (position only); (4) TEMP `__planeGroups` rig hook in MapSceneViewer to remove with the other rig hooks.
- Environments not yet applied: point lights, HDR values, the sun cube texture, per-chunk environment blending (one env per region is used), the static lighting grid.
- **Loc/model shading now uses ModelGL HD Gouraud lighting** (`computeLitFaceRgb`, default map environment) instead of flat baked face colour — but it is **not yet visually calibrated against the live client**. Confirm brightness/gamma/sRGB match a real client screenshot (trees were the reported case); the loc light currently ignores the region's actual environment sun (uses `DEFAULT_SUN_LIGHT`) and uses default ambient/contrast where `def.ambient`/`def.contrast` are absent. Ground shading, static shadows, and anti-aliasing that Cody also flagged in the same comparison are still separate open items.
- **Marker-model hide mechanism unidentified**: ambient-sound/map-icon anchor models (all faces HSL16 29113 teal) are never shown by the shipped client, yet no hide flag exists in the mesh, def, or ModelSM culling. The editor detects all-29113 models and shows colour-coded diamonds instead. If teal quads ever show up in-scene, look for a second marker colour (flowerbed models also carry bright-cyan 33728 faces alongside real geometry, currently rendered).
- Terrain brush: strokes on the outermost ~2 tile rows open a visible seam against the neighbouring region's un-rebuilt edge mesh — fix means rebuilding adjacent neighbour terrain strips (or vertical skirts between regions).
- Editor affordances still missing: in-scene highlight on marquee-selected objects, paste-footprint preview rectangle, cache-global name search (currently region-scoped), editing beyond the centre region. Also note: area-stamp paste APPENDS objects — existing objects in the target area are not cleared.
- Tile-field editing from the 3D view (the 2D view has it).
- Object name resolution in the hover tooltip — needs batched/cached `objects/<id>.json` reads (up to ~2000 per region) before it's practical.
- Overlay/underlay brush swatches show the config's FLAT colour, but textured overlays render their texture in-scene — texture thumbnails in the picker would need texture PNG loads per overlay.
- The outer edge of the 3×3 neighbourhood mosaic clamps — only matters if the camera leaves the neighbourhood.
- Skybox editor: surface a "used by N regions" list per skybox id (the data is all in `map_environments/*.json`).
- **World map ideas** (see `docs/worldmap.md`): a world map view rendered from MAP_AREAS data; a "rebake worldmap from current maps" pipeline so editor edits show on the world map.

## Map Areas

- **World map preview** — render a visual of the area's rects (game-world rectangles → their map placement) so you can see what region of the world an area covers instead of reading raw coordinates. Could start as a simple 2D canvas plotting the rects to scale, and eventually underlay actual map tiles.

## Textures / Texture Definitions

- **No way to add/remove/reorder op nodes yet** — the editor edits existing nodes and rewires inputs, but can't grow the graph. Adding a node means appending to `textureOperations` *and* `operationIndices` together, and re-checking the three root indices.
- **Replace an *existing* texture's image.** "New from image" covers creating a texture from an upload, but swapping the image of an existing material is still missing: for sprite-backed materials it can write a new sprite and repoint the sampler op; for procedural ones it would mean replacing the whole graph with a single sprite sampler (destructive — should be an explicit, warned action).

## Item Icons

- **Generate item icons from our own cache instead of itemdb.biz.** The current set (`public/icons/`, fetched by `scripts/download-icons.mjs`) is scraped from itemdb.biz, which renders from the *latest* RS cache — a number of icons have changed since rev 727, so ours are subtly wrong. The proper fix is rendering them ourselves the way the client builds inventory icons: render the item's model (`inventoryModelId`) with the item's 2D params into a 32×32 canvas — the Three.js model pipeline in ModelViewer already does most of the heavy lifting. Check darkan's icon/sprite rendering code for the exact camera math before porting.

## Game Tips

- **Verify game tips repack in-game.** An actual save → CacheBuilder repack → client boot hasn't been exercised: confirm an edited tip (text/timing/rotation) shows correctly on the real loading screen, and that the stage-table regeneration (master rotation editing rewrites all 36 stages) doesn't upset the client's preference-cursor stage selection.

## Interfaces

- **Interactive editing on the canvas** (drag/resize/reparent) — explicitly deferred by the user until the preview was right.
- **CS2 scripts are edited as raw tagged-arg lists, not decompiled.**
- **No add/remove component support** — the tree only edits existing components.
- **Model textures / item & entity model types** in the preview: RAW_MODEL renders vertex-coloured only; ITEM/NPC_HEAD/PLAYER_* need item-def/identikit composition (the pieces exist in `playerAppearance.ts`).
- **`<img=n>` mod-icon text tags are stripped** rather than drawn.
- **Two font renderers exist** — `fontRender.ts` (GameTips, single-line, `fonts/glyphs/` PNGs) and the fuller `interfacePreview.ts` implementation (sprite-frame glyphs); should consolidate on the latter.
- **~15 component fields remain unidentified obfuscated names** (`anObjectArray1413` etc. — CS2 script hooks whose purpose wasn't cross-referenced yet).

## NPCs

- **Verify the chathead emote list (`src/loaders/headAnimations.ts`) against the new gamevals dump.** The list was transcribed from darkanrs `world-server/.../dialogue/HeadE.java` (2026-07-20); cross-check the names/animation ids against the gamevals dump and reconcile any differences.

## Cutscenes

- **OPEN BUG (2026-07-21): a class of loc objects around the God Wars chapel don't appear (bridge stonework, church ledges/base-plinth/"bottom outer" trim); walls/roof are fine.** VERIFIED via per-loc render logging in `buildLocsMesh`: the chapel's walls (loc 61734 plane 0, 61699 plane 1), roof (61704 plane 2) and crenellations (61708 plane 3) ALL render at the correct cascaded heights (−1536 / −3584 / −4608 / −5280) — the multi-storey structure is faithful, so the earlier "walls don't render / floating" framing was WRONG. Ruled out: shape→model skip (none), marker-face hiding (only 1 genuine marker region-wide), height corruption (a red herring — the debug dedup was showing a *neighbour* region that reuses the same loc ids; the centre terrain is correct, hv[1455]=48). The missing pieces are NOT the chapel walls. `groundContourType` was ported (`contourVertexY` in mapScene.ts — ct1/2/4/5, client `ModelSM.contourToGround`) since bridges (loc 54937 ct5) and paths (ct1) need it; it builds/lints and doesn't regress the chapel, but did NOT visibly fix the reported missing pieces (the chapel ledge pieces are ct0). NEXT: get the specific loc id of one missing piece (right-click/inspect in the maps editor, or in-game Examine) and trace why THAT loc doesn't render — do not keep guessing which loc it is. Contour port is unverified for correctness (couldn't confirm the bridge arch) — verify or revert.

- **Editing + repack.** The viewer is read-only; the cryogen side already has a verified byte-identical `encode()` (16/16), so an editable pass needs: editing UI (the usual draft/save-bar pattern), `saveItem` in the loader, a CacheBuilder repack path that reads the JSON back into `CutsceneDefinitions` (Gson → encode), and `getActions()` on the definition.
- **PLAY_VORBIS previews** — the 116 vorbis actions reference index 36 (Vorbis), which has no cryogen dumper; sounds can't be previewed until that index is dumped.
- **Playback preview gaps** (the 3D player simulates terrain/locs, camera splines, entity walk routes + animations, object spawns and fades):
  - Area **rotations 1–3** aren't implemented in `cutsceneScene.ts` (no shipped cutscene uses them — copied unrotated with a warning). The client transforms to port live in darkan `MapLoader.decodeTilesServer` / `EnvironmentManager.localOffsetX/Y`.
  - **Not simulated**: sounds, entity/positioned gfx, projectiles, hitmarks, hint arrows, tile messages, SET_VARIABLE/EXECUTE_SCRIPT hooks.
  - **Approximations to verify against the live client**: MOVEMENT/ROTATE facing-angle sign convention (yaw mapping is uncalibrated), walk/run/half-walk pace (assumed 1 tile per 30/15/60 cycles), and the spline row[3] term (client lerps it into `cameraPitch` — not applied).
  - The player entity renders as a cone marker — its appearance streams from the server at runtime (`CUTSCENE_BUFFER`), which the cache doesn't carry. Could offer a default identikit avatar via `playerAppearance.ts`.
  - Terrain textures load but loc **static shadows** (the darkened ring under scenery) are skipped in the player.

## Vars

- **Triple-check the vars entry is really complete.** Marked done after diffing cryogen `VarDefinitions` against darkan `VarpType` — both decode only opcode 1 (`paramType`, cp1252 char) and opcode 5 (`clientCode`, ushort), so the dump being almost entirely `{paramType: none, clientCode: 0}` (2708/2716 empty; only var 2715 has paramType `i`, 8 have a non-zero clientCode) appears correct. Still felt suspiciously sparse — before fully trusting it, confirm: (1) the cache `FileType.VARS` table really maps to darkan's *old* `VarpType` format (darkan comments it as "Old varp format" — make sure there isn't a newer/richer varp format for rev 727 that cryogen is decoding with the wrong class), and (2) spot-check a couple of the known-meaningful varps (run energy, weight, special-attack) against a live client to be sure clientCode values line up. The real per-varp structure lives in **varbits** (`VarpbitType`), so cross-check that table too.

## BAS

- Repack not yet exercised in-game (same caveat as other entries).
- Nice-to-have: the fit-table View Anim dropdown previews on the NPC's **first** model only — posing the full merged multi-model NPC via `mergeModels` remains open, blocked on the same submesh-gating gap noted under Animations.

## Map Sprites

- **REMINDER (per Cody, 2026-07-19): when the minimap blending REVISIT (see Maps) is finally resolved, come back and add a minimap-render preview to map_sprites** — show the stamp as it would look drawn on a real minimap, reusing whatever minimap renderer wins.

## Hitsplats / Hitbars

- **Find a better placement for the page-wide zoom control** — currently it's a label + stacked buttons block right under the viewer title (shared by both the hitbar and hitsplat viewers). It works but feels awkward there; experiment with a cleaner spot/layout that still makes it obvious the zoom affects every preview on the page.

## Hitsplats

- **Verify hitsplat 24's right cap in-game** — its `rightCap` reuses the inner-left sprite (4497) un-flipped. Investigation found NO flip/rotate flag anywhere: not in the JSON, not in the client (darkan `EntityUpdating.kt` draws all caps with a plain `draw(x, y, combineMode, color, blend)` — no mirror param), and the cap sprites aren't clean horizontal flips of each other. So the preview *should* match the client. Confirm by looking at hitsplat 24 in the actual game: if in-game also shows the un-flipped right cap, this is just a data quirk and no further action is needed; if the game closes off the right side, there's a flip path we haven't found and it needs deeper investigation.

## Models

- **Import a Blender model and convert it to the RS mesh format.** Not `.blend` directly (proprietary, no parser) — the route is Blender's **glTF or OBJ export**, converted client-side into a new-format 727 mesh. Needs, in order: (1) a mesh **encoder** in TS (`models.ts` only decodes today) — vertices as delta-smart2 streams, faces, per-face HSL colours quantised from vertex/material colours, the 23-byte footer; (2) cryogen `ModelDefinitions.getActions()` so the written `model.dat` actually repacks (check whether models repack at all today); (3) an Upload button on the model viewer with the usual staged-upload pattern + upload-safety disclaimers. Constraints to enforce at import: ≤65k verts/faces (shorts), tri-only geometry, and textures mapped to the closest RS mechanism (planar PNM per face) or dropped to flat colours in v1.
- **Per-face translucency isn't rendered.** Fully transparent faces (alpha 255) are now hidden, but partially transparent ones (glass, ghosts — alpha 1–254) still draw opaque. Fixing it means a 4-component colour attribute + `transparent` materials in ModelViewer, and accepting the sorting artifacts that come with double-sided transparency.

## General Editor

- **REMINDER: set up proper production hosting when the editor is nearly feature-complete** (user asked 2026-07-14 to be reminded "much later once we get almost everything finished"). The app is backend-less, so production = `npm run build` + Caddy `file_server` on `dist/` (no Node process at runtime, nothing to restart — unlike the dev server, whose week-old instance developed 20-second event-loop stalls). Content-hashed assets can take the same `immutable` caching the `/icons/*` Caddy route already has.
- **Detail viewers still missing** (raw-JSON fallback only): `cs2`.
- **Label known params in the params tables** — items' param 644 and the NPC combat params are labeled; do the same for as many other param keys as we can identify, sourcing meanings from cryogen/darkan param usages (`ItemDefinitions`-style getters, server lookups). The `ParamsTable` `rowAnnotation` hook is the extension point.
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
