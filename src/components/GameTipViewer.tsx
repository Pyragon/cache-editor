import { useEffect, useRef, useState } from 'react'
import type { GameTipData, GameTipDef, Stage, StageUpdate, TipComponent } from '../loaders/game_tips'
import { NumberInput } from './defFields'
import { loadSpriteMeta, renderFrameToCanvas } from './spriteRender'
import { drawCacheText, loadCacheFont, measureCacheText } from './fontRender'
import type { CacheFont } from './fontRender'
import './GameTipViewer.css'

// Component type ordinals match darkan TipRenderDetails (the cache byte).
const COMPONENT_TYPES = [
  'BACKGROUND', 'COLOR_LOADING_BAR', 'SPRITE_LOADING_BAR', 'MULTI_SPRITE_LOADING_BAR',
  'OUTLINED', 'SPRITE', 'ROTATED_SPRITE', 'ANCHORED_TEXT', 'TIPS_SPRITE', 'ANIMATED_LOADING_BAR',
]
const ANCHOR_X = ['LEFT', 'CENTER', 'RIGHT']
const ANCHOR_Y = ['TOP', 'CENTER', 'BOTTOM']

// The classic fixed-size client viewport the 727 loading screens target.
const PREVIEW_W = 765
const PREVIEW_H = 503

type FieldKind = 'int' | 'text' | 'color' | 'anchorX' | 'anchorY' | 'bool' | 'sprite'
type FieldDef = [key: keyof TipComponent & string, label: string, kind: FieldKind]

const ANCHOR_FIELDS: FieldDef[] = [
  ['anchorX', 'Anchor X', 'anchorX'],
  ['anchorY', 'Anchor Y', 'anchorY'],
  ['offsetX', 'Offset X', 'int'],
  ['offsetY', 'Offset Y', 'int'],
]
const BAR_BASE_FIELDS: FieldDef[] = [
  ...ANCHOR_FIELDS,
  ['width', 'Width', 'int'],
  ['height', 'Height', 'int'],
  ['textOffsetY', 'Text Offset Y', 'int'],
  ['fileId', 'Font ID', 'int'],
  ['textColor', 'Text Colour', 'color'],
]
const MULTI_SPRITE_FIELDS: FieldDef[] = [
  ['spriteA', 'Sprite A', 'sprite'],
  ['spriteB', 'Sprite B', 'sprite'],
  ['spriteC', 'Sprite C', 'sprite'],
  ['spriteD', 'Sprite D', 'sprite'],
  ['spriteE', 'Sprite E', 'sprite'],
  ['spriteF', 'Sprite F', 'sprite'],
]

const TYPE_FIELDS: Record<string, FieldDef[]> = {
  BACKGROUND: [['color', 'Colour', 'color']],
  COLOR_LOADING_BAR: [...BAR_BASE_FIELDS, ['fillColor', 'Fill Colour', 'color'], ['outlineColor', 'Outline Colour', 'color']],
  SPRITE_LOADING_BAR: [...BAR_BASE_FIELDS, ['unknownInt', 'Unknown Int', 'int'], ['backgroundColor', 'Background Colour', 'color'], ['spriteFileId', 'Sprite ID', 'sprite']],
  MULTI_SPRITE_LOADING_BAR: [...BAR_BASE_FIELDS, ...MULTI_SPRITE_FIELDS],
  OUTLINED: [
    ['newsitemId', 'News Item ID', 'int'], ...ANCHOR_FIELDS,
    ['width', 'Width', 'int'], ['height', 'Height', 'int'],
    ['textColor', 'Text Colour', 'color'], ['shadeColor', 'Shade Colour', 'color'],
    ['backgroundColor', 'Background Colour', 'color'], ['drawOutline', 'Draw Outline', 'bool'],
  ],
  SPRITE: [['spriteId', 'Sprite ID', 'sprite'], ...ANCHOR_FIELDS],
  ROTATED_SPRITE: [['spriteId', 'Sprite ID', 'sprite'], ...ANCHOR_FIELDS, ['angle', 'Angle', 'int']],
  ANCHORED_TEXT: [
    ['tipText', 'Text', 'text'], ...ANCHOR_FIELDS,
    ['textAlignment', 'H Align (0-2)', 'int'], ['textVerticalAlignment', 'V Align (0-2)', 'int'],
    ['lineSpacing', 'Line Spacing', 'int'], ['width', 'Width', 'int'], ['height', 'Height', 'int'],
    ['fileId', 'Font ID', 'int'], ['textColor', 'Text Colour', 'color'], ['textShadowColor', 'Shadow Colour', 'color'],
  ],
  TIPS_SPRITE: [['spriteFileId', 'Sprite ID', 'sprite']],
  ANIMATED_LOADING_BAR: [...BAR_BASE_FIELDS, ...MULTI_SPRITE_FIELDS, ['scrollSpeed', 'Scroll Speed', 'int']],
}

const NEW_COMPONENT_DEFAULTS: Record<string, TipComponent> = {
  BACKGROUND: { type: 'BACKGROUND', color: -16777216 },
  COLOR_LOADING_BAR: { type: 'COLOR_LOADING_BAR', anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, width: 200, height: 18, textOffsetY: -15, fileId: -1, textColor: -1, fillColor: -8388608, outlineColor: -1 },
  SPRITE_LOADING_BAR: { type: 'SPRITE_LOADING_BAR', anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, width: 200, height: 18, textOffsetY: -15, fileId: -1, textColor: -1, unknownInt: 0, backgroundColor: -16777216, spriteFileId: -1 },
  MULTI_SPRITE_LOADING_BAR: { type: 'MULTI_SPRITE_LOADING_BAR', anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, width: 200, height: 18, textOffsetY: -15, fileId: -1, textColor: -1, spriteA: -1, spriteB: -1, spriteC: -1, spriteD: -1, spriteE: -1, spriteF: -1 },
  OUTLINED: { type: 'OUTLINED', newsitemId: 0, anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, width: 300, height: 100, textColor: -1, shadeColor: -16777216, backgroundColor: -16777216, drawOutline: true },
  SPRITE: { type: 'SPRITE', spriteId: 0, anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0 },
  ROTATED_SPRITE: { type: 'ROTATED_SPRITE', spriteId: 0, anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, angle: 0 },
  ANCHORED_TEXT: { type: 'ANCHORED_TEXT', tipText: 'New tip text', anchorX: 'CENTER', anchorY: 'CENTER', offsetX: 0, offsetY: 0, textAlignment: 1, textVerticalAlignment: 1, lineSpacing: 19, width: 290, height: 100, fileId: 3794, textColor: -13421773, textShadowColor: 0 },
  TIPS_SPRITE: { type: 'TIPS_SPRITE', spriteFileId: 0 },
  ANIMATED_LOADING_BAR: { type: 'ANIMATED_LOADING_BAR', anchorX: 'CENTER', anchorY: 'TOP', offsetX: 0, offsetY: 43, width: 200, height: 18, textOffsetY: -15, fileId: 3793, textColor: -725783, spriteA: 3762, spriteB: 3777, spriteC: 3773, spriteD: 3774, spriteE: 3776, spriteF: 3775, scrollSpeed: 6 },
}

// ARGB int (often negative) → css colour. Zero alpha in this data means
// "opaque" (e.g. shadow colour 0 = disabled, handled by callers).
function argbToCss(argb: number): string {
  const a = (argb >>> 24) & 0xff
  const r = (argb >>> 16) & 0xff
  const g = (argb >>> 8) & 0xff
  const b = argb & 0xff
  return `rgba(${r}, ${g}, ${b}, ${a === 0 ? 1 : a / 255})`
}

function anchorPos(anchor: string | undefined, names: string[], size: number, span: number): number {
  const idx = Math.max(0, names.indexOf(anchor ?? names[0]))
  if (idx === 0) return 0
  if (idx === 2) return span - size
  return Math.floor((span - size) / 2)
}

function wrapText(font: CacheFont | null, ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  const widthOf = (s: string) => (font ? measureCacheText(font, s) : ctx.measureText(s).width)
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (widthOf(next) > maxWidth && line !== '') {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

// Draws a tip scene onto ctx (which may be scaled for thumbnails).
function drawScene(
  ctx: CanvasRenderingContext2D,
  comps: TipComponent[],
  res: Resources | null,
  progress: number,
  now: number,
) {
  for (const c of comps) {
      switch (c.type) {
        case 'BACKGROUND': {
          ctx.fillStyle = argbToCss(c.color ?? 0)
          ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)
          break
        }
        case 'SPRITE':
        case 'ROTATED_SPRITE': {
          const sprite = c.spriteId != null ? res?.sprites.get(c.spriteId) : undefined
          const w = sprite?.width ?? 16
          const h = sprite?.height ?? 16
          const x = anchorPos(c.anchorX, ANCHOR_X, w, PREVIEW_W) + (c.offsetX ?? 0)
          const y = anchorPos(c.anchorY, ANCHOR_Y, h, PREVIEW_H) + (c.offsetY ?? 0)
          if (!sprite) {
            ctx.strokeStyle = '#555'
            ctx.strokeRect(x, y, w, h)
            break
          }
          if (c.type === 'ROTATED_SPRITE' && (c.angle ?? 0) !== 0) {
            ctx.save()
            ctx.translate(x + w / 2, y + h / 2)
            // Angle is in 2048ths of a circle (RS convention); approximate.
            ctx.rotate(((c.angle ?? 0) * Math.PI * 2) / 2048)
            ctx.drawImage(sprite, -w / 2, -h / 2)
            ctx.restore()
          } else {
            ctx.drawImage(sprite, x, y)
          }
          break
        }
        case 'TIPS_SPRITE': {
          const sprite = c.spriteFileId != null ? res?.sprites.get(c.spriteFileId) : undefined
          if (sprite) {
            ctx.drawImage(sprite, (PREVIEW_W - sprite.width) / 2, (PREVIEW_H - sprite.height) / 2)
          }
          break
        }
        case 'OUTLINED': {
          const w = c.width ?? 0
          const h = c.height ?? 0
          const x = anchorPos(c.anchorX, ANCHOR_X, w, PREVIEW_W) + (c.offsetX ?? 0)
          const y = anchorPos(c.anchorY, ANCHOR_Y, h, PREVIEW_H) + (c.offsetY ?? 0)
          ctx.fillStyle = argbToCss(c.backgroundColor ?? 0)
          ctx.fillRect(x, y, w, h)
          if (c.drawOutline) {
            ctx.strokeStyle = argbToCss(c.textColor ?? -1)
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
          }
          break
        }
        case 'ANCHORED_TEXT': {
          const w = c.width ?? 0
          const h = c.height ?? 0
          const x = anchorPos(c.anchorX, ANCHOR_X, w, PREVIEW_W) + (c.offsetX ?? 0)
          const y = anchorPos(c.anchorY, ANCHOR_Y, h, PREVIEW_H) + (c.offsetY ?? 0)
          const font = c.fileId != null ? res?.fonts.get(c.fileId) ?? null : null
          ctx.font = '13px sans-serif'
          const lines = wrapText(font, ctx, c.tipText ?? '', w)
          const lineHeight = c.lineSpacing || 16
          const blockH = lines.length * lineHeight
          const vAlign = c.textVerticalAlignment ?? 0
          let lineY = y + (vAlign === 2 ? h - blockH : vAlign === 1 ? (h - blockH) / 2 : 0)
          for (const line of lines) {
            const lineW = font ? measureCacheText(font, line) : ctx.measureText(line).width
            const hAlign = c.textAlignment ?? 0
            const lineX = x + (hAlign === 2 ? w - lineW : hAlign === 1 ? (w - lineW) / 2 : 0)
            if (font) {
              if ((c.textShadowColor ?? 0) !== 0) {
                drawCacheText(ctx, font, line, lineX + 1, lineY + 1, argbToCss(c.textShadowColor!))
              }
              drawCacheText(ctx, font, line, lineX, lineY, argbToCss(c.textColor ?? -1))
            } else {
              ctx.fillStyle = argbToCss(c.textColor ?? -1)
              ctx.textBaseline = 'top'
              ctx.fillText(line, lineX, lineY)
            }
            lineY += lineHeight
          }
          break
        }
        case 'COLOR_LOADING_BAR':
        case 'SPRITE_LOADING_BAR':
        case 'MULTI_SPRITE_LOADING_BAR':
        case 'ANIMATED_LOADING_BAR': {
          const w = c.width ?? 0
          const h = c.height ?? 0
          const x = anchorPos(c.anchorX, ANCHOR_X, w, PREVIEW_W) + (c.offsetX ?? 0)
          const y = anchorPos(c.anchorY, ANCHOR_Y, h, PREVIEW_H) + (c.offsetY ?? 0)
          const multi = c.type === 'MULTI_SPRITE_LOADING_BAR' || c.type === 'ANIMATED_LOADING_BAR'
          const capL = multi && c.spriteC != null ? res?.sprites.get(c.spriteC) : undefined
          const capR = multi && c.spriteD != null ? res?.sprites.get(c.spriteD) : undefined
          const stripT = multi && c.spriteE != null ? res?.sprites.get(c.spriteE) : undefined
          const stripB = multi && c.spriteF != null ? res?.sprites.get(c.spriteF) : undefined
          const fill = multi && c.spriteA != null ? res?.sprites.get(c.spriteA) : undefined
          const empty = multi && c.spriteB != null ? res?.sprites.get(c.spriteB) : undefined

          if (multi && capL && capR && stripT && stripB && fill && empty) {
            // Faithful assembly (client Class52_Sub2): caps at the ends
            // (v-centred), top/bottom strips stretched between them, sprite A
            // stretched over the inner region clipped to progress (the
            // animated variant slides it by scrollSpeed·t/10 % width), and
            // sprite B stretched over the unfilled remainder.
            ctx.drawImage(capL, x, y + Math.floor((h - capL.height) / 2))
            ctx.drawImage(capR, x + w - capR.width, y + Math.floor((h - capR.height) / 2))
            const innerX = x + capL.width
            const innerW = w - capL.width - capR.width
            ctx.drawImage(stripT, innerX, y, innerW, stripT.height)
            ctx.drawImage(stripB, innerX, y + h - stripB.height, innerW, stripB.height)

            const fillY = y + stripT.height
            const fillH = h - stripT.height - stripB.height
            const fillW = Math.floor(innerW * progress)

            ctx.save()
            ctx.beginPath()
            ctx.rect(innerX, fillY, fillW, fillH)
            ctx.clip()
            if (c.type === 'ANIMATED_LOADING_BAR') {
              const scroll = Math.floor(((c.scrollSpeed ?? 0) * now) / 10) % fill.width
              ctx.drawImage(fill, innerX - fill.width + scroll, fillY, innerW + fill.width - scroll, fillH)
            } else {
              ctx.drawImage(fill, innerX, fillY, innerW, fillH)
            }
            ctx.restore()

            ctx.save()
            ctx.beginPath()
            ctx.rect(innerX + fillW, fillY, innerW - fillW, fillH)
            ctx.clip()
            ctx.drawImage(empty, innerX, fillY, innerW, fillH)
            ctx.restore()
          } else {
            // Approximate bar (colour variant, or sprites missing from the
            // dump): dark trough, fill, outline.
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'
            ctx.fillRect(x, y, w, h)
            ctx.fillStyle = c.type === 'COLOR_LOADING_BAR' ? argbToCss(c.fillColor ?? -8388608) : '#8b1a1a'
            ctx.fillRect(x + 1, y + 1, Math.floor((w - 2) * progress), h - 2)
            ctx.strokeStyle = c.type === 'COLOR_LOADING_BAR' ? argbToCss(c.outlineColor ?? -1) : '#c0a060'
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
          }

          const font = c.fileId != null ? res?.fonts.get(c.fileId) ?? null : null
          const label = `Loading - ${Math.floor(progress * 100)}%`
          // Client (Class52.method14): centred at x + width/2, drawn at
          // y + height/2 + 4 + textOffsetY — and the renderer's y is the
          // BOTTOM of the line (method371 subtracts verticalSpacing), while
          // drawCacheText takes the top.
          const lineBottom = y + Math.floor(h / 2) + 4 + (c.textOffsetY ?? 0)
          if (font) {
            const lw = measureCacheText(font, label)
            const vs = font.metrics.verticalSpacing || 12
            drawCacheText(ctx, font, label, x + Math.floor(w / 2) - Math.floor(lw / 2), lineBottom - vs, argbToCss(c.textColor ?? -1))
          } else {
            ctx.font = '13px sans-serif'
            ctx.fillStyle = argbToCss(c.textColor ?? -1)
            ctx.textBaseline = 'alphabetic'
            const lw = ctx.measureText(label).width
            ctx.fillText(label, x + Math.floor(w / 2) - Math.floor(lw / 2), lineBottom)
          }
          break
        }
    }
  }
}

type Resources = {
  sprites: Map<number, HTMLCanvasElement>
  fonts: Map<number, CacheFont>
}

function collectSpriteIds(components: TipComponent[]): number[] {
  const ids = new Set<number>()
  for (const c of components) {
    for (const key of ['spriteId', 'spriteFileId', 'spriteA', 'spriteB', 'spriteC', 'spriteD', 'spriteE', 'spriteF'] as const) {
      const v = c[key]
      if (typeof v === 'number' && v >= 0) ids.add(v)
    }
  }
  return [...ids]
}

function collectFontIds(components: TipComponent[]): number[] {
  const ids = new Set<number>()
  for (const c of components) {
    if (typeof c.fileId === 'number' && c.fileId >= 0) ids.add(c.fileId)
  }
  return [...ids]
}

async function loadResources(
  components: TipComponent[],
  spritesDir: FileSystemDirectoryHandle | null,
  rootHandle: FileSystemDirectoryHandle | null,
): Promise<Resources> {
  const sprites = new Map<number, HTMLCanvasElement>()
  const fonts = new Map<number, CacheFont>()
  if (spritesDir) {
    await Promise.all(collectSpriteIds(components).map(async (id) => {
      const meta = await loadSpriteMeta(spritesDir, id)
      if (!meta) return
      const canvas = renderFrameToCanvas(meta)
      if (canvas) sprites.set(id, canvas)
    }))
  }
  if (rootHandle) {
    await Promise.all(collectFontIds(components).map(async (id) => {
      const font = await loadCacheFont(rootHandle, id)
      if (font) fonts.set(id, font)
    }))
  }
  return { sprites, fonts }
}

// Mini renders of tip scenes for the stage-table timeline — one per tip id
// per session (a tip save drops its own entry).
const thumbCache = new Map<number, Promise<HTMLCanvasElement | null>>()
const THUMB_W = 153
const THUMB_H = 101

function getTipThumb(
  dir: FileSystemDirectoryHandle,
  spritesDir: FileSystemDirectoryHandle | null,
  rootHandle: FileSystemDirectoryHandle | null,
  tipId: number,
): Promise<HTMLCanvasElement | null> {
  let promise = thumbCache.get(tipId)
  if (!promise) {
    promise = (async () => {
      try {
        const file = await (await dir.getFileHandle(`${tipId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as GameTipDef
        const comps = def.components ?? []
        const res = await loadResources(comps, spritesDir, rootHandle)
        const canvas = document.createElement('canvas')
        canvas.width = THUMB_W
        canvas.height = THUMB_H
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, THUMB_W, THUMB_H)
        ctx.scale(THUMB_W / PREVIEW_W, THUMB_H / PREVIEW_H)
        drawScene(ctx, comps, res, 0.62, 4960)
        return canvas
      } catch {
        return null
      }
    })()
    thumbCache.set(tipId, promise)
  }
  return promise
}

function TipThumb({ data, tipId }: { data: GameTipData; tipId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (!data.dir) return
    getTipThumb(data.dir, data.spritesDir, data.rootHandle, tipId).then((canvas) => {
      if (!cancelled && canvas) setUrl(canvas.toDataURL())
    })
    return () => { cancelled = true }
  }, [data, tipId])
  if (!url) return <span className="tip-thumb tip-thumb-empty">{tipId}</span>
  return <img className="tip-thumb" src={url} alt="" />
}

function fmtMs(ms: number): string {
  if (ms === 0) return '0'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
}

const SEG_COLORS = ['#7eb8ff', '#d9a441', '#7fd98f', '#d97fb8', '#8fd9d3', '#b7a1ff']

// The 727 table is one circular playlist baked as pre-rotated copies: every
// stage holds the same cycle starting one tip later, always led by the same
// instant "skeleton" entry (tip 2, display 0). Derive that model so the
// editor can present ONE master cycle and regenerate all stages from it.
type RotationModel = {
  intro: StageUpdate | null      // common first entry across all stages
  cycle: StageUpdate[]           // the rotation, in stage-0 order
  offsets: number[]              // each defined stage's current start index
  uniform: boolean               // false if some stage isn't a rotation of the cycle
}

function sameUpdate(a: StageUpdate, b: StageUpdate): boolean {
  return a.tipFileId === b.tipFileId
    && a.displayDurationMs === b.displayDurationMs
    && a.timeBetweenUpdatesMs === b.timeBetweenUpdatesMs
}

function rotateCycle(cycle: StageUpdate[], offset: number): StageUpdate[] {
  if (cycle.length === 0) return []
  const at = ((offset % cycle.length) + cycle.length) % cycle.length
  return [...cycle.slice(at), ...cycle.slice(0, at)].map((u) => ({ ...u }))
}

function deriveRotationModel(stages: Stage[]): RotationModel {
  if (stages.length === 0) return { intro: null, cycle: [], offsets: [], uniform: true }
  const first = stages[0].updates
  // Intro: a shared identical first entry on every stage.
  const introCandidate = first[0]
  const hasIntro = introCandidate != null
    && stages.every((st) => st.updates[0] != null && sameUpdate(st.updates[0], introCandidate))
  const intro = hasIntro ? { ...introCandidate } : null
  const introLen = hasIntro ? 1 : 0
  const cycle = first.slice(introLen).map((u) => ({ ...u }))

  let uniform = true
  const offsets = stages.map((st, si) => {
    const body = st.updates.slice(introLen)
    if (cycle.length === 0) return 0
    const offset = cycle.findIndex((u) => body[0] != null && u.tipFileId === body[0].tipFileId)
    if (offset === -1 || body.length !== cycle.length) {
      uniform = false
      return si % cycle.length
    }
    const expected = rotateCycle(cycle, offset)
    if (!body.every((u, i) => sameUpdate(u, expected[i]))) uniform = false
    return offset
  })
  return { intro, cycle, offsets, uniform }
}

// Full-size scene data for the stage-table simulation (thumbs are too small
// to reuse). Cached per tip per session, dropped when that tip is saved.
const sceneCache = new Map<number, Promise<{ comps: TipComponent[]; res: Resources } | null>>()

function getTipScene(
  dir: FileSystemDirectoryHandle,
  spritesDir: FileSystemDirectoryHandle | null,
  rootHandle: FileSystemDirectoryHandle | null,
  tipId: number,
): Promise<{ comps: TipComponent[]; res: Resources } | null> {
  let promise = sceneCache.get(tipId)
  if (!promise) {
    promise = (async () => {
      try {
        const file = await (await dir.getFileHandle(`${tipId}.json`)).getFile()
        const def = JSON.parse(await file.text()) as GameTipDef
        const comps = def.components ?? []
        const res = await loadResources(comps, spritesDir, rootHandle)
        return { comps, res }
      } catch {
        return null
      }
    })()
    sceneCache.set(tipId, promise)
  }
  return promise
}

// How long one playlist entry stays on screen: its display time, or (for the
// instant intro entry, display 0) its poll delay.
function slotMs(u: StageUpdate): number {
  return u.displayDurationMs > 0 ? u.displayDurationMs : Math.max(u.timeBetweenUpdatesMs, 250)
}

// Simulates the in-game loading screen: the intro plays once, then the cycle
// repeats with each tip's real timing, while the loading bar fills over the
// chosen simulated load time.
function StageSimPreview({ data, intro, cycle, loadSeconds, simKey }: {
  data: GameTipData
  intro: StageUpdate | null
  cycle: StageUpdate[]
  loadSeconds: number
  simKey: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scenesRef = useRef(new Map<number, { comps: TipComponent[]; res: Resources }>())
  // Key effects on CONTENT, not array identity — the parent re-derives the
  // model every render, and the sim clock shouldn't reset on unrelated edits.
  const timelineKey = JSON.stringify([intro, cycle])

  // Preload every referenced scene (cached across selections/sessions).
  useEffect(() => {
    let cancelled = false
    if (!data.dir) return
    const ids = new Set<number>()
    if (intro) ids.add(intro.tipFileId)
    for (const u of cycle) ids.add(u.tipFileId)
    for (const id of ids) {
      getTipScene(data.dir, data.spritesDir, data.rootHandle, id).then((scene) => {
        if (!cancelled && scene) scenesRef.current.set(id, scene)
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, timelineKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const start = performance.now()
    const loadMs = Math.max(loadSeconds, 1) * 1000

    const introMs = intro ? slotMs(intro) : 0
    const slots = cycle.map(slotMs)
    const cycleMs = slots.reduce((a, b) => a + b, 0)

    // Offscreen buffers for the client's crossfade: it renders the outgoing
    // component to a framebuffer and composites it at 255 − t·255/delay alpha
    // under the incoming one (AssetLoadingScreenRenderer).
    const offA = document.createElement('canvas')
    offA.width = PREVIEW_W; offA.height = PREVIEW_H
    const offB = document.createElement('canvas')
    offB.width = PREVIEW_W; offB.height = PREVIEW_H

    const renderTo = (off: HTMLCanvasElement, entry: StageUpdate | null, progress: number, now: number) => {
      const octx = off.getContext('2d')!
      octx.fillStyle = '#000'
      octx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)
      const scene = entry ? scenesRef.current.get(entry.tipFileId) : undefined
      if (scene) {
        drawScene(octx, scene.comps, scene.res, progress, now)
      } else if (entry) {
        octx.fillStyle = '#888'
        octx.font = '14px sans-serif'
        octx.fillText(`loading tip ${entry.tipFileId}…`, 20, 30)
      }
      return off
    }

    let raf = 0
    function draw(now: number) {
      raf = requestAnimationFrame(draw)
      const elapsed = now - start
      // Loop the load: fill to 100%, then start over (the tip rotation keeps
      // its own clock, so the cycle position carries across loops).
      const progress = (elapsed % loadMs) / loadMs

      // Which playlist entry is on screen, which preceded it, and how far
      // into the current slot we are (for the crossfade window).
      let current: StageUpdate | null = null
      let previous: StageUpdate | null = null
      let phase = 0
      let label = ''
      let remaining = 0
      if (intro && elapsed < introMs) {
        current = intro
        phase = elapsed
        label = `intro (tip ${intro.tipFileId})`
        remaining = introMs - elapsed
      } else if (cycle.length > 0 && cycleMs > 0) {
        let pos = (elapsed - introMs) % cycleMs
        let idx = 0
        while (pos >= slots[idx]) { pos -= slots[idx]; idx++ }
        current = cycle[idx]
        phase = pos
        const firstCycleSlot = elapsed - introMs < slots[0]
        previous = idx > 0 ? cycle[idx - 1]
          : firstCycleSlot ? intro           // fading in from the intro (or null at the very start)
          : cycle[cycle.length - 1]          // wrapped — fading from the last tip
        label = `tip ${current.tipFileId} (${idx + 1}/${cycle.length})`
        remaining = slots[idx] - pos
      }

      // Crossfade: the OUTGOING entry's timeBetweenUpdatesMs is the fade
      // length (dstAlpha = t·255/delay, srcAlpha = the rest — client math).
      const fadeMs = previous?.timeBetweenUpdatesMs ?? 0
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)
      if (previous && fadeMs > 0 && phase < fadeMs) {
        const dstAlpha = Math.min(phase / fadeMs, 1)
        ctx.globalAlpha = 1 - dstAlpha
        ctx.drawImage(renderTo(offA, previous, progress, now), 0, 0)
        ctx.globalAlpha = dstAlpha
        ctx.drawImage(renderTo(offB, current, progress, now), 0, 0)
        ctx.globalAlpha = 1
      } else {
        ctx.drawImage(renderTo(offA, current, progress, now), 0, 0)
      }

      // HUD
      const hud = `${((elapsed % loadMs) / 1000).toFixed(1)}s / ${loadSeconds}s — ${Math.floor(progress * 100)}%` +
        (label ? ` · ${label} · next in ${(remaining / 1000).toFixed(1)}s` : '')
      ctx.font = '12px monospace'
      const hw = ctx.measureText(hud).width
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
      ctx.fillRect(6, PREVIEW_H - 24, hw + 12, 18)
      ctx.fillStyle = '#9fe08f'
      ctx.textBaseline = 'middle'
      ctx.fillText(hud, 12, PREVIEW_H - 15)
      ctx.textBaseline = 'alphabetic'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
    // simKey restarts the simulation clock; timelineKey restarts it when the
    // playlist actually changes (so a duration edit is heard immediately).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineKey, loadSeconds, simKey])

  return (
    <div className="tip-preview-wrap">
      <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} className="tip-preview-canvas" />
    </div>
  )
}

// Small rendered thumbnail for a sprite-id field, reusing the preview's
// already-loaded+cached sprite canvases (loadResources) instead of a
// separate fetch per field.
function SpriteFieldThumb({ id, resources }: { id: number; resources: Resources | null }) {
  const canvas = id >= 0 ? resources?.sprites.get(id) : undefined
  if (!canvas) return <span className="tip-sprite-thumb tip-sprite-thumb-empty">?</span>
  return <img className="tip-sprite-thumb" src={canvas.toDataURL()} alt="" />
}

type Props = {
  data: GameTipData
  onSave: (data: GameTipData) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Stage-table rows reference tip file ids — click to open one. */
  onOpenTip?: (id: number) => void
}

export default function GameTipViewer({ data, onSave, onDirtyChange, onOpenTip }: Props) {
  const [draft, setDraft] = useState<GameTipDef>(data.def)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [resources, setResources] = useState<Resources | null>(null)
  // Which stage-timeline chip is selected for editing.
  const [selUpdate, setSelUpdate] = useState<{ stage: number; index: number } | null>(null)
  // Stage table: 'master' edits the shared rotation (regenerating every
  // stage); 'stages' lists every stage for individual editing.
  const [stageMode, setStageMode] = useState<'master' | 'stages'>('master')
  const [selMaster, setSelMaster] = useState<number | null>(null)
  // Simulated load time (seconds) + restart key for the stage-table preview.
  const [simSeconds, setSimSeconds] = useState(90)
  const [simKey, setSimKey] = useState(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const resourcesRef = useRef(resources)
  resourcesRef.current = resources

  useEffect(() => {
    setDraft(data.def)
    setIsDirty(false)
  }, [data])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const components = draft.components ?? []
  const isStageTable = draft.stageTable != null

  function markDirty(next: GameTipDef) {
    setDraft(next)
    setIsDirty(true)
  }

  function setComponent(index: number, patch: Partial<TipComponent>) {
    markDirty({
      ...draft,
      components: components.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    })
  }

  function addComponent(type: string) {
    markDirty({ ...draft, components: [...components, { ...NEW_COMPONENT_DEFAULTS[type] }] })
  }

  function removeComponent(index: number) {
    markDirty({ ...draft, components: components.filter((_, i) => i !== index) })
  }

  function moveComponent(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= components.length) return
    const next = [...components]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    markDirty({ ...draft, components: next })
  }

  // --- resources for the preview (sprites + cache fonts) ---
  useEffect(() => {
    if (isStageTable) return
    let cancelled = false
    loadResources(components, data.spritesDir, data.rootHandle).then((res) => {
      if (!cancelled) setResources(res)
    })
    return () => { cancelled = true }
    // Reload when the set of referenced ids changes, not on every field edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isStageTable, JSON.stringify(collectSpriteIds(components)), JSON.stringify(collectFontIds(components))])

  // --- preview draw loop ---
  useEffect(() => {
    if (isStageTable) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    let raf = 0
    function draw(now: number) {
      raf = requestAnimationFrame(draw)
      const comps = draftRef.current.components ?? []
      const res = resourcesRef.current
      const progress = (now % 8000) / 8000 // loading bars sweep every 8s

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)
      drawScene(ctx, comps, res, progress, now)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [isStageTable])

  async function handleSave() {
    setIsSaving(true)
    await onSave({ ...data, def: draft })
    thumbCache.delete(data.id) // the stage table's renders of this tip are stale
    sceneCache.delete(data.id)
    setIsSaving(false)
    setIsDirty(false)
  }

  // --- stage table editing ---
  function setStageTable(patch: Partial<NonNullable<GameTipDef['stageTable']>>) {
    markDirty({ ...draft, stageTable: { ...draft.stageTable!, ...patch } })
  }

  function setStage(index: number, patch: Partial<Stage>) {
    const stages = draft.stageTable!.definedStages.map((s, i) => (i === index ? { ...s, ...patch } : s))
    setStageTable({ definedStages: stages })
  }

  function setUpdate(stageIndex: number, updateIndex: number, key: 'tipFileId' | 'displayDurationMs' | 'timeBetweenUpdatesMs', value: number) {
    const stage = draft.stageTable!.definedStages[stageIndex]
    setStage(stageIndex, {
      updates: stage.updates.map((u, i) => (i === updateIndex ? { ...u, [key]: value } : u)),
    })
  }

  if (isStageTable) {
    const table = draft.stageTable!
    const model = deriveRotationModel(table.definedStages)
    const introLen = model.intro ? 1 : 0
    const combined = [...(model.intro ? [model.intro] : []), ...model.cycle]

    // Rebuild every stage from the master rotation, keeping each stage's
    // existing start offset (the baked stagger) and flags.
    const applyMaster = (intro: StageUpdate | null, cycle: StageUpdate[]) => {
      const definedStages = table.definedStages.map((st, si) => ({
        ...st,
        updates: [
          ...(intro ? [{ ...intro }] : []),
          ...rotateCycle(cycle, model.offsets[si] ?? 0),
        ],
      }))
      setStageTable({ definedStages })
    }

    const setMasterEntry = (ci: number, key: 'tipFileId' | 'displayDurationMs' | 'timeBetweenUpdatesMs', value: number) => {
      if (model.intro && ci === 0) {
        applyMaster({ ...model.intro, [key]: value }, model.cycle)
      } else {
        applyMaster(model.intro, model.cycle.map((u, i) => (i === ci - introLen ? { ...u, [key]: value } : u)))
      }
    }

    const removeMasterEntry = (ci: number) => {
      setSelMaster(null)
      if (model.intro && ci === 0) applyMaster(null, model.cycle)
      else applyMaster(model.intro, model.cycle.filter((_, i) => i !== ci - introLen))
    }

    const addMasterEntry = () => {
      applyMaster(model.intro, [...model.cycle, { tipFileId: 2, displayDurationMs: 9000, timeBetweenUpdatesMs: 1000 }])
      setSelMaster(combined.length)
    }

    const selEntry = selMaster != null ? combined[selMaster] : undefined
    const cycleMs = model.cycle.reduce((n, u) => n + u.displayDurationMs + u.timeBetweenUpdatesMs, 0)

    return (
      <div className="item-viewer">
        <div className="item-header">
          <div className="item-badges">
            <span className="enum-title">Game Tips — Stage Table</span>
            <span className="item-id-badge">{table.definedStages.length} stages</span>
            <span className="item-id-badge">{model.cycle.length} tips in rotation</span>
          </div>
        </div>

        <section className="item-section">
          <p className="tex-op-note">
            <strong>How loading tips play:</strong> the client saves a rotation cursor in your
            preferences (advanced by a script each login) and uses it to pick ONE stage from this
            table — a stage is not a loading phase, it's a starting point. That stage's playlist
            then runs for as long as loading takes: the intro entry (display 0ms) appears instantly
            as a skeleton while artwork streams in, then each tip shows for its display time and
            crossfades into the next over its fade duration (the cache's timeBetweenUpdatesMs). Every stage holds the same circular playlist starting one tip later, so each
            login begins on a different background — Jagex baked the rotation as {table.definedStages.length} pre-rotated
            copies, which is why the raw data looks so repetitive.
          </p>
          <div className="item-grid">
            <label className="item-field">
              <span className="item-field-label">Total Stage Count</span>
              <NumberInput value={table.totalStageCount} onChange={(v) => setStageTable({ totalStageCount: v })} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Tips File ID</span>
              <NumberInput value={table.tipsFileId} onChange={(v) => setStageTable({ tipsFileId: v })} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Display Duration (ms)</span>
              <NumberInput value={table.displayDurationMs} onChange={(v) => setStageTable({ displayDurationMs: v })} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Update Delay (ms)</span>
              <NumberInput value={table.timeBetweenUpdatesMs} onChange={(v) => setStageTable({ timeBetweenUpdatesMs: v })} />
            </label>
            <label className="item-field">
              <span className="item-field-label">Editing</span>
              <select
                className="item-stackable-select"
                value={stageMode}
                onChange={(e) => { setSelMaster(null); setSelUpdate(null); setStageMode(e.target.value as 'master' | 'stages') }}
              >
                <option value="master">Master rotation</option>
                <option value="stages">All stages</option>
              </select>
            </label>
          </div>
        </section>

        <section className="item-section">
          <h3 className="tex-op-heading">
            Live Simulation
            <span className="item-id-badge">plays the real timings</span>
          </h3>
          <p className="tex-op-note">
            Exactly what a player staring at a very slow load would see: the intro appears
            instantly, tips advance on their configured display times — crossfading between
            scenes over the outgoing tip's fade duration, exactly like the client — and the
            loading bar fills over the simulated load time below. Editing a tip's timing restarts
            the simulation with the change applied.
          </p>
          <div className="tip-sim-controls">
            <label className="item-field tip-sim-field">
              <span className="item-field-label">Simulated Load (s)</span>
              <NumberInput className="item-field-input" value={simSeconds} min={1} onChange={(v) => setSimSeconds(v)} />
            </label>
            <button type="button" className="cursor-pick-btn" onClick={() => setSimKey((k) => k + 1)}>
              Restart
            </button>
          </div>
          <StageSimPreview
            data={data}
            intro={model.intro}
            cycle={model.cycle}
            loadSeconds={simSeconds}
            simKey={simKey}
          />
        </section>

        {stageMode === 'master' && (
          <section className="item-section tip-stage">
            <h3 className="tex-op-heading">
              Master Rotation
              <span className="item-id-badge">{fmtMs(cycleMs)} full cycle</span>
              <span className="item-id-badge">edits rebuild all {table.definedStages.length} stages</span>
            </h3>
            {!model.uniform && (
              <p className="bitmap-clash-warning">
                ⚠ The stages aren't currently clean rotations of one cycle (this table has been
                edited unevenly). This view shows stage {table.definedStages[0]?.stage ?? 0}'s
                playlist — editing anything here rebuilds every stage from it.
              </p>
            )}
            <div className="tip-strip">
              {combined.map((u, ci) => (
                <button
                  key={ci}
                  type="button"
                  className={`tip-chip${selMaster === ci ? ' tip-chip-sel' : ''}`}
                  style={{ borderBottomColor: model.intro && ci === 0 ? 'var(--border)' : SEG_COLORS[(ci - introLen) % SEG_COLORS.length] }}
                  onClick={() => setSelMaster(selMaster === ci ? null : ci)}
                >
                  <TipThumb data={data} tipId={u.tipFileId} />
                  <span className="tip-chip-label">
                    {model.intro && ci === 0 ? `intro · tip ${u.tipFileId}` : `tip ${u.tipFileId}`}
                  </span>
                  <span className="tip-chip-time">
                    {fmtMs(u.displayDurationMs)}{u.timeBetweenUpdatesMs > 0 ? ` · ${fmtMs(u.timeBetweenUpdatesMs)} fade` : ''}
                  </span>
                </button>
              ))}
              <button type="button" className="tip-chip tip-chip-add" title="Add a tip to the rotation" onClick={addMasterEntry}>
                +
              </button>
            </div>
            {cycleMs > 0 && model.cycle.length > 1 && (
              <div className="tip-duration-bar" title="Each tip's share of the full rotation (display + delay)">
                {model.cycle.map((u, ci) => (
                  <span
                    key={ci}
                    className="tip-duration-seg"
                    style={{
                      flexGrow: Math.max(u.displayDurationMs + u.timeBetweenUpdatesMs, 1),
                      background: SEG_COLORS[ci % SEG_COLORS.length],
                    }}
                    title={`tip ${u.tipFileId} — ${fmtMs(u.displayDurationMs)} shown, ${fmtMs(u.timeBetweenUpdatesMs)} crossfade out`}
                  />
                ))}
              </div>
            )}
            {selEntry != null && selMaster != null && (
              <div className="tip-update-edit">
                <label className="item-field">
                  <span className="item-field-label">Tip File</span>
                  <NumberInput className="item-field-input" value={selEntry.tipFileId} onChange={(v) => setMasterEntry(selMaster, 'tipFileId', v)} />
                </label>
                <label className="item-field">
                  <span className="item-field-label">Display (ms)</span>
                  <NumberInput className="item-field-input" value={selEntry.displayDurationMs} onChange={(v) => setMasterEntry(selMaster, 'displayDurationMs', v)} />
                </label>
                <label className="item-field">
                  <span className="item-field-label" title="timeBetweenUpdatesMs — how long this tip crossfades into the next">Fade Out (ms)</span>
                  <NumberInput className="item-field-input" value={selEntry.timeBetweenUpdatesMs} onChange={(v) => setMasterEntry(selMaster, 'timeBetweenUpdatesMs', v)} />
                </label>
                <button type="button" className="cursor-pick-btn" onClick={() => onOpenTip?.(selEntry.tipFileId)}>View Tip</button>
                <button type="button" className="cursor-pick-btn tip-update-remove" onClick={() => removeMasterEntry(selMaster)}>
                  Remove
                </button>
              </div>
            )}
          </section>
        )}

        {stageMode === 'stages' && table.definedStages.map((stage, si) => {
          const totalMs = stage.updates.reduce((n, u) => n + u.displayDurationMs + u.timeBetweenUpdatesMs, 0)
          const sel = selUpdate?.stage === si ? stage.updates[selUpdate.index] : undefined
          return (
            <section key={si} className="item-section tip-stage">
              <h3 className="tex-op-heading">
                Stage {stage.stage}
                <span className="item-id-badge">{stage.updates.length} tip{stage.updates.length === 1 ? '' : 's'}</span>
                {totalMs > 0 && <span className="item-id-badge">{fmtMs(totalMs)} rotation</span>}
                <label className="badge-toggle tip-shuffle-toggle" title="Shuffled stages play their tips in random order (the hasUpdates flag)">
                  <input type="checkbox" checked={stage.hasUpdates}
                    onChange={(e) => setStage(si, { hasUpdates: e.target.checked })} />
                  <span className={stage.hasUpdates ? 'badge badge-members' : 'badge item-badge-off'}>
                    {stage.hasUpdates ? 'Shuffled' : 'Ordered'}
                  </span>
                </label>
              </h3>
              <div className="tip-strip">
                {stage.updates.map((u, ui) => (
                  <button
                    key={ui}
                    type="button"
                    className={`tip-chip${selUpdate?.stage === si && selUpdate.index === ui ? ' tip-chip-sel' : ''}`}
                    style={{ borderBottomColor: SEG_COLORS[ui % SEG_COLORS.length] }}
                    onClick={() => setSelUpdate(selUpdate?.stage === si && selUpdate.index === ui ? null : { stage: si, index: ui })}
                  >
                    <TipThumb data={data} tipId={u.tipFileId} />
                    <span className="tip-chip-label">tip {u.tipFileId}</span>
                    <span className="tip-chip-time">
                      {fmtMs(u.displayDurationMs)}{u.timeBetweenUpdatesMs > 0 ? ` · ${fmtMs(u.timeBetweenUpdatesMs)} fade` : ''}
                    </span>
                  </button>
                ))}
                <button type="button" className="tip-chip tip-chip-add" title="Add a tip to this stage"
                  onClick={() => {
                    setStage(si, { updates: [...stage.updates, { tipFileId: 2, displayDurationMs: 9000, timeBetweenUpdatesMs: 1000 }] })
                    setSelUpdate({ stage: si, index: stage.updates.length })
                  }}>
                  +
                </button>
              </div>
              {sel && selUpdate && (
                <div className="tip-update-edit">
                  <label className="item-field">
                    <span className="item-field-label">Tip File</span>
                    <NumberInput className="item-field-input" value={sel.tipFileId} onChange={(v) => setUpdate(si, selUpdate.index, 'tipFileId', v)} />
                  </label>
                  <label className="item-field">
                    <span className="item-field-label">Display (ms)</span>
                    <NumberInput className="item-field-input" value={sel.displayDurationMs} onChange={(v) => setUpdate(si, selUpdate.index, 'displayDurationMs', v)} />
                  </label>
                  <label className="item-field">
                    <span className="item-field-label" title="timeBetweenUpdatesMs — how long this tip crossfades into the next">Fade Out (ms)</span>
                    <NumberInput className="item-field-input" value={sel.timeBetweenUpdatesMs} onChange={(v) => setUpdate(si, selUpdate.index, 'timeBetweenUpdatesMs', v)} />
                  </label>
                  <button type="button" className="cursor-pick-btn" onClick={() => onOpenTip?.(sel.tipFileId)}>View Tip</button>
                  <button type="button" className="cursor-pick-btn tip-update-remove"
                    onClick={() => { setSelUpdate(null); setStage(si, { updates: stage.updates.filter((_, i) => i !== selUpdate.index) }) }}>
                    Remove
                  </button>
                </div>
              )}
            </section>
          )
        })}

        {isDirty && (
          <div className="save-bar">
            <span className="save-bar-label">Unsaved changes</span>
            <button type="button" className="save-bar-discard" onClick={() => { setDraft(data.def); setIsDirty(false); setSelMaster(null); setSelUpdate(null) }}>Discard</button>
            <button type="button" className="save-bar-save" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="item-viewer">
      <div className="item-header">
        <div className="item-badges">
          <span className="enum-title">Game Tip {data.id}</span>
          <span className="item-id-badge">{components.length} components</span>
        </div>
      </div>

      <section className="item-section">
        <h3>Preview</h3>
        <p className="tex-op-note">
          The loading screen this tip draws, composited from the components below at the classic
          765 × 503 client size. Loading bars animate a fake progress sweep; the sprite-based bar
          fills are approximated (the client assembles them from cap/fill sprites).
        </p>
        <div className="tip-preview-wrap">
          <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} className="tip-preview-canvas" />
        </div>
      </section>

      <section className="item-section">
        <h3 className="tex-op-heading">
          Components
          <span className="item-id-badge">drawn top to bottom</span>
        </h3>
        {components.map((c, i) => (
          <div key={i} className="tip-component-card">
            <div className="tip-component-head">
              <span className="tip-component-type">{i}: {c.type}</span>
              <span className="tip-component-actions">
                <button type="button" className="cursor-pick-btn" disabled={i === 0} onClick={() => moveComponent(i, -1)}>↑</button>
                <button type="button" className="cursor-pick-btn" disabled={i === components.length - 1} onClick={() => moveComponent(i, 1)}>↓</button>
                <button type="button" className="row-remove-btn" onClick={() => removeComponent(i)}>×</button>
              </span>
            </div>
            <div className="item-grid tip-component-grid">
              {(TYPE_FIELDS[c.type] ?? []).map(([key, label, kind]) => (
                <label key={key} className="item-field">
                  <span className="item-field-label" title={label}>{label}</span>
                  {kind === 'int' && (
                    <NumberInput value={Number(c[key] ?? 0)} onChange={(v) => setComponent(i, { [key]: v })} />
                  )}
                  {kind === 'sprite' && (
                    <span className="tip-sprite-field-row">
                      <SpriteFieldThumb id={Number(c[key] ?? -1)} resources={resources} />
                      <NumberInput value={Number(c[key] ?? 0)} onChange={(v) => setComponent(i, { [key]: v })} />
                    </span>
                  )}
                  {kind === 'color' && (
                    <span className="tip-color-row">
                      <span className="texture-swatch" style={{ background: argbToCss(Number(c[key] ?? 0)) }} />
                      <NumberInput value={Number(c[key] ?? 0)} onChange={(v) => setComponent(i, { [key]: v })} />
                    </span>
                  )}
                  {kind === 'text' && (
                    <textarea
                      className="item-field-input tip-text-input"
                      rows={2}
                      value={String(c[key] ?? '')}
                      onChange={(e) => setComponent(i, { [key]: e.target.value })}
                    />
                  )}
                  {kind === 'bool' && (
                    <span className="sprite-toggle">
                      <input type="checkbox" checked={Boolean(c[key])} onChange={(e) => setComponent(i, { [key]: e.target.checked })} />
                      <span className="sprite-toggle-track" />
                    </span>
                  )}
                  {(kind === 'anchorX' || kind === 'anchorY') && (
                    <select
                      className="item-stackable-select"
                      value={String(c[key] ?? (kind === 'anchorX' ? 'LEFT' : 'TOP'))}
                      onChange={(e) => setComponent(i, { [key]: e.target.value })}
                    >
                      {(kind === 'anchorX' ? ANCHOR_X : ANCHOR_Y).map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="tip-add-row">
          <select
            className="item-stackable-select"
            value=""
            onChange={(e) => { if (e.target.value) addComponent(e.target.value) }}
          >
            <option value="">+ Add component…</option>
            {COMPONENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </section>

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
