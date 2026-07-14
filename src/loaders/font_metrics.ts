import type { CacheLoader, LoadedItem } from './types'

// A font is two halves sharing a file id (darkan FontCombo/BasicFontProvider):
//   fonts/metrics/<id>.json          — advance widths, line height, padding
//   fonts/glyphs/<kind>/<id>/*.png   — one bitmap per character code
// This entry joins them. Most metrics ids are empty placeholders (5,605 of the
// 5,632 in the current dump), so the list comes from the fonts that really have
// glyphs. `kind` is "normal" (real typefaces, 256-char sets) or "jagex"
// (single-glyph logo/wordmark entries).
export type FontKind = 'normal' | 'jagex'

export type FontMetricsDef = {
  id: number
  glyphWidths?: number[]   // advance width per character code (256)
  verticalSpacing: number  // line height
  topPadding: number
  bottomPadding: number
  variadicWidth: boolean   // the per-glyph tables below only exist when true
  glyphSizesX?: number[]
  glyphSizesY?: number[]
}

export type FontData = {
  id: number
  kind: FontKind
  metrics: FontMetricsDef | null
  glyphs: Map<number, Blob>   // character code -> glyph PNG
  // Where the glyphs came from: the dedicated font index, the sprites index
  // (the client reads from either — see loadGlyphsFromSprites), or nowhere.
  glyphSource: 'fonts' | 'sprites' | 'none'
}

type GlyphIndex = { id: number; glyphCount: number; chars: number[] }

// Item selection is keyed by a numeric id app-wide, but normal and jagex are
// separate indices that can hold the SAME font id (494 exists in both), which
// made selecting one highlight both. Jagex items are offset into their own id
// range for the list, and mapped back to the real id when loading.
const JAGEX_ID_OFFSET = 1_000_000

function listId(kind: FontKind, id: number): number {
  return kind === 'jagex' ? id + JAGEX_ID_OFFSET : id
}

function realId(listedId: number): { kind: FontKind; id: number } {
  return listedId >= JAGEX_ID_OFFSET
    ? { kind: 'jagex', id: listedId - JAGEX_ID_OFFSET }
    : { kind: 'normal', id: listedId }
}

async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile()
    return JSON.parse(await file.text()) as T
  } catch {
    return null
  }
}

// fonts/glyphs/<kind>/ handles, when the glyph dump exists.
async function glyphRoots(rootHandle: FileSystemDirectoryHandle | undefined) {
  const roots: { kind: FontKind; dir: FileSystemDirectoryHandle }[] = []
  if (!rootHandle) return roots
  try {
    const fontsDir = await rootHandle.getDirectoryHandle('fonts')
    const glyphsDir = await fontsDir.getDirectoryHandle('glyphs')
    for (const kind of ['normal', 'jagex'] as FontKind[]) {
      try {
        roots.push({ kind, dir: await glyphsDir.getDirectoryHandle(kind) })
      } catch {
        // that flavour wasn't dumped
      }
    }
  } catch {
    // no glyph dump — sprites fallback below still covers every font
  }
  return roots
}

// A font's glyph archive IS a sprite archive: the client builds fonts from
// either the dedicated font index (32/34) or the sprites index (8) — see
// darkan ClientStartup, which constructs FontCombo(Resource.FONT, …) in one
// loading stage and FontCombo(Resource.SPRITES, …) in another, with the same
// font ids and metrics. The two font indices are just alternative image
// encodings of the same fonts (Resource.FONT picks index 34 over 32 when
// USING_JAGEX_IMAGE_FORMAT), and they only hold a handful of fonts, so the
// fonts the game actually uses (307, 591 …) are found here instead.
//
// sprites/<id>/<id>_<frame>.png — one frame per character code.
export async function loadGlyphsFromSprites(
  rootHandle: FileSystemDirectoryHandle,
  id: number,
): Promise<Map<number, Blob>> {
  const glyphs = new Map<number, Blob>()
  try {
    const spritesDir = await rootHandle.getDirectoryHandle('sprites')
    const fontDir = await spritesDir.getDirectoryHandle(String(id))
    for await (const handle of fontDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.png')) continue
      // "<id>_<charCode>.png"
      const match = handle.name.match(/_(\d+)\.png$/)
      if (!match) continue
      glyphs.set(parseInt(match[1], 10), await handle.getFile())
    }
  } catch {
    // no sprite archive for this id
  }
  return glyphs
}

const loader: CacheLoader = {
  // The list is driven by the METRICS, not the glyph dump: a font exists if it
  // has metrics, and its glyphs come from fonts/glyphs/ when dumped or from
  // sprites/<id>/ otherwise. Listing from the glyph dump alone would hide the
  // fonts the game actually uses (307, 591), which live only in sprites.
  // Most metrics ids are empty placeholders (5,605 of 5,632), so those are
  // skipped.
  async *streamItems(dirHandle, rootHandle) {
    const roots = await glyphRoots(rootHandle)
    const jagexIds = new Set<number>()
    if (roots.length > 0) {
      const jagexRoot = roots.find((r) => r.kind === 'jagex')
      if (jagexRoot) {
        for await (const handle of jagexRoot.dir.values()) {
          if (handle.kind !== 'directory') continue
          const id = parseInt(handle.name, 10)
          if (!isNaN(id)) jagexIds.add(id)
        }
      }
    }

    for await (const handle of dirHandle.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
      const id = parseInt(handle.name, 10)
      if (isNaN(id)) continue
      const def = await readJson<FontMetricsDef>(dirHandle, handle.name)
      if (!def?.verticalSpacing && !def?.variadicWidth) continue
      yield { id, name: `${id} · normal` } satisfies LoadedItem
    }

    // Jagex-format fonts are the same fonts re-encoded, so they only appear as
    // extra items when that flavour was actually dumped.
    for (const id of [...jagexIds].sort((a, b) => a - b)) {
      yield { id: listId('jagex', id), name: `${id} · jagex` } satisfies LoadedItem
    }
  },

  async loadItem(dirHandle, item, rootHandle) {
    const { kind, id } = realId(item.id)

    const metrics = await readJson<FontMetricsDef>(dirHandle, `${id}.json`)

    // Glyph source, in the client's own order of preference: the dedicated
    // font index (fonts/glyphs/) when it has this font, else the sprites index.
    let glyphs = new Map<number, Blob>()
    let glyphSource: FontData['glyphSource'] = 'none'

    const root = (await glyphRoots(rootHandle)).find((r) => r.kind === kind)
    if (root) {
      try {
        const fontDir = await root.dir.getDirectoryHandle(String(id))
        const index = await readJson<GlyphIndex>(fontDir, 'index.json')
        await Promise.all((index?.chars ?? []).map(async (code) => {
          try {
            glyphs.set(code, await (await fontDir.getFileHandle(`${code}.png`)).getFile())
          } catch {
            // listed but missing — skip
          }
        }))
        if (glyphs.size > 0) glyphSource = 'fonts'
      } catch {
        // no glyph folder for this id — sprites fallback below
      }
    }

    if (glyphs.size === 0 && rootHandle) {
      glyphs = await loadGlyphsFromSprites(rootHandle, id)
      if (glyphs.size > 0) glyphSource = 'sprites'
    }

    // The real font id, not the offset list id — it's what's displayed and
    // what the metrics file is named.
    return { id, kind, metrics, glyphs, glyphSource } satisfies FontData
  },

  // Only the metrics half is editable; glyph bitmaps come from the sprite
  // archives and aren't repackable yet.
  async saveItem(dirHandle, item, data) {
    const { metrics } = data as FontData
    if (!metrics) return
    const { id } = realId(item.id)
    const fileHandle = await dirHandle.getFileHandle(`${id}.json`, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(metrics, null, 2))
    await writable.close()
  },
}

export default loader
