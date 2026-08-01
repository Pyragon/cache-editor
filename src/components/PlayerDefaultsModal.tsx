import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PlayerLook, PlayerLooks } from '../loaders/playerLook'
import {
  LOOK_COLOUR_LABELS, LOOK_PART_ARMS, LOOK_PART_COUNT, LOOK_PART_LABELS, LOOK_PART_TOP,
  LOOK_PART_WRISTS, defaultPlayerLooks, loadPlayerGender, loadPlayerLooks, lookPartAppliesTo,
  savePlayerGender, savePlayerLooks,
} from '../loaders/playerLook'
import type { LookModel, RecolorPalette } from '../loaders/playerAppearance'
import { buildLookModel, loadRecolorPalette } from '../loaders/playerAppearance'
import type { OutfitData } from '../loaders/outfitSets'
import { loadOutfitSets, setForTop } from '../loaders/outfitSets'
import { EQUIPMENT_SLOTS, EQUIPMENT_SPRITES, scaleEquipmentLayout } from '../loaders/equipmentSlots'
import type { ItemBrief } from '../loaders/itemSlots'
import { findSlotItem, getItem } from '../loaders/itemSlots'
import type { IdentikitIndex } from '../loaders/identikitIndex'
import { identikitIndexKey, loadIdentikitIndex, stepIdentikit } from '../loaders/identikitIndex'
import type { RenderEmote } from '../loaders/renderEmote'
import { loadStandAnimation, resolveRenderEmote } from '../loaders/renderEmote'
import type { AnimationDef } from '../loaders/animations'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import { useSequencePlayback } from './useSequencePlayback'
import { loadUiSprites } from '../loaders/uiSprites'
import { hslToRgb } from '../loaders/models'
import { ItemIcon, NumberInput } from './defFields'
import ModelViewer from './ModelViewer'
import type { CameraState } from './ModelViewer'
import { getIdentikitIcon, peekIdentikitIcon } from './npcSnapshot'
import IdentikitPickerModal from './IdentikitPickerModal'
import './AnimationViewer.css' // .anim-preview-dialog modal shell
import './PlayerDefaultsModal.css'

// Tiles larger than the client's, offsets scaled with them so the grid keeps
// its proportions and the panel widens to suit (1.1, then another 15%).
// 36px tiles become 46 and the 190px panel becomes 240.
const EQUIP = scaleEquipmentLayout(1.1 * 1.15)

/** Look tiles take their size from the equipment layout so the two sides can't
 *  drift apart when the scale is retuned. */
const LOOK_SLOT_SIZE = EQUIP.slots[0].size

/** `.rs-panel` padding, needed to turn a measured content height into a panel
 *  height. Kept in step with the CSS by hand. */
const PANEL_PADDING = 8

/** Tallest the colour list gets before it scrolls; also decides whether it
 *  opens upward when there isn't room below. */
const MAX_POP_HEIGHT = 240

type Props = {
  rootHandle?: FileSystemDirectoryHandle
  onClose: () => void
}

/** Editor for the stored player look — the look and equipment the editor
 *  dresses a player in wherever it needs one (identikit previews today,
 *  cutscene players later). Persists to localStorage; nothing here touches
 *  the cache. */
export default function PlayerDefaultsModal({ rootHandle, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [looks, setLooks] = useState<PlayerLooks>(() => loadPlayerLooks())
  const [female, setFemale] = useState(loadPlayerGender)
  const [dirty, setDirty] = useState(false)
  const [palette, setPalette] = useState<RecolorPalette | null>(null)
  const [outfit, setOutfit] = useState<OutfitData | null>(null)
  const [slotSprites, setSlotSprites] = useState<Map<number, string>>(new Map())
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null)
  const [hoveredSlot, setHoveredSlot] = useState<number | null>(null)
  const [browsePart, setBrowsePart] = useState<number | null>(null)
  // Item slot/name lookups, filled one id at a time as they're needed. An
  // `undefined` entry means "not looked up yet", `null` means "no such item /
  // not equipable" — both distinct from a real brief.
  const [items, setItems] = useState<Map<number, ItemBrief | null>>(new Map())
  const [kitIndex, setKitIndex] = useState<IdentikitIndex | null>(null)
  const [stepping, setStepping] = useState(false)
  // Clicking a slot should leave you ready to type its id.
  const slotInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectedSlot == null) return
    const input = slotInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [selectedSlot])

  useEffect(() => { dialogRef.current?.showModal() }, [])

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    loadRecolorPalette(rootHandle).then((p) => { if (!cancelled) setPalette(p) })
    loadOutfitSets(rootHandle).then((o) => { if (!cancelled) setOutfit(o) })
    loadUiSprites(rootHandle, [EQUIPMENT_SPRITES.slot, EQUIPMENT_SPRITES.slotHover])
      .then((m) => { if (!cancelled) setSlotSprites(m) })
    // 651 kits, and the sidebar list has usually warmed this already.
    loadIdentikitIndex(rootHandle).then((i) => { if (!cancelled) setKitIndex(i) })
    return () => { cancelled = true }
  }, [rootHandle])

  const look = female ? looks.female : looks.male

  function edit(mutate: (draft: PlayerLook) => void) {
    setLooks((prev) => {
      const key = female ? 'female' : 'male'
      const next = { look: [...prev[key].look], colour: [...prev[key].colour], equipment: [...prev[key].equipment] }
      mutate(next)
      return { ...prev, [key]: next }
    })
    setDirty(true)
  }

  // Look up only the items actually equipped — one small read each, not an
  // index of all 25k.
  const equippedKey = look.equipment.join(',')
  useEffect(() => {
    if (!rootHandle) return
    const wanted = look.equipment.filter((id) => id >= 0 && !items.has(id))
    if (wanted.length === 0) return
    let cancelled = false
    Promise.all(wanted.map(async (id) => [id, await getItem(rootHandle, id)] as const))
      .then((rows) => {
        if (cancelled) return
        setItems((prev) => {
          const next = new Map(prev)
          for (const [id, brief] of rows) next.set(id, brief)
          return next
        })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equippedKey, rootHandle])

  // The assembled player. Rebuilt whenever the look, its colours, the
  // equipment or the gender change — keyed by VALUE, since `edit` hands back a
  // fresh object every keystroke and an identity dep would rebuild constantly.
  const [preview, setPreview] = useState<LookModel | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Orbit position/target survive a model swap — ModelViewer writes this on
  // teardown and restores from it on the next build.
  const cameraRef = useRef<CameraState | null>(null)
  const lookKey = `${female}|${look.look.join(',')}|${look.colour.join(',')}|${equippedKey}`

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    // Deliberately NOT clearing `preview` first: blanking it unmounts the
    // viewer, so every keystroke tore the scene down and rebuilt it from
    // scratch. Keeping the old model on screen until the new one lands means
    // the swap is invisible, and the camera ref below carries the orbit over.
    setPreviewError(null)
    buildLookModel(rootHandle, look, null, female)
      .then((result) => { if (!cancelled && result.model) setPreview(result) })
      .catch(() => { if (!cancelled) setPreviewError('Could not assemble the player.') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootHandle, lookKey])

  // The render emote: a stored -1 means "derive it", which for an unarmed
  // player is BAS 1426 -> stand animation 808. A weapon in slot 3 supplies its
  // own through client-script param 644. See renderEmote.ts for the trace.
  const [emote, setEmote] = useState<RenderEmote | null>(null)
  const [standAnim, setStandAnim] = useState<AnimationDef | null>(null)
  const [standSeq, setStandSeq] = useState<number | null>(null)

  useEffect(() => {
    if (!rootHandle) return
    let cancelled = false
    ;(async () => {
      const resolved = await resolveRenderEmote(rootHandle, look.equipment)
      if (cancelled) return
      setEmote(resolved)
      const seq = await loadStandAnimation(rootHandle, resolved.bas)
      if (cancelled) return
      setStandSeq(seq)
      try {
        const dir = await resolveEntryHandle(rootHandle, getEntryPath('animations'))
        if (!dir) return
        const def = JSON.parse(await (await (await dir.getFileHandle(`${seq}.json`)).getFile()).text()) as AnimationDef
        if (!cancelled) setStandAnim(def)
      } catch { /* no sequence — the preview just stands in its rest pose */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootHandle, equippedKey])

  const { posedVertices, poseBounds } = useSequencePlayback(standAnim, preview?.model ?? null, rootHandle, true)

  /** Walks ids from the current one until an item fits the slot. */
  async function stepEquipment(slot: number, current: number, direction: 1 | -1) {
    if (!rootHandle) return
    setStepping(true)
    try {
      const found = await findSlotItem(rootHandle, slot, current, direction)
      if (found >= 0) edit((d) => { d.equipment[slot] = found })
    } finally {
      setStepping(false)
    }
  }

  // A top belonging to an outfit set dictates its own arms and wrists, so
  // those two fields are derived rather than free — see EDITOR.md.
  const topSet = outfit ? setForTop(outfit, look.look[LOOK_PART_TOP], female) : null
  const derivedParts = useMemo(() => {
    if (!topSet) return new Map<number, number>()
    return new Map<number, number>([
      [LOOK_PART_ARMS, topSet.arms],
      [LOOK_PART_WRISTS, topSet.wrists],
    ])
  }, [topSet])

  // Both panels end up the same height: whichever side needs more wins. The
  // look side is content-driven and gender-dependent (no beard row on a
  // female), so it's measured — but measured on an INNER wrapper, because the
  // outer panel carries the resulting min-height and measuring that would
  // ratchet: it could never report a shrink after a gender switch.
  const lookRowsRef = useRef<HTMLDivElement>(null)
  const [lookRowsHeight, setLookRowsHeight] = useState(0)
  useLayoutEffect(() => {
    const el = lookRowsRef.current
    if (!el) return
    const sync = () => setLookRowsHeight(el.offsetHeight)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const panelHeight = Math.max(lookRowsHeight + PANEL_PADDING * 2, EQUIP.contentHeight)

  function handleSave() {
    savePlayerLooks(looks)
    setDirty(false)
  }

  function handleReset() {
    setLooks(defaultPlayerLooks())
    setDirty(true)
  }

  const slotUrl = slotSprites.get(EQUIPMENT_SPRITES.slot)
  const selected = selectedSlot == null ? null : EQUIPMENT_SLOTS.find((s) => s.index === selectedSlot) ?? null
  // Hover wins over selection so sweeping the panel reads every slot name.
  const namedSlot = (hoveredSlot != null ? EQUIPMENT_SLOTS.find((s) => s.index === hoveredSlot) : null) ?? selected

  return (
    <dialog
      ref={dialogRef}
      className="anim-preview-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="anim-preview-body defaults-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Player Look</h3>
          <span className="anim-fit-actions">
            <span className="pill-group">
              <button
                type="button"
                className={`pill-btn${female ? '' : ' active'}`}
                onClick={() => { setFemale(false); savePlayerGender(false); setSelectedSlot(null) }}
              >
                Male
              </button>
              <button
                type="button"
                className={`pill-btn${female ? ' active' : ''}`}
                onClick={() => { setFemale(true); savePlayerGender(true); setSelectedSlot(null) }}
              >
                Female
              </button>
            </span>
            <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
          </span>
        </div>

        <p className="tone-note-body defaults-intro">
          The look and equipment the editor dresses a player in. Stored in this browser, not in the cache.
        </p>


        <div className="defaults-columns">
          {/* ---------------------------------------------------------- look */}
          <section className="defaults-pane">
            <h4 className="defaults-pane-title">Look</h4>
            {/* Grouped so the note can be pinned to the panel's width rather
                than stretching the whole column — see .defaults-note. */}
            <div className="defaults-look-group">
            <div className="rs-panel defaults-look-panel" style={{ minHeight: panelHeight }}>
            <div className="defaults-look-rows" ref={lookRowsRef}>
              {Array.from({ length: LOOK_PART_COUNT }, (_, part) => {
                if (!lookPartAppliesTo(part, female)) return null
                const derived = derivedParts.get(part)
                const isDerived = derived !== undefined
                const value = isDerived ? derived : look.look[part]
                return (
                  <label key={part} className="defaults-row">
                    <LookSlotIcon
                      cacheRoot={rootHandle ?? null}
                      kitId={value}
                      colour={look.colour}
                      slotUrl={slotUrl}
                    />
                    <span className="defaults-row-label">{LOOK_PART_LABELS[part]}</span>
                    {isDerived
                      // Not an input: the game overwrites these from the top's
                      // outfit set, so an editable field would take a value
                      // that never survives. The note under the panel says why.
                      ? <span className="defaults-num defaults-num-locked">{value}</span>
                      : (
                        <>
                          <NumberInput
                            className="cell-input defaults-num"
                            value={value}
                            title={kitIndex
                              ? `Step through the ${kitIndex.get(identikitIndexKey(female, part))?.length ?? 0} ${female ? 'female' : 'male'} ${LOOK_PART_LABELS[part].toLowerCase()} kits`
                              : undefined}
                            // ± stays inside this part's kits; ±1 on the raw id
                            // would walk into another body part entirely.
                            onStep={kitIndex
                              ? (current, direction) => edit((d) => {
                                d.look[part] = stepIdentikit(kitIndex.get(identikitIndexKey(female, part)), current, direction)
                              })
                              : undefined}
                            onChange={(v) => edit((d) => { d.look[part] = v })}
                          />
                          <button
                            type="button"
                            className="model-toolbar-btn defaults-browse"
                            title={`Browse every ${female ? 'female' : 'male'} ${LOOK_PART_LABELS[part].toLowerCase()} kit`}
                            onClick={() => setBrowsePart(part)}
                          >
                            Browse…
                          </button>
                        </>
                      )}
                  </label>
                )
              })}
            </div>
            </div>

            {topSet && (
              <p className="defaults-note">
                <strong>{LOOK_PART_LABELS[LOOK_PART_ARMS]}</strong> and{' '}
                <strong>{LOOK_PART_LABELS[LOOK_PART_WRISTS]}</strong> come from the “{topSet.name}”
                outfit set that top {look.look[LOOK_PART_TOP]} belongs to. Choosing a top overwrites
                both in game, so they aren't editable here.
              </p>
            )}
            </div>

            <h4 className="defaults-pane-title">Colours</h4>
            <div className="rs-panel defaults-colour-panel">
              {palette
                ? LOOK_COLOUR_LABELS.map((label, group) => {
                  const choices = palette.dst[group]?.[0]?.length ?? 0
                  if (choices === 0) return null
                  const value = look.colour[group] ?? 0
                  const clamped = value >= 0 && value < choices
                  return (
                    <label key={group} className="defaults-row">
                      <span className="defaults-row-label">{label}</span>
                      <ColourSelect
                        value={clamped ? value : 0}
                        choices={choices}
                        colourOf={(n) => swatchFor(palette, group, n)}
                        onChange={(n) => edit((d) => { d.colour[group] = n })}
                      />
                    </label>
                  )
                })
                : <p className="tone-note-body">No colour palettes in this dump.</p>}
            </div>
          </section>

          {/* ----------------------------------------------------- equipment */}
          <section className="defaults-pane">
            {/* The slot boxes are identical and unlabelled in game; naming the
                one under the cursor here beats writing into every tile. */}
            <h4 className="defaults-pane-title defaults-equip-title">
              Equipment
              {namedSlot && <span className="defaults-pane-hint">{namedSlot.label}</span>}
              {namedSlot && (() => {
                const id = look.equipment[namedSlot.index] ?? -1
                if (id < 0) return null
                const brief = items.get(id)
                if (brief === undefined) return <span className="defaults-title-item">checking…</span>
                const bad = brief?.wearPos !== namedSlot.index
                return (
                  <span className={`defaults-title-item${bad ? ' is-wrong' : ''}`}>
                    {bad && <span className="rs-equip-warn" aria-hidden="true">!</span>}
                    {brief?.name || `item ${id}`}
                  </span>
                )
              })()}
            </h4>
            <div
              className="rs-panel rs-equip-panel"
              style={{ width: EQUIP.width, height: panelHeight }}
            >
              {/* The grid keeps interface 387's own spacing; this wrapper
                  centres the block when the panel is taller than it. */}
              <div className="rs-equip-grid" style={{ height: EQUIP.contentHeight }}>
              {EQUIP.slots.map((slot) => {
                const id = look.equipment[slot.index] ?? -1
                // `undefined` = not looked up yet, so nothing is flagged until
                // its def has actually been read.
                const brief = items.get(id)
                const wrong = id >= 0 && brief !== undefined && brief?.wearPos !== slot.index
                return (
                  <button
                    key={slot.index}
                    type="button"
                    title={`${slot.label}${id >= 0 ? ` — ${brief?.name || `item ${id}`}` : ' — empty'}`}
                    className={`rs-slot rs-equip-slot${selectedSlot === slot.index ? ' is-selected' : ''}${wrong ? ' is-wrong' : ''}`}
                    style={{
                      left: EQUIP.width / 2 + slot.x - slot.size / 2,
                      top: slot.y,
                      width: slot.size,
                      height: slot.size,
                      ...(slotUrl ? { backgroundImage: `url(${slotUrl})` } : {}),
                    }}
                    onClick={() => setSelectedSlot(slot.index)}
                    onPointerEnter={() => setHoveredSlot(slot.index)}
                    onPointerLeave={() => setHoveredSlot((cur) => (cur === slot.index ? null : cur))}
                  >
                    {id >= 0 && <ItemIcon id={id} />}
                    {wrong && <span className="rs-equip-warn" aria-hidden="true">!</span>}
                  </button>
                )
              })}
              </div>
            </div>

            <div className="defaults-slot-editor">
              {selected ? (
                <>
                  <span className="defaults-row-label">{selected.label}</span>
                  <NumberInput
                    inputRef={slotInputRef}
                    className="cell-input defaults-num"
                    value={look.equipment[selected.index] ?? -1}
                    title={`Step to the next item that fits ${selected.label.toLowerCase()}`}
                    // ± walks ids until one fits this slot; typing stays free
                    // so a wrong id can be entered and flagged.
                    onStep={(current, direction) => void stepEquipment(selected.index, current, direction)}
                    onChange={(v) => edit((d) => { d.equipment[selected.index] = v })}
                  />
                  <button
                    type="button"
                    className="model-toolbar-btn"
                    onClick={() => edit((d) => { d.equipment[selected.index] = -1 })}
                  >
                    Clear
                  </button>
                  {stepping && <span className="defaults-item-name">searching…</span>}
                </>
              ) : (
                <span className="tone-note-body">Pick a slot to set an item. −1 is empty.</span>
              )}
            </div>
          </section>
          {/* --------------------------------------------------- preview */}
          <section className="defaults-pane defaults-preview-pane">
            <h4 className="defaults-pane-title">Preview</h4>
            <div className="rs-panel defaults-preview" style={{ height: panelHeight }}>
              {previewError
                ? <p className="anim-preview-status">{previewError}</p>
                : preview?.model
                  ? (
                    <ModelViewer
                      data={preview.model}
                      hideHeader
                      fitScale={1.75}
                      posedVertices={posedVertices}
                      poseBounds={poseBounds}
                      cameraStateRef={cameraRef}
                    />
                  )
                  : <p className="anim-preview-status">{preview ? 'Nothing renderable.' : 'Assembling…'}</p>}
            </div>
            {emote && (
              <p className="defaults-note defaults-emote-note">
                Render emote <strong>{emote.bas}</strong>
                {emote.source === 'unarmed' && ' (unarmed default)'}
                {emote.source === 'weapon' && emote.weaponId >= 0 && ` from weapon ${emote.weaponId}`}
                {standSeq != null && <> · stand animation <strong>{standSeq}</strong></>}
              </p>
            )}
          </section>
        </div>

        <div className="save-bar defaults-save-bar">
          <span className="save-bar-label">{dirty ? 'Unsaved changes' : 'Saved'}</span>
          <span className="save-bar-actions">
            <button type="button" className="save-bar-discard" onClick={handleReset}>Reset to stock</button>
            <button type="button" className="save-bar-discard" onClick={() => { setLooks(loadPlayerLooks()); setDirty(false) }}>Discard</button>
            <button type="button" className="save-bar-save" onClick={handleSave} disabled={!dirty}>Save</button>
          </span>
        </div>
        {browsePart != null && (
          <IdentikitPickerModal
            rootHandle={rootHandle}
            part={browsePart}
            female={female}
            colour={look.colour}
            currentId={look.look[browsePart]}
            slotUrl={slotUrl}
            slotSize={LOOK_SLOT_SIZE}
            onPick={(id) => edit((d) => { d.look[browsePart] = id })}
            onClose={() => setBrowsePart(null)}
          />
        )}
      </div>
    </dialog>
  )
}

/** Colour choice as number + swatch.
 *
 *  A native `<select>` can't do this: an `<option>` renders as plain text, so
 *  it can hold no swatch element, and tinting its text would tint the number
 *  with it. (Colouring the option's BACKGROUND does work in Chromium, which
 *  was the first attempt, but it's non-standard and reads as a wall of
 *  colour.) Hence a small custom dropdown. */
function ColourSelect({ value, choices, colourOf, onChange }: {
  value: number
  choices: number
  colourOf: (choice: number) => string
  onChange: (choice: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; flip: boolean } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    // Positioned FIXED off the button rather than absolutely inside the modal:
    // an absolute popup still counts toward the dialog's scroll extent, so
    // opening a long list gave the whole modal a scrollbar.
    const place = () => {
      const el = btnRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const flip = below < MAX_POP_HEIGHT && r.top > below
      setRect({
        left: r.left,
        top: flip ? r.top - 4 : r.bottom + 4,
        width: r.width,
        flip,
      })
    }
    place()
    // Long lists (torso has 229) open nowhere near the current pick otherwise.
    currentRef.current?.scrollIntoView({ block: 'center' })

    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey, true)
    // Capture: the modal body is the thing that scrolls, not the window.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  return (
    <div className="colour-select" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`colour-select-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="colour-select-num">{value}</span>
        <span className="colour-select-chip" style={{ background: colourOf(value) }} />
      </button>

      {open && rect && (
        <div
          className="colour-select-pop"
          style={{
            left: rect.left,
            width: rect.width,
            maxHeight: MAX_POP_HEIGHT,
            ...(rect.flip
              ? { bottom: window.innerHeight - rect.top }
              : { top: rect.top }),
          }}
        >
          {Array.from({ length: choices }, (_, n) => (
            <button
              key={n}
              type="button"
              ref={n === value ? currentRef : undefined}
              className={`colour-select-opt${n === value ? ' is-current' : ''}`}
              onClick={() => { onChange(n); setOpen(false) }}
            >
              <span className="colour-select-num">{n}</span>
              <span className="colour-select-chip" style={{ background: colourOf(n) }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One look slot: the tile, with that identikit rendered into it.
 *
 *  Deliberately a component per slot keyed on a single scalar id, mirroring
 *  `ModelSnapshotIcon` — a batched effect that carried the results map in its
 *  own dependency list re-ran on every unrelated state change and cancelled
 *  its own in-flight renders, so nothing ever landed. */
function LookSlotIcon({ cacheRoot, kitId, colour, slotUrl }: {
  cacheRoot: FileSystemDirectoryHandle | null
  kitId: number
  /** The look's colour choices, so the part previews in the colours a player
   *  would actually wear it in rather than its placeholder tones. */
  colour: number[]
  slotUrl?: string
}) {
  // Keyed by value, not identity: the parent rebuilds the array on every edit.
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
        width: LOOK_SLOT_SIZE,
        height: LOOK_SLOT_SIZE,
        ...(slotUrl ? { backgroundImage: `url(${slotUrl})` } : {}),
      }}
    >
      {url && (
        <img
          className="defaults-part-icon"
          style={{ width: LOOK_SLOT_SIZE - 2, height: LOOK_SLOT_SIZE - 2 }}
          src={url}
          alt=""
        />
      )}
    </span>
  )
}

/** The colour a group's choice produces, taken from its first source slot —
 *  the tone the whole group is named after. */
function swatchFor(palette: RecolorPalette, group: number, choice: number): string {
  const packed = palette.dst[group]?.[0]?.[choice]
  if (packed === undefined) return 'transparent'
  return `#${hslToRgb(packed & 0xffff).toString(16).padStart(6, '0')}`
}
