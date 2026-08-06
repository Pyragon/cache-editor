# Lighting

Everything about how the 3D map view lights a scene, and how far it is from the
client. Split out of `RENDER-ISSUES.md` on 2026-07-26 once it became clear this
is one large interlocking piece of work rather than a punch list — most of the
items below are the *same* problem seen from different angles, and several
cannot be done in isolation.

**Read the "Why it's one job" section before picking anything up.** Two separate
attempts have been reverted for taking an item on its own.

---

## Why it's one job

Three findings, traced independently, turn out to describe one system:

1. **The client's environment lighting runs well past 1.0 by design.** Lumbridge
   asks for ambient 1.30, light 2.0, backlight 0.359 — a fully lit vertex wants
   roughly **2.75×**.
2. **The client compresses that back down in a post pass**, not in the shading.
3. **"Lighting detail" is the switch that decides whether a region's own sun is
   used at all** — and the same flag turns on ground point lights.

So: you cannot port the environment sun without the compression working, you
cannot see the compression working while the bake clamps, and the setting that
enables all of it also enables a rendering path we don't have. Each piece looks
small alone and each has failed alone.

### The two reverts, so they aren't repeated

- **2026-07-25 — the sun formula.** `1_12.vert`'s
  `Ambient + max(0, N·L)·Sun + max(0, −N·L)·AntiSun` was ported verbatim, with
  `AntiSunColour` added to `ModelSun`, corrected defaults, and a
  `modelSunFromEnvironment()` feeding the region's real values in. In-scene the
  result was far too bright — every path pebble blew to white. Backed out the
  same day. The trace is good and is preserved below; only the result was wrong.
- **2026-07-26 — tone mapping in the bake.** An extended Reinhard was added to
  `computeModelLitRgb`, on the assumption the compression was missing. It isn't
  — see below — so this double-applied and shifted the whole scene brighter.
  Reverted. Then the bake's clamp was removed so the existing composite could do
  the work; correct in principle, but bloom got far brighter because today's sun
  already peaks at 1.3 and that headroom started crossing the bloom threshold.
  Also reverted.

**The lesson from both: any change here alters the whole scene's brightness at
once, so it needs a calibration pass against a real client screenshot in the
same commit — not afterwards.**

---

## State as of 2026-08-06 (PAUSED — close, not exact)

Four traced bugs fixed in one session (§§5-6 below have the detail). The scene
is much closer to the client and much warmer, but **Cody's verdict was "still
not exact"** and no pair has been measured since the last fix.

Fixed: the ground's invented neutral-grey + `255/avgLuma` boost (§5); the sun
colour being cancelled by a hardcoded `0xDDCCBB` baseline (§6); the brightness
slider rebuilding only the centre region, so it did nothing in a multi-region
view; the slider's range starting at 1 when the client's is 0..4.

**Start here next time: MEASURE, don't trace.** Take a viewer/client pair of the
same spot and compare per-channel means + luminance percentiles:

- deltas flat across percentiles ⇒ something ADDITIVE (fog, bloom, an ambient
  floor)
- deltas proportional to value ⇒ a lighting SCALE
- `client ÷ (viewer × candidate)` equal in all three channels ⇒ a missing
  COLOUR multiply — that is precisely how §6 was found in minutes after hours of
  source-tracing had missed it

The last measurement left ~1.08× (castle) / ~1.14× (kitchen) residual, but that
was taken BEFORE the sun-colour fix, so it is stale — re-shoot first. Suspects
not yet eliminated: fog strength/curve, the loc point-light bake (Cody reports
too bright), and the fact that ground point lights are absent entirely, which
changes what interiors should look like. Open items are listed in `TODO.md`
under "Lighting".

---

## Where the compression actually lives

`clientBloom.ts`'s composite already applies the client's tone map:

```glsl
postLum = (preLum * (1.0 + preLum / whitePoint)) / (preLum + 1.0)
```

and the composer's main target is already `THREE.HalfFloatType`, so values above
1.0 survive the scene render into that pass. **The tone mapping is not missing
and does not belong in the bake.**

What starves it is `computeModelLitRgb`'s final `Math.min(1, …)`: nothing above
1 ever reaches the composite, so the curve has nothing to compress and bright
surfaces flat-clip to white.

Two properties of that curve worth knowing before touching it: at `L = W` it
returns exactly 1 (the white point is literally "the luminance that reads as
white"), and at `W = 1` it reduces to `L(1+L)/(1+L) = L`, an exact identity — so
a region that doesn't override the default gets no compression at all.

**Removing the clamp is necessary but not sufficient.** Tried 2026-07-26:
today's sun already peaks at 1.3 (`hl·(0.7 + 0.3) + 0.3` with
`DEFAULT_MODEL_SUN`), so that headroom immediately crossed the **bloom
threshold** and the scene glowed far too much. The threshold needs re-tuning in
the same change — the client's own default is 1.0, but our blur normalisation
doesn't transfer 1:1 from `FilterBloom`, which is why those sliders exist.

---

## Lighting detail (TRACED 2026-07-26)

`LightDetailPreference` is a plain 0/1, **default 1**. It is not a quality
slider. Three consumers:

### 1. Whether the region's sun is read at all

`Atmosphere.method11468` reads the sun fields *only* when it's on; off, it reads
and **discards** them and substitutes constants. `Class239:121-122` maps them:

```java
renderer.IA((0.7F + brightness*0.1F + …) * atmosphere.aFloat7081);               // ambient
renderer.m(atmosphere.anInt7083, atmosphere.aFloat7082, atmosphere.aFloat7090, …); // colour, light, backlight
```

| | ambient (`aFloat7081`) | light (`aFloat7082`) | backlight (`aFloat7090`) |
|---|---|---|---|
| **off** — client constants | 1.1523438 | 0.69921875 | 1.2 |
| **on** — Lumbridge 12850 | 1.30 | 2.0 | 0.359 |

Off is flat and ambient-dominated: the backlight (1.2) *exceeds* the directional
term (0.699), so everything is filled from both sides, peaking around 1.85×. On
is strongly directional and peaks around 2.75×.

**We render the OFF mode, and as of 2026-07-26 we render it CORRECTLY — the
flat-mode fix below is DONE.** What was wrong, in two parts:

1. **The bake copied the wrong shader family's formula.** Both formulas exist
   in the dumped GLSL: `1_31.vert` (lowercase uniforms — a different family)
   has the half-Lambert `hl·(sun + amb·0.5) + amb·0.5` the bake used;
   `1_12.vert` (uppercase uniforms — the one `MeshRasterizer_Sub3` actually
   feeds) is two-sided: `Ambient + max(0,N·L)·Sun − max(0,−N·L)·AntiSun`.
2. **The constants were invented.** `Class239:142` is the client's flat call:

```java
renderer.m(anInt2935, 0.69921875F, 1.2F, -200f, -240f, -200f); // anInt2935 = 16777215, white
renderer.IA((0.7F + brightness*0.1F) * 1.1523438F);            // BrightnessPreference default = 3
```

| | client, low | old `DEFAULT_MODEL_SUN` | fixed |
|---|---|---|---|
| sun light | 0.69921875 | 0.7 | 0.69921875 |
| ambient | **1.1523438** | **0.6** | 1.1523438 |
| backlight (subtractive) | **1.2** | none | 1.2 |
| direction | (−200, −240, −200) | same | same |

Both are in `computeModelLitRgb` / `DEFAULT_MODEL_SUN` (`models.ts`). Verified
with the render rig (`scripts/render-rig/`) against the client screenshot pair:
**willow fronds went from ~2.2× too dark to matching within 6% with correct
hue** (client 78,79,48 vs ours 74,74,48). No unclamp or bloom retune was needed
after all — flat-mode values only exceed 1.0 on bright sunward faces, and the
client's own framebuffer clips those identically (whitePoint 1.0 = identity
tone map).

Two deliberate scope cuts, both load-bearing:

- ~~**The GROUND was left alone.**~~ **SUPERSEDED the same day — the ground was
  GroundSM-derived after all, and got its own hardware port.** Cody's suspicion
  was right twice: the file header literally said "GroundSM in
  darkan-bot-refactor", and the light grid was a half-Lambert. It had *appeared*
  to match because on flat unshadowed ground the two pipelines numerically
  coincide (0.578^0.7·1.604 ≈ 1.123 — a genuine coincidence that stalled the
  diagnosis). The real hardware ground (`HardwareGround.java:907-965`, low
  lighting detail — the path the reference client runs):

  ```
  strength  = 74 − staticShadow                    (byte b_51 = 74)
  lightness'= (hsl & 0x7f)·strength >> 7, clamp 2..126   ← shadow cuts the BASE
  f_53      = 1.152 + N·L·(N·L>0 ? 0.699 : 1.2)          ← full range, two-sided
  colour    = palette[hsl&0xff80 | lightness'] · f_53
  ```

  Ported 2026-07-26 (`computeVertexLightGrid` + the emitTile colour stage;
  textured tiles take the display-space equivalent of the strength cut since
  they have no lightness to scale). What changed visibly: the SHADOW CURVE
  (shadows deepen the base colour rather than scaling light — wall-shadowed
  areas like the castle courtyard get properly dark) and SLOPE CONTRAST (full
  ±N·L instead of half-Lambert compression — river banks now shade down toward
  the water like the client). Riverside reference: grass 62 vs client 63.
  At lighting detail HIGH the client instead sets ground flags 0x7 and lights
  in the shader — that variant belongs with the lighting-detail toggle work.
- **`ModelViewer`'s standalone previewer keeps its own inline copy of the old
  half-Lambert** — a separate page with its own calibration item (the contrast
  base, below). Changing every previewer's look is its own decision.

**Residual, now the biggest visible gap: FOG.** Post-fix, distant foliage still
reads darker/more saturated than the client (canopy 50,69,14 vs 76,85,38) —
mixing ours ~15-18% toward a pale fog colour reproduces the client values
almost exactly, and the client applies distance fog (`DistanceFogPlane` in
`1_12.vert`, region fogColour/fogDepth) that we don't render at all. Close-up
surfaces match without it.

**Second residual, found chasing "the leaves look drastically different"
(FIXED 2026-07-26): the textured-face grey-mix.** Leaf sprites (951/956/952 —
green leaf clusters with real PNG alpha) are SELF-COLOURED textures, and the
client's `MeshRasterizer_Sub3.method14282` replaces a textured face's colour
with ambient-grey (`ambient·0x020202`) by the texture's `shadowFactor` —
dumped by cryogen under the misnomer **`alpha`** (decode-order proof in
EDITOR.md). 255 = the texture's own colour stands (leaves); 0 = full face tint
(bark/detail maps). We multiplied leaf-green texture × leaf-green face colour:
double green, dark and oversaturated, at any lighting. Ported as
`texturedBaseRgb` (mapScene.ts) feeding `computeModelLitRgb`'s `baseOf`
override, including the def `brightness` byte's `(256+b)/256` post-mix boost.
Rig-verified: canopy 52,63,17 → **76,80,43** vs client 71,76,40; willow hue
R/G 1.01 vs client 0.98.

**Fourth finding, found via the fern (FIXED 2026-07-26): static locs are
CPU-LIT with per-def ambient AND contrast — the 1_12 uniforms path was never
the right model for them.** `MeshRasterizer_Sub3:3254` is the actual static-loc
lighting, a CPU bake into vertex colours (the mesh uploads with ShaderMode 3,
`DiffuseColour = 1`):

```
cos   = dot(sunDir, summedVertexNormal) / faceCount     ← AVERAGE normal
light = ambient(1.152) + cos · (cos<0 ? backlight : sunLight) · 768/contrast
out   = clamp(method14282(hsl, tex, 64+def.ambient) · sunColour · light)
```

Three consequences ported into `computeModelLitRgb`:
- **`768/contrast` scales both directional terms** — `contrast = 850 +
  def.contrast·5` (cryogen dumps the RAW byte; darkan pre-multiplies at
  decode). Higher contrast = flatter light; the name is backwards.
- **Per-def ambient and contrast are wired end to end** (addModel `light`
  param, `AnimatedLoc` records). The fern's `ambient 25 / contrast 15` and the
  willow's `35/50` were the remaining foliage darkness: ambient raises both the
  base lightness (`×(64+a)/128`) and the textured grey (`(64+a)·2`).
- **The cosine divides by the face COUNT, not the normal's length.** Where
  faces disagree (foliage), |average| < 1 and the directional response
  softens; renormalising over-lights curved silhouettes.

Rig-verified against the client screenshot pair at the willow base:
fern fronds 65,67,35 vs client 58,57,32 · rock 75,69,55 vs 73,65,56 ·
willow fronds 80,81,45 vs 80,82,57 (R/G exact; B is the fog-distance knob).

One knowingly-unported nuance: meshes with scale/mirror flags (`anInt8896 &
0x37`) skip the CPU bake and take the real shader path (1_12 uniforms — no
contrast divide) because their baked normals are stale. ~9% of placements are
mirrored; we CPU-bake everything. Revisit only if mirrored locs measurably
diverge.

**Third residual, found via the shoreline rocks (FIXED 2026-07-26): the
ambient lightness scale.** The client's vertex colour for EVERY loc face is
`palette[method14290(hsl, ambient)]` — lightness × ambient/128 (×0.5 at the
default 64, clamp 2..126) — and the shader's diffuse multiplies that. Baking
the full-lightness palette left every UNTEXTURED loc ~2× bright once the real
sun landed ("every pebble blew white" — the exact symptom that sank the
2026-07-25 port, now explained). Textured faces masked it: their grey-mix
already sits at the ambient-scaled grey (`64·2 = 128`). Fixed with the
existing `adjustLuminance` (=method14290) in `computeModelLitRgb`, and the
partial grey-mix base uses the scaled palette too, as method14282 does.
Rig-verified: shoreline pebbles dropped from white dots to the client's
grey-violet; the same-frame canopy moved 76,80,43 → 64,70,34, bracketing the
client's 71,76,40 (branches are sf=0 and correctly darkened).

### 2. Ground point lights

`Class329.method5834:234` is `if (aBool3780) sceneObjectManager.method3431()` —
the ground point-light registration. **"Lighting detail" and "the ground gets
point lights" are the same feature.** No lighting detail, no pooled light on the
floor.

### 3. Ground creation flags

`Class329:441,449` set `i_6 |= 0x2` and `i_7 |= 0x7` on `createGround`,
presumably the per-vertex lighting attributes (2) needs. `MapRegion:863,882`
apply the flag to the ground and to the high-detail water plane.

### 4. The HIGH ground pipeline, end to end (TRACED 2026-08-06)

The full `HardwareGround` fork, from vertex build to shader technique — the
"exact copies" pass:

**Build time** (`HardwareGround.java:897-1055`): every vertex colour starts as
the palette lookup `Class540.anIntArray7136[hsl & 0xff80 | lightness]` with
`lightness = (hsl & 0x7f) · (74 − staticShadow) >> 7`, clamped 2..126 — the
74-cut and the static shadow apply at EVERY detail level. Then:

- `(flags & 0x7) == 0` (LOW): the CPU bakes the directional term into the
  colour — `f = N·SunDir; f = ambient + f·(f > 0 ? sunLight : backlight)`
  (`:963-964`), rgb × f clamped per channel 0..255 (`:988-1012`). No normals
  in the VBO.
- `(flags & 0x7) != 0` (HIGH): the colour is written **unlit** (palette +
  shadow cut only) and the vertex **normal goes into the VBO**
  (`:1028-1047`) for the shader to light live.

Ground normals (`:81-88`): `normalize(dhx, −2·tileScale, dhy)` from ±1-tile
height gradients — flat ground points −y (up, RS y-down), so with Lumbridge's
sun the flat-ground N·L is **+0.968 — the sun branch**, both detail levels.

**Draw time** (`HardwareGround.java:503-627`): `(flags & 0x37) == 0` binds the
Model effect's `Unlit` technique (`method946` — vertex colours pass through).
Otherwise the sun uniforms are set (`:540-543`) and the per-texture-effect
switch picks a technique; the default case is
`aBool8779 ? method950() : method965(0)` where `aBool8779` is the underwater
flag — so normal HIGH ground is `method965(0)` = **`Standard_0PointLights` of
the "Model" effect** (`Class48_Sub2.method14567` names all 18 techniques:
0 Unlit, 1 Unlit_IgnoreAlpha, 2-6 Standard_N, 7-11 Specular_N,
12-16 EnvironmentalMapping_N, 17 UnderwaterGround).

**The shader** is the already-calibrated model family (`1_12.vert` — uniform
set matches `Class48_Sub2` exactly):
`Diffuse = Ambient + max(0,N·L)·Sun + max(0,−N·L)·AntiSun`, then
`× vertexColour`, saturated at the vertex stage. Uniform values
(`HardwareGround:540-543` + `HardwareRenderer.iw:614-651`):

- `SunDir` = normalize(sunPosition << 2)
- `SunColour` = `sunLight · sunRgb`
- `AntiSunColour` = `−backlight · sunRgb` (negative — away-facing dips below
  ambient)
- `AmbientColour` = `(0.7 + 0.1·brightnessPref + jitter) · sunAmbient · sunRgb`

Nothing rescales `sunLight`/`backlight` between the cache decode
(`Atmosphere.method11468` — `readUnsignedShort()/256`, gated on the lighting
pref) and the GPU. **So LOW and HIGH ground use the SAME two-sided formula —
only the constants and the evaluation site differ** — and the viewer's
`computeVertexLightGrid` already matches it term-for-term: same formula, same
normals, same dir sign, same 74/shadow cut.

### 5. What the light multiplies — the actual bug (FOUND 2026-08-06)

The formula was right; **the colour it multiplied was invented.** The ground's
vertex colour is not written in `HardwareGround` at all — it is handed to
`Node_Sub6.method12145(vertexIndex, colour, 74−shadow, lightFactor)`
(`HardwareGround:1072`), which is the ground's exact analogue of the model
path's `method14282`:

```java
if (textureId != -1) {
    sf = details.shadowFactor & 0xff;                 // dumped as `alpha`
    if (sf != 0 && details.effectId != 4) {
        grey = strength * 131586;                     // 0x020202 → strength·2 per channel
        colour = lerp(colour, grey, sf / 256);
    }
    b = details.brightness & 0xff;
    if (b != 0) colour = colour * (256 + b) / 256;    // saturating at 255
}
if (light != 1.0f) colour = clamp(colour * light);    // LOW only; HIGH leaves light at 1
```

So the grey a textured tile mixes toward is `(74 − shadow)·2` — **it darkens
with the tile's own shadow**, and the mix amount is per-texture. The model
version mixes toward the constant `ambient·2` (=128); that is the only
difference between the two.

What the viewer did instead, both invented:

1. `useTint` chose *neutral grey vs palette colour* off `detailsOnly` — a field
   that is really `isGroundMesh` and has nothing to do with colour mixing. So
   every ordinary textured tile got a flat neutral grey (≈0.68 in display
   space) where the client uses the tile's own, much darker, palette colour.
2. Detail maps were additionally scaled by `255/avgLuma` — up to another **2×**
   — to keep them "brightness-neutral". The client has no such term.

That is the blinding kitchen: grey instead of colour explains "white rather
than grey", and the two multipliers stack into the ~2× that only became
obvious once HIGH's `f ≈ 3.37` pushed the result past the clamp. **The same
bug was present at LOW all along** — at `f ≈ 1.85` it merely looked "a bit
hot" instead of clipping, which is why the empirical LOW calibration
(`GROUND_CUT_DISPLAY = pow(74/128, 0.7)`) papered over it. Both invented
constants are now deleted and `emitTri` calls the client sequence.

### 6. The missing sun COLOUR (MEASURED + FOUND 2026-08-06)

The colour fix in §5 helped but left the scene ~15-35% bright and far too cold.
Measuring Cody's two screenshot pairs (castle wall, kitchen) rather than
theorising gave the answer immediately:

| | R | G | B |
|---|---|---|---|
| viewer mean | 103.3 | 103.5 | 65.4 |
| **client mean** | **96.6** | **90.2** | **52.3** |
| client ÷ (viewer × `sunColour/255`) | 1.078 | 1.079 | 1.092 |

The same constant in all three channels ⇒ the residual is **exactly one missing
multiply by the sun colour**. Not a brightness scale — a *scale* would not land
all three channels on the same number, and the per-percentile deltas
(+12/+11/+11/+10/+10 through the darks and mids) were flat, which ruled out
bloom too (and `bloomThreshold` is 1.0039, which nothing reaches).

Cause: `sunTintFor` computed the tint **relative to a hardcoded `0xDDCCBB`**.
Lumbridge's sun is `0xDDCEBB` — one blue step away — so it returned ≈(1,1,1)
and cancelled the warm sun entirely. The client's baseline is WHITE
(`Class239.anInt2935 = 0xFFFFFF`, which is exactly what LOW substitutes), and
the real multiplier is the absolute `sunColour/255` = (0.867, 0.808, 0.733).

Fixed with `sunColourRgb()` (absolute), applied only at lighting detail HIGH —
at LOW the client's sun IS white, so tinting there would be wrong. Locs keep
taking it through the `modelSunFromEnvironment` bake (the `takesSunTint` guard
stops it double-applying); terrain, whose light grid is a scalar, takes it on
the material where it had been silently ≈1.0. `sunTintFor` is retained only for
`CutscenePlayer`, which still uses the old relative behaviour — **that is now
known-wrong and should be moved over once the map view is signed off.**

**Field-name warning.** The dump's `alpha` IS `shadowFactor`, and `detailsOnly`
IS `isGroundMesh`; the decode ORDER is identical in cryogen, darkan-bot-refactor
and the game client, so only the names are wrong — the data is correct. Both
are *signed* bytes in the JSON but the client reads them `& 0xff`, so
`alpha: -1` means shadowFactor **255** (near-total grey replacement — 630 of
2591 textures) and `brightness: -1` means a **2.0×** multiplier (202 textures).
Reading either without the mask inverts the meaning.

The client's model vertex shader (`shaders/glsl/1_12.vert`):

```
AmbientColour + max(0, N·SunDir)·SunColour + max(0, −N·SunDir)·AntiSunColour
```

An ambient term plus a **two-sided** sun/anti-sun pair.
`computeModelLitRgb` instead uses a half-Lambert (`(N·L)*0.5 + 0.5`) folded into
one term.

Uniforms come from `EnvironmentManager.applySun()`:

- `AmbientColour = sunRgb · (0.7 + brightnessPref·0.1) · env.sunAmbient`
- `SunColour = sunRgb · env.sunLight`
- `AntiSunColour = sunRgb · env.sunBacklight`

`MeshRasterizer_Sub3:3047` uploads **AntiSunColour negated**, so the back term
darkens rather than fills. `HardwareGround.java:964` does the same on the CPU
(`ambient + NdotL·(NdotL > 0 ? sunLight : backlight)`), which confirms the sign.

Measured before/after on the bridge wall models during the reverted attempt —
also why this is *not* the fix for the blocky-bridge complaint: surface tone
spread went 0.11..0.74 → 0.20..1.00 on model 48855 and 0.08..0.74 → 0.19..1.00
on 48853, 0% saturated either way. **It gets brighter; it does not get flatter.**

---

## Ground point lights (not implemented)

Corrects an earlier note that said the ground was "correctly excluded". It is
true that only the **Model** shader declares `PointLights*` and that
`HardwareGround` always passes a light count of 0 — but the ground has a
*separate* path:

`SceneObjectManager.method3431` calls
`aGroundArray2591[plane].method6713(lightNode, codes)` for every registered
light. `HardwareGround.method6713` queues a `Node_Sub8` that builds terrain
normals from the height field over the light's footprint and emits its own
geometry. `method3431` also derives the per-tile `codes` (1 = open, 2..5 = a
wall on a given side, from `getInteractableObject(...).aByte9454`) so
wall-shadowed tiles are carved out of the pool.

**Untraced past the `Node_Sub8` constructor.** This is why the floor under a
torch pools in-game and not here, and it's gated behind lighting detail.

---

## Loc point lights (implemented, not signed off)

Region `lights[]` are baked into loc vertex colours (`buildLightGrid` in
`mapScene.ts`, the point-light term in `computeModelLitRgb`). Locs only, which
matches the client's *shader* path. Flicker is baked at intensity 1.0 — the
client's value with "Flickering effects" off.

Reach is **signed off**: `wallLightTiles` — walls read the light grid at the
tile their visible face points into, not the tile they sit on. Full trace in
`EDITOR.md` under "Region point lights". One deliberate divergence: the client
re-picks that tile per frame from the camera, which a baked renderer can't, so
we take both tiles — a wall between a lit room and a dark one lights on both
faces.

Open from the eyeball pass:

- **Intensity is too hot and doesn't blend.** The pool reads as a bright patch
  sitting *on* the tile instead of mixing into it. Could be the intensity scale,
  could be that baking into vertex colours makes falloff only as smooth as the
  tessellation.
- **Flicker.** The dumped light record's flicker field looks data-only
  (<https://i.imgur.com/bNPahmX.png>) and we always bake full intensity, as
  though "Flickering effects" were off. Is that because we haven't implemented
  the setting, or does the field mean something else? Trace before building.
  **Wanted editable either way.**

### Agreed plan (2026-07-25): move point lights off the bake into the shader

The prerequisite for flicker. Traced end to end: `Class287.method5053`
recomputes each light's intensity every tick from the 16 presets in
`method5052`; `MeshRasterizer_Sub3` fills `[x, y, z, radius²]` and
`[r·i, g·i, b·i, 1]` for the ≤4 lights bound to an object and
`Class48_Sub2.method965(n)` uploads them as shader constants (one shader variant
per light count); `1_12.vert` consumes them as
`DiffuseColour += colour · (radiusSq / dot(L,L)) · max(0, dot(N, normalize(L)))`.
**The client never bakes them** — our vertex-colour bake is the approximation,
and it's why flicker is impossible today.

The port: (1) keep the sun/ambient bake, drop point lights from it; (2) add
per-vertex world normal, base palette colour and the loc's 4 light indices (the
selection already exists via `lightGrid.at()`, mirroring the client's per-object
binding); (3) hold the region's lights in a small `DataTexture`, not uniforms —
a region carries up to 255 (avg 30, max 255 in region 1097), past the
vertex-uniform limit; (4) patch the loc material with `1_12.vert`'s loop; (5)
light edits and flicker then become texture writes, so editing is live at 60fps
and Apply stops needing a rebuild.

Accepted trade-offs: sun and point terms combine in linear space rather than
today's pre-clamped sRGB bake, and emissive/HDR faces take no point light (they
already skip directional shading). **Atomic change** — locs lose the baked
lights and gain the shader in the same step.

---

## Per-object lighting fields we ignore

- **The map-scene loc bake ignores `def.ambient` / `def.contrast` entirely
  (2026-07-26).** `computeModelLitRgb` takes only a `ModelSun` — no ambient or
  contrast parameters exist on it — so per-object lighting tweaks in the cache
  do nothing in our scene. (`computeLitFaceRgb` in `models.ts` *does* take them
  and has no callers at all — dead code, or the start of the fix.) The client's
  values are `64 + ambient` and `850 + contrast·5`. Wiring them in belongs with
  the calibration work above, since both change the same numbers.

- **`ModelViewer`'s contrast base is the item-icon one, not the world one
  (VERIFIED 2026-07-26).** `ModelViewer.tsx:451` computes the diffuse scale as
  `768 / (768 + 5·contrast)`. The `·5` is right, but `768` is the base the
  client uses for **item icon** renders (`ItemDefinitions:552`) and unlit
  interface models. Objects, NPCs and in-world item models all use **850**
  (`ObjectDefinition:449`, `NPCDefinitions:268`, `ItemDefinitions:201`), so the
  preview should be `768 / (850 + 5·contrast)` — at contrast 0 we light at 1.0
  where the client lights at 0.903, i.e. every previewed model is ~10%
  over-lit. **Spot animations are a third case**: `SpotAnimationDefinitions:157`
  uses `anInt6981 + 850` with *no* multiplier and an unsigned byte, so they want
  `768 / (850 + contrast)`. Small, uniform brightness change across every model
  preview — worth doing with Cody watching, since it darkens every viewer at
  once. Full table in `EDITOR.md`.

---

## Materials

- **HDR overbright only works for constant-fill materials.** `Class66` uploads
  an `hdr:true` texture as a **float** texture (`renderMaterialPixelsF`) and
  `MaterialDefinitions.renderFloatPixels` scales colour by
  `(1 + hdrOp·31/4096)` — up to **32×**. Our 8-bit PNG dump can't hold that, so
  the scalar is applied to the material instead, but only a **constant-fill** op
  collapses to a single scalar: **87 of the 367** hdr materials. The other 280
  are real op graphs whose per-pixel HDR channel we don't evaluate, so they
  render at 1× and never reach the bloom threshold. Needs either a cryogen
  change to bake the multiplier into the dump, or evaluating the op graph on our
  side. (Bloom itself is done — `clientBloom.ts`, params from the region
  `Atmosphere`.)

- **Verify the 0.7 texture gamma.** `Class66` loads normal textures via
  `renderTexturePixels(id, 0.7F, …)` but SKIPS that scale for `blendType==2` and
  `effectId ∈ {1,7}` textures (those use `renderMaterialPixelsI`). Our
  `renderMaterial` defaults to `gamma = 0.7` for everything — check the dumped
  PNGs match per-texture; a systematic offset here would read as a lighting bug.

- **`effectId 7` — the sky env-map reflection — isn't implemented.** Traced
  2026-07-25 alongside the `effectId 1` specular (which *is* done, commit
  `7dcc23f`). `Class141_Sub7` binds the scene's sky cubemap (`method13596()`)
  with `GL_NORMAL_MAP` texgen and the world matrix on the texture stage, then
  combines `INTERPOLATE` with the material alpha as the factor:
  `rgb = mix(base, sky, texture.alpha)`. Needs a sky cubemap we don't build —
  the procedural sky would have to be rendered into one. Until then those
  materials just get the alpha drop, so reflective surfaces read flat.

---

## Environment features not applied at all

Point lights on the ground, HDR values, and the sun cube texture.

Two former entries here were traced 2026-08-06 and turned out to be non-issues:

- **The "static lighting grid" (opcode 129) is not lighting.** Its ONLY
  consumer in both darkan clients is the camera: `Isaac.processCamera`
  (darkan-game-client `Isaac.java:63-66`) and `Camera.processCamera`
  (darkan-bot-refactor `Camera.kt:85-87`) read
  `(byte & 0xff) * 8 << 2` as a *height above the terrain* per tile and use it
  to raise the minimum camera pitch near tall content (trees, buildings) so
  the camera doesn't clip through them. It never touches a pixel. Cryogen's
  `lightingGrid` field name is a decompiler-era misnomer — it's a camera
  height-hint grid (per plane: type byte; type 1 = one byte per 4×4-tile
  block, type 2 = copy the plane below).
- **Per-chunk atmospheres are real machinery but per-region data.** `Class239`
  keeps an `Atmosphere[sizeX>>3][sizeY>>3]` (one per 8×8-tile chunk,
  registered by `method4056`) and crossfades the GLOBAL light uniforms over
  5145 ms (`anInt2942`) when the player's chunk changes (`method4037/4072`).
  But each region's env tail registers ONE atmosphere for all 64 of its
  chunks (`Class329_Sub1` registration loop / bot-refactor
  `SceneGraph.decodeEffectsClient:1033-1043`), so the chunk granularity only
  matters when crossing region borders — the lighting itself is always one
  set of global values, exactly what the viewer does with the centre
  region's env.

---

## Source audit — is each piece from the hardware renderer? (2026-07-26)

Cody's standing suspicion was that early work ported Software-Mode code.
Audited piece by piece against darkan-game-client:

| piece | ported from | hardware path? |
|---|---|---|
| loc/model lighting | `MeshRasterizer_Sub3:3254` CPU bake | ✅ Sub3 IS the DX mesh class. **Was ❌ until today** — the old bake copied `1_31.vert`'s half-Lambert, a different shader family, with invented constants |
| textured-face base (grey-mix, ambient scale) | `method14282` / `method14290` | ✅ Sub3 |
| palette | `Class540.anIntArray7136` (HSL triangle, pow 0.7) | ✅ shared — `HardwareRenderer.anIntArray8803` points at it (`anIntArray5379` is its BGR swizzle) |
| transparency split + draw order | Sub3 ctor test + `SceneObjectManager.method3441` | ✅ |
| per-material blend modes | — | n/a: `Class73`/`method13904` turned out to be the 2D blitter (see TODO correction) |
| texture load / gamma 0.7 | `Class66.renderTexturePixels` | ✅ hardware texture cache (per-texture gamma-skip verify still open) |
| fog | `Class239.method4075` → `renderer.c` → `glFog(GL_LINEAR)` | ✅ hardware renderers |
| sun/env flat values | `Class239:141-142` | ✅ |
| ground | own pipeline calibrated against client screenshots | ✅ empirically (HardwareGround analog; deliberately frozen) |
| specular (effectId 1) | `1_12.vert` ShaderMode 1 | ✅ |
| ModelViewer standalone page | ModelGL-style inline copy | ⚠ separate page, own item |

The one piece that WAS software-derived is exactly the one that caused a week
of mismatches: the lighting formula. Everything found today lives in the same
class (`MeshRasterizer_Sub3`), which is why fixing one surface kept exposing
the next — formula, grey-mix, ambient scale, contrast were all layers of the
same CPU bake.

## A suggested order

1. ~~**Calibration harness first.**~~ **DONE 2026-07-26** — `scripts/render-rig/`
   (headless Edge + dump server + patch sampler). Its README carries the
   reference numbers from the client screenshot pair.
2. ~~**Fix the flat mode.**~~ **DONE 2026-07-26** — the 1_12.vert formula and
   the client's real flat constants, verified against (1). No unclamp/bloom
   retune was needed for the flat mode; see above.
3. ~~**Distance fog**~~ **DONE 2026-07-26.** Client formula traced end to end:
   `Class239.method4075` → `renderer.c(fogColour, (fogDepth+256)<<2, 0)` →
   LINEAR fog ending at the projection far plane, fading over the last
   `(fogDepth+256)·4` units (`method14013`, `glFogf(GL_LINEAR)`). Lumbridge:
   colour 0x8DA4C2, depth 600 → a 6.7-tile fade. **Fog is NOT gated on lighting
   detail** — `Atmosphere` reads fogColour/fogDepth outside that branch — which
   is why the client hazed distant foliage at LOW while we didn't; it was the
   whole residual after the flat-mode fix (measured f ≈ 0 near / 0.12 mid /
   0.19 far, monotone with distance, per-channel consistent with 0x8DA4C2).
   Implemented as `scene.fog` + matching uniforms in the water shader (alpha
   rises with fog so distant water is a wall of fog, not a window); the skybox
   keeps `fog:false`; the old approximate horizon fade was removed. The one
   unknowable is the client's far plane (a graphics setting), so it's the
   exposed knob: a **Draw distance** slider in the gfx panel (default 40 tiles
   for editor use; ~24 matches a client-like zoom).
4. **The environment sun** behind a lighting-detail toggle: on = region values,
   off = the flat constants we now render correctly. The ON values (peak ~2.75×)
   are where the unclamp + bloom-threshold retune conversation comes back.

   **STATUS 2026-08-06 (evening) — toggle LANDED (default Low); the
   "unclamp" was WRONG and is reverted; exact DX facts secured; the HIGH
   ground shader binding is the one open question.**

   The morning attempt unclamped the bakes per this doc's compression theory
   and blew the scene out (Cody's kitchen/fireplace screenshots). **The
   theory is falsified**: Lumbridge's dumped whitePoint is 1.0039 — the
   composite's tone map is an identity there and compresses nothing. The
   clamps are restored everywhere and are now known to be CLIENT-FAITHFUL,
   from the DX sources directly:

   - `Class239.method4049` (HIGH) vs `method4052` (LOW), verbatim: identical
     shape, raw values, no normalization. NOTE the elided term this doc's
     earlier quote hid: ambient intensity = `(0.7 + brightness·0.1 +
     MAP_REGION_DECODER.method4428()) · aFloat7081` — method4428 is an
     additive region term (untraced; 0 in the normal case?). Direction =
     the atmosphere's `Class385` vector `<<2` per component.
   - `DirectXRenderer.method13948/13949/13950` (the HardwareRenderer `m`/`IA`
     hooks): D3D fixed-function light 0 = diffuse `sunLight·sunRgb`, ambient
     `ambIntensity·sunRgb` (BOTH sun-coloured); light 1 = diffuse
     `−backlight·sunRgb`, inverted direction. D3D9 saturates lit vertex
     colours to [0,1] by specification — nothing above 1 ever exists in this
     path, and the Sub3 CPU bake clamps into 8-bit vertex colours likewise.
     `modelSunFromEnvironment`'s value mapping is confirmed exact; the CLAMP
     is part of the model, not an approximation.
   - **The shipped shader dump (index 31) settles the shader side**:
     `glsl/1_31.vert` (lowercase family; terrain-side uniforms — waterPlane,
     waterParams, depth in MultiTexCoord1) computes
     `hl = clamp(N·L·0.5 + 0.5)`, `lighting = hl·(sun + amb/2) + amb/2`,
     `gl_FrontColor = colour·lighting` — HALF-LAMBERT plus front-colour
     saturation. The half-Lambert this doc scorned for the MODEL family is
     real for this family. 1_12.vert (uppercase, two-sided) remains the
     model family.

   OPEN before High can be called exact: which shader family the flags-0x7
   ground binds (the named dumps carry no "Ground" dir — it is one of the
   numbered programs; find the ground's program selection in
   HardwareGround/DirectXGround), `method4428`, and the point-light/flicker
   half (steps 5–6). Current state after the reverts: High = clamped bakes
   with the region's sun values — locs exact per Sub3; ground uses the f53
   grid with HIGH scalars + colour clamp, which overshoots the half-Lambert
   compression if 1_31 turns out to be the HIGH ground family. Calibration
   targets from Cody's pairs (castle wall 113,111,103→127,111,81; grass
   78,80,64→81,73,47; kitchen + fireplace screenshots 2026-08-06) are the
   sign-off bar.
5. **Point lights into the shader** (the agreed plan above) — unblocks flicker.
6. **Ground point lights** — the largest single missing path.
