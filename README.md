# Cryo Cache Editor

A browser-based editor for RuneScape 2 (revision 727) game cache files, built with Vite + React + TypeScript. Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to read and write cache files directly from disk — no server required.

## Usage

1. Run `npm install` then `npm run dev`
2. Open the app in your browser and click **Open Cache**
3. Select your unpacked cache folder (or a folder containing an `unpacked/` subfolder)
4. Browse cache entries in the sidebar and select items to view or edit

## Cache Entries

Ordered to match [`IndexType.java`](https://github.com/Pyragon/cryogen/blob/master/src/main/java/com/cryo/cache/IndexType.java) in the cryogen repo — the numbers are that enum's index ids. A few IndexType members share one physical folder (e.g. `animations/` holds `animation_frame_sets`, `animation_frame_bases`, and `animations` as separate subpaths) and are listed as separate rows here. `areas` and `quests` aren't IndexType members — they're CONFIG-index sub-archives dumped by the same unpacker — and are appended at the end. Entries marked **Not implemented upstream** have no `dumpFiles()` support in cryogen's own unpacker, so no folder for them will ever appear in a cache dump.

| # | Entry | Status | Notes |
|---|---|---|---|
| 0 | `animation_frame_sets` | Not started | `animations/frame_sets` |
| 1 | `animation_frame_bases` | Not started | `animations/bases`, binary `.dat` files |
| 2 | `config` | Not started | Subfolders: cursors, hitbars, hitsplats, identikits, inventories, map_sprites, params, skyboxes, structs, sun, vars |
| 3 | `interfaces` | Not started | |
| 4 | `sound_effects` | Not started | |
| 5 | `maps` | **Not implemented upstream** | |
| 6 | `music` | **Not implemented upstream** | |
| 7 | `models` | **In Progress** | Read-only 3D viewer (Three.js) with wireframe toggle |
| 8 | `sprites` | **In Progress** | Displays PNG frames with zoom, upload/download per frame |
| 9 | `textures` | Not started | |
| 10 | `huffman` | **Done** | Read-only frequency table viewer |
| 11 | `music2` | **Not implemented upstream** | |
| 12 | `cs2` | Not started | |
| 13 | `font_metrics` | Not started | `fonts/metrics` |
| 14 | `midi_instruments` | Not started | |
| 15 | `sound_effects_midi` | **Not implemented upstream** | |
| 16 | `objects` | Not started | |
| 17 | `enums` | **Done** | Editable key/value table with type-char dropdowns |
| 18 | `npcs` | Not started | |
| 19 | `items` | Not started | |
| 20 | `animations` | Not started | |
| 21 | `spot_animations` | Not started | |
| 22 | `varbits` | Not started | |
| 23 | `map_areas` | Not started | |
| 24 | `quick_chat_messages` | Not started | `quick_chat/messages` |
| 25 | `quick_chat_menus` | Not started | `quick_chat/menus` |
| 26 | `texture_definitions` | Not started | |
| 27 | `particles` | Not started | |
| 28 | `defaults` | Not started | |
| 29 | `billboards` | Not started | |
| 30 | `native_libraries` | **Done** | File browser — view/download/replace/add. `.dll`/`.exe` files can't be touched due to a browser platform restriction (see notice in the viewer) |
| 31 | `shaders` | **Not implemented upstream** | |
| 32 | `normal_fonts` | **Not implemented upstream** | |
| 33 | `game_tips` | **Not implemented upstream** | |
| 34 | `jagex_fonts` | **Not implemented upstream** | |
| 35 | `cutscenes` | **Not implemented upstream** | |
| 36 | `vorbis` | **Not implemented upstream** | |
| — | `areas` | Not started | Not an IndexType member — CONFIG-index sub-archive |
| — | `quests` | **In Progress** | Full editor — reads/writes quest JSON and cache structs (start NPC, start location, slot ID, prereq quests, skill requirements). Not an IndexType member — CONFIG-index sub-archive |

## License

[MIT](LICENSE)
