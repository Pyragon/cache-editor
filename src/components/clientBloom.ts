import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

/**
 * The client's bloom filter, ported from the dumped GLSL rather than
 * approximated with three's UnrealBloomPass (whose mip-chain blur, soft-knee
 * threshold and missing tone-map composite all read differently).
 *
 * Three stages, matching `FilterBloom` (shaders index 31):
 *   1. bright pass  — glsl/1_37.frag
 *   2. gaussian blur — glsl/1_15.frag, separable, run H then V
 *   3. composite    — glsl/1_35.frag
 *
 * Parameters come from the region's `Atmosphere` (map-environment opcode 2,
 * each stored as `byte * 8 / 255`), plumbed through
 * `Class239 -> AbstractRenderer.method8472 -> HardwareRenderer.method8592`:
 *   params.x = threshold, params.y = strength, params.z = whitePoint
 * Class defaults (used when a region doesn't override) are 1.0 / 0.25 / 1.0.
 */

const LUMA = 'const vec3 LUMA = vec3(0.212599993, 0.715200007, 0.0722000003);'

/** glsl/1_37.frag — keep only pixels at or above the luminance threshold. */
const BrightShader = {
  uniforms: { sceneTex: { value: null as THREE.Texture | null }, threshold: { value: 1 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D sceneTex;
    uniform float threshold;
    varying vec2 vUv;
    ${LUMA}
    void main() {
      vec4 c = texture2D(sceneTex, vUv);
      gl_FragColor = c * float(dot(LUMA, c.rgb) >= threshold);
    }`,
}

/**
 * glsl/1_15.frag — 17 taps at the shader's exact weights. The client runs this
 * as one pass per axis with `sampleSize` set to the step along that axis.
 */
const BlurShader = {
  uniforms: {
    sceneTex: { value: null as THREE.Texture | null },
    sampleSize: { value: new THREE.Vector2() },
  },
  vertexShader: BrightShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D sceneTex;
    uniform vec2 sampleSize;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(sceneTex, vUv) * 9.13962647E-02;
      c += (texture2D(sceneTex, vUv - sampleSize)       + texture2D(sceneTex, vUv + sampleSize))       * 8.85843039E-02;
      c += (texture2D(sceneTex, vUv - 2.0 * sampleSize) + texture2D(sceneTex, vUv + 2.0 * sampleSize)) * 8.06569234E-02;
      c += (texture2D(sceneTex, vUv - 3.0 * sampleSize) + texture2D(sceneTex, vUv + 3.0 * sampleSize)) * 6.89895153E-02;
      c += (texture2D(sceneTex, vUv - 4.0 * sampleSize) + texture2D(sceneTex, vUv + 4.0 * sampleSize)) * 5.54346368E-02;
      c += (texture2D(sceneTex, vUv - 5.0 * sampleSize) + texture2D(sceneTex, vUv + 5.0 * sampleSize)) * 4.18442599E-02;
      c += (texture2D(sceneTex, vUv - 6.0 * sampleSize) + texture2D(sceneTex, vUv + 6.0 * sampleSize)) * 2.96720229E-02;
      c += (texture2D(sceneTex, vUv - 7.0 * sampleSize) + texture2D(sceneTex, vUv + 7.0 * sampleSize)) * 1.97658278E-02;
      c += (texture2D(sceneTex, vUv - 8.0 * sampleSize) + texture2D(sceneTex, vUv + 8.0 * sampleSize)) * 1.23691391E-02;
      gl_FragColor = vec4(c.rgb, 1.0);
    }`,
}

/**
 * glsl/1_35.frag — extended Reinhard on the scene luminance, plus additive
 * bloom. Note that at the default whitePoint of 1.0 the tone-map term collapses
 * to identity, so the client effectively only adds `bloom * strength`.
 */
const CompositeShader = {
  uniforms: {
    sceneTex: { value: null as THREE.Texture | null },
    bloomTex1: { value: null as THREE.Texture | null },
    strength: { value: 0.25 },
    whitePoint: { value: 1 },
  },
  vertexShader: BrightShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D sceneTex;
    uniform sampler2D bloomTex1;
    uniform float strength;
    uniform float whitePoint;
    varying vec2 vUv;
    ${LUMA}
    void main() {
      vec4 sceneCol = vec4(texture2D(sceneTex, vUv).rgb, 1.0);
      vec4 bloomCol = texture2D(bloomTex1, vUv);
      float preLum = 0.99 * dot(LUMA, sceneCol.rgb) + 0.00999999978;
      float postLum = (preLum * (1.0 + preLum / whitePoint)) / (preLum + 1.0);
      gl_FragColor = sceneCol * (postLum / preLum) + bloomCol * strength;
    }`,
}

export class ClientBloomPass extends Pass {
  /** luminance at or above which a pixel blooms (Atmosphere -> params.x) */
  threshold = 1
  /** additive bloom scale (Atmosphere -> params.y) */
  strength = 0.25
  /** Reinhard white point; 1.0 = no tone mapping (Atmosphere -> params.z) */
  whitePoint = 1

  private targetA: THREE.WebGLRenderTarget
  private targetB: THREE.WebGLRenderTarget
  private bright = new THREE.ShaderMaterial(BrightShader)
  private blur = new THREE.ShaderMaterial(BlurShader)
  private composite = new THREE.ShaderMaterial(CompositeShader)
  private quad = new FullScreenQuad()

  constructor(width: number, height: number) {
    super()
    // the bloom chain runs at half res, as the client's separate bloom buffer
    // does; half-float so overbright HDR values survive the blur
    const opts = { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace }
    this.targetA = new THREE.WebGLRenderTarget(width >> 1, height >> 1, opts)
    this.targetB = new THREE.WebGLRenderTarget(width >> 1, height >> 1, opts)
  }

  setSize(width: number, height: number) {
    this.targetA.setSize(width >> 1, height >> 1)
    this.targetB.setSize(width >> 1, height >> 1)
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const draw = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = material
      renderer.setRenderTarget(target)
      this.quad.render(renderer)
    }

    // 1. bright pass -> A
    this.bright.uniforms.sceneTex.value = readBuffer.texture
    this.bright.uniforms.threshold.value = this.threshold
    draw(this.bright, this.targetA)

    // 2. separable blur: A -> B (horizontal), B -> A (vertical)
    const w = this.targetA.width, h = this.targetA.height
    this.blur.uniforms.sceneTex.value = this.targetA.texture
    this.blur.uniforms.sampleSize.value.set(1 / w, 0)
    draw(this.blur, this.targetB)
    this.blur.uniforms.sceneTex.value = this.targetB.texture
    this.blur.uniforms.sampleSize.value.set(0, 1 / h)
    draw(this.blur, this.targetA)

    // 3. composite scene + bloom
    this.composite.uniforms.sceneTex.value = readBuffer.texture
    this.composite.uniforms.bloomTex1.value = this.targetA.texture
    this.composite.uniforms.strength.value = this.strength
    this.composite.uniforms.whitePoint.value = this.whitePoint
    draw(this.composite, this.renderToScreen ? null : writeBuffer)
  }

  dispose() {
    this.targetA.dispose()
    this.targetB.dispose()
    this.bright.dispose()
    this.blur.dispose()
    this.composite.dispose()
    this.quad.dispose()
  }
}
