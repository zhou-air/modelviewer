# 多选（Ctrl）与预选中（准星闪烁）— 实现说明与验收证据

**结论：两项都已完成，浏览器实测 24/24 通过、0 页面错误。**
证据：`reports/evidence/game-pick-multiselect-verify.json`、`reports/evidence/game-pick-shot.json`
截图：`reports/game-pick-hover-bright.png` / `-dim.png`、`-crop-bright.png` / `-crop-dim.png`、`reports/game-pick-multi-selected.png`

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| `viewer/js/viewer3d.js` | 选择从单值 `selected` 升级为**选择集 `selection:Set`**（`selected` 保留为"主选中 = 最近加入的那个"）；材质/描边改为按选择集上色；新增**预选中**：准星射线 + 共享浅蓝材质 + 每帧调制闪烁 |
| `viewer/js/navigation/engineeringNavigation.js` | `onCenterPick(opts)` 透传 Ctrl 标记（**这里曾把标记丢掉，见 §4**） |
| `viewer/js/navigation/inputState.js` | 已捕获时的左键带上 `{ additive: e.ctrlKey \|\| e.metaKey }` |
| `viewer/js/tree.js` | 新增 `setSelection()`（用 3D 选择集整体替换树的选择集）；Ctrl 移出一行时同时通知 3D 侧移出 |
| `viewer/app.js` | 3D ↔ 树 共用同一份选择集；徽标显示"N 个对象"；提示文案；实测接口 `selectionState()/hoverState()/selectAdditive()` |
| `scratch/game-pick-multiselect-verify.js` | 新增 E（3D Ctrl 多选）、F（准星多选 + 预选中）共 10 项；并把 `save()` 提升，避免加载阶段失败时吞掉原始错误 |
| `scratch/game-pick-shot.js` | 新增：抓预选中亮/暗两态截图，并用 `readPixels` 量化闪烁幅度 |

## 2. 行为规格

**多选（Ctrl）**

| 操作 | 结果 |
|---|---|
| 普通单击 / 准星左键 | 重置为单选 |
| **Ctrl+单击 / Ctrl+准星左键** | 该对象**加入**选择集；再次 Ctrl+点击 → **移出** |
| Ctrl+点击已选对象直到清空 | 全部取消（属性面板、树、徽标同步清空） |
| Ctrl+点击空白处 | **不动**已有选择集（手抖不会全丢） |
| 右键（游戏导航，已捕获） | 取消选中所有；树同步清空 |
| 树上 Ctrl+点击 | 与 3D 双向同一份选择集（加入/移出都联动） |
| 隐藏 / 隔离 / 复位（F） | 对**整个选择集**生效（多选后隐藏全部、隔离全部、框住全部） |
| 属性面板 / 徽标 | 显示主选中（最后加入的那个）；多选时徽标显示"（共 N 个对象 · Ctrl+点击增删）" |

**预选中（准星指向）**

- 生效条件：游戏导航 **且** 准星可见（已捕获 + 窗口有焦点 + 未暂停），Orbit 模式不产生预选中。
- 命中判定与拾取共用一条射线路径（`_hitAtNdc` / `_resolveAtNdc`），准星固定在屏幕中心 NDC(0,0)。
- 表现为浅蓝高亮 + 闪烁（当前 **0.3 次/秒**；亮暗两态的颜色与自发光同时被调制，峰值只短暂掠过）。
- 选中态优先：准星指到已选中的对象时不再叠加预选中。
- 隐藏件不参与预选中（准星会直接落到它后面的可见件上）。
- 预选中**绝不改动**选择集。
- 释放鼠标捕获（Esc/失焦）→ 预选中立即清除；切回 Orbit 同样清除。

**闪烁参数（都在 `viewer/js/viewer3d.js` 顶部 57–68 行，改完刷新页面即可）**

| 常量 | 当前值 | 作用 |
|---|---|---|
| `HOVER_BLINK_HZ` | `0.3` | 每秒闪烁次数 |
| `HOVER_PEAK_SHARPNESS` | `2.2` | 波形次幂，>1 = 峰值更尖、亮态停留更短 |
| `HOVER_EMISSIVE_DIM` / `_PEAK` | `0.0` / `0.85` | 暗态与亮态的自发光强度 |
| `HOVER_MESH_DIM` / `_PEAK` | `0xa4bacd` / `0xd6e7f5` | 暗态与亮态的网格基色 |
| `HOVER_LINE_DIM` / `_PEAK` | `0x6b7f90` / `0xbcd9ee` | 线条同上 |
| `HOVER_POLL_MS` | `60` | 准星射线重算间隔（与闪烁快慢无关） |

## 3. 验收证据

`game-pick-multiselect-verify.js` 24/24（真实 Pointer Lock，非 shim）：

| 项 | 断言要点 | 结果 |
|---|---|---|
| C1–C3 | 默认游戏导航、树点击不改模式、Esc 后模式保持 | PASS |
| A1–A4 | 树 Ctrl 多选/移出/重置单选、点父项不展开 | PASS |
| B1–B4 | 准星拾取、右键清空、未捕获右键不动作、Orbit 拾取不受影响 | PASS |
| D1–D3 | 复位不瞬移、残留键不自动移动、重捕获不漂移 | PASS |
| **E1** | 普通单击 a → 单选；Ctrl+单击 b → `count=2`、两件都在、`outlineObjects=2`、树 2 行高亮 | PASS |
| **E2** | 再 Ctrl+单击 a → `count=1`，只剩 b | PASS |
| **E3** | 普通单击 → 重置单选 | PASS |
| **E4** | 树 Ctrl 多选两个 → 3D 选择集同步为 2（`canonicals` 与树两行一一对应） | PASS |
| **F1** | 准星指向实体 → 该实体换上 hover 材质，自发光在一个闪烁周期内 0 → 0.84（≈满量程）再回落（span 0.842） | PASS |
| **F2** | 释放捕获 → `enabled=false`、`canonical=null` | PASS |
| **F3** | 预选中不改选择集（选中 b 时 hover 为 a，选择集仍只有 b）；隐藏 a 后 hover 不再是 a，且新目标不在隐藏子树里 | PASS |
| **F4** | 游戏导航 Ctrl+左键准星拾取 → `count` 1→2（b 保留 + a 加入） | PASS |
| **F5** | 右键 → 3D 与树两侧都清空 | PASS |
| **F6** | Orbit 模式无预选中 | PASS |

**闪烁强度与波形（量化，`game-pick-shot.js`）**
在渲染帧内直接 `gl.readPixels` 取准星中心 6×6 平均色，采样窗口 = 1.15 个闪烁周期（频率是用户可调项，脚本按 `1/blinkHz` 自动定窗）：

```
亮态 RGB ≈ [203,216,230]   暗态 RGB ≈ [162,178,190]   亮度摆幅 ≈ 38.8 / 255
自发光一个周期内的走势（32 点）：0 → 0 → 0.02 → 0.07 → 0.15 → 0.27 → 0.44 → 0.62
   → 0.75 → 0.84(峰) → 0.76 → 0.63 → 0.46 → 0.30 → 0.15 → 0.06 → 0 → 0 …
```

38.8 个灰阶的往复变化依然一眼可见，但峰值明显比初版柔和（初版 ≈50/255，且亮态颜色接近纯白）。
波形是**不对称**的：长时间贴地、峰值只掠过一下 —— 32 个采样点里只有 2 个点落在峰值 95% 以上。

### 3.1 调参记录（2026-09-20 下午）

| 项 | 调整前 | 调整后 |
|---|---|---|
| 频率 `HOVER_BLINK_HZ` | 2.4（后由用户手动改为 0.3） | 0.3（保持用户值） |
| 峰值自发光 `HOVER_EMISSIVE_PEAK` | 1.60 | **0.85** |
| 峰值基色 `HOVER_MESH_PEAK` | `0xf6fbff`（近白） | **`0xd6e7f5`**（柔和浅蓝） |
| 峰值线条色 `HOVER_LINE_PEAK` | `0xd2eafd` | **`0xbcd9ee`** |
| 波形 | `smoothstep(t)`（两端各停留很久） | **`t^2.2`**（新增 `HOVER_PEAK_SHARPNESS`） |

"峰值附近停留时间"的量化（在 0.3 次/秒、一个周期 3.33 s 下）：

| 阈值 | smoothstep | t^2.2 | 变化 |
|---|---|---|---|
| 亮过一半（v ≥ 0.5） | 1.67 s / 周期 | 0.90 s / 周期 | −46% |
| **峰值附近（v ≥ 0.85）** | **0.81 s / 周期** | **0.24 s / 周期** | **−70%** |

截图对照：`game-pick-hover-crop-bright.png` vs `-crop-dim.png`（准星周围 180×180 裁切，用 PIL 量中心 60×60 平均亮度 = 197 / 164）。
（更早的初版只压了自发光、不压基色，摆幅只有十几个灰阶，等于看不出在闪 —— 那次也是实测量出来的。）

## 4. 实测抓到的一个真 bug

E4/F4 首轮 FAIL，`additive` 标记在**中间层被吞掉**：

```
inputState._onPointerDown → onCenterPick({additive}) → engineeringNavigation 里写成 () => onRequestCenterPick?.()
```

箭头函数没接参数 → `viewer3d` 收到的永远是 `undefined` → 游戏导航里的 Ctrl 多选表现为"替换单选"。
已改为 `(opts) => onRequestCenterPick?.(opts)`，F4 由 FAIL 转 PASS。

## 5. 性能取舍

- 预选中射线**节流 60 ms**（≈16 Hz）；相机静止且场景无变化时**完全跳过**（比相机位姿签名），空闲时零开销。
- 闪烁只改共享材质的 uniform（颜色/自发光强度），不重建材质、不重编译着色器。
- 只在"准星目标变了"时才重画材质（`_setHover` 同值早退）。
- 材质替换台账从数组改成 `Map`（`obj → 原材质`）：父子节点同时选中时同一 mesh 会出现两次，数组会把原材质记错。
- 命中判定改为沿父链查可见性 —— three.js r160 的 `Raycaster` **不跳过** `visible=false` 的节点，否则隐藏件仍能被准星拾取/预选中（顺带修掉一个存量隐患）。
- 注意：把整个 SITE 之类的大节点选进来时，描边对象可达数千个（实测 5796）。描边在交互期间本来就会自动暂停，未加数量上限。

## 6. 已知限制 / 未做

1. **Orbit 模式没有鼠标悬停预选中** —— 只做了你要求的"游戏导航光标对准实体"。要的话可以按同样的材质机制补鼠标 hover。
2. **闪烁是"浅蓝脉冲"，不是硬开关式的闪** —— 想更刺眼就把 `HOVER_PEAK_SHARPNESS` 往上调（3 以上接近硬开关）、或把 `HOVER_EMISSIVE_PEAK`/`HOVER_MESH_PEAK` 提回去；常数都在 `viewer3d.js` 顶部 57–68 行。
3. **游戏导航中按住 Ctrl 时别按 W** —— 浏览器会执行 Ctrl+W 关闭标签页，页面无法拦截。多选也可走左侧模型树（Ctrl+点击），那条路径没有这个风险。
4. 多选后属性面板只显示主选中；没有做多对象属性对比/汇总。
5. 选区没有跨模型持久化 —— 切换版本会清空（沿用既有行为）。

## 7. 与并行会话的相处（两次实测）

**第一次（本功能落盘期间）**：`viewer3d.js` / `edgeLinesPass.js` / `app.js` / `index.html` 出现了一组我没写过的改动（元件轮廓线 + 隐藏件半透明 ghost 外观选项），并且是基于我的版本继续编辑的。对方沿用了我加的 `selection` / `hover` / `_swapped` 结构，高亮优先级定成「ghost > 选中 > 预选中」。**两边可共存**，最后一次 24/24 就是在合并后的文件上跑的。

**第二次（同日傍晚，只在验收脚本侧）**：对方把**批量渲染**接成了默认路径（`load()` 里自动 `enableBatchRendering()`，源 mesh 统一被设成 `visible=false`，几何进合并批组，`faceIndex → canonicalId` 由 `BatchRenderingManager.resolveHit` 解）。这会**静默打断验收脚本**：

- 脚本里自己写的 `raycaster.intersectObject(root, true)` 预检全部失效（源 mesh 已被隐藏，命中判定过不去），于是"瞄准"和"实际拾取"对不上 → B1–B4/F3 连锁假失败；`_solidInScene(mesh)` 也一律返回 false（它沿链会读到源 mesh 的 `visible=false`）。
- 修法是把验收脚本的瞄准/命中全部改走**生产入口** `model._resolveAtNdc(0,0)`，判"是否隐藏"改用 `model._inHiddenChain(node)`（按 canonical 判，与渲染口径一致）。改完 22/24 → **24/24**。
- 教训：**验收脚本只要自己实现了一遍拾取/可见性判定，就一定会跟生产路径漂移。**

其他提醒：动过 `tools/*.py` 后必须重启 8765 后端进程；本次只改了 `viewer/**` 前端与 `scratch/**`，**不需要重启后端**，刷新页面即可（浏览器缓存建议 Ctrl+F5）。同一目录若长期有第二个会话在写，建议错开时间——整文件覆盖写会无声丢掉对方改动。
