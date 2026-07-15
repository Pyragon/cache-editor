# Cryo Cache Editor

A browser-based editor for RuneScape 2 (revision 727) game cache files, built with Vite + React + TypeScript. Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to read and write cache files directly from disk — no server required.

## Usage

1. Run `npm install` then `npm run dev`
2. Open the app in your browser and click **Open Cache**
3. Select your unpacked cache folder (or a folder containing an `unpacked/` subfolder)
4. Browse cache entries in the sidebar and select items to view or edit

## Cache Entries

Ordered to match [`IndexType.java`](https://github.com/Pyragon/cryogen/blob/master/src/main/java/com/cryo/cache/IndexType.java) in the cryogen repo — the numbers are that enum's index ids. A few IndexType members share one physical folder (e.g. `animations/` holds `animation_frame_sets`, `animation_frame_bases`, and `animations` as separate subpaths) and are listed as separate rows here. Entries marked **Not implemented upstream** have no `dumpFiles()` support in cryogen's own unpacker, so no folder for them will ever appear in a cache dump.

Sidebar colours: **green** = feature-complete editor (user-reviewed), white = dedicated viewer/editor in progress, **amber** = dumped but only the raw-JSON fallback so far, **red** = not present in the dump (disabled).

Status legend: **✅ Done** = complete & reviewed (green) · **Editor** = full editable editor built, pending review · **Viewer** = read-only or partial viewer · **Not started** = raw-JSON fallback only · **Not implemented upstream** = no cryogen `dumpFiles()`, never appears in a dump.

All field-renamed entries (`items`, `objects`, `npcs`, `billboards`, `texture_definitions`, `map_areas`, config `areas`, config `hitsplats`, config `skyboxes`) have been **re-dumped** with the darkan-aligned names; the `textures` dump also carries the alpha channel + correct isHalfSize resolutions as of 2026-07-13.

| # | Entry | Status | Notes |
|---|---|---|---|
| 0 | `animation_frame_sets` | Not started | `animations/frame_sets` |
| 1 | `animation_frame_bases` | Not started | `animations/bases`, binary `.dat` files |
| 2 | `config` | Grouped | Collapsible sidebar group of CONFIG-index sub-archives — see the table below |
| 3 | `interfaces` | Not started | |
| 4 | `sound_effects` | Not started | |
| 5 | `maps` | Not implemented upstream | |
| 6 | `music` | Not implemented upstream | |
| 7 | `models` | Viewer | Read-only 3D viewer (Three.js) with wireframe toggle |
| 8 | `sprites` | Viewer | Displays PNG frames with zoom, upload/download per frame |
| 9 | `textures` | ✅ **Done** | Live op-graph render (37/38 op types, pixel-identical to cryogen; op 29 falls back to the dumped PNG), op-graph editor, animated UV scrolling per the client formula, and "New from image" texture creation (median-cut quantized to the sprite palette) — user signed off 2026-07-14 |
| 10 | `huffman` | ✅ **Done** | Frequency table viewer (Table/Visual) + regenerate-from-corpus editor with round-trip self-test |
| 11 | `music2` | Not implemented upstream | |
| 12 | `cs2` | Not started | |
| 13 | `font_metrics` | ✅ **Done** | Shown as **Fonts** — joins the metrics (13) with the glyph bitmaps from the font sprite archives (32/34), since a font is both halves keyed by one file id. Glyph atlas with editable advance widths, line-height/padding, and a live client-accurate text preview. Glyphs are read-only (the sprite archives aren't repackable yet). |
| 14 | `midi_instruments` | Not started | |
| 15 | `sound_effects_midi` | Not implemented upstream | |
| 16 | `objects` | Editor | Full editable editor — user-verified 2026-07-13 |
| 17 | `enums` | ✅ **Done** | Editable key/value table with type-char dropdowns; Add pre-fills the next key. Decode audited against darkan `EnumType.kt` — opcodes 1-6 identical, 7/8 differ only in representation (darkan materialises a sparse array, cryogen keeps the written entries keyed by the same index), verified against the dump. |
| 18 | `npcs` | Editor | Full editable editor — user-verified 2026-07-13 (model-translations desync hardening still in TODO) |
| 19 | `items` | Editor | Full editable editor with itemdb icon previews — user-verified 2026-07-13 |
| 20 | `animations` | Not started | |
| 21 | `spot_animations` | Not started | |
| 22 | `varbits` | ✅ **Done** | baseVar / start-bit / end-bit editor |
| 23 | `map_areas` | ✅ **Done** | world map areas — name, placement, map size, area rects table, live-derived bounds (map preview idea in TODO) |
| 24 | `quick_chat_messages` | ✅ **Done** | Combined quick chat editor (Edit/Preview toggle, template chips, response navigation, segment/dynamic-part sync) |
| 25 | `quick_chat_menus` | ✅ **Done** | Same combined editor — drill into submenus/messages, saves route to the right folder |
| 26 | `texture_definitions` | ✅ **Done** | Full field editor with live material preview + HSL16 colour swatch — shares the textures viewer; flags repack via cryogen's `TextureDefinitions.encode()` (byte-identical round-trip) — user signed off 2026-07-14 |
| 27 | `particles` | ✅ **Done** | Producer/type editor with a live client-faithful effect preview (emission windows, face-normal cones, effectors) at selectable 10/25/50 FPS; model viewer renders emitters on their carrier faces — user signed off 2026-07-13 |
| 28 | `defaults` | ✅ **Done** | entity / equipment blobs |
| 29 | `billboards` | ✅ **Done** | material id + size + shape/blend, live material preview, used-by-models list (scripts/scan-billboard-usage.mjs) |
| 30 | `native_libraries` | ✅ **Done** | File browser — view/download/replace/add. `.dll`/`.exe` files can't be touched due to a browser platform restriction (see notice in the viewer) |
| 31 | `shaders` | Not implemented upstream | |
| 32 | `normal_fonts` | Merged into **Fonts** | Glyph bitmaps for the real typefaces — dumped by cryogen's FontGlyphs to `fonts/glyphs/normal/`, served by the `font_metrics` entry (no separate sidebar row). |
| 33 | `game_tips` | Not implemented upstream | |
| 34 | `jagex_fonts` | Merged into **Fonts** | Single-glyph logo/wordmark entries — dumped to `fonts/glyphs/jagex/`, served by the `font_metrics` entry (no separate sidebar row). |
| 35 | `cutscenes` | Not implemented upstream | |
| 36 | `vorbis` | Not implemented upstream | |

### Config sub-archives

Sub-archives of `IndexType.CONFIG(2)`, mirroring [`FileType.java`](https://github.com/Pyragon/cryogen/blob/master/src/main/java/com/cryo/cache/FileType.java) (unnamed `SCT_#` placeholders excluded). Shown in-app as a collapsible dropdown under the **Config** sidebar entry. Entries marked *Not dumped* have no folder in the current cache dump.

Ordered to match `FileType.java` (its numeric ids in parentheses). Many members aren't present in the current dump — marked *Not dumped*.

| # | Entry | Status | Notes |
|---|---|---|---|
| 1 | `underlays` | Not dumped | |
| 3 | `identikits` | Not started | Folder-per-id `.lnk` dump format — needs flattening + re-dump like cursors |
| 4 | `overlays` | Not dumped | |
| 5 | `inventories` | ✅ **Done** | Slot length + default-stock pairs with item-icon previews |
| 6 | `objects` | Not dumped | Config sub-archive, distinct from the top-level `objects` index |
| 8 | `enums` | Not dumped | Config sub-archive, distinct from the top-level `enums` index |
| 9 | `npcs` | Not dumped | Config sub-archive, distinct from the top-level `npcs` index |
| 10 | `items` | Not dumped | Config sub-archive, distinct from the top-level `items` index |
| 11 | `params` | ✅ **Done** | Type-char dropdown, default int, auto-disable |
| 12 | `animations` | Not dumped | |
| 13 | `spot_anims` | Not dumped | |
| 14 | `varbits` | Not dumped | Config sub-archive, distinct from the top-level `varbits` index |
| 15 | `varc_string` | Not dumped | |
| 16 | `vars` | ✅ **Done** | Param-type dropdown + client code (verified against darkan `VarpType`: only opcodes 1/5 exist, so the sparse data is correct) |
| 19 | `varc` | Not dumped | |
| 26 | `structs` | ✅ **Done** | Param key→value table |
| 29 | `skyboxes` | ✅ **Done** | material preview + sun ids + background mode (sun fields unused in this cache — sun table is empty at rev 727) |
| 30 | `sun` | Not started | Empty in the current dump |
| 31 | `light_intensities` | Not dumped | |
| 32 | `bas` | Not dumped | |
| 33 | `cursors` | ✅ **Done** | Full editor — hotspot picking on the sprite preview, live "your mouse becomes the cursor" test area with RS-style click crosses, sprite download/upload (uploads allocate a new sprite id), add/remove/clone, save validation |
| 34 | `map_sprites` | Editor | Sprite preview, background colour picker, upscaling toggle, sprite download/upload, add/remove/clone. (Held from Done pending a minimap-render preview — see TODO) |
| 35 | `quests` | Editor | Reads/writes quest JSON and cache structs (start NPC, start location, slot ID, prereq quests, skill requirements) |
| 36 | `areas` | ✅ **Done** | map element config (MECType) — sprites, colours, menu actions, visibility vars, params, static-element Placed At list (73,896 entries) |
| 46 | `hitsplats` | ✅ **Done** | Field editor with a live splat preview whose damage number is rendered with the real cache font referenced by `fontId` (glyphs + advance widths from the cache, positioned exactly like the client) |
| 47 | `clan_var` | Not dumped | |
| 54 | `clan_var_settings` | Not dumped | |
| 72 | `hitbars` | ✅ **Done** | Field editor with a live health-percentage bar preview, per-sprite previews + upload/download, and a slider tinted to the actual bar sprite colours |

## License

[MIT](LICENSE)
