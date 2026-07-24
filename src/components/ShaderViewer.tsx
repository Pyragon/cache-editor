import type { ShaderData } from '../loaders/shaders'
import './ShaderViewer.css'

// Read-only viewer for the dumped shaders (JS5 index 31). GLSL source is the
// ground-truth OpenGL shader logic we mirror in three.js; DirectX entries are
// compiled bytecode (we surface the embedded uniform/assembly strings); manifest
// entries describe a named package's programs.
export default function ShaderViewer({ data }: { data: ShaderData }) {
  if (data.kind === 'error') {
    return <div className="shader-viewer"><div className="shader-empty">{data.message}</div></div>
  }

  if (data.kind === 'glsl') {
    return (
      <div className="shader-viewer">
        <div className="shader-bar">
          <span className="shader-badge shader-badge-glsl">GLSL</span>
          <span className="shader-badge">{data.lang}</span>
          <span className="shader-path">{data.path}</span>
        </div>
        <pre className="shader-source">{data.source}</pre>
      </div>
    )
  }

  if (data.kind === 'dxbc') {
    return (
      <div className="shader-viewer">
        <div className="shader-bar">
          <span className="shader-badge shader-badge-dxbc">DirectX bytecode</span>
          <span className="shader-path">{data.path}</span>
        </div>
        <div className="shader-note">
          Compiled DirectX shader (vs_2_0 / ps_2_0). Not source — the readable
          strings (uniforms, profile, compiler banner) are below.
        </div>
        <pre className="shader-source">{data.strings.join('\n')}</pre>
      </div>
    )
  }

  return (
    <div className="shader-viewer">
      <div className="shader-bar">
        <span className="shader-badge shader-badge-manifest">Manifest</span>
        <span className="shader-path">{data.name}</span>
      </div>
      <pre className="shader-source">{JSON.stringify(data.json, null, 2)}</pre>
    </div>
  )
}
