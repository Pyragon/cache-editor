# Render issues — visual punch list

Scratch list of things that don't look right in the 3D map view yet.
Deliberately **not** in `TODO.md` — this is a short working list to burn down,
not the long-form project log.

## Lighting

Moved to **`docs/lighting.md`** on 2026-07-26. Sun, tone mapping, lighting
detail, point lights (loc and ground), per-object ambient/contrast, HDR
materials and texture gamma all turned out to be one interlocking job rather
than a punch list — two attempts have been reverted for taking an item on its
own — so it gets a document instead of bullets here.

## Terrain / water
- **The river still looks off** (separate from the un-signed-off water colour
  already tracked in `TODO.md`).
- **Willows — FIXED 2026-07-26 (pending Cody's sign-off); the residual is
  fog.** It was never transparency: the loc bake used the wrong shader family's
  formula (`1_31.vert`'s half-Lambert instead of the scene shader
  `1_12.vert`'s two-sided sun/anti-sun) with invented constants, leaving every
  loc ~2.2× darker than the client at the same lighting-detail setting. Fixed
  in `computeModelLitRgb`/`DEFAULT_MODEL_SUN`, verified with the render rig
  (`scripts/render-rig/`) against the client screenshot pair: willow fronds
  now match within 6% with correct hue (78,79,48 vs 74,74,48). The ground was
  deliberately left alone — it already matched. Full story in
  **`docs/lighting.md`**.

  The remaining measured difference — distant foliage hazing toward pale
  blue-grey (~15-18% mix) — was **distance fog, implemented 2026-07-26**:
  client-formula linear fog from the region's fogColour/fogDepth, live Fog
  toggle + Draw distance slider in the gfx panel (the client's far plane is a
  graphics setting we can't read; ~24 tiles matches a client-like zoom).
  Details in `docs/lighting.md`.

  **And the leaf COLOUR itself was a third, separate bug, also fixed
  2026-07-26: the textured-face grey-mix (`shadowFactor`).** Leaf sprites are
  self-coloured textures; the client replaces the face colour with
  ambient-grey for them (`method14282`, factor = texture def's misnamed
  `alpha` field — see EDITOR.md) so the sprite's green stands alone. We
  multiplied green texture × green face colour — leaves dark and oversaturated
  (canopy 52,63,17 vs client 71,76,40) even with lighting and fog right.
  With the mix ported: canopy 76,80,43 — within 5%, correct hue.

  While comparing, discount our marker diamonds (cyan = map-sprite anchors,
  which every tree carries) — toggle markers off for a fair side-by-side.
  Tree canopies are separate locs on **plane 1** — enable it or every tree is
  a bare trunk.
- **Walkways bleed into the grass** — all three mechanisms now ported; kept on
  the list because Cody's verdict was "looking okay", which is not a sign-off.
  The original note here guessed the walkway was simply *bigger* in-game; that
  was wrong, it's a blend. Full trace in **`docs/terrain-blending.md`** — read
  that before touching `emitTile`.
  - **Mechanism 1, the perimeter blend** (commit `2562f34`) — a tile's 8 ring
    vertices take a neighbouring blendable overlay's colour AND texture AND
    scale.
  - **Mechanism 2, the tile-shape families** (commit `2562f34`) — the two
    missing families that subdivide the underlay side of shaped tiles. Straight
    borders and most diagonals matched after these two.
  - **Mechanism 3, the intra-tile blend** (commit `271e9bd`) — four lines in
    `Class329.method5851`: on a tile whose own overlay blends, an underlay
    vertex the overlay's shape covers takes the overlay's colour, texture and
    scale. No `i_34 < 8` guard, so unlike mechanism 1 it reaches the interior
    vertices and the tile centre — which is why the coverage table is 13 wide.
    That was the hard arc on shape 9/10 (tile 3225,3223).
  **Two earlier write-ups of mechanism 3 in this file were wrong** — first
  "the client draws each tile once per distinct material over its whole vertex
  set", then "vertex welding spans the overlay/underlay split". Both are dead;
  the second is *refuted* in the trace doc, not merely unported (the weld key
  carries both colours, so it can only merge vertices that already agree — it
  cannot build a gradient). Don't re-derive either from the screenshots.
  **What to eyeball before signing this off:** the blend now bleeds noticeably
  further than it used to — a full half-tile ramp to the far corner. If it
  reads as too *wide* rather than too hard, the suspect is the `hasOverlay`
  stand-in for the client's discard test, not the coverage table. Remaining
  approximations are listed under Maps in `TODO.md`.

## Locs / transparency
- **Broadleaf canopies render SEE-THROUGH (Cody, 2026-08-07, generated island).**
  The canopy is transparent enough to see a neighbouring evergreen through it,
  where the evergreen beside it reads solid. Screenshot:
  `ShareX/Screenshots/2026-08/opera_gIkIKnVmYp.png`.

  Measured, so the ids are not in doubt. Affected:

  | trunk | canopy | `lift` | footprint | reads as |
  |---|---|---|---|---|
  | Oak `#38731` | `#38736` | 1 | 3 | **see-through** |
  | Tree `#70060` | `#70061` | 1 | 3 | **see-through** |
  | Evergreen `#54787` | `#54795` | 1 | 2 | solid |

  **That split is the most useful thing here**: all three are ordinary plane-1
  canopies emitted by the same code path with the same `lift`, so placement is
  not the variable. Two broadleaf canopies fail and the conifer does not, which
  points at the model or its material rather than the renderer's geometry — and
  gives whoever fixes it a control to compare against.

  First thing to check is texture alpha — see the alpha re-dump watch-out in
  `TODO.md`: foliage is drawn with a fixed `alphaTest` 0.35 cutout on textured
  terrain and `faceAlpha != 0 || blendType != 0` decides transparency on locs,
  so a canopy whose texture alpha sits in the middle of that range would thin
  out exactly like this. Compare `#38736`'s texture alpha against `#54795`'s
  before touching any renderer code.

- **`Tree #38760` has no canopy — and that is what our data says, so verify it
  against the map before calling it a render bug.** In the same shot a trunk
  stands bare. The scenery index records **`NO CANOPY RECORDED`** for `#38760`,
  along with `#1301`, `#1304`, `#38783` and `#38785` — while `#70060` → `#70061`
  and the oak/evergreen pairs above are recorded fine.

  So either those trunks genuinely carry no plane-1 loc in the real map, or
  `CANOPY_MIN_RATE` (0.5 in `scenery.ts`) is rejecting a real pairing that
  happens less than half the time. That threshold was chosen so a tree standing
  under a bridge once doesn't teach us trees carry bridges; it has never been
  checked against a species that legitimately pairs at, say, 0.3. Measure the
  actual pair rate for `#38760` in `maps/` before changing anything — if it is
  genuinely unpaired, this is correct behaviour and the entry can be deleted.

- **Static locs don't priority-interleave opaque and transparent faces.**
  The client bakes ONE face order per model — priority →
  opaque-before-transparent → effectId → texture (`MeshRasterizer_Sub3` ctor,
  flag 0x100 puts opaque faces into the priority sort too) — and draws it in a
  single pass with z-write always on, so a transparent face occludes anything
  sorted after it (Lumbridge fountain: priority-5 basin water hides the
  priority-6 submerged interior outright). The **animated** loc builder now
  reproduces this (2026-07-27, the fountain fix). Static locs still split
  differently: opaque faces go to the global merged opaque mesh (drawn before
  the ground pass) and only transparent faces reach the per-loc sortable mesh
  (depthWrite off), so a static loc with the fountain's pattern would show its
  interior through the water. Fixing it means routing a whole qualifying loc —
  opaque faces included — into its own client-ordered mesh with z-write on,
  like the animated path. No known victim loc yet; find one before building
  the fix so it can be verified.
