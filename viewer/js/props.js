/** 属性面板：展示选中 TXT 对象的全部属性与它在几何侧的对应信息。 */

const GEOM_KIND_CN = {
  Pyramid: "棱锥", Box: "长方体", RectangularTorus: "矩形环", CircularTorus: "圆环",
  EllipticalDish: "椭圆封头", SphericalDish: "球面封头", Snout: "锥颈", Cylinder: "圆柱",
  Sphere: "球", Line: "线", FacetGroup: "面片组",
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function fmt(v) {
  if (Array.isArray(v)) {
    const items = v.map((x) => `<div>${esc(x)}</div>`).join("");
    return `${items}<span style="color:#9aa0a6">（重复键 ${v.length} 条）</span>`;
  }
  return esc(v);
}

function table(rows) {
  return "<table>" + rows.map(([k, v, cls]) =>
    `<tr><td class="k">${esc(k)}</td><td class="v${cls ? " " + cls : ""}">${v}</td></tr>`).join("") + "</table>";
}

export class PropsPanel {
  constructor(host, infoEl, data) {
    this.host = host;
    this.infoEl = infoEl;
    this.data = data;
  }

  /** 切换版本：换数据源并清空面板，避免残留上一版本的对象属性。 */
  setData(data) {
    this.data = data;
    this.clear();
  }

  clear() {
    this.infoEl.textContent = "未选中";
    this.host.innerHTML = '<div class="empty">点击 3D 对象或左侧树节点。</div>';
  }

  /** 比对模式下选中 Model A（叠加的旧版本）时显示：
   *  如实说明"来源 = A、本侧只载入几何"，而不是拿 B 的同名元数据顶上去。 */
  showCompareSource(meta, canonical) {
    const label = meta?.versionName || meta?.label || '（未命名版本）';
    this.infoEl.textContent = `Model A · ${label} · 仅几何`;
    this.host.innerHTML = '<div class="sec">比对来源</div>'
      + table([
        ["来源", "<b>Model A</b>（叠加显示的那一版）"],
        ["版本", esc(label)],
        ["模型", esc(meta?.modelName || "—")],
        ["canonical", `<b>${esc(canonical)}</b>`],
      ])
      + '<div class="empty">A 侧只载入几何（GLB），未加载该版本的元数据：'
      + '属性、模型树、批注、测量命名仍严格属于当前打开的版本（B）。</div>';
  }

  show(txtId) {
    const d = this.data;
    const o = d.objectOf(txtId);
    if (!o) { this.clear(); return; }

    // 仅 RVM 导入的版本：没有 TXT，属性、原文行号、类型（有名对象）本来就取不到
    const rvmOnly = d.meta?.metadataSource === "rvm";
    const pair = d.geomOf.get(o.canonical);
    const rvm = pair ? d.rvmByOffset.get(pair.rvmOffset) : null;

    this.infoEl.textContent = `${o.type || "类型未知"} · ${o.children.length} 个子节点`
      + (pair ? "" : " · RVM 未导出几何");

    let html = "";

    // ---- 概览 ----
    html += '<div class="sec">概览</div>';
    const noType = o.type ? esc(o.type) : '—（RVM 只有匿名对象带类型前缀）';
    const ov = [
      ["类型", noType],
      ["canonical", `<b>${esc(o.canonical)}</b>`],
      ["原始名称", o.name ? esc(o.name) : "（匿名对象）"],
      ["层级深度", String(o.depth)],
      ["父节点", o.parent ? esc(d.objectOf(o.parent).canonical) : "（根）"],
      ["子节点数", String(o.children.length)],
      ["原文行", (o.line === null || o.line === undefined)
        ? '—（RVM 无原文行）' : `${o.line} – ${o.lineEnd}`],
    ];
    html += table(ov);

    // ---- 几何对应（Phase 4 的映射结果）----
    html += '<div class="sec">几何对应</div>';
    if (pair) {
      const rows = [
        ["GLB 节点序号", String(pair.glbNodeIndex)],
        ["RVM 字节偏移", `<b>${pair.rvmOffset}</b>`],
        [rvmOnly ? "对象锚定 id" : "TXT 行锚定 id", esc(pair.txtId)],
        ["匹配通道", esc(pair.channel)],
      ];
      html += table(rows);
      if (rvm) {
        const bb = rvm.bboxWorldM;
        const kinds = Object.entries(rvm.geometryKinds || {})
          .map(([k, n]) => `${GEOM_KIND_CN[_kindName(k)] || k}×${n}`).join("、");
        html += table([
          ["几何块数", String(rvm.directGeometryCount)],
          ["几何构成", kinds || "（无直属几何，为容器组）"],
          ["世界包围盒 (m)",
            bb ? `E ${bb[0].toFixed(2)}…${bb[3].toFixed(2)} · N ${bb[1].toFixed(2)}…${bb[4].toFixed(2)} · U ${bb[2].toFixed(2)}…${bb[5].toFixed(2)}` : "—"],
        ]);
      }
    } else {
      html += '<div class="cap">该对象在 RVM/GLB 中没有对应几何（属无实体几何的设计或辅助对象），'
        + '因此不能在 3D 视图中选中。属性仍然完整。</div>';
    }

    // ---- PDMS 属性 ----
    const pdmsKeys = o.propOrder || [];
    html += `<div class="sec">PDMS 属性（${pdmsKeys.length}）</div>`;
    if (pdmsKeys.length) {
      html += table(pdmsKeys.map((k) => [k, fmt(o.props[k])]));
    } else if (rvmOnly) {
      // 必须说清"为什么空"：这不是丢数据，是这条导入链路本来就没有属性源
      html += '<div class="cap">该版本按<b>仅 RVM</b>导入，RVM 文件本身不含工程属性'
        + '（POS / 管径 / 压力 / 温度 / 描述 / 保温等只存在于 PDMS Data Listing）。'
        + '如需属性，请带 <code>.txt</code> 重新导入一个版本 —— 两个版本会并存，可直接比对。</div>';
    } else {
      html += '<div class="cap">无</div>';
    }

    // ---- 引用区块属性（OLD）----
    const ovKeys = o.overrideOrder || [];
    if (ovKeys.length) {
      html += `<div class="sec">引用区块属性（${ovKeys.length}）</div>`;
      html += '<div class="cap">来自文件后段的 OLD 选择器区块：HREF/TREF/CREF 是管线连接关系，RULE 是规则表达式。</div>';
      html += table(ovKeys.map((k) => [k, fmt(o.override[k])]));
    }

    this.host.innerHTML = html;
  }
}

function _kindName(k) {
  const map = { "1": "Pyramid", "2": "Box", "3": "RectangularTorus", "4": "CircularTorus",
    "5": "EllipticalDish", "6": "SphericalDish", "7": "Snout", "8": "Cylinder",
    "9": "Sphere", "10": "Line", "11": "FacetGroup" };
  return map[k] || `#${k}`;
}
