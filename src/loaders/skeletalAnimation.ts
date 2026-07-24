import type { ModelData } from './models'
import type { AnimationFrameBaseDef } from './animation_frame_bases'
import type { AnimationFrameDef } from './animation_frame_sets'

// Applies one animation frame's bone-group transforms to a model — ports
// darkan ModelSM.kt's animateTransform (the non-interpolated, single-frame
// playback path; interpolateFrames' tweened blend between two frames and the
// BAS equipment-matrix branches inside animateTransform, both gated on data
// this project doesn't build yet, are NOT ported — see the TODO note where
// they'd hook in). Implemented transform types: 0 origin marker, 1 translate,
// 2 rotate, 3 scale (vertex groups from vertexSkins), plus the face-group
// effects 5 (alpha: alpha += delta·8, clamped 0..255 where 255 = invisible)
// and 7 (colour: HSL16 hue += Δx wrapped &0x3f, sat += Δy clamped 0..7,
// light += Δz clamped 0..127), addressed via faceSkins. Types 8/9/10
// (billboard offset/rotate/scale) remain unimplemented.
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
export function buildVertexGroups(vertexSkins: Uint8Array, vertexCount: number): number[][] {
  let maxGroup = 0
  for (let v = 0; v < vertexCount; v++) if (vertexSkins[v] > maxGroup) maxGroup = vertexSkins[v]
  const groups: number[][] = Array.from({ length: maxGroup + 1 }, () => [])
  for (let v = 0; v < vertexCount; v++) groups[vertexSkins[v]].push(v)
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
  // types 5/7 (face alpha/colour) are handled by applyAnimationFrame itself
  // (they touch face groups, not this vertex state); 8/9/10 (billboard
  // offset/rotate/scale) remain unimplemented — see file header.
}

// Type 2/9 store the raw pre-`<<2 & 0x3fff` smart delta (see
// animation_frame_sets.ts) — apply that promotion here, at the point of use,
// exactly like the client does at decode time.
function resolveTransformDelta(type: number, raw: number): number {
  if (type === 2 || type === 9) return (raw << 2) & 0x3fff
  return raw
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

export function applyAnimationFrame(model: ModelData, frameBase: AnimationFrameBaseDef, frame: AnimationFrameDef): PosedVertices | null {
  if (!model.vertexSkins || frame.rawFallbackBytes) return null

  const { vertexGroups, faceGroups } = skinGroupsFor(model)

  function verticesForSlot(slot: number): number[] {
    const labels = frameBase.labels[slot] ?? []
    const vertices: number[] = []
    for (const label of labels) {
      const group = vertexGroups[label]
      if (group) vertices.push(...group)
    }
    return vertices
  }

  function facesForSlot(slot: number): number[] {
    if (!faceGroups) return []
    const labels = frameBase.labels[slot] ?? []
    const faces: number[] = []
    for (const label of labels) {
      const group = faceGroups[label]
      if (group) faces.push(...group)
    }
    return faces
  }

  const state: PoseState = {
    x: Int32Array.from(model.vertexX),
    y: Int32Array.from(model.vertexY),
    z: Int32Array.from(model.vertexZ),
    originX: 0, originY: 0, originZ: 0,
    withinOrigin: false,
    upscaled: false,
  }
  // Copied lazily on the first face-group transform.
  let faceAlpha: Int8Array | null = null
  let faceColor: Uint16Array | null = null

  for (let i = 0; i < frame.transformationIndices.length; i++) {
    const slot = frame.transformationIndices[i]
    const type = frameBase.transformationTypes[slot]

    // Before EVERY transform entry (regardless of its type — the client's
    // driver in Model.kt runs this unconditionally), re-establish the
    // current origin from a DIFFERENT slot's live vertex positions (a
    // zero-delta type-0 pass), keyed by frame.skippedReferences[i]
    // (confusingly also called "labels" in AnimFrame.kt, NOT the same thing
    // as AnimationFrameBaseDef.labels). Skipping this lets the origin drift
    // stale across branches of the skeleton (e.g. legs -> neck, or across a
    // face-effect entry), which produced stretched/spiked geometry
    // (terrorbird capture) and gaping chathead jaws when type-5 blinks sat
    // between rotation entries.
    const skipSlot = frame.skippedReferences[i]
    if (skipSlot != null && skipSlot !== -1) {
      applyTransform(state, model.vertexCount, 0, verticesForSlot(skipSlot), 0, 0, 0)
    }

    // Face-group effects (darkan ModelSM.animateTransform types 5/7).
    if (type === 5) {
      faceAlpha ??= Int8Array.from(model.faceAlpha)
      const delta = frame.transformationX[i]
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
      const dh = frame.transformationX[i], ds = frame.transformationY[i], dl = frame.transformationZ[i]
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

    const x = resolveTransformDelta(type, frame.transformationX[i])
    const y = resolveTransformDelta(type, frame.transformationY[i])
    const z = resolveTransformDelta(type, frame.transformationZ[i])
    applyTransform(state, model.vertexCount, type, verticesForSlot(slot), x, y, z)
  }

  if (state.upscaled) {
    for (let v = 0; v < model.vertexCount; v++) {
      state.x[v] >>= 4
      state.y[v] >>= 4
      state.z[v] >>= 4
    }
  }

  return { x: state.x, y: state.y, z: state.z, faceAlpha, faceColor }
}
