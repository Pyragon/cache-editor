import * as THREE from 'three'
import type { ModelData } from '../loaders/models'
import type { ParticleProducer, ParticleType } from '../loaders/particles'
import { ParticleSim } from './particleSim'
import type { Effector } from './particleSim'

/**
 * Particle emitters for the 3D scenes (map view, cutscene player).
 *
 * A loc model can bind particle producers to individual faces: the face is a
 * spawn surface, not geometry, and the client scatters particles over it every
 * frame (`RSMesh.particleConfig` → `MeshRasterizer_Sub2.method11273`). Without
 * this, every fire, torch, brazier and waterfall in the world is just its
 * charred/unlit prop — see EDITOR.md's emitter trace.
 *
 * The simulation itself is `ParticleSim`, the client-faithful port the particles
 * page and the model viewer already use. This adds what a whole scene needs on
 * top: placement (the sim runs in model space, the scene needs it under a
 * placement matrix), and a budget, because a region has far more emitters than
 * a single model preview ever does.
 */

const PARTICLE_VERT = `
  attribute float psize;
  attribute vec4 pcolor;
  varying vec4 vColor;
  varying float vFogDepth;
  uniform float uScale;
  void main() {
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    gl_PointSize = psize * (uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const PARTICLE_FRAG = `
  uniform sampler2D map;
  uniform float uHdr;
  uniform float uAmbient;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec4 vColor;
  varying float vFogDepth;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    // The particle ARGB is an sRGB value the client writes straight to its
    // sRGB target; our chain renders into a LINEAR buffer that the OutputPass
    // re-encodes, so the tint must be linearized first or every particle
    // displays brightened — the black smoke plume read as light grey.
    // (The sampled texture is already linear: its colorSpace is SRGB.)
    vec3 tint = pow(vColor.rgb, vec3(2.2));
    // uHdr pushes an overbright material past 1.0 so the scene's bloom pass
    // sees it — part of the halo around a fire. 1.0 for everything else.
    vec3 rgb = tint * tex.rgb * uHdr * uAmbient;
    // Region distance fog, on the FINAL colour: the client's Particle effect
    // is fixed-function, so D3D vertex fog applies to particles exactly as to
    // geometry. The raw (unlinearized) fog colour keeps a fully-fogged
    // particle converging to the same backdrop the meshes fade to.
    float fogF = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
    gl_FragColor = vec4(mix(rgb, fogColor, fogF), vColor.a * tex.a);
  }
`

/** Fallback when a producer has no material — most of them look like this anyway. */
export function makeDotTexture(): THREE.Texture {
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

/** A model's emitters/billboards, with the placement that puts them in the scene. */
export type LocEmitter = {
  model: ModelData
  /** placement matrix, as handed to ModelAccumulator.addModel */
  matrix: THREE.Matrix4
  /** the pre-13 <<2 the scene applies to this model's vertices */
  upscale: number
  /** render plane, so plane toggles hide the particles with their loc */
  plane: number
  /** the loc has an idle sequence — its billboards must be driven by the
   *  posed frames (SceneBillboards.addAnimated), not built at rest pose */
  animated?: boolean
}

/** A producer's material id, which is what carries its blend and HDR flags. */
function materialIdOf(info: { producer: Record<string, unknown> }): number {
  return (info.producer as { materialId?: number }).materialId ?? -1
}

type System = {
  sim: ParticleSim
  points: THREE.Points
  holder: THREE.Object3D
  geometry: THREE.BufferGeometry
  material: THREE.ShaderMaterial
  positions: Float32Array
  colors: Float32Array
  sizes: Float32Array
  /** scene-space position of the emitter, for the nearest-N ranking */
  centre: THREE.Vector3
  sizeScale: number
  cap: number
  /** the material's overbright factor, applied only while bloom is on */
  hdrMul: number
  /** adjustsLightIntensity: lit by the scene ambient rather than full-bright */
  followsLight: boolean
  active: boolean
  /** host model hidden/off-camera — the client only simulates particles for
   *  models it is DRAWING (a system undrawn for 750ms is killed and pooled),
   *  so a suspended system doesn't step, and one suspended long enough resets
   *  to the fresh state a re-created producer would have */
  suspended?: boolean
  /** performance.now() when suspension began; cleared once the reset fires */
  suspendedAt?: number | null
}

/** One client tick. The sim counts in these, not in frames. */
const CYCLE_MS = 20
/**
 * Per-emitter ring size: rate × lifetime, which is what the producer actually
 * holds in flight once it settles. One number for every producer was wrong in
 * both directions — the God Wars flames settle near 500 (41/cycle × 16), while
 * the smoke plume over them runs to ~2,600 (7/cycle × 400 cycles): capped at
 * 512 the plume lost four fifths of its particles, which is why it read as thin
 * grey wisps instead of the dense black column the game shows. The clamp is a
 * memory guard, not a look control.
 */
function capacityFor(producer: { maximumParticleRate?: number; maximumLifetime?: number }): number {
  const inFlight = (producer.maximumParticleRate ?? 8) * (producer.maximumLifetime ?? 50)
  return Math.max(128, Math.min(4096, inFlight))
}

/** How many emitters may simulate at once; the nearest to the FOCUS win.
 *  There is no distance cut-off, and the ranking is against the point the
 *  camera looks at (the orbit target), not the camera itself: the chapel
 *  region alone holds 68 emitters, and ranking from a far-orbiting camera let
 *  the 40 candles nearest the CAMERA evict the fire in the middle of the
 *  screen — which read as particles vanishing with distance. */
const MAX_ACTIVE = 64

export class SceneParticles {
  /** Add this to the scene (or to a plane group, to inherit its visibility). */
  readonly groups: THREE.Group[] = [new THREE.Group(), new THREE.Group(), new THREE.Group(), new THREE.Group()]
  private systems: System[] = []
  private textures = new Map<number, THREE.Texture>()
  private ownedTextures: THREE.Texture[] = []
  private carry = 0
  private live = 0
  private scale = 1
  private materialMeta: ((id: number) => Promise<{ hdrMultiplier: number; effectCombiner: number } | null>) | null = null

  /** Where a producer's material metadata comes from (the scene's LocAssets). */
  setMaterialLookup(lookup: (id: number) => Promise<{ hdrMultiplier: number; effectCombiner: number } | null>): void {
    this.materialMeta = lookup
  }

  private hdrOn = true
  /** the scene's IA() value — ambient × the Brightness preference multiplier */
  private ambient = 1
  /** region fog mirrored from scene.fog (near 1e8 = fog off) */
  private fogColor = new THREE.Color(0xc8c0a8)
  private fogNear = 1e8
  private fogFar = 1e9

  /** Mirror the scene's fog (the client's fixed-function fog covers particles
   *  like geometry). Pass null to disable. */
  setFog(colorHex: number | null, near = 1e8, far = 1e9): void {
    if (colorHex !== null) this.fogColor.setHex(colorHex & 0xffffff)
    this.fogNear = colorHex === null ? 1e8 : near
    this.fogFar = colorHex === null ? 1e9 : far
    for (const system of this.systems) {
      const u = system.material.uniforms
      ;(u.fogColor.value as THREE.Color).copy(this.fogColor)
      u.fogNear.value = this.fogNear
      u.fogFar.value = this.fogFar
    }
  }

  /**
   * The client gates HDR float textures on the bloom filter being live (Class66
   * checks method8471(), which IS the bloom filter), and the loc materials here
   * follow it — so the flames must too, or toggling bloom changes everything in
   * the scene except the fire, and there is no way to compare the dim-orange
   * no-bloom look against the client.
   */
  setHdrEnabled(on: boolean): void {
    this.hdrOn = on
    for (const system of this.systems) {
      system.material.uniforms.uHdr.value = on ? system.hdrMul : 1
    }
  }

  /**
   * The scene ambient, for producers with `adjustsLightIntensity`. Traced in
   * the DirectX path (Class54.method1095, HardwareRenderer.aClass54_8837): the
   * flag batches particles and switches the renderer between IA(sceneAmbient)
   * and IA(1.0) — the particle is LIT BY the scene like geometry is, or drawn
   * full-bright. It does NOT make the emitter light its surroundings (an
   * earlier note here claimed that; wrong). The warm pool a fire casts in game
   * is its HDR overbright spread by the bloom filter.
   */
  setAmbient(ambient: number): void {
    this.ambient = ambient
    for (const system of this.systems) {
      system.material.uniforms.uAmbient.value = system.followsLight ? ambient : 1
    }
  }

  /** Whether anything was collected at all — lets a caller skip the per-frame work. */
  get count(): number {
    return this.systems.length
  }

  /**
   * Builds the systems for one placed loc. The sim runs in the model's own
   * space (its physics — gravity, speed, the emission axis — are authored
   * there), and the placement rides on a holder object: model units scaled by
   * the pre-13 upscale, y and z negated exactly as the mesh builder does, and
   * 4096 to undo the sim's 12-bit fixed point.
   *
   * Returns a removal handle for callers whose emitters are transient (an
   * entity gfx that ends) — region locs just ignore it — plus a pose hook:
   * the client re-reads each emitter triangle from the POSED model every
   * frame (ParticleProducer.updatePosition), and sequences use that to gate
   * emission by collapsing the face to a point (see ParticleSim.unmoved).
   * Callers that animate the host model should call `pose` with each posed
   * frame — and pass `awaitFirstPose` so the sims don't leak a burst off the
   * rest-pose triangles in the ticks before the first posed frame lands (the
   * client's producers read the posed triangle from birth). Static hosts pass
   * neither and emit from the rest pose, as they should.
   *
   * `setVisible` mirrors the client's render-driven lifecycle: producers only
   * exist for models being DRAWN, so a host that is hidden or out of shot
   * should suspend its systems (cutscene 12's wall spawns at cycle 0 but the
   * camera doesn't reach it until 235 — the client meets it dust-free, not
   * under four seconds of accumulated cloud).
   */
  async add({ model, matrix, upscale, plane }: LocEmitter, awaitFirstPose = false): Promise<{ remove(): void; pose(posed: { x: Int32Array; y: Int32Array; z: Int32Array }): void; setVisible(visible: boolean): void } | null> {
    if (!model.emitters?.length) return null
    const created: System[] = []
    const anchors: { sim: ParticleSim; ia: number; ib: number; ic: number }[] = []
    const effectors: Effector[] = []
    for (const effector of model.effectors ?? []) {
      const type = model.effectorTypes.get(effector.effectId)
      if (!type || effector.vertex < 0 || effector.vertex >= model.vertexCount) continue
      effectors.push({
        x: model.vertexX[effector.vertex],
        y: model.vertexY[effector.vertex],
        z: model.vertexZ[effector.vertex],
        effectId: effector.effectId,
        type: type as ParticleType,
        dirX: type.offsetX,
        dirZ: type.offsetZ,
      })
    }

    for (const emitter of model.emitters) {
      const info = model.emitterProducers.get(emitter.producerId)
      if (!info || emitter.face < 0 || emitter.face >= model.faceCount) continue
      const ia = model.triangleX[emitter.face], ib = model.triangleY[emitter.face], ic = model.triangleZ[emitter.face]
      if (ia >= model.vertexCount || ib >= model.vertexCount || ic >= model.vertexCount) continue

      const sim = new ParticleSim(
        info.producer as unknown as ParticleProducer,
        info.types as ParticleType[],
        {
          ax: model.vertexX[ia], ay: model.vertexY[ia], az: model.vertexZ[ia],
          bx: model.vertexX[ib], by: model.vertexY[ib], bz: model.vertexZ[ib],
          cx: model.vertexX[ic], cy: model.vertexY[ic], cz: model.vertexZ[ic],
        },
        effectors,
      )
      const cap = capacityFor(info.producer as { maximumParticleRate?: number; maximumLifetime?: number })
      sim.maxParticles = cap
      if (awaitFirstPose) sim.holdUntilPosed()
      anchors.push({ sim, ia, ib, ic })

      const positions = new Float32Array(cap * 3)
      const colors = new Float32Array(cap * 4)
      const sizes = new Float32Array(cap)
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('pcolor', new THREE.BufferAttribute(colors, 4))
      geometry.setAttribute('psize', new THREE.BufferAttribute(sizes, 1))
      geometry.setDrawRange(0, 0)
      // the sim writes model-space coordinates; the holder places them, so the
      // bounds are meaningless here and would cull the whole cloud at once
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)

      // Particles blend exactly like loc faces do, off the material's
      // `effectCombiner`: every particle material in the cache is 2, the
      // alpha-blended path. That is what makes smoke black — the God Wars plume
      // (producer 179, material 850) is #333333 → #000000 at alpha 70-90, so
      // alpha-blending DARKENS what is behind it. Additive cannot: it only ever
      // brightens, which turned that same plume into grey haze.
      //
      // Brightness comes from the material's HDR instead: the flames (producer
      // 397, material 1585, `hdr: true`) are pushed past 1.0 by uHdr and the
      // scene's bloom pass turns that into the yellow halo a fire has in game.
      // The smoke's material is `hdr: false`, so it stays dark. Same two
      // mechanisms the loc renderer already uses — nothing particle-specific.
      const textured = (info.producer as { isTextured?: boolean }).isTextured !== false
      const followsLight = (info.producer as { adjustsLightIntensity?: boolean }).adjustsLightIntensity !== false
      const meta = textured ? await this.materialMeta?.(materialIdOf(info)) ?? null : null
      const material = new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        uniforms: {
          map: { value: textured ? this.textureFor(emitter.producerId, info.material) : this.dot() },
          uScale: { value: this.scale },
          // starts at the overbright value only while HDR is enabled — the
          // client gates HDR on the bloom filter being live (see setHdrEnabled)
          uHdr: { value: this.hdrOn && meta && meta.hdrMultiplier > 1 ? meta.hdrMultiplier : 1 },
          uAmbient: { value: followsLight ? this.ambient : 1 },
          fogColor: { value: this.fogColor.clone() },
          fogNear: { value: this.fogNear },
          fogFar: { value: this.fogFar },
        },
        transparent: true,
        depthWrite: false,
        // effectCombiner 1 is the client's additive combiner; everything shipped
        // for particles is 2, but honour it rather than assuming.
        blending: meta?.effectCombiner === 1 ? THREE.AdditiveBlending : THREE.NormalBlending,
      })

      const points = new THREE.Points(geometry, material)
      points.frustumCulled = false // the holder moves it; see the bounds note above
      // AFTER the billboards (renderOrder 2): the client draws billboards in
      // the object pass with their host model and particles later, so flames
      // render over a fire's glow sprite, never under it
      points.renderOrder = 3
      const holder = new THREE.Object3D()
      holder.matrixAutoUpdate = false
      holder.matrix.copy(matrix).multiply(
        new THREE.Matrix4().makeScale(upscale / 4096, -upscale / 4096, -upscale / 4096),
      )
      holder.add(points)
      this.groups[Math.max(0, Math.min(3, plane))].add(holder)

      const centre = new THREE.Vector3(
        (model.vertexX[ia] + model.vertexX[ib] + model.vertexX[ic]) / 3,
        -(model.vertexY[ia] + model.vertexY[ib] + model.vertexY[ic]) / 3,
        -(model.vertexZ[ia] + model.vertexZ[ib] + model.vertexZ[ic]) / 3,
      ).multiplyScalar(upscale).applyMatrix4(matrix)

      const system: System = {
        sim, points, holder, geometry, material, positions, colors, sizes, centre,
        sizeScale: upscale, cap, hdrMul: meta && meta.hdrMultiplier > 1 ? meta.hdrMultiplier : 1, followsLight, active: true,
      }
      this.systems.push(system)
      created.push(system)
    }
    if (created.length === 0) return null
    return {
      remove: () => {
        for (const system of created) {
          system.holder.parent?.remove(system.holder)
          system.holder.remove(system.points)
          system.geometry.dispose()
          system.material.dispose()
        }
        this.systems = this.systems.filter((s) => !created.includes(s))
      },
      pose: (posed) => {
        for (const { sim, ia, ib, ic } of anchors) {
          sim.setTriangle({
            ax: posed.x[ia], ay: posed.y[ia], az: posed.z[ia],
            bx: posed.x[ib], by: posed.y[ib], bz: posed.z[ib],
            cx: posed.x[ic], cy: posed.y[ic], cz: posed.z[ic],
          })
        }
      },
      setVisible: (visible) => {
        for (const system of created) {
          if (system.suspended === !visible) continue
          system.suspended = !visible
          system.suspendedAt = visible ? null : performance.now()
        }
      },
    }
  }

  private dotTexture: THREE.Texture | null = null

  /** The soft blob untextured producers draw with, shared by all of them. */
  private dot(): THREE.Texture {
    if (!this.dotTexture) {
      this.dotTexture = makeDotTexture()
      this.ownedTextures.push(this.dotTexture)
    }
    return this.dotTexture
  }

  private textureFor(producerId: number, material: Blob | null): THREE.Texture {
    let texture = this.textures.get(producerId)
    if (texture) return texture
    texture = makeDotTexture()
    this.textures.set(producerId, texture)
    this.ownedTextures.push(texture)
    if (material) {
      const target = texture
      // premultiplyAlpha MUST be 'none' — Chromium premultiplies by default and
      // three uploads the bitmap as-is, so a soft-alpha sprite gets its rgb
      // darkened by its own alpha (the same trap every other texture load in
      // this codebase already avoids; see the notes in mapScene's getTexture).
      createImageBitmap(material, { premultiplyAlpha: 'none' }).then((bitmap) => {
        target.image = bitmap
        target.needsUpdate = true
      }).catch(() => { /* keep the dot */ })
    }
    return texture
  }

  /** gl_PointSize is in pixels, so the world→pixel factor follows the viewport. */
  setViewport(heightPx: number, fovDeg: number): void {
    this.scale = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)))
    for (const system of this.systems) system.material.uniforms.uScale.value = this.scale
  }

  /**
   * Advances every simulating emitter and refreshes its buffers. Emitters are
   * ranked by distance to the camera and only the nearest `MAX_ACTIVE` run —
   * a region can hold hundreds, and each one is a full client sim. The rest are
   * hidden and left frozen rather than reset, so walking back towards a fire
   * finds it already burning.
   *
   * Returns how many are live, so a caller can keep its idle throttle asleep in
   * a region whose emitters are all out of range.
   */
  step(deltaMs: number, camera: THREE.Camera, focus?: THREE.Vector3): number {
    if (this.systems.length === 0) return 0
    this.carry += Math.min(deltaMs, 250)
    const ticks = Math.floor(this.carry / CYCLE_MS)
    this.carry -= ticks * CYCLE_MS
    if (ticks === 0) return this.live

    if (this.systems.length > MAX_ACTIVE) {
      const anchor = focus ?? camera.position
      const ranked = this.systems
        .map((s) => ({ s, d: s.centre.distanceToSquared(anchor) }))
        .sort((a, b) => a.d - b.d)
      for (let i = 0; i < ranked.length; i++) ranked[i].s.active = i < MAX_ACTIVE
    } else {
      for (const system of this.systems) system.active = true
    }

    this.live = 0
    for (const system of this.systems) {
      // host not being drawn: no stepping (nothing accumulates off-camera),
      // and past the client's 750ms kill window the system resets to what a
      // freshly created producer would be
      if (system.suspended) {
        if (system.points.visible) system.points.visible = false
        if (system.suspendedAt != null && performance.now() - system.suspendedAt > 750) {
          system.sim.reset()
          system.geometry.setDrawRange(0, 0)
          system.suspendedAt = null
        }
        continue
      }
      if (!system.active) {
        if (system.points.visible) system.points.visible = false
        continue
      }
      this.live++
      system.points.visible = true
      for (let t = 0; t < ticks; t++) system.sim.step(1)

      const { sim, positions, colors, sizes, geometry, sizeScale, cap } = system
      let n = 0
      for (const p of sim.particles) {
        if (n >= cap) break
        const alpha = ((p.color >>> 24) & 0xff) / 255
        if (alpha <= 0.004) continue
        // raw sim space — the holder applies the scene placement
        positions[n * 3] = p.x
        positions[n * 3 + 1] = p.y
        positions[n * 3 + 2] = p.z
        colors[n * 4] = ((p.color >> 16) & 0xff) / 255
        colors[n * 4 + 1] = ((p.color >> 8) & 0xff) / 255
        colors[n * 4 + 2] = (p.color & 0xff) / 255
        colors[n * 4 + 3] = alpha
        // size is fixed-point like the coordinates, and in WORLD units — the
        // holder's scale doesn't reach gl_PointSize
        sizes[n] = Math.max((p.size / 4096) * 2 * sizeScale, 1)
        n++
      }
      geometry.setDrawRange(0, n)
      geometry.attributes.position.needsUpdate = true
      geometry.attributes.pcolor.needsUpdate = true
      geometry.attributes.psize.needsUpdate = true
    }
    return this.live
  }

  dispose(): void {
    for (const system of this.systems) {
      system.holder.remove(system.points)
      system.geometry.dispose()
      system.material.dispose()
    }
    for (const texture of this.ownedTextures) texture.dispose()
    this.systems = []
    this.dotTexture = null
    this.textures.clear()
    this.ownedTextures = []
    for (const group of this.groups) group.clear()
  }
}
