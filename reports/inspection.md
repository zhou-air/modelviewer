# Phase 1 — 真实文件检查报告

- 状态：**已完成**
- 日期：2026-09-18
- 核实方式：字节级探针（自写）+ 成熟解析器实跑（cdyk/rvmparser）+ 两源交叉对账
- 结论级别：`已确认`（有实测/字节证据）/ `暂定` / `缺失` / `不可验证`

---

## 0. 输入文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `示例模型/QICHUANG-SITE-RVM-2026-08-26.rvm` | 4,505,600 B (4.30 MiB) | PDMS 二进制几何 |
| `示例模型/QICHUANG-SITE-2026-08-26.txt` | 1,344,437 B (1.28 MiB) | PDMS Data Listing |

两文件同日导出（TXT 头部 `Date : 26 Aug 2026 16:32`，RVM 头部 `Wed Aug 26 16:33:40 2026`），**属同一次导出**。

---

## 1. RVM 分析

### 1.1 逐条回答任务书的问题

| 问题 | 结论 | 级别 |
|---|---|---|
| RVM 版本 | `AVEVA PDMS Design Mk12.1.SP4.0[4074] (WINDOWS-NT 6.1) (25 Jun 2013 : 20:47)` | 已确认 |
| 能否识别 PDMS hierarchy | ✅ 能。8 层 PDMS 层级完整（SITE→ZONE→PIPE→BRANCH→元件，另有结构/设备嵌套） | 已确认 |
| 是否包含对象名称 | ✅ 有。1156 个 `/` 开头的完整 PDMS 名 + 6264 个 PDMS 合成名 | 已确认 |
| 是否包含 geometry | ✅ 有。12385 个 PRIM 块，11 种图元 | 已确认 |
| 是否包含 transform | ✅ 有。每个 PRIM 含 12 float 的 3×4 矩阵 + 6 float 局部包围盒；每组另有参考原点 | 已确认 |
| 是否包含 material/color | ⚠️ **material 有，color 表没有**（详见 1.6） | 已确认 |
| 能否区分 PIPE/BRANCH/ELBOW/TEE/VALVE/FLANGE/EQUI… | ✅ 能，且与 TXT 类型逐项对齐（详见 §3） | 已确认 |
| 能否建立稳定 object ID | ✅ 能。组名**全局唯一**，且 PRIM 块有稳定的字节偏移 | 已确认 |

### 1.2 HEAD / MODL

```
HEAD v2 : info="AVEVA PDMS Design Mk12.1.SP4.0[4074]  (WINDOWS-NT 6.1)  (25 Jun 2013 : 20:47)"
          note=""  date="Wed Aug 26 16:33:40 2026"  user="cdxc@CDXC06"  encoding="Unicode UTF-8"
MODL v1 : project="XXL"  model="/MDBs"
```

> `project=XXL` 是**项目代码**，不是 MDB 名。层级第一层是 `/MDBs`。

### 1.3 chunk 结构（字节级实测）

| chunk | 数量 | 版本 | 说明 |
|---|---|---|---|
| `HEAD` | 1 | 2 | 文件头 |
| `MODL` | 1 | 1 | 模型根 |
| `CNTB` / `CNTE` | **7420 / 7420** | 2 / 2 | 组的开/闭，**完全配平** |
| `PRIM` | 12385 | 1 | 几何图元 |
| `END:` | 1 | — | 文件结束 |
| `COLR` | **0** | — | **无颜色表** |
| `OBST` / `INSU` | **0 / 0** | — | 无遮挡体 / 无保温体 |

`END:` 之后还有 576 字节全零尾部（PDMS 对齐填充），无害。

### 1.4 层级结构

```
File(MODL)  project=XXL
└─ /MDBs                              ← 组深度 1
   └─ /ENCOSC23059-QICHUANG-SITE      ← SITE         深度 2
      ├─ /QICHUANG-MAIN-PIPE          ← ZONE         深度 3   （共 15 个 ZONE）
      ...
```

| 组深度 | 节点数 | 典型类型 |
|---|---|---|
| 2 | 1 | SITE ×1 |
| 3 | 15 | ZONE ×15 |
| 4 | 292 | PIPE 147 / EQUIPMENT 98 / STRUCTURE 47 / PLOOP 46 / FRMWORK 39 … |
| 5 | 1443 | BRANCH 240 / SUBEQUIPMENT / SUBSTRUCTURE 329 … |
| 6 | 5084 | 管路元件 / 设备图元 / SCTN |
| 7 | 394 | SCTN / SNODE / 结构件 |
| 8 | 181 | SNODE / SJOINT |
| 9 | 10 | 结构最深层 |

- **组总数 7420**；其中有直属几何的 5835 个，无直属几何的 1585 个（纯容器或零长度件）。
- 有包围盒的组 6600 个（内部节点 1280 + 叶节点 5320）；822 个叶节点无包围盒。
- **最大深度 8 层**（不含 File/Model 两个技术节点）。

### 1.5 几何构成

| 图元 | 数量 | 图元 | 数量 |
|---|---|---|---|
| Cylinder | 6551 | Box | 778 |
| Snout | 1246 | CircularTorus | 565 |
| SphericalDish | 982 | Sphere | 194 |
| Line | 906 | RectangularTorus | 178 |
| FacetGroup | 815 | EllipticalDish | 98 |
| | | Pyramid | 72 |
| **合计** | **12385** | | |

FacetGroup 内部面片：**quads 14545 / polygons 1415 / contours 1525 / vertices 27650 / triangles 0**。

平均每个组 1.7 块几何。所有几何矩阵与包围盒数值均为有限值（无 NaN/Inf）。

**包围盒（世界坐标，单位 m）**：
```
E（东）: -119.64 … 79.56     跨度 199.2 m
N（北）:   -1.70 … 131.66    跨度 133.4 m
U（上）:   -3.00 …  22.61    跨度  25.6 m
```
模型位于原点附近、尺度 200 m 级 → **float32 精度充裕**，`--output-gltf-center` 非必需（仍建议开启，便于统一口径）。

### 1.6 transform 与颜色（两个必须记清的点）

**transform — 完整，可用。**
- 每个 PRIM 含 `M_3x4`（12 float，列主序 3×4 仿射矩阵）+ `bboxLocal`（6 float）。
- CNTB 组另有 `translation[3]`，是**参考原点**（局部坐标系锚点），**不是**相对父节点的变换——数值 ×0.001，即 RVM 原始坐标单位是 **mm**，读取后转为 **m**。

**颜色 — 这是本阶段发现的最大非阻塞风险。**

| 事实 | 值 | 级别 |
|---|---|---|
| COLR 色表 chunk | **0 个** | 已确认 |
| 7420 个组的 `material` 值 | **全部 = 1**（无一例外） | 已确认 |
| rvmparser 的材质→颜色映射 | `1 → Black`；`0 → Default(#787878)` | 已确认（源码 `Colorizer.cpp`） |

**推论（暂定，Phase 2 实测确认）**：按 rvmparser 默认行为，整个模型会导出为**单一黑色材质**，GLB 里只会出现 **1 个 material**。

**这不是解析器的问题**：该 RVM 本身就没有携带颜色信息——PDMS 只有在对象被显式赋予 `COLOUR` 属性、或导出时勾选了颜色表的情况下才会写 COLR。本文件没有。

**处置方案（不需用户决策，属工程实现）**：首版按**工程类型**上色，来源已有现成、可靠的两个通道：
1. RVM 合成名前缀（`ELBOW`/`VALVE`/`FLANGE`/`GASKET`/`TEE`/`REDUCER`/`OLET`/`CYLINDER`…）；
2. TXT 的 `type` 字段。

这也是 Navisworks / Autodesk Viewer 处理 PDMS 模型的常规做法（按 Item Type 上色）。**结论：颜色缺失不阻塞 Phase 2。**

### 1.7 稳定 object ID

**已确认**：`duplicate_names = {}` —— **7420 个组名互不重复**。

因此可直接用**组名**作为稳定 ID。但注意两点：

1. 合成名（`ELBOW 1 of BRANCH /WG-10401-400-L1G/B2`）里已包含父对象名，所以名字本身就编码了层级路径；
2. 组名适合作为**业务 ID**，PRIM 块的字节偏移（`rvm:<file>:cntb:<offset>`）适合作为**技术 ID**——两者建议都留，前者给人看，后者做回归比对。

---

## 2. TXT 分析

### 2.1 编码与行

| 项 | 值 |
|---|---|
| 编码 | UTF-8 **带 BOM**，严格解码通过 |
| 物理行 | 92,871（**全部 CRLF**，无混合换行） |
| 续行（行尾 `$`） | 28 处 |
| 逻辑记录 | **92,843** |

### 2.2 记录的分类（按逻辑记录统计，合计闭合 = 92,843）

> 首版此表按**物理行**统计，把形似属性的续行尾也计了进去（得 63,856）。Phase 3 的解析器实现后按**逻辑记录**重新统计并与原文逐行对账，真实分布如下。

| 类别 | 条数 | 说明 |
|---|---|---|
| 空行 | 10,027 | |
| 属性 | **63,822** | 其中主区 62,194 + `OLD` 区 1,628，均为**真正挂在对象上**的属性 |
| `NEW` | 8,955 | |
| `END` | 8,955 | **与 NEW 完全配平** |
| `OLD` 选择器 | 1,068 | 见 2.7 |
| 宏命令 | 8 | `ONERROR GOLABEL`、`INPUT BEGIN`、`INPUT FINISH`、`LABEL`、`RETURN` 等 |
| `--` 注释 | 5 | |
| `$` 指令 | 3 | `$S-`、`$S+` 同义词开关 |

物理行 92,871 − 28 处续行 = 92,843 条逻辑记录，**分布合计闭合**。

### 2.3 文件其实是一个可执行的 PDMS 宏

```
$S-  -- Synonym translation OFF
-- Data Listing    Date : 26 Aug 2026 16:32
ONERROR GOLABEL /ERROR3
INPUT BEGIN
NEW SITE /ENCOSC23059-QICHUANG-SITE
    ...
INPUT FINISH
-- Switch synonyms back on if an error occurs.
LABEL /ERROR3
handle ANY
$S+
RETURN ERROR
endhandle
-- End Data Listing    Date : 26 Aug 2026 16:32
$S+  -- Synonym translation ON
```

两个工程含义：

1. **$S- / $S+ 包裹**：导出期间**关闭同义词翻译**，所以文件里的关键字是 PDMS 规范写法（`EQUIPMENT` 而非缩写 `EQUI`）。parser 不应做同义词展开。
2. **这个文件是可以回灌 PDMS 的**：它就是一段 PML 宏。这解释了为什么文件同时是「数据」也是「可重放命令」——**Phase 4 若要在 PDMS 里定位对象，这个特性是资产**。

### 2.4 语法规则（实测归纳，未写死任何项目相关内容）

```
NEW <TYPE> [<NAME>]        节点开始。NAME 存在时以 "/" 开头；无名称时该行只有 TYPE
END                        节点结束（无参数）
<KEY> <VALUE>              属性。空格分隔，不是 ":="
OLD <SELECTOR>             引用已存在对象的属性块（仅出现在文件后段）
-- ...                     注释
$...                       PDMS 指令
行尾 $                     续行，与下一行拼接为一条记录
```

属性值的形态（**保留原样，不做单位换算**）：

| 形态 | 实例 | 备注 |
|---|---|---|
| 带单位数值三元组 | `POS E 9723mm N 23320mm U 4154.5mm` | E/N/U = PDMS 东/北/上 |
| 带单位标量 | `BORE 400mm`、`TEMP -100000degC`、`PRES 0pascal` | `-100000degC` 是「未设」哨兵值 |
| 引用 | `PSPE SPECIFICATION /L1G`、`SPRE SPCOMPONENT /L1G/GASK-9` | 库/规格引用 |
| 布尔 | `BUIL false`、`DELDSG FALS` | 注意存在 `FALS`（4 字符）写法 |
| unset | `LNTP unset` 与 `DUTY 'unset'` | **两种写法并存**，须都处理 |
| 表达式 | `RULE SET POS  Static Rule ( S ( ATTRIB HEIG OF LNID /CYLI1 - ... ) )` | 可跨行（28 处） |

### 2.5 层级与规模

| 项 | 值 |
|---|---|
| 根节点 | **1 个**：`/ENCOSC23059-QICHUANG-SITE` (SITE) |
| 节点总数 | **8,955** |
| 最大深度 | **7**（0 起始）→ **8 层** |
| 读完后栈残余 | **0** → 层级完全配平，无孤立 END |

> 8 层深度与 RVM 的 8 层 PDMS 层级**完全一致**——两源结构性吻合。

| 有名称 / 无名称 | 数量 |
|---|---|
| 有名称（`/…`） | 1,159 |
| 无名称（仅 `NEW TYPE`） | 7,796 |

### 2.6 类型与属性规模

- 节点类型：**60 种**
- 属性记录：**63,822** 条（主区 62,194 + `OLD` 区 1,628），属性键：**107 种**

主要类型（前 20）：

| 类型 | 数量 | 类型 | 数量 | 类型 | 数量 |
|---|---|---|---|---|---|
| DISH | 1040 | SCTN | 669 | SNODE | 289 |
| CYLINDER | 818 | GASKET | 550 | BRANCH | 240 |
| BOX | 796 | FLANGE | 473 | SJOINT | 182 |
| POINT | 740 | ELBOW | 410 | VALVE | 181 |
| | | NOZZLE | 390 | PIPE | 147 |
| | | SUBSTRUCTURE | 331 | POGON | 140 |
| | | TEE | 109 | EQUIPMENT | 98 |
| | | | | ZONE | 15 / SITE 1 |

主要属性键：`POS` 6738、`ORI` 4127、`BUIL` 4062、`SHOP` 3833、`SPRE` 2625、`HEIG` 2608、`LEVE` 2500、`DELDSG` 2266、`OBST` 2124、`DIAM` 1920、`LSTU` 1879、`TEMP/PRES/TPRESS/DUTY` 各 777、`PSPE` 387、`HPOS/TPOS/HBOR/TBOR/HCON/TCON` 各 240、`BORE` 145、`ANGL` 62 …

**任务书列出的属性键在真实文件中全部存在**（含 `HPOS/TPOS/HDIR/TDIR/HBOR/TBOR/PSPE/SPRE/LSTU/SHOP/BUIL/ANGL/HCON/TCON/TEMP/PRES`），未发现任务书列表中有而文件里没有的键。

### 2.7 后段 `OLD` 引用区块（重要发现）

主层级在 **第 89,066 行**结束。从 **第 89,067 行**起是另一个区块，由 **1,068 条 `OLD <选择器>`** 命令构成，携带 **1,628 条**属性：

```
OLD BRANCH /WG-10401-400-L1G/B2
HREF NOZZLE /V1073-a
TREF TEE 2 of BRANCH /WG-10401-400-L1G/B1

OLD TEE 1 of BRANCH /WG-10401-400-L1G/B2
CREF BRANCH /WG-1041-400-L1G-3/B1  TAIL
```

要点：

1. **选择器格式就是 RVM 的合成名格式**：`TEE 1 of BRANCH /WG-10401-400-L1G/B2` —— 与 RVM 里的组名**完全同构**。
2. 这些属性是 **`HREF`/`TREF`（头/尾连接引用）与 `CREF`（切割引用）**，即**管线拓扑关系**。
3. 全部 1,068 条在文件内部可自解析（`resolved_locally`）。
4. 对将来的用途极高价值：管道搜索、P&ID 联动、Navisworks/PDMS 定位。

### 2.8 边角情况（parser 必须处理的坑）

| 情况 | 规模 | 处理要求 |
|---|---|---|
| 多行记录（行尾 `$`） | 28 处 | 必须先做续行拼接再解析 |
| `FALS` / `false` 混用 | — | 布尔不能只认 `false` |
| `unset` / `'unset'` 混用 | — | 引号须剥离，但不能假定一定有引号 |
| 同一节点重复属性键 | `RULE`，最多 4 次/节点 | **不能覆盖**，必须保留为列表 |
| 属性值含空格与括号 | `RULE SET POS  Static Rule ( S ( … ) )` | 不要按空格切分 value |
| 单元格内出现 `/` 路径与裸名 | `PSPE SPECIFICATION /L1G` | `SPECIFICATION` 是类型限定词，不是路径的一部分 |
| 未设标记 | `-100000degC`、`0pascal` | 原样保留，不判为真实工况 |

### 2.9 与 RVM 的坐标系一致性（独立验证）

TXT：
```
NEW BRANCH /WG-10401-400-L1G/B2
HPOS E 9723mm N 23320mm U 4154.5mm
```
→ (9.723, 23.320, 4.1545) m

RVM（同名 BRANCH 下的第一个元件）：
```
ELBOW 1 of BRANCH /WG-10401-400-L1G/B2  bbox = [9.5804, 23.1774, 4.1589, 9.8654, 23.4624, 4.214]
```
→ x∈[9.580, 9.865], y∈[23.177, 23.462], z∈[4.159, 4.214]

**TXT 的 HPOS 落在这个 ELBOW 的包围盒平面范围内，Z 高度吻合**（4.1545 vs 4.159）。

**结论（已确认）**：两源**同坐标系（E/N/U）**、**同单位（TXT 标注 mm，RVM 内部 mm，均转为 m）**，可互相验证。这是对象匹配的第三个独立证据通道。

---

## 3. RVM ↔ TXT 对象对应（Phase 1 级可行性证据）

> 本节只做**可行性取证**，不做 Phase 4 的正式映射与统计。

### 3.1 命名对象：几乎完美对齐

| 项 | 数量 |
|---|---|
| TXT 中以 `/` 开头的完整 PDMS 名 | 1,159 |
| RVM 中以 `/` 开头的组名 | 1,157（含技术节点 `/MDBs`） |
| **交集** | **1,156** |
| 仅 TXT 有 | **3** |
| 仅 RVM 有 | **1** |

**4 个未匹配项全部可语义解释，无需猜测**：

| 对象 | 原因 |
|---|---|
| `/QICHUANG-W-SHOP-1-G/DATUM` | DATUM 是基准点，无实体，RVM 不导出 |
| `/QICHUANG-WP-04-NETWORK/DATUM` | 同上 |
| `/WORKSHOP-03-GRID-1/DATUM` | 同上 |
| `/MDBs`（RVM 独有） | RVM 的数据库根节点，不是设计对象 |

→ **命名对象匹配率：RVM 侧 1156/1157 = 99.91%，TXT 侧 1156/1159 = 99.74%。**

### 3.2 管路元件：**7 种类型逐一精确相等**

RVM 合成名前缀的 `(子类型 of 父类型)` 与 TXT 的 `父类型 → 子类型` 计数对照：

| 元件类型 | RVM（`X n of BRANCH …`） | TXT（父 = BRANCH） | 一致 |
|---|---|---|---|
| GASKET | 550 | 550 | ✅ |
| FLANGE | 473 | 473 | ✅ |
| ELBOW | 410 | 410 | ✅ |
| VALVE | 181 | 181 | ✅ |
| TEE | 109 | 109 | ✅ |
| OLET | 66 | 66 | ✅ |
| REDUCER | 33 | 33 | ✅ |

**7/7 类型数量完全相等。** 这基本锁定：**两源的管路元件集合是同一批对象。**

其他已验证一致的组合：`FITTING of STWALL` 63 = TXT 63 ✅；`SCTN of FRMWORK` 630 ✅；`SUBSTRUCTURE of STRUCTURE` 329 ✅；`DISH of SUBSTRUCTURE` 966 ✅；`CYLINDER of SUBSTRUCTURE` 435 ✅。

### 3.3 序号命名规则被文件自身证实（最强证据）

TXT 的 `OLD` 区块里有 **221 条**单层选择器形如 `TYPE n of PARENTTYPE /path`。用「同父节点下、按类型计数得到的第 n 个兄弟」去推算名字：

| 结果 | 数量 |
|---|---|
| **推算名与文件自述的选择器名完全一致** | **221** |
| 不一致 | **0** |
| 父节点未找到 | **0** |
| 序号越界 | **0** |

**221/221 = 100%。** 即：**「类型 + 同类型序号 + 父对象路径」这套命名规则是可确定性重建的**，不需要依赖数组顺序硬凑。

（另有 847 条选择器是多层嵌套形如 `SNODE 3 of SCTN 5 of FRMWORK /…`，同样可用该规则递归展开，本轮未展开统计。）

### 3.4 差集：RVM 是 TXT 的子集

- RVM 组：**7,420**（含 `/MDBs`）
- TXT 节点：**8,955**
- 差额：**约 1,535**

TXT 中**未在 RVM 出现为组**的类型（按数量排序）主要分三类：

| 类别 | 类型（TXT 计数） | 解释 |
|---|---|---|
| 无实体几何的设计/辅助对象 | POINT 740、PAVERT 185、POGON 140、VERTEX 14、DPCARTESIAN 46、DPSPHERICAL 44、VVALUE 16、DDATA 30、DPSET 2、DDSE 2、DATUM 3、POINSP 4、PCOMPONENT 8 | 轴网/放样点/数据点/基准，本来就没有实体 |
| 负向图元（挖孔用） | NBOX 16、NCYLINDER 8、NPYRAMID 2、NXTRUSION 3 | RVM 无 OBST/INSU 块，负向布尔未导出 |
| **需逐设备核对的差额** | **NOZZLE：TXT 390 vs RVM 11**、**BOX：TXT 796 vs RVM 639**、SCTN：669 vs 630（父为 SBFRAMEWORK）、CYLINDER：818 vs 810（父为 TMPLATE） | **属 Phase 4 对账项** |

> ⚠️ 上述差额**未做逐节点闭合对账**（那属 Phase 4）。本报告只声明「已识别」，**不声明差额已解释完**：粗算已识别项之和与 1,535 尚有缺口，缺口可能来自容器层级差异。

### 3.5 匹配机制设计结论（供 Phase 4 使用）

按可靠性排序，四通道、逐级回退：

| 优先级 | 通道 | 依据 | 已验证覆盖率 |
|---|---|---|---|
| 1 | **完整 PDMS 名称** | 两源同名直接配对 | 1156/1157（99.91%） |
| 2 | **合成名 = 类型 + 序号 + 父路径** | 文件自身 221/221 自证 | 管路元件 100% |
| 3 | **层级路径 + 父对象** | 深度 8 层两源一致 | 已确认结构吻合 |
| 4 | **坐标 / 包围盒互验** | 同坐标系同单位（§2.9） | 抽样通过 |

**明确不做**：不按全局数组序号强行对应（任务书红线）。
**明确不猜**：无法可靠匹配的对象写入 unmatched 报告，不填充。

---

## 4. 未验证 / 待确认清单（不在 Phase 1 声称已完成）

| 项 | 状态 | 将在哪一阶段解决 |
|---|---|---|
| GLB 实际体积、三角形总数 | NOT_TESTED | Phase 2 |
| 颜色是否真的全黑、需不需要类型配色 | 待实测（推论为单色） | Phase 2 |
| Sphere 等图元在 glTF 中是否与解析计数一致 | NOT_TESTED | Phase 2 |
| 相邻几何 10546 个未命中锚点造成的视觉封口 | 未目视核对 | Phase 2 |
| 加载时间 / FPS / draw calls / 浏览器内存 | NOT_TESTED | Phase 6 |
| 官方对象映射的完整匹配率/未匹配清单 | 未开始 | Phase 4 |
| 跨导出源（不同 PDMS 版本/项目）稳定性 | 未开始 | 后续 |
| TXT 中 `RULE` 表达式是否需要在 Viewer 中求值 | 未评估 | 后续（Phase 5 之外） |

---

## 5. 证据文件索引

| 内容 | 路径 |
|---|---|
| 本报告 | `reports/inspection.md` |
| RVM 字节级探针（可复跑） | `scratch/rvm/inspect_fields.py` |
| RVM 层级 JSON（解析器输出） | `reports/evidence/rvm-hierarchy.json` |
| RVM 解析日志（含统计与警告） | `reports/evidence/rvm-parser.log` |
| RVM 组名清单 | `reports/evidence/rvm-group-names.txt` |
| TXT 节点索引（jsonl） | `reports/evidence/txt-nodes.jsonl` |
| TXT 属性索引（jsonl） | `reports/evidence/txt-attributes.jsonl` |
| TXT 全记录（jsonl，92,843 条） | `reports/evidence/txt-records.jsonl` |
| TXT `OLD` 选择器 | `reports/evidence/txt-old-selectors.jsonl` |
| TXT 引用候选 | `reports/evidence/txt-reference-candidates.jsonl` |
| TXT 重复键 | `reports/evidence/txt-repeated-keys.json` |
| TXT 汇总统计 | `reports/evidence/txt-summary.json` |
| **交叉对账结果（本报告 §3 的来源）** | `reports/evidence/phase01-cross-check.json` |
| 交叉对账脚本（可复跑） | `scratch/cross/phase01_match_feasibility.py` |
