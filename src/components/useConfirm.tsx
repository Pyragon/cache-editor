import { useCallback, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { ConfirmOptions, PendingConfirm } from './ConfirmDialog'

// Promise-based confirm: `const ok = await confirm('Delete this?')`.
// Render the returned `dialog` element once near the component root.
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback((message: string, options?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending((prev) => {
        prev?.resolve(false)
        return { message, ...options, resolve }
      })
    })
  }, [])

  const close = useCallback((result: boolean) => {
    setPending((prev) => {
      prev?.resolve(result)
      return null
    })
  }, [])

  const dialog = pending ? <ConfirmDialog pending={pending} onClose={close} /> : null
  return { confirm, dialog }
}
