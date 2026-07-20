import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpriteMeta } from '../loaders/sprites'
import { NumberInput } from './defFields'
import { imageDataFromFile } from './spriteRender'
import { quantizeImage } from './quantize'
import './SpritePixelEditor.css'

type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'rectf' | 'move' | 'pick'

const TOOLS: [Tool, string, string][] = [
  ['pencil', 'Pencil', 'Paint single pixels (drag to stroke)'],
  ['eraser', 'Eraser', 'Paint transparency (drag to stroke)'],
  ['fill', 'Fill', 'Flood-fill the clicked colour region'],
  ['line', 'Line', 'Drag to draw a straight line'],
  ['rect', 'Rect', 'Drag to draw a rectangle outline'],
  ['rectf', 'Fill Rect', 'Drag to draw a filled rectangle'],
  ['move', 'Move', 'Drag to shift the whole drawing (pixels pushed off the edge are lost)'],
  ['pick', 'Pick', 'Click a pixel to select its colour'],
]

// Copy/paste survives closing the modal, so a frame can be copied into another
// frame (or another sprite). Stored as RGBA so palettes never have to match.
let pixelClipboard: { w: number; h: number; rgba: Uint8ClampedArray } | null = null

const ZOOM_LEVELS = [2, 4, 8, 16, 24]
const MAX_HISTORY = 100
const MAX_DIM = 512

type Snapshot = {
  pixels: Uint8Array
  alpha: Uint8Array
  palette: number[]
  w: number
  h: number
}

type DragState = {
  tool: Tool
  start: { x: number; y: number }
  last: { x: number; y: number }
  /** Move tool: the buffers as they were when the drag started. */
  base?: { pixels: Uint8Array; alpha: Uint8Array }
}

type Props = {
  meta: SpriteMeta
  frameIndex: number
  title?: string
  onApply: (meta: SpriteMeta) => void
  onCancel: () => void
}

const MAX_SEED_BYTES = 8 * 1024 * 1024

function hexToRgb(hex: string): number {
  return parseInt(hex.slice(1), 16) & 0xffffff
}

function rgbToHex(rgb: number): string {
  return `#${((rgb & 0xffffff) >>> 0).toString(16).padStart(6, '0')}`
}

/** In-app pixel editor for one sprite frame: draw tools, undo/redo, resize and
 *  palette selection, all in the sprite's own paletted domain (index 0 =
 *  reserved transparent). Palette changes are append-only so the other frames'
 *  indices stay valid. */
export default function SpritePixelEditor({ meta, frameIndex, title, onApply, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const subW = meta.subWidths[frameIndex] ?? 0
  const subH = meta.subHeights[frameIndex] ?? 0

  // Pixel buffers live in refs (mutated during strokes); `version` bumps to
  // trigger canvas redraws without copying the buffers every pointermove.
  const pixelsRef = useRef<Uint8Array>(new Uint8Array(0))
  const alphaRef = useRef<Uint8Array>(new Uint8Array(0))
  const [version, setVersion] = useState(0)
  const repaint = useCallback(() => setVersion((v) => v + 1), [])

  const [w, setW] = useState(Math.max(1, subW))
  const [h, setH] = useState(Math.max(1, subH))
  const [pendingW, setPendingW] = useState(Math.max(1, subW))
  const [pendingH, setPendingH] = useState(Math.max(1, subH))
  const [palette, setPalette] = useState<number[]>(meta.palette.length > 0 ? [...meta.palette] : [0])
  const [tool, setTool] = useState<Tool>('pencil')
  const [colorIdx, setColorIdx] = useState(meta.palette.length > 1 ? 1 : 0)
  const [zoom, setZoom] = useState(() => {
    const fitW = Math.max(1, subW), fitH = Math.max(1, subH)
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (fitW * ZOOM_LEVELS[i] <= 640 && fitH * ZOOM_LEVELS[i] <= 480) return ZOOM_LEVELS[i]
    }
    return ZOOM_LEVELS[0]
  })
  const [paletteError, setPaletteError] = useState<string | null>(null)
  const [seedUrl, setSeedUrl] = useState('')
  const [seedError, setSeedError] = useState<string | null>(null)
  const [seedNote, setSeedNote] = useState<string | null>(null)
  const [seedBusy, setSeedBusy] = useState(false)
  const [hasClip, setHasClip] = useState(pixelClipboard != null)

  const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] })
  const [histVersion, setHistVersion] = useState(0)
  const dragRef = useRef<DragState | null>(null)
  const previewRef = useRef<{ x: number; y: number } | null>(null)

  // Seed the buffers from the frame (row-major; meta stores column-major).
  useEffect(() => {
    const frame = meta.pixelIndices[frameIndex] ?? []
    const frameAlpha = meta.alpha?.[frameIndex] ?? []
    const width = Math.max(1, subW), height = Math.max(1, subH)
    const px = new Uint8Array(width * height)
    const al = new Uint8Array(width * height)
    for (let x = 0; x < subW; x++) {
      const col = frame[x]
      if (!col) continue
      for (let y = 0; y < subH; y++) {
        px[y * width + x] = col[y] & 0xff
        al[y * width + x] = frameAlpha[y * subW + x] & 0xff
      }
    }
    pixelsRef.current = px
    alphaRef.current = al
    repaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // -- History ----------------------------------------------------------------

  const takeSnapshot = useCallback((): Snapshot => ({
    pixels: pixelsRef.current.slice(),
    alpha: alphaRef.current.slice(),
    palette: [...palette],
    w,
    h,
  }), [palette, w, h])

  const pushHistory = useCallback(() => {
    const hist = historyRef.current
    hist.past.push(takeSnapshot())
    if (hist.past.length > MAX_HISTORY) hist.past.shift()
    hist.future = []
    setHistVersion((v) => v + 1)
  }, [takeSnapshot])

  const restore = useCallback((snap: Snapshot) => {
    pixelsRef.current = snap.pixels.slice()
    alphaRef.current = snap.alpha.slice()
    setPalette([...snap.palette])
    setW(snap.w)
    setH(snap.h)
    setPendingW(snap.w)
    setPendingH(snap.h)
    repaint()
  }, [repaint])

  const undo = useCallback(() => {
    const hist = historyRef.current
    const snap = hist.past.pop()
    if (!snap) return
    hist.future.push(takeSnapshot())
    restore(snap)
    setHistVersion((v) => v + 1)
  }, [restore, takeSnapshot])

  const redo = useCallback(() => {
    const hist = historyRef.current
    const snap = hist.future.pop()
    if (!snap) return
    hist.past.push(takeSnapshot())
    restore(snap)
    setHistVersion((v) => v + 1)
  }, [restore, takeSnapshot])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.target instanceof HTMLInputElement) return
      const key = e.key.toLowerCase()
      if (key === 'z' && e.shiftKey) { e.preventDefault(); redo() }
      else if (key === 'z') { e.preventDefault(); undo() }
      else if (key === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // -- Painting primitives ----------------------------------------------------

  const usesAlpha = meta.usesAlpha[frameIndex] === true

  const paintCell = useCallback((x: number, y: number, idx: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    pixelsRef.current[y * w + x] = idx
    if (usesAlpha) alphaRef.current[y * w + x] = idx === 0 ? 0 : 255
  }, [w, h, usesAlpha])

  const paintLine = useCallback((x0: number, y0: number, x1: number, y1: number, idx: number) => {
    // Bresenham, so fast drags leave no gaps.
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy, x = x0, y = y0
    for (;;) {
      paintCell(x, y, idx)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x += sx }
      if (e2 <= dx) { err += dx; y += sy }
    }
  }, [paintCell])

  const paintRect = useCallback((x0: number, y0: number, x1: number, y1: number, idx: number, filled: boolean) => {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
    if (filled) {
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) paintCell(x, y, idx)
      }
      return
    }
    for (let x = minX; x <= maxX; x++) { paintCell(x, minY, idx); paintCell(x, maxY, idx) }
    for (let y = minY; y <= maxY; y++) { paintCell(minX, y, idx); paintCell(maxX, y, idx) }
  }, [paintCell])

  const floodFill = useCallback((x: number, y: number, idx: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const px = pixelsRef.current
    const target = px[y * w + x]
    if (target === idx) return
    const stack = [y * w + x]
    while (stack.length > 0) {
      const pos = stack.pop()!
      if (px[pos] !== target) continue
      px[pos] = idx
      if (usesAlpha) alphaRef.current[pos] = idx === 0 ? 0 : 255
      const cx = pos % w, cy = (pos - cx) / w
      if (cx > 0) stack.push(pos - 1)
      if (cx < w - 1) stack.push(pos + 1)
      if (cy > 0) stack.push(pos - w)
      if (cy < h - 1) stack.push(pos + w)
    }
  }, [w, h, usesAlpha])

  // -- Pointer handling -------------------------------------------------------

  function cellFromEvent(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.floor((e.clientX - rect.left) / zoom),
      y: Math.floor((e.clientY - rect.top) / zoom),
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return
    const cell = cellFromEvent(e)
    if (cell.x < 0 || cell.y < 0 || cell.x >= w || cell.y >= h) return
    e.currentTarget.setPointerCapture(e.pointerId)

    if (tool === 'pick') {
      setColorIdx(pixelsRef.current[cell.y * w + cell.x])
      return
    }
    if (tool === 'fill') {
      pushHistory()
      floodFill(cell.x, cell.y, colorIdx)
      repaint()
      return
    }
    if (tool === 'pencil' || tool === 'eraser') {
      pushHistory()
      paintCell(cell.x, cell.y, tool === 'eraser' ? 0 : colorIdx)
      dragRef.current = { tool, start: cell, last: cell }
      repaint()
      return
    }
    if (tool === 'move') {
      pushHistory()
      dragRef.current = {
        tool,
        start: cell,
        last: cell,
        base: { pixels: pixelsRef.current.slice(), alpha: alphaRef.current.slice() },
      }
      return
    }
    // line / rect: preview until release
    dragRef.current = { tool, start: cell, last: cell }
    previewRef.current = cell
    repaint()
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag) return
    const cell = cellFromEvent(e)
    const clamped = {
      x: Math.max(0, Math.min(w - 1, cell.x)),
      y: Math.max(0, Math.min(h - 1, cell.y)),
    }
    if (clamped.x === drag.last.x && clamped.y === drag.last.y) return

    if (drag.tool === 'pencil' || drag.tool === 'eraser') {
      paintLine(drag.last.x, drag.last.y, clamped.x, clamped.y, drag.tool === 'eraser' ? 0 : colorIdx)
      drag.last = clamped
      repaint()
      return
    }
    if (drag.tool === 'move' && drag.base) {
      // rebuild from the stroke-start buffers shifted by the drag delta
      const dx = cell.x - drag.start.x
      const dy = cell.y - drag.start.y
      const px = new Uint8Array(w * h)
      const al = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let x = 0; x < w; x++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          px[ny * w + nx] = drag.base.pixels[y * w + x]
          al[ny * w + nx] = drag.base.alpha[y * w + x]
        }
      }
      pixelsRef.current = px
      alphaRef.current = al
      drag.last = clamped
      repaint()
      return
    }
    drag.last = clamped
    previewRef.current = clamped
    repaint()
  }

  function handlePointerUp() {
    const drag = dragRef.current
    if (!drag) return
    if (drag.tool === 'line' || drag.tool === 'rect' || drag.tool === 'rectf') {
      pushHistory()
      if (drag.tool === 'line') paintLine(drag.start.x, drag.start.y, drag.last.x, drag.last.y, colorIdx)
      else paintRect(drag.start.x, drag.start.y, drag.last.x, drag.last.y, colorIdx, drag.tool === 'rectf')
    }
    dragRef.current = null
    previewRef.current = null
    repaint()
  }

  // -- Canvas rendering -------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = w * zoom
    canvas.height = h * zoom
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // pixel layer at 1:1, then scale-blit
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const offCtx = off.getContext('2d')!
    const imageData = offCtx.createImageData(w, h)
    const data = imageData.data
    const px = pixelsRef.current
    const al = alphaRef.current
    for (let pos = 0; pos < w * h; pos++) {
      const idx = px[pos]
      const a = usesAlpha ? al[pos] : (idx === 0 ? 0 : 255)
      if (a === 0) continue
      const rgb = palette[idx] ?? 0
      const o = pos * 4
      data[o] = (rgb >> 16) & 0xff
      data[o + 1] = (rgb >> 8) & 0xff
      data[o + 2] = rgb & 0xff
      data[o + 3] = a
    }
    offCtx.putImageData(imageData, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(off, 0, 0, w, h, 0, 0, w * zoom, h * zoom)

    // line/rect preview overlay
    const drag = dragRef.current
    if (drag && (drag.tool === 'line' || drag.tool === 'rect' || drag.tool === 'rectf') && previewRef.current) {
      const cells: { x: number; y: number }[] = []
      const collect = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) cells.push({ x, y }) }
      const { start } = drag
      const end = previewRef.current
      if (drag.tool === 'line') {
        const dx = Math.abs(end.x - start.x), dy = -Math.abs(end.y - start.y)
        const sx = start.x < end.x ? 1 : -1, sy = start.y < end.y ? 1 : -1
        let err = dx + dy, x = start.x, y = start.y
        for (;;) {
          collect(x, y)
          if (x === end.x && y === end.y) break
          const e2 = 2 * err
          if (e2 >= dy) { err += dy; x += sx }
          if (e2 <= dx) { err += dx; y += sy }
        }
      } else if (drag.tool === 'rectf') {
        const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x)
        const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y)
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) collect(x, y)
        }
      } else {
        const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x)
        const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y)
        for (let x = minX; x <= maxX; x++) { collect(x, minY); collect(x, maxY) }
        for (let y = minY; y <= maxY; y++) { collect(minX, y); collect(maxX, y) }
      }
      const rgb = palette[colorIdx] ?? 0
      ctx.fillStyle = `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, 0.6)`
      for (const cell of cells) ctx.fillRect(cell.x * zoom, cell.y * zoom, zoom, zoom)
    }

    // pixel grid once cells are big enough to have visible seams
    if (zoom >= 8) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 1; x < w; x++) { ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, h * zoom) }
      for (let y = 1; y < h; y++) { ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(w * zoom, y * zoom + 0.5) }
      ctx.stroke()
    }
  }, [version, zoom, w, h, palette, colorIdx, usesAlpha])

  // -- Applying an image to the canvas (upload / URL / paste) -----------------
  // The image is treated strictly as pixel data. Checks before anything is
  // touched: dimensions within the sprite cap, and colours within the palette
  // budget — images over it are median-cut quantized down rather than refused.
  // `replace` resizes the canvas to the image; otherwise it stamps at the
  // top-left over the existing drawing (transparent pixels leave it alone).

  const applyImage = useCallback((source: ImageData, replace: boolean) => {
    if (replace && (source.width < 1 || source.height < 1 || source.width > MAX_DIM || source.height > MAX_DIM)) {
      setSeedError(`Image is ${source.width}×${source.height} — frames are capped at ${MAX_DIM}×${MAX_DIM}.`)
      return
    }
    // Frames without per-pixel alpha are binary: >=128 opaque, else transparent.
    const visible = (a: number) => (usesAlpha ? a > 0 : a >= 128)

    const known = new Set<number>()
    for (let i = 1; i < palette.length; i++) known.add(palette[i] & 0xffffff)
    const countFresh = (img: ImageData): number => {
      const fresh = new Set<number>()
      const data = img.data
      for (let pos = 0; pos < img.width * img.height; pos++) {
        const o = pos * 4
        if (!visible(data[o + 3])) continue
        const rgb = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
        if (!known.has(rgb)) fresh.add(rgb)
      }
      return fresh.size
    }

    let img = source
    let note: string | null = null
    const budget = 256 - palette.length
    if (countFresh(source) > budget) {
      if (budget < 1) {
        setSeedError('The palette is already full (255 colours) — remove colours before loading an image.')
        return
      }
      const q = quantizeImage(source, budget)
      img = q.image
      note = `Image had ${q.originalCount} colours — quantized down to ${q.colorCount} to fit the palette.`
      if (countFresh(img) > budget) {
        // can't happen (quantize output ≤ budget distinct colours), but never
        // let a slip corrupt the palette silently
        setSeedError('Quantization failed to fit the palette — reduce the image\'s colours first.')
        return
      }
    }

    pushHistory()
    const newPalette = [...palette]
    const rgbToIdx = new Map<number, number>()
    for (let i = 1; i < newPalette.length; i++) {
      const rgb = newPalette[i] & 0xffffff
      if (!rgbToIdx.has(rgb)) rgbToIdx.set(rgb, i)
    }

    const data = img.data
    const targetW = replace ? img.width : w
    const targetH = replace ? img.height : h
    const px = replace ? new Uint8Array(targetW * targetH) : pixelsRef.current
    const al = replace ? new Uint8Array(targetW * targetH) : alphaRef.current
    const copyW = Math.min(img.width, targetW)
    const copyH = Math.min(img.height, targetH)
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const o = (y * img.width + x) * 4
        const a = data[o + 3]
        if (!visible(a)) {
          if (replace && usesAlpha) al[y * targetW + x] = a
          continue
        }
        const rgb = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
        let idx = rgbToIdx.get(rgb)
        if (idx == null) {
          idx = newPalette.length
          newPalette.push(rgb)
          rgbToIdx.set(rgb, idx)
        }
        px[y * targetW + x] = idx
        if (usesAlpha) al[y * targetW + x] = a
      }
    }
    pixelsRef.current = px
    alphaRef.current = al
    setPalette(newPalette)
    if (replace) {
      setW(targetW)
      setH(targetH)
      setPendingW(targetW)
      setPendingH(targetH)
    }
    setSeedError(null)
    setSeedNote(note)
    repaint()
  }, [palette, usesAlpha, w, h, pushHistory, repaint])

  function handleCopy() {
    const rgba = new Uint8ClampedArray(w * h * 4)
    const px = pixelsRef.current
    const al = alphaRef.current
    for (let pos = 0; pos < w * h; pos++) {
      const idx = px[pos]
      const a = usesAlpha ? al[pos] : (idx === 0 ? 0 : 255)
      if (a === 0) continue
      const rgb = palette[idx] ?? 0
      const o = pos * 4
      rgba[o] = (rgb >> 16) & 0xff
      rgba[o + 1] = (rgb >> 8) & 0xff
      rgba[o + 2] = rgb & 0xff
      rgba[o + 3] = a
    }
    pixelClipboard = { w, h, rgba }
    setHasClip(true)
  }

  function handlePaste() {
    if (!pixelClipboard) return
    applyImage(new ImageData(pixelClipboard.rgba.slice(), pixelClipboard.w, pixelClipboard.h), false)
  }

  async function handleSeedFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      if (file.size > MAX_SEED_BYTES) throw new Error(`File is too large (max ${MAX_SEED_BYTES / 1024 / 1024}MB).`)
      applyImage(await imageDataFromFile(file), true)
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSeedUrl() {
    const raw = seedUrl.trim()
    if (raw === '' || seedBusy) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw new Error('That doesn\'t look like a valid URL.')
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Only http(s) image URLs are supported.')
      }
      const res = await fetch(url, { mode: 'cors' }).catch(() => {
        throw new Error('Couldn\'t fetch the image — the host may not allow cross-site access (CORS). Download it and use Upload instead.')
      })
      if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}.`)
      const blob = await res.blob()
      if (blob.size > MAX_SEED_BYTES) throw new Error(`File is too large (max ${MAX_SEED_BYTES / 1024 / 1024}MB).`)
      const img = await imageDataFromFile(blob).catch(() => {
        throw new Error('The URL\'s content could not be decoded as an image.')
      })
      applyImage(img, true)
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : String(err))
    } finally {
      setSeedBusy(false)
    }
  }

  // -- Resize / palette / apply ----------------------------------------------

  function handleResize() {
    const newW = Math.max(1, Math.min(MAX_DIM, pendingW))
    const newH = Math.max(1, Math.min(MAX_DIM, pendingH))
    if (newW === w && newH === h) return
    pushHistory()
    const px = new Uint8Array(newW * newH)
    const al = new Uint8Array(newW * newH)
    const copyW = Math.min(w, newW), copyH = Math.min(h, newH)
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        px[y * newW + x] = pixelsRef.current[y * w + x]
        al[y * newW + x] = alphaRef.current[y * w + x]
      }
    }
    pixelsRef.current = px
    alphaRef.current = al
    setW(newW)
    setH(newH)
    setPendingW(newW)
    setPendingH(newH)
    repaint()
  }

  function handleAddColor(hex: string) {
    const rgb = hexToRgb(hex)
    const existing = palette.findIndex((c, i) => i > 0 && (c & 0xffffff) === rgb)
    if (existing >= 0) {
      setColorIdx(existing)
      setPaletteError(null)
      return
    }
    if (palette.length >= 256) {
      setPaletteError('Palette is full (255 colours + transparent) — reuse an existing colour.')
      return
    }
    setPalette((prev) => [...prev, rgb])
    setColorIdx(palette.length)
    setPaletteError(null)
  }

  function handleApply() {
    const frameCount = meta.usesAlpha.length
    const px = pixelsRef.current
    const al = alphaRef.current

    const framePixels: number[][] = Array.from({ length: w }, (_, x) =>
      Array.from({ length: h }, (_, y) => px[y * w + x]))
    const frameAlpha: number[] = usesAlpha
      ? Array.from(al)
      : new Array(w * h).fill(0)

    const pixelIndices = meta.pixelIndices.map((f, i) => (i === frameIndex ? framePixels : f))
    const alpha = meta.alpha.map((f, i) => (i === frameIndex ? frameAlpha : f))
    const subWidths = meta.subWidths.map((v, i) => (i === frameIndex ? w : v))
    const subHeights = meta.subHeights.map((v, i) => (i === frameIndex ? h : v))

    // Full sprite bounds = the union of every frame's placed rect.
    let width = 0, height = 0
    for (let i = 0; i < frameCount; i++) {
      width = Math.max(width, (meta.offsetsX[i] ?? 0) + subWidths[i])
      height = Math.max(height, (meta.offsetsY[i] ?? 0) + subHeights[i])
    }

    onApply({
      ...meta,
      width,
      height,
      palette,
      pixelIndices,
      alpha,
      subWidths,
      subHeights,
    })
  }

  const canUndo = historyRef.current.past.length > 0
  const canRedo = historyRef.current.future.length > 0
  void histVersion // read so eslint sees the state driving canUndo/canRedo re-renders

  return (
    <dialog
      ref={dialogRef}
      className="pixel-editor-dialog"
      onCancel={(e) => { e.preventDefault(); onCancel() }}
    >
      <div className="pixel-editor-body">
        <h3 className="confirm-dialog-title">{title ?? `Edit pixels — Frame ${frameIndex}`}</h3>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleSeedFile}
        />

        <div className="pixel-editor-toolbar">
          <span className="btn-pill">
            {TOOLS.map(([t, label, title]) => (
              <button
                key={t}
                type="button"
                className={`zoom-btn${tool === t ? ' active' : ''}`}
                title={title}
                onClick={() => setTool(t)}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="btn-pill">
            {ZOOM_LEVELS.map((z) => (
              <button
                key={z}
                type="button"
                className={`zoom-btn${zoom === z ? ' active' : ''}`}
                onClick={() => setZoom(z)}
              >
                {z}×
              </button>
            ))}
          </span>
          <span className="btn-pill">
            <button type="button" className="zoom-btn" disabled={!canUndo} title="Ctrl+Z" onClick={undo}>Undo</button>
            <button type="button" className="zoom-btn" disabled={!canRedo} title="Ctrl+Shift+Z / Ctrl+Y" onClick={redo}>Redo</button>
          </span>
          <span className="btn-pill">
            <button type="button" className="zoom-btn" title="Copy the whole canvas (paste it into any frame or sprite)" onClick={handleCopy}>Copy</button>
            <button type="button" className="zoom-btn" disabled={!hasClip} title="Stamp the copied pixels at the top-left (undoable; transparency doesn't overwrite)" onClick={handlePaste}>Paste</button>
          </span>
        </div>

        <div className="pixel-editor-toolbar">
          <span className="sprite-zoom-label">Size</span>
          <NumberInput value={pendingW} min={1} max={MAX_DIM} onChange={setPendingW} />
          <span className="pixel-editor-x">×</span>
          <NumberInput value={pendingH} min={1} max={MAX_DIM} onChange={setPendingH} />
          <button
            type="button"
            className="replace-btn"
            disabled={pendingW === w && pendingH === h}
            onClick={handleResize}
          >
            Resize
          </button>
          <span className="pixel-editor-dims">{w} × {h}</span>
        </div>

        <div className="pixel-editor-toolbar">
          <button
            type="button"
            className="replace-btn"
            title="Replace the canvas with an uploaded image (undoable)"
            onClick={() => {
              setSeedError(null)
              fileInputRef.current!.value = ''
              fileInputRef.current!.click()
            }}
          >
            Upload image…
          </button>
          <input
            type="text"
            className="pixel-editor-url"
            placeholder="https://example.com/image.png"
            value={seedUrl}
            onChange={(e) => setSeedUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSeedUrl() } }}
          />
          <button
            type="button"
            className="replace-btn"
            disabled={seedBusy || seedUrl.trim() === ''}
            title="Fetch the URL and replace the canvas with it (undoable)"
            onClick={handleSeedUrl}
          >
            {seedBusy ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        {seedError && <div className="upload-error">{seedError}</div>}
        {seedNote && <div className="pixel-editor-note">{seedNote}</div>}
        <p className="pixel-editor-note">
          Loaded images are read as pixel data only, checked against the size and palette
          limits, and replace the canvas (Ctrl+Z restores it).
        </p>

        <div className="pixel-editor-canvas-wrap">
          <canvas
            ref={canvasRef}
            className={`pixel-editor-canvas pixel-editor-tool-${tool}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        </div>

        <div className="pixel-editor-palette">
          <span className="sprite-meta-label">Palette — click a swatch to paint with it</span>
          {paletteError && <div className="upload-error">{paletteError}</div>}
          <div className="sprite-palette-grid">
            <button
              type="button"
              className={`sprite-palette-swatch sprite-palette-transparent pixel-editor-swatch${colorIdx === 0 ? ' selected' : ''}`}
              title="Index 0 — transparent (same as the eraser)"
              onClick={() => setColorIdx(0)}
            />
            {palette.slice(1).map((rgb, i) => (
              <button
                key={i + 1}
                type="button"
                className={`sprite-palette-swatch pixel-editor-swatch${colorIdx === i + 1 ? ' selected' : ''}`}
                style={{ background: rgbToHex(rgb) }}
                title={`Index ${i + 1} — ${rgbToHex(rgb)}`}
                onClick={() => setColorIdx(i + 1)}
              />
            ))}
            <label className="sprite-palette-swatch pixel-editor-add-swatch" title="Add a new colour to the palette">
              +
              <input type="color" onChange={(e) => handleAddColor(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="confirm-dialog-actions">
          <button type="button" className="save-bar-discard" onClick={onCancel}>Cancel</button>
          <button type="button" className="save-bar-save" onClick={handleApply}>Apply</button>
        </div>
      </div>
    </dialog>
  )
}
