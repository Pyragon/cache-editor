import type { CacheLoader } from './types'
import { deleteJsonItem, nextFreeJsonId, writeJsonItem } from './common'

// Known fields (post-rename dumper, per darkan-bot-refactor ObjectType.kt);
// the index signature keeps any extra/unknown keys intact through edits.
export type ObjectDef = {
  id?: number
  name: string
  shapes?: number[]
  objectModelIds?: number[][]
  options?: (string | null)[]
  originalColors?: number[]
  modifiedColors?: number[]
  originalTextures?: number[]
  modifiedTextures?: number[]
  recolorDPalette?: number[]
  animations?: number[]
  animProbs?: number[]
  animVals?: number[]
  transformTo?: number[]
  soundGroupIds?: number[]
  quests?: number[]
  parameters?: Record<string, number | string>
  [key: string]: unknown
}

export type ObjectData = {
  id: number
  object: ObjectDef
}

// Mirrors ObjectDefinitions' no-arg constructor defaults in cryogen.
const NEW_OBJECT_DEFAULTS: ObjectDef = {
  name: 'null',
  sizeX: 1, sizeY: 1,
  clipType: 2,
  blocks: true,
  interactable: -1,
  groundContourType: 0, groundContourModifier: -1,
  delayShading: false,
  occludes: -1,
  cullY: 960, cullXZ: 0,
  decorDisplacement: 64,
  ambient: 0, contrast: 0,
  primaryCursorActionIndex: -1, primaryCursor: -1,
  secondaryCursorActionIndex: -1, secondaryCursor: -1,
  mapCategoryId: -1, mapSpriteId: -1,
  adjustMapSceneRotation: false, mapSpriteRotation: 0, flipMapSprite: false,
  inverted: false,
  staticShadow: true, dynamicShadow: true,
  scaleX: 128, scaleY: 128, scaleZ: 128,
  offsetX: 0, offsetY: 0, offsetZ: 0,
  shadowOffsetX: 0, shadowOffsetY: 0, shadowOffsetZ: 0,
  obstructsGround: false,
  ignoreClipOnAltRoute: false,
  supportsItems: -1,
  groundDecorationHeight: 0,
  varpBit: -1, varp: -1,
  ambientSoundId: -1, ambientSoundHearDistance: 0, ambientSoundMaxHearDistance: 0,
  ambientSoundVolume: -1,
  soundMinInterval: 0, soundMaxInterval: 0,
  ambientSoundMaxDelay: -1, ambientSoundMinDelay: 0,
  instrumentSoundEffect: false, instrumentAmbientSound: false,
  replaySequence: true,
  requiresTextures: false,
  members: false,
  hasAnimation: false,
  accessBlockFlag: 0,
  transforms: false,
  dynamicTint: false,
  tintHue: 0, tintSaturation: 0, tintLightness: 0, tintOpacity: 0,
  options: [null, null, null, null, null],
}

const NAME_REGEX = /"name":\s*"((?:[^"\\]|\\.)*)"/

const loader: CacheLoader = {
  // Reads every object file to surface names in the list, batched in
  // parallel so ~74k files stay tolerable.
  async *streamItems(dirHandle) {
    const ids: number[] = []
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && handle.name.endsWith('.json')) {
        const id = parseInt(handle.name.slice(0, -5), 10)
        if (!isNaN(id)) ids.push(id)
      }
    }

    const CHUNK = 250
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const results = await Promise.all(chunk.map(async (id) => {
        try {
          const fileHandle = await dirHandle.getFileHandle(`${id}.json`)
          const text = await (await fileHandle.getFile()).text()
          const match = text.match(NAME_REGEX)
          const name = match ? JSON.parse(`"${match[1]}"`) as string : 'null'
          return { id, name: `${id} - ${name}` }
        } catch {
          return { id, name: String(id) }
        }
      }))
      yield* results
    }
  },

  async loadItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const def = JSON.parse(await file.text()) as ObjectDef
    return { id: item.id, object: def } satisfies ObjectData
  },

  async saveItem(dirHandle, item, data) {
    const { object: def } = data as ObjectData
    await writeJsonItem(dirHandle, item.id, def)
  },

  async createItem(dirHandle) {
    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...NEW_OBJECT_DEFAULTS, id })
    return { id, name: `${id} - null` }
  },

  async deleteItem(dirHandle, item) {
    await deleteJsonItem(dirHandle, item.id)
  },

  async cloneItem(dirHandle, item) {
    const fileHandle = await dirHandle.getFileHandle(`${item.id}.json`)
    const file = await fileHandle.getFile()
    const source = JSON.parse(await file.text()) as ObjectDef

    const id = await nextFreeJsonId(dirHandle)
    await writeJsonItem(dirHandle, id, { ...source, id })
    return { id, name: `${id} - ${source.name ?? 'null'}` }
  },
}

export default loader
