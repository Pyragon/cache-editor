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

---

## Region environment

**What the renderer does.** Reads `map_environments/<id>.json` for sun
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

**What the renderer does.** `facePriorities` sets transparent draw order; per-face
alpha feeds the transparency rules traced in `TODO.md`.

**Not surfaced.** Neither is editable, and both visibly change rendering.

---

# Editor gaps (map scene)

Requested 2026-07-25. These are UI/UX work, not cache-format work — grouped
here rather than in `TODO.md` because they share one theme: the 3D map viewer
shows far more than it lets you change.

## Pointer-interaction invariants (drag-to-move)

Written up because breaking either of these silently corrupts placements on a
misclick — which is exactly what the drag-to-move path did until 2026-07-25.

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
