import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { OverlayData, OverlayDef } from '../loaders/config/overlays'
import { NO_COLOR } from '../loaders/config/overlays'
import { Field, HelpToggle, HexColorInput, NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { rgbToRenderedHex } from '../loaders/models'
import GroundPreview from './GroundPreview'
import GroundExplainer from './GroundExplainer'
import GroundUsagePanel from './GroundUsagePanel'
import TextureThumb from './TextureThumb'
import './UnderlayViewer.css'

const SCALE_HELP: ReactNode = (
  <>
    Opcode 9, stored as <code>readUnsignedShort() &lt;&lt; 2</code>. <code>512</code> — the default
    — spans exactly one tile; <code>1024</code> stretches over two, <code>256</code> repeats twice
    per tile. It is carried through the cross-tile blend alongside the colour and texture.
  </>
)

const SLOT_HELP: ReactNode = (
  <>
    Opcode 11. Layering priority when two overlays meet at a shared vertex — the higher slot paints
    over the lower one at the seam. The comparison does <strong>not</strong> use this raw byte: after
    decoding, the client packs it as <code>slot &lt;&lt; 8 | id</code>, so definitions sharing a slot
    are separated by their id, with the higher id winning. Default 8.
  </>
)

const FLAG_FIELDS: NumFieldDef[] = [
  ['blendsWithUnderlay', 'Blends With Underlay', (
    <>
      Opcode 12, and the <strong>master switch</strong> for this overlay — not a cosmetic softening
      toggle. It selects which of three geometry tables the tile is built from, so the tile gets a
      different triangle count, and it changes <em>neighbouring</em> tiles' geometry too because
      adjacent tiles subdivide next to a blending overlay. With it on, three mechanisms engage: the
      cross-tile perimeter blend, the blending shape family, and an intra-tile feather across the
      underlay half of the tile. Toggle it in the preview with a shaped tile selected — the change
      is obvious on diagonals.
    </>
  )],
  ['occlude', 'Occlude', (
    <>
      Opcode 5 (stored inverted — the opcode's presence means <em>false</em>). A culling hint, not a
      visual property: on planes above ground, a flat occluding tile is flagged "completely flat" so
      the renderer can skip the level below. Turn it off for see-through floors. Our 3D view doesn't
      do plane-below culling, so it won't change the preview.
    </>
  )],
  ['shadowed', 'Shadowed', (
    <>
      Opcode 10 (also stored inverted). Whether the tile <strong>receives</strong> baked wall and
      scenery shadows — the map builder sets <code>hasShadows</code> from it and the renderer stores{' '}
      <code>CONTAINS_SHADOW</code>. For overlays the client additionally requires the tile to have a
      real shape and a tile colour before it counts.
    </>
  )],
]

const WATER_FIELDS: NumFieldDef[] = [
  ['waterFogDepth', 'Fog Depth', (
    <>Opcode 14, stored <code>readUnsignedByte() &lt;&lt; 2</code>, default 512. How quickly the water fogs out with depth.</>
  )],
  ['waterIntensity', 'Intensity', <>Opcode 16, default 255.</>],
  ['opcode20', 'Water Scale (?)', (
    <>
      Opcode 20, a u16, default 63. The name is honest: darkan's own decoder comments it{' '}
      <code>// water scale?</code> and nothing in the client pins it down, so it keeps the opcode
      number rather than a guessed name.
    </>
  )],
]

const UNKNOWN_FIELDS: NumFieldDef[] = [
  ['unusedOpcode21', 'unusedOpcode21', <>Opcode 21, a byte, default 0. Decoded by the client and never read.</>],
  ['unusedOpcode22', 'unusedOpcode22', <>Opcode 22, a u16, default 64. Decoded by the client and never read.</>],
]

// One colour field with an editable swatch, the client-rendered result, and
// a "no colour" toggle (the cache's 0xff00ff sentinel).
function ColorField({ label, value, help, onChange }: {
  label: string
  value: number
  help?: ReactNode
  onChange: (v: number) => void
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const isNone = value === NO_COLOR
  const rawHex = `#${(isNone ? 0 : value & 0xffffff).toString(16).padStart(6, '0')}`
  const renderedHex = isNone ? null : rgbToRenderedHex(value)

  return (
    <div className="item-field ground-color-field">
      <span className={`item-field-label${help ? ' has-help' : ''}`}>
        <span className="field-label-text">{label}</span>
        {help && <HelpToggle open={helpOpen} onToggle={() => setHelpOpen((o) => !o)} />}
      </span>
      <div className="underlay-color-row">
        <label className="underlay-swatch-label">
          <input
            type="color"
            className="underlay-color-input"
            value={rawHex}
            disabled={isNone}
            onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
          />
          <span className="underlay-swatch-caption">uploaded</span>
        </label>
        {/* Kept in the layout even with no colour, so the row doesn't reflow
            when the sentinel is toggled. */}
        <div className="underlay-swatch-label">
          <span
            className={`underlay-swatch-static${renderedHex ? '' : ' underlay-swatch-empty'}`}
            style={renderedHex ? { background: renderedHex } : undefined}
            title={renderedHex ?? 'No colour'}
          />
          <span className="underlay-swatch-caption">in-game</span>
        </div>
        <div className="underlay-value-field">
          <HexColorInput
            className="underlay-rgb-input"
            value={isNone ? 0 : value}
            onChange={onChange}
            disabled={isNone}
            title="24-bit colour as #RRGGBB"
          />
          <span className="underlay-swatch-caption">{isNone ? 'no colour' : `hex · ${value}`}</span>
        </div>
        <label className="badge-toggle">
          <input type="checkbox" checked={isNone} onChange={(e) => onChange(e.target.checked ? NO_COLOR : 0x7f7f7f)} />
          <span className={isNone ? 'badge item-badge-off' : 'badge badge-members'}>
            {isNone ? 'No colour' : 'Coloured'}
          </span>
        </label>
      </div>
      {helpOpen && help && <div className="field-help-text">{help}</div>}
    </div>
  )
}

type Props = {
  data: OverlayData
  onSave: (data: OverlayData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  rootHandle?: FileSystemDirectoryHandle
  onNavigate?: (entryName: string, id: number) => void
}

export default function OverlayViewer({ data, onSave, onDirtyChange, rootHandle, onNavigate }: Props) {
  const [draft, setDraft] = useState<OverlayDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [explaining, setExplaining] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  // The client discards an overlay with neither colour before it reads
  // anything else about it — worth saying out loud rather than leaving someone
  // to wonder why their edits do nothing.
  const invisible = draft.colorRgb === NO_COLOR && draft.secondaryRgb === NO_COLOR && draft.texture < 0

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Overlay {data.id}</span>
          {draft.blendsWithUnderlay && <span className="item-id-badge">blends with underlay</span>}
          <span className="item-id-badge">slot {draft.slot}</span>
        </div>
        <button type="button" className="ground-explain-btn" onClick={() => setExplaining(true)}>
          How ground works
        </button>
      </div>

      <p className="tex-op-note ground-intro">
        An <strong>overlay</strong> is the layer painted on top of a tile's base underlay — a path,
        a road, water, a wooden floor. How much of the tile it covers is <em>not</em> stored here:
        each tile carries its own <strong>shape</strong> (0–12) and <strong>rotation</strong> (0–3),
        which is how curved roads are built from square tiles. Use the preview's shape and rotation
        pickers to see the same definition as a kerb, a diagonal, or a full slab.
      </p>

      {invisible && (
        <p className="tex-op-note ground-warning">
          This overlay has no tile colour, no secondary colour and no texture — the client discards
          it before it even reads the blend flag, so it draws nothing at all.
        </p>
      )}

      <section className="item-section">
        <h3>Preview</h3>
        <GroundPreview
          rootHandle={rootHandle}
          kind="overlay"
          id={data.id}
          def={draft as unknown as Record<string, unknown>}
        />
      </section>

      <section className="item-section">
        <h3>Colour</h3>
        <div className="item-grid">
          <ColorField
            label="Tile Colour"
            value={draft.colorRgb}
            onChange={(v) => set('colorRgb', v)}
            help={(
              <>
                Opcode 1, the client's <code>primaryRGB</code>. This is the colour that gets blended
                — into neighbouring tiles' corners when this overlay blends, and across its own tile
                by the intra-tile feather. Magenta (<code>0xFF00FF</code>) is the "no colour"
                sentinel, which the toggle sets.
              </>
            )}
          />
          <ColorField
            label="Secondary Colour"
            value={draft.secondaryRgb}
            onChange={(v) => set('secondaryRgb', v)}
            help={(
              <>
                Opcode 7, the client's <code>secondaryRGB</code>. It does <strong>three</strong>{' '}
                unrelated jobs: it is the <strong>minimap</strong> colour (overriding a texture's
                average), it is the ground <strong>material colour</strong> in the 3D scene, and it
                acts as a <strong>gate</strong> — an overlay with neither this nor a tile colour is
                thrown away before its blend flag is read. It is not a fallback for the tile colour.
                Dumps made before 2026-07-25 spell it <code>minimapColorRgb</code>; the loader
                migrates those on read.
              </>
            )}
          />
        </div>
      </section>

      <section className="item-section">
        <h3>Blending &amp; priority</h3>
        <div className="item-grid">
          <Field label="Slot" help={SLOT_HELP}>
            <NumberInput value={draft.slot} onChange={(v) => set('slot', v)} min={0} max={255} />
            <span className="ground-derived">
              packed key <code>{((draft.slot << 8) | data.id).toLocaleString()}</code>
            </span>
          </Field>
        </div>
        <ToggleGrid
          fields={[FLAG_FIELDS[0]]}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => set(k, v)}
        />
      </section>

      <section className="item-section">
        <h3>Texture</h3>
        <div className="item-grid">
          <Field
            label="Texture ID"
            help={(
              <>
                Opcodes 2 and 3 (byte and u16 forms; <code>0xFFFF</code> means none). Drawn on the
                overlay portion of the tile and carried through the cross-tile blend as a crossfade
                pass. <code>-1</code> for a flat colour.
              </>
            )}
          >
            <div className="ground-texture-row">
              <NumberInput value={draft.texture} onChange={(v) => set('texture', v)} min={-1} />
              <TextureThumb
                rootHandle={rootHandle}
                id={draft.texture}
                onOpen={onNavigate ? (id) => onNavigate('textures', id) : undefined}
              />
            </div>
          </Field>
        </div>
        <NumGrid
          fields={[['textureScale', 'Texture Scale', SCALE_HELP]]}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => set(k, v)}
        />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid
          fields={[FLAG_FIELDS[1], FLAG_FIELDS[2]]}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => set(k, v)}
        />
      </section>

      <section className="item-section">
        <h3>Water</h3>
        <p className="tex-op-note">
          Only used for overlays the client treats as water, which are drawn as an animated, fogged
          surface instead of a flat tile. The shore fade comes from the riverbed depth in the
          separate underwater map, not from these fields — which is why shallow water shows the sand
          beneath it rather than a lighter tint.
        </p>
        <div className="item-grid">
          <Field
            label="Water Colour"
            help={<>Opcode 13, a 24-bit RGB, default <code>1190717</code>. Unlike the tile colours this one has no magenta sentinel.</>}
          >
            <div className="underlay-color-row">
              <input
                type="color"
                className="underlay-color-input"
                value={`#${(draft.waterColor & 0xffffff).toString(16).padStart(6, '0')}`}
                onChange={(e) => set('waterColor', parseInt(e.target.value.slice(1), 16))}
              />
              <HexColorInput
                className="underlay-rgb-input"
                value={draft.waterColor}
                onChange={(v) => set('waterColor', v)}
                title="24-bit colour as #RRGGBB"
              />
            </div>
          </Field>
        </div>
        <NumGrid fields={WATER_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Used in the world</h3>
        <GroundUsagePanel
          rootHandle={rootHandle}
          kind="overlay"
          id={data.id}
          onOpenRegion={onNavigate ? (region) => onNavigate('maps', region) : undefined}
        />
      </section>

      <details className="item-unknown">
        <summary>Unknown fields</summary>
        <NumGrid fields={UNKNOWN_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </details>

      {explaining && <GroundExplainer kind="overlay" onClose={() => setExplaining(false)} />}

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
