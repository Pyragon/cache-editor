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
| `animations` | Raw JSON | |
| `areas` | Raw JSON | |
| `billboards` | Raw JSON | |
| `config` | Raw JSON | Subfolders: structs, etc. |
| `cs2` | Raw JSON | |
| `enums` | Raw JSON | |
| `fonts` | Raw JSON | |
| `huffman` | **Done** | Read-only frequency table viewer |
| `interfaces` | Raw JSON | |
| `items` | Raw JSON | |
| `map_areas` | Raw JSON | |
| `midi_instruments` | Raw JSON | |
| `models` | Raw JSON | |
| `native_libraries` | Raw JSON | |
| `npcs` | Raw JSON | |
| `objects` | Raw JSON | |
| `particles` | Raw JSON | |
| `quests` | **In Progress** | Full editor — reads/writes quest JSON and cache structs (start NPC, start location, slot ID, prereq quests, skill requirements) |
| `quick_chat` | Raw JSON | |
| `sound_effects` | Raw JSON | |
| `spot_animations` | Raw JSON | |
| `sprites` | Raw JSON | |
| `texture_definitions` | Raw JSON | |
| `textures` | Raw JSON | |
| `varbits` | Raw JSON | |

## License

[MIT](LICENSE)
