# Animation Studio — design

One editor for making an animation, instead of three index viewers you have to
wire together by hand. The existing `animations`, `animation_frame_sets` and
`animation_frame_bases` pages stay, for looking at raw data; they stop being
where you author.

Branch: `animation-studio`.

## The problem with the current editors

The three entries are the format's own layering, and each viewer shows one
layer, so authoring means holding all three in your head at once:

| entry | what it is | what you had to do by hand |
|---|---|---|
| `animation_frame_bases` | the rig: numbered transform SLOTS, each a type + a set of vertex-group labels | know which slot number is "the arm" |
| `animation_frame_sets` | a library of POSES on one rig, keyed by file id | pick a file id, type per-slot deltas |
| `animations` | the PLAYLIST: `(frameSetId, fileId)` + a duration per frame | pack the two ids into a hash yourself |

None of those is the unit a person thinks in. The unit is **"pose the model,
save it as a frame, repeat"** — which is recoverable from the data, because the
data was authored that way.

## The one idea that makes it work: parts

There are no bones in the format. But a frame base's slots reuse the same label
sets over and over, and that reuse *is* the skeleton.

A **part** = one distinct label set + every slot that drives it (its channels:
0 pivot, 1 move, 2 turn, 3 scale). That is a bone — a set of vertices you can
move, turn or scale. Hierarchy comes from containment: if one part's labels are
a strict subset of another's, it's a child, and the parent is the *smallest*
strict superset. That matches how the animation already behaves, because the
client relies on the same nesting (a parent's slot names its descendants'
groups, and runs first).

Implemented in `src/loaders/animRig.ts`, measured over all 3,535 bases:

- **108,947 parts, ~31 per base**, max 214; 14 bases have none.
- Nesting up to 32 deep, well spread across depths 0–9.
- 1,618 bases resolve to a single root, 1,903 to several. Several is fine —
  detached pieces are genuinely separate roots.
- **36,638 parts (a third) carry only a type-0 channel.** They exist to place a
  pivot for something else to turn about. They are marked `poseable: false` and
  must stay out of the bone list, or the ~21 real parts per base drown in them.

`partForVertex` maps a clicked vertex to the deepest part that owns it, which is
what makes "click the hand, not the torso" work.

## The studio

One page, three regions:

1. **Viewport** — the posed model. Click a part to select it; the selection gets
   a gizmo at its pivot (already built: `ModelViewer`'s `gizmo` prop, and
   `applyAnimationFrame`'s `probeSlot` reports the running pivot).
2. **Rig tree** — the poseable parts, nested. Selection is shared with the
   viewport both ways.
3. **Timeline** — the frames of the animation being built, each a pose plus a
   duration. Add / duplicate / reorder / retime. This is the piano-roll idea
   from the cutscene editor, applied to frames.

The authoring loop the user asked for:

> load a model, choose frame 1, set a pose, add frame 2, move it slightly, …

maps directly: **add frame** duplicates the current pose (so you nudge rather
than rebuild), and posing writes deltas into that frame's entries.

## What the studio owns, and what it writes

The studio holds ONE draft: a model, a rig, and an ordered list of
`{ pose, durationCycles }`. On save it writes all three entries itself:

- each pose → a frame file in a frame set (new set, or append to an existing one)
- the rig → the frame base, only if a new one was created
- the ordered list → a sequence, with `frameHashes` packed as
  `(setId << 16) | fileId` and `frameDurations` alongside

The user never types a file id or a hash.

## Decisions already made

- **No mesh editing needed.** Animation needs the mesh's existing vertex groups,
  nothing more, and every rigged model in the cache has them. Authoring groups
  for an unrigged model is *rigging*, a separate and much larger job — out of
  scope until asked for.
- **Reuse an existing rig by default.** Making a new frame base means inventing
  label sets, which means rigging. Picking a model and animating it on the rig
  it already has covers everything the user described.
- **Parts are unnamed in the cache.** `partLabel` describes them by depth and
  size; the studio should let you rename them for the session (and eventually
  persist names beside the dump, since they're editor metadata, not cache data).

## Order of work

1. `animRig.ts` — **done**, verified against every base.
2. Studio shell: model picker → rig → viewport with click-to-select + gizmo.
   Most of this exists in `AnimationFrameSetViewer` and can be lifted.
3. Frame timeline: add / duplicate / retime, previewing through real durations
   rather than the flat rate the frame-set viewer uses.
4. Save: write frame set + sequence together.
5. Only then: creating a new frame base, i.e. rigging.

## Gotchas carried over

- `endBit`-style trap: rotation deltas are stored PRE-shift (`<<2 & 0x3fff`), so
  the storable resolution is a quarter of a 14-bit step. See `packAngle`.
- Axis mapping between the gizmo and the format is not symmetric: RS X and Y are
  standard rotations, Z is negated, and the `(x, −y, −z)` render mapping negates
  Y and Z again. Net: three X → RS `+φ`, Y → `−φ`, Z → `+φ`. Verified numerically.
- `transformationIndices` must stay ascending, and `count` is exactly
  `maxSlot + 1`. Both hold in all 86,609 frames checked.
