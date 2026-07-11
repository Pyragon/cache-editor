import { useEffect, useRef } from 'react'
import './ConfirmDialog.css'

export type ConfirmOptions = {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type PendingConfirm = ConfirmOptions & {
  message: string
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
        <p className="confirm-dialog-message">{pending.message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="save-bar-discard" autoFocus onClick={() => onClose(false)}>
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={pending.danger ? 'confirm-dialog-danger' : 'save-bar-save'}
            onClick={() => onClose(true)}
          >
            {pending.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
