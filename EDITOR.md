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
above, and both save.

**Explained and previewed (2026-07-29).** Both pages were rebuilt from bare
field grids into teaching pages, because none of the above is guessable from a
form:

- **`GroundPreview.tsx`** — a live 3D preview that synthesises a slab of terrain
  and runs it through the map view's own `buildTerrainMesh`, with the draft def
  swapped into the `SceneConfigs`. It is deliberately *not* a reimplementation:
  whatever the map draws, the preview draws, so it cannot drift. The subject
  material sits in the middle of a field of a chosen neighbour, which is the
  only way the corner blur is visible at all. Controls: neighbour material,
  overlay shape + rotation, field size, sloped ground.
- **`GroundExplainer.tsx`** — the long-form "how ground works" modal behind the
  header button (two layers, the neighbour blur, shape/rotation, the master
  switch, slot packing, `secondaryRgb`'s three jobs, textures, the two flags,
  water).
- **Per-field `?` help** via `defFields`' `NumFieldDef` third element and the
  new `Field`/`HelpToggle` exports — opcode, default, sentinel and gotcha per
  field.
- **`GroundUsagePanel.tsx` + `loaders/groundUsage.ts`** — "where in the world is
  this used": an on-demand scan of every region dump counting tiles per
  definition, cached in IndexedDB. It reads only the head slice of each region
  JSON (the two channels sit at the top, ~44 KB of ~340 KB) and tallies straight
  off the atob'd string. Totals are world-wide; the per-region list is capped at
  `TOP_REGIONS` and the UI says so.

**The two flags** (traced 2026-07-29 —
`MapLoader.addUnderlayTiles`/`addOverlayTiles`/`setupCulling`, `GroundGL:875`):

- **`shadowed`** (underlay opcode 4, overlay opcode 10) means "this tile
  RECEIVES the baked wall/scenery shadows". The map builder ORs it into a
  per-tile `hasShadows`, which `GroundGL` stores as `CONTAINS_SHADOW`;
  `createShadowAt` returns early without it, leaving the tile evenly lit under a
  wall. **PORTED 2026-07-29** as `tileTakesShadow` in `mapScene.ts`: both config
  types carry `shadowed`, and `emitTile` consults the shadow grid only where the
  tile allows it, so a non-shadowed material stays lit hard against a shadowed
  neighbour — the client's discontinuity, not a bug. Two guards to preserve if
  this is ever touched, both depending on the shape being **already remapped**:
  the underlay branch needs `pathShape != 0`, and a tile with no overlay has its
  shape remapped 0 → 12 first (`Class329`/`MapLoader:564`), which is the only
  reason plain ground takes shadows at all; the overlay branch needs
  `pathShape != 12` *and* a real tile colour, so a full-tile overlay (shape 0,
  not remapped) silences its hidden underlay and decides alone.
  Scope in this cache: **3 underlays** (37, 58, 135 — all `0xDCDCF0` snow on
  textures 407/525) and **no overlays** turn it off, across 23 regions; the
  biggest are 10583 (world 2624, 5568 — a full plane of 58) and 11603
  (2880, 5312).
- **`occlude`** (opcode 5 on both) is not visual at all — on planes above ground,
  a flat occluding tile gets `COMPLETELY_FLAT` so the level below can be skipped.
  We do no plane-below culling, so the flag is inert here, and both pages say so
  rather than implying the toggle does something.

**Not surfaced.** The remaining gap is **per-tile**, in the 3D map editor:

- No tile inspector. Selecting a ground tile should show its overlay id,
  underlay id, shape and rotation — and, because it is genuinely hard to
  predict, **which of the three shape families the tile resolved to** and why
  (`blendsWithUnderlay` + whether any neighbour asked for an edge face).
- No way to paint an overlay shape or rotation onto a tile. This is the direct
  answer to "how could I have fixed that hard arc by hand" — the arc is shape
  10, and being able to try shape 9 or a different rotation on one tile is the
  most useful single thing this section could gain.
- In the **map view** the blend is still rebuilt wholesale, so editing a
  definition there can't preview live — that would need an incremental terrain
  rebuild. (The definition pages sidestep this: `GroundPreview` builds a small
  synthetic slab instead, which is cheap enough to rebuild on every keystroke.)

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

## Particle emitters on loc models (traced 2026-07-28)

**What the client does.** A mesh can bind particle producers to individual
faces (`RSMesh.particleConfig`, footer flag 0x2). The face is a **spawn
surface, not geometry**: each frame the renderer transforms that triangle's
three vertices into world space and hands them to the producer
(`MeshRasterizer_Sub2.method11273`), which scatters particles across it. The
carrier faces themselves are painted in the invisible-marker green (HSL16
20287) and face away from the viewer, so the client's unconditional back-face
cull hides them.

**Where it shows.** The burnt remains near the God Wars chapel (object 61761,
model 58392) are 22 faces, **6 of which are emitter carriers** bound to
producers 397/398. In game the loc is charred logs with flames over it; the
editor drew the six green triangles instead, and animated them, because
`buildAnimatedLocMesh` used `DoubleSide` where the static loc path uses
`FrontSide`. Corpus-wide, **972 models carry emitters and 161 of those are pure
carriers** — a single sentinel-green face whose only job is to spawn particles.

**Don't skip emitter faces as a class.** An emitter can just as well bind to an
ordinary visible face (a torch's flame on the torch's own geometry), so the fix
is culling, not filtering. Animated loc meshes keep their placement on
`mesh.matrix` instead of baking it into the vertices, so a mirrored placement
reverses the on-screen winding and has to cull `BackSide` instead — the static
path handles the same case by flipping the triangle order as it bakes.

**How the editor renders it.** `sceneParticles.ts` runs one `ParticleSim` — the
same client-faithful port the particles page and model viewer use — per emitter
face, and draws its particles as additive point sprites with the producer's own
material. The sim stays in MODEL space, because its physics are authored there
(gravity, the emission axis off the face normal); a holder object carries the
placement, negating y/z and undoing the sim's 12-bit fixed point exactly as the
mesh builder does. Point size is a world diameter turned into pixels in the
vertex shader, so it follows the viewport.

**Blending and brightness are the material's, not the particle's.** Every
particle material in the cache is `effectCombiner: 2` — the same alpha-blended
path loc faces take — and that is what lets smoke be black: the God Wars plume
(producer 179 on objects 61414/61416, material 850) is `#333333 → #000000` at
alpha 70-90, so alpha-blending darkens what is behind it. Drawing particles
additively cannot do that at all; it only brightens, and turned that plume into
grey haze. Brightness comes from the material's `hdr` flag instead: the flames
(producer 397, material 1585, `hdr: true`) are pushed past 1.0 and the scene's
bloom pass turns that into the yellow halo a fire has in game, while the smoke's
`hdr: false` material stays dark. Both mechanisms are the loc renderer's own —
there is nothing particle-specific about either.

A region has far more emitters than a model preview, so there is a budget:
each emitter's ring is its own rate × lifetime (the flames settle near 500, the
smoke plume over them near 2,600 — one shared cap starved the plume thin), and
only the nearest 32 emitters simulate. There is deliberately NO distance
cut-off: the orbit camera routinely sits 50+ tiles from what it is looking
straight at, so any camera-distance radius switches fires off by view angle.
HDR follows the scene's bloom toggle, exactly as loc materials do (the client
gates HDR float textures on the bloom filter being live).

**Animations gate emission through the face (TRACED 2026-08-02).** The client
re-reads every emitter's triangle off the POSED model each frame
(`ParticleProducer.updatePosition`), and a triangle whose three corners
coincide sets `unmoved`, which stops emission — live particles keep updating.
That is not an edge case, it's the authoring tool for burst timing: a sequence
keeps the emitter face collapsed to a point for most of its run and expands it
only for the frames that should pour. Cutscene 12's rockfall dust (anchor locs
67857/67860, producers 185/186 at rates 96..192/64ths — a firehose if left
ungated) pours once at the end of the collapse animation this way, and a fire's
spark faces flicker on and off with its idle. Ported as
`ParticleSim.unmoved` + the `pose` handle on `SceneParticles.add()`; the
cutscene player feeds poses from spawned objects, gfx and animated locs, the
map viewer from its animated-loc pose loop. A sim that never receives poses
emits from the rest triangle forever — which is exactly what the pre-fix
"constant spew" was. Hosts that pose from birth (spawned objects with an idle,
gfx) pass `awaitFirstPose` so the sims hold until the first posed frame — the
rest pose's open faces otherwise leak an opening puff in the tick before the
sequence collapses them. `maxLoops` matters here too: 14813 is maxLoops 1, and
looping it replayed the burst.

**`adjustsLightIntensity` (TRACED 2026-07-29, DirectX path).** An earlier note
here guessed it made the emitter light its surroundings — wrong. `Class54` is
the HardwareRenderer's particle renderer (`aClass54_8837`), and the flag only
batches particles and switches the renderer between `IA(sceneAmbient)` and
`IA(1.0)` per batch (`Class54.method1095`): a flagged particle is LIT BY the
scene ambient exactly like geometry, an unflagged one draws full-bright. It adds
no light to anything. Ported as the `uAmbient` uniform (`setAmbient`). Also
confirmed there: the particle pass sets no blend state of its own (it rides the
transparent pass's alpha blending) and drops z-write via `RA(false)`.
**CORRECTION 2026-07-28:** an earlier note here claimed the warm glow a fire
casts is "HDR overbright spread by the bloom filter — nothing else". Wrong: the
glow (and the dense smoke column) are **billboards** — see the billboard section
below. The fire's particle material 1585 IS hdr ≈4.03 and does feed bloom, but
the big halo behind the flames is a sprite the client draws explicitly.
Emitters that fall out of range are hidden and left frozen rather than reset, so
walking back to a fire finds it still burning. Per-plane groups hang off the
scene's plane groups, so hiding a plane hides its fires with it.

**Per-plane particle visibility (traced 2026-07-28, `Particle.java:80-130`).**
The client re-buckets every particle to the plane band its CURRENT height
occupies (per tile, walking the ground heightmaps) and draws it under that
plane's visibility; `killAboveSurface` (producer opcode 34, default ON) kills a
particle that sinks below the plane-0 surface, and anything >8 tiles above the
top plane dies too. Why it matters: **one anchor loc can feed flames to every
storey.** The chapel's torch anchor (obj 10397, model 8238, placed plane 3) is
8 invisible carrier faces stacked EXACTLY one plane-step (960 units) apart —
one spawn pair per storey — so drawing all of its systems puts a column of
flames over each door torch. The map scene handles it by parenting systems to
the placement plane's group (upper planes default hidden); the cutscene player
gates the groups by the camera FOCUS height band per frame. Neither is the
client's dynamic per-particle bucketing — a long fall through planes stays in
its source plane's group here — but no shipped emitter seems to need that.

---

## Billboards on loc models — a fire's glow and smoke column (traced 2026-07-28, DirectX path)

**What they are.** A mesh can pin camera-facing sprites to individual faces
(footer flag 0x4: `u16 typeId, u16 face, u8 depth, s8 distance` per entry). The
God Wars fire (object 61761, model 58392) is the worked example: of its 22
faces, 6 are particle-emitter carriers, **4 carry billboard type 93** — the
warm glow behind the flames (material 920, a 128×128 white radial-alpha sprite,
tinted `#e7d067` by the host face colour, ~500 units wide) — and **12 carry
type 179**, the rising smoke column (material 899, a soft blob, tinted a
near-black `#32312e`, ~800 units wide, stacked to ~1.6 tiles up). So the
"light behind the fire" and a large share of the black plume are sprites, not
particles, and neither is bloom.

**The type config** (`billboards/<id>.json`, decoder verified against the
client's `BillboardDefinitions`): `materialId` (opcode 1), `size2d`/`size3d`
(opcode 2, stored −1), `shape` (4), `blendType` (5), `stationary` (6), `hasUid`
(7). Gotchas learned from `MeshRasterizer_Sub3` (the DX mesh class):

- **`hasUid` removes the host face from the mesh** — the ctor drops it from the
  face list outright and only the sprite draws. Both fire types set it.
- **`stationary` is a misnomer: it gates on bloom.** `method14275` draws a
  flagged billboard only while the bloom filter is OFF (`!aBool522 ||
  !method8471()`) — it is the fallback glow for the no-bloom look.
- **`depth` is NOT a draw offset — it is the billboard's animation group id**
  (transform types 8/9/10 flicker offset/rotation/scale per group; the smoke
  puffs sit in groups 1-6). The pull-toward-camera uses the `distance` field
  (100 for every fire billboard): view vector × `(1 − distance/len)`.
- **Sizes are half-extents in world units** — the quad spans 2×size2d by
  2×size3d (`Matrix44Var.method5213` scales a unit quad by size×2), and they do
  NOT scale with the pre-13 `<<2` (the DX mesh is already upscaled).
- **Tint = host face colour through the raw HSL palette** (not sun-lit), alpha
  = `255 − faceAlpha`. The draw is the "Particle" shader (`Class103_Sub1`):
  texture × DiffuseColour, alpha-blended, z-write off, right after the host
  mesh. `shape`/`blendType` are NOT consulted in the DX path at all (the GL/SM
  renderers use them; the ModelViewer's circle-clip/additive handling mirrors
  those, which is close enough for previews).

**Where the editor renders them.** `sceneBillboards.ts` (map scene + cutscene
player): quads merged per material per placed loc, anchors baked to world
space, the vertex shader does the view-space expansion, camera pull, group
scale/roll/offset; `billboardHiddenFaces()` in models.ts feeds the `hasUid`
skip in both scene face loops; the `stationary` gate follows the Bloom toggle.
`ModelViewer` has its own THREE.Sprite-based rendering — which every model
preview embeds (NPC/identikit/player/gfx/interface viewers) — and its sprites
follow the animated pose too: anchors track the posed carrier faces, groups
apply type-9/10 roll/scale, and the host face's baked + type-5 alpha and
type-7 colour carry to the sprite. Still no camera pull there, and raw model
units — a pre-13 model previews its billboards 4× large relative to the mesh.

**Animation is NOT optional for these.** The fire's idle sequence (12409) is
what makes it look right: type 1 raises the carrier faces, types 9/10
roll/breathe each billboard group, and type-5 face fades leave only 2-4 of the
6 smoke puffs per cluster visible at any instant (verified frame by frame).
Rest pose draws all 12 at full base alpha — one giant cloud burying the fire.
`skeletalAnimation.ts` handles types 8/9/10 now (`PosedVertices.
billboardGroups`, group id = the attachment's `depth` byte, per
`RSMesh.method2667`); the map scene drives animated locs' sprites per posed
frame (`SceneBillboards.addAnimated`, hidden until the first pose), and the
cutscene player runs the same LocAnimator loop (added 2026-07-28 — it used to
render animated locs frozen at rest, which is how the chapel torches showed
their flame models as authored stacks of licks). Still open: frame tweening
(100ms steps vs the client's lerp) and the roll-direction sign (unverified
against the client).

**Editability.** The billboards entry has a viewer (`BillboardViewer`); the
per-model attachments (which face carries which type, depth, distance) are mesh
data and only become editable with the model editor. The type config's fields
are all understood now, so a billboards *editor* pass is unblocked: size,
material id, the two flags, with the fire glow as the live-preview case.

---

## Zero-scale texture mappings (traced 2026-07-28)

**What the client does.** A texture mapping of type 1-3 carries three scales,
and the cube path turns them into `64.0F / scale` (`MeshRasterizer.method11256`,
the deob-named `particleDirection*` fields). A **zero** scale therefore becomes
`Infinity`, which flows straight into the space matrix rows
(`method11257` — no zero check anywhere) and poisons one projected coordinate
with ∞/NaN. Two consequences follow, both load-bearing:

- The dominant-axis test (`method11254`) can never pick the poisoned axis,
  because every comparison against NaN is false. It falls through to another
  cube face — whose own coordinate then comes off the ∞-scaled row.
- The client hands those coordinates to the GPU unchanged. Sampling at a garbage
  coordinate returns *some* texel, so **the face is drawn, not skipped**. On a
  uniform texture that reads as a solid pane of one colour.

**Where it shows.** The chapel wall (object 61735 → model 57928) puts its
windows on 8 faces textured 715 — a flat `0x050505` fill — with a cube mapping
scaled `3745, 17822, 0`. In game they are solid black window panes. Dropping
those faces (what the editor did until now) left a hole you could see the world
through. **2,077 models / 73,606 faces** across the cache hit this.

**How the editor renders it.** `modelUVs.ts` reproduces the client's arithmetic
including the ∞/NaN, then pins the non-finite coordinate to a texture edge
(−∞/NaN → 0, +∞ → 1) because feeding NaN to a GPU is undefined across vendors.
One texel stretched over the face — which is what the client's garbage
coordinate amounts to. The counter-case to watch is the Lumbridge fountain
(model 24520, texture 54, one face, cube scaleY 0): clamping the *scale* to 1
there tiled crisp fish across the basin floor, which the client does not show,
so the scales must keep flowing as ∞ and only the final coordinate is pinned.

---

## Player look — identikit parts and the character colour palette (traced 2026-07-29)

**What the renderer does.** Assembles a player from seven identikit "look"
parts and ten colour choices. `PlayerLookModal` previews a def on the stored
default look; `buildLookModel` (`loaders/playerAppearance.ts`) mirrors the
client's order — each part recoloured with its own pairs, merged, then the
global palette applied over the combined mesh
(`PlayerAppearance.getBodyModel`).

**The slot table.** `look[i]` lives at appearance position `IDK_PART_TABLE[i]`
(`[8, 11, 4, 6, 9, 7, 10, 0]`). Verified three independent ways, which is
worth knowing because none of the three is self-evident on its own:

| look index | part | appearance position |
|---|---|---|
| 0 | Hair | 8 |
| 1 | Beard | 11 |
| 2 | Torso | 4 |
| 3 | Arms | 6 |
| 4 | Wrists | 9 |
| 5 | Legs | 7 |
| 6 | Feet | 10 |

1. darkan-bot-refactor `PlayerAppearance.IDK_PART_TABLE`.
2. darkan-world-server `Appearance.generateAppearanceData()` — writes
   `lookI[2]` at the chest position, `lookI[3]` arms, `lookI[5]` legs,
   `lookI[0]` hair, `lookI[4]` hands, `lookI[6]` feet, `lookI[1]` beard.
3. cryogen's `renderPlayerBody()` composes the same seven meshes in that order.

The table's 8th entry (position 0, the hat slot) is equipment-only.

**The part names are function names, and cryogen's differ.** cryogen's
`ModelDefinitions.getDefaultLook()` annotates the same seven ids as "face
(minus jaw)", "jaw", "body", "(arms probably)", "hands", "legs", "feet" —
describing what each kit's *mesh* contains. The labels above describe what the
*slot* does, which is what the client keys on: `look[0]` is gated by the head
equipment slot and `hideHair`, and gets swapped through the hat-hair lookup;
`look[1]` is gated by `hideBeard` and the server's own setter is
`setFacialHair`. Both readings fit the same data — the hair kit also carries
the head mesh used for chatheads (kit 310 has `headModels: [46442]`) — so
don't treat the disagreement as one of them being wrong. Note cryogen hedges
`look[3]` as "probably"; the world-server's `hideArms`/`getOldArms` path
settles it as arms.

**Tops and arms are NOT independent — outfit "sets" pair them, and that is
why nothing has to hide a second pair of arms.** Choosing a top does not leave
the arms alone: `Appearance.verifyArms()` looks the top up in a set and
*overwrites* the arms and wrists with the ones that set names. So a top either
carries its own arm geometry (its set lists `arms: -1`) or it is sleeveless
and its set names the arms kit that completes it. The client has no
render-time trick for overlapping arms; the bad combination simply never
arises. Getting this wrong in the editor produces both failure modes — an
armless body on a sleeveless top, and two interpenetrating pairs of arms on a
sleeved one.

The chain (all in the cache, `loaders/outfitSets.ts`):

```
enum 5735       -> 20 family struct ids (Adventurer, Thief, Warrior…)
family struct   -> up to 6 set structs per gender
                   (male params 1169-1174, female 1175-1180); 1160 = family name
set struct      -> 1182 top · 1183 arms · 1184 wrists · 1185 legs
```

64 sets in this cache (32 per gender); **23 list `arms: -1`** (the top has
sleeves) and **41 name an arms kit** (sleeveless top). Set members' identikit
categories are exactly 2/3/4/5, which is what pins param 1185 to legs and
confirms slot 4 is wrists.

**The proof this is the right model: the stock look IS a set.** Male set 1100
("Thief") is `top 452, arms -1, wrists 371, legs 627` — the stock male look is
`[310, 16, 452, -1, 371, 627, 433]`. Female set 1101 matches its look the same
way. So `arms: -1` in the default look is deliberate (the Thief top has
sleeves), **not a hole to patch** — an earlier pass here "fixed" it with
`getOldArms` and produced exactly the double-arms clipping described above.

For a top in no set, `verifyArms` falls back to the character-creation pick
lists: arms must appear in enum **711** (male) / **693** (female) or it resets
to `getOldArms()` = **26 / 61**; wrists must appear in **749** / **751** or
reset to **34 / 68**. (Selectable top lists are enums 690 / 1591.)

Coverage is partial and a UI has to cope: of the male kits, 32/46 tops,
18/45 arms, 32/46 wrists and 31/43 legs appear in a set; hair, beard and feet
are in none (they pair with nothing).

**Previewing an arms kit is the one case with no client analogue**, since the
client only ever derives arms *from* a top, never the reverse. `buildLookModel`
works backwards: if the kit belongs to a set, that set's top and wrists are
used. If it doesn't — the bare-arms family, which the client only shows under
an equipped chest item — the rule (Cody's call, 2026-07-29) is **keep the
look's own top when it is known to leave the arms visible, and substitute a
sleeveless one otherwise**, flagged `fallback` in the UI:

- `topShowsArms()` is true only when the top's set names an arms kit. A top in
  *no* set counts as false — 14 of the 46 male tops are unplaced and nothing
  in the data says whether they have sleeves, so "unknown" is treated as
  "might hide the arms".
- The substitute is the lowest-id top among sets that name arms. Sleeveless
  tops are contiguous ranges — **457-474 male, 565-587 female** — so this is
  stable, and the picked top's set also supplies the wrists.
- With the stock look this always substitutes, because its top 452 (Thief) is
  sleeved. Point a default look at a sleeveless top and its own top is kept.

**The beard is male-only, and the gate is SERVER-side.** Both
darkan-world-server's `Appearance.generateAppearanceData()` and cryogen's
`renderPlayerBody()` open the beard test with `male &&`, so a female's beard
position is written empty whatever `look[1]` holds. The client would draw a
beard mesh it was handed — it simply never is. The cache agrees: category 8
("female beard") is the one gap in an otherwise contiguous 0-13 range. Any UI
over a female look should omit the beard field rather than offer a dead one;
`lookPartAppliesTo` in playerLook.ts is the shared test, and `buildLookModel`
drops the part before it can render.

**`category` (identikit opcode 1) encodes gender AND body part.** The client
reads and *discards* this byte (`IdkType.decode` opcode 1) — character
creation groups kits through CS2/enum lookups instead — so this is empirical,
not a decode. `category = (female ? 7 : 0) + lookIndex`, and it holds across
all **651** dumped kits: 0-6 male, 7-13 female, with **category 8 ("female
beard") correctly empty**, and every id in the two stock looks landing on its
expected category. That is what lets a viewer drop a kit into the right slot
of the right gender's look without asking. cryogen's dumper named this field
`unused`; the editor's loader calls it `category`.

**The colour palette lives in `defaults`, not in the identikits.**
ENTITY blob opcode 7 (`defaults/entity.json`, dumped as `recolorPaletteSrc` /
`recolorPaletteDst`): **10 groups × 4 source colours**, each source carrying
its own replacement list. A look's `colour[g]` is an index *into that group's
lists*, not a colour. Group meanings come from darkan-world-server's own
setters:

| group | tints | replacement choices in this cache |
|---|---|---|
| 0 | Hair | 25 |
| 1 | Torso | 229 |
| 2 | Legs | 229 |
| 3 | Boots | 206 |
| 4 | Skin | 14 / 14 / 12 / 12 (four source shades) |
| 5-9 | — | none — all four source slots are -1 |

**Each group is several source tones driven by ONE index.** Hair, torso, legs
and boots carry 2 source colours each; skin carries 4. A choice `n` replaces
*every* slot in the group at once — slot 0 with `dst[0][n]`, slot 1 with
`dst[1][n]`, and so on. The pairs are authored as base + highlight: across all
25 hair choices, slot 1 is the same hue and saturation as slot 0 with the
lightness 4-21 units higher. Worked example, identikit 323 (a female
hairstyle, visibly two-tone — both sources appear in its body mesh 46383 and
head mesh 46414):

| `colour[0]` | slot 0 `6798` | slot 1 `-10304` |
|---|---|---|
| 0 | h6 s5 l14 | h6 s3 l26 |
| 2 | h10 s0 l43 | h10 s0 l64 |
| 5 | h7 s4 l64 | h7 s4 l76 |

So a two-tone region cannot be recoloured tone-by-tone **as a player look** —
the appearance block has one byte per group, so the game cannot express it and
an editor offering it would produce a look no server could send. It *can* be
done **in the cache**, through the identikit's own recolour pairs (already
editable in `IdentikitViewer`), which retints that tone for every player using
the kit. See the ordering gotcha below before doing so.

Gotchas for an editor here:

- **An out-of-range choice silently becomes 0.** `PlayerEntity` clamps it
  while reading the appearance block, and the render loop guards again per
  source slot. This is not theoretical: **the stock looks ask for skin 110
  against a 14-entry palette**, so every shipped character renders with skin
  choice 0. A colour picker must clamp per group or it will show colours the
  game never displays.
- **The palette applies to the assembled avatar**, after per-part recolours —
  so a part whose own pairs already moved a colour off the palette's source
  value stops responding to the character colour. That is the client's
  behaviour, not a bug, and it is the trap waiting for anyone retinting one
  tone of a two-tone kit: add a pair `6798 -> X` to a hairstyle and the
  palette can no longer find `6798`, so that tone freezes while the other
  still follows the player's hair colour — hair that half-recolours.
- Groups 5-9 are real in the format and empty in this cache; a UI should hide
  them rather than offer dead sliders.
- Palette values are signed HSL16 (`-1` = the 65535 sentinel on the source
  side); no replacement list in this dump contains -1.

**Already editable.** `IdentikitViewer` edits every field of a kit
(bodyModels, headModels, recolour/retexture pairs, category), and the preview
picks up the live draft so unsaved edits show.

**Not surfaced.**

- **The default looks themselves.** Stored in `localStorage` under
  `cache-editor:player-look-v1`, seeded from darkan-world-server's own
  `Appearance.male()`/`.female()`. No editor yet — the seven part ids, the
  ten colour choices and gender all want one.
- **The palette in `defaults/entity.json`.** `DefaultsViewer` shows the entity
  blob as raw JSON, so the palettes are technically editable as nested arrays
  and practically not. They deserve swatch grids per group.
- **Equipment.** The preview covers the unequipped body only. The client's
  full recipe (darkan-world-server `generateAppearanceData`, mirrored by
  cryogen's `renderPlayerBody`) additionally needs: items in positions 0-3
  drawn first; chest/legs/hands/feet each replacing their look part when
  equipped; `hideArms`/`hideHair`/`hideBeard` tests; the **bare-arms
  substitute kit — 26 male, 61 female** (`getOldArms`) used when a chest item
  hides the arms; and the **hat-hair style lookup** (enums 2339/2342 style →
  slot, 2338/2341 slot → struct, then struct params **790** with-hat / **791**
  with-face-mask) which swaps the hair kit for a hat-compatible one.
- **Head compositing** (`headModels`, item `maleHead1-2`/`femaleHead1-2`).
  `renderPlayerHead` draws the hat's head mesh first, then each look part's
  `renderHead`.

---

## The equipment screen — interface 387 (traced 2026-07-29)

**What it gives us.** The editor's default-player panel is dressed in the
client's own equipment art rather than an approximation:
`loaders/equipmentSlots.ts` holds the layout, `loaders/uiSprites.ts` serves the
sprites, `PlayerDefaultsModal` draws it.

**Sprites.** Slot tile **170** (36x36), hover state **9167** — component 5's
`onMouseOver`/`onMouseLeaveScript` swap between exactly those two. The 40x40
tile is **1409** (the four buttons along the bottom), and **9280-9285** are the
decorative frame edges. All are dumped as `sprites/<id>/<id>_0.png`.

**Layout.** The panel (components 2 and 65) is **190x261**. Each slot is an
anonymous 36x36 container; its `basePositionX` is an **offset from the panel's
horizontal centre**, because `aspectXType: 1` — which is why the dumped x
values go negative on the left. Screen position is
`panelWidth / 2 + x - size / 2`.

| slot | x | y | equipment index | drawn by us |
|---|---|---|---|---|
| Aura | -41 | 4 | 14 | no |
| Head | 0 | 4 | 0 | yes |
| Cape | -41 | 43 | 1 | yes |
| Neck | 0 | 43 | 2 | yes |
| Ammo | 41 | 43 | 13 | no |
| Weapon | -56 | 82 | 3 | yes |
| Torso | 0 | 82 | 4 | yes |
| Shield | 57 | 82 | 5 | yes |
| Legs | 0 | 122 | 7 | yes |
| Hands | -56 | 162 | 9 | yes |
| Feet | 0 | 162 | 10 | yes |
| Ring | 56 | 162 | 12 | no |

**Ring, ammo and aura are omitted from the editor's panel** (Cody,
2026-07-29) because none of them puts geometry on the body, and this panel
exists to dress a player we render. The client corroborates two of the three:
`Equipment.DISABLED_SLOTS` flags exactly indices **12 and 13**, and
`getMeshModifiers` skips a flagged slot before it even reads the item. An aura
is a graphical effect around the player, not a worn mesh. Their coordinates
are kept in the table above (and in a comment in `equipmentSlots.ts`) so they
can be restored without re-reading the interface.

**The slot identities are NOT in the interface.** Every container is an
anonymous box with `typeId 0`, no `opBase` and no menu ops; its item holder
(the 0x0 sprite child) is filled by CS2 at runtime, so the client binds slots
by script. The geometry is unambiguous — it is the classic arrangement — and
the indices above are darkan `Equipment`'s own constants (HEAD 0, CAPE 1,
NECK 2, WEAPON 3, CHEST 4, SHIELD 5, LEGS 7, HANDS 9, FEET 10, RING 12,
AMMO 13, AURA 14). Aura/Ammo are the two least certain, being the RS3
additions. Indices **6, 8 and 11 have no box**: they are the arms, hair and
beard positions, which only identikits ever fill.

**Equipment and identikits share ONE index space** — the 15-wide appearance
array. An equipped chest at index 4 displaces the torso kit that otherwise
sits there, which is exactly what `Appearance.generateAppearanceData` encodes.
A `parent` field in the dump is the packed hash `interfaceId << 16 |
componentId` (25362436 = 387<<16 | 4), which is how the slot containers were
matched to their item holders.

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

## Vorbis (JS5 index 36) — EMPTY in this cache, but the format is traced

Investigated 2026-07-30. `main_file_cache.idx36` is **0 bytes**, so the index
holds no archives at all — reading it through cryogen's store returns 0 files /
0 bytes. There is nothing to dump, and a dumper would produce an empty folder.
This is the same situation as `config_sun`: the index exists in the format, the
revision just ships no data for it. Don't take "cryogen has no dumper for
vorbis" as the reason — the reason is that there is no data.

**And nothing needs it.** A cutscene's `PLAY_VORBIS` action does NOT read index
36 — "vorbis" is the format (a streamed Ogg sample) as opposed to index 4's
additive synth, not an index name. `CutscenePlayVorbis.perform` calls
`AreaSoundPlayer.playSoundVorbis`, which builds an `AreaSound` of **type 2**;
`AreaSound.spoken()` is `type == 2 || type == 3`, and the update loop branches
on it: type 1 reads `Resource.SOUND_EFFECT` (index 4, `AreaSoundPlayer:59`),
`spoken()` reads `Resource.MIDI_INSTRUMENT` (index 14, `:67`). Confirmed
against the dump — all 81 distinct soundIds across the cache's 116 PLAY_VORBIS
actions exist in `midi_instruments`, where only 54 exist in `sound_effects`.
Type 3 is voice-over, which is why the field is called "spoken".

If a cache revision that DOES populate it ever turns up, the work is small,
because the container is already traced from darkan's
`config/midi/instrument/MusicSample.kt` (`decode`, line ~293):

```
int  sampleRate
int  sampleCount
int  start
int  end          // if < 0: end = ~end and loopConsistency = true
int  packetCount
packetCount x {
  size = 0; do { b = u8; size += b } while (b >= 255)   // 255-chained length
  byte[size] packet
}
```

Notes for whoever builds it:

- Index 36 is registered as a **two-level** provider — darkan's
  `ClientStartup:228`, `Resource.createProvider(IndexReference.INDEX_36, true, 2)`
  — so entries are addressed (archive, file), and `MusicSample.list` takes both.
- The Vorbis **setup data** (codebooks, floors, residues, mappings, modes) is
  `static` on `MusicSample`'s companion object and loaded once by
  `initializeData(data)`, so one entry is a shared setup blob and the rest are
  per-sample packet streams. A dumper must keep them distinguishable.
- These are **raw Vorbis packets, not Ogg** — there is no `OggS` framing, so a
  browser `<audio>` element cannot play a dumped file directly. Playback needs
  either a remux into an Ogg container using the setup blob, or a port of
  `MusicSample`'s decoder (~600 lines of MDCT + codebook work, itself derived
  from `stb_vorbis.c`).

## Three object fields whose dumped names were wrong (RENAMED 2026-07-29)

Traced against darkan's `ObjectType.kt` and its consumers while adding the
objects page's field tooltips. All three were renamed **in cryogen**, and
`migrateObjectDef` in `src/loaders/objects.ts` reads either spelling so older
dumps keep working.

| was (cryogen) | now | opcode | what it actually does |
| --- | --- | --- | --- |
| `blocks` | `blocksProjectiles` | 17 / 18 | stops projectiles. Walking is `clipType` (darkan's `blocksMovement`). The class also has a `blocksProjectiles()` accessor — `Region.java` calls it in 12 places for wall/object clipping, which is worth a second look, because it is feeding the PROJECTILE flag into movement clip maps |
| `obstructsGround` | `forceDisplayDecoration` | 73 | the opposite of the old name: it FORCES a ground decoration to draw even when the player has ground decorations switched off (`SceneGraph:87` and `:219`, alongside `hasActions` and `blocksMovement`) |
| `hasAnimation` | `forceNonStationary` | 98 | **not** "has an idle animation" — that is opcodes 24/106, read via `isAnimated()`. Opcode 98 is one of five independent ways to fail `SceneGraph:216`'s stationary test, so an object that already animates leaves it false. Note darkan shares the bad name, so this one is our coinage, not the reference's |

**Ordering trap.** Gson ignores JSON keys the class no longer has and the
no-arg constructor supplies the defaults, so packing a pre-rename dump with the
renamed cryogen silently resets all three. Re-dump `objects` before packing.

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

## Spot animation display fields — the full render recipe (TRACED 2026-07-30)

`SpotAnimationDefinitions.rasterize` (darkan-game-client) is short enough to
read end to end, and it settles the *order* the five display fields apply in —
which is what a preview has to get right, because scaling before posing is not
the same as scaling after.

| dumped (cryogen) | client field | opcode | decode | applied |
| --- | --- | --- | --- | --- |
| `modelId` | `defaultModel` | 1 | bigsmart | `RSMesh.decodeMesh`, then `upscale()` when `version < 13` |
| `sequenceId` | `animationId` | 2 | bigsmart | `animation.rasterize(rasterizer, 0)` |
| `scaleXZ` | `anInt6976` | 4 | ushort, default 128 | `resize(scaleXZ, scaleY, scaleXZ)` — **X and Z share one value** |
| `scaleY` | `anInt6971` | 5 | ushort, default 128 | same call |
| `rotation` | `anInt6978` | 6 | ushort | whole **degrees**, and only 90 / 180 / 270 do anything (`f(4096 / 8192 / 12288)` — 16384 units to a circle). Every other value is silently ignored. |
| `ambient` | `anInt6979` | 7 | **unsigned** byte | `createMeshRasterizer(…, ambient + 64, …)` |
| `contrast` | `anInt6981` | 8 | **unsigned** byte | `createMeshRasterizer(…, …, contrast + 850)` — see the table above; no `·5` |
| recolour / retexture pairs | 40 / 41 | | | `recolour(from, to)` / `retexture(from, to)` on the rasterizer, **before** the pose |

The sequence is: decode mesh → pre-13 upscale → build rasterizer with the
ambient/contrast pair → recolour/retexture → **pose** → **resize** → **rotate**
→ ground contour. So resize and rotation act on the *posed* mesh, which is why
`SpotAnimationViewer` hands them to `ModelViewer` as a render transform
(`WorldRenderParams`, applied to the pose group) instead of baking them into
the vertex buffer the animation rewrites each frame. Recolours go the other
way — they precede the pose, so they're baked into the mesh at load.

**Editable today** in `SpotAnimationViewer`, all five live-previewed in the
right-hand panel along with the recolour pairs. **Not previewed:** the ground
contour (`contourType`/`contourModifier`, opcodes 9–16 → `aByte6982` /
`anInt6980`) needs real terrain under the model, and `replay` (opcode 10,
`aBool6968`) is a spawn-behaviour flag with nothing to draw.

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

## Cutscene EXECUTE_SCRIPT — the fields are arguments, not ids (TRACED 2026-08-01)

**What the client does with it.** `CutsceneExecuteScript.perform()` calls
`CS2Executor.executeCutsceneScript(CURRENT_CUTSCENE, string, int)`, which looks
the script up **from the cutscene id**, not from the action:

```kotlin
val script = CS2Script.getScript(ClientTriggerType.RUN_CUTSCENE_SCRIPT, cutsceneId, -1)
executor.objectLocals[0] = scriptParam   // the string
executor.intLocals[0]    = intParam      // the number
```

and `getScript` composes `triggerId or (scriptId shl 10)` with
`RUN_CUTSCENE_SCRIPT = 20` — so for cutscene 1 that value is 1044.

**That number is matched against a name HASH, not used as an id.** Every archive
in a JS5 reference table carries a 32-bit `nameHash` field (cryogen:
`ArchiveReference.getNameHash()`), and a lookup is a linear scan for the archive
whose hash matches — `Js5ResourceProvider.getFileId` on the client,
`Index.getArchiveId` in cryogen, the same scan with
`CacheUtil.getNameHash("m43_50")` for maps. For a triggered script the composed
value is compared against that column directly, rather than hashing a string.
`getScript` tries three in order: `triggerId | (scriptId << 10)`, then
`triggerId | ((alternateId + 65536) << 10)`, then the global
`triggerId | 0x3fffc00`.

**MEASURED against this cache (2026-08-01), and the answer is that cutscene
scripts don't exist here.** Of 6,566 hashed CS2 archives, 350 fall below 2^26
where composed values live (uniform 32-bit noise predicts ~102), and their low
10 bits pile onto exactly two numbers: **trigger 10
`MINIMENU_CLICK_MEC_OPTION1` (204 scripts)** and **trigger 17 `MEC_MOUSE_OVER`
(65)** — map-element click and hover handlers. Everything else carries an
ordinary jaghash of a string. **Trigger 20 `RUN_CUTSCENE_SCRIPT` has no archive
under any of the three composed values**, so `getScript` returns null and
`executeCutsceneScript`'s `if (script != null)` falls through. Cutscene 1's two
lines of dialogue are in the data and nothing in this cache displays them.

**Which fields drive it.** `cutscenes/<id>.json` → the action's
`scriptStringParam` and `scriptIntParam`. Both are just the script's first
string and int locals. Only cutscene 1 uses this action, twice.

**Cryogen now dumps `cs2/name_hashes.json`** (`archiveId → nameHash`, non-zero
only) — added 2026-08-01, since the dump wrote `cs2/<archiveId>.cs2` and threw
the hash away, which made all 269 triggered scripts unreachable. It doesn't help
cutscenes, which have none, but it's what lets a map element's click and hover
handlers be found. `cs2/1044.cs2` is a chat-line builder writing to chatbox
component 137 — a coincidence of numbering, not the hook.

**What the int looks like (INFERRED, 2 samples — not traced).** It tracks the
text length almost exactly:

| text | chars | int | per char |
| --- | --- | --- | --- |
| "Lord Saradomin, is that you? I feel so cold." | 43 | 155 | 3.60 |
| "Be healed, my loyal commander." | 29 | 106 | 3.66 |

which reads as a subtitle display duration in client cycles (~72ms/char → 3.1s
and 2.1s). It can't be confirmed — no script consumes it in this cache.

**What is already editable.** Nothing — `CutsceneViewer` shows both fields
read-only, and the preview doesn't run the hook.

---

## Cutscene entity movement — pace, facing and the BAS sequence (TRACED 2026-08-01)

**What the renderer does with it.** A cutscene walk (`BASIC_MOVEMENT`) queues a
route of steps, each with its own *pace*, and the client's mover
(`EntityUpdating`, darkan-bot-refactor) drives three things off that pace: how
fast the entity travels, which BAS sequence plays, and — separately — whether it
turns to face where it is going.

**Which cache fields drive it.**

- `cutscenes/<id>.json` → `movements[].movementTypes[]`, one per step. The
  client maps them in `CutsceneEntityMovement.move`: **0 → HALF_WALK, 2 →
  RUNNING, anything else → WALKING**. This is the real pace source.
- `npcs/<id>.json` → **`movementType`** (opcode 128) is a red herring. Both the
  bot deob *and* `darkan-game-client`'s `NPCDefinitions` parse opcode 128 and
  throw the value away — it is server-side. Cutscene 2's killer (14623) has
  `movementType: "RUNNING"` and its route is all type-2 steps, so the two agree,
  but only the route is doing any work.
- `npcs/<id>.json` → **`turnDirection`** (default **32**) is the turn gate:
  `CutsceneEntity.move` sets `entity.turnDirection = def.turnDirection << 3`,
  and `PathingEntity.turn(rotation)` only re-faces when
  `bas.yawAcceleration != 0 || turnDirection != 0`. Nearly every NPC has 32, so
  nearly every NPC turns; a handful of deliberately fixed characters (cutscene
  15's Will Shakenspear 15535, Essjay 15532, Minnie Coop 15533) have 0.
- `config/bas/<id>.json` → `walkAnimation` / `runningAnimation` /
  `teleportingAnimation` (the client calls them walkSequence / runningSequence /
  teleportSequence). `PathingEntity.animateMovement` takes the running sequence
  for a RUNNING step and the teleport one for HALF_WALK **when they are not -1**,
  else the walk. The `*Dir1/2/3` and `*TurnCcw/Cw` variants are sidestep and
  turning-in-place versions we do not use yet.

**Speeds, exactly.** `positionDelta = 16` fine units per *client cycle*, `<< 1`
for RUNNING and `>> 1` for HALF_WALK — so 16 / 32 / 8. The catch-up speedups for
a backlog of queued steps (24, 32) are all gated on **not** being in a cutscene.
Movement is applied **per axis independently**, so a diagonal leg covers both
axes at full speed. Not modelled by us: the client halves the delta again while
an entity is still turning (`delayMovement`), which needs gradual yaw.

**The angle space, which is easy to get 180° wrong.** MOVEMENT's `direction`,
`ROTATE_CUTSCENE_ENTITY`'s `rotation` and the per-step facing all live in one
space: **south 0, west 4096, north 8192, east 12288**. Two independent
confirmations in `EntityUpdating`: the 8-way step table
(`startX < endX && startZ > endZ → 14336`) and the face-an-entity `atan2`, which
is passed **self − target** — the bearing *away* from what it faces, i.e. the
same +8192 offset. The step facing is snapped to those eight directions by the
SIGN of the delta, never a continuous bearing, so a 2×1 step still faces a clean
diagonal. Our conversion to three.js is `yaw = -(angle / 16384) * 2π`, which is
correct given the scene puts north at -z.

**What is already editable.** Nothing. `CutsceneViewer` shows the route table
(tile + pace name) and the cast, all read-only.

**What is not surfaced.** Per-step pace editing, the BAS sequence set, and
`turnDirection` (which the NPC page does not show either, despite being the
difference between a character that pivots and one that glides).

**Gotchas.** `turnDirection` is *not* the def's `contrast` — we mistook the two,
and since `contrast` is the lighting field this both froze the facing of most
entities and let the few it caught expose a separate 180° error in the walk
bearing. If an entity looks like it is moonwalking, check the pace→sequence
mapping first: a RUNNING step animated with the walk cycle moves the feet at
half the speed of the ground.

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
