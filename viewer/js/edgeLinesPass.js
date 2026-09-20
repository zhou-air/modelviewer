/** 元件轮廓线：屏幕空间边缘检测（视图法线 + 线性深度双通道）。
 *
 * 为什么不用 EdgesGeometry / 线框：
 *   本模型 5,796 个 mesh、33.6 万三角形。逐 mesh 生成边线几何（EdgesGeometry）需要先合并
 *   重复顶点（RVM 导出的三角形多数不共享顶点，不合并就退化成"全三角网格线框"），
 *   代价是数量级更大的顶点缓冲 + 同样多的额外 draw call。而"轮廓线"在工程审图里要的是
 *   **外观轮廓**，不是三角网格线框。屏幕空间方案把开销固定成
 *   「1 次离屏场景渲染 + 1 次全屏 pass」，与模型复杂度无关（离屏那次与主渲染同量级）。
 *
 * 为什么要两路通道：
 *   · 只看法线 —— 同朝向的一排元件前后遮挡时法线相同，分不出边界。
 *   · 只看深度 —— 两个贴合/相邻元件的像素深度可能连续，分不出边界。
 *   两路各自取最大响应再取或，覆盖面最广。这仍是屏幕空间方案固有的近似：
 *   深度与法线**同时**连续的贴合面不会被判成边缘（需要物体 ID 缓冲才能彻底解决，
 *   而 ID 缓冲要求逐对象换材质，本模型 5,796 个 mesh 不划算）。
 *
 * 实现要点：
 *   · RGB = 视图空间法线编码（n*0.5+0.5，直接存世界线性值，不做 gamma 处理）
 *     A   = 线性深度 / camera.far（归一化到 [0,1]，HalfFloat 目标够用）
 *   · 法线/深度用一次 `scene.overrideMaterial` 离屏渲染取得，不重建场景、不改主材质。
 *   · ⚠️ overrideMaterial 对 Line/LineSegments 同样生效，而线几何没有 normal 属性。
 *       所以本 pass 在离屏渲染前会**临时隐藏宿主登记的线对象**，渲染完立即恢复
 *       （见 viewer3d 的 lineObjects / _normalPassHide*）。不要去掉这一步：
 *       线写进深度缓冲会在轴网/中心线处产生成片假边缘。shader 里也保留了
 *       |normal|≈0 的兜底分支，万一有线漏网会被推出裁剪空间而不参与边缘检测。
 *   · 背景像素写入 alpha=0，边缘检测把它当作"另一侧没有几何" → 物体外轮廓会被描边，
 *     而纯背景区域内部不产生边缘。
 *   · 本 pass 的 enabled 由宿主按开关控制；关闭时 EffectComposer 直接跳过，零开销。
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';

/** 离屏渲染法线 + 深度。uniform 的 uDepthScale = 1 / camera.far。 */
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

  void main() {
    gl_FragColor = vec4( vViewNormal * 0.5 + 0.5, vDepth );
  }
`;

/** 边缘检测：4 邻域比较法线夹角与相对深度差，取响应较大者。 */
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
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {object} [opts]
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {number} [opts.pixelRatio]
   * @param {THREE.Object3D[]} [opts.lineObjects] 离屏渲染时需要临时隐藏的线对象（宿主登记）
   */
  constructor(scene, camera, { width = 1, height = 1, pixelRatio = 1, lineObjects = [] } = {}) {
    super();

    this.scene = scene;
    this.camera = camera;
    this.pixelRatio = pixelRatio;
    this.lineObjects = lineObjects;

    // 离屏法线/深度目标。NearestFilter：边缘检测要做逐像素差分，插值会糊掉跳变。
    this.normalRT = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio)),
      {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
    this.normalRT.texture.name = 'EdgeLinesPass.normalDepth';

    this.normalMaterial = new THREE.ShaderMaterial({
      name: 'EdgeLinesNormalDepth',
      uniforms: { uDepthScale: { value: 1 } },
      vertexShader: NORMAL_VERT,
      fragmentShader: NORMAL_FRAG,
    });

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

    this._clearColor = new THREE.Color();
    this._size = new THREE.Vector2();   // 复用，避免每帧新建
    this._clearAlpha = 0;
    this._hiddenLines = [];        // 预分配，避免每帧 new 数组
    this._hiddenCount = 0;
    this.lastSceneDrawCalls = 0;   // 离屏那趟的场景绘制量（实测用）
  }

  get uniforms() { return this.material.uniforms; }

  /** 宿主每帧调用：登记本帧要排除的线对象集合（默认就是构造时那一份） */
  setLineObjects(list) {
    this.lineObjects = list || [];
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width * this.pixelRatio));
    const h = Math.max(1, Math.floor(height * this.pixelRatio));
    this.normalRT.setSize(w, h);
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const outW = renderer.getDrawingBufferSize(this._size).x || 1;
    const outH = renderer.getDrawingBufferSize(this._size).y || 1;
    this.uniforms.uTexel.value.set(1 / outW, 1 / outH);
    this.normalMaterial.uniforms.uDepthScale.value = 1 / Math.max(this.camera.far, 1e-3);

    // ---- 第一趟：法线 + 深度（离屏）
    // 线几何没有 normal 属性，写进法线图会在几何线位置产生假边缘，先摘掉它们。
    this._hiddenCount = 0;
    for (const l of this.lineObjects) {
      if (l.visible) {
        l.visible = false;
        this._hiddenLines[this._hiddenCount++] = l;
      }
    }
    const prevOverride = this.scene.overrideMaterial;
    const prevBackground = this.scene.background;
    renderer.getClearColor(this._clearColor);
    this._clearAlpha = renderer.getClearAlpha();

    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;               // 背景必须清成 alpha=0，别让它渲染天空色
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.normalRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // ---- 恢复现场（一定要恢复，否则主渲染与 OutlinePass 都会被带偏）
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;
    renderer.setClearColor(this._clearColor, this._clearAlpha);
    for (let i = 0; i < this._hiddenCount; i++) this._hiddenLines[i].visible = true;

    this.lastSceneDrawCalls = renderer.info.render.calls;

    // ---- 第二趟：边缘检测 + 合成到场景颜色
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tNormalDepth.value = this.normalRT.texture;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.normalRT.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
