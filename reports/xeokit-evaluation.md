# xeokit-sdk 套用评估

- 状态：**已实测评估完成**，结论为「暂不切换，保留为 Phase 7 候选」
- 日期：2026-09-18
- 评估对象：`xeokit/xeokit-sdk` v2.6.114 + `@xeokit/xeokit-convert` v1.3.2
- 实测环境：同一台机器、同一模型、同一浏览器（Chromium 1208，实体 GPU RTX 4060 / D3D11）、同一视口 1600×900、同一 rAF 统计口径
- 说明：本次为**隔离实验**（全部产物在 `scratch/xeokit/`），未替换 Phase 2 的 three.js Viewer

---

## 1. 结论先行

| 判断 | 内容 |
|---|---|
| 技术上能否套用 | **能，但不够用**。渲染与性能远超预期，可是**PDMS 层级被拍平、对象类型丢失、线几何全丢**，正是本 MVP 的核心验收项 |
| 是否现在切换 | **不切换**。see §5 |
| 最大障碍 | **许可证 AGPL-3.0**（不是技术）——与「以后做成客户可用的 Viewer」直接冲突 |
| 建议定位 | Phase 7 候选，触发条件见 §6 |

---

## 2. 许可证（先看这条）

**已确认（读原文 + npm 注册表双重核对）**：

| 项 | 值 |
|---|---|
| `@xeokit/xeokit-sdk` | `version 2.6.114`，`license **AGPL-3.0**` |
| `@xeokit/xeokit-convert` | v1.3.2，LICENSE 文件同样是 **AGPL-3.0** |
| 双许可 | 是。闭源/专有用途需向 Creoox 购买商业许可（`contact@creoox.com`） |

AGPL-3.0 第 13 条原文要点：

> "if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network ... an opportunity to receive the Corresponding Source of your version"

**对本项目的实际含义**：只要哪天把 Viewer 部署成「别人通过网络访问」的服务（哪怕是内网给同事用、给客户看模型），就必须把整套集成代码按 AGPLv3 开源，或者买商业许可。

对比现状：three.js 是 **MIT**，`cdyk/rvmparser` 是 **MIT**，整条链路目前没有任何 copyleft 义务。

> 个人本机验证阶段用 AGPL 软件没有法律问题；问题是它**不能作为将来交付给客户的产品底座**，除非买许可。

---

## 3. 技术实测结果

### 3.1 转换链路

```
RVM (4.30 MiB)
  └─ rvmparser (MIT) ────────► model.glb  17.5 MiB ／ 339 ms
       └─ convert2xkt ───────► model.xkt   8.9 MiB ／ 1.66 s（压缩比 2.02）
```

`convert2xkt` 日志（XKT v12）：drawable objects **7423**、geometries **5507**、triangles **335824**、vertices 371131、tiles 3。

> 对照 GLB：335,824 三角形完全一致 → **三角形没有丢**。
> 但 GLB 里是 5507 个三角面 mesh + **289 个线图元**；XKT 只转了 **5507 个三角面几何，289 个线图元全部未转换**（日志里 7 条 `Parameter expected for 'lines' primitive: params.indices`，几何计数里没有线）。

### 3.2 逐项对比

| 指标 | three.js + GLB（现有） | xeokit + **XKT** | xeokit + **GLB 直载** |
|---|---|---|---|
| 页面→就绪 | 1013–1475 ms | **644–881 ms** | 1433–1483 ms |
| 模型加载耗时 | — | **275–292 ms** | 1110–1141 ms |
| **draw calls / 帧** | **5796** | **6** | **1** |
| **FPS（连续旋转 4 s，同口径）** | **55** | **180** | 180 |
| metaObject 数 | 由我们自建 | 5508 | **0** |
| 对象名称 | 1157 + 6264（全） | 5508（名称正确） | **无** |
| **层级深度** | **8 层（完整）** | **1（拍平）** | **0** |
| **对象类型** | 可从名称前缀取 | **全部 `Default`** | 无 |
| 线几何 | 289 条 | **0** | 0（报错丢弃） |
| 内置工程功能 | 需自建 | TreeView / SectionPlanes / Distance+AngleMeasurements / StoreyViews / NavCube / BCF | 同左（但无数据） |
| 控制台 | 0 错误 | 1 warning | **40 errors** |
| 许可证 | MIT | **AGPL-3.0** | **AGPL-3.0** |

### 3.3 关键问题：层级被拍平

```
XKT 路径 metaScene：
  metaObjectCount 5508   roots 1   named 5508
  maxDepth 1
  depthHistogram { "0": 1, "1": 5507 }
  typeCountTop  [["Default", 5508]]
  depth2Examples []          ← 没有任何第二层
```

对象名是对的（`FLANGE 1 of BRANCH /WG-10401-400-L1G/B2` 原样保留），但：

- **555 个有几何的容器组、以及 SITE / ZONE / PIPE / BRANCH 这些父级，全部没有变成对象**；
- 5507 个有几何的叶子对象**全部挂在合成根 `default` 下**；
- **对象类型全变成 `Default`**，PDMS 类型信息丢失。

`TreeViewPlugin` 能正常渲染，但树是一层平铺的 5507 项 —— 这直接违反本项目 MVP 验收第 3 条（保留并恢复 PDMS 对象层级）与第 6 条（能看到 SITE/ZONE/PIPE/BRANCH 层级）。

**GLB 直载更差**：`metaObjectCount = 0`，没有任何树和属性可言；另有 40 条控制台错误（线图元被拒 + `Mesh with this ID not found`）。

### 3.4 数值可信度说明（重要）

第一轮我读到「draw call = 6、FPS = 180」时**没有直接采信**，因为它可能只是「模型没画出来」。核对过程中发现并修掉了三个会让数字失真的问题：

1. 我把 `NavCubePlugin` 画进了主 canvas，绿色 "FRONT" 方块**遮住了整个模型**；
2. `cameraFlight.flyTo()` 没生效，相机停在 `(0,0,10)` —— **在模型内部**，什么都看不到；
3. xeokit 是**按需渲染**：空转帧几乎不发 draw call，所以空转的 "180 FPS" 与 three.js 的 "55 FPS"（每帧都渲染）**不可比**。

修正后：相机显式摆到模型外并回读校验；GL 绘制调用改为**在创建 Viewer 之前包住 `WebGLRenderingContext.prototype.draw*`**（原型级，最可靠）；性能改用**连续旋转 4 s** 的压力测量。

最终有效数据：

```
XKT 压力测试：frames 721 / 4005 ms → 180 FPS，draw calls 4320 → 每帧 5.99
GLB 压力测试：frames 721 / 4003 ms → 180 FPS，draw calls  720 → 每帧 0.999
three.js（Phase 2）：3 s 实测 55 FPS，draw calls 5796/帧
```

**公平性保留**：xeokit 的着色管线比我 three.js 那套（PBR StandardMaterial + ACES tone mapping + 4 盏灯）简单得多，**FPS 差距里有一部分来自着色开销，不能全部归功于批处理**。draw call 数量的对比才是干净的（6 vs 5796）。

### 3.5 未完成的一处

**未能在 xeokit 侧把材质改成统一灰色**：`model.materials` 为空对象、`SceneMesh.material` 为 `undefined`（5507 个 mesh 全部如此）——v2 的材质入口我没找到，因此 xeokit 侧截图仍是 **RVM 的真实材质（黑）**。

这**只影响视觉对比**（three.js 那边我按决定统一覆盖成灰色），**不影响** draw call、FPS、层级这三项结论。顺带印证了一件事：颜色必须在转换侧或 viewer 侧显式处理，两边都一样。

---

## 4. 修复路径（如果将来要走 xeokit）

`convert2xkt` 提供 `-m, --metamodel <file>`，格式已从源码 `parseMetaModelIntoXKTModel.js` 读到：

```json
{
  "projectId": "...", "revisionId": "...", "author": "...",
  "metaObjects":    [ { "id": "...", "name": "...", "type": "...", "parent": "..." } ],
  "propertySets":   [ { "id": "...", "name": "...", "type": "...",
                        "properties": [ { "name": "...", "value": "..." } ] } ]
}
```

**关键可行性**：XKT 里几何对象的 id 就是 glTF 节点名，也就是我们的 PDMS 名称。只要 metamodel 用同名 id，就能被正确关联上 —— 层级和类型都能补回来。

**而这正是 Phase 3 / Phase 4 本来就要产出的数据**（TXT parser → metadata.json，映射层 → mapping.json）。换句话说：

> 套用 xeokit 不需要推翻现在的架构，**只多一步「把已有的 metadata 输出成 metamodel 形状」**。

这也是我给下一步的一个具体建议（见 §6）。

---

## 5. 为什么不现在切换

| 维度 | 判断 |
|---|---|
| 层级 | **硬伤**。当前 XKT 路线 maxDepth=1、类型全 `Default`，MVP 三条硬指标（层级、名称、属性关联）里有两条直接不满足；补 metamodel 是额外一层工作，而且依赖 Phase 3/4 先完成 |
| 线几何 | 906 条线在 xeokit 路线上**一条不剩**（rvmparser 已丢 39，convert2xkt 再丢 289+）。轴网与结构中心线全没 |
| 性能 | 收益很大（draw call 5796→6），**但现在并不缺性能**：three.js 55 FPS 已经在可用区间，本模型不是园区级 |
| 成本 | 多一层 GLB→XKT 转换、多一套 SDK 学习与集成、多一个 AGPL 依赖 |
| 许可证 | **决定性**。现在整条链是 MIT，引入 xeokit 就背上 AGPL 的网络开源义务 |

**决策**：Phase 2 的 three.js 方案继续。xeokit 写入 `research.md` 的备选清单，作为 Phase 7 的候选。

---

## 6. Phase 7 切换的触发条件（避免凭感觉）

满足**任意一条**再考虑：

1. **拿到商业许可**，或明确接受 AGPL 开源（这两条必须先落一条，否则免谈）；
2. **模型规模显著变大**（例如整个园区的多个 RVM 合并），three.js 侧实测掉到不可用区间；
3. **需要它的现成插件**：剖切 `SectionPlanesPlugin`、测量 `DistanceMeasurementsPlugin` / `AngleMeasurementsPlugin`、楼层视图 `StoreyViewsPlugin`、BCF 视点 —— 这些自建成本不低，若成为刚需则 xeokit 的性价比反转。

**零成本期权建议**：Phase 3 设计 `metadata.json` 时，让它**直接采用 metamodel 的字段形状**（`id / name / type / parent / propertySets[].properties[]`），并在映射层保证 `id` 与 GLB 节点名一致。这样将来要上 xeokit 只是换个序列化出口，不用重做数据层。

---

## 7. 证据与复现

| 内容 | 路径 |
|---|---|
| 本报告 | `reports/xeokit-evaluation.md` |
| XKT 转换脚本调用 | `@xeokit/xeokit-convert` v1.3.2，`convert2xkt.js -s model.glb -o model.xkt -l` |
| XKT 产物（实验） | `scratch/xeokit/model.xkt`（8.9 MiB） |
| 实验页面 | `scratch/xeokit/index.html` · `probe.js` |
| 实测脚本 | `scratch/xeokit/verify-xeokit.js`（`--gltf` 切换路径） |
| XKT 路径实测原始数据 | `reports/evidence/xeokit-probe-measure-xkt.json` |
| GLB 路径实测原始数据 | `reports/evidence/xeokit-probe-measure-gltf.json` |
| 截图 | `reports/xeokit-probe-screenshot-xkt.png` · `-gltf.png` |
| 许可证原文 | `scratch/xeokit/vendor/LICENSE-xeokit-AGPLv3.txt` |

复现：

```bash
python tools/serve.py --port 8765 --no-browser      # 已在运行则跳过
NODE_PATH=C:/Users/34084/.workbuddy/binaries/node/workspace/node_modules \
  node scratch/xeokit/verify-xeokit.js              # XKT 路径
  ... verify-xeokit.js --gltf                       # GLB 直载路径
```

> 沙箱环境注意：该 node 脚本**不能用 `> file` 直接重定向**（会被终止），改用管道（`| tail`）或让脚本自己写文件。
