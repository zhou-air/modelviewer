# Phase 4 — RVM ↔ TXT 对象映射

- 状态：**已完成**，21 项独立校验全部通过
- 日期：2026-09-18
- 方案：按用户决定采用 **B —— 以节点名（canonical）为主键，另附 RVM 字节偏移作技术 id**
- 产物：`data/processed/mapping.json`（1.34 MiB）+ `data/processed/rvm-node-index.json`（3.73 MiB）

---

## 1. 结论

| 指标 | 值 |
|---|---|
| RVM 对象数（组） | 7,420 |
| GLB 命名节点数 | 7,423 |
| TXT 对象数 | 8,955 |
| **已匹配** | **7,420** |
| **RVM 侧匹配率** | **100.00%** |
| GLB 侧匹配率 | 99.964%（3 个未匹配全是技术节点） |
| TXT 侧匹配率 | 82.859% |
| 未匹配 TXT | 1,535 |
| 未匹配 GLB | 3 |

**每一个 RVM 几何组都找到了对应的 TXT 对象，一个不漏。**

匹配通道统计：`{"name": 7420}` —— 通道 2（归一化名称）与通道 3（结构）**一次都没被用到**。这说明 Phase 3 的 `canonical` 命名规则已经足够精确，兜底通道不需要出场（它们仍保留在实现里，供将来其他导出源使用）。

---

## 2. 两处独立校验（都不依赖匹配本身）

### 2.1 父链一致性：7,420 / 7,420

对每一对映射，比较「GLB 里向上找到的最近有名祖先」与「TXT 里该对象的父 canonical」：

```
父链一致 7,420 / 不一致 0
```

> 唯一一个曾报"不一致"的是 SITE `/ENCOSC23059-QICHUANG-SITE`：它在 TXT 里没有父（是根），而在 RVM 里父是技术节点 `/MDBs`。这属于预期情况，已在实现中显式处理并计入一致。

### 2.2 坐标一致性（按父类型分层）

对**叶子组**（包围盒紧密）比较 TXT 的 `POS`/`HPOS` 换算后的点与 RVM 组的世界包围盒的距离：

| 父类型 | n | 精确在盒内 | ≤1 mm | p50 距离 | max |
|---|---|---|---|---|---|
| SUBSTRUCTURE | 2004 | 0 | 0 | 28.587 m | 134.538 m |
| **BRANCH** | **1329** | **1062** | **1329** | **0.0** | **0.000004 m** |
| EQUIPMENT | 685 | 0 | 0 | 28.814 m | 130.134 m |
| SUBEQUIPMENT | 452 | 0 | 0 | 28.136 m | 93.998 m |
| FRMWORK | 44 | 8 | 25 | 0.000002 m | 131.641 m |
| TMPLATE | 14 | 0 | 0 | 63.731 m | 64.629 m |

**管道元件（父类型 = BRANCH）的 1,329 个叶子组，坐标距离全部 ≤ 0.000004 m（0.004 mm）。** 这是一个与名称完全独立的第二证据通道，它同样指向"这 1,329 对一定是同一批对象"。加上名称通道已经覆盖 7,420/7,420，映射的可信度是两条腿站着的。

**同时也发现一个此前不知道的事实**：TXT 的 `POS` 参考系**随父类型而变**——

- 父类型为 `BRANCH`（管道元件）→ **世界坐标**（E/N/U，与 RVM 一致，误差 0）
- 父类型为 `EQUIPMENT` / `SUBEQUIPMENT` / `SUBSTRUCTURE` / `TMPLATE`（设备与结构的图元子对象）→ **父级局部坐标**

验证过程：设备 `/P1074` 自身的 `POS = E 2543mm N 1946mm U 235mm` 落在其包围盒 `[2.293, 1.433, -1.28, 2.793, 2.173, 0.338]` 内 → 世界坐标；其子对象 `CYLINDER 1` 的 `POS = E 385mm N 0mm D 245.5mm` 明显是相对值，但**不是简单平移**就能还原（需要父级完整变换，含 `ORI` 姿态）。

**因此本阶段把坐标通道明确定位为「对世界坐标子集的交叉验证」，不做局部→世界的坐标正算**（那属于几何计算，不在 Phase 4 范围内）。分层统计表就是这条限制的事实记录，没有用提高容差的方式掩盖。

---

## 3. 技术 id：字节偏移，并回读验证

按方案 B，每条映射除主键（canonical 名）外还带两个可回查的 id：

```jsonc
"TEE 1 of BRANCH /WG-10401-400-L1G/B2": {
  "glbNodeIndex": 2318,          // GLB 中的节点序号，直接可定位 three.js 对象
  "rvmOffset":  5032,            // RVM 二进制中的字节偏移，物理锚点
  "rvmId":      "rvm:cntb:5032",
  "txtId":      "txt:L187",      // TXT 中的行锚定 id，可回到原文行
  "channel":    "name"
}
```

**回读验证**：把 `rvmOffset` 回到 RVM 二进制，确认该偏移处确实是一个 `CNTB` chunk，且其组名与映射键完全一致：

```
回读验证 7,420 条映射的 RVM 字节偏移 → 不一致 0
```

这条检查的价值：它证明"字节偏移"不是随手记的数字，而是真的锚定同一个物理对象。将来命名规则若变化，靠它仍能确认"还是那个对象"。

---

## 4. 未匹配分析（1,535 个 TXT 对象）

未匹配项**不猜**，只按可查证的事实分类。全部 1,535 项落进两个成因桶，无"原因未知"残留：

### A 类：该类型在 RVM 中完全不出现 —— **1,272 个 / 16 类**

| 类型 | 数量 | 类型 | 数量 |
|---|---|---|---|
| POINT | 740 | VVALUE | 16 |
| PAVERT | 185 | NBOX | 16 |
| POGON | 140 | VERTEX | 14 |
| DPCARTESIAN | 46 | NCYLINDER | 8 |
| PLOOP | 46 | POINSP | 4 |
| DPSPHERICAL | 44 | NXTRUSION | 3 |
| DATUM | 3 | LOOP | 3 |
| NPYRAMID | 2 | CURVE | 2 |

**判读**：这些是**无实体几何的设计/辅助对象**——轴网放样点（POINT/PAVERT/POGON/VERTEX）、数据点集（DPCARTESIAN / DPSPHERICAL / VVALUE / DATUM）、负向图元（NBOX / NCYLINDER / NPYRAMID / NXTRUSION，用于挖孔）、管线回路（PLOOP/LOOP/CURVE）。RVM 不导出它们的几何，所以在 GLB 里没有对应组。**属预期，不是解析缺陷。**

### B 类：RVM 中该类型存在，但实例更少 —— **263 个 / 7 类**

| 类型 | TXT 总数 | RVM 总数 | TXT 独有 |
|---|---|---|---|
| BOX | 796 | 639 | **157** |
| RTORUS | 72 | 18 | **54** |
| DDATA | 30 | 4 | 26 |
| PYRAMID | 87 | 74 | 13 |
| POHEDRON | 20 | 10 | 10 |
| SUBSTRUCTURE | 331 | 329 | 2 |
| PNODE | 5 | 4 | 1 |

**判读**：**RVM 侧少导出了这些实例**（TXT 有、RVM 无）。原因是 RVM 导出器或 PDMS 侧的选择性导出（例如某些图元被合并、或某些对象未通过导出过滤），**具体原因无法从这两个文件内证明——需要人工确认**。数量不大（263 / 8,955 = 2.9%），且集中在设备与结构的图元层，不影响管道系统。

### GLB 独有 3 个

| 名称 | 判读 |
|---|---|
| `/MDBs` | RVM 的数据库根节点，非 PDMS 设计对象 |
| `data/source/QICHUANG-SITE-RVM-2026-08-26.rvm` | 解析器写入的源文件路径节点 |
| `rvmparser-rotate-z-to-y` | 解析器插入的 Z-up→Y-up 旋转节点 |

三者全部是导出/解析过程产生的技术节点，**不是数据缺失**。

---

## 5. 实现中修掉的 3 个问题（都在我自己这边）

| # | 问题 | 症状 | 根因 |
|---|---|---|---|
| 1 | **单位搞错** | 坐标校验 96% "不符" | RVM 的 **PRIM 几何与包围盒是米**，而 **CNTB 参考原点是毫米**。我把包围盒字段命名成 `bboxWorldMm` 并按毫米比较。两处独立证据确认：某 TEE 的 `referenceTranslation=[710, 13290.6, 5223.4]`（mm）落在其包围盒 `[0.5475, 13.0354, 5.059, 0.8725, 13.5458, 5.4786]`（m）内，同一坐标差 1000 倍 |
| 2 | **坐标方向字母不全** | 2,045 条坐标"未解析" | PDMS 坐标是「方向字母 + 数值」三连，除 `E/N/U` 还有 **`W`(西) / `S`(南) / `D`(下)**，代表负方向。例：`W 29895mm N 705mm U 6975mm`、`E 3757mm N 2113mm D 45.5mm` |
| 3 | **回读校验漏跳 version 字段** | 7,420 条回读全部不符 | `CNTB` payload = `version(4)` + `名称字长(4)` + `名称`。我按 `offset+24` 读长度字段，实际应在 `offset+28`。查原始字节后确认索引侧是对的 |

第 1、2 条都曾被误判为"数据有问题"或"参考点天然偏移"。**回到具体样例逐字节核对，才确认是自己错**——这和 Phase 3 的选择器正则问题同一类教训。

---

## 6. 已知限制

| 项 | 说明 |
|---|---|
| 坐标通道只覆盖世界坐标子集 | 见 §2.2。设备/结构下的图元 `POS` 是父级局部坐标，需完整父链变换（含 `ORI`）才能正算，**本阶段不做** |
| B 类 263 个未匹配的原因无法从文件内证明 | 已量化、已定位到具体对象清单，标注"需人工确认"，**不写猜测性结论** |
| 技术 id 只在 RVM 文件不变时有效 | 字节偏移是物理锚点；RVM 重新导出后偏移会变，届时应以 canonical 名为主键、用回读机制重新建立对照 |
| 单文件、单次导出 | 未做跨项目/跨 PDMS 版本的稳定性验证 |

---

## 7. 产物与证据

| 内容 | 路径 |
|---|---|
| RVM 技术索引（①-附） | `converter/rvm_index.py` → `data/processed/rvm-node-index.json` |
| 映射层（③） | `converter/map_objects.py` → `data/processed/mapping.json` |
| 映射独立校验器 | `converter/verify_mapping.py` |
| 校验明细（21 项 + 回读结果） | `reports/evidence/phase4-verify.json` |
| 未匹配清单与校验摘要 | `reports/evidence/phase4-unmatched.json` |

复现：

```bash
python converter/rvm_index.py --cross-check reports/evidence/rvm-hierarchy.json
python converter/map_objects.py
python converter/verify_mapping.py --json reports/evidence/phase4-verify.json
```

---

## 8. 下一步：Phase 5 — Viewer MVP 交互

现在数据链路已经完整：

```
model.glb（几何，节点名 = canonical）
metadata.json（8,955 对象 · 63,822 属性 · 层级）
mapping.json（7,420 条：canonical ↔ glbNodeIndex ↔ rvmOffset ↔ txtId）
```

Phase 5 要做的（按用户原始需求）：

1. **Selection**：点击 3D 对象 → 高亮 → 取 object id → 查 mapping/metadata → 显示属性面板
2. **Visibility**：Hide Selected / Isolate Selected / Show All
3. **Model Tree**：左侧 SITE → ZONE → PIPE → BRANCH → Component 层级树；点树节点 → 选中 3D 对象 + Camera Fit + 显示属性；点 3D 对象 → 树同步定位
4. **视觉**：统一灰色保持不变，加选中描边（第一版可用 emissive 或 outline pass）

一个实现要点需要先定：`glbNodeIndex` 是 GLB JSON 里的节点序号，three.js 的 `GLTFLoader` 加载后**没有直接暴露原始序号**。需要在加载后按遍历顺序或名字建立 `canonical → Object3D` 的映射表。名字已经唯一且与 canonical 一致，所以**用 `object.name` 建表最稳**；`glbNodeIndex` 保留作对账用。
