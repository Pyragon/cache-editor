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

import type { ProcPlan, RoleId, SpeciesId } from './types'
import { ALL_SPECIES, ROLE_SPECIES } from './scenery'
import { describeMine, type ArchetypeModel } from './archetypes'

const ROLE_SPECIES_NAMES = Object.keys(ROLE_SPECIES)

/**
 * Folder inside the opened cache used to hand a plan to and from an outside
 * planner — Claude Code, an editor, anything that can read and write a file.
 *
 * It is OURS, not the cache's: it holds no game data and nothing repacks it,
 * so `readCacheDir` filters it out of the entry sidebar. Naming it here rather
 * than in the sidebar keeps the two ends from drifting.
 */
export const PROCGEN_DIR = 'procgen'
/** what the app writes: everything a planner needs to know about this cache */
export const BRIEF_FILE = 'brief.md'
/** what the planner writes back: a ProcPlan the Plan tab can build from */
export const PLAN_FILE = 'plan.json'
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
  /**
   * The preferred way to say what a rule plants. Every rule that took a
   * `species` list now takes this instead, and `species` is demoted to an
   * override — the schema has to allow a role-only rule or the "prefer roles"
   * instruction in the prompt is unfollowable.
   */
  const roleEnum = {
    type: 'string',
    enum: ROLE_SPECIES_NAMES,
    description: 'what this rule is FOR. Preferred over `species`: the generator picks the actual object from the map, scored by what the real game plants on ground like the tile being planted',
  }
  const speciesOverride = {
    type: 'array',
    items: speciesPick,
    description: 'explicit override — use ONLY when you really do mean these exact things. Prefer `role`',
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
          waterLevel: { type: 'number', description: 'height below which water is painted. With a landform set this is an ABSOLUTE depth (sea sits at 0, so ~0.06 puts the shoreline just above it); without one it is a percentile of the area own range' },
          landform: { type: 'string', enum: ['inland', 'coast', 'island', 'lakes'], description: 'the SHAPE of the landmass. `coast` puts open sea on one side (~30% water in one body), `island` puts sea all round (~40%). Without this, waterLevel alone only makes scattered ponds - it cannot make a shore or an island' },
          coastAngle: { type: 'number', description: 'degrees; the bearing the LAND lies toward for `coast` — the sea is on the OPPOSITE side. 0 = land east, open sea to the west. 180 = land west, sea east' },
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
          overlayId: { type: 'integer', description: 'paved surface, for a road through a settlement. LEAVE IT OUT for a country track: in the real map an unpaved road is bare underlay with no overlay, and drawing one with a paved overlay looks like tarmac through a wood' },
          underlayId: { type: 'integer', description: 'ground the route is worn into. Town roads sit on town earth (57% of real path tiles do); a country track IS this material' },
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
              role: roleEnum, species: speciesOverride,
              every: { type: 'integer' }, offset: { type: 'integer' },
              emitsLight: { type: 'boolean' }, colorHsl: { type: 'integer' }, size2d: { type: 'integer' },
            },
            required: ['every'],
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
            role: roleEnum,
            species: speciesOverride,
            zoneId: { type: 'string' },
            density: { type: 'number', description: 'placements per 100 eligible tiles; 4 = sparse, 30 = thick forest' },
            clustering: { type: 'number' }, spacing: { type: 'number' },
            avoid: { type: 'array', items: { type: 'string', enum: ['path', 'plot', 'water', 'zone', 'barrier'] } },
            avoidZoneIds: { type: 'array', items: { type: 'string' }, description: 'zone ids this rule must stay out of - use it to keep woodland out of a quarry or a graveyard rather than banning zones entirely' },
            maxSlope: { type: 'number' }, minHeight: { type: 'number' }, maxHeight: { type: 'number' },
            randomRotation: { type: 'boolean' },
          },
          required: ['density'],
        },
      },
      barriers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            aroundZoneId: { type: 'string' },
            role: roleEnum,
            species: speciesOverride,
            thickness: { type: 'integer' }, gaps: { type: 'integer' },
            gapWidth: { type: 'integer' }, offset: { type: 'integer' },
          },
          required: ['aroundZoneId'],
        },
      },
      resources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            zoneId: { type: 'string' },
            role: roleEnum,
            species: speciesOverride,
            count: { type: 'integer' }, depth: { type: 'number' }, rubble: { type: 'boolean' },
          },
          required: ['zoneId', 'count'],
        },
      },
      props: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // A prop is the one place `species` stays the natural choice: it is
            // ONE deliberately placed thing, so "a fountain" means a fountain.
            // `role` is here for "something a village square would have".
            role: roleEnum,
            species: speciesEnum,
            zoneId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
            rotation: { type: 'integer' }, pad: { type: 'integer' },
          },
        },
      },
      docks: {
        type: 'array',
        description:
          'Jetties running out over water. Needs a shoreline, so set terrain.landform '
          + 'to "coast" or "island". The deck objects are MINED from this cache and '
          + 'chosen by the generator — there is deliberately no way to name them here. '
          + 'LEAVE width AND length UNSET unless you have a specific reason: omitted, '
          + 'the generator samples what real piers measure (71% are 1-2 tiles wide, '
          + 'median 11 long), and any number you write here is a guess by comparison.',
        items: {
          type: 'object',
          properties: {
            count: { type: 'integer', description: 'how many jetties (1-3 reads as a working waterfront)' },
            nearZoneId: { type: 'string', description: 'build near this zone, if it reaches the water' },
            width: { type: 'integer', description: 'deck tiles across, 1-4. Prefer omitting.' },
            length: { type: 'integer', description: 'tiles out over the water. Prefer omitting.' },
            headChance: { type: 'number', description: '0..1 chance of a widened T-head at the seaward end' },
            trim: {
              type: 'number',
              description:
                '0..1 clutter on the deck. Prefer omitting: 43% of REAL piers carry '
                + 'nothing at all, and a dock covered in barrels is the generated tell.',
            },
            deckClutter: {
              type: 'object',
              description:
                'Named cargo standing ON the deck — the one place you may name what goes '
                + 'on a jetty. Use it when the pier is WORKING (a fishing village landing '
                + 'its catch, a port loading), not to dress every dock. `trim` cannot do '
                + 'this: it replays ids mined off real piers, which are railings and '
                + 'ladders, and scatter rules cannot reach a deck tile at all.',
              properties: {
                role: { type: 'string', description: 'usually "settlement_prop"' },
                species: {
                  type: 'array',
                  description: 'e.g. crate and barrel, with weights',
                  items: {
                    type: 'object',
                    properties: {
                      species: { type: 'string' },
                      weight: { type: 'number' },
                    },
                    required: ['species'],
                  },
                },
                density: {
                  type: 'number',
                  description:
                    'placements per 100 DECK tiles, not per 100 ground tiles — the '
                    + 'landscape sparsity guidance does not apply here. Default 12, which '
                    + 'is two or three pieces on a jetty. 40+ is a deck you cannot walk down.',
                },
              },
            },
          },
          required: ['count'],
        },
      },
      buildings: {
        type: 'array',
        description:
          'Put buildings on the plots a zone reserves. There is deliberately NO way '
          + 'to describe a layout: the massing is sampled from the footprint vocabulary '
          + 'measured across the real map, the walls come from a mined material family, '
          + 'and the furniture from measured wall-distance distributions. You decide '
          + 'WHERE there are buildings (via the zone and its plot count), not what they '
          + 'look like. A zone with plots and no entry here stays an empty paved pad.',
        items: {
          type: 'object',
          properties: {
            zoneId: { type: 'string', description: 'only build on the plots of this zone; omit for all' },
            fill: { type: 'number', description: '0..1 share of plots that get a building (default 1)' },
            furnish: { type: 'number', description: '0..1 interior clutter (default follows the measurement)' },
          },
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
  /** the place types mined from THIS cache, so a plan can name one */
  archetypes?: ArchetypeModel | null
}

/**
 * Everything a planner needs to know about THIS cache, as text.
 *
 * Exported because the API call is not the only planner. A `ProcPlan` is the
 * whole contract, so a plan written in a chat window — Claude Code, say —
 * runs through exactly the same generator, with no key and no request. What
 * that author lacks is not capability but INFORMATION: which species this dump
 * resolved, what the ground roles are bound to, what the real densities are,
 * and which place types were mined from it. This is that information, and both
 * routes read the same copy so they cannot drift apart.
 */
export function planningBrief(area: ProcPlan['area'], ctx: CacheContext): string {
  return systemPrompt(area, ctx)
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
    '- buildings: a zone with `plots` only RESERVES paved pads. Add a `buildings` entry to actually build on them, or the settlement is a set of empty squares. Building shape, walls and furniture are all mined from this cache — you choose where people live, not what the houses look like.',
    '- docks: if the place is on water and people work it — a fishing village, a port, a ferry — give it `docks`. A shore settlement with no jetty is the single most obvious thing missing from a waterfront, and it needs terrain.landform "coast" or "island" to have a shoreline at all. Set `count` (1-3) and LEAVE width/length/trim UNSET: those are sampled from what real piers in this cache measure, and anything you write instead is a guess. Real piers are narrow — 71% are one or two tiles wide — and 43% carry no clutter whatsoever. If the pier is WORKING and should have cargo standing on it, that is `docks[].deckClutter` (crates, barrels) and nothing else reaches a deck: `trim` replays mined railings and ladders, and a scatter rule cannot touch a deck tile.',
    '- if the mood is dark, dim the ACTUAL environment (sunAmbient ~0.7, a cold grey sunColour, heavier fogDepth) as well as choosing dead trees. Do not just pick gloomy props and leave the sun bright.',
    '- if you make somewhere dark and it has paths, light them: paths.lighting with `role: "light"`, every ~7 tiles, emitsLight true.',
    '- paths: a straight line across the area is the strongest tell that a place was generated. Set paths.wander (0.3 surveyed road, 0.6+ wilderness track) and give it branches, so the route curves with the ground and turns off somewhere.',
    '- paths.coverage decides how much of the area the network actually SERVES, which is a separate question from how much it bends. A settled or travelled area wants 0.6-0.9; somewhere meant to feel remote or trackless wants 0-0.2. Leaving it out means only the branches you asked for.',
    '- do NOT scatter fences, gates, hedges or walls. They only read as deliberate in a LINE around something; sprinkled individually they are orphaned railings standing in a field. Use a barrier ring if you want somewhere enclosed. The same goes for crates, barrels, benches and signposts unless the rule names a zone to keep them inside.',
    '- keep scatter out of a working zone: a mine pit or a quarry full of trees, mushrooms and reeds reads as a bug. Put the zone id in the scatter rule avoidZoneIds.',
    '- reserve plots wherever something could be built later — zones[].plots inside a settlement, paths.waysidePlots out in the wilds — and give them an underlayId so the reserved ground is visible.',
    '',
    'Guidance that matters:',
    '- density is placements per 100 eligible tiles, and the real map is MUCH sparser than intuition suggests. Measured across 15 settlements: the densest place in the game is 2.4 trees per 100 tiles, the median is about 1.1, and open country runs 0.5-1.0. All scenery together, buildings included, comes to under 4 per 100. Use 0.5-1.0 for open ground, 1.5-2.5 for woodland, 2.5-3.5 for a deliberately thick forest. A density of 10 is already a wall of trunks; 25 is a solid carpet.',
    '- the balance BETWEEN roles is still yours, even though the species inside one is not. Measured across the map: dead wood is 21% of all trees, and it is not gloom-only — two thirds of the trees around Barbarian Village and a quarter of a desert edge. So a rough or border place is a `canopy` rule and a `deadwood` rule at comparable densities, not one `canopy` rule with dead trees named in it.',
    '- resources[].count is the size of a whole ore BODY, not a fill for the zone. Real mining sites carry 13-19 rocks (median 17) across 1-8 ore types, median 4 of each type; single-ore sites of 18-34 coal exist too. Use 12-20 for an ordinary mine, 25+ only for somewhere the mine IS the place. You do not need to arrange them: the generator knots each ore type into its own compact pocket, sets the pockets ~3 tiles apart, and leaves about one rock in seven scattered outside — the measured shape of a real mine. Just pick the ore mix and the count.',
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
    '- BUT keep NARROW transition bands pure. Mixing is for broad areas. A shoreline is only one to three tiles wide, so a second material at weight 1 in a beach band puts a contrasting tile in every sixth one — which reads as a HOLE punched in the shore, not as variety, and isolated single tiles also break the terrain corner-blending. Measured: a beach of `sand 5 / dead grass 1` left only 77% of the waterline as sand and looked gappy; `sand 8 / dead grass 1` plus a second pure-sand band nearer the water took it to 95%. Rule of thumb: the narrower the band, the fewer materials it should carry, and the tile row actually touching water should be one material.',
    '',
    // Roles are the preferred way to write a scatter rule: naming a species
    // makes the AUTHOR guess the biome, and the author has not read the map.
    // Naming a role lets the generator answer from measurement instead.
    'PREFER ROLES OVER SPECIES, in scatter rules, barrier rings, resource nodes and path lighting alike.',
    'Instead of `species: [{species: "tree_oak"}]`, write `role: "canopy"` and let the generator pick from',
    `the map. Roles: ${ROLE_SPECIES_NAMES.join(', ')}.`,
    'It scores every species in the role by how often the real game plants it on ground like the tile being',
    'planted, so getting the GROUND right makes the vegetation follow by itself — which is what the real map does.',
    'The corollary is worth acting on: if you want a jungle, do not ask for jungle trees — paint jungle GROUND',
    'and ask for `canopy`. Naming the species yourself means guessing the biome, and you have not read this map.',
    'Name explicit species only when the place is DEFINED by that one thing (a memorial garden of yew, say).',
    '',
    ctx.archetypes
      ? [
          'PLACE TYPES mined from this cache. Prefer naming an area type over hand-picking materials:',
          describeMine(ctx.archetypes),
        ].join('\n')
      : '- no place types have been mined from this cache yet.',
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
/**
 * Scenery that only reads as deliberate when it is PLACED, never when it is
 * scattered. A fence is a LINE around a field; a rate of "0.4 fences per 100
 * tiles" sprinkled as individual posts is just orphaned railings standing in
 * open country. Enclosures belong to the barrier mechanism (or a future field
 * feature), so these are stripped from any scatter rule.
 */
const NEVER_SCATTERED: SpeciesId[] = ['fence', 'fence_gate', 'hedge', 'wall_stone']

/**
 * Clutter that belongs INSIDE somewhere — a crate in a mining pit is fine, a
 * crate alone in a meadow is not. Allowed only when the rule names a zone.
 */
const NEEDS_A_ZONE: SpeciesId[] = ['crate', 'barrel', 'bench', 'campfire', 'signpost']

/**
 * The same two rules at ROLE level. A role names a whole family, so it has to
 * be judged as one — `enclosure` is exactly the fences and walls that must be
 * placed deliberately, and `settlement_prop` is the crates-and-benches family
 * that only makes sense somewhere.
 */
const NEVER_SCATTERED_ROLES: RoleId[] = ['enclosure']
const NEEDS_A_ZONE_ROLES: RoleId[] = ['settlement_prop']

export function sanitizePlan(plan: ProcPlan): { plan: ProcPlan; notes: string[] } {
  const notes: string[] = []
  const next: ProcPlan = { ...plan }

  next.terrain = {
    ...plan.terrain,
    amplitude: Math.max(0, Math.min(240, plan.terrain.amplitude ?? 60)),
    featureScale: Math.max(8, Math.min(600, plan.terrain.featureScale ?? 60)),
  }

  if (next.scatter) {
    // strip structural scenery before anything else looks at the rules
    next.scatter = next.scatter.flatMap((rule) => {
      // Now that `species` is optional in the schema, a rule can name NEITHER.
      // The generator treats that as "plant nothing", which is indistinguishable
      // from the rule having worked — so say so rather than dropping it quietly.
      if (!rule.role && !rule.species?.length) {
        notes.push('dropped a scatter rule that named neither a role nor any species — it would have planted nothing')
        return []
      }
      const bannedRoles = rule.zoneId
        ? NEVER_SCATTERED_ROLES
        : [...NEVER_SCATTERED_ROLES, ...NEEDS_A_ZONE_ROLES]
      if (rule.role && bannedRoles.includes(rule.role)) {
        notes.push(`dropped a '${rule.role}' scatter rule — that family has to be placed deliberately, not sprinkled`)
        return []
      }
      const banned = rule.zoneId ? NEVER_SCATTERED : [...NEVER_SCATTERED, ...NEEDS_A_ZONE]
      // A role-only rule has no species list to filter; the role check above is
      // the whole test for it.
      if (!rule.species?.length) return [rule]
      const kept = rule.species.filter((s) => !banned.includes(s.species))
      if (kept.length === rule.species.length) return [rule]
      const dropped = rule.species.filter((s) => banned.includes(s.species)).map((s) => s.species)
      notes.push(`dropped ${dropped.join(', ')} from a scatter rule — that scenery has to be placed deliberately, not sprinkled`)
      // Dropping every named species leaves the rule meaningless UNLESS it also
      // names a role, which can still supply candidates on its own.
      return kept.length ? [{ ...rule, species: kept }] : rule.role ? [{ ...rule, species: undefined }] : []
    })
    next.scatter = next.scatter.map((rule) => {
      // The real map's densest place is 2.4 trees per 100 tiles, so anything
      // past 12 is already unlike anything in the game rather than merely
      // thick. Kept well above the plausible range so a deliberate choice
      // still gets through — this catches the order-of-magnitude mistake.
      if (rule.density > 12) {
        notes.push(`scatter density ${rule.density} capped to 12 — the densest place in the real map is 2.4 per 100 tiles`)
        return { ...rule, density: 12 }
      }
      return rule
    })
  }

  if (next.barriers) {
    next.barriers = next.barriers.flatMap((ring) => {
      // Same "names nothing" case as scatter. A barrier that plants nothing is
      // worse than a missing one: the path network still aims at its gaps.
      if (!ring.role && !ring.species?.length) {
        notes.push(`barrier around "${ring.aroundZoneId}" named neither a role nor any species and was dropped`)
        return []
      }
      return [ring]
    }).map((ring) => {
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
    if (!r.role && !r.species?.length) notes.push(`resource node in "${r.zoneId}" named neither a role nor any species — it will place nothing`)
  }
  const lighting = next.paths?.lighting
  if (lighting && !lighting.role && !lighting.species?.length) {
    notes.push('path lighting named neither a role nor any species — no lamps will be placed')
  }

  if (next.docks?.length) {
    // A jetty needs a sea to run into. `inland` has no shoreline at all, so the
    // dock planner would search every tile and quietly find nothing — the same
    // silent-nothing failure the scatter rules above are guarded against.
    const form = next.terrain.landform
    if (form && form !== 'coast' && form !== 'island' && form !== 'lakes') {
      notes.push(`docks were asked for on a '${form}' landform, which has no shoreline — `
        + 'set terrain.landform to "coast" or "island", or they will not be built')
    }
    next.docks = next.docks.flatMap((d) => {
      const count = Math.round(d.count ?? 0)
      if (!count || count < 0) {
        notes.push('dropped a dock spec with no count')
        return []
      }
      return [{
        ...d,
        count: Math.min(8, count),
        ...(d.width !== undefined ? { width: Math.max(1, Math.min(4, Math.round(d.width))) } : {}),
        ...(d.length !== undefined ? { length: Math.max(3, Math.min(40, Math.round(d.length))) } : {}),
        ...(d.trim !== undefined ? { trim: Math.max(0, Math.min(1, d.trim)) } : {}),
        ...(d.headChance !== undefined ? { headChance: Math.max(0, Math.min(1, d.headChance)) } : {}),
        // A clutter entry naming nothing places nothing, which is a silent
        // no-op — the same failure the scatter guards above exist to catch.
        // Clamped hard at 60 per 100 deck tiles: past that a jetty is a
        // warehouse and you cannot walk down it.
        ...(d.deckClutter
          ? (d.deckClutter.role || d.deckClutter.species?.length
              ? {
                  deckClutter: {
                    ...d.deckClutter,
                    ...(d.deckClutter.density !== undefined
                      ? { density: Math.max(0, Math.min(60, d.deckClutter.density)) }
                      : {}),
                  },
                }
              : (notes.push('dropped dock deckClutter that named neither a role nor any species'), {}))
          : {}),
      }]
    })
    for (const d of next.docks) {
      if (d.nearZoneId && !zoneIds.has(d.nearZoneId)) {
        notes.push(`dock references unknown zone "${d.nearZoneId}" — it will be placed anywhere on the shore`)
      }
    }
  }

  if (!next.ground?.length) {
    notes.push('plan had no ground bands — filled in plain grass so the area is not black')
    next.ground = [{ underlay: [{ underlayId: 164 }] }]
  }
  return { plan: next, notes }
}
