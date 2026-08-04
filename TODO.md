# TODO

Open work only — completed passes live in git history and README.

## Spot Animations ("gfx")

- **Ground-contour blending isn't previewed** — needs real terrain height data the model previewer doesn't have; same deferral as `animations`.

## Animations

- **REMINDER (2026-07-19): Cody found an animations issue while testing in the live client** — parked while other editors get finished; ask him what it was when animations come back up. (He never described it — don't guess.)
- **Keyframe tweening is PORTED (2026-07-28)** — `applyAnimationFrame` takes an
  optional next frame + elapsed/duration and blends per the client's
  `MeshRasterizer.method11266`: slot-ordered union of both keyframes, identity
  defaults (0 / 128 for scale types), shortest-arc rotation in 14-bit space
  (hue in 6-bit), tween-block flags (f1&0x2 / f2&0x1 → snap), frame1's skip
  reference winning over frame2's, gated on the sequence's `tweened` flag
  (8211/17186 sequences set it). Wired into `LocAnimator.poseAt` (map viewer +
  cutscene loc idles) and the cutscene entity/object/gfx poser, which re-poses
  tweened holders every render frame with the sub-cycle fraction. CONFIRMED
  working in cutscenes (Cody, 2026-07-28). Still open: ModelViewer's sequence
  preview and SpotAnimationViewer don't use it (exact-frame stepping); the
  cutscene wrap tween targets frame 0 rather than the client's
  `frames.length - loopDelay` loop-back point (our playback loops the whole
  sequence).
- **Not ported in `skeletalAnimation.ts`:**
  - **The BAS equipment-matrix branch inside `animateTransform`** (the `verticesData.isNotEmpty()` case, a full 3×3 rotation-matrix composition) — always empty/null in the base playback path (confirmed via every real call site), needed only for equipment-piece-specific pose adjustments.
  - **Submesh gating** (`verticesSubmeshes`, restricting a transform to specific equipment pieces in a composite) — not built into `mergeModels()`'s output yet, so multi-part composites (identikit/equipment stacks) can't be animated with full correctness.
- **Type-5 reveal limitation in ModelViewer's in-place path**: it can hide faces (collapse to a degenerate triangle) but can't REVEAL faces that were alpha-hidden at rest (they're never built into the buffer). The chathead preview rebuilds geometry per frame and handles both directions.
- **Transform math not verified against the live client** — a careful line-by-line port of darkan source, but treat it as unverified until someone compares stepped poses against real client rendering on a rigged model.

## Identikits / Player Preview

- **Equipment has no thumbnail browser.** Look parts have one (Settings → Player Look → Browse); equipment ids are typed or stepped. `IdentikitPickerModal` is the precedent — an item version can filter by `wearPos` the same way the steppers do.
- **The player look isn't used outside the editor's own previews.** Cutscenes still render the player entity as a cone marker; wiring `buildLookModel` in is the point of storing a look at all.
- **The hat-hair style swap isn't applied.** A hat that hides hair currently just removes it; the client instead swaps in a hat-compatible hairstyle via enums 2339/2342 (style → slot), 2338/2341 (slot → struct) and struct params 790 (with hat) / 791 (with face mask). Everything else in the equipment recipe is ported — see `EDITOR.md`.
- **The remaining equipment positions aren't named.** The seven identikit slots are verified three ways now (table in `EDITOR.md`) and weapon (3) / shield (5) come from `defaults/equipment.json`; the rest of the 15-wide appearance table is still labelled by raw slot number rather than guessing.
- **Head compositing isn't previewed** (identikit `headModels`, item `maleHead1-2`/`femaleHead1-2`) — body meshes only. The client's recipe is `renderPlayerHead`: the hat's head mesh first, then each look part's `renderHead`.
- **The `defaults` recolour palettes are only editable as raw JSON.** `DefaultsViewer` renders the entity blob generically, so the 10 colour groups are nested arrays rather than swatch grids. See `EDITOR.md`.
- **Not tested in a real browser session** (File System Access API limitation; typecheck/lint/build pass, Java round-trip verified independently).

## Sound / Music

### PARKED: SFZ instrument export — module built, UI pulled (2026-07-31)

`src/loaders/sfzExport.ts` exists and is verified, but **no UI reaches it**. The
export buttons were added to `MusicViewer` (this song / all banks) and
`SoundEffectViewer` (one .wav / whole index) and then removed the same day:
Cody wants input from someone who actually composes before committing to a
shape. The open question is product, not correctness — what a useful export
looks like in practice.

What is already verified in Node against the real dump, so it doesn't need
redoing: all 247 banks generate 23,153 regions with zero out-of-range opcode
values; `songBankUsage` matches an independent MIDI parser on all 1,662 songs;
sound-effect rendering produces valid WAV headers and projects to 529 MB, which
matches the dumped files.

What was never done, and still isn't: **the File System Access half has never
run** (directory picker, `samples/` creation, writing thousands of files), and
no generated `.sfz` has been loaded into sforzando. That last one is the real
acceptance test — check the envelope fit by ear against the in-app player.

Sizing, for whenever this comes back: song-scoped export is 0.28 MB median /
1.73 MB worst; all banks is ~53 MB; the whole sound-effect index is ~529 MB and
~161 s of pure synthesis, so it likely needs chunking or a cancel button (an
`AbortSignal` is plumbed through but nothing drives it).

### OPEN QUESTION: 14,131 of 16,825 midi_instruments have no reference in the cache

Measured 2026-08-01, and the reason it matters is that it is 84% of the index.

Three ways in are known, all indexed by the viewer's "Used by" panel:

- **instrument banks** — 1,187, through `sound_effects_midi`
- **object/NPC ambient sounds** — another 1,427. The sound id is looked up in
  `midi_instruments` instead of `sound_effects` when the def sets the instrument
  flag (object opcodes 168/169, NPC opcode 162; `SoundEffectPlayer:233/268`)
- **cutscene PLAY_VORBIS** — another 81, none of which any bank reaches.
  `AreaSound` type 2 is `spoken()`, which reads index 14 (`AreaSoundPlayer:67`)

Total reachable from cache data: 2,694. Each of the last two was found only
after the count looked implausible and someone pushed back on it, which is the
reason this entry stays open rather than being written off.

That leaves 14,211 with no cache-side referrer at all, which is too many to
wave away as leftovers. Before concluding they are dead, check the referrers
that would not show up in a def scan:

- **Server-driven sound ids.** `AreaSoundPlayer:67` plays `sound.soundId`
  through this index for "spoken" area sounds, and the id comes over the wire.
  darkan-world-server is the place to grep.
- **CS2 scripts** that trigger sounds by id.
- **Whether the id space is what we think.** `SoundBankCache.listMusic` treats
  its argument as an archive id or a file id depending on the index layout
  (`getArchiveCount() == 1`). cryogen dumps a flat 1..16824. All 1,187 bank
  references resolve to files that exist, and referenced ids cluster rather
  than spreading evenly (34.7% of the first decile, 0% of the 70-80% band),
  which argues the mapping is right — but it has not been proven.

Until that is settled the viewer says only what it has checked; it does not
claim the rest are unreachable.

- **`sound_effects_midi` editor not tested in a real browser session** — typecheck/lint/build pass;
  the dumper/decoder is verified byte-identical independently. Marked done 2026-08-01 on review of
  the UI, but nobody has driven the keymap editor against a real cache yet.

### `midi_instruments` viewer wants export buttons too, eventually

Same parking as above, plus Cody wants to rework that viewer anyway — so this
should land as part of that pass. It needs a "download this instrument" (the
`.ogg` is already on disk, so close to free) and possibly a whole-index export.
Note the index is 16,824 instruments but only **1,187 are referenced by any
bank**, so "all instruments" means something different there than on the music
page, where "all" means all 247 banks. Worth deciding whether the unreferenced
~15,600 are useful to export at all, given no MIDI message can address them.


## Maps

### Locs are merged into one mesh per plane — the client keeps them separate

`buildLocsMesh` batches every loc on a plane into a single geometry. That makes
the scene cheap to draw, but the client doesn't work that way: each placement is
its own scene-graph node (`GraphNode_Sub1_Sub4_Sub1`), which is why it can add,
remove, animate, recolour or morph ONE loc at any moment without touching
anything else.

The divergence has already cost us twice. `REPLACE_OBJECT` in a cutscene
destroys the region loc holding that tile before adding its own
(`LocAction.destroyObject`), and because a merged mesh can't give one loc back,
`assembleCutsceneScene` has to identify replaced locs up front and build each as
its own group so the player can hide it on the right cycle. Live edits in the
map viewer have the same shape of problem — changing one placement rebuilds the
whole plane.

A third cost surfaced 2026-08-02: the client culls each loc by its FOOTPRINT,
not its geometry — `SceneObjectManager.method3447` frustum-tests every tile
corner as a vertical column reaching only `1000 << 2` = 4000 units above the
ground (and 4512 below plane 0), and `GraphNode_Sub1_Sub1.method13029` skips a
loc whose footprint tiles all fail. A loc TALLER than that column vanishes
wholesale the moment its base leaves the frustum even while its upper half
fills the screen — and Jagex leans on the quirk: cutscene 14 parks the camera
INSIDE the QBD lair's 15-tile pillar (loc 71802) and the footprint cull is
what blanks it. A merged mesh can never reproduce per-loc culling, so the
cutscene player now splits locs taller than the column out of the merge
(`buildLocsMesh` `tallLocUnits` → `tall`) and runs the client's outcode test
on their baked corner columns each frame (`TALL_LOC_UNITS` in
CutscenePlayer). That is an approximation by height threshold, not the
client's rule: the client applies the footprint test to EVERY loc, every
frame, one mesh per loc.

Worth trying: one mesh per loc (or per material batch keyed by loc) with the
placement on the node rather than baked into vertices, and measure. If the draw
call count is too high on a dense region, a middle ground is batching only
static locs and keeping anything a cutscene or an edit can touch separate —
plus the client's footprint-column visibility for whatever is per-loc (the
tall-loc path above already implements the test; generalizing it is the easy
half, the mesh split staying fast is the hard half). Until then, every feature
that needs to address a single loc pays for the merge.

### TEST: the region environment tab (2026-07-28)

The 3D view's **Env** tab edits the environment record — the tail of the
region's terrain archive (`maps/environments/<id>.json`): sun, fog, cube
texture, bloom, skybox. Typecheck, lint and build pass; untested against a real
cache. Needs cryogen's matching path change (`MapDefinitions.environmentFile`
now resolves `maps/environments`) to be in place first, or a re-dump writes to
the old folder and the tab finds nothing.

- **Baked vs live.** Sun direction (the compass dial) and ambient should rebuild
  the region ONCE, on release — not per drag step. Fog colour/depth, bloom, sun
  colour and the skybox should apply with no rebuild at all.
- **Flag bits, not zeroes.** Unticking a field's checkbox must remove it from
  the record (the flags byte is what defines the layout), and ticking it back on
  starts at the client default rather than 0.
- **Nothing lost on save.** After Save, the region's `environments/<id>.json`
  still carries its `lightingGrid` and `opcodeOrder` — the opcode order alone is
  what keeps ~560 regions repacking to identical bytes.
- **Draft flow.** Undo/redo steps through env edits alongside placements, and
  Discard restores the file values in both the panel and the scene.

### TEST: the object/marker editing pass (2026-07-25/26)

Typecheck, lint and `npm run build` pass. **The def save path is verified
(2026-07-26):** Cody edited an object's ambient sound id, confirmed the change on
disk, repacked, and confirmed it in-game in both directions — removing the sound
from one object and applying it to another. The rest is still untested against a
real cache, in rough risk order:

- **Discard / undo / region-change with def edits pending.** `objectDefs` joined
  the Snapshot, `applyEdit`, undo/redo and the Discard button. Check: Apply a def
  edit → Discard restores the file values in the panel *and* the scene; Ctrl+Z
  steps through def edits alongside placement edits; navigating to another
  region while a def edit is pending prompts, and discards on confirm.
- **Drag-to-move after the tab split.** All three gates moved from `view` to
  `edit`. Verify: drag moves a selected loc on the Edit tab; nothing moves on
  View/Place/Terrain; Shift+drag marquee still selects (Edit) and still copies an
  area (Terrain); a click on View selects and jumps to Edit, and a drag *from*
  there works on the second gesture. The pointer invariants above are the things
  a regression here would break silently.
- **Collapsed → expanded object list.** `LocList` unmounts its scroll element
  when collapsed, so the virtualizer loses its scroll element; there's a
  `virtualizer.measure()` on expand as insurance but it is a guess. Collapse,
  expand, and check rows render without needing a scroll nudge.
- **The areas scan, cold.** The map-icon browser reads 73913 JSONs on first open.
  Time it, watch the two progress phases actually advance, and confirm the second
  open is instant (the `WeakMap` cache). If it's unusably slow, the fallback is
  an id-keyed index built once and cached to disk.
- **Marker fixes.** Musician-style anchors read as map icons (violet) not sound
  emitters; markers keep their colour after a build (the sun-tint fix); Close
  clears the outline as well as the panel; blank records badge as "no sprite" /
  "no icon" rather than showing nothing.
- **Marker list vs the scene.** Rows match the selection by world tile, so check
  a region with several placements of the same utility object: clicking each row
  should highlight a *different* diamond, not the same one.
- **The pickers write back to the right field.** Two cursor rows share one
  browser, keyed by a `field` on the picking state — confirm Browse on Secondary
  doesn't overwrite Primary, and that "none (-1)" clears rather than setting 0.
- **Live def preview.** Editing a marker's sound/icon/sprite id should recolour
  its diamond as you type (no Apply), and Close/Discard should put the original
  colour back.
- **Symbol thumbnails + list sorting (2026-07-26).** The object and marker lists
  now show a row thumbnail for the object's map icon (areas
  `defaultIconArchive`) and map sprite (map_sprites `spriteId`), and both lists
  take a sort dropdown — including "Map icon first" / "Map sprite first", which
  is how you find which object carries a symbol. Check: thumbnails resolve (a
  category whose area has no icon shows a ◆ placeholder, not a blank); sorting
  doesn't break selection (rows keep their original index, so a scene click
  should still highlight and scroll to the right row under any sort); the
  virtualized object list scrolls correctly after a sort change.

- **EDITOR SURFACES and editor gaps — see `EDITOR.md`.** Cody's rule: *"this is an editor, we need to be able to edit absolutely everything"* — read-only is a bug. `EDITOR.md` holds two things: the cache-field knowledge our render traces produced (ground blending, loc models/textures, per-texture material fields, region environments, point lights, face-level data), so building the UI doesn't mean re-deriving the trace; and the running list of map-editor gaps requested 2026-07-25 — loc panel detail + live preview + dirty/unsaved warnings + `transformTo` preview, editable sound emitters and a sound-emitter table, a map icon/sprite table showing which objects display each, sliders on light fields, and terrain material/colour painting. **Add an entry there whenever a render change teaches us how a cache field behaves, or a panel shows something it can't edit.**
- **REVISIT: what the 'barrier' marker actually means (Cody, 2026-07-25).** The red marker kind is *our* inference, not a client concept: `isMarkerModel` treats any 1–4 face model painted entirely in HSL16 **29113** (teal) or **20287** (green) as an invisible marker loc, and a green one with no sound/`mapCategoryId`/`mapSpriteId` on its def falls through to `'barrier'`. Introduced with the original 3D scene viewer (7571ff5). Worth checking against the client/darkan: is green really a collision-only blocker (bridge edges, ledge guards), and should the kind require `blocks`/`clipType` from the object def rather than resting on the sentinel colour alone? Also confirm the two sentinel colours are the complete set. **Context (2026-07-25): the long-open question of how the client HIDES these is answered — it's plain back-face culling.** Marker quads are single-sided and face downwards (all 6 green faces in model 68757, both faces of teal marker 1105), and the client culls back faces unconditionally: `DirectXRenderer` sets `D3DRS_CULLMODE = D3DCULL_CW` once at init, `OpenGLRenderer` does `glEnable(GL_CULL_FACE); glCullFace(GL_BACK)`, and neither is toggled anywhere. There is no `20287`/`29113`/`33728` constant in the client at all — the colours are an authoring convention, not something the engine reads. So `isMarkerModel` is now purely an EDITOR affordance (it puts a diamond where a marker is); the client-correct hiding comes for free from culling. That also means a sentinel-coloured face mixed into a real model — the Lumbridge signpost sign, loc 69787 model 68757, 6 green faces among 942 — needs no special case.
- **ALL LIGHTING WORK LIVES IN `docs/lighting.md`** (moved there 2026-07-26). The sun formula and its reverted port, tone mapping and why the bake clamp starves it, the lighting-detail trace, loc and ground point lights, the agreed plan to move point lights into the shader, per-object `ambient`/`contrast`, ModelViewer's contrast base, HDR materials and texture gamma. They are one interlocking job — two attempts have been reverted for taking an item on its own — so they are not tracked as separate entries here.
- **Pre-13 mesh upscale before posing — check the other animation previews (2026-07-25).** Fixed for map-scene locs: a frame's type-0/1 origins and translations are authored in the `<<2` upscaled space (the client runs `RSMesh.upscale()` at mesh build, BEFORE `Animation.rasterize`), so posing a raw pre-13 mesh and scaling the result afterwards makes every translation 4× too far — rotations/scales are ratios and survive, which is why it looked *nearly* right. `upscaleModel()` in models.ts now bakes it in for animated locs. `SpotAnimationViewer` is fixed too (2026-07-30) — it now loads its preview mesh through `loadModelComposite`, which upscales pre-13 parts in place. Any *new* `useSequencePlayback` caller that loads a model by hand rather than through `loadModelComposite` needs `upscaleModel(model)` at the pose call, but check its camera/fit first — geometry becomes 4× larger, which matters if the view doesn't auto-fit. **Not `CutscenePlayerModal`** (checked 2026-07-28): its entities come from `loadModelComposite`, which already upscales pre-13 parts in place and marks them v13 so no renderer double-applies it — adding `upscaleModel` there would make every entity 4× too big.
- **"Remove roofs" is a per-TILE rule, not a per-plane one — don't let it eat the bridge railings.** We don't implement the client's setting at all today; `MapSceneViewer`'s feature table says as much ("We use per-plane toggles instead of the client's roof-removal rule"). Whenever it does get built, the naive version — hide everything on plane >= N — is wrong, and the Lumbridge bridge is the case that proves it: its **railings are locs on plane 1** (45143/45146/45147/45148 on tile rows y=24 and y=27), so a per-plane cull deletes them while leaving the deck, which sits on rows y=25/26 and gets shifted down to renderPlane 0 by the bridge flag. The bridge would render as a floating walkway with no sides. How the client actually does it:
  - `Preferences.removeRoofs` / `removeRoofsOptionOverride` are tri-state: 0 never, 1 the contextual mode ("when you walk under one"), 2 always. `MapRegion.handleRoofDisplay()` only runs its sweep when the override is 2.
  - The test is a **per-tile mask**, `tileFunctionMasks[plane][x][y] & 0x4`, checked at the camera/player tile; `calculateVisibilityAdjustments` then flood-fills outward over the enclosed area and writes a per-tile `settingsBits` byte the renderer consults tile by tile. Nothing anywhere hides a whole plane.
  - Don't confuse it with `SettingsBits.areRoofsHidden(x, y)`, which despite the name reads `tileFunctionMasks[1][x][y] & 0x2` — that's the **bridge** bit, used to bump entities up a plane. The bridge deck rows carry exactly that bit; the railing rows carry `0x1|0x8` and neither the bridge bit nor `0x4`.
  So: port the `0x4` mask + flood fill, keep the per-plane toggles as a separate editor-only affordance, and check the bridge railings survive with roofs removed.
- **Clone button on locs.** The 3D map's loc panel can edit and delete a placement but not duplicate one — add a Clone that copies the selected loc (id/shape/rotation/plane) onto a new tile, so repeated scenery doesn't have to be re-placed by hand. (Background in `EDITOR.md`.)
- **REVISIT: minimap fidelity is still not signed off (2026-07-19).** Cody isn't happy with the results yet and expects this may need a redo. Three approaches tried so far: (1) client-faithful HSL pipeline (corner-blended palette + Gouraud lights + blurred shadows), (2) that plus overlay corner blending/splatting, (3) the cryogen-website MapImageDumper port (current state). When picking this back up: compare against the live client side-by-side at the same regions before iterating, and consider that the true HD minimap is literally the textured 3D ground rendered top-down (GroundGL.renderMinimapFloor) — rendering our own terrain meshes orthographically into the minimap canvas may be the correct endgame rather than any per-tile approximation. Once resolved, ALSO add the deferred map_sprites minimap preview (see Map Sprites).
- **DECIDE: height-stroke semantics.** A held drag currently applies one uniform step across the stroke (heights derive from pre-stroke values, so overlaps don't compound); the alternative is continuous accumulation while the brush lingers ("terrain flows up under a held brush"). Ask Cody after he's felt the current behaviour in real use.
- **REMINDER: verify object-placed map icons.** Config `areas` (MECType) was signed off with only *static-element* placements visible in the editor. The other — much more common — placement mechanism is objects: an object def's `mapCategoryId` puts that area's icon at every placed instance, and those placements live in the maps index, now dumped — check those icons resolve correctly and consider extending the Placed At list to include object-based placements.
- **Verify the full write pipeline in-game**: encode/decode symmetry is proven, but an actual save → repack → client boot hasn't been exercised, and location repacks depend on the `Index.putFile` XTEA re-encryption fix made alongside that work.
- **Maps repack now RE-ENCRYPTS locations (policy reversed 2026-07-26).** The packer used to write every `l` archive unencrypted; it now writes it back with the region's own XTEA key, matching how Jagex ships them. The old policy broke the server: `Archive.decompress` XTEAs whenever keys are non-null, so decrypting an already-plaintext archive scrambled it — `Not in GZIP format`, then `Missing xteas for region X` (the key exists, the read just failed). Verified against the packed cache at the time: 7260/7268 maps archives were plaintext. The split is consistent end to end because `MapArchiveKeys.getMapKeys` returns null for an absent *or all-zero* key, `Archive.compress` skips encryption on null keys, and the client treats all-zero keys as "not encrypted" (`js5/Index.method5638:394`) — so encrypted always pairs with a real key, plaintext always with zeros. Changed in cryogen: `MapDefinitions.buildAddEdit` (passes keys), `MapDefinitions.dumpRegion` + `Region.getLocationData` (keyed read first, plain retry only to recover old plaintext archives). **A full maps repack is required** — delete `unpacked/maps/.manifest` — or the ~2400 archives written under the old policy stay plaintext-with-a-key and keep failing. The plain retries can be deleted once that's done.
- **EYEBALL LATER (per Cody, 2026-07-23): the env-mapped water colour is not signed off.** The underwater-map water is done and working (riverbed depth → transparent shore fade + procedural-sky reflection, mirrors client `EnvMappedWater`); Cody wants to eyeball the deep-water colour/saturation against his client before it's final. Knobs live in `MapSceneViewer.tsx` water uniforms: `uDeepTint` (deep body colour), `uSkyZenith`/`uSkyHorizon` (reflected sky gradient), `uSpecExp`/spec `*0.5` scale, wave amplitude. Tell me "darker / more teal / less sparkle" etc.
- **cryogen `um` dump is uncommitted**: the underwater-map dumping (`MapDefinitions.decodeUnderwaterTerrain` + the `um` read in `dumpRegion`) lives only in the cryogen working tree, which has a large pre-existing uncommitted state. `UnderwaterTestDump.java` there is a scratch harness (region-range arg or `all`).
- Water: still no per-material water effects beyond the env-mapped surface; alphaTest is a fixed 0.35 cutout on textured terrain.
- Ground-contouring (`groundContourType`) samples the ground under each vertex's *placed* (rotated/mirrored/scaled) position, as the client does, and now runs for pre-13 meshes too (`getModel` bakes the `<<2` in at decode, where `ObjectDefinition` does). One gap left: the client contours AFTER `resize`, we do it before, so a loc with `scaleY != 128` would scale its ground term too (nothing in the dump is both scaled and contoured).
- **TOUCH-UP LATER: terrain blending is ported but approximate (2026-07-25).** All three client mechanisms are in (`docs/terrain-blending.md` has the full trace — read it before touching this). Cody's verdict on the shape-10 arc at tile 3225,3223 was "looking okay", not signed off. Known gaps, roughly in order of likely visual impact:
  - **The `hasOverlay` stand-in for the client's discard test. Verified to be a no-op on this cache — robustness only, not a visual fix.** The client discards an overlay with `primaryRGB == -1 && secondaryRGB == -1` before it ever sets `aBool3810` (`Class329.method5846:633`); we test `hasOverlay` instead, which differs in that it counts a texture and ignores the secondary colour. Surveyed all 247 dumped overlays: only 2 blending overlays lack a tile colour (184, 51), and both also lack a secondary colour and a texture — so both paths agree and no tile renders differently. Worth making exact if the decoders ever get a general audit, or if hand-edited overlay data starts producing odd blends; not worth a commit on its own. (`secondaryRgb` is dumped and editable — it was the misnamed `minimapColorRgb`, see `EDITOR.md`.)
  - **The legacy `hasOverride` 4-way midpoint split still runs on non-blending tiles**, alongside the real `anIntArray3832` edge split. The client does no such thing — it's a leftover approximation from before mechanism 2 was ported. Blending tiles are already exempt (their synthetic midpoints have no shape-vertex id).
  - **A face's opaque base pass is the tile's own texture**; the client picks the corner material with the lowest `Node.pointer`, which is the packed `tileMap` key `intensity<<48 | scale<<42 | colour<<28 | textureScale<<14 | textureId`.
  - **Two vertex colour channels are collapsed into one.** The client carries a main colour (`3838`/`primaryRGB`) and a material colour (`3839`, `VarNPCMap.method2617`) per vertex and writes the *material* one to the shared stream. We have the value but not the distinction; whether it's visible is unverified.
  - **`computeOverlayPerimeter` reads a single region**, so a blend that should cross a mosaic seam stops at it. Wiring a mosaic version is mechanical.
  - **`anIntArray3843`** — the sixth perimeter array, a direction bitmask (256/512/64/128 from diagonals, 32/16 from edges). Not ported, purpose still unconfirmed.
- **`effectId: 1` materials render matte.** That's the client's specular / env-mapped shader mode: `MeshRasterizer_Sub3` switches on `TextureDetails.effectId` and calls `method948` (shader family `[n + 7]`) instead of `method965` (`[n + 2]`), and `1_12.vert`'s `ShaderMode == 1` branch builds a reflected view vector + specular colour. Their texture's **alpha is a gloss mask, not opacity** (textures 90/91/109/266 sit at alpha 38-70 across the whole image — grey stone trim, barrel rings, sinks, cooking ranges). We now draw them correctly opaque but flat; porting the specular term would need the reflected-view-vector path and the cube/env texture.
- **REVISIT: find a better way to handle transforming ("multiloc") objects.** The current handling is a stopgap and should be redesigned rather than patched. What we do today (`mapScene.ts`, the `transformTo` branch in the loc loop): if a def has *no models of its own* but has `transformTo`, render the **first** non-`-1` target; otherwise render the def's own models. Known problems with that:
  - **The fallback doesn't match the client.** `ObjectDefinition.getMultiLoc` swaps the def for `transformTo[varbit]` and falls back to the **LAST** entry when the var is out of range — often `-1`, i.e. invisible. We take the first real entry instead, on the reasoning that a fresh world has every varbit at 0. Decide deliberately which of the two the editor should show, and say so in the code rather than leaving it implicit.
  - **Defs with both own models and `transformTo` never transform.** They always render their own models, which is only faithful at varbit 0.
  - **`varp` vs `varpBit` isn't consulted at all**, nor is the `transforms` flag — we key off "has no models" as a proxy for "is a multiloc", which is a guess, not the client's test.
  - **No editor surface.** There's no way to see or choose the state: wanted is a per-loc "morph state" picker showing `varp`/`varpBit` and the target list, so you can preview any state (e.g. 69836 → varbit 10907 → [69860, 69861, -1]). A global "assume all vars = N" default would go with it.
  - Trace `getMultiLoc` and its callers end-to-end before rebuilding this — the current code was written from the symptom (locs rendering as nothing at all), not from the client path.
- **Loc idle animations now play** (waving flags etc.): locs whose ObjectType `animations[]` is non-empty are kept out of the merged static mesh (`buildAnimatedLocMesh` in mapScene.ts + `LocAnimator` in locAnimator.ts) and posed via `applyAnimationFrame`. Verified working (8× amplification test showed clear flag deformation; the Lumbridge mosaic has ~326 animated locs). **Perf-hardened**: posing is culled to on-screen + visible-plane locs (frustum test in the RAF loop), so only ~8–27 of 326 solve per frame instead of all 326; vertex/face skin groups are cached per model in skeletalAnimation.ts; animated meshes keep three.js frustum culling (padded bounds) so off-screen ones don't draw. (The original whole-machine slowdown turned out to be Opera running WebGL in **software** — hardware acceleration was off. Culling stays as a safety margin; the 24fps pose throttle was removed once accel was re-enabled.) Animated locs are click-pickable and list-selectable like any other loc: each animated mesh carries a single-entry `userData.locs` with an all-zero `triangleOwners`, plus `userData.locRegion` (its placement is baked into `mesh.matrix`, so `mesh.position` can't identify the region). Their highlight shares the source geometry so it follows the pose instead of freezing, and skips the edge outline (EdgesGeometry can't track a deforming mesh). Currently animated locs render **position-only** (opaque, no per-face alpha/colour) — see the material-blend-mode item below. Remaining follow-up: castle flags sit on **planes 1/3 hidden by default** — enable those planes to see them.
- **Transparency now mirrors the client's DirectX path** (traced in `MeshRasterizer_Sub3` + `SceneObjectManager.method3441`, NOT the software renderers). A face is transparent iff `faceAlpha != 0 || blendType != 0`, where **`blendType` == our texture-def `effectCombiner`** (same decode slot). Ordering, not depth tricks, is what makes it correct: the client draws **opaque objects → ground → transparent objects**, sorts objects far→near by the view depth of their **centre** (`method3421` projects `y + minY/2`), and bakes each model's face order once at build (`facePriorities` → transparent-flag → texture). It keeps **z-write ON**, has **no alpha test** (`ALPHAREF=0`, never changed) and **no `discard`** in any of the 18 dumped fragment shaders. Ported: `renderOrder` reproduces the pass order, per-loc meshes for transparent locs over `TRANSPARENT_OWN_MESH_FACES` (100) faces so three.js frustum-culls and depth-sorts them like the client's objects, smaller clutter shares one mesh, and `renderer.setTransparentSort` uses the centre-depth key. Remaining: the type-5/7 face alpha/colour animation (attempted 2026-07-24, reverted). **CORRECTION 2026-07-26 — the "additive/modulate blend modes" that used to be listed here are NOT a mesh gap.** That note cited `DirectXRenderer.method13894` / `Class73.anInt729`, but `Class73` is four singletons (725 additive, 727 alpha, 728 opaque, 726 modulate) chosen by `HardwareRenderer.method13904(i_1)` on values **1 / 2 / 128** — not a texture-def field — and every caller is in `FontRenderer_Sub4` and `NativeSprite_Sub3`. It is the **2D sprite/font blitter** (interface sprites, hitsplats, text), nothing to do with model faces. Don't port it expecting scenery to change. Checked while investigating willows: `combineMode` is also a dead end, 0 on 2588 of 2591 texture defs.
- **Candle/fireplace-specific bugs to investigate separately**: candelabra render with **no flame** and appear to be **missing a geometry piece between the backboard and the candlesticks** (likely a dropped face/part, not a blend issue). Fireplace flame was thin under the reverted alpha attempt — expected to be the additive/depth issue above.
- Terrain brush: strokes on the outermost ~2 tile rows open a visible seam against the neighbouring region's un-rebuilt edge mesh — fix means rebuilding adjacent neighbour terrain strips (or vertical skirts between regions).
- Editor affordances still missing: in-scene highlight on marquee-selected objects, paste-footprint preview rectangle, cache-global name search (currently region-scoped), editing beyond the centre region. Also note: area-stamp paste APPENDS objects — existing objects in the target area are not cleared.
- Tile-field editing from the 3D view (the 2D view has it).
- Object name resolution in the hover tooltip — needs batched/cached `objects/<id>.json` reads (up to ~2000 per region) before it's practical.
- Overlay/underlay brush swatches show the config's FLAT colour, but textured overlays render their texture in-scene — texture thumbnails in the picker would need texture PNG loads per overlay.
- The outer edge of the 3×3 neighbourhood mosaic clamps — only matters if the camera leaves the neighbourhood.
- Skybox editor: surface a "used by N regions" list per skybox id (the data is all in `maps/environments/*.json`).
- **World map ideas** (see `docs/worldmap.md`): a world map view rendered from MAP_AREAS data; a "rebake worldmap from current maps" pipeline so editor edits show on the world map.

## Map Areas

- **Growing an archive's file table must drop its cached row (2026-07-26).** `Index.cachedFiles[archiveId]` is sized from the file table when `cacheArchiveFiles` allocates it, so adding file ids leaves it short and every later read past the old end throws out of `getFile`'s `cachedFiles[archiveId][fileId]` — seen as `ArrayIndexOutOfBoundsException: Index 52 out of bounds for length 46` when 7 new NPCs (15662-15668, archive 122, files 46-52) were added to an archive that held 46. Per-file `putFile` hid it by re-running `cacheArchiveFiles` at the top of each call; batching all the adds into one consolidation removed that incidental repair. Both `putFile` and `putFiles` now null the row after writing, independently of `resetCache` (which bulk packs deliberately pass false).
- **DO NOT full-repack areas until the packer batches writes (2026-07-26).** Fixing the archive-addressing bug below means all 73913 areas now go into ONE archive (config 36) instead of one archive each. `Index.putFile` consolidates on every call — it decompresses the whole archive, splices in the one changed file, and rewrites it — so a handful of edited areas is fine but a full repack is ~73913 full-archive rewrites and will never finish. Editing a few areas at a time is safe. A batched path (group an index's `AddEditAction`s by archive, consolidate once) is the real fix and is not written yet.
- **Packing areas corrupted the config index (fixed 2026-07-26, cache had to be restored).** `AreaDefinitions.buildAddEdit` addressed its write as `(CONFIG, FileType.MAP_AREAS.archiveId(id), id)`. `MAP_AREAS` declares no `fileIdBitShift`, so `archiveId(id)` returns the id **unchanged** — every area was written to the config archive numbered after itself, landing on whatever config type sat at that number. Area 35 went into archive 35 = quests, so the client died in `QuestDefinitions.method4094` → `ByteBuf.readGJString` (which throws unless its lead byte is 0). Confirmed against the packed cache: idx2 went from ~75 archives to 73913, all populated. `putFile` consolidates rather than wipes, so each config type kept its other files and lost exactly the one whose file id equalled its archive id. `QuestDefinitions` had the identical bug and a comment showing the wrong side of the discrepancy had been deliberately kept. Both now use `(CONFIG, TYPE.getId(), id)`, matching what their reads always did, and `FileType.archiveId` carries a doc comment saying it's only for types that own an index and declare a shift.

- **World map preview** — render a visual of the area's rects (game-world rectangles → their map placement) so you can see what region of the world an area covers instead of reading raw coordinates. Could start as a simple 2D canvas plotting the rects to scale, and eventually underlay actual map tiles.
- **Revisit world-map icons (2026-07-25).** `map_areas/static_elements` pins were being drawn on the 3D view's minimap behind a "World-map icons" toggle; the toggle is now gone and they're simply not drawn, because the quest markers among them (icon sprite 1692 — every "Start of …"/"Route to …", all `displayedOnMinimap: false`) are 52×52 cyan crosses that bury the map. Lumbridge alone stacks ten around the castle. They still deserve a home, just not there — the natural one is the **world map preview** above, which is what they're actually indexed for. Note the set is mixed: of Lumbridge's 24 static elements, 14 *are* flagged `displayedOnMinimap: true` (bank/altar-style pins, several with `defaultIconArchive: -1` and so no icon at all), so whatever surfaces them should split the two rather than showing the lot. `MapSceneViewer.tsx`'s copy of the loader (`staticElements`/`staticBitmaps` — scanned `map_areas/static_elements`, filtered to the centre region, resolved each `areaId` to its icon) went with the draw; recover it from git history if it's useful. The `AreaViewer` page still loads the same data independently via `map_areas.ts`'s `staticElementsDir`, so nothing else regressed.

## Textures / Texture Definitions

- **No way to add/remove/reorder op nodes yet** — the editor edits existing nodes and rewires inputs, but can't grow the graph. Adding a node means appending to `textureOperations` *and* `operationIndices` together, and re-checking the three root indices.
- **Replace an *existing* texture's image.** "New from image" covers creating a texture from an upload, but swapping the image of an existing material is still missing: for sprite-backed materials it can write a new sprite and repoint the sampler op; for procedural ones it would mean replacing the whole graph with a single sprite sampler (destructive — should be an explicit, warned action).

## Item Icons

- **Generate item icons from our own cache instead of itemdb.biz.** The current set (`public/icons/`, fetched by `scripts/download-icons.mjs`) is scraped from itemdb.biz, which renders from the *latest* RS cache — a number of icons have changed since rev 727, so ours are subtly wrong. The proper fix is rendering them ourselves the way the client builds inventory icons: render the item's model (`inventoryModelId`) with the item's 2D params into a 32×32 canvas — the Three.js model pipeline in ModelViewer already does most of the heavy lifting. Check darkan's icon/sprite rendering code for the exact camera math before porting.

## Game Tips

- **Verify game tips repack in-game.** An actual save → CacheBuilder repack → client boot hasn't been exercised: confirm an edited tip (text/timing/rotation) shows correctly on the real loading screen, and that the stage-table regeneration (master rotation editing rewrites all 36 stages) doesn't upset the client's preference-cursor stage selection.

## Interfaces

### NEXT SESSION — nothing below has been looked at in the running app yet

Everything in the 2026-08-04 batch (component add/remove/clone, tree
drag-to-reparent and reorder, the tree context menu, the selection-overlay
perf fix, varc/varcstring variables) was built and type-checks, but **Cody has
not refreshed and used it**. Verify before building on it:

1. **Tree drag-and-drop.** Middle of a row = drop INSIDE (reparent, blue
   ring); top/bottom quarter = drop BESIDE (reorder, amber line). Reorder
   renumbers — check the amber "component ids changed" chip appears in the
   save bar and that saving prompts.
2. **Reorder correctness on real data.** It permutes the sibling group's
   existing id set. Worth confirming on an interface where a component's hook
   references a sibling by hash, that the hash followed.
3. **Clone with/without children** — the "without" case deliberately leaves
   the copy's hooks pointing at the ORIGINAL's children.
4. **Selection lag.** Clicking through 746's 459 components should now be
   instant; the outline moved to its own canvas. If editing a FIELD is still
   slow that's a different fix (the base repaint is genuinely needed then).
5. **The tree has no add/remove buttons any more** — they moved into the
   right-click menu, with a `right-click for add · clone · remove` hint under
   the tree. Say if the buttons should come back alongside.

Also unverified from the session before: the 11:18 tooltip should now show its
text (not `0`), size snugly to the wrapped text, and appear in ~0.5s rather
than 3s.

- **Interactive editing on the canvas** (drag/resize/reparent) — explicitly deferred by the user until the preview was right.
- **CS2 scripts are edited as raw tagged-arg lists, not decompiled.** In particular the hook-arg **sentinels render as raw numbers** — `-2147483645` is "this component's hash", `-2147483647/-46` are mouse x/y, and so on (full table in `EDITOR.md` → "Component CS2 hooks"). They should render as named tokens; shown as bare negative numbers they look like corrupt data and invite someone to overwrite them with a literal hash, which breaks the hook for every other interface sharing the script.
- **Drag / key / scroll-wheel / onResize hooks don't fire in the preview.** Load, varp-transmit, stat-transmit, timer, hover and click hooks do — see `interfaces.md` → "Hook passes" / "Hover passes". `onClickRepeat` and `onHold` need a HELD button, which a single click never reaches. onResize is the easy next one since the viewport already changes.
- **`clickMask` sprites are hovered by their bounding box, not their opaque pixels.** The client tests a masked sprite's per-row opaque span (`anIntArray1457`/`1455` in `client.java`), so transparent parts of a shaped icon are NOT hoverable; we use the plain rect. Shows up as hover triggering slightly outside a shaped icon.
- **`mouseLeaveScript` / `mouseLeaveArrayParams` are misnamed** — decode slot 7 is an INVENTORY transmit hook, not a mouse hook (traced in `client.java`; full evidence in `EDITOR.md`). cryogen, darkan-bot-refactor and the client's own deobfuscated source all share the wrong name, so this is not a cryogen-vs-darkan rename — it needs Cody's call plus a re-dump. `mouseLeaveArrayParams` is also the one transmit filter list still not surfaced in the editor.
- **Reordering renumbers, and the rewrite is interface-LOCAL** (accepted trade-off, warned on save). Sibling draw order is componentId order — `Interface.getDefinitionsFromComponents()` builds the client's draw list with a straight `System.arraycopy` of the id-indexed array, and the only reorder the client does (bring-to-front, from CS2) mutates that copy at runtime and never reaches the cache. Dragging beside a row permutes the sibling group's existing id SET, so no id outside the group moves, and `parent` hashes / hook args / targetParams inside the interface are rewritten. **Not rewritten:** hooks on other interfaces, hashes baked into CS2 scripts, server code. A cache-wide reference sweep would fix that and is the real solution if this bites.
- **A new component starts at 0×0 at the origin**, so it draws nothing until you give it a size — easy to read as "add is broken". Defaulting to something visible, or auto-selecting the size field, would help.
- **Model textures / item & entity model types** in the preview: RAW_MODEL renders vertex-coloured only; ITEM/NPC_HEAD/PLAYER_* need item-def/identikit composition (the pieces exist in `playerAppearance.ts`).
- **`<img=n>` mod-icon text tags are stripped** rather than drawn.
- **Two font renderers exist** — `fontRender.ts` (GameTips, single-line, `fonts/glyphs/` PNGs) and the fuller `interfacePreview.ts` implementation (sprite-frame glyphs); should consolidate on the latter.
- **~15 component fields remain unidentified obfuscated names** (`anObjectArray1413` etc. — CS2 script hooks whose purpose wasn't cross-referenced yet).

## NPCs

- **Verify the chathead emote list (`src/loaders/headAnimations.ts`) against the new gamevals dump.** The list was transcribed from darkanrs `world-server/.../dialogue/HeadE.java` (2026-07-20); cross-check the names/animation ids against the gamevals dump and reconcile any differences.

## Models

- **VERIFY the zero-scale mapping change (2026-07-28).** Faces whose texture
  mapping has a zero scale used to be dropped; they are now drawn with the
  poisoned coordinate pinned to a texture edge, because that is what the client
  does (full trace in `EDITOR.md`). This fixed the chapel windows — see-through
  before, solid black now, matching the game — but it touches **2,077 models /
  73,606 faces**, so it wants a wider eyeball. The known counter-case is the
  **Lumbridge fountain (model 24520, texture 54, one face)**: check its basin
  floor doesn't now carry a smear of the fish sheet.

- **VERIFY the scene particle runtime.** `sceneParticles.ts` runs the client's
  emitter sim per loc emitter face in both 3D scenes; fires, torches and
  waterfalls burn (object 61761 by the God Wars chapel is the test case). Worth
  checking: flames sit ON their loc rather than under/beside it (the placement
  matrix and the y/z negation), particle SIZE looks right at different camera
  distances (point size is a world diameter converted to pixels), the frame rate
  holds in a dense region, and hiding a plane hides its fires. Producers with no
  material fall back to a soft dot.
  - **Current budget (corrected 2026-07-29 — the old note here said "192 each,
    nearest 48, 40-tile cull", none of which is still true).** Per-emitter ring
    = `maximumParticleRate × maximumLifetime`, clamped to **[128, 4096]** — the
    chapel flames settle near 500, the smoke plume near 2,600, and the clamp is
    a memory guard, not a look control. **`MAX_ACTIVE = 64`** emitters simulate
    at once, ranked by distance to the **orbit target** (not the camera), with
    **no distance cut-off**; losers are frozen, not reset, so walking back finds
    a fire still burning. Per-system geometry sets `frustumCulled = false`.
  - **Suspect for any "particles vanish / wrong fire is live" report:** that
    ranking. `step(dt, camera, focus?)` falls back to `camera.position` when no
    focus is passed, and only `MapSceneViewer` passes one (`controls.target`,
    deliberately dropped in POV mode where the camera IS the viewpoint).
    **`CutscenePlayerModal` passes no focus at all** (`r.particles?.step(dt,
    r.camera)`), so cutscenes still rank from the camera — the exact eviction
    that made the map scene's chapel fire cut out when the camera orbited away,
    and a cutscene camera is routinely far from its subject.

## Cutscenes

### Editor — first cut landed 2026-08-01, UNTESTED

"Edit cutscene" on the cutscene page opens `CutsceneEditor`: the same simulated
scene, plus picking and an editable timeline. The loader gained save/create/
clone/delete, so the item list's Add, Clone and Remove buttons all work — Add
makes a blank cutscene (one 8×8 area per plane, the fade-in every shipped
cutscene opens with, and a FINISHED), Clone deep-copies the selected one. Both
arrive staged in memory with the Discard/Save banner, so an unwanted one costs
nothing.

Working model is "the clock is the cursor" — scrub, then click. Picking hits
entities, spawned objects and the ground; the ground pick reports a cutscene
tile and the plane whose mesh was hit. An entity stays "active" across a tile
click so walking is select-entity-then-click-tiles, and clicking more tiles at
the same cycle extends the same route rather than starting new ones.

Camera work is modelled as a SHOT — a DIRECT_CAMERA_MOVEMENT plus the two paths
it names — because a move reads the position array of each path (the aim path's
positions ARE the target; its target columns are the spline's control handles),
and nothing in the format records which two paths belong together except the
action. So capturing creates both at once and writes the action immediately.

Not done / worth a look when testing:
- **Keyframe timestamps are all 0.** Shipped paths have them too, and the sim
  ignores them (progress comes from the action's spline speeds), but if the real
  client uses them a captured shot will time differently.
- **No undo.** Discard reverts to the last save, and that's it.
- **Removing a ROUTE isn't repointed** the way cast and object removal now are
  (`repointActions` drops the actions that used the removed entry and shifts
  higher indices down) — there is no route-removal UI yet, so nothing can
  trigger it, but adding one needs the same treatment. Camera paths likewise.
- **No region picker** for map areas — the table takes raw region tile coords.
- Field editing has no validation beyond min/max; a nonsense value saves.
- `EXECUTE_SCRIPT` can be authored but does nothing (no cutscene script exists —
  see EDITOR.md).

- **OPEN BUG (2026-07-28, 3 failed fixes): Saradomin's eye billboards missing
  at his teleport-in and in the end wide shot of cutscene 1** (they DO show in
  the mid-scene close shots). VERIFIED NOT the cause: the data (host faces
  alpha-0 at rest and through every anim; groups 0/1 scale 121-162/128, never
  0; texture 744 exists, hdr ≈×2.45), and the billboard runtime itself — a
  headless simulation of the exact call sequence (addAnimated → setVisible
  → pose → placeEntity) yields a VISIBLE mesh with correct anchors (head
  height), sizes and cyan tint. FAILED fixes: (1) polygonOffset depth bias
  (kept as coplanarity protection, but it wasn't this), (2) FOG_TILES 40 → 64
  (the region's black fog with fogDepth 3000 started at 14.6 tiles, which
  LOOKED like the answer — camera-spline fade-in matched — but no change
  on retest; the raise stays as a legit draw-distance fix). NEXT: stop
  static analysis — instrument the live player (expose the billboard meshes'
  per-frame `visible`/anchor/uniform state on `window`, check the focus-plane
  gating band during the two failing shots, and check whether `onPosed` is
  actually firing at those moments) and read the states during the exact
  failing frames. Do not guess a fourth mechanism without live data.

- **OPEN BUG (2026-07-21): a class of loc objects around the God Wars chapel don't appear (bridge stonework, church ledges/base-plinth/"bottom outer" trim); walls/roof are fine.** VERIFIED via per-loc render logging in `buildLocsMesh`: the chapel's walls (loc 61734 plane 0, 61699 plane 1), roof (61704 plane 2) and crenellations (61708 plane 3) ALL render at the correct cascaded heights (−1536 / −3584 / −4608 / −5280) — the multi-storey structure is faithful, so the earlier "walls don't render / floating" framing was WRONG. Ruled out: shape→model skip (none), marker-face hiding (only 1 genuine marker region-wide), height corruption (a red herring — the debug dedup was showing a *neighbour* region that reuses the same loc ids; the centre terrain is correct, hv[1455]=48). The missing pieces are NOT the chapel walls. `groundContourType` was ported (`contourVertexY` in mapScene.ts — ct1/2/4/5, client `ModelSM.contourToGround`) since bridges (loc 54937 ct5) and paths (ct1) need it; it builds/lints and doesn't regress the chapel, but did NOT visibly fix the reported missing pieces (the chapel ledge pieces are ct0). NEXT: get the specific loc id of one missing piece (right-click/inspect in the maps editor, or in-game Examine) and trace why THAT loc doesn't render — do not keep guessing which loc it is. (The contour port is no longer unverified — the Lumbridge bridge arch was confirmed correct on 2026-07-25 and signed off, so it stays.)

- **Action roll: a fanned pile can cover a later action.** Marks sharing a lane
  and cycle are drawn 10px apart to the right of their true position, so a deep
  pile reaches into the space belonging to the next action. Measured on a 900px
  grid: **222 lane+cycle piles** across the 16 cutscenes are affected. Worst
  cases: cutscene 0 objects cycle 747 (four DESTROY_OBJECT, next action at 748,
  ~39px of overlap), cutscene 0 objects cycle 1516 (same shape), cutscene 9
  objects cycle 373 (five deep). Nearly all of them are the **Objects** lane,
  which carries every object in the scene where entities each get their own
  row — splitting Objects per object id would dissolve most of it at the cost
  of more rows. Note the current drawing never lies about ordering: a mark is
  only ever displaced to the RIGHT, so nothing appears earlier than it happens.

- **Editing + repack.** The viewer is read-only; the cryogen side already has a verified byte-identical `encode()` (16/16), so an editable pass needs: editing UI (the usual draft/save-bar pattern), `saveItem` in the loader, a CacheBuilder repack path that reads the JSON back into `CutsceneDefinitions` (Gson → encode), and `getActions()` on the definition.
- **PLAY_VORBIS resolves to midi_instruments, NOT index 36** (corrected 2026-08-01). "Vorbis" names the
  format, not an index: the client builds an `AreaSound` of type 2, and `AreaSound.spoken()` (type 2 or 3)
  routes it to `Resource.MIDI_INSTRUMENT` — index 14 — in `AreaSoundPlayer:67`, while type 1 goes to
  `Resource.SOUND_EFFECT`. All 81 distinct soundIds across the 116 actions exist in `midi_instruments`
  (only 54 exist in `sound_effects`), so the mapping is not ambiguous. These now preview in the viewer.
  The old note here claimed they were unplayable until index 36 was dumped; that was wrong.
- **Playback preview gaps** (the 3D player simulates terrain/locs, camera splines, entity walk routes + animations, object spawns and fades):
  - Area **rotations 1–3** aren't implemented in `cutsceneScene.ts` (no shipped cutscene uses them — copied unrotated with a warning). The client transforms to port live in darkan `MapLoader.decodeTilesServer` / `EnvironmentManager.localOffsetX/Y`.
  - **Not simulated**: positioned (tile) gfx, projectiles, hitmarks, hint arrows, tile messages, SET_VARIABLE/EXECUTE_SCRIPT hooks — **none of which any cutscene in this cache uses** (surveyed 2026-08-01: 1,296 actions across the 16 cutscenes use only 14 distinct types, and those aren't among them; `PLAY_SYNTH`, `PLAY_JINGLE` and `ROTATE_CUTSCENE_ENTITY` are unused too). There is nothing to build against, so leave them until content appears that needs them. (ENTITY_GFX is fully simulated as of 2026-07-28, including attachment-only gfx models whose visuals are billboards/particles — confirmed working. Sound landed 2026-08-01.)
  - **Approximations to verify against the live client**: the spline row[3] term (client lerps it into `cameraPitch` — not applied), and the client's halving of movement speed while an entity is still turning (`delayMovement`), which needs the gradual yaw we snap. Movement itself is CALIBRATED against `EntityUpdating` (2026-08-01): 16 fine units per cycle, `<<1` running, `>>1` half-walk, each axis advanced independently, and the catch-up speedups gated off in cutscenes. Facing too — the angle space is south 0 / west 4096 / north 8192 / east 12288, the per-step facing snaps to those eight by the SIGN of the delta, and an entity re-faces while moving when `bas.yawAcceleration != 0 || turnDirection != 0`, where turnDirection is the NPC def's `turnDirection << 3` (default 32, so nearly everyone turns). See EDITOR.md. **The old note here was wrong twice over** — it gated on the def's `contrast` (the lighting field) and called Saradomin's backwards glide in cutscene 0 intentional; it was that gate plus a 180°-out walk bearing.
  - **Gfx attachments snapshot the entity's placement at spawn** — a gfx on an entity that WALKS during it won't follow. (Entity MODEL billboards DO follow as of 2026-07-28: Saradomin's glowing eyes are two type-115 sprites on model 58935, wired through `addAnimated` with a by-reference placement matrix recomposed on every move/pose — TEST: eyes glow, track his head through anims and walks, and hide/show with him. Spawned-OBJECT model attachments and entity-model particle emitters remain unwired; no cutscene case seen yet. Billboard materials apply their HDR multiplier gated on bloom — the eyes are material 744, hdr ≈×2.45, which is what feeds the glow — and entity/object/gfx MESH textures apply theirs too (`ModelData.textureHdrMultipliers`, constant-fill hdr ops only, via `material.color` like the loc meshes). TEST: the eyes bloom; any hdr-textured mesh detail on the cast glows rather than rendering flat.)
  - **The environment is the FIRST area's source region** (sun, fog, skybox, bloom, and the point lights that travel in with each copied chunk). A cutscene assembled from regions with different environments takes the first one — which is what the client does too, since a scene has one environment — but it is worth knowing if a cutscene ever looks lit like somewhere else.
  - Fog uses a fixed draw distance (`FOG_TILES`, now 64 — a high draw-distance client) rather than the client's own setting. 40 put the fog START at 14.6 tiles in cutscene 1 (black fog, fogDepth 3000 = a 23-tile fade band) and swallowed Saradomin's eye sprites from mid-distance — if sprites or scenery ever fade too EARLY or too LATE versus the client again, this constant is the knob.

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

## CS2 Scripts

- **The format spec, emission patterns and the pipeline's state live in `docs/cs2.md` — read it
  first.** Decompiler and recompiler are cryogen's (`com.cryo.cs2`); the editor page is done and
  signed off (see README).
- **Three asm fallbacks are left (6,565/6,568 structured), and none of them is really open work** —
  see the end of `docs/cs2.md`. Script **568** can't be decompiled by anyone: it's a debug script
  whose call passes six ints where the callee wants five ints and a string, so its stacks don't
  balance. Scripts **4738/5268** put an early push in the middle of the next statement's
  expression, which the `stackN` form can't place; expressing it would need a comma-operator-ish
  syntax in a language meant to be hand-edited. Revisit only if that syntax earns its keep
  elsewhere. Tools: `CS2Tail` (scoreboard + per-script `tail.txt`), `CS2VerifyOne <id>` (diff),
  `CS2Trace <id>` (per-instruction stack), `CS2ArityProbe` (opcode signature bugs).

## General Editor

### Every entry needs a working Add / Remove / Clone

Audited 2026-08-01. The sidebar buttons are gated on the loader exposing
`createItem` / `deleteItem` / `cloneItem`, so an entry without them shows the
button greyed out with no explanation. 19 of 32 entry loaders are missing at
least one.

**All three (13):** animations, billboards, game_tips, items, map_areas, npcs,
objects, particles, quick_chat_menus, quick_chat_messages, spot_animations,
sprites, texture_definitions.

**Add + Remove but no Clone (4):** animation_frame_bases, cs2,
sound_effects_midi, varbits. These get Add/Remove free from
`makeJsonDefLoader`; only `cloneItem` is missing, so they are the cheap ones.

**None of the three (15):** animation_frame_sets, cutscenes, defaults, enums,
font_metrics, huffman, interfaces, maps, midi_instruments, models, music,
native_libraries, shaders, sound_effects, textures.

Not all fifteen should get all three — some are genuinely single-blob entries
(`huffman`, `native_libraries`, `defaults`) where Add means nothing, and a few
write formats we can't synthesise from scratch yet (`models`, `textures`,
`maps`). Decide per entry: implement it, or make the button explain why it is
disabled rather than looking broken. The second half matters as much as the
first — a greyed button with no tooltip reads as a bug.

- **Explain every field, viewer by viewer.** Cody's ask (2026-07-29): a lot of
  pages are just a label and a box, and names like "Supports Items" don't say
  what they do. `NumFieldDef`'s optional third element now carries the
  explanation — a **string** renders as a hover `title` on the cell (the cheap
  option, right for pages with dozens of fields), **JSX** renders as the "?"
  disclosure the ground editors use. `ObjectViewer` is done as the reference:
  the non-obvious fields were traced against darkan-bot-refactor's
  `ObjectType.kt` and its consumers, and the obvious ones just got a plain
  sentence. Still to do, roughly by how much they'd benefit: `npcs`, `items`,
  `spot_animations`, `animations`, `interfaces`, `texture_definitions`,
  `particles`, `billboards`, `cutscenes`, `sound_effects`, the BAS page, and the
  map scene's own loc/light panels. Trace anything whose meaning isn't obvious
  rather than inventing it; where cryogen's dumped name disagrees with the
  client, say so in the tooltip instead of repeating the wrong name.
- **RE-DUMP `objects` BEFORE the next pack** (renames applied in cryogen
  2026-07-29 — `blocks`→`blocksProjectiles`, `obstructsGround`→
  `forceDisplayDecoration`, `hasAnimation`→`forceNonStationary`). Order matters:
  Gson silently ignores JSON keys the class no longer has, and
  `ObjectDefinitions`' no-arg constructor supplies the defaults, so packing an
  OLD dump with the renamed class resets those three fields to
  `blocksProjectiles = true`, `forceDisplayDecoration = false`,
  `forceNonStationary = false`. Any object whose real value differed loses it —
  objects that let projectiles through would start blocking them. Re-dumping
  first makes the keys match and the risk disappears. The editor already reads
  either spelling (`migrateObjectDef`), so it is fine before or after.
- **REMINDER: set up proper production hosting when the editor is nearly feature-complete** (user asked 2026-07-14 to be reminded "much later once we get almost everything finished"). The app is backend-less, so production = `npm run build` + Caddy `file_server` on `dist/` (no Node process at runtime, nothing to restart — unlike the dev server, whose week-old instance developed 20-second event-loop stalls). Content-hashed assets can take the same `immutable` caching the `/icons/*` Caddy route already has.
- **Label known params in the params tables** — items' param 644 and the NPC combat params are labeled; do the same for as many other param keys as we can identify, sourcing meanings from cryogen/darkan param usages (`ItemDefinitions`-style getters, server lookups). The `ParamsTable` `rowAnnotation` hook is the extension point.
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
