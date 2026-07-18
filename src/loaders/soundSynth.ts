import type { EnvelopeDef, FilterDef, InstrumentDef, SoundEffectDef } from './sound_effects'

// Faithful TypeScript port of cryogen's additive-synthesis engine
// (Instrument.synthesize / Envelope.step / Filter.compute / SoundEffect.mix),
// so edits in the editor re-synthesize instantly instead of the dumped WAV
// going stale until the next cache dump. Verified sample-exact against the
// dumped WAVs (which cryogen rendered with this same engine at dump time).
//
// Porting notes, all load-bearing:
// - Java `int` arithmetic wraps at 32 bits — every multiply that can
//   overflow uses Math.imul, and accumulators are pinned with |0.
// - The filter runs in Java `float` (32-bit) — Math.fround after every
//   operation, or the coefficients drift enough to flip output samples.
// - The noise table is seeded from `new java.util.Random(0)` — replicated
//   with the exact JDK LCG (48-bit, BigInt).
// - Instrument.evaluateWave's parameter NAMES in cryogen are deobfuscation
//   garbage (call sites pass phase, amplitude, form) — renamed honestly here,
//   math unchanged.

export const SAMPLE_RATE = 22050

// ---------------------------------------------------------------------------
// Static tables (Instrument's static init)
// ---------------------------------------------------------------------------

const noise = new Int32Array(32768)
const sine = new Int32Array(32768)
{
  // java.util.Random(0): seed = (0 ^ 0x5DEECE66D) & (2^48-1);
  // nextInt() = next(32): seed = (seed * 0x5DEECE66D + 0xB) mod 2^48, take top 32 of 48.
  const MASK = (1n << 48n) - 1n
  const MULT = 0x5deece66dn
  let seed = (0n ^ MULT) & MASK
  for (let i = 0; i < 32768; i++) {
    seed = (seed * MULT + 0xbn) & MASK
    const next32 = Number(seed >> 16n) | 0 // top 32 bits as signed int
    noise[i] = (next32 & 0x2) - 1
  }
  for (let i = 0; i < 32768; i++) {
    sine[i] = javaIntCast(Math.sin(i / 5215.1903) * 16384.0)
  }
}

const output = new Int32Array(220500)

// Java's (int) cast of a double/float SATURATES at the int bounds instead of
// wrapping (JLS 5.1.3) — real data hits this: oscillatorPitch up to 2500
// makes pitchStep overflow to Integer.MAX_VALUE. Math.trunc alone is wrong.
function javaIntCast(v: number): number {
  if (Number.isNaN(v)) return 0
  if (v >= 2147483647) return 2147483647
  if (v <= -2147483648) return -2147483648
  return Math.trunc(v)
}

// ---------------------------------------------------------------------------
// Envelope (scratch stepping state kept locally, like the Java transients)
// ---------------------------------------------------------------------------

export class EnvelopeState {
  form: number
  start: number
  end: number
  numPhases: number
  phaseDuration: number[]
  phasePeak: number[]

  critical = 0
  phaseIndex = 0
  step = 0
  amplitude = 0
  ticks = 0

  constructor(def: EnvelopeDef) {
    this.form = def.form
    this.start = def.start
    this.end = def.end
    this.numPhases = def.numPhases
    this.phaseDuration = def.phaseDuration
    this.phasePeak = def.phasePeak
  }

  reset() {
    this.critical = 0
    this.phaseIndex = 0
    this.step = 0
    this.amplitude = 0
    this.ticks = 0
  }

  doStep(period: number): number {
    if (this.ticks >= this.critical) {
      this.amplitude = (this.phasePeak[this.phaseIndex++] << 15) | 0
      if (this.phaseIndex >= this.numPhases) this.phaseIndex = this.numPhases - 1
      this.critical = javaIntCast((this.phaseDuration[this.phaseIndex] / 65536.0) * period)
      if (this.critical > this.ticks) {
        this.step = (((this.phasePeak[this.phaseIndex] << 15) - this.amplitude) / (this.critical - this.ticks)) | 0
      }
    }
    this.amplitude = (this.amplitude + this.step) | 0
    this.ticks++
    return (this.amplitude - this.step) >> 15
  }
}

// ---------------------------------------------------------------------------
// Filter (Java float math — fround everywhere)
// ---------------------------------------------------------------------------

const coefficientFloat: [Float32Array, Float32Array] = [new Float32Array(8), new Float32Array(8)]
const coefficientInt: [Int32Array, Int32Array] = [new Int32Array(8), new Int32Array(8)]
let invUnityFloat = 0
let invUnityInt = 0

const f = Math.fround

// Java float literals — must be rounded to float32 BEFORE the multiply, or
// the double-precision product rounds differently than Java's float product.
const C_MAG = f(0.0015258789)
const C_FREQ = f(32.703197)
const C_PI = f(3.1415927)
const C_PHASE = f(1.2207031e-4)
const C_UNITY = f(0.0030517578)

function adaptMagnitude(filter: FilterDef, dir: number, k: number, t: number): number {
  let alpha = f(f(filter.pairMagnitude[dir][0][k]) + f(t * f(filter.pairMagnitude[dir][1][k] - filter.pairMagnitude[dir][0][k])))
  alpha = f(alpha * C_MAG)
  // Java divides -alpha/20 in float, then widens to double for pow
  return f(1.0 - f(Math.pow(10.0, f(-alpha / 20.0))))
}

function normalize(value: number): number {
  const scaled = f(C_FREQ * f(Math.pow(2.0, value)))
  return f(f(scaled * C_PI) / 11025.0)
}

function adaptPhase(filter: FilterDef, dir: number, i: number, t: number): number {
  let phase = f(f(filter.pairPhase[dir][0][i]) + f(t * f(filter.pairPhase[dir][1][i] - filter.pairPhase[dir][0][i])))
  phase = f(phase * C_PHASE)
  return normalize(phase)
}

function computeFilter(filter: FilterDef, dir: number, t: number): number {
  if (dir === 0) {
    let a0 = f(f(filter.unity[0]) + f(f(filter.unity[1] - filter.unity[0]) * t))
    a0 = f(a0 * C_UNITY)
    invUnityFloat = f(Math.pow(0.1, f(a0 / 20.0)))
    invUnityInt = javaIntCast(f(invUnityFloat * 65536.0))
  }

  if (filter.numPairs[dir] === 0) return 0

  let magnitude = adaptMagnitude(filter, dir, 0, t)
  coefficientFloat[dir][0] = f(f(-2.0 * magnitude) * f(Math.cos(adaptPhase(filter, dir, 0, t))))
  coefficientFloat[dir][1] = f(magnitude * magnitude)

  let i: number
  for (i = 1; i < filter.numPairs[dir]; i++) {
    magnitude = adaptMagnitude(filter, dir, i, t)
    const a = f(f(-2.0 * magnitude) * f(Math.cos(adaptPhase(filter, dir, i, t))))
    const b = f(magnitude * magnitude)
    coefficientFloat[dir][i * 2 + 1] = f(coefficientFloat[dir][i * 2 - 1] * b)
    coefficientFloat[dir][i * 2] = f(f(coefficientFloat[dir][i * 2 - 1] * a) + f(coefficientFloat[dir][i * 2 - 2] * b))
    for (let k = i * 2 - 1; k >= 2; k--) {
      coefficientFloat[dir][k] = f(coefficientFloat[dir][k] + f(f(coefficientFloat[dir][k - 1] * a) + f(coefficientFloat[dir][k - 2] * b)))
    }
    coefficientFloat[dir][1] = f(coefficientFloat[dir][1] + f(f(coefficientFloat[dir][0] * a) + b))
    coefficientFloat[dir][0] = f(coefficientFloat[dir][0] + a)
  }

  if (dir === 0) {
    for (i = 0; i < filter.numPairs[0] * 2; i++) {
      coefficientFloat[0][i] = f(coefficientFloat[0][i] * invUnityFloat)
    }
  }

  for (i = 0; i < filter.numPairs[dir] * 2; i++) {
    coefficientInt[dir][i] = javaIntCast(f(coefficientFloat[dir][i] * 65536.0))
  }

  return filter.numPairs[dir] * 2
}

// ---------------------------------------------------------------------------
// Instrument
// ---------------------------------------------------------------------------

// (long) a * (long) b >> 16 — products stay well under 2^53, so exact in a double;
// Java's arithmetic shift floors.
function mulShift16(a: number, b: number): number {
  return Math.floor((a * b) / 65536)
}

/** Waveform sample: form 1 = square, 2 = sine, 3 = saw, 4 = noise. */
function evaluateWave(phase: number, amplitude: number, form: number): number {
  if (form === 1) return (phase & 0x7fff) < 16384 ? amplitude : -amplitude
  if (form === 2) return Math.imul(sine[phase & 0x7fff], amplitude) >> 14
  if (form === 3) return (Math.imul(amplitude, phase & 0x7fff) >> 14) - amplitude
  if (form === 4) return Math.imul(amplitude, noise[((phase / 2607) | 0) & 0x7fff])
  return 0
}

const phases = new Int32Array(5)
const delays = new Int32Array(5)
const volumeStep = new Int32Array(5)
const pitchStep = new Int32Array(5)
const pitchBaseStep = new Int32Array(5)

export function synthesize(instr: InstrumentDef, mixDuration: number, instrDuration: number): Int32Array {
  // Java's shared static buffer is 10s at 22050Hz and throws past it; JS
  // typed arrays would silently drop OOB writes instead — keep the throw.
  if (mixDuration > output.length) throw new Error(`mix duration ${mixDuration} exceeds the 10s synthesis buffer`)
  output.fill(0, 0, mixDuration)
  if (instrDuration < 10) return output

  const fs = mixDuration / (instrDuration + 0.0)
  const pitch = new EnvelopeState(instr.pitch)
  const volume = new EnvelopeState(instr.volume)

  let pitchModStep = 0
  let pitchModBaseStep = 0
  let pitchModPhase = 0
  let pitchModifier: EnvelopeState | null = null
  let pitchModifierAmplitude: EnvelopeState | null = null
  if (instr.pitchModifier) {
    pitchModifier = new EnvelopeState(instr.pitchModifier)
    pitchModifierAmplitude = new EnvelopeState(instr.pitchModifierAmplitude!)
    pitchModStep = javaIntCast(((pitchModifier.end - pitchModifier.start) * 32.768) / fs)
    pitchModBaseStep = javaIntCast((pitchModifier.start * 32.768) / fs)
  }

  let volumeModStep = 0
  let volumeModBaseStep = 0
  let volumeModPhase = 0
  let volumeMultiplier: EnvelopeState | null = null
  let volumeAmplitude: EnvelopeState | null = null
  if (instr.volumeMultiplier) {
    volumeMultiplier = new EnvelopeState(instr.volumeMultiplier)
    volumeAmplitude = new EnvelopeState(instr.volumeAmplitude!)
    volumeModStep = javaIntCast(((volumeMultiplier.end - volumeMultiplier.start) * 32.768) / fs)
    volumeModBaseStep = javaIntCast((volumeMultiplier.start * 32.768) / fs)
  }

  for (let i = 0; i < 5; i++) {
    if (instr.oscillatorVolume[i] !== 0) {
      phases[i] = 0
      delays[i] = javaIntCast(instr.oscillatorDelays[i] * fs)
      volumeStep[i] = ((instr.oscillatorVolume[i] << 14) / 100) | 0
      pitchStep[i] = javaIntCast(((pitch.end - pitch.start) * 32.768 * Math.pow(1.0057929410678534, instr.oscillatorPitch[i])) / fs)
      pitchBaseStep[i] = javaIntCast((pitch.start * 32.768) / fs)
    }
  }

  for (let i = 0; i < mixDuration; i++) {
    let pitchChange = pitch.doStep(mixDuration)
    let volumeChange = volume.doStep(mixDuration)

    if (pitchModifier) {
      const mod = pitchModifier.doStep(mixDuration)
      const modAmplitude = pitchModifierAmplitude!.doStep(mixDuration)
      pitchChange = (pitchChange + (evaluateWave(pitchModPhase, modAmplitude, pitchModifier.form) >> 1)) | 0
      pitchModPhase = (pitchModPhase + pitchModBaseStep + (Math.imul(mod, pitchModStep) >> 16)) | 0
    }

    if (volumeMultiplier) {
      const mod = volumeMultiplier.doStep(mixDuration)
      const modAmplitude = volumeAmplitude!.doStep(mixDuration)
      volumeChange = Math.imul(volumeChange, ((evaluateWave(volumeModPhase, modAmplitude, volumeMultiplier.form) >> 1) + 32768) | 0) >> 15
      volumeModPhase = (volumeModPhase + volumeModBaseStep + (Math.imul(mod, volumeModStep) >> 16)) | 0
    }

    for (let j = 0; j < 5; j++) {
      if (instr.oscillatorVolume[j] !== 0) {
        const at = delays[j] + i
        if (at < mixDuration) {
          output[at] = (output[at] + evaluateWave(phases[j], Math.imul(volumeChange, volumeStep[j]) >> 15, pitch.form)) | 0
          phases[j] = (phases[j] + (Math.imul(pitchChange, pitchStep[j]) >> 16) + pitchBaseStep[j]) | 0
        }
      }
    }
  }

  if (instr.release) {
    const release = new EnvelopeState(instr.release)
    const attack = new EnvelopeState(instr.attack!)
    let counter = 0
    let muted = true
    for (let i = 0; i < mixDuration; i++) {
      const onStep = release.doStep(mixDuration)
      const offStep = attack.doStep(mixDuration)
      const threshold = muted
        ? ((Math.imul(onStep, (release.end - release.start) | 0) >> 8) + release.start) | 0
        : ((Math.imul(offStep, (release.end - release.start) | 0) >> 8) + release.start) | 0
      counter = (counter + 256) | 0
      if (counter >= threshold) {
        counter = 0
        muted = !muted
      }
      if (muted) output[i] = 0
    }
  }

  if (instr.delayTime > 0 && instr.delayDecay > 0) {
    const delay = javaIntCast(instr.delayTime * fs)
    for (let i = delay; i < mixDuration; i++) {
      output[i] = (output[i] + ((Math.imul(output[i - delay], instr.delayDecay) / 100) | 0)) | 0
    }
  }

  if (instr.filter.numPairs[0] > 0 || instr.filter.numPairs[1] > 0) {
    const filterEnvelope = new EnvelopeState(instr.filterEnvelope)
    let t = filterEnvelope.doStep(mixDuration + 1)
    let M = computeFilter(instr.filter, 0, f(t / 65536.0))
    let N = computeFilter(instr.filter, 1, f(t / 65536.0))
    if (mixDuration >= M + N) {
      let n = 0
      let limit = N
      if (N > mixDuration - M) limit = mixDuration - M

      while (n < limit) {
        let y = mulShift16(output[n + M], invUnityInt) | 0
        for (let i = 0; i < M; i++) y = (y + mulShift16(output[n + M - 1 - i], coefficientInt[0][i])) | 0
        for (let i = 0; i < n; i++) y = (y - mulShift16(output[n - 1 - i], coefficientInt[1][i])) | 0
        output[n] = y
        t = filterEnvelope.doStep(mixDuration + 1)
        n++
      }

      limit = 128
      for (;;) {
        if (limit > mixDuration - M) limit = mixDuration - M

        while (n < limit) {
          let y = mulShift16(output[n + M], invUnityInt) | 0
          for (let i = 0; i < M; i++) y = (y + mulShift16(output[n + M - 1 - i], coefficientInt[0][i])) | 0
          for (let i = 0; i < N; i++) y = (y - mulShift16(output[n - 1 - i], coefficientInt[1][i])) | 0
          output[n] = y
          t = filterEnvelope.doStep(mixDuration + 1)
          n++
        }

        if (n >= mixDuration - M) {
          while (n < mixDuration) {
            let y = 0
            for (let i = n + M - mixDuration; i < M; i++) y = (y + mulShift16(output[n + M - 1 - i], coefficientInt[0][i])) | 0
            for (let i = 0; i < N; i++) y = (y - mulShift16(output[n - 1 - i], coefficientInt[1][i])) | 0
            output[n] = y
            filterEnvelope.doStep(mixDuration + 1)
            n++
          }
          break
        }

        M = computeFilter(instr.filter, 0, f(t / 65536.0))
        N = computeFilter(instr.filter, 1, f(t / 65536.0))
        limit += 128
      }
    }
  }

  for (let i = 0; i < mixDuration; i++) {
    if (output[i] < -32768) output[i] = -32768
    if (output[i] > 32767) output[i] = 32767
  }
  return output
}

// ---------------------------------------------------------------------------
// SoundEffect.mix — combine up to 10 instrument voices into 8-bit mono PCM
// ---------------------------------------------------------------------------

export function mixSoundEffect(def: SoundEffectDef): Int8Array {
  let duration = 0
  for (const instr of def.instruments) {
    if (instr && instr.duration + instr.offset > duration) duration = instr.duration + instr.offset
  }
  if (duration === 0) return new Int8Array(0)

  const ns = ((duration * SAMPLE_RATE) / 1000) | 0
  const mixed = new Int8Array(ns)

  for (const instr of def.instruments) {
    if (!instr) continue
    const mixDuration = ((instr.duration * SAMPLE_RATE) / 1000) | 0
    const offset = ((instr.offset * SAMPLE_RATE) / 1000) | 0
    const samples = synthesize(instr, mixDuration, instr.duration)
    for (let j = 0; j < mixDuration; j++) {
      let out = ((samples[j] >> 8) + mixed[j + offset]) | 0
      if (((out + 128) & ~0xff) !== 0) out = (out >> 31) ^ 0x7f
      mixed[j + offset] = out // Int8Array assignment truncates like the Java (byte) cast
    }
  }
  return mixed
}

/**
 * The exact 16-bit transform SoundEffect.toWAV() applies when writing the
 * dumped previews (its shifts are odd — `>> 16` and `>> (33 & 31)` — but
 * they're what the on-disk WAVs were rendered with, so the verification
 * harness replicates them byte-for-byte).
 */
export function toWavDataBytes(mixed: Int8Array): Uint8Array {
  const fixed = new Uint8Array(mixed.length * 2)
  for (let i = 0; i < mixed.length; i++) {
    fixed[i * 2] = (mixed[i] >> 16) & 0xff
    fixed[i * 2 + 1] = (mixed[i] >> 1) & 0xff
  }
  return fixed
}

/** Float PCM (−1..1) at SAMPLE_RATE for WebAudio playback — proper conversion, not toWAV's quirk. */
export function mixToFloat(def: SoundEffectDef): Float32Array {
  const mixed = mixSoundEffect(def)
  const out = new Float32Array(mixed.length)
  for (let i = 0; i < mixed.length; i++) out[i] = mixed[i] / 128
  return out
}
