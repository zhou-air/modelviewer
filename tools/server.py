"""本地后端 —— 静态服务 + 模型资产管理 API。

原则（任务书 §15）：
  * 默认只监听 127.0.0.1；加 --host 0.0.0.0 可让局域网内设备访问。文件只写本机 data/ 下。
  * 只用 Python 标准库：不引入 Django / ORM / 数据库 / 任务队列。
  * 静态服务直接复用 http.server，API 在 /api/ 前缀下由本文件路由。

用法：
    python tools/server.py [--port 8765] [--host 127.0.0.1] [--no-browser]
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import mimetypes
import re
import shutil
import socket
import socketserver
import sys
import threading
import traceback
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import issue_store as I
import asset_store as S            # noqa: E402
import import_pipeline as P        # noqa: E402
import access_control as AC        # noqa: E402  访问权限层（内网识别 / Session / 权限判定）

ROOT = S.ROOT

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/plain", ".rvm")

_SAFE = re.compile(r"^/api/(?P<rest>[A-Za-z0-9/_.\-]*)$")


class ApiError(Exception):
    def __init__(self, http: int, code: str, message: str):
        super().__init__(message)
        self.http, self.code, self.message = http, code, message


# ------------------------------------------------------------------ 路由

def api_health(req) -> dict:
    return {"pipeline": S.PIPELINE_VERSION, "root": str(ROOT),
            "projects": len(S.scan_projects()), "port": req.server.server_address[1]}


def _sanitize_project(doc: dict, ctx: dict) -> dict:
    """非 INTERNAL_NETWORK 身份不返回客户访问码字段（INTERNAL_REMOTE 也不需要）。"""
    if ctx["role"] != "INTERNAL_NETWORK" and "externalAccess" in doc:
        doc = {k: v for k, v in doc.items() if k != "externalAccess"}
    return doc


def api_projects(req) -> dict:
    ctx = req.access
    if ctx["role"] == "CLIENT_PROJECT":
        # 客户：只返回自己被授权的项目，绝不下发完整项目列表
        projects = [S.scan_project(S.require_project(ctx["projectId"]))]
        projects = [_sanitize_project(p, ctx) for p in projects]
        return {"projects": projects,
                "totals": {"projects": len(projects),
                           "models": sum(p["modelCount"] for p in projects),
                           "versions": sum(p["versionCount"] for p in projects)}}
    projects = [_sanitize_project(p, ctx) for p in S.scan_projects()]
    out = {"projects": projects,
           "totals": {"projects": len(projects),
                      "models": sum(p["modelCount"] for p in projects),
                      "versions": sum(p["versionCount"] for p in projects)}}
    if ctx["role"] == "INTERNAL_NETWORK":
        out["trash"] = S.trash_list()[:20]
    return out


def api_project(req, pid: str) -> dict:
    AC.require_view_project(req.access, pid)
    return _sanitize_project(S.scan_project(S.require_project(pid)), req.access)


def api_create_project(req) -> dict:
    b = req.body_json()
    return S.create_project(b.get("name", ""), b.get("id"), b.get("description", ""))


def api_patch_project(req, pid: str) -> dict:
    b = req.body_json()
    return S.update_project(pid, b.get("name"), b.get("description"))


def api_delete_project(req, pid: str) -> dict:
    return S.delete_project(pid)


def api_create_model(req, pid: str) -> dict:
    b = req.body_json()
    return S.create_model(pid, b.get("name", ""), b.get("id"), b.get("description", ""))


def api_patch_model(req, pid: str, mid: str) -> dict:
    b = req.body_json()
    return S.update_model(pid, mid, b.get("name"), b.get("description"))


def api_delete_model(req, pid: str, mid: str) -> dict:
    return S.delete_model(pid, mid)


def api_version(req, pid: str, mid: str, vid: str) -> dict:
    return S.find_version(pid, mid, vid)


def api_issues(req, pid, mid, vid):
    return I.read(pid, mid, vid)


def api_issue_create(req, pid, mid, vid):
    return I.create(pid, mid, vid, req.body_json())


def api_issue_update(req, pid, mid, vid, iid):
    return I.update(pid, mid, vid, iid, req.body_json())


def api_version_log(req, pid: str, mid: str, vid: str) -> dict:
    f = S.require_version(pid, mid, vid) / "reports" / "conversion.log"
    return {"exists": f.exists(), "text": f.read_text(encoding="utf-8") if f.exists() else ""}


def api_patch_version(req, pid: str, mid: str, vid: str) -> dict:
    b = req.body_json()
    name = (b.get("name") or "").strip()
    if not name:
        raise ApiError(400, "version_name_required", "Version 名称不能为空")
    with S.LOCK:
        f = S.require_version(pid, mid, vid) / "version.json"
        doc = S.read_json(f)
        doc["name"] = name                      # 只改显示名；目录名（id）保持不变
        S.write_json(f, doc)
        return doc


def api_delete_version(req, pid: str, mid: str, vid: str) -> dict:
    return S.delete_version(pid, mid, vid)


def api_suggest_id(req) -> dict:
    q = req.query
    kind = q.get("kind", "project")
    name = q.get("name", "")
    if kind not in ("project", "model"):
        raise ApiError(400, "bad_kind", "kind 只能是 project / model")
    slug = S.slugify(name)
    return {"slug": slug, "suggested": S.suggest_id(name, kind),
            "needsId": not slug,
            "note": "ID 必须是 ASCII（转换器会把路径写进 GLB，非 ASCII 会让 GLB 非法）"}


def api_import_create(req) -> dict:
    b = req.body_json()
    job = P.create_job(
        project_id=b.get("projectId"), model_id=b.get("modelId"),
        version_name=(b.get("versionName") or "").strip(),
        version_id=b.get("versionId"),
        new_project_name=b.get("newProjectName"), new_model_name=b.get("newModelName"),
        new_project_id=b.get("newProjectId"), new_model_id=b.get("newModelId"),
        rvm_filename=b.get("rvmFilename") or "", txt_filename=b.get("txtFilename") or "")
    return job.to_dict()


def api_import_retry(req) -> dict:
    """失败版本原地重跑：源文件已在版本目录里，不需要重新上传。"""
    b = req.body_json()
    for k in ("projectId", "modelId", "versionId"):
        if not b.get(k):
            raise ApiError(400, "missing_param", f"缺少参数 {k}")
    job = P.retry_job(b["projectId"], b["modelId"], b["versionId"])
    return job.to_dict()


def api_import_upload(req, job_id: str, which: str) -> dict:
    if which not in ("rvm", "txt"):
        raise ApiError(404, "bad_source", "源文件槽只能是 rvm / txt")
    job = P.get_job(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "导入任务不存在（后端可能已重启）")
    n = P.save_upload(job, which, req.body_raw())
    return {"jobId": job_id, "which": which, "bytes": n, "uploaded": job.uploaded}


def api_import_start(req, job_id: str) -> dict:
    job = P.get_job(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "导入任务不存在（后端可能已重启）")
    P.start_job(job)
    return job.to_dict()


def api_import_state(req, job_id: str) -> dict:
    job = P.get_job(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "导入任务不存在（后端可能已重启）")
    return job.to_dict()


def api_import_log(req, job_id: str) -> dict:
    job = P.get_job(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "导入任务不存在（后端可能已重启）")
    return {"jobId": job_id, "text": job.log_text()}


def api_import_delete(req, job_id: str) -> dict:
    job = P.get_job(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "导入任务不存在")
    if job.stage not in ("queued", "ready", "failed"):
        raise ApiError(409, "job_running", "导入正在进行，无法清理")
    shutil.rmtree(job.dir, ignore_errors=True)
    with P.JOBS_LOCK:
        P.JOBS.pop(job_id, None)
    return {"removed": job_id}


# ------------------------------------------------------------------ 访问权限 API

def api_access_status(req) -> dict:
    return AC.status_payload(req.access)


def api_access_login(req) -> dict:
    """一个输入框两种码：先试今日内部码，再试项目访问码；失败统一口径。"""
    code = (req.body_json().get("code") or "").strip()
    if not code:
        raise ApiError(400, "code_required", "请输入访问码")
    if AC.verify_internal_code(code):
        role, pid = "INTERNAL_REMOTE", None
    else:
        pid = AC.find_project_by_access_code(code)
        if pid is None:
            raise ApiError(401, "invalid_code", "访问码无效或已失效")
        role = "CLIENT_PROJECT"
    token, ttl = AC.create_session(role, pid)
    req.set_session_cookie(token, ttl)
    return AC.status_payload({"role": role, "projectId": pid})


def api_access_logout(req) -> dict:
    if req.access.get("sessionId"):
        AC.drop_session(req.access["sessionId"])
    req.clear_session_cookie()
    return {"loggedOut": True}


def api_access_internal_code(req) -> dict:
    doc = AC.today_internal_code()
    return {"code": doc["code"], "date": doc["date"],
            "note": "今日有效，明天自动更换；外网员工凭此码进入全项目只读模式"}


def api_project_access_get(req, pid: str) -> dict:
    AC.require_internal(req.access, "管理客户访问码")
    return AC.get_external_access(pid)


def api_project_access_post(req, pid: str) -> dict:
    AC.require_internal(req.access, "管理客户访问码")
    action = req.body_json().get("action")
    if action == "enable":
        return AC.set_external_access(pid, enabled=True)
    if action == "disable":
        return AC.set_external_access(pid, enabled=False)
    if action == "regenerate":
        return AC.set_external_access(pid, regenerate=True)
    raise ApiError(400, "bad_action", "action 只能是 enable / disable / regenerate")


# (http_method, 正则, 处理函数, 参数名列表)
ROUTES: list[tuple[str, re.Pattern, object, tuple[str, ...]]] = [
    ("GET", re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)/issues$"), api_issues, ("pid", "mid", "vid")),
    ("POST", re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)/issues$"), api_issue_create, ("pid", "mid", "vid")),
    ("PATCH", re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)/issues/(?P<iid>[^/]+)$"), api_issue_update, ("pid", "mid", "vid", "iid")),
    ("GET",    re.compile(r"^/health$"), api_health, ()),
    ("GET",    re.compile(r"^/suggest-id$"), api_suggest_id, ()),
    ("GET",    re.compile(r"^/access/status$"), api_access_status, ()),
    ("POST",   re.compile(r"^/access/login$"), api_access_login, ()),
    ("POST",   re.compile(r"^/access/logout$"), api_access_logout, ()),
    ("GET",    re.compile(r"^/access/internal-code$"), api_access_internal_code, ()),
    ("GET",    re.compile(r"^/projects/(?P<pid>[^/]+)/access-code$"), api_project_access_get, ("pid",)),
    ("POST",   re.compile(r"^/projects/(?P<pid>[^/]+)/access-code$"), api_project_access_post, ("pid",)),
    ("GET",    re.compile(r"^/projects$"), api_projects, ()),
    ("POST",   re.compile(r"^/projects$"), api_create_project, ()),
    ("GET",    re.compile(r"^/projects/(?P<pid>[^/]+)$"), api_project, ("pid",)),
    ("PATCH",  re.compile(r"^/projects/(?P<pid>[^/]+)$"), api_patch_project, ("pid",)),
    ("DELETE", re.compile(r"^/projects/(?P<pid>[^/]+)$"), api_delete_project, ("pid",)),
    ("POST",   re.compile(r"^/projects/(?P<pid>[^/]+)/models$"), api_create_model, ("pid",)),
    ("PATCH",  re.compile(r"^/models/(?P<pid>[^/]+)/(?P<mid>[^/]+)$"), api_patch_model, ("pid", "mid")),
    ("DELETE", re.compile(r"^/models/(?P<pid>[^/]+)/(?P<mid>[^/]+)$"), api_delete_model, ("pid", "mid")),
    ("GET",    re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)$"), api_version, ("pid", "mid", "vid")),
    ("PATCH",  re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)$"), api_patch_version, ("pid", "mid", "vid")),
    ("DELETE", re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)$"), api_delete_version, ("pid", "mid", "vid")),
    ("GET",    re.compile(r"^/versions/(?P<pid>[^/]+)/(?P<mid>[^/]+)/(?P<vid>[^/]+)/log$"), api_version_log, ("pid", "mid", "vid")),
    ("POST",   re.compile(r"^/import/jobs$"), api_import_create, ()),
    ("POST",   re.compile(r"^/import/retry$"), api_import_retry, ()),
    ("PUT",    re.compile(r"^/import/jobs/(?P<job_id>[^/]+)/source/(?P<which>[^/]+)$"), api_import_upload, ("job_id", "which")),
    ("POST",   re.compile(r"^/import/jobs/(?P<job_id>[^/]+)/start$"), api_import_start, ("job_id",)),
    ("GET",    re.compile(r"^/import/jobs/(?P<job_id>[^/]+)$"), api_import_state, ("job_id",)),
    ("GET",    re.compile(r"^/import/jobs/(?P<job_id>[^/]+)/log$"), api_import_log, ("job_id",)),
    ("DELETE", re.compile(r"^/import/jobs/(?P<job_id>[^/]+)$"), api_import_delete, ("job_id",)),
]


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "PDMSModelAssetServer/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 基础设施 ----
    def end_headers(self):
        # 导入会就地覆盖产物，切换模型要立刻看到新文件，所以一律禁用缓存
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        try:
            line = fmt % args
        except TypeError:
            line = fmt
        if " 200 " in line and "/api/" not in line and not line.endswith('" -'):
            return                                    # 静态资源成功请求不刷屏
        sys.stderr.write("  %s\n" % line)

    # ---- 读请求体（在拿全局锁之前读完，避免慢客户端拖住整个 API）----
    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    def body_raw(self) -> bytes:
        return getattr(self, "_raw", b"")

    def body_json(self) -> dict:
        raw = self.body_raw()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "bad_json", "请求体不是合法 JSON")

    @property
    def query(self) -> dict:
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in q.items()}

    # ---- 访问身份（Access Gateway） ----
    def _cookie(self, name: str) -> str | None:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def _resolve_access(self) -> dict:
        return AC.resolve_access(self.client_address[0],
                                 self.headers.get("X-Forwarded-For"),
                                 self._cookie(AC.SESSION_COOKIE))

    def set_session_cookie(self, token: str, ttl: int) -> None:
        c = f"{AC.SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={ttl}"
        if AC.CONFIG.secure_cookies:
            c += "; Secure"
        self._out_cookie = c

    def clear_session_cookie(self) -> None:
        self._out_cookie = (f"{AC.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax;"
                            " Max-Age=0")

    # ---- 权限守卫（集中判定，Backend 是最终权限来源） ----
    def _authorize(self, method: str, rest: str, ctx: dict) -> None:
        if rest.startswith("/access/"):
            if (method, rest) in {("POST", "/access/login"), ("GET", "/access/status"),
                                  ("POST", "/access/logout")}:
                return
            if rest == "/access/internal-code" and method == "GET":
                if ctx["role"] != "INTERNAL_NETWORK":
                    raise AC.AccessError(403, "forbidden", "只有公司内网可以读取今日内部码")
                return
            raise AC.AccessError(403, "forbidden", "无权访问")
        if ctx["role"] == "ANONYMOUS":
            raise AC.AccessError(401, "auth_required", "请先输入访问码")
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            AC.require_internal(ctx, "修改数据")
            if method == "DELETE":
                AC.require_delete_password(ctx, self.headers.get("X-Delete-Password"))
            return
        # ---- GET 只读请求 ----
        if rest == "/suggest-id":
            AC.require_internal(ctx, "创建项目 / 模型流程")
            return
        if rest.startswith("/import/"):
            if ctx["role"] == "CLIENT_PROJECT":
                raise AC.AccessError(403, "forbidden", "客户身份不能访问导入管理接口")
            return
        m = (re.match(r"^/projects/([^/]+)(?:/.*)?$", rest)
             or re.match(r"^/versions/([^/]+)/", rest)
             or re.match(r"^/models/([^/]+)/", rest))
        if m:
            AC.require_view_project(ctx, m.group(1))

    # ---- 静态文件守卫（模型文件同样执行项目权限检查；白名单之外一律拒绝） ----
    def _guard_static(self, path: str, ctx: dict) -> None:
        if path.startswith("/viewer"):
            return                              # Viewer 自身与 three.js：所有人可见
        if path.startswith("/data/projects/"):
            parts = path.split("/")
            if len(parts) >= 4:
                if ctx["role"] == "ANONYMOUS":
                    raise AC.AccessError(401, "auth_required", "请先输入访问码")
                AC.require_view_project(ctx, parts[3])
            return
        # 其余一切（/data/trash、/data/access、/config（含删除密码）、/tools、
        # /converter、/reports、/scratch…）一律不通过 HTTP 暴露
        raise AC.AccessError(403, "static_forbidden", "该路径不提供静态访问")

    # ---- 分发 ----
    def _dispatch(self, method: str) -> None:
        from urllib.parse import urlparse
        path = urlparse(self.path).path
        if method in ("POST", "PUT", "PATCH"):
            self._raw = self._read_body()
        else:
            self._raw = b""
        self._out_cookie = None
        self.access = self._resolve_access()
        if not path.startswith("/api/"):
            if method in ("GET", "HEAD"):
                if path in ("/", "/index.html"):
                    self.send_response(302)
                    self.send_header("Location", "/viewer/index.html")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                try:
                    self._guard_static(path, self.access)
                except AC.AccessError as e:
                    self._json(e.http, {"ok": False, "error": {"code": e.code,
                                                               "message": e.message}})
                    return
                return super().do_GET() if method == "GET" else super().do_HEAD()
            self._json(405, {"ok": False, "error": {"code": "method_not_allowed",
                                                    "message": f"{method} {path}"}})
            return
        rest = path[len("/api"):]
        for m, rx, fn, names in ROUTES:
            if m != method:
                continue
            mo = rx.match(rest)
            if mo:
                kwargs = {n: mo.group(n) for n in names}
                try:
                    self._authorize(method, rest, self.access)   # 集中权限守卫
                    with S.LOCK:                     # 请求级串行：扫描与增删不会互相踩
                        data = fn(self, **kwargs)
                    self._json(200, {"ok": True, "data": data})
                except (S.StoreError, ApiError, AC.AccessError) as e:
                    self._json(e.http, {"ok": False, "error": {"code": e.code,
                                                               "message": e.message}})
                except FileNotFoundError as e:
                    self._json(404, {"ok": False, "error": {"code": "not_found",
                                                            "message": str(e)}})
                except Exception as e:  # noqa: BLE001
                    traceback.print_exc()
                    self._json(500, {"ok": False, "error": {"code": "internal",
                                                            "message": repr(e)}})
                return
        self._json(404, {"ok": False, "error": {"code": "no_route",
                                                "message": f"{method} {path}"}})

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if getattr(self, "_out_cookie", None):
            self.send_header("Set-Cookie", self._out_cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


class Server(socketserver.ThreadingTCPServer):
    """注意：Windows 上 `allow_reuse_address=True`（SO_REUSEADDR）**允许第二个进程
    绑定同一个已在监听的端口**，请求会被随机分流到别的进程上——本项目调试时就撞到过
    （8765 上同时有 4 个旧服务在听，接口返回的是静态 404）。所以这里改用
    SO_EXCLUSIVEADDRUSE：端口被占用时直接绑定失败，由 pick_port 往后退。"""

    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def server_close(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 0)
            except OSError:
                pass
        super().server_close()


def port_in_use(p: int) -> bool:
    """真正在监听才算占用（只看 bind 会漏掉 Windows 上的重复绑定）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", p)) == 0


def pick_port(preferred: int) -> int:
    for p in range(preferred, preferred + 20):
        if port_in_use(p):
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("找不到可用端口（%d 起试 20 个）" % preferred)


def get_lan_ip() -> str:
    """取本机局域网 IP（UDP connect 不会真的发包）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="监听地址：默认 127.0.0.1（仅本机）；0.0.0.0 = 局域网可访问")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    port = pick_port(a.port)
    lan_ip = get_lan_ip()
    url = f"http://127.0.0.1:{port}/viewer/index.html"
    lan_url = f"http://{lan_ip}:{port}/viewer/index.html" if a.host != "127.0.0.1" else None
    projects = S.scan_projects()
    n_models = sum(p["modelCount"] for p in projects)
    n_vers = sum(p["versionCount"] for p in projects)

    print("=" * 70)
    scope = "局域网可访问" if a.host != "127.0.0.1" else "仅本机"
    print(f"  PDMS Model Asset Manager — 本地运行（{scope}）")
    print("=" * 70)
    print(f"  根目录 : {ROOT}")
    print(f"  地址   : {url}")
    if lan_url:
        print(f"  局域网 : {lan_url}")
    print(f"  资产   : data/projects/  ·  {len(projects)} 个项目 / {n_models} 个模型 / {n_vers} 个版本")
    if not projects:
        print("  [空] data/projects 下还没有项目 —— 在页面里选择 Import Model 即可开始")
    if not (ROOT / "viewer" / "vendor" / "three.module.js").exists():
        print("  [缺] viewer/vendor/three.module.js")
    if a.host == "127.0.0.1":
        print("  仅监听 127.0.0.1，模型数据不出本机")
    else:
        print(f"  监听 {a.host}:{port}，同一局域网内的设备可通过上面的局域网地址访问")
    print(f"  访问权限: 内网网段 [{', '.join(str(n) for n in AC.CONFIG.internal_ranges)}] · "
          f"信任loopback {'是' if AC.CONFIG.trust_loopback else '否'} · "
          f"可信代理 {len(AC.CONFIG.trusted_proxies)} 条 · "
          f"Session {AC.CONFIG.session_ttl_hours:g} h · "
          f"删除密码 {'已配置' if AC.CONFIG.delete_password else '未配置'}")
    if not AC.CONFIG.trust_loopback:
        print("  [提示] TRUST_LOOPBACK=0：本机 127.0.0.1 访问也会要求访问码（隧道隔离所需）。")
        print("         本机请用局域网地址访问；用 start-lan.bat（0.0.0.0）启动才能让局域网设备直连。")
    if a.host == "127.0.0.1" and not AC.CONFIG.trust_loopback:
        print("  [警告] 当前只监听 127.0.0.1 且不信任 loopback —— 局域网设备将无法访问。")
        print("         请改用 start-lan.bat 启动（0.0.0.0）。")
    if a.host != "127.0.0.1" and not AC.CONFIG.trusted_proxies:
        print("  [提示] 对外部署时请在 config/access.env 里收紧 INTERNAL_NETWORK_RANGES，"
              "并在反向代理场景配置 TRUSTED_PROXIES。")
    print()
    print("  按 Ctrl+C 停止服务")
    print("=" * 70)

    handler = functools.partial(Handler, directory=str(ROOT))
    with Server((a.host, port), handler) as httpd:
        if not a.no_browser:
            # TRUST_LOOPBACK=0 时 127.0.0.1 会被要求访问码，自动打开改用局域网地址
            open_url = lan_url or url
            threading.Timer(0.6, lambda: webbrowser.open(open_url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
