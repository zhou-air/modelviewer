# BINGSUAN RVM「仅 RVM 模式」导入失败诊断

日期：2026-09-24
输入：`BINGSUAN SITE-2026-09-19.RVM`（32,311,840 B），**只给 RVM、未给 TXT**（走新的「仅 RVM」链路）
现象：导入失败、独立验证不通过 → 版本落 `failed`，界面上不给 Open（这就是「打不开」）

> 本次只在 `scratch/_diag-bingsuan/` 的副本上跑，`converter/` 未做任何改动。
> 前置报告：`reports/bingsuan-parse-mismatch-report.md`（2026-09-20，TXT 侧诊断）

---

## 0. 结论（先行）

**失败与「仅 RVM」链路无关，也与 9/20 那三类 TXT 格式变体无关 —— 这次唯一的阻塞是 RVM 文件自身带 12,668 组重复导出。**

| # | 事实 | 性质 |
|---|---|---|
| 1 | RVM 里 32,435 个组只有 19,767 个唯一名，**12,668 个名字各出现 2 次** | 导出缺陷（**硬阻塞**） |
| 2 | 重复对几何 100% 逐位相同（包围盒、图元种类、参考原点全等），且在同一父下相邻 | 完全冗余，不是"同名不同物" |
| 3 | GLB 里同样带 12,668 个冗余节点（各占独立 mesh），几何冗余 36,234 / 86,599 = 41.8% | 显存与 draw call 白增 |
| 4 | 闸门在 `validating` 拦下（2 项 FAIL）→ 版本 failed | **拦得对**，理由见 §3 |

**建议：在 PDMS 侧重导 RVM**（与 9/20 结论一致）。若要"先能看"，需要单独授权做去重通道，见 §5。

---

## 1. 逐层实测（2026-09-24 复现）

| 阶段 | 结果 |
|---|---|
| `rvm_index.py` | 组 32,435 · 唯一名 19,767 · **重名 12,668** · 最大深度 8 · 图元 86,599 |
| `rvm_to_glb.py` | GLB 106,365,788 B · 三角形 2,110,412 · 节点 33,587（命名 32,438，唯一名 19,770） |
| `rvm_metadata.py`（合成） | 对象 32,435 · canonical 重名 12,668 · 映射 19,767（**RVM 侧仅 60.94%**） |
| `verify_rvm_metadata.py` | **FAIL 2 项** ↓ |
| 版本状态 | `failed`（validating）→ 前端不给 Open |

闸门失败项原文：

```
[FAIL] canonical 无重名             got=12668  want=0
[FAIL] 键 == RVM 组名且 id 一致      got=12668  want=0
[OK  ] 按 rvmOffset 回读 RVM 二进制，名称与键一致   （19,767 条回读全过）
```

---

## 2. 重复的结构（可核查的事实）

| 项 | 值 |
|---|---|
| 组（CNTB）总数 | 32,435 |
| 唯一组名 | 19,767 |
| 重名条目 | 12,668（**每个恰好 2 次**，没有 3 次以上的） |
| 重复对的父 | 12,610 个挂在**有名父组**（管道 BRANCH 为主），58 个挂在 **SUBEQUIPMENT**（设备管嘴） |
| 涉及父组 | 1,240 个 |
| 重复对位置 | 在 RVM 索引里**紧邻**（相邻两条 CNTB） |
| 几何一致性 | **12,668 / 12,668 包围盒逐位相同、图元块数与种类相同、参考原点相同** |
| 顶层结构 | 2 个根：`/PROPIONIC-ACID-BINGSUAN-C104`、`/PROPIONIC-ACID-BINGSUAN-C103`（整库多根） |
| 元件类型 | GASKET 3,488 · FLANGE 2,990 · ELBOW 2,721 · VALVE 982 · TEE 698 · NOZZLE 271 · REDUCER 241 · 其他 |
| 独立复现 | `tools/rvmparser/rvmparser.exe --output-json` 统计同样是 32,435 组，重名同样 12,668 → **不是自写解析器看错** |

重复只发生在**元件/管嘴这一层**，结构件（SCTN / SNODE / SUBSTRUCTURE / DISH / BOX…）只有一份。

> 顺带观察（供 PDMS 侧核查参考）：模型里存在大量 `/Copy-of-PG-10904`、`/Copy-(2)-of-R21501-C` 形式的对象名，
> 说明该工程做过较多 Copy 操作 —— 元件层的成对重复与这个背景吻合，值得先往"数据侧是否真有重复元件"方向查。

---

## 3. 为什么闸门必须拦（而不是放过）

`canonical`（= RVM 组名）是整条链路的**唯一主键**：模型侧 `nodeByCanonical`、数据侧 `geomOf`、
隐藏集 `hiddenCanonicals`、批注 `issue.node.canonicalId`、测量命名、两种比对的键，全部用它。

重名时即使硬打开，行为是**错的**：

- GLB 里两个同名节点 → 只能索引到其中一个 → 另一份**点不中、高亮不了、也隐藏不掉**；
- 「隐藏选中 / 隔离选中」只作用于其中一份，画面看起来"隐藏了一半"；
- 对象数、三角形数、draw call 全部虚高（几何冗余 41.8%），交互帧率被无谓拖低；
- 批注/比对指向的对象可能是另一份实例。

**"能打开但操作会错"比"明确拦下"更糟**，所以闸门在这里不放行。

---

## 4. 附带的两个好消息

1. **仅 RVM 链路彻底绕开了 9/20 那三类 TXT 格式变体问题**（`OLD WORLD /*` / `PROTECTION OFF` / 末尾多一个 `END`）——
   那条链路不解析 TXT，本次失败与它完全无关。也就是说：只给 RVM 时，那份 TXT 的格式问题不再是障碍。
2. RVM 侧重名与本项目代码无关：官方 `rvmparser` 输出与自写索引逐项一致。

---

## 5. 建议动作

### 5.1 首选 —— 重导 RVM（不改代码）

1. 在 PDMS 里重新导出 RVM，**对照 QICHUANG 那次成功的导出选项**（那份 `duplicateNames = 0`）；
2. 导出后先自检重名，为 0 再导入：

```bash
python converter/rvm_index.py --source "你的.RVM" --out scratch/check-rvm-index.json
python -c "import json,collections;d=json.load(open('scratch/check-rvm-index.json',encoding='utf-8'));c=collections.Counter(g['name'] for g in d['groups']);print('组',len(d['groups']),'唯一名',len(c),'重名',sum(1 for v in c.values() if v>1))"
```

3. 若重导后重名依旧，说明是**模型数据里真的有重复元件**，需要在 PDMS 里对重复的 BRANCH 逐一核对元件表
   （清单见 `reports/evidence/bingsuan-dup-groups.csv`）。

### 5.2 备选 —— 合成层严格去重（**需要你明确 GO，尚未实施**）

做法：在 `rvm_metadata.py` 合成前，只对满足**全部**判据的兄弟组判为冗余并合并：
同父 + 同名 + 包围盒逐位相同 + 图元块数/种类相同 + 参考原点相同；同时把 GLB 里冗余节点的场景引用摘除
（否则那份"没有主键的节点"永远隐藏不掉）；重复清单写入版本 `reports/`，并在 `version.json` 记明"已去重 N 组"。

- 风险：这会**掩盖导出缺陷**（本项目一贯原则是不在解析器里去重掩盖），且万一存在"同名同位置但语义不同"的对象会误合并。
  本次实测 12,668/12,668 几何完全一致，误合并风险很低，但**必须由你确认后我再动手**。
- 另一条更轻的路：**先只做"能看"的临时版本** —— 把这份 RVM 裁成不含重复子树的子集（丢掉重复对中的一份连同其几何），
  走正常导入，不做代码改动。需要时我再评估可行性。

---

## 6. 证据文件

| 路径 | 内容 |
|---|---|
| `reports/evidence/bingsuan-dup-groups.csv` | 12,668 条重复明细（父组 / 元件名 / 类型 / 两处字节偏移 / 几何是否相同）|
| `scratch/_diag-bingsuan/validation.json` | 本次闸门原始输出（31 项，2 项 FAIL）|
| `scratch/_diag-bingsuan/convert-records-tol0.02.json` | 转换记录（组/几何/三角形）|
| `scratch/bingsuan-rvm-index.json` | 9/20 的同源索引（对照用）|
| `reports/bingsuan-parse-mismatch-report.md` | 9/20 的 TXT 侧诊断（本次已确认与其无关）|
