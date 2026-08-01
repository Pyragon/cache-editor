// Host side of the cache-instrument MIDI player.
//
// Walks a parsed song in tick order while tracking each channel's program and
// bank select, resolves every note to a sample out of the cache, ships the
// decoded samples to the worklet, and hands it a frame-stamped event list so
// playback timing never depends on main-thread jitter.
//
// The synthesis itself lives in midiSynth.worklet.js; docs/music-synth.md has
// the trace both are built from.
import type { MidiFile } from '../loaders/midiFile'
import { compareEvents, midiTickToSeconds } from '../loaders/midiFile'
import type { MusicBankLoader } from '../loaders/musicBank'
import { notePitchAdjustment, patchKey } from '../loaders/musicBank'
import workletUrl from './midiSynth.worklet.js?url'

export type PrepareReport = {
  /** distinct samples successfully decoded */
  samples: number
  /** notes that will sound */
  playable: number
  /** notes whose bank or sample is missing from this dump */
  missing: number
  /** patch keys the song asked for that this dump doesn't have */
  missingBanks: number[]
}

type WorkletEvent =
  | { frame: number; kind: 'on'; channel: number; note: number; velocity: number; sampleId: number; notePitchAdjustment: number; pitchOffset: number; volume: number; pan: number; chokeGroup: number; globalGain: number; zone: unknown }
  | { frame: number; kind: 'off'; channel: number; note: number }
  | { frame: number; kind: 'bend'; channel: number; value: number }

/** Worklet master gain at volume 1.0 — the level playback has always used, so
 *  a full slider is exactly the old behaviour rather than suddenly louder. */
const MAX_GAIN = 0.35

export class CacheMidiPlayer {
  private ctx: AudioContext
  private node: AudioWorkletNode | null = null
  private ready: Promise<void> | null = null
  private events: WorkletEvent[] = []
  /** Note-on paired with when it ends, so `seek` can find what was sounding. */
  private spans: { on: WorkletEvent; offFrame: number }[] = []
  private onFrameCb: ((seconds: number) => void) | null = null
  private onEndedCb: (() => void) | null = null
  private durationSeconds = 0

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.ctx.audioWorklet.addModule(workletUrl)
        const node = new AudioWorkletNode(this.ctx, 'midi-synth', { outputChannelCount: [2] })
        node.connect(this.ctx.destination)
        node.port.onmessage = (e) => {
          const msg = e.data as { type: string; frame?: number }
          if (msg.type === 'frame' && this.onFrameCb) {
            const seconds = (msg.frame ?? 0) / this.ctx.sampleRate
            this.onFrameCb(seconds)
            if (this.durationSeconds > 0 && seconds >= this.durationSeconds) this.onEndedCb?.()
          }
        }
        this.node = node
      })()
    }
    return this.ready
  }

  /**
   * Resolve every note to a cache sample and stage it in the worklet.
   * Reports what it could and couldn't find rather than silently going quiet —
   * a song referencing banks this dump lacks should say so.
   */
  async prepare(midi: MidiFile, banks: MusicBankLoader, onStatus?: (text: string) => void): Promise<PrepareReport> {
    await this.init()
    this.durationSeconds = midi.durationSeconds

    // --- channel state resolved in tick order ---------------------------
    // Which patch a note uses depends on the program and bank select in force
    // at that tick, so notes and controls have to be walked together.
    const program = new Int32Array(16)
    const bankMsb = new Int32Array(16)
    const bankLsb = new Int32Array(16)
    // MidiPcmStream:173 — the percussion channel defaults to bank 128
    bankLsb[9] = 1
    const keyAt: number[] = []

    type Step = { tick: number; track: number; seq: number; order: number; index: number }
    const steps: Step[] = []
    midi.controls.forEach((c, i) => steps.push({ tick: c.tick, track: c.track, seq: c.seq, order: 0, index: i }))
    midi.notes.forEach((n, i) => steps.push({ tick: n.tick, track: n.track, seq: n.seq, order: 1, index: i }))
    // file order, not "controls win" — see compareEvents. A note written before
    // a same-tick program change really does sound on the previous instrument.
    steps.sort(compareEvents)

    for (const step of steps) {
      if (step.order === 0) {
        const c = midi.controls[step.index]
        if (c.kind === 'program') program[c.channel] = c.value
        else if (c.kind === 'bankMsb') bankMsb[c.channel] = c.value
        else if (c.kind === 'bankLsb') bankLsb[c.channel] = c.value
      } else {
        const n = midi.notes[step.index]
        const bankSelect = (bankMsb[n.channel] << 14) + (bankLsb[n.channel] << 7)
        keyAt[step.index] = patchKey(program[n.channel], bankSelect)
      }
    }

    // --- load the banks and samples the song actually needs --------------
    const neededKeys = [...new Set(keyAt.filter((k) => k !== undefined))]
    onStatus?.(`Loading ${neededKeys.length} instrument bank${neededKeys.length === 1 ? '' : 's'}…`)
    const bankByKey = new Map<number, Awaited<ReturnType<MusicBankLoader['bank']>>>()
    await Promise.all(neededKeys.map(async (k) => bankByKey.set(k, await banks.bank(k))))

    const missingBanks = neededKeys.filter((k) => !bankByKey.get(k))
    const neededSamples = new Set<number>()
    for (let i = 0; i < midi.notes.length; i++) {
      const bank = bankByKey.get(keyAt[i])
      const slot = bank?.notes[midi.notes[i].pitch]
      if (slot) neededSamples.add(slot.sampleCode)
    }

    onStatus?.(`Decoding ${neededSamples.size} instrument sample${neededSamples.size === 1 ? '' : 's'}…`)
    let decoded = 0
    await Promise.all([...neededSamples].map(async (code) => {
      const sample = await banks.sample(code, this.ctx)
      if (!sample) return
      decoded++
      this.node!.port.postMessage({
        type: 'sample',
        id: code,
        data: sample.data.buffer.slice(0),
        sampleRate: sample.sampleRate,
        loopStart: sample.loopStart,
        loopEnd: sample.loopEnd,
      })
    }))

    // --- build the frame-stamped timeline --------------------------------
    const rate = this.ctx.sampleRate
    const events: WorkletEvent[] = []
    const spans: { on: WorkletEvent; offFrame: number }[] = []
    let playable = 0
    let missing = 0

    for (let i = 0; i < midi.notes.length; i++) {
      const n = midi.notes[i]
      const bank = bankByKey.get(keyAt[i])
      const slot = bank?.notes[n.pitch]
      if (!bank || !slot) { missing++; continue }
      playable++
      const onFrame = Math.round(midiTickToSeconds(midi, n.tick) * rate)
      const offTick = n.length > 0 ? n.tick + n.length : n.tick + (midi.ticksPerQuarter ?? 480)
      const offFrame = Math.round(midiTickToSeconds(midi, offTick) * rate)
      const on: WorkletEvent = {
        frame: onFrame,
        kind: 'on',
        channel: n.channel,
        note: n.pitch,
        velocity: n.velocity,
        sampleId: slot.sampleCode,
        notePitchAdjustment: notePitchAdjustment(n.pitch, slot.pitchOffset),
        pitchOffset: slot.pitchOffset,
        volume: slot.volume,
        pan: slot.pan,
        chokeGroup: slot.chokeGroup,
        globalGain: bank.globalGain,
        zone: slot.zone,
      }
      events.push(on)
      spans.push({ on, offFrame })
      events.push({ frame: offFrame, kind: 'off', channel: n.channel, note: n.pitch })
    }

    for (const c of midi.controls) {
      if (c.kind !== 'bend') continue
      events.push({ frame: Math.round(midiTickToSeconds(midi, c.tick) * rate), kind: 'bend', channel: c.channel, value: (c.value * 2) / 8192 * 256 })
    }

    events.sort((a, b) => a.frame - b.frame)
    this.events = events
    this.spans = spans
    return { samples: decoded, playable, missing, missingBanks }
  }

  play(onFrame?: (seconds: number) => void, onEnded?: () => void) {
    if (!this.node) return
    this.onFrameCb = onFrame ?? null
    this.onEndedCb = onEnded ?? null
    void this.ctx.resume()
    this.node.port.postMessage({ type: 'events', events: this.events })
    this.node.port.postMessage({ type: 'start' })
  }

  /** Freeze mid-note. Voices and the unplayed queue survive, so resume()
   *  continues rather than re-attacking. */
  pause() {
    this.node?.port.postMessage({ type: 'pause' })
  }

  resume() {
    if (!this.node) return
    void this.ctx.resume()
    this.node.port.postMessage({ type: 'resume' })
  }

  /** 0..1, applied to the worklet's master gain. */
  setVolume(value: number) {
    this.node?.port.postMessage({ type: 'gain', value: Math.max(0, Math.min(1, value)) * MAX_GAIN })
  }

  get duration(): number {
    return this.durationSeconds
  }

  /**
   * Jump to `seconds`. The worklet consumes its queue destructively, so this
   * re-sends the timeline from the target frame onward.
   *
   * Two things have to be reconstructed or the music arrives wrong:
   *  - **notes mid-sustain across the seek point** are re-triggered at the
   *    target, otherwise every held pad or looping drone that started earlier
   *    is simply missing. Their note-offs are already in the tail, since those
   *    land after the seek point by definition.
   *  - **pitch bend** is channel state the worklet keeps across the jump, so
   *    the last bend before the target is re-applied. Without it, seeking
   *    backwards past a bend leaves the old one stuck on.
   */
  seek(seconds: number, running: boolean) {
    if (!this.node) return
    const frame = Math.max(0, Math.round(seconds * this.ctx.sampleRate))
    const tail = this.events.filter((e) => e.frame >= frame)

    const sustained: WorkletEvent[] = []
    for (const span of this.spans) {
      if (span.on.frame < frame && span.offFrame > frame) sustained.push({ ...span.on, frame })
    }

    const bendAt = new Map<number, WorkletEvent>()
    for (const e of this.events) {
      if (e.kind === 'bend' && e.frame < frame) bendAt.set(e.channel, { ...e, frame })
    }

    const events = [...bendAt.values(), ...sustained, ...tail].sort((a, b) => a.frame - b.frame)
    if (running) void this.ctx.resume()
    this.node.port.postMessage({ type: 'seek', frame, events, running })
  }

  stop() {
    this.node?.port.postMessage({ type: 'stop' })
    this.onFrameCb = null
    this.onEndedCb = null
  }

  dispose() {
    this.stop()
    try { this.node?.disconnect() } catch { /* already gone */ }
    this.node = null
  }
}
