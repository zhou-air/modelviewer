# Batch Rendering 正式集成报告

## 结论

indexed 中粒度空间 Batching 已纳入 Viewer 默认渲染路径，未修改 RVM→GLB 转换链。原始 GLB 层级、
canonicalId、metadata、树和原 Mesh 索引均保留；实际 Mesh 绘制由 Batch 承担。Selection/Highlight、Hide、
Isolate、Ghost、树与模型双向联动已恢复并通过回归。

## 工程实现

- 保留 indexed geometry；Batch geometry 全部存在 index，index count = triangles × 3。
- 保持已验证粒度：先空间分桶，每个逻辑 Batch 最多 64 个 Mesh。
- 每个源 Mesh 保留 `canonicalId / sourceMeshUuid / triangle range / face range`。
- Raycaster 命中合批 Mesh 后，用 `faceIndex` 二分反查 canonicalId；Ghost range 主动跳过，保持不可拾取语义。
- 每个空间 Batch 按 `solid / selected / hover / ghost` 状态最多分成少量 Render Mesh。
- 单选、单对象隐藏或 Ghost 通常只重建 1 个 Batch，实测约 2–4 ms；Isolate/Show All 才会触发全量状态同步。
- Outline 改为使用 selected Batch Mesh；Contours 继续按原开关和 pass 执行，本轮未优化二者。

## 基准结果

环境：RTX 4060 Laptop GPU，WebGL 2 / ANGLE D3D11，1444×896，Pixel Ratio 1，Outline/Contours 关。

| 模型 | 模式 | FPS | Frame Time | CPU Frame | GPU Frame | Draw Calls | Triangles |
|---|---|---:|---:|---:|---:|---:|---:|
| site | 原始 | 40 | 25.7 ms | 22.2 ms | 16.88 ms | 5,796 | 335,824 |
| site | indexed Batch | **165** | **6.0 ms** | **3.6 ms** | **2.54 ms** | **394** | 335,824 |
| hygq | 原始 | 13 | 78.9 ms | 75.0 ms | 54.03 ms | 16,255 | 501,323 |
| hygq | indexed Batch | **155** | **6.4 ms** | **6.3 ms** | **1.27 ms** | **317** | 501,323 |

site 的 394 calls = 105 个 Mesh Batch + 保留的 289 个 Line。hygq 无 Line，为 317 个 Mesh Batch。

## 内存与构建代价

| 模型 | 原始 JS Heap | Batch JS Heap | 增量 | 原始 GPU geometry 对象 | 冷启 Batch geometry 对象 | 重建 Batch |
|---|---:|---:|---:|---:|---:|---:|
| site | 57.1 MB | 63.5 MB | +6.4 MB | 5,797 | **395** | 100.9 ms |
| hygq | 132.7 MB | 135.7 MB | +3.0 MB | 16,256 | **318** | 237.4 ms |

GPU geometry 对象数使用冷启默认 Batch 路径采集：原 Mesh 保留在 JS 层级中，但不会先被上传到 GPU。
JS Heap 增量包含空间索引、range 表和合并后的 CPU 缓冲。WebGL 不提供可靠的字节级显存读取，
因此不把 geometry 对象数冒充为显存 MB。

## 功能回归

### 集成专项：14/14 PASS

- 两个模型的 index 完整性、三角形守恒、画面回归；
- 树→模型 Selection/高亮/Outline；
- Hide / Show All；
- Isolate / Show All；
- Ghost 分批、材质和不可拾取语义；
- 真实画布鼠标点击→canonicalId→metadata/属性→树反向定位。

### 原有回归

- `appearance-regression.js`：15/15 PASS。
- `appearance-verify.js`：31/31 PASS，page errors = 0。
- 同版本重载后 GPU geometry 对象数保持 395，未逐次增长。

## 视觉回归

| 模型 | RMSE | 差异 > 8 的像素 |
|---|---:|---:|
| site | 0.16 | 0.02% |
| hygq | 0.29 | 0.05% |

差异仅位于抗锯齿边缘，未见几何缺失、变形或材质改变。

## 本轮边界

未实施 LOD、Streaming 或 WebGPU；未对 Outline/Contours 做额外性能优化。当大量对象同时分属
selected/hover/ghost 多种状态时，同一空间 Batch 可产生多个 Render Mesh，Draw Calls 会相应高于纯 solid 基线；
这是为保留既有交互与视觉语义的有意中粒度取舍。

原始证据：`reports/evidence/batch-integration-regression.json`、`reports/evidence/appearance-regression.json`、
`reports/evidence/appearance-verify.json`。indexed range 清单：`reports/evidence/indexed-batch-site-ranges.json` 与
`reports/evidence/indexed-batch-hygq-ranges.json`。
