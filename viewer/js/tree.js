/** 模型树：按 metadata.json 的层级渲染 SITE → ZONE → PIPE → BRANCH → 元件……
 *
 *  · 懒展开：8955 个节点不能一次性铺进 DOM，只渲染已展开的部分。
 *  · 灰显 = 该对象在 TXT 中有、但 RVM 未导出几何（没有 3D 对应），仍可查看属性。
 *  · 与 3D 双向联动：外部 select(canonical) 会自动展开祖先并滚动到可见位置。
 */

export class ModelTree {
  constructor(host, data, { onPick } = {}) {
    this.host = host;
    this.data = data;
    this.onPick = onPick;
    this.rows = new Map();          // txtId → row element
    this.expanded = new Set();
    this.selectedId = null;
    this.selectedIds = new Set();   // CTRL 多选集合（含 selectedId；普通点击/3D 联动会重置为单元素）
    host.addEventListener('click', (e) => this._onClick(e));
    this._build();
  }

  /** 换到另一个版本：清掉旧的 DOM 与索引后按新 metadata 重建。
   *  必须复用同一个实例 —— 每次 new 都会在 host 上再挂一个 click 监听，切换多次就叠加多次。 */
  setData(data) {
    this.data = data;
    this.host.innerHTML = '';
    this.rows.clear();
    this.expanded.clear();
    this.selectedId = null;
    this.selectedIds.clear();
    this._build();
  }

  _shortLabel(o) {
    if (o.name) return o.name;
    const parts = o.canonical.split(" ");
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : o.canonical;
  }

  _rowHtml(o) {
    const has3d = this.data.geomOf.has(o.canonical);
    const kids = o.children.length;
    const tw = kids ? "▸" : "";
    const label = this._shortLabel(o);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `<div class="row${has3d ? "" : " nogeo"}" data-id="${o.id}" title="${esc(o.canonical)}">`
      + `<span class="tw${kids ? "" : " leaf"}">${tw}</span>`
      + `<span class="nm">${esc(label)}</span>`
      + `<span class="tp">${esc(o.type)}</span>`
      + (has3d ? "" : `<span class="mark" title="RVM 未导出几何">·无几何</span>`)
      + `</div>`;
  }

  _build() {
    const frag = document.createDocumentFragment();
    for (const rootId of this.data.roots) {
      frag.appendChild(this._nodeEl(rootId));
    }
    this.host.appendChild(frag);
    for (const rootId of this.data.roots) this.toggle(rootId, true);
  }

  _nodeEl(id) {
    const o = this.data.objectOf(id);
    const wrap = document.createElement("div");
    wrap.dataset.id = id;
    wrap.innerHTML = this._rowHtml(o);
    this.rows.set(id, wrap.firstElementChild);
    return wrap;
  }

  _kidsEl(wrap, id) {
    let k = wrap.querySelector(":scope > .kids");
    if (!k) {
      k = document.createElement("div");
      k.className = "kids";
      wrap.appendChild(k);
      for (const cid of this.data.objectOf(id).children) {
        k.appendChild(this._nodeEl(cid));
      }
    }
    return k;
  }

  toggle(id, open) {
    const wrap = this.host.querySelector(`div[data-id="${CSS.escape(id)}"]`);
    const row = wrap?.firstElementChild;
    if (!wrap || !row) return;
    const isOpen = this.expanded.has(id);
    const want = open === undefined ? !isOpen : open;
    const tw = row.querySelector(".tw");
    if (want) {
      this._kidsEl(wrap, id);
      wrap.querySelector(":scope > .kids").style.display = "";
      this.expanded.add(id);
      if (tw && !tw.classList.contains("leaf")) tw.textContent = "▾";
    } else {
      const k = wrap.querySelector(":scope > .kids");
      if (k) k.style.display = "none";
      this.expanded.delete(id);
      if (tw && !tw.classList.contains("leaf")) tw.textContent = "▸";
    }
  }

  _onClick(e) {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = row.dataset.id;
    const o = this.data.objectOf(id);
    if (e.target.classList.contains("tw") && o.children.length) {
      this.toggle(id);
      return;
    }
    // CTRL（或 ⌘）多选：切换该行的选中态，不影响其他已选行。
    // 两个方向都联动 3D（加入 = additive 选中，移出 = 同一 additive 语义的切换关闭），
    // 否则 3D 高亮会与树上的选择集不一致。
    if (e.ctrlKey || e.metaKey) {
      if (this.selectedIds.has(id)) {
        this._dropFromSelection(id);
        this.onPick?.(id, o, { additive: true, remove: true });
      } else {
        this.select(id, { scroll: false, expandAncestors: false, additive: true });
        this.onPick?.(id, o, { additive: true });
      }
      return;
    }
    // 展开只认倒三角：点行文本一律只选中，不再自动展开子级
    this.select(id, { scroll: false });
    this.onPick?.(id, o);
  }

  /** 从多选集合中移除一行；主选中退到剩余集合的最后一个（可能与 3D 选中不再一致，见上） */
  _dropFromSelection(id) {
    this.selectedIds.delete(id);
    this.rows.get(id)?.classList.remove("sel");
    if (this.selectedId === id) {
      this.selectedId = [...this.selectedIds].pop() || null;
    }
  }

  /** 展开某行的所有祖先（懒渲染：不展开就不存在对应 DOM，也就无法加高亮） */
  _expandAncestors(id) {
    const chain = [];
    let cur = this.data.objectOf(id);
    while (cur?.parent) { chain.push(cur.parent); cur = this.data.objectOf(cur.parent); }
    for (const pid of chain.reverse()) this.toggle(pid, true);
  }

  /** 选中并高亮；可选展开祖先、滚动到可见处。
   *  additive=true（树内 CTRL 多选）时在现有集合上追加；否则重置为单选。 */
  select(id, { scroll = true, expandAncestors = true, additive = false } = {}) {
    if (!id) return;
    if (expandAncestors) this._expandAncestors(id);
    const prev = new Set(this.selectedIds);
    if (additive) {
      this.selectedIds.add(id);
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(id);
    }
    this.selectedId = id;
    // 只刷新新旧差集涉及的行，避免大集合下整树重刷
    for (const rid of prev) {
      if (!this.selectedIds.has(rid)) this.rows.get(rid)?.classList.remove("sel");
    }
    const row = this.rows.get(id);
    if (row) {
      row.classList.add("sel");
      if (scroll) row.scrollIntoView({ block: "nearest" });
    }
  }

  /** 用外部（3D 选择集）整体替换树的选择集 —— 让 Ctrl 多选在 3D 与树两侧始终是同一份。
   *  primary = 主选中行（滚动定位用）；本方法不触发 onPick，避免联动回环。 */
  setSelection(ids, { primary = null, scroll = false } = {}) {
    const next = new Set(ids || []);
    for (const rid of next) this._expandAncestors(rid);      // 先让每行真实存在
    for (const rid of this.selectedIds) {
      if (!next.has(rid)) this.rows.get(rid)?.classList.remove("sel");
    }
    for (const rid of next) this.rows.get(rid)?.classList.add("sel");
    this.selectedIds = next;
    // primary 必须真的在集合里：3D 里有、TXT 里没有的节点没有对应树行，
    // 无条件 select 会把不存在的行塞进选择集
    if (primary && next.has(primary)) {
      this.selectedId = primary;
      if (scroll) this.rows.get(primary)?.scrollIntoView({ block: "nearest" });
    } else {
      this.selectedId = [...next].pop() || null;
    }
  }

  /** 3D 选中 canonical 后同步定位到树上 */
  selectCanonical(canonical, opts) {
    const id = this.data.idOf(canonical);
    if (id) this.select(id, opts);
    return id;
  }
  counts() {
    return { total: this.data.meta.stats.objects, rendered: this.rows.size };
  }
}
