import type { SpriteMeta } from './sprites'

// A sprite upload that hasn't been written to disk yet. Viewers stage these
// on upload and the loader's saveItem writes them, so Discard really discards
// (see PendingSprites below) rather than leaving an orphan behind.
export type PendingSprite = { id: number; meta: SpriteMeta; png: Blob | null }

// field name on the definition (e.g. 'greenBarSpriteId') -> staged upload
export type PendingSprites = Record<string, PendingSprite>

// Highest existing sprite id + 1. `taken` reserves ids already staged in this
// editing session so two uploads before a save don't collide on one id.
export async function nextFreeSpriteId(
  spritesDir: FileSystemDirectoryHandle,
  taken: Iterable<number> = [],
): Promise<number> {
  let maxId = -1
  for await (const handle of spritesDir.values()) {
    if (handle.kind !== 'directory') continue
    const id = parseInt(handle.name, 10)
    if (!isNaN(id) && id > maxId) maxId = id
  }
  for (const id of taken) {
    if (id > maxId) maxId = id
  }
  return maxId + 1
}

// Writes a sprite archive with a PNG per frame (`<id>_<frame>.png`), which is
// the layout the dump uses and what the fonts loader reads glyphs from —
// writeNewSprite only emits frame 0, so it can't represent a 256-glyph font.
export async function writeSpriteFrames(
  spritesDir: FileSystemDirectoryHandle,
  id: number,
  meta: SpriteMeta,
  frames: (Blob | null)[],
): Promise<void> {
  await writeNewSprite(spritesDir, id, meta, null)

  const subHandle = await spritesDir.getDirectoryHandle(String(id), { create: true })
  for (let frame = 0; frame < frames.length; frame++) {
    const png = frames[frame]
    if (!png) continue
    const pngHandle = await subHandle.getFileHandle(`${id}_${frame}.png`, { create: true })
    const writable = await pngHandle.createWritable()
    await writable.write(png)
    await writable.close()
  }
}

// Writes every staged upload. Called from saveItem, never from an upload handler.
export async function writePendingSprites(
  spritesDir: FileSystemDirectoryHandle | null,
  pending: PendingSprites | undefined,
): Promise<void> {
  if (!spritesDir || !pending) return
  for (const { id, meta, png } of Object.values(pending)) {
    await writeNewSprite(spritesDir, id, meta, png)
  }
}

// Writes a brand-new sprite folder ({id}/{id}.json + optional {id}_0.png
// render) into the sprites entry — used by viewers whose uploads allocate a
// fresh sprite id rather than overwriting a shared sprite.
export async function writeNewSprite(
  spritesDir: FileSystemDirectoryHandle,
  id: number,
  meta: SpriteMeta,
  png: Blob | null,
): Promise<void> {
  const subHandle = await spritesDir.getDirectoryHandle(String(id), { create: true })

  const raw = {
    id,
    width: meta.width,
    height: meta.height,
    palette: meta.palette,
    pixelIndices: meta.pixelIndices,
    alpha: meta.alpha,
    usesAlpha: meta.usesAlpha,
    isVertical: meta.isVertical,
    offsetsX: meta.offsetsX,
    offsetsY: meta.offsetsY,
    subWidths: meta.subWidths,
    subHeights: meta.subHeights,
  }

  const jsonHandle = await subHandle.getFileHandle(`${id}.json`, { create: true })
  const jsonWritable = await jsonHandle.createWritable()
  await jsonWritable.write(JSON.stringify(raw, null, 2))
  await jsonWritable.close()

  if (png) {
    const pngHandle = await subHandle.getFileHandle(`${id}_0.png`, { create: true })
    const pngWritable = await pngHandle.createWritable()
    await pngWritable.write(png)
    await pngWritable.close()
  }
}
