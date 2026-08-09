import { useEffect, useRef, useState } from 'react'
import { NumberInput } from './defFields'
import { buildPlan, DEFAULT_DIALS, THEMES, type PlannerDials, type ThemeId } from '../procgen/planner'
import { loadPalette, savePalette, unboundRoles, ROLE_INFO, type GroundPalette } from '../procgen/palette'
import GroundPaletteModal from './GroundPaletteModal'
import { generate } from '../procgen/generate'
import {
  BRIEF_FILE, PLAN_FILE, PROCGEN_DIR,
  getApiKey, planningBrief, requestPlan, sanitizePlan,
} from '../procgen/claude'
import type { ArchetypeModel } from '../procgen/archetypes'
import {
  buildSceneryIndex, clearCachedIndex, indexSpeciesCount, loadCachedIndex,
  type ScanStats, type SceneryIndex,
} from '../procgen/scenery'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import type { ContextModel } from '../procgen/context'
import { clearContextModel, loadArchetypes, loadContextModel } from '../procgen/modelStore'
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
  /** what the real map plants where; loaded once, rebuilt with the index */
  const contextRef = useRef<ContextModel | null>(null)
  /** the place types mined from this cache, for the planning brief */
  const archetypeRef = useRef<ArchetypeModel | null>(null)
  /** These mirror the refs above so the completeness check can RENDER. Reading
   *  a ref during render never re-runs when it loads, so the gaps list would
   *  report whatever was true on mount and never correct itself. */
  const [archetypeCount, setArchetypeCount] = useState(0)
  const [hasContext, setHasContext] = useState(false)
  /** feedback for the brief buttons, which are otherwise silent */
  const [briefCopied, setBriefCopied] = useState('')
  /** 'waiting' polls procgen/plan.json for an answer to the brief we wrote */
  const [planFileState, setPlanFileState] = useState<'idle' | 'waiting'>('idle')
  /** when the brief was written, so an older plan.json isn't mistaken for a reply */
  const briefWrittenAt = useRef(0)
  const hasKey = !!getApiKey()
  /** the resolved objects folder: undefined = still looking, null = not there */
  const [sceneryDir, setSceneryDir] = useState<FileSystemDirectoryHandle | null | undefined>(undefined)
  /** the maps folder, read once to learn how often the game places each object */
  const [mapsDir, setMapsDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [areasDir, setAreasDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [modelsDir, setModelsDir] = useState<FileSystemDirectoryHandle | null>(null)

  useEffect(() => {
    setIndex(loadCachedIndex(cacheFingerprint))
    // The model lives in IndexedDB (too big for localStorage), so it loads
    // asynchronously and separately from the index. Absent is fine: generation
    // falls back to the frequency prior alone.
    let cancelled = false
    void loadContextModel(cacheFingerprint).then((m) => {
      if (cancelled) return
      contextRef.current = m
      setHasContext(!!m)
    })
    void loadArchetypes(cacheFingerprint).then((a) => {
      if (cancelled) return
      archetypeRef.current = a
      setArchetypeCount(a?.archetypes.length ?? 0)
    })
    return () => { cancelled = true }
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

  // The world map's area definitions, which say which regions are the actual
  // overworld. Without them every mined vocabulary learns from dungeons and
  // test areas as if they were the game — see `worldAreas.ts`.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!rootHandle) { setAreasDir(null); return }
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('map_areas')).catch(() => null)
      if (!cancelled) setAreasDir(dir)
    })()
    return () => { cancelled = true }
  }, [rootHandle])

  // Models, so the mine can drop the invisible marker anchors the client never
  // draws — barrier walls were otherwise built into houses (`markers.ts`).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!rootHandle) { setModelsDir(null); return }
      const dir = await resolveEntryHandle(rootHandle, getEntryPath('models')).catch(() => null)
      if (!cancelled) setModelsDir(dir)
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
  /**
   * `force` rescans even when an index is already loaded.
   *
   * The Rebuild button needs it for a reason that isn't obvious: it clears the
   * cache and calls straight back in, but `setIndex(null)` has not landed yet,
   * so this closure still sees the OLD index and would short-circuit on the
   * line below — the rebuild would quietly do nothing.
   */
  async function ensureIndex(force = false): Promise<SceneryIndex | null> {
    // an index with no species is treated as absent, or it short-circuits the
    // rebuild and silently disables scenery for good
    if (!force && index && indexSpeciesCount(index)) return index
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
    // Whoever sets `busy` clears it. This used to be left to the CALLER, and
    // every caller happened to have a try/finally that did it — so the one
    // that didn't (the rebuild button) left the panel reading "indexing
    // scenery…" forever, after a scan that had actually succeeded. A function
    // that acquires state and relies on its callers to release it will keep
    // finding new ways to leak it.
    setBusy('indexing scenery')
    setIndexProgress('reading object definitions… this happens once per cache')
    try {
      return await runScan(dir)
    } finally {
      setBusy('')
      setIndexProgress('')
    }
  }

  /** The scan itself. Split out only so `ensureIndex` can wrap it in the
   *  try/finally above without indenting the whole body. */
  async function runScan(dir: FileSystemDirectoryHandle): Promise<SceneryIndex | null> {
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
        + `actually uses · overworld region ${done.toLocaleString()} of ${total.toLocaleString()}`,
      ),
      areasDir,
      modelsDir,
    )
    // Say which corpus was mined. A silent fallback to "all 2,413 regions" is
    // exactly how dungeon masonry and a one-region door became the defaults,
    // and the symptom only ever showed up as ugly output much later.
    if (!built.corpus.filtered) {
      setError('This cache has no readable map_areas folder, so the generator had to learn '
        + 'from EVERY region in the dump — dungeons, minigames and test areas included. '
        + 'Expect underground walls and odd doors on buildings. Re-dump map_areas to fix it.')
    }
    setIndex(built.index)
    if (built.contextModel) { contextRef.current = built.contextModel; setHasContext(true) }
    // The archetypes are mined by this same scan. The ref was loaded from
    // IndexedDB on mount, i.e. BEFORE the scan existed — so without this a
    // brief written on the very run that mines them still reports "no place
    // types have been mined from this cache yet".
    if (built.archetypes) {
      archetypeRef.current = built.archetypes
      setArchetypeCount(built.archetypes.archetypes.length)
    }
    setIndexProgress('')
    if (!built.index || !Object.keys(built.index.species).length) {
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
    return built.index
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
      const res = generate(p, idx, contextRef.current)
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
      const res = generate(safe, idx, contextRef.current)
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
   * Put everything a planner needs to know about THIS cache on the clipboard.
   *
   * The point of the Plan tab is that a `ProcPlan` written anywhere runs
   * through the same generator with no key and no request. What an outside
   * author lacks is not capability but INFORMATION — which species this dump
   * resolved, what the ground roles are bound to, what the real densities are,
   * which place types were mined from it. Without that they are guessing at
   * ids, which is the exact failure the mine exists to remove.
   *
   * It is the same text the API layer sends as its system prompt, so the two
   * routes cannot drift apart.
   */
  async function buildBrief(): Promise<string> {
    // The brief is worthless without the index — that is where the available
    // species come from — so build it first if this cache has never been
    // scanned. Same one-off cost as any other generate.
    const idx = await ensureIndex()
    const available = idx
      ? (Object.entries(idx.species) as [string, { id: number }[] | undefined][])
          .filter(([, list]) => list && list.length > 0)
          .map(([name]) => name)
      : undefined
    return planningBrief(area, {
      availableSpecies: available,
      palette,
      archetypes: archetypeRef.current,
    })
  }

  const PLAN_INSTRUCTION = 'Reply with a single ProcPlan JSON object and nothing else.'

  async function copyBrief() {
    setError('')
    setBriefCopied('')
    try {
      const brief = await buildBrief()
      await navigator.clipboard.writeText(`${brief}\n\n${PLAN_INSTRUCTION}`)
      setBriefCopied(`Copied ${(brief.length / 1024).toFixed(1)} KB — paste it to any Claude, then paste its plan back here`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  /** the cache's `procgen/` drop box, created on first use */
  async function procgenDir(): Promise<FileSystemDirectoryHandle> {
    if (!rootHandle) throw new Error('no cache folder is open')
    return rootHandle.getDirectoryHandle(PROCGEN_DIR, { create: true })
  }

  /**
   * Write the brief into `procgen/` inside the opened cache, so a planner with
   * filesystem access can read it without anything being pasted.
   *
   * This is the same brief the clipboard button copies and the same text the
   * API layer sends — three routes, one source. The folder is ours, holds no
   * cache data, and is filtered out of the entry sidebar.
   */
  async function writeBriefFile() {
    setError('')
    setBriefCopied('')
    try {
      const brief = await buildBrief()
      const dir = await procgenDir()
      const write = async (name: string, text: string) => {
        const fh = await dir.getFileHandle(name, { create: true })
        const w = await fh.createWritable()
        await w.write(text)
        await w.close()
      }
      await write(BRIEF_FILE, `${brief}\n\n${PLAN_INSTRUCTION}\nWrite it to \`${PLAN_FILE}\` beside this file.\n`)
      // Stamp the moment we asked, so "has a plan arrived?" is a comparison
      // rather than a guess. Without it an old plan.json left over from a
      // previous area would look like a fresh answer.
      briefWrittenAt.current = Date.now()
      setPlanFileState('waiting')
      setBriefCopied(`Wrote ${PROCGEN_DIR}/${BRIEF_FILE} — ask Claude Code to read it and write ${PLAN_FILE} beside it`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPlanFileState('idle')
    } finally {
      setBusy('')
    }
  }

  /**
   * Look for a plan written back into `procgen/`.
   *
   * `quiet` is the polling path: a missing file is the normal state while
   * waiting, so it must not paint an error every two seconds.
   */
  async function readPlanFile(quiet = false) {
    if (!quiet) { setError(''); setBriefCopied('') }
    try {
      const dir = await procgenDir()
      const fh = await dir.getFileHandle(PLAN_FILE)
      const file = await fh.getFile()
      // Only treat it as an answer if it was written AFTER we asked; otherwise
      // a stale plan from an earlier area silently loads as if it were new.
      if (quiet && file.lastModified < briefWrittenAt.current) return
      const text = await file.text()
      setPlanText(text)
      setPlanFileState('idle')
      setBriefCopied(`Loaded ${PROCGEN_DIR}/${PLAN_FILE} (${new Date(file.lastModified).toLocaleTimeString()}) — check it, then Build from plan`)
    } catch (e) {
      if (quiet) return
      setError(e instanceof Error ? `no ${PLAN_FILE} yet (${e.message})` : String(e))
    }
  }

  // Poll for the answer while waiting. The File System Access API has no
  // change notification, so a poll is the only option — but it only runs
  // between writing a brief and a plan arriving, never idly.
  useEffect(() => {
    if (planFileState !== 'waiting') return
    const id = setInterval(() => { void readPlanFile(true) }, 2000)
    return () => clearInterval(id)
    // readPlanFile closes over setState only; re-creating the timer on every
    // render would reset the interval continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planFileState])

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
      const res = generate(safe, idx, contextRef.current)
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
  /**
   * What the scan should have produced but this cache hasn't got.
   *
   * Deliberately a list rather than a check per artifact: the scan gains
   * outputs over time, and each one arriving with its own warning is how a
   * panel ends up with five near-identical messages. Add the artifact here and
   * it reports itself.
   */
  const gaps: string[] = []
  if (index) {
    if (!index.weighted) gaps.push('how often the game really places each object')
    if (!Object.keys(index.canopies ?? {}).length) gaps.push('multi-part trees')
    if (!hasContext) gaps.push('what the map plants on which ground')
    if (!archetypeCount) gaps.push('place types')
  }

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
      {sceneryDir && !indexSpeciesCount(index) && !busy && (
        <div className="map-picker-msg">
          Scenery isn't indexed yet — generating (or rebuilding the index) reads the
          object definitions and the map once, about 74,000 files, and caches the
          result for this cache.
        </div>
      )}
      {/*
        One completeness check, not a message per artifact.
        A cached index short-circuits the rescan, so a cache can sit with some
        of what the scan produces and not the rest — and nothing said so. The
        answer is to name whatever is ACTUALLY missing in one line, so a new
        artifact added to the scan later shows up here for free instead of
        needing its own bespoke warning.
      */}
      {sceneryDir && !!indexSpeciesCount(index) && gaps.length > 0 && (
        <div className="map-picker-msg">
          This cache was indexed before some of what the generator uses existed —
          missing: {gaps.join(', ')}. Rebuild the index to fill it in.
        </div>
      )}
      {/*
        Shown whenever there is an objects folder, INDEXED OR NOT. Gating this
        row on the index having species put the only way to build one behind
        having one already: clearing the cache made the button vanish, so a
        cleared cache could not be rebuilt from here at all.
      */}
      {sceneryDir && !busy && (
        <div className="procgen-row">
          {!!indexSpeciesCount(index) && (
            <span className="map-picker-selcount">
              scenery: {indexSpeciesCount(index)} species indexed
            </span>
          )}
          <button
            type="button"
            className="save-bar-discard"
            title="Read the objects folder and the map, and cache the result for this cache. Worth redoing if something is missing or the cache has been re-dumped."
            onClick={() => {
              void (async () => {
                try {
                  clearCachedIndex()
                  // The stored model and place types came from the scan we are
                  // about to redo, so drop them together rather than leaving a
                  // half-old picture behind if the rebuild is cancelled.
                  await clearContextModel()
                  contextRef.current = null
                  archetypeRef.current = null
                  setHasContext(false)
                  setArchetypeCount(0)
                  setIndex(null)
                  setError('')
                  // Actually rebuild. This used to clear and stop, leaving the
                  // panel saying "scenery isn't indexed yet" until something
                  // else happened to need an index — a button labelled Rebuild
                  // that rebuilt nothing.
                  await ensureIndex(true)
                } catch (e) {
                  // Without this the rejection vanishes into the void() above
                  // and the panel just sits there looking broken.
                  setError(e instanceof Error ? e.message : String(e))
                }
              })()
            }}
          >
            {indexSpeciesCount(index) ? 'Rebuild scenery index' : 'Build scenery index'}
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

        <p className="tex-op-note">
          A plan is the whole contract, so one written anywhere builds the same
          place. Hand the <strong>brief</strong> — what this cache actually
          holds — to any Claude, and build from the plan it writes back. This
          is the same text the AI tab sends, so it needs <strong>no API key</strong>.
        </p>
        <ol className="tex-op-note">
          <li>
            <strong>Write brief to {PROCGEN_DIR}/</strong> puts{' '}
            <code>{BRIEF_FILE}</code> in a <code>{PROCGEN_DIR}</code> folder
            inside your cache. It holds no game data and never repacks, so it
            is kept out of the entry list on the left.
          </li>
          <li>
            Point Claude Code at it: <em>“read {PROCGEN_DIR}/{BRIEF_FILE} and
            write the plan to {PROCGEN_DIR}/{PLAN_FILE}”</em>.
          </li>
          <li>
            The plan loads into the box below on its own as soon as it appears.
            Read it, then <strong>Build from plan</strong>.
          </li>
        </ol>

        <div className="procgen-row">
          <button
            type="button"
            className="save-bar-discard"
            disabled={!!busy || !rootHandle}
            title={rootHandle
              ? `Write the brief to ${PROCGEN_DIR}/${BRIEF_FILE} inside the opened cache, then watch for ${PLAN_FILE} beside it`
              : 'No cache folder is open'}
            onClick={() => void writeBriefFile()}
          >
            Write brief to {PROCGEN_DIR}/
          </button>
          <button
            type="button"
            className="save-bar-discard"
            disabled={!!busy || !rootHandle}
            title={`Load ${PROCGEN_DIR}/${PLAN_FILE} into the box below`}
            onClick={() => void readPlanFile()}
          >
            Read plan now
          </button>
          <button
            type="button"
            className="save-bar-discard"
            disabled={!!busy}
            title="Copy the same brief to the clipboard instead, for pasting into a chat window"
            onClick={() => void copyBrief()}
          >
            Copy to clipboard
          </button>
        </div>
        {planFileState === 'waiting' && (
          <div className="map-picker-msg">
            Watching {PROCGEN_DIR}/{PLAN_FILE} — it will load here as soon as it is written.
          </div>
        )}
        {briefCopied && <div className="map-picker-msg">{briefCopied}</div>}
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
            {result.report.zones.length} zones ·{' '}
            {/* A plot with a building on it is no longer just a reserved pad, so
                report what was actually BUILT rather than what was set aside. */}
            {result.report.buildings.length
              ? `${result.report.buildings.length} buildings`
              : `${result.report.plots.length} building plots`} ·{' '}
            {result.report.docks.length ? `${result.report.docks.length} docks · ` : ''}
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
