# Phase 7A 报告 —— 把 NavisGameNavigation V0.1 移植到 Web Viewer

> 目标：**把已经验收过的 NavisGameNavigation V0.1 操作体验搬到 Web Viewer**，
> 只把宿主从 Navisworks Camera API 换成 Three.js Camera。
> 不是"开发一个类似的 Web 控制器"。
>
> 迁移前的逐项分析见 `reports/navisgame-web-port.md`（**先于改代码产出**）。
> 本文件是实施与验收记录。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 操作手感 | **保持**。移动、组合归一化、双击 W 加速、俯仰限制、速度数值全部照抄原式，实测组合不超速（比值 0.997–1.006）、加速比 3.02× |
| 数值换算 | **不需要**。GLB 世界单位就是米 → `WORLD_UNITS_PER_METER = 1`，5 m/s 原样保留 |
| World Up | **+Y**（PDMS Z-up 在转换阶段已旋转为 glTF Y-up），实现上仍从宿主 `camera.up` 读 |
| 键位 | 与原件完全一致：F8 / W / S / A / D / Space / Shift / 双击 W / 滚轮 / Esc（方向键仍是 WASD 别名） |
| 需要重新设计的部分 | **零**。唯一被迫替换的是输入来源（Pointer Lock 取代光标锚定）与滚轮 Zoom 的实现路径（原插件的宿主原生 Zoom 通道在 Web 不存在） |
| 移植的 Navisworks workaround | **零**。IME 解绑、菜单吞键、工具争夺、光标回拉、JumpCut 一律不带过来 |
| 验收 | 核心算法移植测试 **22/22**；行为验收 **18/18**（含 10 分钟连续导航） |
| 过程中发现并修掉 | 1 个真实缺陷（见 §6.1）：`update()` 里把 `InputState` 与输入源混用，导致视角/移动/缩放全部失效 |

---

## 1. 交付物

| 类型 | 路径 | 说明 |
|---|---|---|
| 迁移对照分析 | `reports/navisgame-web-port.md` | REUSE / PORT / REPLACE / NOT NEEDED 四类标记，含全部算法与常量提取 |
| 导航层（新增） | `viewer/js/navigation/engineeringNavigation.js` | CameraFrame / CameraMath 逐行端口 + 状态机 + 相机写入 |
| 导航层（新增） | `viewer/js/navigation/inputState.js` | InputState（1:1 端口）+ PointerCapture + DOM 接线（键盘/鼠标/焦点） |
| 导航层（新增） | `viewer/js/navigation/navigationSettings.js` | 速度参数 + localStorage（对应原插件 settings.json） |
| 宿主接入 | `viewer/js/viewer3d.js` | 只做"创建 / 启用 / 停用 Navigation Controller"与模式互斥 |
| 装配与 UI | `viewer/app.js`、`viewer/index.html` | Orbit｜Game 开关、Navigation Settings 面板、准星、提示文案、状态外露 |
| 验收脚本 | `scratch/phase7a-verify.js` | 核心算法移植测试 + 18 项行为实测（含 10 分钟稳定性模式） |
| 验收证据 | `reports/evidence/phase7a-verify.json`、`phase7a-stability.json` | 逐项结果、读数、环境信息；前者为 18 项快速验收，后者含 10 分钟长跑逐 4 秒采样 |

导航层与 Viewer 的分工严格按任务书 §11：`viewer3d.js` 不再承载任何相机运动逻辑。

---

## 2. 算法：逐条对照（与原件同名同式）

| 原件 | Web 实现 | 关键点 |
|---|---|---|
| `CameraFrame`（WorldUp / HorizontalForward / Pitch + 派生 Right / Forward） | 同名类 | `Right = HorizontalForward × WorldUp` 是**每帧派生**量 → A/D 跟随当前 yaw，而不是初始相机右轴 |
| `CameraMath.CreateFrame` | `CameraMath.createFrame` | 含"近乎垂直时用相机右轴兜底推导水平前向"的分支 |
| `CameraMath.ApplyMouseLook` | `applyMouseLook` | `yaw = -dx·rpp`（0.12°/px），`pitch -= dy·rpp`，钳 ±89° |
| `CameraMath.ComposeMovement` | `composeMovement` | 三轴相加后**只归一化一次** —— "组合不超速"的唯一来源，没有被改成"各轴加权求和" |
| `CameraMath.RotateAroundAxis` | `Vector3.applyAxisAngle` | 同为右手系 Rodrigues，公式等价 |
| `InputState` | 同名类 | 按键集合、双击窗口 300 ms、自动重复不刷新时间戳、松开立即清加速、鼠标增量每帧只消费一次 |
| 帧步长 | `Math.min(dt, 0.05)` | 上限 0.05 s 原样保留（掉帧保护） |
| `NavigationDefaults` | `NAVIGATION_DEFAULTS` | 5 m/s · 3× · 0.12°/px · 300 ms · 16 ms · 0.05 s · 10°–100° · 89° · 1e-10 全部照抄 |
| 速度写回 | `position += direction × speed × dt` | 加速只在 `isSprinting && forwardAxis > 0` 时生效（纯 S / 纯 A-D / 纯升降不加速） |
| `settings.json` | `localStorage['navisgame.navigationSettings']` | **字段名与 schemaVersion 保持一致**，校验范围 0.1–500 / 1–10，非法整体回落默认值 |
| 准星 | `#crosshair` 的 SVG | Size 25 / Gap 3 / 前景白 1px / 描边黑 3px（先画黑再叠白），居中于 3D 画布 |
| 状态机 | `start / stop / pause / resume` | 语义与原件相同：进入复位输入；暂停清空按键并释放捕获但**保持模式开启**；保持相机位姿 |

---

## 3. 键位与操作行为（与原件逐条一致）

| 按键 | 行为 | 实现出处 |
|---|---|---|
| **F8** | 开启 / 退出工程导航（不必先点按钮） | `inputState.js` 的 keydown → `onToggleNavigation` |
| 点击 3D 视图 | 捕获鼠标（`requestPointerLock`） | `PointerCapture.request` |
| 鼠标移动 | 无限旋转视角（`movementX/Y` → yaw/pitch） | `_onMouseMove` → `InputState.addMouseDelta` |
| **W / S**（↑/↓ 别名） | 沿**镜头方向的水平投影**前进 / 后退 | `composeMovement` 用 `horizontalForward` |
| **A / D**（←/→ 别名） | 水平左移 / 右移 | 同上，用派生的 `right` |
| **Space** | 沿 World Up 上升 | `composeMovement` 用 `worldUp` |
| **Shift**（左右均可） | 沿 World Up 下降 | 同上 |
| **双击 W 并保持** | 加速 3×；松开立即恢复普通速度 | `InputState` 双拍判定 |
| **滚轮** | Zoom（FOV 10°–100°） | 见 §5.3 |
| **Esc** | 立即退出工程导航（释放指针锁定） | keydown 或 pointerlockchange 两条路径 |

组合移动 `W+D`、`W+Space`、`W+D+Space` 全部实测可用且**不超速**（§7）。

---

## 4. 与现有 Viewer 的共存

| 关注点 | 做法 |
|---|---|
| Orbit / Game 互斥 | `viewer3d.setNavigationMode()` 切模式；Game 时 `controls.enabled = false`，Orbit 时恢复 |
| 渲染循环 | 二选一：Game 走 `navigation.update(dt)`，Orbit 走 `controls.update()`。**必须二选一**：r160 的 `OrbitControls.update()` 每帧无条件 `object.lookAt(target)`，与导航写朝向会互相打架 |
| 退出时相机状态 | 保留 `position/quaternion`；把 `controls.target` 放到视线正前方（距离取上次轨道距离并钳到 `maxDistance`），避免 Orbit 回切瞬间朝向突跳或被距离钳制拉扯 |
| 选中冲突 | Game 模式下 `pointerup` 直接返回，**不触发拾取**；退出后点击选中恢复正常（实测） |
| F 复位视角 | Game 模式下屏蔽（会改 `controls.target` 与相机位置，与导航争相机），并同步禁用工具条按钮；退出后恢复 |
| Hide / Isolate / Show All / Tree / Properties | **未改动**，实测在导航前后行为一致 |
| 监听器 | 全部在构造时注册一次，模式切换只改状态位 → 反复切换 40 次，`addEventListener`/`removeEventListener` 计数均为 **0**，相机漂移 **0** |
| 描边开销 | Game 模式下把"有输入"视为交互，沿用既有的"交互期间暂停描边"优化 |

---

## 5. 宿主替换明细（哪些地方不是照抄，为什么）

### 5.1 光标锚定 → Pointer Lock

原插件每帧读真实光标位置求差、再把光标拉回锚点（`RelativeMouseTracker` + `SetCursorPos`），
还要处理四舍五入、拉回失败、读数失败重置基线。Web 侧 `movementX/movementY` 天生就是无限相对增量，
这套补偿逻辑**整体不需要**。保留的是语义：必须点击三维视图才捕获；未捕获时鼠标不控制相机。

刻意**不传** `unadjustedMovement: true`：原插件的增量来自 `GetCursorPos()`，是经过操作系统指针加速的位移；
浏览器默认的 `movementX` 同样经过加速曲线。要 1:1 保留手感，就保持默认。这条写进了代码注释。

### 5.2 物理键盘轮询 → 浏览器按键状态

原插件每帧调 `IsKeyDown` 采样，是为了绕开 Navisworks 吞键与 IME，**不是为了手感**。
Web 侧按键事件可靠，于是改回事件驱动 —— 这正好是 `InputState` 原本的接口（`keyDown/keyUp`），
`InputState` 一行都不用改。方向键别名、Esc 优先级、"已捕获才吞键"三条规则照原 `TryMapKey` / `TryMessageRouter` 保留。

### 5.3 滚轮 Zoom：照抄原插件的**回落公式**（唯一有取舍的一处）

原插件流程：先把滚轮事件放行给 Navisworks 原生 Zoom，只有回读发现"原生没改相机"时才回落到
`HeightField × 0.9^notches`（钳 10°–100°）。

Web 侧的对应关系变了：原生推拉在 Web 里对应 OrbitControls 的 dolly，但任务书 §8 要求
Game 模式下两个控制器不得同时响应输入 → OrbitControls 必须停用 → **原生通道不存在**。
因此直接把原插件的**回落公式**当作唯一实现：`camera.fov ×= 0.9^notches`，钳在 10°–100°。
这是照抄源码里的现成算法，不是新设计。

- 浏览器 `deltaY` 归一化：`deltaMode=0`(px) 按 `/100`、`=1`(line) 按 `/3`、`=2`(page) 按 `×8` 换算成"格"，
  再套原式的 `clamp(raw, -8, +8)`，Chrome 与 Firefox 手感一致。
- **代价（如实记录）**：它是"望远镜"式缩放，不像推拉那样移动相机位置；缩到 10° 会到顶。
  换来的是相机位置只由 WASD 决定，不会出现"滚轮把相机推进模型里"或与 `controls.target` 语义打架。
- 若日后确认想要推拉手感：只需改 `applyPendingZoom()` 里的两行（沿 `frame.forward` 平移），
  其余（归一化、每帧消费、与移动/视角的互不干扰）都不动。代码里已标注。

### 5.4 焦点：Alt+Tab 与恢复

| 事件 | 处理 |
|---|---|
| `window.blur` / `document.visibilitychange`(hidden) | `pause('focus')`：清空所有按键、释放指针锁定、隐藏准星；**保持 Game 模式** |
| 每帧复核 | `update()` 里仍复核 `document.hasFocus()`，兜住浏览器没派发 blur 的情况（对应原件每帧查 `GetForegroundWindow`） |
| 指针锁定被浏览器解除 | 用 `intentionalExit` 标志区分"我方释放"与"用户按 Esc"：前者只暂停，后者退出导航 |
| 恢复焦点 | **不自动重新捕获**（浏览器规定 Pointer Lock 必须由用户手势触发）→ 必须再点一次 3D 视图；那一次点击不选模型 |
| 未捕获期间按 W | 仍会移动相机（**与原件一致**：捕获只影响鼠标视角与按键吞并），但失焦暂停状态下不会移动 |

### 5.5 明确未移植的宿主 workaround

`ImmAssociateContext` 解绑 IME、`SetWindowsHookEx` 预吞按键、`VK_PROCESSKEY(229)` 判定、
`TryReclaimTool`（5000 ms/25 次）、`MouseLeave` 暂停、`UnitConversion.ScaleFactor`、`JumpCut`、
ToolPlugin/Ribbon/bundle 装载 —— 全部不写。原则：**复用行为和算法，不复用已经不存在的问题。**

---

## 6. 实施过程中发现并修掉的问题

### 6.1 `update()` 把 `InputState` 与输入源混用（真实缺陷，已修）

`EngineeringNavigation` 里有两个对象：DOM 接线层（键盘/鼠标/焦点）和按键状态机（`InputState`）。
首版 `update()` 写成了

```js
const delta = this.input.consumeMouseDelta();   // ← this.input 当时指向"接线层"，没有这个方法
const axes  = this.input.getAxes();
```

接线层没有这两个方法，于是**每帧抛异常**：视角不转、WASD 不动、滚轮不生效，
只留下满屏 `this.input.consumeMouseDelta is not a function`。

修法：把接线层改名 `this.inputSource`，并按原插件命名把按键状态机暴露为 `this.input`
（`this.input = this.inputSource.input`），此后 `this.input.consumeMouseDelta()` / `getAxes()` / `isSprinting`
与原 C# 的 `_input.ConsumeMouseDelta(...)` / `GetAxes(...)` / `IsSprinting` 一一对应。

**为什么值得记下来**：这个缺陷不会让页面白屏，只会让"输入等于没反应"，而验收项里
"能旋转""能移动""滚轮可缩放"会同时失败 —— 排查时容易被误判成 Pointer Lock 或事件没到，
本次就是靠逐帧的 `pageerror` 才定位的。诊断顺序建议固定为：
**先看有没有 JS 异常 → 再看 captured/active/paused/hasFocus 四个状态位 → 最后才怀疑事件链。**

### 6.2 验收脚本自身的问题（同样记录，避免后续重复踩）

| 问题 | 原因 | 处理 |
|---|---|---|
| "无限旋转"注入的 `movementX` 完全没效果 | 与 6.1 同源（异常吞掉了增量） | 修 6.1 后 3 圈 1080° 精确复现 |
| 选中/隔离测试"假失败" | 拿顶层 `SITE` 当目标，包围盒中心是空气 → 射线打不到 | 改成挑**包围盒最小且有几何**的对象；点击前先清空选中 |
| 属性面板"没有变化" | 前一项测试已经选中了同一个对象 | 点击树之前先 `select(null)` 清空面板 |
| 证据 JSON 没写出来 | 异常发生在 `finally` 的 `browser.close()`，之后的写文件被跳过；且 `process.exit()` 会丢掉未冲刷的 stdout | 写文件与 close 各自 try/catch；改用 `process.exitCode` |
| `movementX` 注入是否为等价路径 | 合成 `MouseEvent` 的 `movementX` 在 Chromium 中**会被保留**（实测 `[123,-45,false]`） | 用它驱动与真实鼠标同一条生产代码路径 |
| 无头环境的 Pointer Lock | **实测可用**（真实点击后 `pointerLockElement === canvas`） | 验收第 2 项按真实能力上报，未使用任何模拟 |

---

## 7. 验收结果

### 7.1 核心算法移植测试（22 项，`scratch/phase7a-verify.js` 内跑在浏览器里）

把原插件 `tests/NavisGameNavigation.CoreTests/Program.cs` 的断言逐条搬到 Web 侧执行，
另加 4 条 Web 专有断言（单位系数、World Up、滚轮归一化、常量全量核对）：

**22/22 通过**。覆盖：水平投影、Right 方向、W 不产生竖直分量、组合归一化（含 `1,-1,1`）、
垂直兜底、Pitch 钳制、鼠标右移的 yaw 方向、双击 W、300 ms 窗口、自动重复忽略、松开清加速、
正负相消、鼠标增量单次消费、设置校验与回落、settings 字段契约、准星几何与可见性、单位与常量。

> 原 Program.cs 里的 3 项"光标回拉"测试（四舍五入、拉回失败不重放、读数失败恢复）
> 属 Navisworks 专用，Web 无光标回拉 → 标记 **NOT NEEDED**，不在本清单内。

### 7.2 行为验收（18 项）

| # | 项目 | 结果 | 关键读数 |
|---|---|---|---|
| 1 | F8 开关 | ✅ | orbit → game → orbit，OrbitControls 同步恢复 |
| 2 | 点击 3D View 捕获鼠标 | ✅ | 真实 Pointer Lock 生效（`pointerLockElement === canvas`），准星出现 |
| 3 | 无限旋转 ≥3 圈、Pitch 不翻转 | ✅ | 累计 **1080.00°**（无钳制/无漂移），硬拉后 ±**89°** 不翻转 |
| 4 | 仰视/俯视 W 仍水平 | ✅ | pitch=±89° 时位移 **Y 分量 = 0.0000**，水平 2.34 m，速度 4.92 m/s |
| 5 | W+D 组合 | ✅ | 速度比 **0.997**，与"W 单位向量 + D 单位向量"方向误差 **0.53°** |
| 6 | W+Space 组合 | ✅ | 速度比 **0.998**，方向误差 0.56°，竖直分量 +1.65（向上） |
| 7 | W+D+Space 且不超速 | ✅ | 速度比 **0.998**，方向误差 0.95°，竖直分量 +1.34 |
| 8 | 双击 W 加速 3× | ✅ | 普通 4.94 → 加速 **14.93 m/s**，比值 **3.03×** |
| 9 | 松开 W 立即恢复 | ✅ | `sprinting` 在 keyup 后立即为 false |
| 10 | 滚轮 Zoom | ✅ | 50 →**45**（上滚 1 格 = ×0.9）→ 50；连滚钳到 **10°** / **100°** |
| 11 | Esc 立即退出 | ✅ | 模式回 orbit，准星消失，F 复位按钮恢复 |
| 12 | Game 中点击不选模型 / 退出后选中正常 | ✅ | Game 点击后 `selected = null`；退出后点击同一实体命中并选中 |
| 13 | Alt+Tab 后不卡键（事件级复现） | ✅ | `paused=true`、`captured=false`、`axes` 全 0、`pressed=[]`、按键按住 0.6 s **位移 = 0** |
| 14 | 恢复焦点需重新捕获 | ✅ | focus 后 `captured=false`；点击后 `captured=true` 且 `paused=false` |
| 15 | Hide / Isolate / Show All | ✅ | 隐藏 1 → 显示全部 0；隔离后隐藏 7,415 / 可见 5；最终归零 |
| 16 | Tree / Properties 不受影响 | ✅ | 点树 → 选中同步、属性面板更新 |
| 17 | 连续导航 10 分钟 | ✅ | 两轮：150 样本 / 10.06 min，FPS 32–181，堆 −5.4 MB，全程 `mode=game` 且位置有限 |
| 18 | 反复 Orbit⇄Game（40 次） | ✅ | 监听器新增/移除 **0/0**，相机漂移 **0.0000**，模式与控制器状态正确 |

**页面错误：0**。

### 7.3 连续导航 10 分钟稳定性

`node scratch/phase7a-verify.js --stability 10`：Game 模式下持续交替 W/D/Space/W/S 与视角输入，
每 4 秒采样一次 FPS / draw calls / 堆内存 / 位置 / 俯仰。

| 轮次 | 采样 | 最低 FPS | 最高 FPS | 堆变化 | 结果 |
|---|---|---|---|---|---|
| 第 1 轮（`scratch/phase7a-stability.log`） | 149 | 135 | 182 | −86.2 MB（GC 回落） | PASS |
| 第 2 轮（`reports/evidence/phase7a-stability.json`） | **150**（10.06 min） | **32** | **181** | **−5.4 MB** | **PASS** |

第 2 轮全程 `mode='game'`、`captured=true`，位置始终有限、`|pitch| ≤ 89.001°`；
第 2 轮最低 FPS 32 出现在相机飞到几何密集区时（第 1 轮 135 是因为游走路径大多对着空旷区）——
两轮都远高于判据线（>5 FPS），结论一致：**10 分钟连续导航无卡顿、无失控、无泄漏趋势**。

判据：位置全部有限、`|pitch| ≤ 89.001°`、最低 FPS > 5、堆变化 < 200 MB、结束时仍处于 Game 模式 —— 全部满足。

两点如实说明：

- FPS 高达 135–182 是因为摄像机在园区范围内游走，进视锥的几何远少于"全模型全景"（Phase 6 基线里
  全模型空闲 52 FPS、缩放到元件 101 FPS）；这里要验证的是**长时间不失控/不漂移/不泄漏**，不是峰值性能。
- 第 1 轮结束时进程在写证据文件之前被外部中断，所以那一轮只有控制台日志留档（数字已抄进上表）；
  本轮已把验收脚本改成**每记录一项就落盘一次**，第 2 轮起证据文件完整。

---

## 8. 不属于本阶段的事（明确没做）

- 没有改 Orbit 控制的任何既有行为（旋转/平移/缩放/F 复位/显隐/隔离/树/属性一律未动）。
- 没有做碰撞、重力、地面、跳跃、自动避障、速度档位、选择树聚焦（原插件 V0.1 也没有）。
- 没有移植 Navisworks 侧的插件装载、Ribbon、bundle、探针。
- 没有把滚轮做成推拉（见 §5.3 的取舍，留了一行开关点）。
- 没有为原插件那 25 项核心测试建独立的 JS 测试工程 —— 本阶段把断言内嵌在浏览器验收脚本里跑通；
  若后续要长期维护（例如继续加键位），建议再抽成可在 Node 里跑的模块单测（**未越级实施**）。

---

## 9. 风险与后续建议

| # | 事项 | 建议 |
|---|---|---|
| 1 | **工作区正被并行会话改动**：本轮期间 `data/processed/` 被搬到 `data/_legacy_demo_2026-08-26/`，并出现 `data/projects/`、`tools/server.py`、`viewer/js/assetManager.js`（Phase 8 资产管理）。本轮验收因此改为在 Model Selector 里打开 `qichuang / main-site / 2026-09-18`（与 Phase 7A 开始时同一份 QICHUANG 模型） | **同一目录不要让两个会话同时写**。并行改动会瞬时产生 `index.html` 与 `app.js` 不一致、进而整页不可用；本轮至少遇到一次 |
| 2 | 滚轮是"望远镜"式 FOV 缩放 | 若觉得不像 Navisworks 的推拉手感，改 `applyPendingZoom()` 一个分支即可 |
| 3 | Chrome 在按 Esc 后有约 1.25 s 的指针锁定冷却 | 已做可重试提示，不静默失败；实测连续操作未受阻 |
| 4 | Pointer Lock 需要用户手势，无法"自动恢复捕获" | 属浏览器安全模型，与原插件行为等价（原件同样要求场景内单击） |
| 5 | 稳定性长跑只覆盖了单模型（7,420 映射对象） | 若接入更大园区级模型，建议重跑 `--stability`，并关注描边开销 |

---

## 10. 复现方式

```bash
# 1) 起服务（Phase 8 起的入口是 tools/server.py；旧静态服务 tools/serve.py 仍可用）
python tools/server.py            # 或双击 start.bat

# 2) 跑验收（含 10 分钟稳定性）
NODE_PATH=<workbuddy>/node_modules node scratch/phase7a-verify.js
NODE_PATH=<workbuddy>/node_modules node scratch/phase7a-verify.js --stability 10

# 3) 证据
reports/evidence/phase7a-verify.json
```

手工验收（人眼）建议顺序，与原插件 README 的手工清单一致：
F8 进 → 点场景 → 鼠标连续转 ≥3 圈 → 抬头/低头各按 W 看是否仍水平 → W+D+Space 持续按看是否变快 →
双击按住 W 看加速、松开看恢复 → 滚轮 → Esc → 点模型看选中 → Alt+Tab 后回来看是否还在动。
