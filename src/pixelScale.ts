/**
 * Cache art is 1px-detail art: font glyphs are single-pixel strokes with a
 * single-pixel shadow, borders are 1px, sprite outlines are 1px. Any time a
 * canvas is shown at less than 1 device pixel per drawn pixel, those features
 * don't shrink — they're DELETED, and the text becomes unreadable.
 *
 * That happens for two different reasons, so both are handled here.
 *
 * 1. WE downscale: sizing a buffer by `devicePixelRatio` looks right at DPR 2,
 *    but browser page zoom folds into devicePixelRatio — at 90% zoom it's 0.9,
 *    so `canvas.width = w * dpr` renders the whole frame into a SMALLER buffer
 *    and the strokes are gone before the browser ever sees them. Never render
 *    below 1×: `renderScale()`.
 *
 * 2. The BROWSER downscales: below 100% zoom there are physically fewer device
 *    pixels than CSS pixels, so a 1:1 buffer still has to be squeezed for
 *    display. That's unavoidable — but `image-rendering: pixelated` makes the
 *    browser drop columns outright, while filtered scaling blurs them and every
 *    stroke still contributes something. `watchPixelScale()` marks the root
 *    element while zoomed out so the global CSS rule can switch to filtering.
 */

/** Buffer scale for a pixel-art canvas — the device ratio, but never under 1. */
export function renderScale(): number {
  return Math.max(1, window.devicePixelRatio || 1)
}

/**
 * Size a 2D canvas for pixel-exact drawing at `logicalW × logicalH` and return
 * its context, pre-scaled so callers draw in logical units. The canvas keeps
 * its CSS size, so only the backing resolution changes.
 */
export function preparePixelCanvas(
  canvas: HTMLCanvasElement,
  logicalW: number,
  logicalH: number,
): CanvasRenderingContext2D {
  const scale = renderScale()
  canvas.width = Math.round(logicalW * scale)
  canvas.height = Math.round(logicalH * scale)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = false
  return ctx
}

const ZOOMED_OUT_CLASS = 'zoomed-out'

/** Keep the root element's zoomed-out marker in sync with the page zoom.
 *  Returns a teardown fn. devicePixelRatio has no change event, so this
 *  re-arms a one-shot matchMedia query per value, the standard trick. */
export function watchPixelScale(): () => void {
  let media: MediaQueryList | null = null
  let stopped = false

  const apply = () => {
    const dpr = window.devicePixelRatio || 1
    document.documentElement.classList.toggle(ZOOMED_OUT_CLASS, dpr < 1)
    media?.removeEventListener('change', onChange)
    if (stopped) return
    // fires as soon as the ratio moves off its current value
    media = window.matchMedia(`(resolution: ${dpr}dppx)`)
    media.addEventListener('change', onChange)
  }
  const onChange = () => apply()

  apply()
  return () => {
    stopped = true
    media?.removeEventListener('change', onChange)
  }
}
