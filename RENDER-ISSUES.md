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
Compared against the live client, all still open:
- **Reach is too short.** A torch should light the locs *around* it, not just
  the one it's on. In-game <https://i.imgur.com/NNKWvLI.png>, viewer
  <https://i.imgur.com/pv1RHbm.png>. Radius comes from `size2d` (see the point
  lights note in memory) — worth re-checking that against the client rather
  than assuming the falloff is what's wrong.
- **Intensity is too hot and doesn't blend.** The pool reads as a bright patch
  sitting *on* the tile instead of mixing into it — same two screenshots. Could
  be the intensity scale, could be that we bake into vertex colours so the
  falloff is only as smooth as the tessellation.
- **Flicker.** The dumped light record's flicker field looks data-only
  <https://i.imgur.com/bNPahmX.png> and we always bake full intensity, as
  though "Flickering effects" were off. Open question: is that just because we
  haven't implemented the setting, or does the field mean something else?
  Trace the client before building anything. **Wanted editable either way.**

## Geometry / placement
- **Signposts** render incorrectly — specifically **green blocks** on them.
- **The bridge** looks off.
- **The stairs up to Lumbridge castle** are still wrong. Been on the list a
  while and never actually fixed.

## Terrain / water
- **The river still looks off** (separate from the un-signed-off water colour
  already tracked in `TODO.md`).
- **Willow transparency** — better than it was, but still not matching in-game.
- **Walkways bleed into the grass.** <https://i.imgur.com/AWCJFyW.png> — and
  note the diagnosis: in-game the walkway is simply **bigger**, so this is not
  a crossfade/blend-strength bug to tune. The overlay is covering the wrong
  tiles or the wrong shape within them. Check the overlay shape/rotation split
  before touching any blending.
