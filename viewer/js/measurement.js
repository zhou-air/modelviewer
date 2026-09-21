/** 游戏式测距（第一版）：准星取点 → 两点测距。
 *
 * 定位：服务 Game Navigation（WASD + 鼠标视角）。取点方式照搬 FPS 游戏瞄准 ——
 * **不使用鼠标光标**，射线永远从屏幕中心（NDC 0,0）发出；鼠标只负责相机。
 *
 * 组成（对应要求的第 8 条）：
 *   · `MeasurementGroup`      —— 只装测量视觉（点 / 线），与模型 root 平级，
 *                                不进入模型树、不参与 raycast、不受隐藏/隔离影响。
 *   · `MeasurementController` —— 状态机 + 取点 + 结果计算 + UI 回显。
 *
 * 与宿主（Model3D）的边界：
 *   · 射线、canonicalId、包围盒全部走宿主已有实现（`model._hitAtNdc` / `nodeByCanonical`），
 *     本模块只消费结果，不自己造一套拾取。
 *   · 测距的"真实模型空间"换算见 `_compute()`：距离用世界空间（米）算，绝不基于屏幕像素；
 *     展示用的 ΔX/ΔY/ΔZ 按项目既有 RVM→GLB 坐标映射（见下）还原到 PDMS 世界坐标。
 *
 * ---- 坐标系（要求第 9 条）----
 * 项目固定的 RVM→GLB 换算（rvmparser 内完成，floorPlan.js 里同一套已在使用）：
 *   1. mm → m；2. 减去 `asset.extras.rvmparser-origin`；3. 绕 X 轴 -90°（Z-up → Y-up）。
 * 因而： GLB(x, y, z) = ( Xm - oX , Zm - oZ , -(Ym - oY) )   （*m 为 PDMS 米坐标）
 * 反解（本模块使用，单位 mm）：
 *   PDMS X = ( glb.x + oX ) * 1000
 *   PDMS Y = ( -glb.z + oY ) * 1000
 *   PDMS Z = ( glb.y + oZ ) * 1000
 * 这样 ΔZ 就是"高差"、Horizontal = XY 平面内距离，和管道专业的读图习惯一致。
 * 距离本身是旋转不变量，所以 `distanceMm === hypot(ΔX, ΔY, ΔZ)` 恒成立 —— 该恒等式
 * 在 scratch/measure-verify.js 里被当作映射正确性的硬断言。取不到 origin 时退回
 * GLB 轴向（Y 向上）并在状态里标 `axes: GLB_Y_UP`，不静默假装是 PDMS 坐标。
 *
 * ---- 第二版增补（在第一版数据上叠加，不改第一版算法）----
 *   1. **XYZ 分量辅助线**（`setComponents` / `_componentLegs`）：从 A 出发按模型坐标系轴向
 *      ΔX→ΔY→ΔZ 走成阶梯，与直线同属本 Group；方向取自 `AXIS_VECTORS`（世界空间单位轴，
 *      与相机无关）；某方向 |Δ| < 0.1 mm 不画。各向标签显示**绝对值**，正负只留在数据里。
 *      只对**已完成**的测量画（预览阶段准星在动，阶梯线跟着抖反而看不清）。
 *   2. **测点命名**（`_displayNameFor`）：对象中心点优先用元数据名称/位号（宿主注入 `resolveName`，
 *      复用既有 canonicalId→metadata 映射，不重新解析模型），其余退回 P1/P2… 连续编号。
 *   3. **结构化记录**（`_structuredRecord`）：完成两点测量即落库 `{from,to,direct,dx,dy,dz,horizontal}`
 *      + 原始 P1/P2 世界坐标，供复制与后续功能直接取用；`clipboardText()` 输出
 *      TAB 分列 / 换行分记录、表头带单位的纯数字表，可直接粘贴进 Excel。
 *
 * ---- 刻意不做（第一版范围）----
 *   Vertex Snap / Edge Snap / 角度 / 面积 / 连续测量 / 标注编辑一律没有。
 */
import * as THREE from 'three';
import { keyBindings } from './keyBindings.js';
import { ENGINEERING_AXES, GLB_AXES } from './coordinateMapping.js';

const MM_PER_UNIT = 1000;        // GLB 模型空间单位 = 米（由 PDMS mm 换算而来）
const RECORD_FLASH_MS = 260;     // 取点成功时准星闪 "●" 的时长
const MAX_POINTS = 1024;         // 标记点容量（每条测量 2 个）
const MAX_SEGMENTS = 512;        // 测量线段容量
const MAX_COMPONENTS = 1536;     // XYZ 分量辅助线容量（每条测量最多 3 条）
const RENDER_ORDER = 30;         // depthTest:false + 高 renderOrder ⇒ 测量视觉压在最上层
const LABEL_EPSILON_PX = 0.6;    // 标签位移小于它就不写 DOM，避免每帧无谓的样式写
const PREVIEW_MIN_M = 2e-4;      // 准星还在 A 点附近（<0.2 mm）时不显示预览：0.0 mm 的线和标签是噪音
const COMPONENT_MIN_MM = 0.1;    // 某方向差值小于它就不画该方向的辅助线（"接近 0"判据）
const DIRECT_LABEL_LIFT_PX = -13; // 直线距离标签抬到线上方，别压住准星与线本身
const COMPONENT_LABEL_PX = 12;   // 分量标签沿"屏幕空间垂直方向"让开的距离
const POINT_BADGE_OFFSET_PX = 15; // 测点名字徽章悬在点下方（距离标签在中线上方，互不打架）

// 测点名字徽章（圆形）的尺寸口径 —— JS 量文本与 CSS 渲染必须同一套字体
const BADGE_FONT = '600 10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const BADGE_MIN_PX = 22;         // 最小直径（"P1" 也至少是个像样的圆）
const BADGE_PAD_PX = 10;         // 文本宽度之外的内边距（左右合计）
const BADGE_CIRCLE_MAX_CHARS = 5; // 名字超过这个字符数退回胶囊（长路径名撑不成圆）

const COLOR_LINE = 0x1c5fa8;     // 已固定测量（与 UI 主色一致）
const COLOR_PREVIEW = 0x0f8f8f;  // 预览线（未固定），与已固定的蓝明确区分

const AXES_PDMS = 'PDMS_WORLD_Z_UP';
const AXES_GLB = 'GLB_Y_UP';

/** XYZ 分量辅助线的轴向颜色：沿用工程软件的 X 红 / Y 绿 / Z 蓝约定 */
const AXIS_COLORS = Object.freeze({
  X: new THREE.Color(0xc0392b),
  Y: new THREE.Color(0x1f8a4c),
  Z: new THREE.Color(0x1f6fd0),
});

/** 模型坐标系的**世界空间单位轴** —— 辅助线只能按它画，绝不按屏幕方向。
 *  PDMS 世界坐标（Z 向上）→ GLB：X→+x，Y→−z，Z→+y（见文件头部的换算）。
 *  取不到 origin 时退回 GLB 自身轴向，与 `_compute()` 的口径一致。 */
const AXIS_VECTORS = Object.freeze({
  [AXES_PDMS]: Object.freeze({
    X: ENGINEERING_AXES.E,
    Y: ENGINEERING_AXES.N,
    Z: ENGINEERING_AXES.U,
  }),
  [AXES_GLB]: Object.freeze({
    X: GLB_AXES.X,
    Y: GLB_AXES.Y,
    Z: GLB_AXES.Z,
  }),
});

/** 复制到 Excel 的表头：只有表头带单位，数值列保持纯数字，Excel 才会识别成数值 */
const CLIPBOARD_HEADER = 'From\tTo\tDirect(mm)\tX(mm)\tY(mm)\tZ(mm)\tHorizontal(mm)';

/** 取点方式：决定准星字形与"记录哪个点" */
export const MeasureKind = Object.freeze({ Surface: 'surface', Center: 'center' });

/** 准星字形（要求第 6 条）：未命中 + / Surface ⊕ / Center ◎ / 已记录点 ● */
export const MeasureGlyph = Object.freeze({
  miss: '+', surface: '⊕', center: '◎', recorded: '●',
});

const GLYPH_STATE = Object.freeze({
  miss: 'miss', surface: 'surface', center: 'center', recorded: 'recorded',
});

function noRaycast(object) {
  object.raycast = () => {};
  object.userData.nonSelectable = true;
  return object;
}

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

// 真实键盘事件有 code；自动化/宿主转发事件有时只给 key。补齐常用物理键名，
// 保持 Measurement 与可配置 keyBindings 在两种事件来源下语义一致。
function eventCode(event) {
  if (event.code) return event.code;
  if (/^[a-z]$/i.test(event.key || '')) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key || '')) return `Digit${event.key}`;
  return ({ ' ': 'Space', Escape: 'Escape', Delete: 'Delete', Backspace: 'Backspace' })[event.key] || '';
}

/** mm 取整（复制到 Excel 用整数，和工程读图习惯一致）；顺手把 -0 归一成 0 */
function roundMm(value) {
  const r = Math.round(Number(value));
  if (!Number.isFinite(r)) return 0;
  return r === 0 ? 0 : r;
}

/** TSV 单元格：名称里若有 TAB/换行会破坏"TAB 分列"，压成空格 */
function cell(value) {
  return String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ').trim();
}

/** 圆点贴图：白色实心 + 深色描边（材质 color 会乘上去，描边保持深色，浅背景上也看得清） */
function markerTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** 测量视觉容器。生命周期与模型无关（跨版本复用），只换内容。
 *
 *  四个子对象容量固定、按 drawRange 复用（合起来只占 4 个 draw call）：
 *    markers    —— 已记录点（A/B），屏幕恒定尺寸的点精灵（远处也看得见）
 *    committed  —— 已固定的测量线（所有线段合成一个 LineSegments）
 *    components —— XYZ 分量辅助线（阶梯状 3 段，顶点色区分轴向，合成一个 LineSegments）
 *    preview    —— A → 当前准星 的预览线（只有一条）
 */
export class MeasurementGroup extends THREE.Group {
  constructor() {
    super();
    this.name = 'MeasurementGroup';
    this.userData.nonSelectable = true;

    this.markerTexture = markerTexture();
    this.markerMaterial = new THREE.PointsMaterial({
      map: this.markerTexture, color: COLOR_LINE,
      // sizeAttenuation=false 时 gl_PointSize 直接是设备像素，所以要乘 DPR 才是稳定的 CSS 尺寸
      size: 9 * Math.min(window.devicePixelRatio || 1, 2),
      sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false,
      alphaTest: 0.05,
    });
    const markerGeometry = new THREE.BufferGeometry();
    markerGeometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
    markerGeometry.setDrawRange(0, 0);
    this.markers = new THREE.Points(markerGeometry, this.markerMaterial);
    this.markers.name = 'MeasurementMarkers';
    this.markers.frustumCulled = false;
    this.markers.renderOrder = RENDER_ORDER + 1;

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: COLOR_LINE, transparent: true, opacity: 1,
      depthTest: false, depthWrite: false,
    });
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 2 * 3), 3));
    lineGeometry.setDrawRange(0, 0);
    this.committed = new THREE.LineSegments(lineGeometry, this.lineMaterial);
    this.committed.name = 'MeasurementLines';
    this.committed.frustumCulled = false;
    this.committed.renderOrder = RENDER_ORDER;

    // XYZ 分量：顶点色区分轴向，一个 LineSegments 装下所有测量的所有腿
    this.componentMaterial = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1,
      depthTest: false, depthWrite: false,
    });
    const componentGeometry = new THREE.BufferGeometry();
    componentGeometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(MAX_COMPONENTS * 2 * 3), 3));
    componentGeometry.setAttribute('color',
      new THREE.BufferAttribute(new Float32Array(MAX_COMPONENTS * 2 * 3), 3));
    componentGeometry.setDrawRange(0, 0);
    this.components = new THREE.LineSegments(componentGeometry, this.componentMaterial);
    this.components.name = 'MeasurementComponents';
    this.components.frustumCulled = false;
    this.components.renderOrder = RENDER_ORDER - 1;   // 压在直线之下：直线才是主结果
    this.components.visible = false;

    this.previewMaterial = new THREE.LineBasicMaterial({
      color: COLOR_PREVIEW, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false,
    });
    const previewGeometry = new THREE.BufferGeometry();
    previewGeometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(6), 3));
    this.preview = new THREE.Line(previewGeometry, this.previewMaterial);
    this.preview.name = 'MeasurementPreview';
    this.preview.frustumCulled = false;
    this.preview.renderOrder = RENDER_ORDER;
    this.preview.visible = false;

    this.add(this.markers, this.components, this.committed, this.preview);
    this.traverse(noRaycast);
  }

  /** 供宿主登记到"轮廓线 pass 需要临时摘掉的线对象"清单（线没有 NORMAL，会造出假边缘） */
  get lineObjects() { return [this.committed, this.preview, this.components]; }

  setMarkers(points) {
    const array = this.markers.geometry.attributes.position.array;
    const n = Math.min(points.length, MAX_POINTS);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      array[i * 3] = p.x; array[i * 3 + 1] = p.y; array[i * 3 + 2] = p.z;
    }
    this.markers.geometry.attributes.position.needsUpdate = true;
    this.markers.geometry.setDrawRange(0, n);
    this.markers.visible = n > 0;
    return n;
  }

  setCommitted(segments) {
    const array = this.committed.geometry.attributes.position.array;
    const n = Math.min(segments.length, MAX_SEGMENTS);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const { a, b } = segments[i];
      array[k++] = a.x; array[k++] = a.y; array[k++] = a.z;
      array[k++] = b.x; array[k++] = b.y; array[k++] = b.z;
    }
    this.committed.geometry.attributes.position.needsUpdate = true;
    this.committed.geometry.setDrawRange(0, n * 2);
    this.committed.visible = n > 0;
    return n;
  }

  setPreview(a, b) {
    const array = this.preview.geometry.attributes.position.array;
    array[0] = a.x; array[1] = a.y; array[2] = a.z;
    array[3] = b.x; array[4] = b.y; array[5] = b.z;
    this.preview.geometry.attributes.position.needsUpdate = true;
    this.preview.visible = true;
  }

  hidePreview() { this.preview.visible = false; }

  /** legs: [{ a, b, color }] —— 每条腿是世界空间里的轴对齐线段（方向由上游按模型轴向给出） */
  setComponents(legs) {
    const position = this.components.geometry.attributes.position.array;
    const color = this.components.geometry.attributes.color.array;
    const n = Math.min(legs.length, MAX_COMPONENTS);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const { a, b, color: c } = legs[i];
      position[k] = a.x; position[k + 1] = a.y; position[k + 2] = a.z;
      color[k] = c.r; color[k + 1] = c.g; color[k + 2] = c.b;
      k += 3;
      position[k] = b.x; position[k + 1] = b.y; position[k + 2] = b.z;
      color[k] = c.r; color[k + 1] = c.g; color[k + 2] = c.b;
      k += 3;
    }
    this.components.geometry.attributes.position.needsUpdate = true;
    this.components.geometry.attributes.color.needsUpdate = true;
    this.components.geometry.setDrawRange(0, n * 2);
    this.components.visible = n > 0;
    return n;
  }

  stats() {
    return {
      markers: this.markers.geometry.drawRange.count,
      segments: this.committed.geometry.drawRange.count / 2,
      components: this.components.geometry.drawRange.count / 2,
      preview: this.preview.visible,
      capacity: { points: MAX_POINTS, segments: MAX_SEGMENTS, components: MAX_COMPONENTS },
    };
  }

  dispose() {
    for (const object of [this.markers, this.committed, this.components, this.preview]) {
      object.geometry.dispose();
      object.material.dispose();
    }
    this.markerTexture.dispose();
    this.clear();
  }
}

export class MeasurementController {
  /**
   * @param {object} model Model3D 宿主（只读使用：camera / canvas / _hitAtNdc / nodeByCanonical）
   * @param {object} [options]
   * @param {HTMLElement|null} [options.labelRoot] 3D 标签的 DOM 容器（#measureLabels）
   * @param {HTMLElement|null} [options.reticle]   屏幕中心准星（#measureReticle）
   * @param {Function} [options.onChange]
   * @param {Function|null} [options.resolveName] canonicalId → 元数据名称/位号（取不到返回 null）
   */
  constructor(model, { labelRoot = null, reticle = null, onChange = null, resolveName = null } = {}) {
    this.model = model;
    this.labelRoot = labelRoot;
    this.reticle = reticle;
    this.onChange = onChange;
    this.resolveName = resolveName;   // 只用于"对象中心点命名"，复用既有的 canonicalId→metadata 映射

    this.enabled = false;
    this.continuous = false;     // 连续测量模式（V 键切换）：每点自动接续上一条
    this.showComponents = true;  // XYZ 分量辅助线默认开（面板里可关）
    this.kind = MeasureKind.Surface;
    this.measurements = [];      // 已固定：[{ id, a, b, result, record, legs }]
    this.pending = null;         // 第一点 A（未完成）
    this.pendingResult = null;   // A → 当前准星 的实时结果（预览用）
    this.aim = null;             // 当前准星命中：{ canonicalId, point, bboxCenter, distance }
    this.revision = 0;           // 只在"测量集合"变化时自增（列表 DOM 据此重建）
    this._pointSeq = 0;          // P1/P2… 自动编号（只有"没有名称"的点才吃号）

    this._bboxCache = new Map(); // canonical → Vector3 | null（几何是静态的，缓存永远有效）
    this._aimComputed = false;   // 本帧的准星命中是否已算过（取点只认已展示的那一次）
    this._polledAt = 0;
    this._camSig = null;
    this._dirty = true;
    this._flashUntil = 0;
    this._labelEls = new Map();  // measurement.id → HTMLElement（直线距离）
    this._compLabels = new Map(); // `${id}:X|Y|Z` → HTMLElement（XYZ 分量）
    this._pointLabels = new Map(); // 测点对象 → HTMLElement（圆形名字徽章；key 用点对象最好修剪）
    this._measureCtx = document.createElement('canvas').getContext('2d');  // 量徽章文本宽
    this._previewLabel = null;
    this._reticleText = null;
    this._reticleState = null;
    this._labelPos = new Map();  // label 元素 → 上次写入的像素位置
    this._v = new THREE.Vector3();        // 待投影的世界坐标
    this._proj = new THREE.Vector3();     // 投影中间量
    this._forward = new THREE.Vector3();  // 相机朝向

    this.group = new MeasurementGroup();
    this.group.visible = false;
    this.model.scene.add(this.group);

    this._boundKeyDown = (e) => this._onKeyDown(e);
    window.addEventListener('keydown', this._boundKeyDown);
  }

  // ------------------------------------------------------------ 开关
  get aimCanonicalId() { return this.aim ? this.aim.canonicalId : null; }

  setEnabled(on) {
    const next = !!on;
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    this.group.visible = next;
    this._dirty = true;
    this._aimComputed = false;    // 重新开启后第一下点击要现场补一次射线，别用旧命中
    this._polledAt = 0;
    this._camSig = null;
    if (!next) {
      this.aim = null;
      this.pendingResult = null;
      this.group.hidePreview();
      this._hideLabels();
    }
    this._refreshReticle(performance.now(), true);
    this._emit();
    return this.enabled;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  /** XYZ 分量辅助线显示开关（只影响已完成测量的辅助线，直线距离/预览不受影响）。
   *  打开时会把**已有测量**的辅助线一并画出来 —— 辅助线由测量数据现算，不另存状态。 */
  setComponents(on) {
    const next = !!on;
    if (next === this.showComponents) return this.showComponents;
    this.showComponents = next;
    this._rebuildVisuals();
    this._emit();
    return this.showComponents;
  }

  /** 换模型时调用：坐标全部属于上一个模型，测量结果必须作废（开关状态保留） */
  reset() {
    this.measurements.length = 0;
    this.pending = null;
    this.aim = null;
    this.pendingResult = null;
    this._bboxCache.clear();
    this._pointSeq = 0;
    this._dirty = true;
    this._aimComputed = false;
    this._camSig = null;
    this.group.setMarkers([]);
    this.group.setCommitted([]);
    this.group.setComponents([]);
    this.group.hidePreview();
    this._pruneLabels();
    this.revision++;
    this._emit();
  }

  // ------------------------------------------------------------ 每帧
  /** 每帧重算准星命中。
   *
   *  ⚠️ **不要**给它加节流。第一版曾按 33 ms 节流（那时只当它是"高亮"），但测量把同一个值
   *  同时用在了三处：准星字形、预览线端点、**取点结果**。节流窗口内相机可能已经转过好几度，
   *  于是"预览线端点 / 记录点"会落在用户还没看到的新位姿上 —— 表现就是
   *  「测量点莫名其妙跳跃」+「准星和测量圈没对准」。
   *  实测中心射线只有 0.04 ms（105 批）/ 0.23 ms（317 批），每帧一发完全付得起；
   *  相机静止时仍按签名整帧跳过，所以静态下零开销。 */
  update(now) {
    if (!this.enabled) return;
    if (!this.model.ready || !this.model.root) {
      this._setAim(null);
      this._hideLabels();
      this._refreshReticle(now);
      return;
    }
    const sig = this.model._cameraSignature();
    if (this._dirty || sig !== this._camSig) {
      this._polledAt = now;
      this._camSig = sig;
      this._dirty = false;
      this._setAim(this.model._hitAtNdc(0, 0));
    }
    this._layoutLabels();
    this._refreshReticle(now);
  }

  /** 每帧布局跟着相机走，所以标签位置不参与节流 */
  _setAim(hit) {
    this._aimComputed = true;      // 不管命中与否，"本帧的准星状态"已经确定
    if (!hit) {
      if (!this.aim) return;
      this.aim = null;
      this.pendingResult = null;
      this.group.hidePreview();
      this._emit();
      return;
    }
    const same = this.aim
      && this.aim.canonicalId === hit.canonicalId
      && this.aim.point.equals(hit.point);
    if (same) return;
    this.aim = {
      canonicalId: hit.canonicalId,
      point: hit.point.clone(),
      bboxCenter: this._bboxCenter(hit.canonicalId),
      distance: hit.distance,
    };
    this._syncPreview();
    this._emit();
  }

  _syncPreview() {
    if (!this.pending || !this.aim) {
      this.pendingResult = null;
      this.group.hidePreview();
      return;
    }
    const result = this._compute(this.pending.point, this.aim.point);
    if (!(result.distanceWorldM > PREVIEW_MIN_M)) {
      // 准星还停在 A 上：预览退化成零长度线 + "0.0 mm" 标签，只会挡住准星，直接不出
      this.pendingResult = null;
      this.group.hidePreview();
      return;
    }
    this.pendingResult = result;
    this.group.setPreview(this.pending.point, this.aim.point);
  }

  /** 重新落地点/线几何（pending 或测量集合变化时调用） */
  _rebuildVisuals() {
    const markers = [];
    const seenPoints = new Set();          // 连续模式下 pending === 上一条的 b，同一个点只画一个标记
    const pushMarker = (p) => {
      if (seenPoints.has(p)) return;
      seenPoints.add(p);
      markers.push(p);
    };
    if (this.pending) pushMarker(this.pending.point);
    const segments = [];
    const legs = [];
    for (const m of this.measurements) {
      pushMarker(m.a.point);
      pushMarker(m.b.point);
      segments.push({ a: m.a.point, b: m.b.point });
      // XYZ 分量只对**已完成**的测量画：预览阶段准星一直在动，阶梯线跟着抖反而看不清
      m.legs = this.showComponents ? this._componentLegs(m) : [];
      for (const leg of m.legs) legs.push(leg);
    }
    this.group.setMarkers(markers);
    this.group.setCommitted(segments);
    this.group.setComponents(legs);
    this._syncPreview();
    this._pruneLabels();
  }

  /** XYZ 分量辅助线：从 A 出发，按**模型坐标系**的轴向依次走 ΔX → ΔY → ΔZ（阶梯）。
   *
   *  腿的方向取自 `AXIS_VECTORS`（世界空间单位轴），长度取 |Δmm|/1000 —— 与相机完全无关，
   *  所以无论怎么转视角，X/Y/Z 始终是模型坐标系的定义方向，不会变成"屏幕方向"。
   *  |Δ| < 0.1 mm 的方向不画（那只是浮点噪声，画出来是个点）。 */
  _componentLegs(measurement) {
    const result = measurement.result;
    const axes = AXIS_VECTORS[result.axes] || AXIS_VECTORS[AXES_GLB];
    const legs = [];
    let cursor = measurement.a.point.clone();
    const deltas = [['X', result.dxMm], ['Y', result.dyMm], ['Z', result.dzMm]];
    for (const [axis, mm] of deltas) {
      if (!(Math.abs(mm) >= COMPONENT_MIN_MM)) continue;
      const end = cursor.clone().addScaledVector(axes[axis], mm / MM_PER_UNIT);
      legs.push({ axis, mm, a: cursor.clone(), b: end, color: AXIS_COLORS[axis] });
      cursor = end;
    }
    return legs;
  }

  // ------------------------------------------------------------ 取点
  /** 取点用的命中信息 = **本帧已经展示给用户的那一次命中**（准星字形、预览线端点、记录点
   *  三者同源），这样"看到的"和"记下的"永远一致，不会出现点莫名其妙跳到别处。
   *
   *  ⚠️ 第一版这里是"取点时现场重发一次射线"，看似更"准"，实际是错的：现场射线用的是
   *  用户**还没看到**的新位姿（鼠标早已动过、画面还没刷），于是记录点与准星错位。
   *  只有"从未算过命中"（刚开启测量、或场景/模型刚变）才现场补一次，保证第一下点击不落空。 */
  _currentAim() {
    if (!this._aimComputed) {
      this._setAim(this.model.ready && this.model.root ? this.model._hitAtNdc(0, 0) : null);
    }
    return this.aim;
  }

  /** 左键：记录准星命中的 **表面点** */
  recordSurface() {
    if (!this.enabled) return null;
    this.kind = MeasureKind.Surface;
    const aim = this._currentAim();
    if (!aim) { this._emit(); return null; }
    return this._record({
      kind: MeasureKind.Surface,
      canonicalId: aim.canonicalId,
      point: aim.point.clone(),
      hitPoint: aim.point.clone(),
      bboxCenter: aim.bboxCenter,
    });
  }

  /** C 键：记录当前命中对象的 **包围盒中心**（对象中心点） */
  recordCenter() {
    if (!this.enabled) return null;
    this.kind = MeasureKind.Center;
    const aim = this._currentAim();
    if (!aim || !aim.bboxCenter) { this._emit(); return null; }
    return this._record({
      kind: MeasureKind.Center,
      canonicalId: aim.canonicalId,
      point: aim.bboxCenter.clone(),
      hitPoint: aim.point.clone(),          // 命中点仍如实保留（与中心点区分）
      bboxCenter: aim.bboxCenter,
    });
  }

  /** 测点显示名（要求二）：
   *  · 对象中心点且 canonicalId 能映射到元数据名称/位号 → 直接用该名称（V1011A / P1012 …）
   *  · 其余情况（表面点、或中心点没有有效名称）→ 自动编号 P1、P2、P3…
   *  只有"拿不到名称"的点才吃号，所以一张图里 P 编号连续且不跳号。
   *  名称来自宿主注入的 `resolveName`，复用既有的 canonicalId→metadata 映射，不重新解析模型。
   *  @returns {{ name: string, seq: number|null }} seq = 吃掉的编号（没吃号为 null），
   *           取消这个点时要把号退回去，否则编号会出现空洞。 */
  _displayNameFor(kind, canonicalId) {
    if (kind === MeasureKind.Center && canonicalId && this.resolveName) {
      let name = null;
      try { name = this.resolveName(canonicalId); } catch { name = null; }
      name = name == null ? '' : String(name).trim();
      if (name) return { name, seq: null };
    }
    this._pointSeq += 1;
    return { name: `P${this._pointSeq}`, seq: this._pointSeq };
  }

  /** 结构化测量记录（要求三）：完成两点测量时即时落库，字段名与"复制到 Excel"的表头一致。
   *  距离类取正值、XYZ 保留方向正负号（整数 mm）；同时保留 P1/P2 的**原始世界坐标**（米），
   *  后续要做角度/面积/标注时不必重算。 */
  _structuredRecord(a, b, result) {
    return {
      from: a.displayName,
      to: b.displayName,
      direct: roundMm(result.distanceMm),
      dx: roundMm(result.dxMm),
      dy: roundMm(result.dyMm),
      dz: roundMm(result.dzMm),
      horizontal: roundMm(result.horizontalMm),
      aWorld: a.point.toArray(),
      bWorld: b.point.toArray(),
      axes: result.axes,
    };
  }

  /** 复制到 Excel 的文本：TAB 分列、换行分记录，数值列不带单位（表头注明 mm），
   *  这样 Ctrl+V 进 Excel 会被识别成数值而不是文本。 */
  clipboardText() {
    const rows = [CLIPBOARD_HEADER];
    for (const m of this.measurements) {
      const r = m.record;
      if (!r) continue;
      rows.push([cell(r.from), cell(r.to), r.direct, r.dx, r.dy, r.dz, r.horizontal].join('\t'));
    }
    return rows.join('\n');
  }

  hasClipboardRows() { return this.measurements.length > 0; }

  _record(point) {
    const named = this._displayNameFor(point.kind, point.canonicalId);
    point.displayName = named.name;
    point.ownSeq = named.seq;      // 吃掉的 P 编号（未吃号为 null）；取消该点时要退回
    if (!this.pending) {
      this.pending = point;
      this._flashUntil = performance.now() + RECORD_FLASH_MS;
      this._rebuildVisuals();
      this._emit();
      return this.pending;
    }
    const result = this._compute(this.pending.point, point.point);
    const measurement = {
      id: `M${this.measurements.length + 1}-${Date.now().toString(36)}`,
      a: this.pending,
      b: point,
      result,
      legs: [],
      record: this._structuredRecord(this.pending, point, result),   // 完成即时落库，供复制/后续功能直接用
    };
    // 连续测量模式：刚记下的这个点自动成为下一条的起点（P1→P2 完成后接着 P2→P3…）。
    // 注意 b 与新 pending 是**同一个点对象**，标记/徽章都按点对象去重，不会画两份。
    this.pending = this.continuous ? point : null;
    this.pendingResult = null;
    this.measurements.push(measurement);
    this._flashUntil = performance.now() + RECORD_FLASH_MS;
    this.revision++;
    this._rebuildVisuals();
    this._emit();
    return measurement;
  }

  /** 连续测量开关（V 键）。开启后每完成一条测量，其终点自动作为下一条的起点，
   *  一路 P1→P2→P3… 接连成串；右键 / Esc 取消当前未完成的点即可断开，从新点重新起链。
   *  只影响"完成一条之后 pending 归零还是接续"，对既有测量的数值与几何没有任何影响。 */
  setContinuous(on) {
    const next = !!on;
    if (next === this.continuous) return this.continuous;
    this.continuous = next;
    this._emit();                  // 面板的实时区要提示当前是否处于连续模式
    return this.continuous;
  }

  /** 取消当前未完成的测量（第一点作废，已固定的测量不动）。
   *  入口有三个：Esc、右键、以及面板/自动化的显式调用 —— 语义完全一致。 */
  cancelPending() {
    if (!this.pending) return false;
    // 取消 = 这个点当作从没取过：把它占用的 P 编号退回去，避免编号出现空洞
    // （A=P1 反悔 → 重新取 A 仍是 P1，导出记录里不会出现跳号）
    if (this.pending.ownSeq != null && this.pending.ownSeq === this._pointSeq) {
      this._pointSeq -= 1;
    }
    this.pending = null;
    this.pendingResult = null;
    this._rebuildVisuals();
    this._emit();
    return true;
  }

  /** Delete：删除上一条已固定的测量 */
  removeLast() {
    const removed = this.measurements.pop();
    if (!removed) return null;
    this.revision++;
    this._rebuildVisuals();
    this._emit();
    return removed;
  }

  /** 清除测量：全部删除（等价于开一组新的，P 编号从 P1 重新开始）。
   *  本来就没有测量时也要把编号计数归零 —— 否则"清除 → 再测"会接着上一组的号往下排。 */
  clearAll() {
    const had = this.measurements.length + (this.pending ? 1 : 0);
    if (!had) { this._pointSeq = 0; return 0; }
    this.measurements.length = 0;
    this.pending = null;
    this.pendingResult = null;
    this._pointSeq = 0;
    this.revision++;
    this._rebuildVisuals();
    this._emit();
    return had;
  }

  /** Ctrl+Z：撤销上一步。
   *
   *  · 有未完成的点 → 撤销这个点（编号退回，等同右键 / Esc）。
   *  · 否则撤掉最后一条**已完成的测量**：终点及其测量数据一并作废（终点占用的编号退回），
   *    起点恢复为"待取点"—— 可以直接重取终点，连续模式的链也从这里续。
   *  · 再按一次会继续往上撤（起点也被撤销）。
   *  没有可撤销的内容时返回 null，状态不变。
   *  刻意不做成"多级历史栈"：逐点回退本身就是完整的撤销链，一份栈反而要处理各种交叉。 */
  undoLast() {
    if (this.pending) {
      const p = this.pending;
      this.cancelPending();
      return { kind: 'pending', displayName: p.displayName };
    }
    const removed = this.measurements.pop();
    if (!removed) return null;
    // 终点被丢弃 → 它占用的编号退回；起点保留为待取点，编号不动
    if (removed.b.ownSeq != null) {
      this._pointSeq = Math.min(this._pointSeq, removed.b.ownSeq - 1);
    }
    this.pending = removed.a;
    this.pendingResult = null;
    this.revision++;
    this._rebuildVisuals();
    this._emit();
    return { kind: 'measurement', id: removed.id,
      from: removed.record ? removed.record.from : null,
      to: removed.record ? removed.record.to : null,
      restored: this.pending.displayName };
  }

  // ------------------------------------------------------------ 结果计算
  /** 包围盒中心 = 该 canonical 节点子树的**世界**包围盒中心。
   *  与 `Model3D.fit()` 用的是同一口径；批量渲染把原始 mesh 设成 visible=false 不影响
   *  Box3.setFromObject（它不看 visibility），所以批量模式下同样成立。 */
  _bboxCenter(canonicalId) {
    if (!canonicalId) return null;
    if (this._bboxCache.has(canonicalId)) return this._bboxCache.get(canonicalId);
    const node = this.model.nodeByCanonical.get(canonicalId);
    let center = null;
    if (node) {
      const box = new THREE.Box3().setFromObject(node);
      if (!box.isEmpty()) center = box.getCenter(new THREE.Vector3());
    }
    this._bboxCache.set(canonicalId, center);
    return center;
  }

  /** 两个世界空间点 → 测量结果。距离用世界空间（米），展示值映射到 PDMS 世界坐标（mm）。 */
  _compute(a, b) {
    const distanceWorldM = a.distanceTo(b);
    const origin = this.model.modelOrigin;
    let dx, dy, dz, axes;
    if (origin) {
      const ax = (a.x + origin[0]) * MM_PER_UNIT;
      const ay = (-a.z + origin[1]) * MM_PER_UNIT;
      const az = (a.y + origin[2]) * MM_PER_UNIT;
      const bx = (b.x + origin[0]) * MM_PER_UNIT;
      const by = (-b.z + origin[1]) * MM_PER_UNIT;
      const bz = (b.y + origin[2]) * MM_PER_UNIT;
      dx = bx - ax; dy = by - ay; dz = bz - az;
      axes = AXES_PDMS;
    } else {
      // 没有 origin（理论上不会发生）：如实退回 GLB 轴向，不假装是 PDMS 坐标
      dx = (b.x - a.x) * MM_PER_UNIT;
      dy = (b.y - a.y) * MM_PER_UNIT;
      dz = (b.z - a.z) * MM_PER_UNIT;
      axes = AXES_GLB;
    }
    const horizontalMm = axes === AXES_PDMS
      ? Math.hypot(dx, dy)          // Z 向上：水平面 = XY
      : Math.hypot(dx, dz);         // Y 向上：水平面 = XZ
    return {
      axes,
      distanceMm: distanceWorldM * MM_PER_UNIT,
      distanceWorldM,
      dxMm: dx, dyMm: dy, dzMm: dz,
      verticalMm: axes === AXES_PDMS ? dz : dy,
      horizontalMm,
    };
  }

  // ------------------------------------------------------------ 准星与标签
  /** 准星字形四态（要求第 6 条）。取点成功后的 260 ms 内显示 "●"。 */
  _refreshReticle(now, force = false) {
    if (!this.reticle) return;
    this.reticle.classList.toggle('on', this.enabled);
    if (!this.enabled) return;
    const glyph = now < this._flashUntil ? MeasureGlyph.recorded
      : !this.aim ? MeasureGlyph.miss
        : (this.kind === MeasureKind.Center ? MeasureGlyph.center : MeasureGlyph.surface);
    const state = glyph === MeasureGlyph.recorded ? GLYPH_STATE.recorded
      : glyph === MeasureGlyph.miss ? GLYPH_STATE.miss
        : (this.kind === MeasureKind.Center ? GLYPH_STATE.center : GLYPH_STATE.surface);
    if (!force && glyph === this._reticleText && state === this._reticleState) return;
    this._reticleText = glyph;
    this._reticleState = state;
    // 字形本身是 SVG 几何（四个 <g data-shape>，由 CSS 按 data-state 显示）。
    // 不用文本字符：文本的字形在行盒里受基线/字体度量影响，光学中心会偏 1 px 上下，
    // 与工程导航的 SVG 准星不同心 —— 用户看到的就是"准星和测量圈没对准"。
    this.reticle.dataset.state = state;
  }

  _hideLabels() {
    for (const el of this._labelEls.values()) el.style.display = 'none';
    for (const el of this._compLabels.values()) el.style.display = 'none';
    for (const el of this._pointLabels.values()) el.style.display = 'none';
    if (this._previewLabel) this._previewLabel.style.display = 'none';
  }

  _pruneLabels() {
    const alive = new Set(this.measurements.map((m) => m.id));
    for (const [id, el] of this._labelEls) {
      if (alive.has(id)) continue;
      el.remove();
      this._labelEls.delete(id);
      this._labelPos.delete(el);
    }
    // 分量标签的存活判据 = 当前还存在的腿（关掉 XYZ 开关后腿会消失，标签要一起走）
    const aliveLegs = new Set();
    for (const m of this.measurements) for (const leg of m.legs || []) aliveLegs.add(`${m.id}:${leg.axis}`);
    for (const [key, el] of this._compLabels) {
      if (aliveLegs.has(key)) continue;
      el.remove();
      this._compLabels.delete(key);
      this._labelPos.delete(el);
    }
    // 测点徽章的存活判据 = 当前还存在的点（连续模式的共享点天然只出现一次）
    const alivePoints = new Set();
    for (const m of this.measurements) { alivePoints.add(m.a); alivePoints.add(m.b); }
    if (this.pending) alivePoints.add(this.pending);
    for (const [p, el] of this._pointLabels) {
      if (alivePoints.has(p)) continue;
      el.remove();
      this._pointLabels.delete(p);
      this._labelPos.delete(el);
    }
    // 预览标签没有池化的必要（创建/销毁都只发生在取点前后，不在每帧路径上），
    // 预览结束后直接摘掉，免得 DOM 里留下隐形的孤儿节点
    if (this._previewLabel && !this.pendingResult) {
      this._previewLabel.remove();
      this._labelPos.delete(this._previewLabel);
      this._previewLabel = null;
    }
  }

  _label(map, key, className) {
    if (!this.labelRoot) return null;
    let el = map.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = className;
      this.labelRoot.appendChild(el);
      map.set(key, el);
    }
    return el;
  }

  _layoutLabels() {
    if (!this.labelRoot) return;
    const rect = this.model.canvas.getBoundingClientRect();
    const camera = this.model.camera;
    // 复用向量分工固定：_forward / _proj 是投影用的中间量，_v 只做"待投影的世界坐标"
    const forward = camera.getWorldDirection(this._forward);
    const cameraPos = camera.position;

    /** 世界坐标 → 画布像素；在相机背后返回 null */
    const project = (world) => {
      if (this._proj.copy(world).sub(cameraPos).dot(forward) <= 0) return null;
      const ndc = this._proj.copy(world).project(camera);
      return { x: (ndc.x + 1) / 2 * rect.width, y: (1 - ndc.y) / 2 * rect.height };
    };

    // 测点名字徽章（圆形）：按**点对象**去重 —— 连续模式下相邻两条测量共享同一个点，
    // 按测量角色铺会画出两份重叠的徽章；徽章的 Map key 直接用点对象，修剪时最稳。
    const seenPoints = new Set();
    const badge = (p) => {
      if (!p || seenPoints.has(p)) return;
      seenPoints.add(p);
      this._writeBadge(this._label(this._pointLabels, p, 'mlabel pt'),
        project(p.point), p.displayName || '', p.kind || MeasureKind.Surface,
        { x: 0, y: POINT_BADGE_OFFSET_PX });
    };

    /** 写入位置/文本；offset 是像素偏置（直线标签上抬、分量标签沿屏幕垂直方向让开） */
    const write = (el, screen, offset, text) => {
      if (!el) return;
      if (!screen) { el.style.display = 'none'; return; }
      const x = screen.x + offset.x;
      const y = screen.y + offset.y;
      if (el.textContent !== text) el.textContent = text;
      el.style.display = '';
      const last = this._labelPos.get(el);
      if (!last || Math.abs(last.x - x) > LABEL_EPSILON_PX || Math.abs(last.y - y) > LABEL_EPSILON_PX) {
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        this._labelPos.set(el, { x, y });
      }
    };

    for (const m of this.measurements) {
      // 直线距离标签：抬到线段中点上方
      write(this._label(this._labelEls, m.id, 'mlabel'),
        project(this._midpoint(m.a.point, m.b.point, this._v)),
        { x: 0, y: DIRECT_LABEL_LIFT_PX }, `${fmtMm(m.result.distanceMm)} mm`);

      // XYZ 分量标签：贴在各条腿中点，沿**屏幕空间垂直方向**让开 12 px，
      // 免得盖住腿本身；文案是"轴向 + 绝对值"（方向正负留在数据里，界面上不显示负号）
      for (const leg of m.legs || []) {
        const pa = project(leg.a);
        const pb = project(leg.b);
        let screen = null, offset = { x: 0, y: DIRECT_LABEL_LIFT_PX };
        if (pa && pb) {
          screen = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const len = Math.hypot(dx, dy) || 1;
          offset = { x: -dy / len * COMPONENT_LABEL_PX, y: dx / len * COMPONENT_LABEL_PX };
        }
      write(this._label(this._compLabels, `${m.id}:${leg.axis}`, `mlabel comp mx${leg.axis.toLowerCase()}`),
        screen, offset, `${leg.axis}  ${fmtMm(Math.abs(leg.mm))} mm`);
      }

      // 测点名字徽章（圆形，悬在点下方）：每个**去重后的点**一个 —— 连续模式下相邻两条
      // 测量共享同一个点，按测量角色铺会画出两份重叠的徽章，所以按点对象去重
      badge(m.a);
      badge(m.b);
    }
    if (this.pending && !seenPoints.has(this.pending)) badge(this.pending);
    if (this.pending && this.aim && this.pendingResult) {
      if (!this._previewLabel) {
        this._previewLabel = document.createElement('div');
        this._previewLabel.className = 'mlabel preview';
        this.labelRoot.appendChild(this._previewLabel);
      }
      write(this._previewLabel, project(this._midpoint(this.pending.point, this.aim.point, this._v)),
        { x: 0, y: DIRECT_LABEL_LIFT_PX }, `${fmtMm(this.pendingResult.distanceMm)} mm`);
    } else if (this._previewLabel) {
      this._previewLabel.style.display = 'none';
    }
  }

  _midpoint(a, b, out) { return out.copy(a).add(b).multiplyScalar(0.5); }

  // ------------------------------------------------------------ 测点名字徽章
  /** 测点名字徽章：圆形（名字太长时退化为胶囊，否则一个 30 字的路径名要撑成 200px 的"圆"）。
   *  与距离标签同一套投影/防抖逻辑，差别只在"尺寸由文本决定 + 形状是圆"。 */
  _writeBadge(el, screen, text, kind, offset) {
    if (!el) return;
    if (!screen || !text) { el.style.display = 'none'; return; }
    if (el.dataset.badgeText !== text) {
      el.dataset.badgeText = text;
      el.textContent = text;
      const d = this._badgeDiameter(text);
      if (d) {
        el.classList.remove('pill');
        el.style.width = el.style.height = `${d}px`;
        el.style.lineHeight = '';
        el.style.padding = '0';
      } else {
        el.classList.add('pill');
        el.style.width = '';
        el.style.height = '20px';
        el.style.lineHeight = '';
        el.style.padding = '0 8px';
      }
    }
    if (el.dataset.kind !== kind) el.dataset.kind = kind;
    el.style.display = '';
    const x = screen.x + offset.x;
    const y = screen.y + offset.y;
    const last = this._labelPos.get(el);
    if (!last || Math.abs(last.x - x) > LABEL_EPSILON_PX || Math.abs(last.y - y) > LABEL_EPSILON_PX) {
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      this._labelPos.set(el, { x, y });
    }
  }

  /** 圆形徽章直径：按文本实测宽度 + 内边距，最小 22px；名字超过 5 个字符退回胶囊。
   *  用 canvas 量文本（与 CSS 同字体同字重），避免"估宽度"在不同字体下失准。 */
  _badgeDiameter(text) {
    if (!text || text.length > BADGE_CIRCLE_MAX_CHARS) return null;
    if (!this._measureCtx) return BADGE_MIN_PX;
    this._measureCtx.font = BADGE_FONT;
    return Math.max(BADGE_MIN_PX, Math.ceil(this._measureCtx.measureText(text).width) + BADGE_PAD_PX);
  }

  // ------------------------------------------------------------ 键盘
  _onKeyDown(e) {
    if (!this.enabled) return;
    if (isEditableTarget(e.target)) return;
    const code = eventCode(e);
    // Ctrl+Z / ⌘Z：撤销上一步（必须在 C/V 分支之前 —— 那两个分支遇到修饰键会直接跳过）
      if ((e.ctrlKey || e.metaKey) && keyBindings.has('measurement.undo', code)) {
      e.preventDefault();                 // 别让浏览器对页面做默认的文本撤销
      this.undoLast();
      return;
    }
    if (keyBindings.has('measurement.center', code)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;      // 别抢复制快捷键
      e.preventDefault();
      this.recordCenter();
      return;
    }
    if (keyBindings.has('measurement.continuous', code)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;      // 别抢粘贴快捷键
      e.preventDefault();
      this.setContinuous(!this.continuous);
      return;
    }
      if (keyBindings.has('measurement.escape', code)) {
      // 刻意不 preventDefault / 不 stopPropagation：指针锁定时浏览器自己会吞掉 Esc，
      // 未锁定时导航层还要用它释放鼠标捕获。这里只做"取消未完成测量"这一件事。
      this.cancelPending();
      return;
    }
      if (keyBindings.has('measurement.removeLast', code)) {
      e.preventDefault();
      this.removeLast();
    }
  }

  _emit() { this.onChange?.(this.state()); }

  // ------------------------------------------------------------ 对外状态
  _pointState(p) {
    if (!p) return null;
    return {
      kind: p.kind,
      displayName: p.displayName || null,   // 测点显示名（P1/P2… 或元数据名称）
      canonicalId: p.canonicalId,
      point: p.point.toArray(),
      hitPoint: p.hitPoint ? p.hitPoint.toArray() : null,
      bboxCenter: p.bboxCenter ? p.bboxCenter.toArray() : null,
    };
  }

  state() {
    return {
      enabled: this.enabled,
      kind: this.kind,
      revision: this.revision,
      axes: this.model.modelOrigin ? AXES_PDMS : AXES_GLB,
      origin: this.model.modelOrigin ? [...this.model.modelOrigin] : null,
      aim: this.aim ? {
        canonicalId: this.aim.canonicalId,
        point: this.aim.point.toArray(),
        bboxCenter: this.aim.bboxCenter ? this.aim.bboxCenter.toArray() : null,
        distanceWorldM: this.aim.distance,
      } : null,
      pending: this._pointState(this.pending),
      pendingResult: this.pendingResult,
      pendingLabel: this._previewLabel ? this._previewLabel.textContent : null,
      aimComputed: this._aimComputed,
      showComponents: this.showComponents,
      continuous: this.continuous,
      components: (() => {
        const out = [];
        for (const m of this.measurements) {
          for (const leg of m.legs || []) {
            out.push({ id: m.id, axis: leg.axis, mm: leg.mm,
              a: leg.a.toArray(), b: leg.b.toArray() });
          }
        }
        return out;
      })(),
      clipboardText: this.clipboardText(),
      measurements: this.measurements.map((m) => ({
        id: m.id, a: this._pointState(m.a), b: this._pointState(m.b),
        result: m.result, record: m.record, legs: (m.legs || []).map((l) => l.axis),
      })),
      labels: [...this._labelEls.values()].filter((el) => el.style.display !== 'none').length,
      pointLabels: [...this._pointLabels.values()].filter((el) => el.style.display !== 'none')
        .map((el) => ({ text: el.textContent, kind: el.dataset.kind,
          circle: el.classList.contains('pill') === false,
          w: +el.getBoundingClientRect().width.toFixed(1),
          h: +el.getBoundingClientRect().height.toFixed(1) })),
      componentLabels: [...this._compLabels.values()].filter((el) => el.style.display !== 'none').length,
      componentLabelTexts: [...this._compLabels.values()]
        .filter((el) => el.style.display !== 'none').map((el) => el.textContent),
      reticle: this.reticle ? {
        visible: this.reticle.classList.contains('on'),
        glyph: this._reticleText,
        state: this._reticleState,
      } : null,
      group: { visible: this.group.visible, ...this.group.stats() },
      lineObjectsRegistered: this.model.lineObjects.includes(this.group.committed)
        && this.model.lineObjects.includes(this.group.components),
    };
  }

  dispose() {
    window.removeEventListener('keydown', this._boundKeyDown);
    this.model.scene.remove(this.group);
    this.group.dispose();
    for (const el of this._labelEls.values()) el.remove();
    this._labelEls.clear();
    for (const el of this._compLabels.values()) el.remove();
    this._compLabels.clear();
    for (const el of this._pointLabels.values()) el.remove();
    this._pointLabels.clear();
    this._previewLabel?.remove();
    this._previewLabel = null;
    this.reticle?.classList.remove('on');
  }
}

/** mm 展示：千分位 + 1 位小数（工程读数够用，也不至于糊成科学计数法） */
export function fmtMm(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
