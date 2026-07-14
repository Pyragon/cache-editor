import { useEffect, useRef, useState } from 'react'
import type { AreaData, AreaDef } from '../loaders/config/map_areas'
import type { SpriteMeta } from '../loaders/sprites'
import { loadSpriteMeta, renderFrame } from './spriteRender'
import { IntListInput, NumGrid, ToggleGrid, ParamsTable } from './defFields'
import type { NumFieldDef } from './defFields'
import { paramRowsToRecord, toParamRows } from './defParams'
import type { ParamRow } from './defParams'

type Props = {
  data: AreaData
  onSave: (data: AreaData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const SPRITE_FIELDS: NumFieldDef[] = [
  ['spriteId', 'Sprite'],
  ['defaultIconArchive', 'Default Icon'],
  ['mouseOverIconArchive', 'Mouse-over Icon'],
]

const COLOR_FIELDS: NumFieldDef[] = [
  ['defaultTextColor', 'Default Text'],
  ['mouseOverTextColor', 'Mouse-over Text'],
  ['outlineColor', 'Outline'],
  ['backgroundColor', 'Background'],
  ['lineColor', 'Line'],
]

const GENERAL_FIELDS: NumFieldDef[] = [
  ['baseTextzoom', 'Base Text Zoom'],
  ['categoryId', 'Category ID'],
  ['labelOffsetX', 'Label Offset X'],
  ['labelOffsetY', 'Label Offset Y'],
  ['dashLineSpacing', 'Dash Spacing'],
  ['dashLineLength', 'Dash Length'],
  ['dashLineOffset', 'Dash Offset'],
]

const VAR_FIELDS: NumFieldDef[] = [
  ['primaryVarpbit', 'Primary Varpbit'],
  ['primaryVarp', 'Primary Varp'],
  ['primaryVariableMinValue', 'Primary Min'],
  ['primaryVariableMaxValue', 'Primary Max'],
  ['secondaryVarpbit', 'Secondary Varpbit'],
  ['secondaryVarp', 'Secondary Varp'],
  ['secondaryVariableMinValue', 'Secondary Min'],
  ['secondaryVariableMaxValue', 'Secondary Max'],
]

const FLAG_FIELDS: NumFieldDef[] = [
  ['visible', 'Visible'],
  ['displayedOnWorldmap', 'On World Map'],
  ['displayedOnMinimap', 'On Minimap'],
  ['hasRandomisedMinimapPosition', 'Random Minimap Pos'],
]

function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

// Renders a sprite's first frame, or a placeholder when the id doesn't resolve.
function SpritePreview({ meta }: { meta: SpriteMeta | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !meta || meta.width <= 0 || meta.height <= 0) return
    renderFrame(canvas, meta, 0)
  }, [meta])

  if (!meta || meta.width <= 0 || meta.height <= 0) {
    return <span className="hit-sprite-preview-empty">none</span>
  }
  return (
    <canvas
      ref={ref}
      className="hit-sprite-preview-canvas"
      style={{ width: meta.width * 2, height: meta.height * 2, imageRendering: 'pixelated' }}
    />
  )
}

export default function AreaViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<AreaDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [sprites, setSprites] = useState<Record<string, SpriteMeta | null>>({})
  const [paramRows, setParamRows] = useState<ParamRow[]>([])

  useEffect(() => {
    setDraft(data.def)
    setParamRows(toParamRows(data.def.parameters))
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Load the three referenced sprites whenever their ids change. Ids are
  // plucked out first so edits to unrelated fields don't reload sprites.
  const spriteRefIds = {
    spriteId: Number(draft.spriteId ?? -1),
    defaultIconArchive: Number(draft.defaultIconArchive ?? -1),
    mouseOverIconArchive: Number(draft.mouseOverIconArchive ?? -1),
  }
  useEffect(() => {
    if (!data.spritesDir) return
    let cancelled = false
    async function load() {
      const dir = data.spritesDir!
      const entries = await Promise.all(Object.entries(spriteRefIds).map(async ([key, id]) =>
        [key, id >= 0 ? await loadSpriteMeta(dir, id) : null] as const,
      ))
      if (!cancelled) setSprites(Object.fromEntries(entries))
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spriteRefIds.spriteId, spriteRefIds.defaultIconArchive, spriteRefIds.mouseOverIconArchive, data.spritesDir])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setAction(index: number, value: string) {
    const next = [...(draft.minimenuActions ?? [null, null, null, null, null])]
    next[index] = value === '' ? null : value
    set('minimenuActions', next)
  }

  function setParams(rows: ParamRow[]) {
    setParamRows(rows)
    setDraft((prev) => ({ ...prev, parameters: paramRowsToRecord(rows) }))
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-title-row">
          <input
            className="quest-name-input"
            placeholder="(unnamed area)"
            value={draft.areaName ?? ''}
            onChange={(e) => set('areaName', e.target.value === '' ? undefined : e.target.value)}
          />
        </div>
        <div className="item-badges">
          <span className="item-id-badge">ID {data.id}</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Sprites</h3>
        <div className="hit-sprite-grid">
          {SPRITE_FIELDS.map(([key, label]) => (
            <div key={key} className="hit-sprite-cell">
              <span className="item-field-label" title={label}>{label}</span>
              <input
                className="item-field-input"
                type="number"
                value={Number(draft[key as keyof AreaDef] ?? -1)}
                onChange={(e) => set(key, parseInt(e.target.value, 10) || 0)}
              />
              <div className="hit-sprite-preview">
                <SpritePreview meta={sprites[key] ?? null} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="item-section">
        <h3>Colours</h3>
        <div className="item-grid">
          {COLOR_FIELDS.map(([key, label]) => {
            const value = Number(draft[key as keyof AreaDef] ?? 0)
            return (
              <label key={key} className="item-field">
                <span className="item-field-label">{label}</span>
                <div className="map-sprite-colour-row">
                  <input
                    type="color"
                    className="map-sprite-colour-input"
                    value={rgbIntToHex(value < 0 ? 0 : value)}
                    onChange={(e) => set(key, parseInt(e.target.value.slice(1), 16) || 0)}
                  />
                  <span className="map-sprite-colour-hex">{value === -1 ? 'unset' : rgbIntToHex(value)}</span>
                </div>
              </label>
            )
          })}
        </div>
      </section>

      <section className="item-section">
        <h3>Right-click Menu</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Menu Name</span>
            <input
              className="item-field-input"
              type="text"
              value={draft.minimenuName ?? ''}
              onChange={(e) => set('minimenuName', e.target.value === '' ? undefined : e.target.value)}
            />
          </label>
          {[0, 1, 2, 3, 4].map((i) => (
            <label key={i} className="item-field">
              <span className="item-field-label">Action {i + 1}</span>
              <input
                className="item-field-input"
                type="text"
                value={draft.minimenuActions?.[i] ?? ''}
                onChange={(e) => setAction(i, e.target.value)}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={GENERAL_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
        <ToggleGrid fields={FLAG_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Visibility Vars</h3>
        <NumGrid fields={VAR_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Polygon (opcode 15)</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Offsets (x,y pairs)</span>
            <IntListInput value={draft.offsets} onChange={(v) => set('offsets', v)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Colours (ints)</span>
            <IntListInput value={draft.colors} onChange={(v) => set('colors', v)} />
          </label>
          <label className="item-field">
            <span className="item-field-label">Colour Pointers</span>
            <IntListInput value={draft.colorPointers} onChange={(v) => set('colorPointers', v)} />
          </label>
        </div>
      </section>

      <section className="item-section">
        <h3>Parameters</h3>
        <ParamsTable
          rows={paramRows}
          onSet={(i, patch) => setParams(paramRows.map((row, idx) => idx === i ? { ...row, ...patch } : row))}
          onAdd={() => setParams([...paramRows, { key: '', isString: false, value: '0' }])}
          onRemove={(i) => setParams(paramRows.filter((_, idx) => idx !== i))}
        />
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setParamRows(toParamRows(data.def.parameters)); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
