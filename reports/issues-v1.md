# 3D 批注 / Issue 第一版

## 使用

启动新版后端，打开模型，选中元件，右键 → 添加批注 → 输入意见并保存。
顶部「批注」开启审阅模式：突出显示未处理 Marker，并展开右侧面板。
列表、树节点旁的红色计数均可点击定位；Marker 单击打开记录、双击定位。
定位复用原选择联动，显示关联对象并立即恢复创建时的相机视角，不增加飞行动画。
面板可独立收起，顶部「批注」可重新打开；再次点击顶部入口退出模式。

状态为待修改、已修改待复核、已关闭、无需修改。后两项视为已处理，不计入树计数或上一个/下一个导航。
树计数是该节点直接关联的未处理 Issue 数量，不重复汇总到所有祖先。
已处理记录仍保留在列表。审阅模式隐藏非当前选中的已处理 Marker。

右键命中所选元件时保存实际表面 XYZ；否则复用该元件最近的拾取点。
仅从树选中、没有可用表面点时，使用对象包围盒中心，并在创建对话框注明。
多选时批注关联主选中元件，对话框显示对象名称。

## 修改文件与复用边界

| 文件 | 内容 |
| --- | --- |
| `viewer/js/issues.js`（新增） | Issue 生命周期、创建表单、列表、状态、导航、Marker 投影 |
| `viewer/issues.css`（新增） | 小型 Marker、折叠面板与表单样式 |
| `tools/issue_store.py`（新增） | 独立 JSON 保存、验证、编号、状态冲突检测 |
| `viewer/index.html` | 顶部入口、右侧面板、创建对话框、右键菜单项 |
| `viewer/app.js` | 接入版本生命周期和现有菜单；Orbit 右键也可使用菜单 |
| `viewer/js/viewer3d.js` | 复用拾取保存表面点；相机快照/恢复、显示目标、帧回调 |
| `viewer/js/tree.js` | 节点计数和点击定位，支持懒展开行 |
| `viewer/js/api.js`、`tools/server.py` | 版本范围内的读取/新增/状态更新接口 |
| `scratch/issues-regression.cjs`、`scratch/issue-store-test.py`（新增） | 浏览器完整流程与存储并发/冲突/非法数据验证 |

保留 canonicalId、metadata、原节点树、BatchRendering faceIndex 映射和现有选择逻辑。
Marker 是 DOM 覆盖层，复用渲染帧，不加入 Three.js 模型树、拾取集合或后处理。
Marker 在模型遮挡时仍可见，以便发现问题；视锥外不显示。大量重叠 Marker 的聚合不在本版范围。

## 保存方式

`data/projects/<projectId>/models/<modelId>/versions/<versionId>/issues.json`

首次创建批注时生成文件，不修改 GLB、RVM、TXT 或模型 manifest。
沿用仓库锁与临时文件原子替换。状态更新带 `revision`，旧修订请求返回 409，防止覆盖他人更新。
失败时显示错误；创建失败保留输入；可用「重新加载」读取其他客户端的更新。本版不做实时推送。
继承现有权限：内网可写；项目只读用户仅查看授权项目的 Issue 和定位。

文档 schema 为 `model-review-issues/1`，记录项目/模型/版本和 `coordinateSpace: gltf-world-meters`。
每条 Issue 保存：

- `id`（UUID）、版本内 `number`、批注 `text`、`createdAt`、`updatedAt`、`status`、`revision`。
- `node.canonicalId` 为关联主键；`txtId`、`name` 为辅助信息，不能单独用名称跨版本匹配。
- `position` 为查看器世界坐标 XYZ（米），`positionSource` 区分表面点和对象中心。
- `camera.position/target/quaternion/up/fov/near/far`，Game 模式保存实际朝向，并在恢复后调用原导航 `rebase()`。
- `projectId/modelId/versionId/originVersionId`、`lineageId`、`inheritedFrom`、`bindingStatus` 为继承预留。

## 下一步：跨版本继承

在新版本导入完成后增加显式继承操作，只复制上一版本的 `open/review` 项。
新记录生成新 `id`，保留 `lineageId` 与最初的 `originVersionId`，`inheritedFrom` 保存来源版本及 Issue ID；新旧版本状态彼此独立。
先在同一项目、同一模型内按 canonicalId 验证关联，再用模型映射信息处理改名或重建节点。
缺失或多义匹配标为待重新绑定，不按名称猜测；界面提供手动选中新节点。
坐标和相机须比较两版本 GLB 的 rvmparser-origin、节点变换和单位；原点变化时转换坐标，元件移动时复核表面锚点。
仅匹配节点 ID 不能保证旧 XYZ 仍处于新元件表面。本版只预留数据结构，没有自动继承。

## 验证

- 浏览器 Issue 流程 24 项通过，0 页面异常；测试使用独立临时项目，结束后清理。
- 原选择、搜索、树/属性、隐藏、隔离、Ctrl 多选、轮廓线等 15 项既有回归通过。
- JS 语法检查、Python 编译与独立存储测试通过。按个人使用要求未额外做截图视觉验收。
- 浏览器证据：`reports/evidence/issues-regression.json` 与 `reports/evidence/appearance-regression.json`。
- 本轮新版服务使用 8900；8899 是之前启动的旧服务。旧服务需要重启才会加载新增接口。
