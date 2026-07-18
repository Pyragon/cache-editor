import { useId } from 'react'

// Shared SVG curve graph for envelope/breakpoint data (synth sound effect
// envelopes, gfx instrument-bank zone envelopes, keyboard-wide curves).
// Renders a fixed-aspect panel: grid, linear-interpolated curve, filled area,
// breakpoint dots, and min/max domain labels — the same visual language as
// the light-intensities preview.

export type EnvelopePoint = { x: number; y: number }

const W = 320
const H = 110
const PAD_L = 8
const PAD_R = 8
const PAD_T = 18
const PAD_B = 12

export default function EnvelopeGraph({ points, color = 'var(--electric-blue-bright)', label, xMax, yDomain }: {
  points: EnvelopePoint[]
  color?: string
  label?: string
  /** Domain override — defaults to the data's own max (min 1 to avoid a degenerate scale). */
  xMax?: number
  yDomain?: [number, number]
}) {
  // SVG url(#id) resolves document-wide, so the gradient id must be unique
  // per mounted graph (colors differ between graphs).
  const gradientId = useId() + '-grad'

  if (points.length === 0) {
    return (
      <div className="env-graph env-graph-empty">
        {label && <span className="env-graph-label">{label}</span>}
        <span className="env-graph-none">no points</span>
      </div>
    )
  }

  const dataXMax = Math.max(...points.map((p) => p.x), 1)
  const domX = xMax ?? dataXMax
  let domYMin: number
  let domYMax: number
  if (yDomain) {
    [domYMin, domYMax] = yDomain
  } else {
    domYMin = Math.min(...points.map((p) => p.y), 0)
    domYMax = Math.max(...points.map((p) => p.y), 1)
    const span = domYMax - domYMin
    domYMin -= span * 0.08
    domYMax += span * 0.08
  }
  if (domYMax === domYMin) domYMax = domYMin + 1

  const px = (x: number) => PAD_L + (x / domX) * (W - PAD_L - PAD_R)
  const py = (y: number) => PAD_T + (1 - (y - domYMin) / (domYMax - domYMin)) * (H - PAD_T - PAD_B)

  const sorted = [...points].sort((a, b) => a.x - b.x)
  const lineD = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')
  const baseline = py(Math.max(domYMin, Math.min(0, domYMax)))
  const areaD = `${lineD} L${px(sorted[sorted.length - 1].x).toFixed(1)},${baseline.toFixed(1)} L${px(sorted[0].x).toFixed(1)},${baseline.toFixed(1)} Z`

  const gridX = [0.25, 0.5, 0.75].map((f) => PAD_L + f * (W - PAD_L - PAD_R))
  const gridY = [0.25, 0.5, 0.75].map((f) => PAD_T + f * (H - PAD_T - PAD_B))
  const showZero = domYMin < 0 && domYMax > 0

  return (
    <div className="env-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="env-graph-svg">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={W} height={H} rx="8" fill="#0a0c12" />
        {gridX.map((x) => <line key={`x${x}`} x1={x} y1={PAD_T} x2={x} y2={H - PAD_B} stroke="rgba(255,255,255,0.05)" />)}
        {gridY.map((y) => <line key={`y${y}`} x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.05)" />)}
        {showZero && <line x1={PAD_L} y1={py(0)} x2={W - PAD_R} y2={py(0)} stroke="rgba(255,255,255,0.16)" strokeDasharray="3 3" />}
        <path d={areaD} fill={`url(#${gradientId})`} />
        <path d={lineD} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {sorted.map((p, i) => (
          <circle key={i} cx={px(p.x)} cy={py(p.y)} r="3.2" fill={color} stroke="#0a0c12" strokeWidth="1.5">
            <title>{`(${p.x}, ${p.y})`}</title>
          </circle>
        ))}
        {label && <text x={PAD_L + 2} y="12" className="env-graph-title">{label}</text>}
        <text x={W - PAD_R - 2} y="12" textAnchor="end" className="env-graph-domain">{`y ${Math.round(domYMin)}…${Math.round(domYMax)} · x 0…${Math.round(domX)}`}</text>
      </svg>
    </div>
  )
}
