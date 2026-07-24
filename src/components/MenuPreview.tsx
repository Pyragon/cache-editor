import { useEffect, useRef, useState } from 'react'
import { drawCacheText, loadCacheFont, measureCacheText } from './interfacePreview'
import type { CacheFont } from './interfacePreview'

// The right-click context menu, drawn to match darkan's
// MiniMenu.renderOpenMenuSimple + AbstractToolkit.drawOutlinedFilledOpaqueRectangle:
// the whole box fills 0x5D5447 brown, a black 16px title strip sits at the
// top with "Choose Option" rendered in that same brown, the entry area below
// gets a black outline, and rows are 16px (entryRowHeight) using the real
// b12_full sprite font (the minimenuHeader font, FontManager.kt). Rows are
// col-tagged strings composed by the caller (yellow NPC names, cyan object
// names, combat-coloured levels…).
const MENU_BROWN = '#5d5447'
const MENU_BROWN_RGB = 0x5d5447
const ROW_H = 16
/** b12_full — resolved by name hash at runtime in the client; rev-727 id. */
const MENU_FONT_ID = 496
const SCALE = 2

export function MenuPreview({ cacheRoot, rows }: {
  cacheRoot: FileSystemDirectoryHandle | null
  rows: string[]
}) {
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
  }, [font, rows])

  if (!cacheRoot) return null
  return <canvas ref={canvasRef} />
}
