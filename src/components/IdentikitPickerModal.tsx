import { useEffect, useRef, useState } from 'react'
import { LOOK_PART_LABELS } from '../loaders/playerLook'
import { identikitIndexKey, loadIdentikitIndex } from '../loaders/identikitIndex'
import { getIdentikitIcon, peekIdentikitIcon } from './npcSnapshot'
import './AnimationViewer.css' // .anim-preview-dialog modal shell
import './PlayerDefaultsModal.css'

type Props = {
  rootHandle?: FileSystemDirectoryHandle
  /** Which look slot is being filled (0 hair … 6 feet). */
  part: number
  female: boolean
  /** The look's colour choices, so tiles preview in the wearer's colours. */
  colour: number[]
  currentId: number
  /** The equipment slot sprite, reused as the tile background. */
  slotUrl?: string
  slotSize: number
  onPick: (id: number) => void
  onClose: () => void
}

/** Browse every identikit that fits one look slot, for the gender being
 *  edited, and pick one. The candidate list comes from each kit's `category`
 *  byte, which encodes gender and body part together. */
export default function IdentikitPickerModal({
  rootHandle, part, female, colour, currentId, slotUrl, slotSize, onPick, onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [ids, setIds] = useState<number[] | null>(null)

  useEffect(() => { dialogRef.current?.showModal() }, [])

  useEffect(() => {
    if (!rootHandle) { setIds([]); return }
    let cancelled = false
    loadIdentikitIndex(rootHandle).then((index) => {
      if (!cancelled) setIds(index.get(identikitIndexKey(female, part)) ?? [])
    })
    return () => { cancelled = true }
  }, [rootHandle, female, part])

  const label = LOOK_PART_LABELS[part] ?? `Part ${part}`

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body picker-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">
            {female ? 'Female' : 'Male'} {label.toLowerCase()}
            {ids && <span className="defaults-pane-hint picker-count">{ids.length}</span>}
          </h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        {!ids && <p className="anim-preview-status">Scanning identikits…</p>}
        {ids?.length === 0 && (
          <p className="anim-preview-status">
            No {label.toLowerCase()} kits for this gender in the dump.
          </p>
        )}

        {ids && ids.length > 0 && (
          <div className="picker-grid">
            {ids.map((id) => (
              <button
                key={id}
                type="button"
                className={`picker-tile${id === currentId ? ' is-current' : ''}`}
                title={`Identikit ${id}`}
                onClick={() => { onPick(id); onClose() }}
              >
                <PickerIcon
                  cacheRoot={rootHandle ?? null}
                  kitId={id}
                  colour={colour}
                  slotUrl={slotUrl}
                  size={slotSize}
                />
                <span className="picker-tile-id">{id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </dialog>
  )
}

/** One candidate, rendered in the colours it would be worn in. Same
 *  scalar-keyed shape as the look slots — a batched loader here would cancel
 *  itself as the grid settles. */
function PickerIcon({ cacheRoot, kitId, colour, slotUrl, size }: {
  cacheRoot: FileSystemDirectoryHandle | null
  kitId: number
  colour: number[]
  slotUrl?: string
  size: number
}) {
  const colourKey = colour.join(',')
  const [url, setUrl] = useState<string | null>(peekIdentikitIcon(kitId, colour) ?? null)

  useEffect(() => {
    let cancelled = false
    const choices = colourKey.split(',').map(Number)
    setUrl(peekIdentikitIcon(kitId, choices) ?? null)
    if (!cacheRoot || kitId < 0) return
    getIdentikitIcon(cacheRoot, kitId, choices).then((u) => { if (!cancelled) setUrl(u) })
    return () => { cancelled = true }
  }, [cacheRoot, kitId, colourKey])

  return (
    <span
      className="rs-slot"
      style={{
        width: size,
        height: size,
        ...(slotUrl ? { backgroundImage: `url(${slotUrl})` } : {}),
      }}
    >
      {url && (
        <img
          className="defaults-part-icon"
          style={{ width: size - 2, height: size - 2 }}
          src={url}
          alt=""
        />
      )}
    </span>
  )
}
