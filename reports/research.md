# Phase 0 — 开源 RVM parser / converter 调研

- 状态：**已完成**
- 日期：2026-09-18
- 核实方式：仓库源码直读（本地 clone）+ LICENSE 文件原文 + 提交历史（git log）+ 官方仓库页面 + **在本机对真实 QICHUANG RVM 实跑验证**
- 结论级别标注：`已确认`（有原文或实测证据）/ `暂定`（有间接证据）/ `缺失` / `不可验证`

---

## 0. 先纠正两个仓库地址

任务书中给出的两个候选仓库地址**均不存在**：

| 任务书地址 | 实测结果 |
|---|---|
| `bertt/rvmparser` | `已确认` HTTP 404，仓库不存在 |
| `bertt/rvmsharp` | `已确认` HTTP 404，仓库不存在 |

实际对应项目为：

| 实际项目 | 关系 |
|---|---|
| **`cdyk/rvmparser`** | RVM 解析的**源头实现**（C++）。`equinor/rvmsharp` 自述 "based on rvmparser by @cdyk" |
| **`equinor/rvmsharp`** | Equinor 的 C#/.NET 移植 + 生产化（CadRevealComposer） |

> 后续文档一律使用实际仓库地址，避免用 404 地址做决策依据。

---

## 1. 候选清单

| 项目 | 许可证 | 语言 / 依赖 | 最后提交 | RVM 读取 | 导出 glTF | 保留层级 | 保留属性 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **cdyk/rvmparser** | **MIT** | C++11，仅 libtess2 + rapidjson（均内嵌 submodule） | **2025-08-25** | ✅ | ✅ **GLB/glTF（首选导出目标）** | ✅ glTF 节点树 | ✅ 可写入 node.extras | **选它** |
| equinor/rvmsharp | MIT (Equinor ASA 2019-2023) | C# / .NET 8+、.NET Standard 2.1；LibTessDotNet、System.Numerics.Vectors；NuGet `Equinor.RvmSharp` | 活跃（CadReveal 生产使用） | ✅ | 间接：经 CadRevealComposer → **Reveal 私有格式**，非标准 glTF | ✅ | ✅ | **备选**（见 §3） |
| StirlingLabs/rvmparser | MIT | C++，cdyk 的 fork | **2021-12** | ✅ | 部分（SLJSON 为主） | ✅ | ✅ | 不选（停更，改动集中在自有格式） |
| benvautrin/pmuc (EDF) | **LGPL-2.1** | C++17 + cmake；Boost、OpenCOLLADA、eigen、xiot | **2019-09** | ✅ | ❌ **无 glTF**（X3D / COLLADA / IFC2x3 / STL / DSL3D） | ✅ | ✅ | 不选（无 glTF、停滞 7 年、依赖重、LGPL 传染性） |
| eryar/RvmTranslator (PlantAssistant) | **闭源**（仅免费 3D 浏览） | 未知 | 2025-12 | ✅ | ✅ | — | — | 不选（不可用于本项目源码集成） |
| benvautrin/pmuc 的衍生 / 其他 | — | — | — | — | — | — | — | 未发现与本项目需求更匹配且在维护的实现 |

补充可复用资源（非 converter）：

- `cognite/reveal` —— Web 端大模型 Viewer（Reveal 格式），Phase 7 若走 XKT/私有格式路线时的对照项。
- `xeokit/xeokit-sdk` —— Web Viewer，支持 XKT；Phase 7 候选。
- Equinor **Huldra 公开数据集**（`https://data.equinor.com/dataset/Huldra`）—— 完整海上平台 RVM 源数据，可用于后续「跨导出源稳定性」验证。

---

## 2. 为什么选 `cdyk/rvmparser`

**已确认**（本地 clone 源码 + 本机实跑）：

1. **许可证干净**：MIT（`Copyright (c) 2018-2021 Christopher Dyken`）。可商用、可修改、可闭源分发，只需保留版权声明。
2. **glTF/GLB 是一等导出目标**，而非附加功能。CLI 直接：
   ```
   rvmparser <file.rvm> --output-gltf=<file.glb>
   ```
3. **glTF 节点树保留 PDMS 层级与名称**：源码 `ExportGLTF.cpp` 的 `processNode()` 对 `Node::Kind::File/Model/Group` 逐类写出 `name` 字段，层级一一对应。
4. **属性可随节点导出**：`--output-gltf-attributes=true`（默认 true），把 RVM 属性写入 glTF node 的 `extras`。
5. **工程级细节已经做好**：
   - `--output-gltf-rotate-z-to-y=true`（默认）：PDMS 是 Z 轴向上，glTF 是 Y 轴向上，自动插入旋转节点——**省掉自己处理坐标系**。
   - `--output-gltf-merge-geos=true`（默认）：同一节点的多块几何合并为一个 mesh，保持「组 = 可选单元」的粒度——正是本项目需要的选择粒度。
   - `--output-gltf-center=true`：把模型移到包围盒中心并在 `asset.extra` 记录原点——处理 PDMS 大坐标的 float 精度问题。
   - `--tolerance`：细分容差（默认 0.1，世界单位）。
   - `--color-attribute=<key>`：颜色可由属性键指定，不写死。
   - `--output-gltf-split-level`：按层级拆分成多个文件，为将来按需加载留口子。
6. **覆盖全部 11 种 RVM 图元**：`Tessellator.cpp` / `TriangulationFactory.cpp` 对 Pyramid、Box、RectangularTorus、CircularTorus、EllipticalDish、SphericalDish、Snout、Cylinder、**Sphere**、Line、FacetGroup 全部有实现分支。
7. **依赖极少**：只有 libtess2（多边形三角化）与 rapidjson。内存映射 + arena 分配，为超大模型设计。
8. **实测可用**：本机用 release 二进制 `rvmparser-v1.0.4.exe` 对真实 QICHUANG RVM 跑通，**解析零错误**，产出 7420 组 / 12385 几何，与独立编写的字节级探针结果**逐节点对账一致**（名称序列、父子关系、数量全等）。

**已知限制**（已确认，非阻塞）：

| 限制 | 影响 | 处置 |
|---|---|---|
| `.txt` / `.att` 输入只认 **CADC_Attributes_File v1.0** 格式（`NEW <名>` + `KEY := VALUE &end&`） | **不能**直接吃我们的 PDMS Data Listing | 属性解析自己写（本来就是 Phase 3 计划）；见 `inspection.md` §3 |
| `--output-rev` 通道跳过 Sphere（type 9） | 只影响 `.rev` 文本导出 | 与本项目无关（我们走 glTF） |
| `--output-json`（`ExportJson.cpp`）**只写 name/material/bbox，不含几何** | 不能拿它当几何来源 | 几何一律从 glTF 取 |
| 相邻几何"锚点"对齐只有 12714/23260 命中 | 部分相邻管件之间会保留内部封口面 | 纯视觉，不影响层级/数据；Phase 2 目视核对 |
| 无 COLR 色表时 `material=1` → 映射为 Black | 可能整模型单色 | 详见 `inspection.md` §2.7；方案是按工程类型上色 |

---

## 3. 为什么不用 `equinor/rvmsharp`（但保留为备选）

**已确认**：

- MIT 许可证、Equinor 生产级项目、C#/.NET 8+、NuGet 可引。
- 但它**不直接产出标准 glTF/GLB**：它的下游是 `CadRevealComposer` → **Cognite Reveal 私有格式**；glTF 写入器（`GltfWriter.cs`）是 CadReveal 内部管线的一部分，不是通用 CLI。
- 走它意味着要么吃它的私有格式（绑定 cognite/reveal 生态），要么自己搭 C# 导出工程。
- 本机已有 .NET 6.0.428 / 10.0.302 SDK，技术上能跑，但**本阶段没有必要**。

**它仍然值得保留的理由**：

1. 它的 `PdmsTextParser.cs` 是**唯一一份公开的、经过生产验证的 PDMS 文本解析实现**——虽然它解析的是 `CADC_Attributes_File v1.0`（不是我们的 Data Listing），但其「缩进栈 + NEW/END 配对 + 属性字典 + 字符串驻留」的工程做法，是 Phase 3 写我们自己的 TXT parser 时最好的参考。
2. 若 Phase 7 的 benchmark 显示 Three.js 吃力、需要上 Reveal/XKT 生态，rvmsharp + CadRevealComposer 是现成的整条路线。

**决策**：Phase 2 用 `cdyk/rvmparser` 出 GLB。rvmsharp 只作为参考资料与 Plan B，不引入 .NET 依赖。

---

## 4. Viewer 层：Three.js 还是 xeokit

**本阶段不定案**——按项目原则，Phase 7 依据真实 benchmark 决定。Phase 0 只记录事实：

| | Three.js | xeokit-sdk |
|---|---|---|
| 定位 | 通用 WebGL/WebGPU 引擎，glTF/GLB 原生 | 专为工程/AEC 大模型优化的 Viewer |
| 对应格式 | GLB | **XKT**（需额外转换：GLB→XKT 或 RVM→XKT） |
| 多出的一层转换 | 无 | 有（xkt 转换 CLI / SDK） |
| 工程特性 | 需自己实现 outline/AO/树/隔离 | 内置高亮、剖切、树、XKT 流式加载 |
| 本阶段结论 | **先用它**（少一层转换，链路最短） | 备选；触发条件见 `phase01-summary.md` §5 |

**判断依据（暂定，待 Phase 6 实测）**：本模型 4.3 MiB RVM → 7420 组 / 12385 几何 / 约 1.5 万 quad + 1415 polygon 面片组，量级属于「小而精的装置模型」，不是园区级。GLB + Three.js 很可能够用。**先不提前引入 XKT。**

---

## 5. 证据位置

| 内容 | 路径 |
|---|---|
| 本调研文档 | `reports/research.md` |
| 源码证据（排错时可直接查） | `reports/evidence/research/` |
| ├ cdyk/rvmparser 关键源码 | `cdyk-rvmparser_src_*.cpp`、`Store.h` |
| ├ cdyk 许可证原文 | `cdyk-rvmparser_LICENSE` |
| ├ equinor/rvmsharp 关键源码 | `equinor-rvmsharp_*.cs`、`.csproj` |
| └ equinor 许可证 / 三方许可 | `equinor-rvmsharp_LICENSE`、`_ThirdPartyLicenses.md` |
| 完整源码仓库（浅克隆） | `scratch/rvm/rvmparser/` |
| 已下载的 release 二进制 | `scratch/rvm/rvmparser-v1.0.4.exe` |
| 官方仓库 | https://github.com/cdyk/rvmparser |
