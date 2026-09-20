"""①-附 RVM 技术索引 —— 从 RVM 二进制里取出每个组的「字节偏移 + 名称 + 层级 + 几何统计」。

为什么需要单独一层：
  Phase 4 的对象映射要用「节点名」作业务主键，但名字可能因命名规则变化或重名而失效。
  字节偏移是物理锚点（只要文件不变就永远指向同一个组），所以留一份技术 id 做回归比对。

单位事实（实测确认，容易踩）：
  · PRIM 的 M_3x4 矩阵与 bboxLocal、以及由此算出的世界包围盒 → **米**
  · CNTB 的 referenceTranslation（组参考原点） → **毫米**
  例：某 TEE 的 referenceTranslation=[710, 13290.6, 5223.4]（mm）落在其世界包围盒
      [0.5475,13.0354,5.059, 0.8725,13.5458,5.4786]（m）内 —— 同一坐标，差 1000 倍。

实现依据：cdyk/rvmparser 的 src/ParserRVM.cpp（各 chunk 的字段布局）。
本脚本**不解析图元形状**，只按 chunk 头里的 next-offset 跳过去，因此对未支持的图元类型也安全。

用法：
    python converter/rvm_index.py
    python converter/rvm_index.py --source x.rvm --out y.json
    python converter/rvm_index.py --cross-check reports/evidence/rvm-hierarchy.json
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source"
OUT_DIR = ROOT / "data" / "processed"

# 图元 kind 编号 → 名称（与 ParserRVM / RVM 规范一致）
GEOM_KINDS = {
    1: "Pyramid", 2: "Box", 3: "RectangularTorus", 4: "CircularTorus",
    5: "EllipticalDish", 6: "SphericalDish", 7: "Snout", 8: "Cylinder",
    9: "Sphere", 10: "Line", 11: "FacetGroup",
}


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from(">I", b, p)[0]


def _floats(b: bytes, p: int, n: int):
    return list(struct.unpack_from(">" + "f" * n, b, p))


def _string(b: bytes, p: int):
    """RVM 字符串：uint32 字数（大端），后接 4*len 字节 UTF-8（含 NUL 填充）。"""
    n = _u32(b, p) * 4
    raw = b[p + 4:p + 4 + n]
    return raw.split(b"\0")[0].decode("utf-8", errors="replace"), p + 4 + n


def _mat_mul(m, v):
    """M_3x4 列主序 3x4 仿射矩阵 × 点。"""
    return [sum(m[c * 3 + r] * v[c] for c in range(3)) + m[9 + r] for r in range(3)]


def parse(path: Path) -> dict:
    b = path.read_bytes()
    n = len(b)
    groups: list[dict] = []
    geos: list[dict] = []
    stack: list[dict] = []
    header: dict = {}
    chunk_counts: dict[str, int] = {}
    colors: list[dict] = []

    p = 0
    while p + 24 <= n:
        tag = "".join(chr(_u32(b, p + i * 4)) for i in range(4))
        nxt = _u32(b, p + 16)
        q = p + 24
        chunk_counts[tag] = chunk_counts.get(tag, 0) + 1
        if tag == "END:":
            break
        if not (p < nxt <= n):
            raise SystemExit(f"chunk 偏移异常：{tag} @ {p} → {nxt}")

        if tag == "HEAD":
            ver = _u32(b, q); q += 4
            for k in ("info", "note", "date", "user"):
                header[k], q = _string(b, q)
            if ver >= 2:
                header["encoding"], q = _string(b, q)
            header["version"] = ver
        elif tag == "MODL":
            q += 4
            header["project"], q = _string(b, q)
            header["model"], q = _string(b, q)
        elif tag == "CNTB":
            q += 4
            name, q = _string(b, q)
            transl = _floats(b, q, 3); q += 12
            material = _u32(b, q)
            parent = stack[-1] if stack else None
            g = {
                "id": f"rvm:cntb:{p}",
                "offset": p,
                "name": name,
                "parentId": parent["id"] if parent else None,
                "depth": len(stack) + 1,
                "pathNames": (parent["pathNames"] if parent else []) + [name],
                "material": material,
                "referenceTranslationMm": transl,
                "directGeometryCount": 0,
                "geometryKinds": {},
            }
            groups.append(g)
            stack.append(g)
        elif tag == "CNTE":
            stack.pop()
        elif tag in ("PRIM", "OBST", "INSU"):
            kind = _u32(b, q + 4)
            m = _floats(b, q + 8, 12)
            bb = _floats(b, q + 56, 6)
            if not all(math.isfinite(x) for x in m + bb):
                raise SystemExit(f"PRIM 矩阵/包围盒出现非有限值 @ {p}")
            corners = [(x, y, z) for x in (bb[0], bb[3]) for y in (bb[1], bb[4]) for z in (bb[2], bb[5])]
            wc = [_mat_mul(m, c) for c in corners]
            g = {
                "offset": p,
                "chunk": tag,
                "kind": kind,
                "kindName": GEOM_KINDS.get(kind, f"Unknown({kind})"),
                "ownerId": stack[-1]["id"],
                "bboxWorldM": [min(v[i] for v in wc) for i in range(3)]
                              + [max(v[i] for v in wc) for i in range(3)],
            }
            geos.append(g)
            o = stack[-1]
            o["directGeometryCount"] += 1
            k = str(kind)
            o["geometryKinds"][k] = o["geometryKinds"].get(k, 0) + 1
        elif tag == "COLR":
            colors.append({"kind": _u32(b, q), "index": _u32(b, q + 4), "rgb": list(b[q + 8:q + 11])})
        else:
            raise SystemExit(f"未知 chunk：{tag} @ {p}")

        p = nxt

    if stack:
        raise SystemExit(f"CNTB/CNTE 未配平，残余 {len(stack)} 个")

    # 逐组聚合「直接几何」的世界包围盒（mm）——用于映射层的位置校验
    acc: dict[str, list] = {}
    for g in geos:
        bb = g["bboxWorldM"]
        cur = acc.get(g["ownerId"])
        if cur is None:
            acc[g["ownerId"]] = [bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]]
        else:
            for i in range(3):
                cur[i] = min(cur[i], bb[i])
                cur[i + 3] = max(cur[i + 3], bb[i + 3])
    for g in groups:
        g["bboxWorldM"] = acc.get(g["id"])
        # 无直接几何的容器组：用子树并集兜底
    child_of: dict[str, list[str]] = {}
    for g in groups:
        if g["parentId"]:
            child_of.setdefault(g["parentId"], []).append(g["id"])
    by_id = {g["id"]: g for g in groups}
    order = sorted(groups, key=lambda x: -x["depth"])
    for g in order:
        if g["bboxWorldM"] is not None:
            continue
        boxes = [by_id[c]["bboxWorldM"] for c in child_of.get(g["id"], [])]
        boxes = [b for b in boxes if b]
        if boxes:
            g["bboxWorldM"] = [min(b[i] for b in boxes) for i in range(3)] + \
                              [max(b[i + 3] for b in boxes) for i in range(3)]
    res_groups_with_bbox = sum(1 for g in groups if g["bboxWorldM"])

    names = [g["name"] for g in groups]
    dup = {k: v for k, v in
           __import__("collections").Counter(names).items() if v > 1}

    return {
        "schema": "rvm-node-index/1",
        "source": {"file": path.name, "bytes": n},
        "header": header,
        "chunkCounts": chunk_counts,
        "stats": {
            "groups": len(groups),
            "geometries": len(geos),
            "colorRecords": len(colors),
            "maxDepth": max((g["depth"] for g in groups), default=0),
            "groupsWithGeometry": sum(1 for g in groups if g["directGeometryCount"]),
            "geometryKindHistogram": dict(
                sorted(((GEOM_KINDS.get(k, str(k)), v) for k, v in
                        __import__("collections").Counter(g["kind"] for g in geos).items()),
                       key=lambda x: -x[1])),
            "duplicateNames": len(dup),
            "groupsWithBbox": res_groups_with_bbox,
            "materialsUsed": sorted({g["material"] for g in groups}),
        },
        "groups": groups,
    }


def cross_check(res: dict, rvmparser_json: Path) -> dict:
    """与 rvmparser 的 --output-json 结果对账（名称序列、父子关系、数量）。"""
    off = json.loads(rvmparser_json.read_text(encoding="utf-8"))
    flat = []

    def visit(node, parent=None):
        if "material" in node:
            flat.append((node.get("name"), parent))
            parent = node.get("name")
        for c in node.get("children", []):
            visit(c, parent)

    for r in off:
        visit(r)
    mine = [(g["name"], g["parentId"] and
             next(x["name"] for x in res["groups"] if x["id"] == g["parentId"]))
            for g in res["groups"]]
    return {
        "groupsEqual": len(flat) == len(mine),
        "nameSequenceEqual": [a for a, _ in flat] == [a for a, _ in mine],
        "parentSequenceEqual": [b for _, b in flat] == [b for _, b in mine],
        "officialCount": len(flat),
        "probeCount": len(mine),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--input", type=Path, default=None, help="--source 的同义参数")
    ap.add_argument("--output", type=Path, default=None, help="--out 的同义参数")
    ap.add_argument("--cross-check", type=Path, default=None)
    a = ap.parse_args()

    src = a.input or a.source or next(iter(sorted(SRC_DIR.glob("*.rvm"))))
    src = src.resolve()
    out = (a.output or a.out or (OUT_DIR / "rvm-node-index.json")).resolve()

    t0 = time.perf_counter()
    res = parse(src)
    ms = int((time.perf_counter() - t0) * 1000)

    cc = None
    if a.cross_check and a.cross_check.exists():
        cc = cross_check(res, a.cross_check)
        res["crossCheck"] = cc

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    s = res["stats"]
    print(f"源文件      {src.name}  {res['source']['bytes']:,} B")
    print(f"HEAD        {res['header']['info']}")
    print(f"项目/模型   {res['header']['project']} / {res['header']['model']}")
    print(f"组          {s['groups']:,}（有直属几何 {s['groupsWithGeometry']:,}）· 最大深度 {s['maxDepth']}")
    print(f"几何        {s['geometries']:,}  {s['geometryKindHistogram']}")
    print(f"色表记录    {s['colorRecords']} · 用到的 material {s['materialsUsed']}")
    print(f"组名重名    {s['duplicateNames']}")
    if cc:
        print(f"与官方解析器对账 {cc}")
    print(f"耗时        {ms} ms")
    print(f"产出        {out.relative_to(ROOT)}  {out.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
