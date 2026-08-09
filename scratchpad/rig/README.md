# procgen measurement rig

A vite `--ssr` bundle of the **real** `src/procgen` modules with a filesystem
shim standing in for the File System Access API, so measurements go through the
code that ships rather than a reimplementation of it. That distinction has
already mattered several times — see the "verify through the function the
renderer actually calls" lesson in `docs/map-learning.md` §11.

```
RIG_ENTRY=<entry> ./node_modules/.bin/vite build -c scratchpad/rig/vite.config.mjs
node scratchpad/rig/out/<entry>.mjs
```

| entry | what it answers |
|---|---|
| `roles.ts` | did moving the themes to roles change what they plant? (needs a `plannerBefore.ts` snapshot — see its header) |
| `ground.ts` | what does the map grow on each ground role the palette binds? |
| `bytes.ts` | which underlay bytes are temperate and which are jungle, ranked |
| `rebind.ts` | palette rebind candidates: rgb + jungle share + evidence per role |
| `storeys.ts` | §8.1 — what upper-plane tiles carry, tile-flag bit census, stairs |
| `interiors.ts` | wall-ring flood fill — what a ROOM floor carries, overhang rate |
| `footprints.ts` | §8.3 layer-1 footprint vocabulary — sizes, fill ratio, rect decomposition |
| `docks.ts` | §15 — what a pier is made of: water definition, deck vocabulary, walkway width, deck families, trim |
| `brief.ts` | generate the real planningBrief() offline and write it to procgen/ |

`shim.ts` provides `dirHandle(path)` and inert `localStorage` / `indexedDB`.
Only three filesystem operations are needed (`.values()`, `getFile().text()`,
`getDirectoryHandle`), so the shim stays small.

The cache path is a constant at the top of each entry
(`D:/workspace/github/cryogen-cache/unpacked`).

Mining the whole cache is ~25 s in Node (74k objects + 2,413 regions + context
model + clustering), so entries build the index once and reuse it.
