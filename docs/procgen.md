# Procedural region generation — design

Status: PLANNED (2026-08-05). Nothing here is built yet. The foundations it
needs shipped the same day: the 3D view builds an N×N region span (the
"Regions" selector, `SceneMosaic` generalized past 3×3), and the world map's
create flow can lay down W×H region areas up to 64×64 (bulk files written to
disk; existing regions inside the area are never overwritten).

The goal: type a seed (or, later, a sentence), get a believable landscape —
mountains, flat plots where buildings could go, paths connecting the plots,
grass or snow or anything the underlay palette can express. Buildings
themselves are OUT of scope for the generator: it produces *plots*, and a
separate prefab system fills them later (Cody has his own notes on prefabs —
do not design that here).

## Phase 1 — the deterministic generator

A pure function: `(area, seed, knobs) → terrain edits`. No AI, no network.
Everything below writes the same data the terrain brush already writes
(heights, underlay ids, overlay ids + shapes), so Save/repack needs nothing
new.

Pipeline, in order:

1. **Heightmap.** A few octaves of seeded simplex noise with domain warping
   over the WHOLE area (not per region — one continuous field, split into
   per-region files only at write time). Knobs: mountain amplitude, feature
   scale, warp strength, sea/valley floor level. Heights quantize to the
   stored per-tile byte (`heightValue`, 8-unit steps; value 1 = explicit 0 —
   see the create-region fill for the sentinel).
2. **Zoning.** Slope analysis finds candidate flat areas; picks N plots
   (knob: plot count/density, plot size range), flattens each plot outward
   with a smoothstep skirt so it melts into the hillside instead of terracing.
   Plots are tagged with a purpose (village core, outlying hut, landmark) —
   the tags matter to the AI layer and to prefabs later, not to the terrain.
3. **Paths.** A* between plots (and optionally to the area edge), cost =
   slope + a bonus for reusing existing path, so routes converge into a
   network rather than N disjoint lines. Painted as an overlay a few tiles
   wide (knob: path overlay id — a grey/dirt one; the ported blending melts
   the edges). Where a path must climb steeply, carve the heights toward the
   path line (switchback feel) rather than letting it stripe up a cliff.
4. **Biome paint.** Underlay per tile from height/slope/moisture noise:
   the theme is literally a palette map (knob: grass set vs snow set vs
   custom list of underlay ids with weight ranges). Rock overlays above a
   slope threshold, water overlay below the water level. Snow line as a
   height threshold with a noisy edge.
5. **Write-back.** Split the area field into per-region `MapTerrain`s and
   hand them to the normal draft/save path. Multi-region saves write each
   region file like the bulk create does.

UI sketch: a "Generate" panel on the map page — seed, the knobs above,
Preview (renders into the loaded scene without saving) and Apply. With the
Regions span selector the whole generated area is visible at once.

### Regenerating ONE region inside a generated area

Wanted: select a region, hit "regenerate just this one", and have it mesh
seamlessly with its (possibly hand-edited) neighbours. Design:

- The generator takes optional **boundary constraints**: the 65-vertex border
  heights (and border-tile underlays) of each existing neighbour are FIXED.
- Regenerate the region from a new seed as usual, then blend the outer K
  tiles (K ≈ 8) toward the fixed borders with a smoothstep falloff — same
  trick as the plot skirts.
- Paths: any path that touches the border of a neighbour is a fixed entry
  point the new region's path network must connect to.
- This is also exactly the mechanism for "extend the world": generate a new
  region next to an existing coastline/city edge and it grows out of it
  rather than butting against it.

## Phase 2 — prefabs (DEFERRED, not this doc's job)

The generator only makes plots. Stamping buildings onto plots is the prefab
system — Cody has separate notes with ideas for it. The only contract the
generator promises: a plot is flat, tagged with a purpose, and records its
rect + orientation so a stamper can consume it later.

## Phase 3 — the Claude layer (BYOK)

Optional, additive: the user pastes their own Anthropic API key and describes
the region in words; Claude turns the description into the generator's knob
settings. **Claude never generates tiles** — it fills in the same spec the
sliders edit, so output is always renderable and iteration is stable (same
seed + tweaked spec = same landscape, adjusted).

- **Client-only**: official SDK with `dangerouslyAllowBrowser: true`; the key
  goes only to Anthropic. Keep it in memory by default; localStorage only
  behind an explicit opt-in with a "stored on this machine" note. Suggest a
  workspace-scoped key with a spend limit.
- **Context doc**: generated once from the opened cache — underlay/overlay
  ids with their colours/texture names, the knob schema with ranges and
  effects, area size, and (later) the prefab library. Sent as the system
  prompt with `cache_control` so repeat generations are cheap.
- **The call**: `claude-opus-5`, structured outputs (`output_config.format`
  with a JSON schema of the spec) so the reply is guaranteed-valid. A
  generation is a few cents at Opus pricing; say so in the UI.
- **Iteration**: keep the conversation; "make it snowier" is a follow-up turn
  that returns a revised spec. The single-region-regenerate flow above works
  here too — "redo just this region as a quarry" sends the boundary
  constraints along.
- Safety/UX rules per the upload-safety conventions: the key is data, never
  logged; clear cost disclosure; a visible "AI generated — review before
  saving" note on results.

## Open questions

- Water: real water needs the underwater (`um`) tail for depth-faded shores —
  generated regions would get flat-colour water until we also generate a
  simple depth field. Probably fine for v1.
- Region environments: should the generator also write a
  `maps/environments/<id>.json` (sun/fog/skybox theme per biome)? Cheap win,
  slots into the same spec.
- The stored-height quirk: absent height + plane 0 rolls the client's Perlin
  default — generated terrain must always write explicit heights (the create
  fill already does).
