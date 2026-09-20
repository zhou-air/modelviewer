# Phase 2 — 转换 Spike：RVM → 可显示 Web Geometry

- 状态：**已完成**，几何链路打通并在真实浏览器 + 真实 GPU 上实测通过
- 日期：2026-09-18
- 范围：只做 ① 几何层 + 一个足以验证的最小 Viewer。**未做** TXT 解析（Phase 3）、对象映射（Phase 4）、选中/隐藏/隔离/树/属性面板（Phase 5）
- 未改动源文件；未上传任何数据

---

## 1. 结论

**通过。** 真实 QICHUANG RVM 转成 GLB，浏览器加载 1.0–1.5 s 到位，**draw calls 5796、335,824 三角形、实测 55 FPS**，运行在实体 GPU 上（ANGLE / NVIDIA RTX 4060 Laptop / D3D11，非软件渲染）。层级、名称、朝向、居中全部正确。

发现 **2 个上游缺陷**，均已定位到源码行、量化影响范围，且都有可行处置（见 §5）。

---

## 2. 转换结果

### 2.1 命令

```
tools/rvmparser/rvmparser.exe data/source/QICHUANG-SITE-RVM-2026-08-26.rvm \
  --output-gltf=data/processed/model.glb \
  --output-gltf-attributes=true  --output-gltf-rotate-z-to-y=true \
  --output-gltf-merge-geos=true  --output-gltf-center=true \
  --tolerance=0.02
```

### 2.2 规模对照

| 项 | RVM 源 | GLB 产物 |
|---|---|---|
| 文件体积 | 4,505,600 B (4.30 MiB) | **18,385,928 B (17.5 MiB)** |
| 组 / 节点 | 7420 组 | 7931 节点 |
| 几何 / 图元 | 12385 几何块 | 5796 mesh + 289 线图元 |
| 三角形 | — | **335,824** |
| 顶点 | — | 369,397 |
| 材质 | `material` 全 = 1 | **1 个**（名为 `Black`） |
| 层级深度 | 8 层 PDMS 层级 | 10 层（+ File + Model + 旋转节点） |
| 命名节点 | 1157 `/` 名 + 6264 合成名 | **1157 + 6264，完全一致** |

**节点数 7931 的构成**（可逐项对账，无不明差额）：
`File 1 + Model 1 + 组 7420 + 旋转节点 1 + holder 节点 508 = 7931`

holder 节点的来源：`ExportGLTF.cpp` 用 `modifyNodeTransform = (节点无子节点)` 判断——**有子节点且有直属几何的组**会额外生成 holder 子节点承载 mesh，共 515 个，其中 7 个因缺陷 #1 丢失 → 实际 508。

### 2.3 容差对比（三档实测，同一台机器）

| `--tolerance` | 三角形 | 顶点 | GLB 体积 | 细分耗时 |
|---|---|---|---|---|
| 0.1 m（默认） | 181,259 | 233,248 | 13,331,000 B | 60 ms |
| **0.02 m（本项目默认）** | **335,824** | **369,397** | **18,385,928 B** | **81 ms** |
| 0.005 m | 722,383 | 675,365 | 30,455,416 B | 71 ms |

**观察**：转换耗时几乎不随精度变化（瓶颈在文件解析与写出，不在细分）。0.1 m 对 400 mm 管径偏粗（10 cm 容差 ≈ 管半径的一半），0.02 m 体积只增加 38% 而细节明显改善。**据此把默认值定为 0.02 m**；0.1 m 保留为快速档。这不是优化决策，只是选一个合理的默认。

**全流程耗时**：339 ms（含进程启动、解析、细分、写出 18 MB）。

### 2.4 附带的好消息

日志显示 **`Discarded 8847 caps`**——相邻几何的内部封口面被自动剔除了 8847 个。这**缓解了 Phase 1 提出的担忧**（当时发现"锚点只匹配 12714/23260"，担心大量内部封口面外露）。实际渲染中未观察到明显的多余封口面。

---

## 3. 浏览器实测

| 项 | 值 |
|---|---|
| WebGL 渲染器 | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)` —— **实体 GPU** |
| WebGL 版本 | WebGL 2.0 (OpenGL ES 3.0 Chromium) |
| 页面加载 → 模型就绪 | **1013 ms / 1475 ms**（两次实测） |
| **draw calls** | **5796** |
| 渲染三角形 | 335,824 |
| **FPS（3 秒实测）** | **55** |
| 几何对象 / 纹理 | 5796 / 0 |
| shader program | 2（网格 1 + 线 1） |
| 控制台错误 / 页面异常 | **0 / 0** |
| 模型包围盒 | 199.20 × 25.60 × 133.36 m，**已居中于原点** |
| 交互验证 | 真实鼠标拖拽后相机位置改变 → OrbitControls 生效 |

**朝向验证**：RVM 的 E/N/U 跨度为 199.2 / 133.4 / 25.6 m。GLB 中尺寸为 (199.20, **25.60**, 133.36) = (E, **U**, N)——**PDMS 的 Z-up 已正确转换为 glTF 的 Y-up**。

截图：`reports/phase2-viewer-screenshot.png`、`reports/phase2-viewer-screenshot-rotated.png`

### 3.1 对 Phase 1 风险预测的修正

Phase 1 我把"draw call 偏高"列为**最大技术风险**，预测 5000–6000 量级会导致 20–40 FPS。

**实测结果：5796 draw calls 下 55 FPS。预测的 draw call 量级完全准确，但对 FPS 的影响被高估了。** RTX 4060 这个量级扛得住。

需要保留的限定：
- 这是**无头 Chromium + 实体 GPU** 的测量，真实开窗浏览会有轻微差异；
- 未测低端核显机器；未测内存占用；
- 55 而非 60+ 说明已接近这个方案的舒适区上沿，**但如果后续模型规模明显变大（例如整个园区），Phase 7 仍需评估合并/实例化**。

结论：**第一版继续用 Three.js + GLB，暂不引入 xeokit/XKT。** 该判断有数据支撑，非凭感觉。

---

## 4. Viewer 第一版实际实现的内容

严格限定在"够验证"的范围：

- **Navigation**：Orbit / Pan / Zoom / Fit（`F` 键或按钮复位视角），带阻尼、`screenSpacePanning`（工程视图更顺手）
- **渲染**：Solid/Shaded、抗锯齿（antialias）、Hemisphere(环境) + 3×Directional(主/补/轮廓) 光照、ACES Filmic tone mapping、浅色背景
- **统一灰色材质**（按决定）：`0x8d949c`，roughness 0.62，metalness 0；全部 mesh 复用**同一个材质实例**，shader program 只有 2 个
- **线几何**单独用 `0x4d5866` 的 `LineBasicMaterial`
- **运行统计面板**：FPS / draw calls / 三角形 / 场景对象（实时）
- 坐标轴开关

**未实现**（属 Phase 5）：选中高亮、Hide / Isolate / Show All、层级树、属性面板。
**未实现**（属 Phase 6/7）：SSAO/GTAO、silhouette / edge enhancement、Draco/Meshopt、Instancing。

**一处超出"最小"的改动，理由如下**：首轮截图整体偏曝、结构细节发白不易辨认，我把材质灰阶调深（`0x9aa2ab` → `0x8d949c`）、降低曝光（1.0 → 0.92）与光强配比。理由是 Phase 2 的验收口径要求"**能看到、能辨认**"，偏曝会直接影响辨认，属于本阶段目标而非视觉打磨。

---

## 5. 发现的两个上游缺陷

### 缺陷 #1 — 单条 Line 几何被静默丢弃

| 项 | 内容 |
|---|---|
| 现象 | 906 条 Line 几何中 **39 条未出现在 GLB**，且 7 个 holder 节点也一并缺失 |
| 丢失对象 | **全部是轴网线**：`/QICHUANG-W-SHOP-1-G/1/X1…X12/Y1…`、`/WORKSHOP-03-GRID-1/1/X1…Y4` 等 |
| 根因（已定位到行） | `ExportGLTF.cpp` → `addGeometryPrimitive()` 的 `if (geo->kind == Geometry::Kind::Line)` 分支构造了 `rjPrimitive`，**但没有 `rjPrimitivesNode.PushBack(...)`**；只有非 Line 分支才 push。于是 `insertGeometryIntoNode()` 看到空 primitive 数组 → `return false` → 不建 mesh、不建 holder |
| 为什么还剩 289 条 | 那条路径只在"**组内几何数 == 1**"时走到。几何数 > 1 的组走 `insertMergedGeometriesIntoNode()` → `addPrimitiveForLines()`，该函数**有** push，所以正常 |
| 数量自洽性 | 328 个"仅线"组 − 39 个单线组 = **289** = GLB 中实测线图元数 ✓；515 − 7 = **508** holder ✓ 完全对账 |
| 上游状态 | 已核对仓库最新提交（2025-08-25）的源码，**缺陷仍存在**，未修复 |
| 影响 | 建筑定位轴网不显示。不影响管道、设备、结构实体，不影响层级与名称 |

**处置选项**（本机**未安装 MSVC**，无 `cl.exe` / Visual Studio）：

| 方案 | 成本 | 评价 |
|---|---|---|
| (a) 接受现状，记录为已知缺陷 | 0 | **【已采纳 2026-09-18】** 轴网是参照几何，不影响 10 条验收标准中的任何一条 |
| (b) 装 VS Build Tools 后打一行补丁自编译 | 下载数 GB + 编译 | 最干净、可回归，保留为后续清理项 |
| (c) 在 converter 层把丢失的线从 RVM 补出来再注入 | 中 | **不采纳**——属"用临时代码掩盖问题"，与项目原则冲突 |

### 缺陷 #2 — 非 ASCII 路径会产生非法 GLB

| 项 | 内容 |
|---|---|
| 现象 | 用**绝对路径**调用时，`data/processed/model.glb` 的 JSON 块出现 **4 个非法 UTF-8 字节**（偏移 1328062） |
| 具体内容 | 解析器把源文件路径原样写进 glTF 的 File 节点 `name`。Windows 下它拿到的是 ANSI 代码页（本机 GBK）字节：`modelviewer - \xb8\xb1\xb1\xbe\`（"副本"的 GBK 编码） |
| 后果 | JSON 块不是合法 UTF-8 → **严格 glTF 校验 / 部分 loader 会拒收该 GLB**。（three.js 用容错解码，只是把该节点名变成 `��`，所以渲染本身看不出来） |
| 影响范围 | 仅 File 节点的路径名 1 处，4 字节；几何、材质、层级、其余 7420 个名称**完全不受影响** |
| 处置 | **已规避**：`converter/rvm_to_glb.py` 改为「`cwd` = 项目根 + 相对 ASCII 路径」调用，并在解析器拒绝时直接报错；同时 `validate_glb_json()` 每次转换后强制校验 JSON 块 |
| 回归闸门 | `converter/verify_glb.py` 新增 `json_utf8_ok` 字段，非合法 UTF-8 会被明确报出，不会静默通过 |
| 上游状态 | 属编码处理缺陷，未修复。**风险保留**：若将来源文件名本身含中文，需要先在 converter 里做一次 ASCII 化重命名 |

### 不是缺陷但需记录

- **`node.extras` 全为空**：`--output-gltf-attributes=true` 已开启，但没有喂属性文件，且 rvmparser 的属性通道只认 `CADC_Attributes_File v1.0` 格式（`KEY := VALUE &end&`），**吃不了本项目的 PDMS Data Listing**。
  → **反向印证 Phase 1 的判断**：属性必须走自建的 TXT parser（Phase 3）+ 映射层（Phase 4），GLB 只负责几何。
- **材质只有 1 个、名为 `Black`**：RVM 无颜色表，7420 组 `material` 全 = 1。Viewer 侧统一覆盖为灰色，GLB 本身保持忠实于源数据。

---

## 6. Phase 2 验收对照

| 验收口径（Phase 2） | 结果 |
|---|---|
| RVM 能转成可显示的 Web 几何 | ✅ GLB 18.4 MB |
| 浏览器能完整显示 | ✅ 截图 + 实测，无控制台错误 |
| 朝向正确 | ✅ Z-up → Y-up 已正确转换 |
| 层级与名称保留 | ✅ 1157 + 6264 名称逐一核对一致 |
| 能辨认 | ✅ 管廊、结构框架、设备、平台清晰可辨 |
| 打开浏览器实际验证 | ✅ 无头 Chromium 实体 GPU 实测 + 两张截图 |
| **不追求好看 / 不追求流畅** | 未越级做 UI、未做复杂优化 |

---

## 7. 产物与证据

| 内容 | 路径 |
|---|---|
| 转换产物 | `data/processed/model.glb` |
| 转换脚本（① 几何层） | `converter/rvm_to_glb.py` |
| GLB 校验器 | `converter/verify_glb.py` |
| Viewer | `viewer/index.html` · `viewer/app.js` · `viewer/vendor/`（three.js r160） |
| 入口 | `start.bat` |
| 浏览器实测原始数据 | `reports/evidence/phase2-browser-measure.json` |
| GLB 结构校验结果 | `reports/evidence/phase2-glb-check.json` |
| 转换记录（含 exe SHA1、耗时、GLB 校验） | `reports/evidence/convert-records-tol0.02.json` |
| 转换日志（三档容差） | `scratch/phase2-convert-t*.log`、`scratch/convert-tol0.02.log` |
| 浏览器截图 | `reports/phase2-viewer-screenshot.png` · `-rotated.png` |
| 浏览器验证脚本（可复跑） | `scratch/browser-verify.js` |

---

## 8. 待决策 / 下一步

**已决策（2026-09-18）**：缺陷 #1 的 39 条轴网线 —— **接受现状**，记为已知缺陷，后续装 MSVC 再打补丁清理。证据：`reports/xeokit-evaluation.md` 显示即便换 xeokit，剩下的 289 条线也会全部丢失，说明这不是迁就某个库的问题。

**已完成**：xeokit-sdk 套用评估 → `reports/xeokit-evaluation.md`。结论：实测能跑（draw call 5796→6、FPS 55→180），但**层级被拍平到 1 层、对象类型丢失、线几何全丢**，且许可证为 **AGPL-3.0**。**不切换**，保留为 Phase 7 候选。

**下一步**：
- **Phase 3（可立即开始）**：实现 `converter/txt_parser.py` → `metadata.json`。要点已在 `inspection.md` §2 列全：`NEW <TYPE> [名]` / `KEY value`、28 处 `$` 续行、同节点重复键（`RULE`）不可覆盖、`FALS`/`false` 与 `unset`/`'unset'` 混用、114 种属性键全部原样保留、`OLD` 引用区块单独处理。
  - 附加建议（零成本期权）：`metadata.json` 的字段形状直接采用 xeokit metamodel 的 `id / name / type / parent / propertySets[].properties[]`，将来若要上 xeokit 可零改造切换。
- Phase 4：对象映射（四通道逐级回退），输出匹配率与 unmatched 报告。
- Phase 5：Viewer MVP 交互（选中 / 隐藏 / 隔离 / 层级树 / 属性面板）。
- Phase 6：`benchmark.md`。
