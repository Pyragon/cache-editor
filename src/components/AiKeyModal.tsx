import { useEffect, useState } from 'react'
import { clearApiKey, getApiKey, isKeyPersisted, setApiKey } from '../procgen/claude'

/**
 * Where the user's own Anthropic key is entered, for the optional AI layer of
 * the region generator.
 *
 * The key is theirs and goes only to api.anthropic.com — never to a server of
 * ours, never into a generated plan, never logged. It is held in memory by
 * default; persisting is an explicit opt-in that says plainly where it ends up,
 * because anything else running on this origin can read localStorage.
 */
export default function AiKeyModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('')
  const [persist, setPersist] = useState(false)
  const [hasKey, setHasKey] = useState(false)

  useEffect(() => {
    const existing = getApiKey()
    setHasKey(!!existing)
    setPersist(isKeyPersisted())
  }, [])

  return (
    <div className="map-picker-overlay" onClick={onClose}>
      <div className="map-picker" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="map-picker-head">
          <span className="enum-title map-picker-title">AI generation</span>
          <button type="button" className="map-picker-close" onClick={onClose}>Close</button>
        </div>

        <p className="tex-op-note">
          Optional. The region generator works fully without a key — this only adds
          describing an area in words instead of picking a theme. Bring your own
          Anthropic API key; it is sent only to api.anthropic.com, directly from
          this page.
        </p>

        <label className="item-field-label" htmlFor="ai-key">Anthropic API key</label>
        <input
          id="ai-key"
          className="map-coord-input"
          style={{ width: '100%', marginTop: 4 }}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? '•••••••• (a key is set)' : 'sk-ant-…'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        <label className="mapscene-toggle" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          Remember it on this machine
        </label>
        <p className="tex-op-note" style={{ marginTop: 4 }}>
          Unchecked, the key lives in memory and is gone when you close the tab.
          Checked, it is stored in this browser's localStorage on this machine —
          readable by anything else running on this origin. A workspace-scoped key
          with a spend limit is the safer thing to paste anywhere.
        </p>

        <div className="map-picker-actions">
          <span className="map-picker-selcount">
            {hasKey ? 'A key is currently set.' : 'No key set.'}
          </span>
          {hasKey && (
            <button
              type="button"
              className="save-bar-discard"
              onClick={() => { clearApiKey(); setHasKey(false); setValue(''); setPersist(false) }}
            >
              Forget key
            </button>
          )}
          <button
            type="button"
            className="save-bar-save"
            disabled={!value.trim()}
            onClick={() => { setApiKey(value.trim(), persist); onClose() }}
          >
            Save key
          </button>
        </div>
      </div>
    </div>
  )
}
