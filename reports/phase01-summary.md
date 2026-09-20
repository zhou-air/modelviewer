# Phase 0 + Phase 1 汇报与 Phase 2 计划

- 状态：**Phase 0 / Phase 1 已完成，停在阶段边界等待确认**
- 日期：2026-09-18
- 本阶段不做的事：未生成正式 GLB、未生成 metadata.json、未写 Viewer、未做对象映射统计
- 未改动任何源文件

---

## 1. 一句话结论

**技术路线成立，可以进入 Phase 2。** 真实 QICHUANG RVM 已被成熟开源解析器在**本机实跑通过、零解析错误**，8 层 PDMS 层级与名称完整；TXT 的层级与属性结构完整可解析；两源在**命名对象层面匹配 99.9%**、在**管路元件层面 7 种类型逐一精确相等**。唯一确定的缺陷是该 RVM **不携带颜色**，需要按工程类型上色——这是工程 Viewer 的常规做法，不阻塞。

---

## 2. 对 RVM 的分析（要点）

| 项 | 结果 |
|---|---|
| 版本 | AVEVA PDMS Design Mk12.1.SP4.0[4074]；项目代码 XXL，模型 `/MDBs` |
| 大小 | 4,505,600 B |
| 结构 | HEAD 1 + MODL 1 + **CNTB/CNTE 各 7420（完全配平）** + PRIM 12385 + END: 1 |
| 层级 | **8 层 PDMS 层级完整**；SITE 1 / ZONE 15 / PIPE 147 / BRANCH 240 / EQUIPMENT 98 / STRUCTURE 47 |
| 名称 | 1156 个完整 PDMS 名 + 6264 个合成名；**7420 个组名全局唯一** |
| 几何 | 12385 块，覆盖全部 11 种图元（Cylinder 6551 / Snout 1246 / SphericalDish 982 / Line 906 / FacetGroup 815 / Box 778 / …） |
| 变换 | 每 PRIM 12 float 3×4 矩阵 + 局部包围盒；组另有参考原点。原始单位 mm，读取后为 m |
| 包围盒 | E −119.64…79.56 / N −1.70…131.66 / U −3.00…22.61（米），尺度 200 m 级 |
| **颜色** | ⚠️ **无 COLR 色表；7420 个组 material 全 = 1** |

**最有价值的两个发现**：

1. RVM 的组名不是空白——命名对象带完整 PDMS 路径（`/WG-10401-400-L1G/B2`），未命名元件带**结构化合成名**（`TEE 1 of BRANCH /WG-10401-400-L1G/B2`）。这意味着**不需要靠数组顺序硬凑映射**。
2. 组名**全局唯一**，可直接作为稳定 ID 使用。

---

## 3. 对 TXT 的分析（要点）

| 项 | 结果 |
|---|---|
| 大小 / 编码 | 1,344,437 B；UTF-8 带 BOM；92,871 物理行全 CRLF；28 处续行 → **92,843 逻辑记录** |
| 结构 | 1 个根 SITE，**8955 个节点**，最大深度 7（**8 层，与 RVM 一致**），NEW/END **完全配平、栈清零** |
| 命名 | 1159 个有完整名；7796 个匿名（仅 `NEW TYPE`） |
| 属性 | **63,822 条**属性（主区 62,194 + OLD 区 1,628）、**107 种**属性键、**60 种**节点类型 |
| 语法 | `NEW <TYPE> [<名称>]` / `END` / `KEY value`（空格分隔，**不是 `:=`**）/ 行尾 `$` 续行 |
| 后段 | 第 89,067 行起另有 **1,068 条 `OLD` 选择器 + 1,628 条属性**，内容是 `HREF`/`TREF`/`CREF` **管线连接引用** |
| 本质 | 这个文件同时是一段**可回灌 PDMS 的宏**（`ONERROR GOLABEL` / `INPUT BEGIN` … `INPUT FINISH`） |

**任务书列出的属性键（NAME/POS/ORI/HPOS/TPOS/HDIR/TDIR/BORE/HBOR/TBOR/PSPE/SPRE/LSTU/SHOP/BUIL/ANGL/HCON/TCON/TEMP/PRES）在真实文件中全部存在**，未发现任务书有而文件没有的键。此外文件里还有大量任务书未列出的键（`HEIG/LEVE/DELDSG/OBST/DIAM/ORIF/POSF/GRADE/LNTP/DSCO/…`），**一律原样保留**。

**必须处理的坑**（已识别）：同节点重复键（`RULE` 最多 4 次，不可覆盖）、`FALS`/`false` 混用、`unset`/`'unset'` 混用、属性值含空格与括号、`-100000degC` 这类「未设」哨兵值。

---

## 4. 选择的开源技术

**选择：`cdyk/rvmparser`** —— C++ / **MIT** —— 最后提交 **2025-08-25**（仍在维护）

理由：glTF/GLB 是它的**一等导出目标**（不是附加功能）；节点树保留 PDMS 层级与名称；已内置 **Z→Y 轴转换、模型居中、同组几何合并、细分容差、按属性上色、按层级拆分文件**；覆盖全部 11 种图元；依赖仅 libtess2 + rapidjson；**已在本机对真实文件实跑验证通过，并与自写字节级探针逐节点对账一致**。

> ⚠️ **需要纠正任务书里的两个地址**：`bertt/rvmparser` 与 `bertt/rvmsharp` **均返回 404，仓库不存在**。实际对应项目是 `cdyk/rvmparser` 与 `equinor/rvmsharp`。后续一律以实际地址为准。

**备选：`equinor/rvmsharp`**（C# / MIT / Equinor 生产级）。**不选**原因：它不直接产出标准 glTF，下游是 Cognite Reveal 私有格式。但保留两个用途：① 它的 `PdmsTextParser.cs` 是公开资料里唯一经生产验证的 PDMS 文本解析实现，Phase 3 写 TXT parser 时的**最佳参考**；② 若 Phase 7 决定上 Reveal/XKT 生态，这是现成整条路线。

**Viewer 层：第一版用 Three.js**（少一层格式转换，链路最短）。**xeokit/XKT 不在本阶段引入**——按项目原则，等 Phase 6 的真实 benchmark 说话。

---

## 5. 最大技术风险（按严重度排序）

| # | 风险 | 级别 | 事实依据 | 处置 |
|---|---|---|---|---|
| 1 | **Draw call 偏高** | **高（最可能的真实瓶颈）** | 5835 个组有直属几何 → 即使同组几何合并，仍是 **5000–6000 量级 mesh**；three.js 在此量级通常掉到 20–40 FPS | Phase 6 实测；若确实卡，优化手段现成（按 PIPE/BRANCH 子树合并、对重复图元用 InstancedMesh）。**这正是 Phase 7 存在的意义** |
| 2 | **RVM 无颜色** | 中（必然发生，但好解决） | 无 COLR 色表；7420/7420 组 material = 1 → 默认映射为单色 | 按工程类型上色，颜色来源现成：RVM 合成名前缀 或 TXT `type`。**不阻塞** |
| 3 | **TXT 与 rvmparser 属性通道不兼容** | 中（工作量，不是障碍） | rvmparser 只认 `CADC_Attributes_File v1.0`（`KEY := VALUE &end&`）；我们的 Data Listing 是 `KEY value` | 本来就要自写 TXT parser（Phase 3），**三层分离架构不受影响** |
| 4 | **NOZZLE / BOX 等约 500+ 对象对不上** | 中 | NOZZLE：TXT 390 vs RVM 11；BOX：796 vs 639；SCTN：669 vs 630 | Phase 4 逐父类型对账；**不阻塞 MVP**（不影响管路、不影响层级） |
| 5 | **相邻几何锚点只命中 12714/23260** | 低（纯视觉） | rvmparser 日志 | 部分相邻管件间可能残留内部封口面；Phase 2 目视核对。不影响层级与数据 |
| 6 | **负向图元未导出** | 低 | TXT 有 16 NBOX + 8 NCYLINDER + 2 NPYRAMID + 3 NXTRUSION；RVM 无 OBST/INSU 块 | 可能导致挖孔未体现；Phase 2 目视核对 |

**没有发现会推翻技术路线的问题。** 未出现「parser 不支持本版本 RVM」「几何缺失」「层级丢失」「坐标异常」这四类硬阻塞。

---

## 6. RVM → Web 的计划

```
data/source/QICHUANG-*.rvm
        │  ① converter/rvm_to_glb.py  （调用 rvmparser，MIT，本地二进制）
        ▼
data/processed/model.glb          ← glTF 节点树 = PDMS 层级，node.name = PDMS 名
        │
data/source/QICHUANG-*.txt
        │  ② converter/txt_parser.py   （自写，独立层，通用不写死）
        ▼
data/processed/metadata.json      ← 保留原名称/原类型/原属性/层级路径/未知属性
        │  ③ converter/map_objects.py  （独立层）
        ▼
data/processed/mapping.json       ← rvmNodeId ↔ txtNodeId + 匹配统计 + unmatched 报告
        │
        ▼  ④ viewer/  （three.js，本地 vendor，无 CDN）
浏览器：选 中 / 隐藏 / 隔离 / 显示全部 / 层级树 / 属性面板
        │
        ▼  ⑤ reports/benchmark.md
```

**Phase 2 的具体动作**（只做 ①②的链路验证，不做 ③④⑤）：

1. 固定解析器版本，把二进制放进 `tools/`（保留 MIT 版权声明）。
2. 跑一次转换：
   ```
   rvmparser <file.rvm> --output-gltf=model.glb \
     --output-gltf-attributes=true \
     --output-gltf-rotate-z-to-y=true \
     --output-gltf-merge-geos=true \
     --output-gltf-center=true
   ```
3. **容差对比实验**：`--tolerance` 默认 0.1 m（=10 cm），对 400 mm 管径偏粗。用默认值与一个更细的值各出一份，比较文件体积与目视质量——**不预设结论**。
4. 起本地静态服务，浏览器实际打开，**目视核对 6 件事**：
   - 模型是否完整、朝向是否正常（Z→Y 是否正确）；
   - 是否有明显缺失（对照 TXT 的 SITE/ZONE/PIPE 清单抽查）；
   - 颜色是否确为单色、是否需要在 Phase 5 前补类型配色；
   - 相邻管件封口面问题是否肉眼可见；
   - 逐层展开 glTF 节点树，确认 `SITE → ZONE → PIPE → BRANCH → 元件` 名称与 TXT 一致；
   - 记录 GLB 体积、节点数、mesh 数、三角形数。

**Phase 2 的验收口径**：能看到、能辨认、层级对得上，即通过。**不追求好看、不追求流畅**——流畅是 Phase 6 的验收项。

---

## 7. 建议的项目目录结构

```
modelviewer/
├─ start.bat                     ← 唯一入口：检查产物 → 起 localhost → 开浏览器
├─ README.md
│
├─ tools/
│  └─ rvmparser/
│     ├─ rvmparser.exe           ← 固定版本的 release 二进制（MIT）
│     └─ LICENSE                 ← 必须随分发保留
│
├─ converter/                    ← 三个独立层，互不依赖
│  ├─ rvm_to_glb.py              ← ① RVM 几何层：调 rvmparser → GLB
│  ├─ txt_parser.py              ← ② TXT 元数据层：→ metadata.json（通用，不写死项目）
│  ├─ map_objects.py             ← ③ 映射层：→ mapping.json + unmatched 报告
│  └─ build.py                   ← 编排 ①②③，产出 Phase 6 需要的原始计时数据
│
├─ viewer/
│  ├─ index.html
│  ├─ app.js
│  ├─ style.css
│  └─ vendor/                    ← three.js / OrbitControls / GLTFLoader 本地化，严禁 CDN
│
├─ data/
│  ├─ source/                    ← 原始 RVM/TXT，只读，不改不删
│  └─ processed/                 ← model.glb / metadata.json / mapping.json
│
├─ reports/
│  ├─ research.md                ← Phase 0 ✅
│  ├─ inspection.md              ← Phase 1 ✅
│  ├─ phase01-summary.md         ← 本文件 ✅
│  ├─ benchmark.md               ← Phase 6
│  └─ evidence/                  ← 全部取证材料
│
└─ scratch/                      ← 探针与一次性脚本，不进交付
```

与任务书建议结构一致，只多了 `tools/`（放固定版本解析器二进制，避免每人本地编译）与把 `converter/` 明确定义为三层。

---

## 8. 待确认事项（4 条）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | **以哪个目录为正式项目目录？** 当前工作区是 `Desktop\modelviewer - 副本`，原目录 `Desktop\modelviewer` 也存在且内容基本相同 | 以 `Desktop\modelviewer`（原名）为正式目录，避免"副本"继续分叉 |
| 2 | **首版配色策略** | 按工程类型上色（管路/管件/设备/结构分色）——这是 Navisworks 的常规做法，也便于验证选择与隔离功能 |
| 3 | **Phase 2 的细分容差** | 先跑默认 0.1 m 打通链路，再并行出一份更细的做对比，用数据决定 |
| 4 | **允许下载 three.js 到本地 `viewer/vendor/` 吗？** | 需要联网下载前端库（约 1–2 MB），**模型数据不出本机**。若不允许，需要先申请 |

---

## 9. 阶段边界声明

- 本阶段**只做了读取与取证**：未生成 GLB、未写 parser、未写 Viewer、未做正式对象映射。
- 未修改、未移动、未删除任何源文件。
- 未上传任何数据到云端，未依赖 Autodesk APS。
- **停在此处，等待确认后再进入 Phase 2。**
