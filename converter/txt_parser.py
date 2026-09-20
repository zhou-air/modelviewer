"""② 元数据层 —— PDMS Data Listing (.txt) → metadata.json

通用解析器：不写死项目名、SITE 名、PIPE 名、SPEC、路径或元件数量。
任何符合 PDMS Data Listing 语法的文件都应能解析。

语法（实测归纳，见 reports/inspection.md §2.4）
--------------------------------------------------------------------------
  NEW <TYPE> [<NAME>]     节点开始。有名称时以 "/" 开头；匿名时该行只有 TYPE
  END                     节点结束
  <KEY> <VALUE>           属性。空格分隔（不是 ":="）。VALUE 原样保留
  OLD <SELECTOR>          指向已存在对象的属性块（文件后段）
  -- ...                  注释
  $...                    PDMS 指令（如 $S- / $S+ 同义词开关）
  行尾 $                  续行：与下一行拼接为同一条逻辑记录
--------------------------------------------------------------------------

两条设计要点
--------------------------------------------------------------------------
1) **属性只在"当前目标"存在时才算属性**。NEW..END 栈顶或最近的 OLD 选择器即当前目标；
   目标之外的 `ONERROR GOLABEL ...` / `INPUT BEGIN` / `handle ANY` 等一律视为宏命令。
   这样关键字与命令不会混进属性表。

2) **每个对象都推导一个 canonicalName**，规则与 PDMS/RVM 一致：
       有名对象 → 其 "/..." 名称
       匿名对象 → "<TYPE> <同类兄弟序号> of <父对象 canonicalName>"
   该规则在 Phase 1 已用文件自带的 1068 条 OLD 选择器做过验证（单层 221/221 命中）。
   它使 TXT 对象的 id 可以直接与 RVM/GLB 的节点名对应，是 Phase 4 映射的基础。

用法
--------------------------------------------------------------------------
    python converter/txt_parser.py                          # data/source 下唯一的 .txt
    python converter/txt_parser.py --source x.txt --out y.json
    python converter/txt_parser.py --pretty                 # 缩进输出（体积大，便于人看）
    python converter/txt_parser.py --metamodel out.json     # 额外导出 xeokit metamodel 形状
"""
from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source"
OUT_DIR = ROOT / "data" / "processed"

SCHEMA = "pdms-datalisting/1"

NEW_RE = re.compile(r"^NEW\s+([A-Za-z][A-Za-z0-9_]*)\s*(.*)$")
END_RE = re.compile(r"^END\s*$")
OLD_RE = re.compile(r"^OLD\s+(.+)$")
ATTR_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(.*)$")
# 选择器片段两种形态，分开匹配。
# 注意不要写成 ^TYPE(?:\s+(\d+))?\s+(\S.*)$ —— 对两段式 "SCTN 7" 该正则会把数字让给最后一段，
# 序号被误当成 1。这个歧义曾让 89 条选择器解析失败。
SEG_ANON_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(\d+)$")
SEG_NAMED_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s+(\S.*)$")


def split_segment(seg: str):
    """返回 (kind, type, index, name)；kind ∈ {'anon','named'}；无法识别返回 None。"""
    seg = seg.strip()
    m = SEG_ANON_RE.match(seg)
    if m:
        return ("anon", m.group(1), int(m.group(2)), None)
    m = SEG_NAMED_RE.match(seg)
    if m:
        return ("named", m.group(1), None, m.group(2))
    return None

# PDMS 宏关键字。这些词出现在行首时是宏命令，不是对象属性。
# 文件本身是一段可回灌 PDMS 的宏（ONERROR GOLABEL / INPUT BEGIN ... INPUT FINISH / LABEL ...），
# 用它来界定 OLD 引用区块的结束，避免把 `INPUT FINISH` 之类当成属性。
MACRO_KEYWORDS = {
    "INPUT", "LABEL", "RETURN", "ONERROR", "GOLABEL", "HANDLE", "ENDHANDLE",
    "MESSAGE", "SKIP", "GOTO", "IF", "ELSE", "ENDIF", "BREAK", "QUIT",
    "PAUSE", "CALL", "GOSUB", "TRAP", "EXIT",
}


@dataclass
class Obj:
    id: str                      # 技术 id，行锚定，保证唯一：txt:L<line>
    type: str
    name: str | None             # 原始 PDMS 名称（匿名时为 None）
    parent: str | None
    line: int
    end_line: int = 0
    depth: int = 0
    children: list[str] = field(default_factory=list)
    props: dict[str, str | list[str]] = field(default_factory=dict)
    prop_order: list[str] = field(default_factory=list)
    # OLD 引用区块的属性单独存放：语义上与节点内属性不同（HREF/TREF/CREF/RULE 等），
    # 混在一起会既重复又无法区分来源。
    override: dict[str, str | list[str]] = field(default_factory=dict)
    override_order: list[str] = field(default_factory=list)
    canonical: str = ""          # 派生名，与 PDMS/RVM 命名规则一致
    path: list[str] = field(default_factory=list)   # canonicalName 链


# --------------------------------------------------------------------------- 记录切分

def logical_records(text: str):
    """把物理行合成逻辑记录，处理行尾 `$` 续行。

    返回 [(line_start, line_end, merged_text)]，行号 1 起始。
    """
    lines = text.splitlines()
    out = []
    i = 0
    n = len(lines)
    while i < n:
        start = i + 1
        parts = [lines[i]]
        end = i + 1
        # 续行判定：非指令行（不以 $ 开头）且 rstrip 后以 $ 结尾
        cur = lines[i]
        while (cur.rstrip().endswith("$")
               and not cur.strip().startswith("$")
               and i + 1 < n):
            i += 1
            cur = lines[i]
            parts.append(cur)
            end = i + 1
        if len(parts) == 1:
            merged = parts[0].rstrip()
        else:
            # 去掉每个非末尾片段的行尾 $，拼接
            buf = []
            for k, p in enumerate(parts):
                p2 = p.rstrip()
                if k < len(parts) - 1 and p2.endswith("$"):
                    p2 = p2[:-1]
                buf.append(p2.strip() if k == 0 else p2.strip())
            merged = " ".join(s for s in buf if s != "")
        out.append((start, end, merged))
        i += 1
    return out


# --------------------------------------------------------------------------- 主解析

class Listing:
    def __init__(self) -> None:
        self.objects: dict[str, Obj] = {}
        self.order: list[str] = []          # 按出现顺序
        self.roots: list[str] = []
        self.references: dict[str, list] = defaultdict(list)
        self.unresolved_selectors: list[dict] = []
        self.line_classes: Counter = Counter()
        self.attr_keys: Counter = Counter()
        self.main_attrs = 0
        self.old_attrs = 0
        self.old_selectors = 0
        self.max_depth = 0
        self.preamble: list[str] = []
        self.trailer: list[str] = []
        self.new_count = 0
        self.end_count = 0
        self.continuation_rows = 0
        self.stray_end = 0

    # ---------- canonicalName ----------
    def _assign_names(self) -> None:
        """按出现顺序（父必先于子）计算 canonicalName / path / depth。

        规则与 RVM 一致：匿名对象 = "<TYPE> <同类兄弟序号> of <父 canonicalName>"。
        """
        sib_counter: dict[str, Counter] = {}
        for oid in self.order:
            o = self.objects[oid]
            if o.parent is None:
                o.depth = 0
                sib_counter[oid] = Counter()
            else:
                p = self.objects[o.parent]
                o.depth = p.depth + 1
                self.max_depth = max(self.max_depth, o.depth)
                c = sib_counter.setdefault(o.parent, Counter())
                c[o.type] += 1
                o.ordinal = c[o.type]          # type: ignore[attr-defined]
            if o.name:
                o.canonical = o.name
            else:
                ordv = getattr(o, "ordinal", 1)
                p = self.objects[o.parent]
                # 父级渲染规则与 PDMS/RVM 一致：
                #   有名父级 → "<父类型> <父名>"（类型要带上，例：of BRANCH /WG-10401-400-L1G/B2）
                #   匿名父级 → 父级自身的 canonical（已以 "<类型> <序号>" 开头）
                parent_ref = f"{p.type} {p.name}" if p.name else p.canonical
                o.canonical = f"{o.type} {ordv} of {parent_ref}"
            o.path = ([*self.objects[o.parent].path] if o.parent else []) + [o.canonical]

    # ---------- 属性 ----------
    def _add_attr(self, target: Obj | None, key: str, value: str, line: int, is_old: bool) -> None:
        if target is None:
            return
        self.attr_keys[key] += 1
        if is_old:
            self.old_attrs += 1
        else:
            self.main_attrs += 1
        bag = target.override if is_old else target.props
        order = target.override_order if is_old else target.prop_order
        prev = bag.get(key)
        if prev is None:
            bag[key] = value
            order.append(key)
        elif isinstance(prev, list):
            prev.append(value)
        else:
            bag[key] = [prev, value]


def parse(text: str, source_name: str) -> Listing:
    lst = Listing()
    records = logical_records(text)

    stack: list[Obj] = []
    old_target: Obj | None = None
    old_mode = False
    by_name: dict[str, str] = {}
    children_by_parent: dict[str | None, list[str]] = defaultdict(list)

    for line_start, line_end, raw in records:
        if line_end > line_start:
            lst.continuation_rows += 1
        s = raw.strip()
        if s == "":
            lst.line_classes["blank"] += 1
            continue
        if s.startswith("--"):
            lst.line_classes["comment"] += 1
            (lst.preamble if not lst.objects else lst.trailer).append(s)
            continue
        if s.startswith("$"):
            lst.line_classes["directive"] += 1
            (lst.preamble if not lst.objects else lst.trailer).append(s)
            continue

        m = NEW_RE.match(s)
        if m and not old_mode:
            otype, oname = m.group(1), m.group(2).strip()
            parent = stack[-1].id if stack else None
            oid = f"txt:L{line_start}"
            o = Obj(id=oid, type=otype, name=oname or None, parent=parent,
                    line=line_start, end_line=line_start)
            lst.objects[oid] = o
            lst.order.append(oid)
            if parent is None:
                lst.roots.append(oid)
            else:
                lst.objects[parent].children.append(oid)
            children_by_parent[parent].append(oid)
            if o.name:
                by_name.setdefault(o.name, oid)
            stack.append(o)
            lst.new_count += 1
            lst.line_classes["NEW"] += 1
            continue

        if END_RE.match(s):
            lst.end_count += 1
            lst.line_classes["END"] += 1
            if old_mode:
                old_mode = False
                old_target = None
            elif stack:
                stack[-1].end_line = line_end
                stack.pop()
            else:
                lst.stray_end += 1
            continue

        m = OLD_RE.match(s)
        if m:
            old_mode = True
            old_target = None
            lst.old_selectors += 1
            lst.line_classes["OLD"] += 1
            sel = m.group(1).strip()
            oid = resolve_selector(sel, by_name, lst.objects, children_by_parent)
            if oid is None:
                lst.unresolved_selectors.append({"selector": sel, "line": line_start})
            else:
                old_target = lst.objects[oid]
            continue

        m = ATTR_RE.match(s)
        if m and m.group(1).upper() not in MACRO_KEYWORDS:
            key, value = m.group(1), m.group(2).strip()
            target = old_target if old_mode else (stack[-1] if stack else None)
            if target is None:
                lst.line_classes["command"] += 1
                (lst.preamble if not lst.objects else lst.trailer).append(s)
                continue
            lst.line_classes["OLD_attr" if old_mode else "attr"] += 1
            lst._add_attr(target, key, value, line_start, is_old=old_mode)
            continue

        lst.line_classes["command"] += 1
        if m and m.group(1).upper() in MACRO_KEYWORDS:
            # 宏命令：结束 OLD 引用区块
            old_mode = False
            old_target = None
        (lst.preamble if not lst.objects else lst.trailer).append(s)

    lst.left_on_stack = len(stack)          # type: ignore[attr-defined]
    lst._assign_names()
    lst.by_name = by_name                   # type: ignore[attr-defined]
    return lst


# --------------------------------------------------------------------------- 选择器解析

def resolve_selector(sel: str, by_name: dict[str, str], objects: dict[str, Obj],
                     children_by_parent: dict) -> str | None:
    """把 OLD 选择器解析为对象 id。

    支持两种形态：
      "BRANCH /WG-10401-400-L1G/B2"                 有名对象 → 按名查
      "TEE 1 of BRANCH /WG-10401-400-L1G/B2"         匿名对象 → 父子序号
      "SNODE 3 of SCTN 5 of FRMWORK /CABLEf-BEAM"    多层 → 逐级下行
    """
    parts = [p.strip() for p in sel.split(" of ")]
    if not parts:
        return None
    if len(parts) == 1:
        seg = split_segment(parts[0])
        if seg is None:
            return None
        if seg[0] == "named":
            return by_name.get(seg[3]) or by_name.get(parts[0])
        return None
    # 末段 = 有名祖先；其余段是匿名对象链。
    # 选择器写法是「目标 … 祖先」，所以**从祖先往外要按 parts 的逆序展开**。
    last = split_segment(parts[-1])
    if last is None or last[0] != "named":
        return None
    anchor = by_name.get(last[3])
    if anchor is None:
        return None
    cur = anchor
    for seg_text in reversed(parts[:-1]):
        seg = split_segment(seg_text)
        if seg is None or seg[0] != "anon":
            return None
        ctype, idx = seg[1], seg[2]
        kids = [c for c in children_by_parent.get(cur, []) if objects[c].type == ctype]
        if len(kids) < idx:
            return None
        cur = kids[idx - 1]
    return cur


# --------------------------------------------------------------------------- 导出

def to_metadata(lst: Listing, source: Path, bytes_len: int, encoding: str) -> dict:
    objs = {}
    canonical_dup = Counter()
    name_counter = Counter(o.name for o in lst.objects.values() if o.name)
    for oid in lst.order:
        o = lst.objects[oid]
        canonical_dup[o.canonical] += 1
        d = {
            "id": o.id,
            "name": o.name,
            "type": o.type,
            "parent": o.parent,
            "children": o.children,
            "depth": o.depth,
            "canonical": o.canonical,
            "path": o.path,
            "line": o.line,
            "lineEnd": o.end_line,
            "props": o.props,
            "propOrder": o.prop_order,
        }
        if o.override:
            d["override"] = o.override
            d["overrideOrder"] = o.override_order
        objs[oid] = d

    dup = {k: v for k, v in canonical_dup.items() if v > 1}
    dup_names = {k: v for k, v in name_counter.items() if v > 1}
    return {
        "schema": SCHEMA,
        "source": {
            "file": source.name,
            "bytes": bytes_len,
            "encoding": encoding,
        },
        "roots": lst.roots,
        "objects": objs,
        "stats": {
            "objects": len(lst.objects),
            "roots": len(lst.roots),
            "maxDepth": lst.max_depth,
            "named": sum(1 for o in lst.objects.values() if o.name),
            "anonymous": sum(1 for o in lst.objects.values() if not o.name),
            "newCount": lst.new_count,
            "endCount": lst.end_count,
            "leftOnStack": getattr(lst, "left_on_stack", None),
            "strayEnd": lst.stray_end,
            "continuationRecords": lst.continuation_rows,
            "logicalRecords": sum(lst.line_classes.values()),
            "attributesMain": lst.main_attrs,
            "attributesOld": lst.old_attrs,
            "attributesTotal": lst.main_attrs + lst.old_attrs,
            "attributeKeyKinds": len(lst.attr_keys),
            "attributeKeys": dict(lst.attr_keys.most_common()),
            "types": dict(Counter(o.type for o in lst.objects.values()).most_common()),
            "lineClasses": dict(lst.line_classes),
            "oldSelectors": lst.old_selectors,
            "oldUnresolved": len(lst.unresolved_selectors),
            "objectsWithReferences": sum(1 for o in objs.values() if o.get("override")),
            "canonicalDuplicates": len(dup),
            "canonicalDuplicateExamples": dict(list(dup.items())[:10]),
            "nameDuplicates": len(dup_names),
            "nameDuplicateExamples": dict(list(dup_names.items())[:10]),
        },
        "unresolvedSelectors": lst.unresolved_selectors[:200],
    }


def to_metamodel(meta: dict) -> dict:
    """转成 xeokit metamodel 形状（供将来 xeokit 路线或其它工具复用）。

    id 使用 canonicalName —— 与 GLB 节点名同构，可直接关联几何。
    """
    meta_objects = []
    for o in meta["objects"].values():
        meta_objects.append({
            "id": o["canonical"],
            "name": o["canonical"],
            "type": o["type"],
            "parent": meta["objects"][o["parent"]]["canonical"] if o["parent"] else None,
            "originalName": o["name"],
            "lineId": o["id"],
        })
    property_sets = []
    for o in meta["objects"].values():
        if not o["props"] and not o.get("override"):
            continue
        props = []
        for bag, order in ((o["props"], o["propOrder"]), (o.get("override", {}), o.get("overrideOrder", []))):
            for k in order:
                v = bag[k]
                if isinstance(v, list):
                    for item in v:
                        props.append({"name": k, "value": item})
                else:
                    props.append({"name": k, "value": v})
        property_sets.append({
            "id": o["id"] + ":ps",
            "name": "PDMS",
            "type": "PDMS",
            "objectId": o["canonical"],
            "properties": props,
        })
    return {"metaObjects": meta_objects, "propertySets": property_sets}


# --------------------------------------------------------------------------- CLI

def pick_source() -> Path:
    cands = sorted(SRC_DIR.glob("*.txt"))
    if not cands:
        raise SystemExit(f"data/source 下没有 .txt：{SRC_DIR}")
    return cands[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--txt", type=Path, default=None, help="--source 的同义参数")
    ap.add_argument("--output", type=Path, default=None, help="--out 的同义参数")
    ap.add_argument("--pretty", action="store_true")
    ap.add_argument("--metamodel", type=Path, default=None,
                    help="额外导出 xeokit metamodel 形状的 JSON")
    a = ap.parse_args()
    a.source = a.txt or a.source
    a.out = a.output or a.out

    src = (a.source or pick_source()).resolve()
    a.out = a.out.resolve() if a.out else None
    a.metamodel = a.metamodel.resolve() if a.metamodel else None
    raw = src.read_bytes()
    bom = raw[:3] == b"\xef\xbb\xbf"
    text = raw.decode("utf-8-sig")
    enc = f"UTF-8{' with BOM' if bom else ''}"

    t0 = time.perf_counter()
    lst = parse(text, src.name)
    meta = to_metadata(lst, src, len(raw), enc)
    ms = int((time.perf_counter() - t0) * 1000)

    out = a.out or (OUT_DIR / "metadata.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    dump = json.dumps(meta, ensure_ascii=False,
                      indent=2 if a.pretty else None,
                      separators=None if a.pretty else (",", ":"))
    out.write_text(dump, encoding="utf-8")

    if a.metamodel:
        a.metamodel.parent.mkdir(parents=True, exist_ok=True)
        a.metamodel.write_text(
            json.dumps(to_metamodel(meta), ensure_ascii=False,
                       separators=(",", ":")), encoding="utf-8")

    s = meta["stats"]
    print(f"源文件      {src.name}  {len(raw):,} B  {enc}")
    print(f"逻辑记录    {len(logical_records(text)):,}（其中续行记录 {s['continuationRecords']}）")
    print(f"对象        {s['objects']:,} 个（根 {s['roots']} · 有名 {s['named']:,} · 匿名 {s['anonymous']:,}）")
    print(f"层级        最大深度 {s['maxDepth']}  NEW {s['newCount']} / END {s['endCount']}"
          f" · 栈残余 {s['leftOnStack']}")
    print(f"属性        {s['attributesTotal']:,} 条（主区 {s['attributesMain']:,} + OLD 区 {s['attributesOld']:,}）"
          f" · {s['attributeKeyKinds']} 种键")
    print(f"类型        {len(s['types'])} 种")
    print(f"OLD 选择器  {s['oldSelectors']:,} 条 · 未解析 {s['oldUnresolved']}"
          f" · 带引用对象 {s['objectsWithReferences']:,}")
    print(f"canonical   重名 {s['canonicalDuplicates']}")
    print(f"耗时        {ms} ms")
    print(f"产出        {out.relative_to(ROOT)}  {out.stat().st_size:,} B")
    if a.metamodel:
        print(f"            {a.metamodel.relative_to(ROOT)}  {a.metamodel.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
