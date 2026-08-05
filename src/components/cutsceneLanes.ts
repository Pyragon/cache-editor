// Which lane of the piano roll an action belongs to. Kept out of the component
// files so both the roll and the modals can import it without breaking fast
// refresh (a component module that also exports helpers loses it).
//
// The grouping matches the badge colours the player's action list already uses,
// so a camera action is the same colour wherever it appears.

export const CUTSCENE_LANES: { key: string; label: string }[] = [
  { key: 'camera', label: 'Camera' },
  { key: 'entity', label: 'Entities' },
  { key: 'object', label: 'Objects' },
  { key: 'gfx', label: 'Gfx' },
  { key: 'sound', label: 'Sound' },
  { key: 'misc', label: 'Other' },
  { key: 'end', label: 'End' },
]

export function actionLane(type: string): string {
  if (type.includes('CAMERA')) return 'camera'
  if (type.includes('MOVEMENT') || type === 'ROTATE_CUTSCENE_ENTITY' || type === 'RESET_CUTSCENE_ENTITY') return 'entity'
  if (type.includes('OBJECT')) return 'object'
  if (type.startsWith('PLAY_')) return 'sound'
  if (type.includes('GFX') || type.startsWith('PROJECTILE')) return 'gfx'
  if (type === 'FINISHED') return 'end'
  return 'misc'
}
