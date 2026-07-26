# EDITOR.md — turning what the renderer knows into things you can edit

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
