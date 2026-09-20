"""映射结果独立校验器（③ 映射层的回归闸门）。

重点检查三件事：
  1) 数量闭合：matched + unmatched 必须等于双端各自的真实总数
  2) 名称一致：每条边的键（canonical）在 GLB 端与 TXT 端都真实存在且同名
  3) **技术 id 回读**：按 rvmOffset 回到 RVM 二进制，该偏移处必须真的是一个 CNTB chunk，
     且其名称与键完全一致 —— 这证明"字节偏移"确实锚定同一个对象，而不是凑出来的数字

用法：
    python converter/verify_mapping.py [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import struct
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
SRC = ROOT / "data" / "source"


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
    for i, n in enumerate(J["nodes"]):
        if n.get("name"):
            named.setdefault(n["name"], i)
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
    q = offset + 24 + 4                       # 跳过 version
    n = struct.unpack_from(">I", raw, q)[0] * 4
    if q + 4 + n > len(raw):
        return None
    return raw[q + 4:q + 4 + n].split(b"\0")[0].decode("utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", type=Path, default=PROC / "mapping.json")
    ap.add_argument("--meta", type=Path, default=PROC / "metadata.json")
    ap.add_argument("--rvm-index", type=Path, default=PROC / "rvm-node-index.json")
    ap.add_argument("--glb", type=Path, default=PROC / "model.glb")
    ap.add_argument("--rvm", type=Path, default=None)
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()

    mapping = json.loads(a.mapping.read_text(encoding="utf-8"))
    meta = json.loads(a.meta.read_text(encoding="utf-8"))
    rvm_index = json.loads(a.rvm_index.read_text(encoding="utf-8"))
    glb_named = read_glb_named(a.glb)

    txt = meta["objects"]
    pairs = mapping["pairs"]
    stats = mapping["stats"]
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
        len(pairs) + len(um["glbNamedOnly"]), len(glb_named))
    chk("stats.matched 与 pairs 一致", stats["matched"], len(pairs))
    chk("stats.unmatchedTxt 与清单一致", stats["unmatchedTxt"], len(um["txtOnly"]))
    chk("stats.glbNamedNodes 与 GLB 一致", stats["glbNamedNodes"], len(glb_named))
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

    # ---- 每条边的名称一致 ----
    bad_key = [k for k, p in pairs.items()
               if txt.get(p["txtId"], {}).get("canonical") != k]
    chk("键 == TXT 侧 canonical", len(bad_key), 0)
    bad_glb = [k for k, p in pairs.items() if glb_named.get(k) != p["glbNodeIndex"]]
    chk("键 == GLB 节点名且序号一致", len(bad_glb), 0)
    rvm_by_id = {g["id"]: g for g in rvm_index["groups"]}
    bad_rvm = [k for k, p in pairs.items()
               if rvm_by_id.get(p.get("rvmId"), {}).get("name") != k]
    chk("键 == RVM 组名", len(bad_rvm), 0)
    chk("每边都有 rvmOffset", sum(1 for p in pairs.values() if p["rvmOffset"] is None), 0)

    # ---- 技术 id 回读（最强的一条）----
    src = a.rvm or next(iter(sorted(SRC.glob("*.rvm"))))
    raw = src.read_bytes()
    readback_bad = []
    for k, p in pairs.items():
        nm = read_rvm_group_name(raw, p["rvmOffset"])
        if nm != k:
            readback_bad.append({"key": k, "offset": p["rvmOffset"], "readBack": nm})
    chk("按 rvmOffset 回读 RVM 二进制，名称与键一致", len(readback_bad), 0)
    out["readbackChecked"] = len(pairs)
    out["readbackMismatchSamples"] = readback_bad[:10]

    # ---- 索引侧自洽 ----
    chk("RVM 索引自身无重名",
        sum(1 for v in Counter(g["name"] for g in rvm_index["groups"]).values() if v > 1), 0)
    chk("canonical 无重名",
        sum(1 for v in Counter(o["canonical"] for o in txt.values()).values() if v > 1), 0)

    # ---- 未匹配清单的原因字段必须存在且非空 ----
    chk("未匹配 TXT 项都有 reason",
        sum(1 for x in um["txtOnly"] if not x.get("reason")), 0)
    chk("未匹配 GLB 项都有 reason",
        sum(1 for x in um["glbNamedOnly"] if not x.get("reason")), 0)

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
