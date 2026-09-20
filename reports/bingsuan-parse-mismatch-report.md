# BINGSUAN 文件对「解析不匹配」诊断报告

日期：2026-09-20
对象：
- `示例模型/BINGSUAN SITE-2026-09-19.RVM`（32,311,840 B）
- `示例模型/BINGSUAN SITE-2026-09-19.txt`（5,140,300 B）

触发场景：导入 job `data/import-jobs/20260920-090708-ddda68`
→ `propionic-acid / 111 / 2026-09-20`，状态 **failed @ metadata**。

> 本报告只做诊断。`converter/` 下 7 个脚本**一行未改**；所有验证都在 `scratch/` 的副本上进行。

---

## 0. 结论（先行）

**这两个文件的内容是匹配的** —— RVM 的 19,767 个唯一组名 100% 能在 TXT 中找到，映射审计里 19,767 条字节偏移回读**全部通过**。

所谓"解析不匹配"，实际是**两件独立的事**碰在一起：

| # | 侧 | 事实 | 性质 |
|---|---|---|---|
| A | TXT | 该文件是**整库（World）范围**导出，比以往的样例多出 3 类行 → 解析器/校验器全线崩 | 格式变体不兼容（**硬阻塞**） |
| B | RVM | 每个 BRANCH 下的**管道元件被导出两份** → 12,668 个重名组 | 导出缺陷（**硬闸门**） |

A 是当前报错的原因；**只修 A，导入仍会卡在 validating**。

---

## 1. 证据链

### 1.1 报错原文（已确认）

```
stage: metadata
message: TXT → metadata 解析失败
detail:  File "converter\txt_parser.py", line 189, in _assign_names
             p = self.objects[o.parent]
         KeyError: None
```

### 1.2 根因：`OLD WORLD /*`（第 9 行）

`txt_parser.py` 的 `OLD_RE = ^OLD\s+(.+)$` 命中第 9 行 `OLD WORLD /*` → `old_mode = True`。
`old_mode` 期间：所有 `NEW` 被忽略（`if m and not old_mode`），所有属性因 `target = None` 被丢弃。
只有遇到下一个 `END`（第 73 行）才恢复。

后果（已确认）：

- 丢掉 4 个容器对象：`SITE /PROPIONIC-ACID-BINGSUAN-C104`、`ZONE /PROPIONIC-ACID-PIPE-10`、`PIPE /PL-10904-65-L1G`、`BRANCH /PL-10904-65-L1G/B3`
- B3 下的 12 个元件全部降级为**匿名顶层对象**（第 74 / 85 / 96 / 108 / 120 / 132 / 144 / 156 / 168 / 180 / 194 行）
- `_assign_names()` 对"匿名且无父"的对象执行 `self.objects[None]` → 整个解析进程终止

**判据来自文件自身**：末尾 `INPUT END  WORLD /*` 与开头 `OLD WORLD /*` 成对，是"把当前元素设为 World"的宏语句，不是引用区块选择器。

### 1.3 格式变体：导出范围是整库

| 文件 | 开头 | 末尾 | 根数 |
|---|---|---|---|
| `QICHUANG-SITE-2026-08-26.txt` | `INPUT BEGIN` → `NEW SITE /…` | `INPUT END  SITE /ENCOSC23059-QICHUANG-SITE` | 1 |
| `BINGSUAN SITE-2026-09-19.txt` | `INPUT BEGIN` → `PROTECTION OFF` → `OLD WORLD /*` | `INPUT END  WORLD /*` | **4** |

仓库内所有历史 TXT（`data/**/source/model.txt`、`data/trash/**`）末尾全是 `SITE /…` —— **这个解析器从没见过来自整库范围的导出**。

整库范围多出的行，逐条都会骗过朴素解析器：

| 行 | 问题 | 命中者 |
|---|---|---|
| `OLD WORLD /*`（9 行） | 被当引用区块选择器 → old_mode | `txt_parser.py` |
| `PROTECTION OFF`（8 行） | 无当前对象时的 `K V` 行被当属性 → `stack[-1]` | `verify_metadata.py` |
| `PROTECTION ON`（301050、317848 行） | 同上 | 同上 |
| 末尾多 1 个 `END`（301049 行） | 栈已空仍 END（游离），栈残余仍为 0 | `verify_metadata.py` 的两条断言 |

`verify_metadata.py` 的崩溃点实测在**第 8 行 `PROTECTION OFF`**，早于 `OLD WORLD /*`：

```
File "converter\verify_metadata.py", line 114, in scan_raw
    res["pairsMain"][(stack[-1], key, val)] += 1
IndexError: list index out of range
```

### 1.4 RVM 侧：元件重复导出（已确认，官方解析器独立复现）

| 指标 | 值 |
|---|---|
| 组（CNTB）总数 | 32,435 |
| 唯一组名 | 19,767 |
| 重名的名字 | **12,668（每个恰好出现 2 次）** |
| 重复对特征 | 同父相邻兄弟；参考原点 / 材质 / 首条 PRIM 的种类与 3×4 矩阵**逐位相同**；世界包围盒浮点级相等 |
| 范围 | **只发生在 BRANCH 下的管道元件**（GASKET 3488 / FLANGE 2990 / ELBOW 2721 / VALVE 982 / TEE 698 / NOZZLE / REDUCER…）；结构件（SCTN/SNODE/DISH/BOX/SUBSTRUCTURE…）只有一份 |
| 冗余几何 | 36,234 / 86,599 = **41.8%** |

**独立验证**：`tools/rvmparser/rvmparser.exe --output-json` 输出 `Groups 32435 / Geometries 86599`，与自写 `rvm_index.py` 完全一致，重名也是 12,668 个。**排除"自己的解析器看错了"。**

对照组：QICHUANG RVM `duplicateNames = 0`，所以这个问题以前从未暴露。

### 1.5 补齐补丁后的端到端结果（`scratch/diag-*.py`，未进 converter）

TXT 解析（打补丁后）：

```
对象        27,825 个（根 4 · 有名 3,438 · 匿名 24,387）
层级        最大深度 8  NEW 27825 / END 27826 · 栈残余 0
属性        223,634 条（主区 217,470 + OLD 区 6,164）
OLD 选择器  4,811 条 · 未解析 0 · canonical 重名 0
```

层级与 RVM 吻合：C104 → 25 个二级、C103 → 14 个二级（RVM 侧同样 25 / 14）。

GLB（tolerance 0.02）：106,365,780 B / 2,110,412 三角形 / 闸门三项全过。

映射：

| 项 | 值 |
|---|---|
| RVM 唯一名 → TXT 命中 | **100%（19,767 / 19,767，通道全为 name）** |
| GLB 命名节点 | 19,770（多出的 3 个是技术节点：`/BINGSUAN`、源路径、`rvmparser-rotate-z-to-y`）|
| GLB 侧匹配率 | 99.985% |
| TXT 侧匹配率 | 71.04%（未匹配 8,058 个全部是 RVM 不导出的类型）|
| RVM 侧匹配率 | 60.94% ← **分母被重复组灌水** |

闸门结果：

| 闸门 | 结果 |
|---|---|
| `verify_glb.py` | 通过 |
| `verify_mapping.py` 21 项 | **FAIL 1 项** —— `RVM 索引自身无重名` got=12668 want=0 |
| `verify_metadata.py`（打补丁后）| **FAIL 5 项** —— 见下表 |

`verify_metadata.py` 剩余 5 项失败：

| 检查 | got | want | 性质 |
|---|---|---|---|
| 物理行数 | 317,861 | 317,656 | 校验器恒等式有误，见 §2 |
| NEW/END 配平 | 27,825 | 27,826 | 源文件多 1 个 END |
| 游离 END | 1 | 0 | 同上（无害，栈残余 0）|
| 根数 | 4 | 1 | 校验器写死单 SITE 假设 |
| OLD 选择器外部闭环 | 1 | 0 | 唯一一条差 = `未找到目标: WORLD /*` |

其中 `verify_metadata` 的"物理行数"恒等式实测：

```
物理行数 317,861 = 逻辑记录 316,758 + Σ(跨行数-1) 1,103
续行记录 898（其中 205 条跨 3 行）→ 旧恒等式少算 205
```

---

## 2. 需要改什么（**待用户确认，尚未动手**）

改动都属于"兼容新格式变体"，超出既有的「只许加同义参数」约束，所以先列清单等 GO。

### 2.1 TXT 侧（3 个文件）

| 文件 | 位置 | 改动 |
|---|---|---|
| `converter/txt_parser.py` | `parse()` 的 `OLD_RE` 分支 | 选择器字符串含 `/*` → 按宏语句处理，不进 `old_mode` |
| 同上 | `_assign_names()` | 匿名对象且无父时不再 `self.objects[None]`（防御性，避免"一处格式异常炸掉整次解析"）|
| `converter/verify_metadata.py` | `scan_raw()` | ① 选择器含 `/*` 不进 `in_old`；② `not in_old and not stack` 的 `K V` 行按宏命令处理，不索引 `stack[-1]` |
| 同上 | `check()` | ① 根数 `== 1` 改为按导出范围判定（末尾 `INPUT END` 标识）；② 物理行数恒等式改为 `逻辑记录 + Σ(跨行数-1)`；③ 游离 END 允许 ≤1 并记录；④ 外部闭环跳过 `/*` 选择器 |

### 2.2 RVM 侧（**建议重新导出，不改代码**）

`verify_mapping.py` 的「RVM 索引自身无重名」是**故意**设的闸门（唯一名才能当跨源主键）。
**不要在 `rvm_index.py` 里做去重** —— 那会把真实的导出缺陷掩盖掉。

建议动作：

1. 在 PDMS 里**重新导出 RVM**，确认导出选项（对比 QICHUANG 那次导出的选项）。
2. 导出后先用 `Counter(g["name"] for g in rvm_index["groups"])` 自检重名是否为 0，再走导入。
3. 顺带核对导出范围：RVM 顶层目前是 2 个 SITE（C104 / C103），TXT 顶层是 4 个（2 SITE + 2 TPWLD 模板世界）。TPWLD 属模板定义、RVM 不导出属正常，但**导出范围明确一致更好排查**。

---

## 3. 未决 / 待确认

- `PROTECTION OFF` / `OLD WORLD /*` 的 PDMS 语义：本报告只用到"它出现在文件里、且成对出现"这一事实。它们属于哪种 PDMS 导出选项、能否在导出时关掉，**未验证（需在 PDMS 侧核对导出设置）**。
- 末尾多出的那个 `END`：推测与开头 `OLD WORLD /*` 成对（表示退出 World 层级），**暂定，未证实**。
- TXT 侧"根数 4"是正确解析结果还是源文件本就该有 1 个根 —— 已核对 RVM 顶层确实 2 个 SITE，且 TPWLD 段落自带 `NEW TPWLD … END`，故判为正确。
- 结构类对象（SUBSTRUCTURE / EQUIPMENT / SUBEQUIPMENT）的 TXT `POS` 与世界包围盒差 94–160 m（p50），**父链一致（19,765/19,767）说明映射没错**，属坐标参考系约定差异。校验器不设阈值故不阻塞，但会影响将来"按坐标定位"功能，单独立项。
- `map_objects.py` 把 SITE 的 RVM 父节点写死为 `/MDBs`：QICHUANG 的 RVM MODL 段确实是 `/MDBs`，BINGSUAN 是 `/BINGSUAN` → 该项报 2 条"父链不一致"（无害，非闸门）。

---

## 4. 证据文件

| 路径 | 内容 |
|---|---|
| `scratch/bingsuan-rvm-index.json` | RVM 节点索引（16.4 MB）|
| `scratch/bingsuan-metadata-fixed.json` | 打补丁后的 TXT 解析产物（18.8 MB）|
| `scratch/bingsuan-diag/site.json` | 官方 rvmparser `--output-json` 产物（对照基准）|
| `scratch/bingsuan-diag/model.glb` | 端到端用 GLB（106 MB）|
| `scratch/bingsuan-diag/mapping.json` | 映射结果（4.4 MB）|
| `scratch/bingsuan-diag/validation.{glb,metadata,mapping}.json` | 三条闸门的原始输出 |
| `scratch/diag-txt-parser.py`、`scratch/diag-verify-metadata.py` | 诊断用补丁副本（**不是** converter 里的正式脚本）|
