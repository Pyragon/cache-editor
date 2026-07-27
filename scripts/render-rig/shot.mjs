// Drive Edge headless to map-test.html, wait for the 3D scene build to finish,
// and screenshot the canvas. Usage: node shot.mjs out.png [urlExtra]
import puppeteer from 'puppeteer-core'

const OUT = process.argv[2] ?? 'shot.png'
const EXTRA = process.argv[3] ?? ''
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--window-size=1400,1000', '--hide-scrollbars', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1380, height: 960 },
})
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 200)) })
  await page.goto(`http://127.0.0.1:5199/map-test.html${EXTRA}`, { waitUntil: 'domcontentloaded' })

  // scene build done = the "Loading - please wait." overlay has come and gone
  await page.waitForSelector('.rs-loading', { timeout: 60_000 }).catch(() => {})
  await page.waitForFunction(
    () => !document.querySelector('.rs-loading') && !(window).__error,
    { timeout: 300_000, polling: 500 },
  )
  const err = await page.evaluate(() => (window).__error)
  if (err) throw new Error('page error: ' + err)
  // a couple of settle frames (textures resolving, first RAF passes)
  await new Promise((r) => setTimeout(r, 4000))

  // optional plane toggles: PLANES="1" (or "1,2") checks those plane boxes —
  // tree canopies are separate locs on plane 1, hidden by the default toggles
  const planes = process.env.PLANES
  if (planes) {
    for (const p of planes.split(',')) {
      await page.evaluate((label) => {
        for (const el of document.querySelectorAll('.mapscene-toggle')) {
          if (el.textContent.trim() === label) el.querySelector('input')?.click()
        }
      }, `Plane ${p.trim()}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  // optional camera target: GOTO="x y" flies the camera via the search box
  const goto = process.env.GOTO
  if (goto) {
    await page.click('.map-coord-input')
    await page.type('.map-coord-input', goto)
    await page.keyboard.press('Enter')
    await new Promise((r) => setTimeout(r, 5000)) // camera fly + settle
  }

  const canvas = await page.$('.mapscene-mount canvas')
  if (!canvas) throw new Error('no scene canvas')
  await canvas.screenshot({ path: OUT })
  console.log('wrote', OUT)
} finally {
  await browser.close()
}
