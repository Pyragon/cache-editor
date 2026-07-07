import type { CacheLoader } from './types'
import animations from './animations'
import areas from './areas'
import billboards from './billboards'
import config from './config'
import cs2 from './cs2'
import defaults from './defaults'
import enums from './enums'
import fonts from './fonts'
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
import quests from './quests'
import quick_chat from './quick_chat'
import sound_effects from './sound_effects'
import spot_animations from './spot_animations'
import sprites from './sprites'
import texture_definitions from './texture_definitions'
import textures from './textures'
import varbits from './varbits'

const registry: Record<string, CacheLoader> = {
  animations,
  areas,
  billboards,
  config,
  cs2,
  defaults,
  enums,
  fonts,
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
  quests,
  quick_chat,
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
