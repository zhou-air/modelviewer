# Rendering Optimization Audit

- 生成时间：2026-09-20T10:21:55+08:00
- 范围：`data/projects/**/processed/model.glb`；`ready` 版本进入运行基线，非 ready 但存在的 GLB 单独列出。
- 扫描方式：直接解析 GLB 2.0 JSON/BIN 结构，并对照 Viewer 的 Three.js 渲染路径。

## 口径先说明

- **当前基线 draw call**：GLB 中被节点引用的可渲染 primitive instance 数量，等价于当前无后处理、无视锥剔除时的场景绘制单位；与 `renderer.info.render.calls` 的全模型基线核对。
- **理论最低 draw call**：允许把变换烘焙进顶点、牺牲独立对象级拾取/显隐语义，按 primitive mode + 当前 Viewer 有效材质 + 顶点属性布局全局合批的下界。它是上限估算，不是无需改架构即可获得的结果。
- **可实例化比例**：只把完全相同的 glTF mesh/primitive 几何（相同 accessor 引用）计入；`participatingShare` 表示参与重复组的实例占比，`reducibleDrawShare` 表示理论上可减少的 draw call 占比。
- **可合批比例**：同一 primitive mode、材质角色和属性布局即可合并；变换可烘焙，但合并后对象级选择/隔离必须另做 ID/索引方案。

## 结论摘要

- `data/projects/propionic-acid/models/main-site/versions/2026-09-03/processed/model.glb`：当前基线 **5,796** calls，Viewer 全局合批理论下界 **2**，精确重复几何可实例化参与比例 **0.00%**，有效状态可合批比例 **100.00%**。
- `data/projects/qichuang/models/hygq/versions/2026-09-20/processed/model.glb`：当前基线 **16,255** calls，Viewer 全局合批理论下界 **1**，精确重复几何可实例化参与比例 **0.00%**，有效状态可合批比例 **100.00%**。
- `data/projects/qichuang/models/site/versions/2026-09-19/processed/model.glb`：当前基线 **5,796** calls，Viewer 全局合批理论下界 **2**，精确重复几何可实例化参与比例 **0.00%**，有效状态可合批比例 **100.00%**。

## GLB 扫描结果

| GLB | 状态 | 文件 | 当前场景 calls | Mesh | Line | 三角形 | Viewer 合批下界 | 可合批参与比例 | 精确重复几何参与比例 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `data/projects/propionic-acid/models/111/versions/2026-09-20/processed/model.glb` | failed | 106,365,828 B | 23,738 | 23,603 | 135 | 2,110,412 | 2 | 100.00% | 0.00% |
| `data/projects/propionic-acid/models/main-site/versions/2026-09-03/processed/model.glb` | ready | 18,385,964 B | 5,796 | 5,507 | 289 | 335,824 | 2 | 100.00% | 0.00% |
| `data/projects/qichuang/models/hygq/versions/2026-09-20/processed/model.glb` | ready | 36,058,420 B | 16,255 | 16,255 | 0 | 501,323 | 1 | 100.00% | 0.00% |
| `data/projects/qichuang/models/site/versions/2026-09-19/processed/model.glb` | ready | 18,385,952 B | 5,796 | 5,507 | 289 | 335,824 | 2 | 100.00% | 0.00% |

## 理论最低 draw call

对当前 Viewer 的有效渲染状态，Mesh 在加载时统一替换为一个共享 `MeshStandardMaterial`，Line 统一替换为一个共享 `LineBasicMaterial`。因此：

- 三角形和线是不同 WebGL primitive mode，不能在同一个普通 draw call 中混合；
- 当前模型若保留所有线，理论底线通常是 **1 个三角形批次 + 1 个线批次 = 2 calls**；无 Line 的模型底线为 **1 call**；
- `viewerGlobalBatchFloor` 是更严格的属性布局下界，若出现多个布局，不能直接压成一个批次。
- 这个下界不包含描边/轮廓线/输出后处理；它只描述主场景 RenderPass。

## 实例化审计

| GLB | 重复 mesh 引用组 | 重复 mesh 参与比例 | 可减少 calls 比例 | 精确重复 primitive 组 | 精确重复 primitive 参与比例 | 可减少 calls 比例 |
|---|---:|---:|---:|---:|---:|---:|
| `data/projects/propionic-acid/models/111/versions/2026-09-20/processed/model.glb` | 0 | 0.00% | 0.00% | 0 | 0.00% | 0.00% |
| `data/projects/propionic-acid/models/main-site/versions/2026-09-03/processed/model.glb` | 0 | 0.00% | 0.00% | 0 | 0.00% | 0.00% |
| `data/projects/qichuang/models/hygq/versions/2026-09-20/processed/model.glb` | 0 | 0.00% | 0.00% | 0 | 0.00% | 0.00% |
| `data/projects/qichuang/models/site/versions/2026-09-19/processed/model.glb` | 0 | 0.00% | 0.00% | 0 | 0.00% | 0.00% |

判定：当前 GLB 如果绝大多数 primitive 都是一次性几何，InstancedMesh 不是主要收益点；即使重复比例为 0，仍可通过合批减少 calls，但那是另一条路径。

## 合批审计

| GLB | 原始 GLTF 状态组数 | 原始状态可合批参与比例 | Viewer 有效状态组数 | Viewer 有效状态可合批参与比例 | 理论可减少 calls 比例 |
|---|---:|---:|---:|---:|---:|
| `data/projects/propionic-acid/models/111/versions/2026-09-20/processed/model.glb` | 2 | 100.00% | 2 | 100.00% | 99.99% |
| `data/projects/propionic-acid/models/main-site/versions/2026-09-03/processed/model.glb` | 2 | 100.00% | 2 | 100.00% | 99.97% |
| `data/projects/qichuang/models/hygq/versions/2026-09-20/processed/model.glb` | 1 | 100.00% | 1 | 100.00% | 99.99% |
| `data/projects/qichuang/models/site/versions/2026-09-19/processed/model.glb` | 2 | 100.00% | 2 | 100.00% | 99.97% |

这里的合批比例是**状态兼容上限**，不能直接等同于可无损上线的优化比例。当前 Viewer 依赖每个对象作为独立 Three.js 对象来实现射线拾取、树联动、隐藏/隔离和 OutlinePass 选中；全局合批会破坏这些语义，除非增加对象 ID buffer、批次到对象的反向索引和批内选择逻辑。

## 描边和轮廓线的实际渲染路径

### 基础每帧路径

`EffectComposer` 当前顺序是：

`RenderPass(scene)` → `EdgeLinesPass`（仅 contours 开启）→ `OutlinePass`（仅 selected 且静止超过 160 ms）→ `OutputPass`。

基础无选中、无轮廓线时：

1. `RenderPass`：完整场景一次，产生主要 scene draw calls。
2. `OutputPass`：一个全屏四边形，把中间渲染目标输出到屏幕，并执行 ACES tone mapping / 色彩空间转换。

### 元件轮廓线 `EdgeLinesPass`

开启 `contours` 后，每帧增加：

1. 暂时隐藏所有 Line；
2. 用 `overrideMaterial = normalMaterial` 把整个场景再渲染一次到法线/线性深度 RT；
3. 用一个全屏四边形做 4 邻域法线差/深度差检测并合成。

因此它约等于 **+1 次完整场景渲染 +1 个全屏 pass**，不是简单的线框 draw call。

### 选中描边 `OutlinePass`

选中且停止交互超过 160 ms 后，Three.js `OutlinePass` 实际执行：

1. 非选中对象一次 depth pass；
2. 选中对象一次 mask pass；
3. 下采样；
4. 半分辨率边缘检测；
5. 半分辨率水平/垂直模糊；
6. 四分之一分辨率水平/垂直模糊；
7. overlay 合成。

在当前 Composer 中，OutlinePass 会增加 **2 次场景级 render traversal**，以及约 **7 个全屏四边形 pass**；后面还有常驻的 `OutputPass`。由于第一次只绘制非选中对象、第二次主要绘制选中对象，实际 draw call 增量取决于选中对象数量。

项目已用拖动期暂停 OutlinePass 的策略规避这条路径的实时成本：`outline.enabled = selected && idle > 160 ms`。

## 优化优先级

1. **第一优先级：批次化但保留对象语义**。优先考虑按空间块/层级/对象组做中等粒度合批，并配套对象 ID 映射；不要一开始把整个模型压成一个不可拾取的大 Mesh。
2. **第二优先级：替换 OutlinePass**。当前选中描边是最明确的额外整场景路径；可评估屏幕空间 ID/深度描边，或只对选中对象生成局部 mask。
3. **第三优先级：对重复 primitive 做 InstancedMesh**。只有本报告中精确重复比例显著时才值得优先实施。
4. **第四优先级：大型模型再考虑分块/LOD**。它解决的是可见对象规模和内存峰值，不是当前小模型的首要 draw-call 问题。

## 证据与限制

- 本审计是静态 GLB 结构审计，不替代浏览器 GPU 实测；视锥剔除后的实际 calls 仍取决于相机位置。
- 合批数字没有把选择、高亮、隐藏、隔离、拾取和 OutlinePass 语义自动修复，因此明确标作理论上限。
- GLB 中如果同一 mesh 被多个 node 引用，计入精确实例化候选；如果只是顶点数据“看起来相同”但 accessor 不同，不冒充零成本实例化。
- 运行基线使用 `ready` 版本；非 ready 但已有 GLB 的文件保留在表中，避免把失败导入产物当作正常版本。

## 原始证据

- 机器可读扫描：`reports/evidence/rendering-audit.json`
- 渲染器实现：`viewer/js/viewer3d.js`、`viewer/js/edgeLinesPass.js`
- 后处理实现：`viewer/vendor/jsm/postprocessing/OutlinePass.js`、`EffectComposer.js`
