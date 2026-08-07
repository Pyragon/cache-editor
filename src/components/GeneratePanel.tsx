import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import { buildPlan, DEFAULT_DIALS, THEMES, type PlannerDials, type ThemeId } from '../procgen/planner'
import { loadPalette, savePalette, unboundRoles, ROLE_INFO, type GroundPalette } from '../procgen/palette'
import GroundPaletteModal from './GroundPaletteModal'
import { generate } from '../procgen/generate'
import { getApiKey, requestPlan, sanitizePlan } from '../procgen/claude'
import { buildSceneryIndex, loadCachedIndex, type SceneryIndex } from '../procgen/scenery'
import type { GenerationResult, ProcPlan } from '../procgen/types'

/**
 * The generator's UI, shown when a region rectangle is selected in the world
 * picker: choose a theme (or describe the place, with a key set), generate, and
 * review what it made before anything is written.
 *
 * Nothing here touches the cache. It produces a `GenerationResult` and hands it
 * to the caller, which routes it through the normal multi-region draft/save
 * path — so a generated area is reviewable, undoable and discardable exactly
 * like a hand edit.
 */
/**
 * The dials, with what each one actually moves. A slider whose effect you have
 * to guess is a slider you re-roll blindly, so every one of these says which
 * part of the plan it changes rather than describing itself ("how much stuff").
 */
const SLIDERS = [
  {
    key: 'relief' as const,
    label: 'Hills',
    hint: 'Height range of the terrain, from a near-flat plain to steep country. Drives the plan\'s amplitude — and with it how much stone shows on the slopes, since steep ground paints differently.',
  },
  {
    key: 'density' as const,
    label: 'Scenery',
    hint: 'How thickly things grow. Scales every scatter rule at once, so trees, undergrowth and rocks all thin out or thicken together rather than one at a time.',
  },
  {
    key: 'settlement' as const,
    label: 'Built-up',
    hint: 'How settled the area is. Past about 35% it adds a village: flattened ground, paved building plots, wider paths and props like a well or a fountain. Below that the area stays wild.',
  },
  {
    key: 'pathReach' as const,
    label: 'Path reach',
    hint: 'How much of the area ends up within reach of a path. Each spur is aimed at whatever is currently furthest from the network, so this fills the area in rather than adding routes and hoping. Low leaves most of it trackless wilderness; high means you are never far from a way through.',
  },
  {
    key: 'pathWidth' as const,
    label: 'Path width',
    hint: 'How wide a path is in open country, 1 to 5 tiles. Inside a settlement it always widens on top of this — a road is only broad where the traffic and the building plots are, so a track through the woods stays a track and opens out as it arrives somewhere.',
  },
  {
    key: 'pathLoops' as const,
    label: 'Path loops',
    hint: 'How often a spur, having got where it was going, carries on and rejoins the network somewhere else instead of stopping dead. A place where every lane is a dead end reads as a diagram; real villages loop, so you can leave one way and come back another.',
  },
  {
    key: 'wander' as const,
    label: 'Path wander',
    hint: 'How much routes meander instead of heading straight at their goal. Low reads as a surveyed road, high as a track worn by feet following the ground. A settlement damps this — town roads run truer than wilderness tracks.',
  },
]

export default function GeneratePanel({
  area, regionCount, objectsDir, rootHandle, cacheFingerprint, onApply, onClose,
}: {
  area: { x0: number; y0: number; x1: number; y1: number }
  regionCount: number
  /** for resolving species → object ids; null disables scenery */
  objectsDir: FileSystemDirectoryHandle | null
  /** for reading the cache's ground materials in the palette picker */
  rootHandle: FileSystemDirectoryHandle | undefined
  cacheFingerprint: string
  /** the resolved scenery index rides along so a re-roll can reuse it — the
   *  localStorage key is derived from the region count, which CHANGES when
   *  generating creates free regions */
  onApply: (result: GenerationResult, plan: ProcPlan, index: SceneryIndex | null) => void
  onClose: () => void
}) {
  // The ground palette is CACHE data, kept out of the dials' identity so a
  // rebind doesn't look like a dial change; `buildPlan` gets it at call time.
  const [palette, setPalette] = useState<GroundPalette>(() => loadPalette(cacheFingerprint))
  const [showPalette, setShowPalette] = useState(false)
  const [dials, setDials] = useState<PlannerDials>({ ...DEFAULT_DIALS, seed: 1337, palette: loadPalette(cacheFingerprint) })
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const [result, setResult] = useState<GenerationResult | null>(null)
  const [plan, setPlan] = useState<ProcPlan | null>(null)
  const [index, setIndex] = useState<SceneryIndex | null>(null)
  const [indexProgress, setIndexProgress] = useState('')
  const cancelRef = useRef({ cancelled: false })
  const hasKey = !!getApiKey()

  useEffect(() => {
    setIndex(loadCachedIndex(cacheFingerprint))
  }, [cacheFingerprint])

  useEffect(() => () => { cancelRef.current.cancelled = true }, [])

  async function ensureIndex(): Promise<SceneryIndex | null> {
    if (index) return index
    if (!objectsDir) return null
    setBusy('indexing scenery')
    setIndexProgress('reading object definitions… this happens once per cache')
    const built = await buildSceneryIndex(
      objectsDir,
      cacheFingerprint,
      (done, found) => setIndexProgress(`scanned ${done.toLocaleString()} objects · ${found} scenery matches`),
      cancelRef.current,
    )
    setIndex(built)
    setIndexProgress('')
    return built
  }

  async function runBuiltIn() {
    setError('')
    setNotes([])
    try {
      const idx = await ensureIndex()
      setBusy('generating')
      const p = buildPlan({ ...dials, palette }, area)
      const res = generate(p, idx)
      setPlan(p)
      setResult(res)
      setNotes(res.report.warnings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function runClaude() {
    setError('')
    setNotes([])
    try {
      const idx = await ensureIndex()
      setBusy('asking claude')
      // only offer species this cache actually resolved, so Claude can't plan
      // a forest of something that isn't there
      const available = idx
        ? (Object.entries(idx.species) as [string, { id: number }[] | undefined][])
            .filter(([, list]) => list && list.length > 0)
            .map(([name]) => name)
        : undefined
      const reply = await requestPlan({
        prompt,
        area,
        seed: dials.seed,
        context: { availableSpecies: available, palette },
      })
      const { plan: safe, notes: sanitizeNotes } = sanitizePlan(reply.plan)
      setBusy('generating')
      const res = generate(safe, idx)
      setPlan(safe)
      setResult(res)
      setNotes([...sanitizeNotes, ...res.report.warnings, ...(reply.note ? [reply.note] : [])])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const w = area.x1 - area.x0 + 1
  const h = area.y1 - area.y0 + 1
  const unbound = unboundRoles(palette)

  return (
    <div className="procgen-panel">
      {showPalette && (
        <GroundPaletteModal
          rootHandle={rootHandle}
          palette={palette}
          onChange={(next) => { setPalette(next); savePalette(cacheFingerprint, next) }}
          onClose={() => setShowPalette(false)}
        />
      )}
      <div className="procgen-head">
        <span className="enum-title">Generate</span>
        <span className="map-picker-selcount">
          {w}×{h} regions ({w * 64}×{h * 64} tiles) · {regionCount} to write
        </span>
        <button type="button" className="map-picker-close" onClick={onClose}>Close</button>
      </div>

      <div className="procgen-row">
        <label className="map-create-underlay">
          <span className="item-field-label">seed</span>
          <NumberInput value={dials.seed} onChange={(seed) => setDials({ ...dials, seed })} min={0} max={999999} digits={6} />
        </label>
        <button
          type="button"
          className="save-bar-discard"
          onClick={() => setDials({ ...dials, seed: Math.floor(Math.random() * 999999) })}
        >
          Randomise
        </button>
      </div>

      <div className="procgen-row procgen-themes">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.blurb}
            className={`mapscene-env-pill${dials.theme === t.id ? ' selected' : ''}`}
            onClick={() => setDials({ ...dials, theme: t.id as ThemeId })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="procgen-row procgen-sliders">
        {SLIDERS.map(({ key, label, hint }) => (
          <label key={key} className="procgen-slider" title={hint}>
            <span className="procgen-slider-head">
              <span className="item-field-label">{label}</span>
              <span className="procgen-slider-value">{Math.round(dials[key] * 100)}%</span>
            </span>
            <input
              type="range" min={0} max={100} step={5}
              value={Math.round(dials[key] * 100)}
              aria-label={label}
              onChange={(e) => setDials({ ...dials, [key]: parseInt(e.target.value, 10) / 100 })}
            />
          </label>
        ))}
      </div>

      <div className="procgen-row">
        <button type="button" className="save-bar-save" disabled={!!busy} onClick={() => void runBuiltIn()}>
          {busy === 'generating' ? 'Generating…' : 'Generate'}
        </button>
        <button type="button" className="save-bar-discard" onClick={() => setShowPalette(true)}>
          Ground materials…
        </button>
        {unbound.length > 0 && (
          <span className="map-picker-selcount" title={unbound.map((r) => ROLE_INFO[r].label).join(', ')}>
            {unbound.length} material{unbound.length === 1 ? '' : 's'} still guessed
          </span>
        )}
      </div>

      <div className="procgen-ai">
        <label className="item-field-label" htmlFor="procgen-prompt">Or describe it</label>
        <textarea
          id="procgen-prompt"
          className="map-coord-input procgen-prompt"
          rows={2}
          placeholder={hasKey
            ? 'a small village ringed by dense forest you cannot walk out of, with a fountain in the square'
            : 'Set an API key in Settings → AI generation to use this'}
          value={prompt}
          disabled={!hasKey}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="procgen-row">
          <button
            type="button"
            className="save-bar-save"
            disabled={!hasKey || !prompt.trim() || !!busy}
            onClick={() => void runClaude()}
          >
            {busy === 'asking claude' ? 'Asking Claude…' : 'Generate with Claude'}
          </button>
          <span className="map-picker-selcount">
            {hasKey ? 'Uses your key · a few cents per generation' : 'No API key set'}
          </span>
        </div>
      </div>

      {(busy || indexProgress) && (
        <div className="map-picker-msg">
          {indexProgress || `${busy}…`}
        </div>
      )}
      {error && <div className="map-picker-msg procgen-error">{error}</div>}

      {result && plan && (
        <div className="procgen-result">
          <div className="map-picker-selcount">
            <strong>{result.report.placements.toLocaleString()}</strong> objects ·{' '}
            {result.report.zones.length} zones · {result.report.plots.length} building plots ·{' '}
            {result.report.regions} regions
            {plan.environment ? ' · environment overridden' : ''}
          </div>
          {notes.map((n, i) => <div key={i} className="map-picker-msg">{n}</div>)}
          <p className="tex-op-note">
            Generated — review it before saving. Applying replaces the terrain and
            placements of every region in the area; it goes through the normal
            draft flow, so Discard still undoes it.
          </p>
          <div className="map-picker-actions">
            <button type="button" className="save-bar-discard" onClick={() => { setResult(null); setPlan(null) }}>
              Discard
            </button>
            <button type="button" className="save-bar-save" onClick={() => onApply(result, plan, index)}>
              Apply to {result.report.regions} region{result.report.regions === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
