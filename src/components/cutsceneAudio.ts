import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { SAMPLE_RATE, mixToFloat } from '../loaders/soundSynth'
import type { SoundEffectDef } from '../loaders/sound_effects'
import { parseMidi } from '../loaders/midiFile'
import { MusicBankLoader } from '../loaders/musicBank'
import { CacheMidiPlayer } from '../audio/midiSynth'
import { sampleAudioContext, pcmToBuffer } from './sampleAudio'

// Sound for the cutscene preview.
//
// Three action types make noise, and they do NOT share a source:
//
//   PLAY_SYNTH   index 4  additive synthesis, rendered by our port
//   PLAY_VORBIS  index 14 a streamed ogg — "vorbis" is the format, not an
//                         index; AreaSound type 2 is `spoken()`, which reads
//                         Resource.MIDI_INSTRUMENT (AreaSoundPlayer:67)
//   PLAY_SONG    index 6  a MIDI score with no audio in it, so it has to be
//                         resolved through the instrument banks and rendered
//                         in the synth worklet
//
// The first two are cheap and start on the frame their action fires. A song is
// not: preparing one decodes every sample it touches, which takes long enough
// that starting it synchronously would stall the sim. It is prepared in the
// background and starts when ready, seeking to wherever playback has reached
// by then, so a late-loading song joins in at the right place rather than from
// the top.

// A one-shot sample, kept alive across a pause. An AudioBufferSourceNode is
// single-use — stop() retires it for good — so pausing means stopping the node,
// remembering how far into the buffer it got, and starting a FRESH node from
// that offset on resume. The context itself can't be suspended: it is the one
// shared AudioContext every sound cell on the page plays through
// (sampleAudio.ts), so suspending it would mute the rest of the editor too.
type SoundHandle = {
  source: AudioBufferSourceNode | null
  buffer: AudioBuffer
  gain: GainNode
  /** where in the buffer the current node started */
  offset: number
  /** ctx.currentTime at which it started */
  startedAt: number
}

export class CutsceneAudio {
  private root: FileSystemDirectoryHandle
  private ctx: AudioContext
  private master: GainNode
  private active = new Set<SoundHandle>()
  private samples = new Map<string, Promise<AudioBuffer | null>>()

  private song: CacheMidiPlayer | null = null
  private banks: MusicBankLoader | null = null
  /** the song that should be sounding, and where it started in sim seconds */
  private songWanted: { id: number; atSeconds: number } | null = null
  private songReadyFor: number | null = null
  private volume = 1
  private paused = false

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
    this.ctx = sampleAudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value))
    this.master.gain.value = this.volume
    // the song renders through its own worklet, not our gain node
    this.song?.setVolume(this.volume)
  }

  /** Fire an action's sound. `atSeconds` is the sim clock, used to place a
   *  song that is still loading. */
  play(type: string, fields: Record<string, number>, atSeconds: number) {
    if (type === 'PLAY_SYNTH') void this.playSample('sound_effects', fields.soundId, fields.volume)
    else if (type === 'PLAY_VORBIS') void this.playSample('midi_instruments', fields.soundId, fields.volume)
    else if (type === 'PLAY_SONG') void this.playSong(fields.musicId, atSeconds)
  }

  private async playSample(entry: 'sound_effects' | 'midi_instruments', id: number, volume?: number) {
    if (id == null || id < 0) return
    const buffer = await this.buffer(entry, id)
    if (!buffer) return
    void this.ctx.resume()
    // the action's volume is 0-255 in the cache
    const gain = this.ctx.createGain()
    gain.gain.value = volume != null ? Math.max(0, Math.min(1, volume / 255)) : 1
    gain.connect(this.master)
    const handle: SoundHandle = { source: null, buffer, gain, offset: 0, startedAt: 0 }
    this.active.add(handle)
    // decoding is async, so the preview may have paused since the action fired
    // — hold the sample at offset 0 and let resume() start it
    if (!this.paused) this.startHandle(handle)
  }

  /** (Re)start a handle's playback from its recorded offset. */
  private startHandle(handle: SoundHandle) {
    const source = this.ctx.createBufferSource()
    source.buffer = handle.buffer
    source.connect(handle.gain)
    source.onended = () => {
      // only the node still owned by the handle retires it: a pause stops the
      // old node, and its late `ended` must not drop the resumed one
      if (handle.source !== source) return
      try { handle.gain.disconnect() } catch { /* already gone */ }
      this.active.delete(handle)
    }
    handle.source = source
    handle.startedAt = this.ctx.currentTime
    source.start(0, handle.offset)
  }

  private buffer(entry: 'sound_effects' | 'midi_instruments', id: number): Promise<AudioBuffer | null> {
    const key = `${entry}:${id}`
    let p = this.samples.get(key)
    if (!p) {
      p = (async () => {
        try {
          const dir = await resolveEntryHandle(this.root, getEntryPath(entry))
          if (!dir) return null
          const sub = await dir.getDirectoryHandle(String(id))
          if (entry === 'midi_instruments') {
            const file = await (await sub.getFileHandle('sound.ogg')).getFile()
            return await this.ctx.decodeAudioData(await file.arrayBuffer())
          }
          const file = await (await sub.getFileHandle(`${id}.json`)).getFile()
          const def = JSON.parse(await file.text()) as SoundEffectDef
          const pcm = mixToFloat(def)
          return pcm.length > 0 ? pcmToBuffer(pcm, SAMPLE_RATE) : null
        } catch {
          return null
        }
      })()
      this.samples.set(key, p)
    }
    return p
  }

  private async playSong(musicId: number, atSeconds: number) {
    if (musicId == null || musicId < 0) return
    this.songWanted = { id: musicId, atSeconds }
    this.song ??= new CacheMidiPlayer(this.ctx)
    const player = this.song

    if (this.songReadyFor !== musicId) {
      try {
        const dir = await resolveEntryHandle(this.root, getEntryPath('music'))
        if (!dir) return
        const sub = await dir.getDirectoryHandle(String(musicId))
        const file = await (await sub.getFileHandle('song.mid')).getFile()
        const midi = parseMidi(await file.arrayBuffer())
        if (!midi) return
        this.banks ??= new MusicBankLoader(this.root)
        const report = await player.prepare(midi, this.banks)
        if (report.playable === 0) return
        this.songReadyFor = musicId
      } catch {
        return
      }
    }

    // the sim moved on (seek, stop, another song) while this was loading
    if (this.songWanted?.id !== musicId) return
    player.setVolume(this.volume)
    player.play()
    // join at wherever playback has reached rather than restarting the track
    const behind = this.songWanted.atSeconds
    if (behind > 0.25) player.seek(behind, true)
  }

  /** Freeze everything — used when the preview pauses. */
  pause() {
    if (this.paused) return
    this.paused = true
    this.song?.pause()
    const now = this.ctx.currentTime
    for (const handle of this.active) {
      const played = handle.offset + (handle.source ? now - handle.startedAt : 0)
      this.retire(handle)
      // a sample that would have ended anyway just goes; the rest keep their
      // position so resume() can pick each one back up mid-sample
      if (played >= handle.buffer.duration) {
        try { handle.gain.disconnect() } catch { /* already gone */ }
        this.active.delete(handle)
      } else {
        handle.offset = played
      }
    }
  }

  resume() {
    void this.ctx.resume()
    this.song?.resume()
    if (!this.paused) return
    this.paused = false
    for (const handle of this.active) this.startHandle(handle)
  }

  /** Silence a handle's node without letting its `ended` retire the handle. */
  private retire(handle: SoundHandle) {
    const source = handle.source
    if (!source) return
    handle.source = null
    source.onended = null
    try { source.stop() } catch { /* already ended */ }
  }

  /** Cut all sound. Used on seek and on stop: a scrub must not leave the
   *  previous position's audio running underneath the new one. */
  stopAll() {
    for (const handle of this.active) {
      this.retire(handle)
      try { handle.gain.disconnect() } catch { /* already gone */ }
    }
    this.active.clear()
    this.song?.stop()
    this.songWanted = null
  }

  dispose() {
    this.stopAll()
    this.song?.dispose()
    this.song = null
    try { this.master.disconnect() } catch { /* already gone */ }
  }
}
