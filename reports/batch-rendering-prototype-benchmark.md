# Batch Rendering Prototype Benchmark

- 日期：2026-09-20
- 环境：RTX 4060 Laptop GPU，WebGL 2 / ANGLE D3D11
- 绘制缓冲：1444×896，Pixel Ratio 1.0
- 测试状态：Outline=关，Contours=关
- 粒度：先按空间分桶，再限制每个 Render Batch 最多 64 个原 Mesh

## 结论

Prototype 验证通过。在不修改 RVM→GLB 转换链、不改变三角形数量的情况下：

- 5,796 calls 模型降至 **394 calls**，FPS 从 50 提高到 165。
- 16,255 calls 模型降至 **317 calls**，FPS 从 16 提高到 144。
- CPU Frame Time 分别降低 83.3% 和 88.6%；GPU Frame Time 分别降低 81.8% 和 97.3%。

结果进一步确认：原 Viewer 的主要瓶颈是大量小 Mesh 导致的 Draw Call 提交与驱动/GPU 命令处理，而非三角形数量本身。

## 性能对比

| 模型 | 模式 | FPS | Frame Time | CPU Frame | GPU Frame | Draw Calls | Triangles | Mesh / Line |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 5,796 calls | 原始 | 50 | 19.0 ms | 19.8 ms | 13.33 ms | 5,796 | 335,824 | 5,507 / 289 |
| 5,796 calls | Batch | 165 | 6.0 ms | 3.3 ms | 2.42 ms | **394** | 335,824 | 105 / 289 |
| 16,255 calls | 原始 | 16 | 62.3 ms | 60.6 ms | 40.13 ms | 16,255 | 501,323 | 16,255 / 0 |
| 16,255 calls | Batch | 144 | 7.1 ms | 6.9 ms | 1.07 ms | **317** | 501,323 | 317 / 0 |

5,796 calls 模型中的 289 个 Line 按要求保持原样，未参与 Mesh Geometry Batching，因此最终 calls = 105 Mesh Batch + 289 Line。

## 构建和映射

| 模型 | 原 Mesh | Batch | 记录的 canonicalId | Range 记录 | 建批耗时 |
|---|---:|---:|---:|---:|---:|
| site | 5,507 | 105 | 5,507 | 5,507 | 122.2 ms |
| hygq | 16,255 | 317 | 16,255 | 16,255 | 284.8 ms |

原始 GLB 层级、`nodeByCanonical`、`meshByCanonical` 和 metadata 映射保留不动。每个 Batch 携带有序 range 表，每条包含：

- `canonicalId`
- `sourceMeshUuid`
- `triangleStart / triangleEnd`
- `faceStart / faceEnd`
- `batchIndex / spatialCell`

同一 canonicalId 若对应多个几何块，在 manifest 的 `objects[canonicalId]` 下保留多条 range，不做丢失性合并。

## 拾取验证

Raycaster 命中 Batch 后，用 `faceIndex` 在有序 range 中二分反查 canonicalId：

| 模型 | Range 首/尾边界检查 | 失败 | 实际射线命中 | 无效 canonical | 真实点击选中 |
|---|---:|---:|---:|---:|---|
| site | 11,014 | 0 | 12 | 0 | PASS |
| hygq | 32,510 | 0 | 17 | 0 | PASS |

真实鼠标点击分别正确返回 `FLOOR 1 of FRMWORK /W-SHOP-1-FLOOR` 与 `FLOOR 1 of FRMWORK /floor`，并能继续使用原 metadata/属性面板映射。

## 视觉一致性

在同一相机、材质、分辨率下对原始/Batched 截图做逐像素对比：

| 模型 | RMSE | 单通道差异 > 8 的像素 | 最大通道差异 | 人工检查 |
|---|---:|---:|---:|---|
| site | 0.16 | 0.02% | 24 / 255 | 未见几何缺失或变形 |
| hygq | 0.29 | 0.05% | 29 / 255 | 未见几何缺失或变形 |

微小差异集中在抗锯齿边缘，来自绘制顺序改变；三角形总数与相机均未变。

## 实验边界

这是显式启用的独立 Prototype，默认 Viewer 仍走原渲染路径。当前不将以下能力声明为已完成：

- Hide / Isolate / Ghost 的局部 Batch 可见性管理；
- 选中对象在 Batch 内的独立材质高亮；
- Outline / Contours 适配或优化；
- LOD、Streaming、WebGPU；
- Batch 内存峰值和长时间反复切换压力测试。

原型将几何转为 non-indexed 后合并，因此会增加顶点缓冲内存；这是下一阶段工程化时应优先改为保留 index 的地方，不影响本轮“Draw Call 可否降到数百级”的验证结论。

## 产物

- 原始数据：`reports/evidence/batch-rendering-benchmark.json`
- site 映射：`reports/evidence/batch-site-ranges.json`
- hygq 映射：`reports/evidence/batch-hygq-ranges.json`
- 基准/原型截图：`reports/evidence/batch-*-baseline.png` / `batch-*-prototype.png`
- 复跑脚本：`scratch/batch-rendering-benchmark.js`
