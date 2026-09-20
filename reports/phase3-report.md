# Phase 3 — TXT → metadata.json

- 状态：**已完成**，33 项独立校验全部通过
- 日期：2026-09-18
- 范围：只做 ② 元数据层。**未做** 对象映射（Phase 4）、Viewer 交互（Phase 5）
- 产物：`data/processed/metadata.json`

---

## 1. 结论

TXT 已被通用解析器完整吃下，并与原文**逐条对账通过**。关键收获是：**TXT 推导出的对象名可以精确复现 PDMS 自己写下的引用名**——文件自带的 1,068 条 `OLD` 选择器字符串与计算出的 canonical 名**100% 相等**（闭环验证）。这使得 Phase 4 的映射有了可靠基础，而不是靠序号硬凑。

**Phase 4 预演**：拿 TXT 的 8,955 个 canonical 名与 GLB 的 7,423 个节点名对撞 → **交集 7,420**，GLB 侧命中率 **99.96%**，未命中的 3 个全是技术节点（`/MDBs`、源文件路径节点、`rvmparser-rotate-z-to-y`）。

---

## 2. 产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `data/processed/metadata.json` | 5,541,010 B (5.3 MiB) | 主产物。紧凑 JSON，供 viewer/映射层加载 |
| `data/processed/metadata.metamodel.json` | 5,501,767 B (5.2 MiB) | 附加导出，**xeokit metamodel 形状**，见 §6 |

解析耗时 **179 ms**。

### 2.1 metadata.json 结构

```jsonc
{
  "schema": "pdms-datalisting/1",
  "source": { "file": "...", "bytes": 1344437, "encoding": "UTF-8 with BOM" },
  "roots": ["txt:L8"],
  "objects": {
    "txt:L31": {
      "id": "txt:L31",              // 技术 id（行锚定，保证唯一）
      "name": "/WG-10401-400-L1G/B2", // 原始 PDMS 名（匿名时 null）—— 原样保留
      "type": "BRANCH",              // 原始类型 —— 原样保留
      "parent": "txt:L13",
      "children": ["txt:L33", "..."],
      "depth": 4,
      "canonical": "/WG-10401-400-L1G/B2",  // 派生名，与 PDMS/RVM 引用名同构
      "path": ["/ENCOSC23059-QICHUANG-SITE", "...", "/WG-10401-400-L1G/B2"],
      "line": 31, "lineEnd": 60,     // 原文行范围，便于回溯
      "props": { "HPOS": "E 9723mm N 23320mm U 4154.5mm", "BORE": "400mm",
                 "RULE": ["...", "..."] },   // 重复键 → 数组，不覆盖
      "propOrder": ["BUIL", "SHOP", "BORE", "..."]  // 保留原始出现顺序
    }
  },
  "stats": { /* 见 §3，含全部对账数字 */ },
  "unresolvedSelectors": []          // 当前为空
}
```

关于 `props` 的三个决定（都为了"不丢数据"）：

| 决定 | 原因 |
|---|---|
| 值**原样保留**（`"E 9723mm N 23320mm U 4154.5mm"`，含引号如 `'unset'`） | 不做单位换算、不剥引号、不猜语义。解析语义是消费层的事 |
| 重复键存成**数组**（`RULE` 最多 4 次/节点） | 覆盖会丢数据；PDMS 的 `RULE` 是规则列表 |
| 另存 `propOrder` | 保留原文顺序，便于人工比对与后续展示 |

`OLD` 引用区块的属性放在**独立字段** `override`（1,628 条，1,068 个对象有值），语义上与节点内属性不同（`HREF`/`TREF`/`CREF` 是连接关系、`RULE` 是规则）。不与 `props` 混放，避免重复也避免来源不清。

---

## 3. 与原文的对账（33 项检查，全部通过）

校验器 `converter/verify_metadata.py` 用**另一套代码路径**从原文重算，再与产物比对——不是"再跑一遍同样的代码"，所以能真正发现丢数据、重复、值被改写、层级断裂。

| 维度 | 结果 |
|---|---|
| 物理行 92,871 · 逻辑记录 92,843 · 续行 28 | ✅ |
| NEW 8,955 / END 8,955 / 配平 / 栈残余 0 / 游离 END 0 | ✅ |
| 对象 8,955 · 根 1 · 有名 1,159 · 匿名 7,796 | ✅ |
| 类型 60 种、直方图逐项相等 | ✅ |
| 属性：主区 62,194 + `OLD` 区 1,628 = **63,822**，键 **107** 种 | ✅ |
| **全部属性 (key,value) 多重集 == 原文** | ✅ 对称差 0 |
| **主区属性按 (节点行,key,value) == 原文** | ✅ 对称差 0 |
| **`OLD` 区属性 (key,value) == 原文** | ✅ 对称差 0 |
| `OLD` 选择器 1,068 条 · **未解析 0** | ✅ |
| **`OLD` 选择器字符串 == 目标 canonical（外部闭环）** | ✅ **1,068/1,068** |
| canonical 重名 0 · 原始名称重名 0 | ✅ |
| 父引用全部可达 · children/parent 双向一致 · depth 一致 · 无环 · 从根可达 8,955 | ✅ |

> 「全部属性多重集 == 原文」这一条是最强的：它同时排除了**丢属性、重复属性、值被改写**三种问题。

---

## 4. 命名规则：canonical

每个对象都推导一个 `canonical`，规则与 PDMS/RVM 一致：

```
有名对象  → 其 "/..." 名称
匿名对象  → "<本类型> <同类序号> of <父级引用>"
            其中 父级引用 = 有名父级 → "<父类型> <父名>"    例：of BRANCH /WG-10401-400-L1G/B2
                            匿名父级 → 父级自身的 canonical
```

两个要点（都是被实测纠正过的）：

1. **序号按「全部同类兄弟」计数**，包含其中有名字的那些。原依据：`/V1043-NOZZLES` 下有 6 个 NOZZLE，其中 3 个有名；PDMS 给匿名的那几个编的是 **4/5/6**（RVM 里就写着 `NOZZLE 4 of SUBEQUIPMENT /V1043-NOZZLES`），不是 1/2/3。
2. **有名父级必须带上自己的类型**。第一版我写成 `of /WG-10401-400-L1G/B2`（漏了 `BRANCH`），与 PDMS 不一致——**这个错误会让 Phase 4 的映射全面对不上**。是 §3 的外部闭环检查把它揪出来的。

**结果**：8,955 个 canonical 名**全局唯一**（重名 0）；1,068 条 `OLD` 选择器**全部命中**。

这同时意味着：`canonical` 可以直接当作跨源（TXT ↔ RVM/GLB）的对象主键使用。

---

## 5. 实现过程中修掉的 4 个问题（都出在我自己的解析器上）

记录在此，因为它们都属于"不查就会静默错"的类型。

| # | 问题 | 症状 | 根因 |
|---|---|---|---|
| 1 | 选择器正则歧义 | 89 条选择器解析失败 | `^TYPE(?:\s+(\d+))?\s+(\S.*)$` 遇到两段式 `SCTN 7` 时，数字被让给最后一段，序号一律按 `1` 处理。改为两种形态分别匹配 |
| 2 | 多层选择器下行方向反了 | 234 条选择器解析失败 | 选择器写法是「目标 … 祖先」，要**从锚点逆序展开**；我按正序下行 |
| 3 | **有名父级渲染漏了类型** | canonical 与 PDMS 不一致（闭环检查 1068/1068 全失败） | 见 §4 要点 2 |
| 4 | `OLD` 区块边界判定 | `INPUT FINISH`、`LABEL /ERROR3` 被当成属性 | 引入了 PDMS 宏关键字集合来界定区块结束 |

> 第 1、2 两条曾经让我以为"数据本身有 89 条对不上的引用"（当时甚至看到 `SCTN 1` 确实没有 SNODE 子节点）。实际核查原文后发现 `SNODE 1 of SCTN 1 of /CABLE-COLUMN` **在文件里根本不存在**——这才回头怀疑自己的解析，从而找到正则歧义。**结论先行地接受一个"数据缺陷"是危险的，必须回到原文验证。**

---

## 6. xeokit metamodel 导出（零成本期权）

`converter/txt_parser.py --metamodel <out.json>` 会额外导出 xeokit metamodel 形状：

```json
{ "metaObjects":  [ { "id": "<canonical>", "name": "<canonical>", "type": "BRANCH",
                      "parent": "<父 canonical|null>", "originalName": "/...", "lineId": "txt:L31" } ],
  "propertySets":[ { "id": "...", "name": "PDMS", "type": "PDMS",
                     "objectId": "<canonical>",
                     "properties": [ { "name": "BORE", "value": "400mm" } ] } ] }
```

要点：`id` 用 **canonical**，而 XKT 里几何对象的 id 就是 glTF 节点名（= PDMS 名）——两边同构，可直接关联。将来若走 xeokit 路线（见 `reports/xeokit-evaluation.md`），这是现成的层级与属性补全数据，不用重做数据层。

---

## 7. 已知限制 / 未做的事

| 项 | 说明 |
|---|---|
| 未解析坐标 | `POS`/`HPOS`/`TPOS` 等原样保留为字符串（`E 9723mm N 23320mm U 4154.5mm`）。**不猜单位、不擅自换算**。Phase 4 若需要坐标辅助匹配，届时再加独立解析步骤 |
| 不做同义词展开 | 文件用 `$S-` 关闭了同义词翻译，关键字是规范写法（`EQUIPMENT` 而非 `EQUI`），解析器不做映射 |
| 1,535 个 TXT 对象在 RVM 无对应 | 属 Phase 4 对账范围。主要为无实体几何的设计/辅助对象（POINT 740、PAVERT 185、POGON 140、DP* 数据点、DATUM 3、负向图元 29 等）以及 Phase 1 已识别的 BOX/NOZZLE 差额 |
| 未做跨文件/跨版本稳定性验证 | 单一文件、单次导出 |
| `unresolvedSelectors` 为空 | 100% 解析成功；该字段保留在结构里，用于将来遇到无法解析的选择器时记录，**不猜** |

---

## 8. 产物与证据

| 内容 | 路径 |
|---|---|
| 解析器（② 元数据层） | `converter/txt_parser.py` |
| 独立校验器（回归闸门） | `converter/verify_metadata.py` |
| 主产物 | `data/processed/metadata.json` |
| xeokit metamodel 形状导出 | `data/processed/metadata.metamodel.json` |
| 校验明细（33 项 + 闭环结果） | `reports/evidence/phase3-verify.json` |

复现：

```bash
python converter/txt_parser.py --metamodel data/processed/metadata.metamodel.json
python converter/verify_metadata.py --json reports/evidence/phase3-verify.json
```

---

## 9. 下一步

**Phase 4 — 对象映射**（`converter/map_objects.py` → `data/processed/mapping.json`）。

四通道逐级回退，按可靠性排序：

| 优先级 | 通道 | 已验证依据 |
|---|---|---|
| 1 | 完整 PDMS 名称 / canonical 名直接配对 | **GLB 侧 7,420/7,423 = 99.96%** 已实测 |
| 2 | 类型 + 同类型序号 + 父对象路径 | 外部闭环 **1,068/1,068** 已实测 |
| 3 | 层级路径 | 两源均为 8 层，结构一致 |
| 4 | 坐标 / 包围盒互验 | Phase 1 抽样通过（同坐标系同单位） |

输出：匹配率统计 + unmatched 报告。**无法可靠匹配的不猜**，单独记录。

> Phase 4 开始前需要先定一件事：`mapping.json` 里 RVM 侧用**GLB 节点名**作为键（已经与 canonical 同构），还是额外引入 RVM 的字节偏移做技术 id？后者更稳（抗重名/抗命名规则变化），但需要扩展 Phase 2 的产物。建议两者都留，键用节点名、附技术 id。
