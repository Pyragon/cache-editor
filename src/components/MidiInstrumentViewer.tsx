import { useEffect, useRef, useState } from 'react'
import type { MidiInstrumentData, MidiInstrumentDef } from '../loaders/midi_instruments'
import { NumberInput, NumGrid } from './defFields'
import './SoundEffectViewer.css'

export default function MidiInstrumentViewer({ data, onSave, onDirtyChange }: {
  data: MidiInstrumentData
  onSave: (data: MidiInstrumentData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [def, setDef] = useState<MidiInstrumentDef>(data.def)
  const [oggUrl, setOggUrl] = useState(data.oggUrl)
  const [oggFile, setOggFile] = useState<File | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDef(data.def)
    setOggUrl(data.oggUrl)
    setOggFile(null)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set<K extends keyof MidiInstrumentDef>(key: K, value: MidiInstrumentDef[K]) {
    setDef((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setOggFile(file)
    setOggUrl(URL.createObjectURL(file))
    setIsDirty(true)
    e.target.value = ''
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def, oggFile })
    setIsSaving(false)
    setIsDirty(false)
  }

  function handleDiscard() {
    setDef(data.def)
    setOggUrl(data.oggUrl)
    setOggFile(null)
    setIsDirty(false)
  }

  return (
    <div className="sfx-viewer">
      <input ref={fileInputRef} type="file" accept="audio/ogg,.ogg" style={{ display: 'none' }} onChange={handleFileChange} />

      <div className="sfx-header">
        <span className="item-id-badge">Midi Instrument {data.id}</span>
        {oggUrl
          ? <audio controls src={oggUrl} className="sfx-audio" />
          : <span className="sfx-no-preview">No dumped preview.</span>}
        <button type="button" className="add-row-btn" onClick={() => fileInputRef.current?.click()}>
          Replace Audio…
        </button>
        {oggFile && <span className="sfx-no-preview">Staged: {oggFile.name} (uploaded audio is treated as opaque data — not executed or transcoded — and only takes effect on Save)</span>}
      </div>

      <section className="item-section">
        <h3>Metadata</h3>
        <NumGrid
          fields={[['samplingRate', 'Sampling Rate (Hz)'], ['sampleSize', 'Sample Size'], ['loopStart', 'Loop Start'], ['loopEnd', 'Loop End']]}
          values={def}
          onChange={(k, v) => set(k as keyof MidiInstrumentDef, v as never)}
        />
        <label className="item-field">
          <span className="item-field-label">Duration (ms, computed at dump time)</span>
          <NumberInput value={Math.round(def.duration)} onChange={() => {}} />
        </label>
        <label className="item-field def-toggle-field">
          <span className="item-field-label">Loop End Was Negative (aBool7609)</span>
          <span className="sprite-toggle">
            <input type="checkbox" checked={def.aBool7609} onChange={(e) => set('aBool7609', e.target.checked)} />
            <span className="sprite-toggle-track" />
          </span>
        </label>
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
