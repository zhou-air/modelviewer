"""RVM-only 模式的元数据合成层 —— 单靠 RVM 生成 Viewer 契约的 metadata.json + mapping.json。

为什么需要这一层
    Viewer 的数据契约是「metadata（对象树 + 属性）+ mapping（canonical ↔ GLB 节点 ↔ RVM 字节偏移）」。
    有 TXT（PDMS Data Listing）时这两份由 `txt_parser.py` + `map_objects.py` 生成；
    现场只拿到 RVM 时没有 TXT，但 RVM 的 CNTB 组本身就带**完整层级与 PDMS 对象名**
    （实测 7420 组 / 深度 8 / 重名 0，名字形态与 TXT 侧 canonical 规则同构：
     有名对象 `/WG-10401-400-L1G/B2`，匿名对象 `GASKET 1 of BRANCH /WG-10401-400-L1G/B2`），
    所以可以只从 RVM 合成出**同 schema** 的两份产物，Viewer 侧无需改动即可加载。

拿得到 / 拿不到（实测结论，不猜）
    拿得到  几何、层级、对象名（= canonical）、匿名对象的类型（名字首 token）
    拿不到  PDMS 工程属性（POS/DIAM/PRES/TEMP/DESC/保温/等级…）—— RVM 的 chunk 只有
            HEAD / MODL / CNTB / CNTE / PRIM，属性只存在于 TXT；
            有名对象的 PDMS 类型同样不在 RVM 里。
    因此本脚本产出的 props 一律为空、line/lineEnd 为 null，并如实标记
    顶层 `metadataSource: "rvm"` 与有名对象的 `typeSource: "unknown"`，
    让 UI 能说明「为什么这里没有属性」，而不是让空白看起来像丢数据。

与 TXT 链路的差异（边界必须清楚）
    · 对象数 = RVM 组数，比 TXT 少 —— 少掉的是**没有实体几何**的设计对象（如 POINT/PAVERT/PLOOP），
      它们在 TXT 链路里本来就不可拾取、不进 3D 视图。
    · canonical 与 TXT 链路**同构**，所以同一 Project 里两种版本可以混用，
      模型重叠比对 / 分屏比对的键依然对得上。
    · 重名（RVM 组名重复）一律**如实报告**并在闸门处拦下，不做去重掩盖。

用法：
    python converter/rvm_metadata.py --rvm-index X.json --glb Y.glb
    python converter/rvm_metadata.py --index X.json --glb Y.glb --metadata M.json --mapping P.json
（`--index`≡`--rvm-index`、`--metadata`≡`--meta-out`、`--mapping`≡`--map-out` 是同义参数，
 供本地后端按任意路径调用；`--source` 是原始 .rvm，只在需要回读校验时给。）
"""
from __future__ import annotations

import argparse
import json
import struct
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"

METADATA_SCHEMA = "pdms-datalisting/1"      # 与 txt_parser.py 完全一致：Viewer 按同一契约读
MAPPING_SCHEMA = "pdms-object-mapping/1"    # 与 map_objects.py 完全一致
METADATA_SOURCE = "rvm"                     # 生产源头标记：TXT 链路为 "pdms-datalisting"


def load_glb_named(path: Path) -> dict:
    """读 GLB 的 JSON 块，取出「节点名 → 序号」与节点总数。

    名字重复时保留首个（与 map_objects.load_glb_index 同一口径，便于两条链路的统计可比）。
    """
    raw = path.read_bytes()
    off, J = 12, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        if ctype == 0x4E4F534A:
            J = json.loads(raw[off + 8:off + 8 + clen].decode("utf-8"))
        off += 8 + clen
        off += (-clen) % 4
    if J is None:
        raise SystemExit(f"GLB 里找不到 JSON 块：{path}")
    named: dict[str, int] = {}
    for i, n in enumerate(J.get("nodes", [])):
        nm = n.get("name")
        if nm:
            named.setdefault(nm, i)
    return {"nodeCount": len(J.get("nodes", [])), "named": named}


def type_of_group_name(name: str) -> tuple[str, str]:
    """从 RVM 组名取元素类型 → (type, typeSource)。

    "/xxx" 开头是有名对象：PDMS 类型不在 RVM 里，**不猜**，返回 ("", "unknown")。
    其余是匿名对象："TYPE n of <父引用>" 的首 token 就是 PDMS 元素类型。
    """
    if name.startswith("/"):
        return "", "unknown"
    head = name.split(" ", 1)[0].strip()
    if not head:
        return "", "unknown"
    return head, "rvm-name"


def build(groups: list[dict], glb: dict) -> tuple[dict, dict]:
    by_id = {g["id"]: g for g in groups}
    child_of: dict[str, list[str]] = {}
    for g in groups:
        if g.get("parentId"):
            child_of.setdefault(g["parentId"], []).append(g["id"])

    objects: dict[str, dict] = {}
    type_counter: Counter = Counter()
    named = anonymous = type_unknown = 0
    dup_canonical: Counter = Counter()

    for g in groups:
        name = g["name"]
        canonical = name
        dup_canonical[canonical] += 1
        is_named = name.startswith("/")
        if is_named:
            named += 1
            obj_name = name                     # 与 txt_parser 一致：name 为完整 "/..." 名
        else:
            anonymous += 1
            obj_name = None                     # 与 txt_parser 一致：匿名对象 name 为 null
        otype, tsource = type_of_group_name(name)
        if tsource == "unknown":
            type_unknown += 1
        type_counter[otype or "(unknown)"] += 1

        objects[g["id"]] = {
            "id": g["id"],
            "name": obj_name,
            "type": otype,
            "typeSource": tsource,              # 本合成层扩展字段：TXT 链路不写它
            "parent": g.get("parentId"),
            "children": child_of.get(g["id"], []),
            "depth": g["depth"],
            "canonical": canonical,
            "path": list(g.get("pathNames") or [canonical]),
            "line": None,                       # RVM 没有"原文行"概念，如实置空
            "lineEnd": None,
            "props": {},                        # RVM 不含工程属性
            "propOrder": [],
        }

    roots = [g["id"] for g in groups if not g.get("parentId")]
    dup = {k: v for k, v in dup_canonical.items() if v > 1}

    meta = {
        "schema": METADATA_SCHEMA,
        "metadataSource": METADATA_SOURCE,
        "source": {"file": None, "bytes": None, "encoding": "RVM binary"},
        "roots": roots,
        "objects": objects,
        "stats": {
            "objects": len(objects),
            "roots": len(roots),
            "maxDepth": max((g["depth"] for g in groups), default=0),
            "named": named,
            "anonymous": anonymous,
            "types": dict(type_counter.most_common()),
            # 三条"这条链路缺什么"的自述，供 UI/报告引用
            "typeUnknown": type_unknown,
            "attributesAvailable": False,
            "geometryGroups": sum(1 for g in groups if g.get("directGeometryCount")),
            "canonicalDuplicates": len(dup),
            "canonicalDuplicateExamples": dict(list(dup.items())[:10]),
        },
    }

    # ---------------- mapping ----------------
    named_glb = glb["named"]
    pairs: dict[str, dict] = {}
    rvm_only: list[dict] = []
    seen_offsets: Counter = Counter()
    for g in groups:
        name = g["name"]
        if name in pairs:                       # 重名组：不覆盖，如实进未匹配清单
            rvm_only.append({"name": name, "rvmId": g["id"], "rvmOffset": g["offset"],
                             "reason": "RVM 组名重复，同名组只保留首个映射（需先解决重名）"})
            continue
        node_idx = named_glb.get(name)
        if node_idx is None:
            rvm_only.append({"name": name, "rvmId": g["id"], "rvmOffset": g["offset"],
                             "reason": "GLB 里没有同名节点（该组未被导出为命名节点）"})
            continue
        seen_offsets[g["offset"]] += 1
        pairs[name] = {
            "glbNodeIndex": node_idx,
            "rvmOffset": g["offset"],
            "rvmId": g["id"],
            "txtId": g["id"],                   # 合成链路里"对象 id"就是 RVM 组 id，自洽
            "channel": "rvm",                   # TXT 链路用 name/normalized/structure，这里只有来源通道
        }

    glb_only = [{"name": n, "glbNodeIndex": i,
                 "reason": ("技术节点（非 PDMS 设计对象）"
                            if (n.startswith("/MDBs") or n.endswith(".rvm") or "rvmparser" in n)
                            else "GLB 有该命名节点但 RVM 组名里没有（需逐对象确认）")}
                for n, i in named_glb.items() if n not in pairs]

    stats = {
        "rvmGroups": len(groups),
        "glbNodes": glb["nodeCount"],
        "glbNamedNodes": len(named_glb),
        "txtObjects": len(objects),             # 兼容既有字段名：本期"对象总数"= RVM 组数
        "matched": len(pairs),
        "matchRateOfGlbNamed": round(len(pairs) / max(1, len(named_glb)) * 100, 3),
        "matchRateOfRvm": round(len(pairs) / max(1, len(groups)) * 100, 3),
        "matchRateOfTxt": round(len(pairs) / max(1, len(objects)) * 100, 3),
        "byChannel": {"rvm": len(pairs)},
        "unmatchedTxt": 0,
        "unmatchedGlbNamed": len(glb_only),
        "unmatchedRvm": len(rvm_only),
        "pairsWithRvmOffset": sum(1 for v in pairs.values() if v["rvmOffset"] is not None),
        "metadataSource": METADATA_SOURCE,
    }
    mapping = {
        "schema": MAPPING_SCHEMA,
        "metadataSource": METADATA_SOURCE,
        "inputs": {"metadata": "metadata.json (rvm-synthesized)", "rvmIndex": "rvm-node-index.json",
                   "glb": "model.glb"},
        "stats": stats,
        "pairs": pairs,
        "unmatched": {"txtOnly": [], "glbNamedOnly": glb_only, "rvmOnly": rvm_only,
                      "txtOnlyByType": []},
        "checks": {
            "note": "本映射由 RVM 组名直接合成（单通道），不做结构/坐标回退匹配；"
                    "父链一致性与坐标距离校验属于 TXT 链路的专项检查，此处不适用。",
            "rvmOffsetDuplicates": [o for o, c in seen_offsets.items() if c > 1],
        },
    }
    return meta, mapping


def main() -> int:
    ap = argparse.ArgumentParser(description="仅用 RVM 合成 metadata.json + mapping.json")
    ap.add_argument("--rvm-index", "--index", dest="rvm_index", type=Path, default=None)
    ap.add_argument("--source", "--input", dest="source", type=Path, default=None,
                    help="原始 .rvm（仅用于把文件名/字节数写进 metadata.source，不解析）")
    ap.add_argument("--glb", type=Path, default=None)
    ap.add_argument("--metadata", "--meta-out", dest="metadata", type=Path, default=None)
    ap.add_argument("--mapping", "--map-out", dest="mapping", type=Path, default=None)
    ap.add_argument("--evidence-dir", type=Path, default=None,
                    help="未匹配清单 JSON 的输出目录（不给则不写）")
    a = ap.parse_args()

    index_path = a.rvm_index or (PROC / "rvm-node-index.json")
    glb_path = a.glb or (PROC / "model.glb")
    meta_out = a.metadata or (PROC / "metadata.json")
    map_out = a.mapping or (PROC / "mapping.json")

    t0 = time.perf_counter()
    index = json.loads(Path(index_path).read_text(encoding="utf-8"))
    if index.get("schema") != "rvm-node-index/1":
        raise SystemExit(f"不是 rvm-node-index/1 产物：{index_path}")
    groups = index["groups"]
    if not groups:
        raise SystemExit(f"RVM 索引里没有任何组：{index_path}")
    glb = load_glb_named(Path(glb_path))

    meta, mapping = build(groups, glb)
    src = index.get("source") or {}
    meta["source"] = {"file": (Path(a.source).name if a.source else src.get("file")),
                      "bytes": src.get("bytes"), "encoding": "RVM binary",
                      "rvmHeader": (index.get("header") or {}).get("info"),
                      "note": "本 metadata 由 RVM 合成（无 TXT 数据清单）：只有名字/层级/类型，没有工程属性"}
    meta_out.parent.mkdir(parents=True, exist_ok=True)
    map_out.parent.mkdir(parents=True, exist_ok=True)
    meta_out.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    map_out.write_text(json.dumps(mapping, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    if a.evidence_dir:
        a.evidence_dir.mkdir(parents=True, exist_ok=True)
        (a.evidence_dir / "rvm-synthesized-unmatched.json").write_text(
            json.dumps({"stats": mapping["stats"], "unmatched": mapping["unmatched"]},
                       ensure_ascii=False, indent=2), encoding="utf-8")

    ms = int((time.perf_counter() - t0) * 1000)
    s = mapping["stats"]
    print(f"RVM 组 {s['rvmGroups']:,} → 对象 {meta['stats']['objects']:,}"
          f"（有名 {meta['stats']['named']:,} / 匿名 {meta['stats']['anonymous']:,}）")
    print(f"映射 {s['matched']:,}  →  GLB 侧 {s['matchRateOfGlbNamed']}%"
          f" · RVM 侧 {s['matchRateOfRvm']}%")
    print(f"类型可知 {meta['stats']['objects'] - meta['stats']['typeUnknown']:,}"
          f" / 类型不可知（有名对象）{meta['stats']['typeUnknown']:,}")
    print(f"未匹配：RVM 独有 {s['unmatchedRvm']} · GLB 独有 {s['unmatchedGlbNamed']}")
    print(f"canonical 重名 {meta['stats']['canonicalDuplicates']}")
    print(f"耗时 {ms} ms → {meta_out} {meta_out.stat().st_size:,} B · "
          f"{map_out} {map_out.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
