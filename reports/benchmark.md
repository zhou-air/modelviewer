# benchmark.md — 真实 QICHUANG 模型性能基准

- 模型：`QICHUANG-SITE`（PDMS 12.1 SP4 导出，2026-08-26）
- 日期：2026-09-18
- 采集方式：`scratch/phase6-benchmark.js`（可复跑），原始数据 `reports/evidence/phase6-benchmark.json`
- **所有数字均为本机实测，未估、未填**。凡未测项一律标注并说明原因。

---

## 1. 测试环境与口径

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11 家庭版 中文版，`10.0.26200` |
| CPU | 12th Gen Intel Core i5-12450H，8 核 / 12 线程 |
| 内存 | 15.7 GiB（`TotalVisibleMemorySize` = 16,502,824 KB） |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU（驱动 32.0.15.8097） |
| 浏览器 | Chromium 1208（Playwright 自带），**无头模式** |
| WebGL | `WebGL 2.0 (OpenGL ES 3.0 Chromium)` |
| 实际渲染器 | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)` ← **实体 GPU，非软件渲染** |
| 视口 | 1760 × 940，`devicePixelRatio = 1`，canvas 绘制缓冲 1124 × 940 |
| 轮次 | 加载计时取 **3 轮中位数**；FPS 为 **3 秒 rAF 计数**；拖动场景为 ~2.5 秒真实鼠标拖动 |

**方法说明**：FPS 用 `requestAnimationFrame` 计数（不是库自报）。draw call 用两种口径分别记录：

- **场景 calls** —— 在 `RenderPass` 执行完的瞬间读取 `renderer.info.render.calls`，即几何本身的绘制量（与 Phase 2 口径一致，可比）
- **全帧 calls** —— 关掉 `renderer.info.autoReset`、每帧手动 `reset()` 后读取，含描边等全部后期 pass 的合计

**口径限制（重要）**

1. 无头模式与开窗浏览会有差异：无头下 rAF 不受 vsync 限制（实测可到 165–180 FPS），因此**高于 60 的 FPS 数字只代表"有余量"**，不代表真实开窗体验。
2. 未测低端核显机器；未测 GPU 显存占用（浏览器不暴露）。
3. 内存只统计 **JS 堆**，不含 GPU 缓冲与驱动侧占用。
4. 单机、单浏览器、单次导出，不含跨项目/跨版本变异性。

---

## 2. 静态规模

| 文件 | 字节 | MiB |
|---|---|---|
| RVM（源） | 4,505,600 | 4.30 |
| TXT（源） | 1,344,437 | 1.28 |
| **GLB（本项目几何产物）** | **18,385,928** | **17.53** |
| XKT（xeokit 路线实验产物） | 9,096,708 | 8.68 |
| metadata.json | 5,541,010 | 5.28 |
| metadata.metamodel.json | 5,501,767 | 5.25 |
| rvm-node-index.json | 3,901,591 | 3.72 |
| mapping.json | 1,406,286 | 1.34 |

**Viewer 实际加载量**：GLB 17.53 MiB + metadata 5.28 + mapping 1.34 + rvm-node-index 3.72 = **约 27.9 MiB**

### 对象与几何计数

| 指标 | 值 | 来源 |
|---|---|---|
| RVM 组（object count） | **7,420** | `rvm-node-index.json` |
| RVM 几何块 | 12,385 | 同上 |
| GLB 节点总数 | 7,931 | GLB JSON |
| GLB 命名节点 | 7,423 | 同上 |
| **mesh 数** | **5,507**（+ 线图元 289） | GLB JSON |
| **三角形数** | **335,824** | GLB accessor 累计 |
| 顶点数 | 371,131 | 转换日志 |
| TXT 对象数 | 8,955 | `metadata.json` |
| TXT 属性数 | 63,822 | 同上 |
| RVM ↔ TXT 映射边 | 7,420 | `mapping.json` |
| shader program | 3 | `renderer.info.programs` |
| GPU geometry 对象 | 5,797 | `renderer.info.memory.geometries` |

---

## 3. 加载时间（3 轮中位数）

| 阶段 | 中位数 | 说明 |
|---|---|---|
| metadata.json 5.28 MiB（fetch+parse） | 104 ms | |
| mapping.json 1.34 MiB | 52 ms | |
| rvm-node-index.json 3.72 MiB | 124 ms | |
| **三份 JSON 并行合计** | **129 ms** | 并行发请求，故小于三者之和 |
| 建索引（canonical → txtId / 映射边） | 9 ms | |
| **GLB 17.53 MiB（fetch + 解析 + 建索引 + 应用材质）** | **356 ms** | |
| **页面到首帧**（内部计时） | **909 ms** | 几何加载完成后再等两个 rAF |
| 就绪（内部计时，几何 loaded 事件触发时刻） | 555 ms | 不含首帧渲染，比上一行早 |
| 外部观测：导航 → 就绪可交互 | **1,051 ms** | 含测试脚本轮询开销 |

> 内部计时的 `readyMs`(555) 与 `firstFrameMs`(909) 不等，是因为 `ready` 在几何加载完成时即置位，而 `firstFrameMs` 还额外等了两个 rAF（确保首帧真的画出来）。**对外承诺用 1,051 ms 这个外部观测值更稳妥。**

三轮原始值（`navToReadyMs`）：1057 / 947 / 1051 ms — 波动 < 11%，可复现。

---

## 4. 渲染与交互性能（场景矩阵）

| 场景 | FPS | 场景 calls | **全帧 calls** | 可见对象 | 描边 |
|---|---|---|---|---|---|
| **S1 全模型视野 · 无选中 · 空闲** | **52** | 5,796 | 5,797 | 7,420 | 否 |
| **S2 全模型视野 · 有选中 · 描边开 · 空闲** | **25** | 5,796 | **11,600** | 7,420 | 是 |
| **S3 全模型视野 · 有选中 · 拖动中（描边暂停）** | **45** | 5,796 | 5,797 | 7,420 | 否 |
| S4 缩放到单个元件 · 有选中 · 空闲 | 101 | 37 | 82 | 7,420 | 是 |
| S5 隔离后 · 空闲 | 165 | 2 | 12 | **5** | 是 |
| S6 全模型视野 · 无选中 · 拖动中 | 47 | — | — | 7,420 | 否 |

### 结论

1. **纯几何浏览（无选中、不描边）：52 FPS，5,796 次 draw call / 帧。** 这是本模型的基础性能水位。
2. **描边是唯一显著的开销**：`OutlinePass` 要把场景再渲染进深度/边缘缓冲，**全帧 draw call 从 5,797 涨到 11,600（2.00×）**，空闲 FPS 从 52 **腰斩到 25**。
3. **因此按任务书允许的做法在交互期间暂停描边**：拖动中回到 **45 FPS**（S3），停下 160 ms 自动恢复。另加一层常驻发光材质高亮（换材质实例，零逐帧开销），保证拖动时仍能看见选中对象。
4. **视锥剔除非常有效**：缩放到单个元件后场景 calls 从 5,796 掉到 37，FPS 到 101；隔离后只剩 2 次调用、165 FPS。
5. 拖动比空闲略慢（45–47 vs 52），是鼠标事件与相机更新的开销，不是渲染问题。

> **S2 的 25 FPS 是当前配置的下限**，且只在"选中了对象并且静止不动"时发生。如果用户更看重静止时的描边清晰度、不在意拖动流畅度，可以常开描边并接受这个数字——开关在 `viewer/js/viewer3d.js` 一行。若两者都要，下一阶段可做的优化有：降低 `OutlinePass.downSampleRatio` 分辨率、只在选中对象所在屏幕区域做描边、或改用"背面壳 + 缩放"的廉价描边。

---

## 5. 浏览器内存

用 CDP `HeapProfiler.collectGarbage` 强制 GC 后读取（`--enable-precise-memory-info`）：

| 时刻 | usedJSHeap | totalJSHeap | 堆上限 |
|---|---|---|---|
| 加载完成、GC 后 | **56.5 MB** | 62.5 MB | 4096 MB |
| 跑完全部场景、GC 后 | **60.2 MB** | 64.1 MB | 4096 MB |
| **增量** | **+3.7 MB** | — | — |

- 27.9 MiB 的输入数据（GLB + 4 份 JSON）在 GC 后只留 **56.5 MB** JS 堆，`metadata.json` 与 `rvm-node-index.json` 的中间解析对象已被回收。
- 跑完 6 个场景后仅增 3.7 MB，**多次选中/隐藏/隔离/显示全部未见泄漏趋势**。
- **未统计项**：GPU 侧顶点/索引缓冲、`OutlinePass` 的多个渲染目标（`renderer.info.memory.textures = 2` 是内部计数，不含显存字节）。浏览器不暴露显存，此项标为**不可获得**。

---

## 6. 横向对照

| 指标 | **本项目 three.js + GLB** | xeokit + XKT | xeokit + GLB 直载 |
|---|---|---|---|
| 几何产物 | GLB 17.53 MiB | XKT 8.68 MiB | GLB 17.53 MiB |
| 转换步骤 | RVM → GLB | RVM → GLB → XKT | RVM → GLB |
| **draw calls / 帧（全模型）** | **5,796** | **6** | **1** |
| **拖动中 FPS** | **45** | **180** | 180 |
| 模型加载耗时 | 356 ms | 275–292 ms | 1,110–1,141 ms |
| 页面到就绪（外部观测） | 1,051 ms（含 10.4 MB 元数据） | 644–881 ms（**不含元数据**） | 1,433–1,483 ms |
| **PDMS 层级** | **8 层完整** | **1 层（拍平）** | **无** |
| 对象类型 | 完整（从 canonical 得到） | 全部 `Default` | 无 |
| 线几何 | 289 条 | 0 | 0（报错丢弃） |
| 内置工程功能 | 自建（树/属性/隔离已实现） | TreeView / 剖切 / 测量 / 楼层 / BCF | 同左但无数据 |
| 许可证 | **MIT** | **AGPL-3.0** | **AGPL-3.0** |

> xeokit 三列为 Phase 2 在同一台机器、同一浏览器、同一视口下的实测（详见 `reports/xeokit-evaluation.md`）。
> **公平性保留**：xeokit 的着色管线比本项目（PBR StandardMaterial + ACES tone mapping + 4 盏灯）简单得多，FPS 差距中有一部分来自着色开销，不能全部归功于批处理。**draw call 数量的对比才是干净的**（6 vs 5,796）。
> **口径保留**：xeokit 那次没有加载本项目 10.4 MB 的元数据，所以"页面到就绪"两列不可直接比。

### 未测项（明确标注，不填数字）

| 对照对象 | 状态 | 原因 |
|---|---|---|
| **Navisworks Manage 2024** | **NOT_TESTED** | 本机确实装有（`E:\auto\Navisworks Manage 2024\Roamer.exe`，且 Navisworks 原生支持导入 `.rvm`），但它是 GUI 桌面程序：**加载耗时需人工掐表，FPS 需插件才能取到**，无法用本项目的脚本化方式采集。且启动 GUI 程序属高影响动作，未擅自执行。测量协议见下 |
| **Autodesk Viewer** | **不可验证** | 云端服务，需要把模型上传到 Autodesk 服务器 —— 与本项目「模型数据不出本机、不依赖 Autodesk APS」的硬约束直接冲突，**不做** |

**Navisworks 手工测量协议（供你按需自行执行，5 分钟）**

1. 打开 Navisworks Manage 2024 → 新建 → 用 `追加` 导入 `data/source/QICHUANG-SITE-RVM-2026-08-26.rvm`（Navisworks 直接支持 RVM），不附加任何属性文件。
2. 计时：从按下列出的"追加"到模型可交互，用手机秒表或录屏掐；记录 **RVM 导入耗时**（这是与 `模型加载 356 ms` 可比的量）。
3. 视角：`热点 → 全览`（等价于本项目的 fit），记录 **全览下 FPS**（Navisworks 状态栏右下角有 FPS 显示；若无则开启 `选项 → 界面 → 显示性能`）。
4. 用鼠标中键持续环绕 3 秒，看状态栏 FPS 的最低值，记录 **拖动 FPS**（与本项目 S6 的 47 FPS 可比）。
5. 记录 **Navisworks 进程内存**：任务管理器 → 详细信息 → `Roamer.exe` 的工作集（**注意这是进程总内存，与本项目 56.5 MB 的 JS 堆不是同一口径，只能定性对比**）。
6. 把上面 4 个数填回本节表格即可。

---

## 7. 复现

```bash
python tools/serve.py --port 8765 --no-browser        # 或双击 start.bat
NODE_PATH=C:/Users/34084/.workbuddy/binaries/node/workspace/node_modules \
  node scratch/phase6-benchmark.js 3                  # 参数=轮数
# 原始数据 → reports/evidence/phase6-benchmark.json
# 截图     → reports/phase6-viewer.png
```

前置产物（任一缺失请先跑对应 converter）：`data/processed/{model.glb, metadata.json, mapping.json, rvm-node-index.json}`

---

## 8. 关于「优化后的 Viewer」这条基线

Phase 7 若要优化，**应当对照本文件的 S1/S3 两行**（52 FPS / 5,796 calls 与 45 FPS），而不是对照 xeokit 的 180。判断标准建议设为：

- 全模型视野、无选中、空闲：**≥ 50 FPS**（当前 52，已达标）
- 全模型视野、持续拖动：**≥ 40 FPS**（当前 45–47，已达标）
- 选中并预览（描边开）静止：**≥ 25 FPS**（当前 25，刚好在线上——这是最值得优化的点）

也就是说：**当前方案已经没有功能性瓶颈，剩下的唯一可优化项是描边的成本**。是否值得动，取决于将来模型的规模——本模型 5,796 次 draw call 已经能跑，如果将来合并多个 RVM 到园区级，才需要认真考虑几何合并 / instancing / XKT。
