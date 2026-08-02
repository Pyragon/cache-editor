import type { ModelData } from './models'
import type { AnimationFrameBaseDef } from './animation_frame_bases'
import type { AnimationFrameDef } from './animation_frame_sets'

// Applies one animation frame's bone-group transforms to a model — ports
// darkan's animateTransform, INCLUDING the client's keyframe interpolation
// (MeshRasterizer.method11266's two-frame path, gated on the sequence's
// `tweened` flag): pass the next keyframe + elapsed/duration and every
// transform's deltas blend toward it. (The BAS equipment-matrix branches,
// gated on data this project doesn't build yet, remain NOT ported — see the
// TODO note where they'd hook in.)
// Implemented transform types: 0 origin marker, 1 translate,
// 2 rotate, 3 scale (vertex groups from vertexSkins), plus the face-group
// effects 5 (alpha: alpha += delta·8, clamped 0..255 where 255 = invisible)
// and 7 (colour: HSL16 hue += Δx wrapped &0x3f, sat += Δy clamped 0..7,
// light += Δz clamped 0..127), addressed via faceSkins, and the billboard
// group effects 8 (view-space offset += Δx/Δy), 9 (roll += Δx<<2 & 0x3fff)
// and 10 (scale ×= Δx/128, Δy/128) — a label there is a billboard GROUP id,
// which is the attachment's `depth` byte (MeshRasterizer_Sub3's
// anIntArrayArray8954, built by RSMesh.method2667 from anInt811). The fire by
// the God Wars chapel is the worked example: its smoke puffs live in groups
// 1-6 and the animation scales/rolls each group while type-5 fades the host
// faces — which is ALSO the billboards' alpha (the client recomputes a
// sprite's tint from its host face after every type-5/7 pass).
//
// Fixed-point convention matches the client exactly: a 14-bit sine/cosine
// table (SINE/COSINE, 16384 entries covering one full turn) and a lazy "upscale"
// step that left-shifts every vertex coordinate by 4 bits the first time any
// transform touches the mesh, trading range for precision during the transform
// math. The result is downscaled back by the same 4 bits before being handed
// back in the model's normal coordinate space.

const SINE = new Int32Array(16384)
const COSINE = new Int32Array(16384)
;(function buildTrigTables() {
  const step = (2 * Math.PI) / 16384
  for (let i = 0; i < 16384; i++) {
    SINE[i] = Math.trunc(16384 * Math.sin(i * step))
    COSINE[i] = Math.trunc(16384 * Math.cos(i * step))
  }
})()

// Inverted index: bone-group/label id -> the vertex indices carrying that
// skin byte (darkan Mesh.kt createVertexGroups(), reading vertexSkinBuf).
export function buildVertexGroups(vertexSkins: Int16Array, vertexCount: number): number[][] {
  let maxGroup = 0
  for (let v = 0; v < vertexCount; v++) if (vertexSkins[v] > maxGroup) maxGroup = vertexSkins[v]
  const groups: number[][] = Array.from({ length: maxGroup + 1 }, () => [])
  // label −1 = unlabelled (a merged part that carried no skins of its own):
  // no group claims it, so no transform ever moves it — same rule the face
  // groups below already follow.
  for (let v = 0; v < vertexCount; v++) {
    const group = vertexSkins[v]
    if (group >= 0) groups[group].push(v)
  }
  return groups
}

type PoseState = {
  x: Int32Array
  y: Int32Array
  z: Int32Array
  originX: number
  originY: number
  originZ: number
  withinOrigin: boolean
  upscaled: boolean
}

function ensureUpscaled(state: PoseState, vertexCount: number) {
  if (state.upscaled) return
  for (let v = 0; v < vertexCount; v++) {
    state.x[v] <<= 4
    state.y[v] <<= 4
    state.z[v] <<= 4
  }
  state.upscaled = true
}

// One transform slot's effect (transformationTypes[i]) on the vertices its
// labels resolve to. `x`/`y`/`z` are the frame's already-shift-corrected
// deltas (see resolveTransformDelta below) for this slot.
function applyTransform(state: PoseState, vertexCount: number, type: number, vertices: number[], x: number, y: number, z: number) {
  if (type === 0) {
    ensureUpscaled(state, vertexCount)
    const x1 = x << 4, y1 = y << 4, z1 = z << 4
    let sumX = 0, sumY = 0, sumZ = 0, count = 0
    for (const v of vertices) {
      sumX += state.x[v]; sumY += state.y[v]; sumZ += state.z[v]
      count++
    }
    if (count > 0) {
      state.originX = x1 + Math.trunc(sumX / count)
      state.originY = Math.trunc(sumY / count) + y1
      state.originZ = z1 + Math.trunc(sumZ / count)
      state.withinOrigin = true
    } else {
      state.originX = x1
      state.originY = y1
      state.originZ = z1
    }
  } else if (type === 1) {
    ensureUpscaled(state, vertexCount)
    const x1 = x << 4, y1 = y << 4, z1 = z << 4
    for (const v of vertices) {
      state.x[v] += x1
      state.y[v] += y1
      state.z[v] += z1
    }
  } else if (type === 2) {
    for (const v of vertices) {
      state.x[v] -= state.originX
      state.y[v] -= state.originY
      state.z[v] -= state.originZ
      if (z !== 0) {
        const xan = SINE[z], zan = COSINE[z]
        const tmpY = (xan * state.y[v] + zan * state.x[v] + 16383) >> 14
        state.y[v] = (zan * state.y[v] - xan * state.x[v] + 16383) >> 14
        state.x[v] = tmpY
      }
      if (x !== 0) {
        const xan = SINE[x], zan = COSINE[x]
        const tmpZ = (zan * state.y[v] - xan * state.z[v] + 16383) >> 14
        state.z[v] = (xan * state.y[v] + zan * state.z[v] + 16383) >> 14
        state.y[v] = tmpZ
      }
      if (y !== 0) {
        const xan = SINE[y], zan = COSINE[y]
        const tmpZ = (xan * state.z[v] + zan * state.x[v] + 16383) >> 14
        state.z[v] = (zan * state.z[v] - xan * state.x[v] + 16383) >> 14
        state.x[v] = tmpZ
      }
      state.x[v] += state.originX
      state.y[v] += state.originY
      state.z[v] += state.originZ
    }
  } else if (type === 3) {
    for (const v of vertices) {
      state.x[v] -= state.originX
      state.y[v] -= state.originY
      state.z[v] -= state.originZ
      state.x[v] = Math.trunc((x * state.x[v]) / 128)
      state.y[v] = Math.trunc((y * state.y[v]) / 128)
      state.z[v] = Math.trunc((z * state.z[v]) / 128)
      state.x[v] += state.originX
      state.y[v] += state.originY
      state.z[v] += state.originZ
    }
  }
  // types 5/7 (face alpha/colour) and 8/9/10 (billboard offset/roll/scale)
  // are handled by applyAnimationFrame itself — they touch face/billboard
  // groups, not this vertex state.
}

// Type 2/9 store the raw pre-`<<2 & 0x3fff` smart delta (see
// animation_frame_sets.ts) — apply that promotion here, at the point of use,
// exactly like the client does at decode time.
function resolveTransformDelta(type: number, raw: number): number {
  if (type === 2 || type === 9) return (raw << 2) & 0x3fff
  return raw
}

/** One billboard group's accumulated pose (client Class65 state, identity =
 *  no offset, no roll, scale 128/128). */
export type BillboardGroupPose = {
  /** view-space offset, world units (type 8: anInt668/anInt672) */
  dx: number
  dy: number
  /** roll in 14-bit angle units, a full turn is 16384 (type 9: anInt673) */
  rot: number
  /** width/height scale ×128 (type 10: anInt671/anInt670) */
  sx: number
  sy: number
}

export type PosedVertices = {
  x: Int32Array
  y: Int32Array
  z: Int32Array
  /** Posed per-face alphas, only when a type-5 transform ran (255 = invisible,
   *  i.e. −1 when read back signed like ModelData.faceAlpha). */
  faceAlpha: Int8Array | null
  /** Posed per-face HSL16 colours, only when a type-7 transform ran. */
  faceColor: Uint16Array | null
  /** Billboard group poses keyed by group id (= the attachment's `depth`),
   *  only when a type-8/9/10 transform ran. */
  billboardGroups: Map<number, BillboardGroupPose> | null
}

// Applies every transform in one frame to a model's vertices, in order, and
// returns the posed positions (same array length/order as model.vertexX/Y/Z,
// same coordinate scale — already downscaled back from the transform math's
// internal fixed-point precision) plus posed face alphas/colours when the
// frame carried type 5/7 face-group transforms.
// Vertex/face skin groups are a pure function of the model's skin arrays, so
// cache them per model — rebuilding them on every posed frame (e.g. hundreds of
// animated map locs at 60fps) was pure allocation churn.
const skinGroupCache = new WeakMap<ModelData, { vertexGroups: number[][]; faceGroups: number[][] | null }>()

// A transform slot's vertices are `frameBase.labels[slot]` flattened through the
// model's skin groups — a pure function of the two, and the same answer on
// every frame. It used to be rebuilt per transform entry per pose (twice, since
// each entry also resolves its skip reference), which on a 30-entity cutscene at
// 60fps was the single biggest source of garbage in the frame. Resolved once
// per (model, frame base) and reused.
const EMPTY_SLOT: number[] = []

/** Reusable pose buffers — see `applyAnimationFrame`'s `scratch` parameter. */
export type PoseScratch = { x: Int32Array; y: Int32Array; z: Int32Array }

export function makePoseScratch(model: ModelData): PoseScratch {
  return {
    x: new Int32Array(model.vertexX.length),
    y: new Int32Array(model.vertexY.length),
    z: new Int32Array(model.vertexZ.length),
  }
}

type SlotLists = { vertices: (number[] | undefined)[]; faces: (number[] | undefined)[] }
const slotListCache = new WeakMap<ModelData, WeakMap<AnimationFrameBaseDef, SlotLists>>()

function slotListsFor(model: ModelData, frameBase: AnimationFrameBaseDef): SlotLists {
  let perBase = slotListCache.get(model)
  if (!perBase) slotListCache.set(model, perBase = new WeakMap())
  const hit = perBase.get(frameBase)
  if (hit) return hit

  const { vertexGroups, faceGroups } = skinGroupsFor(model)
  const count = frameBase.transformationTypes.length
  const lists: SlotLists = { vertices: new Array(count), faces: new Array(count) }
  for (let slot = 0; slot < count; slot++) {
    const labels = frameBase.labels[slot]
    if (!labels || labels.length === 0) continue
    // one label is the overwhelmingly common case — hand back the group itself
    // rather than a copy of it (read-only downstream)
    if (labels.length === 1) {
      lists.vertices[slot] = vertexGroups[labels[0]]
      lists.faces[slot] = faceGroups?.[labels[0]]
      continue
    }
    const vertices: number[] = []
    const faces: number[] = []
    for (const label of labels) {
      const vGroup = vertexGroups[label]
      if (vGroup) for (const v of vGroup) vertices.push(v)
      const fGroup = faceGroups?.[label]
      if (fGroup) for (const f of fGroup) faces.push(f)
    }
    lists.vertices[slot] = vertices
    lists.faces[slot] = faces
  }
  perBase.set(frameBase, lists)
  return lists
}

function skinGroupsFor(model: ModelData): { vertexGroups: number[][]; faceGroups: number[][] | null } {
  let cached = skinGroupCache.get(model)
  if (cached) return cached
  const vertexGroups = buildVertexGroups(model.vertexSkins!, model.vertexCount)
  // Face groups (darkan Mesh.createFaceGroups): label −1 = unlabelled.
  let faceGroups: number[][] | null = null
  if (model.faceSkins) {
    let maxGroup = -1
    for (let f = 0; f < model.faceCount; f++) if (model.faceSkins[f] > maxGroup) maxGroup = model.faceSkins[f]
    if (maxGroup >= 0) {
      faceGroups = Array.from({ length: maxGroup + 1 }, () => [])
      for (let f = 0; f < model.faceCount; f++) {
        const group = model.faceSkins[f]
        if (group >= 0) faceGroups[group].push(f)
      }
    }
  }
  cached = { vertexGroups, faceGroups }
  skinGroupCache.set(model, cached)
  return cached
}

/** One resolved transform to apply: slot + final (possibly interpolated)
 *  deltas, already promoted for types 2/9. */
type ResolvedEntry = { slot: number; x: number; y: number; z: number; skip: number }

/**
 * The client's keyframe interpolation (MeshRasterizer.method11266, the
 * two-frame path): walk EVERY slot of the frame base, taking each frame's
 * entry when present and the identity when not (0, or 128 for the scale
 * types 3/10), and blend by elapsed/duration —
 *   - rotations (2, and billboard roll 9) take the SHORTEST ARC per axis in
 *     14-bit angle space (delta >= 8192 wraps negative);
 *   - colour (7) wraps hue the same way in 6-bit space, sat/light linear;
 *   - everything else lerps linearly (translate, scale, alpha, billboards);
 *   - a frame1 entry flagged 0x2 ("hold") or a frame2 entry flagged 0x1
 *     ("snap in") disables the blend — frame1's values apply exactly;
 *   - the origin re-establishment comes from frame1's skip when it has one,
 *     else frame2's.
 * Division mirrors Java's int truncation. Types 2/9 are promoted (<<2 &
 * 0x3fff) BEFORE the arc math, exactly where the client's decode does it.
 */
function resolveEntries(
  frameBase: AnimationFrameBaseDef,
  frame: AnimationFrameDef,
  next: AnimationFrameDef | null,
  elapsed: number,
  duration: number,
): ResolvedEntry[] {
  const entries: ResolvedEntry[] = []
  // Single-frame path — the client's else-branch: frame1's entries verbatim.
  if (!next || elapsed <= 0 || next.frameBaseId !== frame.frameBaseId || next.rawFallbackBytes) {
    for (let i = 0; i < frame.transformationIndices.length; i++) {
      const slot = frame.transformationIndices[i]
      const type = frameBase.transformationTypes[slot]
      entries.push({
        slot,
        x: resolveTransformDelta(type, frame.transformationX[i]),
        y: type === 2 ? resolveTransformDelta(type, frame.transformationY[i]) : frame.transformationY[i],
        z: type === 2 ? resolveTransformDelta(type, frame.transformationZ[i]) : frame.transformationZ[i],
        skip: frame.skippedReferences[i] ?? -1,
      })
    }
    return entries
  }

  const t = Math.min(elapsed, duration)
  let i1 = 0
  let i2 = 0
  for (let slot = 0; slot < frameBase.transformationTypes.length; slot++) {
    const has1 = i1 < frame.transformationIndices.length && frame.transformationIndices[i1] === slot
    const has2 = i2 < next.transformationIndices.length && next.transformationIndices[i2] === slot
    if (!has1 && !has2) continue
    const type = frameBase.transformationTypes[slot]
    const ident = type === 3 || type === 10 ? 128 : 0

    let x1 = ident, y1 = ident, z1 = ident, skip1 = -1, flag1 = 0
    if (has1) {
      x1 = resolveTransformDelta(type, frame.transformationX[i1])
      y1 = type === 2 ? resolveTransformDelta(type, frame.transformationY[i1]) : frame.transformationY[i1]
      z1 = type === 2 ? resolveTransformDelta(type, frame.transformationZ[i1]) : frame.transformationZ[i1]
      skip1 = frame.skippedReferences[i1] ?? -1
      flag1 = frame.transformationFlags[i1] ?? 0
      i1++
    }
    let x2 = ident, y2 = ident, z2 = ident, skip2 = -1, flag2 = 0
    if (has2) {
      x2 = resolveTransformDelta(type, next.transformationX[i2])
      y2 = type === 2 ? resolveTransformDelta(type, next.transformationY[i2]) : next.transformationY[i2]
      z2 = type === 2 ? resolveTransformDelta(type, next.transformationZ[i2]) : next.transformationZ[i2]
      skip2 = next.skippedReferences[i2] ?? -1
      flag2 = next.transformationFlags[i2] ?? 0
      i2++
    }

    let x: number, y: number, z: number
    if ((flag1 & 0x2) !== 0 || (flag2 & 0x1) !== 0) {
      x = x1; y = y1; z = z1
    } else if (type === 2) {
      let dx = (x2 - x1) & 0x3fff
      let dy = (y2 - y1) & 0x3fff
      let dz = (z2 - z1) & 0x3fff
      if (dx >= 8192) dx -= 16384
      if (dy >= 8192) dy -= 16384
      if (dz >= 8192) dz -= 16384
      x = (x1 + Math.trunc((dx * t) / duration)) & 0x3fff
      y = (y1 + Math.trunc((dy * t) / duration)) & 0x3fff
      z = (z1 + Math.trunc((dz * t) / duration)) & 0x3fff
    } else if (type === 9) {
      let dx = (x2 - x1) & 0x3fff
      if (dx >= 8192) dx -= 16384
      x = (x1 + Math.trunc((dx * t) / duration)) & 0x3fff
      y = 0
      z = 0
    } else if (type === 7) {
      let dh = (x2 - x1) & 0x3f
      if (dh >= 32) dh -= 64
      x = (x1 + Math.trunc((dh * t) / duration)) & 0x3f
      y = y1 + Math.trunc(((y2 - y1) * t) / duration)
      z = z1 + Math.trunc(((z2 - z1) * t) / duration)
    } else {
      x = x1 + Math.trunc(((x2 - x1) * t) / duration)
      y = y1 + Math.trunc(((y2 - y1) * t) / duration)
      z = z1 + Math.trunc(((z2 - z1) * t) / duration)
    }
    entries.push({ slot, x, y, z, skip: skip1 !== -1 ? skip1 : skip2 })
  }
  return entries
}

export function applyAnimationFrame(
  model: ModelData,
  frameBase: AnimationFrameBaseDef,
  frame: AnimationFrameDef,
  /** Next keyframe to blend toward (same frame base), or null to pose
   *  `frame` exactly. Only sequences with `tweened` set should pass one. */
  next: AnimationFrameDef | null = null,
  /** Ticks elapsed within `frame` (fractional allowed) / its duration. */
  elapsed = 0,
  duration = 1,
  /**
   * Buffers to pose INTO, instead of allocating a fresh copy of the model's
   * vertices every call. Three arrays the size of the model, per posed thing,
   * per frame, is a lot of garbage on a crowded scene.
   *
   * The returned `PosedVertices` aliases these, so a caller may only share one
   * between things whose poses it consumes before the next call — or, more
   * simply, keep one per posed instance. Omit it and each call allocates, which
   * is always safe.
   */
  scratch?: PoseScratch,
): PosedVertices | null {
  if (!model.vertexSkins || frame.rawFallbackBytes) return null

  const slots = slotListsFor(model, frameBase)
  const verticesForSlot = (slot: number): number[] => slots.vertices[slot] ?? EMPTY_SLOT
  const facesForSlot = (slot: number): number[] => slots.faces[slot] ?? EMPTY_SLOT

  // set() on a right-sized buffer is a memcpy; from() allocates one first.
  const reuse = scratch != null && scratch.x.length === model.vertexX.length
  const state: PoseState = {
    x: reuse ? scratch!.x : Int32Array.from(model.vertexX),
    y: reuse ? scratch!.y : Int32Array.from(model.vertexY),
    z: reuse ? scratch!.z : Int32Array.from(model.vertexZ),
    originX: 0, originY: 0, originZ: 0,
    withinOrigin: false,
    upscaled: false,
  }
  if (reuse) {
    state.x.set(model.vertexX)
    state.y.set(model.vertexY)
    state.z.set(model.vertexZ)
  }
  // Copied lazily on the first face-group transform.
  let faceAlpha: Int8Array | null = null
  let faceColor: Uint16Array | null = null
  // Created lazily on the first billboard-group transform.
  let billboardGroups: Map<number, BillboardGroupPose> | null = null

  // Which transforms run — and with what deltas — comes from resolveEntries:
  // frame1's entries verbatim in the single-frame case, or the client's
  // slot-ordered union of both keyframes with interpolated deltas when
  // tweening. Values arrive PROMOTED for types 2/9.
  for (const entry of resolveEntries(frameBase, frame, next, elapsed, duration)) {
    const { slot } = entry
    const type = frameBase.transformationTypes[slot]

    // Before EVERY transform entry (regardless of its type — the client's
    // driver runs this unconditionally), re-establish the current origin from
    // a DIFFERENT slot's live vertex positions (a zero-delta type-0 pass),
    // keyed by the entry's skip reference (confusingly also called "labels"
    // in AnimFrame.kt, NOT the same thing as AnimationFrameBaseDef.labels).
    // Skipping this lets the origin drift stale across branches of the
    // skeleton (e.g. legs -> neck, or across a face-effect entry), which
    // produced stretched/spiked geometry (terrorbird capture) and gaping
    // chathead jaws when type-5 blinks sat between rotation entries. When
    // tweening, frame1's skip wins and frame2's fills in (client 483-487).
    if (entry.skip !== -1) {
      applyTransform(state, model.vertexCount, 0, verticesForSlot(entry.skip), 0, 0, 0)
    }

    // Face-group effects (types 5/7) — deltas already interpolated.
    if (type === 5) {
      faceAlpha ??= Int8Array.from(model.faceAlpha)
      const delta = entry.x
      for (const f of facesForSlot(slot)) {
        let alpha = (faceAlpha[f] & 0xff) + delta * 8
        if (alpha < 0) alpha = 0
        else if (alpha > 255) alpha = 255
        faceAlpha[f] = alpha
      }
      continue
    }
    if (type === 7) {
      faceColor ??= Uint16Array.from(model.faceColor)
      const dh = entry.x, ds = entry.y, dl = entry.z
      for (const f of facesForSlot(slot)) {
        const hsl = faceColor[f] & 0xffff
        const h = (dh + ((hsl >> 10) & 0x3f)) & 0x3f
        let s = ((hsl >> 7) & 0x7) + ds
        if (s < 0) s = 0
        else if (s > 7) s = 7
        let l = (hsl & 0x7f) + dl
        if (l < 0) l = 0
        else if (l > 127) l = 127
        faceColor[f] = (h << 10) | (s << 7) | l
      }
      continue
    }

    // Billboard group effects (MeshRasterizer_Sub3 types 8/9/10) — a label is
    // a group id (the attachment's `depth`); state accumulates across entries
    // exactly like the client's per-billboard Class65.
    if (type === 8 || type === 9 || type === 10) {
      billboardGroups ??= new Map()
      const dx = entry.x
      const dy = entry.y
      for (const label of frameBase.labels[slot] ?? []) {
        let group = billboardGroups.get(label)
        if (!group) billboardGroups.set(label, group = { dx: 0, dy: 0, rot: 0, sx: 128, sy: 128 })
        if (type === 8) {
          group.dx += dx
          group.dy += dy
        } else if (type === 9) {
          group.rot = (group.rot + dx) & 0x3fff
        } else {
          group.sx = (group.sx * dx) >> 7
          group.sy = (group.sy * dy) >> 7
        }
      }
      continue
    }

    applyTransform(state, model.vertexCount, type, verticesForSlot(slot), entry.x, entry.y, entry.z)
  }

  if (state.upscaled) {
    for (let v = 0; v < model.vertexCount; v++) {
      state.x[v] >>= 4
      state.y[v] >>= 4
      state.z[v] >>= 4
    }
  }

  return { x: state.x, y: state.y, z: state.z, faceAlpha, faceColor, billboardGroups }
}
