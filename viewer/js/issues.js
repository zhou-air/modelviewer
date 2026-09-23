import * as THREE from 'three';
import { api } from './api.js';
import { access } from './access.js';

export const ISSUE_STATUSES = { open: '待修改', review: '已修改待复核', closed: '已关闭', wontfix: '无需修改' };
export const isOpenIssue = i => i.status === 'open' || i.status === 'review';
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Isolated review UI; uses the viewer's semantic selection, raycast and camera APIs. */
export class IssueController {
  constructor(model) {
    this.model = model;
    this.items = [];
    this.generation = 0;
    this.markers = [];
    this.mode = false;
    // 批注标记默认不遮挡模型，用户可通过面板按钮主动显示。
    this.markersHidden = true;
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
    el('issueList').innerHTML = this.items.length ? this.items.map(i => `<button class="issue-row" data-issue="${esc(i.id)}"><strong>#${i.number} · ${ISSUE_STATUSES[i.status]}</strong><span>${esc(i.text)}</span><small>${esc(i.node.name)} · ${esc(new Date(i.createdAt).toLocaleString())}</small></button>`).join('') : '<p class="issue-empty">暂无批注。选中元件后右键添加。</p>';
    const counts = new Map();
    for (const i of this.items.filter(isOpenIssue)) counts.set(i.node.canonicalId, (counts.get(i.node.canonicalId) || 0) + 1);
    this.tree?.setIssueCounts(counts);
    this.layer.replaceChildren();
    this.markers = this.items.map(issue => {
      const button = document.createElement('button');
      button.className = `issue-marker${isOpenIssue(issue) ? ' unresolved' : ' resolved'}`;
      button.textContent = issue.number;
      button.title = `#${issue.number} ${issue.text}`;
      button.setAttribute('aria-label', `批注 ${issue.number}：${issue.text}`);
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
      el('issueDetailText').textContent = `#${issue.number} ${issue.text}`;
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
