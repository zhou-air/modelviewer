/** 分屏同步模型比对（Split Compare）的界面与同步控制层。
 *
 *  与「模型重叠比对」（compare.js + viewer3d.js 的 compare 一节）的区别：
 *    · 重叠比对 = **一个** Three.js 场景里叠两版，靠透明度看差异；
 *    · 分屏比对 = **两个** 独立 Viewer（各一套 renderer / scene / camera）并排显示，
 *      靠**相机位姿严格同步**看同一片空间在两版里的差别。
 *  两者互斥：进入分屏前会先退出重叠比对，反之亦然。
 *
 *  职责边界：
 *    · 本文件只管"选两个版本 / 建第二个视口 / 同步位姿 / 交换左右 / 退出还原"；
 *      相机读写、加载、导航、合批全部复用 Model3D 的既有实现，**没有再实现一套导航**。
 *    · 左视口 = 主 Viewer（app.js 里那个常驻 Model3D，加载 Model A）；
 *      右视口 = 本文件现场 new 出来的第二个 Model3D（加载 Model B），退出时销毁。
 *    · 第二视口不参与：模型树、属性面板、批注、测量、设备定位图。
 *      它只有"看"的职责，所以不会污染主 Viewer 的任何状态。
 *
 *  ---- 相机同步（本功能的核心，性能与稳定性都在这里）----
 *  1. **每帧变化检测，而不是事件广播**：两侧在各自渲染循环的 `onBeforeRender` 里调
 *     `_syncTick()`；谁相对"上一帧的位姿指纹"变了，谁就是源，把它写到另一侧。
 *     没变化的一帧只做几次数组/数字比较，不触发任何模型、材质或渲染器操作 ——
 *     这正是需求里"不要每次变化都重新加载模型或重建渲染器"的落点。
 *  2. **防循环**：写入方写完立刻重算两侧指纹，于是"被同步的那一侧"不会被误判成新的源；
 *     `_syncing` 再兜一层重入保护。两侧同一帧都变（极少见）时按 `lastInteract` 仲裁，
 *     以最近被真正操作的一侧为准。
 *  3. **防抖动**：`applyCameraPose` 会临时关掉 OrbitControls 的阻尼惯性、放宽轨道距离上下限，
 *     并在写完后重建 Game 导航的基准帧（`navigation.rebase()`）——缺任何一条都会出现
 *     "一侧松手后还在滑，另一侧被反复拉回"的拉锯。
 *  4. 同步的内容 = position / quaternion / up / target / fov / near / far。
 */

import { Model3D } from './viewer3d.js';
import { fillVersionSelects } from './compare.js';

const el = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const MIN_RATIO = 0.15;      // 分隔线拖动的左右极限（任一侧都不小于 15% 屏宽）
const MAX_RATIO = 0.85;

export class SplitCompareController {
  /** @param {object} model 主 Viewer（左视口）的 Model3D 实例
   *  @param {object} deps { getCurrent, listVersions, openMain, restoreMain, toast, getAppearance } */
  constructor(model, deps = {}) {
    this.model = model;
    this.deps = deps;
    this.active = false;
    this.syncEnabled = true;
    this.swapped = false;
    this.a = null;                  // { pid, mid, vid, label, glb, versionName, modelName }
    this.b = null;
    this.viewerB = null;            // 右视口的 Model3D；未分屏时恒为 null
    this._options = [];
    this._origMain = null;          // 进入分屏前主 Viewer 正在看的版本（退出时恢复）
    this._ratio = 0.5;
    this._activeSide = 'A';         // 键盘（F / F8）归属："最后被操作/选中"的那一侧
    this._sigA = null;              // 两侧上一帧的位姿指纹（变化检测用）
    this._sigB = null;
    this._modeTry = null;           // 上一次尝试过的导航模式组合（避免同步失败时来回拉锯）
    this._syncing = false;
    this._selA = null;
    this._selB = null;
    this._lastSelSide = null;
    this._els();
    this._bind();
  }

  _els() {
    this.modal = el('splitModal');
    this.selA = el('splitSelA');
    this.selB = el('splitSelB');
    this.msg = el('splitMsg');
    this.ctl = el('splitCtl');
    this.center = el('center');
    this.paneA = el('paneA');
    this.paneB = el('paneB');
    this.divider = el('splitDivider');
    this.tagA = el('splitTagA');
    this.tagB = el('splitTagB');
    this.labelA = el('splitTagLabelA');
    this.labelB = el('splitTagLabelB');
    this.selInfo = el('splitSel');
    this.syncBtn = el('splitSync');
    this.swapBtn = el('splitSwap');
  }

  _bind() {
    el('btnSplit').onclick = () => this.open();
    el('splitCancel').onclick = () => this.close();
    el('splitClose').onclick = () => this.close();
    el('splitStart').onclick = () => this.start();
    this.syncBtn.onclick = () => this.setSync(!this.syncEnabled);
    this.swapBtn.onclick = () => this.swap();
    el('splitFocus').onclick = () => this.focusSelected();
    el('splitExit').onclick = () => this.exit();
    this._bindDivider();
    // 活动侧判定：pointerdown 的**捕获阶段**先跑（早于两个 View 各自的 canvas 监听），
    // 所以"点击右侧即接管键盘"这件事发生在右视口请求 Pointer Lock 之前。
    for (const [side, pane] of [['A', this.paneA], ['B', this.paneB]]) {
      pane.addEventListener('pointerdown', () => {
        if (this.active) this._setActiveSide(side);
      }, true);
    }
  }

  _bindDivider() {
    const d = this.divider;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const rect = this.center.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      this._ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
      this._applyRatio();
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      d.classList.remove('dragging');
      document.body.style.cursor = '';
      try { d.releasePointerCapture(e.pointerId); } catch { /* 未捕获：忽略 */ }
      this.model.resize();
      this.viewerB?.resize();
    };
    d.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      dragging = true;
      d.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      try { d.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      e.preventDefault();
      e.stopPropagation();
    });
    d.addEventListener('pointermove', onMove);
    d.addEventListener('pointerup', onUp);
    d.addEventListener('pointercancel', onUp);
  }

  // ------------------------------------------------------------ 入口

  /** 打开版本选择弹窗（口径与重叠比对一致：只列同一项目下 ready 的版本）。 */
  open() {
    if (!this.deps.getCurrent?.()) {
      this.deps.toast?.('请先打开一个模型版本', 'err');
      return false;
    }
    if (this.model.compareActive()) this.deps.exitCompare?.();   // 两种比对互斥
    const versions = (this.deps.listVersions?.() || []).filter((v) => v.glb);
    this._options = versions;
    if (versions.length < 2) {
      this._setMsg('本项目下只有一个可用的 ready 版本，至少需要两个版本才能比对。'
        + '请先在「切换模型 → Import」里导入另一个版本。', true);
      this.modal.classList.add('on');
      fillVersionSelects(this.selA, this.selB, [], -1, -1);
      el('splitStart').disabled = true;
      return false;
    }
    const cur = this.deps.getCurrent();
    // 左视口固定拿更早的那一版（A = 旧），右视口拿当前版本（B = 新）——
    // 分屏时"左旧右新"是工程上的默认读图顺序。列表按版本名自然降序（最新在最前），
    // 所以当前版本的**后一个**才是更早的版本。
    let iB = versions.findIndex((v) => v.pid === cur.projectId && v.mid === cur.modelId
      && v.vid === cur.versionId);
    if (iB < 0) iB = 0;
    let iA = iB + 1 < versions.length ? iB + 1 : (iB - 1 >= 0 ? iB - 1 : -1);
    if (iA === iB) iA = -1;
    fillVersionSelects(this.selA, this.selB, versions, iA, iB);
    this._setMsg('');
    el('splitStart').disabled = false;
    this.modal.classList.add('on');
    return true;
  }

  close() { this.modal.classList.remove('on'); }

  _setMsg(text, isErr = false) {
    if (!text) {
      this.msg.classList.remove('err');
      this.msg.innerHTML = '左右各一个<b>独立 3D 视口</b>，共用同一空间坐标系：任意一侧导航'
        + '（Orbit / Game），另一侧实时跟随 —— 相机位置、朝向、目标点、FOV 全部同步。<br>'
        + '两侧的选中 / 隐藏 / 高亮互不影响；只列同一项目下状态为 ready 的版本。<br>'
        + '退出时销毁右侧视口，并恢复进入分屏前正在看的那一版。';
      return;
    }
    this.msg.classList.toggle('err', !!isErr);
    this.msg.innerHTML = text;
  }

  // ------------------------------------------------------------ 流程

  async start() {
    const A = this._options[Number(this.selA.value)];
    const B = this._options[Number(this.selB.value)];
    if (!A || !B) return null;
    if (A.mid === B.mid && A.vid === B.vid) {
      this._setMsg('Model A 与 Model B 不能是同一个版本。', true);
      return null;
    }
    el('splitStart').disabled = true;
    try {
      const cur = this.deps.getCurrent();
      this._origMain = cur
        ? { pid: cur.projectId, mid: cur.modelId, vid: cur.versionId, versionName: cur.versionName }
        : null;
      this.a = A;
      this.b = B;

      // ① 左视口（主 Viewer）载入 A —— 已经是 A 就不动，避免无谓重载
      const sameMain = cur && cur.projectId === A.pid && cur.modelId === A.mid
        && cur.versionId === A.vid;
      if (!sameMain) {
        this._setMsg(`正在把 <b>${esc(A.label)}</b> 载入左视口…`);
        await this.deps.openMain?.(A.pid, A.mid, A.vid);
        if (!this.model.ready) throw new Error('左视口模型（A）未能加载完成');
      }

      // ② 右视口：现场创建第二个 Model3D 并载入 B
      this._setMsg(`正在载入右视口 <b>${esc(B.label)}</b>… <span id="splitPct">0%</span>`);
      await this._createViewerB(B);

      // ③ 打开分屏布局（先建布局再对齐视角：pane 有了真实尺寸，resize 才有意义）
      this.active = true;
      this.swapped = false;
      this._ratio = 0.5;
      this.center.classList.add('splitMode');
      this.center.classList.remove('swapped');
      this._applyRatio();
      this.ctl.classList.add('on');
      el('btnSplit').classList.add('on');
      // 第二个 Viewer 构造时是"自己 attach 全局输入"的，这里必须重新裁决一次键盘归属，
      // 否则两侧的 F8 / F 键监听会同时生效。_activeSide 先置空以强制走一遍 _setActiveSide。
      this._activeSide = null;
      this._setActiveSide('A');
      this.model.resize();
      this.viewerB.resize();

      // ④ 以主 Viewer 当前视角为基准对齐两侧，然后开始逐帧同步
      this.syncEnabled = true;
      this._alignFrom(this.model);
      this.model.onBeforeRender = () => this._syncTick();
      this._applySideChrome();
      this.close();
      this.deps.toast?.(`分屏比对已开启：左 = ${A.versionName}，右 = ${B.versionName}（视角同步 ON）`, 'ok');
      return this.state();
    } catch (e) {
      this._setMsg(`分屏比对启动失败：${esc(e?.message || String(e))}`, true);
      await this.exit({ silent: true });
      return null;
    } finally {
      el('splitStart').disabled = false;
    }
  }

  /** 创建右视口的第二个 Model3D。
   *  ⚠️ canvas 必须**每次新建**：`dispose()` 会主动丢弃 WebGL 上下文，而同一张 canvas
   *     再 getContext 拿到的是已丢失的上下文，没法复活。 */
  async _createViewerB(B) {
    const pane = this.paneB;
    const canvas = document.createElement('canvas');
    canvas.id = 'cvB';
    pane.insertBefore(canvas, pane.firstChild);

    const v = new Model3D(canvas, {
      appearance: this.deps.getAppearance?.() || null,
      // 右视口不进模型树 / 属性面板：选中只用于"识别来源"，因此只回报给控制条。
      // 选中即视为"操作了右视口"→ 键盘归属跟着切过去。
      onSelect: (key) => {
        this._selB = key;
        if (key) { this._lastSelSide = 'B'; this._setActiveSide('B'); }
        this._syncSelectionInfo();
      },
      onNavigationState: (s) => el('crosshairB').classList.toggle('on', !!s.crosshair),
    });
    v.onBeforeRender = () => this._syncTick();
    this.viewerB = v;
    // 两个罗盘语义完全重复，只留左视口那一个
    if (v.orientationGizmo?.canvas) v.orientationGizmo.canvas.style.display = 'none';

    await v.load(B.glb, (evt) => {
      const p = el('splitPct');
      if (p && evt?.lengthComputable) p.textContent = `${Math.round(evt.loaded / evt.total * 100)}%`;
    });
    // 右视口默认不加载设备定位图：它是"只读底图"，两版各画一份反而干扰对比
    return v;
  }

  /** 退出分屏：销毁右视口与相关监听，还原主 Viewer 到进入分屏前的版本。 */
  async exit(opts = {}) {
    if (!this.active && !this.viewerB) return false;
    const was = this.active;
    this.active = false;
    this.syncEnabled = false;
    this._syncing = false;
    this._modeTry = null;
    this.model.onBeforeRender = null;
    this.model.inputSuppressed = false;
    // 活动侧可能是右视口 → 主 Viewer 的全局监听那时被摘掉了，退出时必须装回来
    this.model.navigation.inputSource.attachGlobal();
    this.center.classList.remove('splitMode', 'swapped');
    this.ctl.classList.remove('on');
    el('btnSplit').classList.remove('on');
    el('crosshairB').classList.remove('on');
    // 内联 flex 必须清掉：留着 paneA 就只占一半宽，单模型视图会残半个空屏
    this.paneA.style.flex = '';
    this.paneB.style.flex = '';
    this.divider.style.left = '';
    this._destroyViewerB();
    this._selA = this._selB = null;
    this._lastSelSide = null;
    this._sigA = this._sigB = null;
    this.a = null;
    this.b = null;
    this._applySideChrome();
    if (was && !opts.silent) this.deps.toast?.('已退出分屏比对，恢复单模型查看', 'ok');

    // keepRestore：调用方自己要去别的版本（如"切换模型"打开了第三版），
    // 这时再"恢复进入分屏前那一版"会把用户刚点的版本顶掉 → 由调用方跳过恢复。
    const restore = opts.keepRestore ? null : this._origMain;
    this._origMain = null;
    if (restore) {
      const cur = this.deps.getCurrent?.();
      const same = cur && cur.projectId === restore.pid && cur.modelId === restore.mid
        && cur.versionId === restore.vid;
      if (!same) this.deps.restoreMain?.(restore.pid, restore.mid, restore.vid);
    }
    this.model.resize();
    return was;
  }

  _destroyViewerB() {
    const v = this.viewerB;
    this.viewerB = null;
    if (!v) return;
    try { v.dispose(); } catch (e) { console.warn('[split] 释放右视口失败：', e); }
    try { v.canvas?.remove(); } catch { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 相机同步

  /** 每帧被两侧的 `onBeforeRender` 调用。开销上限就是几次数字比较（无变化时）。 */
  _syncTick() {
    if (!this.active || this._syncing) return;
    const A = this.model, B = this.viewerB;
    if (!A.ready || !B || !B.ready) return;

    // ① 导航模式：F8 / 工具条只会改"活动侧"，把结果镜像到另一侧。
    //    B 的全局输入被抑制 → 组合不一致时唯一可能的发起方就是 A，因此一律以 A 为准；
    //    用组合值做一次性尝试，避免某侧切不过去（未 ready / 建帧失败）时每帧来回拉锯。
    const mA = A.navigationMode, mB = B.navigationMode;
    if (mA !== mB) {
      const combo = `${mA}|${mB}`;
      if (combo !== this._modeTry) {
        this._modeTry = combo;
        B.setNavigationMode(mA);
      }
    } else if (this._modeTry) {
      this._modeTry = null;
    }

    // ② 相机位姿：谁变了听谁的
    const sigA = A.cameraPoseSignature();
    const sigB = B.cameraPoseSignature();
    const chA = sigA !== this._sigA;
    const chB = sigB !== this._sigB;
    this._sigA = sigA;
    this._sigB = sigB;
    if (!chA && !chB) return;
    if (!this.syncEnabled) return;

    let src, dst;
    if (chA && !chB) { src = A; dst = B; }
    else if (chB && !chA) { src = B; dst = A; }
    else {
      // 两侧同一帧都变了（例如一侧阻尼滑行、另一侧刚好被同步）：
      // 以"最近真正被操作过"的一侧为准，而不是按固定优先级，避免来回抢。
      src = (A.lastInteract || 0) >= (B.lastInteract || 0) ? A : B;
      dst = src === A ? B : A;
    }
    this._syncing = true;
    try {
      dst.applyCameraPose(src.cameraPose());
    } finally {
      this._syncing = false;
      // 重算指纹：被写入的一侧不算"新的源"，否则下一帧会反向回写形成循环
      this._sigA = A.cameraPoseSignature();
      this._sigB = B.cameraPoseSignature();
    }
  }

  /** 以某一侧的当前位姿为准，立即对齐另一侧（开启同步 / 重新开启同步时用）。 */
  _alignFrom(src) {
    const dst = src === this.model ? this.viewerB : this.model;
    if (!src?.ready || !dst?.ready) return false;
    dst.applyCameraPose(src.cameraPose());
    this._sigA = this.model.cameraPoseSignature();
    this._sigB = this.viewerB.cameraPoseSignature();
    return true;
  }

  setSync(on) {
    if (!this.active) return false;
    this.syncEnabled = !!on;
    // 重新打开时以"活动侧"当前视角为准对齐一次，避免把关闭期间的差异当成跳变
    if (this.syncEnabled) {
      this._alignFrom(this._activeSide === 'B' ? this.viewerB : this.model);
    }
    this._applySideChrome();
    this.deps.toast?.(this.syncEnabled ? '视角同步已开启' : '视角同步已关闭（两侧可各自独立查看）');
    return this.syncEnabled;
  }

  // ------------------------------------------------------------ 其它操作

  /** 交换左右：只调换两个视口的显示位置与标签，不重载模型（相机本就同步，交换对视角无影响）。 */
  swap() {
    if (!this.active) return false;
    this.swapped = !this.swapped;
    this.center.classList.toggle('swapped', this.swapped);
    this._applyRatio();
    this._applySideChrome();
    return this.swapped;
  }

  /** 同步定位：把两侧一起挪到当前选中对象（优先用活动侧的选中集），未选中则整体适配。 */
  focusSelected() {
    if (!this.active) return false;
    const act = this._activeSide === 'B' ? this.viewerB : this.model;
    let target = null;
    if (act?.ready && act.selectedCanonicals.length) {
      act.fit(act.selectedCanonicals);
      target = act.selectedCanonicals;
    } else {
      // 右视口没有元数据、也没有树，用户多半是在左视口选中的
      const fallback = act === this.model ? this.viewerB : this.model;
      if (fallback?.ready && fallback.selectedCanonicals.length) {
        fallback.fit(fallback.selectedCanonicals);
        target = fallback.selectedCanonicals;
      } else {
        this.model.fit(null);
      }
    }
    // 位姿变化由 `_syncTick` 自动带到另一侧，这里不重复写相机
    return target ? [...target] : true;
  }

  /** 主 Viewer 的选中回传（app.js 的 onSelect 调用）：用于识别"选中的元件属于哪一版"。 */
  setSelectionA(canonical) {
    if (!this.active) return;
    this._selA = canonical;
    if (canonical) this._setActiveSide('A');
    this._syncSelectionInfo();
  }

  _setActiveSide(side) {
    if (!this.active || this._activeSide === side) return;
    this._activeSide = side;
    const isA = side === 'A';
    // 全局快捷键（F 复位 / F8 导航模式）只归活动侧：挡掉另一侧，避免一次按键被两边各执行一遍。
    this.model.inputSuppressed = !isA;
    if (this.viewerB) this.viewerB.inputSuppressed = isA;
    // 键盘与鼠标增量也只归活动侧：非活动侧摘掉 **window/document 级** 监听
    //（canvas 自己的滚轮/点击/右键菜单保留 —— 滚在"另一侧"上要能立刻响应，
    // 否则那一侧就是死区；点它则通过上面的 capture 阶段指针监听完成接管）。
    // 先释放切换出去那一侧的 Pointer Lock，免得"锁在 A 上、键盘归 B"的错位状态。
    if (isA) {
      this.viewerB?.navigation.inputSource.releaseCapture();
      this.viewerB?.navigation.inputSource.detachGlobal();
      this.model.navigation.inputSource.attachGlobal();
    } else {
      this.model.navigation.inputSource.releaseCapture();
      this.model.navigation.inputSource.detachGlobal();
      this.viewerB?.navigation.inputSource.attachGlobal();
    }
    this._applySideChrome();
  }

  // ------------------------------------------------------------ 界面

  _applyRatio() {
    const leftPane = this.swapped ? this.paneB : this.paneA;
    const rightPane = leftPane === this.paneA ? this.paneB : this.paneA;
    leftPane.style.flex = `0 0 ${(this._ratio * 100).toFixed(3)}%`;
    rightPane.style.flex = '1 1 0';
    this.divider.style.left = `${(this._ratio * 100).toFixed(3)}%`;
  }

  _applySideChrome() {
    const a = this.a, b = this.b;
    this.labelA.textContent = `A · ${a ? a.versionName : '—'}`;
    this.labelB.textContent = `B · ${b ? b.versionName : '—'}`;
    this.tagA.innerHTML = `<b>A</b>${esc(a ? a.versionName : '—')}`;
    this.tagB.innerHTML = `<b>B</b>${esc(b ? b.versionName : '—')}`;
    this.tagA.classList.toggle('on', this.active && this._activeSide === 'A');
    this.tagB.classList.toggle('on', this.active && this._activeSide === 'B');
    this.syncBtn.textContent = this.syncEnabled ? '同步视角 ON' : '同步视角 OFF';
    this.syncBtn.classList.toggle('on', this.syncEnabled);
    this.swapBtn.textContent = this.swapped ? '交换左右（已交换）' : '交换左右';
    el('splitFocus').disabled = false;
    this._syncSelectionInfo();
  }

  _syncSelectionInfo() {
    if (!this.active) {
      this.selInfo.textContent = '点击任一侧的元件即可识别它属于哪个模型版本';
      return;
    }
    const side = this._lastSelSide;
    if (!side) {
      this.selInfo.textContent = '点击任一侧的元件即可识别它属于哪个模型版本';
      return;
    }
    const key = side === 'A' ? this._selA : this._selB;
    if (!key) {
      this.selInfo.textContent = '点击任一侧的元件即可识别它属于哪个模型版本';
      return;
    }
    const src = side === 'A' ? this.a : this.b;
    this.selInfo.innerHTML = '当前选中来源：'
      + `<span class="${side === 'A' ? 'side-a' : 'side-b'}">Model ${side}</span>`
      + `（${esc(src ? src.versionName : '—')}） · <b>${esc(key)}</b>`
      + `　${side === 'A' ? '左视口' : '右视口'}`;
  }

  /** 供界面 / 实测读取的状态投影。 */
  state() {
    const b = this.viewerB;
    return {
      active: this.active,
      modalOpen: this.modal.classList.contains('on'),
      syncEnabled: this.syncEnabled,
      syncText: this.syncBtn.textContent,
      swapped: this.swapped,
      swapText: this.swapBtn.textContent,
      ratio: +this._ratio.toFixed(4),
      activeSide: this._activeSide,
      splitModeClass: this.center.classList.contains('splitMode'),
      ctlVisible: this.ctl.classList.contains('on'),
      paneAWidth: this.paneA.clientWidth,
      paneBWidth: this.paneB.clientWidth,
      paneBVisible: this.paneB.offsetParent !== null,
      viewerBAlive: !!b,
      bReady: !!(b && b.ready),
      bNodes: b ? b.nodeByCanonical.size : 0,
      bFps: b?.fps ?? null,
      poseA: this.model.ready ? this.model.cameraPose() : null,
      poseB: b && b.ready ? b.cameraPose() : null,
      modeA: this.model.navigationMode,
      modeB: b ? b.navigationMode : null,
      a: this.a ? { pid: this.a.pid, mid: this.a.mid, vid: this.a.vid, versionName: this.a.versionName, modelName: this.a.modelName } : null,
      b: this.b ? { pid: this.b.pid, mid: this.b.mid, vid: this.b.vid, versionName: this.b.versionName, modelName: this.b.modelName } : null,
      tagA: this.tagA.textContent,
      tagB: this.tagB.textContent,
      selectionText: this.selInfo.textContent,
      selectionA: this._selA,
      selectionB: this._selB,
      inputSuppressed: { a: this.model.inputSuppressed, b: b ? b.inputSuppressed : null },
      options: this._options.map((v) => ({ label: v.label, mid: v.mid, vid: v.vid })),
    };
  }

  /** 两侧相机位姿的最大分量差（实测断言用）：0 表示逐位相同。 */
  poseDelta() {
    const b = this.viewerB;
    if (!this.active || !b?.ready || !this.model.ready) return null;
    const pa = this.model.cameraPose(), pb = b.cameraPose();
    const diff = (x, y) => Math.max(...x.map((v, i) => Math.abs(v - y[i])));
    return {
      position: diff(pa.position, pb.position),
      quaternion: diff(pa.quaternion, pb.quaternion),
      target: diff(pa.target, pb.target),
      fov: Math.abs(pa.fov - pb.fov),
      near: Math.abs(pa.near - pb.near),
      far: Math.abs(pa.far - pb.far),
    };
  }
}
