import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { parseMidi } from '../loaders/midiFile'
import { MusicBankLoader } from '../loaders/musicBank'
import { CacheMidiPlayer } from '../audio/midiSynth'

// Play/pause + seek for a `music` track, for the cutscene PLAY_SONG action.
//
// Unlike the sample cells this can't just decode a file: a song is a MIDI
// score with no audio in it, so playing one means resolving every note through
// the cache's own instrument banks and rendering it in the synth worklet — the
// same path the music page uses. That is expensive enough (banks, then one
// decode per distinct sample) that it happens on the FIRST PLAY, never on
// render: a cutscene lists its actions all at once, and preparing each song up
// front would decode hundreds of samples nobody asked to hear.
//
// One shared player for the whole page. Each CacheMidiPlayer registers the
// worklet on its context, and registering the same processor name twice throws,
// so a player per cell is not an option — and only one song should sound at a
// time anyway.

let shared: { ctx: AudioContext; player: CacheMidiPlayer } | null = null
/** Which cell currently owns the shared player, so the others can reset. */
let owner: symbol | null = null
const listeners = new Set<() => void>()

function claim(id: symbol) {
  if (owner !== id) {
    owner = id
    // tell every other cell to drop its transport state
    for (const notify of listeners) notify()
  }
}

function sharedPlayer(): { ctx: AudioContext; player: CacheMidiPlayer } {
  if (!shared) {
    const ctx = new AudioContext()
    shared = { ctx, player: new CacheMidiPlayer(ctx) }
  }
  return shared
}

export function SongPlayerCell({ cacheRoot, musicId, entry = 'music' }: {
  cacheRoot: FileSystemDirectoryHandle
  musicId: number
  /** `music` or `music2` — PLAY_SONG indexes the primary song list. */
  entry?: 'music' | 'music2'
}) {
  const idRef = useRef(Symbol('song-cell'))
  const [status, setStatus] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const [pos, setPos] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
  const banksRef = useRef<MusicBankLoader | null>(null)

  // Another cell took over the shared player: forget our transport rather than
  // showing a paused position for audio that is no longer ours.
  useEffect(() => {
    const id = idRef.current
    const reset = () => {
      if (owner === id) return
      setReady(false)
      setPlaying(false)
      setPaused(false)
      setPos(0)
    }
    listeners.add(reset)
    return () => { listeners.delete(reset) }
  }, [])

  useEffect(() => () => {
    if (owner === idRef.current) { shared?.player.stop(); owner = null }
  }, [])

  async function prepare(): Promise<boolean> {
    const { ctx, player } = sharedPlayer()
    setStatus('loading…')
    try {
      const dir = await resolveEntryHandle(cacheRoot, getEntryPath(entry))
      if (!dir) throw new Error(`${entry} entry not available`)
      const sub = await dir.getDirectoryHandle(String(musicId))
      const file = await (await sub.getFileHandle('song.mid')).getFile()
      const midi = parseMidi(await file.arrayBuffer())
      if (!midi) throw new Error('not a standard MIDI file')
      banksRef.current ??= new MusicBankLoader(cacheRoot)
      const report = await player.prepare(midi, banksRef.current, setStatus)
      if (report.playable === 0) throw new Error('no instrument resolved')
      setDuration(midi.durationSeconds)
      void ctx.resume()
      setStatus(null)
      setReady(true)
      return true
    } catch {
      setStatus(null)
      setFailed(true)
      return false
    }
  }

  async function onPlay() {
    claim(idRef.current)
    const { player } = sharedPlayer()
    if (!ready) {
      if (!(await prepare())) return
      player.play((seconds) => setPos(seconds), () => { setPlaying(false); setPaused(false); setPos(0) })
      setPlaying(true)
      setPaused(false)
      return
    }
    if (paused) { player.resume(); setPaused(false); return }
    player.pause()
    setPaused(true)
  }

  if (failed) return <span className="sound-cell-length">no preview</span>

  return (
    <div className="sound-cell-player">
      <button
        type="button"
        className="zoom-btn sound-cell-btn"
        disabled={status != null}
        title={playing && !paused ? 'Pause' : `Play music track ${musicId}`}
        onClick={() => void onPlay()}
      >
        {status != null ? '…' : playing && !paused ? '⏸' : '▶'}
      </button>
      <input
        className="sound-cell-slider"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(pos, duration)}
        disabled={!ready}
        onChange={(e) => {
          const t = parseFloat(e.target.value)
          setPos(t)
          sharedPlayer().player.seek(t, playing && !paused)
        }}
      />
      <span className="sound-cell-length">
        {status ?? (duration > 0 ? `${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, '0')} / ${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}` : '—')}
      </span>
    </div>
  )
}
