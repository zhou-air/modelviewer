# Phase A — 模型资产管理架构设计

- 日期：2026-09-18
- 范围：只做分析与设计。本文件是后续 Phase B–G 的实现契约。
- 未改任何 Viewer / Converter / Navigation 代码。

---

## 1. 现状：现有 Converter 的输入输出（实测，非推测）

| # | 脚本 | 必需输入 | 产物 | 硬编码路径 | CLI 是否够用 |
|---|---|---|---|---|---|
| ① | `converter/rvm_to_glb.py` | `--source <rvm>`（缺省取 `data/source/*.rvm` 第一个） | `--out <glb>`（缺省 `data/processed/model.glb`）；日志写 `scratch/convert-tol<t>.log`；记录写 `reports/evidence/convert-records-tol<t>.json` | **日志与证据目录写死** | 输入/输出够用，日志需参数化 |
| ①-附 | `converter/rvm_index.py` | `--source <rvm>` | `--out <json>`（缺省 `data/processed/rvm-node-index.json`） | 缺省值 | ✅ 够用 |
| ② | `converter/txt_parser.py` | `--source <txt>` | `--out metadata.json`、`--metamodel <json>` | 缺省值 | ✅ 够用 |
| ③ | `converter/map_objects.py` | `--meta`、`--rvm`(=rvm-node-index)、`--glb` | `--out mapping.json`；额外写 `reports/evidence/phase4-unmatched.json` | **证据目录写死** | 输入/输出够用，证据路径需参数化 |
| 校验 | `verify_glb.py` | 位置参数 `<glb>` | stdout / `--json` | — | 可跑，建议改为具名参数 |
| 校验 | `verify_metadata.py` | `--source <txt>` `--meta <metadata>` | `--json`；退出码 0/1 | — | **有写死样例常量，必须修正** |
| 校验 | `verify_mapping.py` | `--mapping --meta --rvm-index --glb [--rvm]` | `--json`；退出码 0/1 | 缺省 `data/source` | ✅ 够用（`--rvm` 必须显式传，否则回读通道退化为取 `data/source` 第一个） |

调用链依赖关系（不可颠倒）：

```
model.rvm ──①rvm_to_glb──▶ model.glb ──┐
model.rvm ──①附rvm_index─▶ rvm-node-index.json ──┤
model.txt ──②txt_parser─▶ metadata.json ────────┴──③map_objects──▶ mapping.json
                                                  ↓
                        verify_glb / verify_metadata / verify_mapping（三条独立闸门）
```

### 1.1 一条决定 ID 命名规则的硬约束（本设计的关键约束）

`rvm_to_glb.py` 的 `ascii_rel()` 要求**源与目标路径必须是相对项目根的纯 ASCII**。原因（`reports/phase2-report.md` §5 / 已知问题 #2）：`rvmparser.exe` 把 argv 里的源路径原样写进 GLB 的 JSON 块，Windows 下拿到的是 ANSI(GBK) 字节；只要路径含非 ASCII 字符（比如中文目录名），写出来的 JSON 块就不是合法 UTF-8，**GLB 直接变成非法文件**。

推论（强制）：

> `data/projects/<projectId>/models/<modelId>/versions/<versionId>/` 这三级目录名**必须全部是 ASCII**。
> 中文只存在于 `project.json / model.json / version.json` 的 `name` 字段里，永不进入路径。

这也是"ID 与显示名称必须分离"这条要求的**工程原因**，不只是风格偏好。

### 1.2 一处必须修正的写死常量

`converter/verify_metadata.py:156`：

```python
chk("物理行数", r["physicalLines"], 92871)     # 92871 是 QICHUANG 这一个文件的实测值
```

换任何一个 TXT 都会误报失败，无法作为通用导入闸门。改为等价的通用恒等式（已实测在本样例上相等，见 §8）：

```python
chk("物理行数", r["physicalLines"], s["logicalRecords"] + s["continuationRecords"])
# 语义：独立重算的物理行数 == 解析器自记的「逻辑记录 + 跨行记录」
# 本样例：92843 + 28 = 92871 ✅
```

它保留了原检查的意图（**独立重算** vs **产物自记** 的交叉对账），只是把样例常量换成了结构性关系。校验算法本身一行未动。

---

## 2. 数据模型

```
Project  (data/projects/<projectId>/project.json)
  └─ Model  (models/<modelId>/model.json)
       └─ Version  (versions/<versionId>/version.json)
            ├─ source/     model.rvm · model.txt        ← 只读源
            ├─ processed/  model.glb · metadata.json · metadata.metamodel.json
            │              rvm-node-index.json · mapping.json
            └─ reports/    conversion.log · validation.json · validation.*.json
```

三层都用同一套规则：

| 规则 | 说明 |
|---|---|
| `id` | ASCII slug，`^[a-z0-9][a-z0-9._-]{0,47}$`，**不可变**，是目录名与程序引用键 |
| `name` | 任意 UTF-8 显示名（可中文），**可随时改**；改名不动目录 |
| Version 的 `id` | 由 `name` 生成 slug（`2026-09-18` → `2026-09-18`）。slug 已存在 → **拒绝**，不覆盖、不自动加后缀 |
| 三层各带 | `createdAt` / `updatedAt`（ISO 8601 带时区） |

### 2.1 JSON schema（`schema: "pdms-model-asset/1"`）

`project.json`
```jsonc
{ "schema": "pdms-model-asset/1",
  "id": "qichuang", "name": "启创项目", "description": "",
  "createdAt": "2026-09-18T23:50:00+08:00", "updatedAt": "..." }
```

`model.json`
```jsonc
{ "schema": "pdms-model-asset/1",
  "id": "main-site", "name": "Main Site", "description": "",
  "createdAt": "...", "updatedAt": "..." }
```

`version.json`
```jsonc
{ "schema": "pdms-model-asset/1",
  "id": "2026-08-26", "name": "2026-08-26",
  "createdAt": "2026-08-27T09:00:00+08:00",     // 源 RVM 的文件时间
  "importedAt": "2026-09-18T23:50:00+08:00",    // 注册（转换完成）时刻
  "sourceRvm": "source/model.rvm",              // 内部固定名，程序只认这个
  "sourceTxt": "source/model.txt",
  "originalRvmFilename": "QICHUANG-SITE-RVM-2026-08-26.rvm",  // 仅供显示/追溯
  "originalTxtFilename": "QICHUANG-SITE-2026-08-26.txt",
  "status": "ready",                             // importing | ready | failed
  "error": null,                                 // 失败时 {"stage": "...", "message": "..."}
  "assets": { "glb": "processed/model.glb", "metadata": "processed/metadata.json",
              "metamodel": "processed/metadata.metamodel.json",
              "rvmIndex": "processed/rvm-node-index.json",
              "mapping": "processed/mapping.json" },
  "stats": {                                     // §"方便以后版本比较/诊断" —— 本阶段只存不算
    "rvmBytes": 4505600, "txtBytes": 1344437, "glbBytes": 18385928,
    "objectCount": 8955, "namedNodes": 7423, "mappedObjects": 7420,
    "mappingRate": 1.0, "triangles": 335824, "meshes": 5507, "lines": 289,
    "durationMs": 0,
    "converterVersion": "pdms-import-pipeline/1 · rvmparser/2f7025971a95 · tolerance 0.02 m" },
  "history": [ { "at": "...", "status": "importing" }, { "at": "...", "status": "ready" } ] }
```

`stats` 与 `history` 是为**将来版本比较/转换诊断**留的位置；本阶段只写入、不消费，也不生成任何跨版本 GUID。
跨版本对象身份**继续使用 PDMS 原始身份**（`canonical` / PDMS Name / 层级 path / Type —— `metadata.json` 里的字段一个都不改），符合任务书 §31。

### 2.2 事实来源与索引

`project.json / model.json / version.json` 是唯一事实来源；后端每次请求**现场扫描** `data/projects/` 组装列表。

**不做 `index.json`。** 依据：一个 Project 的扫描 = 读 1 + N + M 个小 JSON（实测本项目规模：1 project / 1 model / 1 version，全量扫描 < 5 ms）。任务书 §29 说的是"**如果需要**提高启动速度"，当前规模不需要；多一层索引就多一个可能与事实源不一致的文件。规模真大到需要时再加，且按任务书要求它只能当缓存，丢了能重建。

---

## 3. API 契约（`tools/server.py`，Python 标准库，无第三方依赖）

所有响应 `application/json; charset=utf-8`，形如 `{"ok": true, "data": ...}` / `{"ok": false, "error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 存活探测；返回 pipeline 版本、根目录、项目数 |
| GET | `/api/projects` | 全部 Project → Model → Version 嵌套列表（Launcher 主数据源） |
| GET | `/api/projects/{pid}` | 单个 Project |
| POST | `/api/projects` | 建 Project `{name, id?, description?}` |
| PATCH | `/api/projects/{pid}` | 改显示名 / 描述 |
| DELETE | `/api/projects/{pid}` | 移入 `data/trash/`，返回 `{models, versions}` 计数 |
| POST | `/api/projects/{pid}/models` | 建 Model `{name, id?, description?}` |
| PATCH | `/api/models/{pid}/{mid}` | 改 Model 显示名 / 描述 |
| DELETE | `/api/models/{pid}/{mid}` | 移入 trash，返回 `{versions}` |
| GET | `/api/versions/{pid}/{mid}/{vid}` | Version 详情（含 `validation` 摘要，供 Details 弹窗） |
| PATCH | `/api/versions/{pid}/{mid}/{vid}` | 改 Version 显示名 |
| DELETE | `/api/versions/{pid}/{mid}/{vid}` | 移入 trash |
| POST | `/api/import/jobs` | 建导入任务 `{projectId|newProjectName, modelId|newModelName, versionName, rvmFilename, txtFilename}` → `{jobId}` |
| PUT | `/api/import/jobs/{jobId}/source/rvm` | 原始字节上传（body 即文件内容） |
| PUT | `/api/import/jobs/{jobId}/source/txt` | 同上 |
| POST | `/api/import/jobs/{jobId}/start` | 启动/重试转换（后台线程），立即返回 job 状态 |
| GET | `/api/import/jobs/{jobId}` | 轮询状态：`status` / `stage` / `stages[]` / `error` |
| GET | `/api/import/jobs/{jobId}/log` | `conversion.log` 文本（前端 [View Log]） |

### 3.1 为什么上传走「分片 PUT」而不是 `multipart/form-data`

RVM 4.5 MB + TXT 1.3 MB。任务书允许"不要求严格 REST，优先简单稳定"。三个候选：

| 方案 | 问题 |
|---|---|
| `multipart/form-data` | Python 3.13 **已移除 `cgi` 模块**，标准库不再有现成的 multipart 解析器；手写边界解析是纯粹的 bug 来源 |
| JSON + base64 | 体积 +33%（5.8 MB → 7.8 MB），且要把整个文件读进内存再编码 |
| **分片 PUT（采用）** | 每个文件一次原始 `PUT`，body 直接流式写盘；解析成本为零；上传进度天然可测；重试只需重发某一片 |

代价是 4 次请求（建 job → PUT rvm → PUT txt → start），换来的是"没有自定义协议解析代码"。

### 3.2 路径安全（任务书 §32）

1. 所有 `{pid}/{mid}/{vid}` 先过 `ID_RE` 白名单（小写字母数字开头，允许 `._-`），**拒绝** `..`、`/`、`\`、盘符、Windows 保留名（`con`/`prn`/`aux`/`nul`/`com1`…）、非 ASCII。
2. 拼出来的路径一律过 `resolve()` 后断言**在 `data/projects/` 之内**（`Path.is_relative_to`），否则 400。
3. 上传的原始文件名**只作为字符串存进 `version.json`**，不参与任何路径构造；磁盘上一律叫 `model.rvm` / `model.txt`。
4. 静态服务用 `SimpleHTTPRequestHandler(directory=ROOT)`，其自带的路径规范化负责挡住 `..` 逃逸。

---

## 4. 导入流水线（`tools/import_pipeline.py`）

```
Browser ──PUT──▶ staging (data/import-jobs/<jobId>/source/)
                      │
                      ├─[copying]     移动源文件到 version/source/，写 version.json(status=importing)
                      ├─[geometry]    ① rvm_to_glb.py            → processed/model.glb
                      ├─[metadata]    ② txt_parser.py --metamodel → processed/metadata.json(+metamodel)
                      ├─[mapping]     ①附 rvm_index.py + ③ map_objects.py → rvm-node-index.json, mapping.json
                      ├─[validating]  verify_glb + verify_metadata + verify_mapping → reports/validation.json
                      └─[ready]       回写 version.json(status=ready, stats)
```

- **复用现有转换器**，一个字节的几何/映射算法都不重写、不复制第二套。后端只负责：给对路径、按对顺序、读结果、判闸门。
- 阶段名与任务书 §18 一致：`queued / copying / geometry / metadata / mapping / validating / ready / failed`（`rvm_index` 属于 `mapping` 阶段内的子步骤）。
- 任何阶段失败 → `status=failed`，`error={stage, message}`，**保留 `source/`（只读源）与 `reports/conversion.log`**，`processed/` 里的半成品不注册为 ready。
- 重试 = 对同一 job 再 `POST /start`：源文件已在位，只清 `processed/` 与 `reports/` 后重跑。**不重传文件。**
- `conversion.log` 记每个子步骤的完整命令行、耗时、stdout/stderr。
- 校验闸门：`verify_metadata` / `verify_mapping` 用其**退出码**（0=通过）；`verify_glb` 本身只输出结构报告不含判定，闸门取自其 JSON 的三个客观条件（`json_utf8_ok == true`、`counts.nodes > 0`、`geometry.triangles > 0`）——不改它的算法，只消费它的输出。

### 4.1 版本隔离与"不覆盖"（任务书 §6/§34）

- 目标 `versions/<vid>/` 已存在且 `status=ready` → 返回 **409 `version_exists`**，前端提示"版本已存在，请换一个版本名"。
- 已存在且 `status=failed` → 允许重跑（同一目录，先清派生数据）。所以失败版本**不会**污染同 Model 的其它版本：每个 Version 一个独立目录，互不引用。
- 删除一律 **移入 `data/trash/<时间戳>-<类型>-<id>/`**，不物理删除（任务书 §7 推荐做法，实现成本很低，故采用）。

---

## 5. Viewer 改造点（只加不重写）

| 文件 | 改动 | 理由 |
|---|---|---|
| `viewer/js/data.js` | `loadData({base})`，三份 JSON 路径由调用方给 | 去掉写死的 `../data/processed/` |
| `viewer/js/viewer3d.js` | 新增 `unload()`：移除 root、`dispose()` 几何与自有材质、清 map/选中/隐藏、清 `outline.selectedObjects`、`ready=false`；`load()` 开头先调 `unload()` | 现在**完全没有卸载路径**，连续切换必然泄漏显存 |
| `viewer/js/tree.js` | 新增 `setData(data)`：清 DOM、清 `rows`/`expanded`/`selectedId` 后重建 | 避免重复 `new ModelTree` 在同一 host 上叠加 click 监听 |
| `viewer/js/props.js` | 新增 `setData(data)` | 同上，保证属性面板不残留上一版本对象 |
| `viewer/js/api.js`（新） | 后端 API 客户端 | — |
| `viewer/js/assetManager.js`（新） | Project Manager 侧栏 + Model Selector + Import 弹窗 + Recent | 与 3D 完全解耦 |
| `viewer/app.js` | 拆成「launcher（选择/导入）」与「openVersion(version)（原有装配逻辑）」两段 | 原有装配、工具条、导航接线**原样保留**，只是从"启动即执行"变成"Open 后执行" |
| `viewer/index.html` | 加启动层（Launcher）与顶部标题条；3D 区域在未打开模型时隐藏 | — |

相机、选中、隐藏、隔离在切换时的重置：`unload()` 里清全部状态 + `load()` 末尾 `fit(null)`（等价"Fit Model"），不保留上一模型的任何 object id。

**Navigation 不动**：`viewer/js/navigation/*` 与 `Model3D` 的导航接线保持原样；切换模型时若处于 Game 模式，先 `setNavigationMode('orbit')` 再卸载（重载后 `ready=false`，Game 模式本身也进不去）。

---

## 6. 迁移（任务书 §30）

现有 demo → `qichuang / main-site / 2026-08-26`。**不重新转换**（Phase 2 的产物已经过 21+33 项校验），直接搬运：

```
data/source/*.rvm,txt  → …/versions/2026-08-26/source/model.rvm, model.txt
data/processed/*       → …/versions/2026-08-26/processed/*
```

搬运方式：**复制 → 逐项对账（字节数 + metadata 对象数 8955 + mapping 边数 7420）→ 通过后把原件整体挪到 `data/_legacy_demo_2026-08-26/`**（不删，可回退）。
`version.json` 的 `stats` 从现有产物**读出填写**（不重算）：GLB 字节数、metadata.stats.objects、mapping.stats、三角形数取自 `reports/evidence/phase2-glb-check.json`。

迁移后必须复验（任务书 §30 要求"结果一致"）：Object Count / Mapping / Tree / Properties / Hide / Isolate / Selection 逐项与迁移前一致。

---

## 7. 边界（本阶段明确不做）

Cloud / 账号 / 登录 / 权限 / 远程服务 / 模型分享 / 版本比较 / Diff / 数据库 / AI / 碰撞检查 / PDMS 回写 / 模型编辑 / Electron / Tauri / 移动端。
Navigation 系统由另一条线独立处理，本阶段只保证"切换模型时不破坏其状态"。

---

## 8. 本设计依赖的实测数据

| 事实 | 来源 |
|---|---|
| `92843 + 28 = 92871` 恒等式成立（两个独立实现一致） | 本次实测：`verify_metadata.scan_raw()` 与 `txt_parser.parse()` 的 stats 对比 |
| 转换器路径必须 ASCII | `reports/phase2-report.md` §5 已知问题 #2 + `rvm_to_glb.py:ascii_rel()` |
| 命名节点 7,423 / mapped 7,420 / TXT 对象 8,955 | `reports/phase4-report.md` §1 |
| GLB 17.53 MiB / 335,824 三角形 | `reports/phase2-report.md` §2.2 |
| 页面到就绪 909–1,051 ms；JS 堆 56.5 MB，跑完 6 场景 +3.7 MB | `reports/benchmark.md` |

---

## 9. 实现后的修订（as-built，与本文件上述内容的差异）

实现过程中被实测推翻或补全的地方，逐条列出，避免"文档与代码两套说法"：

| # | 本文件原写法 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | 未规定版本排序 | **按版本名称自然降序**（数字段按数值比，`v2 < v10`） | 版本名就是迭代标识；按导入时间排会在"补导一个旧版本"时错位。见 `tools/asset_store.py:_version_sort_key` |
| 2 | Converter 参数示意为 `--rvm/--txt/--output-dir/--metadata/--mapping` | 采用**同义参数**：`--input/--output`（rvm_to_glb、rvm_index）、`--txt/--output`（txt_parser）、`--mapping`（map_objects） | 任务书要求"无参数时原行为不变"，所以只能新增别名，不能替换原有 `--source/--out` |
| 3 | API 表未含重试接口 | 新增 `POST /api/import/retry` | 失败版本重试不应该要求用户重新手选文件；后端自带源文件，直接原地重跑 |
| 4 | API 表未含版本日志接口 | 新增 `GET /api/versions/{pid}/{mid}/{vid}/log` | 失败时必须能就地看到 `conversion.log`（任务书 §20 [View Log]） |
| 5 | 建 job 由后端按名称生成 ID | 允许前端显式传 `newProjectId`/`newModelId` | 中文名 slug 为空（启创项目 → 生成不出 `qichuang`），必须让用户能填 |
| 6 | "清空 processed/ 与 reports/ 后重跑" | 改为**逐文件尽力删除**，失败不中断 | `shutil.rmtree` 在本机沙箱抛 `SAFE_DELETE_FAIL_CLOSED`；Windows 上文件被占用也会整体失败。这一步是可选清理，不该拖垮导入 |
| 7 | 未规定端口占用处理 | `pick_port` 先 `connect_ex` 探测，`Server` 设 `SO_EXCLUSIVEADDRUSE` | 实测撞到 8765 上 4 个进程同时监听（`SO_REUSEADDR` 允许重复绑定），请求被随机分流 |
| 8 | "校验闸门：verify_metadata / verify_mapping 用退出码" | 补充：`verify_glb` 无判定语义，闸门取其 JSON 的 `json_utf8_ok` / `nodes>0` / `triangles>0`；另加一条 metadata 阶段前置闸门（`objects > 0`） | 0 个对象的"元数据"没有意义，提前失败比跑到校验阶段更早暴露 |
| 9 | 迁移"复制 → 对账 → 挪走原件" | 已按此执行，并在新路径上重跑三条校验器 | 结果是三层证据：sha256 一致 + 校验复跑通过 + GLB 逐字节差异只剩 File 节点名 |
| 10 | 未规定"切换模型"时是否卸载 | `backToLauncher`（去挑版本）**不卸载**；只有"打开另一个版本"才 `unload()` | 返回 Viewer 应该立刻能看；真正要释放显存的是换模型 |

以上修订均已落到代码，并记入 `reports/phase8-report.md`。
