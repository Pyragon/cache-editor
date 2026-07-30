// The long-form "what am I actually editing?" panel behind the Explain button
// on the underlay and overlay editors.
//
// Sourced from the client traces in docs/terrain-blending.md and EDITOR.md's
// "Ground / terrain blending" section, and from FluType.kt / FloType.kt for
// opcode numbers. Kept as prose deliberately: the per-field "?" toggles answer
// "what does this box do", this answers "how does ground work at all", which
// is the thing nobody can guess from a form.
import { useEffect, useRef } from 'react'
import './GroundExplainer.css'

export default function GroundExplainer({ kind, onClose }: {
  kind: 'underlay' | 'overlay'
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])

  return (
    <dialog
      ref={ref}
      className="ground-explainer"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      <div className="ground-explainer-body">
        <header className="ground-explainer-header">
          <h3>How ground materials work</h3>
          <button type="button" className="ground-explainer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="ground-explainer-scroll">
          <section>
            <h4>The two layers</h4>
            <p>
              Every walkable tile in the world is painted from at most two definitions. The{' '}
              <strong>underlay</strong> is the base ground — grass, dirt, sand, cave floor. The{' '}
              <strong>overlay</strong> is an optional layer painted on top of it — a path, a road,
              water, a wooden floor. A tile can have an underlay alone, an overlay alone, or both.
            </p>
            <p>
              The region data doesn't store colours, only ids: <code>underlayIds</code> and{' '}
              <code>overlayIds</code>, one byte per tile, plus a packed{' '}
              <code>overlayShapeRot</code> byte. Those bytes are{' '}
              <strong>the definition id plus one</strong>, because 0 has to mean "nothing here" — so
              the tile byte 164 refers to underlay <em>163</em>. Editing a definition therefore
              repaints every tile in the world that points at it; there is no per-tile colour to
              override.
            </p>
          </section>

          <section className={kind === 'underlay' ? 'ground-explainer-focus' : undefined}>
            <h4>Underlays never draw the colour you typed</h4>
            <p>
              This is the single most surprising thing about underlays. The client does not paint a
              tile with its own colour. It runs a <strong>blur over the surrounding tiles</strong>{' '}
              first: for each tile it averages the hue, saturation and lightness of every underlay in
              roughly an 11×11 tile window, weighting hue by a per-colour divisor, and that average
              becomes the colour of the tile <em>corner</em>. Mid-tile vertices are interpolated
              between the four corners, and the GPU Gouraud-shades between those.
            </p>
            <p>
              Two consequences worth knowing before you go hunting for a bug. A single tile of a new
              colour dropped into a field of grass will barely show — it is averaged away by its
              neighbours. And a large area of the same underlay <em>does</em> reach full strength in
              the middle, so the same definition looks different depending on how much of it is laid
              down together. That is why the preview surrounds your material with a neighbour: a
              swatch on its own tells you almost nothing about how it will read in game.
            </p>
            <p>
              Colour also passes through the client's packed 16-bit HSL palette, the same one model
              faces use, so the in-game result is quantised — the two swatches on this page show
              the raw value you typed and the quantised value the client will actually draw.
            </p>
          </section>

          <section className={kind === 'overlay' ? 'ground-explainer-focus' : undefined}>
            <h4>Overlays: shape, priority, and one master switch</h4>
            <p>
              An overlay covers part of a tile, described by a <strong>shape</strong> (0–12) and a{' '}
              <strong>rotation</strong> (0–3) stored per tile, not on the definition. Shape 0 is the
              whole tile; the others are halves, corners, quarters and diagonal bands; shape 12 means
              the tile is plain underlay. That is how a curved road is drawn out of square tiles, and
              it is why the same overlay definition can look like a straight kerb in one place and a
              diagonal corner in another.
            </p>
            <p>
              <strong><code>blendsWithUnderlay</code> (opcode 12) is the master switch.</strong> It
              is not a cosmetic softening toggle. It selects which of three geometry tables the tile
              is built from, so flipping it changes the tile's triangle count — and it changes the{' '}
              <em>neighbouring</em> tiles' geometry too, because a blending overlay makes adjacent
              tiles subdivide. With it on, three separate blending mechanisms come into play: a
              cross-tile perimeter blend that bleeds this overlay's colour into the ring vertices of
              its neighbours, a different tile-shape family with extra underlay-side faces, and an
              intra-tile feather that fades the overlay across the underlay half of its own tile.
            </p>
            <p>
              When two overlays meet, <strong><code>slot</code> (opcode 11) decides who wins</strong>{' '}
              the shared vertices. The comparison doesn't use the raw byte you edit: after decoding
              the client packs it as <code>slot &lt;&lt; 8 | id</code>, so a higher slot always beats
              a lower one, and two definitions sharing a slot are broken apart by their id — the
              higher id wins. Raising slot makes a material paint over its neighbours at the seam.
            </p>
          </section>

          <section>
            <h4>Two colours, and what the second one really does</h4>
            <p>
              Overlays have two colour fields. <code>colorRgb</code> (opcode 1) is the tile colour —
              the one that gets blended. <code>secondaryRgb</code> (opcode 7) does{' '}
              <strong>three unrelated jobs</strong>, which is why it was mislabelled "minimap colour"
              in both cryogen and darkan until a render trace caught it:
            </p>
            <ul>
              <li>it is the colour the <strong>minimap</strong> draws, overriding a texture's average;</li>
              <li>it is the ground <strong>material colour</strong> in the 3D scene;</li>
              <li>
                it acts as a <strong>gate</strong> — an overlay with neither a tile colour nor a
                secondary colour is discarded outright, before its blend flag is even read. Such a
                definition is invisible no matter what else it says.
              </li>
            </ul>
            <p>
              Both colour fields use magenta (<code>0xFF00FF</code>) as the "no colour" sentinel
              rather than a null, which is what the "No colour" toggle on each swatch sets.
            </p>
          </section>

          <section>
            <h4>Textures</h4>
            <p>
              A material can carry a texture as well as (or instead of) a colour. Ground textures are
              <strong> splatted per corner</strong>: each ground vertex takes the texture of the tile
              whose origin sits at that corner, and the renderer draws a pass per material with
              vertex alpha, which is what stops adjacent different-textured underlays showing a hard
              seam. Most ground textures are near-greyscale detail maps that get multiplied by the
              tile colour, so texture and colour work together rather than one replacing the other.
            </p>
            <p>
              <strong>Texture scale</strong> is stored as <code>readUnsignedShort() &lt;&lt; 2</code>{' '}
              and defaults to 512 — the width of exactly one tile. Doubling it to 1024 stretches the
              texture over two tiles; halving it to 256 repeats it twice per tile. The effect is only
              judgeable across several tiles, which is what the preview's Field control is for.
            </p>
          </section>

          <section>
            <h4>The two flags</h4>
            <p>
              <strong><code>shadowed</code></strong> (underlay opcode 4, overlay opcode 10) decides
              whether the tile <em>receives</em> the baked scenery and wall shadows. The map builder
              sets a per-tile <code>hasShadows</code> from it and the renderer turns that into a{' '}
              <code>CONTAINS_SHADOW</code> flag; a tile without it stays evenly lit even directly
              under a wall. It does not control whether the material casts anything.
            </p>
            <p>
              <strong><code>occlude</code></strong> (opcode 5 on both) is not a visual property at
              all — it is a culling hint. On planes above ground level, a tile that is perfectly flat
              and occludes is marked "completely flat", letting the renderer skip drawing the level
              below it. Turning it off is how see-through floors — grates, glass, holes looking down
              a level — keep what's underneath visible. Our renderer doesn't implement plane-below
              culling, so this flag has no effect in the editor's 3D view; it still matters in game.
            </p>
          </section>

          <section>
            <h4>Water</h4>
            <p>
              An overlay the client treats as water uses its own set of fields rather than the flat
              tile path: <code>waterColor</code>, <code>waterFogDepth</code> (stored{' '}
              <code>&lt;&lt; 2</code>) and <code>waterIntensity</code>, plus{' '}
              <code>opcode20</code> and two fields the client decodes and never reads. These feed the
              animated, fogged water surface, whose transparency is driven by the depth of the
              riverbed dumped in the separate underwater map — which is why shallow water near a
              shore fades to show the sand underneath instead of being tinted.
            </p>
            <p>
              <code>opcode20</code>, <code>unusedOpcode21</code> and <code>unusedOpcode22</code> keep
              those names deliberately: darkan's own decoder has no better name for them either
              (<code>opcode20</code> is guessed to be a water scale), so inventing one here would be
              worse than admitting the gap.
            </p>
          </section>

          <section>
            <h4>Where this lives</h4>
            <p>
              Underlays are CONFIG file type 1 (<code>config/underlays</code>, decoder{' '}
              <code>FluType</code>), overlays are CONFIG file type 4 (<code>config/overlays</code>,
              decoder <code>FloType</code>). The per-tile ids live in the <code>maps</code> entry,
              one JSON per region. The full client trace behind all of the above is in{' '}
              <code>docs/terrain-blending.md</code>, with the editor-facing summary in{' '}
              <code>EDITOR.md</code>.
            </p>
          </section>
        </div>

        <div className="ground-explainer-actions">
          <button type="button" className="save-bar-save" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  )
}
