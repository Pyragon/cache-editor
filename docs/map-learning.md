# Learning the real map

A plan for replacing hand-authored proc-gen constants with a model **mined from
the entire RuneScape map**, and for synthesising buildings that nobody authored.

Written 2026-08-07. Nothing here is built yet except the measurements, which are
all real and reproducible. `docs/procgen-reference.md` holds the earlier
15-settlement survey; this document supersedes its *scope* (that survey read 15
places and plane 0 only) but not its findings, which remain valid.

---

## 1. What Cody wants

Recorded verbatim in intent, because every design decision below answers to it.

### The goal

> "I just want a real, very robust model for map generation built on the actual
> map data of runescape so it's as similar as possible."

Something that has read **everything** — how paths look, how trees look, what
objects go in what biomes, how buildings look, what walls get placed next to
other walls to make a believable building. The end state is being able to say:

> "make me a town with a sprawling marketplace and a castle"

and get it — stalls in the marketplace, a castle built from what it knows a
RuneScape castle looks like, with staircases and ladders.

### Buildings must be synthesised, not copied

This was asked for three times and is **not negotiable**. Cody does not want a
prefab library stamped into plots. He wants:

> "take a wall type, and place it next to another, and then next to another,
> and then maybe diagonal so it makes it bigger in areas, and actually make
> it's own building and shape, and then fill it with rugs, and candles on the
> wall, and chests around the sides of rooms, not because we've copied the
> layout from another building already made, but because it read that building,
> and the 100s others, and deduced that that's how it should look"

Prefabs are demoted to a **validation set** — a held-out corpus to score
synthesis against — not the shipping mechanism.

### Imperfect is acceptable

> "I'm okay if they're not perfect, we can go and fine-tune them after as we're
> making a maps editor, we can add a door, or remove things to make them look
> right."

This is a licence to ship rough output, **not** a licence to ship structurally
broken output. A building with a staircase into solid rock is not something you
fix by hand across hundreds of buildings — see §6 on hard constraints.

### Vertical coherence

Wants the generator to know where to put a plane-1 floor so that a staircase
lines up, and to avoid second floors larger than the first —

> "at least not where it makes sense, of course, some buildings do have second
> floors that overhang the first"

So: containment is the rule, overhang is a *learned exception rate*, not a
hand-picked constant.

### Specific faults in the current generator

From the generated island fishing village. Every one traced to the same root
cause (§4):

- **Torches** that are primarily used *inside buildings* in the real map, placed outdoors.
- **Unlit torches** — "I honestly don't know where you got it from."
- **White rocks**, clearly meant for a mountainous or snowy region, on a tropical island.
- **Stumps** only ever used in rainforest areas.
- **No docks**, on an island fishing village.

### Constraints Cody set

- Storage is not a concern — offered to buy a TB or more. (Answered: not needed, §3.)
- Wants to know up front how much is scripts vs. AI token spend. (Answered: §9.)
- Was willing to run over the map "10x/100x/1000x, even a million times". (Answered: §2 — passes are the wrong axis.)

### Reference point

Cody has seen someone else do this with **WFC for terrain, biomes and
buildings**, synthesising buildings from scratch rather than copying. That
report is what moved WFC from "last priority" to a core component — see §5 for
where it does and does not apply.

---

## 2. The one correction to the framing

> "run over the entirety of the runescape map 10x/100x/1000x, even a million times"

**Extra passes add no information.** The map is a fixed dataset; after ~3 passes
a learner is memorising, not learning. The instinct is right but the axis is
wrong.

What "really LEARN what goes where" means mechanically is **conditioning**, not
iteration. One pass that records fifteen context features per placement learns
enormously more than a thousand passes that record two.

The current generator conditions on essentially **one variable — the object's
name string**. That single fact explains every fault in §1. Fixing it is not
about more passes; it is about more conditioning variables.

---

## 3. What is actually in the map (measured)

| | |
|---|---|
| region files | 2,413 (2,108 populated) |
| loc placements | **5,120,914** |
| distinct object ids **used** | 53,584 |
| objects **defined** in the cache | 73,913 |
| **defined but never placed anywhere** | **20,329 (27%)** |
| raw `maps/` JSON on disk | 510 MB |

Placements by plane — **29% of the map is above ground level**, and every survey
we have done so far read plane 0 only:

| plane 0 | plane 1 | plane 2 | plane 3 |
|---|---|---|---|
| 3,624,958 | 976,751 | 403,557 | 115,648 |

By loc class:

| class | count | share |
|---|---|---|
| scenery (10) | 2,296,312 | 44.8% |
| ground decor (22) | 1,739,563 | 34.0% |
| **wall (0-3, 9)** | **925,945** | 18.1% |
| wall decor (4-8) | 78,101 | 1.5% |
| roof (12-21) | 56,926 | 1.1% |
| scenery diagonal (11) | 24,067 | 0.5% |

**Storage is a non-issue.** The whole map is 510 MB raw; the *learned* model is
smaller still (§5 — 50 symbols and 708 rules for building structure). Do not buy
a drive. And note the corollary: **scaling the mine is free in tokens** (§9), so
there is no reason to sample rather than read everything.

---

## 4. Why the fishing village is wrong (measured)

The generator picks objects by **name substring, sorted by name length**. It has
no idea whether the game ever uses the object it picked. Probing the exact ids
our picker chose:

| id | name | reality in the map |
|---|---|---|
| 13200, 13201, 13202 | Torch | **never placed anywhere** |
| 24738 | Beanstump | **never placed anywhere** |
| 46319 | Ivy stump | **never placed anywhere** |
| 11634 | Rock | **never placed anywhere** |
| 15775 | Stump | 12 placements, 4 regions — surrounded by **Jungle Grass, Jungle plant, Tropical tree** |
| 11097 | Rock | 1 placement — surrounded by **Sandstone / Granite / Coal / Clay rocks** (mine furniture) |
| 10036 | Rock | 1 placement — **100% within 2 tiles of a wall** |

Cody called all of these by eye. The data agrees exactly. Note how *cheap* the
signal is: a single co-occurrence query identifies the jungle stump.

**Two independent fixes fall out:**

1. **Frequency prior** — never place an object the game itself never places, and
   weight selection by real placement count. 27% of the object table is
   unreachable content. This alone deletes the beanstumps and phantom torches.
2. **Context model** — §5.

### Docks exist

| | |
|---|---|
| waterside / fishing objects **defined** | 404 |
| ...actually **placed** by the map | 296 |
| defined but never placed | 108 |

The game's real waterside vocabulary, by placement count: **Fishing spot (168)**,
Nettles (81), **Fishing ledge (75 + 40 + 35 + 35 across four variants)**, Fishing
net (66), Ship's wheel (32), Full fishing net (24), **Ship's ladder (22)**.

So an island fishing village *can* get a working waterfront. "Fishing ledge at
the water's edge near a settlement" is a learnable context; assembling a
multi-tile pier is structural work (§5).

---

## 5. The architecture: two mechanisms, one mine

The single most important design decision in this document.

### WFC is the wrong tool for scenery

WFC constrains by **adjacency** — every local window in the output must have
occurred in the input. That works for walls because walls are *dense and
contiguous*: 280k wall tiles across 2,304 buildings, every one touching another.

Scenery is the opposite. At 1–2 placements per 100 tiles, a tree's eight
neighbours are empty ground ~99% of the time. The rule WFC would learn is
*"empty next to empty"*. **Pointing WFC at scenery scatter teaches it nothing
about which stump belongs on a jungle island.**

### The context model handles "what goes where"

For each of the 5.1M placements, tabulate it against its context:

- underlay id, overlay id + shape, slope, absolute height
- distance to water, to path, to nearest wall / building interior
- plane
- which object **classes** occur within radius R
- the region's overall biome signature

Then invert at generation time: *given this context, what does the real game
actually place here?* Tabular, exact, no training, no GPU, queryable both
directions. This is what makes a fishing village feel like a fishing village.

### WFC handles "how structure assembles"

Measured on the 200 wall-densest regions (2,304 buildings, 280,486 wall tiles),
encoding a cell as the multiset of (shape, rotation) on a tile:

| | |
|---|---|
| distinct structure cells (the alphabet) | **50** |
| cells covering 95% of all wall tiles | **12** |
| observed adjacencies (N/E) | **708** of 5,000 possible — **14% permissive** |
| distinct wall object ids per building | p50 **4**, p90 16, max 119 |
| distinct structure cells per building | p50 **9**, p90 14, max 25 |

A 14%-permissive grammar has real teeth — a loose grammar produces mush. This is
a *smaller and better-conditioned* problem than the classic WFC demos.

The wall-object-ids figure (median 4 per building) proves material is a
**per-building palette choice**, not a per-tile one. Hence a **two-stage solve:
WFC picks structure, then a material pass assigns ids from one coherent family.**
Otherwise you get a house made of twelve different wall styles — the single most
obvious "this was generated" tell.

### Division of labour

| problem | mechanism | why |
|---|---|---|
| which object id, and where | **context model** | sparse — adjacency carries no signal, context does |
| how walls / roofs / docks assemble | **WFC** | dense, contiguous, 50 symbols / 708 rules |
| terrain & biome fields | **WFC** | dense grid, ideal fit |
| paths | **routing + learned profile** | a path is a *route*; WFC cannot produce connectivity |
| buildings along paths | **relational statistics** | learned setback, door orientation, spacing |

All of it comes from **one pass over the map**. The context model, the WFC
grammars and the relational stats are three outputs of the same mine.

On paths specifically: keep A\* routing, but learn the *cross-section* — which
materials by context, what objects sit at what offset, how junctions are
treated. "Buildings around paths" is a few measured distributions: door
orientation vs nearest path, setback distance, spacing along a road.

---

## 6. Building synthesis, without prefabs

What Cody described is **not one algorithm**. It is six layers, and WFC is only
one of them. Pointing WFC at a whole building is exactly what produces rooms
with no doors and walls that wander.

| # | layer | what it decides | difficulty |
|---|---|---|---|
| 1 | **Massing / footprint** | the outline and its wings | medium |
| 2 | **Room subdivision** | interior partitions | **hard — the real one** |
| 3 | **Wall realization** | shape, rotation and object id per edge | easy-ish (grammar measured) |
| 4 | **Openings & connectivity** | doors; every room reachable | medium, must be *exact* |
| 5 | **Furnishing** | rugs, candles, chests, tables | **nearly free** |
| 6 | **Vertical** | upper floors, stairs, overhang | blocked on §8 |

Nothing here copies a layout. Every building is new; it obeys learned statistics
at each level.

### Warning: local growth produces amoebas

Cody's sketch — "place a wall next to another, then another, maybe diagonal to
make it bigger" — is local accretion, and local accretion yields blobs. Real RS
buildings are rectilinear masses with wings, and that shape comes from a global
decision, not tile-by-tile growth. **Layer 1 must learn the footprint vocabulary
(what rectangles, what sizes, how they compose) and sample from it**, then let
WFC realize walls within that outline. Same end result — a building nobody
authored — but building-shaped instead of blob-shaped.

### Furnishing is already solved by the data

Measured across 1,190 buildings with a resolvable interior (median 36 interior
tiles), by Manhattan distance to the nearest wall tile. Wall tiles are excluded
from the interior, so **d1 = touching a wall**:

| object | n | d1 | d2 | d3 | d4+ | **against wall** |
|---|---|---|---|---|---|---|
| Suit of armour | 174 | 98% | 2% | 0% | 1% | **98%** |
| Lamp | 180 | 94% | 1% | 6% | 0% | **94%** |
| Bookcase | 159 | 87% | 4% | 6% | 3% | **87%** |
| Shelves | 240 | 84% | 5% | 9% | 2% | **84%** |
| Stairs | 452 | 76% | 6% | 4% | 14% | **76%** |
| Crate | 304 | 71% | 14% | 4% | 11% | **71%** |
| Staircase | 162 | 71% | 20% | 6% | 2% | **71%** |
| Bed | 230 | 69% | 28% | 3% | 0% | **69%** |
| Ladder | 220 | 54% | 38% | 7% | 2% | **54%** |
| Chair | 1,075 | 52% | 18% | 28% | 2% | **52%** |
| Rug space | 1,412 | 51% | 39% | 11% | 0% | **51%** |
| Table | 807 | 47% | 20% | 22% | 11% | **47%** |
| Stool | 464 | 47% | 17% | 14% | 22% | **47%** |
| Crates | 152 | 38% | 19% | 14% | 30% | **38%** |
| Floor space | 168 | 17% | 50% | 33% | 0% | **17%** |
| **Bench** | 2,819 | 9% | 23% | 27% | 41% | **9%** |
| **Pillar** | 147 | **0%** | **0%** | 50% | 50% | **0%** |

Armour and lamps hug walls. **Pillars are never against one** — dead central,
exactly right. Benches sit in open rows (pews). Cody's "chests around the sides
of rooms" is a distribution you sample from directly. Layer 5 is the *cheapest*
layer, not the hardest.

### Vertical coherence is a constraint problem, not an AI problem

"A staircase at (x,y) on plane 0 must have a matching opening at (x,y) on plane
1" must be **guaranteed**, not probable. An LLM would get it right ~95% of the
time, which means one building in twenty has a staircase into solid rock — and
that is exactly the class of fault you cannot fix by hand at scale, licence to
ship rough output notwithstanding.

So: **enforce deterministically, learn the parameters.** The overhang rate, its
direction and magnitude are measurable numbers. The rule becomes "upper ⊆ lower,
except at the measured rate and in the measured shape."

### Where Claude actually belongs

**Composition and intent, one level up.** "A castle with a great hall, two
flanking towers and a courtyard" → a layout of masses and rooms. "This is a
fishing village, so buildings are small, wooden, and face the water." That is
design judgment, which is what an LLM is genuinely good at.

Per-tile placement is the wrong job for it: too many decisions, too slow, and
non-deterministic precisely where guarantees are needed. `ProcPlan` is already
the right seam — Claude directs, the executor guarantees.

---

## 7. Scoring — how we know it worked

Every layer has a **measurable target**, so synthesis can be scored against
reality rather than eyeballed: generate 100 buildings, re-run the §6 interior
probe, and compare our wall-distance table to the real one. Same method used to
validate the ore clustering work (`docs/procgen-reference.md` §5), where the
generated distribution was matched to the real one percentile by percentile.

This is what makes the project tractable. We can tell whether buildings are
RuneScape-shaped without loading each one and squinting at it.

The held-out prefab corpus (§1) is the other half of scoring: 9,700 real
buildings to compare synthesis against.

Extracted structure counts, for reference:

| connected wall components | 27,625 |
|---|---|
| fragments / fence ends (1–3 pieces) | 10,755 |
| sheds, huts (4–11) | 7,167 |
| house-sized (12–40) | 4,783 |
| large buildings (41–120) | 3,195 |
| castle / complex (121+) | 1,725 |

---

## 8. Open unknowns — verify, do not assume

1. **How does the cache represent an upper-storey floor?** Whether there is an
   explicit floor/opening concept on planes 1–3, or whether it is implicit in
   the terrain planes and tile flags, is **not known**. This determines what
   "line the staircase up" concretely means and blocks layer 6. Trace it against
   **darkan-bot-refactor** before designing anything on top of it.
2. **Everything measured so far is plane 0 only.** The trees, ore, path and
   settlement surveys all ignored 29% of the map. The mine must read all planes.
3. **Footprint vocabulary is unmeasured.** Layer 1 needs it.
4. **Room subdivision approach is undecided.** Learned BSP split ratios vs.
   learned room-adjacency graphs. Needs the room stats from the mine first.
5. **Rotation remapping semantics.** Rotating a synthesised building means
   remapping every loc's rotation *and* respecting how shape types encode tile
   edges. Well-defined, but unverified against darkan.
6. ~~**Two-part trees**~~ — **DONE 2026-08-07**, see §11. It was wrongly listed
   here as blocked on unknown 1: a canopy is just a loc on plane 1 and needs no
   floor concept at all. Unknown 1 blocks buildings only.

---

## 9. Cost model

**~90% scripts. The map data never enters the model's context.**

510 MB of JSON is roughly 150M tokens — reading it would be impossible and
pointless. The discipline is: *a script reduces the data to a summary, and only
the summary is read.* Every measurement in this document worked that way; the
building extraction chewed through all 2,413 regions and returned twelve lines.

Consequence: **scaling the data is free in tokens.** Mining all 2,413 regions
costs the same as the 15-settlement survey did. The difference is CPU and
wall-clock, not spend — which is why there is no reason to sample.

**Decided 2026-08-07: do NOT ship a precomputed corpus.** Every user mines their
own cache in their own browser. This was offered (mine once offline, ship the
result as a static asset so nobody waits) and declined. Consequences to respect:
the mine must be cheap enough to run client-side, its output must go somewhere
per-user, and it must never assume a corpus already exists.

Token spend is concentrated in:

| phase | cost |
|---|---|
| frequency prior | small — a fraction of a session |
| context mine | moderate; *iterating* on the mining script is the real cost |
| generator integration | the largest chunk of the non-WFC work |
| WFC solver + constraints | biggest single piece |

Controls: aggregate hard in script output (percentiles and top-N, never row
dumps), and batch several measurements into one run rather than one question per
round-trip. Long scans go to the background.

---

## 10. Order of work

1. **Frequency prior** — never place what the game never places; weight by real
   placement count. Cheapest thing on the list, immediately visible in the
   fishing village, and it needs the same placement-count pass the full mine
   starts with, so nothing is wasted.
2. **The mine** — all 2,413 regions, **all planes**. Emits the context model,
   the WFC grammars, footprint vocabulary, room stats, relational path stats,
   and the trunk→canopy map. Includes the §8.1 trace.
3. **Context-driven species selection** — replaces name matching in the
   generator. This is what fixes §1's fault list.
4. **Wall realization + connectivity** — WFC within a learned footprint, with
   guaranteed doors and reachability.
5. **Furnishing** — nearly free once the mine exists.
6. **Vertical** — upper floors, stairs, learned overhang. Blocked on §8.1.

Prefab stamping is *not* in this list. It survives only as the §7 validation
corpus.

---

## 11. Built so far

### Step 1 — frequency prior (2026-08-07, untested in the browser)

`scenery.ts` now reads the `maps/` folder once per cache and records, for every
name-matched candidate, **how often the real game places it** and **how often it
does so within 2 tiles of a wall**. Selection then:

1. drops candidates the map never places,
2. drops candidates that are ≥80% indoor (`INDOOR_CUTOFF`),
3. sorts and samples in proportion to `uses × (1 − indoor)` — estimated
   *outdoor* placements.

Each step only applies if something survives, so a species is never silently
emptied. `SceneryIndex` gained `weighted`, and the localStorage key moved to
`:v2` so old caches rebuild. Falls back to the previous name-length behaviour
when `maps/` can't be read.

**Measured effect** — of 5,701 name-matched objects, **2,603 (46%) are never
placed anywhere**:

| species | before (name length) | after (real outdoor usage) |
|---|---|---|
| torch | 4 torches, **all 0 uses** | **Blazing torch** #62703 — 0% indoor |
| tree_stump | Stump #15775 [12] — the jungle one | Tree stump #4328 [138] |
| rock_large | Rock #10036 [1], #11634 [0] | Rock #49257 [498 outdoor] |
| crate | Crate #1 [1] | Crate #59433 [232] |
| bench | Bench #1104 [3] | Bench #58971 [368] |

The indoor test earns its place on Cody's original complaint: the three
commonest torches are **88%, 100% and 100% indoor**, and the one the filter
keeps is 0%. Likewise `plant`, whose commonest member is the indoor "Potted
Plant" (8,562 uses, 84% indoor).

### The biome-conflation trap (found by shipping the above)

Weighting by global usage **introduced a regression** that name-length sorting
had accidentally hidden. Karamja is dense enough in the real map that the
generic buckets were dominated by jungle content:

| bucket | jungle/tropical | plain |
|---|---|---|
| `grass_tuft` | Jungle Grass **4,138** | Grass 1,237 |
| `tree` | Tropical tree ~5,435 | Tree ~17,311 |
| `plant` | Jungle plant 3,101 | 4,033 |

Left alone, 77% of every grass tuft in the game — snowfields included — would
have been jungle grass. Fixed by splitting **`tree_tropical`**, **`grass_jungle`**
and **`plant_jungle`** out as their own species, excluding them from the generic
patterns, and giving the `karamja_tropics` theme a `JUNGLE_UNDERGROWTH` floor
mix. `woodland()` gained an undergrowth-mix parameter.

**The general lesson, which the context model must not repeat:** a global
frequency prior is *context-blind*, and the map's global mix is not any one
place's mix. Frequency answers "does the game use this at all" — it cannot
answer "does the game use this *here*". That is exactly the gap §5's context
model closes, and until it lands, any bucket that spans biomes will drift
toward whichever biome the map has most of.

### The canopy trap (found by Cody in the browser)

The same context-blindness bit a second time, and worse. A two-part tree is a
**trunk on plane 0 and a canopy on plane 1, sharing a name, on adjacent ids**.
Frequency cannot tell them apart, so the prior picked the *canopy* for five
species and planted foliage on the ground with no trunk under it:

| species | frequency picked | actually |
|---|---|---|
| tree_oak | Oak #38736 (758) | **100% plane 1** |
| tree_yew | Yew #38758 (71) | **100% plane 1** |
| tree_evergreen | Evergreen #54795 (389) | **100% plane 1** |
| tree_willow | Willow #38717 (160) | **100% plane 1** |
| tropical | #1327 (1246) | **100% plane 1** |

Fixed with a third filter: `ground` (share of placements on plane 0), cutoff
0.5, applied **before** the indoor filter — a canopy is 0% ground *and* 0%
indoor, so the indoor test alone would have kept it. Every tree species now
resolves to a 100%-plane-0 trunk.

Note the ordering dependency: the three filters are *drop never-placed → drop
non-ground → drop indoor*, each applied only if something survives.

This is the second regression the frequency prior introduced, both from the
same root cause. Any future conditioning variable should be assumed to hide a
similar trap until measured.

### Step 1b — two-part trees emitted (2026-08-07, untested in the browser)

The same scan now records, per ground object, the commonest loc the game places
directly above it, and keeps it as a canopy when it happens at least half the
time (`CANOPY_MIN_RATE`) — so a tree that once stood under a bridge doesn't
teach us that trees carry bridges. Stored on the index as `canopies`, pruned to
ids that survived selection.

`generate()` emits the canopy at the single central placement site: same tile,
**same shape, same rotation**, plane 1. Both are measured, not assumed — the
real map pairs shape exactly (including the six shape-11 oaks, which pair with
shape-11 canopies) and rotation in 99.3% of 2,439 pairs.

Harvested map: oak 38731→**38736**, yew 38755→**38758**, evergreen
54787→**54795**, tropical 1326→**1327**. Willow has no partner. Pair rates
97–100%.

Verified offline on a `dense_forest` seed: 138 plane-0 placements produced 17
plane-1 canopies, exactly one per canopy-bearing trunk, shape and rotation
matching, and **zero** plane-1 objects that weren't a known canopy.

**A claim in §8 this disproves.** Two-part trees were listed as blocked on the
upper-storey unknown. They were not: a canopy is just a loc on plane 1 and
needs no floor or opening concept. §8.1 still blocks *buildings*; it never
blocked trees.
