import type { IComponentDefinition } from './interfaces'

// Ported from darkan-game-client: Class484.initSizes (width/height) and
// Class246.method4204 (x/y), recursed the way InteractableObject.method16099
// walks parent -> children. aspectWidthType/aspectHeightType/aspectXType/
// aspectYType each select one of a handful of resolution modes relative to
// the parent's own resolved size — a component's `parent` field is never a
// plain componentId, it's (interfaceId << 16) | rawParentComponentId, so it
// must be masked before matching against sibling componentIds.

export type LayoutRect = { x: number; y: number; width: number; height: number }

function resolveSize(c: IComponentDefinition, parentW: number, parentH: number): { width: number; height: number } {
  let width = c.baseWidth
  let height = c.baseHeight
  if (c.aspectWidthType === 1) width = parentW - c.baseWidth
  else if (c.aspectWidthType === 2) width = (c.baseWidth * parentW) >> 14
  if (c.aspectHeightType === 1) height = parentH - c.baseHeight
  else if (c.aspectHeightType === 2) height = (parentH * c.baseHeight) >> 14
  if (c.aspectWidthType === 4) width = (c.aspectWidth * height) / c.aspectHeight
  if (c.aspectHeightType === 4) height = (width * c.aspectHeight) / c.aspectWidth
  return { width, height }
}

function resolvePosition(
  c: IComponentDefinition,
  parentW: number,
  parentH: number,
  width: number,
  height: number,
): { x: number; y: number } {
  let x: number
  switch (c.aspectXType) {
    case 0:
      x = c.basePositionX
      break
    case 1:
      x = c.basePositionX + (parentW - width) / 2
      break
    case 2:
      x = parentW - width - c.basePositionX
      break
    case 3:
      x = (c.basePositionX * parentW) >> 14
      break
    case 4:
      x = (parentW - width) / 2 + ((c.basePositionX * parentW) >> 14)
      break
    default:
      x = parentW - width - ((c.basePositionX * parentW) >> 14)
  }
  let y: number
  switch (c.aspectYType) {
    case 0:
      y = c.basePositionY
      break
    case 1:
      y = (parentH - height) / 2 + c.basePositionY
      break
    case 2:
      y = parentH - height - c.basePositionY
      break
    case 3:
      y = (parentH * c.basePositionY) >> 14
      break
    case 4:
      y = (parentH - height) / 2 + ((parentH * c.basePositionY) >> 14)
      break
    default:
      y = parentH - height - ((parentH * c.basePositionY) >> 14)
  }
  return { x, y }
}

/** Resolves every component's on-screen rect for one interface, given a root viewport size.
 *  Classic fixed-mode RS2 game screen content area is 765x503; resizable-mode interfaces
 *  read aspect-relative sizes off the real client window instead — there's no single
 *  correct default, so callers may override it (e.g. to preview a HUD panel at another size). */
export function resolveLayout(
  components: (IComponentDefinition | null)[],
  viewportWidth = 765,
  viewportHeight = 503,
): Map<number, LayoutRect> {
  const rects = new Map<number, LayoutRect>()
  const byParent = new Map<number, IComponentDefinition[]>()
  for (const c of components) {
    if (!c) continue
    const parentId = c.parent === -1 ? -1 : c.parent & 0xffff
    if (!byParent.has(parentId)) byParent.set(parentId, [])
    byParent.get(parentId)!.push(c)
  }

  function layoutChildren(parentId: number, parentW: number, parentH: number, depth: number) {
    if (depth > 32) return // cyclic parent chain guard
    const children = byParent.get(parentId)
    if (!children) return
    for (const c of children) {
      const { width, height } = resolveSize(c, parentW, parentH)
      const { x, y } = resolvePosition(c, parentW, parentH, width, height)
      rects.set(c.componentId, { x, y, width, height })
      if (c.type === 'CONTAINER') {
        layoutChildren(c.componentId, width, height, depth + 1)
      }
    }
  }

  layoutChildren(-1, viewportWidth, viewportHeight, 0)
  return rects
}
