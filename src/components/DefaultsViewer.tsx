import { useEffect, useState } from 'react'
import type { DefaultsData, EntityDefaultsDef, EquipmentDefaultsDef } from '../loaders/defaults'
import { NumberInput, IntListInput, NumGrid, ToggleGrid  } from './defFields'
import type { NumFieldDef } from './defFields'
import { hslToHex } from './rsColor'
import './DefaultsViewer.css'

type Props = {
  data: DefaultsData
  onSave: (data: DefaultsData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const ENTITY_NUM_FIELDS: NumFieldDef[] = [
  ['maximumHits', 'Maximum Hits'],
  ['maxVisibleHitbars', 'Max Visible Hitbars'],
  ['maxHitbars', 'Max Hitbars'],
  ['defaultHitbarHeight', 'Default Hitbar Height'],
  ['profilingMesh', 'Profiling Mesh'],
  ['npcMessageDuration', 'NPC Message Duration'],
  ['playerMessageDuration', 'Player Message Duration'],
  ['gameWidthDefault', 'Game Width Default'],
  ['gameHeightDefault', 'Game Height Default'],
  ['loginInterfaceId', 'Login Interface ID'],
  ['lobbyWindow', 'Lobby Window'],
]

const ENTITY_FLAG_FIELDS: NumFieldDef[] = [
  ['alwaysShowContextMenu', 'Always Show Context Menu'],
  ['npcMessagesEnabled', 'NPC Messages Enabled'],
  ['enablePlayerMessages', 'Player Messages Enabled'],
]

const EQUIP_NUM_FIELDS: NumFieldDef[] = [
  ['shieldSlot', 'Shield Slot'],
  ['weaponSlot', 'Weapon Slot'],
]

export default function DefaultsViewer({ data, onSave, onDirtyChange }: Props) {
  const [draft, setDraft] = useState(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  function set(key: string, value: unknown) {
    setDraft((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
    setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    setIsSaving(false)
    setIsDirty(false)
  }

  const values = draft as Record<string, unknown>

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Defaults — {data.name === 'entity' ? 'Entity' : 'Equipment'}</span>
        </div>
      </div>

      {data.name === 'entity' ? (
        <EntityBody def={draft as EntityDefaultsDef} values={values} set={set} />
      ) : (
        <EquipmentBody def={draft as EquipmentDefaultsDef} values={values} set={set} />
      )}

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

type BodyProps = {
  values: Record<string, unknown>
  set: (key: string, value: unknown) => void
}

function EntityBody({ def, values, set }: BodyProps & { def: EntityDefaultsDef }) {
  return (
    <>
      <section className="item-section">
        <h3>General</h3>
        <NumGrid fields={ENTITY_NUM_FIELDS} values={values} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Flags</h3>
        <ToggleGrid fields={ENTITY_FLAG_FIELDS} values={values} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Hit Offsets</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Offsets X</span>
          <IntListInput value={def.hitOffsetsX} onChange={(v) => set('hitOffsetsX', v)} />
        </div>
        <div className="object-int-list-row">
          <span className="item-field-label">Offsets Y</span>
          <IntListInput value={def.hitOffsetsY} onChange={(v) => set('hitOffsetsY', v)} />
        </div>
      </section>

      {def.recolorPaletteSrc && (
        <section className="item-section">
          <h3>Recolor Palette</h3>
          <p className="huffman-visual-hint">
            The player character-customization colours: {def.recolorPaletteSrc.length} groups, each with up to 4 source
            colours and a list of allowed destination colours per source. Values are packed HSL shorts (-1 = none).
          </p>
          <RecolorPalette
            src={def.recolorPaletteSrc}
            dst={def.recolorPaletteDst ?? []}
            onChange={(nextSrc, nextDst) => {
              set('recolorPaletteSrc', nextSrc)
              set('recolorPaletteDst', nextDst)
            }}
          />
        </section>
      )}
    </>
  )
}

function Swatch({ hsl }: { hsl: number }) {
  const hex = hslToHex(hsl)
  return (
    <span
      className={`recolor-swatch${hex ? '' : ' recolor-swatch-none'}`}
      title={hsl === -1 ? 'none (-1)' : `${hsl} → ${hex}`}
      style={hex ? { background: hex } : undefined}
    />
  )
}

function RecolorPalette({ src, dst, onChange }: {
  src: number[][]
  dst: number[][][]
  onChange: (src: number[][], dst: number[][][]) => void
}) {
  function setSrc(group: number, slot: number, value: number) {
    const next = src.map((row, g) => (g === group ? row.map((v, s) => (s === slot ? value : v)) : row))
    onChange(next, dst)
  }

  function setDst(group: number, slot: number, values: number[] | undefined) {
    const next = dst.map((row, g) =>
      g === group ? row.map((v, s) => (s === slot ? (values ?? []) : v)) : row,
    )
    onChange(src, next)
  }

  return (
    <div className="recolor-groups">
      {src.map((slots, group) => (
        <details key={group} className="recolor-group" open={group === 0}>
          <summary>Group {group}</summary>
          <div className="recolor-slots">
            {slots.map((sourceHsl, slot) => {
              const dstList = dst[group]?.[slot] ?? []
              return (
                <div key={slot} className="recolor-slot">
                  <div className="recolor-slot-src">
                    <span className="item-field-label">Src {slot}</span>
                    <Swatch hsl={sourceHsl} />
                    <NumberInput className="cell-input recolor-src-input" value={sourceHsl} onChange={(v) => setSrc(group, slot,v)} />
                  </div>
                  <span className="recolor-arrow">→</span>
                  <div className="recolor-slot-dst">
                    <IntListInput
                      value={dstList}
                      onChange={(v) => setDst(group, slot, v)}
                      placeholder="destination HSL colours, comma-separated"
                    />
                    <div className="recolor-swatch-strip">
                      {dstList.map((hsl, i) => <Swatch key={i} hsl={hsl} />)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </details>
      ))}
    </div>
  )
}

function EquipmentBody({ def, values, set }: BodyProps & { def: EquipmentDefaultsDef }) {
  return (
    <>
      <section className="item-section">
        <h3>Slots</h3>
        <NumGrid fields={EQUIP_NUM_FIELDS} values={values} onChange={(k, v) => set(k, v)} />
      </section>

      <section className="item-section">
        <h3>Customizable Obj Slots</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Per-slot flags</span>
          <IntListInput value={def.customizableObjSlots} onChange={(v) => set('customizableObjSlots', v)} />
        </div>
      </section>

      <section className="item-section">
        <h3>Hidden Animation Slots</h3>
        <div className="object-int-list-row">
          <span className="item-field-label">Shield Slots</span>
          <IntListInput value={def.hiddenAnimationShieldSlots} onChange={(v) => set('hiddenAnimationShieldSlots', v)} />
        </div>
        <div className="object-int-list-row">
          <span className="item-field-label">Weapon Slots</span>
          <IntListInput value={def.hiddenAnimationWeaponSlots} onChange={(v) => set('hiddenAnimationWeaponSlots', v)} />
        </div>
      </section>
    </>
  )
}
