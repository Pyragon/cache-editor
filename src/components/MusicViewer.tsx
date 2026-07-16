import { useEffect, useRef, useState } from 'react'
import type { MusicData } from '../loaders/music'
import './SoundEffectViewer.css'

export default function MusicViewer({ data, onSave, onDirtyChange }: {
  data: MusicData
  onSave: (data: MusicData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [midUrl, setMidUrl] = useState(data.midUrl)
  const [midFile, setMidFile] = useState<File | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMidUrl(data.midUrl)
    setMidFile(null)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMidFile(file)
    setMidUrl(URL.createObjectURL(file))
    setIsDirty(true)
    e.target.value = ''
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, midFile })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setMidUrl(data.midUrl)
    setMidFile(null)
    setIsDirty(false)
  }

  return (
    <div className="sfx-viewer">
      <input ref={fileInputRef} type="file" accept="audio/midi,.mid,.midi" style={{ display: 'none' }} onChange={handleFileChange} />

      <div className="sfx-header">
        <span className="item-id-badge">Song {data.id}</span>
        {midUrl
          ? (
            <>
              {/* Browsers don't natively play raw .mid without a synth attached, so
                  this is a download link rather than an <audio> tag — any standard
                  MIDI player or editor (or a browser extension with a soundfont
                  synth) can open it directly. */}
              <a className="add-row-btn" href={midUrl} download={`song-${data.id}.mid`}>
                Download .mid
              </a>
              <span className="sfx-no-preview">
                Decompressed from the cache's compact format into a real, standard MIDI file — open it in
                any MIDI player or editor (e.g. MuseScore, a DAW, or a browser MIDI extension).
              </span>
            </>
          )
          : <span className="sfx-no-preview">No dumped preview.</span>}
        <button type="button" className="add-row-btn" onClick={() => fileInputRef.current?.click()}>
          Replace with edited .mid…
        </button>
        {midFile && <span className="sfx-no-preview">Staged: {midFile.name} (uploaded MIDI is treated as opaque data — not executed — and only takes effect on Save)</span>}
      </div>

      <section className="item-section">
        <h3>Repacking</h3>
        <p className="sfx-no-preview">
          cryogen recompresses whatever's in song.mid back into the cache's compact format on repack
          (verified: every song in both indices round-trips to identical decoded MIDI content through
          the compress/decompress pair). Edit the downloaded file in any standard MIDI editor, then
          upload the result here and Save.
        </p>
      </section>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={handleDiscard} disabled={isSaving}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
