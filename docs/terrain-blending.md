# Terrain blending — how the client melts ground materials together

Everything traced on 2026-07-25 while chasing "walkways bleed into the grass"
in `RENDER-ISSUES.md`. Written up because the answer turned out to be **three
independent mechanisms**, two of which are now ported and one of which is not,
and because the deob names involved are impossible to hold in your head.

Sources, in the order they should be trusted:

- **`darkan-game-client`** — `Class329` (the terrain builder), `HardwareGround`,
  `Node_Sub6`. This is what we implement against.
- **`darkan-bot-refactor`** — `MapLoader.kt`, `GroundSM.kt`, `GroundGL.kt`,
  `tile/*.kt`. Naming and structure only, per `CLAUDE.md`. Its names are used
  throughout this document because they're readable, but every claim below was
  checked against the game client.

Our implementation lives in `src/components/mapScene.ts`, mostly in
`buildTerrainMesh`/`emitTile` and `computeOverlayPerimeter`.

---

## The vocabulary

| deob | bot-refactor | what it is |
|---|---|---|
| `Class329` | `MapLoader` | builds ground tiles from the map data |
| `Class329.method5845/5846` | `addBlendedTiles` | the per-tile loop |
| `Class329.method5848` | `calculateOverlayDisplay` | scans neighbours, fills the perimeter arrays |
| `Class329.method5849` | (table selection) | picks one of three tile-shape families |
| `Class329.method5850` | `addOverlayTiles` | emits the overlay portion of a tile |
| `Class329.method5851` | `addUnderlayTiles` | emits the underlay portion |
| `Ground.method6707` | `addBlendedTile` | hands the finished tile to the renderer |
| `OverlayDefinitions` | `FloType` | overlay config |
| `UnderlayDefinitions` | `FluType` | underlay config |

Overlay def fields that matter:

| deob | name | notes |
|---|---|---|
| `aBool7061` | `blendsWithUnderlay` | opcode 62 |
| `anInt7052` | `slot` | opcode 60, layering priority; packed `slot << 8 \| anInt7053` |
| `anInt7057` | `textureScale` | opcode 56, `readUnsignedShort() << 2`, default 512 |
| `primaryRGB` | `colorRgb` | the tile colour; `-1` means none |
| `secondaryRGB` | — | see the material colour below |

A tile's geometry is described by a **shape** (0-12ish) and a **rotation**
(0-3). Vertices are numbered in a fixed space: **0-7 are the perimeter ring**
(corners at 0/2/4/6, edge midpoints at 1/3/5/7, counting from the SW corner),
**8-11 are interior points**, **12 is the tile centre**. `VERTEX_DELTA_X/Y`
in `mapScene.ts` maps an id to a position inside the 512-unit tile.

Two index spaces exist and mixing them is the easiest way to get this wrong:

- **shape space** — the ids as they appear in the shape tables, before rotation
- **world space** — after rotation

One rotation step moves two ring positions, so
`world = (shape - 2*rotation) & 7` and `shape = (world + 2*rotation) & 7`.
The client writes this as `i_25 = i_24 - anInt3781 * 2 & 0x7`.

---

## Mechanism 1 — the perimeter blend (PORTED)

`Class329.method5848`. The client keeps five parallel 8-slot arrays per tile,
one entry per **perimeter ring vertex**:

| array | contents |
|---|---|
| `anIntArray3838` | winner's `primaryRGB` (main colour) |
| `anIntArray3839` | winner's material colour (see below) |
| `anIntArray3813` | winner's `texture` |
| `anIntArray3827` | winner's `textureScale` |
| `anIntArray3842` | winner's `slot` — the priority the comparisons use |
| `anIntArray3843` | a direction bitmask; **not ported, purpose unconfirmed** |

They're filled in two passes, and the order matters:

1. **Four diagonal neighbours**, each claiming exactly one corner, with **no
   priority test** — a later writer simply wins. Guarded on the neighbour
   having `primaryRGB != -1` *and* `blendsWithUnderlay`, and on its shape
   covering the vertex that touches us.

   | neighbour | claims ring vertex | reads neighbour ring index |
   |---|---|---|
   | (x-1, y-1) | 0 | `nrot*2 + 4` |
   | (x+1, y-1) | 2 | `nrot*2 + 6` |
   | (x-1, y+1) | 6 | `nrot*2 + 2` |
   | (x+1, y+1) | 4 | `nrot*2 + 0` |

2. **Four edge neighbours**, each sweeping **three consecutive** ring vertices,
   taking the slot on `<=` so a tie goes to the later writer. `p` and `q` walk
   in opposite directions because the two tiles meet mirrored across the edge.

   | neighbour | `p` (ours) | `q` (theirs) |
   |---|---|---|
   | south (x, y-1) | 2, 1, 0 | `nrot*2 + 4, +5, +6` |
   | north (x, y+1) | 4, 5, 6 | `nrot*2 + 2, +1, +0` |
   | west  (x-1, y) | 6, 7, 0 | `nrot*2 + 4, +3, +2` |
   | east  (x+1, y) | 4, 3, 2 | `nrot*2 + 6, +7, +0` |

Coverage is tested with `aBoolArrayArray3822[shape][q]` — "does this shape's
overlay portion reach vertex q", in **shape space**. Ours is
`OVERLAY_SHAPE_COVERS`, which is byte-identical to the client's table.

### The two consumers, and why the second one is the important one

**`method5850` (overlay faces)** defers to the winner only when it outranks the
tile's own overlay:

```java
if (i_24 < 8 && anIntArray3842[i_25] > overlaydef_5.anInt7052) {
    ints_7[index]        = anIntArray3839[i_25];  // material colour
    ints_12[index]       = anIntArray3827[i_25];  // texture scale
    waterTextures[index] = anIntArray3813[i_25];  // texture
    ints_10[index]       = anIntArray3838[i_25];  // main colour
}
```

**`method5851` (underlay faces)** defers to the winner whenever there *is* one:

```java
if (i_34 < 8 && anIntArray3842[i_35] >= 0) {     // >= 0, NOT a slot comparison
    ints_13[index] = anIntArray3839[i_35];
    ints_18[index] = anIntArray3827[i_35];
    waterTextures[index] = anIntArray3813[i_35];
    ints_16[index] = anIntArray3838[i_35];
}
```

No slot test, because an underlay face has no overlay to outrank. **This is the
path-into-grass feather.** It is the *grass* tile's own vertices picking up the
path's colour, texture and scale — not the path spilling outward. That is why
in-game the grass goes faint as it approaches a path rather than the path
having a soft edge.

Note `i_24 < 8` / `i_34 < 8`: only ring vertices. Interior (8-11) and centre
(12) vertices always keep the tile's own material. This matters in mechanism 3.

### What we had before, and what changed

We had a corner-only, **colour-only** override (`overlayCornerFor` /
`ocorners`), comparing a "slot key" and covering the 4 tile corners. The port
adds `computeOverlayPerimeter` (all 8 ring vertices, including the midpoints
that carry the gradient half a tile inward) and overrides **texture and scale**
as well as colour, on both the overlay and underlay paths.

Since a sampler can't vary per vertex in one draw, the texture override reuses
the crossfade the underlay splat already had: base pass, then one alpha-masked
pass per distinct winning texture.

### Known gap

`computeOverlayPerimeter` reads a single region, so a blend that should cross a
mosaic seam stops at it. `computeOverlayCorners` has the same limitation against
`SceneMosaic.overlayCornerFor`; wiring a mosaic version is mechanical.

---

## Mechanism 2 — the three tile-shape families (PORTED)

`Class329.method5849` picks between **three** families:

```java
if (aBool3853) {            // "unblendable"
    A = 3824; B = 3860; C = 3815;
    overlayFaces = OVERLAY_FACE_COUNT; underlayFaces = UNDERLAY_FACE_COUNT;
} else if (aBool3810) {     // overlay.blendsWithUnderlay
    A = 3775; B = 3821; C = 3836;
    overlayFaces = 3778; underlayFaces = 3819;
    edgeFace = 3833;
} else {
    A = 3774; B = 3830; C = 3831;
    overlayFaces = 3826; underlayFaces = 3847;
    edgeFace = 3828;
}
```

selected by (`Class329:626-647`):

```java
aBool3810 = overlaydef.aBool7061;                        // blendsWithUnderlay
aBool3853 = !aBool3810 && !hasFacesOn[0] && !hasFacesOn[2]
                       && !hasFacesOn[1] && !hasFacesOn[3];
```

with `blendsWithUnderlay` only counting when the tile actually has an underlay
to blend into and a real shape — `method5848`'s guard, not just the flag.

Our `SHAPE_VERTEX_A/B/C` + `OVERLAY_FACE_COUNT`/`UNDERLAY_FACE_COUNT` were
already byte-identical to `3824/3860/3815` — i.e. we had **only the unblendable
family**, and were using it for every tile. Now `NB_*` and `BL_*` carry the
other two.

**Overlay face counts are identical across all three families**
(`{4,2,1,1,2,2,3,1,3,3,3,2,0}`). All the extra geometry a blending tile gets is
on the **underlay** side, and only on the shaped tiles:

| shape | non-blending `3847` | blending `3819` |
|---|---|---|
| 1 | 2 | **4** |
| 2 | 2 | **3** |
| 3 | 2 | **3** |
| 7 | 3 | **5** |
| 9 | 3 | **5** |
| 11 | 4 | **6** |

Shapes 4, 5, 6, 8, 10, 12 are unchanged between the two. That is exactly why
straight borders (full-tile shapes) looked right after mechanism 1 alone, and
diagonals didn't.

### hasFacesOn

`aBoolArrayArray3816` (non-blending) and `aBoolArrayArray3793` (blending) give,
per shape, whether it already puts a face on each of its four edges. The rule,
regular once all four edge blocks are read — edges are 0=S, 1=E, 2=N, 3=W:

```
if (!ownTable[ownShape][(rot + e) & 3])
    hasFacesOn[e] = neighbourTable[nShape][(nrot + ((e + 2) & 3)) & 3]
```

Each side uses **its own** blending-ness to choose between `3793` and `3816`. A
tile only asks where its own shape has no face already, so the feather is
cooperative: a blending shape makes its neighbours subdivide too. The blending
table is far denser — shape 1 is `{false,true,true,false}` against all-false.

### The 3832 edge split

`anIntArray3832` is a **4-entry edge -> face-index lookup** (`-1` = no face on
that edge), present only in the two 13-entry families. Used for exactly one
thing, in both `method5850` and `method5851`:

```java
if (bools_6[-anInt3781 & 0x3] && anInt3846 == anIntArray3832[0]) {
    // 6 vertices instead of 3: A-mid-C and mid-B-C
    anIntArray3837[0] = A; anIntArray3837[1] = 1; anIntArray3837[2] = C;
    anIntArray3837[3] = 1; anIntArray3837[4] = B; anIntArray3837[5] = C;
    b_22 = 6;
}
```

When the neighbour across shape-edge `j` has asked for a face **and** the
running face index equals `edgeFace[j]`, that triangle is split at the edge's
midpoint vertex (`2j+1`). Shape edge `j` maps to world edge `(j - rot) & 3`.

The face index (`anInt3846`) is a **single counter running across overlay faces
then underlay faces** — `method5850` advances it even when there's no overlay
(`anInt3846 += faceCount`). So our underlay loop passes `overlayFaces + i`.

### Coverage in region 12850, plane 0

```
blending family:      329 tiles   shapes {1:56, 2:26, 3:53, 4:19, 5:44,
                                          6:42, 7:10, 8:21, 9:47, 10:10, 11:1}
non-blending family: 1545 tiles
unblendable:         2222 tiles
```

The 1545 were previously on the wrong tables as well — our 15-entry
`UNDERLAY_FACE_COUNT` disagrees with `3847` (shape 1: ours 1, client 2) — so
plain overlays got retriangulated by this too, not only blending ones.

---

## Mechanism 3 — per-vertex material and vertex welding (NOT PORTED)

Still missing, and the reason a curved intra-tile boundary (shape 9/10 — tile
3225,3223 = region 12850 local 25,23, overlay 236 shape 10 rot 0) renders as a
hard arc however well mechanisms 1 and 2 are done.

**Correction, 2026-07-25:** an earlier version of this document claimed the
client draws each tile once per distinct material over the tile's *whole*
vertex set. That was wrong — it was inferred from `method12145` writing only
RGB, before `method12147` and `method12143` had been read. What follows is the
read version.

### How the client actually splats

Three pieces:

**Alpha is a binary per-vertex weight.** `Node_Sub6.method12143`:

```java
public void method12143(int i_1) {
    aStream7513.method2919(i_1 * 4 + 3);   // byte 3 of vertex i_1 — the alpha
    aStream7513.method2920(-1);            // 0xFF
}
```

Stride 4; `method12145` writes bytes 0-2 (RGB) and this writes byte 3. Alpha
defaults to 0, so a material is opaque only at the vertices it owns and the GPU
interpolates the falloff across the triangle.

**Each material draws only its own faces.** `method12147` builds the index
buffer from `anIntArray7515[tile]`, a per-tile bitmask of face indices, set by
`method12152(x, y, faceIndex)`.

**A vertex has exactly one material; a face is registered with all of them.**
`HardwareGround:1094-1136`:

```java
Node_Sub6 a = arr_8[i_74], b = arr_8[i_75], c = arr_8[i_76];
if (a != null) a.method12152(i_12, i_13, i_15);
if (b != null) b.method12152(i_12, i_13, i_15);
if (c != null) c.method12152(i_12, i_13, i_15);
```

So a face whose corners disagree is emitted once per material present at those
corners, each pass opaque at its own corners and transparent at the others.

**This is the same shape as what we already do** — our underlay splat, and the
overlay crossfade added with mechanism 1, are base pass plus one alpha-masked
pass per distinct neighbouring texture. So mechanism 3 is not a different
rendering model, and the earlier framing overstated the work.

### The remaining suspect: vertex welding (HYPOTHESIS, NOT TRACED)

What we do differently is that **we generate independent vertices per face**.
The client welds them. In the buffer fill:

```java
long_47 = (long) i_45 << 48 | (long) i_44 << 32 | (i_42 << 16) | i_43;
//        materialColour       mainColour          tileX       tileZ
if ((i_40 & anInt8529 - 1) == 0 && (i_41 & anInt8529 - 1) == 0) {
    node_80 = class453_10.get(long_47);
}
```

Grid-aligned vertices with matching colour pairs are shared between faces. If
that sharing spans the overlay/underlay split within a tile — and the key
contains only colours and position, nothing that distinguishes the two — then a
vertex on shape 10's arc is one vertex with one alpha per material, and the
weight interpolates across the boundary. With per-face vertices, nothing can
interpolate across that seam no matter what alphas are written, which is
exactly the symptom.

**This is a hypothesis.** What has NOT been read: where `class453_10` entries
are consumed, whether welding really spans overlay/underlay faces, and what
`anInt8529` (the grid-alignment mask) is. Read those before writing code — the
same mistake was already made once in this section.

### Two colour channels per vertex

Related, and also not implemented. Each ground vertex carries **two** colours:

- **main colour** — `anIntArray3838` / `primaryRGB`, stored in
  `anIntArrayArrayArray8538`
- **material colour** — `anIntArray3839`, stored in `anIntArrayArrayArray8556`,
  allocated only when `aBool3854`; `HardwareGround` falls back to the main
  colour when the array is null (`if (ints_17 == null) ints_17 = ints_18;`)

The material colour comes from `VarNPCMap.method2617`:

```java
if (overlay.secondaryRGB != -1) return overlay.secondaryRGB;
if (overlay.texture != -1) {
    TextureDetails d = textureCache.getTextureDetails(overlay.texture);
    if (!d.isGroundMesh) return d.color;
}
return overlay.primaryRGB;
```

which is the same rule as our single `overlayCornerHsl` (tile colour, else the
texture's average). So we have the *value*; we collapse two channels into one.
In the buffer fill, `i_52` is the lit main colour and `i_87` the lit material
colour, and the vertex colour written to the stream is the **material** one
(`stream_7.method2921(-16777216 | i_87)`), while `i_52` is what gets passed to
each `Node_Sub6.method12145`. Whether that distinction matters visually is
unverified.

### Where to pick this up

**The alpha write is found** (`method12143`, above) and the splatting model
turned out to match ours. The open question is now vertex welding — read
`class453_10`, `anInt8529`, and whether sharing spans the overlay/underlay
split, before writing anything.

**Then the shape of the fix is known.** Our underlay splatting already does
this in miniature — base pass, then one alpha-masked crossfade pass per
neighbouring texture. What's needed is to lift it from "per face group" to
"per tile": collect the distinct materials across *all* of a tile's faces,
overlay and underlay together, and emit the whole tile once per material with
the per-vertex alpha. That would subsume the ad-hoc overlay crossfade passes
added with mechanism 1, and probably the legacy `hasOverride` midpoint split in
the underlay path too (which currently sits alongside the real `3832` split and
may double up on some tiles).

Mechanism 2 stays worth having either way: more vertices means a finer weight
field. It's resolution for the blend, not the blend itself.

---

## Loose ends

- `anIntArray3843`, the sixth perimeter array — a direction bitmask (256/512/64/
  128 from diagonals, 32/16 from edges). Not ported, purpose unconfirmed.
- `anInt7053`, the low byte of the packed `slot`. We tie-break on the overlay id
  instead (`floSlotKey`). Pre-existing, and consistent with the old corner path.
- The legacy `hasOverride` 4-way midpoint split of underlay triangles is still
  in `emitTile` alongside the ported `3832` split.
- Shapes >= 13 fall back to the unblendable family; the 13-entry tables don't
  cover them.
