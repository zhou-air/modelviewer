"""RVM-only 链路的独立校验闸门（替代 TXT 链路里的 verify_metadata + verify_mapping）。

要证明的事情只有一件：**这份 metadata/mapping 确实是从这份 RVM + 这份 GLB 推出来的，
没有任何凭空补出来的对象、名字或映射**。所以检查全部围绕"闭合"与"回读"：

  1) schema 与来源标记：必须是 pdms-datalisting/1 + metadataSource=rvm
  2) 数量闭合：对象数 == RVM 组数；matched + 未匹配 == 双端各自的真实总数
  3) 键唯一：canonical、pairs 键、glbNodeIndex、rvmOffset 都不许重复
  4) 树自洽：children/parent 双向一致、depth 与父链一致、无环、root 的 parent 为空
  5) **技术 id 回读**：按 rvmOffset 回到 RVM 二进制，该偏移必须真的是 CNTB 且组名 == 键
     —— 这证明映射锚定的是同一个对象，而不是凑出来的数字
  6) 链路自述：props 必须为空、line/lineEnd 必须为 null（本链路声称没有工程属性，
     若出现非空即为矛盾，必须查清而不是放过）

用法：
    python converter/verify_rvm_metadata.py --metadata ... --mapping ... --rvm-index ... \
        --glb ... --rvm ... --json out.json
"""
from __future__ import annotations

import argparse
import json
import struct
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"


def read_glb_named(path: Path) -> dict:
    raw = path.read_bytes()
    off, J = 12, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        if ctype == 0x4E4F534A:
            J = json.loads(raw[off + 8:off + 8 + clen].decode("utf-8"))
        off += 8 + clen
        off += (-clen) % 4
    named = {}
    for i, n in enumerate(J.get("nodes", [])):
        nm = n.get("name")
        if nm:
            named.setdefault(nm, i)
    return named


def read_rvm_group_name(raw: bytes, offset: int):
    """在给定偏移读 CNTB chunk 的组名；偏移不是合法 CNTB 时返回 None。

    chunk 头 = 4×uint32 标签 + next_offset + 保留 = 24 字节
    CNTB payload = version(uint32) + 名称字长(uint32，单位 4 字节) + 名称字节
    所以名称的**长度字段**在 offset+28，名称字节在 offset+32。
    """
    if offset + 32 > len(raw):
        return None
    tag = "".join(chr(struct.unpack_from(">I", raw, offset + i * 4)[0]) for i in range(4))
    if tag != "CNTB":
        return None
    q = offset + 24 + 4
    n = struct.unpack_from(">I", raw, q)[0] * 4
    if q + 4 + n > len(raw):
        return None
    return raw[q + 4:q + 4 + n].split(b"\0")[0].decode("utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metadata", type=Path, default=PROC / "metadata.json")
    ap.add_argument("--mapping", type=Path, default=PROC / "mapping.json")
    ap.add_argument("--rvm-index", type=Path, default=PROC / "rvm-node-index.json")
    ap.add_argument("--glb", type=Path, default=PROC / "model.glb")
    ap.add_argument("--rvm", type=Path, default=None, help="原始 .rvm；给了才做字节回读")
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()

    meta = json.loads(a.metadata.read_text(encoding="utf-8"))
    mapping = json.loads(a.mapping.read_text(encoding="utf-8"))
    index = json.loads(a.rvm_index.read_text(encoding="utf-8"))
    glb_named = read_glb_named(a.glb)

    objs = meta["objects"]
    pairs = mapping["pairs"]
    um = mapping["unmatched"]
    groups = index["groups"]
    out: dict = {"pass": True, "checks": []}

    def chk(name, got, want, ok=None):
        ok = (got == want) if ok is None else ok
        out["checks"].append({"name": name, "got": got, "want": want, "ok": bool(ok)})
        if not ok:
            out["pass"] = False

    # ---------- 1 来源与 schema ----------
    chk("metadata schema", meta.get("schema"), "pdms-datalisting/1")
    chk("metadataSource", meta.get("metadataSource"), "rvm")
    chk("mapping schema", mapping.get("schema"), "pdms-object-mapping/1")
    chk("mapping.metadataSource", mapping.get("metadataSource"), "rvm")

    # ---------- 2 数量闭合 ----------
    chk("对象数 == RVM 组数", len(objs), len(groups))
    chk("matched + 未匹配RVM == RVM 组数",
        len(pairs) + len(um.get("rvmOnly") or []), len(groups))
    chk("matched + 未匹配GLB命名 == GLB 命名节点数",
        len(pairs) + len(um.get("glbNamedOnly") or []), len(glb_named))
    chk("stats.matched 与 pairs 一致", mapping["stats"]["matched"], len(pairs))
    chk("stats.rvmGroups 与索引一致", mapping["stats"]["rvmGroups"], len(groups))
    chk("stats.glbNamedNodes 与 GLB 一致", mapping["stats"]["glbNamedNodes"], len(glb_named))
    chk("stats.unmatchedRvm 与清单一致", mapping["stats"].get("unmatchedRvm"),
        len(um.get("rvmOnly") or []))
    chk("stats.unmatchedGlbNamed 与清单一致", mapping["stats"]["unmatchedGlbNamed"],
        len(um.get("glbNamedOnly") or []))

    # ---------- 3 键唯一 ----------
    chk("canonical 无重名",
        sum(1 for v in Counter(o["canonical"] for o in objs.values()).values() if v > 1), 0)
    chk("pairs 键数 == 边数", len(pairs), len(set(pairs)))
    chk("glbNodeIndex 无重复",
        sum(1 for v in Counter(p["glbNodeIndex"] for p in pairs.values()).values() if v > 1), 0)
    chk("rvmOffset 无重复",
        sum(1 for v in Counter(p["rvmOffset"] for p in pairs.values()).values() if v > 1), 0)
    chk("对象 id 无重复",
        len(objs) - len({o["id"] for o in objs.values()}), 0)

    # ---------- 4 逐对象与 RVM 索引对齐 ----------
    idx_by_id = {g["id"]: g for g in groups}
    chk("对象 id 集合 == RVM 组 id 集合", set(objs) == set(idx_by_id), True)
    bad_name = [oid for oid, o in objs.items()
                if idx_by_id.get(oid, {}).get("name") != o["canonical"]]
    chk("每个对象的 canonical == 对应 RVM 组名", len(bad_name), 0)
    bad_parent = [oid for oid, o in objs.items()
                  if o.get("parent") != idx_by_id.get(oid, {}).get("parentId")]
    chk("每个对象的 parent == RVM 索引 parentId", len(bad_parent), 0)
    bad_depth = [oid for oid, o in objs.items()
                 if o.get("depth") != idx_by_id.get(oid, {}).get("depth")]
    chk("每个对象的 depth == RVM 索引 depth", len(bad_depth), 0)

    # ---------- 5 树自洽 + 无环 ----------
    bad_child = bad_stub = 0
    for oid, o in objs.items():
        for cid in o.get("children") or []:
            c = objs.get(cid)
            if c is None:
                bad_stub += 1
            elif c.get("parent") != oid:
                bad_child += 1
    chk("children 里的 id 都存在", bad_stub, 0)
    chk("children 与 parent 双向一致", bad_child, 0)
    chk("root 的 parent 为空",
        sum(1 for r in meta["roots"] if objs.get(r, {}).get("parent") is not None), 0)
    chk("roots 无重复", len(meta["roots"]) - len(set(meta["roots"])), 0)
    cycle = 0
    for oid in objs:
        seen, cur, guard = set(), oid, 0
        while cur is not None and guard <= len(objs):
            if cur in seen:
                cycle += 1
                break
            seen.add(cur)
            cur = objs.get(cur, {}).get("parent")
            guard += 1
    chk("父链无环", cycle, 0)

    # ---------- 6 映射自洽 ----------
    bad_txtid = [k for k, p in pairs.items()
                 if objs.get(p.get("txtId"), {}).get("canonical") != k]
    chk("键 == 对象侧 canonical（txtId 回指自洽）", len(bad_txtid), 0)
    bad_glb = [k for k, p in pairs.items() if glb_named.get(k) != p["glbNodeIndex"]]
    chk("键 == GLB 节点名且序号一致", len(bad_glb), 0)
    idx_by_name = {g["name"]: g for g in groups}
    bad_rvm = [k for k, p in pairs.items() if idx_by_name.get(k, {}).get("id") != p["rvmId"]]
    chk("键 == RVM 组名且 id 一致", len(bad_rvm), 0)
    chk("每边都有 rvmOffset", sum(1 for p in pairs.values() if p["rvmOffset"] is None), 0)

    # ---------- 7 技术 id 回读（最强的一条）----------
    readback_bad = []
    if a.rvm and Path(a.rvm).exists():
        raw = Path(a.rvm).read_bytes()
        for k, p in pairs.items():
            nm = read_rvm_group_name(raw, p["rvmOffset"])
            if nm != k:
                readback_bad.append({"key": k, "offset": p["rvmOffset"], "readBack": nm})
        chk("按 rvmOffset 回读 RVM 二进制，名称与键一致", len(readback_bad), 0)
        out["readbackChecked"] = len(pairs)
        out["readbackMismatchSamples"] = readback_bad[:10]
    else:
        out["readbackChecked"] = 0
        out["readbackSkipped"] = "未提供 --rvm，跳过字节回读"

    # ---------- 8 链路自述不得自相矛盾 ----------
    chk("props 全为空（RVM 无工程属性）",
        sum(1 for o in objs.values() if o.get("props")), 0)
    chk("line/lineEnd 全为 null（RVM 无原文行）",
        sum(1 for o in objs.values() if o.get("line") is not None
            or o.get("lineEnd") is not None), 0)
    chk("未匹配 RVM 项都有 reason",
        sum(1 for x in (um.get("rvmOnly") or []) if not x.get("reason")), 0)
    chk("未匹配 GLB 项都有 reason",
        sum(1 for x in (um.get("glbNamedOnly") or []) if not x.get("reason")), 0)

    for c in out["checks"]:
        mark = "OK  " if c["ok"] else "FAIL"
        print(f'  [{mark}] {c["name"]:<46} got={c["got"]!r:<16} want={c["want"]!r}')
    print()
    if out["readbackChecked"]:
        print(f'回读验证 {out["readbackChecked"]:,} 条映射的 RVM 字节偏移')
    print("总判定：" + ("全部通过" if out["pass"] else
                    f'失败 {sum(1 for c in out["checks"] if not c["ok"])} 项'))
    if a.json:
        Path(a.json).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"明细已写入 {a.json}")
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
