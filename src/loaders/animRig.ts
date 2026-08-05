import type { AnimationFrameBaseDef } from './animation_frame_bases'
import type { ModelData } from './models'

// Turning a frame base into something a person can point at.
//
// The format has no bones. A frame base is a flat list of numbered transform
// SLOTS, each carrying a type and a set of vertex-group labels, and "the upper
// arm" exists only as the fact that several slots happen to name the same
// groups. Every editor built straight on top of that makes you think in slot
// indices, which is why the current one is unusable for actually animating.
//
// A PART fixes that: one distinct label set, with every slot that drives it
// gathered as its channels. That is exactly a bone — a set of vertices you can
// move, turn or scale — and it's recoverable from the data because the slots
// were authored that way.
//
// Hierarchy comes from containment: if one part's groups are a strict subset of
// another's, it's a child. That's the same emergent nesting the client relies
// on (a parent's slot lists its descendants' groups, and runs first), so the
// tree here matches the tree the animation actually behaves like.

/** A poseable piece of the rig: some vertex groups, and the slots that move them. */
export type RigPart = {
  id: number
  /** Vertex-group labels this part moves. */
  labels: number[]
  /** The slots driving it, by transform type — 0 pivot, 1 move, 2 turn, 3 scale. */
  channels: { slot: number; type: number }[]
  /** Index into `parts`, or −1 for a root. */
  parent: number
  children: number[]
  depth: number
  /**
   * Can this be posed, or is it only a pivot?
   *
   * A third of all parts in the cache (36,638 of 108,947) carry nothing but a
   * type-0 channel: they exist to place the origin for something else to turn
   * about, and dragging one does nothing visible. Listing them as bones would
   * bury the ~21 real ones per base in noise, which is the exact failure this
   * whole model is meant to undo.
   */
  poseable: boolean
}

export type Rig = {
  parts: RigPart[]
  /** Vertex-group label → the DEEPEST part that moves it. Clicking a vertex in
   *  the viewport should select the most specific thing that owns it, not the
   *  torso that happens to contain everything. */
  deepestByLabel: Map<number, number>
  /** Slots that address face or billboard groups — real transforms, but nothing
   *  in the scene to grab, so the studio surfaces them separately. */
  effectSlots: { slot: number; type: number }[]
}

/** Types that move geometry, and so make a part. 0 only moves the pivot, but it
 *  belongs to the part it's aimed at, so it's collected as a channel. */
const GEOMETRY_TYPES = new Set([0, 1, 2, 3])

const keyOf = (labels: number[]) => labels.slice().sort((a, b) => a - b).join(',')

export function buildRig(base: AnimationFrameBaseDef): Rig {
  const byKey = new Map<string, RigPart>()
  const effectSlots: { slot: number; type: number }[] = []

  for (let slot = 0; slot < base.transformationTypes.length; slot++) {
    const type = base.transformationTypes[slot]
    const labels = base.labels[slot] ?? []
    if (!GEOMETRY_TYPES.has(type)) {
      if (labels.length > 0) effectSlots.push({ slot, type })
      continue
    }
    if (labels.length === 0) continue
    const key = keyOf(labels)
    const existing = byKey.get(key)
    if (existing) { existing.channels.push({ slot, type }); continue }
    byKey.set(key, {
      id: byKey.size,
      labels: labels.slice().sort((a, b) => a - b),
      channels: [{ slot, type }],
      parent: -1,
      children: [],
      depth: 0,
      poseable: false,
    })
  }

  const parts = [...byKey.values()]
  parts.forEach((p, i) => {
    p.id = i
    p.poseable = p.channels.some((c) => c.type === 1 || c.type === 2 || c.type === 3)
  })

  // Parent = the SMALLEST strict superset. Smallest matters: an arm is inside
  // both the torso and the whole body, and the arm is the useful parent.
  const sets = parts.map((p) => new Set(p.labels))
  for (let i = 0; i < parts.length; i++) {
    let best = -1
    for (let j = 0; j < parts.length; j++) {
      if (i === j || parts[j].labels.length <= parts[i].labels.length) continue
      let contains = true
      for (const l of parts[i].labels) if (!sets[j].has(l)) { contains = false; break }
      if (!contains) continue
      if (best === -1 || parts[j].labels.length < parts[best].labels.length) best = j
    }
    parts[i].parent = best
  }
  for (const p of parts) if (p.parent >= 0) parts[p.parent].children.push(p.id)

  // Depth, iteratively — a base whose label sets partially overlap can't form a
  // clean tree, and a cycle here would hang the editor rather than look wrong.
  for (const p of parts) {
    let depth = 0
    let cursor = p.parent
    const seen = new Set<number>([p.id])
    while (cursor >= 0 && !seen.has(cursor) && depth < 64) {
      seen.add(cursor)
      depth++
      cursor = parts[cursor].parent
    }
    p.depth = depth
  }

  // Deepest owner per label: the most specific part is the one to select.
  const deepestByLabel = new Map<number, number>()
  for (const p of parts) {
    for (const l of p.labels) {
      const held = deepestByLabel.get(l)
      if (held == null || p.depth > parts[held].depth) deepestByLabel.set(l, p.id)
    }
  }

  return { parts, deepestByLabel, effectSlots }
}

/** The part to select when the user clicks a vertex — the most specific one
 *  that moves it. Null when the vertex belongs to no group the rig touches. */
export function partForVertex(rig: Rig, model: ModelData, vertexIndex: number): number | null {
  const label = model.vertexSkins?.[vertexIndex]
  if (label == null || label < 0) return null
  return rig.deepestByLabel.get(label) ?? null
}

/** Every vertex a part moves, for highlighting it in the viewport. Includes
 *  descendants, because moving a part moves everything under it — that IS what
 *  the containment nesting means. */
export function partVertices(rig: Rig, model: ModelData, partId: number): Set<number> {
  const out = new Set<number>()
  const part = rig.parts[partId]
  if (!part || !model.vertexSkins) return out
  const want = new Set(part.labels)
  for (let v = 0; v < model.vertexCount; v++) {
    const label = model.vertexSkins[v]
    if (label >= 0 && want.has(label)) out.add(v)
  }
  return out
}

/** A stable, readable name for a part. The cache stores none, so this describes
 *  it by what it is: how deep it sits and how much it moves. Good enough to tell
 *  parts apart in a list; the studio lets you rename them for a session. */
export function partLabel(rig: Rig, partId: number): string {
  const part = rig.parts[partId]
  if (!part) return `part ${partId}`
  const kind = part.depth === 0 ? 'root' : `depth ${part.depth}`
  return `part ${partId} · ${kind} · ${part.labels.length} group${part.labels.length === 1 ? '' : 's'}`
}
