import { useEffect, useState } from 'react'
import type { TextureData } from '../loaders/textures'
import { hslToRgb } from '../loaders/models'
import './TextureViewer.css'

type Props = { data: TextureData }

const ZOOM_LEVELS = [1, 2, 4, 8]

export default function TextureViewer({ data }: Props) {
  const [zoom, setZoom] = useState(2)
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    setZoom(2)
    setDims(null)
    const objectUrl = URL.createObjectURL(data.png)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [data])

  function handleDownload() {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `texture_${data.id}.png`
    a.click()
  }

  const def = data.definition
  const colourRgb = def ? hslToRgb(def.colorHsl) : 0
  const colourHex = `#${colourRgb.toString(16).padStart(6, '0')}`

  return (
    <div className="texture-viewer">
      <div className="texture-header">
        <div className="texture-title">
          <span className="texture-id">Texture {data.id}</span>
          {dims && <span className="texture-dims">{dims.w} × {dims.h}</span>}
        </div>
        <div className="texture-zoom-row">
          <span className="texture-zoom-label">Zoom</span>
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z}
              type="button"
              className={`zoom-btn${zoom === z ? ' active' : ''}`}
              onClick={() => setZoom(z)}
            >
              {z}×
            </button>
          ))}
          <button type="button" className="replace-btn" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>

      <div className="texture-canvas-wrap">
        {url && (
          <img
            src={url}
            alt={`Texture ${data.id}`}
            className="texture-image"
            style={dims ? { width: dims.w * zoom, height: dims.h * zoom } : undefined}
            onLoad={(e) => {
              const img = e.currentTarget
              setDims({ w: img.naturalWidth, h: img.naturalHeight })
            }}
          />
        )}
      </div>

      {def && (
        <div className="texture-def">
          <h3 className="texture-def-title">Definition</h3>
          <div className="texture-def-grid">
            <div className="texture-def-card">
              <span className="texture-def-label">Colour</span>
              <span className="texture-def-value">
                <span className="texture-swatch" style={{ background: colourHex }} />
                {def.colorHsl}
              </span>
            </div>
            {([
              ['Brightness',      def.brightness],
              ['Alpha',           def.alpha],
              ['Effect ID',       def.effectId],
              ['Effect param 1',  def.effectParam1],
              ['Effect param 2',  def.effectParam2],
              ['Speed U',         def.textureSpeedU],
              ['Speed V',         def.textureSpeedV],
              ['Mipmapping',      def.mipmapping],
              ['Combine mode',    def.combineMode],
              ['Effect combiner', def.effectCombiner],
            ] as [string, number][]).map(([label, value]) => (
              <div key={label} className="texture-def-card">
                <span className="texture-def-label">{label}</span>
                <span className="texture-def-value">{value}</span>
              </div>
            ))}
            {([
              ['Details only',   def.detailsOnly],
              ['Half size',      def.isHalfSize],
              ['Skip triangles', def.skipTriangles],
              ['Brick tile',     def.isBrickTile],
              ['Repeat S',       def.repeatS],
              ['Repeat T',       def.repeatT],
              ['HDR',            def.hdr],
              ['aBool2087 (?)',  def.aBool2087],
            ] as [string, boolean][]).map(([label, value]) => (
              <div key={label} className="texture-def-card">
                <span className="texture-def-label">{label}</span>
                <span className={`texture-def-flag${value ? ' on' : ''}`}>
                  {value ? 'Yes' : 'No'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
