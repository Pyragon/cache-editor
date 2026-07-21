import type { ModelData } from './models'
import type { AnimationFrameBaseDef } from './animation_frame_bases'
import type { AnimationFrameDef } from './animation_frame_sets'

// Applies one animation frame's bone-group transforms to a model's vertices —
// ports darkan ModelSM.kt's animateTransform (the non-interpolated, single-
// frame playback path; interpolateFrames' tweened blend between two frames
// and the BAS equipment-matrix branches inside animateTransform, both gated
// on data this project doesn't build yet, are NOT ported — see the TODO
// note where they'd hook in). Only transform types that move vertices are
// implemented (0 origin marker, 1 translate, 2 rotate, 3 scale); types 5/7
// (face alpha/colour) and 8/9/10 (billboard offset/rotate/scale) are
// face-group/billboard-group effects, not vertex deformation, and are
// skipped — a model played through this only shows its skeletal pose, not
// those secondary effects.
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
  // types 5/7/8/9/10 (alpha, colour, billboard offset/rotate/scale) intentionally not implemented — see file header.
}

// Type 2/9 store the raw pre-`<<2 & 0x3fff` smart delta (see
// animation_frame_sets.ts) — apply that promotion here, at the point of use,
// exactly like the client does at decode time.
function resolveTransformDelta(type: number, raw: number): number {
  if (type === 2 || type === 9) return (raw << 2) & 0x3fff
  return raw
}

export type PosedVertices = { x: Int32Array; y: Int32Array; z: Int32Array }

// Applies every transform in one frame to a model's vertices, in order, and
// returns the posed positions (same array length/order as model.vertexX/Y/Z,
// same coordinate scale — already downscaled back from the transform math's
// internal fixed-point precision).
export function applyAnimationFrame(model: ModelData, frameBase: AnimationFrameBaseDef, frame: AnimationFrameDef): PosedVertices | null {
  if (!model.vertexSkins || frame.rawFallbackBytes) return null

  const vertexGroups = buildVertexGroups(model.vertexSkins, model.vertexCount)

  function verticesForSlot(slot: number): number[] {
    const labels = frameBase.labels[slot] ?? []
    const vertices: number[] = []
    for (const label of labels) {
      const group = vertexGroups[label]
      if (group) vertices.push(...group)
    }
    return vertices
  }

  const state: PoseState = {
    x: Int32Array.from(model.vertexX),
    y: Int32Array.from(model.vertexY),
    z: Int32Array.from(model.vertexZ),
    originX: 0, originY: 0, originZ: 0,
    withinOrigin: false,
    upscaled: false,
  }

  for (let i = 0; i < frame.transformationIndices.length; i++) {
    const slot = frame.transformationIndices[i]
    const type = frameBase.transformationTypes[slot]

    // Before certain transforms, the client re-establishes the current
    // origin from a DIFFERENT slot's live vertex positions (a zero-delta
    // type-0 pass) — darkan Model.kt's single-frame driver, keyed by
    // frame.skippedReferences[i] (confusingly also called "labels" in
    // AnimFrame.kt, NOT the same thing as AnimationFrameBaseDef.labels).
    // Skipping this lets the origin drift stale across branches of the
    // skeleton (e.g. legs -> neck), which is what was producing the
    // stretched/spiked geometry on models whose hierarchy isn't purely
    // linear (confirmed against a live terrorbird capture).
    const skipSlot = frame.skippedReferences[i]
    if (skipSlot != null && skipSlot !== -1) {
      applyTransform(state, model.vertexCount, 0, verticesForSlot(skipSlot), 0, 0, 0)
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

  return { x: state.x, y: state.y, z: state.z }
}
