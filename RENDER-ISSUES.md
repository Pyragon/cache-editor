# Render issues — visual punch list

Scratch list of things that don't look right in the 3D map view yet.
Deliberately **not** in `TODO.md` — this is a short working list to burn down,
not the long-form project log.

## Lighting / materials
- **HDR overbright only works for constant-fill materials.** `Class66` uploads
  an `hdr:true` texture as a **float** texture (`renderMaterialPixelsF`) and
  `MaterialDefinitions.renderFloatPixels` scales colour by `(1 + hdrOp·31/4096)`
  — up to **32×**. Our 8-bit PNG dump can't hold that, so the scalar is applied
  to the material instead, but only a **constant-fill** op collapses to a single
  scalar: **87 of the 367** hdr materials. The other 280 are real op graphs whose
  per-pixel HDR channel we don't evaluate, so they render at 1× and never reach
  the bloom threshold. Needs either a cryogen change to bake the multiplier into
  the dump, or evaluating the op graph on our side. (Bloom itself is done —
  `clientBloom.ts`, params from the region `Atmosphere`.)
- **Verify the 0.7 texture gamma.** `Class66` loads normal textures via
  `renderTexturePixels(id, 0.7F, …)` but SKIPS that scale for `blendType==2` and
  `effectId ∈ {1,7}` textures (those use `renderMaterialPixelsI`). Our
  `renderMaterial` defaults to `gamma = 0.7` for everything — check the dumped PNGs
  match per-texture; a systematic offset here would read as a lighting bug.
- **effectId 7 — the sky env-map reflection — isn't implemented.** Traced
  2026-07-25 alongside the effectId 1 specular (which *is* done, commit
  `7dcc23f`). `Class141_Sub7` binds the scene's sky cubemap (`method13596()`)
  with `GL_NORMAL_MAP` texgen and the world matrix on the texture stage, then
  combines `INTERPOLATE` with the material alpha as the factor:
  `rgb = mix(base, sky, texture.alpha)`. Needs a sky cubemap we don't build —
  the procedural sky would have to be rendered into one. Until then those
  materials just get the alpha drop, so reflective surfaces read flat.
- **Model lighting** not calibrated against the live client.
- **The "lighting detail" setting is unexplored** and reportedly makes things
  look far better. Find what it switches on in the client — likely the branch
  that decides baked vs per-pixel lighting. Affects the point lights below, but
  probably not only them.
- **Point lights** — implemented 2026-07-25 but **not yet signed off**. Region
  `lights[]` are baked into loc vertex colours (`buildLightGrid` in mapScene.ts,
  the point-light term in `computeModelLitRgb`). Locs only, which matches the
  client: only the Model shader declares `PointLights*`, and `HardwareGround`
  always passes a light count of 0. Flicker is baked at intensity 1.0 — the
  client's value with "Flickering effects" off; animating it needs the lights as
  shader uniforms rather than baked colours. What the eyeball pass turned up is
  below.

### Point lights — the eyeball pass (2026-07-25)
Compared against the live client. Reach was the first item here and is now
**signed off** (`wallLightTiles` in mapScene.ts — walls read the light grid at
the tile their visible face points into, not the tile they sit on; the full
trace is in `EDITOR.md` under "Region point lights"). Watch for its one
deliberate divergence as you go: the client re-picks that tile per frame from
the camera, which a baked renderer can't, so we take both tiles — a wall
between a lit room and a dark one lights on both faces. Still open:
- **Intensity is too hot and doesn't blend.** The pool reads as a bright patch
  sitting *on* the tile instead of mixing into it — same two screenshots. Could
  be the intensity scale, could be that we bake into vertex colours so the
  falloff is only as smooth as the tessellation.
- **Flicker.** The dumped light record's flicker field looks data-only
  <https://i.imgur.com/bNPahmX.png> and we always bake full intensity, as
  though "Flickering effects" were off. Open question: is that just because we
  haven't implemented the setting, or does the field mean something else?
  Trace the client before building anything. **Wanted editable either way.**

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
