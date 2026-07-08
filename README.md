# Cryo Cache Editor

A browser-based editor for OSRS game cache files, built with Vite + React + TypeScript. Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to read and write cache files directly from disk — no server required.

## Usage

1. Run `npm install` then `npm run dev`
2. Open the app in your browser and click **Open Cache**
3. Select your unpacked cache folder (or a folder containing an `unpacked/` subfolder)
4. Browse cache entries in the sidebar and select items to view or edit

## Cache Entries

| Entry | Status | Notes |
|---|---|---|
| `animations` | Not started | |
| `areas` | Not started | |
| `billboards` | Not started | |
| `config` | Not started | Subfolders: structs, etc. |
| `cs2` | Not started | |
| `enums` | Not started | |
| `fonts` | Not started | |
| `huffman` | **Done** | Read-only frequency table viewer |
| `interfaces` | Not started | |
| `items` | Not started | |
| `map_areas` | Not started | |
| `midi_instruments` | Not started | |
| `models` | Not started | |
| `native_libraries` | Not started | |
| `npcs` | Not started | |
| `objects` | Not started | |
| `particles` | Not started | |
| `quests` | **In Progress** | Full editor — reads/writes quest JSON and cache structs (start NPC, start location, slot ID, prereq quests, skill requirements) |
| `quick_chat` | Not started | |
| `sound_effects` | Not started | |
| `spot_animations` | Not started | |
| `sprites` | Not started | |
| `texture_definitions` | Not started | |
| `textures` | Not started | |
| `varbits` | Not started | |

## License

[MIT](LICENSE)
