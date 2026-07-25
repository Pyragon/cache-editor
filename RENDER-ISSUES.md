# Render issues — visual punch list

Scratch list of things that don't look right in the 3D map view yet.
Deliberately **not** in `TODO.md` — this is a short working list to burn down,
not the long-form project log.

## Flames / candles
Traced 2026-07-25. Flames are **not** additive — model faces never set a blend
mode (`HardwareRenderer.method14004` fixes the 3D pass to alpha-blend; additive
`ONE,ONE` is only reachable from `NativeSprite_Sub3`, i.e. 2D sprites). Don't
chase that again.

The flame turned out to be **three** things, all now done:
1. **Shape/transparency** — the type-5 face-alpha animation. Texture 110's opacity
   op is a constant 4096 (fully opaque) and the model has no baked `faceAlpha`, so
   anim 477 (alpha 128–216 ⇒ ~15–50% opacity) is the only source.
2. **Overbright + bloom** — texture 110 is `hdr:true` with a constant-fill HDR op
   (`fillValue 401` ⇒ `1 + 401·31/4096` = **4.03×**). The client's FilterBloom is
   ported verbatim (`clientBloom.ts`), and its params come from the region's
   `Atmosphere` (map-environment opcode 2).
3. **Emissive shading** — the last piece, and the one that made everything else
   look wrong. Gouraud shading spread the flame's faces over a **16× range**
   (max-channel 0.062 … 1.000, avg 0.548). After 4.03× the bright faces clip to
   pale yellow but the dark ones sit at ~0.25 — the orange band the client doesn't
   have. HDR faces now take their colour at full value and skip the directional
   term (`unlitHdrFaces`).

Note for future digging: the flame's **runtime** face colours are not the model's
baked ones — the object def runs `applyRecolor` (935878's four baked colours become
two: h0/l51 and h10/l64). Read colours after recolour, not from `model.dat`.

## Lighting / materials
- **HDR overbright textures + bloom** — the flame's *glow*, and the bigger half of
  the flame job. `Class66` uploads a texture with `hdr:true` as a **float** texture
  (`renderMaterialPixelsF`), and `MaterialDefinitions.renderFloatPixels` scales
  colour by `(1 + hdrOp·31/4096)` — up to **32×** overbright (texture 110's hdr op
  is a constant 401 ⇒ **~4.03×**). Bloom then picks it up (`FilterBloom` is in the
  shader dump; there's a `bloom` preference). **Our 8-bit PNG dump has flattened
  this**, so it needs (a) a cryogen change to dump HDR textures preserving the
  multiplier + a re-dump, and (b) float textures, an HDR render target and a bloom
  post-process on our side.
- **Verify the 0.7 texture gamma.** `Class66` loads normal textures via
  `renderTexturePixels(id, 0.7F, …)` but SKIPS that scale for `blendType==2` and
  `effectId ∈ {1,7}` textures (those use `renderMaterialPixelsI`). Our
  `renderMaterial` defaults to `gamma = 0.7` for everything — check the dumped PNGs
  match per-texture; a systematic offset here would read as a lighting bug.
- **Model lighting** not calibrated against the live client.
- **Point lights** — implemented 2026-07-25 but **not yet signed off**. Region
  `lights[]` are baked into loc vertex colours (`buildLightGrid` in mapScene.ts,
  the point-light term in `computeModelLitRgb`). Locs only, which matches the
  client: only the Model shader declares `PointLights*`, and `HardwareGround`
  always passes a light count of 0. Flicker is baked at intensity 1.0 — the
  client's value with "Flickering effects" off; animating it needs the lights as
  shader uniforms rather than baked colours. Needs an eyeball against the live
  client (Lumbridge torches/fireplace are the obvious test).

## Geometry / placement
- **Missing objects** — some locs don't render at all.
- **Signposts** render incorrectly.
- **Torches in Lumbridge** are rotated wrong.
- **The bridge** looks off.

## Terrain / water
- **The river still looks off** (separate from the un-signed-off water colour
  already tracked in `TODO.md`).
- **Willow transparency** — better than it was, but still not matching in-game.

## Animation
- **The cooking goblin's animation** looks wrong.
