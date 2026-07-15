import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import './ConfirmDialog.css'

export type ConfirmOptions = {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** No choice to make — show a single dismiss button instead of Cancel/OK. */
  acknowledge?: boolean
}

export type PendingConfirm = ConfirmOptions & {
  message: ReactNode
  resolve: (result: boolean) => void
}

export default function ConfirmDialog({ pending, onClose }: { pending: PendingConfirm; onClose: (result: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      onCancel={(e) => { e.preventDefault(); onClose(false) }}
      onClick={(e) => { if (e.target === ref.current) onClose(false) }}
    >
      <div className="confirm-dialog-body">
        {pending.title && <h3 className="confirm-dialog-title">{pending.title}</h3>}
        <div className="confirm-dialog-message">{pending.message}</div>
        <div className="confirm-dialog-actions">
          {!pending.acknowledge && (
            <button type="button" className="save-bar-discard" autoFocus onClick={() => onClose(false)}>
              {pending.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            type="button"
            className={pending.danger ? 'confirm-dialog-danger' : 'save-bar-save'}
            autoFocus={pending.acknowledge}
            onClick={() => onClose(true)}
          >
            {pending.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
