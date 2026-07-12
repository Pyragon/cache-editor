# TODO

## Quests

- **Slot ID mapping is hardcoded** — `QUEST_ID_TO_SLOT` in `quests.ts` was extracted manually from `Quests.java`. Figure out if/how this mapping can be derived directly from the cache so it doesn't go stale.
- **`_levelRequirements` (quest JSON) vs `skillReqs` (struct cache) are the same data** stored in two places. Decide whether to keep both sections or merge them into one that reads/writes both locations on save.
- **`_questPrerequisiteIds` (quest JSON) vs `prereqQuestIds` (struct cache)** are similarly duplicated. Same decision needed.
- **Ask Claude the difference between Skill Requirements (Cache) and Level Requirements, as well as Prereq Quest IDs and Prereq Quest IDs (Cache).**
- **`preReqSkillReqs` (accumulated from prereq tree)** was removed from the UI. May want to add it back as a read-only computed display to show total skill requirements including all prerequisites.
- **Struct skill req max** — `writeStruct` clears up to 7 skill req pairs (keys 871–884). Verify no quest needs more than 7.

- **Get the rest of quest structs within the editor to edit the quest start interface.**

## Sprites

- **Look into the vertical field in sprites, should they be rotated?**

## Map Sprites

- **Add a 'preview' to map_sprites to show what they would look like on a proper minimap.**

## General Editor

- **Add/Remove/Clone buttons** are wired up via optional `createItem`/`deleteItem`/`cloneItem` loader methods, but only `config_cursors` and `config_map_sprites` implement them — every other entry's buttons render disabled until its loader adds CRUD support.
- **Huffman** — user noted it should be loaded differently eventually (current display is functional but rough).
- **Detail viewers** for other cache types still show raw JSON: `items`, `npcs`, `objects`, `animations`, `areas`, `sprites`, `textures`, `interfaces`, `models`, `config` subfolders, etc.
- **Open Cache button** shows `📁 folderName` — consider a cleaner label or breadcrumb.
- **Error handling** — if a struct file is missing or malformed, the quest silently shows no server data. Could surface a visible warning.
