import * as THREE from 'three';
import { api } from './api.js';
import { access } from './access.js';
import { copyText, readText } from './clipboard.js';

export const ISSUE_STATUSES = { open: '待修改', review: '已修改待复核', closed: '已关闭', wontfix: '无需修改' };
export const isOpenIssue = i => i.status === 'open' || i.status === 'review';
export const UNTRANSLATED = '（未翻译）';
const DISPLAY_MODES = ['zh', 'en', 'both'];
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 导出序号用 Issue 的稳定序号（issues.json 的 number：单调递增、不复用，删批注也不重排） */
export const issueSeq = n => String(n).padStart(3, '0');
/** TSV 单元格：批注里若含制表符/换行会把两列拆散，导出前压成空格 */
const tsvCell = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const HEADER_KEY = /^(序号|编号|no\.?|id|iid|issue\s*id|issue|#)$/i;

/** Isolated review UI; uses the viewer's semantic selection, raycast and camera APIs. */
export class IssueController {
  constructor(model, options = {}) {
    this.model = model;
    this.toast = options.toast || (() => {});
    this.items = [];
    this.generation = 0;
    this.markers = [];
    this.mode = false;
    // 批注标记默认不遮挡模型，用户可通过面板按钮主动显示。
    this.markersHidden = true;
    // 中英显示切换只走一个 class（.lang-zh / .lang-en / .lang-both），不重建列表 DOM
    this.displayMode = 'zh';
    this.layer = document.createElement('div');
    this.layer.id = 'issueMarkers';
    model.canvas.parentElement.append(this.layer);
    el('btnIssues').onclick = () => {
      this.mode = el('issuePanel').classList.contains('hidden') || !this.mode;
      el('btnIssues').classList.toggle('on', this.mode);
      el('btnIssues').setAttribute('aria-pressed', String(this.mode));
      el('issuePanel').classList.toggle('hidden', !this.mode);
      this.layer.classList.toggle('review-mode', this.mode);
    };
    el('issueCollapse').onclick = () => el('issuePanel').classList.add('hidden');
    el('issuePrev').onclick = () => this.step(-1);
    el('issueNext').onclick = () => this.step(1);
    el('issueLocate').onclick = () => this.locate(this.activeId);
    el('issueReload').onclick = () => this.reload();
    el('issueToggleMarkers').onclick = () => {
      this.markersHidden = !this.markersHidden;
      el('issueToggleMarkers').textContent = this.markersHidden ? '显示所有批注' : '隐藏所有批注';
      el('issueToggleMarkers').setAttribute('aria-pressed', String(this.markersHidden));
      this.updateMarkers();
    };
    el('issueToggleMarkers').textContent = '显示所有批注';
    el('issueToggleMarkers').setAttribute('aria-pressed', 'true');
    // ---- 双语导出 / 导入 ----
    el('issueLangZh').onclick = () => this.setDisplayMode('zh');
    el('issueLangEn').onclick = () => this.setDisplayMode('en');
    el('issueLangBoth').onclick = () => this.setDisplayMode('both');
    el('btnIssueExport').onclick = () => this.exportComments();
    el('btnIssueImport').onclick = () => this.openImport();
    el('issueImportRead').onclick = () => this.readClipboardIntoDialog();
    el('issueImportCancel').onclick = () => el('issueImportDialog').close();
    el('issueImportForm').onsubmit = e => { e.preventDefault(); this.applyImport(); };
    this.setDisplayMode('zh');
    el('issueList').onclick = e => {
      const row = e.target.closest('[data-issue]');
      if (row) this.locate(row.dataset.issue);
    };
    el('issueStatus').onchange = () => this.changeStatus(el('issueStatus').value);
    el('issueForm').onsubmit = e => { e.preventDefault(); this.saveDraft(); };
    el('issueCancel').onclick = () => { this.draft = null; el('issueDialog').close(); };
    model.onReviewFrame = () => this.updateMarkers();
  }

  clear() {
    ++this.generation;
    this.context = null;
    this.draft = null;
    this.items = [];
    this.activeId = null;
    this.model.lastPick = null;
    el('issueDialog').close();
    el('issueImportDialog').close();
    this.tree?.setIssueCounts(new Map());
    this.render();
  }

  async bind(context, data, tree) {
    this.context = { ...context };
    this.data = data;
    this.tree = tree;
    tree.onIssuePick = canonical => {
      const i = this.items.find(i => isOpenIssue(i) && i.node.canonicalId === canonical);
      if (i) this.locate(i.id);
    };
    await this.reload();
  }

  args() { return [this.context.projectId, this.context.modelId, this.context.versionId]; }
  message(text) { el('issueMessage').textContent = text; }

  // ------------------------------------------------ 中英双语
  /** 中文原文：commentZh 是 text 的只读镜像，老记录只有 text 时回退到 text */
  commentZh(issue) { return issue.commentZh || issue.text || ''; }
  commentEn(issue) { return issue.commentEn || ''; }
  /** 列表/详情统一走这一份渲染：中英两段都在 DOM 里，由面板 class 决定谁可见 */
  commentHtml(issue) {
    return `<span class="zh">${esc(this.commentZh(issue))}</span>`
      + `<span class="en">${esc(this.commentEn(issue))}</span>`;
  }
  markerTitle(issue) {
    const en = this.commentEn(issue);
    return `#${issue.number} ${this.commentZh(issue)}${en ? ` ／ ${en}` : ` ／ ${UNTRANSLATED}`}`;
  }

  setDisplayMode(mode) {
    if (!DISPLAY_MODES.includes(mode)) return this.displayMode;
    this.displayMode = mode;
    const panel = el('issuePanel');
    for (const m of DISPLAY_MODES) panel.classList.toggle(`lang-${m}`, m === mode);
    el('issueLangZh').setAttribute('aria-pressed', String(mode === 'zh'));
    el('issueLangEn').setAttribute('aria-pressed', String(mode === 'en'));
    el('issueLangBoth').setAttribute('aria-pressed', String(mode === 'both'));
    return mode;
  }

  // ------------------------------------------------ 导出中文批注（TAB 分隔，可直接粘进 Excel）
  clipboardText() {
    const rows = [...this.items].sort((a, b) => a.number - b.number);
    return ['序号\t中文批注',
      ...rows.map(i => `${issueSeq(i.number)}\t${tsvCell(this.commentZh(i))}`)].join('\n');
  }

  async exportComments() {
    if (!this.items.length) { this.toast('还没有批注可导出', 'err'); return false; }
    const text = this.clipboardText();
    const via = await copyText(text);
    if (!via) {
      this.toast('复制失败：浏览器拒绝了剪贴板写入。请用 https 或 localhost 打开本页，或手动抄录。', 'err');
      return false;
    }
    this.message(`已复制 ${this.items.length} 条批注（序号 + 中文，TAB 分隔）`);
    this.toast(`已复制 ${this.items.length} 条批注（TAB 分隔），可直接粘贴进 Excel`);
    return true;
  }

  // ------------------------------------------------ 导入英文批注
  openImport() {
    if (!access.isInternal) { this.message('当前身份为只读，不能导入翻译。'); return; }
    el('issueImportText').value = '';
    el('issueImportError').textContent = '';
    el('issueImportResult').textContent = '';
    el('issueImportDialog').showModal();
    el('issueImportText').focus();
  }

  async readClipboardIntoDialog() {
    const text = await readText();
    if (text == null) {
      el('issueImportError').textContent = '读不到剪贴板（浏览器未授权或当前不是 https/localhost）。请手动在下面的框里 Ctrl+V 粘贴。';
      el('issueImportText').focus();
      return false;
    }
    el('issueImportText').value = text;
    el('issueImportError').textContent = '';
    return true;
  }

  /** 解析「序号 \t 英文批注」两列。返回 {rows, invalid}；表头行自动跳过，不猜不模糊匹配。 */
  parseImportText(text) {
    const rows = [], invalid = [];
    const lines = String(text ?? '').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const cells = line.split('\t');
      if (HEADER_KEY.test(cells[0].trim())) return;        // 表头行
      if (cells.length < 2) {
        invalid.push({ line: index + 1, text: line.slice(0, 80), reason: 'missing_column' });
        return;
      }
      rows.push({ key: cells[0].trim(), commentEn: cells.slice(1).join(' ').trim(), line: index + 1 });
    });
    return { rows, invalid };
  }

  /** 按序号（或完整 Issue id）匹配并写入英文；只写 commentEn，中文原文不受影响。 */
  async importFromText(text) {
    if (!access.isInternal) return { ok: false, message: '当前身份为只读，不能导入翻译。' };
    if (!this.context) return { ok: false, message: '尚未打开版本。' };
    const { rows, invalid } = this.parseImportText(text);
    if (!rows.length) {
      return { ok: false, message: '没有解析到「序号 + 英文批注」两列数据（需 TAB 分隔）。', invalid };
    }
    const generation = this.generation;
    let data;
    try {
      data = await api.issueTranslations(...this.args(),
        rows.map(r => ({ key: r.key, commentEn: r.commentEn })));
    } catch (e) {
      return { ok: false, message: `导入失败：${e.message}`, invalid };
    }
    if (generation !== this.generation) return { ok: false, message: '版本已切换，本次导入结果未应用。' };
    this.items = data.issues;
    this.render();
    const counts = data.counts || {};
    const parts = [`已写入 ${counts.updated || 0} 条英文批注`];
    if (counts.skipped) parts.push(`${counts.skipped} 条跳过（英文为空）`);
    if (counts.unmatched) parts.push(`${counts.unmatched} 条未匹配`);
    if (invalid.length) parts.push(`${invalid.length} 行格式不对`);
    const message = `${parts.join('，')}。中文批注未被改动。`;
    this.message(message);
    return { ok: true, message, counts, unmatched: data.unmatched || [],
      skipped: data.skipped || [], duplicated: data.duplicated || [], invalid };
  }

  async applyImport() {
    const button = el('issueImportApply');
    if (button.disabled) return null;
    button.disabled = true;
    el('issueImportError').textContent = '';
    el('issueImportResult').textContent = '';
    try {
      const report = await this.importFromText(el('issueImportText').value);
      if (!report.ok) {
        el('issueImportError').textContent = report.message;
        this.toast(report.message, 'err');
        return report;
      }
      const missed = report.unmatched.map(u => u.key).join('、');
      el('issueImportResult').textContent = report.message
        + (missed ? `未匹配的序号：${missed}` : '');
      // 部分写入不算失败：一条没写进去才用红色提示
      const written = report.counts?.updated || 0;
      const kind = written === 0 ? 'err' : (report.unmatched.length || report.invalid.length ? 'warn' : undefined);
      this.toast(report.message, kind);
      if (!report.unmatched.length && !report.invalid.length) el('issueImportDialog').close();
      return report;
    } finally {
      button.disabled = false;
    }
  }

  async reload() {
    if (!this.context) return;
    const generation = ++this.generation;
    this.message('正在加载批注…');
    try {
      const doc = await api.issues(...this.args());
      if (generation !== this.generation) return;
      this.items = doc.issues;
      this.message('');
      this.render();
    } catch (e) {
      if (generation === this.generation) this.message(`批注加载失败：${e.message}。请点击重新加载。`);
    }
  }

  begin(point) {
    if (!this.context || !this.model.ready || !this.model.selected || !access.isInternal) return;
    // 比对模式下 A 侧（叠加的旧版本）只有几何、没有元数据，也没有它的批注存储：
    // 如实拒绝，而不是把批注错记到 B 的同名对象上。
    if (this.model.sideOfKey && this.model.sideOfKey(this.model.selected) === 'A') {
      this.toast('Model A（比对叠加层）只载入几何，不能在此侧新建批注；请切到 B 侧对象。', 'err');
      return;
    }
    const canonicalId = this.model.selected;
    const anchor = this.model.issueAnchor(point);
    if (!anchor) { this.message('无法取得所选对象的位置'); return; }
    const txtId = this.data.idOf(canonicalId);
    this.draft = {
      generation: this.generation, args: this.args(),
      node: { canonicalId, txtId, name: this.data.objectOf(txtId)?.name || canonicalId },
      position: anchor.position, positionSource: anchor.source,
      camera: this.model.captureReviewCamera(),
    };
    el('issueDraftObject').textContent = `${this.draft.node.name} · ${anchor.source === 'surface' ? '表面点击位置' : '对象中心（未命中所选对象表面）'}`;
    el('issueText').value = '';
    el('issueDraftError').textContent = '';
    el('issueSave').disabled = false;
    el('issueDialog').showModal();
    el('issueText').focus();
  }

  async saveDraft() {
    const draft = this.draft, text = el('issueText').value.trim();
    if (!draft || !text || el('issueSave').disabled) return;
    el('issueSave').disabled = true;
    try {
      const issue = await api.createIssue(...draft.args, { ...draft, text });
      if (draft.generation !== this.generation) return;
      this.items.push(issue);
      this.activeId = issue.id;
      this.draft = null;
      el('issueDialog').close();
      el('issuePanel').classList.remove('hidden');
      this.message('已保存');
      this.render();
    } catch (e) {
      if (draft.generation === this.generation) el('issueDraftError').textContent = `保存失败：${e.message}。文字已保留，可重试。`;
    } finally { el('issueSave').disabled = false; }
  }

  open(id) {
    this.activeId = id;
    el('issuePanel').classList.remove('hidden');
    this.renderDetail();
  }

  locate(id) {
    const issue = this.items.find(i => i.id === id);
    if (!issue || !this.model.ready) return;
    this.open(id);
    if (!this.model.nodeByCanonical.has(issue.node.canonicalId)) {
      this.message('关联对象在当前版本中不存在，需重新绑定。');
      return;
    }
    this.model.revealReviewNode(issue.node.canonicalId);
    this.model.select(issue.node.canonicalId);
    this.model.restoreReviewCamera(issue.camera);
    this.message('');
  }

  step(delta) {
    const items = this.items.filter(isOpenIssue);
    if (!items.length) { this.message('没有待处理问题'); return; }
    const index = items.findIndex(i => i.id === this.activeId);
    this.locate(items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length].id);
  }

  async changeStatus(status) {
    const issue = this.items.find(i => i.id === this.activeId);
    if (!issue || !access.isInternal) return;
    const generation = this.generation;
    el('issueStatus').disabled = true;
    try {
      const saved = await api.updateIssue(...this.args(), issue.id, { status, revision: issue.revision });
      if (generation !== this.generation) return;
      this.items = this.items.map(i => i.id === saved.id ? saved : i);
      this.message('状态已保存');
      this.render();
    } catch (e) {
      if (generation === this.generation) { this.message(`状态未保存：${e.message}`); this.renderDetail(); }
    }
  }

  render() {
    const sorted = [...this.items].sort((a, b) => a.number - b.number);
    el('issueList').innerHTML = sorted.length ? sorted.map(i => `<button class="issue-row" data-issue="${esc(i.id)}"><strong>#${issueSeq(i.number)} · ${ISSUE_STATUSES[i.status]}</strong>${this.commentHtml(i)}<small>${esc(i.node.name)} · ${esc(new Date(i.createdAt).toLocaleString())}</small></button>`).join('') : '<p class="issue-empty">暂无批注。选中元件后右键添加。</p>';
    const counts = new Map();
    for (const i of this.items.filter(isOpenIssue)) counts.set(i.node.canonicalId, (counts.get(i.node.canonicalId) || 0) + 1);
    this.tree?.setIssueCounts(counts);
    this.layer.replaceChildren();
    this.markers = this.items.map(issue => {
      const button = document.createElement('button');
      button.className = `issue-marker${isOpenIssue(issue) ? ' unresolved' : ' resolved'}`;
      button.textContent = issue.number;
      button.title = this.markerTitle(issue);
      button.setAttribute('aria-label', `批注 ${issue.number}：${this.commentZh(issue)}`);
      button.onclick = () => this.open(issue.id);
      button.ondblclick = () => this.locate(issue.id);
      this.layer.append(button);
      return { issue, button, world: new THREE.Vector3().fromArray(issue.position), projected: new THREE.Vector3() };
    });
    this.renderDetail();
    this.updateMarkers();
  }

  renderDetail() {
    const issue = this.items.find(i => i.id === this.activeId);
    el('issueDetail').classList.toggle('hidden', !issue);
    el('issueLocate').disabled = !issue;
    if (issue) {
      el('issueDetailText').innerHTML = `<b>#${issueSeq(issue.number)}</b>${this.commentHtml(issue)}`;
      el('issueStatus').value = issue.status;
      el('issueStatus').disabled = !access.isInternal;
    }
    for (const row of el('issueList').querySelectorAll('[data-issue]')) row.classList.toggle('active', row.dataset.issue === this.activeId);
  }

  updateMarkers() {
    const { camera, canvas } = this.model;
    if (!this.markers.length) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    camera.updateMatrixWorld();
    for (const { issue, button, world, projected } of this.markers) {
      projected.copy(world).project(camera);
      const visible = !this.markersHidden && this.model.ready && projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && (!this.mode || isOpenIssue(issue) || issue.id === this.activeId);
      button.hidden = !visible;
      if (visible) button.style.transform = `translate(${(projected.x + 1) * width / 2}px,${(1 - projected.y) * height / 2}px) translate(-50%,-50%)`;
      button.classList.toggle('active', issue.id === this.activeId);
    }
  }
}
