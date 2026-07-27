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

**We currently render the OFF mode.** `DEFAULT_MODEL_SUN` is
`sunColour [0.7, 0.7, 0.7]` — literally the off-mode `sunLight` of 0.699 — which
is why the scene reads flat, and why porting the ON values without compression
blew out.

### 2. Ground point lights

`Class329.method5834:234` is `if (aBool3780) sceneObjectManager.method3431()` —
the ground point-light registration. **"Lighting detail" and "the ground gets
point lights" are the same feature.** No lighting detail, no pooled light on the
floor.

### 3. Ground creation flags

`Class329:441,449` set `i_6 |= 0x2` and `i_7 |= 0x7` on `createGround`,
presumably the per-vertex lighting attributes (2) needs. `MapRegion:863,882`
apply the flag to the ground and to the high-detail water plane.

---

## The sun formula

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

Point lights on the ground, HDR values, the sun cube texture, per-chunk
environment blending (one env per region is used), and the static lighting grid
(opcode 129 — dumped and round-tripped as opaque base64, never rendered).

---

## A suggested order

1. **Calibration harness first.** Everything here changes global brightness, and
   both reverts happened because there was no way to judge the result except
   "looks too bright". A side-by-side against a real client screenshot at a
   known region — Lumbridge 12850 — is the thing that makes the rest safe.
2. **Unclamp the bake + retune the bloom threshold together**, in one commit,
   measured against (1).
3. **The environment sun** behind a lighting-detail toggle: on = region values,
   off = the client's flat constants, which is roughly what we render now.
4. **Point lights into the shader** (the agreed plan above) — unblocks flicker.
5. **Ground point lights** — the largest single missing path, and the one most
   likely to account for "the client just looks better".
