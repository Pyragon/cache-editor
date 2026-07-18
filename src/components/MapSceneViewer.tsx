import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MapData, MapRegionDef } from '../loaders/maps'
import { SIZE, decodeTerrain } from '../loaders/maps'
import { buildTerrainMesh, buildLocsMesh, buildMarkersMesh, buildRegionOutline, loadSceneConfigs, LocAssets, SceneMosaic, MARKER_COLORS } from './mapScene'
import type { SceneConfigs, LocRef, MarkerInfo } from './mapScene'
import { getEntryPath, resolveEntryHandle } from '../loaders/entryOrder'
import './MapSceneViewer.css'

// 3D scene preview of a map region and its 8 neighbours (the client always
// builds a 3×3 block — buildings that straddle a region boundary only look
// right with the neighbours present). Region outlines and floating markers
// (sound emitters / map-icon anchors) are editor aids on top.
// See mapScene.ts for the ported client pipeline.

const REGION_UNITS = SIZE * 512

let cachedConfigs: { root: FileSystemDirectoryHandle; configs: SceneConfigs } | null = null

export default function MapSceneViewer({ data }: { data: MapData }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [visiblePlanes, setVisiblePlanes] = useState([true, true, true, true])
  const [showLocs, setShowLocs] = useState(true)
  const [showNeighbors, setShowNeighbors] = useState(true)
  const [showOutlines, setShowOutlines] = useState(true)
  const [showMarkers, setShowMarkers] = useState(true)
  const [status, setStatus] = useState('building terrain…')
  const [hoverText, setHoverText] = useState('')
  const [selection, setSelection] = useState<{
    kind: 'loc' | 'marker' | 'tile'
    title: string
    lines: string[]
  } | null>(null)
  const planeGroupsRef = useRef<(THREE.Group | null)[]>([null, null, null, null])
  type Tagged = { obj: THREE.Object3D; neighbor: boolean; kind: 'terrain' | 'loc' | 'marker' | 'outline' }
  const taggedRef = useRef<Tagged[]>([])
  const assetsRef = useRef<LocAssets | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false

    const w = mount.clientWidth || 900
    const h = mount.clientHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    renderer.setClearColor(0x0b0d12)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x0b0d12, REGION_UNITS * 2, REGION_UNITS * 5)
    const camera = new THREE.PerspectiveCamera(50, w / h, 8, REGION_UNITS * 10)
    const center = new THREE.Vector3(REGION_UNITS / 2, 0, -REGION_UNITS / 2)
    camera.position.set(center.x, REGION_UNITS * 0.55, center.z + REGION_UNITS * 0.75)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.maxPolarAngle = Math.PI / 2 - 0.02
    controls.update()

    const disposables: { dispose(): void }[] = []
    // materials with animated UVs: data-driven scroll (waterfalls, lava —
    // offset = seconds*speed/64, OpenGlToolkit convention) and still water
    // (client ripple effect approximated by a gentle drifting wobble)
    const scrollMaterials: { map: THREE.Texture; u: number; v: number }[] = []
    const waterMaterials: THREE.Texture[] = []
    const track = (obj: THREE.Object3D) => {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) disposables.push(mesh.geometry)
        if (mesh.material) {
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            disposables.push(m)
            const basic = m as THREE.MeshBasicMaterial
            if (basic.map && m.userData.scroll) {
              scrollMaterials.push({ map: basic.map, u: m.userData.scroll.u, v: m.userData.scroll.v })
              disposables.push(basic.map) // per-material texture clone
            } else if (basic.map && m.userData.water) {
              waterMaterials.push(basic.map)
              disposables.push(basic.map)
            }
          }
        }
      })
      return obj
    }

    // --- picking: hover tile highlight + click-to-select -----------------
    renderer.domElement.style.cursor = 'crosshair'
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerInside = false
    const TILE = 512

    function tileOutline(color: number): THREE.LineLoop {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0, TILE, 0, 0, TILE, 0, -TILE, 0, 0, -TILE,
      ]), 3))
      const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, linewidth: 2 }))
      line.visible = false
      line.raycast = () => {} // never pickable
      scene.add(line)
      return line
    }
    const hoverOutline = tileOutline(0xffe14d)
    const selectOutline = tileOutline(0xff5ad2)

    function pick(): THREE.Intersection | null {
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(scene.children, true)
      for (const hit of hits) {
        if (!(hit.object as THREE.Mesh).isMesh) continue // skip lines/outlines
        let visible = true
        for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
          if (!o.visible) { visible = false; break }
        }
        if (visible) return hit
      }
      return null
    }

    function worldTileOf(point: THREE.Vector3): { wx: number; wy: number; tx: number; ty: number } {
      const tx = Math.floor(point.x / TILE)
      const ty = Math.floor(-point.z / TILE)
      return { wx: data.def.regionX * 64 + tx, wy: data.def.regionY * 64 + ty, tx, ty }
    }

    function onPointerMove(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      pointerInside = true
    }
    function onPointerLeave() {
      pointerInside = false
      hoverOutline.visible = false
      setHoverText('')
    }

    let downX = 0, downY = 0
    function onPointerDown(e: PointerEvent) {
      downX = e.clientX
      downY = e.clientY
    }
    function onPointerUp(e: PointerEvent) {
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return // orbit drag
      const hit = pick()
      if (!hit) {
        setSelection(null)
        selectOutline.visible = false
        return
      }
      const mesh = hit.object as THREE.Mesh
      const { wx, wy, tx, ty } = worldTileOf(hit.point)
      const faceIndex = hit.faceIndex ?? -1

      if (mesh.userData.markers && faceIndex >= 0) {
        const marker = (mesh.userData.markers as MarkerInfo[])[faceIndex >> 3]
        if (marker) {
          const gp = new THREE.Vector3()
          mesh.getWorldPosition(gp)
          const regionX = data.def.regionX + Math.round(gp.x / (64 * TILE))
          const regionY = data.def.regionY - Math.round(gp.z / (64 * TILE))
          const mwx = regionX * 64 + marker.tileX
          const mwy = regionY * 64 + marker.tileY
          setSelection({
            kind: 'marker',
            title: `${marker.kind === 'sound' ? 'Sound emitter' : marker.kind === 'mapicon' ? 'Map icon anchor' : marker.kind === 'barrier' ? 'Barrier wall' : 'Marker'} — object ${marker.objectId}`,
            lines: [`world tile ${mwx}, ${mwy}`],
          })
          selectOutline.position.set(gp.x + marker.tileX * TILE, gp.y + marker.y + 8, gp.z - marker.tileY * TILE)
          selectOutline.visible = true
          void (async () => {
            const def = await assetsRef.current?.getDef(marker.objectId)
            if (def) {
              setSelection((prev) => prev && {
                ...prev,
                lines: [
                  `world tile ${mwx}, ${mwy}`,
                  def.ambientSoundId !== undefined ? `ambient sound ${def.ambientSoundId}` : '',
                  def.soundId !== undefined ? `sound ${def.soundId}` : '',
                  def.soundGroupIds?.length ? `sound group [${def.soundGroupIds.join(', ')}]` : '',
                  def.mapCategoryId !== undefined && def.mapCategoryId >= 0 ? `map category ${def.mapCategoryId}` : '',
                ].filter(Boolean),
              })
            }
          })()
          return
        }
      }

      if (mesh.userData.locs && faceIndex >= 0) {
        const owners = mesh.userData.triangleOwners as Int32Array
        const owner = owners?.[faceIndex] ?? -1
        const loc = owner >= 0 ? (mesh.userData.locs as LocRef[])[owner] : undefined
        if (loc) {
          // loc tile coords are region-local to the mesh's own region
          const meshRegionX = data.def.regionX + Math.round(mesh.position.x / (64 * TILE))
          const meshRegionY = data.def.regionY - Math.round(mesh.position.z / (64 * TILE))
          setSelection({
            kind: 'loc',
            title: `Object ${loc.objectId}`,
            lines: [
              `world tile ${meshRegionX * 64 + loc.x}, ${meshRegionY * 64 + loc.y}, plane ${loc.plane}`,
              `shape ${loc.shape}, rotation ${loc.rotation}`,
            ],
          })
          selectOutline.position.set(mesh.position.x + loc.x * TILE, hit.point.y + 10, mesh.position.z - loc.y * TILE)
          selectOutline.visible = true
          void (async () => {
            const def = await assetsRef.current?.getDef(loc.objectId)
            if (def) {
              setSelection((prev) => prev && {
                ...prev,
                title: `${def.name && def.name !== 'null' ? def.name : 'Object'} (${loc.objectId})`,
                lines: [
                  `world tile ${meshRegionX * 64 + loc.x}, ${meshRegionY * 64 + loc.y}, plane ${loc.plane}`,
                  `shape ${loc.shape}, rotation ${loc.rotation}, size ${def.sizeX ?? 1}×${def.sizeY ?? 1}`,
                  def.objectModelIds ? `models [${def.objectModelIds.flat().join(', ')}]` : '',
                ].filter(Boolean),
              })
            }
          })()
          return
        }
      }

      if (mesh.userData.isTerrain) {
        setSelection({
          kind: 'tile',
          title: `Tile ${wx}, ${wy}`,
          lines: [`region ${Math.floor(wx / 64)}, ${Math.floor(wy / 64)} — local ${((wx % 64) + 64) % 64}, ${((wy % 64) + 64) % 64}`],
        })
        selectOutline.position.set(tx * TILE, hit.point.y + 10, -ty * TILE)
        selectOutline.visible = true
        return
      }

      setSelection(null)
      selectOutline.visible = false
    }

    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    let raf = 0
    let frame = 0
    function animate() {
      controls.update()
      if (scrollMaterials.length > 0 || waterMaterials.length > 0) {
        const seconds = (performance.now() % 512000) / 1000
        for (const { map, u, v } of scrollMaterials) {
          map.offset.set(((seconds * u) / 64) % 1, ((seconds * v) / 64) % 1)
        }
        // still water: slow diagonal drift with a subtle swell
        const wu = (seconds * 0.022 + Math.sin(seconds * 0.8) * 0.012) % 1
        const wv = (seconds * 0.031 + Math.cos(seconds * 0.6) * 0.012) % 1
        for (const map of waterMaterials) map.offset.set(wu, wv)
      }
      // hover raycast every other frame — cheap enough, keeps orbit smooth
      if (pointerInside && (frame++ & 1) === 0) {
        const hit = pick()
        if (hit) {
          const { wx, wy, tx, ty } = worldTileOf(hit.point)
          hoverOutline.position.set(tx * TILE, hit.point.y + 8, -ty * TILE)
          hoverOutline.visible = true
          setHoverText(`tile ${wx}, ${wy}`)
        } else {
          hoverOutline.visible = false
          setHoverText('')
        }
      }
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    function onResize() {
      const nw = mount!.clientWidth || w
      const nh = mount!.clientHeight || h
      renderer.setSize(nw, nh)
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(mount)

    ;(async () => {
      try {
        if (!data.rootHandle) {
          setStatus('no cache root available')
          return
        }
        if (!cachedConfigs || cachedConfigs.root !== data.rootHandle) {
          cachedConfigs = { root: data.rootHandle, configs: await loadSceneConfigs(data.rootHandle) }
        }
        const configs = cachedConfigs.configs
        if (disposed) return

        const assets = new LocAssets(data.rootHandle)
        assetsRef.current = assets
        const mapsDir = await resolveEntryHandle(data.rootHandle, getEntryPath('maps'))

        for (let plane = 0; plane < 4; plane++) {
          const group = new THREE.Group()
          scene.add(group)
          planeGroupsRef.current[plane] = group
        }
        const outlines = new THREE.Group()
        scene.add(outlines)

        // load all 9 cells first — the mosaic needs every terrain up front so
        // heights/lighting/underlay-blur are seam-free across boundaries
        setStatus('loading regions…')
        type Cell = { dx: number; dy: number; def: MapRegionDef; terrain: ReturnType<typeof decodeTerrain> }
        const cells: Cell[] = [{ dx: 0, dy: 0, def: data.def, terrain: data.terrain }]
        const regionGrid: (Cell['terrain'] | null)[][] = [[null, null, null], [null, null, null], [null, null, null]]
        regionGrid[1][1] = data.terrain
        if (mapsDir) {
          for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
              if (dx === 0 && dy === 0) continue
              try {
                const id = ((data.def.regionX + dx) << 8) | (data.def.regionY + dy)
                const file = await (await mapsDir.getFileHandle(`${id}.json`)).getFile()
                const def = JSON.parse(await file.text()) as MapRegionDef
                const terrain = decodeTerrain(def)
                cells.push({ dx, dy, def, terrain })
                regionGrid[dx + 1][dy + 1] = terrain
              } catch { /* neighbour not dumped */ }
            }
          }
        }
        setStatus('computing mosaic…')
        const mosaic = new SceneMosaic(regionGrid, data.def.regionX, data.def.regionY, configs)
        if (disposed) return

        for (const { dx, dy, def, terrain } of cells) {
          const isCenter = dx === 0 && dy === 0
          if (disposed) return

          const offsetX = dx * REGION_UNITS
          const offsetZ = -dy * REGION_UNITS
          const label = isCenter ? 'this region' : `neighbour ${def.regionX},${def.regionY}`
          setStatus(`terrain: ${label}…`)
          const { heights, lights } = mosaic.slicesFor(dx, dy)
          const palettes = [0, 1, 2, 3].map((plane) => mosaic.paletteFor(dx, dy, plane))

          for (let plane = 0; plane < 4; plane++) {
            const terrainMesh = await buildTerrainMesh(terrain, plane, heights, configs, assets, {
              lights,
              palettes,
            })
            if (disposed) return
            if (terrainMesh) {
              terrainMesh.position.set(offsetX, 0, offsetZ)
              track(terrainMesh)
              planeGroupsRef.current[plane]?.add(terrainMesh)
              taggedRef.current.push({ obj: terrainMesh, neighbor: !isCenter, kind: 'terrain' })
            }
          }

          if (def.hasLocations && def.objects.length > 0) {
            for (let plane = 0; plane < 4; plane++) {
              const { mesh, markers } = await buildLocsMesh(
                terrain, def.objects, plane, heights, assets,
                (done, total) => setStatus(`objects (${label}, plane ${plane}): ${done}/${total}`),
              )
              if (disposed) return
              if (mesh) {
                mesh.position.set(offsetX, 0, offsetZ)
                track(mesh)
                planeGroupsRef.current[plane]?.add(mesh)
                taggedRef.current.push({ obj: mesh, neighbor: !isCenter, kind: 'loc' })
              }
              if (markers.length > 0) {
                const markerGroup = buildMarkersMesh(markers)
                if (markerGroup) {
                  markerGroup.position.set(offsetX, 0, offsetZ)
                  track(markerGroup)
                  planeGroupsRef.current[plane]?.add(markerGroup)
                  taggedRef.current.push({ obj: markerGroup, neighbor: !isCenter, kind: 'marker' })
                }
              }
            }
          }

          // outline every region's perimeter; centre gets the bright colour
          const outline = buildRegionOutline(heights[0], isCenter ? 0x2f8fff : 0x9a5cff)
          outline.position.set(offsetX, 0, offsetZ)
          track(outline)
          outlines.add(outline)
          taggedRef.current.push({ obj: outline, neighbor: !isCenter, kind: 'outline' })
        }
        setStatus('')
      } catch (e) {
        setStatus(`scene build failed: ${e}`)
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      for (const d of disposables) d.dispose()
      void assetsRef.current?.dispose()
      assetsRef.current = null
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      planeGroupsRef.current = [null, null, null, null]
      taggedRef.current = []
    }
  }, [data])

  // visibility = plane toggle (via group) AND per-kind toggle AND neighbour toggle
  useEffect(() => {
    planeGroupsRef.current.forEach((group, plane) => {
      if (group) group.visible = visiblePlanes[plane]
    })
    for (const { obj, neighbor, kind } of taggedRef.current) {
      const kindOn = kind === 'loc' ? showLocs : kind === 'marker' ? showMarkers : kind === 'outline' ? showOutlines : true
      obj.visible = kindOn && (!neighbor || showNeighbors)
    }
  }, [visiblePlanes, showLocs, showMarkers, showOutlines, showNeighbors, status])

  return (
    <div className="mapscene">
      <div className="mapscene-controls">
        {[0, 1, 2, 3].map((plane) => (
          <label key={plane} className="mapscene-toggle">
            <input
              type="checkbox"
              checked={visiblePlanes[plane]}
              onChange={(e) => setVisiblePlanes((prev) => prev.map((v, i) => (i === plane ? e.target.checked : v)))}
            />
            Plane {plane}
          </label>
        ))}
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showLocs} onChange={(e) => setShowLocs(e.target.checked)} />
          Objects
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showNeighbors} onChange={(e) => setShowNeighbors(e.target.checked)} />
          Adjacent regions
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
          Region outlines
        </label>
        <label className="mapscene-toggle">
          <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
          <span className="mapscene-marker-key">
            Markers (<span style={{ color: '#ff9d3a' }}>sound</span>/<span style={{ color: '#b47aff' }}>map icon</span>/<span style={{ color: '#ff5a5a' }}>barrier</span>)
          </span>
        </label>
        {status && <span className="mapscene-status">{status}</span>}
        {!status && hoverText && <span className="mapscene-hover">{hoverText}</span>}
      </div>
      <div className="mapscene-view">
        <div ref={mountRef} className="mapscene-mount" />
        {selection && (
          <div className="mapscene-info">
            <div className="mapscene-info-title">
              {selection.kind === 'marker' && (
                <span
                  className="mapscene-info-dot"
                  style={{ background: `#${MARKER_COLORS[
                    selection.title.startsWith('Sound') ? 'sound'
                    : selection.title.startsWith('Map') ? 'mapicon'
                    : selection.title.startsWith('Barrier') ? 'barrier'
                    : 'other'
                  ].toString(16).padStart(6, '0')}` }}
                />
              )}
              {selection.title}
            </div>
            {selection.lines.map((line, i) => <div key={i} className="mapscene-info-line">{line}</div>)}
            <button type="button" className="mapscene-info-close" onClick={() => setSelection(null)}>×</button>
          </div>
        )}
      </div>
    </div>
  )
}
