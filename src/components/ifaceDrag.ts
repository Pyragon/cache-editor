import type { IComponentDefinition } from '../loaders/interfaces'
import { childrenByParent, positionFromLocal } from './interfacePreview'
import type { LayoutRect } from './interfacePreview'

// Dragging a component on either preview canvas. Kept out of the viewers
// because both of them need it and the maths is the interesting part: the
// pointer moves in ABSOLUTE canvas pixels, but what gets written is
// basePositionX/Y in whatever units the component's aspect mode uses.

/** How close (in interface pixels) an edge has to be to snap. */
export const SNAP_DISTANCE = 5

/** A common inset from the parent's edges. Interfaces are full of components
 *  sitting a small fixed margin in from their container, and flush-to-the-edge
 *  is rarely what's actually wanted. */
export const SNAP_MARGIN = 10

/** The box a component is positioned inside: its parent's origin on the canvas
 *  and the basis its aspect modes resolve against. */
export type ParentBox = { originX: number; originY: number; width: number; height: number }

/**
 * Where the selected component's parent sits, and what basis it gives.
 *
 * A container hands its children its SCROLL size when it has one, not its
 * drawn size — the same rule `resolveAbsoluteLayout` walks with — so a child
 * of a scrolling container is positioned against the scroll extent even though
 * only part of it is visible.
 */
export function parentBoxOf(
  comp: IComponentDefinition,
  components: (IComponentDefinition | null)[],
  layout: Map<number, LayoutRect>,
  viewportW: number,
  viewportH: number,
): ParentBox {
  if (comp.parent === -1) return { originX: 0, originY: 0, width: viewportW, height: viewportH }
  const parentId = comp.parent & 0xffff
  const parent = components.find((c) => c?.componentId === parentId)
  const rect = layout.get(parentId)
  if (!parent || !rect) return { originX: 0, originY: 0, width: viewportW, height: viewportH }
  return {
    originX: rect.x,
    originY: rect.y,
    width: parent.scrollWidth !== 0 ? parent.scrollWidth : rect.width,
    height: parent.scrollHeight !== 0 ? parent.scrollHeight : rect.height,
  }
}

/** A line the drag snapped to, in ABSOLUTE canvas coords, for drawing. */
export type SnapGuide = { axis: 'x' | 'y'; at: number }

type SnapResult = { local: number; guides: SnapGuide[] }

/**
 * Pull one axis onto a nearby edge.
 *
 * Candidates are the parent's own edges and centre, plus every sibling's
 * edges and centre — the things you actually line a component up with. Both
 * the dragged component's leading and trailing edge are tested against each,
 * so a box snaps flush left, flush right, or centred without having to aim
 * at which edge.
 */
function snapAxis(
  axis: 'x' | 'y',
  local: number,
  extent: number,
  parentExtent: number,
  siblings: { start: number; size: number }[],
  origin: number,
): SnapResult {
  // lines worth lining up with: the parent's edges, the same edges inset by a
  // standard margin, the parent's centre, and each sibling's edges and centre
  const targets = [
    0, parentExtent,
    SNAP_MARGIN, parentExtent - SNAP_MARGIN,
    (parentExtent - extent) >> 1,
  ]
  for (const s of siblings) targets.push(s.start, s.start + s.size, s.start + ((s.size - extent) >> 1))

  let best: { local: number; line: number; d: number } | null = null
  for (const t of targets) {
    // test the leading edge onto the line, then the trailing edge onto it, so
    // a box snaps flush either way without aiming at a particular edge
    for (const candidate of [t, t - extent]) {
      const d = Math.abs(candidate - local)
      if (d <= SNAP_DISTANCE && (!best || d < best.d)) best = { local: candidate, line: t, d }
    }
  }
  if (!best) return { local, guides: [] }
  return { local: best.local, guides: [{ axis, at: origin + best.line }] }
}

export type DragOutcome = {
  basePositionX: number
  basePositionY: number
  guides: SnapGuide[]
}

/**
 * Turn a pointer position into the component's new basePositionX/Y.
 *
 * `pointer` and `grabOffset` are in absolute canvas pixels; the offset is
 * where inside the component the drag started, so the box doesn't jump to
 * centre itself under the cursor.
 */
export function dragToBasePosition(
  comp: IComponentDefinition,
  rect: LayoutRect,
  parent: ParentBox,
  components: (IComponentDefinition | null)[],
  layout: Map<number, LayoutRect>,
  pointer: { x: number; y: number },
  grabOffset: { x: number; y: number },
  snap: boolean,
): DragOutcome {
  let localX = pointer.x - grabOffset.x - parent.originX
  let localY = pointer.y - grabOffset.y - parent.originY
  const guides: SnapGuide[] = []

  if (snap) {
    const parentId = comp.parent === -1 ? -1 : comp.parent & 0xffff
    const sibs = (childrenByParent(components).get(parentId) ?? [])
      .filter((s) => s.componentId !== comp.componentId)
      .map((s) => layout.get(s.componentId))
      .filter((r): r is LayoutRect => r != null)

    const x = snapAxis('x', localX, rect.width, parent.width,
      sibs.map((r) => ({ start: r.x - parent.originX, size: r.width })), parent.originX)
    localX = x.local
    guides.push(...x.guides)

    const y = snapAxis('y', localY, rect.height, parent.height,
      sibs.map((r) => ({ start: r.y - parent.originY, size: r.height })), parent.originY)
    localY = y.local
    guides.push(...y.guides)
  }

  return {
    basePositionX: positionFromLocal(comp.aspectXType, localX, rect.width, parent.width),
    basePositionY: positionFromLocal(comp.aspectYType, localY, rect.height, parent.height),
    guides,
  }
}
