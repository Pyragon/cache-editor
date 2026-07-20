# How the world map works (rev 727)

Findings from reading darkan-bot-refactor (`graphics/map/worldmap/WorldMap.kt`,
`WorldMapSub1.kt`) and cryogen (`loaders/map/WorldMapAreaDefinitions.java`),
2026-07-19. Written down because the world map is easy to confuse with the
minimap — they share a visual language but have completely different data
sources.

## It's rendered, but from pre-baked data

The world map lives in its **own cache index — `MAP_AREAS` (index 23)** —
separate from the maps index the 3D scene and minimap use. It is *rendered*
by the client (not stitched from screenshots), but from a **frozen, offline
bake** of the world:

- **`details` archive** — one record per world map area (name,
  `filenamePrefix`, bounds/`areaRects`, which surface it shows). Cryogen's
  `WorldMapAreaDefinitions` decodes these and dumps them to
  `unpacked/map_areas/`.
- **`<filenamePrefix>` archives** — the baked tile data per area:
  - underlay colours stored as **literal pre-blended RGB per tile**
    (`underlayRgbColors` + `underlayGreenBlue` in WorldMap.kt) — Jagex ran
    the blur/lighting offline and shipped the *result*, so the world map
    doesn't recompute anything from underlay configs;
  - overlay ids (`overlayIds`, resolved through `overlayFloorColors`);
  - loc placements + rotations used to stamp mapscene sprites (trees/rocks —
    `renderObjectSprites`, same MapSpriteType path as the minimap).
- **`<filenamePrefix>_staticelements` archives** — explicit icon/label
  placements (see below).

Because the bake is frozen, the world map historically lagged behind actual
map edits — and it will not reflect edits made in this editor unless the
MAP_AREAS bake is regenerated.

## Icons: two sources, only one feeds the minimap

This explains "an icon is on the world map but not on the minimap":

1. **Object placements** — an object def's `mapCategoryId` points at an
   areas-config entry (MECType); its icon (`defaultIconArchive` sprite) is
   drawn at every placed instance of the object. These appear on **both**
   the minimap and the world map. This is what our editor minimap draws.
2. **Static elements** — icons/labels Jagex pinned **explicitly at
   coordinates** in the worldmap index, independent of any object
   (`StaticElementPlacement` = areas-config element id + coordinate). These
   appear **only on the world map**, never on the minimap — in the real
   client too.

So a world-map-only icon is (almost always) a static element. To check a
specific one: cryogen dumps them to `unpacked/map_areas/static_elements/`,
and the areas config viewer's **"Placed At" list** shows every static
placement of an area's icon.

(Edge case: the minimap only shows the current plane — an icon from an
object on another plane also won't show. Our editor minimap draws plane 0.)

## Related editor facts

- The editor's minimap is generated live from the maps index (mosaic-blurred
  underlay palette + slope lighting + overlay minimap colours + shape masks
  + wall lines + mapscene sprites + object-derived map icons) — it matches
  the *client minimap*, not the world map.
- Fields worth remembering: areas config `defaultIconArchive` is the icon
  sprite (its `spriteId` field is the worldmap-label channel and is -1 on
  regular icons); overlay `minimapColorRgb` is the minimap-only colour
  channel.

## Possible future work (also listed in TODO.md)

- Overlay static elements on the editor minimap as a toggleable aid (dimmed),
  so world-map-only icons are visible/editable in context.
- A proper world map view rendered from the MAP_AREAS data.
- A "rebake worldmap from current maps" pipeline, so editor map edits can be
  reflected on the world map.
