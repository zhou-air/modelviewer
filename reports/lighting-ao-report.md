# 第一、二阶段光影增强

2026-09-21。已实现基础 PBR 光照、屏幕空间 AO，以及原外观面板内的四项持久化设置。

## 修改文件

| 文件 | 改动 |
|---|---|
| `viewer/js/lightingController.js`（新增） | HemisphereLight + 相机朝向附近的 DirectionalLight，光照开关与强度 |
| `viewer/js/normalDepthPass.js`（新增） | 从 Edge Lines 提取共享 Normal / Linear Depth 预处理；统一资源、尺寸和状态恢复 |
| `viewer/js/ambientOcclusionPass.js`（新增） | 半分辨率 AO、深度/法线加权合成、高亮保护 |
| `viewer/js/edgeLinesPass.js` | 只做边缘合成，直接读取共享纹理 |
| `viewer/js/viewer3d.js` | 控制器与 Pass 接线、哑光参数、相机更新、Resize、模型尺度适配 |
| `viewer/js/appearance.js` | 四项默认值、数值约束和现有 localStorage 存取 |
| `viewer/app.js` | 面板事件、回显、诊断接口 |
| `viewer/index.html` | 小型“光影”分组；小窗口面板可滚动 |
| `scratch/lighting-verify.js`、`scratch/lighting-benchmark.js`、`scratch/lighting-orientation-verify.js`（新增） | 功能、GPU 缓冲、性能和方向控件验证 |
| `scratch/appearance-verify.js` | 修正旧测试的 400 ms 固定等待：统计每 500 ms 更新，改为等待真实状态 |

BatchRenderingManager 未修改。没有新增逐对象材质或逐对象 Mesh；indexed geometry、canonicalId、faceIndex 映射、模型树和属性数据继续走原路径。

## 光照与颜色

原实现已经使用共享 MeshStandardMaterial，不需要转换整棵模型树。普通模型、Batch solid、原有按颜色缓存的 override 材质 roughness 从 0.62 调为 0.82，metalness 仍为 0。选中、Hover 和 Ghost 的共享材质保留。

环境半球光强度 1.8，主方向光强度 2.1，乘以用户光照强度。主光沿相机局部方向 `(-0.45, 0.65, 1)` 布置，每帧仅更新光源和 target 的位置，兼容 Orbit / Game。关闭增强时保留中性基础照明，避免 PBR 模型全黑。灯光为 scene 子级，不进入模型 root 或模型 BoundingBox。

仍保留 ACESFilmicToneMapping / exposure 0.92 和既有 OutputPass。颜色链仍是 Selection / Hover → Object Override → Global → Default；光照不改这些颜色数据。

## AO 选型与共享

调查了 Three.js r160 的官方实现：

- [SSAOPass](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/postprocessing/SSAOPass.js)：自带 Normal/Depth 场景渲染和 AO/模糊目标，直接接入会重复预处理。
- [SAOPass](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/postprocessing/SAOPass.js)：自带 Normal/Depth 渲染，支持两趟模糊；同样需要适配当前缓冲约定。
- [GTAOPass](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/postprocessing/GTAOPass.js)：有外部 G-buffer 接口和去噪管线，但现有打包线性深度及交互保护仍需适配。

本次选择独立、轻量的屏幕空间 AO（SAO 风格的邻域位置/法线积分），不是直接移植官方 GTAO。固定 16 点螺旋采样，半宽×半高 AO 目标，深度/法线加权四点上采样；无时域历史、无随机帧噪声、无动态分辨率系统。半径按模型包围盒对角线的 0.006 设置，限制在 0.08–2 米；远处小结构的效果会自然减弱。

**已成功共享**：单个 RGBA HalfFloat 目标，RGB = 视图法线，`abs(A)` = 线性深度 / far。负 A 标记 Selection / Hover / Ghost 等受保护表面；AO 在这些像素保留原颜色，Edge 按绝对深度继续工作。选中描边在 AO / Edge 后执行。透明 Ghost 不贡献 AO 遮挡。FloorPlan、测量组和登记的线对象不进入法线预处理。

管线：`Render → [共享 NormalDepth] → [AO] → [Edge] → Outline → Output`。

- AO 和 Edge 同开：共享预处理只执行一次；GPU 渲染次数测试确认。
- AO 关、Edge 开：只保留 Edge 所需的预处理和边缘合成。
- 两者都关：预处理和 AO 全部跳过。
- 在已有 Edge 的基础上开启 AO：只增加 2 个全屏 draw call。
- RenderTarget 和 Material 常驻，不逐帧新建；只处理登记的辅助对象，不新增每帧全模型树扫描。
- Resize 统一由 Composer 传入实际像素尺寸；DPR 1.5 下验证主目标和共享目标一致，AO 为半尺寸。

默认 `lightingEnabled=true`、`lightingIntensity=1`、`aoEnabled=true`、`aoIntensity=0.65`。AO 强度范围 0–1.5；最终线性颜色衰减上限 45%，默认更轻。强度为 0 时跳过 AO。四项写入既有 `pdms-model-viewer-appearance-v1`，跨 Project / Model / Version 保留，恢复默认外观同时重置。

## 性能实测

RTX 4060 Laptop GPU，Chromium WebGL2 / ANGLE D3D11；浏览器 1440×900，3D 绘制区 1124×856，DPR 1。Orbit 全模型视角，无选中，FloorPlan 保持原默认。每个状态预热 2 秒，随后 16 次采样取中位数。最终性能测试未与本次其他浏览器回归同时运行；桌面其他负载、刷新率上限和时钟变化仍会影响 FPS。

| 模型 | 状态 | FPS | 帧时间 ms | GPU ms | 主场景 calls | 全部 passes calls |
|---|---|---:|---:|---:|---:|---:|
| site | 改动前，Edge OFF | 165 | 6.10 | 2.59 | 398 | 399 |
| site | AO OFF / Edge OFF | 165 | 6.10 | 2.57 | 398 | 399 |
| site | AO ON / Edge OFF | 133 | 7.40 | 5.50 | 398 | 506 |
| site | AO OFF / Edge ON | 133 | 7.20 | 5.25 | 398 | 505 |
| site | AO ON / Edge ON | 135 | 7.80 | 5.83 | 398 | 507 |
| hygq | 改动前，Edge OFF | 146 | 7.20 | 2.01 | 321 | 322 |
| hygq | AO OFF / Edge OFF | 139 | 7.10 | 1.99 | 321 | 322 |
| hygq | AO ON / Edge OFF | 71 | 14.80 | 9.59 | 321 | 641 |
| hygq | AO OFF / Edge ON | 71 | 13.40 | 9.49 | 321 | 640 |
| hygq | AO ON / Edge ON | 71 | 15.50 | 10.18 | 321 | 642 |

AO OFF 的主场景与总绘制次数和改动前相同，GPU 时间接近基线。AO 单独开启的 GPU 增量分别约 2.93 / 7.60 ms，重模型主要花费在必要的法线/深度场景渲染；不能把半分辨率 AO 误认为整个预处理也降为半分辨率。已有 Edge 时再开启 AO 的 GPU 增量仅约 0.58 / 0.69 ms，证明没有重复渲染场景。hygq 的 AO 开销显著，低性能设备可以关闭 AO；Batch 优势仍保留，主场景 calls 不变。

原始记录：`evidence/lighting-baseline.json`、`evidence/lighting-benchmark.json`。

## 验证结果

- 新增光影检查 8/8：默认材质、共享预处理、AO 非空且克制、高亮缓冲保护、相机跟随和包围盒、Resize/DPR、跨模型及刷新保存、恢复默认及异常值。
- GPU 缓冲读取：全模型 AO 半分辨率目标有 3,648 个像素显著低于白色，最小值 215/255；隔离测试对象时选中和 Hover 各有 16,029 个受保护像素。隔离用于确保受测元件实际可见，避免被其他结构遮挡。
- 颜色/地板回归 12/12：对象颜色、全局色、取消选中、Hide/Show、Ghost 恢复、非 Batch 回退路径、用户级与模型级状态边界。
- 交互回归 15/15：Selection、多选、Hide/Isolate/Show、模型树、属性面板、Edge 联动。
- 外观回归 31/31：AO 默认开启时验证 Edge、Ghost、拾取、透明度、面板和重载资源计数。最初一项统计等待测试读到旧值，修正等待条件后全部通过。
- 测量回归 64/64：Game/Orbit 导航、真实表面取点、Batch canonical 命中、世界坐标、XYZ、撤销、辅助显示和切换模型。
- Orientation Gizmo：相机同步、六向视图与命中区域通过；不进入主后处理场景。
- 最终运行未记录页面或 WebGL shader 错误。AO + Edge 组合截图为 `evidence/lighting-ao-edge.png`。

## 边界与后续优化

未实现 Shadow Map、Contact Shadow、HDRI 或天空盒。AO 是屏幕空间近似，屏幕外/被完全遮挡的结构不会提供遮蔽，不能作为工程间隙或碰撞判定依据。很细的缝隙和透明物体附近宁可减弱效果，避免大片暗斑。

Depth/Normal 共享已经完成。若后续需要更低开销，可调查只开 AO 时降低共享预处理分辨率，或在真正静止且场景状态未变时复用上一帧缓冲；本版不引入这些额外失效条件和缓存复杂度。
