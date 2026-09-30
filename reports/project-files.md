# Project Files — 项目资料管理

完成日期：2026-09-30。

## 使用

首页右侧新增 Project Files 面板。先选择 Project，点 Upload File 选择一个或多个文件。
每个文件最大 100 MB（100 × 1024 × 1024 字节）；多文件依次上传，显示上传进度及逐文件失败信息。
上传时切换 Project，已选择的整批文件仍上传到原项目，进度信息明确显示目标项目。

列表显示 File Name、Type、Size、Uploaded Time、Download、Delete，并按上传时间倒序排列。
文件名搜索不区分大小写，只匹配文件名；搜索与 Type 分类同时生效。
切换 Project 时清空旧项目列表与筛选条件，读取新项目资料；切换 Model / Version 不改变文件列表。
同项目内的同名文件自动改为 `设备表 (1).xlsx` 等安全名称，不覆盖原文件。

Download 直接下载并保留中文文件名。Delete 先确认，再输入现有删除密码；删除移入现有回收站。
内网身份可上传、删除；外部员工可读取所有项目，客户只能读取获授权项目。
只读界面隐藏上传、删除入口，后端仍独立检查权限。

分类：CAD（dwg/dxf）、PDF、Spreadsheet（xlsx/xls/csv）、Document（doc/docx）、
Image（png/jpg/jpeg/gif/bmp/webp/svg/tif/tiff/ico/avif/heic/heif）及 Other。扩展名不区分大小写。

## 存储与接口

沿用 Python 标准库、本地项目目录、JSON 记录和全局存储锁，无新增运行依赖。

```text
data/projects/<projectId>/files/
  files.json
  <opaqueFileId>/
    content.bin
    record.json
```

记录字段为 `id`、`projectId`、`fileName`、`type`、`size`、`uploadedAt`、
`relatedModelId`、`relatedVersionId`。最后两个可选字段第一版均为 null，不提供关联界面。
显示名称与磁盘路径分离；自动处理 Windows 非法字符、保留名、名称长度和不区分大小写的重名。
同名分配和提交受锁保护，JSON 原子替换，提交失败撤销新文件；删除记录提交失败时恢复回收站内容。

| 接口 | 作用 |
|---|---|
| `GET /api/projects/<pid>/files` | `{projectId, files, maxFileBytes}` |
| `POST /api/projects/<pid>/files?name=<encodedName>` | 原始二进制请求体上传单文件，返回记录 |
| `GET /api/projects/<pid>/files/<fid>/download` | 经过权限检查的附件下载 |
| `DELETE /api/projects/<pid>/files/<fid>` | 使用现有 `X-Delete-Password`，返回删除及回收站结果 |

除附件下载外，接口沿用 `{ok, data}` / `{ok, error}` 响应。
上传前检查权限、长度和大小限制，流式接收避免将 100 MB 请求整体放入内存。
下载仅从指定项目的记录查找文件，不接受用户提供的磁盘路径。
项目资料目录不提供静态访问；静态守卫使用实际解码、规范化后的路径检查权限，阻止编码或路径绕过。

前端实现位于 `viewer/js/projectFiles.js`，由现有 AssetManager 接入。
后端实现位于 `tools/project_file_store.py`，由现有 server 路由接入。
没有添加文件夹、标签、在线预览、全文搜索、文件版本树或额外权限体系。

## 验证结果

- Python 与三个修改的 JavaScript 模块语法检查通过。
- **21/21 接口场景通过**：多文件请求、项目隔离、分类、排序、中文及并发同名文件、安全名称、
  下载原始字节、删除密码与回收站、匿名/客户/外部员工权限、静态路径绕过、100 MB 边界、
  非法及截断请求、模型版本独立性、服务重启持久化。
- 实际上传并逐块验证下载了恰好 104,857,600 字节的文件；超出 1 字节的请求在读取正文前拒绝。
- **38/38 Chromium 浏览器检查通过**：真实多文件选择器、分类与文件名组合筛选、排序、项目树与
  Project 下拉切换、页面刷新、中文文件下载、删除确认与取消、错误密码重试、延迟响应、上传期间
  切换项目、部分上传失败、客户只读界面，以及桌面尺寸下的布局边界。
- 浏览器未出现未捕获的页面错误；测试结束后临时项目和测试服务清理完成。
- 现有 ready 模型实际打开并返回首页成功，模型导入弹窗正常；导入任务创建、源文件上传、状态读取、
  任务清理接口通过。本次未重新执行 RVM 转换全链路，也未重跑整个 Viewer 的三维交互回归。

全部测试使用独立临时数据；未向实际项目加入测试文件。按个人使用要求未做截图视觉验收。

可复跑脚本：

```powershell
python -X utf8 scratch/project-files-api-test.py
$env:NODE_PATH='C:/Users/34084/AppData/Roaming/npm/node_modules/openclaw/node_modules'
node scratch/project-files-browser-test.cjs
```

浏览器测试使用本机已有 Chromium 1208，并从临时副本启动完整首页和真实模型夹具。
检查明细见 `reports/evidence/project-files-api-test.json` 和 `reports/evidence/project-files-browser-test.json`。

重启现有服务并刷新首页后使用新功能。
