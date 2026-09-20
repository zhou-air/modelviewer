"""③ 映射层 —— 建立 RVM(几何) ↔ TXT(元数据) 的对象对应关系。

产物：data/processed/mapping.json
  · pairs：以 canonical 名为主键，附 GLB 节点序号 + RVM 字节偏移（技术 id）+ TXT 对象 id
  · stats：匹配率与未匹配统计
  · unmatched：双端未匹配清单，按可查证的原因分类，**不猜**

匹配通道（逐级回退，可查证性由高到低）
  1) 名称：canonical 名与 RVM/GLB 节点名完全相同
  2) 归一化名称：合并重复斜杠、压缩空白、大小写不敏感后相同
  3) 结构：（类型 + 同类型序号 + 父对象）递归重建名字后相同
  4) 坐标：TXT 的 POS/HPOS 落在 RVM 组的世界包围盒内
  —— 第 4 通道**只用于校验已匹配的边**，不作为独立配对依据（最弱，且易假阳）。

用法：
    python converter/map_objects.py
    python converter/map_objects.py --meta data/processed/metadata.json --glb data/processed/model.glb
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
EVID = ROOT / "reports" / "evidence"

# PDMS 坐标是「方向字母 + 数值」三连，方向有正负之分：
#   E 向东 / W 向西(= -E)      N 向北 / S 向南(= -N)      U 向上 / D 向下(= -U)
# 例： "W 29895mm N 705mm U 6975mm" / "E 3757mm N 2113mm D 45.5mm"
POS_RE = re.compile(
    r"([EWNSUD])\s+(-?[\d.]+)\s*mm\s*"
    r"([EWNSUD])\s+(-?[\d.]+)\s*mm\s*"
    r"([EWNSUD])\s+(-?[\d.]+)\s*mm",
    re.IGNORECASE)
_AXIS = {"E": (0, +1), "W": (0, -1), "N": (1, +1), "S": (1, -1), "U": (2, +1), "D": (2, -1)}

# 在 RVM 中完全没有对应几何的 TXT 类型（用于给未匹配项归类；由数据统计得出，非人工臆断）
# 这里只放"判定为结构性无几何"的类型，其余一律标 reason="需人工确认"。
NON_GEOMETRIC_HINT = {
    "POINT", "PAVERT", "POGON", "VERTEX", "DATUM", "POINSP",
    "DPCARTESIAN", "DPSPHERICAL", "DPSET", "DDSE", "DDATA", "VVALUE",
    "LOOP", "GENSEC", "SPINE", "CURVE", "PCOMPONENT",
}


def norm_name(s: str) -> str:
    """归一化：折叠重复斜杠、压缩空白、去掉首尾空白（不改大小写，PDMS 名区分大小写）。"""
    s = re.sub(r"/{2,}", "/", s.strip())
    s = re.sub(r"\s+", " ", s)
    return s


def load_glb_index(path: Path) -> dict:
    raw = path.read_bytes()
    off, J = 12, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        if ctype == 0x4E4F534A:
            J = json.loads(raw[off + 8:off + 8 + clen].decode("utf-8"))
        off += 8 + clen
        off += (-clen) % 4
    nodes = J["nodes"]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children") or []:
            parent[c] = i
    named = {}
    for i, n in enumerate(nodes):
        nm = n.get("name")
        if nm:
            named.setdefault(nm, i)          # 名字唯一，重复时保留首个
    return {
        "nodeCount": len(nodes),
        "named": named,
        "parent": parent,
        "hasMesh": [("mesh" in n) for n in nodes],
        "nodes": nodes,
    }


def parse_enu(value: str):
    """解析 "E 9723mm N 23320mm U 4154.5mm" 之类 → (E, N, U) 毫米；方向字母带符号。"""
    m = POS_RE.search(value)
    if not m:
        return None
    out = [None, None, None]
    for i in range(3):
        letter = m.group(1 + 2 * i).upper()
        axis, sign = _AXIS[letter]
        if out[axis] is not None:
            return None                     # 同一轴出现两次 → 不认，避免误读
        out[axis] = sign * float(m.group(2 + 2 * i))
    if any(v is None for v in out):
        return None
    return tuple(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", type=Path, default=PROC / "metadata.json")
    ap.add_argument("--rvm", type=Path, default=PROC / "rvm-node-index.json")
    ap.add_argument("--glb", type=Path, default=PROC / "model.glb")
    ap.add_argument("--out", type=Path, default=PROC / "mapping.json")
    ap.add_argument("--mapping", type=Path, default=None, help="--out 的同义参数")
    ap.add_argument("--evidence-dir", type=Path, default=EVID,
                    help="未匹配清单 JSON 的输出目录（缺省 reports/evidence）")
    a = ap.parse_args()
    if a.mapping:
        a.out = a.mapping

    t0 = time.perf_counter()
    meta = json.loads(a.meta.read_text(encoding="utf-8"))
    rvm = json.loads(a.rvm.read_text(encoding="utf-8"))
    glb = load_glb_index(a.glb)

    txt = meta["objects"]                                   # id -> object
    txt_by_canonical = {o["canonical"]: oid for oid, o in txt.items()}
    rvm_by_name = {g["name"]: g for g in rvm["groups"]}

    # ---------------- 通道 1：名称 ----------------
    pairs: dict[str, dict] = {}
    chan = Counter()
    for name, node_idx in glb["named"].items():
        oid = txt_by_canonical.get(name)
        g = rvm_by_name.get(name)
        if oid is None:
            continue                                        # RVM 有、TXT 没有 → 单独处理
        pairs[name] = {
            "glbNodeIndex": node_idx,
            "rvmOffset": g["offset"] if g else None,
            "rvmId": g["id"] if g else None,
            "txtId": oid,
            "channel": "name",
        }
        chan["name"] += 1

    # ---------------- 通道 2：归一化名称 ----------------
    txt_norm = defaultdict(list)
    for oid, o in txt.items():
        txt_norm[norm_name(o["canonical"])].append(oid)
    rvm_norm = defaultdict(list)
    for g in rvm["groups"]:
        rvm_norm[norm_name(g["name"])].append(g)
    tn = set(txt_norm)
    for name, node_idx in glb["named"].items():
        if name in pairs:
            continue
        key = norm_name(name)
        cands = txt_norm.get(key) or []
        if len(cands) == 1:
            g = rvm_by_name.get(name)
            pairs[cands[0]] = {
                "glbNodeIndex": node_idx,
                "rvmOffset": g["offset"] if g else None,
                "rvmId": g["id"] if g else None,
                "txtId": cands[0], "channel": "normalized",
            }
            chan["normalized"] += 1

    # ---------------- 通道 3：结构（类型 + 序号 + 父）----------------
    # 只有在通道 1/2 都没配上的 RVM 组才尝试；父必须已配对，否则跳过（不猜）
    unmatched_rvm = [g for g in rvm["groups"] if g["name"] not in glb["named"]]
    by_parent = defaultdict(list)
    for oid, o in txt.items():
        by_parent[o["parent"]].append(oid)
    for name, node_idx in glb["named"].items():
        if name in pairs or name in txt_by_canonical:
            continue
        # 名字对不上时按结构重建：需要先知道该组在 TXT 中的父与序号，这无法从名字反推，
        # 因此这里只在"RVM 组的父已配对"且"TXT 侧存在唯一同类型同序号候选"时才接受。
        g = rvm_by_name.get(name)
        if g is None or not g["parentId"]:
            continue
        parent_name = next((x["name"] for x in rvm["groups"] if x["id"] == g["parentId"]), None)
        p_oid = pairs.get(parent_name, {}).get("txtId") if parent_name else None
        if p_oid is None:
            continue
        same = [c for c in by_parent[p_oid] if txt[c]["type"] == _type_of_name(name)]
        idxs = [c for c in same if c not in {v["txtId"] for v in pairs.values()}]
        if len(idxs) == 1:
            c = idxs[0]
            pairs[c] = {"glbNodeIndex": node_idx, "rvmOffset": g["offset"],
                        "rvmId": g["id"], "txtId": c, "channel": "structure"}
            chan["structure"] += 1

    # ---------------- 未匹配 ----------------
    matched_txt = {v["txtId"] for v in pairs.values()}
    txt_only = [oid for oid in txt if oid not in matched_txt]
    matched_glb_names = set(pairs)
    glb_only_names = [n for n in glb["named"] if n not in matched_glb_names]

    # 未匹配的分类：只能用可查证的事实（类型在 RVM 里出不出现、数量差多少），不臆断原因
    rvm_type_count = Counter(_type_of_name(g["name"]) for g in rvm["groups"])
    txt_type_count = Counter(o["type"] for o in txt.values())
    txt_only_by_type = Counter(txt[o]["type"] for o in txt_only)
    type_table = []
    for t, n in txt_only_by_type.most_common():
        in_rvm = rvm_type_count.get(t, 0)
        type_table.append({
            "type": t,
            "txtTotal": txt_type_count[t],
            "txtUnmatched": n,
            "rvmTotal": in_rvm,
            "verdict": ("RVM 中该类型完全不出现（判为无实体几何）" if in_rvm == 0
                        else f"RVM 中该类型存在但少 {n} 个实例（需逐对象确认）"
                        if in_rvm < txt_type_count[t] else "需人工确认"),
        })

    # ---------------- 校验：父链一致性 ----------------
    parent_ok = parent_bad = 0
    parent_bad_samples = []
    for name, p in pairs.items():
        o = txt[p["txtId"]]
        txt_parent_can = txt[o["parent"]]["canonical"] if o["parent"] else None
        gi = p["glbNodeIndex"]
        pidx = glb["parent"].get(gi)
        glb_parent_name = glb["nodes"][pidx].get("name") if pidx is not None else None
        # GLB 里父节点可能是有名组，也可能是无名 holder；向上找到最近的有名祖先
        while pidx is not None and glb_parent_name is None:
            pidx = glb["parent"].get(pidx)
            glb_parent_name = glb["nodes"][pidx].get("name") if pidx is not None else None
        # RVM 里 SITE 的父是技术节点 /MDBs（TXT 无此对象）；这种情况算一致
        if glb_parent_name == txt_parent_can or (txt_parent_can is None
                                                 and glb_parent_name == "/MDBs"):
            parent_ok += 1
        else:
            parent_bad += 1
            if len(parent_bad_samples) < 5:
                parent_bad_samples.append(
                    {"name": name, "txtParent": txt_parent_can, "glbParent": glb_parent_name})

    # ---------------- 校验：TXT 坐标点到 RVM 组包围盒的距离 ----------------
    # 说明：TXT 的 POS/HPOS 是**参考点**（管端、构件锚点），不一定落在实体表面内，
    # 因此不设"通过/不通过"的人为阈值，只报告距离分布，并把明显异常（>1 m）列出来。
    # 只对**叶子组**统计：容器组的包围盒是子树并集，几乎什么点都会落进去，没有区分度。
    child_of_rvm = defaultdict(int)
    for g in rvm["groups"]:
        if g["parentId"]:
            child_of_rvm[g["parentId"]] += 1
    coord = {"withCoordinate": 0, "inside": 0, "unparsedValue": 0,
             "noCoordinateData": 0, "leafGroupsChecked": 0,
             "distanceM": {"p50": None, "p90": None, "p95": None, "max": None},
             "byParentType": {}, "over1m": [], "unparsedSamples": []}
    dists = []
    per_parent = defaultdict(list)
    for name, p in pairs.items():
        o = txt[p["txtId"]]
        val = o["props"].get("POS") or o["props"].get("HPOS")
        if isinstance(val, list):
            val = val[0]
        if not val:
            coord["noCoordinateData"] += 1
            continue
        coord["withCoordinate"] += 1
        enu = parse_enu(val)
        if enu is None:
            coord["unparsedValue"] += 1
            if len(coord["unparsedSamples"]) < 8:
                coord["unparsedSamples"].append({"name": name, "value": val})
            continue
        g = rvm_by_name.get(name)
        bb = g.get("bboxWorldM") if g else None
        if not bb or not g["directGeometryCount"] or child_of_rvm.get(g["id"], 0):
            continue                                  # 只查叶子组（包围盒紧密）
        coord["leafGroupsChecked"] += 1
        pt = [c / 1000.0 for c in enu]                # mm → m
        d2 = 0.0
        for i in range(3):
            lo, hi = bb[i], bb[i + 3]
            if pt[i] < lo:
                d2 += (lo - pt[i]) ** 2
            elif pt[i] > hi:
                d2 += (pt[i] - hi) ** 2
        d = d2 ** 0.5
        ptype = txt[o["parent"]]["type"] if o["parent"] else "(根)"
        per_parent[ptype].append(d)
        if d == 0.0:
            coord["inside"] += 1
        else:
            dists.append((d, name, pt, bb, ptype))
    if dists:
        dists.sort()
        vals = [d for d, *_ in dists]
        for label, q in (("p50", 0.50), ("p90", 0.90), ("p95", 0.95)):
            coord["distanceM"][label] = round(vals[min(len(vals) - 1, int(q * len(vals)))], 4)
        coord["distanceM"]["max"] = round(vals[-1], 4)
    coord["outsideCount"] = len(dists)
    # 按父类型分层：立刻能看出哪些子集是"世界坐标"、哪些是"父级局部坐标"
    def pct(v, q):
        v = sorted(v)
        return v[min(len(v) - 1, int(q * len(v)))]
    coord["byParentType"] = {
        k: {"n": len(v), "insideExactly": sum(1 for x in v if x == 0.0),
            "within1mm": sum(1 for x in v if x <= 0.001),
            "p50M": round(pct(v, .5), 6), "p90M": round(pct(v, .9), 6),
            "maxM": round(max(v), 6)}
        for k, v in sorted(per_parent.items(), key=lambda x: -len(x[1]))
    }
    coord["over1m"] = [{"name": n, "parentType": pt, "distanceM": round(d, 3),
                        "txtM": [round(x, 3) for x in pt2],
                        "rvmBboxM": [round(x, 3) for x in bb]}
                       for d, n, pt2, bb, pt in dists if d > 1.0][:20]
    coord["over1mCount"] = sum(1 for d, *_ in dists if d > 1.0)

    # ---------------- 输出 ----------------
    stats = {
        "rvmGroups": len(rvm["groups"]),
        "glbNodes": glb["nodeCount"],
        "glbNamedNodes": len(glb["named"]),
        "txtObjects": len(txt),
        "matched": len(pairs),
        "matchRateOfGlbNamed": round(len(pairs) / max(1, len(glb["named"])) * 100, 3),
        "matchRateOfRvm": round(len(pairs) / max(1, len(rvm["groups"])) * 100, 3),
        "matchRateOfTxt": round(len(pairs) / max(1, len(txt)) * 100, 3),
        "byChannel": dict(chan),
        "unmatchedTxt": len(txt_only),
        "unmatchedGlbNamed": len(glb_only_names),
        "pairsWithRvmOffset": sum(1 for v in pairs.values() if v["rvmOffset"] is not None),
    }
    out = {
        "schema": "pdms-object-mapping/1",
        "inputs": {
            "metadata": str(a.meta.name),
            "rvmIndex": str(a.rvm.name),
            "glb": str(a.glb.name),
        },
        "stats": stats,
        "pairs": pairs,
        "unmatched": {
            "txtOnly": [
                {"txtId": o, "canonical": txt[o]["canonical"], "type": txt[o]["type"],
                 "reason": ("该类型在 RVM 中完全不出现" if rvm_type_count.get(txt[o]["type"], 0) == 0
                            else "RVM 中该类型存在但本实例无对应组（需逐对象确认）")}
                for o in txt_only
            ],
            "glbNamedOnly": [
                {"name": n, "glbNodeIndex": glb["named"][n],
                 "reason": ("技术节点（非 PDMS 设计对象）"
                            if (n.startswith("/MDBs") or n.endswith(".rvm")
                                or "rvmparser" in n)
                            else "RVM 有该组但 TXT 无同名对象（需逐对象确认）")}
                for n in glb_only_names
            ],
            "txtOnlyByType": type_table,
        },
        "checks": {
            "parentChainAgree": {"agree": parent_ok, "disagree": parent_bad,
                                 "samples": parent_bad_samples},
            "coordinateToBboxDistance": coord,
        },
    }

    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    EVID_DIR = a.evidence_dir
    EVID_DIR.mkdir(parents=True, exist_ok=True)
    (EVID_DIR / "phase4-unmatched.json").write_text(
        json.dumps({"stats": stats, "unmatched": out["unmatched"], "checks": out["checks"]},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    ms = int((time.perf_counter() - t0) * 1000)
    print(f"RVM 组 {stats['rvmGroups']:,} · GLB 命名节点 {stats['glbNamedNodes']:,} · TXT 对象 {stats['txtObjects']:,}")
    print(f"已匹配 {stats['matched']:,}  →  GLB 侧 {stats['matchRateOfGlbNamed']}%"
          f" · RVM 侧 {stats['matchRateOfRvm']}% · TXT 侧 {stats['matchRateOfTxt']}%")
    print(f"匹配通道 {stats['byChannel']}")
    print(f"未匹配：TXT 独有 {stats['unmatchedTxt']:,} · GLB 独有 {stats['unmatchedGlbNamed']}")
    print(f"校验 · 父链一致 {parent_ok:,} / 不一致 {parent_bad}")
    c = out["checks"]["coordinateToBboxDistance"]
    print(f"校验 · 坐标：有值 {c['withCoordinate']:,}（未解析 {c['unparsedValue']}）"
          f" · 无坐标 {c['noCoordinateData']:,}")
    print(f"       叶子组可查 {c['leafGroupsChecked']:,} → 落在包围盒内 {c['inside']:,}"
          f" · 距离分布 {c['distanceM']} · 超 1 m {c['over1mCount']}")
    print("       按父类型分层（n / 落在盒内 / p50 距离 m）:")
    for k, v in list(c["byParentType"].items())[:8]:
        print(f"         {k:14} n={v['n']:<6} 精确在盒内={v['insideExactly']:<6}"
              f" ≤1mm={v['within1mm']:<6} p50={v['p50M']:<10} max={v['maxM']}")
    # a.out 可能是调用方给的相对路径（本地后端按相对路径传参），relative_to 只接受绝对路径
    print(f"耗时 {ms} ms → {a.out.resolve().relative_to(ROOT)} {a.out.stat().st_size:,} B")
    return 0


def _type_of_name(name: str) -> str:
    """从 RVM 组名取类型："/xxx" → ""（有名对象无类型前缀）；"TYPE n of ..." → "TYPE"。"""
    if name.startswith("/"):
        return ""
    return name.split(" ", 1)[0]


if __name__ == "__main__":
    raise SystemExit(main())
