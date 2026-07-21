import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import type { ParticleProducer, ParticleType } from '../loaders/particles'
import { PARTICLE_FPS_DEFAULT, PARTICLE_FPS_KEY, PARTICLE_FPS_OPTIONS, ParticleSim } from './particleSim'
import type { Effector } from './particleSim'
import { useZoom } from './useZoom'
import './ModelViewer.css'

// An item's 2D display params (ItemDefinitions), applied as an "item pose":
// how the client renders this model as an inventory icon. Rotations are in
// 2048ths of a circle, resizes in 128ths, zoom is the camera distance.
export type ModelDisplayParams = {
  label: string
  zoom: number
  rotationX: number
  rotationY: number
  rotationZ: number
  offsetX: number
  offsetY: number
  resizeX: number
  resizeY: number
  resizeZ: number
  /** Lighting params (client: createMeshRasterizer(…, 64 + ambient, 768 + contrast·5)). */
  ambient: number
  contrast: number
  /** Paired HSL16 face recolours (client recolour(from, to) on the icon mesh). */
  recolorFrom: number[]
  recolorTo: number[]
  /** Paired texture swaps (client retexture(from, to) on the icon mesh). */
  retextureFrom: number[]
  retextureTo: number[]
  /** Swap-target renders + scroll speeds, loaded by the opener — the model's
      own loader only fetches textures the mesh itself references. */
  retextureBlobs?: Map<number, Blob>
  retextureSpeeds?: Map<number, { u: number; v: number }>
}

// The client projects icons through a 512-focal / 32px-tall viewport
// (ItemDefinitions.getSprite → method6531(16, 16, 512, 512, ...)), i.e. a
// near-orthographic 2·atan(16/512) ≈ 3.6° vertical FOV.
const ICON_FOV = 2 * Math.atan(16 / 512) * (180 / Math.PI)

// The palette RGB is a display (sRGB) value, but three's renderer works in
// linear space and gamma-encodes on output — vertex colours fed in as-is get
// double-encoded and wash out (~a whole gamma too bright vs the client).
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export type CameraState = { position: [number, number, number]; target: [number, number, number] }

type Props = {
  data: ModelData
  display?: ModelDisplayParams | null
  /** Animated vertex positions (skeletalAnimation.ts) applied in place to the
   *  live geometry — same length/order as data.vertexX/Y/Z. Changing this does
   *  NOT rebuild the Three.js scene; null/undefined shows the rest pose. */
  posedVertices?: PosedVertices | null
  /** When set, the orbit camera saves into / restores from this ref across
   *  scene rebuilds (e.g. reloading a different model into the same viewer) —
   *  so the user's rotation survives instead of resetting to the default view. */
  cameraStateRef?: React.MutableRefObject<CameraState | null>
}

// Per-particle size, tint and alpha need a shader — THREE.Points only supports a
// uniform size. `uScale` converts a world-space diameter to gl_PointSize pixels.
const PARTICLE_VERT = `
  attribute float psize;
  attribute vec4 pcolor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * (uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`
const PARTICLE_FRAG = `
  uniform sampler2D map;
  varying vec4 vColor;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor.rgb * tex.rgb, vColor.a * tex.a);
  }
`

// Fallback when a producer has no material: a soft radial dot, which is what most
// particle materials look like anyway.
function makeDotTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.5)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

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

export default function ModelViewer({ data, display, posedVertices, cameraStateRef }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const matsRef = useRef<THREE.MeshBasicMaterial[]>([])
  // Decoded material textures, keyed by texture id and kept across scene
  // rebuilds (e.g. reloading a different model that shares texture ids) —
  // without this, each rebuild re-decoded every texture from scratch via
  // createImageBitmap, and since that's async, the model visibly rendered
  // flat-coloured (no texture) for a moment. Only disposed on true unmount,
  // or when a texture id's blob actually changes underneath it.
  const textureCacheRef = useRef(new Map<number, { blob: Blob; texture: THREE.Texture }>())
  useEffect(() => () => {
    for (const { texture } of textureCacheRef.current.values()) texture.dispose()
    textureCacheRef.current.clear()
  }, [])
  const [wireframe, setWireframe] = useState(false)
  const [applyPose, setApplyPose] = useState(true)
  // The scene-build closure that applies an animated pose in place. The build
  // effect deliberately does NOT depend on posedVertices — frame changes only
  // rewrite the existing position buffer (and re-anchor billboards/emitters)
  // through this ref, never rebuild the scene.
  const applyPosedFnRef = useRef<((posed: PosedVertices | null) => void) | null>(null)
  const [particles, setParticles] = useState(true)
  const particlesRef = useRef(true)
  const particleObjectsRef = useRef<THREE.Points[]>([])

  // Caps how often the particle sims step and re-upload their GPU buffers. The
  // scene itself still renders every RAF so orbiting stays smooth; the sim keeps
  // real-time speed by batching cycles. Shared setting with the particles page.
  const [particleFps, setParticleFps] = useZoom(PARTICLE_FPS_KEY, PARTICLE_FPS_OPTIONS, PARTICLE_FPS_DEFAULT)
  const particleFpsRef = useRef(particleFps)
  useEffect(() => { particleFpsRef.current = particleFps }, [particleFps])

  const emitterCount = data.emitters?.filter((e) => data.emitterProducers.has(e.producerId)).length ?? 0

  // A fresh navigation with display params starts posed.
  useEffect(() => { setApplyPose(true) }, [display])

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

    // Item pose (inventory-icon display params), resolved up front because the
    // item's recolours dye the face colours during the geometry build below.
    const pose = display && applyPose ? display : null
    const recolor = new Map<number, number>()
    if (pose) pose.recolorFrom.forEach((from, i) => recolor.set(from & 0xffff, pose.recolorTo[i] & 0xffff))
    const faceHsl = (f: number) => {
      const hsl = faceColor[f] & 0xffff
      return recolor.get(hsl) ?? hsl
    }
    // Texture swaps ride the same toggle; swapped-in renders come from the pose
    // (retextureBlobs) since data.textures only holds the mesh's own ids.
    const retexture = new Map<number, number>()
    if (pose) pose.retextureFrom.forEach((from, i) => retexture.set(from, pose.retextureTo[i]))
    const textureBlob = (id: number): Blob | undefined =>
      pose?.retextureBlobs?.get(id) ?? data.textures.get(id)

    // Icon lighting (client MeshRasterizer): the base lightness is scaled by
    // ambient/128 (64 + item ambient — the default *halves* it), then each
    // corner is modulated by 1 + cos·(768 / (768 + 5·contrast)) with cos the
    // averaged vertex normal against the icon light direction (−50, −10, −50).
    // Baked in model space, exactly like the client (the pose matrix comes later).
    let normSumX: Float32Array | null = null
    let normSumY: Float32Array | null = null
    let normSumZ: Float32Array | null = null
    let normCount: Uint16Array | null = null
    if (pose) {
      normSumX = new Float32Array(vertexCount)
      normSumY = new Float32Array(vertexCount)
      normSumZ = new Float32Array(vertexCount)
      normCount = new Uint16Array(vertexCount)
      for (let f = 0; f < faceCount; f++) {
        if (data.faceType && data.faceType[f] === 2) continue
        const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
        if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount)
          continue
        const e1x = vertexX[ib] - vertexX[ia], e1y = vertexY[ib] - vertexY[ia], e1z = vertexZ[ib] - vertexZ[ia]
        const e2x = vertexX[ic] - vertexX[ia], e2y = vertexY[ic] - vertexY[ia], e2z = vertexZ[ic] - vertexZ[ia]
        const nx = e1y * e2z - e2y * e1z
        const ny = e1z * e2x - e2z * e1x
        const nz = e1x * e2y - e2x * e1y
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        if (len === 0) continue
        for (const v of [ia, ib, ic]) {
          normSumX[v] += nx / len
          normSumY[v] += ny / len
          normSumZ[v] += nz / len
          normCount[v]++
        }
      }
    }
    const LIGHT_LEN = Math.sqrt(50 * 50 + 10 * 10 + 50 * 50)
    const LX = -50 / LIGHT_LEN, LY = -10 / LIGHT_LEN, LZ = -50 / LIGHT_LEN
    const ambientScale = 64 + (pose?.ambient ?? 0)
    const diffuseScale = 768 / (768 + 5 * (pose?.contrast ?? 0))
    // Client method13538: rescale the HSL16's 7-bit lightness by ambient/128.
    const litHsl = (hsl: number) => {
      let lum = ((hsl & 0x7f) * ambientScale) >> 7
      if (lum < 2) lum = 2
      else if (lum > 126) lum = 126
      return (hsl & 0xff80) + lum
    }

    // Bucket faces by texture id; -1 = flat face colour. Textures whose PNG
    // is missing from the cache fall back to the colour bucket.
    // Faces replaced by a billboard (hasUid set on its type) aren't rendered —
    // the client skips them and draws only the billboard (ModelSM/darkan).
    const hiddenFaces = new Set<number>()
    if (data.billboards) {
      for (const bb of data.billboards) {
        if (data.billboardTypes.get(bb.typeId)?.def.hasUid) hiddenFaces.add(bb.face)
      }
    }

    const buckets = new Map<number, number[]>()
    for (let f = 0; f < faceCount; f++) {
      if (hiddenFaces.has(f)) continue
      // faceAlpha -1 is 255 unsigned: fully transparent. Most particle-emitter faces
      // are painted a garish marker green and hidden this way — rendering them is
      // wrong for ANY invisible face, emitter or not. (Emitter faces with alpha 0
      // stay visible: lava-style surfaces genuinely show while emitting.)
      if (data.faceAlpha[f] === -1) continue
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount)
        continue
      let tex = faceTextures?.[f] ?? -1
      if (tex >= 0) tex = retexture.get(tex) ?? tex
      if (tex >= 0 && !textureBlob(tex)) tex = -1
      const bucket = buckets.get(tex)
      if (bucket) bucket.push(f)
      else buckets.set(tex, [f])
    }

    const bucketOrder = [...buckets.keys()].sort((a, b) => a - b) // -1 first
    const validFaces = [...buckets.values()].reduce((n, b) => n + b.length, 0)

    const positions = new Float32Array(validFaces * 9)
    const colors    = new Float32Array(validFaces * 9)
    const uvs       = new Float32Array(validFaces * 6)
    // Which model vertex each buffer corner came from — the geometry is
    // non-indexed (corners duplicated per face), so this is the map an
    // animated pose needs to rewrite positions in place.
    const cornerVertex = new Int32Array(validFaces * 3)

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

        // RS → Three is (x, −y, −z): a pure 180° rotation about X. Y-down flips
        // upright and the client's +z view direction becomes our −z, so the
        // default camera sees exactly what the client camera sees. (Negating x
        // as well — the old mapping — mirrors every model left-to-right.)
        const ax = vertexX[ia], ay = -vertexY[ia], az = -vertexZ[ia]
        const bx = vertexX[ib], by = -vertexY[ib], bz = -vertexZ[ib]
        const cx = vertexX[ic], cy = -vertexY[ic], cz = -vertexZ[ic]

        const base = vert * 3
        positions[base]     = ax; positions[base + 1] = ay; positions[base + 2] = az
        positions[base + 3] = bx; positions[base + 4] = by; positions[base + 5] = bz
        positions[base + 6] = cx; positions[base + 7] = cy; positions[base + 8] = cz
        cornerVertex[vert] = ia; cornerVertex[vert + 1] = ib; cornerVertex[vert + 2] = ic

        for (const x of [ax, bx, cx]) { if (x < minX) minX = x; if (x > maxX) maxX = x }
        for (const y of [ay, by, cy]) { if (y < minY) minY = y; if (y > maxY) maxY = y }
        for (const z of [az, bz, cz]) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }

        // Face colour tints the material texture — the dumped material images
        // are greyscale detail maps and the client multiplies them by face HSL.
        if (pose) {
          // Icon lighting: ambient-scaled base, per-corner diffuse from the
          // smooth vertex normals (client vertex-lit path in MeshRasterizer).
          const rgb = hslToRgb(litHsl(faceHsl(f)))
          const br = (rgb >> 16) & 0xFF
          const bg = (rgb >> 8)  & 0xFF
          const bb =  rgb        & 0xFF
          const cornerIdx = [ia, ib, ic]
          for (let i = 0; i < 3; i++) {
            const v = cornerIdx[i]
            const n = normCount![v]
            const cos = n > 0
              ? (LX * normSumX![v] + LY * normSumY![v] + LZ * normSumZ![v]) / n
              : 0
            const f30 = 1 + cos * diffuseScale
            colors[base + i * 3]     = srgbToLinear(Math.min(Math.max((br * f30) / 255, 0), 1))
            colors[base + i * 3 + 1] = srgbToLinear(Math.min(Math.max((bg * f30) / 255, 0), 1))
            colors[base + i * 3 + 2] = srgbToLinear(Math.min(Math.max((bb * f30) / 255, 0), 1))
          }
        } else {
          const rgb = hslToRgb(faceHsl(f))
          const r = srgbToLinear(((rgb >> 16) & 0xFF) / 255)
          const g = srgbToLinear(((rgb >> 8)  & 0xFF) / 255)
          const b = srgbToLinear((rgb         & 0xFF) / 255)
          colors[base]     = r; colors[base + 1] = g; colors[base + 2] = b
          colors[base + 3] = r; colors[base + 4] = g; colors[base + 5] = b
          colors[base + 6] = r; colors[base + 7] = g; colors[base + 8] = b
        }

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
    // Materials with a UV scroll (the fire cape's flowing lava): the client offsets
    // sampling by seconds * speed / 64 each frame (OpenGlToolkit.renderAnimatedTexture).
    const scrollingTextures: { texture: THREE.Texture; u: number; v: number }[] = []
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
        const blob = textureBlob(g.tex)!
        const speed = pose?.retextureSpeeds?.get(g.tex) ?? data.textureSpeeds.get(g.tex)

        const cached = textureCacheRef.current.get(g.tex)
        if (cached && cached.blob === blob) {
          // same texture as last rebuild (e.g. the previous animation frame)
          // — reuse the already-decoded GPU texture, no async gap.
          if (speed) scrollingTextures.push({ texture: cached.texture, u: speed.u, v: speed.v })
          mat.map = cached.texture
          mat.needsUpdate = true
        } else {
          createImageBitmap(blob).then((bitmap) => {
            if (disposed) { bitmap.close(); return }
            const texture = new THREE.Texture(bitmap)
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.RepeatWrapping
            texture.colorSpace = THREE.SRGBColorSpace
            texture.needsUpdate = true
            cached?.texture.dispose()
            textureCacheRef.current.set(g.tex, { blob, texture })
            if (speed) scrollingTextures.push({ texture, u: speed.u, v: speed.v })
            mat.map = texture
            mat.needsUpdate = true
          })
        }
      }
    })

    matsRef.current = materials
    const mesh = new THREE.Mesh(geo, materials)
    // The pose group lets item display params rotate/scale around the mesh's
    // centred pivot (mesh.position carries the centring offset).
    const poseGroup = new THREE.Group()
    poseGroup.add(mesh)
    scene.add(poseGroup)

    // --- Billboards: camera-facing sprites at their host face's centroid,
    // sized size2d×2 by size3d×2 world units (sizes are half-extents), tinted
    // by the host face colour when blendType 0 ("colour mix"), additive for
    // shape 2 ("brightened"), circle-clipped for shape 1. Added as children of
    // the mesh so they inherit its centering offset.
    const spriteMaterials: THREE.SpriteMaterial[] = []
    const spriteTextures: THREE.Texture[] = []
    // host-face corner indices per sprite, so an animated pose can re-centre it
    const spriteAnchors: { sprite: THREE.Sprite; ia: number; ib: number; ic: number }[] = []
    if (data.billboards) {
      for (const bb of data.billboards) {
        const info = data.billboardTypes.get(bb.typeId)
        if (!info || bb.face < 0 || bb.face >= faceCount) continue
        const { def, material } = info
        const ia = triangleX[bb.face], ib = triangleY[bb.face], ic = triangleZ[bb.face]
        if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue

        const smat = new THREE.SpriteMaterial({
          color: def.blendType === 0 ? hslToRgb(faceHsl(bb.face)) : 0xffffff,
          transparent: true,
          depthWrite: false,
          blending: def.shape === 2 ? THREE.AdditiveBlending : THREE.NormalBlending,
        })
        spriteMaterials.push(smat)
        const sprite = new THREE.Sprite(smat)
        sprite.position.set(
          (vertexX[ia] + vertexX[ib] + vertexX[ic]) / 3,
          -(vertexY[ia] + vertexY[ib] + vertexY[ic]) / 3,
          -(vertexZ[ia] + vertexZ[ib] + vertexZ[ic]) / 3,
        )
        sprite.scale.set(def.size2d * 2, def.size3d * 2, 1)
        sprite.renderOrder = 1
        mesh.add(sprite)
        spriteAnchors.push({ sprite, ia, ib, ic })

        if (material) {
          createImageBitmap(material).then((bitmap) => {
            if (disposed) { bitmap.close(); return }
            let source: CanvasImageSource = bitmap
            if (def.shape === 1) {
              const canvas = document.createElement('canvas')
              canvas.width = bitmap.width
              canvas.height = bitmap.height
              const ctx = canvas.getContext('2d')!
              ctx.beginPath()
              ctx.ellipse(canvas.width / 2, canvas.height / 2, canvas.width / 2, canvas.height / 2, 0, 0, Math.PI * 2)
              ctx.clip()
              ctx.drawImage(bitmap, 0, 0)
              source = canvas
            }
            const texture = new THREE.Texture(source)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.needsUpdate = true
            spriteTextures.push(texture)
            smat.map = texture
            smat.needsUpdate = true
          })
        }
      }
    }

    // --- Particle emitters: run the client's emitter per attached face, spawning
    // from random points on that triangle, and draw the live particles as a point
    // cloud in the model's own space. Same 20ms cycle as the particles page preview.
    type EmitterSystem = {
      sim: ParticleSim
      points: THREE.Points
      positions: Float32Array
      colors: Float32Array
      sizes: Float32Array
      geometry: THREE.BufferGeometry
      material: THREE.ShaderMaterial
    }
    const emitterSystems: EmitterSystem[] = []
    const particleTextures: THREE.Texture[] = []
    const PARTICLE_CAP = 2048
    // spawn-face corners / anchor vertices, so an animated pose can move
    // emitters and effectors with the mesh (particles in flight are kept)
    const simAnchors: { sim: ParticleSim; ia: number; ib: number; ic: number }[] = []
    const effectorAnchors: { effector: Effector; vertex: number }[] = []

    if (data.emitters) {
      // one texture per producer, shared by every emitter using it
      const producerTextures = new Map<number, THREE.Texture>()

      // Effectors: anchored particle types that pull/push this model's particles
      // (wind sway, attractors). Shared by every sim; each pre-filters to the ones
      // its producer actually listens to. Direction is the type's raw offset — the
      // model matrix is identity here.
      const effectors: Effector[] = []
      if (data.effectors) {
        for (const effector of data.effectors) {
          const type = data.effectorTypes.get(effector.effectId)
          if (!type || effector.vertex < 0 || effector.vertex >= vertexCount) continue
          effectors.push({
            x: vertexX[effector.vertex],
            y: vertexY[effector.vertex],
            z: vertexZ[effector.vertex],
            effectId: effector.effectId,
            type: type as ParticleType,
            dirX: type.offsetX,
            dirZ: type.offsetZ,
          })
          effectorAnchors.push({ effector: effectors[effectors.length - 1], vertex: effector.vertex })
        }
      }

      for (const emitter of data.emitters) {
        const info = data.emitterProducers.get(emitter.producerId)
        if (!info || emitter.face < 0 || emitter.face >= faceCount) continue
        const ia = triangleX[emitter.face], ib = triangleY[emitter.face], ic = triangleZ[emitter.face]
        if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue

        // the sim runs in raw model space; the render negates, same as the mesh
        const sim = new ParticleSim(
          info.producer as unknown as ParticleProducer,
          info.types as ParticleType[],
          {
            ax: vertexX[ia], ay: vertexY[ia], az: vertexZ[ia],
            bx: vertexX[ib], by: vertexY[ib], bz: vertexZ[ib],
            cx: vertexX[ic], cy: vertexY[ic], cz: vertexZ[ic],
          },
          effectors,
        )
        sim.maxParticles = PARTICLE_CAP
        simAnchors.push({ sim, ia, ib, ic })

        let texture = producerTextures.get(emitter.producerId)
        if (!texture) {
          texture = makeDotTexture()
          producerTextures.set(emitter.producerId, texture)
          particleTextures.push(texture)
          if (info.material) {
            const target = texture
            createImageBitmap(info.material).then((bitmap) => {
              if (disposed) { bitmap.close(); return }
              target.image = bitmap
              target.needsUpdate = true
            })
          }
        }

        const positions = new Float32Array(PARTICLE_CAP * 3)
        const colors = new Float32Array(PARTICLE_CAP * 4)
        const sizes = new Float32Array(PARTICLE_CAP)
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute('pcolor', new THREE.BufferAttribute(colors, 4))
        geometry.setAttribute('psize', new THREE.BufferAttribute(sizes, 1))
        geometry.setDrawRange(0, 0)

        const material = new THREE.ShaderMaterial({
          vertexShader: PARTICLE_VERT,
          fragmentShader: PARTICLE_FRAG,
          uniforms: { map: { value: texture }, uScale: { value: 1 } },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })

        const points = new THREE.Points(geometry, material)
        // positions change every frame; the precomputed bounding sphere would cull it
        points.frustumCulled = false
        points.renderOrder = 2
        mesh.add(points)

        emitterSystems.push({ sim, points, positions, colors, sizes, geometry, material })
      }
    }
    particleObjectsRef.current = emitterSystems.map((s) => s.points)
    for (const s of emitterSystems) s.points.visible = particlesRef.current

    function stepEmitters(ticks: number) {
      for (const system of emitterSystems) {
        for (let t = 0; t < ticks; t++) system.sim.step(1)

        const { sim, positions, colors, sizes, geometry } = system
        let n = 0
        for (const p of sim.particles) {
          if (n >= PARTICLE_CAP) break
          const alpha = ((p.color >>> 24) & 0xff) / 255
          if (alpha <= 0.004) continue
          // same (x, −y, −z) axis mapping the mesh vertices get
          positions[n * 3]     = p.x / 4096
          positions[n * 3 + 1] = -(p.y / 4096)
          positions[n * 3 + 2] = -(p.z / 4096)
          colors[n * 4]     = ((p.color >> 16) & 0xff) / 255
          colors[n * 4 + 1] = ((p.color >> 8) & 0xff) / 255
          colors[n * 4 + 2] = (p.color & 0xff) / 255
          colors[n * 4 + 3] = alpha
          // size is fixed-point like the coords; /4096 is the world half-extent
          sizes[n] = Math.max((p.size / 4096) * 2, 1)
          n++
        }
        geometry.setDrawRange(0, n)
        geometry.attributes.position.needsUpdate = true
        geometry.attributes.pcolor.needsUpdate = true
        geometry.attributes.psize.needsUpdate = true
      }
    }

    // world-diameter → pixel conversion for gl_PointSize, refreshed on resize
    function updateParticleScale(height: number) {
      const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
      for (const system of emitterSystems) system.material.uniforms.uScale.value = scale
    }
    updateParticleScale(h)

    // A model can have NO visible faces at all — pure particle rigs (e.g. 51222,
    // the Christmas cupboard's sparkle rig) are nothing but invisible marker faces.
    // Without this the bounds stay ±Infinity, the mesh position goes NaN, and the
    // whole scene (particles included, as mesh children) vanishes.
    if (!isFinite(minX)) {
      for (let v = 0; v < vertexCount; v++) {
        const x = vertexX[v], y = -vertexY[v], z = -vertexZ[v]
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
      }
      if (!isFinite(minX)) { minX = maxX = minY = maxY = minZ = maxZ = 0 }
    }

    const cx2 = (minX + maxX) / 2
    const cy2 = (minY + maxY) / 2
    const cz2 = (minZ + maxZ) / 2
    mesh.position.set(-cx2, -cy2, -cz2)

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)

    // Item pose: the client's inventory-icon transform (ItemDefinitions.getSprite).
    // It rolls Z(-zan), yaws Y(yan), translates to (offX, offY − h/2, zoom·sin(xan),
    // zoom·cos(xan) + offY), then pitches X(xan) — and since RX(xan)·(0, z·sin, z·cos)
    // = (0, 0, z), the pitch collapses to rotating the model itself about its centre
    // with the camera a straight zoom away. 2048 rotation units = a full circle.
    // Conjugated through the (x, −y, −z) RS→Three mapping (a 180° rotation about X),
    // yaw and roll angles negate, pitch is unchanged, and translations map to
    // (tx, −ty, −tz).
    if (pose) {
      const rad = (units: number) => (units * Math.PI) / 1024
      poseGroup.scale.set(pose.resizeX / 128, pose.resizeY / 128, pose.resizeZ / 128)
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rad(pose.rotationX))
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -rad(pose.rotationY))
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad(pose.rotationZ))
      poseGroup.quaternion.copy(qx).multiply(qy).multiply(qz)
      // Residual translation (offsets ride through the final pitch; offY feeds
      // both the y and z components in the client code).
      const t = new THREE.Vector3(pose.offsetX, -pose.offsetY, -pose.offsetY).applyQuaternion(qx)
      poseGroup.position.copy(t)

      const zoom = pose.zoom > 0 ? pose.zoom : span * 2.5
      camera.fov = ICON_FOV
      camera.position.set(0, 0, zoom)
      camera.near = Math.max(zoom * 0.01, 0.1)
      camera.far = zoom * 10 + span * 100
    } else {
      camera.position.set(0, 0, span * 2.5)
      camera.near = span * 0.001
      camera.far  = span * 100
    }
    camera.updateProjectionMatrix()
    updateParticleScale(h)

    // --- Animated pose: rewrites the live position buffer in place (plus
    // billboard centres and particle-emitter/effector anchors) — no scene
    // rebuild. Colours, UVs and the centring offset stay at rest pose: UVs
    // glued to their faces is the normal skinned-mesh look, and a fixed pivot
    // keeps the camera from jumping between frames. The length guard drops a
    // stale pose left over from a previously loaded model.
    const positionAttr = geo.getAttribute('position') as THREE.BufferAttribute
    function applyPosed(posed: PosedVertices | null) {
      const valid = posed != null && posed.x.length === vertexCount ? posed : null
      const X = valid ? valid.x : vertexX
      const Y = valid ? valid.y : vertexY
      const Z = valid ? valid.z : vertexZ
      for (let i = 0; i < cornerVertex.length; i++) {
        const v = cornerVertex[i]
        positions[i * 3]     = X[v]
        positions[i * 3 + 1] = -Y[v]
        positions[i * 3 + 2] = -Z[v]
      }
      positionAttr.needsUpdate = true
      // Skip recomputing bounds per frame — the mesh IS the scene, culling
      // buys nothing, and stale rest-pose bounds could wrongly cull a pose.
      mesh.frustumCulled = false
      for (const { sprite, ia, ib, ic } of spriteAnchors) {
        sprite.position.set(
          (X[ia] + X[ib] + X[ic]) / 3,
          -(Y[ia] + Y[ib] + Y[ic]) / 3,
          -(Z[ia] + Z[ib] + Z[ic]) / 3,
        )
      }
      for (const { sim, ia, ib, ic } of simAnchors) {
        sim.setTriangle({
          ax: X[ia], ay: Y[ia], az: Z[ia],
          bx: X[ib], by: Y[ib], bz: Z[ib],
          cx: X[ic], cy: Y[ic], cz: Z[ic],
        })
      }
      for (const { effector, vertex } of effectorAnchors) {
        effector.x = X[vertex]
        effector.y = Y[vertex]
        effector.z = Z[vertex]
      }
    }
    applyPosedFnRef.current = applyPosed
    // A rebuild mid-animation (this render's closure has the current prop)
    // starts from the active pose instead of flashing the rest pose.
    if (posedVertices) applyPosed(posedVertices)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1

    // restore the previous rebuild's orbit state (animation frame stepping)
    if (cameraStateRef?.current) {
      camera.position.set(...cameraStateRef.current.position)
      controls.target.set(...cameraStateRef.current.target)
      controls.update()
    }

    let animId: number
    let lastParticleTime = performance.now()
    let tickCarry = 0
    function animate(now: number) {
      animId = requestAnimationFrame(animate)
      controls.update()

      // The FPS cap throttles sim stepping + buffer uploads only — the sim keeps
      // real-time speed by accumulating 20ms client cycles across skipped frames,
      // and the scene still renders every RAF for smooth orbiting.
      if (emitterSystems.length > 0 && particleObjectsRef.current[0]?.visible) {
        if (now - lastParticleTime >= 1000 / particleFpsRef.current) {
          const elapsed = Math.min(now - lastParticleTime, 250)
          lastParticleTime = now
          tickCarry += elapsed / 20
          const ticks = Math.floor(tickCarry)
          tickCarry -= ticks
          if (ticks > 0) stepEmitters(ticks)
        }
      } else {
        // don't bank time while hidden, or re-enabling replays a burst
        lastParticleTime = now
      }

      // Animated materials: offset = seconds * speed / 64, the exact client formula
      // (the % 128000 keeps the float exact; 128s is a whole number of loops for any
      // speed). This runs every frame regardless of the particle FPS cap — it's two
      // uniform writes, and choppy lava looks broken in a way choppy sparks don't.
      if (scrollingTextures.length > 0) {
        const seconds = (now % 128000) / 1000
        for (const entry of scrollingTextures) {
          entry.texture.offset.set(((seconds * entry.u) / 64) % 1, ((seconds * entry.v) / 64) % 1)
        }
      }

      renderer.render(scene, camera)
    }
    animId = requestAnimationFrame(animate)

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      updateParticleScale(nh)
    })
    ro.observe(mount)

    return () => {
      disposed = true
      applyPosedFnRef.current = null
      if (cameraStateRef) {
        cameraStateRef.current = {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        }
      }
      cancelAnimationFrame(animId)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      geo.dispose()
      // mesh textures live in textureCacheRef, not disposed per-rebuild — see its declaration
      for (const material of materials) material.dispose()
      for (const texture of spriteTextures) texture.dispose()
      for (const material of spriteMaterials) material.dispose()
      for (const system of emitterSystems) {
        system.geometry.dispose()
        system.material.dispose()
      }
      for (const texture of particleTextures) texture.dispose()
      mount.removeChild(renderer.domElement)
    }
    // cameraStateRef is a mutable ref (stable identity, read at cleanup) and
    // posedVertices is applied in place by the effect below — both deliberately
    // not dependencies (a pose change must not rebuild the scene).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, display, applyPose])

  // Animated pose changes never rebuild the scene — just in-place buffer writes.
  useEffect(() => {
    applyPosedFnRef.current?.(posedVertices ?? null)
  }, [posedVertices])

  useEffect(() => {
    for (const material of matsRef.current) material.wireframe = wireframe
  }, [wireframe])

  useEffect(() => {
    particlesRef.current = particles
    for (const points of particleObjectsRef.current) points.visible = particles
  }, [particles])

  return (
    <div className="model-viewer">
      <div className="model-header">
        <span className="model-id">Model {data.id}</span>
        <span className="model-stats">
          {data.vertexCount} verts · {data.faceCount} faces
          {emitterCount > 0 && ` · ${emitterCount} particle emitter${emitterCount > 1 ? 's' : ''}`}
          {display && applyPose && ` · inventory pose from ${display.label}`}
        </span>
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
        {display && (
          <button
            className={`model-toolbar-btn${applyPose ? ' active' : ''}`}
            title="Apply the item's inventory-icon zoom, rotations, resizes and offsets"
            onClick={() => setApplyPose(v => !v)}
          >
            Item Pose
          </button>
        )}
        {emitterCount > 0 && (
          <>
            <button
              className={`model-toolbar-btn${particles ? ' active' : ''}`}
              onClick={() => setParticles(v => !v)}
            >
              Particles
            </button>
            {particles && PARTICLE_FPS_OPTIONS.map((f) => (
              <button
                key={f}
                className={`model-toolbar-btn${particleFps === f ? ' active' : ''}`}
                onClick={() => setParticleFps(f)}
              >
                {f} FPS
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
