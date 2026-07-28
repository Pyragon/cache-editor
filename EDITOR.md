# EDITOR.md — turning what the renderer knows into things you can edit

Two parts: **field knowledge** (what a render trace taught us about a cache
field, so a UI can be built from it later) and **editor gaps** (the running list
of what the editor can't do yet). Open work is still tracked in `TODO.md`; this
is the detail behind it.

## The rule

> "This is an editor, we need to be able to edit **absolutely everything**."
> — Cody, 2026-07-25

Read-only is a bug, not a limitation. If the viewer can show a value, the editor
should be able to change it, preview the change live, and warn before losing it.
When a new panel shows a field it can't edit, that's an entry in this file at
minimum.

## Why this file exists

The renderer runs well ahead of the editor. Every time we trace a piece of
client behaviour, we learn which **cache fields** drive it — and that knowledge
lives in a commit message, a `docs/` trace, or nobody's head. Months later,
building the UI for it means re-deriving all of it.

So: **when a change teaches us how a cache field affects rendering, write an
entry here.** Not the render fix — that belongs in the code and in `docs/`.
What belongs here is the answer to *"if someone wanted to edit this tomorrow,
what would they need to know?"*

This is a knowledge file, not a task list. Open work still goes in `TODO.md`;
entries here are the reference the TODO item would need. Related:
`docs/terrain-blending.md` and `docs/worldmap.md` hold the render-side traces.

## How to add an entry

One section per subject. Cover, in order:

1. **What the renderer does with it** — one or two sentences, plus a pointer to
   the trace doc or commit.
2. **Which cache fields drive it** — entry, field name *as dumped*, opcode, and
   the client's own name where the two disagree. This is the part that is
   expensive to re-derive.
3. **What is already editable** — name the viewer component. Half the value of
   this file is stopping someone from building a page that exists.
4. **What is not surfaced** — the actual gap.
5. **Gotchas for whoever builds it** — packed values, rebuild triggers,
   re-dump requirements, fields whose dumped name is misleading.

Keep entries honest about confidence. If a field's meaning is inferred rather
than traced, say so.

---

## Ground / terrain blending

**What the renderer does.** Ground materials melt into each other by three
independent client mechanisms — a cross-tile perimeter blend, a choice between
three tile-shape families, and an intra-tile blend that feathers an overlay
across the underlay half of its own tile. All three are ported. Full trace:
`docs/terrain-blending.md`. Do not touch `emitTile` without reading it.

**Cache fields that drive it.**

Overlays — `config/overlays`, loader `src/loaders/config/overlays.ts`, decoder
`OverlayDefinitions.method11364` in the client / `FloType.kt` in
darkan-bot-refactor:

| dumped name | opcode | client name | what it does here |
|---|---|---|---|
| `blendsWithUnderlay` | 12 | `aBool7061` | **the master switch.** Picks the tile-shape family AND enables the intra-tile blend |
| `slot` | 11 | `anInt7052` | priority; the winner of every cross-tile comparison |
| `colorRgb` | 1 | `primaryRGB` | the blended colour |
| `secondaryRgb` | 7 | `secondaryRGB` | three jobs — see below. Called `minimapColorRgb` before 2026-07-25 |
| `texture` | 2 / 3 | `texture` | blended alongside the colour, as a crossfade pass |
| `textureScale` | 9 | `anInt7057` | `readUnsignedShort() << 2`, default 512; blended too |

Underlays — `config/underlays`, `src/loaders/config/underlays.ts`: `rgb`,
`texture`, `scale`. These feed the corner-palette blur, not the overlay logic.

Per-tile map data — the `maps` entry: `overlayIds`, `underlayIds`, and
`overlayShapeRot`, a single packed byte (`shape << 2 | rotation`). Shape is
0-12ish, rotation 0-3.

**Already editable.** `OverlayViewer` and `UnderlayViewer` expose every field
above, and both save. Nothing new is needed at the *definition* level.

**Not surfaced.** The gap is entirely **per-tile**, in the 3D map editor:

- No tile inspector. Selecting a ground tile should show its overlay id,
  underlay id, shape and rotation — and, because it is genuinely hard to
  predict, **which of the three shape families the tile resolved to** and why
  (`blendsWithUnderlay` + whether any neighbour asked for an edge face).
- No way to paint an overlay shape or rotation onto a tile. This is the direct
  answer to "how could I have fixed that hard arc by hand" — the arc is shape
  10, and being able to try shape 9 or a different rotation on one tile is the
  most useful single thing this section could gain.
- The blend is rebuilt wholesale. A live preview while dragging a slot or
  toggling `blendsWithUnderlay` would need the terrain rebuild to be
  incremental; today it isn't.

**Gotchas.**

- **Opcode 7 does three jobs, and was named after one of them.** It was
  `minimapColorRgb` in cryogen and here until 2026-07-25; **renamed to
  `secondaryRgb`**, the game client's own name. Both cryogen and
  darkan-bot-refactor called it a minimap colour, which is why it took a
  rendering trace to notice — CLAUDE.md's hierarchy puts darkan-bot-refactor
  first for config decoders, but this field's *meaning* is a rendering
  question, and there the client wins. The three jobs:
  1. the minimap tile colour, overriding a texture's average
     (`Class291.method5164`) — the only one the old name covered;
  2. the ground **material colour** in the 3D scene — `VarNPCMap.method2617`
     prefers it over the tile colour;
  3. a **gate**: an overlay with `primaryRGB == -1 && secondaryRGB == -1` is
     discarded before `aBool7061` is ever read (`Class329:633`), so it decides
     whether a tile blends at all.

  Note it is *not* a fallback for the tile colour — `anInt3850` is `primaryRGB`
  alone, which is why `floTileHsl` still ignores it.

  **Old dumps:** the rename needs a cryogen re-dump. Until then
  `migrateOverlayDef` (in the loader) and `floSecondaryRgb` (in `mapScene`) read
  either spelling. The migration matters more than it looks: without it an old
  dump would show the field empty *and drop it on save*, silently discarding
  opcode 7.
- **`slot` is packed after decode.** `postDecode` does `slot = slot << 8 | id`,
  so the editable value is the raw byte from opcode 11, not what the comparison
  code sees. Our `floSlotKey` reproduces the packing.
- **`blendsWithUnderlay` is not a cosmetic toggle.** Flipping it changes which
  vertex tables the tile uses, so the tile gets a different triangle count —
  and it changes the *neighbours'* geometry too, because a blending shape makes
  adjacent tiles subdivide. Any editor that changes it must rebuild the
  neighbours, not just the tile.
- **Coverage is in unrotated shape space.** `OVERLAY_SHAPE_COVERS[shape][id]`
  is indexed before rotation; a UI showing "which corners does this overlay
  cover" must apply `(corner + 2·rotation) & 7` first.
- **Per-tile underlay/overlay bytes are definition id + 1.** The map opcode
  stream stores `underlayId` as `opcode − 81` and the dump keeps that raw
  byte, where 0 means "none" — so byte 164 is underlay *163* (Lumbridge
  grass), and the same +1 convention holds for the overlay byte. Everything
  that resolves a definition must subtract one (`configs.underlays.get(id −
  1)` throughout `mapScene.ts`; the 2D preview had an off-by-one until
  2026-07-27). The tile inspector edits the raw byte, so what users type is
  the +1 value; `createRegionDef`'s fill takes the raw byte too.

---

## Loc / object model and texture panel

**What the renderer does.** Resolves a loc to its models and each model's face
groups to textures, with per-material blend modes (see
`reference_directx_blend_modes` and `TODO.md`).

**Not surfaced.** The 3D map's loc panel can edit and delete a placement, but
shows nothing about the models underneath it. It should list the selected loc's
models and, per model, the textures each face group uses, with the ability to
swap them. Worked example: the Lumbridge fireplace's flame is texture 110, and
nothing in the UI says so.

Also missing: a **Clone** button — the panel can edit and delete a placement but
not duplicate one, so repeated scenery has to be re-placed by hand.

---

## Per-texture material fields

**What the renderer does.** These drive the DirectX material setup — blend
mode, specular/env-map mode, HDR multiplier, scroll speed.

**Not surfaced.** None of `blendType`/`effectCombiner` (0 opaque, 1 cutout,
2 alpha), `effectId`, `hdr` and the HDR op-graph multiplier
(`1 + hdrOp*31/4096`, up to 32×), or `textureSpeedU/V` is editable. All of them
visibly change rendering.

**`alpha` is a MISNOMER — it is the client's `TextureDetails.shadowFactor`
(TRACED 2026-07-26).** Verified by decode order in the client's texture-details
loader (`ImageIndexLoader`: …skipTriangles, brightness, **shadowFactor**,
effectId… — cryogen dumps that slot as `alpha`). It is the textured-face
grey-mix factor of `MeshRasterizer_Sub3.method14282`: 0..255 of the face colour
replaced with ambient-grey (`ambient·0x020202`, mid-grey 128 at ambient 64)
before lighting. Self-coloured textures (leaf sprites 951/956/952…) carry 255
(dumped `-1`) so the sprite's own colour stands; detail maps (bark 923) carry 0
and take the full face tint. Skipping it double-tinted every tree canopy
green-on-green — the "leaves look drastically different" bug. Ported as
`texturedBaseRgb` in `mapScene.ts`; the def's `brightness` byte is the same
method's post-mix `(256+b)/256` boost. **Cryogen's field should be renamed
`shadowFactor`** (with a re-dump) if the decoder ever gets its audit pass.
Similarly suspect: `detailsOnly` sits in the decode slot of the client's
`isGroundMesh` (== byte 0) — semantics happen to align for terrain detail
maps, but the name is the dumper's, not the client's.

---

## Region environment

**What the renderer does.** Reads `maps/environments/<id>.json` for sun
colour/ambient/light/backlight/position, fog colour and depth, skybox, and the
bloom parameters from opcode 2 (`bloomThreshold`, `bloomStrength`, `whitePoint`,
each a byte × 8/255, so 0..8).

**Not surfaced.** No editor and no repack path. See
`project_map_env_tail_packing` for the packing state.

---

## Region point lights

**What the renderer does.** Bakes the map-environment `lights[]` into loc vertex
colours. Each record carries position (x/z plus a height *above* the tile),
`size2d` (radius = `size2d*512 + 256`), a packed-HSV colour, plane and grow
flags, and a flicker `type` (a built-in preset 2..16, or 31 = a
`config/light_intensities` id).

**`ranges[]` is the field that decides what actually lights up**, and it is far
more load-bearing than it looks. `size2d` only sets the falloff (`radiusSq/d²`);
which *locs* receive the light is decided entirely by the per-tile grid the
record registers on, and that grid is `ranges[]`. It holds `size2d*2+1` shorts,
one per tile row of the bounding box, each `offset << 8 | length` over that
row's tile columns — so a `size2d` 1 light nominally covers 3×3 but the authored
data usually carves out much less. Region 12850's wall torches are all
`[2,2,0]` / `[0,2,2]` / `[258,258,0]` / `[0,258,258]`, i.e. a 2×2 quadrant of the
3×3 box, picked so the quadrant faces the room. Raising `size2d` alone does NOT
widen the footprint — the row count changes, so `ranges` has to be rewritten to
match or the light reaches no further (see `lightRangesFor`, which writes full
rows). An editor that exposes `size2d` without exposing `ranges` will look
broken.

**Walls read the grid at a different tile than they sit on.** Scenery takes the
lights over its own footprint, but wall shapes 0-3 (`GraphNode_Sub1_Sub5.
method13036`) test the wall's side flag — `Engine.method4777`, `{1,2,4,8}[rot]`
for shapes 0/2 and `{16,32,64,128}[rot]` for 1/3 — against a camera-relative
table, and when the visible face points away from the wall's own tile they read
the grid on the tile on the *other side* of the wall. That is why a torch lights
the walls flanking it even though those walls' own tiles are outside the
footprint. We can't re-pick per camera while the lighting is baked, so
`wallLightTiles` takes both tiles; moving lights into the shader would let us do
it properly. Shape 9 (`WALL_INTERACT`, the diagonal walls) is *not* a wall node
— it goes through the generic object path and uses its footprint.

**Not surfaced.** No way to see, move, recolour or add one.

**Gotcha.** There is an agreed plan (in `TODO.md`) to move point lights off the
bake and into the loc shader. Doing that first makes light edits live at 60fps
and removes the rebuild-on-Apply, so **build the shader path before the editor
UI**, not after.

---

## Face-level data

**What the renderer does.** `facePriorities` sets the model's baked draw order —
and not just for transparent faces: the client sorts **every** face by
priority → opaque-before-transparent → texture effectId → texture id
(`MeshRasterizer_Sub3` ctor, flag 0x100) and draws the lot in one pass with
z-write always on, so a transparent face *occludes* any face sorted after it
(TRACED 2026-07-27: Lumbridge fountain's priority-5 basin water hides its
priority-6 submerged interior outright — that's a design tool, not an
accident). Per-face alpha feeds the transparency rules traced in `TODO.md`.

**Not surfaced.** Neither is editable, and both visibly change rendering.

---

## Model texture mappings — a zero scale hides the face (TRACED 2026-07-27)

**What the renderer does.** Each textured face points at a texture *mapping*
(`texturePos` → the per-mapping `textureRenderTypes` / `textureNormalX/Y/Z` /
`textureScaleX/Y/Z` / `textureRotation` / speed / trans arrays in the model
binary, decoded in `loaders/models.ts`). For projected mappings (type 1
cylinder, type 2 cube) the client turns each scale into `64.0F / scale` — and
a **scale of 0 is Infinity**, which poisons that axis of the projection matrix
with NaN (`MeshRasterizer.method11256/11257`, darkan-game-client). Any face
whose UV formula touches the poisoned axis gets NaN UVs and degenerates to an
invisible smear — effectively a *hidden face*, and content uses it that way:
Lumbridge fountain (object 36781 → model 24520) carries a fish-sprite-sheet
face (texture 54, same art as sprite 2) on a type-2 mapping with
`textureScaleY = 0`, so the fish never show in the client. Our port
(`components/modelUVs.ts`, shared by the map scene, snapshots and ModelViewer)
mirrors the IEEE math and drops faces whose UVs come out non-finite — do NOT
"fix" the zero by clamping; that un-hides such faces (tiled fish across the
fountain basin).

**Not surfaced.** Model binaries are read-only in the editor, so mappings
aren't editable at all. If model editing ever lands, a zero scale on a
projected mapping must surface as "face hidden", not be sanitised.

---

## Loc sound / map-icon / map-sprite fields

Traced 2026-07-25 while making the map-scene markers editable. cryogen's
`ObjectDefinitions` and darkan's `ObjectType` decode these **opcode for
opcode identically** — only the field NAMES differ, and cryogen's dump uses its
own. Left column is what you'll find in `objects/<id>.json`:

| dumped (cryogen) | client (darkan `ObjectType`) | opcode | notes |
| --- | --- | --- | --- |
| `ambientSoundId` | `soundId` | 78 | looping ambient `sound_effects` id |
| `ambientSoundHearDistance` | `soundRadius` | 78, 79 | tiles the sound carries |
| `soundMinInterval` / `soundMaxInterval` | same | 79 | gap between plays, ticks |
| `soundGroupIds` | `soundGroupIds` | 79 | random pick per play |
| `ambientSoundVolume` | `soundVolume` | 104 | **-1 = opcode absent; the client's own default is 255** |
| `ambientSoundMinDelay` / `ambientSoundMaxDelay` | same | 173 | client default 256 each |
| `ambientSoundMaxHearDistance` | same | 178 | darkan comments it "not sure if this is correct" |
| `instrumentSoundEffect` / `instrumentAmbientSound` | same | 168 / 169 | |
| `mapSpriteId` | `mapIconId` | 102 | `config/map_sprites` record — the minimap symbol |
| `mapSpriteRotation` | `mapIconRotation` | 101 | quarter turns |
| `flipMapSprite` | `mapIconFlipped` | 105 | |
| `adjustMapSceneRotation` | `mapIconRotates` | 97 | false ⇒ client forces rotation 0 rather than adding the placement's |
| `mapCategoryId` | `mapCategoryid` | 107 | `config/areas` (MEC) record — the map pin |

Four gotchas that cost real debugging time:

- **`mapSpriteId` is read per SLOT, and the wall-decoration slot is never asked
  (TRACED 2026-07-26).** `Static.method13042` is the client's whole per-tile
  minimap pass. It queries the scene three times — `getWall`,
  `getInteractableObject`, `getGroundDecoration` — and checks `mapSpriteId` on
  each, drawing the sprite when set and falling back to the wall lines / the
  `WALL_INTERACT` diagonal when not. It **never calls the wall-decoration
  accessor at all**, so a loc placed as type 4–8 (slot 1 — `ObjectType`'s second
  column, mirrored by our `OBJECT_SLOTS`) cannot draw a map sprite however its
  definition is set; the wall it hangs on draws its own. Cody hit this setting a
  sprite on a wall decoration and seeing nothing in game. The def field is
  shared by every placement, so it's the *placement's* shape that decides,
  not the object: the same def placed as scenery elsewhere still draws there.
  `ObjectDefEditor` now takes a `placementType` and replaces the whole map
  sprite section with an explanation when the slot is 1 (still showing the
  stored value), and the editor minimap skips slot 1 to match.
- **An unset id is dumped as `-1`, never omitted.** Every one of the 73913
  objects carries `ambientSoundId`. Any `!== undefined` test on these fields is
  therefore always true — that's what classified all 206 nameless map-icon
  anchors (the musician among them) as sound emitters. Always test `>= 0`;
  `markerKindFromDef` in `mapScene.ts` is the single place that does it now.
  `soundGroupIds` is the exception: absent unless populated, never negative
  (384 objects carry one, lowest entry 710), and 340 of those are emitters whose
  only sound is the group — so it can't be dropped from the "is this a sound
  emitter" test.
- **`map_sprites` has an explicit blank.** Opcode 4's only job is to set the
  sprite id to -1, and the field's natural default is 0 — so `spriteId: -1` is
  authored intent, not a dump failure. 7 of the 106 records are blank this way
  (22, 36–40, 95) and **map sprite 22 alone is referenced by ~940 object defs**
  (the invisible clip walls lining water, e.g. object 83: nameless,
  `blocks: true`, `clipType: 2`, wall shapes `[0,2,3,9]`). Its neighbours' sprite
  ids run 1623, 1624, ⟨gap⟩, 1625, 1626 — a retired symbol whose references were
  never cleaned up. The client draws nothing for it: `createRotatedNativeSprite`
  fails `isFileCached(-1)` and returns null, and `ComponentMinimap` keeps the
  whole draw — `backgroundColor` fill included — inside `if (nativeSprite != null)`.
- **`config/areas` has the same blank**, as `defaultIconArchive: -1`. Both are
  now badged in the marker panel ("no sprite" / "no icon") and distinguished
  from "record missing" and "sprite N not dumped", because rendering nothing for
  all four cases is what made map sprite 22 look like a bug.

**Editable where:** `ObjectDefEditor.tsx`, shared by the map scene's marker and
object panels — a marker IS an object, so they differ only in which sections
they ask for (`identity` / `shape` / `sprite` / `icon` / `sound`). Note these
fields live on the **object definition**, not the placement — there is no
per-placement copy — so an edit changes every placement of that object in the
game. Both panels say so, and the marker one reports how many placements the
current region has. Drafts flow panel → `EditPatch.objectDefs` → `MapViewer`
state → `LocAssets.setDefOverrides`, so the scene previews an edit before it's
saved; the region's Save button writes `objects/<id>.json` whole.

**Picking by eye, not by id.** `MapSymbolPicker.tsx` is a thumbnail browser over
three tables — `map_sprites`, `areas` and `cursors` — opened from the Browse…
button next to each id field. `map_sprites` (106) and `cursors` (183) are
instant; `config/areas` is **73913 files of which only 643 have an icon** (132
distinct sprites) and 635 a name, so the scan filters to those, reports its two
phases separately (listing the folder, then a real percentage while reading),
and is cached per cache-root for the session in a `WeakMap` — its object URLs
are deliberately never revoked, since the cache outlives any one modal. Blank
records still get a cell, labelled with *why* they're blank, so "no sprite"
stays distinguishable from a failed load.

## Loc cursors, appearance and morph fields

Same treatment as the sound/icon table above — opcodes verified against both
decoders 2026-07-26 while filling out the object panel.

| dumped (cryogen) | client (darkan) | opcode | notes |
| --- | --- | --- | --- |
| `primaryCursor` / `primaryCursorActionIndex` | same | 99 | cursor id + which right-click option it applies to |
| `secondaryCursor` / `secondaryCursorActionIndex` | same | 100 | **9139 objects set at least one cursor** |
| `interactable` | `interactionType` | 19 | |
| `ambient` | same | 29 | signed byte |
| `contrast` | same | 39 | raw byte in the dump; the client's effective value is `850 + raw·5` — see below |
| `scaleX/Y/Z` | `resizeX/Y/Z` | 65/66/67 | 128 = 100% |
| `offsetX/Y/Z` | same | 70/71/72 | stored as `short << 2` |
| `inverted` | same | 62 | mirrored model |
| `staticShadow` | same | 64 clears it | |
| `dynamicShadow` | same | 88 clears it | |
| `obstructsGround` | `forceDisplayDecoration` | **73** | not 69 — 69 is `accessBlockFlag` in cryogen and a discarded byte in darkan |
| `supportsItems` | same | **75** | |
| `clipType` | `blocksMovement` | 27 (=1), 17 (=0) | the names disagree; the values don't |
| `occludes` | `occlusionMode` | 23 (=1), 103 (=0) | |
| `varpBit` / `varp` / `transformTo` | same | 77, 92 | 92 also reads the extra target |

### `ambient` / `contrast`: what the client actually does (VERIFIED 2026-07-26)

Traced in **darkan-game-client** (the rendering authority), not just the bot
refactor. Every lit def resolves to the same pair of numbers handed to
`createMeshRasterizer(mesh, flags, _, ambientArg, contrastArg)`, and the
renderer then scales the sun by `intensity * 768 / contrastArg`
(`MeshRasterizer_Sub3:3254`). So `contrastArg` is a *divisor*: bigger contrast =
flatter shading, and 768 is a fixed numerator, not a base.

| def | decode | use site | effective contrastArg |
| --- | --- | --- | --- |
| Object | `readByte() * 5` (`ObjectDefinition:206`) | `850 + contrast` (`:449`) | **850 + raw·5** |
| NPC | `readByte()` (`NPCDefinitions:604`) | `anInt4888 * 5 + 850` (`:268`) | **850 + raw·5** |
| Item (world/inv model) | `readByte()` (`ItemDefinitions:439`) | `contrast * 5 + 850` (`:201`) | **850 + raw·5** |
| Item (**icon** render) | same field | `contrast * 5 + 768` (`:552`) | **768 + raw·5** |
| SpotAnim | `readUnsignedByte()` (`SpotAnimationDefinitions:73`) | `anInt6981 + 850` (`:157`) | **850 + raw** — no ·5, and unsigned |
| interface models, hint arrow | — | literal `64, 768` | 768 |

So the ·5 is real for objects/NPCs/items; the *only* difference between the
object path and the others is that the client folds it in at decode time
instead of at use. **cryogen dumps the raw byte** (`ObjectDefinitions:283`,
symmetric encode at `:800`), which matches every other def type in the dump —
the JSON is self-consistent and correct. Ambient is uniformly `64 + raw`.

Two consequences for our code, neither of them the "our bake is 5× off" I
guessed before checking:

- **The map scene's loc bake never reads `ambient`/`contrast` at all.**
  `computeModelLitRgb` (models.ts) takes only a `ModelSun`; there are no
  ambient/contrast parameters on it. So there is no 5× error there — there's an
  unimplemented field. (`computeLitFaceRgb`, which *does* take them, is exported
  but has no callers.)
- **`ModelViewer` gets the ·5 right and the base wrong.** `ModelViewer.tsx:451`
  computes `768 / (768 + 5 * contrast)`; for objects/NPCs/items-in-world it
  should be `768 / (850 + 5 * contrast)`. 768 is the *item icon* base. At
  contrast 0 that's 1.0 where the client gets 0.903 — every previewed model is
  ~10% over-lit, shrinking as contrast rises. Spot animations want
  `768 / (850 + contrast)` with no multiplier at all.

# Editor gaps (map scene)

Requested 2026-07-25. These are UI/UX work, not cache-format work — grouped
here rather than in `TODO.md` because they share one theme: the 3D map viewer
shows far more than it lets you change.

## Side-panel tabs

**View / Edit / Place / Terrain.** View is browsing only — the objects, point
lights and markers lists, each a collapsible section whose header is its own
count-and-filter row (`SectionHead`). Edit is whatever is selected: the loc,
light and marker panels, plus the multi-select actions.

Selecting anything — a scene click, or a row in any View-tab list — switches to
**Edit**. That's what keeps the drag gate honest: left-drag moves the selected
object only on the Edit tab, and since selection forces that tab (and is blocked
outright on Terrain), you can only end up selected-but-elsewhere by changing tab
on purpose. Shift+drag marquee follows the same rule (Edit selects objects,
Terrain copies an area). Keyboard: `v`/`e`/`p`/`t`.

The **marker list** is per-placement, not per-object, and can't be derived from
the placement list: only the build knows which placements are markers, since it
takes a model's sentinel colour to tell. `buildLocsMesh` returns them and the
centre region's go into `sceneMarkers` state. Rows match the selection by world
tile rather than object id — the same utility object is placed hundreds of times.

## Pointer-interaction invariants (drag-to-move)

Written up because breaking either of these silently corrupts placements on a
misclick — which is exactly what the drag-to-move path did until 2026-07-25.

(The tab named below is now **Edit**, not View — see the section above.)

1. **One drag threshold, shared.** `DRAG_PX` in `MapSceneViewer.tsx` decides
   click-vs-drag for *both* the click handler and drag-to-move arming. They were
   separate before: the 5px test existed but sat after the move path's early
   return, so it never guarded a move and a 1px twitch committed an edit. Any
   new press-and-drag interaction must arm off the same constant.
2. **Move by delta, never by picked tile.** A drag moves a loc by the tile
   delta the cursor has travelled since the press (`movingTargetTile`), not to
   whatever tile the ray lands on. Dropping on the picked tile means pressing a
   multi-tile object anywhere except its anchor tile is already "a different
   tile", so a plain click teleports it there.

3. **Target tiles off the ground, not off `pick()`.** `pick()` returns the
   nearest visible mesh of *any* kind — correct for selection, wrong for "which
   tile is the cursor over". While dragging a loc the ray keeps landing on the
   loc itself, and on every wall, tree and roof the cursor crosses, so the tile
   sticks to that surface instead of tracking the cursor. `pickGround()`
   raycasts only meshes tagged `userData.isTerrain`. The grab reference taken at
   pointerdown must come from the same function, or the delta is biased by
   however far up the model the press landed.

Related trap: `resolveLocAt`'s `isCenter` means "belongs to the centre region"
(`:1107`), **not** "the object's centre tile". It does not tell you where on an
object the user clicked, and reading it that way is what made fault 2 look
guarded when it wasn't.

4. **Async previews must dedupe on the PENDING key, not just the built one.**
   The ghost's `ghost.key` is set only when its async `buildLocsMesh` lands, so
   checking that alone meant every update during a build — including ones for
   the tile already being built — bumped the cancellation token and restarted
   it. Place mode survived this because it updates from the RAF loop at ~30Hz,
   slower than a build; a drag fires `pointermove` at 120Hz+, faster than a
   build, so every attempt cancelled its predecessor and the ghost never
   appeared at all. `ghostPendingKey` closes it. Same shape as any
   token-cancelled async preview: dedupe on what's *in flight*, and have the
   clear path bump the token so a build can't land after the interaction ends
   and strand an object in the scene.

5. **A loc's geometry comes back on three paths — preview all of them.**
   `buildLocsMesh` returns `{ mesh, transparentLocs, markers, shadows,
   animated }`. `mesh` is the merged **opaque** geometry only; a loc with
   transparent faces gets its own mesh in `transparentLocs`, and a loc with an
   idle animation is pulled out of the merge into `animated` (rebuild it with
   `buildAnimatedLocMesh` and copy `al.matrix`). Anything previewing a single
   loc that reads only `mesh` silently shows **nothing** for transparent
   scenery and animated locs — the ghost did exactly this, which is why a
   fountain produced no ghost while ordinary objects would have. Placement is
   already baked in for the centre region; only neighbours need an offset.

**Still on the generic `pick()`:** place mode, paste-stamp and the terrain brush
all target tiles through it, so their cursor feedback drifts onto objects the
same way. Left alone deliberately — for *placing*, pointing at a wall and
getting the wall's tile is arguably the intent, whereas a *move* is a delta and
has no such reading. Worth revisiting if placement feels imprecise near
scenery.

## Object (loc) panel — it shows almost nothing and edits live nowhere

Today the panel shows x, y, type, rotation, plane. Wanted:

- **Much more info.** At minimum the object's name and id, its models and the
  textures each face group uses (see the loc/texture panel entry above),
  size, clip/blocking, `groundContourType`, animation, and the `transformTo`
  set. Treat "what does the def say" as the baseline.
- **Live preview on edit.** Changing any field should update the scene
  immediately, not on Apply — including **rotation**, which currently only
  previews after Apply.
- **Dirty state + discard.** Edits mark the panel dirty; Discard reverts.
- **Warn before losing edits.** Selecting another object, switching tabs, or
  navigating away with unsaved changes must prompt. **Reuse what exists** —
  `App.tsx` already has `confirmLeaveItem()` (`:687`), a `confirmDialog` modal
  with Discard/Cancel, plus a `beforeunload` guard (`:321`), driven by
  `isContentDirty`. The map panel should feed the same flag rather than grow
  its own dialog. The general pattern is CLAUDE.md's "Editable viewer
  convention" (local `draft`, `isDirty`, sticky save bar).
- **`transformTo` preview.** Let the panel choose which morph target the loc
  renders as, so a multiloc can be inspected in each of its states. This pairs
  with the open "REVISIT: transforming objects" item in `TODO.md` — that item
  decides which target to show *by default*; this one is about overriding it by
  hand. Doing this first would make that decision much easier to reason about.

## Sound emitters — read-only, and no table

- **Selecting one is read-only.** Everything about an emitter should be
  editable, same as any loc. (It *is* a loc — an invisible utility object — so
  the loc panel work above mostly subsumes this, but the sound-specific fields
  need surfacing too.)
- **Needs a table**, like locs and point lights already have: list every
  emitter in the region, select/jump to one, edit in place.
- **BUG: things with no sound are listed as emitters.** The musician map icon
  shows up as a sound emitter despite having sound `-1` and being nothing but a
  map icon. The marker-kind ternary in `mapScene.ts` (`:3799`) tests
  `def.soundId !== undefined || def.ambientSoundId !== undefined ||
  soundGroupIds?.length`, so a field that is *present but disabled* (`-1`) still
  beats the `mapCategoryId >= 0` branch underneath it — which does test `>= 0`
  properly. Fix: require `>= 0` on both sound ids, the way the icon and sprite
  branches already do. Check the dump first for what "unset" actually looks like
  (`-1` vs absent) and whether `soundGroupIds` can carry `-1` entries. The same
  predicate is duplicated in `MapSceneViewer.tsx` (`:2660`, the Place-tab
  quick-picks) and has to change in both.
- **BUG: Close leaves the emitter selected.** Clicking Close on an emitter's
  detail panel dismisses the panel but the marker stays selected/highlighted in
  the 3D view, so scene and panel disagree about what's selected. Close should
  clear the selection exactly like deselecting does. Check the other marker
  kinds and the loc panel for the same leak.

## Editing placements without rebuilding the scene

Moving, placing or deleting a loc currently re-runs the whole region build,
which is slow enough to break the flow of laying scenery out. Wanted: apply the
geometry change immediately and let the *baked* results go stale, with a small
disclaimer saying lighting and shadows won't be re-baked until a reload, plus a
**Reload** button somewhere obvious to force the full rebuild when you want them
correct again.

- **The merged opaque mesh is the obstacle.** A loc that lives in it can't just
  be moved — its triangles are baked into a shared buffer. The practical route
  is to pull the edited loc out into its own mesh, which the transparent-loc
  path already does (`transparentLocs`), and rebuild only that one.
- **Deletes are the easy case** — collapsing the loc's triangles is enough
  without touching the rest of the buffer; adds and moves are where the own-mesh
  split is needed.
- **What actually goes stale:** the sun/ambient vertex bake, baked point lights,
  and static shadows (the darkened ring under scenery). Say so in the
  disclaimer rather than a vague "lighting may be wrong".
- **Sequencing:** this overlaps the point-lights-in-the-shader plan in
  `TODO.md` — once lights stop being baked into vertex colours, light edits stop
  going stale at all and only the sun bake and shadows still need the reload.

## Map icons / map sprites — needs a table

List every map icon/sprite used in the region, and for each, **which objects
display it**. The link runs through an object def's `mapCategoryId` (an `areas`
/ MECType record), plus static-element placements — see the related
"REMINDER: verify object-placed map icons" item in `TODO.md`, which is about
whether those placements resolve correctly. The table is how you'd check.

## Light editing — sliders as well as values

The light table's editable cells take typed numbers only. Every numeric field
(position, radius/`size2d`, colour components, intensity) should have a slider
*and* the number, so a value can be dialled in while watching the scene. The
number field stays for precision and for pasting exact values.

**Sequencing:** see the point-lights gotcha above — moving lights into the loc
shader first makes these edits live at 60fps instead of triggering a rebuild,
which is what makes sliders worth having at all.

## Terrain painting

Drag-to-paint tiles, for both **materials/textures** and **plain colours**. A
terrain brush already exists (`terrainBrushRef`, and `onPointerDown:1237` starts
a `paintingDrag` that continues through `onPointerMove:1158`), so this is
extending what that brush can apply rather than new interaction plumbing.

Worth doing alongside the per-tile overlay shape/rotation painting described in
the ground-blending entry — same interaction, and together they'd cover most of
what hand-authoring terrain needs.

---

# Parked 2026-07-27 — map-scene punch list

Dumped here on Cody's ask while switching off maps for a while. Open issues
first, then future features.

## Open issues

- **cryogen CacheBuilder freezes at 100%.** With the ManifestBackedDefinition
  rework, a build runs its actions for quite a while and then hangs at 100%
  rather than exiting. Cryogen-side bug, not this repo — reproduce there.
- **Water is close but under-animated.** Current surface reads like the client
  with *water detail off* — colour and reflection are in the right place, but
  the real client at full detail animates far more. See
  `reference_water_shader` / `docs/` for where the procedural-sky water stands;
  the missing piece may need the `um` underwater-map dump we don't have.
- **Minimap brightness slider should die.** Figure out the client's actual
  minimap brightness (suspicion: another software-mode difference, same family
  as the `window.__gpu` gotcha) and bake the correct value in, then remove the
  "Map brightness" slider (`mmGamma`, `cache-editor:minimap-gamma-v2`).
- **Cursor "no option" needs clarification.** The map-scene def editor's cursor
  picker (`cursorPick` in ObjectDefEditor, `CURSOR_SLOTS`) lets you choose
  which right-click option a cursor applies to, including "no option" — but
  the objects entry's editor has nothing like it, and its cursors seem to ride
  the options directly. If the index is genuinely selectable, the objects
  editor should get the same control; if it isn't, the map-scene picker is
  wrong. Reconcile the two against the client's decode before touching either.

## Future features

- **Skybox — what do we actually have?** The graphics settings panel claims
  "applied", yet it's been said repeatedly that we lack the skycube needed for
  correct lighting. Do we have skyboxes and a sun or not? The viewer looks
  like we don't. And given all that: what does the "Sky" checkbox actually do
  today? Answer those questions first, then build whatever's missing.
- **Idle animations.** Gather more info — what drives them, what we render
  today, what's missing.
- **NPC spawns.** A way to see what the map looks like populated:
  - Parse a matrix-style spawn list from a text file, filtered to the current
    region; honour the extras (facing direction, does-it-walk, …).
  - Use cryogen's code for deciding the random walk.
  - Show the NPC list as a View-tab section on the right, like objects.
- **Copy/paste → prefabs.** Shift+drag marquee already sort-of selects an
  area, but it drags in ground layers and possibly other planes. Wanted:
  - Selection copies just the actual objects in the area, saved to a tab on
    the right.
  - Save with a name, persist across refreshes, delete/clone.
  - Point is placing pre-made structures — a bank, a hut, a whole building —
    into an area you're building. Prefabs, basically.
