import type { ModelData } from '../loaders/models'

// Standalone port of the client's texture-mapping UV generation
// (MeshRasterizer.method11256/11271/11306/11255 in the darkan client) for use
// by the map scene's merged loc geometry. ModelViewer.tsx carries an older
// inline copy of the same math inside its build effect — consolidating it on
// this module is a pending cleanup (see TODO.md).

function jagexNormalSpace(
  nx: number, ny: number, nz: number,
  rotByte: number,
  sx: number, sy: number, sz: number,
): number[] {
  const rotCos = Math.cos(rotByte * 0.024543693)
  const rotSin = Math.sin(rotByte * 0.024543693)
  const rot = [rotCos, 0, rotSin, 0, 1, 0, -rotSin, 0, rotCos]

  let space: number[]
  const mNorm = ny / 32767.0
  const pnNormNeg = -Math.sqrt(1.0 - Math.min(1, mNorm * mNorm))
  const oneMinusM = 1.0 - mNorm
  const pn = Math.sqrt(nx * nx + nz * nz)
  if (pn === 0 && mNorm === 0) {
    space = rot
  } else {
    let nNormNeg = 1.0
    let pNorm = 0.0
    if (pn !== 0) {
      nNormNeg = -nz / pn
      pNorm = nx / pn
    }
    const n = [
      mNorm + nNormNeg * nNormNeg * oneMinusM,
      pNorm * pnNormNeg,
      pNorm * nNormNeg * oneMinusM,
      -pNorm * pnNormNeg,
      mNorm,
      nNormNeg * pnNormNeg,
      nNormNeg * pNorm * oneMinusM,
      -nNormNeg * pnNormNeg,
      mNorm + pNorm * pNorm * oneMinusM,
    ]
    space = [
      rot[0] * n[0] + rot[1] * n[3] + rot[2] * n[6],
      rot[0] * n[1] + rot[1] * n[4] + rot[2] * n[7],
      rot[0] * n[2] + rot[1] * n[5] + rot[2] * n[8],
      rot[3] * n[0] + rot[4] * n[3] + rot[5] * n[6],
      rot[3] * n[1] + rot[4] * n[4] + rot[5] * n[7],
      rot[3] * n[2] + rot[4] * n[5] + rot[5] * n[8],
      rot[6] * n[0] + rot[7] * n[3] + rot[8] * n[6],
      rot[6] * n[1] + rot[7] * n[4] + rot[8] * n[7],
      rot[6] * n[2] + rot[7] * n[5] + rot[8] * n[8],
    ]
  }

  space[0] *= sx; space[1] *= sx; space[2] *= sx
  space[3] *= sy; space[4] *= sy; space[5] *= sy
  space[6] *= sz; space[7] *= sz; space[8] *= sz
  return space
}

export type UVWriter = (f: number, ia: number, ib: number, ic: number, out: number[] | Float32Array, base6: number) => void

/** Builds a per-face UV writer for one model. */
export function makeUVWriter(model: ModelData): UVWriter {
  const { vertexCount, faceCount, vertexX, vertexY, vertexZ, triangleX, triangleY, triangleZ,
    texturePos, textureP, textureM, textureN,
    textureRenderTypes, textureNormalX, textureNormalY, textureNormalZ,
    textureScaleX, textureScaleY, textureScaleZ, textureRotation,
    textureDirection, textureSpeed, textureTransU, textureTransV } = model

  const mappingCount = textureRenderTypes?.length ?? 0
  type Mapping = { space: number[]; sx: number; sy: number; sz: number }
  const mappings: (Mapping | null)[] = new Array(mappingCount).fill(null)
  const mappingCenter = new Float64Array(mappingCount * 3)
  if (mappingCount > 0 && texturePos) {
    const min = new Float64Array(mappingCount * 3).fill(Infinity)
    const max = new Float64Array(mappingCount * 3).fill(-Infinity)
    for (let f = 0; f < faceCount; f++) {
      const pos = texturePos[f]
      if (pos < 0 || pos >= mappingCount) continue
      const b = pos * 3
      for (const v of [triangleX[f], triangleY[f], triangleZ[f]]) {
        if (v < 0 || v >= vertexCount) continue
        if (vertexX[v] < min[b])     min[b]     = vertexX[v]
        if (vertexX[v] > max[b])     max[b]     = vertexX[v]
        if (vertexY[v] < min[b + 1]) min[b + 1] = vertexY[v]
        if (vertexY[v] > max[b + 1]) max[b + 1] = vertexY[v]
        if (vertexZ[v] < min[b + 2]) min[b + 2] = vertexZ[v]
        if (vertexZ[v] > max[b + 2]) max[b + 2] = vertexZ[v]
      }
    }
    for (let m = 0; m < mappingCount; m++) {
      const type = textureRenderTypes![m] & 0xFF
      if (type < 1 || type > 3) continue
      const rawX = textureScaleX![m], rawY = textureScaleY![m], rawZ = textureScaleZ![m]
      let sx = 1, sy = 1, sz = 1
      if (type === 1) {
        if (rawX > 0) { sx = 1; sz = rawX / 1024 }
        else if (rawX < 0) { sx = -rawX / 1024; sz = 1 }
        sy = 64 / rawY
      } else if (type === 2) {
        sx = 64 / rawX
        sy = 64 / rawY
        sz = 64 / rawZ
      } else {
        sx = rawX / 1024; sy = rawY / 1024; sz = rawZ / 1024
      }
      if (!isFinite(sx)) sx = 1
      if (!isFinite(sy)) sy = 1
      if (!isFinite(sz)) sz = 1
      const space = jagexNormalSpace(
        textureNormalX![m], textureNormalY![m], textureNormalZ![m],
        textureRotation![m] & 0xFF, sx, sy, sz,
      )
      mappings[m] = { space, sx, sy, sz }
      const b = m * 3
      if (min[b] <= max[b]) {
        mappingCenter[b]     = Math.trunc((min[b]     + max[b])     / 2)
        mappingCenter[b + 1] = Math.trunc((min[b + 1] + max[b + 1]) / 2)
        mappingCenter[b + 2] = Math.trunc((min[b + 2] + max[b + 2]) / 2)
      }
    }
  }

  const proj = new Float64Array(3)
  function projectCorner(space: number[], mb: number, v: number) {
    const x = vertexX[v] - mappingCenter[mb]
    const y = vertexY[v] - mappingCenter[mb + 1]
    const z = vertexZ[v] - mappingCenter[mb + 2]
    proj[0] = space[0] * x + space[1] * y + space[2] * z
    proj[1] = space[3] * x + space[4] * y + space[5] * z
    proj[2] = space[6] * x + space[7] * y + space[8] * z
  }

  const swizzled: [number, number] = [0, 0]
  function swizzleUV(u: number, v: number, dir: number) {
    if (dir === 1)      { swizzled[0] = -v; swizzled[1] = u }
    else if (dir === 2) { swizzled[0] = -u; swizzled[1] = -v }
    else if (dir === 3) { swizzled[0] = v;  swizzled[1] = -u }
    else                { swizzled[0] = u;  swizzled[1] = v }
  }

  function writePlanarUVs(P: number, M: number, N: number, ia: number, ib: number, ic: number, out: number[] | Float32Array, base6: number) {
    const px = vertexX[P], py = vertexY[P], pz = vertexZ[P]
    const mx = vertexX[M] - px, my = vertexY[M] - py, mz = vertexZ[M] - pz
    const nx = vertexX[N] - px, ny = vertexY[N] - py, nz = vertexZ[N] - pz
    const cx = my * nz - mz * ny
    const cy = mz * nx - mx * nz
    const cz = mx * ny - my * nx
    const ux = ny * cz - nz * cy, uy = nz * cx - nx * cz, uz = nx * cy - ny * cx
    const vx = my * cz - mz * cy, vy = mz * cx - mx * cz, vz = mx * cy - my * cx
    const uDen = ux * mx + uy * my + uz * mz
    const vDen = vx * nx + vy * ny + vz * nz
    const corners = [ia, ib, ic]
    for (let i = 0; i < 3; i++) {
      const dx = vertexX[corners[i]] - px
      const dy = vertexY[corners[i]] - py
      const dz = vertexZ[corners[i]] - pz
      out[base6 + i * 2]     = uDen !== 0 ? (ux * dx + uy * dy + uz * dz) / uDen : 0
      out[base6 + i * 2 + 1] = vDen !== 0 ? (vx * dx + vy * dy + vz * dz) / vDen : 0
    }
  }

  return function writeUVs(f: number, ia: number, ib: number, ic: number, out: number[] | Float32Array, base6: number) {
    const pos = texturePos?.[f] ?? -1

    if (pos < 0) {
      out[base6]     = 0; out[base6 + 1] = 1
      out[base6 + 2] = 1; out[base6 + 3] = 1
      out[base6 + 4] = 0; out[base6 + 5] = 0
      return
    }

    const type = pos < mappingCount ? textureRenderTypes![pos] & 0xFF : 0
    const mapping = pos < mappingCount ? mappings[pos] : null

    if (type >= 1 && type <= 3 && mapping) {
      const { space, sx, sy, sz } = mapping
      const mb = pos * 3
      const dir = textureDirection![pos]
      const speed = textureSpeed![pos] / 256
      const corners = [ia, ib, ic]
      const u = [0, 0, 0], v = [0, 0, 0]

      if (type === 1) {
        const wrapMul = textureScaleZ![pos] / 1024
        for (let i = 0; i < 3; i++) {
          projectCorner(space, mb, corners[i])
          let cu = Math.atan2(proj[0], proj[2]) / 6.2831855 + 0.5
          if (wrapMul !== 1) cu *= wrapMul
          const cv = proj[1] + 0.5 + speed
          swizzleUV(cu, cv, dir)
          u[i] = swizzled[0]; v[i] = swizzled[1]
        }
        const half = wrapMul / 2
        if ((dir & 0x1) === 0) {
          if (u[1] - u[0] > half) u[1] -= wrapMul
          else if (u[0] - u[1] > half) u[1] += wrapMul
          if (u[2] - u[0] > half) u[2] -= wrapMul
          else if (u[0] - u[2] > half) u[2] += wrapMul
        } else {
          if (v[1] - v[0] > half) v[1] -= wrapMul
          else if (v[0] - v[1] > half) v[1] += wrapMul
          if (v[2] - v[0] > half) v[2] -= wrapMul
          else if (v[0] - v[2] > half) v[2] += wrapMul
        }
      } else if (type === 2) {
        const transU = textureTransU![pos] / 256
        const transV = textureTransV![pos] / 256
        const e1x = vertexX[ib] - vertexX[ia], e1y = vertexY[ib] - vertexY[ia], e1z = vertexZ[ib] - vertexZ[ia]
        const e2x = vertexX[ic] - vertexX[ia], e2y = vertexY[ic] - vertexY[ia], e2z = vertexZ[ic] - vertexZ[ia]
        const nx = e1y * e2z - e2y * e1z
        const ny = e1z * e2x - e2z * e1x
        const nz = e1x * e2y - e2x * e1y
        const fx = (nx * space[0] + ny * space[1] + nz * space[2]) / sx
        const fy = (nx * space[3] + ny * space[4] + nz * space[5]) / sy
        const fz = (nx * space[6] + ny * space[7] + nz * space[8]) / sz
        const ax = Math.abs(fx), ay = Math.abs(fy), az = Math.abs(fz)
        const axis = ay > ax && ay > az ? (fy > 0 ? 0 : 1)
                   : az > ax && az > ay ? (fz > 0 ? 2 : 3)
                   : (fx > 0 ? 4 : 5)
        for (let i = 0; i < 3; i++) {
          projectCorner(space, mb, corners[i])
          let cu: number, cv: number
          if (axis === 0)      { cu =  proj[0] + speed + 0.5; cv = -proj[2] + transV + 0.5 }
          else if (axis === 1) { cu =  proj[0] + speed + 0.5; cv =  proj[2] + transV + 0.5 }
          else if (axis === 2) { cu = -proj[0] + speed + 0.5; cv = -proj[1] + transU + 0.5 }
          else if (axis === 3) { cu =  proj[0] + speed + 0.5; cv = -proj[1] + transU + 0.5 }
          else if (axis === 4) { cu =  proj[2] + transV + 0.5; cv = -proj[1] + transU + 0.5 }
          else                 { cu = -proj[2] + transV + 0.5; cv = -proj[1] + transU + 0.5 }
          swizzleUV(cu, cv, dir)
          u[i] = swizzled[0]; v[i] = swizzled[1]
        }
      } else {
        for (let i = 0; i < 3; i++) {
          projectCorner(space, mb, corners[i])
          const len = Math.sqrt(proj[0] * proj[0] + proj[1] * proj[1] + proj[2] * proj[2])
          const cu = Math.atan2(proj[0], proj[2]) / 6.2831855 + 0.5
          const cv = Math.asin(proj[1] / len) / 3.1415927 + 0.5 + speed
          swizzleUV(cu, cv, dir)
          u[i] = swizzled[0]; v[i] = swizzled[1]
        }
        if ((dir & 0x1) === 0) {
          if (u[1] - u[0] > 0.5) u[1]--
          else if (u[0] - u[1] > 0.5) u[1]++
          if (u[2] - u[0] > 0.5) u[2]--
          else if (u[0] - u[2] > 0.5) u[2]++
        } else {
          if (v[1] - v[0] > 0.5) v[1]--
          else if (v[0] - v[1] > 0.5) v[1]++
          if (v[2] - v[0] > 0.5) v[2]--
          else if (v[0] - v[2] > 0.5) v[2]++
        }
      }

      for (let i = 0; i < 3; i++) {
        out[base6 + i * 2]     = u[i]
        out[base6 + i * 2 + 1] = v[i]
      }
      return
    }

    let P = ia, M = ib, N = ic
    if (textureP && pos < textureP.length && type === 0) {
      P = textureP[pos]; M = textureM![pos]; N = textureN![pos]
      if (P >= vertexCount || M >= vertexCount || N >= vertexCount) { P = ia; M = ib; N = ic }
    }
    writePlanarUVs(P, M, N, ia, ib, ic, out, base6)
  }
}
