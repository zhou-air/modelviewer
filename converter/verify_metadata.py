"""metadata.json 独立校验器（② 元数据层的回归闸门）。

刻意与 txt_parser.py 走**不同的代码路径**从原文重算，再与产物逐项对账：
不是"再跑一遍同样的代码"，所以能真正发现丢数据、重复、值被改写、层级断裂。

用法：
    python converter/verify_metadata.py                       # 默认源与产物
    python converter/verify_metadata.py --source x.txt --meta y.json --json out.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW = re.compile(r"^NEW\s+([A-Za-z][A-Za-z0-9_]*)\s*(.*)$")
END = re.compile(r"^END\s*$")
OLD = re.compile(r"^OLD\s+(.+)$")
ATTR = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(.*)$")
MACRO = {
    "INPUT", "LABEL", "RETURN", "ONERROR", "GOLABEL", "HANDLE", "ENDHANDLE",
    "MESSAGE", "SKIP", "GOTO", "IF", "ELSE", "ENDIF", "BREAK", "QUIT",
    "PAUSE", "CALL", "GOSUB", "TRAP", "EXIT",
}


def scan_raw(text: str):
    """独立扫描原文：不合并续行地用最小状态机重算所有可对账的量。

    续行处理：行尾 `$` 且非 `$` 开头 → 与下一行拼接（与解析器同样的语义，
    但这里用直观实现，便于交叉验证）。
    """
    lines = text.splitlines()
    # 先做续行合并，并记录每条逻辑记录覆盖的物理行
    records = []
    i = 0
    n = len(lines)
    while i < n:
        parts = [lines[i]]
        start = i + 1
        while (parts[-1].rstrip().endswith("$")
               and not parts[-1].strip().startswith("$")
               and i + 1 < n):
            i += 1
            parts.append(lines[i])
        end = i + 1
        if len(parts) == 1:
            merged = parts[0].rstrip()
        else:
            merged = " ".join(
                (p.rstrip()[:-1] if (k < len(parts) - 1 and p.rstrip().endswith("$")) else p).strip()
                for k, p in enumerate(parts)
            )
        records.append((start, end, merged))
        i += 1

    res = {
        "physicalLines": len(lines),
        "logicalRecords": len(records),
        "continuationRecords": sum(1 for a, b, _ in records if b > a),
        "new": 0, "end": 0, "oldSelectors": 0,
        "types": Counter(), "keysMain": Counter(), "keysOld": Counter(),
        "attrsMain": 0, "attrsOld": 0,
        "pairsMain": Counter(),          # (node_line, key, value)
        "pairsOld": Counter(),           # (key, value)
        "pairsAll": Counter(),
        "nodeNames": Counter(),
        "maxNodeStack": 0, "stackLeft": 0, "strayEnd": 0,
    }
    stack: list[int] = []
    in_old = False
    for start, end, raw in records:
        s = raw.strip()
        if not s or s.startswith("--") or s.startswith("$"):
            continue
        m = NEW.match(s)
        if m and not in_old:
            res["new"] += 1
            res["types"][m.group(1)] += 1
            nm = m.group(2).strip()
            if nm:
                res["nodeNames"][nm] += 1
            stack.append(start)
            res["maxNodeStack"] = max(res["maxNodeStack"], len(stack))
            continue
        if END.match(s):
            res["end"] += 1
            if in_old:
                in_old = False
            elif stack:
                stack.pop()
            else:
                res["strayEnd"] += 1
            continue
        if OLD.match(s):
            res["oldSelectors"] += 1
            in_old = True
            continue
        m = ATTR.match(s)
        if m and m.group(1).upper() not in MACRO:
            key, val = m.group(1), m.group(2).strip()
            res["pairsAll"][(key, val)] += 1
            if in_old:
                res["attrsOld"] += 1
                res["keysOld"][key] += 1
                res["pairsOld"][(key, val)] += 1
            else:
                res["attrsMain"] += 1
                res["keysMain"][key] += 1
                res["pairsMain"][(stack[-1], key, val)] += 1
            continue
        # 宏命令：结束 OLD 区块
        in_old = False

    res["stackLeft"] = len(stack)
    res["_records"] = records
    return res


SEG_ANON = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(\d+)$")
SEG_NAMED = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(\S.*)$")


def split_seg_local(seg: str):
    """'(TYPE, n)' 或 '(TYPE, path)'；识别不了返回 None。与解析器分开实现。"""
    seg = seg.strip()
    m = SEG_ANON.match(seg)
    if m:
        return (m.group(1), m.group(2))
    m = SEG_NAMED.match(seg)
    if m:
        return (m.group(1), m.group(2))
    return None


def check(src_path: Path, meta_path: Path) -> dict:
    raw = src_path.read_bytes()
    text = raw.decode("utf-8-sig")
    r = scan_raw(text)
    records_all = r["_records"]
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    s = meta["stats"]
    objs = meta["objects"]
    out: dict = {"pass": True, "checks": []}

    def chk(name, got, want, ok=None):
        ok = (got == want) if ok is None else ok
        out["checks"].append({"name": name, "got": got, "want": want, "ok": bool(ok)})
        if not ok:
            out["pass"] = False

    # 物理行数 = 逻辑记录 + 跨行续行。原实现写死 92871（QICHUANG 单文件的实测值），
    # 换任何别的 TXT 都会误报失败，无法作为通用导入闸门。此处换成等价的结构恒等式，
    # 保留原检查的用意（独立重算 vs 产物自记 的交叉对账）：
    # 本样例 92843 + 28 = 92871，与原常量完全相等（已在设计文档 §1.2 记录）。
    chk("物理行数", r["physicalLines"], s["logicalRecords"] + s["continuationRecords"])
    chk("逻辑记录数", r["logicalRecords"], s["logicalRecords"])
    chk("续行记录", r["continuationRecords"], s["continuationRecords"])
    chk("NEW 数", r["new"], s["newCount"])
    chk("END 数", r["end"], s["endCount"])
    chk("NEW/END 配平", r["new"], r["end"])
    chk("栈残余", r["stackLeft"], 0)
    chk("游离 END", r["strayEnd"], 0)
    chk("对象数", len(objs), r["new"])
    chk("根数", len(meta["roots"]), 1)
    chk("有名对象数", sum(1 for o in objs.values() if o["name"]), s["named"])
    chk("无名对象数", sum(1 for o in objs.values() if not o["name"]), s["anonymous"])
    chk("对象类型种数", len(s["types"]), len(r["types"]))
    chk("类型直方图", dict(s["types"]), dict(r["types"].most_common()))
    chk("原始名称直方图(去重计数)",
        Counter(o["name"] for o in objs.values() if o["name"]), r["nodeNames"])

    # 属性：主区按 (节点行, key, value) 精确对账；OLD 区按 (key, value) 多重集对账
    # 节点内属性 → props（按节点行精确对账）；OLD 引用区块 → override（按多重集对账）
    got_main = Counter()
    got_old = Counter()
    got_all = Counter()
    for o in objs.values():
        for k, v in o["props"].items():
            for one in (v if isinstance(v, list) else [v]):
                got_main[(o["line"], k, one)] += 1
                got_all[(k, one)] += 1
        for k, v in o.get("override", {}).items():
            for one in (v if isinstance(v, list) else [v]):
                got_old[(k, one)] += 1
                got_all[(k, one)] += 1
    chk("主区属性条数", s["attributesMain"], r["attrsMain"])
    chk("OLD 区属性条数", s["attributesOld"], r["attrsOld"])
    chk("属性总数", s["attributesTotal"], r["attrsMain"] + r["attrsOld"])
    chk("属性键种数", s["attributeKeyKinds"], len(r["keysMain"] + r["keysOld"]))

    def diff(a: Counter, b: Counter):
        """两个多重集的对称差条目数；用于属性逐条对账，避免打印上万条明细。"""
        return sum((a - b).values()) + sum((b - a).values())

    d_all = diff(got_all, r["pairsAll"])
    chk("全部属性 (key,value) 多重集与原文一致", d_all, 0)
    d_main = diff(got_main, r["pairsMain"])
    chk("主区属性按(节点行,key,value)与原文一致", d_main, 0)
    d_old = diff(got_old, r["pairsOld"])
    chk("OLD 区属性 (key,value) 与原文一致", d_old, 0)
    if d_all:
        out["attrDiffSamples"] = {
            "metadata_only": [list(x) for x in list((got_all - r["pairsAll"]).keys())[:10]],
            "raw_only": [list(x) for x in list((r["pairsAll"] - got_all).keys())[:10]],
        }

    chk("OLD 选择器数", s["oldSelectors"], r["oldSelectors"])
    chk("OLD 选择器未解析数", s["oldUnresolved"], 0)
    chk("canonical 重名数", s["canonicalDuplicates"], 0)
    chk("原始名称重名数", s["nameDuplicates"], 0)

    # 树完整性
    ids = set(objs)
    missing_parent = [o["id"] for o in objs.values() if o["parent"] and o["parent"] not in ids]
    chk("父引用全部可达", len(missing_parent), 0)
    kids = defaultdict(list)
    for o in objs.values():
        if o["parent"]:
            kids[o["parent"]].append(o["id"])
    bad_children = [o["id"] for o in objs.values() if sorted(o["children"]) != sorted(kids[o["id"]])]
    chk("children 与 parent 双向一致", len(bad_children), 0)
    # 可达性 + 深度一致 + 无环
    seen = set()
    stack = list(meta["roots"])
    depth_err = 0
    while stack:
        oid = stack.pop()
        if oid in seen:
            continue
        seen.add(oid)
        o = objs[oid]
        if o["parent"]:
            if o["depth"] != objs[o["parent"]]["depth"] + 1:
                depth_err += 1
        elif o["depth"] != 0:
            depth_err += 1
        stack.extend(o["children"])
    chk("从根可达的对象数", len(seen), len(objs))
    chk("depth 与父子关系一致", depth_err, 0)
    chk("无环（可达数 == 总数）", len(seen), len(objs))

    # canonical 规则独立复算。
    # 序号按**全部同类兄弟**计数（含其中有名字的那些）——这是 PDMS 的做法，
    # 外部依据：文件自带的 OLD 选择器与 RVM 合成名都能对上（见下面的闭环检查）。
    recalc_err = 0
    counters: dict[str, Counter] = {}
    for o in sorted(objs.values(), key=lambda x: x["line"]):
        if o["parent"]:
            c = counters.setdefault(o["parent"], Counter())
            c[o["type"]] += 1
            ordv = c[o["type"]]
        else:
            ordv = 1
        if o["name"]:
            want = o["name"]
        else:
            par = objs[o["parent"]]
            pref = f'{par["type"]} {par["name"]}' if par["name"] else par["canonical"]
            want = f'{o["type"]} {ordv} of {pref}'
        if want != o["canonical"]:
            recalc_err += 1
    chk("canonical 规则独立复算一致", recalc_err, 0)

    # ---- 外部闭环：文件自带的每条 OLD 选择器，其字符串应恰好等于被指对象的
    #      canonical（匿名对象）或 "<类型> <canonical>"（有名对象）。
    #      这不是"再跑一遍自己的规则"，而是拿 PDMS 自己写下的名字来验收。 ----
    by_canonical = {o["canonical"]: oid for oid, o in objs.items()}
    sel_ok = sel_bad = 0
    sel_bad_samples = []
    for start, end, raw in records_all:
        m = OLD.match(raw.strip())
        if not m:
            continue
        sel = m.group(1).strip()
        # 匿名对象：canonical 本身就是选择器字符串，直接查表
        probe = by_canonical.get(sel)
        if probe is None:
            # 有名对象：选择器形如 "<类型> <名称>"，用名称查
            seg = split_seg_local(sel.split(" of ")[0])
            if seg and not seg[1].isdigit():
                probe = by_canonical.get(seg[1])
        if probe is None:
            sel_bad += 1
            if len(sel_bad_samples) < 5:
                sel_bad_samples.append("未找到目标: " + sel)
            continue
        o = objs[probe]
        ok = (o["canonical"] == sel) or (
            o["name"] and f'{o["type"]} {o["name"]}' == sel)
        if ok:
            sel_ok += 1
        else:
            sel_bad += 1
            if len(sel_bad_samples) < 5:
                sel_bad_samples.append(f'{sel} -> {o["canonical"]}')
    chk("OLD 选择器字符串 == 目标 canonical（外部闭环）", sel_bad, 0,
        ok=(sel_ok > 0 and sel_bad == 0))
    out["selectorClosedLoop"] = {"matched": sel_ok, "mismatched": sel_bad,
                                 "samples": sel_bad_samples}

    out["raw"] = {k: (dict(v) if isinstance(v, Counter) else v)
                  for k, v in r.items()
                  if k not in ("pairsMain", "pairsOld", "pairsAll", "nodeNames", "_records")}
    out["meta"] = s
    out["fails"] = [c for c in out["checks"] if not c["ok"]]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=None)
    ap.add_argument("--meta", type=Path, default=None)
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()
    src = a.source or next(iter(sorted((ROOT / "data" / "source").glob("*.txt"))))
    meta = a.meta or (ROOT / "data" / "processed" / "metadata.json")

    res = check(Path(src), Path(meta))
    for c in res["checks"]:
        mark = "OK  " if c["ok"] else "FAIL"
        print(f'  [{mark}] {c["name"]:<34} got={c["got"]!r:<22} want={c["want"]!r}')
    print()
    print("总判定：" + ("全部通过" if res["pass"] else f'失败 {len(res["fails"])} 项'))
    if a.json:
        Path(a.json).write_text(json.dumps(res, ensure_ascii=False, indent=2, default=str),
                                encoding="utf-8")
        print(f"明细已写入 {a.json}")
    return 0 if res["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
