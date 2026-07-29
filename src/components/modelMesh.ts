import * as THREE from 'three'
import { hslToRgb, billboardHiddenFaces, computeModelLitRgb, AMBIENT_DEFAULT, CONTRAST_DEFAULT } from '../loaders/models'
import type { ModelData, ModelSun } from '../loaders/models'
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
  /** Model-face index per buffer corner — what a type-5/7 face animation
   *  needs to rewrite the colour buffer in place. */
  cornerFace: Int32Array
  /** Material (group) index per buffer corner — a type-5 fade may only flip
   *  ITS OWN group's material transparent, never the whole mesh's. */
  cornerMaterial: Uint16Array
  /** Each material's build-time transparency, what a pose restores to. */
  baseTransparent: boolean[]
  /** The built per-corner rgb (lit when the builder lit), what a pose's
   *  type-7 rewrite scales and a restore returns to. */
  baseColors: Float32Array
  /** Frees the geometry, materials and decoded GPU textures. */
  dispose: () => void
  /** internal: whether the last applied pose rewrote face alphas/colours, so
   *  the next pose without them restores the baked values exactly once */
  faceFxApplied: boolean
}

/** Build a renderable mesh from a (composite) model, textures included.
 *  Returns null when no face is visible.
 *
 *  `light` bakes the client's per-vertex Gouraud sun into the vertex colours
 *  (computeModelLitRgb — the same calibrated bake the loc meshes get, with the
 *  def's ambient/contrast), written in the loc convention (raw values). The
 *  cutscene player passes it so its NPCs shade like their surroundings —
 *  unlit they rendered as flat full-brightness cutouts ("low detail, too
 *  bright"). Omit it for the legacy flat look (snapshot icons). */
export async function buildTexturedModelMesh(
  model: ModelData,
  light?: { sun?: ModelSun; ambient?: number; contrast?: number },
): Promise<TexturedModelMesh | null> {
  const { vertexCount, faceCount, vertexX, vertexY, vertexZ, triangleX, triangleY, triangleZ, faceColor, faceAlpha, faceTextures, textures } = model

  // Bucket visible faces by texture id (-1 = flat colour; ids without a
  // dumped material PNG fall back to flat so nothing renders untinted-white).
  // A zero-scale mapping poisons one UV coordinate; the writer pins it to a
  // texture edge and the face still draws, as it does in the client.
  // Faces replaced by a hasUid billboard never draw (the client drops them).
  const writeUVs = makeUVWriter(model)
  const uvScratch = new Float32Array(6)
  const bbHidden = billboardHiddenFaces(model)
  const buckets = new Map<number, number[]>()
  for (let f = 0; f < faceCount; f++) {
    if (faceAlpha[f] === -1) continue
    if (bbHidden?.has(f)) continue
    const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
    if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue
    let tex = faceTextures?.[f] ?? -1
    if (tex >= 0 && !textures.get(tex)) tex = -1
    if (tex >= 0 && !writeUVs(f, ia, ib, ic, uvScratch, 0)) continue
    const bucket = buckets.get(tex)
    if (bucket) bucket.push(f)
    else buckets.set(tex, [f])
  }
  const bucketOrder = [...buckets.keys()].sort((a, b) => a - b) // -1 first
  const validFaces = [...buckets.values()].reduce((n, b) => n + b.length, 0)
  if (validFaces === 0) return null

  // Decode the material PNGs up front: the geometry pass needs each detail
  // map's average luma (a `detailsOnly` texture carries no colour of its own,
  // so the face colour must be boosted by 255/avgLuma or every textured face
  // darkens by the map's brightness — same normalisation the loc meshes get).
  const decoded = new Map<number, { bitmap: ImageBitmap; boost: number }>()
  await Promise.all(bucketOrder.filter((t) => t >= 0).map(async (tex) => {
    try {
      // 'none': Chromium premultiplies by default and three uploads an
      // ImageBitmap verbatim, so a material with a sub-255 alpha would sample
      // as rgb·a — the specular detail maps render near-black without this.
      const bitmap = await createImageBitmap(textures.get(tex)!, { premultiplyAlpha: 'none' })
      let boost = 1
      if (model.textureDetailsOnly.get(tex)) {
        const size = 16
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, size, size)
          const px = ctx.getImageData(0, 0, size, size).data
          let sum = 0, n = 0
          for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] === 0) continue
            sum += (px[i] + px[i + 1] + px[i + 2]) / 3
            n++
          }
          if (n > 0) boost = 255 / Math.max(32, sum / n)
        }
      }
      decoded.set(tex, { bitmap, boost })
    } catch { /* undecodable PNG — the group renders flat-tinted */ }
  }))

  // The lit bake, when asked for: identity normal matrix (the placement rides
  // on the group transform), indexed (face*3+corner)*3 like the loc paths.
  const lit = light
    ? computeModelLitRgb(model, [1, 0, 0, 0, 1, 0, 0, 0, 1], light.sun, undefined, undefined, undefined,
        light.ambient ?? AMBIENT_DEFAULT, light.contrast ?? CONTRAST_DEFAULT)
    : null

  const positions = new Float32Array(validFaces * 9)
  // RGBA — the alpha channel carries the face's baked translucency (RS 0 =
  // opaque … 255 = invisible, complemented), and a type-5 animation rewrites
  // it per frame through applyPoseToMesh
  const colors = new Float32Array(validFaces * 12)
  const uvs = new Float32Array(validFaces * 6)
  const cornerVertex = new Int32Array(validFaces * 3)
  const cornerFace = new Int32Array(validFaces * 3)
  const cornerMaterial = new Uint16Array(validFaces * 3)

  const groups: { start: number; count: number; tex: number; hasAlpha: boolean }[] = []
  let vert = 0
  for (const tex of bucketOrder) {
    const faces = buckets.get(tex)!
    const group = { start: vert, count: faces.length * 3, tex, hasAlpha: false }
    const materialIndex = groups.length
    groups.push(group)
    const boost = tex >= 0 ? decoded.get(tex)?.boost ?? 1 : 1
    for (const f of faces) {
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      const rgb = hslToRgb(faceColor[f] & 0xffff)
      const r = srgbToLinear(((rgb >> 16) & 0xff) / 255)
      const g = srgbToLinear(((rgb >> 8) & 0xff) / 255)
      const b = srgbToLinear((rgb & 0xff) / 255)
      const baked = faceAlpha[f] & 0xff
      const opacity = (255 - baked) / 255
      if (baked !== 0) group.hasAlpha = true
      const corners = [ia, ib, ic]
      for (let i = 0; i < 3; i++) {
        const v = corners[i]
        const base = (vert + i) * 3
        // RS → three: (x, −y, −z)
        positions[base] = vertexX[v]
        positions[base + 1] = -vertexY[v]
        positions[base + 2] = -vertexZ[v]
        const cbase = (vert + i) * 4
        if (lit) {
          const lb = (f * 3 + i) * 3
          colors[cbase] = lit[lb] * boost
          colors[cbase + 1] = lit[lb + 1] * boost
          colors[cbase + 2] = lit[lb + 2] * boost
        } else {
          colors[cbase] = r * boost; colors[cbase + 1] = g * boost; colors[cbase + 2] = b * boost
        }
        colors[cbase + 3] = opacity
        cornerVertex[vert + i] = v
        cornerFace[vert + i] = f
        cornerMaterial[vert + i] = materialIndex
      }
      if (tex >= 0) writeUVs(f, ia, ib, ic, uvs, vert * 2)
      vert += 3
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))

  const materials: THREE.MeshBasicMaterial[] = []
  const gpuTextures: THREE.Texture[] = []
  await Promise.all(groups.map(async (g, i) => {
    geo.addGroup(g.start, g.count, i)
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    // A group blends when its texture-def effectCombiner ("blendType") is
    // non-zero — drawn in the client's transparent pass with the texture's
    // ALPHA as opacity (the ghostly cutscene props: object 61435, texture
    // 1219, alpha ~70/255) — or when any of its faces bakes translucency (the
    // Stone of Jas's aura shell: model 44495, every face at faceAlpha 192).
    // z-write stays ON like the client's transparent objects. blendType-0
    // materials keep their PNG alpha as a gloss mask, never opacity — do not
    // sniff the bitmap instead of the def.
    if ((g.tex >= 0 && model.textureBlendTypes.get(g.tex)) || g.hasAlpha) {
      mat.transparent = true
    }
    materials[i] = mat
    const dec = g.tex >= 0 ? decoded.get(g.tex) : undefined
    if (dec) {
      const texture = new THREE.Texture(dec.bitmap)
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      gpuTextures.push(texture)
      mat.map = texture
      mat.needsUpdate = true
    }
    // An hdr material's overbright multiplier, same treatment as loc meshes:
    // material.color scales the map+vertex colour past 1.0 and the scene's
    // bloom pass glows it (a glowing robe trim next to Saradomin's hdr eyes).
    const hdrMul = g.tex >= 0 ? model.textureHdrMultipliers.get(g.tex) : undefined
    if (hdrMul && hdrMul > 1) {
      mat.userData.hdrMultiplier = hdrMul
      mat.color.setScalar(hdrMul)
    }
  }))

  const mesh = new THREE.Mesh(geo, materials)
  mesh.frustumCulled = false
  return {
    mesh,
    cornerVertex,
    cornerFace,
    cornerMaterial,
    baseTransparent: materials.map((m) => m.transparent),
    baseColors: colors.slice(),
    faceFxApplied: false,
    dispose: () => {
      geo.dispose()
      for (const m of materials) m.dispose()
      for (const t of gpuTextures) t.dispose()
    },
  }
}

/** Rewrite the mesh's positions (and, when the pose carries type-5/7 face
 *  effects, its colour buffer) from a skeletal pose — or back to rest with
 *  null, using the corner maps buildTexturedModelMesh returned. */
export function applyPoseToMesh(
  tm: TexturedModelMesh,
  model: ModelData,
  posed: { x: Int32Array; y: Int32Array; z: Int32Array; faceAlpha?: Int8Array | null; faceColor?: Uint16Array | null } | null,
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

  // Type-5 alpha / type-7 colour: rewrite the colour buffer from the posed
  // face values; when a pose stops carrying them, restore the baked values
  // exactly once. This is what makes the Stone of Jas's aura PULSE — its
  // idle sequence drives the shell's alpha every frame.
  const posedAlpha = posed?.faceAlpha ?? null
  const posedColor = posed?.faceColor ?? null
  if (posedAlpha || posedColor || tm.faceFxApplied) {
    const colorAttr = tm.mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const colors = colorAttr.array as Float32Array
    const alphas = posedAlpha ?? model.faceAlpha
    const materials = Array.isArray(tm.mesh.material) ? tm.mesh.material : [tm.mesh.material]
    const matNeedsBlend = tm.baseTransparent.map(() => false)
    for (let c = 0; c < tm.cornerFace.length; c++) {
      const f = tm.cornerFace[c]
      const cbase = c * 4
      if (posedColor || tm.faceFxApplied) {
        if (posedColor && posedColor[f] !== model.faceColor[f]) {
          // scale the BUILT colour (which may carry the lit bake and detail
          // boost) by the palette ratio of posed vs baked HSL, so a type-7
          // colour shift keeps the shading instead of flattening it
          const to = hslToRgb(posedColor[f] & 0xffff)
          const from = hslToRgb(model.faceColor[f] & 0xffff)
          for (let ch = 0; ch < 3; ch++) {
            const fromC = (from >> (16 - ch * 8)) & 0xff
            const toC = (to >> (16 - ch * 8)) & 0xff
            colors[cbase + ch] = fromC > 0 ? tm.baseColors[cbase + ch] * (toC / fromC) : srgbToLinear(toC / 255)
          }
        } else {
          colors[cbase] = tm.baseColors[cbase]
          colors[cbase + 1] = tm.baseColors[cbase + 1]
          colors[cbase + 2] = tm.baseColors[cbase + 2]
        }
      }
      const opacity = (255 - (alphas[f] & 0xff)) / 255
      colors[cbase + 3] = opacity
      if (opacity < 1) matNeedsBlend[tm.cornerMaterial[c]] = true
    }
    colorAttr.needsUpdate = true
    // An animation can fade a group that was baked opaque — flip THAT group's
    // material transparent while it blends, and back to its base state after.
    // Never the whole mesh: the Stone of Jas entity (npc 14317) merges the
    // opaque stone with its pulsing aura shell, and flipping every material
    // put the stone in the transparent pass BEHIND the aura group — whose
    // z-write then killed the stone's fragments ("the models inside
    // disappear"). z-write stays on regardless, like the client.
    for (let i = 0; i < materials.length; i++) {
      const want = tm.baseTransparent[i] || matNeedsBlend[i]
      if (materials[i].transparent !== want) {
        materials[i].transparent = want
        materials[i].needsUpdate = true
      }
    }
    tm.faceFxApplied = posedAlpha != null || posedColor != null
  }
}
