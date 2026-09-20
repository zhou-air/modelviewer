# Phase 8 — 模型资产管理器（Project / Model / Version + 导入流水线）

- 状态：**已完成**，后端 35/35、浏览器 34/34 项实测通过
- 日期：2026-09-18
- 范围：只新增资产管理层。**未重写** Viewer 的 3D/树/属性/导航，**未重写** 任何转换或校验算法，**未动** Navigation 系统。
- 设计契约：`reports/model-management-design.md`（Phase A）

---

## 1. 结论

原来"启动就写死打开 `data/processed/model.glb`"的程序，现在是：

```
双击 start.bat → 本地后端 → Model Selector（Project / Model / Version）→ Open → Viewer
                              ↘ Import Model → 自动转换 → 注册版本 → 可直接打开
```

| 项 | 结果 |
|---|---|
| Project / Model / Version 三层资产 | ✅ 文件系统 + JSON manifest，无数据库 |
| 多项目 / 多模型 / 多版本任意切换 | ✅ 启创项目(Main Site 3 版 + Tank Area) · 丙酸项目(Main Site 1 版) 实测切换 |
| 导入一个 RVM+TXT → 可查看的版本 | ✅ 后端 8.2–11.9 s（含 4.5 MB 上传 → 转换 → 映射 → 三条独立校验） |
| 复用现有转换链 | ✅ 只调 `converter/*.py`，**没有第二套转换器**，算法零改动 |
| 不覆盖历史版本 | ✅ 同名版本返回 409 并给出可读提示；失败版本单独成目录，互不影响 |
| 删除 | ✅ 一律移入 `data/trash/`，不物理删除 |
| 原 QICHUANG 模型 | ✅ 迁移为 `启创项目/Main Site/2026-08-26`，**未重新转换**，逐字节对账通过 |
| 原 Viewer 功能 | ✅ Selection / Hide / Isolate / Show All / Tree / Properties 全部保持 |
| 连续切换 10 次 | ✅ BufferGeometry 恒为 5,797、纹理恒为 2、场景节点恒为 5；JS 堆稳态 67.4 → 70.8 MB |

两个自造的坑也记在这里（都是实测踩出来的，不是推测）：`tools/serve.py` 留下的 3 个旧进程 + Windows 的 `SO_REUSEADDR` 让同一端口被绑了 4 次、请求被随机分流；`shutil.rmtree` 在本机沙箱下会抛 `SAFE_DELETE_FAIL_CLOSED`。两者都已按"不依赖环境"的方式处理，见 §7。

---

## 2. 实际落盘结构

```
data/
├─ projects/
│  ├─ qichuang/                              启创项目
│  │  ├─ project.json                        {id,name,description,createdAt,updatedAt}
│  │  └─ models/
│  │     ├─ main-site/                       Main Site
│  │     │  ├─ model.json
│  │     │  └─ versions/
│  │     │     ├─ 2026-08-26/                ← 迁移自原 demo（未重转）
│  │     │     ├─ 2026-09-18/                ← 经导入流水线生成
│  │     │     └─ 2026-09-19/                ← 经导入 UI 生成
│  │     │        ├─ version.json
│  │     │        ├─ source/     model.rvm · model.txt            （只读源）
│  │     │        ├─ processed/  model.glb · metadata.json · metadata.metamodel.json
│  │     │        │              rvm-node-index.json · mapping.json
│  │     │        └─ reports/    conversion.log · validation.json · validation.*.json
│  │     └─ tank-area/                       （暂无版本的模型）
│  └─ propionic-acid/                        丙酸项目 → main-site → 2026-09-03
├─ import-jobs/                              导入暂存区（上传的原始字节）
├─ trash/                                    删除的东西都在这儿，可人工取回
└─ _legacy_demo_2026-08-26/                  迁移前的 data/source + data/processed（未删除）
   ├─ source/   QICHUANG-SITE-RVM-2026-08-26.rvm · QICHUANG-SITE-2026-08-26.txt
   └─ processed/ model.glb · metadata.json · … · mapping.json
```

`version.json` 里存了任务书 §4 要求的时间与统计字段（`createdAt`/`importedAt`/`sourceRvm`/`sourceTxt`/`status`/`originalRvmFilename`/`originalTxtFilename` + `stats{rvmBytes,txtBytes,glbBytes,objectCount,namedNodes,rvmGroups,mappedObjects,mappingRate,triangles,meshes,lines,durationMs,converterVersion}`），并额外留了 `history[]`。这些字段目前只写不读——版本比较将来直接用，不用改结构。
**跨版本对象身份仍然只用 PDMS 原始身份**（canonical / 层级 path / Type，`metadata.json` 字段一个没改），没有引入任何新 GUID。

---

## 3. 交付物

| 类型 | 文件 | 说明 |
|---|---|---|
| 新增 | `tools/asset_store.py` | 资产仓库：ID 校验、扫描、创建/改名/删除（移入 trash）、manifest 读写、版本注册 |
| 新增 | `tools/import_pipeline.py` | 导入流水线：暂存 → 调现有转换链 → 校验闸门 → 注册版本；含 job 阶段状态；也可当 CLI 用（无界面导入） |
| 新增 | `tools/server.py` | 本地后端：`/api/*` + 静态服务，只用标准库，只监听 `127.0.0.1` |
| 新增 | `tools/migrate_demo.py` | 一次性迁移 demo 到新结构（复制→sha256 对账→重跑校验→原件移入 legacy） |
| 新增 | `viewer/js/api.js` | 后端 API 客户端（含 XHR 上传进度） |
| 新增 | `viewer/js/assetManager.js` | Project Manager 侧栏 · Model Selector · Import 弹窗 · Recent · Details/Log |
| 改 | `viewer/app.js` | 拆成「启动层（选择/导入）」+「查看层（openVersion）」；原工具条/导航接线保留 |
| 改 | `viewer/index.html` | 加启动层、顶部标题条、导入弹窗、通用弹窗、右键菜单；Viewer 三栏原样 |
| 改 | `viewer/js/data.js` | `loadData({base})`：三份 JSON 路径由调用方给，不再写死 |
| 改 | `viewer/js/viewer3d.js` | **新增 `unload()`**（原来完全没有卸载路径）；去掉写死的 7423 警告 |
| 改 | `viewer/js/tree.js` / `props.js` | 新增 `setData()`，换版本时复用实例（避免监听叠加） |
| 改 | `start.bat` | 唯一入口改为启动本地后端（不再需要预先转换，也不再依赖 `data/processed/`） |
| 改 | 6 个 `converter/*.py` | **只加参数、不改算法**：`--input/--output/--log/--evidence-dir` 等同义参数 |
| 改 | `converter/verify_metadata.py` | 一行：写死的 `92871` 换成等价恒等式（见 §5） |
| 报告 | `reports/model-management-design.md` | Phase A 设计契约 |
| 报告 | `reports/phase8-report.md` | 本文件 |
| 证据 | `reports/evidence/phase8-*.json` | 迁移对账 / API 与流水线 / 浏览器实测原始数据 |
| 截图 | `reports/phase8-*.png` | launcher · viewer · isolated · import dialog/ready/failed · imported-open |

---

## 4. 导入流水线

```
浏览器选 RVM+TXT ──PUT──▶ data/import-jobs/<jobId>/source/   （原始字节，无 multipart 解析）
                              │
                              ├─ copying     建 Project/Model/Version 目录，源文件落到 source/（固定名 model.rvm / model.txt）
                              ├─ geometry    ① rvm_to_glb.py            → processed/model.glb
                              ├─ metadata    ② txt_parser.py            → metadata.json + metadata.metamodel.json
                              ├─ mapping     ①附 rvm_index.py + ③ map_objects.py → rvm-node-index.json, mapping.json
                              ├─ validating  verify_glb + verify_metadata(33 项) + verify_mapping(21 项) → reports/validation.json
                              └─ ready       version.json: status=ready + stats
```

实测（同一份 4.5 MB RVM + 1.3 MB TXT）：

| 环节 | 耗时 |
|---|---|
| 后端 CLI 全链（无上传） | 5.8 s |
| 经 HTTP（含 4.5 MB 上传 + 前端轮询） | 8.2–11.9 s |
| 其中 geometry / metadata / mapping / validating | 1.04 s / 0.80 s / 0.73 s + 0.83 s（含 7,420 条字节偏移回读）/ 校验三项 |

三条闸门全部通过后的产物与 demo **逐项同源**：

| 项 | 迁移来的 2026-08-26 | 导入生成的 2026-09-18 |
|---|---|---|
| GLB 体积 | 18,385,928 B | 18,385,960 B（+32 B，原因见 §6） |
| 三角形 | 335,824 | 335,824 |
| 节点 / 网格 | 7,931 / 5,796 | 7,931 / 5,796 |
| TXT 对象 | 8,955 | 8,955 |
| 几何对应 | 7,420 / 7,420 = 100% | 7,420 / 7,420 = 100% |

失败处理：`status=failed` 写进 `version.json`，`error={stage,message}` 直接显示在界面（含 converter 的输出尾部），源文件与 `conversion.log` 保留，`[重试]` 复用已保存的源文件原地重跑（不需要重新选文件）。**状态绝不会停在 `importing`。**

---

## 5. 关键决策（都有实测依据）

| # | 决策 | 依据 |
|---|---|---|
| 1 | **Project/Model/Version 的目录名必须是 ASCII slug**，中文只留在 `name` 字段 | `rvmparser` 把源文件路径原样写进 GLB 的 JSON 块；非 ASCII 会让 GLB 变成非法 UTF-8（`reports/phase2-report.md` 已知问题 #2）。中文目录名 = 转换必坏 |
| 2 | 上传用**分片 PUT**而不是 `multipart/form-data` | Python 3.13 已移除 `cgi`，标准库没有 multipart 解析器；手写边界解析是纯 bug 来源。代价是 4 次请求，换来"零自定义协议解析" |
| 3 | 删除**移入 `data/trash/`** | 成本只有一次 `os.rename`，换来"误删可人工取回" |
| 4 | 版本列表**按名称自然降序**（`2026-09-19 > 2026-09-18 > 2026-08-26`，`v2 < v10`） | 版本名就是迭代标识，用户看到的顺序应跟名字一致；按导入时间排会在"补导一个旧版本"时错位 |
| 5 | **不做 `index.json`** | 一次全量扫描 < 5 ms（2 项目/3 模型/7 版本）。任务书 §29 说的是"如果需要"；多一层缓存就多一个可能与事实源不一致的文件 |
| 6 | 后端 API 请求级串行（一把可重入锁） | 扫描与增删不会互相踩；请求处理 < 20 ms，串行没有代价 |
| 7 | `verify_glb` 不改算法，闸门从它的输出取（`json_utf8_ok` / `nodes>0` / `triangles>0`） | 它本来只输出结构报告、没有判定语义；改它就得碰算法，读它的输出更干净 |
| 8 | `verify_metadata.py` 里写死的 `92871` 换成 `logicalRecords + continuationRecords` | 原值只是 QICHUANG 这一个文件的实测值，换文件必误报。恒等式在本样例 `92843 + 28 = 92871` 完全相等，且保留原意（独立重算 vs 产物自记的交叉对账）。已实测 33 项仍全通过 |
| 9 | 端口探测先 `connect_ex` 再 `bind`，并设 `SO_EXCLUSIVEADDRUSE` | 实测踩到：Windows 下 `SO_REUSEADDR` 允许第二个进程绑同一端口，8765 上同时有 4 个旧服务在听，接口返回的是静态 404。现在端口被占就直接失败、往后退 |
| 10 | 重试清理**逐文件删除**而不是 `shutil.rmtree` | 本机沙箱下 `rmtree` 抛 `SAFE_DELETE_FAIL_CLOSED`；Windows 上文件被占用也会整体失败。这一步只是可选清理，不该拖垮整个导入 |
| 11 | `backToLauncher`（切换模型）**不卸载**当前模型，只有"打开另一个版本"才卸载 | 前者只是去挑版本，"返回 Viewer" 应该立刻能看；真正需要释放显存的是换模型，那一步在 `Model3D.load()` 里先 `unload()` |

---

## 6. 迁移对账（任务书 §30：不要重新转换）

搬运方式：复制 → sha256 逐项比对 → 原地重跑三条校验器 → 原件移入 `data/_legacy_demo_2026-08-26/`（**未删除**）。

| 文件 | 字节 | sha256(前 12) |
|---|---|---|
| `source/model.rvm` | 4,505,600 | `44bfb8fae9d4` |
| `source/model.txt` | 1,344,437 | `180b864ca85e` |
| `processed/model.glb` | 18,385,928 | `1191a8df4b6f` |
| `processed/metadata.json` | 5,541,010 | `bab8f10e0d82` |
| `processed/metadata.metamodel.json` | 5,501,767 | `2ac5fe11cc51` |
| `processed/rvm-node-index.json` | 3,901,591 | `1c5d7b3282ed` |
| `processed/mapping.json` | 1,406,286 | `6c99971062e7` |

搬运后在新路径上重跑：GLB 结构 ✅ · metadata 33 项 ✅ · mapping 21 项（含 7,420 条字节偏移回读）✅。

### 6.1 那 +32 字节是什么（已逐字节核实，不是"应该没问题"）

同一份源文件、同一条转换链，2026-09-18 的 GLB 比 demo 的 GLB 大 32 字节。拆开看：

```
bin 块 sha256            完全相同（12,917,168 B，两边一致）
节点/网格/材质数          7,931 / 5,796 / 1，完全相同
JSON 除 File 节点名外     完全相同（把那一处名字替换成同一个占位符后逐字符相等）
File 节点 A              data/source/QICHUANG-SITE-RVM-2026-08-26.rvm        （43 字符）
File 节点 B              data/projects/qichuang/models/main-site/versions/2026-09-18/source/model.rvm  （75 字符）
差值                     32 字节
```

也就是说：**唯一差异是 rvmparser 写进 GLB 的源文件路径字符串长度**，几何一个字节没变。这同时反证了 ASCII 相对路径这条约束确实在生效（写进去的正是我们给的相对路径）。

---

## 7. 测试（Phase G 15 项对照）

| # | 任务书要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 导入一个新 Version | ✅ 后端 + UI 双路径 | `phase8-api-test` ① / `phase8-verify` 导入 UI |
| 2 | 同一 Model 导入第二个 Version | ✅ 2026-08-26 / 09-18 / 09-19 并存 | 版本列表 |
| 3 | 创建第二个 Model | ✅ Tank Area（空模型也正常显示） | api ③ |
| 4 | 创建第二个 Project | ✅ 丙酸项目 | api ④ |
| 5 | Project 间切换 | ✅ 启创项目 ⇄ 丙酸项目，标题/数据/树全变 | verify「切换到另一个 Project」 |
| 6 | Version 间切换 | ✅ 标题、GLB 路径、树、属性同步 | verify「Model Selector 切版本」 |
| 7 | 连续切换模型 ≥10 次 | ✅ 10 次：几何 5,797 恒定、纹理 2 恒定、场景节点 5 恒定、JS 堆稳态 67.4→70.8 MB | verify switchSeq |
| 8 | 导入错误 RVM | ✅ 停在 `geometry`，源文件保留 | api ⑧ |
| 9 | 导入错误 TXT | ✅ 停在 `metadata`（0 对象闸门），提示"不是 PDMS Data Listing" | api ⑨ / verify 失败路径 |
| 10 | 导入缺失 TXT | ✅ 启动即被拒 `source_missing`，不落盘 | api ⑩ |
| 11 | 重复 Version | ✅ 409 `version_exists`，manifest 未被改动 | api + verify UI 提示 |
| 12 | 关闭程序重新启动 | ✅ 直接扫盘结果与 API 一致（事实来源是文件系统） | api ⑫ |
| 13 | 项目列表仍正确 | ✅ 2 项目 / 3 模型 / 可见版本，含失败版本状态点 | verify launcherState |
| 14 | 原 QICHUANG 模型仍正常 | ✅ 7,423 命名节点 / 8,955 对象 / 100% 对应 | verify 首开 |
| 15 | 原 Selection / Hide / Isolate / Tree / Properties | ✅ 真实鼠标点击命中、可见 7420→7419→7420、隔离剩 5、树→属性有内容 | verify 回归段 |

汇总：**浏览器 34/34**（`reports/evidence/phase8-verify.json`）、**后端 35/35**（`reports/evidence/phase8-api-test.json`）。全程无 pageerror；唯一被浏览器记为 console error 的是刻意触发的 409（重复版本），页面自身已正确提示。

复现：

```bash
python tools/server.py --port 8765 --no-browser          # 或双击 start.bat
python scratch/phase8-api-test.py                        # 后端 + 流水线
NODE_PATH=<node-workspace>/node_modules node scratch/phase8-verify.js   # 浏览器
python tools/migrate_demo.py                             # 迁移（已执行过，幂等）
```

---

## 8. 开发过程中修掉的问题

| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | 8765 上同时有 4 个服务在监听，`/api/*` 返回静态 404 | `tools/serve.py` 的旧进程未退出 + Windows `SO_REUSEADDR` 允许重复绑定同一端口 | 停掉 3 个遗留 `serve.py`（无状态静态服务）；`server.py` 改为 `SO_EXCLUSIVEADDRUSE` + 连接探测选端口 |
| 2 | 导入在 `mapping` 阶段失败，但 mapping.json 其实已生成 | `map_objects.py` 最后一行 `a.out.relative_to(ROOT)`：传相对路径时 `relative_to` 抛 `ValueError`（Python 3.12+ 行为） | 打印前先 `resolve()`。纯打印缺陷，判断逻辑未动 |
| 3 | 失败版本的 `version.json` 停在 `importing` | job 失败时只改了内存状态，没回写 manifest | `Job.fail()` 统一把 `status=failed` + `error` 写回 manifest |
| 4 | `retry` 报 404 | 后端进程是加接口之前启动的（经典"改了代码没重启"） | 重启后端；交付说明里写清"改后端要重启" |
| 5 | 重试抛 `SAFE_DELETE_FAIL_CLOSED` | `shutil.rmtree` 遇到沙箱/被占用文件会整体失败 | 改成逐文件尽力删除（§5 #10） |
| 6 | 页面白屏 | `document.getElementById('toastClose')` 为 null（HTML 里没有这个按钮），`_bind()` 抛错，整个模块中断 | 绑定改为不存在则跳过；启动时显式 `am.show()` |
| 7 | 树上的 `Open` 按钮点不到 | 行内操作按钮只在 hover 时 `display:flex` | Version 行的 `Open` 改常显（它本来就是主操作），`⋯` 仍只在 hover/选中时出现 |
| 8 | `verify_metadata.py` 换文件必失败 | 写死样例常量 92871 | 换成等价恒等式（§5 #8） |

---

## 9. 已知限制 / 本阶段明确没做

| 项 | 说明 |
|---|---|
| 版本比较 / Diff | 未做（任务书明确排除）。但 `version.json` 的 stats + 不变的 canonical/hierarchy 字段已为它留好位置 |
| `index.json` 缓存 | 未做，理由见 §5 #5；规模真变大时再加，且只能当缓存 |
| Import job 不跨后端重启 | 重启后 `JOBS` 内存表清空，进行中的 job 会 404；已完成/失败的版本不受影响（状态在 `version.json` 里） |
| 单根 TXT 假设 | `verify_metadata.py` 有 `根数 == 1` 的检查，多 SITE 的导出会在这条上失败（提示明确，不会静默） |
| `verify_glb.py` 无退出码语义 | 闸门由流水线读它的 JSON 判定（§5 #7），不是它自己判 |
| 前端用原生 `<select>` + 自定义弹窗 | 不引前端框架（任务书禁止引入重型依赖），代价是样式朴素 |
| 归属地：上传不落地校验 | 只校验扩展名与后端解析结果，不校验 RVM 版本号 |
| `data/_legacy_demo_2026-08-26/` | 迁移原件按设计保留（27 MB）。确认新结构没问题后可自行删除 |
| `data/trash/` | 删除的东西在这里累积，程序不自动清理 |
| `data/import-jobs/` | 上传暂存区。成功的 job 会留下源文件副本（与 `version/source/` 内容相同），可人工清空 |

---

## 10. 下一步（供参考，未启动）

1. **版本比较**：以 `canonical` 为跨版本身份，比较两个 `mapping.json` → 新增/删除/数量变化；`version.json.stats` 已可直接出对比表。
2. **模型树跨版本标记**：在当前树里标出"这一版新增/删掉的元件"。
3. **列表排序与搜索**：项目/模型多起来之后加过滤框（当前原生选择器够用）。
4. **`data/import-jobs/` 自动回收**：成功导入后清理暂存副本。
