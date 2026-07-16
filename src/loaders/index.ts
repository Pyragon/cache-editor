import type { CacheLoader } from './types'
import animation_frame_bases from './animation_frame_bases'
import animation_frame_sets from './animation_frame_sets'
import animations from './animations'
import billboards from './billboards'
import config_cursors from './config/cursors'
import config_hitbars from './config/hitbars'
import config_light_intensities from './config/light_intensities'
import config_varc from './config/varc'
import config_varc_string from './config/varc_string'
import config_clan_var from './config/clan_var'
import config_clan_var_settings from './config/clan_var_settings'
import config_underlays from './config/underlays'
import config_overlays from './config/overlays'
import maps from './maps'
import game_tips from './game_tips'
import config_hitsplats from './config/hitsplats'
import config_identikit from './config/identikit'
import config_inventories from './config/inventories'
import config_map_areas from './config/map_areas'
import config_map_sprites from './config/map_sprites'
import config_params from './config/params'
import config_quests from './config/quests'
import config_skybox from './config/skyboxes'
import config_structs from './config/structs'
import config_sun from './config/sun'
import config_vars from './config/vars'
import cs2 from './cs2'
import defaults from './defaults'
import enums from './enums'
import font_metrics from './font_metrics'
import huffman from './huffman'
import interfaces from './interfaces'
import items from './items'
import map_areas from './map_areas'
import midi_instruments from './midi_instruments'
import models from './models'
import native_libraries from './native_libraries'
import npcs from './npcs'
import objects from './objects'
import particles from './particles'
import quick_chat_menus from './quick_chat_menus'
import quick_chat_messages from './quick_chat_messages'
import sound_effects from './sound_effects'
import spot_animations from './spot_animations'
import sprites from './sprites'
import texture_definitions from './texture_definitions'
import textures from './textures'
import varbits from './varbits'

const registry: Record<string, CacheLoader> = {
  animation_frame_bases,
  animation_frame_sets,
  animations,
  billboards,
  config_cursors,
  config_hitbars,
  config_light_intensities,
  config_varc,
  config_varc_string,
  config_clan_var,
  config_clan_var_settings,
  config_underlays,
  config_overlays,
  maps,
  game_tips,
  config_hitsplats,
  config_identikit,
  config_inventories,
  config_map_areas,
  config_map_sprites,
  config_params,
  config_quests,
  config_skybox,
  config_structs,
  config_sun,
  config_vars,
  cs2,
  defaults,
  enums,
  font_metrics,
  huffman,
  interfaces,
  items,
  map_areas,
  midi_instruments,
  models,
  native_libraries,
  npcs,
  objects,
  particles,
  quick_chat_menus,
  quick_chat_messages,
  sound_effects,
  spot_animations,
  sprites,
  texture_definitions,
  textures,
  varbits,
}

export function getLoader(name: string): CacheLoader | null {
  return registry[name] ?? null
}

export type { CacheLoader, LoadedItem, QuestServerData } from './types'
export { ENTRY_ORDER, getEntryPath, resolveEntryHandle } from './entryOrder'
export type { EntryDef } from './entryOrder'
