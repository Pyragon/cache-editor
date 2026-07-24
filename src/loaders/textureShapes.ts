// The op-29 Rasterizer's shape drawing — a faithful port of cryogen's
// texture/rasterizers/ classes (LineRasterizer, BezierCurveRasterizer,
// RectangleRasterizer, EllipseRasterizer) plus the static plumbing in
// TextureOpRasterizer (pixel buffer + clip bounds) and
// JagexArrayUtils.method3922 (the span fill).
//
// Everything here mirrors the Java statics: one shared pixel buffer, one shared
// clip rect, and — deliberately — the ellipse span table (`anIntArray36`) that
// persists across calls and is grown but never cleared. Reads of stale entries
// from a previous shape are part of the client's behaviour, so the table can't
// be reallocated per call.
//
// Coordinates are 12-bit fixed point over the tile (4096 == full width/height);
// each draw call scales them to pixel space with `coord * size >> 12` first.
// The cryogen method numbers are kept in comments so the port can be re-checked
// line-by-line against the source.

/** One entry of an op-29 `shapes` array, as dumped (TextureShapeRasterizerAdapter
 *  serializes every field, so line/bezier carry their constructor's fillColor -1). */
export type RasterShape = {
  shapeType: number
  fillColor: number
  strokeColor: number
  strokeWidth: number
} & Record<string, number>

const imul = Math.imul
const idiv = (a: number, b: number) => (a / b) | 0

// TextureOpRasterizer statics: the buffer rasterized into and the clip rect
// (inclusive bounds — setClipBounds is called with rowEnd/columnEnd).
let rows: Int32Array[] = []
let clipMinX = 0
let clipMaxX = 100
let clipMinY = 0
let clipMaxY = 100

// EllipseRasterizer.anIntArray36 — see the header note on persistence.
let spanTable = new Int32Array(0)

/** EllipseRasterizer.method7170 — growing REPLACES the array (old contents lost),
 *  a smaller request keeps the old array and its stale contents. */
function ensureSpanTable(size: number) {
  if (spanTable.length < size) spanTable = new Int32Array(size)
}

/** LineRasterizer.method4890 — clamp v into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : Math.min(v, hi))

/** JagexArrayUtils.method3922 — fill row[a..b] INCLUSIVE (no-op when a > b). */
function fillSpan(row: Int32Array, a: number, b: number, v: number) {
  for (let x = a; x <= b; x++) row[x] = v
}

// ---------------------------------------------------------------------------
// Lines (LineRasterizer) — strokeWidth is carried but never applied by the client.

/** method13411 — vertical span at column x, [min(y0,y1), max(y0,y1)) EXCLUSIVE. */
function vSpanRaw(x: number, y0: number, y1: number, v: number) {
  if (y0 > y1) {
    for (let y = y1; y < y0; y++) rows[y][x] = v
  } else {
    for (let y = y0; y < y1; y++) rows[y][x] = v
  }
}

/** method12746 */
function vSpanClipped(x: number, y0: number, y1: number, v: number) {
  if (x >= clipMinX && x <= clipMaxX) {
    vSpanRaw(x, clamp(y0, clipMinY, clipMaxY), clamp(y1, clipMinY, clipMaxY), v)
  }
}

/** method568 — horizontal span on row y, endpoints INCLUSIVE. */
function hSpanRaw(x0: number, x1: number, y: number, v: number) {
  if (x0 > x1) fillSpan(rows[y], x1, x0, v)
  else fillSpan(rows[y], x0, x1, v)
}

/** method11250 */
function hSpanClipped(x0: number, x1: number, y: number, v: number) {
  if (y >= clipMinY && y <= clipMaxY) {
    hSpanRaw(clamp(x0, clipMinX, clipMaxX), clamp(x1, clipMinX, clipMaxX), y, v)
  }
}

/** method11220 — unclipped Bresenham, endpoints inclusive. */
function lineRaw(x0: number, y0: number, x1: number, y1: number, v: number) {
  let ax = x0
  let ay = y0
  let bx = x1
  let by = y1
  let dy = by - ay
  let dx = bx - ax
  if (dx === 0) {
    if (dy !== 0) vSpanRaw(ax, ay, by, v)
  } else if (dy === 0) {
    hSpanRaw(ax, bx, ay, v)
  } else {
    if (dy < 0) dy = -dy
    if (dx < 0) dx = -dx
    const steep = dy > dx
    let t: number
    if (steep) {
      t = ax; ax = ay; ay = t
      t = bx; bx = by; by = t
    }
    if (ax > bx) {
      t = ax; ax = bx; bx = t
      t = ay; ay = by; by = t
    }
    let minor = ay
    const run = bx - ax
    let rise = by - ay
    let error = -(run >> 1)
    const step = ay < by ? 1 : -1
    if (rise < 0) rise = -rise
    if (steep) {
      for (let major = ax; major <= bx; major++) {
        rows[major][minor] = v
        error += rise
        if (error > 0) {
          minor += step
          error -= run
        }
      }
    } else {
      for (let major = ax; major <= bx; major++) {
        rows[minor][major] = v
        error += rise
        if (error > 0) {
          minor += step
          error -= run
        }
      }
    }
  }
}

/** method6159 — clip both endpoints against the rect, then Bresenham. */
function lineClipped(x0: number, y0: number, x1: number, y1: number, v: number) {
  const dx = x1 - x0
  const dy = y1 - y0
  if (dx === 0) {
    if (dy !== 0) vSpanClipped(x0, y0, y1, v)
  } else if (dy === 0) {
    hSpanClipped(x0, x1, y0, v)
  } else {
    const slope = idiv(dy << 12, dx)
    const intercept = y0 - ((imul(x0, slope) >> 12) | 0)
    let ay: number
    let ax: number
    if (x0 < clipMinX) {
      ay = ((imul(slope, clipMinX) >> 12) + intercept) | 0
      ax = clipMinX
    } else if (x0 > clipMaxX) {
      ay = ((imul(slope, clipMaxX) >> 12) + intercept) | 0
      ax = clipMaxX
    } else {
      ay = y0
      ax = x0
    }
    let by: number
    let bx: number
    if (x1 < clipMinX) {
      by = ((imul(slope, clipMinX) >> 12) + intercept) | 0
      bx = clipMinX
    } else if (x1 > clipMaxX) {
      by = ((imul(slope, clipMaxX) >> 12) + intercept) | 0
      bx = clipMaxX
    } else {
      by = y1
      bx = x1
    }
    if (ay < clipMinY) {
      ay = clipMinY
      ax = idiv((clipMinY - intercept) << 12, slope)
    } else if (ay > clipMaxY) {
      ay = clipMaxY
      ax = idiv((clipMaxY - intercept) << 12, slope)
    }
    if (by < clipMinY) {
      by = clipMinY
      bx = idiv((clipMinY - intercept) << 12, slope)
    } else if (by > clipMaxY) {
      by = clipMaxY
      bx = idiv((clipMaxY - intercept) << 12, slope)
    }
    lineRaw(ax, ay, bx, by, v)
  }
}

/** LineRasterizer.drawStroked */
function drawLineStroked(s: RasterShape, w: number, h: number) {
  const x0 = imul(s.startX, w) >> 12
  const x1 = imul(s.endX, w) >> 12
  const y0 = imul(h, s.startY) >> 12
  const y1 = imul(h, s.endY) >> 12
  lineClipped(x0, y0, x1, y1, s.strokeColor)
}

// ---------------------------------------------------------------------------
// Bezier curves (BezierCurveRasterizer) — 32 cubic segments joined by lines.

/** method12117 — all control points in bounds: unclipped line segments. */
function bezierRaw(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, v: number) {
  if (x0 === x1 && y1 === y0 && x2 === x3 && y2 === y3) {
    lineRaw(x0, y0, x3, y3, v)
    return
  }
  let px = x0
  let py = y0
  const x0t = x0 * 3
  const y0t = y0 * 3
  const x1t = x1 * 3
  const y1t = y1 * 3
  const x2t = x2 * 3
  const y2t = y2 * 3
  const cx3 = x3 - x2t + x1t - x0
  const cy3 = y1t + (y3 - y2t) - y0
  const cx2 = x0t + (x2t - x1t - x1t)
  const cy2 = y0t + (y2t - y1t - y1t)
  const cx1 = x1t - x0t
  const cy1 = y1t - y0t
  for (let t = 128; t <= 4096; t += 128) {
    const t2 = imul(t, t) >> 12
    const t3 = imul(t2, t) >> 12
    const nx = x0 + ((imul(cx2, t2) + imul(cx3, t3) + imul(cx1, t)) >> 12)
    const ny = ((imul(cy3, t3) + imul(cy2, t2) + imul(cy1, t)) >> 12) + y0
    lineRaw(px, py, nx, ny, v)
    px = nx
    py = ny
  }
}

/** method4779 — some control point out of bounds: clipped line segments. */
function bezierClipped(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, v: number) {
  if (x0 === x1 && y1 === y0 && x2 === x3 && y2 === y3) {
    lineClipped(x0, y0, x3, y3, v)
    return
  }
  let px = x0
  let py = y0
  const x0t = x0 * 3
  const y0t = y0 * 3
  const x1t = x1 * 3
  const y1t = y1 * 3
  const x2t = x2 * 3
  const y2t = y2 * 3
  const cx3 = x3 - x2t + x1t - x0
  const cy3 = y1t + (y3 - y2t) - y0
  const cx2 = x0t + (x2t - x1t - x1t)
  const cy2 = y0t + (y2t - y1t - y1t)
  const cx1 = x1t - x0t
  const cy1 = y1t - y0t
  for (let t = 128; t <= 4096; t += 128) {
    const t2 = imul(t, t) >> 12
    const t3 = imul(t, t2) >> 12
    const nx = x0 + ((imul(cx2, t2) + imul(cx3, t3) + imul(cx1, t)) >> 12)
    const ny = ((imul(cy2, t2) + imul(cy3, t3) + imul(cy1, t)) >> 12) + y0
    lineClipped(px, py, nx, ny, v)
    px = nx
    py = ny
  }
}

/** BezierCurveRasterizer.drawStroked → method12399 */
function drawBezierStroked(s: RasterShape, w: number, h: number) {
  const x0 = imul(s.controlX0, w) >> 12
  const y0 = imul(h, s.controlY0) >> 12
  const x1 = imul(s.controlX1, w) >> 12
  const y1 = imul(h, s.controlY1) >> 12
  const x2 = imul(s.controlX2, w) >> 12
  const y2 = imul(h, s.controlY2) >> 12
  const x3 = imul(s.controlX3, w) >> 12
  const y3 = imul(h, s.controlY3) >> 12
  const inBounds =
    x0 >= clipMinX && x0 <= clipMaxX && x1 >= clipMinX && x1 <= clipMaxX &&
    x2 >= clipMinX && x2 <= clipMaxX && x3 >= clipMinX && x3 <= clipMaxX &&
    y0 >= clipMinY && y0 <= clipMaxY && y1 >= clipMinY && y1 <= clipMaxY &&
    y2 >= clipMinY && y2 <= clipMaxY && y3 >= clipMinY && y3 <= clipMaxY
  if (inBounds) bezierRaw(x0, y0, x1, y1, x2, y2, x3, y3, s.strokeColor)
  else bezierClipped(x0, y0, x1, y1, x2, y2, x3, y3, s.strokeColor)
}

// ---------------------------------------------------------------------------
// Rectangles (RectangleRasterizer)

/** method14572 — 1px outline, fully in bounds. */
function rectOutline1Raw(x0: number, x1: number, y0: number, y1: number, v: number) {
  fillSpan(rows[y0++], x0, x1, v)
  fillSpan(rows[y1--], x0, x1, v)
  for (let y = y0; y <= y1; y++) {
    const row = rows[y]
    row[x0] = row[x1] = v
  }
}

/** method4561 — thick outline, fully in bounds. */
function rectOutlineRaw(x0: number, x1: number, y0: number, y1: number, v: number, width: number) {
  const yTop = width + y0
  const yBottom = y1 - width
  for (let y = y0; y < yTop; y++) fillSpan(rows[y], x0, x1, v)
  for (let y = y1; y > yBottom; --y) fillSpan(rows[y], x0, x1, v)
  const xLeft = width + x0
  const xRight = x1 - width
  for (let y = yTop; y <= yBottom; y++) {
    const row = rows[y]
    fillSpan(row, x0, xLeft, v)
    fillSpan(row, xRight, x1, v)
  }
}

/** method1388 — 1px outline, clipped. */
function rectOutline1Clipped(x0: number, x1: number, y0: number, y1: number, v: number) {
  let ax = x0
  let bx = x1
  let ay = y0
  let by = y1
  if (ay <= clipMaxY && by >= clipMinY) {
    let leftIn: boolean
    if (ax < clipMinX) {
      ax = clipMinX
      leftIn = false
    } else if (ax > clipMaxX) {
      ax = clipMaxX
      leftIn = false
    } else {
      leftIn = true
    }
    let rightIn: boolean
    if (bx < clipMinX) {
      bx = clipMinX
      rightIn = false
    } else if (bx > clipMaxX) {
      bx = clipMaxX
      rightIn = false
    } else {
      rightIn = true
    }
    if (ay >= clipMinY) fillSpan(rows[ay++], ax, bx, v)
    else ay = clipMinY
    if (by <= clipMaxY) fillSpan(rows[by--], ax, bx, v)
    else by = clipMaxY
    if (leftIn && rightIn) {
      for (let y = ay; y <= by; y++) {
        const row = rows[y]
        row[ax] = row[bx] = v
      }
    } else if (leftIn) {
      for (let y = ay; y <= by; y++) rows[y][ax] = v
    } else if (rightIn) {
      for (let y = ay; y <= by; y++) rows[y][bx] = v
    }
  }
}

/** method744 — thick outline, clipped. */
function rectOutlineClipped(x0: number, x1: number, y0: number, y1: number, v: number, width: number) {
  const ay = clamp(y0, clipMinY, clipMaxY)
  const by = clamp(y1, clipMinY, clipMaxY)
  const ax = clamp(x0, clipMinX, clipMaxX)
  const bx = clamp(x1, clipMinX, clipMaxX)
  const yTop = clamp(width + y0, clipMinY, clipMaxY)
  const yBottom = clamp(y1 - width, clipMinY, clipMaxY)
  for (let y = ay; y < yTop; y++) fillSpan(rows[y], ax, bx, v)
  for (let y = by; y > yBottom; --y) fillSpan(rows[y], ax, bx, v)
  const xLeft = clamp(width + x0, clipMinX, clipMaxX)
  const xRight = clamp(x1 - width, clipMinX, clipMaxX)
  for (let y = yTop; y <= yBottom; y++) {
    const row = rows[y]
    fillSpan(row, ax, xLeft, v)
    fillSpan(row, xRight, bx, v)
  }
}

/** method1564 — solid fill, fully in bounds. */
function rectFillRaw(x0: number, x1: number, y0: number, y1: number, v: number) {
  for (let y = y0; y <= y1; y++) fillSpan(rows[y], x0, x1, v)
}

/** method7728 — solid fill, clipped. */
function rectFillClipped(x0: number, x1: number, y0: number, y1: number, v: number) {
  const ay = clamp(y0, clipMinY, clipMaxY)
  const by = clamp(y1, clipMinY, clipMaxY)
  const ax = clamp(x0, clipMinX, clipMaxX)
  const bx = clamp(x1, clipMinX, clipMaxX)
  for (let y = ay; y <= by; y++) fillSpan(rows[y], ax, bx, v)
}

/** method3230 — fill + stroke, fully in bounds. */
function rectFillStrokeRaw(x0: number, x1: number, y0: number, y1: number, fill: number, stroke: number, width: number) {
  const yTop = y0 + width
  const yBottom = y1 - width
  for (let y = y0; y < yTop; y++) fillSpan(rows[y], x0, x1, stroke)
  for (let y = y1; y > yBottom; --y) fillSpan(rows[y], x0, x1, stroke)
  const xLeft = x0 + width
  const xRight = x1 - width
  for (let y = yTop; y <= yBottom; y++) {
    const row = rows[y]
    fillSpan(row, x0, xLeft, stroke)
    fillSpan(row, xLeft, xRight, fill)
    fillSpan(row, xRight, x1, stroke)
  }
}

/** method4034 — fill + stroke, clipped. */
function rectFillStrokeClipped(x0: number, x1: number, y0: number, y1: number, fill: number, stroke: number, width: number) {
  const ay = clamp(y0, clipMinY, clipMaxY)
  const by = clamp(y1, clipMinY, clipMaxY)
  const ax = clamp(x0, clipMinX, clipMaxX)
  const bx = clamp(x1, clipMinX, clipMaxX)
  const yTop = clamp(y0 + width, clipMinY, clipMaxY)
  const yBottom = clamp(y1 - width, clipMinY, clipMaxY)
  for (let y = ay; y < yTop; y++) fillSpan(rows[y], ax, bx, stroke)
  for (let y = by; y > yBottom; --y) fillSpan(rows[y], ax, bx, stroke)
  const xLeft = clamp(x0 + width, clipMinX, clipMaxX)
  const xRight = clamp(x1 - width, clipMinX, clipMaxX)
  for (let y = yTop; y <= yBottom; y++) {
    const row = rows[y]
    fillSpan(row, ax, xLeft, stroke)
    fillSpan(row, xLeft, xRight, fill)
    fillSpan(row, xRight, bx, stroke)
  }
}

function rectCorners(s: RasterShape, w: number, h: number) {
  return [imul(s.left, w) >> 12, imul(s.right, w) >> 12, imul(h, s.top) >> 12, imul(h, s.bottom) >> 12] as const
}

const rectInBounds = (x0: number, x1: number, y0: number, y1: number) =>
  x0 >= clipMinX && x1 <= clipMaxX && y0 >= clipMinY && y1 <= clipMaxY

/** RectangleRasterizer.drawStroked → method1805 */
function drawRectStroked(s: RasterShape, w: number, h: number) {
  const [x0, x1, y0, y1] = rectCorners(s, w, h)
  if (rectInBounds(x0, x1, y0, y1)) {
    if (s.strokeWidth === 1) rectOutline1Raw(x0, x1, y0, y1, s.strokeColor)
    else rectOutlineRaw(x0, x1, y0, y1, s.strokeColor, s.strokeWidth)
  } else if (s.strokeWidth === 1) {
    rectOutline1Clipped(x0, x1, y0, y1, s.strokeColor)
  } else {
    rectOutlineClipped(x0, x1, y0, y1, s.strokeColor, s.strokeWidth)
  }
}

/** RectangleRasterizer.drawFilled → method6772 */
function drawRectFilled(s: RasterShape, w: number, h: number) {
  const [x0, x1, y0, y1] = rectCorners(s, w, h)
  if (rectInBounds(x0, x1, y0, y1)) rectFillRaw(x0, x1, y0, y1, s.fillColor)
  else rectFillClipped(x0, x1, y0, y1, s.fillColor)
}

/** RectangleRasterizer.drawFilledAndStroked → method6731 */
function drawRectFilledStroked(s: RasterShape, w: number, h: number) {
  const [x0, x1, y0, y1] = rectCorners(s, w, h)
  if (rectInBounds(x0, x1, y0, y1)) rectFillStrokeRaw(x0, x1, y0, y1, s.fillColor, s.strokeColor, s.strokeWidth)
  else rectFillStrokeClipped(x0, x1, y0, y1, s.fillColor, s.strokeColor, s.strokeWidth)
}

// ---------------------------------------------------------------------------
// Ellipses (EllipseRasterizer). Circles (rx == ry after scaling) take a midpoint-
// circle path; true ellipses use a Bresenham-style dual-decision-variable walk.
// The decision-variable updates are opaque deob output — kept verbatim.

/** method813 — filled circle, fully in bounds. */
function circleFillRaw(cx: number, cy: number, r: number, v: number) {
  let dx = 0
  let dy = r
  let err = -r
  let acc = -1
  fillSpan(rows[cy], cx - r, cx + r, v)
  while (dy > dx) {
    acc += 2
    err += acc
    ++dx
    if (err >= 0) {
      --dy
      err -= dy << 1
      const below = rows[dy + cy]
      const above = rows[cy - dy]
      const xr = cx + dx
      const xl = cx - dx
      fillSpan(below, xl, xr, v)
      fillSpan(above, xl, xr, v)
    }
    const xr = cx + dy
    const xl = cx - dy
    const lower = rows[dx + cy]
    const upper = rows[cy - dx]
    fillSpan(lower, xl, xr, v)
    fillSpan(upper, xl, xr, v)
  }
}

/** method4866 — filled circle, clipped. */
function circleFillClipped(cx: number, cy: number, r: number, v: number) {
  let dx = 0
  let dy = r
  let err = -r
  let acc = -1
  const xr0 = clamp(cx + r, clipMinX, clipMaxX)
  const xl0 = clamp(cx - r, clipMinX, clipMaxX)
  fillSpan(rows[cy], xl0, xr0, v)
  while (dy > dx) {
    acc += 2
    err += acc
    if (err > 0) {
      --dy
      err -= dy << 1
      const yUp = cy - dy
      const yDown = dy + cy
      if (yDown >= clipMinY && yUp <= clipMaxY) {
        const xr = clamp(cx + dx, clipMinX, clipMaxX)
        const xl = clamp(cx - dx, clipMinX, clipMaxX)
        if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, v)
        if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, v)
      }
    }
    ++dx
    const yUp = cy - dx
    const yDown = dx + cy
    if (yDown >= clipMinY && yUp <= clipMaxY) {
      const xr = clamp(cx + dy, clipMinX, clipMaxX)
      const xl = clamp(cx - dy, clipMinX, clipMaxX)
      if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, v)
      if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, v)
    }
  }
}

/** method6292 — filled circle dispatch. */
function circleFill(cx: number, cy: number, r: number, v: number) {
  if (cx - r >= clipMinX && cx + r <= clipMaxX && cy - r >= clipMinY && r + cy <= clipMaxY) {
    circleFillRaw(cx, cy, r, v)
  } else {
    circleFillClipped(cx, cy, r, v)
  }
}

/** method3751 — filled ellipse, fully in bounds. */
function ellipseFillRaw(cx: number, cy: number, rx: number, ry: number, v: number) {
  let dx = 0
  let dy = ry
  const rx2 = imul(rx, rx)
  const ry2 = imul(ry, ry)
  const ry2x2 = ry2 << 1
  const rx2x2 = rx2 << 1
  const ryx2 = ry << 1
  let d1 = (ry2x2 + imul(1 - ryx2, rx2)) | 0
  let d2 = (ry2 - imul(rx2x2, ryx2 - 1)) | 0
  const rx2x4 = rx2 << 2
  const ry2x4 = ry2 << 2
  let s1 = imul((dx << 1) + 3, ry2x2)
  let s2 = imul((ry << 1) - 3, rx2x2)
  let s3 = imul(ry2x4, dx + 1)
  let s4 = imul(rx2x4, ry - 1)
  fillSpan(rows[cy], cx - rx, cx + rx, v)
  while (dy > 0) {
    if (d1 < 0) {
      while (d1 < 0) {
        d1 = (d1 + s1) | 0
        d2 = (d2 + s3) | 0
        s1 = (s1 + ry2x4) | 0
        s3 = (s3 + ry2x4) | 0
        ++dx
      }
    }
    if (d2 < 0) {
      d1 = (d1 + s1) | 0
      d2 = (d2 + s3) | 0
      s1 = (s1 + ry2x4) | 0
      s3 = (s3 + ry2x4) | 0
      ++dx
    }
    d1 = (d1 - s4) | 0
    d2 = (d2 - s2) | 0
    s2 = (s2 - rx2x4) | 0
    s4 = (s4 - rx2x4) | 0
    --dy
    const yUp = cy - dy
    const yDown = dy + cy
    const xr = cx + dx
    const xl = cx - dx
    fillSpan(rows[yUp], xl, xr, v)
    fillSpan(rows[yDown], xl, xr, v)
  }
}

/** method15405 — filled ellipse, clipped. */
function ellipseFillClipped(cx: number, cy: number, rx: number, ry: number, v: number) {
  let dx = 0
  let dy = ry
  const rx2 = imul(rx, rx)
  const ry2 = imul(ry, ry)
  const ry2x2 = ry2 << 1
  const rx2x2 = rx2 << 1
  const ryx2 = ry << 1
  let d1 = (ry2x2 + imul(1 - ryx2, rx2)) | 0
  let d2 = (ry2 - imul(rx2x2, ryx2 - 1)) | 0
  const rx2x4 = rx2 << 2
  const ry2x4 = ry2 << 2
  let s1 = imul((dx << 1) + 3, ry2x2)
  let s2 = imul((ry << 1) - 3, rx2x2)
  let s3 = imul(ry2x4, dx + 1)
  let s4 = imul(rx2x4, ry - 1)
  if (cy >= clipMinY && cy <= clipMaxY) {
    const xr = clamp(cx + rx, clipMinX, clipMaxX)
    const xl = clamp(cx - rx, clipMinX, clipMaxX)
    fillSpan(rows[cy], xl, xr, v)
  }
  while (dy > 0) {
    if (d1 < 0) {
      while (d1 < 0) {
        d1 = (d1 + s1) | 0
        d2 = (d2 + s3) | 0
        s1 = (s1 + ry2x4) | 0
        s3 = (s3 + ry2x4) | 0
        ++dx
      }
    }
    if (d2 < 0) {
      d1 = (d1 + s1) | 0
      d2 = (d2 + s3) | 0
      s1 = (s1 + ry2x4) | 0
      s3 = (s3 + ry2x4) | 0
      ++dx
    }
    d1 = (d1 - s4) | 0
    d2 = (d2 - s2) | 0
    s2 = (s2 - rx2x4) | 0
    s4 = (s4 - rx2x4) | 0
    --dy
    const yUp = cy - dy
    const yDown = dy + cy
    if (yDown >= clipMinY && yUp <= clipMaxY) {
      const xr = clamp(cx + dx, clipMinX, clipMaxX)
      const xl = clamp(cx - dx, clipMinX, clipMaxX)
      if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, v)
      if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, v)
    }
  }
}

/** method2637 — circle fill + stroke, fully in bounds. */
function circleFillStrokeRaw(cx: number, cy: number, r: number, fill: number, stroke: number, width: number) {
  ensureSpanTable(r)
  let dx = 0
  let rInner = r - width
  if (rInner < 0) rInner = 0
  let dy = r
  let errOuter = -r
  let dyInner = rInner
  let errInner = -rInner
  let accOuter = -1
  let accInner = -1
  const centerRow = rows[cy]
  const xlIn = cx - rInner
  const xrIn = cx + rInner
  fillSpan(centerRow, cx - r, xlIn, stroke)
  fillSpan(centerRow, xlIn, xrIn, fill)
  fillSpan(centerRow, xrIn, cx + r, stroke)
  while (dy > dx) {
    accOuter += 2
    accInner += 2
    errOuter += accOuter
    errInner += accInner
    if (errInner >= 0 && dyInner >= 1) {
      spanTable[dyInner] = dx
      --dyInner
      errInner -= dyInner << 1
    }
    ++dx
    if (errOuter >= 0) {
      --dy
      errOuter -= dy << 1
      if (dy >= rInner) {
        const below = rows[dy + cy]
        const above = rows[cy - dy]
        const xr = cx + dx
        const xl = cx - dx
        fillSpan(below, xl, xr, stroke)
        fillSpan(above, xl, xr, stroke)
      } else {
        const below = rows[dy + cy]
        const above = rows[cy - dy]
        const inner = spanTable[dy]
        const xr = cx + dx
        const xl = cx - dx
        const xri = cx + inner
        const xli = cx - inner
        fillSpan(below, xl, xli, stroke)
        fillSpan(below, xli, xri, fill)
        fillSpan(below, xri, xr, stroke)
        fillSpan(above, xl, xli, stroke)
        fillSpan(above, xli, xri, fill)
        fillSpan(above, xri, xr, stroke)
      }
    }
    const lower = rows[dx + cy]
    const upper = rows[cy - dx]
    const xr = cx + dy
    const xl = cx - dy
    if (dx < rInner) {
      const inner = dyInner < dx ? spanTable[dx] : dyInner
      const xri = cx + inner
      const xli = cx - inner
      fillSpan(lower, xl, xli, stroke)
      fillSpan(lower, xli, xri, fill)
      fillSpan(lower, xri, xr, stroke)
      fillSpan(upper, xl, xli, stroke)
      fillSpan(upper, xli, xri, fill)
      fillSpan(upper, xri, xr, stroke)
    } else {
      fillSpan(lower, xl, xr, stroke)
      fillSpan(upper, xl, xr, stroke)
    }
  }
}

/** method1174 — circle fill + stroke, clipped. NOTE: unlike the raw variant, the
 *  span table is written at the DECREMENTED index — that asymmetry is in the client. */
function circleFillStrokeClipped(cx: number, cy: number, r: number, fill: number, stroke: number, width: number) {
  ensureSpanTable(r)
  let dx = 0
  let rInner = r - width
  if (rInner < 0) rInner = 0
  let dy = r
  let errOuter = -r
  let dyInner = rInner
  let errInner = -rInner
  let accOuter = -1
  let accInner = -1
  if (cy >= clipMinY && cy <= clipMaxY) {
    const centerRow = rows[cy]
    const xl = clamp(cx - r, clipMinX, clipMaxX)
    const xr = clamp(cx + r, clipMinX, clipMaxX)
    const xli = clamp(cx - rInner, clipMinX, clipMaxX)
    const xri = clamp(cx + rInner, clipMinX, clipMaxX)
    fillSpan(centerRow, xl, xli, stroke)
    fillSpan(centerRow, xli, xri, fill)
    fillSpan(centerRow, xri, xr, stroke)
  }
  while (dy > dx) {
    accOuter += 2
    accInner += 2
    errOuter += accOuter
    errInner += accInner
    if (errInner >= 0 && dyInner >= 1) {
      --dyInner
      errInner -= dyInner << 1
      spanTable[dyInner] = dx
    }
    ++dx
    if (errOuter >= 0) {
      --dy
      errOuter -= dy << 1
      const yUp = cy - dy
      const yDown = dy + cy
      if (yDown >= clipMinY && yUp <= clipMaxY) {
        if (dy >= rInner) {
          const xr = clamp(cx + dx, clipMinX, clipMaxX)
          const xl = clamp(cx - dx, clipMinX, clipMaxX)
          if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, stroke)
          if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, stroke)
        } else {
          const inner = spanTable[dy]
          const xr = clamp(cx + dx, clipMinX, clipMaxX)
          const xl = clamp(cx - dx, clipMinX, clipMaxX)
          const xri = clamp(cx + inner, clipMinX, clipMaxX)
          const xli = clamp(cx - inner, clipMinX, clipMaxX)
          if (yDown <= clipMaxY) {
            const row = rows[yDown]
            fillSpan(row, xl, xli, stroke)
            fillSpan(row, xli, xri, fill)
            fillSpan(row, xri, xr, stroke)
          }
          if (yUp >= clipMinY) {
            const row = rows[yUp]
            fillSpan(row, xl, xli, stroke)
            fillSpan(row, xli, xri, fill)
            fillSpan(row, xri, xr, stroke)
          }
        }
      }
    }
    const yUp = cy - dx
    const yDown = dx + cy
    if (yDown >= clipMinY && yUp <= clipMaxY) {
      let xr = cx + dy
      let xl = cx - dy
      if (xr >= clipMinX && xl <= clipMaxX) {
        xr = clamp(xr, clipMinX, clipMaxX)
        xl = clamp(xl, clipMinX, clipMaxX)
        if (dx < rInner) {
          const inner = dyInner < dx ? spanTable[dx] : dyInner
          const xri = clamp(cx + inner, clipMinX, clipMaxX)
          const xli = clamp(cx - inner, clipMinX, clipMaxX)
          if (yDown <= clipMaxY) {
            const row = rows[yDown]
            fillSpan(row, xl, xli, stroke)
            fillSpan(row, xli, xri, fill)
            fillSpan(row, xri, xr, stroke)
          }
          if (yUp >= clipMinY) {
            const row = rows[yUp]
            fillSpan(row, xl, xli, stroke)
            fillSpan(row, xli, xri, fill)
            fillSpan(row, xri, xr, stroke)
          }
        } else {
          if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, stroke)
          if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, stroke)
        }
      }
    }
  }
}

/** method12838 — circle fill + stroke dispatch. */
function circleFillStroke(cx: number, cy: number, r: number, fill: number, stroke: number, width: number) {
  if (cx - r >= clipMinX && cx + r <= clipMaxX && cy - r >= clipMinY && r + cy <= clipMaxY) {
    circleFillStrokeRaw(cx, cy, r, fill, stroke, width)
  } else {
    circleFillStrokeClipped(cx, cy, r, fill, stroke, width)
  }
}

/** method15241 — ellipse fill + stroke, fully in bounds. Walks the outer and inner
 *  ellipses simultaneously with two sets of decision variables. */
function ellipseFillStrokeRaw(cx: number, cy: number, rx: number, ry: number, fill: number, stroke: number, width: number) {
  let dxOut = 0
  let dy = ry
  let dxIn = 0
  const rxi = rx - width
  const ryi = ry - width
  const rx2 = imul(rx, rx)
  const ry2 = imul(ry, ry)
  const rxi2 = imul(rxi, rxi)
  const ryi2 = imul(ryi, ryi)
  const ry2x2 = ry2 << 1
  const rx2x2 = rx2 << 1
  const ryi2x2 = ryi2 << 1
  const rxi2x2 = rxi2 << 1
  const ryx2 = ry << 1
  const ryix2 = ryi << 1
  let d1 = (ry2x2 + imul(1 - ryx2, rx2)) | 0
  let d2 = (ry2 - imul(rx2x2, ryx2 - 1)) | 0
  let d1i = (ryi2x2 + imul(1 - ryix2, rxi2)) | 0
  let d2i = (ryi2 - imul(rxi2x2, ryix2 - 1)) | 0
  const rx2x4 = rx2 << 2
  const ry2x4 = ry2 << 2
  const rxi2x4 = rxi2 << 2
  const ryi2x4 = ryi2 << 2
  let s1 = imul(ry2x2, 3)
  let s2 = imul(rx2x2, ryx2 - 3)
  let s1i = imul(ryi2x2, 3)
  let s2i = imul(rxi2x2, ryix2 - 3)
  let s3 = ry2x4
  let s4 = imul(ry - 1, rx2x4)
  let s3i = ryi2x4
  let s4i = imul(rxi2x4, ryi - 1)
  const centerRow = rows[cy]
  fillSpan(centerRow, cx - rx, cx - rxi, stroke)
  fillSpan(centerRow, cx - rxi, cx + rxi, fill)
  fillSpan(centerRow, cx + rxi, cx + rx, stroke)

  while (dy > 0) {
    const innerActive = dy <= ryi
    if (innerActive) {
      if (d1i < 0) {
        while (d1i < 0) {
          d1i = (d1i + s1i) | 0
          d2i = (d2i + s3i) | 0
          s1i = (s1i + ryi2x4) | 0
          s3i = (s3i + ryi2x4) | 0
          ++dxIn
        }
      }
      if (d2i < 0) {
        d1i = (d1i + s1i) | 0
        d2i = (d2i + s3i) | 0
        s1i = (s1i + ryi2x4) | 0
        s3i = (s3i + ryi2x4) | 0
        ++dxIn
      }
      d1i = (d1i - s4i) | 0
      d2i = (d2i - s2i) | 0
      s2i = (s2i - rxi2x4) | 0
      s4i = (s4i - rxi2x4) | 0
    }
    if (d1 < 0) {
      while (d1 < 0) {
        d1 = (d1 + s1) | 0
        d2 = (d2 + s3) | 0
        s1 = (s1 + ry2x4) | 0
        s3 = (s3 + ry2x4) | 0
        ++dxOut
      }
    }
    if (d2 < 0) {
      d1 = (d1 + s1) | 0
      d2 = (d2 + s3) | 0
      s1 = (s1 + ry2x4) | 0
      s3 = (s3 + ry2x4) | 0
      ++dxOut
    }
    d1 = (d1 - s4) | 0
    d2 = (d2 - s2) | 0
    s2 = (s2 - rx2x4) | 0
    s4 = (s4 - rx2x4) | 0
    --dy
    const yUp = cy - dy
    const yDown = dy + cy
    const xr = cx + dxOut
    const xl = cx - dxOut
    if (innerActive) {
      const xri = cx + dxIn
      const xli = cx - dxIn
      fillSpan(rows[yUp], xl, xli, stroke)
      fillSpan(rows[yUp], xli, xri, fill)
      fillSpan(rows[yUp], xri, xr, stroke)
      fillSpan(rows[yDown], xl, xli, stroke)
      fillSpan(rows[yDown], xli, xri, fill)
      fillSpan(rows[yDown], xri, xr, stroke)
    } else {
      fillSpan(rows[yUp], xl, xr, stroke)
      fillSpan(rows[yDown], xl, xr, stroke)
    }
  }
}

/** method6824 — ellipse fill + stroke, clipped. */
function ellipseFillStrokeClipped(cx: number, cy: number, rx: number, ry: number, fill: number, stroke: number, width: number) {
  let dxOut = 0
  let dy = ry
  let dxIn = 0
  const rxi = rx - width
  const ryi = ry - width
  const rx2 = imul(rx, rx)
  const ry2 = imul(ry, ry)
  const rxi2 = imul(rxi, rxi)
  const ryi2 = imul(ryi, ryi)
  const ry2x2 = ry2 << 1
  const rx2x2 = rx2 << 1
  const ryi2x2 = ryi2 << 1
  const rxi2x2 = rxi2 << 1
  const ryx2 = ry << 1
  const ryix2 = ryi << 1
  let d1 = (ry2x2 + imul(1 - ryx2, rx2)) | 0
  let d2 = (ry2 - imul(rx2x2, ryx2 - 1)) | 0
  let d1i = (ryi2x2 + imul(1 - ryix2, rxi2)) | 0
  let d2i = (ryi2 - imul(rxi2x2, ryix2 - 1)) | 0
  const rx2x4 = rx2 << 2
  const ry2x4 = ry2 << 2
  const rxi2x4 = rxi2 << 2
  const ryi2x4 = ryi2 << 2
  let s1 = imul(ry2x2, 3)
  let s2 = imul(rx2x2, ryx2 - 3)
  let s1i = imul(ryi2x2, 3)
  let s2i = imul(rxi2x2, ryix2 - 3)
  let s3 = ry2x4
  let s4 = imul(ry - 1, rx2x4)
  let s3i = ryi2x4
  let s4i = imul(rxi2x4, ryi - 1)
  if (cy >= clipMinY && cy <= clipMaxY) {
    const centerRow = rows[cy]
    const xl = clamp(cx - rx, clipMinX, clipMaxX)
    const xr = clamp(cx + rx, clipMinX, clipMaxX)
    const xli = clamp(cx - rxi, clipMinX, clipMaxX)
    const xri = clamp(cx + rxi, clipMinX, clipMaxX)
    fillSpan(centerRow, xl, xli, stroke)
    fillSpan(centerRow, xli, xri, fill)
    fillSpan(centerRow, xri, xr, stroke)
  }

  while (dy > 0) {
    const innerActive = dy <= ryi
    if (innerActive) {
      if (d1i < 0) {
        while (d1i < 0) {
          d1i = (d1i + s1i) | 0
          d2i = (d2i + s3i) | 0
          s1i = (s1i + ryi2x4) | 0
          s3i = (s3i + ryi2x4) | 0
          ++dxIn
        }
      }
      if (d2i < 0) {
        d1i = (d1i + s1i) | 0
        d2i = (d2i + s3i) | 0
        s1i = (s1i + ryi2x4) | 0
        s3i = (s3i + ryi2x4) | 0
        ++dxIn
      }
      d1i = (d1i - s4i) | 0
      d2i = (d2i - s2i) | 0
      s2i = (s2i - rxi2x4) | 0
      s4i = (s4i - rxi2x4) | 0
    }
    if (d1 < 0) {
      while (d1 < 0) {
        d1 = (d1 + s1) | 0
        d2 = (d2 + s3) | 0
        s1 = (s1 + ry2x4) | 0
        s3 = (s3 + ry2x4) | 0
        ++dxOut
      }
    }
    if (d2 < 0) {
      d1 = (d1 + s1) | 0
      d2 = (d2 + s3) | 0
      s1 = (s1 + ry2x4) | 0
      s3 = (s3 + ry2x4) | 0
      ++dxOut
    }
    d1 = (d1 - s4) | 0
    d2 = (d2 - s2) | 0
    s2 = (s2 - rx2x4) | 0
    s4 = (s4 - rx2x4) | 0
    --dy
    const yUp = cy - dy
    const yDown = dy + cy
    if (yDown >= clipMinY && yUp <= clipMaxY) {
      const xr = clamp(cx + dxOut, clipMinX, clipMaxX)
      const xl = clamp(cx - dxOut, clipMinX, clipMaxX)
      if (innerActive) {
        const xri = clamp(cx + dxIn, clipMinX, clipMaxX)
        const xli = clamp(cx - dxIn, clipMinX, clipMaxX)
        if (yUp >= clipMinY) {
          const row = rows[yUp]
          fillSpan(row, xl, xli, stroke)
          fillSpan(row, xli, xri, fill)
          fillSpan(row, xri, xr, stroke)
        }
        if (yDown <= clipMaxY) {
          const row = rows[yDown]
          fillSpan(row, xl, xli, stroke)
          fillSpan(row, xli, xri, fill)
          fillSpan(row, xri, xr, stroke)
        }
      } else {
        if (yUp >= clipMinY) fillSpan(rows[yUp], xl, xr, stroke)
        if (yDown <= clipMaxY) fillSpan(rows[yDown], xl, xr, stroke)
      }
    }
  }
}

function ellipseParams(s: RasterShape, w: number, h: number) {
  return [imul(s.centerX, w) >> 12, imul(h, s.centerY) >> 12, imul(s.radiusX, w) >> 12, imul(h, s.radiusY) >> 12] as const
}

/** EllipseRasterizer.drawFilled → method14584 */
function drawEllipseFilled(s: RasterShape, w: number, h: number) {
  const [cx, cy, rx, ry] = ellipseParams(s, w, h)
  if (ry === rx) {
    circleFill(cx, cy, rx, s.fillColor)
  } else if (cx - rx >= clipMinX && cx + rx <= clipMaxX && cy - ry >= clipMinY && ry + cy <= clipMaxY) {
    ellipseFillRaw(cx, cy, rx, ry, s.fillColor)
  } else {
    ellipseFillClipped(cx, cy, rx, ry, s.fillColor)
  }
}

/** EllipseRasterizer.drawFilledAndStroked → method5316 */
function drawEllipseFilledStroked(s: RasterShape, w: number, h: number) {
  const [cx, cy, rx, ry] = ellipseParams(s, w, h)
  if (ry === rx) {
    circleFillStroke(cx, cy, rx, s.fillColor, s.strokeColor, s.strokeWidth)
  } else if (cx - rx >= clipMinX && cx + rx <= clipMaxX && cy - ry >= clipMinY && ry + cy <= clipMaxY) {
    ellipseFillStrokeRaw(cx, cy, rx, ry, s.fillColor, s.strokeColor, s.strokeWidth)
  } else {
    ellipseFillStrokeClipped(cx, cy, rx, ry, s.fillColor, s.strokeColor, s.strokeWidth)
  }
}

// ---------------------------------------------------------------------------

const LINE = 0
const BEZIER = 1
const RECTANGLE = 2
const ELLIPSE = 3

/** TextureOpRasterizer.rasterizeShapes — draw every shape into `target`, in order.
 *  Line and bezier have no filled form (their drawFilled/drawFilledAndStroked are
 *  empty in the client), and ellipse has no stroke-only form. */
export function rasterizeShapes(shapes: RasterShape[], target: Int32Array[], width: number, height: number) {
  rows = target
  clipMinX = 0
  clipMaxX = width - 1
  clipMinY = 0
  clipMaxY = height - 1
  for (const s of shapes) {
    const filled = s.fillColor >= 0
    const stroked = s.strokeColor >= 0
    if (filled && stroked) {
      if (s.shapeType === RECTANGLE) drawRectFilledStroked(s, width, height)
      else if (s.shapeType === ELLIPSE) drawEllipseFilledStroked(s, width, height)
    } else if (filled) {
      if (s.shapeType === RECTANGLE) drawRectFilled(s, width, height)
      else if (s.shapeType === ELLIPSE) drawEllipseFilled(s, width, height)
    } else if (stroked) {
      if (s.shapeType === LINE) drawLineStroked(s, width, height)
      else if (s.shapeType === BEZIER) drawBezierStroked(s, width, height)
      else if (s.shapeType === RECTANGLE) drawRectStroked(s, width, height)
    }
  }
  rows = []
}
