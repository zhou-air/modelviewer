/** 访问权限前端层：只消费后端 /api/access/status 的判定结果，前端不做任何身份决定。
 *
 * 职责：
 *   1. 外网（ANONYMOUS）显示访问码输入门，登录成功后刷新页面重建整个应用。
 *   2. 把权限位（access.perms）暴露给 AssetManager / app.js 做 UI 裁剪；
 *      注意：UI 只是显示层，后端才是最终权限来源。
 *   3. 内网首页渲染"今日内部访问码"卡片；非内网身份显示角色徽标 + 退出访问。
 */

import { api } from './api.js';

const ROLE_LABEL = {
  INTERNAL_NETWORK: '内网 · 完整权限',
  INTERNAL_REMOTE: '外部员工 · 全项目只读',
  CLIENT_PROJECT: '客户 · 单项目只读',
  ANONYMOUS: '未验证访问',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand && document.execCommand('copy');
  ta.remove();
  return !!ok;
}

export const access = {
  status: null,
  role: 'ANONYMOUS',
  perms: {},

  get isInternal() { return this.role === 'INTERNAL_NETWORK'; },

  /** app.js 启动时最先调用。外网无 Session 时阻塞在访问码门上。 */
  async init() {
    const el = (id) => document.getElementById(id);
    try {
      this.status = await api.accessStatus();
    } catch (e) {
      return;                       // 后端不可达：交给 AssetManager 的横幅去报错
    }
    this.role = this.status.role || 'ANONYMOUS';
    this.perms = this.status.permissions || {};
    if (this.role === 'ANONYMOUS') {
      await this._gate(el);
      // _gate 内部登录成功后执行 location.reload()，不会走到这里
    }
  },

  /** 外网访问门：一个输入框，服务器自动区分内部码 / 项目码 */
  _gate(el) {
    return new Promise((resolve) => {
      const gate = el('accessGate');
      const input = el('gateCode');
      const err = el('gateError');
      const btn = el('gateEnter');
      gate.classList.add('on');
      setTimeout(() => input.focus(), 60);
      const submit = async () => {
        const code = input.value.trim();
        if (!code) return;
        btn.disabled = true;
        btn.textContent = '验证中…';
        err.classList.remove('on');
        try {
          await api.accessLogin(code);
          location.reload();          // Session Cookie 已种下，重载后按新身份装配
        } catch (e) {
          err.textContent = e.message || '访问码无效或已失效';
          err.classList.add('on');
          btn.disabled = false;
          btn.textContent = '进入';
          input.focus();
          input.select();
        }
      };
      btn.onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
  },

  /** 启动层可见后的界面裁剪：角色徽标 / 隐藏管理入口 / 今日内部码卡片 */
  async applyChrome() {
    const el = (id) => document.getElementById(id);
    const badge = el('roleBadge');
    if (!badge) return;
    const label = ROLE_LABEL[this.role] || this.role;
    const sub = this.role === 'CLIENT_PROJECT' && this.status?.projectName
      ? ` · ${esc(this.status.projectName)}` : '';
    badge.innerHTML = `<span class="rb-role ${esc(this.role)}">${esc(label)}</span>${sub}`;

    // 管理入口只对内网显示（后端同样拒绝，这里只是不显示）
    const internal = this.isInternal;
    for (const id of ['pmNew', 'pmImport', 'btnImportTop']) {
      const n = el(id);
      if (n) n.classList.toggle('hidden', !internal);
    }

    // 非内网身份：退出访问
    if (this.role !== 'INTERNAL_NETWORK') {
      const sp = document.querySelector('#launcher header .sp');
      const btn = document.createElement('button');
      btn.id = 'btnAccessLogout';
      btn.textContent = '退出访问';
      btn.onclick = async () => { try { await api.accessLogout(); } catch { /* ignore */ } location.reload(); };
      sp.insertBefore(btn, sp.firstChild);
    }

    // 内网：今日内部访问码卡片（默认打码隐藏，显示/复制随时可用）
    if (internal) {
      try {
        const ic = await api.internalCode();
        const host = el('internalCodeCard');
        host.classList.remove('hidden');
        const mask = '•'.repeat(ic.code.length);
        host.innerHTML =
          `<h3>今日内部访问码</h3>
           <div class="ic-row">
             <span class="ic-code" id="icCode">${esc(mask)}</span>
             <button id="icToggle">显示</button>
             <button id="icCopy">复制</button>
           </div>
           <div class="mut small">今日有效 · 外网同事凭此码进入全项目只读模式，明日自动更换</div>`;
        host.querySelector('#icToggle').onclick = (e) => {
          const shown = e.target.textContent === '显示';
          e.target.textContent = shown ? '隐藏' : '显示';
          host.querySelector('#icCode').textContent = shown ? ic.code : mask;
        };
        host.querySelector('#icCopy').onclick = async (e) => {
          e.target.textContent = await copyText(ic.code) ? '已复制' : '复制失败';
          setTimeout(() => { e.target.textContent = '复制'; }, 1600);
        };
      } catch { /* 非内网或后端异常：卡片保持隐藏 */ }
    }
  },
};
