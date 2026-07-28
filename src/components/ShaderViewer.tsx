import type { ShaderData } from '../loaders/shaders'
import './ShaderViewer.css'

// Read-only viewer for the dumped shaders (JS5 index 31). GLSL source is the
// ground-truth OpenGL shader logic we mirror in three.js; DirectX entries are
// compiled bytecode (we surface the embedded uniform/assembly strings); manifest
// entries describe a named package's programs.
//
// Read-only DELIBERATELY — the reasons are in ReadOnlyNote below, and they are
// about value rather than difficulty: GLSL is the easiest repack in the cache
// (the file's bytes ARE the text), but an edit would only reach players on the
// OpenGL toolkit, and the same look is reachable for both renderers through
// data the client feeds either path.

/** Why this entry doesn't edit, shown on every shader so it's never a mystery. */
function ReadOnlyNote() {
  return (
    <div className="shader-note shader-note-readonly">
      <strong>Read-only, on purpose.</strong> The client ships each program twice — GLSL for the
      OpenGL toolkit, compiled DXBC for DirectX — and DXBC can't be rebuilt without the original
      HLSL and Microsoft's <code>fxc</code>. Editing the GLSL would change what OpenGL players see
      and leave DirectX players on the old rendering. The GLSL is also machine-translated from
      HLSL (<code>r0026</code>, <code>TMP35</code>, <code>struct VS_IN</code>), so it reads like
      decompiled code with no source to regenerate from. To change how the game looks, edit the
      data both renderers consume — texture definitions, the region environment's fog/sun/bloom,
      light intensities, skyboxes, particles — or the client's own renderer. These files earn
      their keep as the reference our 3D views are ported from.
    </div>
  )
}

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
        <ReadOnlyNote />
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
        <ReadOnlyNote />
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
      <ReadOnlyNote />
      <pre className="shader-source">{JSON.stringify(data.json, null, 2)}</pre>
    </div>
  )
}
