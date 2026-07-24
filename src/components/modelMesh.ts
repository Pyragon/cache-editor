import * as THREE from 'three'
import { hslToRgb } from '../loaders/models'
import type { ModelData } from '../loaders/models'
import { makeUVWriter } from './modelUVs'

// Shared textured mesh builder for composite models rendered OUTSIDE
// ModelViewer — the NPC/object snapshot icons and the cutscene player's
// entities. Faces bucket by texture id into geometry groups (one material
// per group, its map decoded from the dumped material PNG), UVs come from
// modelUVs' client-exact projection port, and untextured faces keep their
// flat HSL colour. Face colour always stays on as a vertex-colour tint —
// the material PNGs are greyscale detail maps the client multiplies by
// face colour. All bitmap decodes are awaited, so the returned mesh is
// safe to render immediately (snapshots render exactly once).

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

export type TexturedModelMesh = {
  mesh: THREE.Mesh
  /** Model-vertex index for every buffer corner (non-indexed geometry) — the
   *  map an animated pose needs to rewrite positions in place. */
  cornerVertex: Int32Array
  /** Frees the geometry, materials and decoded GPU textures. */
  dispose: () => void
}

/** Build a renderable mesh from a (composite) model, textures included.
 *  Returns null when no face is visible. */
export async function buildTexturedModelMesh(model: ModelData): Promise<TexturedModelMesh | null> {
  const { vertexCount, faceCount, vertexX, vertexY, vertexZ, triangleX, triangleY, triangleZ, faceColor, faceAlpha, faceTextures, textures } = model

  // Bucket visible faces by texture id (-1 = flat colour; ids without a
  // dumped material PNG fall back to flat so nothing renders untinted-white).
  const buckets = new Map<number, number[]>()
  for (let f = 0; f < faceCount; f++) {
    if (faceAlpha[f] === -1) continue
    const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
    if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue
    let tex = faceTextures?.[f] ?? -1
    if (tex >= 0 && !textures.get(tex)) tex = -1
    const bucket = buckets.get(tex)
    if (bucket) bucket.push(f)
    else buckets.set(tex, [f])
  }
  const bucketOrder = [...buckets.keys()].sort((a, b) => a - b) // -1 first
  const validFaces = [...buckets.values()].reduce((n, b) => n + b.length, 0)
  if (validFaces === 0) return null

  const writeUVs = makeUVWriter(model)
  const positions = new Float32Array(validFaces * 9)
  const colors = new Float32Array(validFaces * 9)
  const uvs = new Float32Array(validFaces * 6)
  const cornerVertex = new Int32Array(validFaces * 3)

  const groups: { start: number; count: number; tex: number }[] = []
  let vert = 0
  for (const tex of bucketOrder) {
    const faces = buckets.get(tex)!
    groups.push({ start: vert, count: faces.length * 3, tex })
    for (const f of faces) {
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      const rgb = hslToRgb(faceColor[f] & 0xffff)
      const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
      const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
      const b = srgbToLinear((rgb & 0xff) / 255)
      const corners = [ia, ib, ic]
      for (let i = 0; i < 3; i++) {
        const v = corners[i]
        const base = (vert + i) * 3
        // RS → three: (x, −y, −z)
        positions[base] = vertexX[v]
        positions[base + 1] = -vertexY[v]
        positions[base + 2] = -vertexZ[v]
        colors[base] = r; colors[base + 1] = g; colors[base + 2] = b
        cornerVertex[vert + i] = v
      }
      if (tex >= 0) writeUVs(f, ia, ib, ic, uvs, vert * 2)
      vert += 3
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))

  const materials: THREE.MeshBasicMaterial[] = []
  const gpuTextures: THREE.Texture[] = []
  await Promise.all(groups.map(async (g, i) => {
    geo.addGroup(g.start, g.count, i)
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    materials[i] = mat
    if (g.tex >= 0) {
      try {
        const bitmap = await createImageBitmap(textures.get(g.tex)!)
        const texture = new THREE.Texture(bitmap)
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
        gpuTextures.push(texture)
        mat.map = texture
        mat.needsUpdate = true
      } catch { /* undecodable PNG — the group renders flat-tinted */ }
    }
  }))

  const mesh = new THREE.Mesh(geo, materials)
  mesh.frustumCulled = false
  return {
    mesh,
    cornerVertex,
    dispose: () => {
      geo.dispose()
      for (const m of materials) m.dispose()
      for (const t of gpuTextures) t.dispose()
    },
  }
}

/** Rewrite the mesh's positions from a skeletal pose (or back to rest with
 *  null), using the cornerVertex map buildTexturedModelMesh returned. */
export function applyPoseToMesh(
  tm: TexturedModelMesh,
  model: ModelData,
  posed: { x: Int32Array; y: Int32Array; z: Int32Array } | null,
) {
  const attr = tm.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = attr.array as Float32Array
  const vx = posed?.x ?? model.vertexX
  const vy = posed?.y ?? model.vertexY
  const vz = posed?.z ?? model.vertexZ
  for (let c = 0; c < tm.cornerVertex.length; c++) {
    const v = tm.cornerVertex[c]
    const base = c * 3
    arr[base] = vx[v]
    arr[base + 1] = -vy[v]
    arr[base + 2] = -vz[v]
  }
  attr.needsUpdate = true
}
