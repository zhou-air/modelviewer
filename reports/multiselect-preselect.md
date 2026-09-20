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
- 命中判定与拾取共用一条射线路径（`_resolveAtNdc`），准星固定在屏幕中心 NDC(0,0)。
- 表现为浅蓝高亮 + 闪烁（约 2.4 次/秒，亮暗两态颜色与自发光同时调制）。
- 选中态优先：准星指到已选中的对象时不再叠加预选中。
- 隐藏件不参与预选中（准星会直接落到它后面的可见件上）。
- 预选中**绝不改动**选择集。
- 释放鼠标捕获（Esc/失焦）→ 预选中立即清除；切回 Orbit 同样清除。

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
| **F1** | 准星指向实体 → 该实体换上 hover 材质，自发光在 0.02↔1.50 间连续采样到全量程摆动（span 0.994） | PASS |
| **F2** | 释放捕获 → `enabled=false`、`canonical=null` | PASS |
| **F3** | 预选中不改选择集（选中 b 时 hover 为 a，选择集仍只有 b）；隐藏 a 后 hover 不再是 a，且新目标仍是可见实体 | PASS |
| **F4** | 游戏导航 Ctrl+左键准星拾取 → `count` 1→2（b 保留 + a 加入） | PASS |
| **F5** | 右键 → 3D 与树两侧都清空 | PASS |
| **F6** | Orbit 模式无预选中 | PASS |

**闪烁是否"看得见"（量化，`game-pick-shot.js`）**
在渲染帧内直接 `gl.readPixels` 取准星中心 6×6 平均色，连续 16 次采样：

```
亮态 RGB ≈ [218,227,238]   暗态 RGB ≈ [161,178,190]   亮度摆幅 ≈ 50 / 255
```

50 个灰阶的往复变化是很明显的闪烁。截图对照：`game-pick-hover-crop-bright.png`（近白浅蓝）vs `-crop-dim.png`（接近模型灰）。
（初版只压了自发光、不压基色，摆幅只有十几个灰阶，等于看不出在闪 —— 已按实测把暗态压到接近模型灰。）

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
2. **闪烁是"浅蓝脉冲"，不是硬开关式的闪** —— 想更刺眼可以把 `HOVER_BLINK_HZ`（现在 2.4）与两态颜色/自发光常量直接调；位置都在 `viewer3d.js` 顶部。
3. **游戏导航中按住 Ctrl 时别按 W** —— 浏览器会执行 Ctrl+W 关闭标签页，页面无法拦截。多选也可走左侧模型树（Ctrl+点击），那条路径没有这个风险。
4. 多选后属性面板只显示主选中；没有做多对象属性对比/汇总。
5. 选区没有跨模型持久化 —— 切换版本会清空（沿用既有行为）。

## 7. ⚠️ 需要你知道的一件事：这个目录当时有**第二个会话在同时写**

本次改动落盘期间，`viewer/js/viewer3d.js`、`viewer/js/edgeLinesPass.js`、`viewer/app.js`、`viewer/index.html` 出现了一组**我没有写过的**改动（元件轮廓线 + 隐藏件半透明 ghost 外观选项），并且是在我改完 `viewer3d.js` 之后基于我的版本继续编辑的。也就是说**另一个会话正在同一个工作区里并行开发**。

- 目前两边是可共存的：对方的 `_applyHighlight()` 按「ghost（隐藏件半透明）> 选中（橙）> 预选中（浅蓝闪）」排优先级，沿用了我的 `_swapped` / `selection` / `hover` 结构；我最后一次实测就是在这个合并后的文件上跑的（24/24、0 页面错误）。
- 但仍建议**同一时间只让一个会话写这个目录**：并行写同一个文件时，任何一方用整文件覆盖写入都会静默丢掉另一方的改动，而且这种丢法不会报错。
- 另外提醒：动过 `tools/*.py` 后必须重启 8765 后端进程；本次只改了 `viewer/**` 前端与 `scratch/**`，**不需要重启后端**，刷新页面即可（浏览器缓存建议 Ctrl+F5）。
