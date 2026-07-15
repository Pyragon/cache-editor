import { useEffect, useRef, useState } from 'react'
import type { LightIntensityData, LightIntensityDef } from '../loaders/config/light_intensities'
import { NumGrid } from './defFields'
import type { NumFieldDef } from './defFields'
import { FLICKER_TABLE } from './flickerTable'
import './LightIntensityViewer.css'

// Waveform names per FlickeringEffect.applyEffect (darkan) — effect selects
// how the light's intensity oscillates over a 2048-unit rotation cycle.
const EFFECT_NAMES: [value: number, label: string][] = [
  [0, '0 — Steady'],
  [1, '1 — Sine pulse'],
  [2, '2 — Sawtooth'],
  [3, '3 — Flicker (perlin)'],
  [4, '4 — Strobe (on/off)'],
  [5, '5 — Triangle pulse'],
]

const NUM_FIELDS: NumFieldDef[] = [
  ['duration', 'Duration (speed)'],
  ['ticker', 'Ticker (amplitude)'],
  ['surrounding', 'Surrounding (base)'],
]

// The client waveform (FlickeringEffect.applyEffect): rotation is 0..2047,
// output nominally 0..2048.
function wave(effect: number, rotation: number): number {
  switch (effect) {
    case 1: return (Math.trunc(Math.sin((2 * Math.PI * (rotation << 3)) / 16384) * 16384) >> 4) + 1024
    case 2: return rotation
    case 3: return FLICKER_TABLE[rotation] >> 1
    case 4: return (rotation >> 10) << 11
    case 5: return (rotation < 1024 ? rotation : 2048 - rotation) << 1
    default: return 2048
  }
}

// intensity in "transparency" units: ((wave · ticker) >> 11 + surrounding) / 2048.
function intensity(def: LightIntensityDef, rotation: number): number {
  return (((wave(def.effect, rotation) * def.ticker) >> 11) + def.surrounding) / 2048
}

type Props = {
  data: LightIntensityData
  onSave: (data: LightIntensityData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export default function LightIntensityViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<LightIntensityDef>(data.light)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    setDraft(data.light)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  // Live preview: a glowing point light driven by the exact client formula
  // (left), and one full waveform cycle with a moving time cursor (right).
  // The client advances its counter once per 20ms frame; rotation moves
  // duration/50 units per frame, so duration 2048 is one cycle per second.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const GLOW = 170          // left square for the glow
    const PAD = 14
    const plotX = GLOW + 24
    const plotW = W - plotX - PAD
    const plotY = PAD
    const plotH = H - PAD * 2

    // y for an intensity value; the plot shows 0..2 (surrounding + full wave
    // can reach 2.0), with a reference line at 1.0.
    const toY = (v: number) => plotY + plotH - (Math.min(Math.max(v, 0), 2) / 2) * plotH

    let raf = 0
    function draw(now: number) {
      raf = requestAnimationFrame(draw)
      const def = draftRef.current
      const frames = Math.floor(now / 20)
      const rotation = Math.floor((def.duration * frames) / 50) & 0x7ff
      const cur = intensity(def, rotation)

      ctx.clearRect(0, 0, W, H)

      // --- glow ---
      const cx = GLOW / 2 + PAD / 2, cy = H / 2
      const alpha = Math.min(Math.max(cur, 0), 1)
      const radius = GLOW * 0.42
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius)
      grad.addColorStop(0, `rgba(255, 214, 140, ${alpha})`)
      grad.addColorStop(0.35, `rgba(255, 166, 64, ${alpha * 0.55})`)
      grad.addColorStop(1, 'rgba(255, 120, 20, 0)')
      ctx.fillStyle = grad
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
      ctx.fillStyle = `rgba(255, 240, 210, ${alpha})`
      ctx.beginPath()
      ctx.arc(cx, cy, 3, 0, Math.PI * 2)
      ctx.fill()

      // --- waveform plot ---
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.lineWidth = 1
      ctx.strokeRect(plotX, plotY, plotW, plotH)
      // reference line at intensity 1.0
      ctx.beginPath()
      ctx.moveTo(plotX, toY(1))
      ctx.lineTo(plotX + plotW, toY(1))
      ctx.setLineDash([3, 4])
      ctx.stroke()
      ctx.setLineDash([])

      ctx.strokeStyle = 'rgba(126, 184, 255, 0.9)'
      ctx.beginPath()
      for (let i = 0; i < plotW; i++) {
        const rot = Math.floor((i / plotW) * 2048) & 0x7ff
        const y = toY(intensity(def, rot))
        if (i === 0) ctx.moveTo(plotX + i, y)
        else ctx.lineTo(plotX + i, y)
      }
      ctx.stroke()

      // time cursor
      const cursorX = plotX + (rotation / 2048) * plotW
      ctx.strokeStyle = 'rgba(255, 214, 140, 0.8)'
      ctx.beginPath()
      ctx.moveTo(cursorX, plotY)
      ctx.lineTo(cursorX, plotY + plotH)
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, light: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Light Intensity {data.id}</span>
          <span className="item-id-badge">flickering point light</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Preview</h3>
        <p className="tex-op-note">
          How the light's brightness animates, per the client formula — maps place point lights that
          reference this config for their flicker behaviour. The dashed line is full intensity; the
          curve is one cycle of the waveform (duration 2048 ≈ one cycle per second).
        </p>
        <div className="light-preview-wrap">
          <canvas ref={canvasRef} width={640} height={180} className="light-preview-canvas" />
        </div>
      </section>

      <section className="item-section">
        <h3>Definition</h3>
        <div className="item-grid">
          <label className="item-field">
            <span className="item-field-label">Effect (waveform)</span>
            <select
              className="item-stackable-select light-effect-select"
              value={draft.effect}
              onChange={(e) => set('effect', Number(e.target.value))}
            >
              {EFFECT_NAMES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <NumGrid fields={NUM_FIELDS} values={draft as unknown as Record<string, unknown>} onChange={(k, v) => set(k, v)} />
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button
            type="button"
            className="save-bar-discard"
            onClick={() => { setDraft(data.light); setIsDirty(false) }}
          >
            Discard
          </button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
