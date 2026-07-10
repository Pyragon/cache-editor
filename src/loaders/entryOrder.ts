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
// grouped under `group: 'configs'` and rendered as one "Config" row with a
// dropdown rather than 28 separate sidebar rows. Several FileType names
// collide with unrelated top-level IndexType names (e.g. FileType.ENUMS is
// a config sub-archive, completely different from the top-level `enums`
// entry), so grouped entries are prefixed with `config_` to stay unique —
// except `config_quests`/`config_map_areas`, which keep the folder names
// `quests`/`areas` on disk (dumped there historically, moved under
// `configs/` so they don't get confused with unrelated top-level entries).
export type EntryDef = {
  name: string
  path: string[]
  group?: string
}

export const ENTRY_ORDER: EntryDef[] = [
  { name: 'animation_frame_sets', path: ['animations', 'frame_sets'] },
  { name: 'animation_frame_bases', path: ['animations', 'bases'] },
  // IndexType.CONFIG(2) — see FileType.java, SCT_# placeholders excluded.
  { name: 'config_underlays', path: ['configs', 'underlays'], group: 'configs' },
  { name: 'config_identikit', path: ['configs', 'identikits'], group: 'configs' },
  { name: 'config_overlays', path: ['configs', 'overlays'], group: 'configs' },
  { name: 'config_inventories', path: ['configs', 'inventories'], group: 'configs' },
  { name: 'config_objects', path: ['configs', 'objects'], group: 'configs' },
  { name: 'config_enums', path: ['configs', 'enums'], group: 'configs' },
  { name: 'config_npcs', path: ['configs', 'npcs'], group: 'configs' },
  { name: 'config_items', path: ['configs', 'items'], group: 'configs' },
  { name: 'config_params', path: ['configs', 'params'], group: 'configs' },
  { name: 'config_animations', path: ['configs', 'animations'], group: 'configs' },
  { name: 'config_spot_anims', path: ['configs', 'spot_anims'], group: 'configs' },
  { name: 'config_varbits', path: ['configs', 'varbits'], group: 'configs' },
  { name: 'config_varc_string', path: ['configs', 'varc_string'], group: 'configs' },
  { name: 'config_vars', path: ['configs', 'vars'], group: 'configs' },
  { name: 'config_varc', path: ['configs', 'varc'], group: 'configs' },
  { name: 'config_structs', path: ['configs', 'structs'], group: 'configs' },
  { name: 'config_skybox', path: ['configs', 'skyboxes'], group: 'configs' },
  { name: 'config_sun', path: ['configs', 'sun'], group: 'configs' },
  { name: 'config_light_intensities', path: ['configs', 'light_intensities'], group: 'configs' },
  { name: 'config_bas', path: ['configs', 'bas'], group: 'configs' },
  { name: 'config_cursors', path: ['configs', 'cursors'], group: 'configs' },
  { name: 'config_map_sprites', path: ['configs', 'map_sprites'], group: 'configs' },
  { name: 'config_quests', path: ['configs', 'quests'], group: 'configs' },
  { name: 'config_map_areas', path: ['configs', 'areas'], group: 'configs' },
  { name: 'config_hitsplats', path: ['configs', 'hitsplats'], group: 'configs' },
  { name: 'config_clan_var', path: ['configs', 'clan_var'], group: 'configs' },
  { name: 'config_clan_var_settings', path: ['configs', 'clan_var_settings'], group: 'configs' },
  { name: 'config_hitbars', path: ['configs', 'hitbars'], group: 'configs' },
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
  { name: 'normal_fonts', path: ['normal_fonts'] },
  { name: 'game_tips', path: ['game_tips'] },
  { name: 'jagex_fonts', path: ['jagex_fonts'] },
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
