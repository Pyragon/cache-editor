import type { CacheLoader } from './types'
import { streamDirItems } from './common'

// One folder per song (IndexType.MUSIC / MUSIC2 — identical format, shared
// loader). Dumped by cryogen MusicDefinitions as <id>/song.bin (raw cache
// bytes, reference/inspection only) + <id>/song.mid (decompressed via
// MusicTrackDecompressor into a real, standard, playable MIDI file —
// verified against javax.sound.midi across every song in both indices).
// song.mid is the editable source of truth: cryogen's getActions()
// recompresses whatever's in song.mid via MusicTrackCompressor (validated
// 100% functional round-trip), not song.bin, so replacing it here is all
// that's needed to change what gets packed.
export type MusicData = {
  id: number
  midUrl: string | null
  midFile: File | null
}

const loader: CacheLoader = {
  streamItems: streamDirItems,

  async loadItem(dirHandle, item) {
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id))
    let midUrl: string | null = null
    let midFile: File | null = null
    try {
      const midHandle = await subHandle.getFileHandle('song.mid')
      midFile = await midHandle.getFile()
      midUrl = URL.createObjectURL(midFile)
    } catch {
      // no dumped preview
    }
    return { id: item.id, midUrl, midFile } satisfies MusicData
  },

  async saveItem(dirHandle, item, data) {
    const { midFile } = data as MusicData
    if (!midFile) return
    const subHandle = await dirHandle.getDirectoryHandle(String(item.id), { create: true })
    const midHandle = await subHandle.getFileHandle('song.mid', { create: true })
    const writable = await midHandle.createWritable()
    await writable.write(await midFile.arrayBuffer())
    await writable.close()
  },
}

export default loader
