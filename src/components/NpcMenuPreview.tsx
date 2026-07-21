import { useEffect, useRef, useState } from 'react'
import { drawCacheText, loadCacheFont, measureCacheText } from './interfacePreview'
import type { CacheFont } from './interfacePreview'

// Right-click context menu preview, drawn to match darkan's
// MiniMenu.renderOpenMenuSimple + AbstractToolkit.drawOutlinedFilledOpaqueRectangle:
// the whole box fills 0x5D5447 brown, a black 16px title strip sits at the
// top with "Choose Option" rendered in that same brown, the entry area below
// gets a black outline, and rows are 16px (entryRowHeight) using the real
// b12_full sprite font (the minimenuHeader font, FontManager.kt). Entry text
// is white with the target name in yellow (0xFFFF00) and the level in the
// combat-based colour, computed as though OUR combat level is 138 (maxed) —
// so most NPC levels read green (TextUtils.calculateCombatBasedColor).
//
// Members semantics per NPCType.kt: opcodes 150–154 (membersOptions) write
// into the SAME option slots — on a members world they take the slot over,
// and on a free world the slot is nulled entirely (even if opcode 30–34 also
// set it). The F2P/Members toggle mirrors exactly that.
const MENU_BROWN = '#5d5447'
const MENU_BROWN_RGB = 0x5d5447
const ROW_H = 16
/** b12_full — resolved by name hash at runtime in the client; rev-727 id. */
const MENU_FONT_ID = 496
const VIEWER_COMBAT_LEVEL = 138
const SCALE = 2

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
  const [font, setFont] = useState<CacheFont | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    if (!cacheRoot) return
    loadCacheFont(cacheRoot, MENU_FONT_ID).then((f) => { if (!cancelled) setFont(f) })
    return () => { cancelled = true }
  }, [cacheRoot])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !font) return

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

    const title = 'Choose Option'
    let maxWidth = measureCacheText(font, title)
    for (const row of rows) {
      const width = measureCacheText(font, row)
      if (width > maxWidth) maxWidth = width
    }
    const w = maxWidth + 8
    const h = 22 + rows.length * ROW_H
    canvas.width = w * SCALE
    canvas.height = h * SCALE
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    ctx.imageSmoothingEnabled = false

    // chrome (AbstractToolkit.drawOutlinedFilledOpaqueRectangle)
    ctx.fillStyle = MENU_BROWN
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#000000'
    ctx.fillRect(1, 1, w - 2, 16)
    ctx.strokeStyle = '#000000'
    ctx.strokeRect(1.5, 18.5, w - 3, h - 20)

    // title in the menu brown on the black strip, no shadow (renderPlain
    // is called with the fill colour and shadow −1)
    drawCacheText(ctx, font, MENU_FONT_ID, title, 3, 14, MENU_BROWN_RGB, false)

    rows.forEach((row, i) => {
      drawCacheText(ctx, font, MENU_FONT_ID, row, 3, 31 + i * ROW_H, 0xffffff, true)
    })
  }, [font, name, combatLevel, options, membersOptions, members])

  if (!cacheRoot) return null
  return (
    <div className="npc-menu-preview">
      <span className="btn-pill">
        <button type="button" className={`zoom-btn${members ? '' : ' active'}`} onClick={() => setMembers(false)}>F2P</button>
        <button type="button" className={`zoom-btn${members ? ' active' : ''}`} onClick={() => setMembers(true)}>Members</button>
      </span>
      <canvas ref={canvasRef} />
    </div>
  )
}
