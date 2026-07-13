import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import './ModelViewer.css'

type Props = { data: ModelData }

// Builds the 3×3 matrix transforming model space into texture-projection
// space from a packed normal, rotation byte, and per-axis scale. Ported from
// the darkan client's MeshRasterizer.method11257 — the odd math is
// implementation-defined, do not "fix" it.
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

export default function ModelViewer({ data }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const matsRef = useRef<THREE.MeshBasicMaterial[]>([])
  const [wireframe, setWireframe] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const w = mount.clientWidth || 800
    const h = mount.clientHeight || 600

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000)
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100000)

    // --- Build geometry ---
    const { vertexCount, faceCount, vertexX, vertexY, vertexZ,
            triangleX, triangleY, triangleZ, faceColor,
            faceTextures, texturePos, textureP, textureM, textureN } = data

    // Bucket faces by texture id; -1 = flat face colour. Textures whose PNG
    // is missing from the cache fall back to the colour bucket.
    const buckets = new Map<number, number[]>()
    for (let f = 0; f < faceCount; f++) {
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount)
        continue
      let tex = faceTextures?.[f] ?? -1
      if (tex >= 0 && !data.textures.has(tex)) tex = -1
      const bucket = buckets.get(tex)
      if (bucket) bucket.push(f)
      else buckets.set(tex, [f])
    }

    const bucketOrder = [...buckets.keys()].sort((a, b) => a - b) // -1 first
    const validFaces = [...buckets.values()].reduce((n, b) => n + b.length, 0)

    const positions = new Float32Array(validFaces * 9)
    const colors    = new Float32Array(validFaces * 9)
    const uvs       = new Float32Array(validFaces * 6)

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    // Precompute the texture-space transform for each projection mapping
    // (types 1-3). Each also needs the centre of the vertices it paints.
    // Mirrors MeshRasterizer.method11256 in the darkan client.
    const { textureRenderTypes, textureNormalX, textureNormalY, textureNormalZ,
            textureScaleX, textureScaleY, textureScaleZ, textureRotation,
            textureDirection, textureSpeed, textureTransU, textureTransV } = data
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

    // UV axis swizzle applied by the client after every projection
    // (MeshRasterizer.method11271 / 11306 / 11255, parameter i_8/i_9).
    const swizzled: [number, number] = [0, 0]
    function swizzleUV(u: number, v: number, dir: number) {
      if (dir === 1)      { swizzled[0] = -v; swizzled[1] = u }
      else if (dir === 2) { swizzled[0] = -u; swizzled[1] = -v }
      else if (dir === 3) { swizzled[0] = v;  swizzled[1] = -u }
      else                { swizzled[0] = u;  swizzled[1] = v }
    }

    // Planar UVs: project each corner onto the texture triangle. P is the
    // texture origin, P→M the U axis, P→N the V axis.
    function writePlanarUVs(P: number, M: number, N: number, ia: number, ib: number, ic: number, base6: number) {
      const px = vertexX[P], py = vertexY[P], pz = vertexZ[P]
      const mx = vertexX[M] - px, my = vertexY[M] - py, mz = vertexZ[M] - pz
      const nx = vertexX[N] - px, ny = vertexY[N] - py, nz = vertexZ[N] - pz
      // normal = pM × pN
      const cx = my * nz - mz * ny
      const cy = mz * nx - mx * nz
      const cz = mx * ny - my * nx
      // uAxis = pN × normal, vAxis = pM × normal
      const ux = ny * cz - nz * cy, uy = nz * cx - nx * cz, uz = nx * cy - ny * cx
      const vx = my * cz - mz * cy, vy = mz * cx - mx * cz, vz = mx * cy - my * cx
      const uDen = ux * mx + uy * my + uz * mz
      const vDen = vx * nx + vy * ny + vz * nz
      const corners = [ia, ib, ic]
      for (let i = 0; i < 3; i++) {
        const dx = vertexX[corners[i]] - px
        const dy = vertexY[corners[i]] - py
        const dz = vertexZ[corners[i]] - pz
        uvs[base6 + i * 2]     = uDen !== 0 ? (ux * dx + uy * dy + uz * dz) / uDen : 0
        uvs[base6 + i * 2 + 1] = vDen !== 0 ? (vx * dx + vy * dy + vz * dz) / vDen : 0
      }
    }

    function writeUVs(f: number, ia: number, ib: number, ic: number, base6: number) {
      const pos = texturePos?.[f] ?? -1

      if (pos < 0) {
        // No mapping: the client hardcodes these corner UVs.
        uvs[base6]     = 0; uvs[base6 + 1] = 1
        uvs[base6 + 2] = 1; uvs[base6 + 3] = 1
        uvs[base6 + 4] = 0; uvs[base6 + 5] = 0
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
          // Cylinder (MeshRasterizer.method11306). The wrap multiplier is the
          // raw Z scale value, not part of the matrix.
          const wrapMul = textureScaleZ![pos] / 1024
          for (let i = 0; i < 3; i++) {
            projectCorner(space, mb, corners[i])
            let cu = Math.atan2(proj[0], proj[2]) / 6.2831855 + 0.5
            if (wrapMul !== 1) cu *= wrapMul
            const cv = proj[1] + 0.5 + speed
            swizzleUV(cu, cv, dir)
            u[i] = swizzled[0]; v[i] = swizzled[1]
          }
          // Seam wrap fix: pull corners that landed a full period away back.
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
          // Cube (MeshRasterizer.method11255): pick the cube face whose axis
          // best matches the face normal, then project onto that face.
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
          // Sphere (MeshRasterizer.method11271).
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
          uvs[base6 + i * 2]     = u[i]
          uvs[base6 + i * 2 + 1] = v[i]
        }
        return
      }

      let P = ia, M = ib, N = ic
      if (textureP && pos < textureP.length && type === 0) {
        P = textureP[pos]; M = textureM![pos]; N = textureN![pos]
        if (P >= vertexCount || M >= vertexCount || N >= vertexCount) { P = ia; M = ib; N = ic }
      }
      writePlanarUVs(P, M, N, ia, ib, ic, base6)
    }

    const groups: { start: number; count: number; tex: number }[] = []
    let vert = 0

    for (const tex of bucketOrder) {
      const faces = buckets.get(tex)!
      groups.push({ start: vert, count: faces.length * 3, tex })

      for (const f of faces) {
        const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]

        // OSRS: Y is down, and models face away from the default camera — negate
        // Y to flip upright and X/Z to spin 180° so the model faces the viewer.
        const ax = -vertexX[ia], ay = -vertexY[ia], az = -vertexZ[ia]
        const bx = -vertexX[ib], by = -vertexY[ib], bz = -vertexZ[ib]
        const cx = -vertexX[ic], cy = -vertexY[ic], cz = -vertexZ[ic]

        const base = vert * 3
        positions[base]     = ax; positions[base + 1] = ay; positions[base + 2] = az
        positions[base + 3] = bx; positions[base + 4] = by; positions[base + 5] = bz
        positions[base + 6] = cx; positions[base + 7] = cy; positions[base + 8] = cz

        for (const x of [ax, bx, cx]) { if (x < minX) minX = x; if (x > maxX) maxX = x }
        for (const y of [ay, by, cy]) { if (y < minY) minY = y; if (y > maxY) maxY = y }
        for (const z of [az, bz, cz]) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }

        // Face colour tints the material texture — the dumped material images
        // are greyscale detail maps and the client multiplies them by face HSL.
        const rgb = hslToRgb(faceColor[f])
        const r = ((rgb >> 16) & 0xFF) / 255
        const g = ((rgb >> 8)  & 0xFF) / 255
        const b =  (rgb        & 0xFF) / 255
        colors[base]     = r; colors[base + 1] = g; colors[base + 2] = b
        colors[base + 3] = r; colors[base + 4] = g; colors[base + 5] = b
        colors[base + 6] = r; colors[base + 7] = g; colors[base + 8] = b

        if (tex >= 0) writeUVs(f, ia, ib, ic, vert * 2)

        vert += 3
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3))
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2))
    geo.computeVertexNormals()

    // One material per group: flat vertex colours, or the texture's material PNG.
    const wireframe = matsRef.current[0]?.wireframe ?? false
    const materials: THREE.MeshBasicMaterial[] = []
    const loadedTextures: THREE.Texture[] = []
    let disposed = false

    groups.forEach((g, i) => {
      geo.addGroup(g.start, g.count, i)
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        wireframe,
      })
      materials.push(mat)

      if (g.tex >= 0) {
        const blob = data.textures.get(g.tex)!
        createImageBitmap(blob).then((bitmap) => {
          if (disposed) { bitmap.close(); return }
          const texture = new THREE.Texture(bitmap)
          texture.wrapS = THREE.RepeatWrapping
          texture.wrapT = THREE.RepeatWrapping
          texture.colorSpace = THREE.SRGBColorSpace
          texture.needsUpdate = true
          loadedTextures.push(texture)
          mat.map = texture
          mat.needsUpdate = true
        })
      }
    })

    matsRef.current = materials
    const mesh = new THREE.Mesh(geo, materials)
    scene.add(mesh)

    const cx2 = (minX + maxX) / 2
    const cy2 = (minY + maxY) / 2
    const cz2 = (minZ + maxZ) / 2
    mesh.position.set(-cx2, -cy2, -cz2)

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)
    camera.position.set(0, 0, span * 2.5)
    camera.near = span * 0.001
    camera.far  = span * 100
    camera.updateProjectionMatrix()

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1

    let animId: number
    function animate() {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    })
    ro.observe(mount)

    return () => {
      disposed = true
      cancelAnimationFrame(animId)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      geo.dispose()
      for (const texture of loadedTextures) texture.dispose()
      for (const material of materials) material.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [data])

  useEffect(() => {
    for (const material of matsRef.current) material.wireframe = wireframe
  }, [wireframe])

  return (
    <div className="model-viewer">
      <div className="model-header">
        <span className="model-id">Model {data.id}</span>
        <span className="model-stats">{data.vertexCount} verts · {data.faceCount} faces</span>
        <span className="model-hint">Drag to rotate · Scroll to zoom · Right-drag to pan</span>
      </div>
      <div ref={mountRef} className="model-canvas" />
      <div className="model-toolbar">
        <button
          className={`model-toolbar-btn${wireframe ? ' active' : ''}`}
          onClick={() => setWireframe(v => !v)}
        >
          Wireframe
        </button>
      </div>
    </div>
  )
}
