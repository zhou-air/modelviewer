/** 模型重叠比对（Overlay Compare）的界面控制层。
 *
 *  职责边界：
 *    · 本文件只管"选两个版本 / 显示模式 / 透明度 / 交换 / 退出"的界面与流程；
 *    · 3D 侧的叠加加载、材质、拾取、侧标记全部在 `viewer3d.js` 的 compare 一节里，
 *      本文件只调用 `model.loadOverlay / setCompareSide / setCompareOpacity / swapCompareSides / exitCompare`。
 *
 *  为什么不做重（第一版）：
 *    · 不做几何差异分析、节点匹配、新增/删除识别 —— 只把两版叠在同一坐标系里给人看。
 *    · A 侧只加载 GLB（不加载 A 的 metadata.json）：比对要的是"看形状差在哪"，
 *      元数据（属性/树/批注）仍严格属于当前打开的版本（B），避免两套元数据互相污染。
 *      A 侧因此不参与树的选中、不参与批注锚点、测量时也如实退回 P 编号。
 */
const el = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class CompareController {
  /** @param {object} model Model3D 实例
   *  @param {object} deps  { getCurrent, listVersions, openMain, toast, onChrome } */
  constructor(model, deps = {}) {
    this.model = model;
    this.deps = deps;
    this.active = false;
    this.a = null;                 // { pid, mid, vid, label, glb }
    this.b = null;
    this._options = [];            // 弹窗里的版本清单（与 <option value> 的序号一一对应）
    this._generation = 0;
    this._pending = null;
    this._els();
    this._bind();
  }

  _els() {
    this.modal = el('cmpModal');
    this.selA = el('cmpSelA');
    this.selB = el('cmpSelB');
    this.msg = el('cmpMsg');
    this.bar = el('compareBar');
    this.labelA = el('cmpLabelA');
    this.labelB = el('cmpLabelB');
    this.opacityInput = el('cmpOpacity');
    this.opacityLabel = el('cmpOpacityLabel');
    this.opacityVal = el('cmpOpacityVal');
    this.selInfo = el('cmpSel');
    // ⚠️ 不要用 el('cv').parentElement：分屏改造后 canvas 的父容器是 #paneA（左视口），
    //    而 compareMode 这个类必须落在 #center 上 —— CSS 写的是 `.compareMode #navPrompt`
    //    （navPrompt 是 #center 的直接子元素），落在 #paneA 上选择器就不匹配了。
    this.center = el('center');
  }

  _bind() {
    el('btnCompare').onclick = () => this.open();
    el('cmpCancel').onclick = () => this.close();
    el('cmpClose').onclick = () => this.close();
    el('cmpStart').onclick = () => this.start();
    el('cmpModeA').onclick = () => this.setSide('A');
    el('cmpModeB').onclick = () => this.setSide('B');
    el('cmpModeAB').onclick = () => this.setSide('both');
    el('cmpSwap').onclick = () => this.swap();
    el('cmpExit').onclick = () => this.exit();
    this.opacityInput.addEventListener('input', () => {
      this.model.setCompareOpacity(Number(this.opacityInput.value) / 100);
      this.syncChrome();
    });
  }

  // ------------------------------------------------------------ 入口

  /** 打开版本选择弹窗：只列**同一项目**下 ready 的版本，默认 A = 比当前版本更早的那一版。 */
  open() {
    if (!this.deps.getCurrent?.()) {
      this.deps.toast?.('请先打开一个模型版本', 'err');
      return false;
    }
    // 两种比对互斥：分屏比对占着第二个 WebGL 视口，叠着开会让"当前在看哪一版"彻底说不清
    this.deps.exitSplit?.();
    const versions = (this.deps.listVersions?.() || []).filter((v) => v.glb);
    this._options = versions;
    if (versions.length < 2) {
      this._setMsg('本项目下只有一个可用的 ready 版本，至少要两个版本才能比对。'
        + '请先在「切换模型 → Import」里导入另一个版本。', true);
      this.modal.classList.add('on');
      this._renderOptions([], -1, -1);
      el('cmpStart').disabled = true;
      return false;
    }
    const cur = this.deps.getCurrent();
    let iB = versions.findIndex((v) => v.pid === cur.projectId && v.mid === cur.modelId
      && v.vid === cur.versionId);
    if (iB < 0) iB = 0;
    // 列表按版本名自然降序（最新在最前）→ 当前版本的**后一个**就是更早的版本
    let iA = iB + 1 < versions.length ? iB + 1 : (iB - 1 >= 0 ? iB - 1 : -1);
    if (iA === iB) iA = -1;
    this._renderOptions(versions, iA, iB);
    this._setMsg('');
    el('cmpStart').disabled = false;
    this.modal.classList.add('on');
    return true;
  }

  cancelPending() {
    if (!this._pending) return;
    this._pending.abort();
    this._pending = null;
    ++this._generation;
    el('cmpStart').disabled = false;
  }

  close() { this.cancelPending(); this.modal.classList.remove('on'); }

  _renderOptions(versions, iA, iB) {
    fillVersionSelects(this.selA, this.selB, versions, iA, iB);
  }

  _setMsg(text, isErr = false) {
    this.msg.classList.toggle('err', !!isErr);
    this.msg.classList.toggle('mut', !isErr);
    if (text) this.msg.innerHTML = text;
    else {
      this.msg.classList.remove('err');
      this.msg.classList.add('mut');
      this.msg.innerHTML = '两个版本会同时载入<b>同一个 Three.js 场景、同一坐标系</b>：'
        + 'B 正常显示，A 半透明叠加。<br>只列同一项目下状态为 ready 的版本；'
        + 'B 默认取当前打开的版本，A 取它前面更早的那一版。<br>'
        + '第一版只做重叠显示，不自动做几何差异分析 / 节点匹配。';
    }
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
    this.exit({ silent: true });
    const controller = this._pending = new AbortController();
    const generation = ++this._generation;
    const current = () => generation === this._generation && !controller.signal.aborted;
    el('cmpStart').disabled = true;
    try {
      const cur = this.deps.getCurrent();
      const sameMain = cur && cur.projectId === B.pid && cur.modelId === B.mid
        && cur.versionId === B.vid;
      if (!sameMain) {
        this._setMsg(`正在把 <b>${esc(B.label)}</b> 设为主模型（B）…`);
        const loaded = await this.deps.openMain?.(B.pid, B.mid, B.vid);
        if (!current()) return null;
        if (loaded === false || !this.model.ready) throw new Error('主模型（B）未能加载完成');
      }
      this._setMsg(`正在加载 <b>${esc(A.label)}</b> 作为叠加层（A）… <span id="cmpPct">0%</span>`);
      await this.model.loadOverlay(A.glb, {
        signal: controller.signal,
        label: A.label,
        meta: { pid: A.pid, mid: A.mid, vid: A.vid, versionName: A.versionName, modelName: A.modelName },
        onProgress: (evt) => {
          const p = el('cmpPct');
          if (p && evt?.lengthComputable) p.textContent = `${Math.round(evt.loaded / evt.total * 100)}%`;
        },
      });
      if (!current()) return null;
      this.a = A;
      this.b = B;
      this.active = true;
      this._pending = null;
      this.close();
      this.model.setCompareSide('both');
      this.model.setCompareOpacity(Number(this.opacityInput.value) / 100);
      this.syncChrome();
      this.setSelection(null);
      const st = this.model.compareState();
      this.deps.toast?.(
        `比对已开启：A = ${A.versionName}（半透明 ${Math.round(st.opacity * 100)}%），B = ${B.versionName}`
        + (st.originAligned ? '' : '；⚠ 缺少 origin，按 GLB 坐标直接叠加（未做原点补偿）'),
        st.originAligned ? 'ok' : 'warn');
      return st;
    } catch (e) {
      if (!current() || e.name === 'AbortError') return null;
      this._setMsg(`比对启动失败：${esc(e?.message || String(e))}`, true);
      if (this.model.compareActive()) this.model.exitCompare();
      this.active = false;
      this.syncChrome();
      return null;
    } finally {
      if (current()) { this._pending = null; el('cmpStart').disabled = false; }
    }
  }

  /** 退出比对：卸载叠加层、还原实体侧材质与显示状态（原有批注/测量/隐藏/改色全部照旧）。 */
  exit(opts = {}) {
    this.cancelPending();
    const was = this.model.compareActive();
    if (was) this.model.exitCompare();
    // 界面状态无论如何都归零：换主模型时 3D 侧的 compare 已被 unload 拆掉，
    // 本层的 active/label 可能还停在旧值，这里一并清干净。
    this.active = false;
    this.a = null;
    this.b = null;
    this.setSelection(null);
    this.syncChrome();
    if (was && !opts.silent) this.deps.toast?.('已退出比对，恢复单模型查看', 'ok');
    return was;
  }

  setSide(side) {
    if (!this.model.compareActive()) return null;
    const r = this.model.setCompareSide(side);
    this.syncChrome();
    return r;
  }

  swap() {
    if (!this.model.compareActive()) return null;
    const p = this.model.swapCompareSides();
    this.syncChrome();
    return p;
  }

  // ------------------------------------------------------------ 界面同步

  syncChrome() {
    const active = this.model.compareActive();
    this.active = active;
    this.bar.classList.toggle('on', active);
    this.center?.classList.toggle('compareMode', active);
    el('btnCompare').classList.toggle('on', active);
    if (!active) {
      this.labelA.textContent = 'A · —';
      this.labelB.textContent = 'B · —';
      return;
    }
    const st = this.model.compareState();
    this.labelA.textContent = `A · ${this.a ? this.a.versionName : '—'}（${this.a ? this.a.modelName : ''}）`;
    this.labelB.textContent = `B · ${this.b ? this.b.versionName : '—'}（${this.b ? this.b.modelName : ''}）`;
    el('cmpModeA').classList.toggle('on', st.side === 'A');
    el('cmpModeB').classList.toggle('on', st.side === 'B');
    el('cmpModeAB').classList.toggle('on', st.side === 'both');
    // 交换后透明的是 B，滑杆标签跟着换，避免"标签说 A、改的是 B"
    this.opacityLabel.textContent = st.primary === 'A' ? 'B 透明度' : 'A 透明度';
    const pct = Math.round((st.primary === 'A' ? st.bOpacity : st.aOpacity) * 100);
    if (Number(this.opacityInput.value) !== pct) this.opacityInput.value = String(pct);
    this.opacityVal.textContent = `${pct}%`;
    el('cmpSwap').textContent = st.primary === 'A' ? '交换 A/B（当前 A 实体）' : '交换 A/B';
  }

  /** 选中来源回显：点到的元件属于哪一版。 */
  setSelection(key) {
    if (!this.selInfo) return;
    if (!this.active) { this.selInfo.textContent = '点击元件即可识别来源（A 半透明那侧 / B 实体那侧）'; return; }
    if (!key) { this.selInfo.textContent = '未选中元件 · 点击 3D 视图中的元件可识别它来自 A 还是 B'; return; }
    const side = this.model.sideOfKey(key);
    const raw = this.model.rawCanonical(key);
    const label = side === 'A' ? (this.a?.versionName || '—') : (this.b?.versionName || '—');
    this.selInfo.innerHTML = `当前选中来源：`
      + `<span class="${side === 'A' ? 'side-a' : 'side-b'}">Model ${side}（${esc(label)}）</span>`
      + ` · <b>${esc(raw)}</b>`
      + (side === 'A' ? ' · 该侧只载入几何，属性/树/批注仍属于 B' : '');
  }

  state() {
    return {
      active: this.model.compareActive(),
      modalOpen: this.modal.classList.contains('on'),
      barVisible: this.bar.classList.contains('on'),
      a: this.a ? { ...this.a } : null,
      b: this.b ? { ...this.b } : null,
      options: this._options.map((v) => ({ label: v.label, mid: v.mid, vid: v.vid })),
      opacityLabel: this.opacityLabel.textContent,
      opacitySlider: Number(this.opacityInput.value),
      selectionText: this.selInfo.textContent,
      ...this.model.compareState(),
    };
  }
}

/** 把"同项目 ready 版本"清单填进两个 <select>（A/B 默认项自动错开）。
 *  重叠比对（本文件）与分屏比对（splitCompare.js）共用这一份渲染，避免两处口径分叉。 */
export function fillVersionSelects(selA, selB, versions, iA, iB) {
  const groups = new Map();             // modelId → option 列表（同项目内可能有多模型）
  versions.forEach((v, i) => {
    const key = `${v.mid}`;
    if (!groups.has(key)) groups.set(key, { label: v.modelName, items: [] });
    groups.get(key).items.push({ i, label: v.versionName, ready: true });
  });
  const html = [...groups.values()].map((g) =>
    `<optgroup label="${esc(g.label)}">`
    + g.items.map((it) => `<option value="${it.i}">${esc(it.label)}</option>`).join('')
    + '</optgroup>').join('');
  selA.innerHTML = html;
  selB.innerHTML = html;
  if (iA >= 0) selA.value = String(iA);
  if (iB >= 0) selB.value = String(iB);
  // A/B 选中同一项时（同项目只有两个版本且默认值相同不可能，但手工改选可能）自动错开
  if (selA.value === selB.value && versions.length > 1) {
    selA.value = String([...Array(versions.length).keys()].find((i) => String(i) !== selB.value));
  }
}

/** 供装配层组装版本清单：把 AssetManager 的项目树拍平成"同项目 ready 版本"列表。 */
export function versionsOfProject(projects, pid) {
  const p = (projects || []).find((x) => x.id === pid);
  if (!p) return [];
  const out = [];
  for (const m of p.models || []) {
    for (const v of m.versions || []) {
      if (v.status !== 'ready' || !v.assets?.glb) continue;
      out.push({
        pid: p.id, mid: m.id, vid: v.id,
        glb: v.assets.glb, floorplan: v.assets.floorplan || null,
        projectName: p.name, modelName: m.name, versionName: v.name,
        label: `${p.name} / ${m.name} / ${v.name}`,
      });
    }
  }
  return out;
}
