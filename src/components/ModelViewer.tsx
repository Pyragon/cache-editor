import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ModelData } from '../loaders/models'
import { hslToRgb } from '../loaders/models'
import './ModelViewer.css'

type Props = { data: ModelData }

export default function ModelViewer({ data }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const matRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const [wireframe, setWireframe] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const w = mount.clientWidth || 800
    const h = mount.clientHeight || 600

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000)
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100000)

    // --- Build geometry ---
    const { vertexCount, faceCount, vertexX, vertexY, vertexZ,
            triangleX, triangleY, triangleZ, faceColor } = data

    const positions = new Float32Array(faceCount * 9)
    const colors    = new Float32Array(faceCount * 9)

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (let f = 0; f < faceCount; f++) {
      const ia = triangleX[f], ib = triangleY[f], ic = triangleZ[f]
      if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount)
        continue

      // OSRS: Y is down, and models face away from the default camera — negate
      // Y to flip upright and X/Z to spin 180° so the model faces the viewer.
      const ax = -vertexX[ia], ay = -vertexY[ia], az = -vertexZ[ia]
      const bx = -vertexX[ib], by = -vertexY[ib], bz = -vertexZ[ib]
      const cx = -vertexX[ic], cy = -vertexY[ic], cz = -vertexZ[ic]

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

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    mat.wireframe = matRef.current?.wireframe ?? false
    matRef.current = mat
    const mesh = new THREE.Mesh(geo, mat)
    scene.add(mesh)

    const cx2 = (minX + maxX) / 2
    const cy2 = (minY + maxY) / 2
    const cz2 = (minZ + maxZ) / 2
    mesh.position.set(-cx2, -cy2, -cz2)

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)
    camera.position.set(0, 0, span * 2.5)
    camera.near = span * 0.001
    camera.far  = span * 100
    camera.updateProjectionMatrix()

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1

    let animId: number
    function animate() {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

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

  useEffect(() => {
    if (matRef.current) matRef.current.wireframe = wireframe
  }, [wireframe])

  return (
    <div className="model-viewer">
      <div className="model-header">
        <span className="model-id">Model {data.id}</span>
        <span className="model-stats">{data.vertexCount} verts · {data.faceCount} faces</span>
        <span className="model-hint">Drag to rotate · Scroll to zoom · Right-drag to pan</span>
      </div>
      <div ref={mountRef} className="model-canvas" />
      <div className="model-toolbar">
        <button
          className={`model-toolbar-btn${wireframe ? ' active' : ''}`}
          onClick={() => setWireframe(v => !v)}
        >
          Wireframe
        </button>
      </div>
    </div>
  )
}
