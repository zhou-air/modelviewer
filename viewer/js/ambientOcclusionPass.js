import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const geometryFunctions = `
uniform sampler2D tNormalDepth;
uniform mat4 inverseProjection;
uniform sampler2D tDepth;
vec3 positionAt(vec2 uv) {
  float depth = texture2D(tDepth, uv).r;
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
`;

/** Bounded contact AO: shared normal/mask texture + its sampleable hardware depth.
 * Full-resolution sampling without blur; no additional scene render.
 * Signed depth protects highlight/ghost surfaces without an object-ID texture or meshes.
 */
export class AmbientOcclusionPass extends Pass {
  constructor(normalDepth, camera) {
    super(); this.camera = camera; this.intensity = 0.3; this.radius = 0.12; this.needsSwap = false;
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.aoRT.texture.name = 'AmbientOcclusion.contactFullResolution';
    const shared = { tNormalDepth: { value: normalDepth.normalRT.texture },
      inverseProjection: { value: camera.projectionMatrixInverse }, tDepth: { value: normalDepth.normalRT.depthTexture } };
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, vertexShader,
      uniforms: { ...shared, radius: { value: this.radius },
        projectionY: { value: 1 }, resolution: { value: new THREE.Vector2() } },
      fragmentShader: `varying vec2 vUv; ${geometryFunctions}
uniform float radius, projectionY;
uniform vec2 resolution;
void main() {
  vec4 center = texture2D(tNormalDepth, vUv);
  if (center.a <= 0.0) { gl_FragColor = vec4(1.0); return; }
  vec3 p = positionAt(vUv);
  vec3 n = normalize(center.rgb * 2.0 - 1.0);
  float pixelRadius = min(radius * projectionY * resolution.y / (2.0 * max(-p.z, 0.001)), 20.0);
  if (pixelRadius < 1.0) { gl_FragColor = vec4(1.0); return; }
  float occlusion = 0.0;
  // Fixed spiral: stable during movement, no frame noise or temporal history.
  for (int i = 0; i < 16; i++) {
    float t = (float(i) + 0.5) / 16.0;
    float angle = float(i) * 2.39996323;
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * t * pixelRadius / resolution;
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) continue;
    // Depth uses nearest filtering. Reconstruct at that texel's actual center;
    // a fractional ray with a neighbour's depth creates false AO on slanted planes.
    uv = (floor(uv * resolution) + 0.5) / resolution;
    vec4 s = texture2D(tNormalDepth, uv);
    if (s.a <= 0.0) continue;
    vec3 delta = positionAt(uv) - p;
    float distanceToSample = length(delta);
    float bias = max(radius * 0.025, 0.001);
    float facing = max(0.0, (dot(n, delta) - bias) / max(distanceToSample, 0.0001) - 0.08);
    float falloff = max(0.0, 1.0 - distanceToSample / radius);
    occlusion += facing * falloff * falloff;
  }
  float amount = clamp(occlusion / 16.0 * 3.0, 0.0, 0.5);
  amount *= smoothstep(0.01, 0.03, amount);
  gl_FragColor = vec4(vec3(1.0 - amount), 1.0);
}`,
    });
    this.composite = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, vertexShader,
      // Multiply in place: preserve the original scene depth for engineering overlays.
      transparent: true, blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { ...shared, tAO: { value: this.aoRT.texture }, intensity: { value: this.intensity } },
      fragmentShader: `varying vec2 vUv;
uniform sampler2D tAO, tNormalDepth;
uniform float intensity;
void main() {
  float valid = texture2D(tNormalDepth, vUv).a;
  float ao = texture2D(tAO, vUv).r;
  float shade = valid > 0.0 ? 1.0 - min(0.18, (1.0 - ao) * intensity) : 1.0;
  gl_FragColor = vec4(vec3(shade), 1.0);
}`,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  setSize(w, h) {
    this.aoRT.setSize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
    this.material.uniforms.resolution.value.set(w, h);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.radius.value = this.radius;
    this.material.uniforms.projectionY.value = this.camera.projectionMatrix.elements[5];
    this.quad.material = this.material; renderer.setRenderTarget(this.aoRT); this.quad.render(renderer);
    this.composite.uniforms.intensity.value = this.intensity;
    this.quad.material = this.composite;
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(readBuffer); this.quad.render(renderer);
    } finally { renderer.autoClear = autoClear; }
  }
  dispose() { this.aoRT.dispose(); this.material.dispose(); this.composite.dispose(); this.quad.dispose(); }
}
