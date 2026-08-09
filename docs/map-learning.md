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

1. ~~**How does the cache represent an upper-storey floor?**~~ **ANSWERED
   2026-08-08 — see §13. There is no explicit floor or opening concept.** Layer 6
   is no longer blocked on an unknown.
2. **Everything measured so far is plane 0 only.** The trees, ore, path and
   settlement surveys all ignored 29% of the map. The mine must read all planes.
3. ~~**Footprint vocabulary is unmeasured.**~~ **MEASURED 2026-08-08 — see §14.**
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

## 9a. Plan v2 — the plan should stop deciding materials

Cody, 2026-08-07, and he is right:

> "A plan should really just tell the procgen the type of area, the number of
> plots maybe, types of buildings, maybe even the path, or how hilly an area
> is. The procgen should then choose underlay materials related to the type of
> area, choose what material to use for the path, scatter trees and plants
> based on that area. We kinda defeat the purpose of the procgen if most things
> are decided by the plan, that doesn't have access to all the stuff we're
> making now."

Exactly the problem. A plan is authored either by `planner.ts`'s hand-written
themes or by a language model from a one-line description — **neither has read
the map**. Every `underlayId`, species list and density baked into a plan is a
guess overriding the one component that actually knows: the mine.

### What a plan should carry, and what it should not

| stays in the plan | moves to the generator |
|---|---|
| area type ("coastal fishing village") | underlay / overlay ids |
| zones, and what each is FOR | path surface material |
| plot count, building kinds | species lists |
| path structure (coverage, loops, width) | scatter densities |
| relief / hilliness, landform | ground bands by slope and height |
| mood (environment) | which variant of anything |

The plan describes **intent and composition**. The generator supplies the
**vocabulary**. That is the split `ProcPlan` was meant to have — Claude is good
at "a sprawling market east of the castle" and bad at "underlay 163".

### The mechanism: archetypes learned from real regions

Feasibility measured 2026-08-07. Signature per region = share of the 12
commonest underlays + scenery density + wall density; k-means, k=8, over the
1,549 regions with real ground:

| cluster | n | ground mix | scenery | walls | reads as |
|---|---|---|---|---|---|
| #3 | 184 | 48:55%, 55:9% | 19 | 7 | empty grassland / wilds |
| #0 | 85 | 62:22%, 49:12% | 376 | 39 | swampy, unbuilt |
| #7 | 222 | 163:48%, 70:30% | 400 | 319 | **town — contains Varrock (50,53)** |
| #5 | 358 | 63:9% | 400 | 382 | dense built-up |
| #4/#6 | 285 | 49/160/163/161 mixed | 400 | 221-378 | settlement in green country |

Recognisable place types fall out of the raw data with no labelling. So:
a plan says *"coastal fishing village, 5 plots, gently hilly, one road"*, the
generator picks the nearest archetype and takes its **real** ground palette,
species mix, densities and path material from the map.

(The density figures above saturate at a cap of 400 — a real implementation
needs better normalisation. The clustering concept is what this proves.)

### Two ways to hold the knowledge, and we want both

1. **The generator derives from archetypes.** Deterministic, always available,
   needs no LLM. This is the primary path and the one that answers Cody's
   question.
2. **Feed the planner a summary of the mine** — available archetypes, what each
   ground role actually looks like, which species really exist here — so an
   authored plan is informed rather than guessed. This makes Claude's
   *composition* better, which is what it is genuinely good at.

Neither replaces the other: (1) stops the plan making decisions it is
unqualified to make, (2) stops the planner composing something the cache cannot
supply.

### Depends on

The `(species, id)` scoring change (§10a) — species must be selectable by
context before roles can replace explicit species lists.

---

## 10a. RESUME HERE — state as of 2026-08-07, end of session

**Everything below is UNCOMMITTED.** Last commit is `d02dd97`
("feat(procgen): build the generator on measured map data"). Typecheck, lint
and `npm run build` are all clean.

### Done and verified offline, NOT yet seen in the browser

| | where | state |
|---|---|---|
| frequency prior | `scenery.ts` | §11 — shipped, Cody has used it |
| multi-part trees | `scenery.ts` + `generate.ts` | §11 — oak/yew/evergreen verified in-browser by Cody; 3-part tropical built after that, unverified |
| **context model** | `context.ts`, `modelStore.ts`, `terrainNoise.ts` | §12 — built, offline-verified only |

### FIRST THING IN THE MORNING

The scenery index is at **`:v6`** and the context model is new, so Cody's next
generate triggers a **full rescan** (74k object files + 2,413 region files).
That is expected. What to check, in order:

1. Do tropical trees now show stump + trunk + **crown** (three locs)?
2. Do oak/yew/evergreen canopies still sit flush? (regression check)
3. Does the scan finish in a tolerable time now that it also decodes four
   base64 channels per region and evaluates terrain noise? **This is the main
   risk of the context work** — it was never timed in a browser.
4. Does the mix of species visibly vary with ground?

### Questions for Cody (also in TODO.md)

- **Tropical loc 1329 (plane 3).** He thought he saw one. The aggregate says
  it is 2 placements in 1,222 (0.16%) — noise. Needs the tile or ids he was
  looking at to check that specific tree.
- **Every generated tropical gets its crown**, but the real map only gives
  1326 one 58% of the time. Fix is to store each layer's rate and roll per
  tree; costs an index bump and another rescan. Offered, not done.

### Next steps on the mine, in order

1. **Retire the hand-added filters.** `INDOOR_CUTOFF`, `GROUND_CUTOFF` and the
   never-placed drop in `scenery.ts` are all special cases the model subsumes
   (P(wall|object), P(plane|object), P(object)=0). Keeping both means two
   things to keep in sync. Do this only once the model is confirmed working in
   the browser — the filters are the safety net until then.
2. **Re-encode the neighbour feature by object CLASS.** As a raw count it
   measured 1.2% and was dropped; "what is growing near me" is very likely
   worth more than that, and it is the natural way to get copses of one
   species rather than a uniform mix.
3. **Distance-to-water and distance-to-path features.** Both are cheap at
   generation time (`f.waterDist` already exists) but need a BFS per region
   during the scan.
4. **Then the building work** (§6), which is the larger prize and is still
   blocked on §8.1 — how the cache represents an upper-storey floor.

### Watch out for

- **`STORAGE_KEY` must be bumped on any stored-shape change** (`scenery.ts`).
  Missing that has already shipped one silent bug. The context model is
  validated separately by fingerprint + `version`.
- **`binOf` in `context.ts` is a contract.** The scan and the generator must
  bucket identically or the histograms describe one world and are queried
  about another. Never inline an equivalent.
- **Verify through the function the renderer actually calls.** Five attempts at
  the canopy height failed because each test reimplemented an assumption. See
  §11's lessons.

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

#### The canopy also needs a plane-1 HEIGHT (found in the browser)

Emitting the loc was not enough: the foliage rendered floating well clear of
its trunk. With no stored height on plane 1, `mapScene.ts` places that plane a
**full storey (960 units)** above plane 0, and we were storing none.

The real map's convention is **species-specific**, measured over 2,464 real
trunk+canopy tiles:

| species | plane-1 height at the canopy tile |
|---|---|
| oak | **72% store byte 1** (= flush with plane 0) |
| yew | **75% byte 1** |
| evergreen | **98% byte 1** |
| tropical | **81% store nothing** → the 960 fallback, 18% store 30 (also 960) |

So an oak/yew/evergreen canopy sits at ground level — its *model* carries the
height — while a tropical canopy genuinely does sit a storey up. Note byte 1
decodes to 0: the renderer maps `value === 1` to zero.

The index therefore stores `{ id, lift }` per canopy, `lift` being the modal
height byte or -1 for "leave unset", and `generate()` writes plane-1
`heightValue`/`heightPresence` when lift ≥ 0. Verified on both branches: a
`dense_forest` seed put byte 1 on all 17 oak canopies, and a `karamja_tropics`
seed left all 22 tropical canopies unset while still flushing 3 oaks — zero
wrong in either.

#### ...and the height must cover FOUR tiles, not one (the actual fix)

Writing the height at the canopy's own tile was still wrong, and took four
attempts to find because every check I ran said it was right.

Heights live on a **65×65 vertex grid** where vertex (gx,gy) reads **tile**
(gx,gy), and `averageHeight` **bilinearly interpolates a tile's four corners**.
Writing one tile therefore fixed one corner and left the other three on the
"no stored height" path — a full storey down. Measured at the tile centre the
way the renderer does it:

| | oak / yew / evergreen | tropical |
|---|---|---|
| single-tile write | **−720** (¾ × 960) | −960 |
| all four corner tiles | **0** ✓ | −960 ✓ |

**This is why tropical looked right and oak did not**: tropical stores nothing,
so all four of its corners agreed on the same fallback, while oak had one
corner flush and three a storey up. Real regions store plane-1 heights across
**large contiguous areas** (376–4,096 of 4,096 tiles measured), never at
isolated tiles — the shape of the real data was the clue.

The fix writes the lift to the 2×2 block of tiles supplying the canopy tile's
corners, crossing into the neighbouring region when the tile sits on a border.

#### ...and the four vertices depend on the loc's FOOTPRINT (the actual fix)

Even a 2×2 block was wrong. `buildLocsMesh` does **not** use the ground's
`averageHeight`; it has its own average over four vertices chosen by the loc's
**footprint**:

```
xA = x + (size>>1)      xB = x + ((size+1)>>1)     (same for y)
avgHeight = (h[xA,yA] + h[xB,yA] + h[xA,yB] + h[xB,yB]) >> 2
```

So the sampled vertices move with size:

| canopy | size | samples | 2×2 block enough? |
|---|---|---|---|
| tropical 1327 | **1×1** | x, x+1 | yes (and it writes nothing anyway) |
| evergreen 54795 | **2×2** | x+1 only | yes |
| **oak 38736** | **3×3** | **x+1, x+2** | **no** |
| **yew 38758** | **3×3** | **x+1, x+2** | **no** |

That is the whole mystery: tropical and evergreen were inside the block, oak
and yew were not. The index therefore stores the canopy's `size`, and the emit
writes exactly `[lo..hi]²` where `lo = size>>1`, `hi = (size+1)>>1`.

Verified against a full **mosaic** (not a single region): oak 248/248 at offset
0, evergreen 95/95 at 0, yew 28/28 at 0, tropical 60/60 at −960.

A tree on the area's **outer edge** needs a vertex owned by a region we aren't
generating. That is all-or-nothing now: if any sampled tile is unreachable the
canopy is skipped entirely, because a partly-written height averages to
something between the two and floats worse than no canopy at all.

#### ...and a tropical tree is THREE locs, not two

Found by Cody once oak and yew were right. Measured over the whole map:

| trunk | plane 1 | plane 2 | plane 3 |
|---|---|---|---|
| tropical **1326** | 1327 — always | **1328, 714 of 1,217 (59%)** | 1329, 3 cases |
| tropical 1375 | 1376 | — | — |
| oak / yew / evergreen | one layer | — | — |

So 1326 is a *stump*, 1327 the *trunk*, 1328 the *crown* — each a storey apart
(both planes store "unset", i.e. the 960 default). A single partner could only
ever build two thirds of the tree, which is why its top was missing.

`canopies` is now a **stack** (`CanopyLayer[]`, index 0 = plane 1), built by
walking upward until a plane isn't reliably occupied — which keeps plane 3 out,
at 3 occurrences in 1,217. Note that heights are cumulative: each layer's plane
is measured from the one below, so every level needs its own `lift`.

Verified through the mosaic: `1326@p0 → 1327@p1 → 1328@p2` ×60 with steps
−960/−960, alongside oak ×248, evergreen ×95 and yew ×28 all at step 0. One
oak on the area's outer edge was correctly skipped rather than half-written.

**Lessons worth keeping:**
- **Ask how many parts a thing has before modelling it as two.** "Trunk plus
  canopy" was an assumption that survived four rounds of debugging because it
  was never the thing being tested.
- Copying a loc across planes is not enough. Plane N's *terrain height* is part
  of the placement, its default is a whole storey, and the error is purely
  visual — no type or count check catches it.
- **A per-tile value read through a vertex grid is not a per-tile value**, and
  *which* vertices are read can depend on the object, not just the tile.
- **Verify through the exact function the renderer calls.** Five attempts
  failed here, and every one of them "passed" a check: first a single vertex,
  then the ground's `averageHeight` — neither of which is what a loc uses.
  Locs go through `buildLocsMesh`'s own footprint-aware average. Find the real
  call site before writing the test, or the test will confirm the bug.
- **Test at the scale the bug lives at.** A single-region harness reported 6
  false failures at the seams because it clamped where the real mosaic reads
  the neighbour. Build the mosaic.

**A claim in §8 this disproves.** Two-part trees were listed as blocked on the
upper-storey unknown. They were not: a canopy is just a loc on plane 1 and
needs no floor or opening concept. §8.1 still blocks *buildings*; it never
blocked trees.

---

## 12. The mine — feature study (2026-08-07)

Measured before building anything, so the client-side pipeline is only asked to
carry features that pay their way. All 2,413 regions decoded, 75,644 candidate
placements on plane 0, 2,726 distinct objects, H(object) = 8.41 bits.

### Which features predict WHICH object

Mutual information between each context feature and object identity:

| feature | MI (bits) | % of object identity |
|---|---|---|
| **underlay** | 2.905 | **34.5%** |
| overlay | 1.635 | 19.4% |
| height | 1.185 | 14.1% |
| slope | 0.929 | 11.0% |
| wall proximity | 0.495 | 5.9% |
| neighbour count | 0.105 | 1.2% |

**Underlay is the dominant signal** — the ground material really does tell you
what grows on it. Wall proximity is real but modest, which fits its role as a
*filter* rather than a discriminator. **Neighbour count is worthless as
encoded** (1.2%): a raw count of nearby locs carries almost nothing. If
neighbours are to be used at all it must be by object *class*, not by count.

### Does it actually beat the frequency prior?

Deterministic 80/20 split, naive Bayes over the five useful features with
Laplace smoothing, scored against held-out placements:

| | top-1 | top-5 | mean log-likelihood |
|---|---|---|---|
| frequency prior only (§11) | 11.5% | 21.4% | −5.568 |
| **+ context** | **27.9%** | **55.5%** | **−3.268** |

60,515 training placements, 1,131 candidates with ≥5 examples. **2.4× at top-1,
2.6× at top-5**, and a likelihood ratio of about ten. Random would be ~0.09%.

### Design decisions this settles

- **Naive Bayes over per-object marginals, not joint context tables.** 75,644
  placements across 2,726 objects is ~28 examples each; joint keys would be
  mostly empty. Marginals stay dense, stay small, and measurably work.
- **Store P(context | object) + the P(object) prior**, and apply Bayes at
  generation time. Storing P(object | context) directly explodes.
- The model **subsumes** §11's three hand-added filters: never-placed is
  P(object)=0, indoor is P(wall|object), ground is P(plane|object). They should
  be retired as special cases once this lands, not kept alongside it.
- Drop the neighbour feature until it can be re-encoded by class.

### Costs the browser pipeline must carry

The frequency scan only had to read each region's `objects` array. The mine
must additionally decode four base64 channels per region (`underlayIds`,
`overlayIds`, `heightValue`, `heightPresence`) and evaluate the terrain height
noise where a tile has no stored height. Budget for meaningfully more CPU than
§11's scan, on top of the same I/O.

### Step 2 — the context model, BUILT 2026-08-07 (untested in the browser)

Three new pieces:

- **`src/procgen/context.ts`** — `TileContext`, the `binOf` bucketing (the
  single source of truth shared by scan and generator), `observe`/`finalise`,
  and `contextLikelihood`.
- **`src/procgen/modelStore.ts`** — IndexedDB persistence, keyed by cache
  fingerprint. Every call resolves rather than rejects; a missing model just
  means generation falls back to the frequency prior.
- **`src/components/terrainNoise.ts`** — `calculateTileHeight` and its noise
  chain, lifted verbatim out of `mapScene.ts` so the scan can use it without
  importing three.js. `mapScene` re-exports it, so existing importers are
  unaffected.

The model is built in the **same pass** as the frequency counts — reading 2,413
region files is the expensive part of indexing, and doing it twice to learn two
things about the same placements would be the wrong trade. `resolveSpecies` now
takes an optional model + tile and weights candidates by
`outdoorUses x contextLikelihood`; `generate(plan, index, model)` threads the
tile through every placement site via `tileContext(f, i)`.

Feature parity between scan and generator is free, and must stay that way:
`f.underlay`/`f.overlay` already hold material BYTES and `f.height`/`f.slope`
are in stored units — exactly what the dump stores. **No conversion, and none
should be introduced.** `wall` is always 2 at generation time, which is honest
rather than neutral: the generator plants outdoors, and that steers selection
away from furniture on its own.

Measured on the real dump: **2,754 objects, 0.39 MB serialised**. Small enough
that localStorage would technically hold it; IndexedDB is kept because it will
grow as features are added.

## 12a. Roles, joint scoring, and the temper calibration (2026-08-07)

Step 3 of §10 — "context-driven species selection" — plus the `(species, id)`
scoring fix Cody asked for. **All measured against the real dump through an
offline rig that bundles and runs the actual `src/procgen` modules** (see "The
rig" at the end), rather than a reimplementation of them.

### What changed

- **`RoleId` + `SceneryChoice` in `types.ts`.** A scatter rule, barrier, prop,
  lighting spec or resource node may now name a ROLE (`canopy`, `undergrowth`,
  `deadwood`, `loose_stone`, `ore`, `enclosure`, `settlement_prop`, `light`,
  `memorial`, `waterside`) instead of a species list. `ROLE_SPECIES` in
  `scenery.ts` maps each to its member species, deliberately generously — the
  point is to hand the whole plausible vocabulary to the scorer and let the map
  decide, not to re-guess here.
- **`chooseScenery` replaces `resolveSpecies` + `pickWeighted`.** Every
  candidate in every offered species now competes in ONE pass, weighted by
  `species prior x outdoor uses x context likelihood`. Previously the species
  was chosen from the plan's weights first, so context could pick a different
  oak but could never say "not an oak".
  - a plan naming **species** keeps its weights: the species' frequency mass is
    normalised out so only its *average* context fit modulates the weight.
    Without that, a species with twenty common variants would drown one with a
    single rare variant and the plan's numbers would be decoration.
  - a plan naming a **role** hands the decision over entirely: the prior is the
    species' real outdoor usage, which reduces to flat scoring over every
    (species, variant) pair.
- **Waterside species added — and two of them REMOVED again 2026-08-07.**
  `fishing_ledge` and `fishing_spot` are gone (index `:v10`); `waterside` is
  now `reeds` + `nettles`, i.e. the damp margin rather than a waterfront.
  Cody looked at them in the scene: a fishing spot is an NPC in this game, and
  a "Fishing ledge" is dock trim authored to sit on a dock that isn't there.
  **They passed every statistical test** — 185 placements, 100% on the ground,
  rarely near a wall — which is the lesson worth keeping: usage says the game
  places a thing, never that it can stand on its own. Original note follows.
- **Waterside species added** — `fishing_ledge`, `fishing_spot`, `nettles`.
  Cody's fishing village had no waterfront because the vocabulary had no word
  for one (§1). Fishing ledge is 185 placements over four variants, 100% on the
  ground. A PIER is deliberately not here: a multi-tile structure is structural
  work (§5), not something a scatter rule can drop. **Index bumped to `:v8`.**
- **Unseen objects no longer score 1.0** in `contextLikelihood`. Returning 1 was
  harmless while it only ranked variants of one species; once candidates compete
  ACROSS species, 1 is the maximum any object can score, so "we know nothing
  about this" would outrank every well-fitted object in the cache. It now backs
  off to the same Laplace formula at n = 0.

### THE HEADLINE: the geometric mean was the worst possible setting

`contextLikelihood` returned `pow(product, 1/5)` — the geometric mean over the
five features. Calibrated against the real map by total variation distance
between our species mix and the map's actual mix on each common ground
material, summed over canopy, undergrowth and loose_stone:

| T | 1 | 1.25 | **1.5** | 2 | 3 | 5 |
|---|---|---|---|---|---|---|
| TVD | 0.572 | 0.579 | **0.600** | 0.669 | 0.771 | **0.875** |

**T = 5 is the worst of every value tried, by a wide margin.** It diluted the
one feature carrying most of the signal (underlay, 34.5% of object identity) to
a fifth of its weight. Measured at T = 5: tropical trees were 16-27% of the
canopy on EVERY material and jungle plants were the majority of the undergrowth
everywhere — the §11 biome-conflation trap reappearing through the very
mechanism meant to close it.

**The justification for the geometric mean did not survive re-measurement.**
§12 blamed the product for monoculture ("99-100% of the weight on every kind of
ground"). That is mostly the FREQUENCY PRIOR, not the context product:
`tree_oak` gives its top variant 85% and `grass_tuft` 91% even at T = 5,
because one variant genuinely dominates real usage. What T actually costs is
variant spread, and modestly — `tree` runs 5.96 effective variants at T = 5 and
4.18 at T = 1.

`CONTEXT_TEMPER = 1.5` is the shipped value: the flat optimum runs 1 to 1.5,
and 1.5 is the best single value for `canopy`, the most visually dominant layer
(0.112 vs 0.148 at T = 1), while keeping more variant spread. **Re-run the
calibration if the feature set changes** — correlated features should raise T,
independent ones should lower it.

### Verified through the real `chooseScenery`

The mix now moves with the ground, and moves the way the map does:

| ground | our canopy | real |
|---|---|---|
| town earth (163) | tropical 6-7% | tropical 6% |
| byte 0 / 48 / 63 | tropical 20-27% | tropical 12-27% |

| ground | our undergrowth | real |
|---|---|---|
| 163 | fern 23%, flowers 23%, mushroom 18% | flowers 31%, mushroom 22%, fern 22% |
| 49 | grass_jungle 65% | grass_jungle 54% |
| 62 (sand) | plant_jungle 36%, plant 25% | plant_jungle 40%, plant 36% |

Also verified: role coverage is **10/10 roles, all species present** in this
cache; a role-only plan generates and is byte-identical across runs; all 17
built-in themes still generate (85-250 ms, 110-1112 placements) with canopies
still pairing correctly (oak 98 trunks → 95 canopies, tropical 1326 → 1327 →
1328 → 1329).

### Two findings that correct earlier assumptions

1. **Underlay 48 really is a jungle material in this cache.** The real map puts
   54% jungle grass on it. Reading "grass 48" from
   `docs/procgen-reference.md` as *temperate* grass and then seeing jungle
   appear on it looks like a bug and is not one. The palette ROLE names are our
   labels, not the cache's.
2. **Scenery on snow is not sparse — undergrowth on snow is ABSENT.** Underlay
   byte 26 carries 1,301 plane-0 placements overall but **zero** from the
   undergrowth candidate set. With no evidence, scoring falls back to the global
   prior, which is jungle-heavy, so a snowfield gets jungle undergrowth. This is
   the one place the §11 trap still bites.

### The likelihood REWARDED being poorly observed (found in the browser 2026-08-08)

Cody: *"we're literally getting 'Ice covered boulder (5037)' spawned in this
area. I thought the context was supposed to fix this."* He was right, and the
cause was in the scorer, not in the vocabulary.

`contextLikelihood` smoothed Laplace-style toward UNIFORM: `(seen + 1) / (n +
bins)`. With ~200 underlay bins that has its incentives backwards —

| object | placements | score on ground it has NEVER been seen on |
|---|---|---|
| Ice covered boulder 5037 | 9 | `1/209` = **0.0048** |
| Rock 60272 | 336 | `1/536` = **0.0019** |

**The rarer object wins by 2.5x purely for knowing less.** An object with a
handful of sightings has an almost flat distribution and can therefore never
score badly ANYWHERE, while a well-observed object that genuinely belongs
elsewhere is correctly crushed. On temperate grass every well-observed rock was
ruled out and the oddities were all that was left in the pool.

**Two smoothed fixes were tried and both failed**, which is worth recording so a
third is not attempted:

1. *Shrink toward the population distribution instead of uniform.* Made it worse
   on grass — the average object is a tree, so every rock inherited a tree's
   affinity for grass.
2. *Divide by the object's own peak bin.* With 9 observations the peak holds
   about 5, so an unseen bin still scores 1/6. Measured, ice boulders came out
   at 0.41-0.45 against a legitimate boulder's 0.37-0.53 — **overlapping, so no
   threshold exists.**

The information is not recoverable from 9 observations by any ratio. What IS
recoverable is categorical: **5037's nine placements are on bytes 58 and 26,
both snow.** So the gate became the question actually being asked — *has the map
ever placed this object on this ground material?* Candidates with zero
observations on the tile's underlay are dropped, unless that would empty the
pool, in which case the plan asked for something this ground cannot supply and
the ask is honoured.

Measured through the real `chooseScenery`, 4,000 draws per ground:

| ground | ice boulders drawn | pool now led by |
|---|---|---|
| grass 160 | **0 / 4000** | Boulder 19205 (seen 5x here) 63%, Rubble 12% |
| sand 61 | **0 / 4000** | Boulder 19205 48%, Granite rocks 13% |
| townEarth 163 | **0 / 4000** | Rubble 52%, Rock 60272 29%, Rock 60271 18% |

It also fixed the opposite error: Rock 60271 and 60272 are seen **92 and 44
times on grass** and were scoring 0.0000 under the old formula. Underlay is the
dominant signal (34.5% of object identity, §12), so gating on it is the
strongest honest statement available — and it is what "rocks from similar areas"
means in one line.

### Two survivors of that gate, and the two different reasons (2026-08-08)

Cody, after the fix above: *"I'm still seeing rocks that are clearly meant for
snowy areas (41582, literally a rock covered in snow)... and 29018, I don't even
know what it is, it's not actually a rock, but a flat surface with a bump."*

They needed **different** fixes, and the difference is the useful part.

**41582 — one sighting is not habitat.** Its underlay histogram is
`26:21  58:4  27:1  163:1`: twenty-five of twenty-seven placements on the two
snow bytes, and a SINGLE stray on town earth was enough to clear a `> 0` gate.
Requiring **two** separates it from everything legitimate with room to spare —
on the ground they are kept for, Boulder 19205 has 5, Rubble 2509 has 3, Boulder
445 has 2, Rock 441 has 7, Rock 442 has 4, Granite rocks 10947 has 5. One
sighting is a region's accident; two is a pattern. (`MIN_GROUND_SIGHTINGS`.)

**29018 — no context gate could ever catch it.** Seven of its sixteen placements
are genuinely on dirt, which is ground this plan paints. The map really does put
it there. What is wrong is that it is a **piece of a composition**: a flat slab
authored to sit in a row making a formation, which alone reads as a stray patch
of desert.

This is §12a's fishing-ledge lesson exactly — *usage says the game places a
thing, never that it can stand on its own* — and it now has a measurable form.
A composition piece is placed **next to a copy of itself**:

| object | self-adjacent | |
|---|---|---|
| Granite rocks 10947 | **100.0%** | composition |
| Rocks **29018** | **87.5%** | composition |
| Rubble 2509 | 82.4% | comes in patches |
| Boulder 444 | 45.8% | standalone |
| Rock 441 | 31.0% | standalone |
| Boulder 19205, Rock 60271/60272, Rocks 41582 | 0.0% | standalone |

Nothing sits between 46% and 82%, so `GROUPED_CUTOFF = 0.65` is comfortably
inside the gap. `SceneryEntry.grouped` is measured in the same scan pass as the
frequency counts (**index bumped to `:v11`, so this costs one rescan**).

Rubble at 82.4% is a deliberate casualty: it does come in patches, and one
scattered piece of it is no better than one slab. If clustered placement ever
lands, these objects become candidates for it rather than exclusions — which is
the better end state, since the map clearly wants them in groups.

Result on a lush green shore, 4,000 draws: the `loose_stone` pool is now Boulder
19205 77%, Boulder 445 11%, Rock 60272 5%, Rock 60271 4% — all standalone rock
with real evidence on that ground.

**The general shape of this, worth carrying forward:** three separate defects all
looked like "the context model isn't working", and none of them was.
One was the scorer rewarding ignorance, one was a threshold set at 1 instead of
2, and one was an object that is statistically perfect and physically a fragment.
Only the first was a model problem.

### Known limitation, and why archetypes are the fix

The no-evidence case above is not fixable by tuning T: with zero observations
every candidate is equally unexplained, so the global prior decides, and the
global prior is whatever the map has most of. Lowering the prior's weight would
flatten toward uniform, which is not right either.

**§9a's archetypes are the structural answer.** A snowy archetype takes its
species mix from actual snowy regions, so the question "what grows on snow"
is answered by regions that have snow rather than by a global average. That
makes archetypes a correctness fix, not only a convenience.

### The rig

`scratchpad/rig/` — a vite `--ssr` bundle of the real `src/procgen` modules
with a filesystem shim standing in for the File System Access API, so
measurements go through the code that ships. Entries: `driver.ts` (mine),
`analyze.ts` (role coverage + mixes), `calibrate.ts` (the T sweep),
`variety.ts` (variant concentration), `probe.ts` (Cody's fault list),
`gen.ts` (end-to-end + determinism). Build with
`RIG_ENTRY=<entry> ./node_modules/.bin/vite build -c <rig>/vite.config.mjs`.

**Scan cost, finally measured** (§10a listed this as the main untested risk):
the full maps scan — all 2,413 regions, four base64 channels each, terrain
noise where a tile stores no height — is **3.8 s in Node**, against *all*
25,676 placeable objects, roughly 4x the candidate set the browser actually
uses. The compute is not the problem; per-file I/O through the File System
Access API is whatever it is, but the added context work is not what will make
it slow.

## 12b. Archetypes — clustering WORKS, label-free matching does not (2026-08-07)

§9a's mechanism, built: `src/procgen/archetypes.ts`, mined in the same scan
pass (signatures collected in `countPlacements`, clustered in
`buildSceneryIndex`, stored in IndexedDB beside the context model).

### The clustering is sound, and the evidence is independent

k-means (k=8, k-means++ seeded from a fixed constant, so every user mining the
same cache gets the same archetypes) over: the 12 commonest underlay shares,
log-compressed scenery and wall densities, flat share, relief.

**Landmark test** — region ids are stable in RS, and nothing in the pipeline is
told about them:

| cluster | caught |
|---|---|
| #1 | **Varrock, Falador, Lumbridge**, Barbarian Village |
| #6 | Draynor |
| #4 | Seers |
| #3 | Al Kharid, Karamja, Catherby |
| #0 | Ardougne |

The three classic towns landing in one cluster with no labelling is the result
that says this means something. Whole mine (74k objects + 2,413 regions +
context model + clustering): **15 s in Node.**

### Two measurement bugs found and fixed on the way

1. **Density divided by tiles-carrying-ground**, so a region with 600 ground
   tiles and 500 objects read as 83 placements per 100 — against a real-world
   maximum of about 4 per 100. Now divided by a fixed `REGION_TILES`, which is
   also what `docs/procgen-reference.md` measured against.
2. **"Vegetation" measured as total scenery density**, which counts benches,
   crates and barrels. Towns are thick with those, so Ardougne scored as more
   vegetated than open country and `town` matched the wrong cluster. Now
   `greenery` is the share of the SPECIES MIX that actually grows.

### What does NOT work: matching an area type by hand-written profile

`AREA_TYPE_PROFILES` defines each `AreaType` as a target on measured axes
(built / greenery / trees / relief) and picks the nearest cluster, so no
cluster needs a label. It half-works: `village` finds Draynor's cluster and
`town` finds Ardougne's. But **four of the eight area types collapse onto one
52-region cluster**, and `town` does NOT select the cluster holding Varrock,
Falador and Lumbridge.

The identified cause is the **`relief` axis**: it is the p90 height step over
stored heights, which picks up the sharp steps at building foundations exactly
like real terrain. So the most heavily built cluster scores 0.85 relief — a
fact about its buildings, not its ground. Its weight is reduced to 0.4 and it
is documented as the weakest axis, but that is mitigation, not a fix.

**Do not tune the profile table by eye.** That is fitting to Gielinor by hand,
which is the guesswork this whole exercise removes; one round of it was already
done and produced the collapse above.

### The route that fits what Cody actually asked for

> "give claude a way to know things from this procgen itself, so it can make a
> plan better... claude should give a plan with 'intent' whilst the procgen
> should be the one actually deciding on what to do"

`describeMine()` emits the digest — every place type with its measured profile,
densities and commonest growth, plus the role vocabulary. **A planner that can
read that should pick the archetype itself**, which is judgement, which is what
a language model is genuinely good at — and it deletes the hand-written profile
table rather than tuning it. `matchArchetype` then survives only as the
no-API-key fallback, where being approximate is acceptable.

Still to build: threading `areaType`/archetype into `ProcPlan`, having the
generator take its ground bands, densities and path materials from the matched
archetype, and feeding `describeMine()` into `claude.ts`.

## 12c. Roles are AUTHORED now — and they exposed a palette bug (2026-08-08)

§12a built roles; nothing emitted them. Both authors do now.

### What changed

- **`claude.ts`'s tool schema was the hard blocker.** The system prompt already
  said "PREFER ROLES OVER SPECIES", and the schema did not expose `role` on any
  rule *and* marked `species` required on scatter, barriers, resources and path
  lighting. The instruction was literally unfollowable. Every rule now takes
  `role`, `species` is demoted to a documented override, and `required` dropped
  to the fields that are genuinely structural (`density`, `aroundZoneId`,
  `zoneId`+`count`, `every`).
- **`sanitizePlan` gained the case that relaxation creates:** a rule naming
  NEITHER a role nor a species. The generator treats that as "plant nothing",
  which is indistinguishable from the rule having worked, so scatter rules and
  barriers with neither are dropped with a note, and resource nodes and path
  lighting warn.
- **All 17 built-in themes moved over.** `WOODLAND`, `UNDERGROWTH` and
  `JUNGLE_UNDERGROWTH` are gone; `woodland()` takes an options bag and defaults
  to `canopy` + `undergrowth`. Ore, lighting, rubble, reeds, gravestones and the
  village-in-forest barrier are all roles now.

Two things deliberately did NOT move, and the reasoning is the general rule for
when to keep a species list:

- **`seers_farmland`'s maple** (9.6% of Seers' trees, ~1% of the map's) and
  **the flower rates at Seers and Catherby**. A theme NAMED after a local fact
  is exactly the case a global context model cannot recover.
- **The balance BETWEEN roles stays the plan's job.** `barbarian_wilds` was one
  rule with dead trees weighted inside it; it is now a 0.78 `canopy` rule and a
  1.59 `deadwood` rule, which is the same measured statement made in the
  vocabulary that survives contact with the map.

### Verified through the real modules, on the real cache

`scratchpad/rig/roles.ts` runs `buildPlan` from before and after the change
through the real `generate`, on one seed and one mined index, over 2x2 regions.
All 17 themes generate, all are byte-identical across two runs, none plants
nothing, and nothing is unresolved. Ore, light, loose_stone, waterside,
memorial and settlement_prop all resolve cleanly — `mining_valley` actually
gained ore (ore_coal 9% + ore_tin 9%, against 4/4/3% for the three the theme
used to name).

**Count the MIX on plane 0 only.** A tropical tree is four locs and an oak two,
so tabulating every placement over-represents multi-part species several times
over — the first run of this rig read 23% "tropical" where the trunk count was
9%.

### The finding: five palette roles are bound to Karamja materials

Roles leaked jungle into every temperate theme — `plant_jungle` 8-14% and
`tree_tropical` 4-9% in Lumbridge, Varrock, Falador, Draynor, rolling grass.
The obvious reading is that `canopy` and `undergrowth` are too broad. **That is
not the cause.** Asking the map directly what it grows on each byte the palette
binds:

| bound role | byte | jungle canopy | jungle undergrowth | top canopy / undergrowth |
|---|---|---|---|---|
| `townEarth` | 164 | 3% | 20% | tree 74% / mushroom 39% |
| `grassDark` | 163 | 6% | 21% | tree 69% / fern 31% |
| `grassMid` | 161 | 6% | 26% | tree 69% / fern 30% |
| `dirt` | 64 | 15% | 39% | tree 66% / plant 39% |
| **`grass`** | **49** | **13%** | **68%** | tree 65% / **grass_jungle 55%** |
| **`sand`** | **62** | **46%** | **52%** | tree 47% / plant 36% |
| **`grassLush`** | **48** | **30%** | **68%** | tree 64% / **grass_jungle 35%** |
| **`grassDead`** | **50** | **46%** | **64%** | **tree_tropical 46%** / grass_jungle 34% |
| **`trackEarth`** | **65** | **62%** | **86%** | **tree_tropical 62%** / **grass_jungle 81%** |

Byte 65 is the most jungle ground in the cache, and it is our open-country path
material. Byte 50 and 62 have a TROPICAL TREE as their commonest canopy.

The cause is in how they were chosen: the palette was bound by how **prevalent**
a material was across the 15-settlement survey, and that survey included
**Brimhaven, which is on Karamja**. So "the commonest green" was jungle green.
`grass`, `grassLush`, `grassDead`, `trackEarth` and `sand` are all Karamja
materials wearing temperate role names.

**The temperate greens are 160, 161, 163 and 164** — 3-6% jungle canopy, top
canopy `tree`, top undergrowth fern/mushroom, and 163 carries the most evidence
in the whole cache (12,412 observations).

This is worth being precise about, because it inverts the obvious conclusion:
**roles did not introduce a bug, they revealed one.** Species lists had been
hiding it — hardcoding temperate species onto jungle ground produces a
temperate-looking place and a wrong ground palette, and nothing complains. The
moment the map got a vote, it said what the ground actually was. §12a already
warned of exactly this (*"the palette ROLE names are our labels, not the
cache's"*); this is that warning arriving with numbers.

Corollary for `karamja_tropics`, which reads as a regression and is not: its
undergrowth went from 80% jungle (hardcoded by `JUNGLE_UNDERGROWTH`) to ~65%
(what the map actually does on that ground). It became more faithful, not less.

### The no-evidence signature, confirmed

Bytes 13, 14, 26 (`snow`), 55 (`stone`), 56, 58, 137 and 148 all return
**identical** numbers — 23% jungle canopy, 39% jungle undergrowth, `tree 51%` /
`plant_jungle 22%`. Identical outputs across unrelated materials is the
fingerprint of every candidate being equally unexplained and the global prior
deciding. That is §12a's known limitation, now visible as a signature you can
test for rather than an argument. Themes that paint a snow band therefore cap
their undergrowth just below the snowline (`floorMaxHeight`), which is both a
real-map fact and a way around the gap until archetypes land.

### The rebind — DONE 2026-08-08, on Cody's call

Six roles moved. Each replacement is the **lowest-jungle material that still
looks like its role** (rgb within ~70 of what the role was bound to) and carries
enough observations to trust:

| role | was | jungle | now | jungle | note |
|---|---|---|---|---|---|
| `grass` | 48 `#58680b` | 40% | **160** `#29380f` | **16%** | ev 6,755 |
| `grassLush` | 47 `#35720a` | 50% | **92** `#38562f` | **24%** | the greenest clean material |
| `grassMid` | 160 | 16% | **159** `#29380f` | 17% | 160's twin, texture 918 not 917 |
| `grassDark` | 162 | 14% | unchanged | | most-observed underlay in the cache |
| `grassDead` | 49 `#78680b` | 56% | **12** `#807048` | **32%** | dry khaki |
| `mud` | 62 `#3d2b0b` | 43% | **9** `#282018` | **24%** | |
| `trackEarth` | 64 `#654d0b` | 75% | **69** `#654d0b` | **32%** | *identical rgb*, texture 154 not 510 |
| `sand` | 61 `#d0c074` | 50% | **130** `#b3ac90` | **32%** | paler, greyer, not Brimhaven beach |

`trackEarth` is the neatest result: 64 and 69 are the **same colour**, differing
only in texture, and one is the most jungle ground in the cache while the other
is ordinary. Nothing about the appearance could have told you.

The temperate greens in this cache are a **dark ramp** — there is no clean
bright green — which is why `grass` and `grassMid` can share an rgb without the
ramp collapsing: their textures differ.

**Measured effect.** Tropical trees are gone from the top six of Lumbridge,
Falador, Draynor, Catherby and dense forest; `grass_jungle` is gone from rolling
grass, gloomy woods, coastal and barbarian wilds. A residual `plant_jungle`
8-11% remains on the greens, which is what those materials genuinely carry.

**`stone` and `snow` were left alone deliberately.** They have no placement
evidence at all, so every candidate scores identically and the global prior
decides — rebinding cannot fix a no-evidence case, only archetypes can.

### The rebind shipped two APPEARANCE failures (found in the browser 2026-08-08)

Cody built the plan and the shoreline came out looking like a tiled floor.

The rebind ranked candidates by how close their **rgb** was to the role's old
colour. `GroundMaterial.rgb` in `palette.ts` says, in as many words, that it is
*"NOT what the tile looks like when `texture` is set"* — and every one of these
materials has a texture. The tint only shifts a texture's hue; it cannot turn
flagstones into sand.

| role | rebound to | its texture | what it actually is |
|---|---|---|---|
| `sand` | 130 | 725 | **paving slabs** |
| `grassDead` | 12 | 66 | angular gravel chippings |

Both reverted — `sand` back to 61 (texture 128, fine speckled sand) and
`grassDead` to 49 (texture 312, a grass texture). A beach grows almost nothing,
so the jungle share was never worth much there and appearance is the entire job.

The greens survive the check: 160 is texture 917 (fibrous grass), 92 is 276
(fine green grass), 162 is 980, and `trackEarth` 69 is texture 154 (soft mottled
earth) — the same rgb as the old 64 with a different, unremarkable texture.
`mud` is the weak one: 9's texture 416 is rock and the old 62's 181 is pebbles,
so neither is convincingly mud; 9 is kept for the much lower jungle share.

**The rule that replaces the rgb test: LOOK at `textures/<id>/<id>.png` before
binding anything.** They are dumped per texture and can simply be viewed. Two
measured axes — jungle share and rgb distance — both said 130 was the best sand
in the cache, and one glance at the image says it is a patio.

### Karamja then needed its own ground, and that is the thesis in miniature

The rebind broke `karamja_tropics`: it had been painting Karamja's materials
through roles called `grass` and `grassLush`, and once those pointed at
temperate ground the jungle theme grew a temperate wood (plant 17%, tree 15%,
tree_tropical gone).

The fix is one line of intent — the theme names the jungle materials outright
(`JUNGLE` in `planner.ts`, ids 47/48/49/61, the very ones the palette had been
wrongly bound to). Jungle came straight back: **plant_jungle 28%, grass_jungle
15%, tree_tropical 9% — 52% jungle**, against 50% for the old hardcoded
`JUNGLE_UNDERGROWTH` mix.

That is the whole argument demonstrated end to end. The same scatter rule
(`role: 'canopy'`, `role: 'undergrowth'`) produces a temperate wood or a jungle
depending **only on the ground painted under it**, and it reproduces the mix the
old hardcoded species list was hand-tuned to. Nothing in the theme says
"tropical" any more.

Hardcoded ids are still a compromise — the proper fix is jungle ROLES in the
palette, or better an archetype supplying ground and species together from real
Karamja regions (§9a).

### Still open

`kharid_desert` is the theme that did not come right: tree_tropical is down from
9% to 5%, but `tree_evergreen` is 8% and there are no palms. Desert sand is a
no-evidence context, so this is the same gap as snow and it needs archetypes,
not another rebind.

---

## 13. Upper storeys — §8.1 ANSWERED (2026-08-08)

**There is no explicit floor concept, and no opening concept.** An upper-storey
floor is an ordinary terrain plane that happens to carry material and a height.
That is the whole answer, and it unblocks layer 6.

Cody called the approach before it was run: *"all the information on what's
placed where, even second storey, is in the cache, and any information on like,
'if I click these stairs, where do I go' is in the actual server itself."* Both
halves were right. The mine answered the structural question; the client was
needed for exactly one thing — what the flag **bits are called** — which is the
one thing data can never tell you. Stairs-to-destination never came into it.

### What the cache says (2,413 regions, all planes, `scratchpad/rig/storeys.ts`)

Tiles that carry a loc on plane N, against tiles on the same plane that do not:

| plane | tiles w/ loc | underlay | overlay | stored height | (no loc) underlay | overlay |
|---|---|---|---|---|---|---|
| 0 | 3,407,947 | 55.1% | 24.7% | 90.0% | 48.2% | 36.6% |
| 1 | 931,941 | **7.2%** | **17.3%** | 74.4% | 0.7% | 2.8% |
| 2 | 385,924 | 10.0% | 28.6% | 69.1% | 0.2% | 1.4% |
| 3 | 112,631 | 5.8% | 26.5% | 68.2% | 0.1% | 0.3% |

**Underlays essentially do not exist above plane 0** (7.2% against 55.1%), while
overlays survive and are enriched ~6x over open air. So upper-storey ground is
painted with OVERLAYS, not underlays. Heights are stored broadly on plane 1
(74.4% under locs, 43.9% even without), matching §11's finding that real regions
store plane-1 heights across large contiguous areas rather than at isolated
tiles.

Above a staircase or ladder (4,309 placements, 1,119 stair-like ids): 62.0% have
a loc on the plane above, **72.0% have a stored height**, 31.0% an overlay, and
**0.7% an underlay**. And 60.5% of plane-1 tiles carrying a loc have a plane-0
loc beneath them — upper storeys sit over ground-floor structure, as expected.

### The height rule, confirmed in the decoder

`MapLoader.decodeTile` (bot-refactor — a decode, not a render path):

```kotlin
if (opcode == 0) {                       // no height stored for this tile
    if (plane == 0) tileHeights[0][..] = -calculateTileheight(...) * 8 shl 2
    else            tileHeights[plane][..] = tileHeights[plane-1][..] - 960
} else if (opcode == 1) {
    var heightDelta = readUByte()
    if (heightDelta == 1) heightDelta = 0
    if (plane == 0) tileHeights[0][..] = -heightDelta * 8 shl 2
    else            tileHeights[plane][..] = tileHeights[plane-1][..] - (heightDelta * 8 shl 2)
}
```

Three things this nails down, all of which §11 had inferred empirically from the
tree canopies and which are now confirmed at the source:

1. **Upper-plane heights are RELATIVE to the plane below**, not absolute. Every
   level needs its own delta.
2. **Absent height on plane > 0 means exactly 960 below the plane beneath** —
   one full storey up. Absent is not zero.
3. **A stored byte of 1 decodes to 0** (flush with the plane below).

Plane 0 is the odd one out: absent there means the client's own procedural
terrain noise, not a default offset.

### The tile-flags bit table

The flags byte is written by map opcodes 50-81 as `opcode - 49`, so it is a
**5-bit value, 1..32**. The census agrees exactly — bits 5, 6 and 7 are 0.0% on
every plane.

| bit | meaning | where it lives |
|---|---|---|
| `0x1` | **unwalkable** (collision only) | `MapLoader.initializeFloor` → `clipping[h].setUnwalkable` |
| `0x2` | **bridge** — read from **plane 1 specifically**, drops the tile a plane | `SettingsBits.getCollisionPlane`, `areRoofsHidden` |
| `0x4` | **roof removal** | `MapRegion` roof sweep |
| `0x8` | **force collision plane 0** | `SettingsBits.getCollisionPlane` |
| `0x10` | **hidden / not visible** | `SettingsBits.isVisible` |

Measured share of tiles carrying each bit:

| plane | 0x1 | 0x2 | 0x4 | 0x8 | 0x10 |
|---|---|---|---|---|---|
| 0 | 41.0% | 1.6% | 4.4% | **0.0%** | 0.3% |
| 1 | 24.5% | 1.6% | 2.2% | **5.2%** | 0.1% |
| 2 | 23.5% | 0.0% | 0.9% | 1.3% | 0.1% |
| 3 | 22.3% | 0.1% | 0.2% | 0.2% | 0.1% |

**A hypothesis this killed.** `0x8` is upper-plane-only (0.0% on plane 0, 5.2% on
plane 1) and looked exactly like the missing "there is a floor here" flag. It is
not — it forces the tile's COLLISION plane to 0, which is a movement fact, not a
rendering or structural one. Worth recording because the distribution was
genuinely suggestive and the data alone would never have settled it. This is the
case for reading the client's naming: the shape of the numbers pointed the wrong
way.

`SettingsBits.areRoofsHidden` remains a misnomer — it reads the **bridge** bit,
not the roof bit, as `TODO.md` already noted.

### What this means for building synthesis

To put a second storey at (x, y):

- write an **overlay** on plane 1 for the floor material (never an underlay);
- write a **stored height** on plane 1 as a delta from plane 0 — byte 1 for
  flush, absent for a full storey up;
- set `0x1` on tiles that should block movement;
- leave `0x2` and `0x8` alone unless deliberately building a bridge.

"Line the staircase up" means **nothing more than matching coordinates**. There
is no opening to carve and no floor object to register — which makes §6's
vertical-coherence constraint (`upper ⊆ lower`, except at the measured overhang
rate) a pure geometry check, and much cheaper than feared.

### The sub-question, ANSWERED — an upper floor is OVERLAY TERRAIN

`scratchpad/rig/interiors.ts`. Walls occupy tiles (the §5/§7 approximation, kept
for consistency), the outside is flooded in from the region border with
4-connectivity so a diagonal wall run still seals, and what is left is interior.
7,350 enclosed buildings on plane 0, 2,706 on plane 1, 834 on plane 2.

Interior tiles, by pocket size — §6 measured a real interior at a median of 36
tiles, so 9-120 is where rooms and halls actually live:

| plane | pocket | tiles | overlay | underlay | height | floor decor |
|---|---|---|---|---|---|---|
| 0 | 9-40 room | 44,615 | 58.9% | **60.2%** | 98.3% | 25.3% |
| 0 | 41-120 hall | 74,678 | 59.1% | **60.0%** | 97.4% | 30.4% |
| **1** | **9-40 room** | 18,730 | **70.0%** | **8.1%** | 69.0% | 27.2% |
| **1** | **41-120 hall** | 34,625 | **72.0%** | **10.7%** | 82.2% | 43.1% |
| 2 | 9-40 room | 7,858 | 58.7% | 10.9% | 73.3% | 20.9% |
| 3 | 9-40 room | 1,911 | 77.0% | 1.6% | 78.6% | 31.3% |

**H1 (overlay terrain) wins.** 70-72% of upper-storey room and hall tiles carry
an overlay, against 8-11% carrying an underlay. The ground floor is the mirror
image — underlay 60%, because a ground floor is often just the outdoor terrain
continuing indoors. **Upstairs there is no outdoor terrain to continue, so the
floor has to be painted, and it is painted as an overlay.**

**H3 (the roof of the storey below) is dead** — roof locs beneath an upper-storey
interior run **0.0-0.4% on every plane and every pocket size**. Roofs are not
floors.

**H2 (a floor loc) is not the mechanism either**, but it is not nothing: floor
decoration (type 22) sits on 27% of room tiles and 43% of hall tiles. That is
rugs and furnishing laid *on* the overlay floor — §6's layer 5 — not a substitute
for it.

### The overhang rate, which layer 6 needs

| plane | rooms contained | overhang |
|---|---|---|
| 1 | 74.8% | **25.2%** |
| 2 | 77.0% | 23.0% |
| 3 | 91.8% | 8.2% |

So §6's rule stands — containment IS the rule — but the exception rate is
substantial rather than marginal, and it should be read as an upper bound: a
plane-1 room sitting over a plane-0 structure that this region does not fully
enclose scores as overhang here.

### The upper-floor material vocabulary

The commonest overlays on a plane-1 room floor are 242, 95, 5 and 190 — and
**all four are texture 595**. One wooden floor texture dominates upstairs.
Plane 0's room floors are far more varied (5, 244, 56, 75, 190, 89, 112, 233
across textures 595/1112/301/600/197/669/884), which fits: outdoors and ground
floors inherit the world's materials, upstairs is built.

### Two method corrections, both of which changed the answer

1. **Pooling all interior tiles gave 38.5% overlay on plane 1; bucketing by
   pocket size gave 70%.** The first pass averaged 79 interior tiles per building
   against §6's median of 36 — the signature of courtyards and walled compounds
   being counted as "inside". The 121+ bucket sits at 27% overlay and was
   dragging the real rooms down with it.
2. **Counting containment as "over the room below" put overhang at 34.8%;
   counting it as "over the room *or the wall* below" put it at 25.2%.** A
   storey's outer ring sits directly on the wall beneath it, which is
   containment, not overhang.

Neither error would have shown up as anything but a plausible number.

---

## 14. The footprint vocabulary — §8.3 MEASURED (2026-08-08)

Layer 1's input. §6's warning is the reason it matters: local accretion makes
amoebas, so the massing has to come from a global decision sampled from a
measured vocabulary. This is that vocabulary.

`scratchpad/rig/footprints.ts`, plane 0, all 2,413 regions. **1,521 buildings**,
where a building is a connected wall component that solely encloses interior
space — which drops the 10,755 fence ends and fragments §7 counted.

### Buildings are near-square and small

| | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|
| footprint area (walls + interior) | 16 | 27 | **72** | 199 | 571 |
| interior only | | 7 | **27** | 98 | 356 |

Commonest bounding boxes (short × long): **5×5** (94), 3×3 (71), 6×6 (46),
5×6 (42), 4×5 (41), 3×4 (41), 4×4 (39), 6×7 (31), 8×8 (28), 9×9 (27).

**Aspect ratio is the sharpest constraint: p50 1.20, p90 1.86.** Real buildings
are close to square and almost never exceed 2:1. Any generator producing long
thin masses is already wrong before a single wall is placed.

### They are rectilinear, but not rectangles

Fill ratio = footprint area / bounding-box area:

| p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|
| 0.42 | 0.65 | **0.81** | 0.96 | 1.00 |

Only **20.4% are a plain rectangle** (fill 1.00) and 32.9% fill ≥ 0.90. So the
median building fills about four fifths of its box — a rectangular core with a
wing or a notch, exactly the shape §6 predicted and precisely what neither a
plain rectangle nor free-form growth produces.

**p10 = 0.42 is the amoeba guard.** A synthesised footprint filling less than
~0.4 of its bounding box is outside anything the real map does.

### The core-plus-wings structure

Greedy maximal-rectangle decomposition (take the largest all-footprint rectangle,
remove it, repeat; capped at 8):

| rects | share |
|---|---|
| 1 | **21.6%** |
| 2 | 8.9% |
| 3 | 18.0% |
| 4 | 10.0% |
| 5 | 7.5% |
| 6 | 6.3% |
| 7 | 4.2% |
| 8 (cap reached) | 23.4% |

74.8% reach 95% coverage inside 8 rectangles; the 23.4% at the cap are castles
and complexes.

**The primary rectangle is a median 72% of the whole footprint** (p25 0.55,
p75 0.89). That is the single most useful number here: a building is a dominant
core mass plus small additions, not an assembly of equals. Layer 1 should sample
a core and then attach one or two smaller rectangles, and it should not treat
the parts symmetrically.

Commonest primary rectangles: **3×4** (90), 4×4 (85), 3×3 (80), 5×5 (58),
6×6 (51), 3×5 (45), 4×5 (39), 5×6 (31).

Internal consistency check: 21.6% decompose to one rectangle against 20.4%
measuring fill 1.00 — the same buildings reached two different ways.

### How a wing sits against the core

Two-rectangle buildings only, so **n = 136 and this is the weakest number here**:

| | share |
|---|---|
| flush at one end (corner-aligned) | **58.1%** |
| centred on the core | 36.8% |
| offset / overhanging | 5.1% |
| flush at both ends | 0.0% |

The 0.0% is structural, not a finding: a wing flush at both ends would have been
absorbed into the core as one larger rectangle by the greedy pass. Wings are
corner-aligned about 60% of the time and centred about 35%; free-floating
offsets barely happen.

### A layer-1 recipe, directly from the above

1. Sample a core rectangle — 3-9 a side, near-square, aspect ≤ ~1.9.
2. With probability ~0.22 stop there; otherwise attach 1-3 smaller rectangles.
3. Size the additions so the core stays ~70% of the total.
4. Place each addition corner-aligned (~58%) or centred (~37%).
5. Reject any candidate whose fill ratio falls below ~0.42.

### The extractor was wrong twice, and §6 caught it

The first version reported **593 buildings at exactly 14×14**, bounding boxes of
62×62, and a median footprint of 178 tiles. The cause was the footprint flood
absorbing *any* adjacent enclosed pocket, so a town wall swallowed the courtyard
it shares with the houses inside it and came out as one 60-tile "building".

Two fixes: an interior pocket now belongs to the component that **solely** bounds
it (a pocket bounded by two components is shared ground and belongs to neither),
and a component whose interior exceeds 6× its wall count is a compound, not a
building.

**§6's independently measured "1,190 buildings, median 36 interior tiles" is what
made the error visible** — 178 was obviously wrong against it, and the corrected
run gives 1,521 buildings at median 27, which agrees to within the difference in
filters. Keep that number as the calibration target for any future change to
this extractor.

---

## 15. Docks — MEASURED 2026-08-08 (`scratchpad/rig/docks.ts`)

"No docks on an island fishing village" is §1's oldest surviving fault, and the
reason it survived is that **a pier had never been measured as a structure**. §4
measured waterside OBJECTS by name; that is how `fishing_ledge` was shipped and
then pulled again (§12a) — 185 placements, 100% on the ground, every statistical
test passed, and it is dock trim authored to sit on a deck that was not there.

This is the structural pass, the same job §14 did for building footprints.

### First: what water is

An overlay is water if the underwater ("um") layer is authored beneath it.
Measured over all 2,413 regions, that picks out **overlay 112** with no
ambiguity:

| overlay | tiles | P(underwater height present) |
|---|---|---|
| **112** | **1,406,704** | **94.8%** |
| 215 | 7,779 | 73.4% |
| 200 | 1,956 | 72.8% |
| *(no overlay)* | 2,540,457 | 2.5% |

112 alone is 96% of all water in the cache, and its count in Port Sarim (2,333)
independently reproduces the figure `docs/procgen.md` §6 recorded when the
underwater layer was ported.

**Do NOT reuse the renderer's `isWaterMaterial`** (`mapScene.ts:1438`). It is a
hue test on the texture, used to decide what to *animate*, and it does not select
112 at all — it finds 9 overlays covering a rounding error of the map. It was the
obvious thing to reuse and it was measured wrong before anything was built on it.

`waterColor` on the overlay def is also a dead end: it is written unconditionally,
so all 247 overlays carry it and 235 carry the identical default `#122b3d`.

### A pier is LOCS OVER WATER, not terrain

Checked by looking at Port Sarim (12081/12082) before theorising, which is what
the §13 upper-storey question needed too. The deck is a carpet of **type-22
ground decoration laid on water tiles** — 471 placements of one id in region
12082 alone — and the terrain underneath is untouched sea. There is no raised
land, no wooden underlay, no special tile flag.

So a dock = a connected run of deck tiles standing over at least one water tile.
The component is grown over DECK rather than over water deliberately: that keeps
the landward apron, which is the join the generator has to reproduce.

### The deck test, and the wrong one that came first

A deck plank is a ground decoration whose def sets **`obstructsGround`** — the
flag that makes a type-22 replace the terrain under it rather than lie on it. It
also excludes the water decals sharing shape 22 (lily pads, foam, ripples —
21135, 21136, 754 are all `obstructsGround: false`).

The first cutoff tried was **`offsetY <= -200`**, taken from Port Sarim's 64496
at −904 (the renderer negates `offsetY`, so that lifts the plank 904 units, 94%
of a 960 storey). It found **4 deck ids and 14 docks in the entire map.** Only
the Port Sarim family is authored with a lift; the commonest decks in the cache —
56924 (1,082 placements), 9453 (351, across 23 regions), 9454 (279, 22 regions) —
all sit at `offsetY: 0` and carry their height **in the model**.

That is §11's canopy lesson arriving a second time: **a per-object offset is one
of several ways the map raises a thing, and picking the one the first example
happened to use silently deletes everything authored the other way.** The correct
test finds **193 deck ids and 115 structures**.

### What the map has

| | |
|---|---|
| water regions | 683 |
| ground decorations standing on water | 516 |
| ...that are DECK ids (`obstructsGround`) | **193** |
| deck structures over water | **115** |
| shore-attached **piers** | 59 (3 carry ship vocabulary) |
| free-floating vessels / platforms | 56 (**22** carry ship vocabulary) |

**A moored hulk is a deck over water too.** Without splitting them out the
geometry describes boats: the two largest "docks" in the first run were a 33×24
solid block carrying a Figurehead and a Ship's ladder, and a hull carrying a
Ship's wheel and a Pile of rope. Shore contact is the structural split; the ship
word-list only labels it so the split can be checked.

### Pier geometry — 51 clean piers

Region-border-crossing and ship-carrying components excluded.

| | p25 | p50 | p75 | p90 |
|---|---|---|---|---|
| deck tiles | 8 | **24** | 75 | 166 |
| long side | 4 | **11** | 14 | 21 |
| short side | 3 | 4 | 11 | 15 |
| fill ratio | 0.42 | 0.56 | 0.80 | 1.00 |
| shore join (deck tiles touching land) | 2 | **4** | 21 | 48 |

**The single most useful number is the WALKWAY WIDTH** — the median contiguous
run along the narrower axis. A bounding box says a T-headed pier is 14 wide; what
matters is that you walk down it two abreast.

| width | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 11 |
|---|---|---|---|---|---|---|---|---|---|
| piers | **18** | **18** | 3 | 6 | 1 | 2 | 1 | 1 | 1 |

**71% of piers are 1 or 2 tiles wide.** A generated pier wider than 4 is already
wrong. And 43% sit entirely over water (p50 of the over-water share is 0.97), so
the apron is usually a tile or two, not a broad quay.

### A dock STYLE is a family of ids, not one id

Deck ids per pier: p50 **2**, p90 7; only **24%** of piers use a single id. The
recurring families:

| piers | ids |
|---|---|
| 5 | 72997, 72998 |
| 4 | 43681–43685 |
| 3 | 64496 *(Port Sarim, single-id)* |
| 3 | 56916–56931 *(13 ids)* |
| 3 | 32803, 32805 |
| 2 | 2759, 64490, 64491 |

This is §5's per-building material palette in miniature: **picking one deck id
and tiling it is the dock equivalent of a house built from twelve wall styles.**
Pick a family, then place from within it.

And the ids inside a family are **positional**, not interchangeable:

| id | n | on an EDGE tile | rotations 0/1/2/3 |
|---|---|---|---|
| 64489 | 133 | **95%** | 5 / 0 / 84 / 11 |
| 20512 | 132 | **100%** | 31 / 34 / 18 / 17 |
| 56916 | 76 | **100%** | 41 / 14 / 45 / 0 |
| 64490 | 92 | 92% | 0 / 0 / **100** / 0 |
| 18863 | 784 | **14%** | 0 / **100** / 0 / 0 |
| 56924 | 1,082 | 44% | 37 / 0 / 63 / 0 |

Some ids are almost always on an edge (edge trim / capping) and some almost never
(18863 at 14% is a field piece), and several are locked to one rotation. So deck
realization is a small tile-fitting problem with the same shape as §5's wall
grammar — not a fill.

### Trim is SPARSE, which contradicts the instinct

| | |
|---|---|
| piers carrying **nothing at all** | **43%** |
| piers with a railing (wall shapes 0–3/9) | 33% |

Where trim exists it is overwhelmingly edge-bound — the wall-shape entries run
100% on edge tiles, and the commonest scenery piece (816) is 61%. The named
inventory across all deck structures is small and nautical: **Ship's ladder,
Mast, Barrel, Crate, Winch, Pile of rope**.

**Most dock parts have no name at all** (`name: "null"` — 64496, 9453, 9454 and
the whole 56916–56931 family). This is the direct reason the current generator
can never build one: `scenery.ts` matches candidates **by name substring**, so
the entire deck vocabulary is invisible to it, while "Fishing ledge" — which has
a name and is trim — is exactly what it found. The dock vocabulary has to be
carried by ID, mined, like the canopy map is.

### Weaknesses of this pass, to respect before building on it

1. **n = 51 is small.** The family counts (5, 4, 3, 3…) are the weakest numbers
   here; treat them as "these families exist", not as a distribution.
2. **Bridges are not separated from piers.** A bridge is deck-over-water attached
   to land at *both* ends and would currently score as a pier with a large shore
   join — which is a plausible reading of the p90 of 48. Splitting on
   "land contact on two opposite sides" is the obvious next filter.
3. **Region-border components are dropped** (8 of them), which biases the length
   distribution short. §14 made the same trade.
4. **`obstructsGround` may over-select.** It is the right flag for "covers the
   ground", but nothing verifies every one of the 193 ids is *dock* decking
   rather than some other raised platform; "Icy ground" turning up in the trim
   table is a hint that the neighbourhood is broader than piers alone.

### BUILT 2026-08-09 — `src/procgen/docks.ts`

The measurement above is now mined per cache and executed.

- **`docks.ts`** holds the model, the mining (`observeDocks`/`finaliseDocks`) and
  the generation-side picks. Mined in the SAME region walk as the frequency
  prior, the context model and the archetype signatures — the region files are
  already open, and a fourth pass over the same bytes would be the wrong trade.
- **Deck candidates are collected in the object pass, ABOVE
  `isPlaceableScenery`**, because that helper rejects `name === 'null'` and most
  dock parts are unnamed. This is the concrete reason the species vocabulary
  could never build a pier.
- **`DockSpec` in `ProcPlan`**, `docks` on the report, `planDocks` before the
  paths and `runDocks` in the placement phase. Laying out before the paths is
  what lets a lane be routed to the foot of each jetty — a pier nobody can walk
  to is scenery. Index bumped to **`:v12`**, so this costs one rescan.
- **A `fishing_village` theme**, which is the thing the whole exercise was for.
  `coastal` gets one jetty too.
- **`sanitizePlan`** warns when docks are asked for on an inland landform (no
  shoreline = the planner searches every tile and silently finds nothing) and
  clamps every dimension.

Measured through the real modules on the real cache (`scratchpad/rig/dockgen.ts`):
**50 piers mined, 24 families, 124 parts, 16.8 KB** (whole index 53.2 KB), mine
24 s in Node. A `fishing_village` on a 2×2 builds **3 jetties**, deck 95% over
water, byte-identical across two runs, and all 18 themes still generate.

Two things the verification caught, both worth keeping:

1. **Clamping the sampled width was wrong; filtering is right.** Mined widths run
   1–24 (the wide ones are quays and jetty heads). `Math.min(4, w)` turned every
   one of those into a 4, so a distribution that is 71% one-or-two tiles started
   producing 4-wide rafts. Discarding out-of-range samples keeps the shape of the
   measurement instead of piling its tail on the boundary. Same class of error as
   the density cap in §12b.
2. **The first pass criterion — "every plank must be over water" — was WRONG,
   and the code was right.** §15 measured the over-water share at p50 0.97 / p25
   0.69 with only 43% entirely over water: a pier has an apron where it meets the
   shore. One plank on sand out of 52 is the map's own behaviour. Testing for
   100% would have driven a fix for something real piers do on purpose. The rig
   now compares against the measured p25.

Fishing ledges become legitimate again now there is a deck under them — which is
exactly what §12a said when they were pulled. They are not re-enabled yet.

### Still open on docks

- **Bridges** are still not separated from piers in the mine (§15 weakness 2), so
  a land-to-land structure can contribute to the family stats.
- **The generator never builds a bridge**, deliberately: `planDocks` stops at the
  far shore rather than crossing, because bridges were not measured.
- **Trim placement is uniform along the edge.** Real trim clusters (barrels by
  the landward end, ladders at the head); nothing measures position along the
  pier yet, only edge-vs-interior.
- **Multi-region piers** are excluded from the mine, biasing lengths short.

---

## 16. Buildings — §8.5 ANSWERED, and layers 1/3/4/5 BUILT (2026-08-09)

§14 gave layer 1 its footprint vocabulary. What still blocked layer 3 was §8.5:
*"Rotation remapping semantics. Well-defined, but unverified against darkan."*
Without it, walls can be placed in the right PLACE facing the wrong way, which
is the "structurally broken output" §6 says the licence to ship rough work does
not cover.

### The failed approach, and why it read as a finding

The obvious move was to reuse what works for dock decking (§15): tabulate
rotation against the tile's **outward normal** and replay it. Measured over all
enclosed buildings, that came out only **28–52% concentrated** — which looks
exactly like "wall rotation is not determined by position".

It is. The proxy was wrong: it lumped **interior partition walls**, which have no
outward normal at all, in with perimeter walls, and it took the first non-
footprint neighbour on footprints that are not rectangles.

### The controlled measurement, which is unambiguous

Restricting to the **311 perfectly rectangular buildings** in the cache — where
which side a wall tile sits on cannot be argued — and to tiles touching exactly
one side:

| side | rot 0 | rot 1 | rot 2 | rot 3 | n |
|---|---|---|---|---|---|
| E (+x) | **74%** | 0% | 26% | 0% | 1,301 |
| S (−y) | 0% | **72%** | 0% | 28% | 1,214 |
| W (−x) | 24% | 0% | **75%** | 0% | 1,278 |
| N (+y) | 0% | 29% | 0% | **71%** | 1,244 |

**Shape 0's rotation IS the exposed edge: 0 = +x, 1 = −y, 2 = −x, 3 = +y.**

The ~26% remainder is *always* the opposite rotation, never a perpendicular one.
That is not noise — a wall occupies a tile EDGE, and either of the two tiles
sharing that edge can carry it. One rule, two spellings.

Corners, same 311 buildings, tiles touching exactly two sides:

| corner | shape 1 | shape 2 | shape 9 |
|---|---|---|---|
| ES | rot 0 @ **100%** | rot 2 @ 100% | rot 2 @ 98% |
| WS | rot 1 @ **100%** | rot 3 @ 100% | rot 3 @ 96% |
| NW | rot 2 @ **100%** | rot 0 @ 100% | rot 0 @ 98% |
| EN | rot 3 @ **100%** | rot 1 @ 100% | rot 1 @ 97% |

**A shape-1 corner at rotation r covers edges r and (r+1)&3** — exact on all
four, with the same edge numbering. Shape 2 is the same corner at r+2 (a
different anchor), and shape 9 follows shape 2.

This is the general lesson worth keeping: **when a positional measurement comes
back weakly concentrated, suspect the control before the conclusion.** The same
question went from 40% to 100% purely by restricting it to cases where the
answer is unambiguous.

### The rest of the mine

Measured in the same pass and now shipped on the index:

- **1,521 enclosed buildings** — which independently reproduces §14's count
  exactly, and is the calibration signal that the extractor is the same one.
- **Wall material families**: 1,018 distinct id-sets; **p50 5 wall ids per
  building, p90 15**. As with docks, a style is a family, not an id.
- **Doors**: 360 distinct wall ids whose def offers an **"Open"** option. The
  commonest is `3626` ("Wall", 1,459 uses) — note the *name* is useless here and
  the option is what identifies it, which is another case of the species
  vocabulary being unable to reach the thing.
- **Furniture by distance to the nearest wall**, reproducing §6: `14768` is 68%
  at d1, `20601` 53%, `43672` 48%, while `31130` is **0% at d1** and 40% at d4+ —
  the pillar signature, dead central, exactly as §6 measured it.

### BUILT — `src/procgen/buildings.ts`

Layers 1, 3, 4 and 5. Layer 2 (room subdivision) and layer 6 (upper storeys) are
NOT done.

- **Layer 1, massing**: `sampleFootprint` implements §14's recipe — near-square
  core 3–9 a side, aspect ≤ 1.9, stop at the core ~22% of the time, else 1–3
  smaller wings sized to keep the core dominant, corner-aligned 58% / centred
  37%, and **reject any candidate whose fill ratio falls below 0.42** (the amoeba
  guard). The outline is a global decision sampled from measurement, which is
  §6's answer to "local accretion makes blobs".
- **Layer 3, walls**: every footprint tile's exposed edges are walled using the
  rotation semantics above — one shape-1 loc for an adjacent-edge corner, shape 0
  otherwise — from one mined material family per building.
- **Layer 4, the door**: guaranteed, not probable. Exactly one perimeter tile
  becomes a door, chosen as the straight-wall tile nearest a path so the building
  faces the road.
- **Layer 5, furnishing**: sampled from the wall-distance distributions, so
  wall-huggers hug and pillars stand clear without either being written down.
- `BuildingSpec` in `ProcPlan`, `runBuildings` in the placement phase, and
  `addTown()` now asks for buildings on the plots it reserves — **a reserved plot
  used to be an invisible promise to a prefab system that did not exist.**

Verified through the real modules (`scratchpad/rig/dockgen.ts`): a
`village_in_forest` on a 2×2 builds **6 buildings on 7 plots** at 5×5, 7×4, 5×4,
4×4, 5×7 and 5×4 — all inside §14's measured vocabulary — with **every building
having a door**, every rotation in range, and **no gaps in any perimeter**. All
18 themes still generate.

Two bugs the verification caught:

1. **The door landed on a corner tile** and vanished. The corner branch emits one
   loc for both edges and `continue`s, so two of six buildings came out sealed.
   Doors are now chosen only among straight-wall tiles. This is exactly the class
   of fault §6 says must be *guaranteed* rather than probable.
2. **The rig's own perimeter check was wrong** — it used `2*(w+h)-4`, which is
   only right for a plain rectangle and reported false failures on every
   footprint with a wing. The generator now counts pieces it could not place and
   warns, and the rig reads that instead of re-deriving a formula. Ask the
   component that knows.

### Still open on buildings

- **Layer 2, room subdivision** — every building is a single room. This is §6's
  "hard one" and is untouched.
- **Layer 6, upper storeys** — unblocked by §13 but not built.
- **Roofs** are not placed at all (56,926 roof locs in the map, unmeasured).
- **No wall GRAMMAR** — §5's 50 structure cells / 708 adjacencies are still only
  a scratchpad measurement. The current placer is geometric (exposed edges), not
  grammatical, which is adequate for a rectilinear footprint and would not be for
  anything more ambitious.
- **Furniture rotation is random**, so chairs and beds do not face into the room.
- **Nothing has been seen in a browser.**

---

#### The product is unusable for generation — use the geometric mean

> **SUPERSEDED 2026-08-07 by §12a.** The geometric mean measured as the WORST
> of every tempering value tried, and the monoculture it was blamed on turned
> out to be mostly the frequency prior. Kept for the reasoning trail; the
> shipped value is `CONTEXT_TEMPER = 1.5`.

`contextLikelihood` returns the **geometric mean** of the per-feature
probabilities, not their product. The product is the correct Bayes term for
*classifying* a placement, and is what §12's accuracy figures measured — but
five multiplied probabilities span so many orders of magnitude that the best
candidate took **99-100% of the weight on every kind of ground**. That is a
monoculture forest, not a wood. The mean is a monotone transform, so the
ranking is unchanged; it only compresses the range back to about one feature's
worth so sampling has somewhere to go.

After the change, the same query behaves:

| ground | top tree picks |
|---|---|
| grass (underlay 163) | #38760 24%, #38783 20%, #38785 19%, #70060 12%, #1304 11% |
| sand (underlay 61) | **#1304 33%**, #38760 12%, #38783 11%, #59915 10% |
| stone (underlay 54) | #1304 19%, #38760 18%, #70060 13%, #38783 13% |

Tree #1304 is 11% of grass and **33% of sand** — the mix genuinely moves with
the ground while keeping variety.

Two traps already hit and handled, both of which fail *silently*:
- **A base64 channel read out of the raw text is still JSON-ESCAPED.** Gson's
  HTML-safe encoder writes `=` padding as `=`, so a region's
  `heightValue` ends `...AAAA==` and `atob` **throws** on it. This
  shipped once and cost every tree canopy its height: 1,676 of the 1,677
  regions with plane-1 objects failed to decode, `lift` fell back to "unknown"
  for every species, and the only symptom was foliage hovering a storey above
  its trunk. **Unescape with `JSON.parse('"'+raw+'"')`, not an HTML-entity
  replace**, then still **validate the decoded length** (16,384 bytes for a
  tile channel, 2,048 for the presence bitmask).
  The lesson generalises: verifying a decode with `JSON.parse` in a test and
  shipping a raw-regex path is how it got through — the two differ *only* on
  escaping, which is precisely the thing being tested.
- A tile with no stored height is **not flat**; it falls back to the client's
  terrain noise (`calculateTileHeight` in `mapScene.ts`). Treating absent as
  zero would have invented cliffs at every boundary between stored and
  procedural ground.
