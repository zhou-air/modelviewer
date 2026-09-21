/** 3D 层：场景 / 加载 / 拾取 / 选中高亮 / 显隐 / 视图适配 / 外观选项。
 *
 * 设计要点
 *  · 材质策略：RVM 本身不带颜色（material 全为 1 → Black），所以按既定决定统一覆盖为灰色。
 *    全部 mesh 复用同一个材质实例，shader program 只有 2 个（网格 1 + 线 1）。
 *  · 选中高亮：EffectComposer + OutlinePass 描边（不是三角网格线框）。多选共用同一套材质/描边，
 *    只是对象列表变长。
 *  · 预选中（Phase 10）：游戏导航准星指到的实体先用浅色材质高亮并闪烁，左键点下才变正式选中。
 *  · 拾取：射线命中后**向上找到最近的有名节点**——GLB 里有 508 个无名 holder 节点承载几何。
 *    ⚠️ three.js r160 的 Raycaster **不会跳过 visible=false 的节点**（见 vendor 的 intersectObject），
 *       所以隐藏/隔离掉的对象仍会被射线命中；命中判定必须自己沿父链查可见性。
 *  · 名字即主键：GLB 节点名 == canonical（Phase 4 已验证 7,420/7,423）。
 *    ⚠️ 但 three.js 的 GLTFLoader 会**清洗节点名**（`PropertyBinding.sanitizeNodeName`：
 *       去掉 `[ ] . : /`、空白转下划线）。例如 `/MDBs` → `MDBs`，
 *       `TEE 1 of BRANCH /WG-10401-400-L1G/B2` → `TEE_1_of_BRANCH_WG-10401-400-L1G-B2`。
 *       所以**不能用 `object.name` 做主键**，必须用 GLTFLoader 保留在
 *       `node.userData.name` 里的**原始名**。且它还会给无名 mesh 自动起 `mesh_N` 名字，
 *       因此只索引带 `userData.name` 的节点。
 *  · 外观可选项（默认全关，见 setContours / setXray）：
 *      – 元件轮廓线：屏幕空间边缘检测后处理，开销与模型复杂度无关的固定一轮（见 edgeLinesPass.js）。
 *      – 隐藏件半透明：被隐藏/隔离掉的元件不消失，改用半透明 ghost 材质显示，透明度可调。
 *    ⚠️ 这两个选项把「显隐」从"只调 node.visible"变成"visible + 材质"两件事，
 *       因此**所有**显隐与选中入口都必须走 `_applyVisibility()`；不要再就地改 node.visible
 *       或对象材质，否则关掉选项后会留下没还原的 ghost 材质。
 */
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/jsm/controls/OrbitControls.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from '../vendor/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { LightingController } from './lightingController.js';
import { NormalDepthPass } from './normalDepthPass.js';
import { AOOverlayPass } from './aoOverlayPass.js';
import { AmbientOcclusionPass } from './ambientOcclusionPass.js';
import { EdgeLinesPass } from './edgeLinesPass.js';
import { EngineeringNavigation } from './navigation/engineeringNavigation.js';
import { NavigationSettingsStore } from './navigation/navigationSettings.js';
import { PerformanceDiagnostics } from './performanceDiagnostics.js';
import { BatchRenderingManager } from './batchRendering.js';
import { FloorPlanGroup } from './floorPlan.js';
import { MeasurementController } from './measurement.js';
import { OrientationGizmo } from './orientationGizmo.js';
import { ENGINEERING_AXES } from './coordinateMapping.js';
import { keyBindings } from './keyBindings.js';
import { SceneAppearance } from './sceneAppearance.js';
import { normalizeColor, normalizeSettings } from './appearance.js';

const MODEL_COLOR = 0x8d949c;
const LINE_COLOR = 0x4d5866;
const BG_COLOR = 0xeef1f3;
const OUTLINE_COLOR = 0xc8791a;
const ORIENTATION_VECTORS = Object.freeze({
  E: ENGINEERING_AXES.E,
  W: ENGINEERING_AXES.E.clone().negate(),
  N: ENGINEERING_AXES.N,
  S: ENGINEERING_AXES.N.clone().negate(),
  U: ENGINEERING_AXES.U,
  D: ENGINEERING_AXES.U.clone().negate(),
});

// ---- 外观选项默认值（两项默认都是关）
const XRAY_OPACITY_DEFAULT = 0.32;      // 隐藏件半透明的默认不透明度
const XRAY_OPACITY_MIN = 0.05;
const XRAY_OPACITY_MAX = 0.95;
const GHOST_COLOR = 0x9aa6b2;           // ghost 网格色：略浅于正常灰，避免看起来"反而变实了"
const GHOST_LINE_COLOR = 0x8fa0ad;

function makeBatchModelMaterial(options) {
  const material = new THREE.MeshStandardMaterial(options);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 objectColor;\nattribute float objectColorMix;\nvarying vec3 vObjectColor;\nvarying float vObjectColorMix;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vObjectColor = objectColor;\n  vObjectColorMix = objectColorMix;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjectColor;\nvarying float vObjectColorMix;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vObjectColor, clamp(vObjectColorMix, 0.0, 1.0));');
  };
  material.customProgramCacheKey = () => 'pdms-batch-object-color-v1';
  return material;
}

// ---- 预选中（准星指向）配色：浅蓝，与选中的橙色（OUTLINE_COLOR）明确区分。
// 闪烁用"在暗态与亮态之间往返"实现：emissiveIntensity 与颜色同时被调制，浅背景上也看得见。
// ⚠️ 暗态刻意压到接近模型灰（0x8d949c），否则在"浅灰模型 + 浅灰背景"下亮暗两态几乎看不出差别，
//    起不到"闪"的提示作用（实测：暗态只压 emissive 时，屏幕像素只差 10 来个灰阶）。
const HOVER_BLINK_HZ = 0.3;                       // ≈ 0.3次/秒
// >1 = 峰值更尖：值越大，亮态停留越短（只"掠过"峰值）。
// 用 |v-峰值| 的停留占比看：smoothstep 时约 24% 的周期处在峰值 85% 以上，2.2 次幂后降到约 7%。
// 想让闪更"啪"一下就把这个数往上调（3 以上会接近硬开关），想柔和往 1 靠。
const HOVER_PEAK_SHARPNESS = 2.2;
const HOVER_EMISSIVE_DIM = 0.0;
const HOVER_EMISSIVE_PEAK = 0.85;
const HOVER_MESH_DIM = new THREE.Color(0xa4bacd); // 暗态：比模型灰略偏蓝，弱但可辨
const HOVER_MESH_PEAK = new THREE.Color(0xd6e7f5); // 亮态：压在"柔和的浅蓝"，不再冲到近白
const HOVER_LINE_DIM = new THREE.Color(0x6b7f90);
const HOVER_LINE_PEAK = new THREE.Color(0xbcd9ee);
const HOVER_POLL_MS = 60;                         // 准星射线节流（≈16 Hz，足够跟手且不占帧预算）

export class Model3D {
  constructor(canvas, { onSelect, onReady, onNavigationState, onMeasurementChange,
                        onGameContextMenu, resolvePointName, appearance = null } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.onReady = onReady;
    this.onNavigationState = onNavigationState;   // 导航状态变化时回调（切换 Orbit/Game 后按钮高亮依赖它）
    this.onMeasurementChange = onMeasurementChange; // 测量状态变化时回调（面板回显依赖它）
    this.onGameContextMenu = onGameContextMenu;
    this.resolvePointName = resolvePointName || null; // canonicalId → 元数据名称/位号（对象中心点命名用）
    this.nodeByCanonical = new Map();     // canonical → Object3D（有名节点）
    this.meshByCanonical = new Map();     // canonical → Mesh[]（含子孙）
    this.hiddenCanonicals = new Set();
    this.selection = new Set();           // 多选集合（canonical，保持加入顺序）
    this.selected = null;                 // 主选中 = 最近一次加入的那个（单值语义仍被树/属性面板使用）
    this.hover = null;                    // 预选中（准星指到的实体），未指到为 null
    this._hoverPolledAt = 0;
    this._hoverCamSig = null;             // 上次预选中射线时的相机位姿签名（静止时省掉重复射线）
    this._hoverDirty = true;              // 场景/选择变化后强制重算一次预选中
    this.ready = false;
    this.modelOrigin = null;              // GLB asset.extras['rvmparser-origin']：坐标回映射要用
    this.floorPlanGroup = null;           // 与模型 root 平级：不进入树/拾取/显隐/隔离
    this.floorPlanVisible = true;         // 设备定位图默认开启；换版本保留用户当前开关
    this.floorPlanDebug = false;
    this.floorPlanError = null;
    this.objectColorOverrides = new Map(); // canonicalId → THREE.Color；只在当前模型会话有效
    this._overrideMeshMaterials = new Map();
    this._overrideLineMaterials = new Map();
    this._objectColorsDirty = false;
    this.globalModelColor = new THREE.Color(appearance?.globalModelColor || MODEL_COLOR);

    // ---- 外观选项（默认关）。跨版本保留：换模型不清掉用户开着的开关，但页面刷新回到默认关。
    this.contours = false;                // 元件轮廓线
    this.xray = false;                    // 隐藏件半透明
    this.xrayOpacity = XRAY_OPACITY_DEFAULT;
    this.lineObjects = [];                // 所有 Line/LineSegments（轮廓线的法线趟要把它们摘掉）
    // 材质替换台账：obj → 原始材质。用 Map 而不是数组 —— 父子节点同时被选中时，
    // 同一个 mesh 会出现在多个 canonical 的网格列表里，数组会把它记两次并还原成错误材质。
    this._swapped = new Map();
    this._ghost = new Set();              // 本轮被换成 ghost 材质的对象（用于给选中/预选中让路）

    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.info.autoReset = false;      // 手动 reset，否则读到的只是最后一个 pass
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.performance = new PerformanceDiagnostics(this.renderer);

    this.scene = new THREE.Scene();
    this.sceneAppearance = new SceneAppearance(this.scene, {
      backgroundColor: appearance?.backgroundColor || `#${new THREE.Color(BG_COLOR).getHexString()}`,
      environmentMode: appearance?.environmentMode,
      environmentPreset: appearance?.environmentPreset,
      environmentTexture: appearance?.environmentTexture,
      environmentColors: appearance?.environmentColors,
      groundEnabled: appearance?.groundEnabled === true,
      groundColor: appearance?.groundColor || '#d7dde3',
    });

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.05, 20000);
    this.camera.position.set(90, 70, 90);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 8000;
    this.controls.minDistance = 0.2;
    this.lastInteract = 0;
    this.controls.addEventListener('change', () => { this.lastInteract = performance.now(); });

    this.lightSettings = normalizeSettings(appearance);
    this.lighting = new LightingController(this.scene, this.lightSettings);

    // Render → shared Normal/Depth → AO → engineering helpers → Edge → Outline → Output.
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 4,                                  // 保持抗锯齿
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(Math.min(devicePixelRatio, 2));
    // 记录「场景本身」的绘制量：renderer.info 会被最后一个 pass（OutputPass 的全屏四边形）
    // 覆盖成 1 次绘制，所以必须在 RenderPass 执行完的那一刻读一次。
    this.renderPass = new RenderPass(this.scene, this.camera);
    const origRender = this.renderPass.render.bind(this.renderPass);
    this.renderPass.render = (renderer, wtr, rtr, dt, mr) => {
      if (this.aoOverlayPass?.enabled) this.aoOverlayPass.hideForBase();
      try { origRender(renderer, wtr, rtr, dt, mr); }
      finally { this.aoOverlayPass?.restoreBase(); }
      this.sceneDrawCalls = renderer.info.render.calls;
      this.sceneTriangles = renderer.info.render.triangles;
      const now = performance.now();
      if (!this._renderableCountAt || now - this._renderableCountAt >= 500) {
        const list = renderer.renderLists.get(this.scene, 0);
        const objects = new Set();
        let meshes = 0, lines = 0;
        for (const bucket of [list.opaque, list.transmissive, list.transparent]) {
          for (const item of bucket) {
            const object = item.object;
            if (!object || objects.has(object.id)) continue;
            objects.add(object.id);
            if (object.isMesh) meshes++;
            else if (object.isLine || object.isLineSegments || object.isLineLoop) lines++;
          }
        }
        this.visibleMeshes = meshes;
        this.visibleLines = lines;
        this._renderableCountAt = now;
      }
    };
    this.composer.addPass(this.renderPass);
    // AO / Edge consume one packed normal-depth target; Outline remains the final interaction layer.
    this.normalDepthPass = new NormalDepthPass(this.scene, this.camera, this);
    this.composer.addPass(this.normalDepthPass);
    this.aoPass = new AmbientOcclusionPass(this.normalDepthPass, this.camera);
    this.composer.addPass(this.aoPass);
    this.aoOverlayPass = new AOOverlayPass(this);
    this.composer.addPass(this.aoOverlayPass);
    this.setLightingAppearance(this.lightSettings);
    this.edgePass = new EdgeLinesPass(this.normalDepthPass);
    this.edgePass.enabled = false;
    this.composer.addPass(this.edgePass);
    this.outline = new OutlinePass(new THREE.Vector2(w, h), this.scene, this.camera);
    this.outline.edgeStrength = 3.2;
    this.outline.edgeGlow = 0.0;
    this.outline.edgeThickness = 1.6;
    this.outline.visibleEdgeColor.set(OUTLINE_COLOR);
    this.outline.hiddenEdgeColor.set(0x8a6a3a);
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.05;
    this._ndc = new THREE.Vector2();      // 复用，避免每帧新建

    // ---- 导航层（Phase 7A）：Orbit 与 Game 二选一，靠 navigationMode + controls.enabled 互斥。
    // 本文件只负责"创建 / 启用 / 停用 Navigation Controller"，相机运动算法全在 navigation/ 里。
    this.navigationMode = 'orbit';
    this.navigationSettings = new NavigationSettingsStore();
    this.navigation = new EngineeringNavigation({
      camera: this.camera,
      canvas,
      worldUp: this.camera.up,                 // 宿主向上轴：本模型 PDMS Z-up 已转为 glTF Y-up
      settings: this.navigationSettings,
      onRequestModeToggle: () => this.toggleNavigationMode(),   // F8（模式切换的唯一键盘入口）
      // 准星拾取：已捕获时左键选中屏幕中心的对象，点空处清空选中。
      onRequestCenterPick: (opts) => { if (this.ready && this.root) this._pickAtCenter(opts); },
      onRequestSelectionMenu: (point) => {
        if (this.selection.size) this.onGameContextMenu?.(point);
      },
      onStateChange: () => this._emitNavigationState(),
    });
    this._orbitDistance = this.camera.position.distanceTo(this.controls.target);

    // ---- 测距层（游戏式测距）。与 FloorPlanGroup 一样是"与 root 平级的独立层"：
    // 不进模型树、不参与 raycast、不受隐藏/隔离影响。准星射线复用本类已有拾取路径。
    const overlayParent = canvas.parentElement;
    this.measurement = new MeasurementController(this, {
      labelRoot: overlayParent ? overlayParent.querySelector('#measureLabels') : null,
      reticle: overlayParent ? overlayParent.querySelector('#measureReticle') : null,
      onChange: (state) => this.onMeasurementChange?.(state),
      // 对象中心点命名复用既有的 canonicalId → metadata 映射（由装配层注入，本层不认识元数据）
      resolveName: (canonicalId) => this.resolvePointName?.(canonicalId) ?? null,
    });
    this.orientationGizmo = new OrientationGizmo({
      mainCamera: this.camera,
      parent: overlayParent,
      onDirection: (direction) => this.setOrientationView(direction),
    });

    this._bindEvents();
    this._loop();
  }

  _bindEvents() {
    const el = this.canvas;
    let downX = 0, downY = 0, downT = 0;
    el.addEventListener('pointerdown', (e) => {
      downX = e.clientX; downY = e.clientY; downT = performance.now();
      // Game 右键会先由导航层释放 Pointer Lock，随后不一定产生可观察的 pointerup；
      // 在 Game 入口立即取消 pending，不影响 Orbit 右键拖动的“拖动不取消”语义。
      if (e.button === 2 && this.navigationMode === 'game' && this.measurement?.enabled) {
        this.measurement.cancelPending();
      }
    });
    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      const isClick = moved <= 4 && performance.now() - downT <= 700;   // 拖拽/长按不算点击
      // 右键 = 取消"未完成的测量点"（只取了 A、还没取 B 时反悔）。
      // 放在 game 的早退之前 —— 两种导航模式下都要能用；同样只在"没拖动"时算数，
      // 因为 Orbit 模式下右键拖动是平移，不能顺手把测量点取消掉。
      // 已完成的两点测量不受影响（只清 pending），
      // 游戏导航右键会另外打开已选对象菜单；此处只处理测量待定点。
      if (e.button === 2) {
        if (isClick && this.measurement?.enabled) this.measurement.cancelPending();
        return;
      }
      // 游戏导航中鼠标只负责相机：点击不触发拾取（原插件同样如此，Esc 释放鼠标后才恢复选中）
      if (this.navigationMode === 'game') return;
      if (e.button !== 0) return;
      if (!isClick) return;
      // 测距开启时左键专用于取点（射线仍从屏幕中心发出，与鼠标位置无关），
      // 且**不改动选择集** —— 退出测距后选择/高亮行为原样恢复。
      if (this.measurement?.enabled) { this.measurement.recordSurface(); return; }
      // CTRL（⌘）按住 = 多选：把该对象加入/移出选择集，而不是重置为单选
      this._pick(e, { additive: e.ctrlKey || e.metaKey });
    });
    new ResizeObserver(() => this.resize()).observe(el.parentElement);
    addEventListener('keydown', (e) => {
      // 输入框里打字不触发复位（树搜索 / 导航设置数字框）
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      if (keyBindings.has('navigation.fit', e.code)) this.fit(this.selectedCanonicals);
    });
  }

  // ------------------------------------------------ 导航模式（Orbit | Game）
  /** 原插件 `Start()` 的宿主校验在 Web 的等价物：模型必须已就绪 */
  setNavigationMode(mode) {
    if (mode !== 'game' && mode !== 'orbit') return;
    if (mode === this.navigationMode) { this._emitNavigationState(); return; }

    if (mode === 'game') {
      if (!this.ready) { this.navigationFailure = '模型尚未加载完成。'; this._emitNavigationState(); return; }
      this._orbitDistance = this.camera.position.distanceTo(this.controls.target);
      this.controls.enabled = false;             // 两个 Controller 不同时响应输入
      // A top/bottom compass view uses a horizontal camera-up for readable plan
      // orientation. Restore the engineering U axis before Game builds its frame.
      this.camera.up.copy(ENGINEERING_AXES.U);
      this.navigationMode = 'game';
      const failure = this.navigation.start();
      if (failure) {                             // 建帧失败：回滚，保持 Orbit 可用
        this.navigationMode = 'orbit';
        this.controls.enabled = true;
        this.navigationFailure = failure;
      } else {
        this.navigationFailure = null;
      }
    } else {
      this.navigation.stop();                    // 保留当前相机位姿
      this.navigationMode = 'orbit';
      this._restoreOrbitTarget();
      this.controls.enabled = true;
    }
    this._emitNavigationState();
  }

  toggleNavigationMode() {
    this.setNavigationMode(this.navigationMode === 'game' ? 'orbit' : 'game');
  }

  /** 退出游戏导航时把 Orbit 的旋转中心放到视线正前方：
   *  既保住退出瞬间的朝向（target 在视线上，update() 的 lookAt 不会改变朝向），
   *  又不会因为距离超过 maxDistance 被 OrbitControls 的距离钳制把相机扯回来。 */
  _restoreOrbitTarget() {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const distance = Math.min(
      Math.max(this._orbitDistance || 10, this.controls.minDistance),
      this.controls.maxDistance);
    this.controls.target.copy(this.camera.position).addScaledVector(forward, distance);
    this.controls.update();
  }

  navigationState() {
    return {
      mode: this.navigationMode,
      orbitEnabled: this.controls.enabled,
      orbitTarget: this.controls.target.toArray(),
      failure: this.navigationFailure || null,
      ...this.navigation.state(),
    };
  }

  _emitNavigationState() {
    this.onNavigationState?.(this.navigationState());
  }

  resize() {
    const p = this.canvas.parentElement;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ratio = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);

  }

  // ------------------------------------------------ 加载 / 卸载
  /** 卸载当前模型：移除节点、释放几何与材质、清空索引与选中/隐藏状态。
   *
   *  没有这一步就没法安全地"切换模型"——旧的 BufferGeometry 与显存缓冲不会自己消失，
   *  连续切换几十次就会把显存吃满。渲染器 / 后期处理 / 导航控制器保持常驻，不重建。 */
  unload() {
    this.batchRendering?.dispose();
    this.batchRendering = null;
    this.sceneAppearance?.syncGround(null);
    // 测量结果的坐标属于上一个模型，必须作废（测量开关本身保留，与 floorPlanVisible 同理）
    this.measurement?.reset();
    if (this.floorPlanGroup) {
      this.scene.remove(this.floorPlanGroup);
      this.floorPlanGroup.dispose();
      this.floorPlanGroup = null;
    }
    this.floorPlanError = null;
    // 换模型前先退出工程导航：导航控制器常驻，但模型卸掉后 ready=false，
    // 留在 Game 模式会出现"导航开着但没有模型"的空档状态（Phase 7A）。
    if (this.navigationMode === 'game') this.setNavigationMode('orbit');
    if (this.root) {
      this.scene.remove(this.root);
      const geos = new Set();
      const mats = new Set();
      this.root.traverse((o) => {
        if (o.geometry) geos.add(o.geometry);
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) mats.add(m);
      });
      for (const g of geos) g.dispose();
      for (const m of mats) {
        for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
          m[k]?.dispose();
        }
        m.dispose();
      }
      this.root = null;
    }
    for (const m of [this.meshMat, this.batchMeshMat, this.lineMat, this.selMeshMat, this.selLineMat,
                     this.hoverMeshMat, this.hoverLineMat,
                     this.ghostMeshMat, this.ghostLineMat]) m?.dispose();
    const attachedOverrideMaterials = new Set([...this._overrideMeshMaterials.values(), ...this._overrideLineMaterials.values()]);
    for (const m of attachedOverrideMaterials) m.dispose();
    this._overrideMeshMaterials.clear();
    this._overrideLineMaterials.clear();
    this.meshMat = this.batchMeshMat = this.lineMat = this.selMeshMat = this.selLineMat = null;
    this.hoverMeshMat = this.hoverLineMat = null;
    this.ghostMeshMat = this.ghostLineMat = null;

    this.nodeByCanonical.clear();
    this.meshByCanonical.clear();
    this.hiddenCanonicals.clear();
    this.lineObjects.length = 0;          // 轮廓线 pass 引用的是同一个数组
    this._swapped.clear();                // 材质替换台账（obj → 原材质）
    this._ghost.clear();                  // 本轮被换成 ghost 材质的对象
    this.objectColorOverrides.clear();    // canonicalId 只属于当前模型会话
    this.selection.clear();
    this.selected = null;                 // 不把上一模型的 object id 带到下一模型
    this.hover = null;
    this._hoverCamSig = null;
    this._hoverDirty = true;
    this.outline.selectedObjects = [];
    this.box = null;
    this.info = null;
    this.modelOrigin = null;
    this.ready = false;
    this.canvas.style.cursor = "default";
    this.onSelect?.(null);                // 让树/属性面板同步清空
  }

  async load(url, onProgress, { floorplan = null } = {}) {
    this.unload();                        // 防御性：重复 load 不会叠加
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) =>
      loader.load(url, res, onProgress, (e) => rej(new Error(e?.message || 'GLB 加载失败'))));

    this.root = gltf.scene;
    // RVM→GLB 换算的原点（米）。测距把世界坐标还原成 PDMS 世界坐标（mm）要用它，
    // 设备定位图用的是同一个值 —— 只读一次，两处共用，避免口径分叉。
    const origin = gltf.parser?.json?.asset?.extras?.['rvmparser-origin'];
    this.modelOrigin = Array.isArray(origin) && origin.length === 3
      && origin.every((v) => typeof v === 'number' && Number.isFinite(v)) ? origin : null;

    // 统一灰色：原始 mesh 与 Batch solid 各复用一个材质实例。
    // Batch solid 额外带对象色属性；原始 mesh 保持普通材质，避免给每个源几何增加属性。
    this.meshMat = new THREE.MeshStandardMaterial({ color: this.globalModelColor, roughness: 0.82, metalness: 0 });
    this.batchMeshMat = makeBatchModelMaterial({ color: this.globalModelColor, roughness: 0.82, metalness: 0 });
    this.lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR });
    this.setGlobalModelColor(`#${this.globalModelColor.getHexString()}`);
    // 选中态材质：常驻的发光高亮（几乎零开销），保证拖动时选中对象也看得见；
    // 空闲时再叠加 OutlinePass 的描边（描边开销大，交互中暂停——任务书允许这样做）。
    this.selMeshMat = new THREE.MeshStandardMaterial({
      color: 0xd9a05a, emissive: 0x6b3d08, emissiveIntensity: 1.0,
      roughness: 0.55, metalness: 0,
    });
    this.selLineMat = new THREE.LineBasicMaterial({ color: 0xc8791a });
    // 预选中（准星指向）：浅蓝 + 每帧调制的自发光。颜色与强度都在渲染循环里按正弦调制，
    // 这里给的是"亮态"初值。与选中材质一样是全局共享实例（多对象同时预选中也只有一个对象）。
    this.hoverMeshMat = new THREE.MeshStandardMaterial({
      color: HOVER_MESH_PEAK.clone(), emissive: 0x2f7fd0,
      emissiveIntensity: HOVER_EMISSIVE_PEAK, roughness: 0.5, metalness: 0,
    });
    this.hoverLineMat = new THREE.LineBasicMaterial({ color: HOVER_LINE_PEAK.clone() });
    // 隐藏件半透明（X-ray ghost）：常驻但只在 xray 开关打开时才会被挂到对象上。
    // depthWrite=false 是半透明的关键 —— 否则先绘制的 ghost 会把后面的 ghost 整块挡掉，
    // "半透明互见"就消失了。代价是同一物体前后表面叠加会略深，工程几何上可接受。
    this.ghostMeshMat = new THREE.MeshStandardMaterial({
      color: GHOST_COLOR, roughness: 0.72, metalness: 0,
      transparent: true, opacity: this.xrayOpacity, depthWrite: false,
    });
    this.ghostLineMat = new THREE.LineBasicMaterial({
      color: GHOST_LINE_COLOR, transparent: true,
      opacity: this._ghostLineOpacity(), depthWrite: false,
    });

    // 统一灰色：必须覆盖**全部** mesh —— 包括无名 holder 下的几何。
    // ⚠️ 不能只依赖 _applyHighlight()：它按 canonical 遍历 meshByCanonical，只认得"有名字的节点"，
    //    无名节点下的网格会一直顶着 glTF 原生材质（metallic=1/roughness=1）渲染成黑色。
    // 这一趟同时登记所有线对象给轮廓线 pass（法线趟必须把它们摘掉）。
    let meshes = 0, lines = 0;
    this.lineObjects.length = 0;
    this.root.traverse((o) => {
      if (o.isMesh) { o.material = this.meshMat; meshes++; }
      else if (o.isLineSegments || o.isLine || o.isLineLoop) {
        o.material = this.lineMat; lines++; this.lineObjects.push(o);
      }
    });

    // 索引：原始 glTF 名 → 节点 / 网格集合
    this.root.traverse((o) => {
      const gltfName = o.userData && o.userData.name;
      if (!gltfName) return;                      // 跳过无名 holder 与被自动命名的 mesh
      this.nodeByCanonical.set(gltfName, o);
      const ms = [];
      o.traverse((c) => { if (c.isMesh || c.isLineSegments || c.isLine) ms.push(c); });
      this.meshByCanonical.set(gltfName, ms);
    });

    this.scene.add(this.root);
    this._applyVisibility();              // 材质与可见性统一在这里落地（含轮廓线/半透明当前状态）
    this.box = new THREE.Box3().setFromObject(this.root);
    this.enableBatchRendering();          // 正式路径：保留原层级，仅替换 Mesh 渲染集合
    if (floorplan) {
      try {
        this.floorPlanGroup = new FloorPlanGroup({
          document: floorplan,
          origin: this.modelOrigin,
          modelBox: this.box,
          nodeByCanonical: this.nodeByCanonical,
        });
        this.floorPlanGroup.visible = this.floorPlanVisible;
        this.floorPlanGroup.setDebugVisible(this.floorPlanDebug);
        this.floorPlanGroup.traverse((o) => {
          if (o.isLine || o.isLineSegments || o.isLineLoop) this.lineObjects.push(o);
        });
        this.scene.add(this.floorPlanGroup);
      } catch (e) {
        this.floorPlanError = e?.message || String(e);
        console.warn('[viewer] 设备定位图未加载：', this.floorPlanError);
      }
    }
    this.sceneAppearance.syncGround(this.box, this.floorPlanGroup?.floorY ?? null);
    // 测量线也要登记进轮廓线 pass 的"临时摘掉"清单：线几何没有 NORMAL，
    // 留着会在法线图里造出成片假边缘（与 floorplan 的线同一个理由）。
    for (const line of (this.measurement?.group.lineObjects || [])) this.lineObjects.push(line);
    this.fit(null);                       // 切换模型后默认 Fit Model
    this.ready = true;
    // 默认导航模式 = 游戏导航：模型就绪后自动切入（Game 需要 ready，故挂在这里而非构造时）。
    // 若建帧失败会自动回落 Orbit 并记录 navigationFailure，不影响加载流程。
    this.setNavigationMode('game');
    this.info = {
      meshes, lines, namedNodes: this.nodeByCanonical.size,
      floorplan: this.floorPlanGroup?.stats || null,
      floorplanError: this.floorPlanError,
    };
    if (this.nodeByCanonical.size === 0) {
      console.warn('[viewer] 没有索引到任何命名节点：GLB 可能与 metadata 不是同一版本');
    }
    this.onReady?.(this.info);
    return this.info;
  }

  // ------------------------------------------------ 拾取
  /** 从 mesh 向上找最近的对象色覆盖；因此子对象覆盖优先于父对象覆盖。 */
  _objectColorForObject(object) {
    for (let node = object; node; node = node.parent) {
      const canonical = node.userData?.name;
      if (canonical && this.objectColorOverrides.has(canonical)) {
        return this.objectColorOverrides.get(canonical);
      }
      if (node === this.root) break;
    }
    return null;
  }

  _overrideMaterial(color, line = false) {
    const key = color.getHexString();
    const cache = line ? this._overrideLineMaterials : this._overrideMeshMaterials;
    if (cache.has(key)) return cache.get(key);
    const material = line
      ? new THREE.LineBasicMaterial({ color })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 });
    cache.set(key, material);
    return material;
  }

  _applyAllObjectBaseMaterials() {
    if (!this.root) return;
    this.root.traverse((object) => {
      if (!(object.isMesh || object.isLineSegments || object.isLine || object.isLineLoop)) return;
      const color = this._objectColorForObject(object);
      const line = object.isLineSegments || object.isLine || object.isLineLoop;
      object.material = color ? this._overrideMaterial(color, line) : (line ? this.lineMat : this.meshMat);
    });
  }

  /** 重画材质：先整体还原，再按「隐藏件 ghost（半透明）> 选中（橙）> 预选中（浅蓝闪烁）」上色。
   *  只有选择集 / 预选中 / 显隐集 / 外观开关变化时才调用；闪烁本身只改材质 uniform，不走这里。 */
  _applyHighlight() {
    for (const [obj, original] of this._swapped) obj.material = original;
    this._swapped.clear();
    this._ghost.clear();

    if (this._objectColorsDirty) {
      this._applyAllObjectBaseMaterials();
      this._objectColorsDirty = false;
    }

    // ① 隐藏件半透明。只在"开关打开且当前确实有隐藏对象"时才走这一趟全场景遍历。
    if (this.xray && this.hiddenCanonicals.size && this.root) {
      this.root.traverse((o) => {
        if (!(o.isMesh || o.isLineSegments || o.isLine || o.isLineLoop)) return;
        if (!this._inHiddenChain(o)) return;
        this._swapped.set(o, o.material);
        o.material = o.isMesh ? this.ghostMeshMat : this.ghostLineMat;
        this._ghost.add(o);
      });
    }

    const paint = (canonical, meshMat, lineMat) => {
      for (const m of (this.meshByCanonical.get(canonical) || [])) {
        if (this._ghost.has(m)) continue;      // ghost 优先：隐藏件不该被高亮成实心色
        if (!this._swapped.has(m)) this._swapped.set(m, m.material);
        const isLine = m.isLineSegments || m.isLine || m.isLineLoop;
        m.material = isLine ? lineMat : meshMat;
      }
    };
    for (const c of this.selection) paint(c, this.selMeshMat, this.selLineMat);
    // 已选中的对象不再叠加预选中（选中态优先，否则点下去颜色会跳一下）
    if (this.hover && !this.selection.has(this.hover)) {
      paint(this.hover, this.hoverMeshMat, this.hoverLineMat);
    }
  }

  /** 线比面细：同样的不透明度下线会先"看不见"，所以给一个系数并夹在上限内 */
  _ghostLineOpacity() {
    return Math.min(this.xrayOpacity * 1.6, XRAY_OPACITY_MAX);
  }

  /** 沿父链判断：该对象（或它的任一命名祖先）是否处于隐藏集里。
   *  隐藏件半透明要按整棵子树判断 —— 单看 node.visible 分不出"自己被隐藏"还是"父被隐藏"。 */
  _inHiddenChain(obj) {
    for (let n = obj; n; n = n.parent) {
      const k = n.userData && n.userData.name;
      if (k && this.hiddenCanonicals.has(k)) return true;
      if (n === this.root) break;
    }
    return false;
  }

  /** 描边对象 = 选择集里所有可见网格（父子同选时同一 mesh 只留一份） */
  _syncOutline() {
    if (this.batchRendering?.enabled) {
      this.outline.selectedObjects = this.batchRendering.selectedRenderObjects();
      return;
    }
    const objs = [];
    for (const c of this.selection) {
      for (const m of (this.meshByCanonical.get(c) || [])) {
        if (this._solidInScene(m)) objs.push(m);
      }
    }
    this.outline.selectedObjects = [...new Set(objs)];
  }

  /** three.js 的 Raycaster 不看 visible，隐藏/隔离必须沿父链自己判 */
  _visibleInScene(obj) {
    for (let n = obj; n; n = n.parent) {
      if (n.visible === false) return false;
      if (n === this.root) break;
    }
    return true;
  }

  /** 视觉上算"实体可见"：沿链没有 visible=false，也不落在任何隐藏集的子树里。
   *  ⚠️ 隐藏件半透明打开时，隐藏对象**仍在渲染**（ghost 半透明），但不算实体 ——
   *     既不描边、也不可拾取，隐藏的语义不能被外观选项改掉。 */
  _solidInScene(obj) {
    return this._visibleInScene(obj) && !this._inHiddenChain(obj);
  }

  /** 向上找最近的有名节点（原始 glTF 名）；无名 holder 会被跳过 */
  parentNamed(o) {
    let n = o;
    while (n && !(n.userData && n.userData.name)) n = n.parent;
    return n;
  }

  _pick(ev, opts = {}) {
    const r = this.canvas.getBoundingClientRect();
    this._pickAtNdc(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1, opts);
  }

  /** 游戏导航准星拾取：准星固定在屏幕中心，即 NDC (0, 0) */
  _pickAtCenter(opts = {}) {
    // 测距开启时左键专用于取点（准星命中的表面点），不改动选择集
    if (this.measurement?.enabled) { this.measurement.recordSurface(); return; }
    this._pickAtNdc(0, 0, opts);
  }

  /** 射线打到哪个 canonical；打空返回 null。拾取与预选中共用这一条几何路径。 */
  _resolveAtNdc(ndcX, ndcY) {
    const hit = this._hitAtNdc(ndcX, ndcY);
    return hit ? hit.canonicalId : null;
  }

  /** 一次射线拿到**完整命中信息**：canonicalId + 实际表面命中点 + 命中距离。
   *
   *  这是全项目唯一的中心/指定 NDC 射线实现：拾取、预选中、测距都走它，
   *  保证三者的 canonicalId 口径完全一致（批量渲染时 faceIndex → canonicalId 的
   *  解析由 BatchRenderingManager.resolveHit 负责，与渲染是同一份台账）。
   */
  _hitAtNdc(ndcX, ndcY) {
    if (!this.root) return null;
    this.raycaster.setFromCamera(this._ndc.set(ndcX, ndcY), this.camera);
    if (this.batchRendering?.enabled) {
      const batchHits = this.raycaster.intersectObject(this.batchRendering.group, true);
      for (const hit of batchHits) {
        const canonicalId = this.batchRendering.resolveHit(hit);
        if (canonicalId && this.meshByCanonical.has(canonicalId)) {
          return { canonicalId, point: hit.point, distance: hit.distance, object: hit.object };
        }
      }
      return null;
    }
    const hits = this.raycaster.intersectObject(this.root, true);
    for (const h of hits) {
      if (!this._solidInScene(h.object)) continue;
      const named = this.parentNamed(h.object);
      const key = named && named.userData && named.userData.name;
      if (key && this.meshByCanonical.has(key)) {
        return { canonicalId: key, point: h.point, distance: h.distance, object: h.object };
      }
    }
    return null;
  }

  enableBatchRendering(options = {}) {
    this.batchRendering?.dispose();
    this.batchRendering = new BatchRenderingManager(this, options);
    const result = this.batchRendering.build();
    this._syncOutline();
    return result;
  }

  disableBatchRendering() {
    this.batchRendering?.dispose();
    this.batchRendering = null;
    this._applyVisibility();
  }

  _pickAtNdc(ndcX, ndcY, opts = {}) {
    const key = this._resolveAtNdc(ndcX, ndcY);
    // Ctrl 点空处不清空已有多选（否则多选过程中手一抖就全没了）
    if (!key && opts.additive) return;
    this.select(key, opts);
  }

  // ------------------------------------------------ 选中 / 高亮（支持 Ctrl 多选）
  /** @param {object} [opts] { additive } —— additive=true 时把该对象加入/移出选择集（Ctrl 多选），
   *  否则重置为单选；其余字段原样传给 onSelect（如树 Ctrl 多选）。 */
  select(canonical, opts = {}) {
    const additive = !!opts.additive;
    if (!canonical) {
      if (additive) return;                  // Ctrl 点空：保持现状
      this.selection.clear();
      this.selected = null;
    } else if (additive) {
      if (this.selection.delete(canonical)) {
        // 移出：主选中退到剩余集合里最后加入的那个
        if (this.selected === canonical) this.selected = this._lastSelected();
      } else {
        this.selection.add(canonical);
        this.selected = canonical;
      }
    } else {
      this.selection.clear();
      this.selection.add(canonical);
      this.selected = canonical;
    }
    this._applyHighlight();
    this.batchRendering?.sync();
    this._syncOutline();
    this._hoverDirty = true;                 // 选中会改材质，预选中需要重算一遍
    this.canvas.style.cursor = this.selected ? 'pointer' : 'default';
    this.onSelect?.(this.selected, opts);
  }

  _lastSelected() {
    let last = null;
    for (const c of this.selection) last = c;   // Set 保持插入顺序
    return last;
  }

  /** 当前选择集（canonical 数组，按加入顺序）；单值语义请用 this.selected */
  get selectedCanonicals() { return [...this.selection]; }

  // ------------------------------------------------ 预选中（准星指向）
  /** 预选中只在"游戏导航 + 准星可见"时生效；准星可见 ⇔ active && !paused && captured && focused */
  get hoverEnabled() {
    return !!(this.ready && this.root && this.navigationMode === 'game'
      && this.navigation.shouldShowCrosshair);
  }

  /** 每帧调用：按节流重算准星指向；相机静止且场景无变化时直接跳过（省掉一次全场景射线） */
  _updateHover(now) {
    if (!this.hoverEnabled) {
      this._setHover(null);
      // 记下的相机签名必须作废：否则"Esc 释放 → 原地重新捕获"会因签名未变而永远不重算
      this._hoverCamSig = null;
      return;
    }
    // 测距开启时准星射线由测量层统一发射（它本来就要每帧算命中点），
    // 预选中直接沿用同一结果，省掉一整趟全场景射线。
    if (this.measurement?.enabled) {
      this._setHover(this.measurement.aimCanonicalId);
      this._hoverCamSig = null;      // 让"关闭测距"后的下一次更新一定重算
      return;
    }
    if (now - this._hoverPolledAt < HOVER_POLL_MS) return;
    const sig = this._cameraSignature();
    if (!this._hoverDirty && sig === this._hoverCamSig) return;
    this._hoverPolledAt = now;
    this._hoverCamSig = sig;
    this._hoverDirty = false;
    this._setHover(this._resolveAtNdc(0, 0));
  }

  _cameraSignature() {
    const p = this.camera.position, q = this.camera.quaternion;
    return `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},`
      + `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)},${this.camera.fov}`;
  }

  _setHover(canonical) {
    if (this.hover === canonical) return;
    this.hover = canonical;
    this._applyHighlight();
    this.batchRendering?.sync();
    this.onHover?.(canonical);
  }

  /** 闪烁：只改共享材质的 uniform（颜色 / 自发光强度），不重建材质、不重编译着色器 */
  _animateHover(now) {
    if (!this.hover || !this.hoverMeshMat) return;
    const t = 0.5 - 0.5 * Math.cos(2 * Math.PI * HOVER_BLINK_HZ * now / 1000);
    // 次幂 > 1 把波形整体压向"暗态"一侧：亮态只是短暂掠过峰值，不再在峰值附近磨蹭。
    // （原先用 smoothstep 两端各停留很久，在低频下看起来更像"亮着不动"而不是闪）
    const v = Math.pow(t, HOVER_PEAK_SHARPNESS);
    this.hoverMeshMat.color.copy(HOVER_MESH_DIM).lerp(HOVER_MESH_PEAK, v);
    this.hoverMeshMat.emissiveIntensity = HOVER_EMISSIVE_DIM
      + (HOVER_EMISSIVE_PEAK - HOVER_EMISSIVE_DIM) * v;
    this.hoverLineMat.color.copy(HOVER_LINE_DIM).lerp(HOVER_LINE_PEAK, v);
  }

  /** 供自动化实测读取 */
  hoverState() {
    const meshes = this.hover ? (this.meshByCanonical.get(this.hover) || []) : [];
    return {
      enabled: this.hoverEnabled,
      canonical: this.hover,
      meshes: meshes.length,
      emissiveIntensity: this.hoverMeshMat ? +this.hoverMeshMat.emissiveIntensity.toFixed(4) : null,
      meshColor: this.hoverMeshMat ? this.hoverMeshMat.color.getHexString() : null,
      lineColor: this.hoverLineMat ? this.hoverLineMat.color.getHexString() : null,
      blinkHz: HOVER_BLINK_HZ,
      emissivePeak: HOVER_EMISSIVE_PEAK,      // 供实测按"峰值的百分比"断言闪烁幅度
      peakSharpness: HOVER_PEAK_SHARPNESS,    // 峰值越尖，亮态停留越短
      pollMs: HOVER_POLL_MS,
    };
  }

  selectionState() {
    return {
      count: this.selection.size,
      canonicals: this.selectedCanonicals,
      primary: this.selected,
      outlineObjects: this.outline.selectedObjects.length,
      swappedObjects: this._swapped.size,
    };
  }

  // ------------------------------------------------ 视图
  /** @param {string|string[]|Set<string>|null} target 单个 canonical / 多个 / null = 整个模型 */
  fit(target) {
    let box = null;
    const list = typeof target === 'string' ? [target]
      : (target && typeof target[Symbol.iterator] === 'function' ? [...target] : []);
    for (const canonical of list) {
      const node = this.nodeByCanonical.get(canonical);
      if (!node) continue;
      const b = new THREE.Box3().setFromObject(node);
      if (b.isEmpty()) continue;
      box = box ? box.union(b) : b;
    }
    if (!box) box = this.box.clone();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.15;
    const dir = new THREE.Vector3(0.72, 0.55, 0.72).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.02, dist / 5000);
    this.camera.far = dist * 12 + 500;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.maxDistance = Math.max(dist * 8, this.box.getSize(new THREE.Vector3()).length() * 2);
    this.controls.update();
    this._orbitDistance = this.camera.position.distanceTo(this.controls.target);
    // 游戏导航中复位：相机被外部移动后必须重建导航基准帧，
    // 否则 frame 与实际朝向脱节，下一次视角转动会瞬移回旧方向
    if (this.navigationMode === 'game') this.navigation.rebase();
  }

  /**
   * Set an engineering orthogonal view from the compass. Orbit/Game keep
   * their existing control logic; they are only rebased after the pose change.
   */
  setOrientationView(direction) {
    if (!this.ready || !this.root || !this.box || !ORIENTATION_VECTORS[direction]) return false;
    const box = this.box.clone();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const distance = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.15;
    const directionVector = ORIENTATION_VECTORS[direction].clone();
    this.camera.position.copy(center).addScaledVector(directionVector, distance);
    // Keep the plan orientation readable while preserving the existing Y-up GLB frame.
    const viewUp = direction === 'U'
      ? ENGINEERING_AXES.N.clone()
      : direction === 'D'
        ? ENGINEERING_AXES.N.clone().negate()
        : ENGINEERING_AXES.U.clone();
    this.camera.up.copy(viewUp);
    this.controls.target.copy(center);
    this.camera.lookAt(center);
    this.camera.near = Math.max(0.02, distance / 5000);
    this.camera.far = distance * 12 + 500;
    this.camera.updateProjectionMatrix();
    if (this.navigationMode === 'game') {
      this.camera.up.copy(ENGINEERING_AXES.U);
    } else {
      this.controls.update();
    }
    this._orbitDistance = this.camera.position.distanceTo(this.controls.target);
    if (this.navigationMode === 'game') this.navigation.rebase();
    return true;
  }

  // ------------------------------------------------ 显隐
  _namedNodes(excludeTechnical = true) {
    const out = [];
    for (const [name, node] of this.nodeByCanonical) {
      if (excludeTechnical && this.isTechnical(name)) continue;
      out.push([name, node]);
    }
    return out;
  }

  isTechnical(name) {
    return name === '/MDBs' || name.includes('rvmparser') || name.endsWith('.rvm');
  }

  /** 把 hiddenCanonicals 落到 node.visible 上，再重画材质。
   *  ⚠️ 隐藏件半透明打开时**不能**简单地把被隐藏的节点设成 visible=false ——
   *     那样它们根本不会进渲染，ghost 也就无从谈起。所以这里按 xray 分两种落地方式。 */
  _applyVisibility() {
    const xray = this.xray;
    for (const [name, node] of this._namedNodes()) {
      node.visible = xray ? true : !this.hiddenCanonicals.has(name);
    }
    this._applyHighlight();
    this.batchRendering?.sync();
    this._syncOutline();
  }

  /** 隐藏整个选择集（多选时一次隐藏全部） */
  hideSelected() {
    if (!this.selection.size) return false;
    let n = 0;
    for (const c of this.selection) {
      if (!this.nodeByCanonical.has(c)) continue;
      this.hiddenCanonicals.add(c);
      n++;
    }
    if (!n) return false;
    this._applyVisibility();
    this._hoverDirty = true;
    return true;
  }

  /** 隔离：保留下来的 = 选择集里每个对象的祖先链 + 子孙 */
  isolateSelected() {
    if (!this.selection.size) return false;
    const keep = new Set();
    for (const c of this.selection) {
      const sel = this.nodeByCanonical.get(c);
      if (!sel) continue;
      for (let n = sel; n; n = n.parent) {
        const k = n.userData && n.userData.name;
        if (k) keep.add(k);
      }
      sel.traverse((o) => {
        const k = o.userData && o.userData.name;
        if (k) keep.add(k);
      });
    }
    if (!keep.size) return false;
    this.hiddenCanonicals.clear();
    for (const [name] of this._namedNodes()) {
      if (!keep.has(name)) this.hiddenCanonicals.add(name);
    }
    this._applyVisibility();
    this._hoverDirty = true;
    return true;
  }

  showAll() {
    this.hiddenCanonicals.clear();
    this._applyVisibility();
    this._hoverDirty = true;
    return true;
  }

  get hiddenCount() { return this.hiddenCanonicals.size; }

  // ------------------------------------------------ 设备定位底图（独立只读层）
  setFloorPlanVisible(on) {
    this.floorPlanVisible = !!on;
    if (this.floorPlanGroup) this.floorPlanGroup.visible = this.floorPlanVisible;
    return this.floorPlanVisible;
  }

  setFloorPlanDebug(on) {
    this.floorPlanDebug = !!on;
    this.floorPlanGroup?.setDebugVisible(this.floorPlanDebug);
    return this.floorPlanDebug;
  }

  floorPlanState() {
    return {
      available: !!this.floorPlanGroup,
      visible: !!this.floorPlanVisible,
      debug: !!this.floorPlanDebug,
      error: this.floorPlanError,
      stats: this.floorPlanGroup?.stats || null,
    };
  }

  /** 可见命名对象数 = 命名对象里不落在隐藏子树中的那些。
   *  不能用 node.visible 统计：隐藏件半透明打开时隐藏对象仍是 visible=true 才渲染得出来。 */
  visibleNamedCount() {
    let n = 0;
    for (const [name, node] of this._namedNodes()) if (!this._inHiddenChain(node)) n++;
    return n;
  }

  // ------------------------------------------------ 外观选项
  setGlobalModelColor(value) {
    const color = normalizeColor(value, `#${new THREE.Color(MODEL_COLOR).getHexString()}`);
    this.globalModelColor.set(color);
    this.meshMat?.color.set(color);
    this.batchMeshMat?.color.set(color);
    // 默认线色继续保留原 Viewer 的深色；用户真正选择其他模型色时，普通模型线跟随。
    if (this.lineMat) this.lineMat.color.set(color === `#${new THREE.Color(MODEL_COLOR).getHexString()}` ? LINE_COLOR : color);
    return `#${this.globalModelColor.getHexString()}`;
  }

  setBackgroundColor(value) {
    const color = normalizeColor(value, `#${new THREE.Color(BG_COLOR).getHexString()}`);
    return this.sceneAppearance.setBackgroundColor(color);
  }

  setEnvironmentMode(value) { return this.sceneAppearance.setEnvironmentMode(value); }

  setEnvironmentPreset(value) { return this.sceneAppearance.setEnvironmentPreset(value); }

  setEnvironmentColors(value) { return this.sceneAppearance.setEnvironmentColors(value); }

  setEnvironmentTexture(value) { return this.sceneAppearance.setEnvironmentTexture(value); }

  setGroundEnabled(on) {
    return this.sceneAppearance.setGroundEnabled(on);
  }

  setGroundColor(value) {
    const color = normalizeColor(value, '#d7dde3');
    return this.sceneAppearance.setGroundColor(color);
  }

  setLightingAppearance(changes = {}) {
    this.lightSettings = normalizeSettings({ ...this.lightSettings, ...changes });
    this.lighting.apply(this.lightSettings);
    this.aoPass.enabled = this.lightSettings.aoEnabled && this.lightSettings.aoIntensity > 0;
    this.aoPass.intensity = this.lightSettings.aoIntensity;
    this.aoPass.radius = this.lightSettings.aoRadius;
    this.aoOverlayPass.enabled = this.aoPass.enabled;
    this.normalDepthPass.enabled = this.aoPass.enabled || this.contours;
    return this.lightSettings;
  }

  applyUserAppearance(settings = {}) {
    this.setLightingAppearance(settings);
    this.setGlobalModelColor(settings.globalModelColor);
    this.setBackgroundColor(settings.backgroundColor);
    this.sceneAppearance.applyEnvironment(settings);
    this.setGroundColor(settings.groundColor);
    this.setGroundEnabled(settings.groundEnabled === true);
    return this.appearanceState();
  }

  resetTransientAppearance() {
    this.setContours(false);
    this.setXray(false);
    this.setXrayOpacity(XRAY_OPACITY_DEFAULT);
    this.clearAllObjectColors();
    return this.appearanceState();
  }

  setObjectColor(canonicals, value) {
    const list = typeof canonicals === 'string' ? [canonicals] : [...(canonicals || [])];
    const color = normalizeColor(value, null);
    if (!color) return false;
    const changed = [];
    for (const canonical of list) {
      if (!canonical || !this.nodeByCanonical.has(canonical)) continue;
      this.objectColorOverrides.set(canonical, new THREE.Color(color));
      changed.push(canonical);
    }
    if (!changed.length) return false;
    this._objectColorsDirty = true;
    this._applyHighlight();
    this.batchRendering?.updateObjectColors(changed);
    this._syncOutline();
    return true;
  }

  clearObjectColor(canonicals) {
    const list = typeof canonicals === 'string' ? [canonicals] : [...(canonicals || [])];
    const changed = [];
    for (const canonical of list) {
      if (this.objectColorOverrides.delete(canonical)) changed.push(canonical);
    }
    if (!changed.length) return false;
    this._objectColorsDirty = true;
    this._applyHighlight();
    this.batchRendering?.updateObjectColors(changed);
    this._syncOutline();
    return true;
  }

  clearSelectedObjectColor() { return this.clearObjectColor(this.selectedCanonicals); }

  clearAllObjectColors() {
    const changed = [...this.objectColorOverrides.keys()];
    if (!changed.length) return false;
    this.objectColorOverrides.clear();
    this._objectColorsDirty = true;
    this._applyHighlight();
    this.batchRendering?.updateObjectColors(changed);
    this._syncOutline();
    return true;
  }

  objectColorState() {
    return {
      overrides: [...this.objectColorOverrides.entries()].map(([canonical, color]) => ({
        canonical, color: `#${color.getHexString()}`,
      })),
      count: this.objectColorOverrides.size,
    };
  }

  /** 元件轮廓线（屏幕空间边缘检测）。返回生效值。 */
  setContours(on) {
    this.contours = !!on;
    this.edgePass.enabled = this.contours;
    this.normalDepthPass.enabled = this.contours || this.aoPass.enabled;
    return this.contours;
  }

  /** 隐藏件以半透明展现。打开/关闭都会立即重画一次材质与可见性。 */
  setXray(on) {
    this.xray = !!on;
    this._applyVisibility();
    return this.xray;
  }

  /** 半透明不透明度（越小越"虚"）。超出范围会被夹到 [0.05, 0.95]。 */
  setXrayOpacity(value) {
    const v = Number(value);
    const o = Number.isFinite(v)
      ? Math.min(Math.max(v, XRAY_OPACITY_MIN), XRAY_OPACITY_MAX)
      : XRAY_OPACITY_DEFAULT;
    this.xrayOpacity = o;
    if (this.ghostMeshMat) this.ghostMeshMat.opacity = o;
    if (this.ghostLineMat) this.ghostLineMat.opacity = this._ghostLineOpacity();
    return o;
  }

  appearanceState() {
    const scene = this.sceneAppearance.state();
    return {
      globalModelColor: `#${this.globalModelColor.getHexString()}`,
      ...scene,
      lightingEnabled: this.lightSettings.lightingEnabled,
      lightingIntensity: this.lightSettings.lightingIntensity,
      aoEnabled: this.lightSettings.aoEnabled,
      aoIntensity: this.lightSettings.aoIntensity,
      aoRadius: this.lightSettings.aoRadius,
      aoPassEnabled: this.aoPass.enabled,
      normalDepthPassEnabled: this.normalDepthPass.enabled,
      contours: this.contours,
      xray: this.xray,
      xrayOpacity: +this.xrayOpacity.toFixed(3),
      ghostObjects: this._ghost.size,
      edgePassEnabled: this.edgePass.enabled,
      edgeSceneDrawCalls: this.edgePass.lastSceneDrawCalls,
      ghostMeshOpacity: this.ghostMeshMat ? +this.ghostMeshMat.opacity.toFixed(3) : null,
      ghostLineOpacity: this.ghostLineMat ? +this.ghostLineMat.opacity.toFixed(3) : null,
      ghostMeshColor: this.ghostMeshMat ? this.ghostMeshMat.color.getHexString() : null,
      ghostDepthWrite: this.ghostMeshMat ? this.ghostMeshMat.depthWrite : null,
      objectColorOverrides: this.objectColorOverrides.size,
    };
  }

  // ------------------------------------------------ 测距（游戏式，第一版）
  /** 开关测量；打开后屏幕中心出现准星，射线固定从屏幕中心发出（鼠标仍只负责相机） */
  setMeasurement(on) { return this.measurement.setEnabled(on); }
  toggleMeasurement() { return this.measurement.toggle(); }
  measureSurfacePoint() { return this.measurement.recordSurface(); }
  measureObjectCenter() { return this.measurement.recordCenter(); }
  cancelMeasurement() { return this.measurement.cancelPending(); }
  removeLastMeasurement() { return this.measurement.removeLast(); }
  /** Ctrl+Z：撤销上一步（未完成的点，或最后一条测量 + 其终点） */
  undoLastMeasurement() { return this.measurement.undoLast(); }
  clearMeasurements() { return this.measurement.clearAll(); }
  measurementState() { return this.measurement.state(); }
  /** XYZ 分量辅助线开关（对已有测量同样生效） */
  setMeasureComponents(on) { return this.measurement.setComponents(on); }
  /** 连续测量模式开关（V 键）：每完成一条测量，终点自动作为下一条的起点 */
  setMeasureContinuous(on) { return this.measurement.setContinuous(on); }
  toggleMeasureContinuous() { return this.measurement.setContinuous(!this.measurement.continuous); }
  /** 复制到 Excel 的 TSV 文本（不含表头外的单位文字，数值列保持纯数字） */
  measurementClipboardText() { return this.measurement.clipboardText(); }

  // ------------------------------------------------ 渲染循环
  _loop() {
    let frames = 0, last = performance.now(), lastFrame = performance.now();
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      this.performance.beginFrame(now);
      const deltaSeconds = (now - lastFrame) / 1000;
      lastFrame = now;
      if (this.navigationMode === 'game') {
        // 二选一：OrbitControls.update() 每帧都会无条件 lookAt(target)，与游戏导航写朝向互相打架
        this.navigation.update(deltaSeconds);
        // 沿用既有的"交互期间暂停描边"优化：导航中同样视为持续交互
        if (this.navigation.interacting) this.lastInteract = now;
      } else {
        this.controls.update();
      }
      // 测距：准星射线 + 预览线 + 标签投影。必须在相机更新之后、渲染之前（与现实一致），
      // 并且在 _updateHover 之前（预选中要复用它的命中结果）。
      this.measurement.update(now);
      // 预选中：必须在相机更新之后、渲染之前 —— 射线用的是本帧的相机位姿。
      // 位置只在"相机动了 / 场景变了"时重算（节流 60ms），闪烁调制每帧都做（只改 uniform，开销可忽略）。
      this._updateHover(now);
      this._animateHover(now);
      // 拖动/缩放期间关掉描边（开销大），停下 160 ms 后自动恢复
      this.outline.enabled = !!this.selected
        && (performance.now() - this.lastInteract) > 160;
      // 轮廓线同样按开关同步：EffectComposer 会直接跳过 disabled 的 pass，关掉即零开销
      this.edgePass.enabled = this.contours;
      this.lighting.update(this.camera);
      this.normalDepthPass.enabled = this.contours || this.aoPass.enabled;
      this.renderer.info.reset();
      this.composer.render();
      // 独立透明画布：只同步主相机旋转，不进入主场景、后处理、树或 raycast。
      this.orientationGizmo.update();
      this.frameDrawCalls = this.renderer.info.render.calls;   // 本帧全部 pass 合计
      this.performance.endFrame();
      frames++;
      if (now - last >= 500) {
        this.fps = Math.round(frames * 1000 / (now - last));
        this.wasInteracting = (performance.now() - this.lastInteract) <= 160;
        frames = 0; last = now;
        this.drawCalls = this.sceneDrawCalls;
        this.triangles = this.sceneTriangles;
        this.onStats?.(this.performance.snapshot({
          fps: this.fps,
          drawCalls: this.sceneDrawCalls,          // 场景本身（与 Phase 2 口径一致）
          triangles: this.sceneTriangles,
          frameDrawCallsAllPasses: this.frameDrawCalls,  // 含描边/输出等后期 pass
          outlineEnabled: this.outline.enabled,
          contours: this.contours,
          xray: this.xray,
          xrayOpacity: +this.xrayOpacity.toFixed(2),
          interacting: this.wasInteracting,
          visible: this.ready ? this.visibleNamedCount() : 0,
          hidden: this.hiddenCount,
          navigationMode: this.navigationMode,
          visibleMeshes: this.visibleMeshes || 0,
          visibleLines: this.visibleLines || 0,
        }));
      }
    };
    tick();
  }
}
