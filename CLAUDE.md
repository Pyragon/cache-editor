# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based editor for OSRS-era game cache files (Vite + React 19 + TypeScript). It has no backend — it reads and writes cache files directly on the user's disk via the browser's **File System Access API** (`showDirectoryPicker({ mode: 'readwrite' })`). Everything happens client-side against a folder the user opens, which must be an unpacked cache dump (a folder of folders, one per cache table — `items/`, `models/`, `enums/`, `native_libraries/`, etc.). `App.tsx`'s `handleOpenCache` tries `getDirectoryHandle('unpacked')` on the selected folder first and falls back to the folder itself if that subfolder doesn't exist.

## Git workflow

Never run `git commit` or `git push` unless the user explicitly asks for it in that turn. Finishing an implementation is not permission to commit it — stop and leave it ready, don't stage or commit proactively.

## Commands

```
npm install       # install deps
npm run dev        # start Vite dev server (http://localhost:5173)
npm run build       # tsc -b && vite build
npm run lint        # oxlint
npm run preview     # preview a production build
```

There is no test suite in this repo.

## Architecture

### Loader plugin pattern

Each cache entry (e.g. `enums`, `sprites`, `quests`) has an optional loader in `src/loaders/<entry-name>.ts` implementing the `CacheLoader` interface (`src/loaders/types.ts`):

- `streamItems(dirHandle)` — async generator yielding `{ id, name }` for the item list sidebar.
- `loadItem(dirHandle, item, rootHandle?)` — loads the full data for a selected item.
- `saveItem(dirHandle, item, data)` *(optional)* — persists edits back to disk. Loaders without this are read-only.
- `noPanel` *(optional)* — for entries that are a single blob rather than a list of items (`huffman`, `native_libraries`), so no per-item sidebar list is shown.

Loaders are registered by entry name in `src/loaders/index.ts`'s `registry` object; `getLoader(name)` looks one up. Many entries listed in `README.md`'s table don't have a dedicated loader yet — those fall back to the generic helpers in `src/loaders/common.ts`:
- `streamJsonItems` / `loadJsonItem` — for entries stored as flat `<id>.json` files.
- `streamDirItems` — for entries stored as `<id>/` subfolders.

Entries with no loader at all, or whose loaded content has no specialized viewer, render as raw JSON via a `<pre>` fallback in `App.tsx`.

### Entry order and folder resolution

The sidebar entry order is not alphabetical — it's a fixed canonical order (`src/loaders/entryOrder.ts`'s `ENTRY_ORDER`) mirroring `IndexType.java` in the cryogen repo. Each entry's `name` (the registry/loader key) is paired with a `path` — an array of folder segments relative to the cache root, since several entries don't live at the top level (e.g. `font_metrics` → `fonts/metrics`, `quick_chat_messages` → `quick_chat/messages`, `animation_frame_sets` → `animations/frame_sets`). `App.tsx` resolves each entry's real `FileSystemDirectoryHandle` via `resolveEntryHandle(root, getEntryPath(name))` rather than a single-level `getDirectoryHandle(name)` call — always use that helper (not a raw `getDirectoryHandle`) when adding code that needs an entry's folder.

Entries whose path fails to resolve in the currently opened cache (either because cryogen's own unpacker has no `dumpFiles()` implementation for that `IndexType` at all, or because this particular dump just doesn't have it) are marked `available: false` and rendered disabled/red in the sidebar — they're never clickable and never call into a loader. Folders present on disk but not covered by `ENTRY_ORDER` still show up, appended alphabetically after the canonical list, so unrecognized/custom cache folders don't silently disappear.

### Wiring a new specialized viewer

Specialized viewer components (`QuestViewer`, `SpriteViewer`, `ModelViewer`, `TextureViewer`, `NativeLibrariesViewer`, `EnumViewer`, `HuffmanViewer`) are manually special-cased in `App.tsx`: a `const xContent = selectedEntry?.name === 'x' && ... ? selectedItemContent as XData : null` check, then a branch in the content-panel ternary chain that renders the component instead of the JSON fallback. Adding a new one means: write the loader, write the component, add both to `App.tsx` following that same pattern.

### Editable viewer convention

Editable viewers share one pattern: local `draft` state seeded from props, an `isDirty` flag set on any change, and a sticky bottom "Unsaved changes" bar with Discard/Save buttons. Component CSS files are **plain imports, not CSS modules** — Vite bundles them all into one global stylesheet, so classes are deliberately shared and reused across components rather than redefined per-component. In particular, `.save-bar*`, `.stat-card`, `.stat-input`, `.cell-input`, `.add-row-btn`, `.row-remove-btn`, `.quest-table*`, `.badge-dropdown-*`, and `.cell-dropdown-*` are all defined once (mostly in `QuestViewer.css`) and reused by other viewers that never import their own copy.

### File System Access API limitation

Chromium silently blocks reading, writing, and even *enumerating* files with "dangerous" extensions (`.dll`, `.exe`, `.ini`, `.cfg`, `.sys`, etc.) through this API — confirmed empirically against a real cache dump (affected folders enumerate as empty with no error). This is a hard browser platform restriction with no in-browser workaround. It mainly affects the `native_libraries` entry; `NativeLibrariesViewer` shows an explanatory notice rather than pretending file management works there.

### Shared type-tag system (enums / params / structs / cs2)

`enums` (and the `params`/struct/CS2-script systems it's shared with) use a single-character "ScriptVarType" tagging convention for `keyTypeChar`/`valueTypeChar` — e.g. `i` = int, `s` = string, `o` = obj id, `n` = npc id, `J` = struct id, etc. The full known mapping lives in `EnumViewer.tsx`'s `TYPE_LABELS`, sourced from the darkan-game-client/cryogen client source. Values are numeric unless `valueTypeChar === 's'`; keys are always numeric across the real cache dump.

### Reference repos for client/cache logic

When porting or verifying RuneScape client/cache logic (binary formats, math, type systems), only trust the user's own repos whose names contain **cryogen** or **darkan** (sibling repos under the same GitHub workspace, e.g. `cryogen-cache`, `darkan-game-client`, `darkan-server`) — not third-party projects like rsmv or RuneLite, which have been found to contain incompatible assumptions for this cache/client revision.
