// Audio helpers shared by the sound cells. Separate from SamplePlayer.tsx so
// that file exports only its component — mixing the two breaks fast refresh.

let sharedCtx: AudioContext | null = null

/** One AudioContext for every cell on the page. Browsers cap them at ~6, and a
 *  table of sound rows would blow through that instantly. */
export function sampleAudioContext(): AudioContext {
  sharedCtx ??= new AudioContext()
  return sharedCtx
}

/** Wrap raw mono PCM as an AudioBuffer at its own rate, for the synth side. */
export function pcmToBuffer(pcm: Float32Array, sampleRate: number): AudioBuffer {
  const ctx = sampleAudioContext()
  const buffer = ctx.createBuffer(1, Math.max(1, pcm.length), sampleRate)
  buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
  return buffer
}
