import { useEffect, useRef, useState } from 'react'
import './SettingsMenu.css'

export type SettingsMenuItem = {
  label: string
  hint?: string
  onSelect: () => void
}

/** The gear beside the app title. A plain dropdown — more entries are expected
 *  to land here, so it takes its items as data rather than hardcoding one. */
export default function SettingsMenu({ items }: { items: SettingsMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="settings-menu" ref={wrapRef}>
      <button
        type="button"
        className={`settings-menu-btn${open ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⚙</span>
        <span className="sr-only">Settings</span>
      </button>

      {open && (
        <div className="settings-menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="settings-menu-item"
              onClick={() => { setOpen(false); item.onSelect() }}
            >
              <span className="settings-menu-item-label">{item.label}</span>
              {item.hint && <span className="settings-menu-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
