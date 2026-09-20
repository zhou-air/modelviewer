"""GLB 结构独立校验器（只用标准库，不依赖 three.js / glTF 库）。

用途：转换后对账 —— 确认 glTF 节点树 = PDMS 层级、mesh/三角形数量与 RVM 解析结果一致、
      没有图元静默丢失。可作为回归比对基线。

用法：
    python converter/verify_glb.py <file.glb> [--json out.json]
"""
from __future__ import annotations

import json
import struct
import sys
from collections import Counter
from pathlib import Path

MODE_TRIANGLES = 4
MODE_TRIANGLE_STRIP = 5
MODE_TRIANGLE_FAN = 6
MODE_LINES = 1
MODE_LINE_STRIP = 3
MODE_POINTS = 0


def read_glb(path: Path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF":
        raise ValueError(f"not a GLB: magic={magic!r}")
    chunks = {}
    off = 12
    while off < length:
        clen, ctype = struct.unpack_from("<II", raw, off)
        data = raw[off + 8: off + 8 + clen]
        chunks[ctype] = data
        off += 8 + clen
        off += (-clen) % 4
    j = json.loads(chunks[0x4E4F534A].decode("utf-8"))
    bin_len = len(chunks.get(0x004E4942, b""))
    return raw, version, j, bin_len


def check_json_is_utf8(path: Path):
    """GLB 的 JSON 块必须是合法 UTF-8。rvmparser 会把源路径写进 File 节点的 name；
    若调用时用了含非 ASCII 的绝对路径，Windows 下会写成 ANSI 字节，GLB 即变成非法文件。"""
    raw = path.read_bytes()
    clen, _ = struct.unpack_from("<II", raw, 12)
    jc = raw[20:20 + clen]
    bad = []
    i = 0
    while i < len(jc):
        try:
            jc[i:].decode("utf-8")
            break
        except UnicodeDecodeError as e:
            bad.append(i + e.start)
            i += e.start + 1
    return bad


def analyze(path: Path) -> dict:
    bad_utf8 = check_json_is_utf8(path)
    raw, version, g, bin_len = read_glb(path)

    nodes = g.get("nodes", [])
    meshes = g.get("meshes", [])
    accessors = g.get("accessors", [])
    materials = g.get("materials", [])

    depth_of = {}
    order = []
    roots = [i for i in range(len(nodes)) if not any(
        i in (n.get("children") or []) for n in nodes)]
    # 更稳的根判定
    has_parent = set()
    for n in nodes:
        for c in n.get("children") or []:
            has_parent.add(c)
    roots = [i for i in range(len(nodes)) if i not in has_parent]
    stack = [(r, 0) for r in roots]
    while stack:
        i, d = stack.pop()
        depth_of[i] = d
        order.append(i)
        for c in nodes[i].get("children") or []:
            stack.append((c, d + 1))

    prim_modes = Counter()
    tris = 0
    lines = 0
    points = 0
    vertex_total = 0
    prim_total = 0
    for m in meshes:
        for p in m.get("primitives", []):
            prim_total += 1
            mode = p.get("mode", MODE_TRIANGLES)
            prim_modes[mode] += 1
            pos_idx = p["attributes"].get("POSITION")
            n_vert = accessors[pos_idx]["count"] if pos_idx is not None else 0
            vertex_total += n_vert
            if "indices" in p:
                n_idx = accessors[p["indices"]]["count"]
            else:
                n_idx = n_vert
            if mode == MODE_TRIANGLES:
                tris += n_idx // 3
            elif mode in (MODE_TRIANGLE_STRIP, MODE_TRIANGLE_FAN):
                tris += max(0, n_idx - 2)
            elif mode == MODE_LINES:
                lines += n_idx // 2
            elif mode == MODE_LINE_STRIP:
                lines += max(0, n_idx - 1)
            elif mode == MODE_POINTS:
                points += n_idx

    mesh_nodes = [i for i, n in enumerate(nodes) if "mesh" in n]
    named = [n["name"] for n in nodes if n.get("name")]
    depth_hist = Counter(depth_of.values())
    names_with_slash = sum(1 for x in named if x.startswith("/"))
    names_synthetic = sum(1 for x in named if " of " in x)
    extras_nodes = sum(1 for n in nodes if n.get("extras"))

    return {
        "file": path.name,
        "bytes": len(raw),
        "glb_version": version,
        "json_utf8_ok": not bad_utf8,
        "json_invalid_byte_offsets": bad_utf8[:10],
        "generator": g.get("asset", {}).get("generator"),
        "asset_extra": g.get("asset", {}).get("extras"),
        "bin_chunk_bytes": bin_len,
        "counts": {
            "nodes": len(nodes),
            "roots": len(roots),
            "meshes": len(meshes),
            "primitives": prim_total,
            "materials": len(materials),
            "accessors": len(accessors),
            "nodes_with_mesh": len(mesh_nodes),
            "nodes_with_extras": extras_nodes,
        },
        "geometry": {
            "triangles": tris,
            "lines": lines,
            "points": points,
            "vertices": vertex_total,
            "primitive_modes": dict(prim_modes),
        },
        "hierarchy": {
            "max_depth": max(depth_of.values()) if depth_of else None,
            "depth_histogram": dict(sorted(depth_hist.items())),
        },
        "names": {
            "named_nodes": len(named),
            "slash_names": names_with_slash,
            "synthetic_names": names_synthetic,
            "samples_root": [nodes[i].get("name") for i in roots][:5],
            "samples_deep": [nodes[i].get("name") for i in order[-5:]],
            "first_synthetic": next((x for x in named if " of " in x), None),
        },
        "material_names": [m.get("name") for m in materials],
        "extensions_used": g.get("extensionsUsed", []),
        "scene_nodes": g.get("scenes", [{}])[0].get("nodes"),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    p = Path(sys.argv[1])
    res = analyze(p)
    out = json.dumps(res, ensure_ascii=False, indent=2)
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(out, encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
