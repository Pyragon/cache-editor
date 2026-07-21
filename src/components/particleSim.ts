// A port of the client's particle emitter, so the preview shows what the effect
// actually does rather than an invented approximation.
//
// Sources: darkan-bot-refactor ParticleProducer.processCycle (emission) and
// Particle.visualUpdate (per-tick motion, colour fade, speed/size ramps).
//
// Everything the client derives in init() from the packed colours is recomputed here
// (`deriveRuntime`), because those fields are transient and never dumped.

import type { ParticleProducer, ParticleType } from '../loaders/particles'

// Frame-rate cap options for the previews. Simulation speed is unaffected — cycles
// accumulate against real time — this only bounds how often frames are processed.
// One persisted setting shared by the particles page and the model viewer.
export const PARTICLE_FPS_OPTIONS = [10, 25, 50]
export const PARTICLE_FPS_KEY = 'cache-editor:particle-fps'
export const PARTICLE_FPS_DEFAULT = 25

// cryogen Trig: a full turn is 16384 units, values scaled by 16384.
const SINE = new Int32Array(16384)
const COSINE = new Int32Array(16384)
{
  const step = 3.834951969714103e-4
  for (let i = 0; i < 16384; i++) {
    SINE[i] = Math.trunc(16384.0 * Math.sin(i * step))
    COSINE[i] = Math.trunc(16384.0 * Math.cos(i * step))
  }
}

/** The fields ParticleProducerDefinition.init() derives; transient, so not in the JSON. */
export type Runtime = {
  minimumStartR: number
  minimumStartG: number
  minimumStartB: number
  minimumStartA: number
  redVariance: number
  greenVariance: number
  blueVariance: number
  alphaVariance: number

  colorFadeStart: number
  alphaFadeStart: number
  redFadeStep: number
  greenFadeStep: number
  blueFadeStep: number
  alphaFadeStep: number

  startSpeedChange: number
  speedStep: number
  startSizeChange: number
  sizeChangeStep: number
}

export function deriveRuntime(p: ParticleProducer): Runtime {
  const minColor = p.minimumStartColorRgb | 0
  const maxColor = p.maximumStartColorRgb | 0

  const minimumStartR = (minColor >> 16) & 0xff
  const maximumStartR = (maxColor >> 16) & 0xff
  const minimumStartG = (minColor >> 8) & 0xff
  const maximumStartG = (maxColor >> 8) & 0xff
  const minimumStartB = minColor & 0xff
  const maximumStartB = maxColor & 0xff
  const minimumStartA = (minColor >> 24) & 0xff
  const maximumStartA = (maxColor >> 24) & 0xff

  const redVariance = maximumStartR - minimumStartR
  const greenVariance = maximumStartG - minimumStartG
  const blueVariance = maximumStartB - minimumStartB
  const alphaVariance = maximumStartA - minimumStartA

  const rt: Runtime = {
    minimumStartR, minimumStartG, minimumStartB, minimumStartA,
    redVariance, greenVariance, blueVariance, alphaVariance,
    colorFadeStart: 0, alphaFadeStart: 0,
    redFadeStep: 0, greenFadeStep: 0, blueFadeStep: 0, alphaFadeStep: 0,
    startSpeedChange: 0, speedStep: 0, startSizeChange: 0, sizeChangeStep: 0,
  }

  const trunc = (a: number, b: number) => Math.trunc(a / b)

  if (p.fadeColor !== 0) {
    rt.colorFadeStart = trunc(p.colorFading * p.maximumLifetime, 100) || 1
    rt.alphaFadeStart = trunc(p.alphaFading * p.maximumLifetime, 100) || 1

    const fade = p.fadeColor | 0
    rt.redFadeStep = trunc((((fade >> 16) & 0xff) - (trunc(redVariance, 2) + minimumStartR)) << 8, rt.colorFadeStart)
    rt.greenFadeStep = trunc((((fade >> 8) & 0xff) - (trunc(greenVariance, 2) + minimumStartG)) << 8, rt.colorFadeStart)
    rt.blueFadeStep = trunc(((fade & 0xff) - (trunc(blueVariance, 2) + minimumStartB)) << 8, rt.colorFadeStart)
    rt.alphaFadeStep = trunc((((fade >> 24) & 0xff) - (trunc(alphaVariance, 2) + minimumStartA)) << 8, rt.alphaFadeStart)

    // the client nudges each step away from zero by 4
    rt.redFadeStep += rt.redFadeStep > 0 ? -4 : 4
    rt.greenFadeStep += rt.greenFadeStep > 0 ? -4 : 4
    rt.blueFadeStep += rt.blueFadeStep > 0 ? -4 : 4
    rt.alphaFadeStep += rt.alphaFadeStep > 0 ? -4 : 4
  }

  if (p.endSpeed !== -1) {
    rt.startSpeedChange = trunc(p.maximumLifetime * p.speedChange, 100) || 1
    rt.speedStep = trunc(p.endSpeed - (trunc(p.maximumSpeed - p.minimumSpeed, 2) + p.minimumSpeed), rt.startSpeedChange)
  }

  if (p.endSize !== -1) {
    rt.startSizeChange = trunc(p.sizeChange * p.maximumLifetime, 100) || 1
    rt.sizeChangeStep = trunc(p.endSize - (trunc(p.maximumSize - p.minimumSize, 2) + p.minimumSize), rt.startSizeChange)
  }

  return rt
}

export type Particle = {
  // position and direction are 12-bit fixed point
  x: number
  y: number
  z: number
  dirX: number
  dirY: number
  dirZ: number
  speed: number
  size: number
  lifespan: number
  lifetime: number
  /** packed ARGB */
  color: number
  /** the sub-byte remainder the client carries while fading */
  intermediate: number
}

/** The face a model emitter is bound to, in model units. Particles spawn on it. */
export type EmitterTriangle = {
  ax: number; ay: number; az: number
  bx: number; by: number; bz: number
  cx: number; cy: number; cz: number
}

/**
 * An effective vertex, resolved: a particle type anchored at a model vertex, pulling
 * or pushing nearby particles. dirX/Y/Z is the type's offset vector through the model
 * matrix — identity in the previews, so the raw offsets (EffectiveVerticeEffect
 * computes the same defaultMatrixX/Z; Y is used untransformed by the client).
 */
export type Effector = {
  x: number
  y: number
  z: number
  effectId: number
  type: ParticleType
  /** Only X and Z exist transformed — the client's effect node has no defaultMatrixY. */
  dirX: number
  dirZ: number
}

export class ParticleSim {
  particles: Particle[] = []
  private rate = 0
  private rt: Runtime
  private producer: ParticleProducer
  private types: ParticleType[]
  private triangle: EmitterTriangle | null
  // the emitter's centre, which the distance-based speed falloff measures from
  private centerX = 0
  private centerY = 0
  private centerZ = 0
  /** Oldest particles are dropped past this, like the client's ring buffer. */
  maxParticles = Infinity

  // The emission axis: the triangle's face normal, normalised to 32767. The client
  // centres the angular spreads on this via atan2 (baseRotation in ParticleProducer),
  // so a wall-mounted emitter sprays out of the wall, not straight up. Zero for a
  // point emitter, which reproduces the client's degenerate-triangle case exactly.
  private axisX = 0
  private axisY = 0
  private axisZ = 0
  private thetaH = 0
  private thetaV = 0
  /** Sim age in client cycles, which the emission window gates on. */
  private age = 0

  // Effectors that can act on this producer's particles, pre-filtered per the
  // client's two loops: `viaFileIds2` mirrors the system-list loop (matches
  // particleFileIds2, skips handlingType 1), `viaUids` the global-map loop
  // (matches effectiveVertexUids, no handling filter).
  private viaFileIds2: Effector[] = []
  private viaUids: Effector[] = []

  constructor(producer: ParticleProducer, types: ParticleType[], triangle?: EmitterTriangle, effectors?: Effector[]) {
    this.producer = producer
    this.types = types
    this.rt = deriveRuntime(producer)
    this.triangle = triangle ?? null

    if (effectors?.length) {
      const ids2 = producer.particleFileIds2 ?? []
      const uids = producer.effectiveVertexUids ?? []
      for (const effector of effectors) {
        if (effector.type.particleHandlingType !== 1 && ids2.includes(effector.type.id)) {
          this.viaFileIds2.push(effector)
        }
        if (uids.includes(effector.effectId)) {
          this.viaUids.push(effector)
        }
      }
    }
    if (triangle) this.setTriangle(triangle)
  }

  /** Re-anchor the emitter to a moved face (skeletal animation) without
   *  resetting live particles — recomputes the spawn centre and emission axis
   *  exactly like construction. */
  setTriangle(triangle: EmitterTriangle) {
    this.triangle = triangle
    this.centerX = Math.trunc((triangle.ax + triangle.bx + triangle.cx) / 3)
    this.centerY = Math.trunc((triangle.ay + triangle.by + triangle.cy) / 3)
    this.centerZ = Math.trunc((triangle.az + triangle.bz + triangle.cz) / 3)

    // cross(B-A, C-A), component order per the client
    const bax = triangle.bx - triangle.ax
    const bay = triangle.by - triangle.ay
    const baz = triangle.bz - triangle.az
    const cax = triangle.cx - triangle.ax
    const cay = triangle.cy - triangle.ay
    const caz = triangle.cz - triangle.az
    let mx = (bay * caz - baz * cay) | 0
    let my = (baz * cax - bax * caz) | 0
    let mz = (bax * cay - cax * bay) | 0

    while (mx > 32767 || my > 32767 || mz > 32767 || mx < -32767 || my < -32767 || mz < -32767) {
      mx >>= 1
      my >>= 1
      mz >>= 1
    }

    let divider = Math.trunc(Math.sqrt(mz * mz + my * my + mx * mx))
    if (divider <= 0) divider = 1
    this.axisX = Math.trunc((mx * 32767) / divider)
    this.axisY = Math.trunc((my * 32767) / divider)
    this.axisZ = Math.trunc((mz * 32767) / divider)

    // 2607.594… is 16384 / 2π — radians to 14-bit angle units
    if (this.producer.maximumAngleH > 0 || this.producer.maximumAngleV > 0) {
      this.thetaH = Math.trunc(Math.atan2(this.axisZ, this.axisX) * 2607.5945876176133)
      this.thetaV = Math.trunc(
        Math.atan2(this.axisY, Math.sqrt(this.axisX * this.axisX + this.axisZ * this.axisZ)) * 2607.5945876176133,
      )
    }
  }

  get runtime() {
    return this.rt
  }

  reset() {
    this.particles = []
    this.rate = 0
  }

  /** One client cycle (20ms). `delta` is in cycles. */
  step(delta: number) {
    // The emission window: with a finite producer lifetime, emission is only live
    // during [0, emissionEndTime) each period when activeFirst, or the complement
    // when not. Non-periodic producers stop for good after one period. Particles
    // already in flight keep updating either way.
    const p = this.producer
    let emitting = true
    if (p.lifetime !== -1 && p.lifetime > 0) {
      let timeAlive = this.age
      if (!p.periodic && timeAlive > p.lifetime) {
        emitting = false
      } else {
        timeAlive %= p.lifetime
      }
      if (!p.activeFirst && timeAlive < p.emissionEndTime) emitting = false
      if (p.activeFirst && timeAlive >= p.emissionEndTime) emitting = false
    }
    // Existing particles update BEFORE new ones are emitted, exactly as the client
    // orders performUpdate — newborns aren't touched until the next cycle, which is
    // the only reason 1-tick-lifetime particles (producer 315) are visible at all.
    const next: Particle[] = []
    for (const particle of this.particles) {
      if (this.update(particle, delta)) next.push(particle)
    }
    this.particles = next

    if (emitting) this.emit(delta)
    this.age += delta
  }

  private emit(delta: number) {
    const p = this.producer

    // rate is in 1/64ths of a particle per tick
    this.rate += Math.trunc(delta * (p.minimumParticleRate + Math.random() * (p.maximumParticleRate - p.minimumParticleRate)))
    if (this.rate <= 63) return

    const count = this.rate >> 6
    this.rate &= 0x3f

    for (let i = 0; i < count; i++) {
      // The angular spreads span `max - min`, CENTRED on `min` plus the emission
      // axis's theta — min is an offset, not a floor, which is why a producer can
      // legitimately have max < min. With no spread at all, particles fly straight
      // along the axis (the face normal; zero for a point emitter).
      let dirX: number
      let dirY: number
      let dirZ: number

      if (p.maximumAngleH <= 0 && p.maximumAngleV <= 0) {
        dirX = this.axisX
        dirY = this.axisY
        dirZ = this.axisZ
      } else {
        const spreadH = p.maximumAngleH - p.minimumAngleH
        const spreadV = p.maximumAngleV - p.minimumAngleV
        const baseH = p.minimumAngleH + this.thetaH - (spreadH >> 1)
        const baseV = p.minimumAngleV + this.thetaV - (spreadV >> 1)

        const rotH = (baseH + Math.trunc(spreadH * Math.random())) & 0x3fff
        const rotV = (baseV + Math.trunc(spreadV * Math.random())) & 0x1fff

        const sinH = SINE[rotH]
        const cosH = COSINE[rotH]
        const sinV = SINE[rotV]
        const cosV = COSINE[rotV]

        dirX = (cosH * sinV) >> 13
        dirY = (cosV << 1) * -1
        dirZ = (sinV * sinH) >> 13
      }

      const speed = p.minimumSpeed + Math.trunc(Math.random() * (p.maximumSpeed - p.minimumSpeed))
      const lifetime = p.minimumLifetime + Math.trunc(Math.random() * (p.maximumLifetime - p.minimumLifetime))
      const size = p.minimumSize + Math.trunc(Math.random() * (p.maximumSize - p.minimumSize))

      const rt = this.rt
      let color: number
      if (p.uniformColorVariance) {
        // one roll shared by R, G and B — keeps the ramp on a single hue line
        const r = Math.random()
        color =
          (Math.trunc(r * rt.redVariance + rt.minimumStartR) << 16) |
          (Math.trunc(rt.minimumStartG + r * rt.greenVariance) << 8) |
          Math.trunc(rt.minimumStartB + r * rt.blueVariance) |
          (Math.trunc(rt.minimumStartA + Math.random() * rt.alphaVariance) << 24)
      } else {
        color =
          (Math.trunc(rt.minimumStartR + Math.random() * rt.redVariance) << 16) |
          (Math.trunc(rt.minimumStartG + Math.random() * rt.greenVariance) << 8) |
          Math.trunc(rt.minimumStartB + Math.random() * rt.blueVariance) |
          (Math.trunc(rt.minimumStartA + Math.random() * rt.alphaVariance) << 24)
      }

      // A model emitter spawns each particle at a random point on its triangle —
      // the client folds the two barycentric rolls so the sample stays inside it.
      let x = 0
      let y = 0
      let z = 0
      const tri = this.triangle
      if (tri) {
        let a = Math.fround(Math.random())
        let b = Math.fround(Math.random())
        if (a + b > 1.0) {
          a = 1.0 - a
          b = 1.0 - b
        }
        const c = 1.0 - (a + b)
        x = Math.trunc(b * tri.bx + tri.ax * a + tri.cx * c) << 12
        y = Math.trunc(b * tri.by + tri.ay * a + tri.cy * c) << 12
        z = Math.trunc(c * tri.cz + tri.az * a + tri.bz * b) << 12
      }

      this.particles.push({
        x, y, z,
        dirX, dirY, dirZ,
        speed, size,
        lifespan: lifetime,
        lifetime,
        color,
        intermediate: 0,
      })
    }

    if (this.particles.length > this.maxParticles) {
      this.particles.splice(0, this.particles.length - this.maxParticles)
    }
  }

  /** Returns false when the particle dies. */
  private update(pt: Particle, delta: number): boolean {
    const p = this.producer
    const rt = this.rt

    pt.lifetime -= delta
    if (pt.lifetime <= 0) return false

    const elapsed = pt.lifespan - pt.lifetime

    // Colour fade. The client keeps a sub-byte remainder in `intermediate` and does
    // the whole thing in 16-bit fixed point, which is why the ramps look smooth even
    // though the visible channels are bytes.
    if (p.fadeColor !== 0) {
      if (elapsed <= rt.colorFadeStart) {
        let red = delta * rt.redFadeStep + ((pt.color >> 8) & 0xff00) + ((pt.intermediate >> 16) & 0xff)
        let green = delta * rt.greenFadeStep + (pt.color & 0xff00) + ((pt.intermediate >> 8) & 0xff)
        let blue = delta * rt.blueFadeStep + ((pt.color << 8) & 0xff00) + (pt.intermediate & 0xff)

        red = red < 0 ? 0 : red > 0xffff ? 0xffff : red
        green = green < 0 ? 0 : green > 0xffff ? 0xffff : green
        blue = blue < 0 ? 0 : blue > 0xffff ? 0xffff : blue

        pt.color = (pt.color & ~0xffffff) | ((green & 0xff00) + ((blue & 0xff00) >> 8) + ((red & 0xff00) << 8))
        pt.intermediate = (pt.intermediate & ~0xffffff) | ((blue & 0xff) + ((red & 0xff) << 16) + ((green & 0xff) << 8))
      }

      if (elapsed <= rt.alphaFadeStart) {
        let alpha = delta * rt.alphaFadeStep + ((pt.intermediate >> 24) & 0xff) + ((pt.color >> 16) & 0xff00)
        alpha = alpha < 0 ? 0 : alpha > 0xffff ? 0xffff : alpha

        pt.color = (pt.color & 0xffffff) | ((alpha & 0xff00) << 16)
        pt.intermediate = (pt.intermediate & 0xffffff) | ((alpha & 0xff) << 24)
      }
    }

    if (p.endSpeed !== -1 && elapsed <= rt.startSpeedChange) pt.speed += rt.speedStep * delta
    if (p.endSize !== -1 && elapsed <= rt.startSizeChange) pt.size += rt.sizeChangeStep * delta

    const tileX = pt.x >> 12
    const tileY = pt.y >> 12
    const tileZ = pt.z >> 12

    // speed falloff with distance from the emitter's centre
    const offX = tileX - this.centerX
    const offY = tileY - this.centerY
    const offZ = tileZ - this.centerZ
    // `shr` on a Java long floors; Math.trunc would round toward zero and drift on
    // negative values, so these use Math.floor.
    if (p.speedUpdateType === 1) {
      const dist = Math.trunc(Math.sqrt(offX * offX + offY * offY + offZ * offZ)) >> 2
      const falloff = delta * dist * p.speedFallOffStep
      pt.speed = pt.speed - Math.floor((pt.speed * falloff) / 262144)
    } else if (p.speedUpdateType === 2) {
      const dist = offX * offX + offY * offY + offZ * offZ
      const falloff = delta * dist * p.speedFallOffStep
      pt.speed = pt.speed - Math.floor((pt.speed * falloff) / 268435456)
    }

    let dirX = pt.dirX
    let dirY = pt.dirY
    let dirZ = pt.dirZ
    let accelerated = false

    // Effectors: an anchored particle type pulls/pushes particles inside its range
    // (`uid`, squared distance) and facing cone (`zan`, against the direction vector).
    // Ported from the two loops in Particle.visualUpdate; the maths are identical,
    // only the matching differs, which the constructor pre-filtered. Note the dot
    // product's Y term uses the TYPE's raw offsetY — only X/Z go through the model
    // matrix in the client. A zero-length direction gives NaN and never passes the
    // cone check, exactly as in Kotlin.
    const applyEffector = (effector: Effector) => {
      const t = effector.type
      const offX = tileX - effector.x
      const offY = tileY - effector.y
      const offZ = tileZ - effector.z
      const distSq = offX * offX + offY * offY + offZ * offZ
      if (distSq > t.uid) return

      let dimension = Math.sqrt(distSq)
      if (dimension === 0) dimension = 1

      const facing = ((offX * effector.dirX + offY * t.offsetY + offZ * effector.dirZ) * 65535.0) / (t.size3d * dimension)
      if (!(facing >= t.zan)) return

      let push = 0
      if (t.type === 1) push = (dimension / 16.0) * t.sizeMultiplier
      else if (t.type === 2) push = (dimension / 16.0) * (dimension / 16.0) * t.sizeMultiplier

      if (t.verticeCalculationType === 0) {
        // along the effector's own direction
        if (t.currentOffset === 0) {
          dirX += (effector.dirX - push) * delta
          dirY += (t.offsetY - push) * delta
          dirZ += (effector.dirZ - push) * delta
          accelerated = true
        } else {
          pt.x = Math.trunc(pt.x + (effector.dirX - push) * delta)
          pt.y = Math.trunc(pt.y + (t.offsetY - push) * delta)
          pt.z = Math.trunc(pt.z + (effector.dirZ - push) * delta)
        }
      } else {
        // radial, away from the effector vertex
        const rx = (offX / dimension) * t.size3d
        const ry = (offY / dimension) * t.size3d
        const rz = (offZ / dimension) * t.size3d
        if (t.currentOffset === 0) {
          dirX += rx * delta
          dirY += ry * delta
          dirZ += rz * delta
          accelerated = true
        } else {
          pt.x = Math.trunc(pt.x + rx * delta)
          pt.y = Math.trunc(pt.y + ry * delta)
          pt.z = Math.trunc(pt.z + rz * delta)
        }
      }
    }

    for (const effector of this.viaFileIds2) applyEffector(effector)
    for (const effector of this.viaUids) applyEffector(effector)

    // Motion offsets inherited from the particle types (gravity, wind, drift).
    // currentOffset 0 accelerates the particle; otherwise it displaces it directly.
    for (const type of this.types) {
      if (type.currentOffset === 0) {
        dirX += delta * type.offsetX
        dirY += delta * type.offsetY
        dirZ += delta * type.offsetZ
        accelerated = true
      } else {
        pt.x += type.offsetX * delta
        pt.y += type.offsetY * delta
        pt.z += type.offsetZ * delta
      }
    }

    if (accelerated) {
      // direction is a short; when it overflows the client halves it and doubles
      // the speed instead, which keeps the velocity but restores the range
      while (dirX > 32767 || dirY > 32767 || dirZ > 32767 || dirX < -32767 || dirY < -32767 || dirZ < -32767) {
        dirX /= 2
        dirY /= 2
        dirZ /= 2
        pt.speed <<= 1
      }
      pt.dirX = Math.trunc(dirX)
      pt.dirY = Math.trunc(dirY)
      pt.dirZ = Math.trunc(dirZ)
    }

    // dir * velocity is a LONG multiply in the client, then shr 23 (floor)
    const velocity = pt.speed << 2
    pt.x += Math.floor((pt.dirX * velocity) / 8388608) * delta
    pt.y += Math.floor((pt.dirY * velocity) / 8388608) * delta
    pt.z += Math.floor((pt.dirZ * velocity) / 8388608) * delta

    return true
  }
}
