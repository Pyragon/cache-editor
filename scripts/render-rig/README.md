# Render rig — headless screenshots of the 3D map scene

Built 2026-07-26 to calibrate the loc lighting fix against Cody's client
screenshots. Renders the real `MapSceneViewer` in headless Edge (SwiftShader,
so results are hardware-independent) and samples patch colours numerically —
"looks too bright" becomes a number.

## Pieces

- **`dump-server.mjs`** — serves `cryogen-cache/unpacked` on :8787 with the
  `/__ls` listing endpoint `src/map-test.tsx`'s fake FileSystemDirectoryHandle
  needs. Adjust `ROOT` if the dump moves.
- **`/map-test.html` + `src/map-test.tsx`** (repo root) — loads `MapViewer`
  against that server instead of a real picked folder. Opens region 12850 in 3D
  by default (the `HOME` coords).
- **`shot.mjs`** — drives Edge via puppeteer-core: waits for the loading
  overlay to come and go, optionally toggles planes and flies the camera, then
  screenshots the scene canvas.
  - `PLANES="1,2,3"` — check those plane boxes first. **Tree canopies are locs
    on plane 1**; without this every tree is a bare trunk.
  - `GOTO="3238 3233"` — fly the camera via the coordinate search box.
- **`sample.mjs`** — average RGB of named rects in a PNG, and crops each rect
  to its own file so you can verify what surface it actually hit (the rects
  WILL hit players/markers/water on the first try; always check the crops).

## Run

```
node scripts/render-rig/dump-server.mjs &          # :8787
npx vite --port 5199 --strictPort &                # serves /map-test.html
cd <scratch> && npm i puppeteer-core pngjs
PLANES="1,2,3" GOTO="3230 3244" node shot.mjs out.png
node sample.mjs out.png out canopy:460,800,100,80 grass:250,500,80,60
```

`shot.mjs` expects Edge at `C:/Program Files (x86)/Microsoft/Edge/Application/
msedge.exe` and the Vite server on :5199 — edit the constants for anything else.

## Reference values (2026-07-26 screenshot pair, Lumbridge east bank)

From `java_K89pBHQqWg.png` (client, lighting detail LOW) vs the viewer at the
same spot. Post-fix viewer values in parens:

| surface | client avg | viewer avg |
|---|---|---|
| willow fronds | 78,79,48 | 74,74,48 (post-fix; was ~2.2× dark) |
| tree canopy | 76,85,38 | 50,69,14 — residual is FOG, unimplemented |
| path cobble | 66,60,54 | 74,68,62 |
| grass | 67,70,43 | 66,63,48 |

Marker diamonds (cyan/violet) are editor-only overlays — toggle Markers off or
sample around them.
