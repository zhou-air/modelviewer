# Phase 5 — Viewer MVP 交互

- 状态：**已完成**，浏览器实测通过（无 pageError、无 console 错误）
- 日期：2026-09-18
- 产物：`viewer/` 三栏界面（模型树 / 3D / 属性），`start.bat` 一键启动

---

## 1. 结论

Selection、Visibility、模型树双向联动、选中描边全部实现并实测通过。数据链路（Phase 2 几何 + Phase 3 元数据 + Phase 4 映射）在界面上完整跑通：点击一个对象，右侧能同时看到它的 **PDMS 属性**、**GLB 节点序号**、**RVM 字节偏移**。

性能上有一项需要交代的取舍，见 §4：**描边会把绘制量翻倍（空闲 30 FPS），所以按任务书允许的方式在拖动期间暂停描边，恢复后回到 61 FPS。**

---

## 2. 功能验收

| 功能 | 实测结果 |
|---|---|
| 加载 | 页面到就绪 **719–796 ms**（含 10.4 MB JSON + 18 MB GLB） |
| 命名节点 / 网格 / 线 | 7,423 / 5,507 / 289（与 Phase 4 的 GLB 计数一致） |
| **Selection** | **真实鼠标点击**（打在对象投影位置上）命中成功；射线取最近物体——测试点在楼板后方时正确命中了前面的楼板 |
| 高亮 | 选中对象呈琥珀色发光 + 空闲时叠加描边 |
| 属性面板 | 概览 / **几何对应** / PDMS 属性 / OLD 引用属性 四段；几何对应里含 GLB 节点序号、**RVM 字节偏移**、txtId、匹配通道、几何构成、世界包围盒 |
| **树 → 3D** | 点树行 → 3D 选中 + 属性同步（实测点 SITE 行 → 属性显示「SITE · 15 个子节点」） |
| **3D → 树** | 点 3D 对象 → 树自动展开祖先链并高亮对应行、滚动到可见位置 |
| 无几何节点 | 灰显、可点、属性完整；不会误改 3D 选中 |
| **Hide Selected** | 可见 7,420 → 7,419 |
| **Isolate Selected** | 可见 7,420 → **5**（自身 + 祖先链：SITE→ZONE→PIPE→BRANCH→对象） |
| **Show All** | 恢复到 7,420 |
| 按钮状态 | 无 3D 选中时 Hide/Isolate 禁用；无隐藏项时 Show All 禁用 — 实测三态均正确 |

截图：`reports/phase5-selected.png`（全模型视野）、`phase5-selected-closeup.png`（缩放到选中）、`phase5-isolated.png`（隔离态）

### 2.1 一处需要说明的"看起来不对"的现象

隔离一个 **GASKET**（本身没有几何）后，画面里仍显示一整条管段。这**不是 bug**：

`/WG-10401-400-L1G/B2` 这个 BRANCH **自身带 10 块管段几何**（17 个子组另有 41 块）。隔离时保留的是「自身 + 祖先链」，所以 BRANCH 的直管段保留、17 个兄弟元件（弯头/法兰/阀门）被隐藏。画面里正是一条**没有管件的干净管段**——符合预期。

---

## 3. 模型树

- 数据来自 `metadata.json`，是 TXT 的**完整 8,955 个对象 / 8 层**，不是从 GLB 反推的（GLB 只有 7,420 个几何组）。
- **懒展开**：只渲染已展开部分（实测初始渲染 61 行、展开 4 个节点）。
- 灰显 = 该对象在 TXT 中有、但 RVM 未导出几何（1,535 个），仍可查看属性。

---

## 4. 性能：描边的真实代价与取舍

| 场景 | FPS | 场景 draw calls | **全帧 draw calls（含所有后期 pass）** |
|---|---|---|---|
| 全模型视野、无选中 | 45–50 | 5,796 | — |
| 选中 + 描边开启（空闲） | **30** | 4,097 | **8,202** |
| 选中 + **拖动中（描边暂停）** | **61** | 3,621 | 3,622 |

（场景 calls 不同是因为相机已缩放到选中对象，视锥剔除后可见网格变少）

**结论**：
- `OutlinePass` 要把场景再渲染进深度/边缘缓冲，**全帧绘制量几乎翻倍**（4,097 → 8,202），空闲 FPS 从 ~45 掉到 30。
- 按任务书「移动/旋转时降低效果或暂时关闭，停止后恢复高质量」的做法，在相机交互期间 `outline.enabled = false`，**拖动中回到 61 FPS**，停下 160 ms 后自动恢复描边。
- 为避免"拖动时选中对象凭空消失"，另加了一层**常驻的发光高亮**（换材质实例，零逐帧开销）。

这个处理与任务书的视觉要求是一致的；如果将来更看重空闲清晰度而不是拖动流畅度，可以把描边常开——**数据已经在这里，改一行开关即可**。

---

## 5. 修掉的 2 个问题

### 5.1 three.js 的 GLTFLoader 会清洗节点名（重要）

实测发现：`object.name` **不等于** glTF 里的原始名。`GLTFLoader` 内部调用 `PropertyBinding.sanitizeNodeName()`：

| glTF 原始名 | `object.name` |
|---|---|
| `/MDBs` | `MDBs` |
| `TEE 1 of BRANCH /WG-10401-400-L1G/B2` | `TEE_1_of_BRANCH_WG-10401-400-L1G-B2` |
| `data/source/….rvm` | `datasource…rvm` |

规则是**去掉 `[ ] . : /`、把空白换成下划线**。而且它还会给无名 mesh 自动起 `mesh_N` 名字。

**修正**：改用 `GLTFLoader` 保留在 `node.userData.name` 里的**原始名**建索引，并且只索引带 `userData.name` 的节点（正好 7,423 个，与 Phase 4 一致）。

> 这条直接推翻了我上一阶段结尾的判断（当时说"用 `object.name` 建表最稳"）。**名字确实是主键，但要取 `userData.name`，不是 `object.name`。**

### 5.2 `renderer.info` 被最后一个 pass 覆盖

引入 `EffectComposer` 后，`renderer.info.render.calls` 读到的是**最后一个 pass**（`OutputPass` 的全屏四边形 = 1 次绘制），看起来像"整个场景只有 1 个 draw call"。

**修正**：在 `RenderPass` 执行完的那一刻读一次作为「场景本身」的计数；同时关闭 `info.autoReset` 并每帧手动 `reset()`，从而也能得到**全帧所有 pass 的合计**。§4 的两列数字就是这么来的。

---

## 6. 文件结构

```
viewer/
├─ index.html            三栏布局 + 覆盖层
├─ app.js                装配：数据 / 3D / 树 / 属性 接线，工具条，对外状态
├─ js/
│  ├─ data.js            加载并索引 metadata / mapping / rvm-node-index
│  ├─ viewer3d.js        场景、加载、拾取、高亮、显隐、视图适配、统计
│  ├─ tree.js            懒展开模型树 + 双向联动
│  └─ props.js           属性面板（含几何对应信息）
└─ vendor/               three.js r160 本地副本（含 postprocessing / shaders）
```

三层解耦保持：Viewer 只读 `data/processed/` 的产物，不碰 RVM/TXT 解析逻辑。

---

## 7. 已知限制

| 项 | 说明 |
|---|---|
| 描边在交互期间暂停 | 见 §4。这是性能取舍，不是缺陷；开关在 `viewer3d.js` 一行 |
| 属性面板未做搜索/过滤 | 单个对象的属性最多十几条，暂不需要 |
| 未做剖切 / 测量 / 楼层视图 | 不在 MVP 范围（任务书明确排除） |
| 未做移动端适配 | 任务书明确排除 |
| 树未做虚拟滚动 | 8,955 节点靠懒展开控制 DOM 规模；实测渲染 61 行 |

---

## 8. 产物与证据

| 内容 | 路径 |
|---|---|
| Viewer | `viewer/index.html` · `viewer/app.js` · `viewer/js/*.js` |
| 实测脚本（可复跑） | `scratch/phase5-verify.js` |
| 实测原始数据 | `reports/evidence/phase5-verify.json` |
| 截图 | `reports/phase5-selected.png` · `phase5-selected-closeup.png` · `phase5-isolated.png` |

复现：

```bash
python tools/serve.py --port 8765            # 或直接双击 start.bat
NODE_PATH=<node-workspace>/node_modules node scratch/phase5-verify.js
```

---

## 9. 下一步：Phase 6 — Performance

现在功能齐了，Phase 6 要把性能测成一份可对比的基准 `reports/benchmark.md`，记录：

- 原始 RVM 体积、GLB 体积、metadata/mapping 体积
- RVM object count / mesh count / triangle count / draw calls
- initial load time（分段：JSON 解析、GLB 加载、首帧）
- approximate FPS（分场景：空闲 / 拖动 / 选中 / 隔离）
- 浏览器内存（`performance.memory` 可得）

并与 Navisworks / Autodesk Viewer / xeokit+XKT（已有 Phase 2 的实测数据）做对照。
