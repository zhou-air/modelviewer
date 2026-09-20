# NavisGameNavigation V0.1 → Web Viewer 迁移对照（Phase 7A）

> 本文是**改代码之前**的分析产物。所有条目都来自实际阅读
> `C:\Users\34084\Desktop\navisview` 源码，不是按需求描述反推的。
> 目标：把已经验收过的 NavisGameNavigation 操作手感 1:1 搬到 Web Viewer，
> 只替换宿主（Navisworks Camera API → Three.js Camera），不重新设计导航。

---

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| 要重新设计吗 | **不要**。原插件的 `Core/CameraFrame.cs` + `Core/CameraMath.cs` + `Core/InputState.cs` + `Core/NavigationDefaults.cs` 四份文件是**宿主无关的纯算法**，可在 Three.js 里逐行等价重写 | 见 §4 |
| 速度要换算吗 | **不需要**。GLB 世界单位就是**米**，与原 Navisworks 世界单位一致 → 换算系数 = 1，5 m/s 原样保留 | §5.1 |
| World Up 是什么 | **+Y**（PDMS Z-up 已在转换阶段旋转为 glTF Y-up），与 Three.js 默认向上轴一致 | §5.2 |
| 手感会不会变 | 不会。移动、加速、双击 W、俯仰限制、组合归一化全部照抄原式；唯一被迫改的是**输入来源**（指针锁定取代光标锚定）和**滚轮 Zoom 的实现路径**（原插件依赖宿主原生 Zoom，Web 无该通道） | §6 |
| 需要移植的 Navisworks workaround | **一个都不要**。W 被菜单吞、IME `VK_PROCESSKEY`、工具被宿主抢走、光标锚定回拉、JumpCut——这五个是纯 Navisworks 宿主缺陷 | §7 |

---

## 1. 阅读范围（原插件源码）

| 类别 | 文件 | 读到了什么 |
|---|---|---|
| 说明 | `src/.../README.md`（`navisview/README.md`） | 完整键位表、焦点暂停语义、9 条手工验收清单 |
| 算法 | `Core/CameraFrame.cs` | Right / Forward 的推导式 |
| 算法 | `Core/CameraMath.cs` | 建帧、水平投影、鼠标视角、组合移动归一化、绕轴旋转、Clamp |
| 算法 | `Core/InputState.cs` | 按键集合、双击 W 判定、鼠标增量累积/消费、轴向量、Reset |
| 算法 | `Core/NavigationDefaults.cs` | **全部数值常量** |
| 算法 | `Core/Vector3d.cs` | 右乘叉积约定（`this × other`，右手系） |
| 输入 | `Core/RelativeMouseTracker.cs` | 光标回拉的基线/读数逻辑（Windows 专用） |
| 输入 | `Input/MouseCapture.cs` | 锚定点击点、隐藏光标、释放 |
| 输入 | `Input/NavigationKeyboardInterceptor.cs` | 消息钩子、Alt 豁免、按键预吞 |
| 输入 | `Core/NavigationMessageRouter.cs` | 导航中按键路由规则、Esc 优先级 |
| 状态 | `Navigation/GameNavigationController.cs` | **状态机全貌**：Start/Stop、Pause/Resume、键盘轮询、视图写回、滚轮、工具争夺 |
| 状态 | `Plugin/GameNavigationToolPlugin.cs` | 工具生命周期、Overlay 准星、卸载钩子 |
| 设置 | `Settings/NavigationSettingsData.cs` | JSON 契约（`schemaVersion`/`normalSpeedMetersPerSecond`/`sprintMultiplier`）与校验范围 |
| 设置 | `Settings/NavigationSettingsStore.cs` | `%APPDATA%\NavisGameNavigation\settings.json`，原子替换写入 |
| UI | `Core/CrosshairModel.cs`、`UI/CrosshairRenderer.cs`、`UI/SpeedSettingsDialog.cs` | 准星几何/配色/线宽、速度对话框取值范围 |
| 规范 | `tests/.../Program.cs` | **25 项算法测试**，等于官方验收基线（本文多处引用其断言） |

---

## 2. 标记定义

| 标记 | 含义 |
|---|---|
| **REUSE** | 算法与数值原样照抄，Web 里逐行等价，不改行为 |
| **PORT** | 行为保留，载体换成 Web 对应物（如 Viewpoint → THREE.Camera 的写入方式） |
| **REPLACE** | 宿主专用机制换成 Web 等价机制（Pointer Lock、浏览器键盘状态、window 焦点事件） |
| **NOT NEEDED** | 原插件为迁就 Navisworks 宿主缺陷而写，Web 不存在该问题，**不移植** |

---

## 3. 总对照表

| NavisGameNavigation | Web Viewer（Phase 7A 实现） | 类别 | 说明 |
|---|---|---|---|
| `Core/CameraFrame.cs`（WorldUp / HorizontalForward / Pitch / Right / Forward） | `CameraFrame` 类 | **REUSE** | 三字段 + 两个派生量，公式一字不改 |
| `Core/CameraMath.cs.CreateFrame` | `CameraMath.createFrame` | **REUSE** | 含"近乎垂直时的水平前向兜底"分支 |
| `Core/CameraMath.cs.ProjectOntoPlane` | `CameraMath.projectOntoPlane` | **REUSE** | `v - n(v·n)` |
| `Core/CameraMath.cs.ApplyMouseLook` | `CameraMath.applyMouseLook` | **REUSE** | `yaw = -dx·rpp`，`pitch -= dy·rpp` |
| `Core/CameraMath.cs.ComposeMovement` | `CameraMath.composeMovement` | **REUSE** | 组合后 `normalize()`——**这是"组合不超速"的唯一来源** |
| `Core/CameraMath.cs.RotateAroundAxis` | `Vector3.applyAxisAngle` | **REUSE** | 同为右手系 Rodrigues，可直接替换 |
| `Core/InputState.cs` | `InputState` 类 | **REUSE** | 按键集合/双击判定/增量消费逐行等价 |
| `Core/NavigationDefaults.cs` | `navigationSettings.js > NAVIGATION_DEFAULTS` | **REUSE** | 数值全部保留（见 §4.9 表） |
| `navigation state`（IsActive / IsPaused） | `EngineeringNavigation.active / paused` | **PORT** | 语义不变 |
| `movement state`（6 键轴向量） | `InputState.getAxes()` | **REUSE** | 正负相消规则相同 |
| `forward/back movement algorithm` | `composeMovement` + WorldUp 投影 | **REUSE** | 仰视/俯视都走水平投影 |
| `horizontal projection algorithm` | `projectOntoPlane` | **REUSE** | 同上 |
| `strafe algorithm` | `CameraFrame.right`（由**当前** yaw 推导） | **REUSE** | 注意：不是初始帧的相机右轴 |
| `vertical movement algorithm` | `worldUp × upAxis` | **REUSE** | 沿**世界**上轴，不沿镜头 |
| `delta-time movement` | rAF 帧间隔 + `Math.min(dt, 0.05)` | **REUSE** | 上限 0.05 s 原样保留 |
| `normal speed` 5 m/s | `NormalSpeedMetersPerSecond = 5` | **REUSE** | 换算系数 1（§5.1） |
| `fast speed multiplier` 3× | `SprintMultiplier = 3` | **REUSE** | 仅当 `isSprinting && forwardAxis > 0` |
| `double-W detection` 300 ms | `DoubleTapThresholdMilliseconds = 300` | **REUSE** | 含"自动重复不计入"的隐式行为 |
| `yaw` | `CameraFrame.horizontalForward` 绕 WorldUp 旋转 | **REUSE** | 不存欧拉角，与原件一致 |
| `pitch` | `CameraFrame.pitchRadians` | **REUSE** | 不存欧拉角 |
| `pitch clamp` ±89° | `MaxPitchRadians` | **REUSE** | |
| `combined movement normalization` | `Vector3.normalize()` | **REUSE** | 零向量保持零向量 |
| `enter/exit navigation state` | `start()` / `stop()` | **PORT** | 宿主检查（正交视图、模型是否存在）改为 Web 等价检查 |
| `focus lost / focus restored` | `pause('focus')` + 需重新点击 | **REPLACE** | 触发源：`window.blur` / `visibilitychange`；恢复需重新 Pointer Lock |
| `input reset`（`InputState.Reset`） | `inputState.reset()` | **REUSE** | 进入、退出、暂停、恢复四处都调 |
| `camera state preservation` | 退出时保留相机位姿 + 重算 Orbit target | **PORT** | Three.js 没有 Viewpoint 对象可写回；改为保留 `position/quaternion` 并把 `controls.target` 放到视线正前方，避免 Orbit 模式回切时朝向突跳 |
| `ToolPlugin`（`GameNavigationToolPlugin`） | `EngineeringNavigation` | **PORT** | 只保留"接收输入 → 更新相机"的职责，去掉工具身份 |
| `Autodesk.Navisworks.Api` / `Viewpoint` | `THREE.PerspectiveCamera` | **REPLACE** | `AlignDirection`/`AlignUp` → `lookAt(pos + forward)` |
| `ViewChange.JumpCut`（绕过碰撞/重力/插值） | 直接写 `camera.position` / `quaternion` | **REPLACE** | Three.js 侧无碰撞、无重力、无插值，"瞬时写"是默认行为 |
| `Win32 physical keyboard polling`（`NativeMethods.IsKeyDown` 每帧采样） | 浏览器 `keydown`/`keyup` 状态集 | **REPLACE** | 见 §6.2；`InputState` 本身不依赖轮询，可直接复用 |
| Windows cursor anchoring（`GetCursorPos`/`SetCursorPos`/`RelativeMouseTracker`） | **Pointer Lock API** | **REPLACE** | `movementX/movementY` 天然是无限相对增量，不需要回拉 |
| `settings.json`（`%APPDATA%\NavisGameNavigation\`） | `localStorage['navisgame.navigationSettings']` | **REPLACE** | **字段名与 schemaVersion 保持一致**（§4.10） |
| `SpeedSettingsDialog` | Web 版 Navigation Settings 面板 | **PORT** | 同样只暴露普通速度 + 加速倍率两项 |
| `CrosshairModel`/`CrosshairRenderer`（屏幕中心 4 线，白 1px 黑 3px 底） | `#crosshair` SVG | **PORT** | 几何与配色照抄，居中于 **canvas** 而非整个窗口 |
| Navisworks Zoom（原生视点推拉） | `camera.fov`（原插件的**回落公式**） | **REPLACE** | 见 §6.4，理由与取舍写在那里 |
| Windows IME 解绑（`ImmAssociateContext`） | — | **NOT NEEDED** | §7.1 |
| 宿主菜单加速键吞键（W） | — | **NOT NEEDED** | §7.2 |
| `VK_PROCESSKEY(229)` 处理 | — | **NOT NEEDED** | §7.3 |
| 导航工具被宿主抢走的收回逻辑（`TryReclaimTool`，5000 ms / 最多 25 次） | — | **NOT NEEDED** | §7.4 |
| `MouseLeave` 暂停（锚定导致的假"离开视图"） | — | **NOT NEEDED** | §7.5 |
| 无界面模式探针（`HostProbePlugin`） | 浏览器端实测脚本 | **REPLACE** | 见 §9 |

---

## 4. 逐项算法提取（实现时必须逐字对齐的部分）

### 4.1 CameraFrame（`Core/CameraFrame.cs`）

```text
WorldUp            : 单位向量（一次求得，导航期间不变）
HorizontalForward  : 单位向量，永在垂直于 WorldUp 的平面内
PitchRadians       : 俯仰角，受限 ±89°
Right   = normalize(HorizontalForward × WorldUp)      // 派生，随 yaw 更新
Forward = normalize(HorizontalForward·cos(pitch) + WorldUp·sin(pitch))
```

**关键点**：`Right` 与 `Forward` 都是**每帧从 HorizontalForward 重算的派生量**，不是存下来的向量。
这决定了 A/D 在俯仰之后仍然水平（用当前 yaw 的右轴，而不是初始右轴）。

### 4.2 CreateFrame（建帧）

```text
up = normalize(worldUp)                  // 零向量 → 报错
f  = normalize(forward)                  // 零向量 → 报错
h  = normalize(projectOntoPlane(f, up))
if (|h| ≈ 0) {                           // 近乎垂直：兜底
    hr = normalize(projectOntoPlane(cameraRight, up))
    h  = normalize(up × hr)
}
pitch = clamp(asin(clamp(f·up, -1, 1)), -89°, +89°)
```

### 4.3 ApplyMouseLook（鼠标视角）

```text
yaw              = -deltaX * radiansPerPixel     // 右移为正 → 视角右转
HorizontalForward = normalize(rotateAroundAxis(HorizontalForward, WorldUp, yaw))
PitchRadians      = clamp(PitchRadians - deltaY * radiansPerPixel, -89°, +89°)
```

- 灵敏度：`0.12°/px` → `0.0020943951 rad/px`（`NavigationDefaults`）。
- 测试锁定方向：`TestMouseYawDirection` 断言"鼠标右移 100 px 后 HorizontalForward.X > 0"。
- 俯仰不翻转的保证来自 clamp 89°（`TestPitchClamp`）。

### 4.4 ComposeMovement（组合移动）——第 3、4 节的核心

```text
movement = HorizontalForward × forwardAxis
         + Right             × rightAxis
         + WorldUp           × upAxis
return normalize(movement)          // 零向量 → 零向量
```

- 轴取值只有 `-1 / 0 / 1`（`InputState.Axis` 正负相消）。
- **"组合不超速"完全来自这一个 `normalize()`**：W+D 与 W 同为 1 单位/秒。不要改成三轴相加后各自乘系数。
- W+D+Space = 三轴同时归一化，方向斜向上，**速度模长仍是 1**。
- `TestCombinationNormalization` 断言 `|composeMovement(f,1,1,1)| == 1`、`|…(1,0,1)| == 1`。

### 4.5 速度与步长

```text
speed = NormalSpeedMetersPerSecond × metersToDocumentUnits     // ← 换算系数，见 §5.1
if (isSprinting && forwardAxis > 0) speed *= SprintMultiplier   // ← 只有"向前"才吃加速
step = speed × deltaSeconds
position += movementDirection × step
```

注意 `forwardAxis > 0` 这个条件：**加速对 S、纯 A/D、纯 Space 无效**（原件如此，照抄）。

### 4.6 双击 W 判定（`InputState`）

```text
keyDown(Forward, t):
    if (!pressed.add(Forward)) return false          // 自动重复被吞，且不刷新时间戳
    if (lastForwardPress != null):
        elapsed = t - lastForwardPress
        isSprinting = (elapsed >= 0 && elapsed <= 300)
    lastForwardPress = t
keyUp(Forward):
    pressed.delete(Forward); isSprinting = false     // 松开立即恢复普通速度
```

测试锁定：`TestDoubleTapSprint`（1000→1250 ms 加速）、`TestLateSecondTap`（1000→1400 ms 不加速）、
`TestAutoRepeat`（按住不触发）、`TestReleaseClearsSprint`（松开即清）。

### 4.7 帧步长

```text
间隔上限 MaximumDeltaSeconds = 0.05 s；原始间隔先 max(0, t) 再 min(0.05)
```

原插件用 16 ms 定时器 + Stopwatch；Web 用 rAF 帧间隔，**上限 0.05 秒保留**——
这既是掉帧保护，也顺带保证"长时间卡顿不会瞬移"。

### 4.8 滚轮 Zoom

原始归一化（`GameNavigationController.NormalizeWheel`）：

```text
raw = (|length| > eps) ? length : (short)wheel
if (|raw| >= 120) raw /= 120                      // Win32 一格 = 120
notches = clamp(raw, -8, +8)
```

原始回落公式（`ApplyPendingWheelFallback`）：

```text
if (原生 Zoom 已改变相机) → 不回落到 FOV
nextField = HeightField × 0.9 ^ notches
HeightField = clamp(nextField, 10°, 100°)          // 垂直视场角
```

### 4.9 状态机

```text
Start :  校验宿主可用 → 建帧 → input.Reset() → 挂事件 → 起时钟
Stop  :  IsActive=false, IsPaused=false → input.Reset() → 释放鼠标 → 摘事件 → 保留相机
Pause :  IsPaused=true → input.Reset() → 释放鼠标捕获 → 时钟重启     （焦点丢失）
Resume:  IsPaused=false → input.Reset() → 时钟重启 → 重新捕获鼠标   （场景内单击）
每帧  :  if (焦点丢失) Pause(); if (IsPaused) return;  然后 采样→消费鼠标→写相机
准星  :  显示条件 = active && !paused && captured && foreground
```

`TimerIntervalMilliseconds = 16`（对应 Web 的 rAF）。

### 4.10 全部数值常量（照抄）

| 常量 | 值 | Web 侧去处 |
|---|---|---|
| `NormalSpeedMetersPerSecond` | `5.0` | `navigationSettings.js` |
| `SprintMultiplier` | `3.0` | 同上 |
| `MouseSensitivityDegreesPerPixel` | `0.12` | 同上 |
| `DoubleTapThresholdMilliseconds` | `300` | 同上 |
| `TimerIntervalMilliseconds` | `16` | rAF 帧循环（等价） |
| `MaximumDeltaSeconds` | `0.05` | 同上 |
| `MinimumFieldOfViewRadians` | `10°` | 同上（Zoom clamp） |
| `MaximumFieldOfViewRadians` | `100°` | 同上 |
| `MaxPitchRadians` | `89°` | 同上 |
| `Epsilon` | `1e-10` | 同上 |
| 速度校验范围 | `0.1 – 500` | 设置校验 |
| 加速倍率校验范围 | `1 – 10` | 设置校验 |
| `SchemaVersion` | `1` | localStorage 契约 |
| 准星 `SizePixels/GapPixels/LineWidth/OutlineWidth` | `25 / 3 / 1 / 3` | `#crosshair` SVG |
| 准星颜色 | 前景 `#FFFFFF` α1 · 描边 `#000000` α0.9 | 同上（先画 3px 黑，再叠 1px 白） |
| settings.json 字段名 | `schemaVersion` / `normalSpeedMetersPerSecond` / `sprintMultiplier` | localStorage 保持同名 |

---

## 5. 单位与坐标（决定"手感要不要动"）

### 5.1 世界单位 = 米 → 换算系数 1（已确认）

| 证据 | 内容 |
|---|---|
| `converter/rvm_to_glb.py` | `--tolerance=0.02`，注释「(默认 0.1，世界单位)」；无缩放参数 |
| `reports/phase2-report.md` §朝向验证 | GLB 尺寸 `(199.20, 25.60, 133.36) = (E, U, N)`，与 RVM 的 E/N/U 跨度 199.2 / 133.4 / 25.6 m 一致 |
| `reports/inspection.md` §2.9 | RVM 内部单位 mm，读取后为 m；TXT 亦标注 mm，均转为 m |
| `viewer/js/viewer3d.js` | `fit()` 用米级距离、`far = dist*12 + 500`、`maxDistance 8000` —— 与 200 m 级模型吻合 |

**结论**：`WORLD_UNITS_PER_METER = 1`。5 m/s 就是 5 世界单位/秒，**不做任何缩放**，
不引入"因为换算而调速度"的手感偏移。（原插件那行 `UnitConversion.ScaleFactor(Units.Meters, document.Units)`
在 Web 里等价于乘 1。）

### 5.2 World Up = +Y（已确认）

| 证据 | 内容 |
|---|---|
| `converter/rvm_to_glb.py` | 固定传 `--output-gltf-rotate-z-to-y=true`，注释「PDMS 是 Z 向上，glTF 是 Y 向上」 |
| `reports/phase4-report.md` | GLB 内含 `rvmparser-rotate-z-to-y` 旋转节点 |
| `reports/phase2-report.md` | 实测三个维度排列为 (E, U, N)，确认旋转已生效 |

**结论**：`WorldUp = (0, +1, 0)`。实现上仍按原 `ReadWorldUp` 的做法**从宿主读**（`camera.up`），
退化时才回落到 `(0,1,0)`；这样万一将来换了向上轴的模型，导航不用改代码。

---

## 6. 宿主差异：REPLACE 明细与理由

### 6.1 光标锚定 → Pointer Lock

| 原插件 | Web |
|---|---|
| `MouseCapture.CaptureAt(view)`：记住点击点作为锚点，隐藏光标 | `canvas.requestPointerLock()`（必须由用户手势触发，即点击 canvas） |
| `RelativeMouseTracker`：每帧读真实光标位置求差，再把光标拉回锚点 | 浏览器直接给 `movementX/movementY` 增量 |
| 读数四舍五入/失败回滚的补偿逻辑（`ReadPosition`/`SetPosition` 回调、`_hasBaseline` 重取） | **无对应问题**，不需要 |
| 目标点击点不可见/拉回失败时记 `CURSOR_PIN_FAILED` 诊断 | 不需要 |

保留的是**语义**：点击 3D 视图 → 捕获；捕获后鼠标只控相机；未捕获时鼠标不控相机（不许悬停捕获，
原插件明确记录过"悬停捕获会把指针推到视图外"这个坑）。

**不做** `unadjustedMovement: true`：原插件的增量来自 `GetCursorPos()`，是**经过操作系统指针加速**的位移；
Chrome 默认的 `movementX` 同样经过加速曲线。要 1:1 保留手感，就保持默认。这条写进代码注释，防止以后被"优化"掉。

### 6.2 Win32 物理键盘轮询 → 浏览器 keydown/keyup

原插件**每帧调用 `IsKeyDown` 采样**，是为了绕开宿主吞键/IME，不是为了手感。
Web 侧按键事件可靠，因此改回**事件驱动的按键集合**——这恰好就是 `InputState` 本来的接口
（`KeyDown(key, timestamp)` / `KeyUp(key)`），`InputState` 一行不用改。

键位映射沿用原 `TryMapKey` 的别名表：

| 键 | NavigationKey | 备注 |
|---|---|---|
| `W` / `ArrowUp` | Forward | 方向键是 W 的别名（原件的注释：方向键不会被宿主吞） |
| `S` / `ArrowDown` | Backward | |
| `A` / `ArrowLeft` | Left | |
| `D` / `ArrowRight` | Right | |
| `Space` | Up | 沿 WorldUp 上升 |
| `Shift`（左/右） | Down | 沿 WorldUp 下降 |
| `Esc` | 退出导航 | 优先级最高，未捕获时也生效（`TestEscapeRoute`） |
| `F8` | 开 / 关导航 | 原由 Navisworks 注册快捷键，Web 由 keydown 处理 |

**"已捕获才吞键"**：原 `NavigationMessageRouter.TryRoute` 只在
`navigationActive && movementCaptureActive && IsMovementKey` 时才算导航输入。
Web 等价：仅在"游戏模式且已捕获"时 `preventDefault()`（挡掉空格滚页、方向键滚动）。

### 6.3 视点写回 → 直接写相机

| 原插件 | Web |
|---|---|
| `document.CurrentViewpoint.CreateCopy()` → 改 Position / AlignDirection / AlignUp → `_view.CopyViewpointFrom(vp, ViewChange.JumpCut)` | 直接写 `camera.position`，用 `camera.lookAt(position + frame.forward)` 定朝向 |
| 「无变化则不写回」（避免与宿主争相机） | **保留**：无移动、无转视角、无缩放时直接 return，不做多余写入 |
| `JumpCut` 绕过碰撞/重力/插值 | Three.js 侧本来就没有这三者，**无需对应物** |
| 写回后回读校验（`VIEW_WRITE_FIRST` / `VIEW_WRITE_NOT_APPLIED` 诊断） | 不需要（我们是唯一写入者） |

### 6.4 滚轮 Zoom：明确取舍

原插件的滚轮流程是**先放行给 Navisworks 原生 Zoom**（`return false`），
只有在"回读发现原生没改相机"时才回落到视场角公式（README：「若原生行为未接管则自动使用视场角 Zoom」）。

Web 侧的对应关系：

1. **原生 Zoom 通道不存在**。原生推拉在 Web 里对应 OrbitControls 的 dolly，但 §8 要求
   Game 模式下两个控制器不得同时响应输入 → OrbitControls 必须 `enabled = false`，
   它的 wheel 监听会直接 return。
2. 因此本版**直接采用原插件的回落公式作为唯一实现**：`fov ×= 0.9^notches`，clamp 到 `[10°, 100°]`。
   这是**照抄源码里的现成算法**，不是新设计。
3. 代价（如实记录）：从 50° 缩到 10° 约 5 倍放大后到顶；它不像推拉那样移动相机位置。
   换来的是：游戏模式下相机位置只由 WASD 决定，不出现"滚轮把相机推进墙体/推到模型外"，
   也不会与 `controls.target` 语义打架。
4. 浏览器 `deltaY` 的归一化：`deltaMode=0`(pixel) 按 `/100`、`deltaMode=1`(line) 按 `/3`
  换算成"格"，再套原式的 `clamp(raw, -8, +8)`；这样 Chrome 与 Firefox 的滚轮手感一致。
5. 若日后确认想要推拉手感：只需把 `EngineeringNavigation.applyPendingZoom()` 里的 FOV 分支
   换成沿 `frame.forward` 平移，其余不受影响（在代码里已标注）。

### 6.5 焦点处理

| 原插件 | Web |
|---|---|
| `IsNavisworksForeground()`（`GetForegroundWindow()` 比对主窗口句柄），每帧检查 + `MouseMove`/定时器里都查 | `window.blur` / `window.focus` / `document.visibilitychange` |
| 失焦 → `Pause('focus')` | 失焦 → `pause('focus')`：清空按键、释放 Pointer Lock、隐藏准星；**保持游戏模式**
| 重新切回 + 单击三维场景 → `ResumeCapture` | 重新切回**不会**自动锁指针（浏览器规定 Pointer Lock 必须由用户手势触发）→ 必须再点一次 3D 视图 |
| `MouseLeave` 也 Pause | **不移植**（§7.5） |

额外一条 Web 专属：指针锁定**被浏览器自己解除**有两种情形——用户按 Esc（→ 退出导航）
与窗口失焦（→ 只是暂停）。用 `intentionalExit` 标志区分我们自己调用的释放。
另外 Chrome 在 Esc 后有约 1.25 s 的重新加锁冷却，`requestPointerLock()` 的 Promise 会被拒绝——
按"捕获失败"提示用户再点一次，不静默失败。

---

## 7. 明确不移植的 Navisworks workaround

| # | 原插件代码 | 它解决的问题 | 为什么不移植 |
|---|---|---|---|
| 7.1 | `DetachIme()` / `RestoreIme()`（`ImmAssociateContext(mainWindow, 0)`） | IME 接管键盘后宿主只上报 `VK_PROCESSKEY(229)` | 浏览器键盘事件不受 Windows IME 影响：`e.code`（`KeyW`）与 `e.key` 在 IME 组合态下仍可用；组合态的 `keydown` 会被 `e.isComposing` 标记，而中文输入只在页面有输入框时发生（本项目仅设置面板有数字框，已单独屏蔽） |
| 7.2 | `NavigationKeyboardInterceptor` 的 `SetWindowsHookEx` / `HwndSource` 钩子（预吞按键） | Navisworks 把 `W` 当菜单加速键吞掉 | 浏览器没有宿主加速键。`keydown` 就是最上游 |
| 7.3 | `VkProcessKey = 0xE5` 的判定与 `KEY_IME_PROCESSKEY` 日志 | 同上 | 同上 |
| 7.4 | `OnToolChanged` → `TryReclaimTool()`、`ToolReclaimWindowMilliseconds=5000`、`MaximumToolReclaims=25`、`IsNavisworksNavigationTool()` 的 30 个枚举分支 | Navisworks 会用自己的导航条/滚轮工具抢走当前工具，把导航会话拆掉 | 纯宿主概念。Web 里"工具"= OrbitControls，已用 `enabled` 开关确定性接管 |
| 7.5 | `MouseLeave` → `Pause('mouse-leave')`（并带 `MOUSE_LEAVE_IGNORED_CAPTURED` 判断） | 光标回拉自己触发了 `MouseLeave`，导致准星只在按住鼠标时出现 | Pointer Lock 下不存在 `mouseleave` 语义（指针被锁、不移动） |
| 7.6 | `RelativeMouseTracker` 的基线重取 / 回拉失败不重放 | `SetCursorPos` 被四舍五入或裁剪 | §6.1 |
| 7.7 | `GameNavigationToolPlugin` 的 `OverlayRender` / `RequestDelayedRedraw(OverlayRender)` | 在宿主叠加层画准星 | Web 用 DOM 元素（`#crosshair`） |
| 7.8 | `_metersToDocumentUnits` 的 `UnitConversion.ScaleFactor` | 模型单位可能不是米 | Web 固定为米 → 系数 1（§5.1） |
| 7.9 | `MouseDown` 里 `IsPaused` 时 `ResumeCapture` 的宿主前台校验 | `GetForegroundWindow` 判定 | 用 `document.hasFocus()` + Pointer Lock 状态代替 |
| 7.10 | `HostProbePlugin` / `FallbackAddInPlugins` / Ribbon XAML / `PackageContents.xml` / 部署脚本 | Navisworks 插件装载 | Web 无插件装载概念 |

**原则记录**：`复用行为和算法，不复用已经不存在的问题。` —— 上表 7.1–7.10 一律不写进 Web 代码，
避免把 Navisworks 的补丁带成 Web 的债务。

---

## 8. Web 侧新增的最小宿主适配（原插件没有、但 Web 必须有）

这些不是"重新设计导航"，而是"宿主接口替换"的必要产物，逐条登记：

| # | 事项 | 理由 |
|---|---|---|
| 8.1 | `Navigation Mode: Orbit / Game` 开关 + `controls.enabled` 互斥 | §8 要求；Orbit 保留原样不删 |
| 8.2 | Game 模式下屏蔽 `_pick`（点击选中）与 `F`（复位视角） | 原插件：导航时点击=捕获指针、不选模型；`F` 会改 `controls.target` 与相机位置，与导航争相机 |
| 8.3 | 退出 Game 时重算 `controls.target = position + forward × min(上次轨道距离, maxDistance)` | 否则 OrbitControls 会朝旧 target 做 `lookAt`，退出瞬间视角会突跳；取 `min(…, maxDistance)` 是为了避免 `update()` 的距离钳制把相机扯回来 |
| 8.4 | 渲染循环内二选一：`nav.update(dt)` **或** `controls.update()` | r160 的 `OrbitControls.update()` 每帧无条件 `object.lookAt(target)`，与游戏模式写朝向冲突 |
| 8.5 | 所有监听器**只注册一次**（页面生命周期），模式切换只改状态位 | 验收第 18 项：反复切换不得叠加监听 |
| 8.6 | 设置面板输入框获得焦点时忽略移动键 | 数字框里输入不能再驱动相机（Web 才有输入框） |
| 8.7 | 状态外露：`viewport` 上暴露 `navState()` / `setNavMode()` / `setNavSettings()` | 沿用本项目既有做法（`window.__viewer` 供自动化实测读取） |

---

## 9. 验收清单对照（18 项，逐条给判定手段）

| # | 验收项 | 判定方式 | 对应源码依据 |
|---|---|---|---|
| 1 | F8 开 / 关 | 触发 `keydown F8` 两次，读 `navState().mode` | README「F8」 |
| 2 | 点击 3D View 捕获鼠标 | 真实点击 canvas → `document.pointerLockElement === canvas` | README「单击一次即可捕获」 |
| 3 | 无限旋转、Pitch 不翻转 | 连续注入 `movementX`（含多圈），累计 yaw 无上限、`|pitch| ≤ 89°` | `TestPitchClamp` |
| 4 | 仰视/俯视 W/S 仍水平 | 设 pitch=+85°/−85° 后按 W，位移的 Y 分量 ≈ 0 | `TestForwardHasNoVerticalComponent` |
| 5 | W+D 正常 | 位移方向 = 水平前向与右向的角平分线，模长 = 5×dt | `TestCombinationNormalization` |
| 6 | W+Space 正常 | 同上，含竖直分量，模长不放大 | 同上 |
| 7 | W+D+Space 正常且不超速 | 三轴同按，位移模长 == 单轴位移模长（同 dt 下） | 同上 + §4.4 normalize |
| 8 | 双击 W 保持加速 | 两次 keydown 间隔 < 300 ms → 位移 = 3× | `TestDoubleTapSprint` |
| 9 | 松开 W 立即恢复 | keyup 后位移回 1× | `TestReleaseClearsSprint` |
| 10 | 滚轮 Zoom | `wheel` 事件 → `camera.fov` 变化且被钳在 10°–100° | §4.8 |
| 11 | Esc 立即退出 | 注入 Esc → `mode === 'orbit'` | `TestEscapeRoute` |
| 12 | 退出后选中正常 | 退出后点击模型 → `viewer.selected` 变化 | README 验收 7 |
| 13 | Alt+Tab 后不卡键 | 模拟 blur → `navState().axes` 全 0、`paused=true`；再 focus 且不点击，位移仍为 0 | README 验收 8 |
| 14 | 重新进入需重新捕获 | focus 后 `captured === false`，需点击 canvas | §6.5 |
| 15 | Hide / Isolate / Show All 正常 | 调用三个接口，`hiddenCount` / `visible` 变化正确 | §8.2 只屏蔽拾取，不动显隐 |
| 16 | Tree / Properties 正常 | 点击树节点 → 属性面板更新（不受导航影响） | §9 要求 |
| 17 | 连续导航 10 分钟不卡顿 | 自动脚本在 Game 模式持续输出输入，采样 FPS / draw calls / 内存 | 原 README 验收 9 |
| 18 | 反复 Orbit⇄Game 不叠加监听 | 循环切换 N 次，比对相机在"无输入"下的漂移量与监听器注册计数（用一次性探针统计） | §8.5 |

---

## 10. 未决与风险（如实记录，不掩盖）

| # | 事项 | 状态 | 处理 |
|---|---|---|---|
| 1 | 滚轮 Zoom 走 FOV 而非推拉 | **取舍已定，见 §6.4** | 若实测手感不对，改 `applyPendingZoom()` 一个分支即可 |
| 2 | Chrome Esc 后指针锁定有冷却（约 1.25 s） | 已知 | 捕获失败给出可重试提示，不静默失败 |
| 3 | 无头 Chromium 的 Pointer Lock 可用性 | **待实测** | 相机数学用注入 `movementX` 的等价路径验证；Pointer Lock 用真实点击验证，若环境不支持则如实在证据里标注为 NOT_TESTED |
| 4 | 焦点/失焦在自动化里难以真实重现 | 待实测 | 用 `page.evaluate` 派发 `blur`/`visibilitychange` 走真实事件处理链，并标注为"事件级复现"而非"OS 级 Alt+Tab" |
| 5 | 长时间（10 min）稳定性 | 待实测 | 由 `scratch/phase7a-verify.js` 的压力场景给出实测数字 |
| 6 | 原插件有 25 项核心单测，Web 侧目前无对应测试工程 | 待办 | 本阶段先用浏览器实测覆盖；如需长期维护，可把 §4 的数学函数抽成可在 Node 里跑的模块单测（**本阶段不做，避免越级**） |

---

## 11. 实施顺序（本文件之后的动作）

1. 新增 `viewer/js/navigation/navigationSettings.js`、`inputState.js`、`engineeringNavigation.js`。
2. 改 `viewer/js/viewer3d.js`：只做「创建 / 启用 / 停用 Navigation Controller」与模式互斥。
3. 改 `viewer/index.html` + `viewer/app.js`：模式开关、Navigation Settings、准星、提示文案、状态外露。
4. 浏览器实测 18 项，证据写入 `reports/evidence/phase7a-*.json` + 截图。
5. 出 `reports/phase7a-report.md`。

> 全程遵守：**行为与算法照抄，宿主接口替换，Navisworks 的补丁不带过来。**

---

## 12. 实施后的偏差记录（本文件产出之后补充）

实施与验收结果见 `reports/phase7a-report.md`。这里只登记"与原计划的差异"，供以后回看时对账。

### 12.1 行为偏差：0 处

键位、速度、加速倍率、双击窗口、俯仰钳制、组合归一化、焦点暂停、Esc 退出、滚轮方向
全部与原件一致，已用 22 项核心算法移植测试 + 18 项行为实测逐条验证（`reports/evidence/phase7a-verify.json`）。

### 12.2 实现路径的选择（4 处，均有理由）

| # | 原计划 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | 滚轮 Zoom 映射到 "Three.js camera FOV / 现有 Viewer zoom 机制" | 直接用原插件的**回落公式** `fov ×= 0.9^notches`（钳 10°–100°） | Game 模式下 OrbitControls 必须停用（§8 不让两个控制器同时响应），原生 dolly 通道不存在，于是把源码里现成的回落公式升为主实现。取舍写在 `phase7a-report.md` §5.3 |
| 2 | 不移植 Navisworks 的 focus 处理 | 用 `window.blur` / `focus` / `visibilitychange` + 每帧复核 `document.hasFocus()` | 后者对应原件在定时器里查 `IsNavisworksForeground()` 的兜底，属于行为保留 |
| 3 | Pointer Lock 等价于光标锚定 | **不传** `unadjustedMovement: true` | 原件的增量来自 `GetCursorPos()`（经 OS 指针加速），浏览器默认 `movementX` 同样经加速曲线 → 手感一致 |
| 4 | Game 模式使用移植后的导航控制器 | Game 模式下额外屏蔽 `F` 复位与射线拾取 | 两者都会与"导航独占相机 / 鼠标只控相机"冲突；已记入报告的共存表 |

### 12.3 原计划里"看情况"的判断结果

| 判断项 | 结论 |
|---|---|
| 单位是否需要换算 | **不需要**。GLB 世界单位 = 米 → `WORLD_UNITS_PER_METER = 1`，5 m/s 原样 |
| World Up | **+Y**，实现上从 `camera.up` 读（对应原件 `ReadWorldUp`），退化才回落 `(0,1,0)` |
| 未捕获时按 W 是否移动 | **会移动** —— 复核源码后确认这是原插件的行为（`IsPaused` 为假即写相机），照抄，并在验收项 14 里如实标注 |
| 原 `InputState` 是否要为了 Web 改接口 | **不用改**。原件的物理键盘轮询是宿主补丁，事件驱动的 `keyDown/keyUp` 才是它本来该有的用法 |

### 12.4 验收环境变更（非本阶段造成）

本轮实施期间，工作区被另一个并行会话改成了多项目资产布局（`data/projects/`、`tools/server.py`、
`viewer/js/assetManager.js`）。原 `data/processed/` 被移到 `data/_legacy_demo_2026-08-26/processed/`，
Viewer 改为先显示 Model Selector。因此验收脚本改为通过 `viewer.am.openVersion()` 打开

> `qichuang / main-site / 2026-09-18`

—— 与 Phase 7A 开始时使用的 `data/processed/` 是**同一份 QICHUANG RVM/TXT**（8,955 对象 / 7,420 映射）。
导航层代码本身未受这次重构影响（该并行改动保留并接入了本阶段的导航层）。

