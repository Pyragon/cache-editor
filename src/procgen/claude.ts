/**
 * The optional Claude layer: a sentence → a `ProcPlan`.
 *
 * Claude does NOT generate tiles, and it does not merely "turn the dials"
 * either. It authors the PLAN: which zones exist and where, what grows in
 * them, where a barrier ring goes and how many ways through it has, whether
 * the sun should be dimmed. The deterministic generator then builds it. See
 * `types.ts` for why that middle layer is the right level.
 *
 * Everything here is client-side. The user's key goes to api.anthropic.com and
 * nowhere else — never to a server of ours, never logged, never put in a plan.
 */

import type { ProcPlan } from './types'
import { ALL_SPECIES } from './scenery'
import { THEMES } from './planner'
import { ROLE_INFO, type GroundPalette, type PaletteRole } from './palette'

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'

const KEY_STORAGE = 'cache-editor:anthropic-key'

/**
 * The key lives in memory by default. Persisting is opt-in and says so in the
 * UI — it is the user's own credential and this is their machine, but a key in
 * localStorage is readable by anything else running on this origin.
 */
let memoryKey: string | null = null

export function setApiKey(key: string, persist: boolean) {
  memoryKey = key || null
  try {
    if (persist && key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch { /* storage blocked — memory still works for this session */ }
}

export function getApiKey(): string | null {
  if (memoryKey) return memoryKey
  try {
    return localStorage.getItem(KEY_STORAGE)
  } catch {
    return null
  }
}

export function isKeyPersisted(): boolean {
  try {
    return !!localStorage.getItem(KEY_STORAGE)
  } catch {
    return false
  }
}

export function clearApiKey() {
  memoryKey = null
  try { localStorage.removeItem(KEY_STORAGE) } catch { /* ignore */ }
}

/**
 * The plan schema, as a tool input schema. Using a tool rather than free text
 * is what makes the reply guaranteed-parseable — the model cannot answer with
 * prose, and every field is checked before we ever try to build from it.
 */
function planSchema(): Record<string, unknown> {
  const speciesEnum = { type: 'string', enum: ALL_SPECIES }
  const speciesPick = {
    type: 'object',
    properties: { species: speciesEnum, weight: { type: 'number' } },
    required: ['species'],
  }
  const weightedUnderlay = {
    type: 'object',
    properties: { underlayId: { type: 'integer' }, weight: { type: 'number' } },
    required: ['underlayId'],
  }
  return {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'one line describing the place you designed' },
      terrain: {
        type: 'object',
        properties: {
          baseHeight: { type: 'number' },
          amplitude: { type: 'number', description: 'peak-to-trough in stored height units; 20 = gentle, 200 = alpine' },
          featureScale: { type: 'number', description: 'tiles per feature; 30 = tight hills, 150 = broad' },
          warp: { type: 'number' },
          roughness: { type: 'number' },
          ridged: { type: 'boolean', description: 'true reads as mountain chains' },
          waterLevel: { type: 'number', description: '0..1 normalized height below which water is painted' },
        },
        required: ['amplitude', 'featureScale'],
      },
      ground: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            underlay: { type: 'array', items: weightedUnderlay },
            minHeight: { type: 'number' }, maxHeight: { type: 'number' },
            minSlope: { type: 'number' }, maxSlope: { type: 'number' },
            zoneId: { type: 'string' }, overlayId: { type: 'integer' },
          },
          required: ['underlay'],
        },
      },
      zones: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['town', 'village', 'plaza', 'farm', 'forest', 'grove', 'wilds', 'quarry', 'mine', 'graveyard', 'camp', 'ruins', 'water', 'swamp', 'wasteland'] },
            shape: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['circle', 'rect'] },
                cx: { type: 'number' }, cy: { type: 'number' }, radius: { type: 'number' },
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              },
              required: ['type'],
            },
            flatten: { type: 'number', description: '0..1; towns want ~0.85' },
            ground: { type: 'array', items: weightedUnderlay },
            plots: {
              type: 'object',
              properties: {
                count: { type: 'integer' }, minSize: { type: 'integer' },
                maxSize: { type: 'integer' }, purpose: { type: 'string' },
                underlayId: { type: 'integer', description: 'paves the pad so the reserved plot is visible' },
              },
              required: ['count'],
            },
          },
          required: ['id', 'kind', 'shape'],
        },
      },
      paths: {
        type: 'object',
        properties: {
          overlayId: { type: 'integer' },
          width: { type: 'integer', description: 'tiles across in open country; 1-2 is a track, 3+ a road' },
          settlementWidth: { type: 'integer', description: 'tiles across inside a zone. Keep it wider than `width` — a road broadens where the buildings are' },
          connectZones: { type: 'boolean' },
          toAreaEdge: { type: 'boolean' },
          wander: { type: 'number', description: '0..1 meander. 0.3 for a surveyed road, 0.6+ for a track in the wilds' },
          branches: { type: 'integer', description: 'minimum spurs off the trunk route; they rejoin the network or end at a wayside pad' },
          loops: { type: 'number', description: '0..1 how often a spur rejoins the network instead of dead-ending. Settlements want 0.6+; a remote track can dead-end freely' },
          coverage: { type: 'number', description: '0..1 how much of the area ends up within reach of a path. Spurs aim at whatever is furthest from the network. 0 = trackless wilderness with one road through; 0.8 = a well-served area' },
          waysidePlots: { type: 'integer', description: 'flat pads at spur ends for a shop/shrine/hut' },
          waysidePlotUnderlayId: { type: 'integer' },
          lighting: {
            type: 'object',
            properties: {
              species: { type: 'array', items: speciesPick },
              every: { type: 'integer' }, offset: { type: 'integer' },
              emitsLight: { type: 'boolean' }, colorHsl: { type: 'integer' }, size2d: { type: 'integer' },
            },
            required: ['species', 'every'],
          },
        },
        required: ['overlayId'],
      },
      scatter: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            species: { type: 'array', items: speciesPick },
            zoneId: { type: 'string' },
            density: { type: 'number', description: 'placements per 100 eligible tiles; 4 = sparse, 30 = thick forest' },
            clustering: { type: 'number' }, spacing: { type: 'number' },
            avoid: { type: 'array', items: { type: 'string', enum: ['path', 'plot', 'water', 'zone', 'barrier'] } },
            maxSlope: { type: 'number' }, minHeight: { type: 'number' }, maxHeight: { type: 'number' },
            randomRotation: { type: 'boolean' },
          },
          required: ['species', 'density'],
        },
      },
      barriers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            aroundZoneId: { type: 'string' },
            species: { type: 'array', items: speciesPick },
            thickness: { type: 'integer' }, gaps: { type: 'integer' },
            gapWidth: { type: 'integer' }, offset: { type: 'integer' },
          },
          required: ['aroundZoneId', 'species'],
        },
      },
      resources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            zoneId: { type: 'string' },
            species: { type: 'array', items: speciesPick },
            count: { type: 'integer' }, depth: { type: 'number' }, rubble: { type: 'boolean' },
          },
          required: ['zoneId', 'species', 'count'],
        },
      },
      props: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            species: speciesEnum,
            zoneId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
            rotation: { type: 'integer' }, pad: { type: 'integer' },
          },
          required: ['species'],
        },
      },
      environment: {
        type: 'object',
        properties: {
          sunColour: { type: 'integer' }, sunAmbient: { type: 'number' },
          sunLight: { type: 'number' }, sunBacklight: { type: 'number' },
          fogColour: { type: 'integer' }, fogDepth: { type: 'integer' }, skyboxId: { type: 'integer' },
        },
      },
    },
    required: ['terrain', 'ground'],
  }
}

export type CacheContext = {
  /** underlay ids that exist, with a colour hint where we know it */
  underlays?: { id: number; hex?: string }[]
  overlays?: { id: number; hex?: string }[]
  /** species this cache actually resolved, so the model only picks real ones */
  availableSpecies?: string[]
  /** role → definition id, as bound for THIS cache by the ground-material
   *  picker. Without it the model is inventing ids. */
  palette?: GroundPalette
}

function systemPrompt(area: ProcPlan['area'], ctx: CacheContext): string {
  const w = (area.x1 - area.x0 + 1) * 64
  const h = (area.y1 - area.y0 + 1) * 64
  return [
    'You design areas for a RuneScape-style tile world. You are given a description and you reply by calling `emit_plan` exactly once.',
    '',
    `The area is ${w}x${h} TILES (${area.x1 - area.x0 + 1}x${area.y1 - area.y0 + 1} regions). All coordinates you give are area-relative tiles: (0,0) is the south-west corner, x grows east, y grows north.`,
    '',
    'You are NOT setting sliders. You are authoring the structure of a place:',
    '- zones are the areas that mean something (a town, a wood, a pit). Give them ids and refer to those ids from scatter/barriers/resources/props.',
    '- scatter rules say what grows where and how thickly. Use several rules per area: canopy trees, then undergrowth, then occasional dead wood/rocks.',
    '- a barrier ring is how you make somewhere enclosed ("a village you cannot walk out of"). ALWAYS leave gaps (2 is usual) or the place is unreachable.',
    '- if the mood is dark, dim the ACTUAL environment (sunAmbient ~0.7, a cold grey sunColour, heavier fogDepth) as well as choosing dead trees. Do not just pick gloomy props and leave the sun bright.',
    '- if you make somewhere dark and it has paths, light them: paths.lighting with lanterns or torches every ~7 tiles, emitsLight true.',
    '- paths: a straight line across the area is the strongest tell that a place was generated. Set paths.wander (0.3 surveyed road, 0.6+ wilderness track) and give it branches, so the route curves with the ground and turns off somewhere.',
    '- paths.coverage decides how much of the area the network actually SERVES, which is a separate question from how much it bends. A settled or travelled area wants 0.6-0.9; somewhere meant to feel remote or trackless wants 0-0.2. Leaving it out means only the branches you asked for.',
    '- reserve plots wherever something could be built later — zones[].plots inside a settlement, paths.waysidePlots out in the wilds — and give them an underlayId so the reserved ground is visible.',
    '',
    'Guidance that matters:',
    '- density is placements per 100 eligible tiles. 3-6 is open grass, 12-20 is woodland, 25-40 is dense forest. Above 45 is a wall of trunks.',
    '- flatten a town (~0.85) or buildings will sit on a slope. Give it plots so buildings can be stamped later.',
    '- give ground bands overlapping conditions; later bands win, so paint the general case first and the exceptions after.',
    `- available species in THIS cache: ${(ctx.availableSpecies ?? ALL_SPECIES).join(', ')}. Do not use any other.`,
    // Ids are meaningless to you and to the model; the ROLE is the shared
    // vocabulary, and the binding is this cache's answer to it. Naming the
    // role next to the number is what lets the model band ground sensibly
    // ("mud in the hollows") instead of shuffling integers.
    ctx.palette
      ? [
          '- ground material ids for THIS cache, by role. Use these numbers and no others:',
          ...(Object.keys(ROLE_INFO) as PaletteRole[])
            .map((r) => `    ${r} (${ROLE_INFO[r].blurb}) = ${ctx.palette![r]}`),
          '  underlay roles go in `ground[].underlay[].underlayId` and `zones[].ground[].underlayId`;',
          '  path/water/rock are OVERLAYS and go in `overlayId` / `paths.overlayId`.',
        ].join('\n')
      : '- no ground materials are bound for this cache; keep `ground` to a single band and let the user fix it.',
    '- vary the ground. A single material across the whole area reads as a painted plane however good the heightmap is: put wet ground in the hollows (low maxHeight), worn ground on the ridges and slopes, and stone only where it is genuinely steep.',
    '',
    `Reference themes the built-in planner ships, for calibration: ${THEMES.map((t) => `${t.id} (${t.blurb})`).join('; ')}.`,
  ].join('\n')
}

export type PlanRequest = {
  prompt: string
  area: ProcPlan['area']
  seed: number
  context?: CacheContext
  /** prior turns, so "make it snowier" refines rather than restarts */
  history?: { role: 'user' | 'assistant'; content: string }[]
  signal?: AbortSignal
}

export type PlanResponse = {
  plan: ProcPlan
  /** what it said alongside the plan, for the UI */
  note?: string
  usage?: { input: number; output: number }
}

/**
 * Ask Claude for a plan. Throws with a readable message on auth/network/refusal
 * so the panel can show it — the key is never included in any thrown text.
 */
export async function requestPlan(req: PlanRequest): Promise<PlanResponse> {
  const key = getApiKey()
  if (!key) throw new Error('No API key set — add one in Settings → AI generation.')

  const body = {
    model: MODEL,
    max_tokens: 8000,
    system: [
      { type: 'text', text: systemPrompt(req.area, req.context ?? {}), cache_control: { type: 'ephemeral' } },
    ],
    tools: [{
      name: 'emit_plan',
      description: 'Emit the generation plan for the described area.',
      input_schema: planSchema(),
    }],
    tool_choice: { type: 'tool', name: 'emit_plan' },
    messages: [
      ...(req.history ?? []),
      { role: 'user', content: req.prompt },
    ],
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // required for calling the API straight from a page
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  if (!res.ok) {
    let detail = ''
    try {
      const err = await res.json() as { error?: { message?: string } }
      detail = err.error?.message ?? ''
    } catch { /* non-json error body */ }
    if (res.status === 401) throw new Error('That API key was rejected (401).')
    if (res.status === 429) throw new Error('Rate limited by the API (429) — wait a moment and retry.')
    throw new Error(`API error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const json = await res.json() as {
    content: { type: string; text?: string; name?: string; input?: unknown }[]
    usage?: { input_tokens: number; output_tokens: number }
  }
  const toolUse = json.content.find((c) => c.type === 'tool_use' && c.name === 'emit_plan')
  if (!toolUse?.input) {
    const said = json.content.find((c) => c.type === 'text')?.text
    throw new Error(said ? `No plan returned. Claude said: ${said.slice(0, 300)}` : 'No plan returned.')
  }

  const partial = toolUse.input as Omit<ProcPlan, 'version' | 'seed' | 'area'>
  return {
    plan: { ...partial, version: 1, seed: req.seed, area: req.area },
    note: json.content.find((c) => c.type === 'text')?.text,
    usage: json.usage && { input: json.usage.input_tokens, output: json.usage.output_tokens },
  }
}

/**
 * Guard rails applied to ANY plan before it is built, whether it came from
 * Claude or from a hand-edited json. The generator is robust to nonsense, but
 * these catch the cases that would waste a user's time — an unreachable
 * enclosure, or a density that carpets the area in trunks.
 */
export function sanitizePlan(plan: ProcPlan): { plan: ProcPlan; notes: string[] } {
  const notes: string[] = []
  const next: ProcPlan = { ...plan }

  next.terrain = {
    ...plan.terrain,
    amplitude: Math.max(0, Math.min(240, plan.terrain.amplitude ?? 60)),
    featureScale: Math.max(8, Math.min(600, plan.terrain.featureScale ?? 60)),
  }

  if (next.scatter) {
    next.scatter = next.scatter.map((rule) => {
      if (rule.density > 60) {
        notes.push(`scatter density ${rule.density} capped to 60 — above that it is a solid wall of scenery`)
        return { ...rule, density: 60 }
      }
      return rule
    })
  }

  if (next.barriers) {
    next.barriers = next.barriers.map((ring) => {
      if ((ring.gaps ?? 0) < 1) {
        notes.push(`barrier around "${ring.aroundZoneId}" had no gaps — added one so the area is reachable`)
        return { ...ring, gaps: 1, gapWidth: ring.gapWidth ?? 6 }
      }
      return ring
    })
  }

  // a zone referenced by nothing that exists is a silent no-op otherwise
  const zoneIds = new Set((next.zones ?? []).map((z) => z.id))
  for (const ring of next.barriers ?? []) {
    if (!zoneIds.has(ring.aroundZoneId)) notes.push(`barrier references unknown zone "${ring.aroundZoneId}" and was skipped`)
  }
  for (const r of next.resources ?? []) {
    if (!zoneIds.has(r.zoneId)) notes.push(`resource node references unknown zone "${r.zoneId}" and was skipped`)
  }

  if (!next.ground?.length) {
    notes.push('plan had no ground bands — filled in plain grass so the area is not black')
    next.ground = [{ underlay: [{ underlayId: 164 }] }]
  }
  return { plan: next, notes }
}
