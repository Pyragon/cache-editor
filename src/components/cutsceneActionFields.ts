import { CUTSCENE_ACTION_TYPES } from '../loaders/cutscenes'

// The fields each action type carries, in the order cryogen dumps them.
//
// This is the editor's schema: it decides which inputs an action shows, and
// what a newly created one starts with. Names and meanings come from
// darkan-bot-refactor's config/cutscene/action/ classes — the same source the
// dumper's field names follow, so a hand-authored action packs identically to a
// shipped one.

export type FieldKind = 'int' | 'string'

export type ActionField = {
  name: string
  label: string
  kind?: FieldKind
  /** Shown under the input where the meaning isn't obvious from the name. */
  hint?: string
  /** Index into `def.entities` / `def.objects` / `def.movements` / camera
   *  paths — the editor offers a picker instead of a bare number. */
  ref?: 'entity' | 'object' | 'movement' | 'camera' | 'anim' | 'gfx'
}

const entity = (name: string, label = 'Entity'): ActionField => ({ name, label, ref: 'entity' })
const tile = (x = 'x', y = 'y'): ActionField[] => [
  { name: x, label: 'Tile X' },
  { name: y, label: 'Tile Y' },
]

export const ACTION_FIELDS: Record<string, ActionField[]> = {
  MOVEMENT: [
    entity('targetIndex'),
    ...tile(),
    { name: 'plane', label: 'Plane' },
    { name: 'direction', label: 'Facing', hint: 'south 0, west 4096, north 8192, east 12288' },
  ],
  BASIC_MOVEMENT: [
    entity('entityIndex'),
    { name: 'movementIndex', label: 'Route', ref: 'movement' },
    { name: 'plane', label: 'Plane' },
  ],
  ANIMATE_MOVEMENT: [
    entity('entityIndex'),
    { name: 'movementAnimationId', label: 'Animation', ref: 'anim' },
    { name: 'seqFlag', label: 'Gfx', ref: 'gfx', hint: 'spot anim played with it, 0 for none' },
  ],
  ROTATE_CUTSCENE_ENTITY: [
    entity('cutsceneEntityPtr'),
    { name: 'rotation', label: 'Facing', hint: 'south 0, west 4096, north 8192, east 12288' },
  ],
  RESET_CUTSCENE_ENTITY: [entity('entityIndex')],
  REPLACE_OBJECT: [
    { name: 'locIndex', label: 'Object', ref: 'object' },
    ...tile(),
    { name: 'plane', label: 'Plane' },
    { name: 'rotation', label: 'Rotation', hint: '0-3, quarter turns' },
  ],
  DESTROY_OBJECT: [{ name: 'cutsceneObjectPtr', label: 'Object', ref: 'object' }],
  ANIMATE_OBJECT: [
    { name: 'objectIndex', label: 'Object', ref: 'object' },
    { name: 'sequenceId', label: 'Animation', ref: 'anim' },
  ],
  ENTITY_GFX: [
    entity('targetIndex'),
    { name: 'gfxId', label: 'Gfx', ref: 'gfx' },
    { name: 'spotAnimationIndex', label: 'Slot', hint: '0-3, the entity’s spot-anim slots' },
    { name: 'displayHeight', label: 'Height' },
    { name: 'rotation', label: 'Rotation' },
    { name: 'adjustmentType', label: 'Adjust' },
  ],
  POSITIONED_GFX: [
    { name: 'gfxId', label: 'Gfx', ref: 'gfx' },
    ...tile(),
    { name: 'plane', label: 'Plane' },
    { name: 'displayHeight', label: 'Height' },
    { name: 'rotation', label: 'Rotation' },
  ],
  DIRECT_CAMERA_MOVEMENT: [
    { name: 'positionMovementIndex', label: 'Position path', ref: 'camera' },
    { name: 'lookAtMovementIndex', label: 'Look-at path', ref: 'camera' },
    { name: 'positionKeyframe', label: 'From keyframe' },
    { name: 'lookAtKeyframe', label: 'Look keyframe' },
    { name: 'splineSpeedStart', label: 'Speed start', hint: '16.16 progress per cycle' },
    { name: 'splineSpeedEnd', label: 'Speed end' },
  ],
  UNCENTERED_CAMERA_MOVEMENT: [
    { name: 'localX', label: 'Local X' },
    { name: 'localY', label: 'Local Y' },
    { name: 'moveZ', label: 'Height' },
    { name: 'angleX', label: 'Angle X' },
    { name: 'angleY', label: 'Angle Y' },
  ],
  FADE_SCREEN: [
    { name: 'fadeDurationCycles', label: 'Over (cycles)' },
    { name: 'fadeScreenColor', label: 'ARGB', hint: 'alpha in the top byte; 0 fades back to clear' },
  ],
  PLAY_SONG: [{ name: 'musicId', label: 'Music' }, { name: 'volume', label: 'Volume' }],
  PLAY_JINGLE: [{ name: 'jingleId', label: 'Jingle' }, { name: 'volume', label: 'Volume' }],
  PLAY_SYNTH: [
    { name: 'soundId', label: 'Sound' },
    { name: 'volume', label: 'Volume' },
    { name: 'sampleRate', label: 'Rate' },
    { name: 'timesRepeated', label: 'Repeats' },
  ],
  PLAY_VORBIS: [
    { name: 'soundId', label: 'Sample' },
    { name: 'volume', label: 'Volume' },
    { name: 'sampleRate', label: 'Rate' },
    { name: 'timesRepeated', label: 'Repeats' },
  ],
  SET_VARIABLE: [{ name: 'key', label: 'Varp' }, { name: 'value', label: 'Value' }],
  SET_BIT_VARIABLE: [{ name: 'key', label: 'Varbit' }, { name: 'value', label: 'Value' }],
  EXECUTE_SCRIPT: [
    { name: 'scriptStringParam', label: 'Text', kind: 'string' },
    { name: 'scriptIntParam', label: 'Number' },
  ],
  SET_HINT_DETAILS: [
    entity('entityIndex'),
    { name: 'text', label: 'Text', kind: 'string' },
    { name: 'colorType', label: 'Colour' },
    { name: 'duration', label: 'Cycles' },
  ],
  TILE_MESSAGE: [
    { name: 'absX', label: 'Abs X' },
    { name: 'absY', label: 'Abs Y' },
    { name: 'minimenuText', label: 'Text', kind: 'string' },
    { name: 'cycleDuration', label: 'Cycles' },
  ],
  APPLY_HITMARK: [
    entity('entityIndex'),
    { name: 'hitsplatId', label: 'Hitsplat' },
    { name: 'hitText', label: 'Text', kind: 'string' },
    { name: 'soakHitsplatId', label: 'Soak splat' },
    { name: 'soakText', label: 'Soak text', kind: 'string' },
    { name: 'currentHealth', label: 'Health' },
    { name: 'maxHealth', label: 'Max health' },
  ],
  PROJECTILE_HOMING: [
    { name: 'gfxId', label: 'Gfx', ref: 'gfx' },
    entity('sourceEntityIndex', 'From entity'),
    entity('targetEntityIndex', 'To entity'),
    { name: 'duration', label: 'Cycles' },
    { name: 'startHeight', label: 'Start height' },
    { name: 'endHeight', label: 'End height' },
    { name: 'angle', label: 'Angle' },
    { name: 'slope', label: 'Slope' },
  ],
  FINISHED: [],
}

/** Types offered in the editor's "add action" menu, in a sensible authoring
 *  order rather than the packing order. Everything the preview simulates comes
 *  first; the rest still writes correctly, it just won't show in the preview. */
export const ADDABLE_ACTIONS: string[] = [
  'MOVEMENT',
  'BASIC_MOVEMENT',
  'ANIMATE_MOVEMENT',
  'ROTATE_CUTSCENE_ENTITY',
  'RESET_CUTSCENE_ENTITY',
  'REPLACE_OBJECT',
  'ANIMATE_OBJECT',
  'DESTROY_OBJECT',
  'ENTITY_GFX',
  'DIRECT_CAMERA_MOVEMENT',
  'FADE_SCREEN',
  'PLAY_SONG',
  'PLAY_VORBIS',
  'PLAY_SYNTH',
  'PLAY_JINGLE',
  'FINISHED',
  'POSITIONED_GFX',
  'UNCENTERED_CAMERA_MOVEMENT',
  'SET_VARIABLE',
  'SET_BIT_VARIABLE',
  'SET_HINT_DETAILS',
  'TILE_MESSAGE',
  'APPLY_HITMARK',
  'PROJECTILE_HOMING',
  'EXECUTE_SCRIPT',
]

/** Which action types the 3D preview actually simulates — the rest save fine
 *  but won't show, and the editor says so rather than letting you wonder. */
export const SIMULATED_ACTIONS = new Set([
  'MOVEMENT', 'BASIC_MOVEMENT', 'ANIMATE_MOVEMENT', 'ROTATE_CUTSCENE_ENTITY',
  'RESET_CUTSCENE_ENTITY', 'REPLACE_OBJECT', 'ANIMATE_OBJECT', 'DESTROY_OBJECT',
  'ENTITY_GFX', 'DIRECT_CAMERA_MOVEMENT', 'FADE_SCREEN', 'FINISHED',
  'PLAY_SONG', 'PLAY_VORBIS', 'PLAY_SYNTH',
])

export const KNOWN_ACTION_TYPES = CUTSCENE_ACTION_TYPES.map((a) => a.type)

/** A new action's starting fields: every field the type carries, zeroed, so the
 *  packed form always has the shape the decoder expects. */
export function defaultFields(type: string): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const field of ACTION_FIELDS[type] ?? []) out[field.name] = field.kind === 'string' ? '' : 0
  return out
}
