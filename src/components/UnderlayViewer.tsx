import { useEffect, useState } from 'react'
import type { UnderlayData, UnderlayDef } from '../loaders/config/underlays'
import { Field, HexColorInput, NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { rgbToRenderedHex } from '../loaders/models'
import GroundPreview from './GroundPreview'
import GroundExplainer from './GroundExplainer'
import GroundUsagePanel from './GroundUsagePanel'
import TextureThumb from './TextureThumb'
import './UnderlayViewer.css'

const NUM_FIELDS: NumFieldDef[] = [
  ['texture', 'Texture ID', (
    <>
      Opcode 2. The material drawn on tiles using this underlay, or <code>-1</code> for none.
      Ground textures are splatted per tile corner and blended with vertex alpha, so two
      different-textured underlays meet in a crossfade rather than a hard seam. Most ground
      textures are near-greyscale detail maps that get multiplied by the colour above — the
      texture and the colour work together.
    </>
  )],
  ['scale', 'Texture Scale', (
    <>
      Opcode 3, stored as <code>readUnsignedShort() &lt;&lt; 2</code>. <code>512</code> — the
      default — makes the texture span exactly one tile. <code>1024</code> stretches it over two
      tiles, <code>256</code> repeats it twice per tile. Judge it across several tiles in the
      preview, not on one.
    </>
  )],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['shadowed', 'Shadowed', (
    <>
      Opcode 4 (stored inverted — the opcode's presence means <em>false</em>). Whether tiles of
      this underlay <strong>receive</strong> the baked wall and scenery shadows: the map builder
      turns it into a per-tile <code>hasShadows</code>, which the renderer stores as{' '}
      <code>CONTAINS_SHADOW</code>. Switch it off and the ground stays evenly lit even directly
      under a wall. It has nothing to do with casting shadows.
    </>
  )],
  ['occlude', 'Occlude', (
    <>
      Opcode 5 (also stored inverted). Not a visual property — a culling hint. On planes above
      ground level, a tile that is perfectly flat and occludes is flagged "completely flat" so the
      renderer can skip the level underneath. Turn it off for see-through floors (grates, glass,
      holes). The editor's 3D view doesn't do plane-below culling, so this flag won't change the
      preview; it still matters in game.
    </>
  )],
]

type Props = {
  data: UnderlayData
  onSave: (data: UnderlayData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  rootHandle?: FileSystemDirectoryHandle
  onNavigate?: (entryName: string, id: number) => void
}

// Ground tile base colour. The swatch shows the colour as the client
// actually renders it — quantised through the same HSL16 palette as model
// faces — not the raw uploaded RGB, which can look a little different.
export default function UnderlayViewer({ data, onSave, onDirtyChange, rootHandle, onNavigate }: Props) {
  const [draft, setDraft] = useState<UnderlayDef>(data.def)
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

  const rawHex = `#${(draft.rgb & 0xffffff).toString(16).padStart(6, '0')}`
  const renderedHex = rgbToRenderedHex(draft.rgb)

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Underlay {data.id}</span>
          {draft.texture >= 0 && <span className="item-id-badge">textured</span>}
        </div>
        <button type="button" className="ground-explain-btn" onClick={() => setExplaining(true)}>
          How ground works
        </button>
      </div>

      <p className="tex-op-note ground-intro">
        An <strong>underlay</strong> is the base ground a tile is painted with — grass, dirt, sand,
        a cave floor. Every walkable tile in the world references one by id, and an overlay (a path,
        water, a wooden floor) may be painted on top of it. Editing this definition repaints every
        tile in the world that points at it.
        <br />
        The colour below is <em>not</em> drawn as-is: the client averages each tile against its
        neighbours over roughly an 11×11 window and gives the result to the tile's corners, so a
        lone tile of a new colour is almost invisible while a whole field of it reads at full
        strength. The preview surrounds it with a second material for exactly that reason.
      </p>

      <section className="item-section">
        <h3>Preview</h3>
        <GroundPreview
          rootHandle={rootHandle}
          kind="underlay"
          id={data.id}
          def={draft as unknown as Record<string, unknown>}
        />
      </section>

      <section className="item-section">
        <h3>Colour</h3>
        <div className="underlay-color-row">
          <label className="underlay-swatch-label">
            <input
              type="color"
              className="underlay-color-input"
              value={rawHex}
              onChange={(e) => set('rgb', parseInt(e.target.value.slice(1), 16))}
            />
            <span className="underlay-swatch-caption">uploaded</span>
          </label>
          <div className="underlay-swatch-label">
            <span className="underlay-swatch-static" style={{ background: renderedHex }} title={renderedHex} />
            <span className="underlay-swatch-caption">in-game</span>
          </div>
          <div className="underlay-value-field">
            <HexColorInput
              className="underlay-rgb-input"
              value={draft.rgb}
              onChange={(v) => set('rgb', v)}
              title="24-bit colour as #RRGGBB"
            />
            {/* the raw integer is what lands in the JSON, so keep it visible */}
            <span className="underlay-swatch-caption">hex · {draft.rgb}</span>
          </div>
        </div>
        <p className="tex-op-note">
          Opcode 1, a 24-bit RGB. The client converts it to packed HSL16 at load and quantises it
          through the same 65,536-entry palette model faces use — the "in-game" swatch is that
          result, and it can differ slightly from the raw value. It then feeds the neighbour blur
          described above, so what a tile finally draws is an average, not this colour.
        </p>
      </section>

      <section className="item-section">
        <h3>Texture</h3>
        <div className="item-grid">
          <Field
            label="Texture ID"
            help={NUM_FIELDS[0][2]}
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
          fields={[NUM_FIELDS[1]]}
          values={draft as unknown as Record<string, unknown>}
          onChange={(k, v) => set(k, v)}
        />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid fields={FLAG_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Used in the world</h3>
        <GroundUsagePanel
          rootHandle={rootHandle}
          kind="underlay"
          id={data.id}
          onOpenRegion={onNavigate ? (region) => onNavigate('maps', region) : undefined}
        />
      </section>

      {explaining && <GroundExplainer kind="underlay" onClose={() => setExplaining(false)} />}

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
