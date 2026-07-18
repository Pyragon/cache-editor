import { useEffect, useMemo, useRef, useState } from 'react'
import type { InterfaceData, IComponentDefinition, ModelType, CS2Script } from '../loaders/interfaces'
import { MODEL_TYPES } from '../loaders/interfaces'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import ModelViewer from './ModelViewer'
import { NumberInput, NumGrid, ToggleGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { InterfaceAssets, loadPreviewAssets, paintInterface, resolveAbsoluteLayout } from './interfacePreview'
import './InterfaceViewer.css'

// CS2 script hooks a component may carry — shown as a flat list of the ones
// actually present (most components have none). Decompiling CS2 bytecode
// into readable logic is out of scope; this exposes the raw tagged args.
const SCRIPT_FIELDS: [key: keyof IComponentDefinition, label: string][] = [
  ['onLoadScript', 'On Load'],
  ['onMouseOver', 'On Mouse Over'],
  ['onMouseLeaveScript', 'On Mouse Leave'],
  ['hookParams', 'Hook Params'],
  ['onTargetEnter', 'On Target Enter'],
  ['onVarpTransmit', 'On Varp Transmit'],
  ['mouseLeaveScript', 'Mouse Leave'],
  ['onStatTransmit', 'On Stat Transmit'],
  ['onTimer', 'On Timer'],
  ['params', 'Params'],
  ['onTargetLeave', 'On Target Leave'],
  ['popupScript', 'Popup'],
  ['onClick', 'On Click'],
  ['onClickRepeat', 'On Click Repeat'],
  ['onRelease', 'On Release'],
  ['onHold', 'On Hold'],
  ['onDrag', 'On Drag'],
  ['onDragComplete', 'On Drag Complete'],
  ['onMouseMove', 'On Mouse Move'],
  ['onKey', 'On Key'],
  ['onScrollWheel', 'On Scroll Wheel'],
  ['anObjectArray1413', 'Script 1413'],
  ['anObjectArray1292', 'Script 1292'],
  ['anObjectArray1415', 'Script 1415'],
  ['anObjectArray1416', 'Script 1416'],
  ['anObjectArray1383', 'Script 1383'],
  ['anObjectArray1419', 'Script 1419'],
  ['anObjectArray1361', 'Script 1361'],
  ['anObjectArray1421', 'Script 1421'],
  ['anObjectArray1346', 'Script 1346'],
  ['anObjectArray1353', 'Script 1353'],
  ['anObjectArray1271', 'Script 1271'],
]

const LAYOUT_FIELDS: NumFieldDef[] = [
  ['basePositionX', 'Base X'],
  ['basePositionY', 'Base Y'],
  ['baseWidth', 'Base Width'],
  ['baseHeight', 'Base Height'],
]

const SPRITE_FIELDS: NumFieldDef[] = [
  ['angle2d', 'Angle'],
  ['transparency', 'Transparency'],
  ['borderThickness', 'Border Thickness'],
  ['spriteShadow', 'Shadow (ARGB)'],
]

const MODEL_FIELDS: NumFieldDef[] = [
  ['animation', 'Animation'],
  ['originX', 'Origin X'],
  ['originY', 'Origin Y'],
  ['originZ', 'Origin Z'],
  ['spritePitch', 'Pitch'],
  ['spriteRoll', 'Roll'],
  ['spriteYaw', 'Yaw'],
  ['spriteScale', 'Scale'],
]

const TEXT_FIELDS: NumFieldDef[] = [
  ['lineSpacing', 'Line Spacing'],
  ['textHorizontalAli', 'Horizontal Align'],
  ['textVerticalAli', 'Vertical Align'],
  ['maxTextLines', 'Max Lines'],
  ['transparency', 'Transparency'],
]

const CURSOR_FIELDS: NumFieldDef[] = [
  ['targetOverCursor', 'Target Over Cursor'],
  ['targetLeaveCursor', 'Target Leave Cursor'],
  ['moveOverCursor', 'Move Over Cursor'],
  ['dragDeadzone', 'Drag Deadzone'],
  ['dragDeadTime', 'Drag Dead Time'],
  ['dragType', 'Drag Type'],
]

function rgbInputHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}

function scriptToText(script: CS2Script | null | undefined): string {
  if (!script) return ''
  return script.join(', ')
}

function textToScript(text: string): CS2Script | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return trimmed.split(',').map((tok) => {
    const t = tok.trim()
    const n = Number(t)
    return t !== '' && Number.isFinite(n) ? n : t
  })
}

function depthOf(byId: Map<number, IComponentDefinition>, c: IComponentDefinition): number {
  let depth = 0
  let cur = c
  const seen = new Set<number>()
  while (cur.parent !== -1) {
    const parentId = cur.parent & 0xffff
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    depth++
    cur = parent
  }
  return depth
}

export default function InterfaceViewer({ data, onSave, onDirtyChange, onNavigate }: {
  data: InterfaceData
  onSave: (data: InterfaceData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onNavigate?: (entryName: string, itemId: number) => void
}) {
  const [components, setComponents] = useState(data.components)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [viewportW, setViewportW] = useState(765)
  const [viewportH, setViewportH] = useState(503)
  const [showHidden, setShowHidden] = useState(false)
  const [showOutlines, setShowOutlines] = useState(true)
  /** null = fit the panel; a number = explicit scale with scrollable overflow. */
  const [zoom, setZoom] = useState<number | null>(null)
  const [activeSection, setActiveSection] = useState('layout')
  const [modelPreview, setModelPreview] = useState<{ modelId: number; loading: boolean; data: ModelData | null } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const assetsRef = useRef<InterfaceAssets | null>(null)

  useEffect(() => {
    setComponents(data.components)
    setIsDirty(false)
    setSelectedId(data.components.find((c) => c != null)?.componentId ?? null)
    setModelPreview(null)
  }, [data])

  // One asset cache per opened cache root (sprites/fonts/model renders persist across interfaces).
  useEffect(() => {
    if (!data.rootHandle) return
    const assets = new InterfaceAssets(data.rootHandle)
    assetsRef.current = assets
    return () => {
      assets.dispose()
      if (assetsRef.current === assets) assetsRef.current = null
    }
  }, [data.rootHandle])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const list = useMemo(() => components.filter((c): c is IComponentDefinition => c != null), [components])
  const byId = useMemo(() => new Map(list.map((c) => [c.componentId, c])), [list])
  const layout = useMemo(() => resolveAbsoluteLayout(components, viewportW, viewportH), [components, viewportW, viewportH])
  const selected = selectedId != null ? byId.get(selectedId) ?? null : null

  // --- draw preview: load whatever assets this frame needs, then paint ---
  useEffect(() => {
    const canvas = canvasRef.current
    const assets = assetsRef.current
    if (!canvas) return
    let cancelled = false
    const opts = { showHidden, showContainerOutlines: showOutlines }
    // Fixed 2× supersample: the canvas is CSS-fitted to its panel (the whole
    // interface is always visible, never scrolled), so the buffer renders at
    // 2× and downscales crisply.
    const SCALE = 2

    function paintBase(ctx: CanvasRenderingContext2D) {
      canvas!.width = viewportW * SCALE
      canvas!.height = viewportH * SCALE
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#14161d'
      ctx.fillRect(0, 0, viewportW, viewportH)
    }

    function paintSelection(ctx: CanvasRenderingContext2D) {
      if (selectedId == null) return
      const rect = layout.get(selectedId)
      if (!rect) return
      ctx.strokeStyle = '#2f8fff'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 3])
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height)
      ctx.setLineDash([])
    }

    ;(async () => {
      const ctx = canvas.getContext('2d')!
      if (!assets) {
        paintBase(ctx)
        paintSelection(ctx)
        return
      }
      const resolved = await loadPreviewAssets(assets, components, layout, viewportW, viewportH, opts)
      if (cancelled) return
      paintBase(ctx)
      paintInterface(ctx, components, layout, resolved, viewportW, viewportH, opts)
      paintSelection(ctx)
    })()
    return () => { cancelled = true }
  }, [components, layout, selectedId, viewportW, viewportH, showHidden, showOutlines])

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rectBounds = canvas.getBoundingClientRect()
    const px = ((e.clientX - rectBounds.left) / rectBounds.width) * viewportW
    const py = ((e.clientY - rectBounds.top) / rectBounds.height) * viewportH

    // Topmost (deepest) hit wins.
    let best: { id: number; depth: number } | null = null
    for (const c of list) {
      const rect = layout.get(c.componentId)
      if (!rect || (c.hidden && !showHidden)) continue
      if (px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height) {
        const depth = depthOf(byId, c)
        if (!best || depth >= best.depth) best = { id: c.componentId, depth }
      }
    }
    if (best) setSelectedId(best.id)
  }

  function updateSelected(patch: Partial<IComponentDefinition>) {
    if (selectedId == null) return
    setComponents((prev) => prev.map((c) => (c && c.componentId === selectedId ? { ...c, ...patch } : c)))
    setIsDirty(true)
  }

  function set(key: keyof IComponentDefinition, value: unknown) {
    updateSelected({ [key]: value } as Partial<IComponentDefinition>)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, components })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setComponents(data.components)
    setIsDirty(false)
  }

  async function openModelPreview(modelId: number) {
    if (modelId < 0 || !data.rootHandle) return
    setModelPreview({ modelId, loading: true, data: null })
    try {
      const modelsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('models'))
      const loader = getLoader('models')
      if (!modelsDir || !loader) throw new Error('models entry not available')
      const modelData = await loader.loadItem(modelsDir, { id: modelId, name: `${modelId}` }, data.rootHandle) as ModelData
      setModelPreview({ modelId, loading: false, data: modelData })
    } catch {
      setModelPreview({ modelId, loading: false, data: null })
    }
  }

  const attachedScripts = selected ? SCRIPT_FIELDS.filter(([key]) => (selected[key] as CS2Script | null) != null).length : 0
  const hasTypeSection = selected != null && ['SPRITE', 'MODEL', 'TEXT', 'FIGURE', 'LINE'].includes(selected.type)
  const sections: { key: string; label: string }[] = selected
    ? [
        { key: 'layout', label: 'Layout' },
        ...(hasTypeSection ? [{ key: 'type', label: selected.type }] : []),
        { key: 'ops', label: 'Ops & Cursors' },
        { key: 'scripts', label: attachedScripts > 0 ? `CS2 Scripts (${attachedScripts})` : 'CS2 Scripts' },
      ]
    : []
  // fall back when the selected component has no type-specific section
  const active = activeSection === 'type' && !hasTypeSection ? 'layout' : activeSection

  return (
    <div className="iface-viewer">
      <div className="iface-header">
        <span className="item-id-badge">Interface {data.id}</span>
        <span className="iface-count">{list.length} components</span>
        <label className="iface-viewport-field">
          Viewport
          <NumberInput className="cell-input" value={viewportW} onChange={setViewportW} min={16} />
          ×
          <NumberInput className="cell-input" value={viewportH} onChange={setViewportH} min={16} />
        </label>
        <div className="iface-presets">
          <button type="button" title="Classic fixed game screen" onClick={() => { setViewportW(765); setViewportH(503) }}>765×503</button>
          <button type="button" title="Fixed-mode 3D viewport" onClick={() => { setViewportW(512); setViewportH(334) }}>512×334</button>
          <button type="button" title="A resizable-mode window" onClick={() => { setViewportW(1024); setViewportH(768) }}>1024×768</button>
        </div>
        <label className="iface-toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
        <label className="iface-toggle">
          <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
          Container outlines
        </label>
        <div className="iface-zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.25, (z ?? 1) - 0.25))}>−</button>
          <span>{zoom == null ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(4, (z ?? 1) + 0.25))}>+</button>
          {zoom != null && <button type="button" className="iface-zoom-fit" onClick={() => setZoom(null)}>Fit</button>}
        </div>
      </div>

      <div className="iface-body">
        <div className="iface-tree">
          {list
            .slice()
            .sort((a, b) => a.componentId - b.componentId)
            .map((c) => (
              <div
                key={c.componentId}
                className={`iface-tree-row${c.componentId === selectedId ? ' selected' : ''}${c.hidden ? ' hidden-row' : ''}`}
                style={{ paddingLeft: `${8 + depthOf(byId, c) * 12}px` }}
                onClick={() => setSelectedId(c.componentId)}
              >
                <span className="iface-tree-id">{c.componentId}</span>
                <span className="iface-tree-type">{c.type}</span>
                {c.name && <span className="iface-tree-name">{c.name}</span>}
              </div>
            ))}
        </div>

        <div className="iface-main">
          <div className="iface-canvas-wrap">
            <canvas
              ref={canvasRef}
              className="iface-canvas"
              onClick={handleCanvasClick}
              style={zoom == null ? undefined : { width: `${viewportW * zoom}px`, maxWidth: 'none', maxHeight: 'none' }}
            />
          </div>

          {selected && (
            <div className="iface-fields">
              <div className="iface-fields-title">
                Component {selected.componentId} — {selected.type}
                {selected.parent !== -1 && <span className="iface-parent-note"> (parent {selected.parent & 0xffff})</span>}
              </div>

              {active === 'layout' && (
                <section className="item-section">
                  <h3>Layout</h3>
                  <NumGrid fields={LAYOUT_FIELDS} values={selected} onChange={(k, v) => set(k as keyof IComponentDefinition, v)} />
                  <div className="iface-aspect-row">
                    {(['aspectWidthType', 'aspectHeightType', 'aspectXType', 'aspectYType'] as const).map((key) => (
                      <label key={key} className="item-field">
                        <span className="item-field-label">{key}</span>
                        <NumberInput value={selected[key]} onChange={(v) => set(key, v)} min={0} max={5} />
                      </label>
                    ))}
                  </div>
                  <ToggleGrid
                    fields={[['hidden', 'Hidden'], ['preventClickThrough', 'Prevent Click-Through']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                </section>
              )}

              {active === 'type' && selected.type === 'SPRITE' && (
                <section className="item-section">
                  <h3>Sprite</h3>
                  <NumGrid
                    fields={[['spriteId', 'Sprite Id'], ...SPRITE_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                    links={{ spriteId: onNavigate ? { label: 'View', onOpen: (id) => onNavigate('sprites', id) } : undefined }}
                  />
                  <ToggleGrid
                    fields={[['tiling', 'Tiling'], ['alpha', 'Alpha'], ['flipVertical', 'Flip V'], ['flipHorizontal', 'Flip H'], ['clickMask', 'Click Mask']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </section>
              )}

              {active === 'type' && selected.type === 'MODEL' && (
                <section className="item-section">
                  <h3>Model</h3>
                  <label className="item-field">
                    <span className="item-field-label">Model Type</span>
                    <select value={selected.modelType} onChange={(e) => set('modelType', e.target.value as ModelType)}>
                      {MODEL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <NumGrid
                    fields={[['modelId', 'Model Id'], ...MODEL_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                    links={{
                      modelId: {
                        label: 'Preview',
                        onOpen: (id) => openModelPreview(id),
                      },
                    }}
                  />
                  <ToggleGrid
                    fields={[['hasOrigin', 'Has Origin'], ['hasTransform', 'Has Transform'], ['priorityRender', 'Priority Render'], ['usesOrthogonal', 'Orthogonal']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  {modelPreview && (
                    <div className="iface-model-preview">
                      {modelPreview.loading && <div className="iface-model-loading">Loading model {modelPreview.modelId}…</div>}
                      {!modelPreview.loading && !modelPreview.data && <div className="iface-model-loading">Model {modelPreview.modelId} failed to load.</div>}
                      {!modelPreview.loading && modelPreview.data && (
                        <div className="iface-model-preview-canvas">
                          <ModelViewer data={modelPreview.data} display={null} />
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {active === 'type' && selected.type === 'TEXT' && (
                <section className="item-section">
                  <h3>Text</h3>
                  <label className="item-field iface-text-field">
                    <span className="item-field-label">Text</span>
                    <textarea
                      className="quest-textarea"
                      value={selected.text}
                      onChange={(e) => set('text', e.target.value)}
                    />
                  </label>
                  <NumGrid
                    fields={[['fontId', 'Font Id'], ...TEXT_FIELDS]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <ToggleGrid
                    fields={[['shadow', 'Shadow'], ['monospaced', 'Monospaced']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </section>
              )}

              {active === 'type' && (selected.type === 'FIGURE' || selected.type === 'LINE') && (
                <section className="item-section">
                  <h3>{selected.type === 'FIGURE' ? 'Figure' : 'Line'}</h3>
                  <NumGrid
                    fields={selected.type === 'LINE' ? [['lineWidth', 'Line Width']] : [['transparency', 'Transparency']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <ToggleGrid
                    fields={selected.type === 'FIGURE' ? [['filled', 'Filled']] : [['lineDirection', 'Direction (\\ vs /)']]}
                    values={selected}
                    onChange={(k, v) => set(k as keyof IComponentDefinition, v)}
                  />
                  <label className="item-field">
                    <span className="item-field-label">Color</span>
                    <input type="color" value={rgbInputHex(selected.color)} onChange={(e) => set('color', parseInt(e.target.value.slice(1), 16))} />
                  </label>
                </section>
              )}

              {active === 'ops' && (
                <section className="item-section">
                  <h3>Options &amp; Cursors</h3>
                  <label className="item-field">
                    <span className="item-field-label">Op Base</span>
                    <input className="cell-input" value={selected.opBase} onChange={(e) => set('opBase', e.target.value)} />
                  </label>
                  <label className="item-field">
                    <span className="item-field-label">Target Verb</span>
                    <input className="cell-input" value={selected.targetVerb} onChange={(e) => set('targetVerb', e.target.value)} />
                  </label>
                  {(selected.options ?? []).map((opt, i) => (
                    <label key={i} className="item-field">
                      <span className="item-field-label">Option {i + 1}</span>
                      <input
                        className="cell-input"
                        value={opt ?? ''}
                        onChange={(e) => {
                          const next = [...(selected.options ?? [])]
                          next[i] = e.target.value
                          set('options', next)
                        }}
                      />
                    </label>
                  ))}
                  <NumGrid fields={CURSOR_FIELDS} values={selected} onChange={(k, v) => set(k as keyof IComponentDefinition, v)} />
                </section>
              )}

              {active === 'scripts' && (
                <section className="item-section">
                  <h3>CS2 Scripts</h3>
                  {attachedScripts === 0 && (
                    <div className="iface-no-scripts">No scripts attached to this component.</div>
                  )}
                  {SCRIPT_FIELDS.filter(([key]) => (selected[key] as CS2Script | null) != null).map(([key, label]) => (
                    <label key={key} className="item-field iface-text-field">
                      <span className="item-field-label">{label}</span>
                      <input
                        className="cell-input"
                        value={scriptToText(selected[key] as CS2Script | null)}
                        onChange={(e) => set(key, textToScript(e.target.value))}
                      />
                    </label>
                  ))}
                </section>
              )}
            </div>
          )}
        </div>

        <div className="iface-side">
          {!selected && (
            <div className="iface-side-hint">Click a component in the preview or the tree to inspect it.</div>
          )}
          {sections.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`iface-section-btn${active === key ? ' selected' : ''}`}
              onClick={() => setActiveSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard} disabled={isSaving}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
