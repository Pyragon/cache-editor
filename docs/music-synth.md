# Playing music with the cache's own instruments

Trace of darkan's MIDI software synthesiser, made 2026-07-30 before porting it,
so the port is a translation rather than a reinvention. Cody chose the faithful
route: a **sample-accurate AudioWorklet**, not a WebAudio node graph.

Reference package: `darkan-bot-refactor/src/main/kotlin/com/jagex/game/runetek5/sound/jagtheora/`.

## Why this exists

A `.mid` is a score with no audio in it. Browsers ship no MIDI synthesiser at
all (Web MIDI talks to *devices*; no engine plays `.mid` in an `<audio>` tag),
so anything audible has to be synthesised in JS. A General MIDI soundfont would
sound fine but wrong — the client renders music from its own sample bank, which
is in this cache.

## The chain, all of it already decoded

| link | where | notes |
|---|---|---|
| song → standard MIDI | `music`/`music2` → `<id>/song.mid` | parsed by `src/loaders/midiFile.ts` |
| program + bank → patch key | `MidiPcmStream:440/444/574` | `key = program + (CC0 << 14) + (CC32 << 7)`; channel 9 defaults `bankSelect = 128` (`:173`) |
| patch key → bank | `sound_effects_midi/<key>.json` | 246 archives, ids to 1667 — consistent with that formula |
| bank note → sample | `resolveSample()` in `src/loaders/sound_effects_midi.ts` | `code-1`, bit 0 picks the index, `>> 2` is the id |
| sample → audio | `midi_instruments/<id>/sound.ogg` (16,824) | already real Ogg Vorbis — `decodeAudioData` handles it; **99.94% of mapped notes** |
| sample → audio | `sound_effects/<id>` (10,240) | additive synthesis, ported in `src/loaders/soundSynth.ts`; **14 note slots total** (see below) |

`listEffect` vs `listMusic` in `SoundBankCache.kt` are wired to `INDEX_4` and
`INDEX_14` respectively (`ClientStartup.kt:201/209`) — so the first branch reads
the *same* index as loc/NPC ambient sounds, via the same `Resource.SOUND_EFFECT`
provider `AreaSoundPlayer` uses.

## Runtime architecture

- **`MusicPatchNode`** is one voice. **`MusicPatchNode2`** is the per-note
  envelope/vibrato struct (our `SoundEffectMidiZone`). **`AreaSoundStream`** is
  the actual sample player — resampling, loop points, volume, pan, fades (476
  lines, and the biggest single piece of the port).
- **`MusicPatchPcmStream.fill`** walks the voice queue and renders each voice in
  chunks bounded by `patchNode.tickSampleLength`, calling
  `MidiPcmStream.updatePatchNode` at every tick boundary. That is where
  envelopes, vibrato and decay advance.
- **The tick is `sampleRate / 100`** — 10 ms (`updatePatchNode:777`). Envelopes
  are stepped per tick, not per sample; only the sample playback itself is
  per-sample. That makes the worklet structure straightforward: render in
  ≤10 ms slices, run the tick between them.
- `sustain[track] & 0x4` selects a **retrigger** path that re-attacks the sample
  on an LFO (`effectSpeedScaled`), crossfading the old stream out over
  `min(sampleRate/100, 262144/step)` samples. Rare, but it is why voices hold a
  replaceable `stream` rather than a fixed buffer position.

## The two non-standard controllers: CC16 and CC17 (traced 2026-07-31)

Both are handled in `MidiPcmStream.parseMessage` — they are *not* inert, and a
MIDI round-trip that drops them changes how the song sounds. Each is a 14-bit
pair (MSB + LSB at +32), though **no song in the cache ever sends the LSB**
(CC48/CC49 appear zero times), so in practice the value is `data2 << 7`.

### CC16 / CC48 → `generalPurpose1[channel]` — sample start offset

At note-on (`MidiPcmStream:215`) the channel's `generalPurpose1` picks the
branch:

- `== 0` → normal start: stream opens at position 0 at full volume.
- `!= 0` → stream opens at **volume 0**, then `applyInitialSampleOffset` seeks it
  to `(generalPurpose1 * totalSamples) >> 6`.

Stream positions are 1/256-sample units (the reverse branch compares against
`samples shl 8`), so that offset is the fraction **`generalPurpose1 / 16384`** of
the sample — a full-scale 14-bit scrub into the waveform.

If the note carries the loop flag (`pitchOffset[note] < 0`) *and* the sample
loops, the length used is the bounce length `samples + samples - start`, and an
offset past the end calls `reversePlaybackDirection()` — the sample plays
**backwards**.

### CC17 / CC49 → `setEffectSpeed` — retrigger LFO rate; CC81 is its on/off switch

`setEffectSpeed` stores `effectSpeedScaled = round(2097152 * 2^(raw * 9/16384))`
(the literal `5.4931640625E-4` is exactly `9/16384`). `MusicPatchPcmStream:48`
consumes it as `step = effectSpeedScaled / sampleRate`, accumulated into
`retriggerPhase` modulo `0x100000` — one wrap is one re-attack. So

```
retrigger rate = 2 * 2^(raw * 9 / 16384)  Hz     (raw = CC17 value << 7)
```

= 2 Hz at value 0 up to ~976 Hz at value 127. The values actually used (17–49)
land at roughly **4.6–22 Hz**, i.e. an audible buzz/tremolo.

It only does anything while `sustain[channel] & 0x4`, which is set by **CC81 ≥
64** and cleared (with a `retriggerPhase` reset via `resetEffectSwitch`) below
that.

### How much is at stake

Message counts are high but concentrated in very few songs:

| CC | messages | songs | non-zero |
|---|---|---|---|
| 16 (start offset) | 49,594 | **36** | 49,491 |
| 17 (retrigger rate) | 43,186 | **17** | 43,030 |
| 81 (retrigger on/off) | 3,808 | **16** | — |

CC17 and CC81 are effectively the same feature: all 16 CC81 songs use CC17, and
16 of the 17 CC17 songs use CC81. Both controllers are swept continuously rather
than set once, so those ~50 songs are doing real automation with them.

**Round-trip implication:** a DAW passes unknown CCs through as generic
controller data, so plain edit-and-re-export is safe. What is *not* safe is any
tool or cleanup pass that filters non-GM controllers — for those ~50 songs it
would silently remove a scrub or a tremolo. Neither controller is ported to our
worklet yet.

## ⚠️ darkan's `MusicPatchNode2` field names are WRONG — do not port by name

`updatePatchNode` uses them for completely different jobs than their names
suggest. Verified by reading the arithmetic (`MidiPcmStream:775-840`):

| field name | what it ACTUALLY drives |
|---|---|
| `volumeEnvelopeRelease` | the **vibrato phase increment** (`vibratoPhase += volumeEnvelopeRelease`) |
| `volumeEnvelopeSustain` | rate for stepping the **sustain/volume** envelope |
| `volumeEnvelopeDecay` | the **continuous decay** — voice dies when `decay * volumeEnvelopeTime >= 819200` |
| `vibratoLfoDelay` | the **release envelope** rate |
| `vibratoLfoFrequency` | rate scalar for the decay accumulator |

Our cryogen-side names (`sustainRate`, `decayRate`, `releaseRate`,
`vibratoRate`, `vibratoDepth`, `vibratoDelay`) are a *different* naming of the
same nine fields. **Before porting, pin the mapping by DECODE ORDER** — compare
`MusicPatch.kt`'s parse against cryogen's `SoundEffectMidi` field by field.
Matching them up by name will silently swap vibrato for release.

## Envelope maths

Rates are pitch-scaled. With

```
pitchScalar = 5.086263020833333e-6 * (((notePitch - 60) << 8) + (portamentoPitchOffset * portamentoFactor >> 12))
```

each tick advances a position by `round(128 * 2^(pitchScalar * rate))`, or by a
flat `128` when that rate is 0. Envelope data is a byte array of X,Y
breakpoints; the index walks forward while
`position > (array[index + 2] & 0xff) << 8`. A voice is dead when the sustain
envelope reaches its last breakpoint with Y = 0, when the release envelope runs
off the end, or when the decay accumulator passes 819200.

Release only advances when `releaseState >= 0` **and** `sustain[track] & 0x1` is
clear **and** the voice is not the channel's held loop-group note.

## Still to trace before writing the voice engine

- `calculatePitch(patchNode)` in `MidiPcmStream` — the full pitch chain
  (`MusicPatch.pitchOffset`, built at `:149/157/177` from the bank's cumulative
  tuning deltas, plus portamento and pitch bend).
- `AreaSoundStream` (476 lines) — resampling, loop handling, fade behaviour.
- `MusicPatch.ready()` (`:506`) — how samples are attached and which sample
  rates are requested.
- Voice allocation and choke groups in `MidiPcmStream` note-on/note-off.

## Verified against the real dump (2026-07-30)

Both checks were written as *independent* implementations in Node, so agreement
means the formula is right rather than that the code agrees with itself.

- **Patch key chain — 5,111,576 / 5,111,576 note-ons (100.00%)** across *every*
  song in the cache resolve from `program + bank select` all the way to a sample
  file that exists on disk. No missing bank, no unmapped note slot, no absent
  sample. (Was 97.8% over a six-song sample until the bank-0 re-dump below;
  re-measured across all 1,662 songs on 2026-07-31.)
- **Tuning — 541 / 573 (94.4%)** of multi-note sample runs advance by exactly
  256 units per semitone, i.e. chromatically correct. The exceptions confirm
  the maths rather than contradict it: `delta 0` runs are notes sharing one
  sample at a fixed pitch (drum-kit behaviour) and `delta 128` is deliberate
  half-semitone microtuning.
- 649 note slots carry the loop flag (negative `pitchOffset`).

### How much music actually uses `sound_effects`? Almost none (2026-07-31)

Full sweep of all 247 banks and all 1,662 songs (1,137 `music` + 525 `music2`),
simulating `MidiPcmStream`'s per-channel `program + (CC0 << 14) + (CC32 << 7)`
with channel 9 defaulting to bank 128, then matching every note-on against the
banks' `sampleCode` parity. Numbers are post-bank-0-re-dump:

- **23,139 of 23,153** mapped note slots resolve to `midi_instruments`
  (1,187 distinct oggs). **14** resolve to `sound_effects` — 6 distinct ids:
  3452, 3711, 3712, 3713, 3715, 3716. No bank is *only* sound effects.
- All 14 are percussion: note 27 → sfx 3452 in banks 128/136/144/152/153/168/
  176/184/255, bank 184 notes 96/97 → 3715/3716, bank 291 notes 52/53/55 →
  3711/3712/3713. Bank 0 added 128 slots, all `midi_instruments`.
- **9 songs** ever strike one: `music/905` (bank 184 note 27, ×217),
  `music/457` (128/27, ×24), `music/903` (291/52,53,55), `music/929`,
  `music/926`, `music/932` (184/96), `music2/260` (184/96,97), `music2/261`,
  `music2/425`. In note-ons that is **299 of 5,111,576** — 0.006%.
- Songs reference 233 distinct patch keys, and every one now has a bank file.

So the `sound_effects` branch is not dead code, but treating the two indices as
peer sample sources overstates it by three orders of magnitude.

### The old 2.2% was a cryogen dumper bug — fixed and re-dumped

Every failing note wanted **bank key 0**, which was missing from the dump.
`SoundEffectMidi.dumpFiles` looped `for (int i = 1; ...)` — it skipped archive
0. Since `MidiPcmStream`'s `defaultProgram` is 0 for every channel except
percussion, bank 0 is what a channel uses before any program change, making it
the most referenced bank in the index. Fixed to start at 0 (no other dumper had
the same off-by-one). Re-dumped 2026-07-31 — the index is 247 archives now, and
the end-to-end resolution rate went to 100%.

## Ported, and deliberately not ported

Implemented in `src/audio/midiSynth.worklet.js`: per-voice linear-interpolated
resampling at fixed-point 8.8, loop points from the negative-`pitchOffset`
flag, the 10 ms envelope tick, pitch-scaled sustain/release envelopes, the
continuous decay accumulator and its 819200 death threshold, the 512-step
vibrato LFO with its fade-in, choke groups, pitch bend, and a 10 ms fade on
voice death so nothing clicks.

Known approximations — worth knowing before chasing a fidelity bug:

- **The gain chain is principled, not bit-exact.** `volume`, `globalGain` and
  velocity are combined multiplicatively; the client's exact curve isn't ported.
- **`volumeCurve` / `panCurve` are ignored.** The loader notes the client bakes
  these into the per-note `volume`/`pan` at runtime; we use the raw per-note
  values.
- **Sustain pedal (CC64) is parsed but not acted on**, and the `sustain & 0x4`
  retrigger path and portamento are not ported at all. All three are rare.
- **CC16 (sample start offset) and CC17/CC81 (retrigger LFO) are not ported** —
  see the controller section above. 36 and ~16 songs respectively rely on them.
- Envelope breakpoints are linearly interpolated between X,Y pairs; the client
  may shape them differently.

## Editing songs outside the editor: the SFZ exporter

`src/loaders/sfzExport.ts` writes the cache's banks out as an SFZ pack so a
downloaded `.mid` can be edited in a DAW with the real instruments instead of a
General MIDI substitute.

**No UI currently calls it.** Buttons were added to `MusicViewer` and
`SoundEffectViewer` and pulled the same day — Cody wants guidance from someone
who composes before settling on a shape. The module is kept because the mapping
below is the hard part and it's verified; wiring a button back up is trivial.
The rest of this section is what a future UI would be exposing.

Two scopes make sense for songs, and they answer different questions:

- **this song** — only the banks *and notes* the song already touches.
  **0.28 MB median, 1.73 MB worst case.** Right for tweaking an existing
  arrangement, wrong if you want to change an instrument: a bank that isn't in
  the pack can't be selected.
- **all instruments** — every bank in the index. 247 files, 23,153 regions,
  1,193 samples, **~53 MB**. Right for composing, since any program/bank the
  client can address is available.

Note "all instruments" means all 247 *banks*, not all 16,824 `midi_instruments`.
Only 1,187 of those are referenced by any bank, and an instrument no bank maps
can't be addressed by a MIDI message at all, so it would be unplayable.

`exportSoundEffectPack` is the index-4 equivalent — ~10,084 renderable effects,
**~529 MB**, laid out 128 per `.sfz` so effect `id` sits on key `id % 128`.
Those are one-shots, not melodic instruments, so each gets one key at natural
pitch with no tuning to reconstruct. Budget around three minutes of CPU: the
additive synth runs per effect (~16 ms each over a 394-effect sample). 157 ids
are empty folders in a real dump and collapse to a single summary line.

SFZ rather than SF2 because it reads `.ogg` directly (52 MB vs ~463 MB decoded),
it is plain text, and it is not boxed into SF2's fixed DAHDSR. Bank addressing
maps cleanly: CC0 is always 0 in this cache, so `key = CC32 * 128 + program` with
CC32 ∈ 0–13, and each archive becomes one `bank_<key>.sfz`.

One `<region>` per mapped note rather than per key range — the runs are only
*usually* chromatic, and per-note regions are exact with no special cases. They
also let the envelope fit be computed at each note's own pitch, since envelope
rates are key-tracked.

Exact in the export: sample mapping, per-note tuning (`pitch_keycenter` +
`tune`), loop flag and points, pan, relative volume, choke groups (`group` /
`off_by`), and vibrato (`pitchlfo_freq` = `vibratoRate / 512 * 100` Hz,
`pitchlfo_depth` = `vibratoDepth * 1.5625` cents, `pitchlfo_fade` =
`vibratoDelay * 0.02` s). Approximated: the amplitude envelopes, fitted from
arbitrary breakpoint curves plus the continuous decay onto DAHDSR. Absent: CC16
and CC17/CC81, which are channel controllers no SFZ player implements.

Validated by generating all 247 banks: 23,153 regions, 1,193 distinct samples
(both matching the independent sweep exactly), zero non-finite or out-of-range
opcode values.

## Same-tick event order is file order, not "controls first"

Found while building the exporter, and it was a live playback bug. `MidiFile`
splits notes and controls into separate arrays, so when a note and a program or
bank change share a tick on the same channel their relative order has to be
reconstructed. Both `midiSynth.ts` and the first cut of `songBankUsage` assumed
controls win — but cryogen's decompressor writes the client's single event
stream out in order, so a note written *before* a same-tick program change
really does sound on the previous instrument.

`parseMidi` now stamps every event with `track` and a monotonic `seq`, and
`compareEvents` sorts by `(tick, track, seq)`. Getting this wrong mis-assigns
the first note of a phrase in roughly 1,300 of the 1,662 songs — usually
inaudible, occasionally not. With the fix, `songBankUsage` reproduces an
independent single-stream MIDI parser's patch-key and note sets on **all 1,662
songs exactly**; before it, 16 songs disagreed.

## Port plan

1. Spike one note end to end, proving the patch key formula and pitch.
2. Sample resolver + lazy cache (never preload 16k oggs), reusing `soundSynth.ts`
   for the `sound_effects` half.
3. AudioWorklet: voice struct, 10 ms tick, envelopes, vibrato, loops, choke.
4. Sequencer from the parsed MIDI, wired into `MusicViewer` in place of the
   oscillator preview.

Bonus once it exists: real auditioning on `midi_instruments`, and a playable
keyboard on the `sound_effects_midi` bank page.
