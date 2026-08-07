# Procedural region generation

Status: **BUILT 2026-08-06** — generator, planner, UI and Claude layer.
The generator is verified by running it; the UI and the Claude call have never
been exercised in a browser. Read "The determination" first — it answers the question
that shaped everything else.

---

## The determination: dials, or a generator Claude actually changes?

Cody asked, given a wishlist of tree species, barriers around a forest, lamps
along paths in dark areas, environment dimming, fountains, stony Varrock-like
areas and mines: *can a basic proc-gen with dials plus Claude adjusting those
dials do all this, or does the generator itself need to change based on what
Claude says?*

**Neither. The answer is a third thing, and it is why this was built the way it
was.**

Dials are genuinely not enough, and it is worth being precise about why. A dial
is a magnitude. Every one of the interesting asks is a *relationship*:

| The ask | Why a dial can't express it |
|---|---|
| "a village surrounded by forest so you're trapped" | a ring that FOLLOWS a zone's boundary, with a controlled number of ways through. There is no scalar for "enclosed but not sealed". |
| "lights along the paths" | placement RELATIVE to a computed path network that doesn't exist until the generator has routed it |
| "a gloomy area" | dead trees *and* a dimmed sun *and* heavier fog — three unrelated subsystems that have to agree on a mood |
| "an area with resources, like a mine" | a zone, sunk into the ground, seeded with ore-bearing rocks, with rubble around it |

But the opposite extreme — Claude emitting tiles, or Claude rewriting generator
code — is worse. Tiles would be megabytes of output with no determinism and no
guarantee the result is even renderable. Generated code is unreviewable and
unsafe to run against someone's cache.

So the contract is a **plan**: a small, closed vocabulary of ENTITIES that
Claude authors and a deterministic generator executes.

```
  a sentence ─► Claude ─┐
                        ├─► ProcPlan (json) ─► generator ─► terrain + locs + env
  presets/dials ────────┘
```

Claude chooses the *structure* — which zones exist, where they are, what grows
in them, where the barrier goes and how many gaps it has, whether the sun dims.
That is meaningfully "the generator changes based on what Claude says": a plan
can describe places the preset themes never anticipated. What it cannot do is
produce something unrenderable, non-deterministic, or unreviewable.

Three properties fall out of this that are worth protecting:

1. **The AI is not a separate code path.** The built-in planner emits the same
   `ProcPlan`. Everything works with no API key; Claude is just a better
   planner. There is exactly one generator to debug.
2. **Same plan + same seed = same place**, forever, offline. Verified in
   testing (terrain and placements byte-identical across runs).
3. **A plan is reviewable json.** You can read what it is about to do before it
   touches the cache, hand-edit it, diff two of them, or keep one beside the
   region it produced.

The one real cost: the vocabulary is a ceiling. Claude cannot ask for something
`types.ts` has no word for. Adding "rivers that flow downhill to the sea" means
adding a concept to the plan and code to execute it — Claude cannot invent it.
I think that is the right trade (it is also what keeps the output safe), but it
is the thing to revisit if it ever feels limiting. **See the questions at the
bottom.**

---

## What is built and tested

`src/procgen/`:

| file | what it is |
|---|---|
| `types.ts` | the plan vocabulary — the contract, and the long-form version of the reasoning above |
| `rng.ts` | seeded RNG, value noise, domain-warped fbm, weighted picks |
| `scenery.ts` | species vocabulary → real object ids, by NAME, from the opened cache |
| `generate.ts` | the deterministic executor |
| `planner.ts` | 8 built-in themes + dials → a plan (no API key needed) |
| `claude.ts` | BYOK: a sentence → a plan, via tool-use so the reply is schema-valid |

Pipeline order inside `generate.ts` (order matters, and is commented in place):
heightmap → zones (flatten with a skirt) → plots → paths (A\* with slope cost
and route reuse) → ground bands → resources → props → **path lighting** →
barriers → scatter → split into per-region files.

Lighting deliberately runs BEFORE scatter. It didn't at first, and the result
was zero lamps on every dark theme: scatter had already claimed every verge
tile. The deliberate things go down first and the filler fits around them.

### Verified by running it (not by reading it)

Across all 8 themes over a 3×2 region area:

- 35-220 ms per generation; 800-3800 placements depending on theme
- terrain byte-identical across two runs of the same plan ✓
- placements byte-identical across two runs ✓
- **zero plane-0 tiles missing an explicit height** ✓ — critical, because an
  absent height makes the client roll its own Perlin default and silently
  discard the heightmap
- barrier ring around a village: 446 placements in the ring band, filling
  70 of 72 angular sectors, with exactly 2 empty sectors — i.e. it encloses,
  and the two gaps are real ✓
- lit paths on the dark themes: 18 lamps placed along the routed network ✓
- environment record written for `gloomy_woods` and `wasteland` ✓

### Covering the wishlist

| Ask | Status |
|---|---|
| tree species (oak/willow/maple/yew/magic/evergreen/palm) | ✓ vocabulary + name matching |
| dead trees, burnt, stumps, fallen/broken | ✓ |
| rocks, boulders, rubble | ✓ |
| ferns, plants, flowers, bushes, reeds, mushrooms, grass tufts | ✓ |
| "gloomy → dead trees specifically" | ✓ `gloomy_woods` theme, and Claude can do it from a sentence |
| barriers so you're trapped | ✓ `BarrierRing`, gaps enforced by the sanitizer |
| lights along paths in dark areas | ✓ `PathLighting`, incl. emitting real point-light records |
| environment dimmed for dark areas | ✓ `EnvironmentSpec` written per region |
| fountains (and wells, statues, benches…) | ✓ `PropPlacement` with a levelled pad |
| stony areas like Varrock/Falador | ✓ `stony_highland` (ridged terrain, stone bands, rock overlays) |
| mines / resource areas | ✓ `ResourceNode` — sinks a pit and seeds ore rocks |
| works across every region being created | ✓ generates one continuous field over the whole rectangle, splits at write time |

---

## Not done yet

- ~~UI.~~ **Built, unclicked.** Select a rectangle in the world picker →
  "Generate…" → theme pills, seed, three sliders, or a prompt box if a key is
  set → Apply. Apply routes through the multi-region draft path, so a
  generation is previewed in the 3D view, is undoable, and writes nothing until
  Save. The API key lives in Settings → AI generation.
  **Nothing in this UI has been exercised in a browser.**
- ~~The scenery index has never been built against the real cache.~~
  **DONE — validated against all 73,913 objects in cryogen-cache, and it found
  three real bugs** (see "What validation caught" below). 51 of 52 species now
  resolve, and the preferred match for each is the plain one: `tree` → "Tree",
  `tree_oak` → "Oak", `rock_large` → "Rock", `fountain` → "Fountain",
  `crate` → "Crate". The one gap is `stalagmite`, which resolves but is a cave
  prop nothing currently scatters. The index itself has still never been built
  through the UI (it needs an opened cache), only through an offline harness
  running the same matching logic.
- **Claude layer is untested against the live API** (no key here). The request
  shape, tool schema and error handling are written; nobody has watched a real
  response come back.
- **Prefabs.** Unchanged: the generator makes plots, tags them and reports
  them. Stamping buildings is your separate notes.
- **Single-region regenerate with boundary constraints** (the old phase-1
  design, still wanted) — `preserveRegions` exists in the plan type as the
  hook, and nothing reads it yet.

---

## What validation caught

Running the matcher over the real dump was worth more than any amount of
re-reading it. Three bugs, none of which type-checking or a unit test on
invented data would have found:

1. **Substring matching planted the wrong things.** "Conse**crate**d pet house"
   matched `crate`, "Je**well**ery box" matched `well`, "Timber de**fence**"
   matched `fence`, "En**grave**d sarcophagus" matched `gravestone`. Matching is
   now anchored on non-letter boundaries.
2. **Word anchoring then broke every plural** — `rock` stopped matching "Coal
   rocks", `reed` stopped matching "Reeds", and five ore species silently
   vanished. Terms now tolerate one trailing `s`.
3. **`ore_coal` and `ore_clay` were being eaten by `rock_small`**, because the
   generic "rocks" pattern ran first and only "<metal> **ore** rocks" tripped
   its exclusion. Ore species are now ordered ahead of generic rock.

Also fixed while looking: `ore_adamant` needed "adamantite" spelled out;
`ore_essence` has to precede `ore_rune` or "Rune essence rock" is claimed as
runite; and a species now prefers its plainest-named member, because a cache
holds one "Oak" and a dozen "Diseased Oak"/"Evil oak tree" variants and a
forest of diseased oaks is not what "oak" meant.

## Questions for you

Answer any of these and I'll act on them; where you don't, I'll use the
judgement noted.

1. **Is the vocabulary ceiling acceptable?** Claude can only use concepts
   `types.ts` defines. The alternative — letting it emit small sandboxed
   scripts — is much more powerful and much harder to trust. *My judgement:
   keep the vocabulary, grow it when something is missing.*

2. **Underlay/overlay ids are guesses.** Everything except 164 (grass, from the
   create-region fill) is a placeholder: dirt 22, sand 33, stone 47, snow 59,
   path overlay 4, water 6, rock 15. If you tell me the real ids for a few
   ground types I'll set them as the defaults; otherwise the panel will expose
   them so you can fix them per-generation.

3. **How much should Generate overwrite?** Right now a plan rewrites every tile
   and replaces the placement list of every region in the rectangle. For
   *creating* new regions that's obviously right. For running it over regions
   that already have content it is destructive. *My judgement: Generate is
   offered on the create flow and on empty regions freely; over existing
   content it needs an explicit confirm naming the regions it will overwrite.*

4. **Should generated point lights be written?** Path lighting can emit real
   light records into the environment file. They cost a rebuild and they bake
   into loc colours. Cheap to leave on for dark themes only, which is what it
   does now.

5. **Scatter density feels high to me.** A dense forest currently lands ~580
   placements per region. Real regions run a few hundred. It looks right in the
   numbers but I have not seen it rendered — if it reads as a wall of trunks,
   the density scale needs halving across every theme.

6. **Water.** Still the old open question: real water wants the underwater
   (`um`) tail for depth-faded shores, which we don't generate. `coastal`
   paints a flat water overlay below a height threshold. Fine for v1?

7. **Where should the Generate UI live** — the picker footer (my plan), a tab
   in the map side panel, or its own page? The picker footer means "select the
   area you want, then describe it", which reads well to me.
