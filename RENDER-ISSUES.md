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
- **Willow transparency** — better than it was, but still not matching in-game.
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
