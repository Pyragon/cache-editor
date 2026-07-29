// The in-game equipment screen, as data.
//
// Layout read straight off **interface 387** in the dump (2026-07-29). Every
// slot container there sits at `basePositionX/Y` with `aspectXType: 1`, which
// makes X an offset from the panel's horizontal centre — that is why the
// dumped x values are negative on the left. The panel itself (components 2 and
// 65) is 190x261.
//
// Slot identities are NOT in the interface: each container is an anonymous
// 36x36 box whose item holder is filled by CS2 at runtime, so the client binds
// them by script, not by a field we can read. The geometry is unambiguous
// though — it is the classic arrangement — and the indices below are darkan
// `Equipment`'s own constants.
export const EQUIPMENT_PANEL = { width: 190, height: 261 }

/** Sprite ids from interface 387: the empty slot and its hover state
 *  (component 5 swaps 170 -> 9167 in `onMouseOver`). */
export const EQUIPMENT_SPRITES = { slot: 170, slotHover: 9167 }

export type EquipmentSlotDef = {
  /** Index into the 15-wide appearance/equipment array (darkan `Equipment`). */
  index: number
  label: string
  /** Offset from the panel's horizontal centre, per aspectXType 1. */
  x: number
  y: number
  size: number
}

// Indices: HEAD 0, CAPE 1, NECK 2, WEAPON 3, CHEST 4, SHIELD 5, LEGS 7,
// HANDS 9, FEET 10, RING 12, AMMO 13, AURA 14 (Equipment.java:31-43).
// 6, 8 and 11 are the arms/hair/beard positions — identikit-only, never
// equipment, which is why the screen has no box for them.
//
// **Ring (12), ammo (13) and aura (14) are deliberately omitted** (Cody,
// 2026-07-29): this panel dresses a player we are going to RENDER, and none
// of the three puts geometry on the body. The client says as much for two of
// them — `Equipment.DISABLED_SLOTS` flags exactly indices 12 and 13, and
// `getMeshModifiers` skips any flagged slot before it looks at the item — and
// an aura is a graphical effect around the player rather than a worn mesh.
// Their dumped positions, if they are ever wanted back: aura (-41, 4),
// ammo (41, 43), ring (56, 162).
export const EQUIPMENT_SLOTS: EquipmentSlotDef[] = [
  { index: 0, label: 'Head', x: 0, y: 4, size: 36 },
  { index: 1, label: 'Cape', x: -41, y: 43, size: 36 },
  { index: 2, label: 'Neck', x: 0, y: 43, size: 36 },
  { index: 3, label: 'Weapon', x: -56, y: 82, size: 36 },
  { index: 4, label: 'Torso', x: 0, y: 82, size: 36 },
  { index: 5, label: 'Shield', x: 57, y: 82, size: 36 },
  { index: 7, label: 'Legs', x: 0, y: 122, size: 36 },
  { index: 9, label: 'Hands', x: -56, y: 162, size: 36 },
  { index: 10, label: 'Feet', x: 0, y: 162, size: 36 },
]

/** How tall the slot grid itself is, top of the first row to the bottom of the
 *  last. The editor keeps the client's own row spacing and centres this block
 *  in whatever height the panel ends up with, rather than stretching it. */
export const EQUIPMENT_CONTENT_HEIGHT = Math.max(...EQUIPMENT_SLOTS.map((s) => s.y + s.size))

export type EquipmentLayout = {
  slots: EquipmentSlotDef[]
  width: number
  contentHeight: number
}

/** The layout at a display scale. Offsets scale with the tiles so the grid
 *  keeps the client's proportions instead of just fattening the boxes into
 *  each other, and the panel widens to match. Scale 1 reproduces interface
 *  387 exactly. */
export function scaleEquipmentLayout(scale: number): EquipmentLayout {
  const slots = EQUIPMENT_SLOTS.map((slot) => ({
    ...slot,
    x: Math.round(slot.x * scale),
    y: Math.round(slot.y * scale),
    size: Math.round(slot.size * scale),
  }))
  return {
    slots,
    width: Math.round(EQUIPMENT_PANEL.width * scale),
    contentHeight: Math.max(...slots.map((s) => s.y + s.size)),
  }
}

/** Which identikit part an equipped item hides, for slots that share their
 *  appearance position with a body part. The chest/legs/hands/feet items
 *  simply take the slot; hair, beard and arms are hidden by separate item
 *  flags (`hideHair`/`hideBeard`/`hideArms`, equip types 8/? /6) which need
 *  the item defs to evaluate — see EDITOR.md. */
export const EQUIPMENT_LABEL_BY_INDEX = new Map(EQUIPMENT_SLOTS.map((s) => [s.index, s.label]))
