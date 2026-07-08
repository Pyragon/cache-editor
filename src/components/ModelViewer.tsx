import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import './ModelViewer.css'

type Props = { data: ModelData }

export default function ModelViewer({ data }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    // --- Renderer ---
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x1a1a2e)
    const { clientWidth: w, clientHeight: h } = mount
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // --- Scene & Camera ---
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100000)

    // --- Build geometry ---
    const { vertexCount, faceCount, vertexX, vertexY, vertexZ,
            triangleX, triangleY, triangleZ, faceColor } = data

    // Unindexed buffer: each face is 3 unique vertices for flat face colors
    const positions = new Float32Array(faceCount * 9)
    const colors    = new Float32Array(faceCount * 9)

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (let f = 0; f < faceCount; f++) {
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue

      // OSRS Y is "down" — negate for Three.js Y-up
      const ax = vertexX[ia], ay = -vertexY[ia], az = vertexZ[ia]
      const bx = vertexX[ib], by = -vertexY[ib], bz = vertexZ[ib]
      const cx = vertexX[ic], cy = -vertexY[ic], cz = vertexZ[ic]

      const base = f * 9
      positions[base]     = ax; positions[base + 1] = ay; positions[base + 2] = az
      positions[base + 3] = bx; positions[base + 4] = by; positions[base + 5] = bz
      positions[base + 6] = cx; positions[base + 7] = cy; positions[base + 8] = cz

      for (const x of [ax, bx, cx]) { if (x < minX) minX = x; if (x > maxX) maxX = x }
      for (const y of [ay, by, cy]) { if (y < minY) minY = y; if (y > maxY) maxY = y }
      for (const z of [az, bz, cz]) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }

      const rgb = hslToRgb(faceColor[f])
      const r = ((rgb >> 16) & 0xFF) / 255
      const g = ((rgb >> 8)  & 0xFF) / 255
      const b =  (rgb        & 0xFF) / 255
      colors[base]     = r; colors[base + 1] = g; colors[base + 2] = b
      colors[base + 3] = r; colors[base + 4] = g; colors[base + 5] = b
      colors[base + 6] = r; colors[base + 7] = g; colors[base + 8] = b
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3))
    geo.computeVertexNormals()

    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    })

    const mesh = new THREE.Mesh(geo, mat)
    scene.add(mesh)

    // Ambient + directional light
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(1, 2, 1)
    scene.add(dir)

    // Centre model and position camera
    const cx2 = (minX + maxX) / 2
    const cy2 = (minY + maxY) / 2
    const cz2 = (minZ + maxZ) / 2
    mesh.position.set(-cx2, -cy2, -cz2)

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)
    camera.position.set(0, 0, span * 1.5)
    camera.near = span * 0.001
    camera.far  = span * 100
    camera.updateProjectionMatrix()

    // --- Orbit controls ---
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1

    // --- Render loop ---
    let animId: number
    function animate() {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    // --- Resize observer ---
    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      geo.dispose()
      mat.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [data])

  return (
    <div className="model-viewer">
      <div className="model-header">
        <span className="model-id">Model {data.id}</span>
        <span className="model-stats">{data.vertexCount} verts · {data.faceCount} faces</span>
        <span className="model-hint">Drag to rotate · Scroll to zoom · Right-drag to pan</span>
      </div>
      <div ref={mountRef} className="model-canvas" />
    </div>
  )
}
