import * as THREE from 'three'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import type { PosedVertices } from '../loaders/skeletalAnimation'
import type { LocEmitter } from './sceneParticles'

/**
 * Billboard attachments for the 3D scenes (map view, cutscene player).
 *
 * A loc model can pin camera-facing sprites to individual faces — the glow a
 * fire casts and its rising smoke column are billboards, not particles (the
 * God Wars fire, model 58392, carries 4 glow sprites and 12 stacked smoke
 * sprites next to its 6 particle emitters). Without these a fire is just its
 * flame particles: no light behind them, no black plume.
 *
 * Ported from the client's DirectX path (`MeshRasterizer_Sub3.method14275`,
 * drawn right after the host mesh each frame):
 *   - anchor = the host face's centroid (of the CURRENT, possibly animated,
 *     vertex positions), in view space;
 *   - the anchor is pulled `distance` units TOWARD the camera
 *     (`f - f*(distance/len)`) so the sprite clears its own geometry;
 *   - the quad is axis-aligned in view space (camera-facing), full extent
 *     2*size2d by 2*size3d world units (`Matrix44Var.method5213` scales a unit
 *     quad by size*2 about the anchor), scaled/rolled/offset by the group's
 *     animation state;
 *   - tint = the host face's colour through the HSL palette (raw, not sun-lit)
 *     with alpha `255 - faceAlpha`, times the type's material texture
 *     ("Particle" shader: texture * DiffuseColour);
 *   - a type with `hasUid` REPLACES its host face (the mesh builders skip it);
 *   - a type with `stationary` set only draws while the bloom filter is OFF —
 *     the flag's real meaning is "fallback sprite for the no-bloom look"
 *     (`!aBool522 || !method8471()` in the client).
 *
 * ANIMATION MATTERS more than it sounds: the fire's idle sequence translates
 * the carrier faces, scales/rolls each smoke puff's billboard group (types
 * 9/10, group id = the attachment's `depth` byte) and — critically — type-5
 * fades most puffs to invisible at any instant. Drawn at rest pose instead,
 * all 12 puffs stack at full base alpha and bury the fire in one giant cloud.
 * So animated locs get `addAnimated()`, whose sprites stay hidden until the
 * scene's animator delivers the first posed frame, and static locs get the
 * baked `add()` path.
 */

const BILLBOARD_VERT = `
  attribute vec2 aCorner;
  attribute vec2 aSize;
  attribute float aDist;
  attribute float aRot;
  attribute vec2 aOff;
  attribute vec4 aColor;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;
  void main() {
    vColor = aColor;
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // the client's pull-toward-camera: shrink the view vector by aDist units
    float len = max(length(mv.xyz), 1.0);
    mv.xyz *= 1.0 - aDist / len;
    vec2 corner = aCorner * aSize;
    float c = cos(aRot), s = sin(aRot);
    mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) + aOff;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const BILLBOARD_FRAG = `
  uniform sampler2D map;
  uniform float uHdr;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;
  void main() {
    vec4 tex = texture2D(map, vUv);
    // The face-colour tint is an sRGB palette value; our chain renders into a
    // LINEAR buffer the OutputPass re-encodes, so linearize it or the sprite
    // displays brightened — the dark smoke column read as light grey and the
    // glow washed out pale. (The sampled texture is already linear.)
    // uHdr is the material's overbright multiplier (Saradomin's eye sprites,
    // material 744, are hdr fill-192 -> x2.45) — past 1.0 the bloom pass
    // turns it into the glow; 1.0 while bloom is off, like every material.
    vec3 rgb = pow(vColor.rgb, vec3(2.2)) * tex.rgb * uHdr;
    // Region distance fog: the client's Particle effect is fixed-function, so
    // D3D vertex fog mutes a distant glow toward the backdrop exactly as it
    // does geometry — without this the glow reads too vivid at range.
    float fogF = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
    gl_FragColor = vec4(mix(rgb, fogColor, fogF), vColor.a * tex.a);
  }
`

/** The soft fallback when a type has no material — mirrors the particle dot. */
function makeFallbackTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.4)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** 14-bit client angle → radians, negated for the view-space y flip (the DX
 *  view runs y-down; mirroring an axis reverses the roll direction). */
const ANGLE = -(2 * Math.PI) / 16384

/** One billboard's immutable identity within a built mesh. */
type QuadRef = {
  face: number
  /** animation group = the attachment's `depth` byte */
  group: number
  size2d: number
  size3d: number
  distance: number
}

type AnimatedSystem = {
  geometry: THREE.BufferGeometry
  quads: QuadRef[]
}

/** Handle for one animated loc's sprites: drive with `pose`, `remove` when the
 *  loc leaves the scene (deleted placement, centre rebuild). `setVisible`
 *  lets an owner whose sprites are NOT children of its group (a cutscene
 *  entity) hide them with it. */
export type AnimatedBillboards = {
  pose(posed: PosedVertices | null): void
  setVisible(on: boolean): void
  remove(): void
}

export class SceneBillboards {
  /** Add these to the plane groups so plane toggles hide sprites with their locs. */
  readonly groups: THREE.Group[] = [new THREE.Group(), new THREE.Group(), new THREE.Group(), new THREE.Group()]
  private meshes: THREE.Mesh[] = []
  /** meshes whose type is bloom-gated (`stationary`): drawn only with bloom off */
  private gated: THREE.Mesh[] = []
  private materials = new Map<number, THREE.ShaderMaterial>()
  private textures: THREE.Texture[] = []
  private fallback: THREE.Texture | null = null
  private bloomOn = true
  private count_ = 0
  private materialMeta: ((id: number) => Promise<{ hdrMultiplier: number; effectCombiner: number } | null>) | null = null

  /** Where a material's HDR multiplier comes from (the scene's LocAssets). */
  setMaterialLookup(lookup: (id: number) => Promise<{ hdrMultiplier: number; effectCombiner: number } | null>): void {
    this.materialMeta = lookup
  }

  /** region fog mirrored from scene.fog (near 1e8 = fog off) */
  private fogColor = new THREE.Color(0xc8c0a8)
  private fogNear = 1e8
  private fogFar = 1e9

  /** Mirror the scene's fog (the client's fixed-function fog covers billboards
   *  like geometry). Pass null to disable. */
  setFog(colorHex: number | null, near = 1e8, far = 1e9): void {
    if (colorHex !== null) this.fogColor.setHex(colorHex & 0xffffff)
    this.fogNear = colorHex === null ? 1e8 : near
    this.fogFar = colorHex === null ? 1e9 : far
    for (const material of this.materials.values()) {
      const u = material.uniforms
      ;(u.fogColor.value as THREE.Color).copy(this.fogColor)
      u.fogNear.value = this.fogNear
      u.fogFar.value = this.fogFar
    }
  }

  get count(): number {
    return this.count_
  }

  /** Baked sprites for a STATIC loc. Animated locs are skipped here — their
   *  sprites are meaningless at rest pose (see the class comment). */
  add(placed: LocEmitter): void {
    if (placed.animated || !placed.model.billboards?.length) return
    for (const [materialId, [plain, gatedQuads]] of this.collect(placed)) {
      for (const [quads, isGated] of [[plain, false], [gatedQuads, true]] as const) {
        if (quads.length === 0) continue
        const { mesh } = this.buildMesh(quads.length, this.materialFor(materialId, placed.model))
        this.writeStatic(mesh.geometry, quads, placed)
        if (isGated) {
          this.gated.push(mesh)
          mesh.visible = !this.bloomOn
        }
        this.meshes.push(mesh)
        this.groups[Math.max(0, Math.min(3, placed.plane))].add(mesh)
        this.count_ += quads.length
      }
    }
  }

  /**
   * Sprites for an ANIMATED loc: returns a handle whose `pose` the scene's
   * animator calls with each posed frame (`null` re-poses the rest state).
   * The sprites stay hidden until the first call, so a loc whose animation
   * never loads shows no stale rest-pose cloud. Null when the model carries
   * no billboards.
   */
  addAnimated(placed: LocEmitter): AnimatedBillboards | null {
    if (!placed.model.billboards?.length) return null
    const systems: { system: AnimatedSystem; mesh: THREE.Mesh; isGated: boolean }[] = []
    for (const [materialId, [plain, gatedQuads]] of this.collect(placed)) {
      for (const [quads, isGated] of [[plain, false], [gatedQuads, true]] as const) {
        if (quads.length === 0) continue
        const { mesh, system } = this.buildMesh(quads.length, this.materialFor(materialId, placed.model), quads)
        // posed anchors move (the smoke column rises well above its rest
        // faces), so skip three's static-bounds frustum test for these few
        mesh.frustumCulled = false
        // hidden until the first posed frame arrives — rest pose draws every
        // smoke puff at once at full alpha, which buries the fire in a cloud
        mesh.visible = false
        mesh.userData.awaitingPose = true
        if (isGated) this.gated.push(mesh)
        this.meshes.push(mesh)
        this.groups[Math.max(0, Math.min(3, placed.plane))].add(mesh)
        this.count_ += quads.length
        systems.push({ system, mesh, isGated })
      }
    }
    if (systems.length === 0) return null
    let ownerHidden = false
    const applyVisibility = () => {
      for (const { mesh, isGated } of systems) {
        mesh.visible = !ownerHidden && !mesh.userData.awaitingPose && (isGated ? !this.bloomOn : true)
      }
    }
    return {
      pose: (posed) => {
        for (const { system, mesh } of systems) {
          this.writePose(system, placed, posed)
          mesh.userData.awaitingPose = false
        }
        applyVisibility()
      },
      setVisible: (on) => {
        ownerHidden = !on
        applyVisibility()
      },
      remove: () => {
        for (const { system, mesh } of systems) {
          mesh.parent?.remove(mesh)
          system.geometry.dispose()
          this.meshes = this.meshes.filter((m) => m !== mesh)
          this.gated = this.gated.filter((m) => m !== mesh)
          this.count_ -= system.quads.length
        }
        systems.length = 0
      },
    }
  }

  /** Group a placed model's billboards per material, split plain/bloom-gated. */
  private collect({ model }: LocEmitter): Map<number, [QuadRef[], QuadRef[]]> {
    const byMaterial = new Map<number, [QuadRef[], QuadRef[]]>()
    for (const bb of model.billboards ?? []) {
      const info = model.billboardTypes.get(bb.typeId)
      if (!info || bb.face < 0 || bb.face >= model.faceCount) continue
      const ia = model.triangleX[bb.face], ib = model.triangleY[bb.face], ic = model.triangleZ[bb.face]
      if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue
      const lists = byMaterial.get(info.def.materialId)
        ?? byMaterial.set(info.def.materialId, [[], []]).get(info.def.materialId)!
      lists[info.def.stationary ? 1 : 0].push({
        face: bb.face,
        group: bb.depth,
        size2d: info.def.size2d,
        size3d: info.def.size3d,
        distance: bb.distance,
      })
    }
    return byMaterial
  }

  /** Allocates the quad geometry (4 verts + 2 tris per billboard). */
  private buildMesh(n: number, material: THREE.ShaderMaterial, quads?: QuadRef[]): { mesh: THREE.Mesh; system: AnimatedSystem } {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 12), 3))
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array(n * 8), 2))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n * 8), 2))
    geometry.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(n * 4), 1))
    geometry.setAttribute('aRot', new THREE.BufferAttribute(new Float32Array(n * 4), 1))
    geometry.setAttribute('aOff', new THREE.BufferAttribute(new Float32Array(n * 8), 2))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 16), 4))
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 8), 2))
    const index: number[] = []
    const corners = geometry.attributes.aCorner.array as Float32Array
    const uvs = geometry.attributes.uv.array as Float32Array
    // v=0 is the uploaded image's top row; corner y +1 is the quad's top
    const CORNERS = [[-1, 1], [1, 1], [1, -1], [-1, -1]]
    for (let q = 0; q < n; q++) {
      for (let c = 0; c < 4; c++) {
        const i = q * 4 + c
        corners[i * 2] = CORNERS[c][0]
        corners[i * 2 + 1] = CORNERS[c][1]
        uvs[i * 2] = (CORNERS[c][0] + 1) / 2
        uvs[i * 2 + 1] = (1 - CORNERS[c][1]) / 2
      }
      const base = q * 4
      index.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
    geometry.setIndex(index)
    const mesh = new THREE.Mesh(geometry, material)
    // after the transparent loc pass but BEFORE the particles (renderOrder 3):
    // the client draws billboards in the object pass with their host model and
    // particles later, so a fire's flames render over its glow sprite
    mesh.renderOrder = 2
    return { mesh, system: { geometry, quads: quads ?? [] } }
  }

  /** Bakes a static loc's quads: rest-pose anchors, identity group state. */
  private writeStatic(geometry: THREE.BufferGeometry, quads: QuadRef[], placed: LocEmitter): void {
    this.writeQuads(geometry, quads, placed, null)
    // the shader expands corners in view space, so pad the bounds by the
    // largest extent or three's frustum test would cull the quads' edges
    const positions = geometry.attributes.position.array as Float32Array
    const bounds = new THREE.Box3()
    const v = new THREE.Vector3()
    let pad = 0
    for (let i = 0; i < positions.length; i += 3) bounds.expandByPoint(v.set(positions[i], positions[i + 1], positions[i + 2]))
    for (const quad of quads) pad = Math.max(pad, Math.max(quad.size2d, quad.size3d) + Math.abs(quad.distance))
    const sphere = new THREE.Sphere()
    bounds.getBoundingSphere(sphere)
    sphere.radius += pad
    geometry.boundingSphere = sphere
  }

  /** Re-poses an animated loc's quads from one animation frame. */
  private writePose(system: AnimatedSystem, placed: LocEmitter, posed: PosedVertices | null): void {
    this.writeQuads(system.geometry, system.quads, placed, posed)
  }

  private writeQuads(geometry: THREE.BufferGeometry, quads: QuadRef[], placed: LocEmitter, posed: PosedVertices | null): void {
    const { model, matrix, upscale } = placed
    const positions = geometry.attributes.position.array as Float32Array
    const sizes = geometry.attributes.aSize.array as Float32Array
    const dists = geometry.attributes.aDist.array as Float32Array
    const rots = geometry.attributes.aRot.array as Float32Array
    const offs = geometry.attributes.aOff.array as Float32Array
    const colors = geometry.attributes.aColor.array as Float32Array
    const vx = posed?.x ?? model.vertexX
    const vy = posed?.y ?? model.vertexY
    const vz = posed?.z ?? model.vertexZ
    const anchor = new THREE.Vector3()
    for (let q = 0; q < quads.length; q++) {
      const quad = quads[q]
      const ia = model.triangleX[quad.face], ib = model.triangleY[quad.face], ic = model.triangleZ[quad.face]
      // same model->scene mapping the mesh builders use: y and z negated,
      // pre-13 upscale applied, then the placement matrix
      anchor.set(
        (vx[ia] + vx[ib] + vx[ic]) / 3,
        -(vy[ia] + vy[ib] + vy[ic]) / 3,
        -(vz[ia] + vz[ib] + vz[ic]) / 3,
      ).multiplyScalar(upscale).applyMatrix4(matrix)
      // tint follows the (possibly type-5/7 animated) host face, exactly as
      // the client recomputes Class65's colour from the face after each pass
      const hsl = (posed?.faceColor ?? model.faceColor)[quad.face] & 0xffff
      const rgb = hslToRgb(hsl)
      const alpha = (255 - ((posed?.faceAlpha ?? model.faceAlpha)[quad.face] & 0xff)) / 255
      const group = posed?.billboardGroups?.get(quad.group)
      const sizeX = quad.size2d * (group?.sx ?? 128) / 128
      const sizeY = quad.size3d * (group?.sy ?? 128) / 128
      const rot = (group?.rot ?? 0) * ANGLE
      const offX = group?.dx ?? 0
      const offY = -(group?.dy ?? 0) // client view space runs y-down
      const r = ((rgb >> 16) & 0xff) / 255
      const g = ((rgb >> 8) & 0xff) / 255
      const b = (rgb & 0xff) / 255
      for (let c = 0; c < 4; c++) {
        const i = q * 4 + c
        positions[i * 3] = anchor.x
        positions[i * 3 + 1] = anchor.y
        positions[i * 3 + 2] = anchor.z
        sizes[i * 2] = sizeX
        sizes[i * 2 + 1] = sizeY
        dists[i] = quad.distance
        rots[i] = rot
        offs[i * 2] = offX
        offs[i * 2 + 1] = offY
        colors[i * 4] = r
        colors[i * 4 + 1] = g
        colors[i * 4 + 2] = b
        colors[i * 4 + 3] = alpha
      }
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aSize.needsUpdate = true
    geometry.attributes.aDist.needsUpdate = true
    geometry.attributes.aRot.needsUpdate = true
    geometry.attributes.aOff.needsUpdate = true
    geometry.attributes.aColor.needsUpdate = true
  }

  private materialFor(materialId: number, model: ModelData): THREE.ShaderMaterial {
    let material = this.materials.get(materialId)
    if (material) return material
    let texture: THREE.Texture
    const blob = [...model.billboardTypes.values()].find((t) => t.def.materialId === materialId)?.material ?? null
    if (blob) {
      texture = new THREE.Texture()
      texture.colorSpace = THREE.SRGBColorSpace
      const target = texture
      // premultiplyAlpha 'none': the project-wide bitmap gotcha — the default
      // darkens a soft-alpha sprite's rgb by its own alpha at upload
      createImageBitmap(blob, { premultiplyAlpha: 'none' }).then((bitmap) => {
        target.image = bitmap
        target.needsUpdate = true
      }).catch(() => { /* keep empty — quad stays invisible until then */ })
      this.textures.push(texture)
    } else {
      texture = this.fallback ??= makeFallbackTexture()
    }
    material = new THREE.ShaderMaterial({
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      uniforms: {
        map: { value: texture },
        uHdr: { value: 1 },
        fogColor: { value: this.fogColor.clone() },
        fogNear: { value: this.fogNear },
        fogFar: { value: this.fogFar },
      },
      transparent: true,
      depthWrite: false,
      // the client's "Particle" shader path alpha-blends; face colour carries
      // the brightness (the glow is a near-opaque warm sprite, not additive)
      blending: THREE.NormalBlending,
      // A sprite with `distance: 0` sits EXACTLY on its host face (Saradomin's
      // eyes). The client survives the coplanarity because its billboard pass
      // reuses the mesh's transform pipeline bit-for-bit; our anchors take a
      // different path, so without a bias the depth test can z-fight the host
      // surface. (Depth write is off, so only the comparison shifts.)
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    })
    material.userData.hdrMul = 1
    // the overbright factor lives in the material meta; fill it in when it
    // resolves (the client gates HDR on the bloom filter being live)
    if (materialId >= 0 && this.materialMeta) {
      const target = material
      void this.materialMeta(materialId).then((meta) => {
        if (meta && meta.hdrMultiplier > 1) {
          target.userData.hdrMul = meta.hdrMultiplier
          target.uniforms.uHdr.value = this.bloomOn ? meta.hdrMultiplier : 1
        }
      })
    }
    this.materials.set(materialId, material)
    return material
  }

  /** Mirrors the client's `stationary` gate: those sprites are the no-bloom
   *  stand-ins, drawn only while the bloom filter is off — and HDR follows
   *  the same switch, exactly like the particle and loc materials. */
  setBloomEnabled(on: boolean): void {
    this.bloomOn = on
    // an animated gated mesh that was never posed stays hidden either way
    for (const mesh of this.gated) mesh.visible = !on && !mesh.userData.awaitingPose
    for (const material of this.materials.values()) {
      material.uniforms.uHdr.value = on ? ((material.userData.hdrMul as number) ?? 1) : 1
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
    }
    for (const material of this.materials.values()) material.dispose()
    for (const texture of this.textures) texture.dispose()
    this.fallback?.dispose()
    this.fallback = null
    this.meshes = []
    this.gated = []
    this.materials.clear()
    this.textures = []
    for (const group of this.groups) group.clear()
    this.count_ = 0
  }
}
