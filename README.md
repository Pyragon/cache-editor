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
| 0 | `animation_frame_sets` | Editor | `animations/frame_sets` — each keyframe (per-bone-group translate/rotate/scale deltas). Dumped as structured JSON (was raw undecoded `.dat` before this pass); expandable per-frame transform table with cross-link to its frame base. Dumper + repack added to cryogen (`AnimationFrame`/`AnimationFrameSet`) — **100% byte-identical round-trip** (490,049/490,049 frames) |
| 1 | `animation_frame_bases` | Editor | `animations/bases` — the "skeleton" bone-group structure frames transform against. Dumped as structured JSON (was raw `.dat` before this pass); editable transform-slot table (type, shadow flag, submesh bitmask, vertex-group labels). Dumper + repack added to cryogen (`AnimationFrameBase`) — **100% byte-identical round-trip** (3,535/3,535) |
| 2 | `config` | Grouped | Collapsible sidebar group of CONFIG-index sub-archives — see the table below |
| 3 | `interfaces` | Editor | One folder per interface, one JSON file per component (`<interfaceId>/<componentId>.json` — no screenshot). Component tree, per-type field editing, CS2 script hooks shown as raw editable arg lists, and a **faithful client-style preview** ported from the darkan client's draw path: real cache fonts (glyph bitmaps from the font's sprite archive + `fonts/metrics` advances, `<col>` tags, wrapping, alignment, shadows), sprites with tint/tile/rotation/flip/transparency, figures/lines, and RAW_MODEL components rendered in place via offscreen Three.js using the client's model matrix (2048-unit angles, `spriteScale` zoom, 512-focal projection, origin screen-shift, parent-clip overflow). Special content panes (game view, minimap, …) and runtime-composed model types (player/NPC heads) show labeled placeholders. Several dumper/encoder bugs found and fixed this pass, including a shared cp1252 string-codec bug and a dump-writer charset bug — **100% byte-identical round-trip** (see TODO for details) |
| 4 | `sound_effects` | Editor | RS2's additive-synthesis sound-effect format (up to 10 simultaneous oscillator-bank "instruments" per effect, each with envelopes, an optional biquad filter, echo) — full field editor with drawn envelope curves plus **live in-browser re-synthesis** — the synth engine is ported to TypeScript (`soundSynth.ts`, sample-exact against all 10,084 dumped WAVs), so edits play instantly over WebAudio with a rendered waveform, loop markers and playhead. Dumper already existed; this pass added `encode()`/`getActions()` (previously a stub) — **100% byte-identical round-trip** (10,084/10,084) |
| 5 | `maps` | Editor | World terrain (2,407 regions, 64×64×4 tiles) and XTEA-encrypted placed objects — top-down coloured preview per plane with click-to-edit tiles, plus a **full 3D scene view** (2D/3D toggle) ported from the darkan client scene pipeline: tile heights incl. the Perlin default-height noise, 11×11 blended underlay colours, the 13 overlay tile shapes, slope-directional lighting, **fully textured** (UV-mapped loc models via the client's planar/cylinder/cube/sphere mappings; world-planar terrain textures with detail-map tinting per the material config), and every placed loc's models merged into the scene, with orbit camera and per-plane toggles. Dumper + repack in cryogen (`MapDefinitions`, terrain functionally verified, locations byte-identical round-trip). Object placement editing still out of scope (see TODO) |
| 6 | `music` | Editor | Archives are a Jagex-specific compact re-encoding of Standard MIDI Files (not literal .mid, not General MIDI instrument data) — reverse-engineered by tracing the client's own decompressor. Dumps a real, standard, playable `.mid` per song for download/external editing (MuseScore, a DAW, etc.), then repacks whatever's uploaded back into the compact format. Both directions verified against real cache data: decompress is **100% valid** (1,137/1,137, checked against `javax.sound.midi`), and the round-trip decompress→compress→decompress is **100% functionally identical** (same decoded MIDI content) across all 1,137 songs |
| 7 | `models` | Viewer | Read-only 3D viewer (Three.js) with wireframe toggle |
| 8 | `sprites` | ✅ **Done** | Frame viewer with zoom + checker/dark/transparent/custom background, per-frame Edit/Replace/Download/Clone/Remove/reorder, per-frame meta fields, and a palette panel (click a swatch to recolour every pixel using it — max 255 colours + reserved transparent). **In-app pixel editor** (per-frame Edit, also the "+ Add frame" flow): pencil/eraser/fill/line/rect/filled-rect/move/eyedropper, undo/redo, copy/paste across frames and sprites, canvas resize, palette picker with append-only colour adds, and canvas seeding from an uploaded image or http(s) URL — over-limit images are median-cut quantized to the remaining palette budget automatically. Sidebar Add/Remove/Clone create, delete, and duplicate whole sprites. Saving rewrites the JSON **and regenerates the per-frame PNGs** in the dump convention (sub-frame size), so other pages' sprite previews and the repack tracker stay in sync |
| 9 | `textures` | ✅ **Done** | Live op-graph render (37/38 op types, pixel-identical to cryogen; op 29 falls back to the dumped PNG), op-graph editor, animated UV scrolling per the client formula, and "New from image" texture creation (median-cut quantized to the sprite palette) |
| 10 | `huffman` | ✅ **Done** | Frequency table viewer (Table/Visual) + regenerate-from-corpus editor with round-trip self-test |
| 11 | `music2` | Editor | Same format and editor as `music` (a secondary/parallel song index) — **100% functional round-trip, 525/525** |
| 12 | `cs2` | Not started | |
| 13 | `font_metrics` | ✅ **Done** | Shown as **Fonts** — joins the metrics (13) with the glyph bitmaps from the font sprite archives (32/34), since a font is both halves keyed by one file id. Glyph atlas with editable advance widths, line-height/padding, and a live client-accurate text preview. Glyphs are read-only (the sprite archives aren't repackable yet). |
| 14 | `midi_instruments` | Editor | Despite the name, this is Ogg Vorbis sample audio (not General MIDI) — the music sequencer's instrument voices. Metadata editor (sample rate, loop points) with real playable `.ogg` preview and a "replace audio" upload. This pass completed `encode()`/`getActions()` (previously stubs) and finished the packet-extraction path (`fromOGGFile`, previously an unfinished debug method) — **100% byte-identical round-trip** (16,824/16,824) |
| 15 | `sound_effects_midi` | Editor | Despite the name, neither the `sound_effects` synthesis format nor the `music` compact-MIDI format — a SoundFont/DLS-style instrument bank keyed by MIDI program-change number (`Node_Sub14` in the client): a 128-note keymap pointing at "zones" (amplitude envelope, continuous decay, vibrato LFO), cross-referencing samples that live in `sound_effects`/`midi_instruments`. Zones and global gain are editable; the note keymap is shown read-only, grouped into ranges (see TODO). Dumper + repack added to cryogen (`SoundEffectMidi`) — **100% byte-identical round-trip** (246/246 non-empty archives) |
| 16 | `objects` | Editor | Full editable editor |
| 17 | `enums` | ✅ **Done** | Editable key/value table with type-char dropdowns; Add pre-fills the next key. Decode audited against darkan `EnumType.kt` — opcodes 1-6 identical, 7/8 differ only in representation (darkan materialises a sparse array, cryogen keeps the written entries keyed by the same index), verified against the dump. |
| 18 | `npcs` | Editor | Full editable editor (model-translations desync hardening still in TODO) |
| 19 | `items` | ✅ **Done** | Full editor — icon previews, cross-entry View links (model posed as the inventory icon with recolours/retextures/icon lighting, equipment models, cursors), cursor preview cards with resolved option labels |
| 20 | `animations` | Editor | "Sequence" playback metadata (darkan `SeqType.kt`) — frame timing/ordering, priority, held-item overrides, footstep sounds, interleave order. Full field editor with a frame table (duration/frame-set/file-id, cross-linked), a "Preview on Model" frame-stepper that applies the ported skeletal transform math to a chosen model, and a **Skeleton & Compatible Models** section: the sequence's frame base (skeleton) badge plus, after a session-cached ~43k-file compatibility scan, sortable tables of every NPC and spot-anim pairing on the same skeleton — the models this animation actually fits. Encoder added to cryogen (`AnimationDefinitions`, previously a stub) — **100% functionally identical round-trip** (17,186/17,186; byte-level mismatches are pure opcode-ordering variance in the original data, not a functional gap — see TODO) |
| 21 | `spot_animations` | Editor | "GFX" — a model + a sequence to play on it, spawned at a location or on an entity (spell splashes, teleport effects, special-attack visuals). Renders through the same pipeline as regular animated entities. Field editor, recolour pairs, and a frame-stepper preview reusing the `animations` skeletal-transform pipeline. Encoder added to cryogen (`SpotAnimationDefinitions`, previously a stub) — **100% functionally identical round-trip** (3,252/3,252; 82% byte-identical, remaining gap is the same opcode-ordering non-issue as `animations`) |
| 22 | `varbits` | ✅ **Done** | baseVar / start-bit / end-bit editor |
| 23 | `map_areas` | ✅ **Done** | world map areas — name, placement, map size, area rects table, live-derived bounds (map preview idea in TODO) |
| 24 | `quick_chat_messages` | ✅ **Done** | Combined quick chat editor (Edit/Preview toggle, template chips, response navigation, segment/dynamic-part sync) |
| 25 | `quick_chat_menus` | ✅ **Done** | Same combined editor — drill into submenus/messages, saves route to the right folder |
| 26 | `texture_definitions` | ✅ **Done** | Full field editor with live material preview + HSL16 colour swatch — shares the textures viewer; flags repack via cryogen's `TextureDefinitions.encode()` (byte-identical round-trip) |
| 27 | `particles` | ✅ **Done** | Producer/type editor with a live client-faithful effect preview (emission windows, face-normal cones, effectors) at selectable 10/25/50 FPS; model viewer renders emitters on their carrier faces |
| 28 | `defaults` | ✅ **Done** | entity / equipment blobs |
| 29 | `billboards` | ✅ **Done** | material id + size + shape/blend, live material preview, used-by-models list (scripts/scan-billboard-usage.mjs) |
| 30 | `native_libraries` | ✅ **Done** | File browser — view/download/replace/add. `.dll`/`.exe` files can't be touched due to a browser platform restriction (see notice in the viewer) |
| 31 | `shaders` | Not implemented upstream | |
| 32 | `normal_fonts` | Merged into **Fonts** | Glyph bitmaps for the real typefaces — dumped by cryogen's FontGlyphs to `fonts/glyphs/normal/`, served by the `font_metrics` entry (no separate sidebar row). |
| 33 | `game_tips` | ✅ **Done** | Loading-screen tips — per-tip component scenes with a live 765×503 preview (sprites, cache-font text, sprite-assembled animated loading bars), and a visual stage table: master-rotation editor rebuilding all 36 stages, tip thumbnails, and a crossfading load simulation with editable duration; dumper + byte-verified repack in cryogen (`GameTipsDefinitions`). In-game repack verification pending (see TODO) |
| 34 | `jagex_fonts` | Merged into **Fonts** | Single-glyph logo/wordmark entries — dumped to `fonts/glyphs/jagex/`, served by the `font_metrics` entry (no separate sidebar row). |
| 35 | `cutscenes` | Not implemented upstream | |
| 36 | `vorbis` | Not implemented upstream | |

### Config sub-archives

Sub-archives of `IndexType.CONFIG(2)`, mirroring [`FileType.java`](https://github.com/Pyragon/cryogen/blob/master/src/main/java/com/cryo/cache/FileType.java) (unnamed `SCT_#` placeholders excluded). Shown in-app as a collapsible dropdown under the **Config** sidebar entry. Entries marked *Not dumped* have no folder in the current cache dump.

Ordered to match `FileType.java` (its numeric ids in parentheses). Many members aren't present in the current dump — marked *Not dumped*.

| # | Entry | Status | Notes |
|---|---|---|---|
| 1 | `underlays` | Editor | Ground tile base colours — colour swatch (raw + client-quantised), texture, scale; dumper + repack added to cryogen (`UnderlayDefinitions`, 170/170 functional round-trip) |
| 3 | `identikits` | Editor | Player "identikit" body parts (hair, torso, legs, etc.) — bodyModels/headModels merge into composite meshes with recolour/retexture pairs applied (`IdentiKitDefinitions.renderBody`/`renderHead`). Dump flattened from folder-per-id to `<id>.json` (the README's old ".lnk" note was stale — no such files exist; matches the `cursors` convention). Editor: field editor, recolour/retexture pair tables, live composite mesh preview, and a "Preview Full Player" tool that assembles all appearance slots (identikits + equipped items) into one avatar — **651/651 functionally identical round-trip** (see TODO for details) |
| 4 | `overlays` | Editor | Ground tile overlays (paths, water) — tile/minimap colour swatches, texture, water fields; dumper + repack added to cryogen (`OverlayDefinitions`, 247/247 functional round-trip) |
| 5 | `inventories` | ✅ **Done** | Slot length + default-stock pairs with item-icon previews |
| 6 | `objects` | Empty in cache | Config sub-archive, distinct from the top-level `objects` index — holds no data at rev 727 |
| 8 | `enums` | Empty in cache | Config sub-archive, distinct from the top-level `enums` index — holds no data at rev 727 |
| 9 | `npcs` | Empty in cache | Config sub-archive, distinct from the top-level `npcs` index — holds no data at rev 727 |
| 10 | `items` | Empty in cache | Config sub-archive, distinct from the top-level `items` index — holds no data at rev 727 |
| 11 | `params` | ✅ **Done** | Type-char dropdown, default int, auto-disable |
| 12 | `animations` | Empty in cache | No archive in the CONFIG index at rev 727 (moved to the top-level animations index) |
| 13 | `spot_anims` | Empty in cache | No archive in the CONFIG index at rev 727 (moved to the top-level spot_animations index) |
| 14 | `varbits` | Empty in cache | Config sub-archive, distinct from the top-level `varbits` index — holds no data at rev 727 |
| 15 | `varc_string` | ✅ **Done** | Presence records only (the cache stores no fields) — Add/Remove manage which ids exist |
| 16 | `vars` | ✅ **Done** | Param-type dropdown + client code (verified against darkan `VarpType`: only opcodes 1/5 exist, so the sparse data is correct) |
| 19 | `varc` | ✅ **Done** | Client variables — type-char dropdown + persists-across-sessions toggle |
| 26 | `structs` | ✅ **Done** | Param key→value table |
| 29 | `skyboxes` | ✅ **Done** | material preview + sun ids + background mode (sun fields unused in this cache — sun table is empty at rev 727) |
| 30 | `sun` | Not started | Empty in the current dump |
| 31 | `light_intensities` | ✅ **Done** | Flickering point-light configs (waveform/speed/amplitude/base) with a live animated preview of the client formula — dumper + byte-verified repack added to cryogen (`LightIntensityDefinitions`) |
| 32 | `bas` | ✅ **Done** | Base animation sets (render anims) — movement-sequence matrix (stand/walk/run/teleport × direction/turn variants, each with a jump link to the animation), random stand sequences, model/rotation-physics fields, and a **Used by NPCs** table (from the shared compatibility scan: every NPC whose render anim this is, with jump links to the NPC and its models, and a per-NPC View Anim dropdown that plays the stand/walk/run/teleport sequence on the NPC's model in real time). Dumper + repack added to cryogen (`BASDefinitions`, fields renamed per darkan `BasType`) — 2,574/2,574 functional round-trip (65% byte-identical; the rest is opcode-order variance in the original data) |
| 33 | `cursors` | ✅ **Done** | Full editor — hotspot picking on the sprite preview, live "your mouse becomes the cursor" test area with RS-style click crosses, sprite download/upload (uploads allocate a new sprite id), add/remove/clone, save validation |
| 34 | `map_sprites` | ✅ **Done** | Sprite preview, background colour picker, upscaling toggle (with client-semantics tooltip: stretches the stamp to the object's tile footprint), sprite download/upload, "Browse…" modal picker over all 8×8 sprites, in-app pixel editing of the stamp (staged as a new sprite id), a "not 8×8" warning when the referenced sprite breaks the verified stamp size, "Used by objects" reverse lookup (one-time scan of all ~74k object defs, session-cached, sortable/filterable table jumping to the object viewer), add/remove/clone. (A minimap-render preview is planned once the minimap renderer is settled — see TODO) |
| 35 | `quests` | ✅ **Done** | Edits both cache archives a quest lives in — the quest def (archive 35) and the quest-start-interface struct (archive 26, journal texts, interface names, raw extras) — with the quest↔slot map derived from the cache (name-matched, 183/183 vs the old hardcoded table) and computed prereq-tree skill totals |
| 36 | `areas` | ✅ **Done** | map element config (MECType) — sprites, colours, menu actions, visibility vars, params, static-element Placed At list (73,896 entries) |
| 46 | `hitsplats` | ✅ **Done** | Field editor with a live splat preview whose damage number is rendered with the real cache font referenced by `fontId` (glyphs + advance widths from the cache, positioned exactly like the client) |
| 47 | `clan_var` | ✅ **Done** | Clan variables — type char + interactive 32-bit register map of the base word (drag to set bits, neighbour lanes, overlap warnings) |
| 54 | `clan_var_settings` | ✅ **Done** | Clan settings variables — same editor as clan vars (identical shape, different cache opcode) |
| 72 | `hitbars` | ✅ **Done** | Field editor with a live health-percentage bar preview, per-sprite previews + upload/download, and a slider tinted to the actual bar sprite colours |

## License

[MIT](LICENSE)
