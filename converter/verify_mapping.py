"""映射结果独立校验器（③ 映射层的回归闸门）。

重点检查三件事：
  1) 数量闭合：matched + unmatched 必须等于双端各自的真实总数
  2) 身份一致：键是 TXT canonical，sourceName 锚定 GLB/RVM；回退通道有独立证据
  3) **技术 id 回读**：按 rvmOffset 回到 RVM 二进制，该偏移处必须真的是一个 CNTB chunk，
     且其名称与 sourceName 完全一致（旧 exact 记录回退到键）

用法：
    python converter/verify_mapping.py [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import re
import struct
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
SRC = ROOT / "data" / "source"


def read_glb_index(path: Path) -> dict:
    raw = path.read_bytes()
    off, J = 12, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        if ctype == 0x4E4F534A:
            J = json.loads(raw[off + 8:off + 8 + clen].decode("utf-8"))
        off += 8 + clen
        off += (-clen) % 4
    named = defaultdict(list)
    parents = {}
    for i, n in enumerate(J["nodes"]):
        if n.get("name"):
            named[n["name"]].append(i)
        for child in n.get("children") or []:
            parents[child] = i
    return {"nodes": J["nodes"], "named": dict(named), "parents": parents}


def read_glb_named(path: Path) -> dict:
    return {name: indices[0] for name, indices in read_glb_index(path)["named"].items()
            if len(indices) == 1}


def read_rvm_group_name(raw: bytes, offset: int):
    """在给定偏移读 CNTB chunk 的组名；偏移不是合法 CNTB 时返回 None。

    chunk 头 = 4×uint32 标签 + next_offset + 保留 = 24 字节
    CNTB payload = version(uint32) + 名称字长(uint32，单位 4 字节) + 名称字节
    所以名称的**长度字段**在 offset+28，名称字节在 offset+32。
    """
    if type(offset) is not int or offset < 0 or offset + 32 > len(raw):
        return None
    if struct.unpack_from(">4I", raw, offset) != tuple(map(ord, "CNTB")):
        return None
    q = offset + 24 + 4                       # 跳过 version
    n = struct.unpack_from(">I", raw, q)[0] * 4
    if q + 4 + n > len(raw):
        return None
    return raw[q + 4:q + 4 + n].split(b"\0")[0].decode("utf-8", errors="replace")


def verify(mapping: dict, meta: dict, rvm_index: dict, glb: dict, raw: bytes) -> dict:
    """Validate source anchors independently of the mapping producer."""
    txt = meta["objects"]
    pairs = mapping["pairs"]
    stats = mapping["stats"]
    glb_named = glb["named"]
    named_count = sum(map(len, glb_named.values()))
    out: dict = {"pass": True, "checks": []}

    def chk(name, got, want, ok=None):
        ok = (got == want) if ok is None else ok
        out["checks"].append({"name": name, "got": got, "want": want, "ok": bool(ok)})
        if not ok:
            out["pass"] = False

    # ---- 结构 ----
    chk("schema", mapping.get("schema"), "pdms-object-mapping/1")

    # ---- 数量闭合 ----
    um = mapping["unmatched"]
    chk("matched + unmatchedTxt == TXT 对象数",
        len(pairs) + len(um["txtOnly"]), len(txt))
    chk("matched + unmatchedGlbNamed == GLB 命名节点数",
        len(pairs) + len(um["glbNamedOnly"]), named_count)
    chk("stats.matched 与 pairs 一致", stats["matched"], len(pairs))
    chk("stats.unmatchedTxt 与清单一致", stats["unmatchedTxt"], len(um["txtOnly"]))
    chk("stats.glbNamedNodes 与 GLB 一致", stats["glbNamedNodes"], named_count)
    chk("stats.txtObjects 与 metadata 一致", stats["txtObjects"], len(txt))
    chk("stats.rvmGroups 与 RVM 索引一致", stats["rvmGroups"], len(rvm_index["groups"]))

    # ---- 键唯一 ----
    chk("pairs 键数 == 边数", len(pairs), len(set(pairs)))
    gi_dup = [k for k, v in Counter(p["glbNodeIndex"] for p in pairs.values()).items() if v > 1]
    chk("glbNodeIndex 无重复", len(gi_dup), 0)
    off_dup = [k for k, v in Counter(p["rvmOffset"] for p in pairs.values()).items() if v > 1]
    chk("rvmOffset 无重复", len(off_dup), 0)
    tids = [p["txtId"] for p in pairs.values()]
    chk("txtId 无重复", len(tids) - len(set(tids)), 0)

    # ---- TXT identity and independent source identity ----
    bad_key = [k for k, p in pairs.items()
               if txt.get(p["txtId"], {}).get("canonical") != k]
    chk("键 == TXT 侧 canonical", len(bad_key), 0)
    source = lambda key, pair: pair.get("sourceName", key)
    bad_glb = [k for k, p in pairs.items()
               if glb_named.get(source(k, p)) != [p["glbNodeIndex"]]]
    chk("sourceName == 唯一 GLB 节点名且序号一致", len(bad_glb), 0)
    rvm_by_id = {g["id"]: g for g in rvm_index["groups"]}
    bad_rvm = [k for k, p in pairs.items()
               if rvm_by_id.get(p.get("rvmId"), {}).get("name") != source(k, p)
               or rvm_by_id.get(p.get("rvmId"), {}).get("offset") != p.get("rvmOffset")]
    chk("sourceName / rvmOffset == RVM 索引锚点", len(bad_rvm), 0)
    chk("每边都有 rvmOffset", sum(1 for p in pairs.values() if p["rvmOffset"] is None), 0)

    # Do not silently accept fallback channels just because anchors exist.
    def normalized(name):
        return re.sub(r"\s+", " ", re.sub(r"/{2,}", "/", name.strip()))

    def identity(name):
        match = re.match(r"^([A-Za-z][A-Za-z0-9_]*)\s+([1-9][0-9]*)\s+of\s+.+$", name)
        return (match[1], int(match[2])) if match else None

    by_source = {source(key, pair): pair for key, pair in pairs.items()}
    txt_norm = Counter(normalized(obj["canonical"]) for obj in txt.values())
    source_norm = Counter(normalized(name) for name, indices in glb_named.items() for _ in indices)
    txt_children, source_children = Counter(), Counter()
    for obj in txt.values():
        token = identity(obj["canonical"])
        if token and token[0] == obj["type"]:
            txt_children[(obj["parent"], token)] += 1
    for group in rvm_index["groups"]:
        token = identity(group["name"])
        if token:
            source_children[(group.get("parentId"), token)] += 1

    def parent_name(index):
        parent = glb["parents"].get(index)
        seen = {index}
        while parent is not None and parent not in seen:
            seen.add(parent)
            name = glb["nodes"][parent].get("name")
            if name:
                return name
            parent = glb["parents"].get(parent)
        return None

    bad_channel = []
    for canonical, pair in pairs.items():
        name = source(canonical, pair)
        obj = txt.get(pair["txtId"], {})
        channel = pair.get("channel")
        if channel == "name":
            valid = name == canonical
        elif channel == "normalized":
            key = normalized(name)
            valid = (key == normalized(canonical)
                     and txt_norm[key] == source_norm[key] == 1)
        elif channel == "structure":
            group = rvm_by_id.get(pair.get("rvmId"), {})
            parent = rvm_by_id.get(group.get("parentId"), {})
            parent_pair = by_source.get(parent.get("name"), {})
            token = identity(name)
            valid = bool(token and token == identity(canonical)
                         and token[0] == obj.get("type")
                         and parent_pair and parent_pair.get("txtId") == obj.get("parent")
                         and parent_name(pair["glbNodeIndex"]) == parent.get("name")
                         and txt_children[(obj.get("parent"), token)] == 1
                         and source_children[(group.get("parentId"), token)] == 1)
        else:
            valid = False
        if not valid:
            bad_channel.append(canonical)
    chk("匹配通道具有名称或唯一父子序号证据", len(bad_channel), 0)

    # ---- 技术 id 回读（最强的一条）----
    readback_bad = []
    for k, p in pairs.items():
        nm = read_rvm_group_name(raw, p["rvmOffset"])
        if nm != source(k, p):
            readback_bad.append({"key": k, "offset": p["rvmOffset"], "readBack": nm})
    chk("按 rvmOffset 回读 RVM 二进制，名称与 sourceName 一致", len(readback_bad), 0)
    out["readbackChecked"] = len(pairs)
    out["readbackMismatchSamples"] = readback_bad[:10]

    # ---- 索引侧自洽 ----
    chk("RVM 索引自身无重名",
        sum(1 for v in Counter(g["name"] for g in rvm_index["groups"]).values() if v > 1), 0)
    chk("canonical 无重名",
        sum(1 for v in Counter(o["canonical"] for o in txt.values()).values() if v > 1), 0)
    chk("GLB 命名节点无重名", sum(len(indices) > 1 for indices in glb_named.values()), 0)
    chk("RVM id 无重复", len(rvm_index["groups"]) - len(rvm_by_id), 0)
    chk("RVM offset 无重复", len(rvm_index["groups"])
        - len({group["offset"] for group in rvm_index["groups"]}), 0)
    txt_coverage = Counter(tids + [item["txtId"] for item in um["txtOnly"]])
    chk("TXT 匹配与未匹配清单覆盖每个对象一次", txt_coverage == Counter(txt.keys()), True)
    actual_nodes = [index for indices in glb_named.values() for index in indices]
    node_coverage = Counter([pair["glbNodeIndex"] for pair in pairs.values()]
                            + [item["glbNodeIndex"] for item in um["glbNamedOnly"]])
    chk("GLB 匹配与未匹配清单覆盖每个节点一次", node_coverage == Counter(actual_nodes), True)

    # ---- 未匹配清单的原因字段必须存在且非空 ----
    chk("未匹配 TXT 项都有 reason",
        sum(1 for x in um["txtOnly"] if not x.get("reason")), 0)
    chk("未匹配 GLB 项都有 reason",
        sum(1 for x in um["glbNamedOnly"] if not x.get("reason")), 0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", type=Path, default=PROC / "mapping.json")
    ap.add_argument("--meta", type=Path, default=PROC / "metadata.json")
    ap.add_argument("--rvm-index", type=Path, default=PROC / "rvm-node-index.json")
    ap.add_argument("--glb", type=Path, default=PROC / "model.glb")
    ap.add_argument("--rvm", type=Path, default=None)
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()
    src = a.rvm or next(iter(sorted(SRC.glob("*.rvm"))))
    out = verify(json.loads(a.mapping.read_text(encoding="utf-8")),
                 json.loads(a.meta.read_text(encoding="utf-8")),
                 json.loads(a.rvm_index.read_text(encoding="utf-8")),
                 read_glb_index(a.glb), src.read_bytes())

    for c in out["checks"]:
        mark = "OK  " if c["ok"] else "FAIL"
        print(f'  [{mark}] {c["name"]:<44} got={c["got"]!r:<16} want={c["want"]!r}')
    print()
    print(f'回读验证 {out["readbackChecked"]:,} 条映射的 RVM 字节偏移')
    print("总判定：" + ("全部通过" if out["pass"] else f'失败 {sum(1 for c in out["checks"] if not c["ok"])} 项'))
    if a.json:
        Path(a.json).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"明细已写入 {a.json}")
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
