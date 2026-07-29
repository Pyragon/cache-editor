import { useEffect, useMemo, useState } from 'react'
import type { IdentikitData, IdentikitDef } from '../loaders/config/identikit'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { getLoader } from '../loaders'
import type { ModelData } from '../loaders/models'
import { mergeModels, applyRecolor } from '../loaders/models'
import ModelViewer from './ModelViewer'
import PlayerLookModal from './PlayerLookModal'
import { LOOK_COLOUR_LABELS, LOOK_PART_LABELS, lookSlotFromCategory } from '../loaders/playerLook'
import type { PaletteToneUse, RecolorPalette } from '../loaders/playerAppearance'
import { loadRecolorPalette, paletteTonesUsed, toneIsItsOwnDefault } from '../loaders/playerAppearance'
import { hslToRgb } from '../loaders/models'
import { invalidateIdentikitIcon } from './npcSnapshot'
import { NumberInput, PairTable } from './defFields'
import { LOOK_PART_COUNT } from '../loaders/playerLook'

const HEAD_SLOT_COUNT = 5

type PreviewState = { loading: boolean; data: ModelData | null; error: boolean }

export default function IdentikitViewer({ data, onSave, onDirtyChange }: {
  data: IdentikitData
  onSave: (data: IdentikitData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState<IdentikitDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [bodyPreview, setBodyPreview] = useState<PreviewState>({ loading: false, data: null, error: false })
  const [headPreview, setHeadPreview] = useState<PreviewState>({ loading: false, data: null, error: false })
  const [showPlayerPreview, setShowPlayerPreview] = useState(false)
  const [palette, setPalette] = useState<RecolorPalette | null>(null)

  useEffect(() => {
    if (!data.rootHandle) return
    let cancelled = false
    loadRecolorPalette(data.rootHandle).then((p) => { if (!cancelled) setPalette(p) })
    return () => { cancelled = true }
  }, [data.rootHandle])

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  function setBodyModel(index: number, value: number) {
    setDraft((prev) => {
      const bodyModels = (prev.bodyModels ?? []).slice()
      bodyModels[index] = value
      return { ...prev, bodyModels }
    })
    setIsDirty(true)
  }

  function addBodyModel() {
    setDraft((prev) => ({ ...prev, bodyModels: [...(prev.bodyModels ?? []), 0] }))
    setIsDirty(true)
  }

  function removeBodyModel(index: number) {
    setDraft((prev) => {
      const bodyModels = (prev.bodyModels ?? []).filter((_, i) => i !== index)
      // Keep the key absent rather than an empty array — that's how kits with
      // no body models are stored, and the round trip has to match.
      return { ...prev, bodyModels: bodyModels.length > 0 ? bodyModels : undefined }
    })
    setIsDirty(true)
  }

  function setHeadModel(slot: number, value: number) {
    setDraft((prev) => {
      const headModels = (prev.headModels ?? [-1, -1, -1, -1, -1]).slice()
      headModels[slot] = value
      return { ...prev, headModels }
    })
    setIsDirty(true)
  }

  function setRecolorPair(index: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).slice()
      const replacementColours = (prev.replacementColours ?? []).slice()
      if (which === 0) originalColours[index] = value
      else replacementColours[index] = value
      return { ...prev, originalColours, replacementColours }
    })
    setIsDirty(true)
  }

  function addRecolorPair() {
    setDraft((prev) => ({
      ...prev,
      originalColours: [...(prev.originalColours ?? []), 0],
      replacementColours: [...(prev.replacementColours ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRecolorPair(index: number) {
    setDraft((prev) => {
      const originalColours = (prev.originalColours ?? []).filter((_, i) => i !== index)
      const replacementColours = (prev.replacementColours ?? []).filter((_, i) => i !== index)
      return {
        ...prev,
        originalColours: originalColours.length > 0 ? originalColours : undefined,
        replacementColours: replacementColours.length > 0 ? replacementColours : undefined,
      }
    })
    setIsDirty(true)
  }

  function setRetexturePair(index: number, which: 0 | 1, value: number) {
    setDraft((prev) => {
      const originalTextures = (prev.originalTextures ?? []).slice()
      const replacementTextures = (prev.replacementTextures ?? []).slice()
      if (which === 0) originalTextures[index] = value
      else replacementTextures[index] = value
      return { ...prev, originalTextures, replacementTextures }
    })
    setIsDirty(true)
  }

  function addRetexturePair() {
    setDraft((prev) => ({
      ...prev,
      originalTextures: [...(prev.originalTextures ?? []), 0],
      replacementTextures: [...(prev.replacementTextures ?? []), 0],
    }))
    setIsDirty(true)
  }

  function removeRetexturePair(index: number) {
    setDraft((prev) => {
      const originalTextures = (prev.originalTextures ?? []).filter((_, i) => i !== index)
      const replacementTextures = (prev.replacementTextures ?? []).filter((_, i) => i !== index)
      return {
        ...prev,
        originalTextures: originalTextures.length > 0 ? originalTextures : undefined,
        replacementTextures: replacementTextures.length > 0 ? replacementTextures : undefined,
      }
    })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    // The look slots in Settings → Set Defaults cache a render of this kit.
    invalidateIdentikitIcon(data.id)
    setIsSaving(false)
    setIsDirty(false)
  }

  // Loads and merges a set of model ids into one composite ModelData with
  // this identikit's recolor/retexture pairs applied — mirrors cryogen's
  // IdentiKitDefinitions.renderBody()/renderHead().
  async function loadComposite(modelIds: number[], setState: (s: PreviewState) => void) {
    if (modelIds.length === 0 || !data.rootHandle) { setState({ loading: false, data: null, error: false }); return }
    setState({ loading: true, data: null, error: false })
    try {
      const modelsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('models'))
      const loader = getLoader('models')
      if (!modelsDir || !loader) throw new Error('models entry not available')
      const parts = await Promise.all(modelIds.map((id) =>
        loader.loadItem(modelsDir, { id, name: `${id}` }, data.rootHandle) as Promise<ModelData>,
      ))
      const merged = mergeModels(parts)
      if (draft.originalColours) {
        applyRecolor(
          merged,
          draft.originalColours, draft.replacementColours ?? [],
          draft.originalTextures ?? [], draft.replacementTextures ?? [],
        )
      }
      setState({ loading: false, data: merged, error: false })
    } catch {
      setState({ loading: false, data: null, error: true })
    }
  }

  useEffect(() => {
    loadComposite(draft.bodyModels ?? [], setBodyPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.bodyModels, draft.originalColours, draft.replacementColours, draft.originalTextures, draft.replacementTextures, data.rootHandle])

  useEffect(() => {
    const heads = (draft.headModels ?? []).filter((id) => id >= 0)
    loadComposite(heads, setHeadPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.headModels, draft.originalColours, draft.replacementColours, draft.originalTextures, draft.replacementTextures, data.rootHandle])

  // An identikit's `category` says both which body part it is and which
  // gender's kit list it belongs to, so the preview can drop it straight into
  // the matching slot of the right default look (see playerLook.ts).
  const slot = lookSlotFromCategory(draft.category)

  // The previews below render the mesh as painted, but a player's colour
  // choice replaces these tones before anything reaches the game — so a kit
  // painted in two of them (identikit 323's brown + magenta hair) reads as a
  // two-colour hairstyle when it is really one colour plus a marker.
  const paletteTones = useMemo(() => {
    if (!palette) return []
    const seen = new Map<string, PaletteToneUse>()
    for (const model of [bodyPreview.data, headPreview.data]) {
      if (!model) continue
      for (const use of paletteTonesUsed(model, palette)) {
        const key = `${use.group}:${use.slot}`
        const prev = seen.get(key)
        if (prev) prev.faces += use.faces
        else seen.set(key, { ...use })
      }
    }
    return [...seen.values()]
  }, [palette, bodyPreview.data, headPreview.data])

  // Only worth explaining where it actually misleads — i.e. where a MARKER
  // tone is on screen, a colour always swapped out before the game draws it.
  // Tones that map to themselves at choice 0 are honest previews and need no
  // note; flagging those too would put this banner on ~74% of kits. The whole
  // palette has just two markers (hair slot 1, skin slot 3), which lands this
  // on hairstyles and beards — exactly where the surprise is.
  const markerToneGroup = useMemo(() => {
    if (!palette) return null
    const byGroup = new Map<number, PaletteToneUse[]>()
    for (const tone of paletteTones) {
      const list = byGroup.get(tone.group) ?? []
      list.push(tone)
      byGroup.set(tone.group, list)
    }
    for (const [group, tones] of byGroup) {
      if (tones.some((t) => !toneIsItsOwnDefault(palette, t.group, t.slot))) return { group, tones }
    }
    return null
  }, [paletteTones, palette])

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Identikit {data.id}</span>
          {slot && (
            <span className="item-id-badge">
              {slot.female ? 'Female' : 'Male'} · {LOOK_PART_LABELS[slot.part]}
            </span>
          )}
          <button
            type="button"
            className="look-preview-btn"
            onClick={() => setShowPlayerPreview(true)}
            title="Show this identikit on the default player look"
          >
            <span className="look-preview-btn-glyph" aria-hidden="true">🧍</span>
            Preview
          </button>
        </div>
      </div>

      {showPlayerPreview && (
        <PlayerLookModal
          title={`Identikit ${data.id} on the default look`}
          rootHandle={data.rootHandle}
          female={slot?.female ?? false}
          override={slot ? { part: slot.part, identikitId: data.id, def: draft } : null}
          note={slot ? undefined : `Category ${draft.category} doesn't map to a body part, so this kit isn't swapped in — showing the default look alone.`}
          onClose={() => setShowPlayerPreview(false)}
        />
      )}

      <div className="idk-columns">
      <div className="idk-fields">

      <section className="item-section">
        <h3>General</h3>
        {/* `category` is gender AND body part packed together — see
            playerLook.ts — so it edits as two controls that write one byte. */}
        <div className="idk-general">
          <label className="idk-field">
            <span className="item-field-label">Gender</span>
            <span className="pill-group">
              <button
                type="button"
                className={`pill-btn${slot?.female ? '' : ' active'}`}
                onClick={() => set('category', (slot?.part ?? 0))}
              >
                Male
              </button>
              <button
                type="button"
                className={`pill-btn${slot?.female ? ' active' : ''}`}
                onClick={() => set('category', LOOK_PART_COUNT + (slot?.part ?? 0))}
              >
                Female
              </button>
            </span>
          </label>

          <label className="idk-field">
            <span className="item-field-label">Body part</span>
            <select
              className="item-stackable-select idk-part-select"
              value={slot ? slot.part : ''}
              onChange={(e) => set('category', (slot?.female ? LOOK_PART_COUNT : 0) + Number(e.target.value))}
            >
              {!slot && <option value="">category {draft.category}</option>}
              {LOOK_PART_LABELS.map((label, part) => (
                <option key={part} value={part}>{label}</option>
              ))}
            </select>
          </label>

          {slot?.female && slot.part === 1 && (
            <span className="idk-general-note">No female beard kits exist in this cache.</span>
          )}
        </div>
      </section>

      <section className="item-section">
        <h3>Body Models</h3>
        <p className="idk-preview-note idk-inline-note">Merged into one composite mesh, in order.</p>
        {(draft.bodyModels?.length ?? 0) > 0 && (
          <div className="quest-table-wrap item-pair-wrap">
            <table className="quest-table">
              <thead><tr><th className="idk-index-th">#</th><th>Model</th><th>Remove</th></tr></thead>
              <tbody>
                {(draft.bodyModels ?? []).map((id, i) => (
                  <tr key={i}>
                    <td className="item-stack-index">{i}</td>
                    <td><NumberInput className="cell-input" value={id} onChange={(v) => setBodyModel(i, v)} /></td>
                    <td><button type="button" className="row-remove-btn" onClick={() => removeBodyModel(i)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add-row-btn" onClick={addBodyModel}>+ Add model</button>
      </section>

      <section className="item-section">
        <h3>Head Models</h3>
        <div className="idk-head-grid">
          {Array.from({ length: HEAD_SLOT_COUNT }, (_, i) => (
            <label key={i} className="idk-field">
              <span className="item-field-label">Slot {i}</span>
              <NumberInput className="cell-input idk-num" value={draft.headModels?.[i] ?? -1} onChange={(v) => setHeadModel(i, v)} />
            </label>
          ))}
        </div>
      </section>

      <PairTable
        title="Recolour Pairs"
        srcLabel="Original HSL"
        dstLabel="Replacement HSL"
        src={draft.originalColours ?? []}
        dst={draft.replacementColours ?? []}
        onSet={setRecolorPair}
        onAdd={addRecolorPair}
        onRemove={removeRecolorPair}
      />

      <PairTable
        title="Retexture Pairs"
        srcLabel="Original Texture"
        dstLabel="Replacement Texture"
        src={draft.originalTextures ?? []}
        dst={draft.replacementTextures ?? []}
        onSet={setRetexturePair}
        onAdd={addRetexturePair}
        onRemove={removeRetexturePair}
      />

      </div>

      <div className="idk-side">
      {markerToneGroup && palette && (
        <section className="item-section">
          <div className="tone-note">
            <div className="tone-note-head">
              <span className="tone-note-title">
                {markerToneGroup.tones.length > 1
                  ? `Two-tone ${LOOK_COLOUR_LABELS[markerToneGroup.group].toLowerCase()} — the previews show placeholder colours`
                  : 'The previews show a placeholder colour'}
              </span>
              <span className="tone-note-swatches">
                {markerToneGroup.tones.map((tone) => {
                  const rgb = hslToRgb(tone.source & 0xffff)
                  const marker = !toneIsItsOwnDefault(palette, tone.group, tone.slot)
                  return (
                    <span
                      key={`${tone.group}:${tone.slot}`}
                      className={`tone-note-swatch${marker ? ' is-marker' : ''}`}
                      style={{ background: `#${rgb.toString(16).padStart(6, '0')}` }}
                      title={`${tone.faces} face${tone.faces === 1 ? '' : 's'} painted HSL16 ${tone.source}${marker ? ' — a marker colour, always replaced' : ' — also this tone’s colour at choice 0, so it survives unchanged there'}`}
                    />
                  )
                })}
              </span>
            </div>
            <p className="tone-note-body">
              This kit is painted in {markerToneGroup.tones.length === 1 ? 'a colour' : `${markerToneGroup.tones.length} colours`}{' '}
              that a player's <strong>{LOOK_COLOUR_LABELS[markerToneGroup.group].toLowerCase()}</strong> choice replaces,
              and one setting replaces {markerToneGroup.tones.length === 1 ? 'it' : 'them all together, so they can’t be picked apart'}.
              The previews below render the mesh as painted, so an <em>outlined</em> swatch above is a marker — always
              swapped out, never drawn in game, which is why it can look like a colour no{' '}
              {LOOK_COLOUR_LABELS[markerToneGroup.group].toLowerCase()} ever has. Swatches without an outline map to
              themselves at choice 0, so those are real colours. Use <strong>Preview</strong> to see the kit recoloured
              on a full player.
            </p>
          </div>
        </section>
      )}

      <div className="idk-preview-row">
      {(draft.bodyModels?.length ?? 0) > 0 && (
        <section className="item-section idk-preview-card">
          <h3>Body model</h3>
          <p className="idk-preview-note">The mesh worn on the player body.</p>
          {bodyPreview.loading && <p className="tex-op-note">Loading…</p>}
          {bodyPreview.error && <p className="tex-op-note">Couldn't load one or more body models.</p>}
          {bodyPreview.data && <ModelViewer data={bodyPreview.data} hideHeader fitScale={1.9} />}
        </section>
      )}

      {(draft.headModels?.some((id) => id >= 0) ?? false) && (
        <section className="item-section idk-preview-card">
          <h3>Head model</h3>
          <p className="idk-preview-note">
            A separate mesh, used for chathead portraits.
          </p>
          {headPreview.loading && <p className="tex-op-note">Loading…</p>}
          {headPreview.error && <p className="tex-op-note">Couldn't load one or more head models.</p>}
          {headPreview.data && <ModelViewer data={headPreview.data} hideHeader fitScale={1.9} />}
        </section>
      )}
      </div>

      </div>
      </div>

      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false) }}>Discard</button>
          <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
