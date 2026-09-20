/** 模型资产管理器（启动层）：Project Manager 侧栏 · Model Selector · Import Model。
 *
 * 与 3D 完全解耦：本文件不认识 three.js，只负责"让用户挑到一个 ready 版本"，
 * 然后交给 app.js 去打开。所有数据来自本地后端 (tools/server.py)，文件不出本机。
 */

import { api, uploadSource, ApiError } from './api.js';
import { access } from './access.js';

const LS_RECENT = 'pdmsviewer.recent.v1';
const LS_LAST = 'pdmsviewer.lastopened.v1';
const MAX_RECENT = 6;

const STAGE_LABEL = {
  queued: '排队', copying: '复制源文件', geometry: '转换 RVM → GLB',
  metadata: '解析 TXT → 元数据', mapping: '对象映射', validating: '独立校验',
  ready: '完成',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const fmtTime = (iso) => (iso ? iso.replace('T', ' ').replace(/\+.*/, '') : '—');

function readLS(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch { return fallback; }
}

const writeLS = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 隐私模式 */ }
};

export class AssetManager {
  constructor({ onOpen, onResume }) {
    this.onOpen = onOpen;
    this.onResume = onResume;
    this.data = { projects: [], totals: {} };
    this.expandedProjects = new Set();
    this.expandedModels = new Set();
    this.sel = { projectId: null, modelId: null, versionId: null };
    this.recent = readLS(LS_RECENT, []);
    this._cache = new Map();                 // versionKey → 后端健康检查用
    this._els();
    this._bind();
  }

  _els() {
    const el = (id) => document.getElementById(id);
    this.root = el('launcher');
    this.treeEl = el('pmTree');
    this.selectorEl = el('selectorCard');
    this.recentEl = el('recentCard');
    this.toastEl = el('toast');
    this.menuEl = el('ctxMenu');
    this.modalEl = el('modal');
    this.bannerEl = el('pmBanner');
  }

  _bind() {
    const on = (id, fn) => { const n = document.getElementById(id); if (n) n.onclick = fn; };
    this.treeEl.addEventListener('click', (e) => this._onTreeClick(e));
    this.selectorEl.addEventListener('click', (e) => this._onSelectorClick(e));
    this.selectorEl.addEventListener('change', (e) => this._onSelectorChange(e));
    this.recentEl.addEventListener('click', (e) => this._onRecentClick(e));
    on('pmNew', () => this.createProjectFlow());
    on('pmRefresh', () => this.refresh());
    on('pmImport', () => this.openImport());
    on('pmClose', () => { this.hide(); this.onResume?.(); });
    on('toastClose', () => this.toast(null));
    this.menuEl.addEventListener('click', (e) => this._onMenuClick(e));
    document.addEventListener('pointerdown', (e) => {
      if (this.menuEl.classList.contains('on') && !this.menuEl.contains(e.target)) {
        this.menuEl.classList.remove('on');
      }
    }, true);
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.menuEl.classList.remove('on'); }
    });
  }

  // ------------------------------------------------------------- 数据

  async refresh() {
    try {
      const d = await api.projects();
      this.data = d;
      this._banner(null);
      this._syncSelection();
      this.render();
    } catch (e) {
      this.bannerEl.classList.add('on');
      this.bannerEl.innerHTML = `<b>连接不到本地后端</b><br>${esc(e.message)}<br>`
        + '<span class="mut">请关闭此页，改用 start.bat 启动。</span>';
    }
  }

  get projects() { return this.data.projects || []; }

  getProject(pid) { return this.projects.find((p) => p.id === pid) || null; }

  getModel(pid, mid) {
    const p = this.getProject(pid);
    return p ? (p.models.find((m) => m.id === mid) || null) : null;
  }

  getVersion(pid, mid, vid) {
    const m = this.getModel(pid, mid);
    return m ? (m.versions.find((v) => v.id === vid) || null) : null;
  }

  /** 选择态失效时自动落到第一个可用项（优先 ready 版本） */
  _syncSelection() {
    const s = this.sel;
    if (!this.getProject(s.projectId)) s.projectId = this.projects[0]?.id || null;
    const p = this.getProject(s.projectId);
    if (p && !this.getModel(s.projectId, s.modelId)) s.modelId = p.models[0]?.id || null;
    const m = this.getModel(s.projectId, s.modelId);
    if (m && !this.getVersion(s.projectId, s.modelId, s.versionId)) {
      s.versionId = (m.versions[0] || {}).id || null;
    }
    if (!p) { s.modelId = null; s.versionId = null; }
  }

  _banner(html) {
    this.bannerEl.classList.toggle('on', !!html);
    if (html) this.bannerEl.innerHTML = html;
  }

  // ------------------------------------------------------------- 渲染

  render() {
    this.renderTree();
    this.renderSelector();
    this.renderRecent();
    const t = this.data.totals || {};
    document.getElementById('pmTotals').textContent =
      `${t.projects || 0} 个项目 · ${t.models || 0} 个模型 · ${t.versions || 0} 个版本`;
  }

  renderTree() {
    const P = this.projects;
    const canManage = !!access.perms.manageProjects;   // UI 裁剪；后端仍是最终权限来源
    if (!P.length) {
      this.treeEl.innerHTML = '<div class="pm-empty">No Models<br>'
        + '<span class="mut">还没有任何项目。点右下角 <b>Import Model</b> 导入第一个模型，'
        + '或在顶部新建项目。</span></div>';
      return;
    }
    let html = '';
    for (const p of P) {
      const pOpen = this.expandedProjects.has(p.id);
      const pSel = p.id === this.sel.projectId;
      html += `<div class="pm-node">
        <div class="pm-row lv1${pSel ? ' sel' : ''}" data-kind="project" data-pid="${esc(p.id)}">
          <span class="tw">${p.models.length ? (pOpen ? '▾' : '▸') : '·'}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="meta">${p.modelCount} 模型 · ${p.versionCount} 版本</span>
          <span class="acts">
            ${canManage ? '<button data-act="new-model" title="在此项目下新建模型">+ 模型</button>' : ''}
            ${canManage ? '<button data-act="menu" title="更多">⋯</button>' : ''}
          </span>
        </div>`;
      if (pOpen) {
        html += '<div class="pm-kids">';
        if (!p.models.length) html += '<div class="pm-row lv2 mut-row"><span class="nm">（还没有模型）</span></div>';
        for (const m of p.models) {
          const mKey = `${p.id}/${m.id}`;
          const mOpen = this.expandedModels.has(mKey);
          const mSel = pSel && m.id === this.sel.modelId;
          html += `<div class="pm-node">
            <div class="pm-row lv2${mSel ? ' sel' : ''}" data-kind="model"
                 data-pid="${esc(p.id)}" data-mid="${esc(m.id)}">
              <span class="tw">${m.versions.length ? (mOpen ? '▾' : '▸') : '·'}</span>
              <span class="nm">${esc(m.name)}</span>
              <span class="meta">${m.versionCount} 版本</span>
              <span class="acts">
                ${canManage ? '<button data-act="new-version" title="为这个模型导入新版本">+ 版本</button>' : ''}
                ${canManage ? '<button data-act="menu" title="更多">⋯</button>' : ''}
              </span>
            </div>`;
          if (mOpen) {
            html += '<div class="pm-kids">';
            if (!m.versions.length) html += '<div class="pm-row lv3 mut-row"><span class="nm">（还没有版本）</span></div>';
            for (const v of m.versions) {
              const vSel = mSel && v.id === this.sel.versionId;
              html += `<div class="pm-row lv3 st-${esc(v.status)}${vSel ? ' sel' : ''}"
                    data-kind="version" data-pid="${esc(p.id)}" data-mid="${esc(m.id)}"
                    data-vid="${esc(v.id)}" title="${esc(v.originalRvmFilename || v.name)}">
                <span class="dot"></span>
                <span class="nm">${esc(v.name)}</span>
                <span class="meta">${v.status === 'ready'
                  ? `RVM ${fmtBytes(v.rvmBytes)} · GLB ${fmtBytes(v.glbBytes)}`
                  : esc(this._statusText(v))}</span>
                <span class="acts">
                  ${v.status === 'ready' ? '<button data-act="open">Open</button>' : ''}
                  ${canManage ? '<button data-act="menu" title="更多">⋯</button>' : ''}
                </span>
              </div>`;
            }
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    this.treeEl.innerHTML = html;
  }

  _statusText(v) {
    if (v.status === 'ready') return 'Ready';
    if (v.status === 'failed') return `失败 · ${STAGE_LABEL[v.error?.stage] || v.error?.stage || ''}`;
    if (v.status === 'importing') return '导入中…';
    return '状态异常（缺 manifest）';
  }

  renderSelector() {
    const s = this.sel;
    const p = this.getProject(s.projectId);
    const m = this.getModel(s.projectId, s.modelId);
    const v = this.getVersion(s.projectId, s.modelId, s.versionId);
    const opts = (list, cur, labelFn) => list.map((x) =>
      `<option value="${esc(x.id)}"${x.id === cur ? ' selected' : ''}>${esc(labelFn(x))}</option>`).join('');

    let html = '<div class="sel-grid">';
    html += `<label>Project</label><select id="selProject"${this.projects.length ? '' : ' disabled'}>`
      + (this.projects.length ? opts(this.projects, s.projectId, (x) => x.name) : '<option>（无）</option>')
      + '</select>';
    html += `<label>Model</label><select id="selModel"${m || (p && p.models.length) ? '' : ' disabled'}>`
      + (p && p.models.length ? opts(p.models, s.modelId, (x) => x.name) : '<option>（无）</option>')
      + '</select>';
    html += `<label>Version</label><select id="selVersion"${m && m.versions.length ? '' : ' disabled'}>`
      + (m && m.versions.length
        ? opts(m.versions, s.versionId, (x) => `${x.name}${x.status === 'ready' ? '' : `（${this._statusText(x)}）`}`)
        : '<option>（无）</option>')
      + '</select>';
    html += '</div>';

    if (v) {
      const ready = v.status === 'ready';
      html += `<div class="ver-card st-${esc(v.status)}">`
        + `<div class="vc-head"><span class="dot"></span><b>${esc(v.name)}</b>`
        + `<span class="tag">${esc(this._statusText(v))}</span></div>`
        + '<table class="kv">'
        + `<tr><td>导入时间</td><td>${esc(fmtTime(v.importedAt))}</td></tr>`
        + `<tr><td>源文件时间</td><td>${esc(fmtTime(v.createdAt))}</td></tr>`
        + `<tr><td>RVM / GLB</td><td>${fmtBytes(v.rvmBytes)} / ${fmtBytes(v.glbBytes)}</td></tr>`
        + `<tr><td>对象数</td><td>${v.objectCount ? v.objectCount.toLocaleString() : '—'}</td></tr>`
        + '<tr><td>几何对应率</td><td>'
        + (v.mappingRate === null || v.mappingRate === undefined ? '—'
          : `${(v.mappingRate * 100).toFixed(2)}%`)
        + '</td></tr>'
        + `<tr><td>原始文件名</td><td class="brk">${esc(v.originalTxtFilename || '—')}</td></tr>`
        + '</table>'
        + (v.error ? `<div class="vc-err"><b>失败阶段</b>：${esc(STAGE_LABEL[v.error.stage] || v.error.stage)}`
          + `<br>${esc(v.error.message)}</div>` : '')
        + '</div>';
    } else {
      html += '<div class="ver-card muted">这个 Model 下还没有版本。<br>'
        + '点 <b>Import Model</b> 导入第一个版本。</div>';
    }

    html += '<div class="sel-acts">'
      + `<button id="selOpen" class="primary"${v && v.status === 'ready' ? '' : ' disabled'}>Open Model</button>`
      + '<button id="selImport">Import Model</button>'
      + (v ? '<button id="selDetails">Details</button>' : '')
      + (v && v.status === 'failed' ? '<button id="selRetry">查看错误</button>' : '')
      + '</div>';
    this.selectorEl.innerHTML = html;
  }

  renderRecent() {
    if (!this.recent.length) {
      this.recentEl.innerHTML = '<div class="recent-empty mut">还没有打开过模型。</div>';
      return;
    }
    this.recentEl.innerHTML = '<div class="recent-list">' + this.recent.map((r, i) =>
      `<div class="recent-row${r.available === false ? ' gone' : ''}">
        <span class="rp">${esc(r.projectName)}</span>
        <span class="rm">${esc(r.modelName)}</span>
        <span class="rv">${esc(r.versionName)}</span>
        <span class="rt">${esc(fmtTime(r.at))}</span>
        ${r.available === false
          ? '<span class="tag bad">已不存在</span>'
          : `<button data-act="recent-open" data-i="${i}">Open</button>`}
      </div>`).join('') + '</div>';
  }

  // ------------------------------------------------------------- 交互

  _onTreeClick(e) {
    const btn = e.target.closest('button');
    const row = e.target.closest('.pm-row');
    if (!row) return;
    const { kind, pid, mid, vid } = row.dataset;

    if (btn) {
      const act = btn.dataset.act;
      if (act === 'menu') { this._openMenu(kind, { pid, mid, vid }, btn); return; }
      if (act === 'open') { this.openVersion(pid, mid, vid); return; }
      if (act === 'new-model') { this.createModelFlow(pid); return; }
      if (act === 'new-version') { this.openImport({ projectId: pid, modelId: mid, versionId: null }); return; }
      return;
    }

    if (kind === 'project') {
      this.sel.projectId = pid;
      this.sel.modelId = this.getProject(pid)?.models[0]?.id || null;
      this.sel.versionId = this.getModel(pid, this.sel.modelId)?.versions[0]?.id || null;
      if (!this.expandedProjects.has(pid)) { this.expandedProjects.add(pid); this.renderTree(); }
      this.renderSelector();
    } else if (kind === 'model') {
      this.sel.projectId = pid; this.sel.modelId = mid;
      this.sel.versionId = this.getModel(pid, mid)?.versions[0]?.id || null;
      const key = `${pid}/${mid}`;
      if (!this.expandedModels.has(key)) { this.expandedModels.add(key); this.renderTree(); }
      this.renderSelector();
    } else if (kind === 'version') {
      this.sel = { projectId: pid, modelId: mid, versionId: vid };
      this.renderTree();
      this.renderSelector();
    }
  }

  _onSelectorClick(e) {
    const id = e.target.id;
    if (id === 'selOpen') return this.openVersion(this.sel.projectId, this.sel.modelId, this.sel.versionId);
    if (id === 'selImport') return this.openImport(this.sel);
    if (id === 'selDetails' || id === 'selRetry') {
      const s = this.sel;
      return this.showDetails(s.projectId, s.modelId, s.versionId);
    }
  }

  _onSelectorChange(e) {
    const id = e.target.id;
    if (id === 'selProject') {
      this.sel.projectId = e.target.value;
      this.sel.modelId = this.getProject(this.sel.projectId)?.models[0]?.id || null;
      this.render();
    } else if (id === 'selModel') {
      this.sel.modelId = e.target.value;
      this.sel.versionId = this.getModel(this.sel.projectId, this.sel.modelId)?.versions[0]?.id || null;
      this.render();
    } else if (id === 'selVersion') {
      this.sel.versionId = e.target.value;
      this.renderSelector();
      this.renderTree();
    }
  }

  _onRecentClick(e) {
    const b = e.target.closest('button[data-act="recent-open"]');
    if (!b) return;
    const r = this.recent[+b.dataset.i];
    if (r) this.openVersion(r.projectId, r.modelId, r.versionId);
  }

  // ------------------------------------------------------------- 打开模型

  async openVersion(pid, mid, vid) {
    const v = this.getVersion(pid, mid, vid);
    if (!v) return this.toast('版本不存在', 'err');
    if (v.status !== 'ready') {
      return this.toast(`版本 ${v.name} 不是 ready（${this._statusText(v)}），无法打开`, 'err');
    }
    const p = this.getProject(pid);
    const m = this.getModel(pid, mid);
    const ctx = { project: p, model: m, version: v };
    this._pushRecent(ctx);
    writeLS(LS_LAST, { projectId: pid, modelId: mid, versionId: vid, at: new Date().toISOString() });
    this.hide();
    try {
      await this.onOpen(ctx);
    } catch (e) {
      this.show();
      this.toast(`打开失败：${e.message}`, 'err');
    }
  }

  _pushRecent(ctx) {
    const item = {
      projectId: ctx.project.id, modelId: ctx.model.id, versionId: ctx.version.id,
      projectName: ctx.project.name, modelName: ctx.model.name,
      versionName: ctx.version.name, at: new Date().toISOString(), available: true,
    };
    this.recent = [item, ...this.recent.filter((r) =>
      !(r.projectId === item.projectId && r.modelId === item.modelId
        && r.versionId === item.versionId))].slice(0, MAX_RECENT);
    this._flagMissingRecents();
    writeLS(LS_RECENT, this.recent);
    this.renderRecent();
  }

  /** 最近记录里已经不存在（被删/改名）的项标出来，但不自动消失 —— 用户自己看得见更好 */
  _flagMissingRecents() {
    for (const r of this.recent) {
      const v = this.getVersion(r.projectId, r.modelId, r.versionId);
      r.available = !!v && v.status === 'ready';
    }
  }

  // ------------------------------------------------------------- Project / Model 增删改

  async createProjectFlow() {
    if (!access.perms.createProject) return this.toast('当前身份不能创建项目', 'err');
    const name = await this.promptDlg({ title: '新建 Project', label: '项目名称（可中文）', value: '' });
    if (name === null) return;
    const sug = await api.suggestId('project', name).catch(() => ({ suggested: '' }));
    const id = await this.promptDlg({
      title: '新建 Project',
      label: 'Project ID（内部目录名，只能 ASCII）',
      value: sug.suggested || '',
      hint: sug.needsId
        ? '名称里没有 ASCII 字符，请自己起一个英文 ID，例如 qichuang / propionic-acid。'
        : 'ID 决定 data/projects/ 下的目录名，创建后不再改动；显示名称随时可改。',
    });
    if (id === null) return;
    try {
      const p = await api.createProject(name, id.trim());
      await this.refresh();
      this.sel = { projectId: p.id, modelId: null, versionId: null };
      this.expandedProjects.add(p.id);
      this.render();
      this.toast(`已创建项目 ${p.name}`);
    } catch (e) { this.toast(e.message, 'err'); }
  }

  async createModelFlow(pid) {
    if (!access.perms.manageProjects) return this.toast('当前身份不能创建模型', 'err');
    const p = this.getProject(pid);
    const name = await this.promptDlg({ title: `在「${p.name}」下新建 Model`, label: '模型名称', value: '' });
    if (name === null) return;
    const sug = await api.suggestId('model', name).catch(() => ({ suggested: '' }));
    const id = await this.promptDlg({
      title: '新建 Model', label: 'Model ID（ASCII）', value: sug.suggested || '',
      hint: '例如 main-site / tank-area / pipe-rack。',
    });
    if (id === null) return;
    try {
      const m = await api.createModel(pid, name, id.trim());
      this.expandedProjects.add(pid);
      this.expandedModels.add(`${pid}/${m.id}`);
      await this.refresh();
      this.sel = { projectId: pid, modelId: m.id, versionId: null };
      this.render();
      this.toast(`已创建模型 ${m.name}`);
    } catch (e) { this.toast(e.message, 'err'); }
  }

  _openMenu(kind, ids, anchorBtn) {
    const canManage = !!access.perms.manageProjects;
    const items = [];
    if (kind === 'project') {
      if (access.isInternal) items.push(['客户访问…', 'access-code']);
      if (canManage) {
        items.push(['重命名 / 改描述', 'rename']);
        items.push(['在此新建 Model', 'new-model']);
        items.push(['导入模型到本项目', 'import']);
        items.push(['删除项目…', 'delete']);
      }
    } else if (kind === 'model') {
      if (canManage) {
        items.push(['重命名 / 改描述', 'rename']);
        items.push(['导入新版本', 'import']);
        items.push(['删除模型…', 'delete']);
      }
    } else {
      const v = this.getVersion(ids.pid, ids.mid, ids.vid);
      if (v && v.status === 'ready') items.push(['Open', 'open']);
      if (canManage) {
        items.push(['重命名', 'rename']);
        items.push(['Details', 'details']);
        items.push(['查看 conversion.log', 'log']);
        if (v && v.status === 'failed') items.push(['重试导入', 'retry']);
        items.push(['删除版本…', 'delete']);
      } else if (v && v.status === 'ready') {
        items.push(['Details', 'details']);
      }
    }
    if (!items.length) return;
    this.menuEl.dataset.kind = kind;
    Object.assign(this.menuEl.dataset, ids);
    this.menuEl.innerHTML = items.map(([label, act]) =>
      `<button data-mact="${act}"${act === 'delete' ? ' class="danger"' : ''}>${esc(label)}</button>`).join('');
    const r = anchorBtn.getBoundingClientRect();
    this.menuEl.classList.add('on');
    this.menuEl.style.left = `${Math.min(r.left - 120, innerWidth - 240)}px`;
    this.menuEl.style.top = `${r.bottom + 4}px`;
  }

  async _onMenuClick(e) {
    const b = e.target.closest('button[data-mact]');
    if (!b) return;
    const act = b.dataset.mact;
    const { kind, pid, mid, vid } = this.menuEl.dataset;
    this.menuEl.classList.remove('on');
    try {
      if (act === 'open') return void this.openVersion(pid, mid, vid);
      if (act === 'details') return void this.showDetails(pid, mid, vid);
      if (act === 'log') return void this.showLog(pid, mid, vid);
      if (act === 'new-model') return void this.createModelFlow(pid);
      if (act === 'import') {
        return void this.openImport(kind === 'project'
          ? { projectId: pid, modelId: null, versionId: null }
          : { projectId: pid, modelId: mid, versionId: null });
      }
      if (act === 'retry') return void this.retryVersion(pid, mid, vid);
      if (act === 'rename') return void this.renameFlow(kind, pid, mid, vid);
      if (act === 'access-code') return void this.accessCodeFlow(pid);
      if (act === 'delete') return void this.deleteFlow(kind, pid, mid, vid);
    } catch (e) { this.toast(e.message, 'err'); }
  }

  async renameFlow(kind, pid, mid, vid) {
    if (kind === 'project') {
      const p = this.getProject(pid);
      const name = await this.promptDlg({ title: '重命名 Project', label: '项目名称', value: p.name });
      if (name === null || !name.trim()) return;
      await api.updateProject(pid, { name: name.trim() });
    } else if (kind === 'model') {
      const m = this.getModel(pid, mid);
      const name = await this.promptDlg({ title: '重命名 Model', label: '模型名称', value: m.name });
      if (name === null || !name.trim()) return;
      await api.updateModel(pid, mid, { name: name.trim() });
    } else {
      const v = this.getVersion(pid, mid, vid);
      const name = await this.promptDlg({
        title: '重命名 Version', label: '版本名称', value: v.name,
        hint: `目录名（${vid}）保持不变，只改显示名称。`,
      });
      if (name === null || !name.trim()) return;
      await api.updateVersion(pid, mid, vid, { name: name.trim() });
    }
    await this.refresh();
    this.toast('已更新');
  }

  async deleteFlow(kind, pid, mid, vid) {
    let title, lines, res;
    if (kind === 'project') {
      const p = this.getProject(pid);
      title = `删除项目「${p.name}」？`;
      lines = [
        `将删除：${p.modelCount} 个 Model、${p.versionCount} 个 Version`,
        `ID：${p.id}`,
        '所有源文件（RVM/TXT）与转换产物都会一起移走。',
      ];
    } else if (kind === 'model') {
      const m = this.getModel(pid, mid);
      title = `删除模型「${m.name}」？`;
      lines = [`将删除：${m.versionCount} 个 Version`, `ID：${mid}`];
    } else {
      const v = this.getVersion(pid, mid, vid);
      title = `删除版本「${v.name}」？`;
      lines = [`ID：${vid}`, `状态：${this._statusText(v)}`,
        `源文件：${v.originalRvmFilename || '—'}`];
    }
    lines.push('删除只是移入 data/trash/，不会立即物理删除，但页面里不再可见。');
    const ok = await this.confirmDlg({ title, lines, okLabel: 'Delete', danger: true });
    if (!ok) return;
    // 删除是危险操作：内网也需要输入服务器端校验的统一删除密码
    const doDelete = (password) => {
      if (kind === 'project') return api.deleteProject(pid, password);
      if (kind === 'model') return api.deleteModel(pid, mid, password);
      return api.deleteVersion(pid, mid, vid, password);
    };

    if (access.perms.deleteRequiresPassword) {
      for (;;) {
        const password = await this.promptDlg({
          title: '需要删除密码', label: '删除密码', type: 'password',
          hint: '删除密码由服务器统一配置（config/access.env），前端不保存。',
        });
        if (password === null) return;
        try { res = await doDelete(password); break; }
        catch (e) {
          if (e.code === 'delete_password_invalid' || e.code === 'delete_password_required') {
            this.toast('删除密码不正确，请重试', 'err');
            continue;
          }
          throw e;
        }
      }
    } else {
      res = await doDelete(null);
    }
    await this.refresh();
    this.toast(`已移入回收站：${res.trashedTo || res.removed || ''}`);
  }

  /** 项目客户访问码管理：查看 / 复制 / 重新生成 / 启用 / 禁用（仅内网） */
  async accessCodeFlow(pid) {
    if (!access.isInternal) return this.toast('只有公司内网可以管理客户访问码', 'err');
    const p = this.getProject(pid);
    const box = this._modalShell('<div id="acBody" class="mut">读取中…</div>', {});
    box.querySelector('.modal-title').textContent = `客户访问 — ${p.name}`;
    const acts = box.querySelector('.modal-acts');
    acts.innerHTML = '';
    const close = () => { this.closeModal(); };
    const cancel = document.createElement('button');
    cancel.textContent = '关闭';
    cancel.onclick = close;
    acts.appendChild(cancel);

    const reload = async () => {
      let ea;
      try { ea = await api.projectAccessCode(pid); }
      catch (e) {
        box.querySelector('#acBody').innerHTML = `<div class="vc-err">${esc(e.message)}</div>`;
        return;
      }
      const body = box.querySelector('#acBody');
      body.classList.remove('mut');
      body.innerHTML = `<table class="kv wide">
          <tr><td>状态</td><td>${ea.enabled
            ? '<b style="color:var(--ok)">已启用</b>'
            : '<span class="mut">已禁用（外部无法访问）</span>'}</td></tr>
          <tr><td>访问码</td><td class="brk mono">${ea.code
            ? `<b>${esc(ea.code)}</b>` : '—'}</td></tr>
        </table>
        <div class="mut small" style="margin-top:8px;line-height:1.8">
          客户在外网页面输入此访问码后，只能查看本项目（只读）。<br>
          重新生成或禁用后，旧访问码立即不能用于新的登录，已建立的 Session 会继续有效至自然过期。
        </div>`;
      const row = body.querySelector('table');
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      const mkBtn = (label, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.onclick = () => fn(b);
        btns.appendChild(b);
        return b;
      };
      if (ea.enabled && ea.code) {
        mkBtn('复制访问码', async (b) => {
          b.textContent = '已复制';
          setTimeout(() => { b.textContent = '复制访问码'; }, 1600);
          await navigator.clipboard.writeText(ea.code).catch(() => {});
        });
      }
      mkBtn(ea.enabled ? '重新生成' : '生成访问码', async (b) => {
        b.disabled = true;
        try { await api.setProjectAccess(pid, 'regenerate'); await reload(); }
        catch (e) { this.toast(e.message, 'err'); b.disabled = false; }
      }, 'primary');
      mkBtn(ea.enabled ? '禁用外部访问' : '启用外部访问', async (b) => {
        b.disabled = true;
        try {
          await api.setProjectAccess(pid, ea.enabled ? 'disable' : 'enable');
          await reload();
        } catch (e) { this.toast(e.message, 'err'); b.disabled = false; }
      });
      body.appendChild(btns);
    };
    await reload();
  }

  async retryVersion(pid, mid, vid) {
    // 失败版本原地重跑：源文件还在版本目录里，后端直接复用，不需要重新选文件
    const v = this.getVersion(pid, mid, vid);
    const ok = await this.confirmDlg({
      title: `重试导入「${v.name}」？`,
      lines: [`阶段：${STAGE_LABEL[v.error?.stage] || v.error?.stage || '—'}`,
        '源文件保持不动，只清空 processed/ 与 reports/ 后重跑整条转换链。'],
      okLabel: 'Retry',
    });
    if (!ok) return;
    try {
      const job = await api.importRetry(pid, mid, vid);
      this.openImport({ projectId: pid, modelId: mid });
      this.job = job;
      document.getElementById('impProgress').classList.add('on');
      document.getElementById('impStart').disabled = true;
      await this._pollJob(job.jobId);
    } catch (e) { this.toast(e.message, 'err'); }
  }

  // ------------------------------------------------------------- Details / Log

  async showDetails(pid, mid, vid) {
    const v = this.getVersion(pid, mid, vid);
    const p = this.getProject(pid);
    const m = this.getModel(pid, mid);
    const rows = [
      ['路径', `${p.name} / ${m.name} / ${v.name}`],
      ['Project ID / Model ID / Version ID', `${pid} / ${mid} / ${vid}`],
      ['状态', this._statusText(v)],
      ['导入时间', fmtTime(v.importedAt)],
      ['源文件时间', fmtTime(v.createdAt)],
      ['原始 RVM 文件', v.originalRvmFilename || '—'],
      ['原始 TXT 文件', v.originalTxtFilename || '—'],
      ['RVM / TXT / GLB', `${fmtBytes(v.rvmBytes)} / ${fmtBytes(v.txtBytes)} / ${fmtBytes(v.glbBytes)}`],
      ['对象数（TXT）', v.objectCount ? v.objectCount.toLocaleString() : '—'],
      ['已映射几何组', v.mappedObjects ? v.mappedObjects.toLocaleString() : '—'],
      ['几何对应率', v.mappingRate === null || v.mappingRate === undefined ? '—'
        : `${(v.mappingRate * 100).toFixed(2)}%`],
      ['转换耗时', v.durationMs ? `${(v.durationMs / 1000).toFixed(1)} s` : '—'],
      ['转换链版本', v.converterVersion || '—'],
    ];
    let html = '<table class="kv wide">'
      + rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td class="brk">${esc(val)}</td></tr>`).join('')
      + '</table>';

    if (v.validation) {
      html += `<h4>独立校验闸门 · ${v.validation.pass ? '全部通过' : '未通过'}</h4><ul class="chk">`
        + v.validation.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✕'} `
          + `${esc(c.name)}${c.failed?.length ? `：${esc(c.failed.join('、'))}` : ''}</li>`).join('')
        + '</ul>';
    }
    if (v.error) {
      html += `<h4>失败信息</h4><div class="vc-err"><b>阶段</b>：${esc(STAGE_LABEL[v.error.stage] || v.error.stage)}`
        + `<br><b>错误</b>：${esc(v.error.message)}</div>`;
    }
    if (v.assets) {
      html += '<h4>产物文件（本机）</h4><ul class="files">'
        + Object.entries(v.assets).map(([k, url]) =>
          `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(k)}</a>`
          + `<span class="mut">${esc(url.split('/').slice(-2).join('/'))}</span></li>`).join('')
        + '</ul>';
    }
    if (v.history?.length) {
      html += '<h4>操作历史</h4><ul class="hist">' + v.history.slice().reverse().map((h) =>
        `<li>${esc(fmtTime(h.at))} · ${esc(STAGE_LABEL[h.status] || h.status)}`
        + `${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('') + '</ul>';
    }
    await this.modalDlg({
      title: `Version ${v.name}`,
      body: html,
      actions: v.status === 'failed'
        ? [['查看 conversion.log', () => { this.closeModal(); this.showLog(pid, mid, vid); }]]
        : [],
      okLabel: '关闭',
    });
  }

  async showLog(pid, mid, vid) {
    let text = '';
    try { text = (await api.versionLog(pid, mid, vid)).text || ''; }
    catch (e) { text = `读取失败：${e.message}`; }
    const path = v_path(pid, mid, vid);
    await this.modalDlg({
      title: 'conversion.log',
      body: `<div class="mut mono">${esc(path)}/reports/conversion.log</div>`
        + `<pre class="log">${esc(text.slice(-20000) || '（空）')}</pre>`,
      okLabel: '关闭',
      wide: true,
    });
  }

  // ------------------------------------------------------------- Import

  openImport(prefill = {}) {
    if (!access.perms.upload) {
      this.toast('当前身份不能上传模型', 'err');
      return;
    }
    const el = (id) => document.getElementById(id);
    const p = this.getProject(prefill.projectId) || this.getProject(this.sel.projectId);

    el('impProject').innerHTML = '<option value="">（未选择）</option>'
      + this.projects.map((x) => `<option value="${esc(x.id)}"${p && x.id === p.id ? ' selected' : ''}>`
        + `${esc(x.name)}</option>`).join('')
      + '<option value="__new__">＋ 新建 Project…</option>';

    this._impFillModels(p?.id, prefill.modelId);
    el('impNewProject').value = '';
    el('impNewModel').value = '';
    el('impProjectId').value = '';
    el('impModelId').value = '';
    el('impVersion').value = prefill.versionName || new Date().toISOString().slice(0, 10);
    el('impRvm').value = '';
    el('impTxt').value = '';
    el('impRvmName').textContent = '未选择文件';
    el('impTxtName').textContent = '未选择文件';
    el('impProgress').innerHTML = '';
    el('impProgress').classList.remove('on');
    el('impError').classList.remove('on');
    el('impOpen').classList.remove('on');
    el('impRetry').classList.remove('on');
    el('impStart').disabled = false;
    el('impStart').textContent = 'Import';
    this.job = null;
    this._impSyncForm();
    this._impHint('');
    el('modal').classList.remove('on');
    el('importModal').classList.add('on');
  }

  _impFillModels(pid, selectMid) {
    const el = (id) => document.getElementById(id);
    const p = this.getProject(pid);
    el('impModel').innerHTML = '<option value="">（未选择）</option>'
      + (p?.models || []).map((x) => `<option value="${esc(x.id)}"`
        + `${x.id === selectMid ? ' selected' : ''}>${esc(x.name)}</option>`).join('')
      + '<option value="__new__">＋ 新建 Model…</option>';
  }

  /** 根据两个下拉的当前值，决定"新建 Project / Model"的名字与 ID 字段是否显示 */
  _impSyncForm() {
    const el = (id) => document.getElementById(id);
    const newP = el('impProject').value === '__new__';
    if (newP) {
      // 新项目下必然没有模型 → Model 只能是"新建"
      el('impModel').innerHTML = '<option value="__new__" selected>＋ 新建 Model…</option>';
    }
    const newM = el('impModel').value === '__new__' || newP;
    for (const [wrap, label, on] of [
      ['impNewProjectWrap', 'impNewProjectLabel', newP],
      ['impProjectIdWrap', 'impProjectIdLabel', newP],
      ['impNewModelWrap', 'impNewModelLabel', newM],
      ['impModelIdWrap', 'impModelIdLabel', newM],
    ]) {
      el(wrap).classList.toggle('on', on);
      el(label).classList.toggle('on', on);
    }
    if (!newP) { el('impNewProject').value = ''; el('impProjectId').value = ''; }
    if (!newM) { el('impNewModel').value = ''; el('impModelId').value = ''; }
  }

  async _suggest(name, kind, targetId) {
    const el = document.getElementById(targetId);
    if (!name.trim()) { el.value = ''; return; }
    try {
      const s = await api.suggestId(kind, name.trim());
      el.value = s.suggested || '';
      el.dataset.needsId = s.needsId ? '1' : '';
    } catch { /* 后端不可用时留空由用户填 */ }
  }

  _impHint(text, isErr) {
    const h = document.getElementById('impHint');
    h.innerHTML = text;
    h.classList.toggle('err', !!isErr);
  }

  _impCollect() {
    const el = (id) => document.getElementById(id);
    const pv = el('impProject').value;
    const mv = el('impModel').value;
    const out = {
      versionName: el('impVersion').value.trim(),
      rvmFile: el('impRvm').files[0] || null,
      txtFile: el('impTxt').files[0] || null,
    };
    if (!out.versionName) throw new ApiError('version_required', '请填写版本名称（例如 2026-09-25）');
    if (pv === '__new__') {
      out.projectId = null;
      out.newProjectName = el('impNewProject').value.trim();
      out.newProjectId = el('impProjectId').value.trim();
      if (!out.newProjectName) throw new ApiError('project_required', '请填写新 Project 名称');
      if (!out.newProjectId) throw new ApiError('project_id_required', '请填写新 Project 的 ASCII ID');
    } else if (pv) {
      out.projectId = pv;
      out.newProjectName = null;
      out.newProjectId = null;
    } else {
      throw new ApiError('project_required', '请选择 Project（或新建一个）');
    }
    if (mv === '__new__' || pv === '__new__') {
      out.modelId = null;
      out.newModelName = el('impNewModel').value.trim();
      out.newModelId = el('impModelId').value.trim();
      if (!out.newModelName) throw new ApiError('model_required', '请填写新 Model 名称');
      if (!out.newModelId) throw new ApiError('model_id_required', '请填写新 Model 的 ASCII ID');
    } else if (mv) {
      out.modelId = mv;
      out.newModelName = null;
      out.newModelId = null;
    } else {
      throw new ApiError('model_required', '请选择 Model（或新建一个）');
    }
    if (!out.rvmFile) throw new ApiError('rvm_required', '请选择 RVM 文件');
    if (!out.txtFile) throw new ApiError('txt_required', '请选择 TXT 数据清单文件');
    return out;
  }

  async startImport() {
    const el = (id) => document.getElementById(id);
    let form;
    try { form = this._impCollect(); }
    catch (e) { return this._impHint(`<b>还不能开始</b><br>${esc(e.message)}`, true); }

    el('impStart').disabled = true;
    el('impStart').textContent = '导入中…';
    el('impError').classList.remove('on');
    el('impOpen').classList.remove('on');
    el('impProgress').classList.add('on');
    this._impHint('');
    this._renderImportStages([{ name: 'copying', status: 'running' }], null);

    try {
      const job = await api.importCreate({
        projectId: form.projectId, modelId: form.modelId,
        newProjectName: form.newProjectName, newModelName: form.newModelName,
        newProjectId: form.newProjectId, newModelId: form.newModelId,
        versionName: form.versionName,
        rvmFilename: form.rvmFile.name, txtFilename: form.txtFile.name,
      });
      this.job = job;
      await uploadSource(job.jobId, 'rvm', form.rvmFile, (l, t) =>
        this._renderImportStages(null, `上传 RVM ${fmtBytes(l)} / ${fmtBytes(t)}`, job));
      await uploadSource(job.jobId, 'txt', form.txtFile, (l, t) =>
        this._renderImportStages(null, `上传 TXT ${fmtBytes(l)} / ${fmtBytes(t)}`, job));
      await api.importStart(job.jobId);
      await this._pollJob(job.jobId);
    } catch (e) {
      el('impError').classList.add('on');
      el('impError').innerHTML = `<b>导入未能开始</b><br>${esc(e.message)}`;
      el('impStart').disabled = false;
      el('impStart').textContent = 'Import';
    }
  }

  async _pollJob(jobId) {
    const el = (id) => document.getElementById(id);
    for (;;) {
      let job;
      try { job = await api.importState(jobId); }
      catch (e) {
        this._impHint(esc(e.message), true);
        el('impStart').disabled = false;
        el('impStart').textContent = 'Import';
        return;
      }
      this.job = job;
      this._renderImportStages(job.stages, null, job);
      if (job.status === 'ready') {
        this._impHint(`<b>导入完成</b>：${esc(job.projectId)} / ${esc(job.modelId)}`
          + ` / ${esc(job.versionId)}　→ 可以直接打开`);
        await this.refresh();
        this.sel = { projectId: job.projectId, modelId: job.modelId, versionId: job.versionId };
        this.expandedProjects.add(job.projectId);
        this.expandedModels.add(`${job.projectId}/${job.modelId}`);
        this.render();
        el('impStart').disabled = false;
        el('impStart').textContent = 'Import';
        el('impOpen').classList.add('on');
        Object.assign(el('impOpen').dataset, {
          pid: job.projectId, mid: job.modelId, vid: job.versionId,
        });
        return;
      }
      if (job.status === 'failed') {
        const err = job.error || {};
        el('impError').classList.add('on');
        el('impError').innerHTML = '<b>Import Failed</b><br>'
          + `Stage：<b>${esc(STAGE_LABEL[err.stage] || err.stage || '—')}</b><br>`
          + `Error：${esc(err.message || '未知')}`
          + (err.detail ? `<pre class="log sm">${esc(err.detail.slice(-1200))}</pre>` : '');
        el('impStart').disabled = false;
        el('impStart').textContent = '重新选择文件导入';
        el('impRetry').classList.add('on');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async retryJob() {
    if (!this.job) return;
    const el = (id) => document.getElementById(id);
    el('impRetry').classList.remove('on');
    el('impError').classList.remove('on');
    el('impStart').disabled = true;
    try {
      const job = await api.importRetry(this.job.projectId, this.job.modelId, this.job.versionId);
      this.job = job;
      el('impProgress').classList.add('on');
      await this._pollJob(job.jobId);
    } catch (e) {
      el('impError').classList.add('on');
      el('impError').innerHTML = `<b>重试失败</b><br>${esc(e.message)}`;
      el('impStart').disabled = false;
    }
  }

  _renderImportStages(stages, note, job) {
    const el = document.getElementById('impProgress');
    const order = ['copying', 'geometry', 'metadata', 'mapping', 'validating', 'ready'];
    const status = {};
    for (const s of (stages || [])) status[s.name] = s.status;
    el.innerHTML = '<div class="st-h">Importing Model</div>'
      + order.map((name) => {
        const st = status[name] || 'pending';
        const mark = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'running' ? '→' : '○';
        const cls = st === 'done' ? 'ok' : st === 'failed' ? 'bad' : st === 'running' ? 'run' : '';
        const ms = (stages || []).find((s) => s.name === name)?.ms;
        return `<div class="st ${cls}"><span class="mk">${mark}</span>`
          + `<span class="nm">${esc(STAGE_LABEL[name] || name)}</span>`
          + `<span class="ms">${ms ? `${(ms / 1000).toFixed(1)} s` : ''}</span></div>`;
      }).join('')
      + (note ? `<div class="st-note">${esc(note)}</div>` : '')
      + (job ? `<div class="st-note">目标：${esc(job.location || '')}</div>` : '');
  }

  // ------------------------------------------------------------- 通用弹窗

  _modalShell(html, { wide } = {}) {
    this.modalEl.classList.add('on');
    this.modalEl.querySelector('.modal-box').classList.toggle('wide', !!wide);
    this.modalEl.querySelector('.modal-body').innerHTML = html;
    return this.modalEl.querySelector('.modal-box');
  }

  closeModal() {
    this.modalEl.classList.remove('on');
  }

  modalDlg({ title, body, actions = [], okLabel = '确定', wide }) {
    return new Promise((resolve) => {
      const box = this._modalShell(body, { wide });
      box.querySelector('.modal-title').textContent = title;
      const acts = box.querySelector('.modal-acts');
      acts.innerHTML = '';
      for (const [label, fn] of actions) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => { resolve(true); fn(); };
        acts.appendChild(b);
      }
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = okLabel;
      ok.onclick = () => { this.closeModal(); resolve(true); };
      acts.appendChild(ok);
      box.querySelector('.modal-x').onclick = () => { this.closeModal(); resolve(false); };
    });
  }

  confirmDlg({ title, lines = [], okLabel = 'Delete', danger }) {
    const body = `<ul class="cfm">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    return new Promise((resolve) => {
      const box = this._modalShell(body, {});
      box.querySelector('.modal-title').textContent = title;
      const acts = box.querySelector('.modal-acts');
      acts.innerHTML = '';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => { this.closeModal(); resolve(false); };
      const ok = document.createElement('button');
      ok.className = danger ? 'danger' : 'primary';
      ok.textContent = okLabel;
      ok.onclick = () => { this.closeModal(); resolve(true); };
      acts.append(cancel, ok);
      box.querySelector('.modal-x').onclick = () => { this.closeModal(); resolve(false); };
    });
  }

  promptDlg({ title, label, value = '', hint = '', type = 'text' }) {
    const body = `<label class="fld"><span>${esc(label)}</span>`
      + `<input id="dlgInput" type="${esc(type)}" value="${esc(value)}"></label>`
      + (hint ? `<div class="mut small">${esc(hint)}</div>` : '');
    return new Promise((resolve) => {
      const box = this._modalShell(body, {});
      box.querySelector('.modal-title').textContent = title;
      const acts = box.querySelector('.modal-acts');
      acts.innerHTML = '';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => { this.closeModal(); resolve(null); };
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = '确定';
      const submit = () => {
        const v = box.querySelector('#dlgInput').value;
        this.closeModal();
        resolve(v);
      };
      ok.onclick = submit;
      acts.append(cancel, ok);
      box.querySelector('.modal-x').onclick = () => { this.closeModal(); resolve(null); };
      const input = box.querySelector('#dlgInput');
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      setTimeout(() => input.focus(), 30);
    });
  }

  // ------------------------------------------------------------- 提示条

  toast(text, kind) {
    if (!text) { this.toastEl.classList.remove('on'); return; }
    this.toastEl.className = `overlay on${kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : ''}`;
    this.toastEl.innerHTML = `<span>${esc(text)}</span>`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('on'),
      kind === 'err' ? 9000 : 4500);
  }

  show(canResume = false) {
    this.root.classList.add('on');
    document.getElementById('pmClose').classList.toggle('hidden', !canResume);
  }

  hide() { this.root.classList.remove('on'); }
}

const v_path = (pid, mid, vid) =>
  `data/projects/${pid}/models/${mid}/versions/${vid}`;

// ---------------------------------------------------------------- 导入弹窗接线

export function bindImportModal(am) {
  const el = (id) => document.getElementById(id);
  el('impProject').addEventListener('change', () => {
    const pv = el('impProject').value;
    if (pv === '__new__') {
      am._impSyncForm();
    } else {
      am._impFillModels(pv, null);
      am._impSyncForm();
    }
  });
  el('impModel').addEventListener('change', () => am._impSyncForm());
  el('impNewProject').addEventListener('input', () =>
    am._suggest(el('impNewProject').value, 'project', 'impProjectId'));
  el('impNewModel').addEventListener('input', () =>
    am._suggest(el('impNewModel').value, 'model', 'impModelId'));
  el('impStart').onclick = () => am.startImport();
  el('impRetry').onclick = () => am.retryJob();
  el('impOpen').onclick = () => {
    const d = el('impOpen').dataset;
    el('importModal').classList.remove('on');
    am.openVersion(d.pid, d.mid, d.vid);
  };
  el('impClose').onclick = () => el('importModal').classList.remove('on');
  el('impCancel').onclick = () => el('importModal').classList.remove('on');
  el('modal').querySelector('.modal-x').onclick = () => am.closeModal();
  el('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') am.closeModal();
  });
  el('impRvm').addEventListener('change', () => impEcho(el('impRvm'), 'impRvmName'));
  el('impTxt').addEventListener('change', () => impEcho(el('impTxt'), 'impTxtName'));
  // "版本已存在"等业务错误由后端返回，页面上只在提示区显示，不静默失败。
}

function impEcho(input, targetId) {
  const f = input.files[0];
  document.getElementById(targetId).textContent = f
    ? `${f.name}  ${fmtBytes(f.size)}` : '未选择文件';
}
