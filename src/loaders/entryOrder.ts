// Canonical cache entry order, mirroring IndexType.java in the cryogen repo
// (com/cryo/cache/IndexType.java). A handful of IndexType members never
// produce a folder because cryogen's own unpacker has no implementation for
// them (dumpFiles() is missing, empty, or dead code) — those are included
// here for completeness/visibility but will simply fail to resolve at
// runtime and show up disabled in the sidebar. A few entries collapse
// multiple IndexType members onto one physical folder (e.g. animations/
// holds ANIMATION_FRAME_SETS, ANIMATION_FRAME_BASES and ANIMATIONS as
// separate subpaths) — those are kept as separate rows here, each pointing
// at its own subpath.
//
// IndexType.CONFIG(2) is itself a whole other index of sub-archives, listed
// in FileType.java (excluding the unnamed SCT_# placeholders). Those are
// grouped under `group: 'config'` and rendered as one "Config" row with a
// dropdown rather than 28 separate sidebar rows. Several FileType names
// collide with unrelated top-level IndexType names (e.g. FileType.ENUMS is
// a config sub-archive, completely different from the top-level `enums`
// entry), so grouped entries are prefixed with `config_` to stay unique —
// except `config_quests`/`config_map_areas`, which keep the folder names
// `quests`/`areas` on disk (dumped there historically, moved under
// `config/` so they don't get confused with unrelated top-level entries).
export type EntryDef = {
  name: string
  path: string[]
  group?: string
}

export const ENTRY_ORDER: EntryDef[] = [
  { name: 'animation_frame_sets', path: ['animations', 'frame_sets'] },
  { name: 'animation_frame_bases', path: ['animations', 'bases'] },
  // IndexType.CONFIG(2) — see FileType.java, SCT_# placeholders excluded.
  { name: 'config_underlays', path: ['config', 'underlays'], group: 'config' },
  { name: 'config_identikit', path: ['config', 'identikits'], group: 'config' },
  { name: 'config_overlays', path: ['config', 'overlays'], group: 'config' },
  { name: 'config_inventories', path: ['config', 'inventories'], group: 'config' },
  { name: 'config_objects', path: ['config', 'objects'], group: 'config' },
  { name: 'config_enums', path: ['config', 'enums'], group: 'config' },
  { name: 'config_npcs', path: ['config', 'npcs'], group: 'config' },
  { name: 'config_items', path: ['config', 'items'], group: 'config' },
  { name: 'config_params', path: ['config', 'params'], group: 'config' },
  { name: 'config_animations', path: ['config', 'animations'], group: 'config' },
  { name: 'config_spot_anims', path: ['config', 'spot_anims'], group: 'config' },
  { name: 'config_varbits', path: ['config', 'varbits'], group: 'config' },
  { name: 'config_varc_string', path: ['config', 'varc_string'], group: 'config' },
  { name: 'config_vars', path: ['config', 'vars'], group: 'config' },
  { name: 'config_varc', path: ['config', 'varc'], group: 'config' },
  { name: 'config_structs', path: ['config', 'structs'], group: 'config' },
  { name: 'config_skybox', path: ['config', 'skyboxes'], group: 'config' },
  { name: 'config_sun', path: ['config', 'sun'], group: 'config' },
  { name: 'config_light_intensities', path: ['config', 'light_intensities'], group: 'config' },
  { name: 'config_bas', path: ['config', 'bas'], group: 'config' },
  { name: 'config_cursors', path: ['config', 'cursors'], group: 'config' },
  { name: 'config_map_sprites', path: ['config', 'map_sprites'], group: 'config' },
  { name: 'config_quests', path: ['config', 'quests'], group: 'config' },
  { name: 'config_map_areas', path: ['config', 'areas'], group: 'config' },
  { name: 'config_hitsplats', path: ['config', 'hitsplats'], group: 'config' },
  { name: 'config_clan_var', path: ['config', 'clan_var'], group: 'config' },
  { name: 'config_clan_var_settings', path: ['config', 'clan_var_settings'], group: 'config' },
  { name: 'config_hitbars', path: ['config', 'hitbars'], group: 'config' },
  { name: 'interfaces', path: ['interfaces'] },
  { name: 'sound_effects', path: ['sound_effects'] },
  { name: 'maps', path: ['maps'] },
  { name: 'music', path: ['music'] },
  { name: 'models', path: ['models'] },
  { name: 'sprites', path: ['sprites'] },
  { name: 'textures', path: ['textures'] },
  { name: 'huffman', path: ['huffman'] },
  { name: 'music2', path: ['music2'] },
  { name: 'cs2', path: ['cs2'] },
  // Fonts: the metrics (IndexType 13) and the glyph bitmaps from the font
  // sprite archives (32 normal_fonts / 34 jagex_fonts) are two halves of one
  // font, joined by file id. They're served as a single "Fonts" entry, so
  // those two IndexType members have no separate row here.
  { name: 'font_metrics', path: ['fonts', 'metrics'] },
  { name: 'midi_instruments', path: ['midi_instruments'] },
  { name: 'sound_effects_midi', path: ['sound_effects_midi'] },
  { name: 'objects', path: ['objects'] },
  { name: 'enums', path: ['enums'] },
  { name: 'npcs', path: ['npcs'] },
  { name: 'items', path: ['items'] },
  { name: 'animations', path: ['animations'] },
  { name: 'spot_animations', path: ['spot_animations'] },
  { name: 'varbits', path: ['varbits'] },
  { name: 'map_areas', path: ['map_areas'] },
  { name: 'quick_chat_messages', path: ['quick_chat', 'messages'] },
  { name: 'quick_chat_menus', path: ['quick_chat', 'menus'] },
  { name: 'texture_definitions', path: ['texture_definitions'] },
  { name: 'particles', path: ['particles'] },
  { name: 'defaults', path: ['defaults'] },
  { name: 'billboards', path: ['billboards'] },
  { name: 'native_libraries', path: ['native_libraries'] },
  { name: 'shaders', path: ['shaders'] },
  { name: 'game_tips', path: ['game_tips'] },
  { name: 'cutscenes', path: ['cutscenes'] },
  { name: 'vorbis', path: ['vorbis'] },
]

const PATH_BY_NAME = new Map(ENTRY_ORDER.map((def) => [def.name, def.path]))

export function getEntryPath(name: string): string[] {
  return PATH_BY_NAME.get(name) ?? [name]
}

export async function resolveEntryHandle(
  root: FileSystemDirectoryHandle,
  path: string[],
): Promise<FileSystemDirectoryHandle | null> {
  let current = root
  for (const segment of path) {
    try {
      current = await current.getDirectoryHandle(segment)
    } catch {
      return null
    }
  }
  return current
}
