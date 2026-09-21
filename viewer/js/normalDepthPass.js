import * as THREE from 'three';
import { Pass } from '../vendor/jsm/postprocessing/Pass.js';

// RGB: view normal; abs(A): linear depth / far; negative A: protected interaction/helper.
const NORMAL_VERT = /* glsl */`
  varying vec3 vViewNormal;
  varying float vDepth;
  uniform float uDepthScale;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    vec3 n = normalMatrix * normal;

    // 兜底：线几何没有 normal 属性 → |n| ≈ 0 → 推到裁剪空间外（NDC z > 1 被裁掉）
    float hasNormal = step( 0.5, length( n ) );
    vViewNormal = hasNormal > 0.5 ? normalize( n ) : vec3( 0.0, 0.0, 1.0 );
    vDepth = -mvPosition.z * uDepthScale;

    gl_Position = hasNormal > 0.5
      ? projectionMatrix * mvPosition
      : vec4( 0.0, 0.0, 2.0, 1.0 );
  }
`;

const NORMAL_FRAG = /* glsl */`
  varying vec3 vViewNormal;
  varying float vDepth;

  uniform float uProtected;
  void main() {
    gl_FragColor = vec4( normalize(vViewNormal) * 0.5 + 0.5, vDepth * uProtected );
  }
`;


export class NormalDepthPass extends Pass {
  constructor(scene, camera, model) {
    super(); this.scene = scene; this.camera = camera; this.model = model;
    this.needsSwap = false;
    this.normalRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: true, stencilBuffer: false,
    });
    this.normalRT.texture.name = 'SharedNormalLinearDepth';
    // Sample the existing hardware depth attachment for small contacts. Half-float
    // linear depth alone loses millimetre detail at engineering viewing distances.
    this.normalRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.normalMaterial = new THREE.ShaderMaterial({
      uniforms: { uDepthScale: { value: 1 }, uProtected: { value: 1 } },
      vertexShader: NORMAL_VERT, fragmentShader: NORMAL_FRAG,
    });
    this.normalMaterial.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const m = object.material;
      this.normalMaterial.uniforms.uProtected.value =
        m === model.selMeshMat || m === model.hoverMeshMat || m?.transparent || object.userData.nonSelectable ? -1 : 1;
      this.normalMaterial.uniformsNeedUpdate = true;
    };
    this._clearColor = new THREE.Color(); this._hidden = [];
    this.lastSceneDrawCalls = 0; this.renderCount = 0;
  }
  setSize(w, h) { this.normalRT.setSize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))); }
  render(renderer) {
    const scene = this.scene, previous = scene.overrideMaterial, background = scene.background;
    const target = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clearColor);
    let count = 0;
    const hide = o => { if (o?.visible) { this._hidden[count++] = o; o.visible = false; } };
    // Registered objects only; never scan the model tree per frame.
    for (const o of this.model.lineObjects) hide(o);
    hide(this.model.floorPlanGroup); hide(this.model.measurement?.group);
    this.normalMaterial.uniforms.uDepthScale.value = 1 / Math.max(this.camera.far, 1e-3);
    const calls = renderer.info.render.calls;
    try {
      scene.overrideMaterial = this.normalMaterial; scene.background = null;
      renderer.setClearColor(0, 0); renderer.setRenderTarget(this.normalRT); renderer.clear();
      renderer.render(scene, this.camera);
      this.lastSceneDrawCalls = renderer.info.render.calls - calls; this.renderCount++;
    } finally {
      scene.overrideMaterial = previous; scene.background = background;
      renderer.setClearColor(this._clearColor, alpha); renderer.setRenderTarget(target);
      for (let i = 0; i < count; i++) this._hidden[i].visible = true;
      this._hidden.length = 0;
    }
  }
  dispose() { this.normalRT.dispose(); this.normalMaterial.dispose(); }
}
