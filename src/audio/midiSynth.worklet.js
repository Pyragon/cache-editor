/* eslint-disable no-undef */
// Sample-accurate MIDI voice mixer, ported from darkan's
// MusicPatchPcmStream / MusicPatchNode / MidiPcmStream. Full trace and the
// field-name traps are in docs/music-synth.md — read that before editing.
//
// Plain JS on purpose: it is loaded with `?url` and runs unbundled inside the
// AudioWorklet scope, so it must be self-contained with no imports.
//
// Shape of the port:
//  - the client steps envelopes on a TICK of sampleRate/100 (10 ms) and only
//    the sample playback itself is per-sample, so this renders frame by frame
//    and runs the tick between frames;
//  - note events arrive from the host stamped with an absolute frame, so
//    timing does not depend on main-thread jitter;
//  - positions are fixed-point <<8 with linear interpolation, matching
//    AudioBufferStream.mixForward*Interpolated.

/** 2^(pitch/3072): pitch units are 1/256 of a semitone (calculatePitch). */
const PITCH_SCALE = 3.255208333333333e-4
/** sin() argument for a 512-step LFO table: 2*PI/512. */
const VIBRATO_STEP = 0.01227184630308513
/** pitch-scaling of envelope rates (updatePatchNode). */
const ENV_PITCH_SCALAR = 5.086263020833333e-6

class Voice {
  constructor(spec, sample, outRate) {
    this.channel = spec.channel
    this.note = spec.note
    this.chokeGroup = spec.chokeGroup
    this.sample = sample
    this.outRate = outRate

    // --- pitch ---------------------------------------------------------
    this.notePitchAdjustment = spec.notePitchAdjustment
    this.pitchBend = 0 // in 1/256 semitone, updated by the host
    // negative pitchOffset is the client's loop flag
    this.looping = spec.pitchOffset < 0 && sample.loopEnd > sample.loopStart

    // --- position (fixed point <<8) -------------------------------------
    this.pos = 0
    this.step = 256

    // --- gain ------------------------------------------------------------
    // volume/pan are the bank's per-note values; globalGain is per-bank.
    this.baseGain = (spec.volume / 64) * (spec.globalGain / 64) * (spec.velocity / 127)
    const pan = Math.max(0, Math.min(128, spec.pan))
    this.panL = Math.cos((pan / 128) * (Math.PI / 2))
    this.panR = Math.sin((pan / 128) * (Math.PI / 2))

    // --- envelopes (the zone) --------------------------------------------
    const z = spec.zone || {}
    this.sustainEnv = z.sustainEnvelope || null
    this.releaseEnv = z.releaseEnvelope || null
    this.sustainRate = z.sustainRate || 0
    this.decayRate = z.decayRate || 0
    this.releaseRate = z.releaseRate || 0
    this.vibratoRate = z.vibratoRate || 0
    this.vibratoDepth = z.vibratoDepth || 0
    this.vibratoDelay = z.vibratoDelay || 0

    this.envPos = 0
    this.envIndex = 0
    this.decayTime = 0
    this.releaseState = -1 // < 0 while held
    this.releaseIndex = 0
    this.vibratoPhase = 0
    this.tickCounter = 0
    this.dead = false
    // a short fade on death/steal, so nothing clicks
    this.fade = 1
    this.fading = false
  }

  /** calculatePitch: playback step as fixed-point 8.8 against the output rate. */
  updateStep() {
    let pitch = this.notePitchAdjustment + this.pitchBend
    if (this.vibratoRate > 0 && this.vibratoDepth > 0) {
      let depth = this.vibratoDepth << 2
      const delay = this.vibratoDelay << 1
      // vibrato fades in over its delay rather than starting at full depth
      if (delay > 0 && this.tickCounter < delay) depth = (depth * this.tickCounter) / delay
      pitch += Math.sin(VIBRATO_STEP * (this.vibratoPhase & 0x1ff)) * depth
    }
    const rate = this.sample.sampleRate * 256 * Math.pow(2, PITCH_SCALE * pitch) / this.outRate
    this.step = Math.max(1, Math.round(rate))
  }

  /** Amplitude 0..1 from an X,Y breakpoint envelope at `pos`. */
  static envAmplitude(env, pos, index) {
    if (!env || env.length < 2) return 1
    const x0 = (env[index] & 0xff) << 8
    const y0 = env[index + 1] & 0xff
    if (index + 3 >= env.length) return y0 / 255
    const x1 = (env[index + 2] & 0xff) << 8
    const y1 = env[index + 3] & 0xff
    if (x1 <= x0) return y1 / 255
    const t = Math.max(0, Math.min(1, (pos - x0) / (x1 - x0)))
    return (y0 + (y1 - y0) * t) / 255
  }

  /** One 10 ms envelope tick (updatePatchNode). */
  tick() {
    this.tickCounter++
    this.vibratoPhase += this.vibratoRate

    // rates are pitch-scaled: faster envelopes for higher notes
    const pitchScalar = ENV_PITCH_SCALAR * ((this.note - 60) << 8)
    const advance = (rate) => (rate > 0 ? Math.round(128 * Math.pow(2, pitchScalar * rate)) : 128)

    if (this.decayRate > 0) {
      this.decayTime += advance(this.vibratoRate)
      if (this.decayRate * this.decayTime >= 819200) this.dead = true
    }

    if (this.sustainEnv) {
      this.envPos += advance(this.sustainRate)
      while (this.envIndex < this.sustainEnv.length - 2
        && this.envPos > (this.sustainEnv[this.envIndex + 2] & 0xff) << 8) {
        this.envIndex += 2
      }
      if (this.envIndex === this.sustainEnv.length - 2 && (this.sustainEnv[this.envIndex + 1] & 0xff) === 0) {
        this.dead = true
      }
    }

    if (this.releaseState >= 0 && this.releaseEnv) {
      this.releaseState += advance(this.releaseRate)
      while (this.releaseIndex < this.releaseEnv.length - 2
        && this.releaseState > (this.releaseEnv[this.releaseIndex + 2] & 0xff) << 8) {
        this.releaseIndex += 2
      }
      if (this.releaseIndex === this.releaseEnv.length - 2) this.dead = true
    } else if (this.releaseState >= 0 && !this.releaseEnv) {
      // no release curve: a short fade so note-off is still audible as an end
      this.fading = true
    }

    if (this.dead) this.fading = true
    this.updateStep()
  }

  noteOff() {
    if (this.releaseState < 0) this.releaseState = 0
  }

  /** Linear-interpolated mono sample at the current fixed-point position. */
  read() {
    const d = this.sample.data
    const i = this.pos >> 8
    if (i < 0 || i >= d.length) return 0
    const frac = (this.pos & 0xff) / 256
    const a = d[i]
    const b = i + 1 < d.length ? d[i + 1] : (this.looping ? d[this.sample.loopStart] : 0)
    return a + (b - a) * frac
  }

  advance() {
    this.pos += this.step
    const end = this.looping ? this.sample.loopEnd : this.sample.data.length
    if (this.pos >> 8 >= end) {
      if (this.looping) {
        const loopLen = this.sample.loopEnd - this.sample.loopStart
        if (loopLen > 0) {
          while (this.pos >> 8 >= this.sample.loopEnd) this.pos -= loopLen << 8
        } else {
          this.dead = true
        }
      } else {
        this.dead = true
        this.fading = true
      }
    }
  }

  /** Current amplitude, combining the envelopes and any fade-out. */
  gain() {
    let g = this.baseGain
    if (this.sustainEnv) g *= Voice.envAmplitude(this.sustainEnv, this.envPos, this.envIndex)
    if (this.releaseState >= 0 && this.releaseEnv) {
      g *= Voice.envAmplitude(this.releaseEnv, this.releaseState, this.releaseIndex)
    }
    if (this.decayRate > 0) {
      g *= Math.max(0, 1 - (this.decayRate * this.decayTime) / 819200)
    }
    return g * this.fade
  }
}

class MidiSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Map()
    this.voices = []
    this.events = []
    this.frame = 0
    this.tickFrames = Math.max(1, Math.round(sampleRate / 100))
    this.framesToTick = this.tickFrames
    this.masterGain = 0.35
    this.running = false
    this.pitchBend = new Float32Array(16)
    this.port.onmessage = (e) => this.onMessage(e.data)
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'sample':
        this.samples.set(msg.id, {
          data: new Float32Array(msg.data),
          sampleRate: msg.sampleRate,
          loopStart: msg.loopStart,
          loopEnd: msg.loopEnd,
        })
        break
      case 'events':
        // already frame-stamped and sorted by the host
        for (const ev of msg.events) this.events.push(ev)
        this.events.sort((a, b) => a.frame - b.frame)
        break
      case 'start':
        this.frame = 0
        this.running = true
        break
      // Pause freezes rather than tears down: voices and the remaining event
      // queue stay exactly as they are, so resuming continues mid-note instead
      // of re-attacking. `process` already outputs silence while !running.
      case 'pause':
        this.running = false
        break
      case 'resume':
        this.running = true
        break
      // Seek can't just move `frame`, because the queue is consumed
      // destructively (`shift()` below) — anything already played is gone. The
      // host therefore re-sends the tail of the timeline from the target frame,
      // plus re-triggers for notes that were mid-sustain across it.
      case 'seek':
        this.voices.length = 0
        this.events.length = 0
        for (const ev of msg.events) this.events.push(ev)
        this.events.sort((a, b) => a.frame - b.frame)
        this.frame = msg.frame
        this.running = msg.running
        this.port.postMessage({ type: 'frame', frame: this.frame })
        break
      case 'stop':
        this.running = false
        this.voices.length = 0
        this.events.length = 0
        this.frame = 0
        this.port.postMessage({ type: 'stopped' })
        break
      case 'gain':
        this.masterGain = msg.value
        break
      default:
        break
    }
  }

  applyEvent(ev) {
    if (ev.kind === 'on') {
      const sample = this.samples.get(ev.sampleId)
      if (!sample) return
      // choke groups: a new note in the group cuts the previous one (hi-hats)
      if (ev.chokeGroup >= 0) {
        for (const v of this.voices) {
          if (v.chokeGroup === ev.chokeGroup && !v.dead) { v.dead = true; v.fading = true }
        }
      }
      const voice = new Voice(ev, sample, sampleRate)
      voice.pitchBend = this.pitchBend[ev.channel] || 0
      voice.updateStep()
      // hard cap so a runaway song cannot lock the audio thread
      if (this.voices.length > 96) {
        const victim = this.voices.findIndex((v) => v.releaseState >= 0)
        this.voices.splice(victim >= 0 ? victim : 0, 1)
      }
      this.voices.push(voice)
    } else if (ev.kind === 'off') {
      for (const v of this.voices) {
        if (v.channel === ev.channel && v.note === ev.note && v.releaseState < 0) v.noteOff()
      }
    } else if (ev.kind === 'bend') {
      this.pitchBend[ev.channel] = ev.value
      for (const v of this.voices) if (v.channel === ev.channel) { v.pitchBend = ev.value; v.updateStep() }
    } else if (ev.kind === 'allOff') {
      for (const v of this.voices) v.noteOff()
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out.length > 1 ? out[1] : out[0]
    left.fill(0)
    if (right !== left) right.fill(0)
    if (!this.running) return true

    for (let i = 0; i < left.length; i++) {
      // events land on their exact frame
      while (this.events.length > 0 && this.events[0].frame <= this.frame) {
        this.applyEvent(this.events.shift())
      }

      if (--this.framesToTick <= 0) {
        this.framesToTick = this.tickFrames
        for (const v of this.voices) v.tick()
      }

      let l = 0
      let r = 0
      for (let vi = 0; vi < this.voices.length; vi++) {
        const v = this.voices[vi]
        const s = v.read() * v.gain()
        l += s * v.panL
        r += s * v.panR
        v.advance()
        if (v.fading) {
          v.fade -= 1 / (sampleRate * 0.01) // 10 ms fade, matches the client's
          if (v.fade <= 0) v.dead = true
        }
      }
      left[i] += l * this.masterGain
      if (right !== left) right[i] += r * this.masterGain

      this.frame++
    }

    // reap after the block rather than mid-loop
    if (this.voices.some((v) => v.dead && v.fade <= 0)) {
      this.voices = this.voices.filter((v) => !(v.dead && v.fade <= 0))
    }

    // let the host drive the playhead off the audio clock, not wall time
    if ((this.frame % 2048) < 128) this.port.postMessage({ type: 'frame', frame: this.frame })
    return true
  }
}

registerProcessor('midi-synth', MidiSynthProcessor)
