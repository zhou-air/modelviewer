/** Edge composite consumes the shared normal/linear-depth prepass. */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
const EDGE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;      // 场景颜色（线性空间，HalfFloat）
  uniform sampler2D tNormalDepth;  // 上一步的法线 + 深度
  uniform vec2 uTexel;
  uniform vec3 uEdgeColor;         // 线性空间
  uniform float uNormalThreshold;  // 法线夹角响应阈值（1-dot）
  uniform float uDepthThreshold;   // 相对深度差阈值
  uniform float uStrength;

  varying vec2 vUv;

  /** 单个邻域的响应，两项各自累积取最大 */
  void sampleNeighbor( vec2 offset, vec3 nC, float dC, inout float maxN, inout float maxD ) {
    vec4 s = texture2D( tNormalDepth, vUv + offset );
    s.a = abs(s.a);
    if ( s.a <= 0.0 ) {            // 邻域是背景：当前像素必在物体轮廓上
      maxN = 2.0;
      return;
    }
    vec3 n = normalize( s.xyz * 2.0 - 1.0 );
    maxN = max( maxN, 1.0 - dot( nC, n ) );
    maxD = max( maxD, abs( dC - s.a ) / max( dC, 1e-5 ) );
  }

  void main() {
    vec4 base = texture2D( tDiffuse, vUv );
    vec4 sC = texture2D( tNormalDepth, vUv );

    sC.a = abs(sC.a);
    if ( sC.a <= 0.0 ) {           // 背景不描边
      gl_FragColor = base;
      return;
    }

    vec3 nC = normalize( sC.xyz * 2.0 - 1.0 );
    float dC = sC.a;
    float maxN = 0.0, maxD = 0.0;

    sampleNeighbor( vec2( uTexel.x, 0.0 ), nC, dC, maxN, maxD );
    sampleNeighbor( vec2( -uTexel.x, 0.0 ), nC, dC, maxN, maxD );
    sampleNeighbor( vec2( 0.0, uTexel.y ), nC, dC, maxN, maxD );
    sampleNeighbor( vec2( 0.0, -uTexel.y ), nC, dC, maxN, maxD );

    float eN = smoothstep( uNormalThreshold, uNormalThreshold * 2.0, maxN );
    float eD = smoothstep( uDepthThreshold, uDepthThreshold * 3.0, maxD );
    float edge = max( eN, eD ) * uStrength;

    gl_FragColor = vec4( mix( base.rgb, uEdgeColor, edge ), base.a );
  }
`;

export class EdgeLinesPass extends Pass {
  constructor(normalDepth) {
    super(); this.normalDepth = normalDepth; this.normalRT = normalDepth.normalRT;
    this.material = new THREE.ShaderMaterial({
      name: 'EdgeLinesComposite',
      uniforms: {
        tDiffuse: { value: null },
        tNormalDepth: { value: this.normalRT.texture },
        uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uEdgeColor: { value: new THREE.Color(0x2c3742) },   // 深灰蓝：浅背景上足够清楚，又不抢选中橙
        uNormalThreshold: { value: 0.42 },
        uDepthThreshold: { value: 0.0045 },
        uStrength: { value: 0.85 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: EDGE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.material);

  }
  get uniforms() { return this.material.uniforms; }
  get lastSceneDrawCalls() { return this.normalDepth.lastSceneDrawCalls; }
  setSize(w, h) { this.uniforms.uTexel.value.set(1 / Math.max(w, 1), 1 / Math.max(h, 1)); }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}
