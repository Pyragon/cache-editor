import { useEffect, useRef, useState } from 'react'
import type { LookModel, LookPartOverride } from '../loaders/playerAppearance'
import { buildLookModel } from '../loaders/playerAppearance'
import type { PlayerLooks } from '../loaders/playerLook'
import { LOOK_PART_LABELS, loadPlayerLooks } from '../loaders/playerLook'
import ModelViewer from './ModelViewer'
import './AnimationViewer.css' // reuses the .anim-preview-dialog modal styles
import './PlayerLookModal.css'

type Props = {
  title: string
  rootHandle?: FileSystemDirectoryHandle
  /** Which stored default look to dress — the gender the previewed def
   *  belongs to. Locked: a kit is authored for one body, and the list already
   *  labels which, so there's nothing to choose here. */
  female: boolean
  /** The def being viewed, swapped into the look part it belongs to. */
  override?: LookPartOverride | null
  /** Shown above the preview — e.g. why no part could be overridden. */
  note?: string
  onClose: () => void
}

/** Previews a def on the stored default player look: the seven identikit body
 *  parts assembled the way the client builds an unequipped player, with the
 *  def you're looking at replacing its own slot. */
export default function PlayerLookModal({ title, rootHandle, female, override, note, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [looks] = useState<PlayerLooks>(() => loadPlayerLooks())
  const [built, setBuilt] = useState<LookModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { dialogRef.current?.showModal() }, [])

  // The override's def is the viewer's live draft, so unsaved edits preview;
  // its identity changes every parent render, hence the value-keyed deps.
  const overrideKey = override ? `${override.part}:${override.identikitId}:${JSON.stringify(override.def ?? null)}` : ''

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    setBuilt(null)
    setError(null)
    buildLookModel(rootHandle, female ? looks.female : looks.male, override, female)
      .then((result) => { if (!cancelled) setBuilt(result) })
      .catch(() => { if (!cancelled) setError('Could not assemble the player look.') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootHandle, female, looks, overrideKey])

  const missing = built?.parts.filter((p) => p.status === 'missing') ?? []

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
            <span className="item-id-badge">{female ? 'Female' : 'Male'} look</span>
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>

        {built && (
          <div className="look-part-row">
            {built.parts.map((part) => {
              const name = LOOK_PART_LABELS[part.part]
              const dim = part.status === 'empty' || part.status === 'n/a'
              const borrowed = part.source === 'set' || part.source === 'fallback'
              const title = part.status === 'n/a'
                ? `${name} — not worn by this gender; the server writes the slot empty`
                : part.overridden
                  ? `${name} — the identikit you're viewing`
                  : part.source === 'set'
                    ? `${name} — set by the outfit set the top belongs to, as the client does (not from the default look)`
                    : part.source === 'fallback'
                      ? `${name} — no outfit set covers this combination, so the client's default (${part.identikitId}) stands in`
                      : part.status === 'empty'
                        ? `${name} — not worn by the default look`
                        : `${name} — identikit ${part.identikitId} from the default look`
              return (
                <span
                  key={part.part}
                  className={`look-part-chip${part.overridden ? ' is-override' : ''}${dim ? ' is-empty' : ''}${part.status === 'missing' ? ' is-missing' : ''}${borrowed ? ' is-fallback' : ''}`}
                  title={title}
                >
                  <span className="look-part-chip-name">{name}</span>
                  {part.status === 'n/a' ? 'n/a' : part.status === 'empty' ? 'none' : part.identikitId}
                  {borrowed && <span className="look-part-chip-tag">{part.source}</span>}
                </span>
              )
            })}
          </div>
        )}

        {note && <p className="anim-preview-status">{note}</p>}
        {!rootHandle && <p className="anim-preview-status">No cache open.</p>}
        {error && <p className="anim-preview-status">{error}</p>}
        {rootHandle && !built && !error && <p className="anim-preview-status">Assembling player…</p>}
        {built && !built.model && !error && (
          <p className="anim-preview-status">Nothing renderable — none of the look's parts loaded.</p>
        )}
        {built?.model && <ModelViewer data={built.model} />}

        {missing.length > 0 && (
          <p className="anim-preview-status">
            Couldn't load: {missing.map((p) => `${LOOK_PART_LABELS[p.part]} (${p.identikitId})`).join(', ')}.
          </p>
        )}
        {built && !built.paletteApplied && (
          <p className="anim-preview-status">
            Colour choices not applied — the <code>defaults</code> entity blob has no recolour palettes in this dump.
          </p>
        )}
      </div>
    </dialog>
  )
}
