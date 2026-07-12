import type { SpriteMeta } from './sprites'

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
