/** 项目资料面板。只依赖项目与文件 API，不依赖 Model、Version 或 Three.js。 */
import { api, uploadProjectFile } from './api.js';
import { access } from './access.js';

export const MAX_PROJECT_FILE_BYTES = 100 * 1024 * 1024;
export const PROJECT_FILE_TYPES = ['CAD', 'PDF', 'Spreadsheet', 'Document', 'Image', 'Other'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 组合文件名搜索和分类筛选；相同时间维持后端返回的稳定次序。 */
export function filterProjectFiles(files, search = '', type = '') {
  const query = search.trim().toLocaleLowerCase();
  return files.map((file, index) => ({ file, index }))
    .filter(({ file }) => (!type || file.type === type)
      && (!query || String(file.fileName).toLocaleLowerCase().includes(query)))
    .sort((a, b) => ((Date.parse(b.file.uploadedAt) || 0) - (Date.parse(a.file.uploadedAt) || 0))
      || a.index - b.index)
    .map(({ file }) => file);
}

export class ProjectFiles {
  constructor({ root, deleteFile }) {
    this.root = root;
    this.deleteFile = deleteFile;
    this.projectId = null;
    this.projectName = '';
    this.files = [];
    this.search = '';
    this.type = '';
    this.maxFileBytes = MAX_PROJECT_FILE_BYTES;
    this.loading = false;
    this.error = null;
    this.upload = null;
    this.deleting = new Set();
    this._requestId = 0;
    this._build();
    this.render();
  }

  _build() {
    this.root.innerHTML = '<div class="pf-head"><h3>Project Files</h3>'
      + '<span id="projectFilesProject" class="mut small"></span></div>'
      + '<div class="pf-toolbar">'
      + '<input id="projectFilesSearch" type="text" placeholder="搜索文件名" aria-label="搜索项目文件名">'
      + '<select id="projectFilesType" aria-label="项目文件 Type 分类">'
      + '<option value="">All Types</option>'
      + PROJECT_FILE_TYPES.map((type) => `<option value="${type}">${type}</option>`).join('')
      + '</select><button id="projectFilesUpload" class="primary">Upload File</button>'
      + '<input id="projectFilesInput" type="file" multiple hidden></div>'
      + '<div id="projectFilesStatus" class="pf-status small" role="status" aria-live="polite"></div>'
      + '<div id="projectFilesTable" class="pf-table-wrap"></div>'
      + '<div id="projectFilesCount" class="mut small pf-count"></div>';
    const el = (id) => this.root.querySelector(`#${id}`);
    this.projectEl = el('projectFilesProject');
    this.searchEl = el('projectFilesSearch');
    this.typeEl = el('projectFilesType');
    this.uploadEl = el('projectFilesUpload');
    this.inputEl = el('projectFilesInput');
    this.statusEl = el('projectFilesStatus');
    this.tableEl = el('projectFilesTable');
    this.countEl = el('projectFilesCount');
    this.searchEl.addEventListener('input', () => { this.search = this.searchEl.value; this.renderTable(); });
    this.typeEl.addEventListener('change', () => { this.type = this.typeEl.value; this.renderTable(); });
    this.uploadEl.onclick = () => {
      if (!this.projectId || !access.perms.manageProjects || this.upload?.running) return;
      // 文件选择器打开期间即使项目改变，选择的文件仍只上传到打开选择器时的项目。
      this._pickerProject = { id: this.projectId, name: this.projectName };
      this.inputEl.click();
    };
    this.inputEl.addEventListener('change', () => {
      const files = Array.from(this.inputEl.files || []);
      const target = this._pickerProject || { id: this.projectId, name: this.projectName };
      this._pickerProject = null;
      this.inputEl.value = '';
      if (files.length && target) this.uploadFiles(files, target);
    });
    this.inputEl.addEventListener('cancel', () => { this._pickerProject = null; });
    this.tableEl.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-file-delete]');
      if (!button) return;
      const file = this.files.find((item) => item.id === button.dataset.fileDelete);
      if (file) this.removeFile(this.projectId, file);
    });
  }

  setProject(project, { force = false } = {}) {
    const id = project?.id || null;
    const changed = id !== this.projectId;
    this.projectName = project?.name || '';
    if (changed) {
      this.projectId = id;
      this.files = [];
      this.search = '';
      this.type = '';
      this.searchEl.value = '';
      this.typeEl.value = '';
      this.error = null;
      this.loading = false;
      ++this._requestId;
    }
    this.render();
    if (id && (changed || force)) return this.refresh();
    return Promise.resolve();
  }

  async refresh() {
    const projectId = this.projectId;
    if (!projectId) return;
    const requestId = ++this._requestId;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const data = await api.projectFiles(projectId);
      if (this.projectId !== projectId || requestId !== this._requestId) return;
      this.files = (data.files || []).filter((file) => file.projectId === projectId);
      this.maxFileBytes = Math.min(data.maxFileBytes || MAX_PROJECT_FILE_BYTES, MAX_PROJECT_FILE_BYTES);
    } catch (error) {
      if (this.projectId !== projectId || requestId !== this._requestId) return;
      this.files = [];
      this.error = `读取项目文件失败：${error.message}`;
    } finally {
      if (this.projectId === projectId && requestId === this._requestId) {
        this.loading = false;
        this.render();
      }
    }
  }

  render() {
    this.projectEl.textContent = this.projectId ? this.projectName : '未选择项目';
    this.projectEl.title = this.projectName;
    this.root.dataset.projectId = this.projectId || '';
    this.searchEl.disabled = !this.projectId;
    this.typeEl.disabled = !this.projectId;
    this.uploadEl.classList.toggle('hidden', !access.perms.manageProjects);
    this.uploadEl.disabled = !this.projectId || !!this.upload?.running;
    this.renderStatus();
    this.renderTable();
  }

  renderStatus() {
    const upload = this.upload;
    let html = '';
    if (upload) {
      const target = `项目「${upload.projectName}」`;
      if (upload.running) {
        const percent = upload.totalBytes ? Math.round(upload.loaded / upload.totalBytes * 100) : 0;
        html = `${esc(target)} · 正在上传 ${upload.index} / ${upload.total}：${esc(upload.fileName)} `
          + `(${percent}% · ${fmtBytes(upload.loaded)} / ${fmtBytes(upload.totalBytes)})`;
      } else {
        html = `${esc(target)} · 已上传 ${upload.successes} / ${upload.total} 个文件`
          + (upload.failures.length ? `，${upload.failures.length} 个失败` : '。');
      }
      if (upload.failures.length) {
        html += '<ul class="pf-failures">' + upload.failures.map((item) =>
          `<li>${esc(item.name)}：${esc(item.message)}</li>`).join('') + '</ul>';
      }
    }
    if (this.error) html += `<div class="pf-error">${esc(this.error)}</div>`;
    this.statusEl.innerHTML = html;
    this.statusEl.classList.toggle('hidden', !html);
  }

  renderTable() {
    const canManage = !!access.perms.manageProjects;
    const filtered = filterProjectFiles(this.files, this.search, this.type);
    let empty = '';
    if (!this.projectId) empty = '选择一个 Project 后管理项目资料。';
    else if (this.loading && !this.files.length) empty = '正在读取项目文件…';
    else if (this.error && !this.files.length) empty = '项目文件暂时不可用，请点击顶部刷新重试。';
    else if (!this.files.length) empty = canManage ? '还没有项目文件，点击 Upload File 上传。' : '还没有项目文件。';
    else if (!filtered.length) empty = '没有符合文件名和 Type 筛选条件的文件。';
    const columns = canManage ? 6 : 5;
    this.tableEl.innerHTML = '<table class="pf-table"><thead><tr>'
      + '<th>File Name</th><th>Type</th><th>Size</th><th>Uploaded Time ↓</th><th>Download</th>'
      + (canManage ? '<th>Delete</th>' : '') + '</tr></thead><tbody>'
      + (empty ? `<tr><td colspan="${columns}" class="pf-empty">${esc(empty)}</td></tr>`
        : filtered.map((file) => `<tr data-file-id="${esc(file.id)}">`
          + `<td class="pf-name" title="${esc(file.fileName)}">${esc(file.fileName)}</td>`
          + `<td>${esc(file.type)}</td><td class="pf-size">${esc(fmtBytes(file.size))}</td>`
          + `<td class="pf-time" title="${esc(file.uploadedAt)}">${esc(fmtTime(file.uploadedAt))}</td>`
          + `<td><a class="pf-download" href="${esc(api.projectFileDownloadUrl(this.projectId, file.id))}" download="${esc(file.fileName)}" aria-label="${esc(`下载 ${file.fileName}`)}">Download</a></td>`
          + (canManage ? `<td><button data-file-delete="${esc(file.id)}" aria-label="${esc(`删除 ${file.fileName}`)}"${this.deleting.has(`${this.projectId}/${file.id}`) ? ' disabled' : ''}>Delete</button></td>` : '')
          + '</tr>').join(''))
      + '</tbody></table>';
    this.countEl.textContent = this.projectId
      ? `${filtered.length} / ${this.files.length} 个文件 · 最新上传在前${canManage ? ' · 单文件最大 100 MB' : ''}` : '';
  }

  async uploadFiles(files, project = { id: this.projectId, name: this.projectName }) {
    if (!project.id || !files.length || !access.perms.manageProjects || this.upload?.running) return;
    const projectId = project.id;
    const upload = this.upload = {
      projectId, projectName: project.name, total: files.length, index: 0,
      fileName: '', loaded: 0, totalBytes: 0, running: true, successes: 0, failures: [],
    };
    const limit = this.maxFileBytes;
    this.render();
    for (const file of Array.from(files)) {
      upload.index += 1;
      upload.fileName = file.name;
      upload.loaded = 0;
      upload.totalBytes = file.size;
      this.renderStatus();
      if (file.size > limit) {
        upload.failures.push({ name: file.name, message: '超过单文件 100 MB 限制' });
        this.renderStatus();
        continue;
      }
      try {
        const record = await uploadProjectFile(projectId, file, (loaded, total) => {
          upload.loaded = loaded;
          upload.totalBytes = total;
          this.renderStatus();
        });
        upload.successes += 1;
        if (this.projectId === projectId && record.projectId === projectId) {
          ++this._requestId; // 已提交的新记录不能被先前发出的读取响应覆盖。
          this.loading = false;
          this.error = null;
          this.files = [record, ...this.files.filter((item) => item.id !== record.id)];
          this.renderTable();
        }
      } catch (error) {
        upload.failures.push({ name: file.name, message: error.message });
      }
    }
    upload.running = false;
    this.render();
    if (this.projectId === projectId && upload.successes) await this.refresh();
  }

  async removeFile(projectId, file) {
    if (!projectId || !access.perms.manageProjects) return;
    const key = `${projectId}/${file.id}`;
    if (this.deleting.has(key)) return;
    this.deleting.add(key);
    this.renderTable();
    try {
      const removed = await this.deleteFile(projectId, file);
      if (removed && this.projectId === projectId) await this.refresh();
    } catch (error) {
      if (this.projectId === projectId) {
        this.error = `删除文件失败：${error.message}`;
        this.renderStatus();
      }
    } finally {
      this.deleting.delete(key);
      this.renderTable();
    }
  }
}
