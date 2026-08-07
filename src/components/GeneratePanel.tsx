import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import { buildPlan, DEFAULT_DIALS, THEMES, type PlannerDials, type ThemeId } from '../procgen/planner'
import { loadPalette, savePalette, unboundRoles, ROLE_INFO, type GroundPalette } from '../procgen/palette'
import GroundPaletteModal from './GroundPaletteModal'
import { generate } from '../procgen/generate'
import { getApiKey, requestPlan, sanitizePlan } from '../procgen/claude'
import {
  buildSceneryIndex, clearCachedIndex, indexSpeciesCount, loadCachedIndex,
  type ScanStats, type SceneryIndex,
} from '../procgen/scenery'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
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

/**
 * The shape of the landmass, which is a different question from its texture.
 * Water level alone is a percentile of fractal noise and fractal basins are
 * scattered, so without this "coastal" produced ponds rather than a shore, and
 * an island could not be expressed at all.
 */
const LANDFORMS = [
  { id: 'auto' as const, label: 'Auto', hint: 'Let the theme decide — the coastal themes pick a coast, everything else stays inland.' },
  { id: 'inland' as const, label: 'Inland', hint: 'No sea. Any water comes from the water level alone, as scattered pools.' },
  { id: 'coast' as const, label: 'Coast', hint: 'Open sea on one side, with the land rising away from it. The shoreline wanders, because the terrain noise still shapes it — measured at about 30% water in one connected body.' },
  { id: 'island' as const, label: 'Island', hint: 'Land in the middle, sea all round it. About 40% water in a single body, and the coastline is irregular rather than a circle.' },
  { id: 'lakes' as const, label: 'Lakes', hint: 'Inland water wherever the ground dips below the water level — ponds and marsh rather than a shore.' },
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
  /** hand-written / pasted plan JSON — the same contract the AI layer emits */
  const [planText, setPlanText] = useState('')
  /** the panel is three separate ways to author the same plan; showing them
   *  all at once made the modal taller than a screen */
  const [tab, setTab] = useState<'theme' | 'plan' | 'describe'>('theme')
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
  /** the resolved objects folder: undefined = still looking, null = not there */
  const [sceneryDir, setSceneryDir] = useState<FileSystemDirectoryHandle | null | undefined>(undefined)
  /** the maps folder, read once to learn how often the game places each object */
  const [mapsDir, setMapsDir] = useState<FileSystemDirectoryHandle | null>(null)

  useEffect(() => {
    setIndex(loadCachedIndex(cacheFingerprint))
  }, [cacheFingerprint])

  // Find the objects folder up front, so "this will generate bare terrain" is
  // said BEFORE you spend a generation finding out. The parent resolves it too
  // but leaves null on any failure, so this re-tries from the cache root.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (objectsDir) { setSceneryDir(objectsDir); return }
      if (!rootHandle) { setSceneryDir(null); return }
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('objects')).catch(() => null)
      if (!cancelled) setSceneryDir(dir)
    })()
    return () => { cancelled = true }
  }, [objectsDir, rootHandle])

  // The maps folder drives the frequency prior — how often the real game
  // places each candidate object. Missing it isn't fatal; the index just falls
  // back to matching on names alone, which is what shipped before.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!rootHandle) { setMapsDir(null); return }
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('maps')).catch(() => null)
      if (!cancelled) setMapsDir(dir)
    })()
    return () => { cancelled = true }
  }, [rootHandle])

  /**
   * Abort the scenery scan when the panel goes away.
   *
   * The flag MUST be cleared on mount as well as set on unmount. `useRef`
   * survives React's development double-invoke (mount → unmount → mount under
   * StrictMode), so a cleanup-only version left `cancelled: true` set by that
   * first throwaway unmount, on the very same object the second mount reuses.
   * Every scan then aborted after one directory entry — instantly, silently,
   * and looking exactly like an empty objects folder.
   */
  useEffect(() => {
    // capture the object, not the ref — this one is a plain flag we own for the
    // component's lifetime, never a DOM node that could be swapped underneath us
    const flag = cancelRef.current
    flag.cancelled = false
    return () => { flag.cancelled = true }
  }, [])

  /**
   * The species index, built once per cache.
   *
   * Without it NOTHING can be placed: every species fails to resolve and you
   * get bare terrain plus a list of species names, which reads like a content
   * problem rather than a missing index. So this both tries harder to find the
   * folder and says plainly when it cannot.
   */
  async function ensureIndex(): Promise<SceneryIndex | null> {
    // an index with no species is treated as absent, or it short-circuits the
    // rebuild and silently disables scenery for good
    if (index && indexSpeciesCount(index)) return index
    // the parent resolves `objects/` for us, but it does so from its own
    // rootHandle and leaves null on any failure — try once more here rather
    // than silently generating an empty world
    let dir = sceneryDir ?? objectsDir
    if (!dir && rootHandle) {
      dir = await resolveEntryHandle(rootHandle, getEntryPath('objects')).catch(() => null)
    }
    if (!dir) {
      setError('No objects folder found in this cache, so no scenery can be placed — '
        + 'the terrain will generate but it will be bare. Check the cache has an '
        + '"objects" folder at its root.')
      return null
    }
    setBusy('indexing scenery')
    setIndexProgress('reading object definitions… this happens once per cache')
    // a holder, not a bare let: TS cannot see the callback assign it and
    // narrows a plain local to `never`
    const statsBox: { v: ScanStats | null } = { v: null }
    const built = await buildSceneryIndex(
      dir,
      cacheFingerprint,
      (done, found, total) => setIndexProgress(
        total === 0
          ? 'counting object definitions…'
          : `${Math.floor((done / total) * 100)}% · ${done.toLocaleString()} of `
            + `${total.toLocaleString()} objects · ${found.toLocaleString()} scenery matches`,
      ),
      cancelRef.current,
      (s) => { statsBox.v = s },
      mapsDir,
      (done, total) => setIndexProgress(
        `${Math.floor((done / Math.max(1, total)) * 100)}% · learning which objects the game `
        + `actually uses · region ${done.toLocaleString()} of ${total.toLocaleString()}`,
      ),
    )
    setIndex(built)
    setIndexProgress('')
    if (!built || !Object.keys(built.species).length) {
      // Say what the scan SAW. "No scenery" and "no files" look identical from
      // the outside and need completely different fixes.
      const s = statsBox.v
      setError(s
        ? `Scanned the objects folder and matched nothing. It saw ${s.entries} directory `
          + `entries, ${s.jsonFiles} numbered .json files, ${s.named} with a name, `
          + `${s.placeable} placeable, ${s.matched} matched`
          + (s.cancelled ? ' — and the scan was cancelled part-way.' : '.')
          + (s.entries === 0
            ? ' Zero entries means the folder read as empty: either it is the wrong folder, or the browser is refusing to enumerate it.'
            : '')
        : 'Read the objects folder but matched no scenery in it.')
    }
    return built
  }

  async function runBuiltIn() {
    setError('')
    setNotes([])
    try {
      const idx = await ensureIndex()
      setBusy('generating')
      // the sanitiser is the ONE guard rail for any plan, wherever it came
      // from — the built-in planner used to skip it, so a bad rule here was
      // caught only when Claude wrote the same thing
      const { plan: p, notes: sanitizeNotes } = sanitizePlan(buildPlan({ ...dials, palette }, area))
      const res = generate(p, idx)
      setPlan(p)
      setResult(res)
      setNotes([...sanitizeNotes, ...res.report.warnings])
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

  /**
   * Build from a pasted plan.
   *
   * A `ProcPlan` is the whole contract — the AI layer's only job is to write
   * one, so a plan written by hand (or by Claude in a chat window) goes through
   * exactly the same generator and produces exactly the same place. No key, no
   * request, and still deterministic on (plan, seed).
   */
  async function runPlanJson() {
    setError('')
    setNotes([])
    try {
      // Copying JSON out of a chat window or a wrapped code block can smuggle
      // in raw control characters, which are illegal inside a JSON string and
      // fail with an unhelpful "bad control character". None of them can be
      // meaningful in a plan, so retry once with them flattened to spaces
      // rather than making someone hunt for an invisible byte.
      let parsed: ProcPlan
      let repaired = false
      try {
        parsed = JSON.parse(planText) as ProcPlan
      } catch (first) {
        // every control character becomes a space: outside a string JSON treats
        // it as whitespace anyway, and inside one it is the very thing that
        // made the parse fail
        let cleaned = ''
        for (const ch of planText) cleaned += ch.charCodeAt(0) < 32 ? ' ' : ch
        if (cleaned === planText) throw first
        parsed = JSON.parse(cleaned) as ProcPlan
        repaired = true
      }
      const idx = await ensureIndex()
      setBusy('generating')
      // The plan's own area is ignored in favour of the rectangle you picked,
      // so one plan can be dropped anywhere. Zone and prop coordinates are
      // area-relative though, so a size mismatch moves them — say so rather
      // than silently placing a town half off the edge.
      const authored = parsed.area
      const resized = authored
        && (authored.x1 - authored.x0 !== area.x1 - area.x0
          || authored.y1 - authored.y0 !== area.y1 - area.y0)
      const { plan: safe, notes: sanitizeNotes } = sanitizePlan({
        ...parsed,
        area,
        seed: parsed.seed ?? dials.seed,
      })
      const res = generate(safe, idx)
      setPlan(safe)
      setResult(res)
      setNotes([
        ...(repaired ? ['that JSON had stray control characters in it (a copy/paste artifact) — they were stripped'] : []),
        ...(resized
          ? [`this plan was written for ${authored!.x1 - authored!.x0 + 1}×${authored!.y1 - authored!.y0 + 1} regions and you have ${w}×${h} selected — zones and props are placed in area-relative tiles, so they may sit off-centre`]
          : []),
        ...sanitizeNotes, ...res.report.warnings,
      ])
    } catch (e) {
      setError(e instanceof SyntaxError ? `that isn't valid JSON — ${e.message}` : (e instanceof Error ? e.message : String(e)))
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

      {sceneryDir === null && (
        <div className="map-picker-msg procgen-error">
          No <code>objects</code> folder in this cache — terrain will generate but it
          will be completely bare, because species are matched against object names.
        </div>
      )}
      {sceneryDir && !indexSpeciesCount(index) && (
        <div className="map-picker-msg">
          Scenery isn't indexed yet — the first generate reads the object definitions
          once (about 74,000 files) and caches the result for this cache.
        </div>
      )}
      {sceneryDir && !!indexSpeciesCount(index) && (
        <div className="procgen-row">
          <span className="map-picker-selcount">
            scenery: {indexSpeciesCount(index)} species indexed
          </span>
          <button
            type="button"
            className="save-bar-discard"
            title="Throw the cached index away and rescan the objects folder. Worth doing if scenery is missing or the cache has been re-dumped."
            onClick={() => { clearCachedIndex(); setIndex(null); setError('') }}
          >
            Rebuild scenery index
          </button>
        </div>
      )}

      <div className="procgen-tabs">
        {([['theme', 'Theme & dials'], ['plan', 'Paste a plan'], ['describe', 'Describe it']] as const)
          .map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`procgen-tab${tab === id ? ' selected' : ''}`}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
      </div>

      {tab === 'theme' && (<>
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

      <div className="procgen-row procgen-themes">
        {LANDFORMS.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            title={hint}
            className={`mapscene-env-pill${dials.landform === id ? ' selected' : ''}`}
            onClick={() => setDials({ ...dials, landform: id })}
          >
            {label}
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
            {unbound.length} on surveyed defaults
          </span>
        )}
      </div>
      </>)}

      {tab === 'plan' && (
      <div className="procgen-ai">
        <div className="procgen-row">
          {plan && (
            <button
              type="button"
              className="save-bar-discard"
              title="Put the plan behind what you just generated into the box, so you can keep it, tweak it by hand, or send it to someone"
              onClick={() => setPlanText(JSON.stringify(plan, null, 2))}
            >
              Copy current plan out
            </button>
          )}
          <span className="map-picker-selcount">A plan is plain JSON — no key needed</span>
        </div>
        {(
          <>
            <textarea
              className="map-coord-input procgen-prompt"
              rows={8}
              spellCheck={false}
              placeholder={'Paste a ProcPlan here — the same JSON the AI layer emits.\n{ "version": 1, "terrain": { "amplitude": 60, "featureScale": 42 }, "ground": [ … ] }'}
              value={planText}
              onChange={(e) => setPlanText(e.target.value)}
            />
            <div className="procgen-row">
              <button
                type="button"
                className="save-bar-save"
                disabled={!planText.trim() || !!busy}
                onClick={() => void runPlanJson()}
              >
                Build from plan
              </button>
              <span className="map-picker-selcount">
                Uses the rectangle you selected, not the plan's own area
              </span>
            </div>
          </>
        )}
      </div>
      )}

      {tab === 'describe' && (
      <div className="procgen-ai">
        <label className="item-field-label" htmlFor="procgen-prompt">Describe the place</label>
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
      )}

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
