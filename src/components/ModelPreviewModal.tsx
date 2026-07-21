import { useEffect, useRef, useState } from 'react'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import ModelViewer from './ModelViewer'
import type { ModelDisplayParams } from './ModelViewer'
import './AnimationViewer.css' // reuses the .anim-preview-dialog modal styles

type Props = {
  title: string
  modelId: number
  /** Item pose (inventory-icon display params); plain model when absent. */
  display?: ModelDisplayParams | null
  rootHandle: FileSystemDirectoryHandle
  /** Optional escape hatch, e.g. "Open in Models" / "Open Item". */
  openLabel?: string
  onOpen?: () => void
  onClose: () => void
}

/** Modal wrapper around ModelViewer: quick model previews without navigating
 *  away from the page you're on (items page View Model, BAS item rows). */
export default function ModelPreviewModal({ title, modelId, display, rootHandle, openLabel, onOpen, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [model, setModel] = useState<ModelData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { dialogRef.current?.showModal() }, [])

  useEffect(() => {
    let cancelled = false
    setModel(null)
    setError(null)
    ;(async () => {
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('models'))
        const loader = getLoader('models')
        if (!dir || !loader) throw new Error('models entry not available')
        const data = await loader.loadItem(dir, { id: modelId, name: `${modelId}` }, rootHandle) as ModelData
        if (!cancelled) setModel(data)
      } catch {
        if (!cancelled) setError(`Couldn't load model ${modelId}.`)
      }
    })()
    return () => { cancelled = true }
  }, [modelId, rootHandle])

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">{title}</h3>
          <span className="anim-fit-actions">
            {onOpen && openLabel && (
              <button type="button" className="field-link-btn" onClick={onOpen}>{openLabel}</button>
            )}
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>
        {error && <p className="anim-preview-status">{error}</p>}
        {!model && !error && <p className="anim-preview-status">Loading model {modelId}…</p>}
        {model && <ModelViewer data={model} display={display ?? undefined} />}
      </div>
    </dialog>
  )
}
