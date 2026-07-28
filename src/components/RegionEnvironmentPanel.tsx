import { useEffect, useRef, useState } from 'react'
import type { RegionEnvironment } from './mapScene'
import './RegionEnvironmentPanel.css'

/**
 * Editor for a region's environment record — the tail of its terrain archive
 * (`maps/environments/<id>.json`): sun, fog, cube texture, bloom and skybox.
 *
 * **The flags byte defines the layout, not field presence** (cryogen
 * `MapEnvironment.encode`: a set bit writes a value, zero if the field is
 * missing), so every environment row owns its flag bit and a cleared row is
 * genuinely absent rather than zero. It lives as a tab in the scene's side
 * panel, beside the region's other lists, and the scene stays visible next to
 * it — which is what makes the live fog/sun/bloom updates worth having.
 *
 * The sections we don't model — the static lighting grid and the opcode order —
 * ride along in the draft untouched and are shown read-only at the bottom, so
 * it's obvious they're preserved rather than dropped.
 */

/** Which flag bit gates each environment field (cryogen `decodeEnvironment`). */
const FLAG = {
  sunColour: 0x1,
  sunAmbient: 0x2,
  sunLight: 0x4,
  sunBacklight: 0x8,
  sunPosition: 0x10,
  fogColour: 0x20,
  fogDepth: 0x40,
  cubeTexture: 0x80,
} as const

type EnvField = keyof typeof FLAG

/** Client defaults, shown as the placeholder when a region doesn't override. */
const DEFAULTS = {
  sunColour: 0xddccbb,
  sunAmbient: 1.0,
  sunLight: 1.0,
  sunBacklight: 0.5,
  fogColour: 0xc8c0a8,
  fogDepth: 0,
}

/** Values stored as u16/256 — quantised so an untouched save round-trips. */
const fixed8 = (v: number) => Math.round(Math.max(0, Math.min(255.99, v)) * 256) / 256
/** Bloom values are a byte × 8/255. */
const bloomStep = (v: number) => Math.round((Math.max(0, Math.min(8, v)) / 8) * 255) * 8 / 255

const hex = (v: number) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`

export default function RegionEnvironmentPanel({ env, regionId, editable, onChange }: {
  env: RegionEnvironment | null
  regionId: number
  /** without a cache root there's nowhere to write the file back */
  editable: boolean
  onChange: (next: RegionEnvironment) => void
}) {
  const environment = env?.environment
  const flags = environment?.flags ?? 0
  const has = (field: EnvField) => (flags & FLAG[field]) !== 0

  /** Replace the environment record, keeping everything we don't model. */
  function patchEnvironment(changes: Partial<NonNullable<RegionEnvironment['environment']>>, flagChanges = 0) {
    const base = environment ?? { flags: 0 }
    onChange({ ...(env ?? {}), environment: { ...base, ...changes, flags: (base.flags | flagChanges) } })
  }

  /** Turn a field on (with a starting value) or off, keeping the flags exact. */
  function toggleField(field: EnvField, on: boolean) {
    const base = environment ?? { flags: 0 }
    const next: NonNullable<RegionEnvironment['environment']> = { ...base }
    next.flags = on ? base.flags | FLAG[field] : base.flags & ~FLAG[field]
    if (on) {
      // a newly enabled field starts at the client default rather than zero
      if (field === 'sunColour' && next.sunColour === undefined) next.sunColour = DEFAULTS.sunColour
      if (field === 'sunAmbient' && next.sunAmbient === undefined) next.sunAmbient = DEFAULTS.sunAmbient
      if (field === 'sunLight' && next.sunLight === undefined) next.sunLight = DEFAULTS.sunLight
      if (field === 'sunBacklight' && next.sunBacklight === undefined) next.sunBacklight = DEFAULTS.sunBacklight
      if (field === 'sunPosition' && next.sunPosition === undefined) next.sunPosition = [-28, -100, -52]
      if (field === 'fogColour' && next.fogColour === undefined) next.fogColour = DEFAULTS.fogColour
      if (field === 'fogDepth' && next.fogDepth === undefined) next.fogDepth = DEFAULTS.fogDepth
      if (field === 'cubeTexture' && next.cubeTexture === undefined) next.cubeTexture = [0, 0, 0, 0, 0, 0]
    } else {
      delete next[field]
    }
    // an environment record with no fields left is no record at all
    const stripped: RegionEnvironment = { ...(env ?? {}) }
    if (next.flags === 0 && Object.keys(next).length === 1) delete stripped.environment
    else stripped.environment = next
    onChange(stripped)
  }

  const sunPos = environment?.sunPosition ?? [-28, -100, -52]
  // (defined below the preview state, which the readout and knob both follow)
  /** Sun direction as compass angle + height, which is how it reads in-scene. */
  const azimuth = (Math.atan2(sunPos[0], sunPos[2]) * 180) / Math.PI
  const horizontal = Math.hypot(sunPos[0], sunPos[2])
  const elevation = (Math.atan2(-sunPos[1], horizontal) * 180) / Math.PI

  function setSunAngles(nextAzimuth: number, nextElevation: number) {
    const length = Math.hypot(sunPos[0], sunPos[1], sunPos[2]) || 116
    const az = (nextAzimuth * Math.PI) / 180
    const el = (nextElevation * Math.PI) / 180
    const flat = Math.cos(el) * length
    patchEnvironment({
      sunPosition: [
        Math.round(Math.sin(az) * flat),
        Math.round(-Math.sin(el) * length),
        Math.round(Math.cos(az) * flat),
      ],
    }, FLAG.sunPosition)
  }

  const dialRef = useRef<HTMLDivElement>(null)
  // The sun direction is baked into vertex colours, so committing every pointer
  // move would rebuild the region under the cursor and make the dial unusable.
  // Drag moves the knob only; the edit lands once, on release.
  const [dialPreview, setDialPreview] = useState<{ azimuth: number; elevation: number } | null>(null)
  function dialAngles(e: React.PointerEvent | PointerEvent) {
    const box = dialRef.current?.getBoundingClientRect()
    if (!box) return null
    const dx = e.clientX - (box.left + box.width / 2)
    const dy = e.clientY - (box.top + box.height / 2)
    // distance from centre = elevation (centre overhead, rim on the horizon)
    const radius = Math.min(box.width, box.height) / 2
    const reach = Math.min(1, Math.hypot(dx, dy) / radius)
    return { azimuth: (Math.atan2(dx, -dy) * 180) / Math.PI, elevation: 90 - reach * 90 }
  }
  function commitDial() {
    if (!dialPreview) return
    setSunAngles(dialPreview.azimuth, dialPreview.elevation)
    setDialPreview(null)
  }
  const shownAzimuth = dialPreview?.azimuth ?? azimuth
  const shownElevation = dialPreview?.elevation ?? elevation

  return (
    <div className={`env-panel${editable ? '' : ' env-panel-locked'}`}>
      <div className="env-panel-head">
        <span className="env-panel-title">Region environment</span>
        <span className="env-panel-region">{regionId >> 8}, {regionId & 0xff}</span>
      </div>

      <div className="env-panel-body">
        <p className="env-panel-note">
          {editable
            ? <>The tail of this region's terrain archive. Fog, bloom, sun colour and the skybox
              update the scene as you drag; the sun's <em>direction</em> and <em>ambient</em> are
              baked into vertex colours, so those rebuild the centre region (a moment's pause).</>
            : <>Read-only: open a cache folder to edit the environment record.</>}
        </p>

        <Section title="Sun">
          <Row label="Colour" on={has('sunColour')} onToggle={(on) => toggleField('sunColour', on)}
            hint={`default ${hex(DEFAULTS.sunColour)}`}>
            <input type="color" className="env-colour" value={hex(environment?.sunColour ?? DEFAULTS.sunColour)}
              onChange={(e) => patchEnvironment({ sunColour: parseInt(e.target.value.slice(1), 16) }, FLAG.sunColour)} />
            <code className="env-hex">{hex(environment?.sunColour ?? DEFAULTS.sunColour)}</code>
          </Row>
          <Slider label="Ambient" on={has('sunAmbient')} onToggle={(on) => toggleField('sunAmbient', on)}
            value={environment?.sunAmbient ?? DEFAULTS.sunAmbient} min={0} max={4} step={1 / 256}
            onValue={(v) => patchEnvironment({ sunAmbient: fixed8(v) }, FLAG.sunAmbient)} baked />
          <Slider label="Light" on={has('sunLight')} onToggle={(on) => toggleField('sunLight', on)}
            value={environment?.sunLight ?? DEFAULTS.sunLight} min={0} max={4} step={1 / 256}
            onValue={(v) => patchEnvironment({ sunLight: fixed8(v) }, FLAG.sunLight)} />
          <Slider label="Backlight" on={has('sunBacklight')} onToggle={(on) => toggleField('sunBacklight', on)}
            value={environment?.sunBacklight ?? DEFAULTS.sunBacklight} min={0} max={4} step={1 / 256}
            onValue={(v) => patchEnvironment({ sunBacklight: fixed8(v) }, FLAG.sunBacklight)} />

          <Row label="Direction" on={has('sunPosition')} onToggle={(on) => toggleField('sunPosition', on)} baked>
            <div className="env-sun">
              <div
                className={`env-dial${dialPreview ? ' env-dial-dragging' : ''}`}
                ref={dialRef}
                title="Drag: around = compass direction, centre = overhead, rim = on the horizon. Applies when you let go."
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDialPreview(dialAngles(e))
                }}
                onPointerMove={(e) => { if (e.buttons) setDialPreview(dialAngles(e)) }}
                onPointerUp={commitDial}
                onPointerCancel={commitDial}
              >
                <div className="env-dial-ring" />
                <div
                  className="env-dial-knob"
                  style={{
                    left: `${50 + Math.sin((shownAzimuth * Math.PI) / 180) * (1 - shownElevation / 90) * 50}%`,
                    top: `${50 - Math.cos((shownAzimuth * Math.PI) / 180) * (1 - shownElevation / 90) * 50}%`,
                  }}
                />
              </div>
              <div className="env-sun-fields">
                <NumberField label="x" value={sunPos[0]} min={-32768} max={32767} baked
                  onValue={(v) => patchEnvironment({ sunPosition: [v, sunPos[1], sunPos[2]] }, FLAG.sunPosition)} />
                <NumberField label="y" value={sunPos[1]} min={-32768} max={32767} baked
                  onValue={(v) => patchEnvironment({ sunPosition: [sunPos[0], v, sunPos[2]] }, FLAG.sunPosition)} />
                <NumberField label="z" value={sunPos[2]} min={-32768} max={32767} baked
                  onValue={(v) => patchEnvironment({ sunPosition: [sunPos[0], sunPos[1], v] }, FLAG.sunPosition)} />
                <div className="env-sun-readout">
                  {Math.round(shownAzimuth)}° compass · {Math.round(shownElevation)}° up
                  {dialPreview && <span className="env-pending"> — release to apply</span>}
                </div>
              </div>
            </div>
          </Row>
        </Section>

        <Section title="Fog">
          <Row label="Colour" on={has('fogColour')} onToggle={(on) => toggleField('fogColour', on)}
            hint="also the backdrop the world fades into">
            <input type="color" className="env-colour" value={hex(environment?.fogColour ?? DEFAULTS.fogColour)}
              onChange={(e) => patchEnvironment({ fogColour: parseInt(e.target.value.slice(1), 16) }, FLAG.fogColour)} />
            <code className="env-hex">{hex(environment?.fogColour ?? DEFAULTS.fogColour)}</code>
          </Row>
          <Slider label="Depth" on={has('fogDepth')} onToggle={(on) => toggleField('fogDepth', on)}
            value={environment?.fogDepth ?? 0} min={0} max={4000} step={1}
            onValue={(v) => patchEnvironment({ fogDepth: Math.round(v) }, FLAG.fogDepth)}
            hint="how far back the fade starts — (depth + 256) × 4 world units" />
        </Section>

        <Section title="Cube texture">
          <Row label="Faces" on={has('cubeTexture')} onToggle={(on) => toggleField('cubeTexture', on)}
            hint="six texture ids, the environment cube map">
            <div className="env-cube">
              {(environment?.cubeTexture ?? [0, 0, 0, 0, 0, 0]).map((id, i) => (
                <NumberField key={i} label={['+x', '-x', '+y', '-y', '+z', '-z'][i]} value={id} min={0} max={65535}
                  onValue={(v) => {
                    const faces = [...(environment?.cubeTexture ?? [0, 0, 0, 0, 0, 0])]
                    faces[i] = v
                    patchEnvironment({ cubeTexture: faces }, FLAG.cubeTexture)
                  }} />
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Bloom">
          <Row label="Region overrides" on={env?.hdr != null}
            onToggle={(on) => {
              const next: RegionEnvironment = { ...(env ?? {}) }
              if (on) next.hdr = env?.hdr ?? { bloomThreshold: 1, bloomStrength: 0.25, whitePoint: 1 }
              else delete next.hdr
              onChange(next)
            }}
            hint="off = the client's own 1.0 / 0.25 / 1.0" />
          {env?.hdr && <>
            <Slider label="Threshold" on value={env.hdr.bloomThreshold} min={0} max={8} step={8 / 255}
              onValue={(v) => onChange({ ...env, hdr: { ...env.hdr!, bloomThreshold: bloomStep(v) } })} />
            <Slider label="Strength" on value={env.hdr.bloomStrength} min={0} max={8} step={8 / 255}
              onValue={(v) => onChange({ ...env, hdr: { ...env.hdr!, bloomStrength: bloomStep(v) } })} />
            <Slider label="White point" on value={env.hdr.whitePoint} min={0} max={8} step={8 / 255}
              onValue={(v) => onChange({ ...env, hdr: { ...env.hdr!, whitePoint: bloomStep(v) } })} />
          </>}
        </Section>

        <Section title="Skybox">
          <Row label="Sky dome" on={env?.skybox != null}
            onToggle={(on) => {
              const next: RegionEnvironment = { ...(env ?? {}) }
              if (on) next.skybox = env?.skybox ?? { id: 0, x: 0, y: 0, z: 0, rotation: 0 }
              else delete next.skybox
              onChange(next)
            }}
            hint="a config/skyboxes id" />
          {env?.skybox && <>
            <Row label="Id" on>
              <NumberField label="" value={env.skybox.id} min={0} max={65535}
                onValue={(v) => onChange({ ...env, skybox: { ...env.skybox!, id: v } })} />
            </Row>
            <Slider label="Rotation" on value={env.skybox.rotation} min={0} max={16383} step={64}
              onValue={(v) => onChange({ ...env, skybox: { ...env.skybox!, rotation: Math.round(v) } })}
              format={(v) => `${Math.round((v / 16384) * 360)}°`} />
            <Row label="Offset" on>
              <div className="env-cube">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <NumberField key={axis} label={axis} value={env.skybox![axis]} min={-32768} max={32767}
                    onValue={(v) => onChange({ ...env, skybox: { ...env.skybox!, [axis]: v } })} />
                ))}
              </div>
            </Row>
          </>}
        </Section>

        {(env?.lightingGrid || env?.opcodeOrder) && (
          <p className="env-panel-note env-panel-carried">
            Carried through untouched:
            {env.lightingGrid && ` a static lighting grid (${Math.round(env.lightingGrid.length * 0.75)} bytes)`}
            {env.lightingGrid && env.opcodeOrder ? ' and' : ''}
            {env.opcodeOrder && ` this region's own opcode order (${env.opcodeOrder.join(', ')})`}
            . Saving preserves them, so an untouched region repacks to identical bytes.
          </p>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="env-section">
      <h4 className="env-section-title">{title}</h4>
      {children}
    </div>
  )
}

/**
 * One field. `on` is the flag bit: off means the region genuinely doesn't carry
 * the value, which is not the same as carrying a zero.
 */
function Row({ label, on, onToggle, hint, baked, children }: {
  label: string
  on: boolean
  onToggle?: (on: boolean) => void
  hint?: string
  baked?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`env-row${on ? '' : ' env-row-off'}`}>
      <label className="env-row-label">
        {onToggle && (
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)}
            title={on ? 'Remove this field from the region' : 'Add this field to the region'} />
        )}
        <span>{label}</span>
        {baked && <span className="env-baked" title="Baked into vertex colours — editing rebuilds the region">rebuild</span>}
      </label>
      <div className="env-row-control">{children}</div>
      {hint && <div className="env-row-hint">{hint}</div>}
    </div>
  )
}

/**
 * A value with a slider and a number box. `baked` values (the ones the scene has
 * to rebuild for) are previewed while dragging and committed on release —
 * committing per step would rebuild the region under the cursor mid-drag.
 */
function Slider({ label, on, onToggle, value, min, max, step, onValue, hint, baked, format }: {
  label: string
  on: boolean
  onToggle?: (on: boolean) => void
  value: number
  min: number
  max: number
  step: number
  onValue: (v: number) => void
  hint?: string
  baked?: boolean
  format?: (v: number) => string
}) {
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? value
  const commit = () => {
    setPreview((pending) => {
      if (pending != null) onValue(pending)
      return null
    })
  }
  // a release outside the input (or a cancelled drag) still has to land
  useEffect(() => {
    if (preview == null) return
    window.addEventListener('pointerup', commit)
    window.addEventListener('pointercancel', commit)
    return () => {
      window.removeEventListener('pointerup', commit)
      window.removeEventListener('pointercancel', commit)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview != null])
  return (
    <Row label={label} on={on} onToggle={onToggle} hint={hint} baked={baked}>
      <input type="range" className="env-slider rs-slider" min={min} max={max} step={step} value={shown}
        onChange={(e) => (baked ? setPreview(Number(e.target.value)) : onValue(Number(e.target.value)))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit} />
      <input type="number" className="env-number" min={min} max={max} step={step} value={round4(shown)}
        onChange={(e) => (baked ? setPreview(Number(e.target.value)) : onValue(Number(e.target.value)))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
      {format && <span className="env-row-hint">{format(shown)}</span>}
      {preview != null && <span className="env-pending" title="Applies when you let go">·</span>}
    </Row>
  )
}

function NumberField({ label, value, min, max, onValue, baked }: {
  label: string
  value: number
  min: number
  max: number
  onValue: (v: number) => void
  /** feeds a baked value: commit on blur/Enter rather than per keystroke */
  baked?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (raw: string) => Math.max(min, Math.min(max, Math.round(Number(raw)) || 0))
  const commit = () => {
    if (draft == null) return
    onValue(clamp(draft))
    setDraft(null)
  }
  return (
    <label className="env-field">
      {label && <span>{label}</span>}
      <input type="number" className="env-number" min={min} max={max} value={draft ?? value}
        onChange={(e) => (baked ? setDraft(e.target.value) : onValue(clamp(e.target.value)))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
    </label>
  )
}

const round4 = (v: number) => Math.round(v * 10000) / 10000
