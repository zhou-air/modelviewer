# 外观选项 — 元件轮廓线 & 隐藏件半透明

- 状态：**已完成**，功能实测 31/31、既有交互回归 15/15 项通过，0 页面异常
- 日期：2026-09-20
- 范围：只改 Viewer 的渲染与 UI 开关。**未动**转换链 / 校验闸门 / 资产层 / 权限体系 / 导航算法。
- 需求：模型外观可选优化项，**需要开关，默认关**；① 元件轮廓线 ② 隐藏的元件以半透明方式展现，透明度可调。

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 开关位置 | 工具条新增「外观」按钮 → 右下角面板（与「导航设置」互斥，不会重叠） |
| 默认状态 | ✅ 两项均关闭；关闭时**不产生任何额外渲染开销**（轮廓线 pass 被 EffectComposer 直接跳过） |
| ① 元件轮廓线 | ✅ 屏幕空间边缘检测，元件分界清楚且背景无噪点；差异图证明描边只落在元件边界上 |
| ② 隐藏件半透明 | ✅ 隐藏/隔离掉的对象保留在画面里、以 ghost 半透明显示；滑块 5%–95% 实时生效 |
| 语义不被外观破坏 | ✅ ghost 对象**不可拾取、不参与描边、不计入可见对象数**，`hidden` 计数不变；关掉开关立刻回到真隐藏 |
| 状态保留 | ✅ 页面会话内跨版本保留；刷新页面回到默认关 |
| 既有交互 | ✅ 树/搜索联动、隐藏、隔离、显示全部、Ctrl 多选、面板开关、复位视角全部回归通过 |
| 资源 | ✅ 切换模型前后：BufferGeometry 5,797 恒定、纹理不增长、命名节点 7,423 恒定 |

**过程中修掉一个我自己引入的回归**（必须记下来，因为它不会自己暴露）：改造 `load()` 时误删了"给全部 mesh 统一赋灰色材质"那一趟遍历。材质同步 `_applyHighlight()` 按 canonical 遍历 `meshByCanonical`，**只覆盖有名字的节点**，无名 holder 下的几何会一直顶着 glTF 原生材质（`metallic=1 / roughness=1`）渲染成黑色 —— 表现是"模型整体变黑"，很容易被误判成轮廓线画错了。见 §5。

---

## 2. ① 元件轮廓线

### 2.1 为什么不是 EdgesGeometry / 线框

本模型 5,507 个 mesh、33.6 万三角形（另有 289 条 Line）。逐 mesh 生成边线几何要先合并重复顶点（RVM 导出的三角形多数不共享顶点，不合并就退化成"全三角网格线框"），代价是数量级更大的顶点缓冲 + 同样多的额外 draw call。而工程审图要的是**外观轮廓**，不是三角网格线框。

屏幕空间方案把开销固定成「1 次离屏场景渲染 + 1 次全屏 pass」，与几何复杂度无关（离屏那趟与主渲染同量级）。

### 2.2 为什么要法线 + 深度两路

| 只看一路的失效场景 | 两路取或的结果 |
|---|---|
| 只看法线：一排同朝向的元件前后遮挡，遮挡处法线相同 → 分不出边界 | ✅ 深度跳变检出 |
| 只看深度：两个贴合/相邻的元件，屏幕像素深度连续 → 分不出边界 | ✅ 法线跳变检出 |

实现（`viewer/js/edgeLinesPass.js`）：

1. **趟一**：`scene.overrideMaterial = 自写法线材质`，离屏渲染到 HalfFloat 目标 —— RGB = 视图空间法线（`n*0.5+0.5`），A = 线性深度 / `camera.far`。
2. **趟二**：全屏 pass 读场景颜色 + 上一步的纹理，对 4 邻域做
   `maxN = max(1 - dot(nC, nN))`、`maxD = max(|dC - dN| / dC)`，
   分别 `smoothstep` 后取或，`mix` 回场景颜色。

### 2.3 两个必须记住的坑

**坑一：线几何没有法线属性，会把假边缘写进法线图。**
`overrideMaterial` 对 `LineSegments` 同样生效，而本模型的 289 条线（轴网/中心线）没有 NORMAL 属性（已核实：5796 个 primitive 中 5507 个带 NORMAL，缺的 289 个正好是线）。所以离屏那趟会**先把登记的线对象临时隐藏、渲染完立刻恢复**。实测证据：离屏趟的 draw call 数为 5,508 = 场景 5,795 − 287（线），差值正好是被摘掉的线。

**坑二：半精度浮点下深度差的可用阈值。**
深度以 `1/far` 归一化后写进 HalfFloat 的 alpha 通道，半精度相对分辨率约 `5e-4`，两像素差分噪声约 `1e-3`。所以深度阈值给 `0.0045`（约 4.5 倍噪声），并且深度只作为辅助 —— 主判据是法线。

### 2.4 效果取证

| 取证 | 结果 |
|---|---|
| 逐像素差异（开 vs 关） | 9.69% 像素变化，**变化精确落在元件边界线上**，模型内部与背景零变化 |
| `uStrength = 0`（只留合成） | 画面与关闭状态**逐像素一致**（暗像素占比同为 0.1%）→ 合成步骤本身不引入任何色偏 |
| 只留法线通道 | 4.3% 像素被描边 |
| 只留深度通道 | 2.1% 像素被描边 |

对照图：`reports/evidence/diag/01-on-default.png`（开启后效果）、`07-diff-off-vs-on.png`（差异放大图）。

---

## 3. ② 隐藏件半透明

### 3.1 做法

隐藏状态仍然只记在 `hiddenCanonicals` 里（与原实现同一份事实来源），渲染时按开关分两种落地：

| 开关 | `node.visible` | 材质 |
|---|---|---|
| 关 | 被隐藏的节点 = `false`（原行为） | 不变 |
| 开 | 全部 = `true`（否则根本不进渲染，ghost 无从谈起） | 被隐藏子树里的每个 mesh/line 换成 ghost 材质 |

ghost 材质：`MeshStandardMaterial({ color: 0x9aa6b2, transparent: true, opacity: <滑块值>, depthWrite: false })`。

`depthWrite: false` 是半透明的关键 —— 否则先绘制的 ghost 会把后面的 ghost 整块挡掉，"半透明互见"就消失了。线比面细，同样的不透明度下线会先"看不见"，所以线的不透明度乘 1.6 并夹在 0.95 以内。

### 3.2 语义边界（都被断言覆盖）

| 断言 | 结果 |
|---|---|
| 隐藏件仍被渲染（ghost 对象数 > 0） | ✅ |
| `hidden` 计数不变（隐藏语义没被外观选项改掉） | ✅ 1 → 1 |
| 可见对象数不变（ghost 不算可见） | ✅ 7,419 → 7,419 |
| 点击 ghost 对象不会选中它（射线正确穿透到后面的实体） | ✅ 点隐藏的地板 → 选中了它后面的墙 |
| ghost 不参与描边 | ✅ |
| 关掉开关 → ghost 归零、被隐藏件立刻消失且仍不可拾取 | ✅ |
| 越界值被夹到 [0.05, 0.95] | ✅ `-5 → 0.05`、`9 → 0.95` |
| 真实拖动滑块 → 材质与标签同步 | ✅ 拖到 70 → `opacity=0.7`、标签 "70%" |

---

## 4. 实测

三支脚本，全部可重复跑（后端在 8899 端口，`TRUST_LOOPBACK=1` 起）：

```bash
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-verify.js       # 31 项
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-regression.js   # 15 项
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-fps.js          # 帧率对比
```

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `appearance-verify.js` | 默认态 / 轮廓线开关 / ghost 渲染与拾取 / 透明度可调 / 关掉后的还原 / 面板互斥 / 跨版本保留 / 资源不泄漏 | **31/31**，0 页面异常 |
| `appearance-regression.js` | 树搜索→3D 联动、隐藏、显示全部、隔离、Ctrl 多选多隐藏、面板开关、复位视角（含开着轮廓线时重复关键路径） | **15/15** |
| `appearance-fps.js` | 交替开关各 4 轮取中位数 | 见 §4.2 |

原始数据：`reports/evidence/appearance-verify.json`、`appearance-regression.json`、`appearance-fps.json`。

### 4.1 绘制量（确定值，与渲染环境无关）

| 状态 | 全帧 draw calls |
|---|---|
| 轮廓线关 | 5,797 |
| 轮廓线开 | 11,305 |

差值 5,508 = 离屏那一趟的场景绘制量（5,795 主体 − 287 被摘掉的线）。**关掉后完全回到 5,797。**

### 4.2 帧率

`scratch/appearance-fps.js`：交替开关各 4 轮、每轮取 2 秒稳态 FPS 后取中位数。

| 状态 | 4 轮实测 | 中位数 | 比值 |
|---|---|---|---|
| 轮廓线关 | 45 / 43 / 43 / 45 | **45** | — |
| 轮廓线开 | 22 / 24 / 22 / 23 | **23** | 1.96 |
| 轮廓线开 + 相机持续移动 | 23×6 | 23 | — |

> ⚠️ headless 走 swiftshader（**软件光栅化**），瓶颈在 CPU 侧的光栅化而不是 GPU。
> 多渲染一遍场景在软件渲染下近似 2 倍代价；真机上 CPU draw call 才是主要成本，
> 相对差会明显小于上表。**绝对值不代表真机，只作定性参考**；确定值只有 §4.1 的绘制量。
> 参考对照：本项目既有的描边在拖动期暂停后是 61 FPS、空闲 30 FPS，属同一量级的取舍。

数据：`reports/evidence/appearance-fps.json`。

### 4.3 一个值得记录的统计口径变化

`visibleNamedCount()` 原实现数 `node.visible`，改后数"不落在隐藏子树里"的节点。差异只在**隐藏的是祖先节点**时出现：原口径会把"父被隐藏、自己 `visible` 仍是 `true`"的后代算成可见。

实测：把叶子元件 `/PG-10603` 隐藏，两者都是 7,419；但隐藏模型根节点 `/ENCOSC…-SITE` 时，新口径给出 **0**（确实一个都看不见），原口径会给出 7,419。新口径更准，`hidden + visible == 全部命名节点数` 这个恒等式现在成立。

---

## 5. 修掉的自造回归（重要）

改造 `load()` 时，我把原来的"统一灰色：遍历全部 mesh 赋 `meshMat`"误删了，以为材质同步统一由 `_applyHighlight()` 负责。

**但 `_applyHighlight()` 按 canonical 遍历 `meshByCanonical`，只认得"有名字的节点"** —— 无名 holder 下的几何不在任何 canonical 的网格表里，于是保留 GLTFLoader 建的 glTF 原生材质（本模型只有一个 material，`metallic=1 / roughness=1`），渲染出来是黑的。

- 表现：模型整体变黑（还被误以为是轮廓线把画面涂黑了）
- 定位：逐通道诊断（`scratch/appearance-diag.js`）+ 与既有截图 `reports/phase8-viewer.png` 对比模型亮度
- 修复：`load()` 里恢复全量遍历赋材质（统计几何量与登记线对象同一趟做掉）
- 防复发：`viewer3d.js` 里该处注释已写明"不能只依赖 `_applyHighlight()`"
- 证据：修复前模型区域暗像素 19.0%、修复后 0.1%，与既有截图一致

---

## 6. 已知限制与后续建议

| # | 限制 | 说明 / 建议 |
|---|---|---|
| 1 | 深度与法线**同时连续**的贴合面不会被描边 | 屏幕空间方案的固有近似。要彻底解决需要物体 ID 缓冲，而 5,796 个 mesh 逐对象换材质不划算 |
| 2 | 轮廓线开启时每帧多一轮场景渲染（5,508 draw calls） | 用户显式开启、关掉即零开销，因此不做拖动期暂停。若真机实测觉得拖动掉帧，可加"交互中暂停轮廓线"（与描边同一套 `lastInteract` 逻辑，改动约 3 行） |
| 3 | 轮廓线用固定阈值 | 不同尺度的模型（本模型 far ≈ 3,447）可能需要微调 `uNormalThreshold / uDepthThreshold`，目前是 `edgeLinesPass.js` 里的常量，未暴露到 UI |
| 4 | ghost 之间自排序 | `depthWrite:false` 的固有代价，同一物体前后表面叠加会略深；工程几何上可接受 |
| 5 | 启动瞬间的 `GL_INVALID_FRAMEBUFFER_OPERATION` 警告 | **既有问题，非本次引入**：`phase5-verify` / `phase7a-stability` / `game-pick-multiselect-verify` 的历史 evidence 里都有同类警告。本次对照测量显示开关轮廓线时新增警告数为 0 |
| 6 | 状态不持久化 | 按"默认关"的要求，刷新页面回到默认。若要记住用户选择，可照 `navigationSettings` 写入 localStorage（但那会与"默认关"的语义冲突，需明确取舍） |

---

## 7. 改动清单

| 文件 | 改动 |
|---|---|
| `viewer/js/edgeLinesPass.js` | **新增** 元件轮廓线后处理 pass（离屏法线/深度 + 边缘检测合成） |
| `viewer/js/viewer3d.js` | 新增外观状态与 `setContours / setXray / setXrayOpacity / appearanceState`；新增 ghost 材质与 `_ghostLineOpacity / _inHiddenChain / _solidInScene / _applyVisibility`；`_applyHighlight` 加 ghost 优先级；显隐三件套与拾取改走统一口径；`resize / unload / _loop / stats` 同步 |
| `viewer/index.html` | 工具条「外观」按钮 + `#appearance` 面板（两个复选框 + 透明度滑块）+ 相关样式 |
| `viewer/app.js` | 面板绑定、与「导航设置」互斥、`syncAppearanceInputs()`、`viewer.appearance*` 测试接口 |
| `scratch/appearance-verify.js` | **新增** 31 项功能实测 |
| `scratch/appearance-regression.js` | **新增** 15 项既有交互回归 |
| `scratch/appearance-fps.js` | **新增** 帧率对比测量 |
| `scratch/appearance-diag.js` | **新增** 逐通道诊断（画面不对时的排查工具） |
| `README.md` | 外观选项说明表 + 性能取舍段落 + 目录 + 实测脚本 |
