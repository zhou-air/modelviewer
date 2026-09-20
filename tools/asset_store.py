"""模型资产仓库 —— Project / Model / Version 三层文件系统 + JSON manifest。

设计契约见 reports/model-management-design.md。要点：

* 事实来源就是文件系统：data/projects/<pid>/project.json
                              /models/<mid>/model.json
                              /versions/<vid>/version.json
  没有数据库，也没有 index.json（当前规模扫描一次 < 5 ms，多一个索引就多一个可能不一致的文件）。
* **ID 必须是 ASCII slug**，因为 rvmparser 会把源文件路径写进 GLB 的 JSON 块，
  非 ASCII 路径会让 GLB 变成非法 UTF-8（见 reports/phase2-report.md 已知问题 #2）。
  中文只允许出现在 name 字段里。
* 删除一律移入 data/trash/，不物理删除。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import unicodedata
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PROJECTS = DATA / "projects"
TRASH = DATA / "trash"
JOBS = DATA / "import-jobs"

SCHEMA = "pdms-model-asset/1"
PIPELINE_VERSION = "pdms-import-pipeline/1"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,47}$")
WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}
# 目录层级内部使用的固定文件名 —— 也是唯一允许出现在 source/ 里的名字
SOURCE_RVM = "model.rvm"
SOURCE_TXT = "model.txt"
GLB = "model.glb"
METADATA = "metadata.json"
METAMODEL = "metadata.metamodel.json"
RVM_INDEX = "rvm-node-index.json"
MAPPING = "mapping.json"
FLOORPLAN = "floorplan.json"

STATUS_IMPORTING = "importing"
STATUS_READY = "ready"
STATUS_FAILED = "failed"

LOCK = threading.RLock()


# ------------------------------------------------------------------ 基础工具

def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def file_mtime_iso(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime).astimezone().replace(
        microsecond=0).isoformat()


def read_json(p: Path):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def write_json(p: Path, obj) -> None:
    """原子写：先写 .tmp 再替换，避免半截 JSON 把 manifest 写坏。"""
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def slugify(text: str) -> str:
    """→ ASCII slug。中文等非 ASCII 字符会被丢弃（返回空串），此时需用户另给 ID。"""
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = s.encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:48].strip("-")


def suggest_id(name: str, fallback_prefix: str) -> str:
    """给前端用的 ID 建议值：能 slug 就用 slug，否则给一个可用的 <prefix>-N。"""
    s = slugify(name)
    if s:
        return s
    n = 1
    taken = {p.name for p in (PROJECTS.iterdir() if PROJECTS.exists() else [])}
    while f"{fallback_prefix}-{n}" in taken:
        n += 1
    return f"{fallback_prefix}-{n}"


class StoreError(Exception):
    """带错误码的仓库错误，供 API 直接映射为 HTTP 状态。"""

    def __init__(self, code: str, message: str, http: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http = http


def validate_id(value: str, kind: str, *, http: int = 400) -> str:
    v = (value or "").strip()
    if not v:
        raise StoreError(f"{kind}_id_required", f"{kind} ID 不能为空", http)
    if not v.isascii():
        raise StoreError(
            f"{kind}_id_not_ascii",
            f"{kind} ID 必须是 ASCII（转换器会把路径写进 GLB，非 ASCII 会让 GLB 非法）。"
            f"请改用英文/数字，例如 qichuang、main-site、2026-09-18。收到：{v!r}", http)
    if not ID_RE.match(v):
        raise StoreError(
            f"{kind}_id_invalid",
            f"{kind} ID 只能包含小写字母、数字、点、下划线、连字符，且必须以字母或数字开头"
            f"（≤48 字符）。收到：{v!r}", http)
    if v.split(".")[0].lower() in WINDOWS_RESERVED or v.lower() in WINDOWS_RESERVED:
        raise StoreError(f"{kind}_id_reserved", f"{kind} ID {v!r} 是 Windows 保留名，请换一个", http)
    return v


def safe_under(base: Path, *parts: str) -> Path:
    """拼路径并断言结果仍在 base 之内（挡 ../ 与绝对路径注入）。"""
    p = base.joinpath(*parts).resolve()
    if p != base.resolve() and base.resolve() not in p.parents:
        raise StoreError("path_escape", f"非法路径：{'/'.join(parts)}", 400)
    return p


# ------------------------------------------------------------------ 路径

def project_dir(pid: str) -> Path:
    return safe_under(PROJECTS, validate_id(pid, "project"))


def model_dir(pid: str, mid: str) -> Path:
    return safe_under(project_dir(pid) / "models", validate_id(mid, "model"))


def version_dir(pid: str, mid: str, vid: str) -> Path:
    return safe_under(model_dir(pid, mid) / "versions", validate_id(vid, "version"))


def require_dir(p: Path, kind: str, code: str) -> Path:
    if not p.is_dir():
        raise StoreError(code, f"{kind} 不存在：{p.relative_to(ROOT).as_posix()}", 404)
    return p


def require_project(pid: str) -> Path:
    return require_dir(project_dir(pid), "Project", "project_not_found")


def require_model(pid: str, mid: str) -> Path:
    require_project(pid)
    return require_dir(model_dir(pid, mid), "Model", "model_not_found")


def require_version(pid: str, mid: str, vid: str) -> Path:
    require_model(pid, mid)
    return require_dir(version_dir(pid, mid, vid), "Version", "version_not_found")


def url_of(p: Path) -> str:
    """本机静态服务把项目根当作文档根，故一律用 /data/... 形式的绝对路径。"""
    return "/" + p.resolve().relative_to(ROOT).as_posix()


# ------------------------------------------------------------------ 创建 / 改名

def create_project(name: str, pid: str | None = None, description: str = "") -> dict:
    name = (name or "").strip()
    if not name:
        raise StoreError("project_name_required", "Project 名称不能为空")
    pid = validate_id(pid or suggest_id(name, "project"), "project")
    with LOCK:
        d = project_dir(pid)
        if d.exists():
            raise StoreError("project_exists", f"Project ID {pid!r} 已存在", 409)
        ts = now_iso()
        doc = {"schema": SCHEMA, "id": pid, "name": name, "description": description,
               "createdAt": ts, "updatedAt": ts}
        (d / "models").mkdir(parents=True)
        write_json(d / "project.json", doc)
        return doc


def update_project(pid: str, name: str | None = None,
                   description: str | None = None) -> dict:
    with LOCK:
        f = require_project(pid) / "project.json"
        doc = _load_manifest(f, "project", pid)
        if name is not None:
            if not name.strip():
                raise StoreError("project_name_required", "Project 名称不能为空")
            doc["name"] = name.strip()
        if description is not None:
            doc["description"] = description
        doc["updatedAt"] = now_iso()
        write_json(f, doc)
        return doc


def create_model(pid: str, name: str, mid: str | None = None, description: str = "") -> dict:
    name = (name or "").strip()
    if not name:
        raise StoreError("model_name_required", "Model 名称不能为空")
    mid = validate_id(mid or suggest_id(name, "model"), "model")
    with LOCK:
        require_project(pid)
        d = model_dir(pid, mid)
        if d.exists():
            raise StoreError("model_exists", f"Model ID {mid!r} 已存在", 409)
        ts = now_iso()
        doc = {"schema": SCHEMA, "id": mid, "name": name, "description": description,
               "createdAt": ts, "updatedAt": ts}
        (d / "versions").mkdir(parents=True)
        write_json(d / "model.json", doc)
        _touch_project(pid)
        return doc


def update_model(pid: str, mid: str, name: str | None = None,
                 description: str | None = None) -> dict:
    with LOCK:
        f = require_model(pid, mid) / "model.json"
        doc = _load_manifest(f, "model", mid)
        if name is not None:
            if not name.strip():
                raise StoreError("model_name_required", "Model 名称不能为空")
            doc["name"] = name.strip()
        if description is not None:
            doc["description"] = description
        doc["updatedAt"] = now_iso()
        write_json(f, doc)
        _touch_project(pid)
        return doc


def _load_manifest(f: Path, kind: str, ident: str) -> dict:
    if not f.exists():
        raise StoreError(f"{kind}_manifest_missing",
                         f"{f.relative_to(ROOT).as_posix()} 缺失，无法识别该 {kind}", 409)
    return read_json(f)


def _touch_project(pid: str) -> None:
    f = project_dir(pid) / "project.json"
    if f.exists():
        doc = read_json(f)
        doc["updatedAt"] = now_iso()
        write_json(f, doc)


# ------------------------------------------------------------------ 删除（移入 trash）

def _trash(directory: Path, kind: str, ident: str) -> str:
    TRASH.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"{stamp}-{kind}-{ident}"
    dest = TRASH / base
    n = 2
    while dest.exists():
        dest = TRASH / f"{base}-{n}"
        n += 1
    with LOCK:
        shutil.move(str(directory), str(dest))
    return url_of(dest)


def count_versions(pid: str, mid: str | None = None) -> int:
    """Project 下（或指定 Model 下）的版本目录数，用于删除确认弹窗的计数。"""
    total = 0
    if mid is None:
        roots = [m for m in (project_dir(pid) / "models").iterdir()
                 if m.is_dir()] if (project_dir(pid) / "models").is_dir() else []
    else:
        roots = [model_dir(pid, mid)]
    for m in roots:
        if not m.is_dir():
            continue
        vroot = m / "versions"
        if vroot.is_dir():
            total += sum(1 for v in vroot.iterdir() if v.is_dir())
    return total


def count_models(pid: str) -> int:
    mroot = project_dir(pid) / "models"
    return sum(1 for m in mroot.iterdir() if m.is_dir()) if mroot.is_dir() else 0


def delete_project(pid: str) -> dict:
    with LOCK:
        d = require_project(pid)
        info = {"id": pid, "models": count_models(pid), "versions": count_versions(pid)}
        info["trashedTo"] = _trash(d, "project", pid)
        return info


def delete_model(pid: str, mid: str) -> dict:
    with LOCK:
        d = require_model(pid, mid)
        info = {"id": mid, "versions": count_versions(pid, mid)}
        info["trashedTo"] = _trash(d, "model", f"{pid}--{mid}")
        _touch_project(pid)
        return info


def delete_version(pid: str, mid: str, vid: str) -> dict:
    with LOCK:
        d = require_version(pid, mid, vid)
        info = {"id": vid}
        info["trashedTo"] = _trash(d, "version", f"{pid}--{mid}--{vid}")
        _touch_project(pid)
        return info


# ------------------------------------------------------------------ 扫描

def _version_assets(vdir: Path, status: str) -> dict | None:
    if status != STATUS_READY:
        return None
    proc = vdir / "processed"
    files = {"glb": GLB, "metadata": METADATA, "metamodel": METAMODEL,
             "rvmIndex": RVM_INDEX, "mapping": MAPPING, "floorplan": FLOORPLAN}
    out = {}
    for key, fname in files.items():
        f = proc / fname
        if f.exists():
            out[key] = url_of(f)
    return out or None


def _version_validation(vdir: Path) -> dict | None:
    """读取该版本的校验摘要（供 Details 弹窗显示"这份产物的闸门结果"）。"""
    f = vdir / "reports" / "validation.json"
    if not f.exists():
        return None
    try:
        v = read_json(f)
    except Exception:  # noqa: BLE001
        return {"pass": None, "checks": [], "note": "validation.json 无法解析"}
    return {"pass": v.get("pass"), "at": v.get("at"),
            "checks": [{"name": c.get("name"), "ok": c.get("ok"),
                        "failed": (c.get("detail") or {}).get("failed")}
                       for c in v.get("checks", [])]}


def scan_version(vdir: Path) -> dict:
    """读一个版本目录。缺 version.json 时**不隐藏**，标成 invalid 让用户能删掉它。"""
    f = vdir / "version.json"
    if not f.exists():
        return {"id": vdir.name, "name": vdir.name, "status": "invalid",
                "createdAt": None, "importedAt": file_mtime_iso(vdir), "error": {
                    "stage": "scan", "message": "version.json 缺失（可能是中断的导入）"},
                "stats": {}, "assets": None, "originalRvmFilename": None,
                "originalTxtFilename": None, "rvmBytes": None, "glbBytes": None,
                "objectCount": None, "mappingRate": None}
    doc = read_json(f)
    st = doc.get("stats") or {}
    status = doc.get("status", "invalid")
    return {
        "id": doc.get("id", vdir.name),
        "name": doc.get("name", vdir.name),
        "status": status,
        "createdAt": doc.get("createdAt"),
        "importedAt": doc.get("importedAt"),
        "error": doc.get("error"),
        "originalRvmFilename": doc.get("originalRvmFilename"),
        "originalTxtFilename": doc.get("originalTxtFilename"),
        "rvmBytes": st.get("rvmBytes"),
        "txtBytes": st.get("txtBytes"),
        "glbBytes": st.get("glbBytes"),
        "objectCount": st.get("objectCount"),
        "mappedObjects": st.get("mappedObjects"),
        "mappingRate": st.get("mappingRate"),
        "floorplanEquipment": st.get("floorplanEquipment"),
        "floorplanPositioned": st.get("floorplanPositioned"),
        "floorplanOutlines": st.get("floorplanOutlines"),
        "durationMs": st.get("durationMs"),
        "converterVersion": st.get("converterVersion"),
        "assets": _version_assets(vdir, status),
        "validation": _version_validation(vdir),
        "history": doc.get("history", []),
    }


def _natkey(s: str):
    """自然排序键：数字段按数值比（v2 < v10），其余按字符比。"""
    return tuple((0, int(t), "") if t.isdigit() else (1, 0, t)
                 for t in re.split(r"(\d+)", s or "") if t != "")


def _version_sort_key(v: dict):
    """版本列表顺序 = 按版本名称自然降序（任务书 §9「最新版本排在最上面」）。

    取名称而不是导入时间：版本名就是迭代标识（2026-08-26 / 2026-09-03 / 2026-09-18…），
    用户看到的顺序应该跟名字一致；导入时间只是"什么时候登记进来的"，不反映迭代先后。
    同名（不可能，目录唯一）时用导入时间兜底。
    """
    return (_natkey(str(v.get("name") or "")), v.get("importedAt") or "")


def scan_model(mdir: Path) -> dict:
    f = mdir / "model.json"
    doc = read_json(f) if f.exists() else {"id": mdir.name, "name": mdir.name,
                                           "description": "", "createdAt": None,
                                           "updatedAt": None}
    vroot = mdir / "versions"
    versions = [scan_version(v) for v in vroot.iterdir() if v.is_dir()] if vroot.is_dir() else []
    versions.sort(key=_version_sort_key, reverse=True)      # 最新版本排最上面
    doc = dict(doc)
    doc["manifestMissing"] = not f.exists()
    doc["versions"] = versions
    doc["versionCount"] = len(versions)
    return doc


def scan_project(pdir: Path) -> dict:
    f = pdir / "project.json"
    doc = read_json(f) if f.exists() else {"id": pdir.name, "name": pdir.name,
                                           "description": "", "createdAt": None,
                                           "updatedAt": None}
    mroot = pdir / "models"
    models = [scan_model(m) for m in sorted(mroot.iterdir(), key=lambda p: p.name)
              if m.is_dir()] if mroot.is_dir() else []
    doc = dict(doc)
    doc["manifestMissing"] = not f.exists()
    doc["models"] = models
    doc["modelCount"] = len(models)
    doc["versionCount"] = sum(m["versionCount"] for m in models)
    return doc


def scan_projects() -> list[dict]:
    PROJECTS.mkdir(parents=True, exist_ok=True)
    return [scan_project(p) for p in sorted(PROJECTS.iterdir(), key=lambda p: p.name)
            if p.is_dir()]


def find_version(pid: str, mid: str, vid: str) -> dict:
    return scan_version(require_version(pid, mid, vid))


def trash_list() -> list[dict]:
    if not TRASH.is_dir():
        return []
    out = []
    for p in sorted(TRASH.iterdir(), key=lambda p: p.name, reverse=True):
        if p.is_dir():
            out.append({"name": p.name, "at": file_mtime_iso(p), "url": url_of(p)})
    return out


# ------------------------------------------------------------------ 版本注册

def new_version_doc(vid: str, name: str, created_at: str, *,
                    original_rvm: str | None = None,
                    original_txt: str | None = None) -> dict:
    return {
        "schema": SCHEMA,
        "id": vid,
        "name": name,
        "createdAt": created_at,
        "importedAt": now_iso(),
        "sourceRvm": f"source/{SOURCE_RVM}",
        "sourceTxt": f"source/{SOURCE_TXT}",
        "originalRvmFilename": original_rvm,
        "originalTxtFilename": original_txt,
        "status": STATUS_IMPORTING,
        "error": None,
        "assets": {"glb": f"processed/{GLB}", "metadata": f"processed/{METADATA}",
                   "metamodel": f"processed/{METAMODEL}",
                   "rvmIndex": f"processed/{RVM_INDEX}", "mapping": f"processed/{MAPPING}",
                   "floorplan": f"processed/{FLOORPLAN}"},
        "stats": {},
        "history": [{"at": now_iso(), "status": STATUS_IMPORTING}],
    }


def append_history(doc: dict, status: str, note: str | None = None) -> None:
    h = doc.setdefault("history", [])
    item = {"at": now_iso(), "status": status}
    if note:
        item["note"] = note
    h.append(item)
    del h[:-12]                     # 只留最近 12 条，别让 manifest 无限长大


def version_id_for(name: str, explicit: str | None = None) -> str:
    """Version 的目录名 = 名称的 slug。中文名 slug 为空时要求显式给 ID。"""
    if explicit:
        return validate_id(explicit, "version")
    s = slugify(name)
    if not s:
        raise StoreError(
            "version_id_required",
            f"版本名 {name!r} 里没有可用作目录名的 ASCII 字符，请改用含字母/数字的名称"
            f"（例如 2026-09-25、rev-b），或单独填写 Version ID。")
    return validate_id(s, "version")
