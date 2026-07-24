import { useState } from 'react'
import { MenuPreview } from './MenuPreview'

// NPC right-click menu rows: entry text white, target name yellow (0xFFFF00),
// level in the combat-based colour computed as though OUR combat level is
// 138 (maxed) — so most NPC levels read green
// (TextUtils.calculateCombatBasedColor).
//
// Members semantics per NPCType.kt: opcodes 150–154 (membersOptions) write
// into the SAME option slots — on a members world they take the slot over,
// and on a free world the slot is nulled entirely (even if opcode 30–34 also
// set it). The F2P/Members toggle mirrors exactly that.
const VIEWER_COMBAT_LEVEL = 138

// TextUtils.calculateCombatBasedColor(target, mine) as a <col=> tag.
function combatColorTag(targetLevel: number, myLevel: number): string {
  const diff = myLevel - targetLevel
  const rgb =
    diff < -9 ? 0xff0000 :
    diff < -6 ? 0xff3000 :
    diff < -3 ? 0xff7000 :
    diff < 0 ? 0xffb000 :
    diff > 9 ? 0x00ff00 :
    diff > 6 ? 0x40ff00 :
    diff > 3 ? 0x80ff00 :
    diff > 0 ? 0xc0ff00 :
    0xffff00
  return `<col=${rgb.toString(16).padStart(6, '0')}>`
}

export function NpcMenuPreview({ cacheRoot, name, combatLevel, options, membersOptions }: {
  cacheRoot: FileSystemDirectoryHandle | null
  name: string
  combatLevel: number
  options: (string | null)[]
  membersOptions: (string | null)[]
}) {
  const [members, setMembers] = useState(true)

  const slots = Array.from({ length: 5 }, (_, i) => {
    const membersOption = membersOptions[i] ?? null
    const baseOption = options[i] ?? null
    return members ? (membersOption ?? baseOption) : (membersOption != null ? null : baseOption)
  }).filter((option): option is string => option != null && option.length > 0)

  // Entry target text, composed like MiniMenuBuilder: yellow name, then the
  // combat colour takes over for " (level: N)" (only when the NPC has one).
  const target = `<col=ffff00>${name || 'null'}${combatLevel > 0
    ? `${combatColorTag(combatLevel, VIEWER_COMBAT_LEVEL)} (level: ${combatLevel})`
    : ''}`
  const rows = [
    ...slots.map((option) => `${option} ${target}`),
    'Walk here',
    `Examine ${target}`,
    'Cancel',
  ]

  if (!cacheRoot) return null
  return (
    <div className="npc-menu-preview">
      <span className="btn-pill">
        <button type="button" className={`zoom-btn${members ? '' : ' active'}`} onClick={() => setMembers(false)}>F2P</button>
        <button type="button" className={`zoom-btn${members ? ' active' : ''}`} onClick={() => setMembers(true)}>Members</button>
      </span>
      <MenuPreview cacheRoot={cacheRoot} rows={rows} />
    </div>
  )
}
