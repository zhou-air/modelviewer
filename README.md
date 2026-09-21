# PDMS Model Asset Manager — 本地工程模型查看与管理

> 本仓库为公开开发仓库。发布副本保留 `示例模型/` 中的 RVM/TXT 示例，真实运行数据、访问密码、临时调试文件和缓存不纳入版本控制。

把 AVEVA PDMS 导出的 RVM 几何与 TXT 数据清单，转换成能在**本机浏览器**里流畅查看的工程模型，
并且按 **Project / Model / Version** 三层管理起来（导入、自动转换、版本迭代、切换查看）。
不依赖 Navisworks、不依赖 Autodesk APS、不上传任何数据到云端。

当前进度：**Phase 8 完成**（三层数据链路 + 可交互 Viewer + 性能基准 + 模型资产管理器，均已实测）；**Phase 9 完成**（内外网访问权限体系：内网直进 / 每日内部码 / 项目访问码 / 删除密码，20 项权限实测全过）。

## 怎么运行

双击项目根目录的 **`start.bat`**。

它会启动本地后端（`http://127.0.0.1:8765/viewer/index.html`）并自动打开浏览器。
localhost 由后端判定为**公司内网（INTERNAL_NETWORK）**，直接进入内部项目管理器，无需输入访问码。
首次进入看到的是 **Model Selector**：

```
Projects                     Project  [ 启创项目 ▼ ]
  启创项目                     Model    [ Main Site ▼ ]
    Main Site                 Version  [ 2026-09-19 ▼ ]
      2026-09-19  Open                 [ Open Model ]  [ Import Model ]
      2026-09-18  Open
      2026-08-26  Open
    Tank Area
  丙酸项目
    Main Site
      2026-09-03  Open
```

选好 Project → Model → Version，点 `Open Model` 进查看器。需要新版本就点 `Import Model`：
选好目标 Project / Model、填版本名，再选本机的 `.rvm` 与 `.txt`，剩下的全部自动完成。

Viewer 会同时加载由现有 **PDMS 设备定位工具**从同一份 TXT 导出的 `floorplan.json`。
工具条“设备定位图”默认开启；底图只读、不可选择，不进入模型树，也不受隐藏/隔离影响。

- 只监听 `127.0.0.1`，模型数据不出本机；不用注册、不用登录、没有云端。
- 停止服务：在启动窗口按 `Ctrl+C`。
- 历史版本不会被覆盖；删除只是移入 `data/trash/`。

## 访问权限体系（Phase 9）

### 三种身份（由服务器端判定，前端只做显示裁剪）

| 身份 | 进入方式 | 权限 |
|---|---|---|
| `INTERNAL_NETWORK` 内网 | 来自内网网段（localhost 恒为内网） | 全部功能；删除需输删除密码 |
| `INTERNAL_REMOTE` 外部员工 | 外网输入**今日内部访问码**（内网首页可复制） | 全项目只读 |
| `CLIENT_PROJECT` 客户 | 外网输入某项目的**项目访问码** | 只见并只读该一个项目 |

外网只有一个输入框，服务器自动区分两种码；验证失败统一返回"访问码无效或已失效"。
权限判定集中在 `tools/access_control.py`（PermissionService），API 与静态模型文件都走同一套守卫。

### 配置（`config/access.env`，已 gitignore，可用同名环境变量覆盖）

| 键 | 说明 | 默认 |
|---|---|---|
| `INTERNAL_NETWORK_RANGES` | 内网网段 / 公网出口 IP，逗号分隔 CIDR | loopback + 常用内网段 |
| `TRUST_LOOPBACK` | 是否把 localhost/127.0.0.1 当内网。**cloudflared 隧道 / 本机反代场景必须设 0**（隧道回源流量从 127.0.0.1 进来）；设 0 后本机请改用局域网地址访问，并用 `start-lan.bat` 启动 | 1 |
| `TRUSTED_PROXIES` | 可信反向代理；只有来自它的 `X-Forwarded-For` 才被信任（保持为空可防伪造） | 空（忽略 XFF） |
| `DELETE_PASSWORD` | 删除密码；留空则首次运行自动生成并写回 | 自动生成 |
| `SESSION_TTL_HOURS` | Session 有效期（与每日码滚动无关） | 24 |
| `SECURE_COOKIES` | HTTPS 部署时设 1 | 0 |

### 新增 API

| 方法 / 路径 | 说明 |
|---|---|
| `GET /api/access/status` | 当前身份 + 权限位（公开） |
| `POST /api/access/login` | `{code}` → 验证并建 Session（公开） |
| `POST /api/access/logout` | 退出当前 Session |
| `GET /api/access/internal-code` | 今日内部码（仅内网） |
| `GET/POST /api/projects/<pid>/access-code` | 项目客户访问码管理（仅内网） |
| `DELETE /api/*` | 需请求头 `X-Delete-Password` |

### 启动方式

| 场景 | 方法 |
|---|---|
| 本机 | `start.bat`（127.0.0.1，直接进内网模式） |
| 局域网 | `start-lan.bat`（0.0.0.0，手机/iPad 同 Wi-Fi 访问打印出来的局域网地址；手机将按其 IP 判定身份，默认内网段含 192.168.0.0/16） |
| 云服务器 | `python tools/server.py --port 8765 --host 0.0.0.0`，收紧 `INTERNAL_NETWORK_RANGES` 为公司出口 IP，配 `TRUSTED_PROXIES`，HTTPS 下开 `SECURE_COOKIES=1`；不要把密码写进仓库 |

### 权限测试

```bash
python scratch/access-test.py      # 20 项：Case 1–12 全覆盖 + 防伪造 + 统一口径
```


> 不要直接双击 `viewer/index.html`——ES module、GLB 与 `/api/*` 都需要经过本地后端。

### 手动分步（调试用）

```bash
python tools/server.py --port 8765 --no-browser    # 只起后端，不开浏览器
python tools/server.py --port 8765                 # 起后端并打开浏览器

# 无界面导入（走同一条流水线）
python tools/import_pipeline.py --project qichuang --model main-site \
    --version 2026-09-25 --rvm X.rvm --txt X.txt

# 单独跑某一层转换（都是独立脚本，可任意路径出入）
python converter/rvm_to_glb.py --source data/projects/.../source/model.rvm \
    --out data/projects/.../processed/model.glb --tolerance 0.02
python converter/txt_parser.py  --source .../source/model.txt --out .../processed/metadata.json \
    --metamodel .../processed/metadata.metamodel.json
# 复用现有定位工具的 PdmsDataListingParser + OutlineBuilder，不在 Viewer 中另写 TXT 解析器
PdmsEquipmentLocator.exe floorplan .../source/model.txt .../processed/floorplan.json
python converter/rvm_index.py   --source .../source/model.rvm --out .../processed/rvm-node-index.json
python converter/map_objects.py --meta .../processed/metadata.json --rvm .../processed/rvm-node-index.json \
    --glb .../processed/model.glb --out .../processed/mapping.json --evidence-dir .../reports

# 三条独立校验闸门
python converter/verify_glb.py <model.glb> --json <out.json>
python converter/verify_metadata.py --source <model.txt> --meta <metadata.json> --json <out.json>
python converter/verify_mapping.py --mapping <mapping.json> --meta <metadata.json> \
    --rvm-index <rvm-node-index.json> --glb <model.glb> --rvm <model.rvm> --json <out.json>

# 实测脚本
python scratch/phase8-api-test.py                                        # 后端 + 导入流水线
NODE_PATH=<node-workspace>/node_modules node scratch/phase8-verify.js    # 浏览器（需先起后端）
python scratch/phase6-benchmark.js 3                                     # 性能基准（需先起后端）

# 外观与交互实测：后端起在 8899 端口即可，脚本把端口写死在 PORT 环境变量里
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-verify.js       # 31 项功能实测
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-regression.js   # 15 项既有交互回归
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-fps.js          # 开关的帧率对比
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-diag.js         # 逐通道诊断（画面不对时用）
PORT=8899 NODE_PATH=<node-workspace>/node_modules node scratch/appearance-color-ground-verify.js # 颜色、背景、地板与会话边界
```

## 目录

```
├─ start.bat                     唯一入口：起后端 + 开浏览器
├─ start-lan.bat                 局域网入口：0.0.0.0 监听，手机/iPad 同 Wi-Fi 访问
├─ config/
│  ├─ access.env                 访问权限配置（含删除密码，不进 Git，首次运行自动生成）
│  └─ access.env.example         配置说明模板
├─ tools/
│  ├─ server.py                  本地后端：/api/* + 静态服务 + 权限守卫（只用标准库）
│  ├─ access_control.py          访问权限层：内网识别 / Session / 每日码 / 项目访问码 / 权限判定
│  ├─ asset_store.py             资产仓库：Project/Model/Version 文件系统 + JSON manifest
│  ├─ import_pipeline.py         导入流水线：暂存 → 现有转换链 → 校验 → 注册版本
│  ├─ migrate_demo.py            一次性迁移工具（把旧 demo 注册成 qichuang/main-site/2026-08-26）
│  ├─ serve.py                   纯静态服务（调试用，无 API）
│  └─ rvmparser/rvmparser.exe    固定版本解析器（MIT，见 LICENSE-rvmparser-MIT.txt）
├─ converter/                    转换与校验脚本（每个都能独立运行、任意路径出入）
│  ├─ rvm_to_glb.py              ① 几何层：RVM → GLB
│  ├─ txt_parser.py              ② 元数据层：TXT → metadata.json
│  ├─ rvm_index.py               ①-附 RVM 技术索引：字节偏移 + 层级 + 包围盒
│  ├─ map_objects.py             ③ 映射层：RVM ↔ TXT → mapping.json
│  ├─ verify_glb.py              GLB 结构校验（含 JSON 必须是合法 UTF-8 的闸门）
│  ├─ verify_metadata.py         metadata 独立校验（33 项，含命名规则外部闭环）
│  └─ verify_mapping.py          映射独立校验（21 项，含字节偏移回读验证）
├─ viewer/
│  ├─ index.html                 启动层（Project Manager / Model Selector / Import）+ 三栏查看器 + 外网访问门
│  ├─ app.js                     装配：启动层 ↔ 查看层，工具条，对外状态
│  ├─ js/
│  │  ├─ api.js                  后端 API 客户端
│  │  ├─ access.js               访问权限前端层：访问门 / 角色徽标 / 今日内部码卡片
│  │  ├─ assetManager.js         Project Manager · Model Selector · Import 弹窗 · Recent · Details
│  │  ├─ data.js                 按版本路径加载三份元数据并建索引
│  │  ├─ floorPlan.js            只读设备定位底图：轮廓/位号/定位点/坐标调试
│  │  ├─ appearance.js            用户级外观偏好：颜色、背景、地板与 localStorage
│  │  ├─ sceneAppearance.js       场景背景与独立地板，不进入模型树和拾取
│  │  ├─ edgeLinesPass.js        元件轮廓线后处理：离屏法线/深度 + 屏幕空间边缘检测
│  │  ├─ viewer3d.js             场景、加载/卸载、拾取、高亮、显隐、外观选项、视图适配、统计
│  │  ├─ batchRendering.js       indexed 空间合批 + faceIndex→canonicalId + 增量状态同步
│  │  ├─ performanceDiagnostics.js CPU/GPU Timer Query 帧诊断
│  │  ├─ tree.js                 懒展开模型树 + 双向联动
│  │  ├─ props.js                属性面板（含几何对应信息）
│  │  └─ navigation/             工程导航（独立于本阶段，未改动）
│  └─ vendor/                    three.js r160 本地副本（含 postprocessing/shaders）
├─ data/
│  ├─ projects/                  事实来源：Project / Model / Version 的 JSON manifest 与产物
│  ├─ import-jobs/               导入暂存区（上传的原始字节）
│  ├─ trash/                     删除的资产（移入，不物理删除）
│  └─ _legacy_demo_2026-08-26/   迁移前的 data/source + data/processed（保留，可删）
├─ reports/                      各阶段报告 + evidence/ 实测原始数据
└─ scratch/                      探针脚本与临时产物，不进交付
```

**四层解耦**：几何层 / 元数据层 / 映射层 / Viewer 互不依赖，任一层可单独替换；
资产管理层只在"调用现有脚本 + 记录结果"这一层上工作，不含任何转换逻辑。

已实现：Orbit/Pan/Zoom/Fit、点击选中（真实射线拾取）、选中高亮与描边、隐藏/隔离/显示全部、
8 层模型树与 3D 双向联动、属性面板（含 RVM 字节偏移等映射信息）、
工程导航（Orbit/Game）、多项目/多模型/多版本管理、导入即转换即校验、模型切换与状态复位、
**外观系统（模型颜色、对象覆盖色、场景背景、地板及既有选项，见下）**，以及默认启用的
**indexed 中粒度空间 Batching**（保留 canonicalId / metadata / 树 / 拾取 / 高亮 / 显隐语义）。

### Batch Rendering

Viewer 加载 GLB 后保留原层级和映射，但将 Mesh 按空间分桶、每批最多 64 个的粒度生成 indexed Render Batch。
每个原 Mesh 都保留 triangle/face range，Raycaster 通过 `faceIndex` 反查 canonicalId。选中、预选、隐藏和
ghost 只重建状态变化涉及的中粒度 Batch；Isolate/Show All 等全局操作才同步全部 Batch。
实测基础场景从 5,796 / 16,255 calls 降到 394 / 317 calls，详见
`reports/batch-rendering-integration-report.md`。

### 外观系统（工具条「外观」）

| 选项 | 作用 | 实现 | 代价 |
|---|---|---|---|
| **全局模型颜色** | 修改没有对象覆盖色的模型对象；恢复默认后回到默认模型色 | 共享批处理材质通过 `objectColor/objectColorMix` 属性混合全局色，不为每个原始对象创建材质 | 不拆 Batch；只更新受影响的批次 |
| **对象单独改色** | 右键对单个或多个选中对象设置常用色、自定义色或恢复默认色 | `Map<canonicalId, color>`；取消选中后恢复对象自己的颜色 | 只更新受影响的 Batch，切换模型/版本清空 |
| **背景颜色** | 设置纯色场景背景 | `SceneAppearance` 管理 `scene.background` | 无额外渲染 pass |
| **显示地板 / 地板颜色** | 按模型包围盒自动放置水平地板 | 独立场景节点，不参与 raycast、模型树、隐藏/隔离和测量；FloorPlan 位于其上方 | 默认关闭，无阴影/AO |
| **元件轮廓线** | 给每个元件画出分界轮廓，工程审图时结构层次比纯着色清楚得多 | 屏幕空间边缘检测后处理（`viewer/js/edgeLinesPass.js`）：先用 `overrideMaterial` 离屏渲染一遍法线 + 线性深度，再按 4 邻域做法线夹角与相对深度差的边缘检测，合成回画面 | 开启时每帧多一轮场景渲染 + 一个全屏 pass。关掉后该 pass 被 EffectComposer 直接跳过，**零开销** |
| **隐藏件半透明** | 「隐藏选中 / 隔离选中」掉的对象不消失，改用半透明 ghost 显示，不透明度 5%–95% 可调 | 隐藏件保留在渲染里，仅换成 `transparent + depthWrite:false` 的 ghost 材质；显隐状态仍记在 `hiddenCanonicals` | 只有存在隐藏对象时才多一趟全场景材质同步；画面上是半透明混合，几乎无开销 |

新外观项的语义边界（都经过实测断言）：

- 颜色优先级为选中/悬停高亮 → 对象覆盖色 → 全局模型颜色 → 默认模型颜色；选中高亮、Ghost、轮廓线、FloorPlan、Measurement 和 Orientation Gizmo 不使用对象覆盖材质替代。
- `globalModelColor`、`backgroundColor`、`groundEnabled`、`groundColor` 写入当前设备的 `localStorage`，切换 Project/Model/Version 保留；对象覆盖色只在当前模型查看会话内保留，切换模型或版本清空。
- 地板根据模型 BoundingBox 自动定尺寸和高度；FloorPlan 单独位于模型根节点之外，并在地板上方保留偏移，避免遮挡和 Z-fighting。

- 轮廓线用**视图法线 + 线性深度双通道**。只看法线分不出前后遮挡的同朝向元件，只看深度分不出贴近的相邻元件，两路取或才能覆盖。仍属屏幕空间近似：**深度与法线同时连续的贴合面不会被描边**（要彻底解决需要物体 ID 缓冲，而 5,796 个 mesh 逐对象换材质不划算）。
- 半透明只改**外观**，不改**语义**：ghost 对象仍然不可拾取、不参与描边、不计入“可见对象”统计，`hidden` 计数也不变；关掉开关立即回到真隐藏。

### 设备定位图（默认开启）

- `floorplan.json` 保存 PDMS 世界坐标（mm、Z-up），内容包括设备位号、XYZ、ZONE、定位点和 BOX/CYLINDER 世界 XY 轮廓。
- 导入时调用现有 `PdmsEquipmentLocator.exe floorplan` 轻量命令；查找顺序为环境变量 `PDMS_LOCATOR_EXE`、`tools/PdmsEquipmentLocator.exe`、桌面同级 `PDMS设备定位工具/PdmsEquipmentLocator.exe`。
- Viewer 读取 GLB 内的 `asset.extras.rvmparser-origin`，严格复用当前转换的“中心平移 + Z-up→Y-up”映射；底图落在 Three.js XZ 平面、`modelBox.min.y` 下方极小偏移处，不允许手工平移或缩放对齐。
- `FloorPlanGroup` 与模型根节点平级，不参与 raycast、模型树、选中、隐藏或隔离。位号按纹理批处理，轮廓和定位点分别合并为单个 `LineSegments`。
- “外观 → 定位坐标调试”可同时显示绿色 floorplan 定位点、粉色 3D 设备包围盒中心和紫色连接线。
- 设备定位图仍按既有页面会话语义管理；新加入的四项用户级外观偏好写入 localStorage，刷新和切换 Project/Model/Version 均保留。

性能取舍：Outline 依然会增加额外 pass，因此沿用交互期间暂停、停止后恢复的既有策略。
元件轮廓线是同类性质的取舍（多一轮场景渲染），
但它由用户显式开启、且关掉即完全不执行，所以不做拖动期暂停。详细基准见 `reports/benchmark.md`、
`reports/appearance-options-report.md`、`reports/batch-rendering-integration-report.md`。

## 数据与文档口径

| 内容 | 路径 |
|---|---|
| 架构设计（数据模型 / API 契约 / 流水线） | `reports/model-management-design.md` |
| 本阶段交付说明与实测 | `reports/phase8-report.md` |
| 各阶段历史报告 | `reports/phase2-report.md` … `reports/phase5-report.md`、`reports/benchmark.md` |
| 实测原始数据 | `reports/evidence/phase8-*.json` |
| 版本记录结构（为将来版本比较预留的字段） | 各 `versions/<id>/version.json` 的 `stats` 与 `history` |

## 固定解析器版本

| 项 | 值 |
|---|---|
| 项目 | https://github.com/cdyk/rvmparser |
| 许可证 | MIT（`tools/rvmparser/LICENSE-rvmparser-MIT.txt`，分发时必须保留） |
| 版本 | v1.0.4 release |
| 二进制 SHA1(前12) | `2f7025971a95` |

## 已知问题

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | 上游 glTF 导出器**丢失单条 Line 几何**（`ExportGLTF.cpp` 的 `addGeometryPrimitive()` Line 分支缺少 `PushBack`） | 本模型 906 条 Line 中丢 39 条，全部是轴网线 | **已接受（第一版）**，见 `reports/phase2-report.md` §5 |
| 2 | 解析器把 `argv` 里的源路径原样写进 glTF JSON。Windows 下非 ASCII 路径会写成 ANSI(GBK) 字节 → **JSON 块非法 UTF-8，GLB 成为非法文件** | 严格 loader 可能拒收 | 已规避：转换器强制相对 ASCII 路径 + 校验闸门；**资产目录名强制 ASCII slug** |
| 3 | 该 RVM 不含颜色（无 COLR 色表，7420 组 `material` 全 = 1） | 第 1 版统一灰色 | 设计如此，非缺陷 |
| 4 | `--output-gltf-attributes` 产出的 `node.extras` 为空 | GLB 不含 TXT 属性 | 预期内：属性由 metadata + mapping 提供 |
| 5 | 导入 job 不跨后端重启 | 重启后进行中的 job 会 404；已完成版本不受影响 | 已接受（任务书不要求任务队列） |
| 6 | 修改 `tools/*.py` 后必须重启后端才生效 | 老进程仍在跑旧代码，表现为接口 404 | 属 Python 常驻进程的正常行为 |
| 7 | `phase8-api-test.py` 的「tank-area 版本为空」断言基于旧数据假设 | tank-area 里有真实版本时该项会 FAIL（34/35），非功能缺陷 | 测试假设过时，重置步骤未覆盖该模型 |
| 8 | 静态服务已收紧为白名单：只放行 `/viewer/**` 与有权限的 `/data/projects/<pid>/**`，`/` 重定向到 Viewer | 直接访问 `/config`、`/reports`、`/data/trash` 等一律 403（防删除密码泄露） | 权限体系设计如此 |

详见 `reports/phase2-report.md`、`reports/phase8-report.md`。
