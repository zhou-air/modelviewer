"""访问权限层 —— Access Gateway + Session + Permission Service。

设计原则（权限任务书 §14/§19）：
  * 只有一层权限模型，三种身份：INTERNAL_NETWORK / INTERNAL_REMOTE / CLIENT_PROJECT。
  * 内网识别完全由服务器端决定；浏览器前端只消费 /api/access/status 的结果。
  * 配置集中在 config/access.env（可被同名环境变量覆盖），不散落硬编码。
  * Backend 是最终权限来源；本模块同时供 server.py 的 API 守卫与静态文件守卫调用。

不引入：账号系统 / RBAC / OAuth / 数据库。Session 是进程内存字典，重启即失效
（与导入 job 同策略），模型数据本身不受影响。
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
from datetime import datetime, date
from pathlib import Path

import asset_store as S            # noqa: E402  (复用 ROOT / LOCK / read_json / write_json)

ROOT = S.ROOT
CONFIG_FILE = ROOT / "config" / "access.env"
DAILY_CODE_FILE = S.DATA / "access" / "daily-code.json"

SESSION_COOKIE = "mv_session"

# 访问码字母表：大写字母 + 数字，排除易混淆字符（O/0、I/1、L/1）
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

ROLES = ("INTERNAL_NETWORK", "INTERNAL_REMOTE", "CLIENT_PROJECT", "ANONYMOUS")


class AccessError(Exception):
    """权限错误，server.py 直接映射为 HTTP 响应（与 StoreError/ApiError 同型）。"""

    def __init__(self, http: int, code: str, message: str):
        super().__init__(message)
        self.http, self.code, self.message = http, code, message


# ------------------------------------------------------------------ 访问码

def _generate_code(length: int = 8) -> str:
    body = "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))
    half = length // 2
    return body[:half] + "-" + body[half:]


def normalize_code(text: str) -> str:
    """去掉空格与连字符、统一大写后再比对（用户抄写时格式可能不一致）。"""
    return re.sub(r"[\s-]+", "", str(text or "")).upper()


def code_matches(input_code: str, stored: str) -> bool:
    if not stored:
        return False
    return hmac.compare_digest(normalize_code(input_code), normalize_code(stored))


def hash_code(code: str) -> str:
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 配置

def _parse_env_file(p: Path) -> dict:
    out = {}
    if not p.is_file():
        return out
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _parse_ranges(text: str) -> list:
    nets = []
    for part in re.split(r"[,;\s]+", text or ""):
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part if "/" in part else part + "/32",
                                             strict=False))
        except ValueError:
            print(f"  [access] 忽略非法网段配置: {part!r}")
    return nets


class _Config:
    """集中配置。优先级：环境变量 > config/access.env > 默认值。"""

    def __init__(self) -> None:
        f = _parse_env_file(CONFIG_FILE)
        def get(key: str, default: str = "") -> str:
            return os.environ.get(key, f.get(key, default))

        self.internal_ranges = _parse_ranges(get(
            "INTERNAL_NETWORK_RANGES",
            "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"))
        self.trusted_proxies = _parse_ranges(get("TRUSTED_PROXIES", ""))
        # TRUST_LOOPBACK=1：localhost/127.0.0.1 恒为内网（本机开发默认）。
        # 通过 cloudflared 隧道 / 同机反向代理暴露公网时必须设为 0 ——
        # 隧道回源流量从 127.0.0.1 进来，若信任 loopback 会把外网全放进内网。
        self.trust_loopback = get("TRUST_LOOPBACK", "1") in ("1", "true", "yes")
        self.session_ttl_hours = float(get("SESSION_TTL_HOURS", "24") or 24)
        self.secure_cookies = get("SECURE_COOKIES", "0") in ("1", "true", "yes")
        self.delete_password = get("DELETE_PASSWORD", "")
        if not self.delete_password:
            # 首次运行：自动生成并写回 config/access.env，避免空密码裸奔
            self.delete_password = _generate_code(10)
            try:
                CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
                if not CONFIG_FILE.exists():
                    CONFIG_FILE.write_text(
                        "# 访问权限配置（本文件含敏感信息，不要提交 Git）\n"
                        f"DELETE_PASSWORD={self.delete_password}\n"
                        "# INTERNAL_NETWORK_RANGES=10.0.0.0/8,192.168.0.0/16,203.0.113.10/32\n"
                        "# TRUSTED_PROXIES=127.0.0.1\n"
                        "# SESSION_TTL_HOURS=24\n"
                        "# SECURE_COOKIES=0\n",
                        encoding="utf-8")
                    print(f"  [access] 已生成删除密码并写入 {CONFIG_FILE.name}（请自行修改）")
            except OSError:
                pass

    def is_internal_ip(self, ip: str) -> bool:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if addr.is_loopback:
            return self.trust_loopback       # 可配置；隧道/同机反代场景必须关闭
        return any(addr in n for n in self.internal_ranges)

    def is_trusted_proxy(self, ip: str) -> bool:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(addr in n for n in self.trusted_proxies)


CONFIG = _Config()


# ------------------------------------------------------------------ 每日内部码

def _today() -> str:
    return date.today().isoformat()


def today_internal_code() -> dict:
    """取（必要时生成）今日内部码。每天 00:00 后第一次读取时滚动。
    只有服务器知道；旧代码随文件覆盖立即失效。"""
    with S.LOCK:
        doc = {}
        if DAILY_CODE_FILE.is_file():
            try:
                doc = S.read_json(DAILY_CODE_FILE)
            except Exception:  # noqa: BLE001
                doc = {}
        if doc.get("date") != _today() or not doc.get("code"):
            doc = {"date": _today(), "code": _generate_code(8),
                   "generatedAt": S.now_iso()}
            S.write_json(DAILY_CODE_FILE, doc)
        return doc


def verify_internal_code(input_code: str) -> bool:
    today = today_internal_code()
    return code_matches(input_code, today.get("code", ""))


# ------------------------------------------------------------------ 项目访问码

def _project_manifest(pid: str) -> tuple[Path, dict]:
    f = S.require_project(pid) / "project.json"
    doc = S._load_manifest(f, "project", pid)
    return f, doc


def get_external_access(pid: str) -> dict:
    _, doc = _project_manifest(pid)
    ea = doc.get("externalAccess") or {}
    return {"enabled": bool(ea.get("enabled")),
            "code": ea.get("code") if ea.get("enabled") else None,
            "codeHash": ea.get("codeHash"),
            "updatedAt": ea.get("updatedAt")}


def set_external_access(pid: str, *, enabled: bool | None = None,
                        regenerate: bool = False) -> dict:
    """启用 / 禁用 / 重新生成项目的客户访问码。重新生成或禁用后，旧码立即失效。"""
    with S.LOCK:
        f, doc = _project_manifest(pid)
        ea = dict(doc.get("externalAccess") or {})
        if regenerate:
            ea["code"] = _generate_code(8)
            ea["codeHash"] = hash_code(ea["code"])
            ea["enabled"] = True
        elif enabled is not None:
            ea["enabled"] = bool(enabled)
            if enabled and not ea.get("code"):
                ea["code"] = _generate_code(8)
                ea["codeHash"] = hash_code(ea["code"])
        ea["updatedAt"] = S.now_iso()
        doc["externalAccess"] = ea
        doc["updatedAt"] = S.now_iso()
        S.write_json(f, doc)
        return {"enabled": bool(ea.get("enabled")),
                "code": ea.get("code") if ea.get("enabled") else None,
                "updatedAt": ea["updatedAt"]}


def find_project_by_access_code(input_code: str) -> str | None:
    """按访问码找项目（启用状态的项目才参与匹配）。返回 pid 或 None。"""
    norm = normalize_code(input_code)
    if len(norm) < 4:
        return None
    with S.LOCK:
        if not S.PROJECTS.is_dir():
            return None
        for pdir in sorted(S.PROJECTS.iterdir()):
            f = pdir / "project.json"
            if not pdir.is_dir() or not f.is_file():
                continue
            try:
                doc = S.read_json(f)
            except Exception:  # noqa: BLE001
                continue
            ea = doc.get("externalAccess") or {}
            if ea.get("enabled") and ea.get("codeHash"):
                if hmac.compare_digest(hash_code(input_code), ea["codeHash"]):
                    return doc.get("id") or pdir.name
    return None


# ------------------------------------------------------------------ Session

_SESSIONS: dict[str, dict] = {}
_SESS_LOCK = threading.Lock()


def create_session(role: str, project_id: str | None) -> tuple[str, int]:
    """创建 Session，返回 (token, max_age 秒)。有效期独立于每日码滚动。"""
    token = secrets.token_urlsafe(32)
    ttl = int(CONFIG.session_ttl_hours * 3600)
    with _SESS_LOCK:
        _SESS_LRU()
        _SESSIONS[token] = {"role": role, "projectId": project_id,
                            "createdAt": S.now_iso(),
                            "expiresAt": datetime.now().astimezone().timestamp() + ttl}
    return token, ttl


def _SESS_LRU() -> None:
    """顺手清理过期 Session，防止内存无限增长。"""
    now = datetime.now().astimezone().timestamp()
    for t in [t for t, s in _SESSIONS.items() if s["expiresAt"] < now]:
        _SESSIONS.pop(t, None)


def get_session(token: str) -> dict | None:
    if not token:
        return None
    with _SESS_LOCK:
        s = _SESSIONS.get(token)
        if not s:
            return None
        if s["expiresAt"] < datetime.now().astimezone().timestamp():
            _SESSIONS.pop(token, None)
            return None
        return dict(s)


def drop_session(token: str) -> None:
    with _SESS_LOCK:
        _SESSIONS.pop(token, None)


# ------------------------------------------------------------------ AccessContext 与权限判定

def resolve_access(client_ip: str, forwarded_for: str | None,
                   session_token: str | None) -> dict:
    """服务器端判定访问身份。顺序：有效 Session 优先（外部员工/客户），
    否则按来源 IP 判内网（含 trusted proxy 处理），否则 ANONYMOUS。"""
    sess = get_session(session_token)
    if sess:
        return {"role": sess["role"], "projectId": sess["projectId"],
                "ip": client_ip, "sessionId": session_token}
    real_ip = client_ip
    if forwarded_for and CONFIG.is_trusted_proxy(client_ip):
        # 只信任来自 trusted proxy 的 XFF；取最左侧第一个非信任代理的地址
        for candidate in [c.strip() for c in forwarded_for.split(",")]:
            if candidate and not CONFIG.is_trusted_proxy(candidate):
                real_ip = candidate
                break
    if CONFIG.is_internal_ip(real_ip):
        return {"role": "INTERNAL_NETWORK", "projectId": None,
                "ip": real_ip, "sessionId": None}
    return {"role": "ANONYMOUS", "projectId": None, "ip": real_ip, "sessionId": None}


# ---- 统一权限表达（前端 perms 与后端判定共用同一套语义）----

def permissions(ctx: dict) -> dict:
    r = ctx["role"]
    if r == "INTERNAL_NETWORK":
        return {"viewAllProjects": True, "upload": True, "createProject": True,
                "manageProjects": True, "delete": True, "deleteRequiresPassword": True,
                "readInternalCode": True, "manageAccessCodes": True}
    if r == "INTERNAL_REMOTE":
        return {"viewAllProjects": True, "upload": False, "createProject": False,
                "manageProjects": False, "delete": False, "deleteRequiresPassword": False,
                "readInternalCode": False, "manageAccessCodes": False}
    # CLIENT_PROJECT / ANONYMOUS
    return {"viewAllProjects": False, "upload": False, "createProject": False,
            "manageProjects": False, "delete": False, "deleteRequiresPassword": False,
            "readInternalCode": False, "manageAccessCodes": False}


def can_view_project(ctx: dict, pid: str) -> bool:
    if ctx["role"] == "CLIENT_PROJECT":
        return pid == ctx["projectId"]
    return ctx["role"] in ("INTERNAL_NETWORK", "INTERNAL_REMOTE")


def require_view_project(ctx: dict, pid: str) -> None:
    if not can_view_project(ctx, pid):
        raise AccessError(403, "project_forbidden", "没有访问该项目的权限")


def require_internal(ctx: dict, action: str = "此操作") -> None:
    if ctx["role"] != "INTERNAL_NETWORK":
        raise AccessError(403, "forbidden", f"当前身份（{ctx['role']}）不允许{action}")


def require_delete_password(ctx: dict, supplied: str | None) -> None:
    require_internal(ctx, "删除")
    supplied_norm = normalize_code(supplied or "")
    expected_norm = normalize_code(CONFIG.delete_password)
    if not supplied_norm:
        raise AccessError(403, "delete_password_required",
                          "删除是危险操作，请输入删除密码（X-Delete-Password）")
    if not (supplied_norm and hmac.compare_digest(supplied_norm, expected_norm)):
        raise AccessError(403, "delete_password_invalid", "删除密码不正确")


def status_payload(ctx: dict) -> dict:
    payload = {"role": ctx["role"], "permissions": permissions(ctx)}
    if ctx["role"] == "CLIENT_PROJECT":
        payload["projectId"] = ctx["projectId"]
        try:
            payload["projectName"] = (S.read_json(
                S.project_dir(ctx["projectId"]) / "project.json").get("name")
                if ctx["projectId"] else None)
        except Exception:  # noqa: BLE001
            payload["projectName"] = ctx["projectId"]
    return payload
