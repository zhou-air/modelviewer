# Three.js Viewer 性能诊断 Benchmark

- 测试日期：2026-09-20
- GPU：NVIDIA GeForce RTX 4060 Laptop GPU（ANGLE / D3D11）
- WebGL：WebGL 2.0；`EXT_disjoint_timer_query_webgl2` 可用
- 绘制缓冲：1444×896，Pixel Ratio 1.0
- 口径：无头 Chromium，每场景稳定后采样 4 s，取中位数
- 基础渲染对比均保持 Outline=关、Contours=关；未修改现有渲染架构

## 实测结果

| 模型 / 场景 | FPS | Frame Time | CPU Frame | GPU Frame | Scene Calls | 三角形 | 可见 Mesh / Line |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5,796 calls・全模型 | 38 | 25.0 ms | 25.6 ms | 18.36 ms | 5,796 | 335,824 | 5,507 / 289 |
| 5,796 calls・缩放到局部 | 165 | 6.0 ms | 4.9 ms | 1.06 ms | 47 | 5,154 | 46 / 1 |
| 5,796 calls・隔离单对象 | 165 | 6.1 ms | 2.2 ms | 0.73 ms | 2 | 339 | 2 / 0 |
| 16,255 calls・全模型 | 14 | 77.2 ms | 74.7 ms | 50.41 ms | 16,255 | 501,323 | 16,255 / 0 |
| 16,255 calls・缩放到局部 | 73 | 13.5 ms | 13.2 ms | 0.91 ms | 65 | 2,699 | 65 / 0 |
| 16,255 calls・隔离单对象 | 165 | 6.0 ms | 4.5 ms | 0.77 ms | 1 | 12 | 1 / 0 |

> 165 FPS 是无头测试环境的 rAF 上限附近，只表示帧预算充足，不代表开窗后会超过显示器刷新率。

## 瓶颈判断

**结论：当前大场景主要受 CPU / Draw Call submission 链路限制，不是 RTX 4060 的三角形或像素着色能力不足。**

1. calls 从 5,796 增至 16,255（约 2.80倍）时，CPU Frame 从 25.6 ms 增至 74.7 ms（约 2.92倍），FPS 从 38 降至 14。CPU 时间基本按 draw call 数线性增长。
2. 16,255 calls 全模型下 CPU 74.7 ms，高于 GPU 50.41 ms，CPU 每帧多出约 24.3 ms；帧率更接近 CPU 预算。这是 CPU 构建、校验并提交大量小绘制命令的典型特征。
3. 缩放后三角形并非单调决定速度：16,255-calls 模型局部仅剩 65 calls 时，GPU 降到 0.91 ms；隔离后为 0.77 ms。这说明 RTX 4060 处理当前可见几何很轻松。
4. 全模型的 GPU Timer 也会随 calls 上升，因为 GPU/驱动仍要处理 16,255 个小批次；这不等于 shader/compute 已跑满。仅凭 WebGL Timer Query 不能直接给出 GPU utilization 百分比，但当前数据与“GPU 利用不充分、由 CPU 喂命令速度限制”一致。若需确认占用率，应同步采集 NVIDIA/Windows GPU Engine 遥测，不应从 GPU ms 反推百分比。

## 功能与边界

页面右上角诊断面板现已显示 FPS / Frame Time、CPU/GPU Frame Time、场景与全帧 Draw Calls、Triangles、实际可见 Mesh/Line、GPU Renderer / WebGL、绘制分辨率 / Pixel Ratio，以及 Outline / Contours 状态。GPU Timer Query 不可用、未就绪或 disjoint 时显示 `N/A`/状态，不用 CPU 时间代替。

本轮未优化 Outline，未实施 Batching、LOD 或 WebGPU 重构。原始数据见 `reports/evidence/performance-diagnostics-benchmark.json`，可用 `scratch/performance-benchmark.js` 复跑。
