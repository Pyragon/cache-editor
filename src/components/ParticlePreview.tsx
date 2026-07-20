import { useEffect, useRef, useState } from 'react'
import type { ParticleData, ParticleProducer } from '../loaders/particles'
import { PARTICLE_FPS_DEFAULT, PARTICLE_FPS_KEY, PARTICLE_FPS_OPTIONS, ParticleSim } from './particleSim'
import { useZoom } from './useZoom'

type Props = {
  producer: ParticleProducer
  data: ParticleData
}

// Particles are drawn with their material's rendered PNG, tinted to the particle's
// colour. Tinting per particle per frame would be far too slow, so each colour gets a
// pre-tinted sprite, cached and quantised to 5 bits per channel.
function makeTinter(source: CanvasImageSource, w: number, h: number) {
  const cache = new Map<number, HTMLCanvasElement>()

  return (rgb: number): HTMLCanvasElement => {
    const key = ((rgb >> 3) & 0x1f) | (((rgb >> 11) & 0x1f) << 5) | (((rgb >> 19) & 0x1f) << 10)
    const hit = cache.get(key)
    if (hit) return hit

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!

    ctx.drawImage(source, 0, 0, w, h)
    // keep the material's luminance/shape, replace its hue
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = `rgb(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff})`
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(source, 0, 0, w, h)

    if (cache.size < 512) cache.set(key, canvas)
    return canvas
  }
}

// Fallback when the producer has no material: a soft round blob, which is what most
// particle materials look like anyway.
function makeDot(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.5)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 32)
  return canvas
}

export default function ParticlePreview({ producer, data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [running, setRunning] = useState(true)
  const [additive, setAdditive] = useState(true)
  const [count, setCount] = useState(0)

  // useZoom is really "persisted choice from a fixed set" — exactly what an FPS cap
  // is. Read through a ref so changing it doesn't rebuild the sim mid-flight.
  const [fps, setFps] = useZoom(PARTICLE_FPS_KEY, PARTICLE_FPS_OPTIONS, PARTICLE_FPS_DEFAULT)
  const fpsRef = useRef(fps)
  useEffect(() => { fpsRef.current = fps }, [fps])

  // The material can be huge (128x128) next to a particle a few pixels across, so it
  // is downscaled once into the sprite the tinter works from.
  const [sprite, setSprite] = useState<CanvasImageSource | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!data.materialPng) {
      setSprite(makeDot())
      return
    }
    createImageBitmap(data.materialPng).then((bitmap) => {
      if (!cancelled) setSprite(bitmap)
      else bitmap.close()
    }).catch(() => {
      if (!cancelled) setSprite(makeDot())
    })
    return () => { cancelled = true }
  }, [data.materialPng])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sprite) return

    const surface = canvas
    const ctx = surface.getContext('2d')!
    const types = [...data.types.values()]
    const sim = new ParticleSim(producer, types)

    const spriteW = 64
    const spriteH = 64
    const tint = makeTinter(sprite, spriteW, spriteH)

    let raf = 0
    let last = performance.now()
    let carry = 0

    // World units are 12-bit fixed point; this maps them onto the canvas.
    const SCALE = 900

    function frame(now: number) {
      raf = requestAnimationFrame(frame)

      // The FPS setting throttles how often a frame is PROCESSED (sim batch + draw),
      // not the sim rate — cycles still accumulate against real time below, so at
      // 10 FPS the physics run at the same speed in chunkier steps. Skipped frames
      // cost one comparison.
      if (now - last < 1000 / fpsRef.current) return

      const elapsedMs = Math.min(now - last, 250)
      last = now

      if (running) {
        // one client cycle is 20ms (the main loop increments 'cycles' at 50fps);
        // accumulate real time so the preview runs at the same rate regardless of
        // display refresh
        carry += elapsedMs / 20
        const ticks = Math.floor(carry)
        carry -= ticks
        for (let t = 0; t < ticks; t++) sim.step(1)
      }

      const { width, height } = surface
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#0d1016'
      ctx.fillRect(0, 0, width, height)

      // Emitter marker — a UI crosshair, not geometry. Standalone producers are
      // POINT emitters; they only gain a spawn triangle when a model face hosts
      // them (see the model viewer). Labelled because the bare line read as if it
      // were part of the effect.
      const originX = width / 2
      const originY = height * 0.72
      ctx.strokeStyle = '#3a4152'
      ctx.beginPath()
      ctx.moveTo(originX - 10, originY)
      ctx.lineTo(originX + 10, originY)
      ctx.moveTo(originX, originY - 6)
      ctx.lineTo(originX, originY + 6)
      ctx.stroke()
      ctx.fillStyle = '#5a6374'
      ctx.font = '10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('emitter', originX, originY + 18)

      ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over'

      for (const p of sim.particles) {
        // y is negative upward in the client's space
        const sx = originX + (p.x / 4096) * (width / SCALE) * 60
        const sy = originY + (p.y / 4096) * (height / SCALE) * 60
        const size = Math.max(2, (p.size >> 14) * 0.9)

        const alpha = ((p.color >>> 24) & 0xff) / 255
        if (alpha <= 0.004) continue

        ctx.globalAlpha = alpha
        ctx.drawImage(tint(p.color & 0xffffff), sx - size / 2, sy - size / 2, size, size)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'

      setCount(sim.particles.length)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [producer, data.types, sprite, running, additive])

  const hasTypes = data.types.size > 0
  const wantsTypes = (producer.particleFileIds?.length ?? 0) > 0

  return (
    <div className="particle-preview">
      <canvas ref={canvasRef} width={420} height={300} className="particle-canvas" />

      <div className="particle-preview-bar">
        <button type="button" className="zoom-btn" onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : 'Play'}
        </button>
        <button type="button" className={`zoom-btn${additive ? ' active' : ''}`} onClick={() => setAdditive((a) => !a)}>
          Additive
        </button>
        <span className="btn-pill">
          {PARTICLE_FPS_OPTIONS.map((f) => (
            <button key={f} type="button" className={`zoom-btn${fps === f ? ' active' : ''}`} onClick={() => setFps(f)}>
              {f} FPS
            </button>
          ))}
        </span>
        <span className="tex-op-hint">{count} particles</span>
      </div>

      {wantsTypes && !hasTypes && (
        <p className="tex-op-note">
          This producer inherits motion from particle type{producer.particleFileIds!.length > 1 ? 's' : ''}{' '}
          {producer.particleFileIds!.join(', ')}, but <code>particles/types/</code> isn't in this dump —
          particles will fly straight instead of drifting. Re-dump to pick them up.
        </p>
      )}
    </div>
  )
}
