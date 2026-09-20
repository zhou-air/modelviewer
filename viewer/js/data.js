/** 数据层：加载并索引当前版本目录下的 metadata.json / mapping.json / rvm-node-index.json。
 *
 * 三份产物的分工（见 reports/phase3-report.md、phase4-report.md）：
 *   metadata.json        8,955 个 TXT 对象：canonical、层级、全部属性
 *   mapping.json         7,420 条对应：canonical ↔ glbNodeIndex ↔ rvmOffset ↔ txtId
 *   rvm-node-index.json  RVM 技术索引：字节偏移处的几何构成与世界包围盒
 *
 * 路径不再写死：由调用方给出当前版本的 processed/ 目录（base），
 * 因此同一份 Viewer 可以加载任意 Project / Model / Version。
 */

async function getJSON(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!total || !res.body) return res.json();

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder("utf-8").decode(buf));
}

export async function loadData({ base, floorPlanUrl = null, onProgress } = {}) {
  if (!base) throw new Error("loadData 需要 base（当前版本 processed/ 目录的 URL）");
  const url = (name) => `${base.replace(/\/?$/, "/")}${name}`;
  const T = {};
  const files = [
    ["metadata", url("metadata.json")],
    ["mapping", url("mapping.json")],
    ["rvmIndex", url("rvm-node-index.json")],
  ];
  if (floorPlanUrl) files.push(["floorplan", floorPlanUrl]);

  const out = {};
  const loaded = { bytes: 0, total: 0 };
  const tJson = performance.now();
  await Promise.all(files.map(async ([key, u]) => {
    const t0 = performance.now();
    out[key] = await getJSON(u, (got, total) => {
      onProgress?.(got, total, key);
    });
    T[key + "Ms"] = Math.round(performance.now() - t0);
  }));
  T.jsonAllMs = Math.round(performance.now() - tJson);

  const tIdx = performance.now();

  const meta = out.metadata;
  const objects = meta.objects;

  // canonical → txtId
  const byCanonical = new Map();
  for (const [id, o] of Object.entries(objects)) byCanonical.set(o.canonical, id);

  // 每个对象的子节点数 + 是否有几何（来自 mapping）
  const pairs = out.mapping.pairs;
  const geomOf = new Map();                       // canonical → 映射边
  for (const [canon, p] of Object.entries(pairs)) geomOf.set(canon, p);

  // rvmOffset → 几何构成 / 包围盒
  const rvmByOffset = new Map();
  for (const g of out.rvmIndex.groups) rvmByOffset.set(g.offset, g);

  T.indexBuildMs = Math.round(performance.now() - tIdx);

  return {
    base,
    timings: T,
    meta, mapping: out.mapping, rvmIndex: out.rvmIndex, floorplan: out.floorplan || null,
    objects, byCanonical, geomOf, rvmByOffset,
    stats: meta.stats,
    roots: meta.roots,
    objectOf: (id) => objects[id],
    idOf: (canonical) => byCanonical.get(canonical) ?? null,
  };
}
