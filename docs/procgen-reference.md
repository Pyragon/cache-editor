# What the real map actually does

Reference data for the region generator, measured from the cache's own map
dumps rather than guessed. Everything here comes from decoding
`maps/<id>.json` directly — the per-tile underlay, overlay, shape and height
channels, plus each placed object's name from `objects/<id>.json`. No
rendering was involved: "what is under a building" and "how far apart are
trees" are exact questions the dump answers, where a screenshot could only be
eyeballed.

**Survey:** 15 settlements, each with its surrounding ring of 8 regions —
135 regions, ~550,000 plane-0 tiles, ~6,800 trees. Lumbridge, Varrock,
Falador, Draynor, Rimmington, Seers' Village, Catherby, Port Sarim, Al Kharid,
Edgeville, Barbarian Village, Taverley, Ardougne, Yanille, Brimhaven.

Tiles are bucketed by **distance to the nearest building**, not by region,
because every region holds both town and countryside and the interesting
question is what changes between them:

| zone | meaning | share of survey |
|---|---|---|
| `built` | within 3 tiles of a building or facility | 6.9% |
| `fringe` | 4–10 tiles | 20.2% |
| `open` | everything else | 72.9% |

> **Ids below are DEFINITION ids** (`config/underlays/<id>.json`). The per-tile
> byte is `id + 1`, because 0 means "no material". See `procgen/palette.ts`.

---

## 1. There is no single "grass"

This is the biggest reason generated ground doesn't look like the game. Real
ground is a **blend of many close relatives**, and no single underlay exceeds
~20% of any zone:

| zone | top underlays |
|---|---|
| built | 163 (18.5%), 162 (15.4%), 62 (12.2%), 48 (10.7%), 160 (9.9%), 63 (8.2%), 49 (6.8%) |
| fringe | 162 (17.0%), 163 (15.1%), 48 (12.8%), 160 (11.3%), 62 (10.6%), 63 (6.8%) |
| open | 162 (13.6%), 48 (11.1%), 160 (10.7%), 163 (5.9%), 62 (5.5%), 54 (5.0%), 64 (4.6%) |

The generator painted one id per band, which is why its ground reads as flat
colour. It needs to paint a **weighted mix of 4–6 relatives** per band.

Note also that **163 is a town material, not a wild one**: 18.5% of built
tiles but only 5.9% of open, rising to 36% inside Lumbridge and 44% inside
Edgeville. The old palette used it as `grass`, which is backwards.

### The material families

| family | ids | notes |
|---|---|---|
| green | 47 `#35720a`, 48 `#58680b`, 98 `#276d27`, 99 `#396215`, 159/160 `#29380f`, 162 `#20250a` | 48 is the workhorse; 162 the commonest overall; 159/160 are a near-identical pair (textures 918/917) |
| town ground | 163 `#1c1813` (tex 929) | packed earth inside settlements; sibling texture to the path overlay (928) |
| earth | 62 `#3d2b0b`, 63 `#644e1e`, 64 `#654d0b`, 65 `#663300`, 95 `#4b3e14`, 97 `#2f2b1f` | 62 is also the steep-slope material |
| dry/yellow | 49 `#78680b` | 56% of built Brimhaven; reads as parched grass |
| sand | 60 `#b19a3d`, 61 `#d0c074`, 67 `#cbba76` | 61 is 28% of open Brimhaven |
| desert | 166 `#78673f`, 167 `#90754b`, 168 `#765a3d` | Al Kharid only: 22/19/15% of its open ground |
| stone | 44 `#444444`, 54 `#767676`, 55 `#4d4d4d`, 144, 146, 148 | 54 is 19% of open Rimmington (rocky coast) |
| snow | 25 `#e6e6eb` | 7–9% of open Catherby and Taverley (White Wolf Mountain) |

**Colour alone is a trap.** These `rgb` values are tints under a texture —
underlay 163's rgb is `#1c1813` yet the tile reads as dark earth, and the
create-region fill's 163 renders green. Judge by the texture, which is what
the ground-material picker shows.

---

## 2. Paths, found by shape

Rather than assume which overlay is a road, every overlay's tiles were grouped
into connected components and scored on how **long and thin** they are — a road
fills little of its bounding box and spans far; a field of sand fills its box.

| overlay | components | mean span | box fill | reading |
|---|---|---|---|---|
| **235** `#35302d` tex 928 | 96 | 33.2 | 0.37 | **the main road/path** |
| **187** `#4e4329` tex 441 | 102 | 23.5 | 0.46 | **dirt track** — shorter, rougher |
| 244 `#2b2310` tex 197 | 19 | 36.1 | 0.27 | narrow trail, rare but very skinny |
| 111 `#60769a` tex 669 | 127 | 40.9 | 0.59 | **water** — long because coastlines are |
| 81 `#5c5444`, 82 `#464034` tex 508 | 32/39 | 25.7/16.6 | 0.45/0.57 | **rock on steep ground** |
| 143/76 `#b79767` tex 512 | 11 | 21.8 | 0.43 | sand path |

Both 235 and 187 have `blendsWithUnderlay: true`, so their edges feather into
the ground rather than cutting a hard border — worth keeping when we pick a
path material.

Town paving is a different set, and it is **place-specific**: Falador uses 122
`#b8b098` (24% of its built overlay), Al Kharid and Lumbridge use 172 `#786848`,
Seers and Catherby use 55 `#606058` and 102 `#787060`.

---

## 3. Terrain is flat, then it isn't

Per-tile slope = worst 4-neighbour height-byte delta, 527k samples:

| statistic | value |
|---|---|
| perfectly flat | **41.8%** |
| median | 1 |
| p75 | 4 |
| p90 | 8 |
| p95 | 12 |
| p99 | 25 |
| max | 119 |

**42% of real tiles are dead flat.** Fractal noise produces almost none, which
is a structural difference, not a tuning one: RS ground is terraced, with broad
level shelves separated by short steep steps. Our fbm heightmap gives a
continuously rolling surface that never sits still.

Height range within a region (max − min byte):

| place | mean | max |
|---|---|---|
| Lumbridge | 49 | 58 |
| Varrock | 50 | 75 |
| Draynor | 51 | 87 |
| Falador | 64 | 122 |
| Seers | 72 | 163 |
| Al Kharid | 75 | 155 |
| Edgeville | 84 | 184 |
| Catherby | 93 | 165 |
| Taverley | 100 | 214 |

So a settled region spans ~50 height bytes and a mountainous one ~100, against
the generator's amplitude range of 20–140. The magnitude was about right; the
*distribution* is wrong.

### Material by slope

| slope | share | underlays | overlays |
|---|---|---|---|
| 0 (flat) | 42% | 54, 64, 162, 163, 62 — spread | 111 water dominates |
| 1–2 | 21% | 162 (19%), 48 (15%), 160 (13%), 163 (13%) | 235 (36%), 187 (16%) |
| 3–5 | 21% | 162 (19%), 48 (15%), 160 (14%) | 235 (28%), 187 (21%) |
| 6–10 | 10% | 162 (17%), 48 (14%), 160 (13%), 62 (8%) | 81 (17%), 244 (13%) |
| >10 | 6% | **62 (15%)**, 162, 48, 63 (8%), 25 (7%) | **82 (18%), 81 (17%)** |

Two rules fall straight out: **62 is the steep-ground underlay**, and **81/82
are the exposed-rock overlays**. Paths sit on gentle slopes (235 and 187 peak
in the 1–5 band) and vanish above 10 — roads go around hills, which is what the
router's climb penalty already tries to do.

---

## 4. Scenery is an order of magnitude sparser than we thought

Trees per 100 tiles, plane 0, per place:

| place | trees/100 | | place | trees/100 |
|---|---|---|---|---|
| Barbarian Village | 2.37 | | Falador | 1.07 |
| Seers' Village | 1.99 | | Yanille | 1.04 |
| Catherby | 1.55 | | Rimmington | 0.99 |
| Brimhaven | 1.53 | | Edgeville | 0.93 |
| Ardougne | 1.51 | | Port Sarim | 1.10 |
| Varrock | 1.30 | | Lumbridge | 0.64 |
| Draynor | 1.20 | | Al Kharid | 0.16 |
| Taverley | 1.14 | | | |

**The densest place in the game is 2.4 trees per 100 tiles.** The generator's
themes used 12–36, which is 10–20× too many — this is the answer to open
question 5 in `procgen.md`, and it is not a matter of taste.

All scenery, pooled, per 100 tiles: tree 0.64, plant 0.51, building 0.34,
clutter 0.28, dead tree 0.26, flowers 0.22, fence 0.15, oak 0.14, rock 0.13,
mushroom 0.11, light 0.10, evergreen 0.10, bush 0.09, ore 0.07, fern 0.05,
willow 0.05. **Total under 4 objects per 100 tiles**, including buildings.

### Species mix

| species | share |
|---|---|
| plain tree | 51.6% |
| dead tree | 20.9% |
| oak | 11.4% |
| evergreen | 7.9% |
| willow | 3.6% |
| stump | 1.8% |
| maple | 1.3% |
| yew | 1.1% |
| magic | 0.2% |
| palm | 0.2% |

Yew and maple are genuinely rare — a forest of them is wrong. Maple is
essentially Seers' Village only (9.6% there, ~0 elsewhere), and willow clusters
at Rimmington (9.6%), Port Sarim (7.9%) and Ardougne (7.0%) — waterside.

**Dead trees are not a "gloomy" exclusive.** They are 66.8% of Barbarian
Village's trees, 29.3% of Al Kharid's, 26.3% of Taverley's, 22.7% of Yanille's.
They mark rough, wild and border country, not just haunted woods.

### Spacing

Nearest-neighbour distance between trees (6,808 samples): p10 1.4, p25 2.2,
**p50 3.6**, p75 4.5, p90 5.8 tiles. So a minimum spacing of 2 with a typical
gap near 3.5 is right; trees do touch occasionally but rarely.

Trees stand on 162 (20%), 48 (20%), 160 (18%), 62 (10%), 47 (5%) — the green
family — and only **8% stand on perfectly flat ground**, median slope 3. They
prefer gentle slopes over shelves, which is the opposite of buildings.

### Two-part trees

Some species are **two locs**: a trunk on plane 0 and a separate canopy loc on
plane 1, on the same tile but with a **different object id**. Measured over
regions 40–53 × 48–55:

| species | plane-0 count | has a plane-1 canopy |
|---|---|---|
| Oak | 541 | **92%** |
| Tropical tree | 372 | **98%** |
| Yew | 38 | **100%** |
| Tree | 2,526 | 0% |
| Dead tree / Willow / Maple / Swamp tree | — | 0% |

**That table is a regional subset and under-counts.** A later full-map scan
found **Evergreen** is two-part as well (389/389 of its ground placements carry
a canopy) — it simply doesn't occur in regions 40–53 × 48–55. Treat the list as
"at least these", not "only these".

The generator only emits plane 0, so these species come out as bare trunks.
Fixing it needs a trunk-id → canopy-id mapping, because **the ids differ** —
"also emit on plane 1" is not enough. Harvested from the full map:

| species | trunk | canopy | pair rate |
|---|---|---|---|
| oak | 38731 | **38736** | 758/783 (97%) |
| yew | 38755 | **38758** | 71/71 (100%) |
| evergreen | 54787 | **54795** | 389/389 (100%) |
| tropical tree | 1326 | **1327** | 1221/1222 (100%) |
| willow | 38616 | — | no partner (single-part) |

**DONE 2026-08-07** — the index carries this map and `generate()` emits the
canopy on plane 1 at the same tile, with the same shape and rotation (both
measured: shape pairs exactly, rotation matches in 99.3% of 2,439 pairs). See
`docs/map-learning.md` §11, which also covers the plane filter that stops the
canopy being planted on the ground in the first place.

---

## 5. Ore is knotted, not scattered

Measured over the 20 regions in 40–55 × 46–57 carrying 10+ ore rocks.

| measurement | p25 | p50 | p75 |
|---|---|---|---|
| nearest rock of the **same** type | 1.0 | **1.4** | 2.0 |
| nearest rock of **any** type | 1.0 | 1.4 | 1.4 |
| nearest **other** cluster's centre | 2.1 | **3.2** | 4.7 |
| rocks per mining region | 13 | 17 | 19 |
| rocks of one type at a site | 3 | 4 | 7 |

Same-type NN equals any-type NN (1.4 both), which is the whole finding: **your
nearest neighbour is almost always your own ore**. Types self-segregate into
pockets.

A same-type cluster (rocks linked within 3 tiles) is compact and roughly round
— bbox 4×5 tiles, aspect 1.2, filling ~25% of it. Sizes: median 2, p90 6, max
31 (the one big coal seam). **37% are a lone rock** sitting away from any
pocket of its own type. Sites run 1–8 ore types; single-ore sites of 18–34 coal
exist alongside 8-type sites.

So a mine is *one dense knot of type-segregated pockets*, much smaller than the
pit around it — not an even fill of the zone. The pockets abut each other
(3.2 tiles apart) so the whole ore body is only ~10–14 tiles across.

**Ported** in `runResources`: one object id resolved per ore type (not a
weighted pick per rock), budget split by weight with every named ore
guaranteed at least one rock, pocket centres on a ring sized to the measured
3.2-tile gap, blobs of radius 2.4, and a 15% chance a non-anchor rock strays
into the wider zone. Occupancy is marked at radius **0**, not 1 — a 1-tile
keep-out forces every gap to 1.4 and kills the orthogonal adjacency that a
quarter of real rocks have.

Tuning that measured *worse* and was reverted: capping the retry-widening, and
shrinking the pocket radius to 2.0. Both raised the lone-rock share, because a
pocket that cannot spill simply fails to place its last rocks.

---

## 6. Place signatures

Enough to derive themes from. Percentages are of that zone's underlay tiles.

| place | built ground | open ground | character |
|---|---|---|---|
| **Lumbridge** | 163:36, 159:11, 48:9 | 162:11, 9:8, 168:8, 167:8 | town earth core, sparse (0.64 trees/100), 26% flat |
| **Varrock** | — see below — | | biggest built share (10.7% of area) |
| **Falador** | 62:20, 162:20, 48:13, 160:12 | 162:19, 160:16, 48:16 | pale stone paving 122 (24% of built overlay), 0.56 buildings/100 |
| **Draynor** | 163:18, 162:18, 49:13, 48:13 | 162:13, 54:9, 48:8, 64:8 | low relief (p99 slope 16), willow country |
| **Rimmington** | 62:25, 162:13, 49:12 | **54:19**, 64:11, 162:9 | rocky coast, 50% flat, zero dead trees |
| **Seers'** | 162:21, 63:18, 160:18, 48:18 | 162:20, 48:19, 160:19, 148:7 | 1.99 trees/100, the maple place, 0.53 fences/100 |
| **Catherby** | 63:18, 62:16, 49:15 | 162:16, 160:16, 48:15, **25:7** | snow at altitude, 0.86 flowers/100, high relief (93) |
| **Port Sarim** | 163:18, 162:17, 49:12 | **54:13**, 64:11, 162:10 | 38% of open overlay is water |
| **Al Kharid** | 163:33, 159:14 | **167:22, 166:19, 168:15** | desert palette, 0.16 trees/100, 0.64 rocks/100 |
| **Barbarian** | **62:26**, 163:25, 162:12, 63:11 | 162:20, 160:19, 48:17, 62:13 | **1.59 dead trees/100**, the roughest ground |
| **Taverley** | 162:19, 159:14, 48:13 | 162:15, 48:12, 160:11, 25:9 | highest relief (100 mean), snow, 0.92 buildings/100 |
| **Brimhaven** | **49:56**, 47:10, 146:10 | **61:28**, 47:17, 67:10 | tropical: yellow-green town, sand, 3.79 plants/100 |
| **Ardougne** | 160:20, 162:20, 48:20, 163:13 | 162:19, 48:17, 160:17 | balanced large town |
| **Edgeville** | **163:44**, 62:10, 162:10 | 162:22, 160:15, 48:14 | most town-earth of anywhere, only 28% flat |
| **Yanille** | — | — | 22.7% dead trees, 3665 built tiles |

Settlement footprint: `built` tiles are 4.1% of Lumbridge's 9-region survey,
9.3% of Falador's, 10.7% of Varrock's, 10.8% of Taverley's. So a town occupies
roughly **half a region to one region** of a multi-region area, not the 18%
circle radius the planner was using.

---

## 7. What this changes in the generator

Applied alongside this document:

1. **Palette bound to real ids.** grass 48, lush 47, mid 160, dark 162, dry 49,
   dirt 63, mud 62, town earth 163, sand 61, gravel 95, stone 54, snow 25;
   path overlay 235, dirt track 187, water 111, rock 81. Three green roles
   became four — 160 is the game's third-commonest underlay and the first pass
   had no role for it.
2. **Ground bands paint mixes**, 4–6 weighted relatives, never a single id.
3. **Densities cut by ~10×** to the measured figures, per theme.
4. **Species weights from the real mix** — plain tree dominant, oak second,
   yew and maple rare.
5. **Steep ground uses 62 with the 81/82 rock overlays**, and the band
   thresholds are the measured percentiles (`minSlope: 6` ≈ p85,
   `minSlope: 11` ≈ p95).
6. **Dead trees moved out of "gloomy only"** into rough and border country.
7. **Two road materials**, not one: 235 through a settlement, 187 as the track
   in open country.
8. **Town footprint cut** from 18% of the area to 13%, per the measured
   4–11% built share.
9. **Nine place-derived themes** added alongside the original eight.
10. **The AI layer re-taught.** Its prompt carried the old density scale
    ("12–20 is woodland"), which would have had Claude planning forests 10×
    too thick regardless of what the built-in planner does. The sanitiser's
    density cap dropped from 60 to 12.

### Verified by running it

Compiled the generator offline and generated a 2×2 area on every theme:

- placements land at **0.7–4.7 per 100 tiles** (was ~14 for a default
  gloomy area) against a measured real total under 4;
- the commonest underlay in a generated region is now **20–27%**, against
  100% before and 13.6% in the real map — better, not yet equal, and the
  remaining gap is that the game leans on more near-identical variants than
  the palette has roles for;
- output is still deterministic on `(plan, seed)`.

Not verified: how any of it looks. That needs eyes on the 3D view.

Not yet addressed, and the biggest remaining gap: **the 42%-flat terracing**.
Our heightmap is smooth fbm and produces almost no flat ground, so even with
perfect materials the *shape* of the land still reads as generated. That wants
a quantisation/terracing pass over the heightfield, and is worth doing as its
own piece of work.

---

*Reproduce with the survey scripts in the session scratchpad
(`survey2.py` + `run_survey.py`, then `report1`–`report4`).*
