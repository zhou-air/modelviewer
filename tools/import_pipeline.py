"""导入流水线 —— 把「用户选的文件」变成「已注册的 ready 版本」。

职责只有四件事（任务书 §16）：
    给对路径 → 按对顺序调**现有转换器** → 判校验闸门 → 注册版本
几何 / 元数据 / 映射算法一行都没有在这里重写，也不存在第二套转换器。

阶段与任务书 §18 一致：
    queued → copying → geometry → metadata → mapping → validating → ready | failed

两种用法：
    HTTP  ：tools/server.py 建 job → PUT 源文件 → POST /start（后台线程跑）
    CLI   ：python tools/import_pipeline.py --project qichuang --model main-site \
              --version 2026-09-25 --rvm X.rvm --txt X.txt
    CLI 仅 RVM：去掉 --txt 即可（元数据由 RVM 合成，见下）

两种元数据来源（由**源文件是否在场**决定，不是靠开关）
    · 有 TXT（PDMS Data Listing）：metadata = txt_parser、mapping = map_objects、
      floorplan = 设备定位工具；三条独立闸门（verify_glb / verify_metadata / verify_mapping）。
    · 仅 RVM：metadata + mapping = rvm_metadata 合成（canonical 就是 RVM 组名），
      跳过 floorplan；闸门 = verify_glb + verify_rvm_metadata（含逐条字节偏移回读）。
      代价：没有 POS/DIAM/PRES/TEMP/DESC 等工程属性，也没有设备定位图。
"""
from __future__ import annotations

import argparse
import copy
import io
import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from functools import wraps
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import asset_store as S  # noqa: E402

ROOT = S.ROOT
CONVERTER = ROOT / "converter"
PY = sys.executable
TOLERANCE = 0.02

STAGES = ["queued", "copying", "geometry", "metadata", "mapping", "validating", "ready"]
MAX_RUNNING_IMPORTS = 2
MAX_PENDING_IMPORTS = 32
CONVERSION_TIMEOUT_SECONDS = 30 * 60
MAX_TOOL_LOG_BYTES = 256 * 1024


def _locked(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        with S.LOCK:
            return fn(*args, **kwargs)
    return call


# ------------------------------------------------------------------ 工具

def _rel(p: Path) -> str:
    return p.resolve().relative_to(ROOT).as_posix()


def _tool_version() -> str:
    exe = ROOT / "tools" / "rvmparser" / "rvmparser.exe"
    sha = hashlib.sha1(exe.read_bytes()).hexdigest()[:12] if exe.exists() else "missing"
    return f'{S.PIPELINE_VERSION} · rvmparser/{sha} · tolerance {TOLERANCE} m'


def _floorplan_tool() -> Path:
    """定位现有 PDMS 设备定位工具；不在 Viewer 内复制或重写 TXT 解析器。"""
    configured = os.environ.get("PDMS_LOCATOR_EXE", "").strip()
    candidates = [
        Path(configured) if configured else None,
        ROOT / "tools" / "PdmsEquipmentLocator.exe",
        ROOT.parent / "PDMS设备定位工具" / "PdmsEquipmentLocator.exe",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise S.StoreError(
        "floorplan_tool_missing",
        "找不到 PDMS 设备定位工具。请设置 PDMS_LOCATOR_EXE，或把 "
        "PdmsEquipmentLocator.exe 放到 Viewer/tools/ 下。")


def _run(cmd: list[str], log: list[str]) -> subprocess.CompletedProcess:
    """调用现有脚本。cmd 里的脚本路径与参数一律相对项目根，与手工执行完全一致。"""
    t0 = time.perf_counter()
    log.append(f"$ {' '.join(cmd)}")
    # Conversion helpers may launch native children. Bound the whole stage and
    # terminate its process tree on timeout; spool logs instead of buffering them.
    options = ({"creationflags": subprocess.CREATE_NO_WINDOW}
               if os.name == "nt" else {"start_new_session": True})
    timed_out = False
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(cmd, cwd=str(ROOT), stdout=output,
                                   stderr=subprocess.STDOUT, **options)
        try:
            process.wait(timeout=CONVERSION_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == "nt":
                try:
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        output.seek(0, os.SEEK_END)
        size = output.tell()
        output.seek(max(0, size - MAX_TOOL_LOG_BYTES))
        tail = output.read().decode("utf-8", errors="replace")
        if size > MAX_TOOL_LOG_BYTES:
            tail = "[earlier output omitted]\n" + tail
    proc = subprocess.CompletedProcess(cmd, process.returncode, tail, "")
    ms = int((time.perf_counter() - t0) * 1000)
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if out:
        log.append(out)
    log.append(f"  → exit={proc.returncode}  {ms} ms")
    log.append("")
    if timed_out:
        raise S.StoreError("conversion_timeout", "转换阶段超时，已停止转换进程；请检查源文件后重试", 408)
    return proc


# ------------------------------------------------------------------ Job

JOBS: dict[str, "Job"] = {}
JOBS_LOCK = S.LOCK


class Job:
    def __init__(self, job_id: str, *, project_id: str, model_id: str, version_id: str,
                 version_name: str, new_project_name: str | None = None,
                 new_model_name: str | None = None, rvm_filename: str = "",
                 txt_filename: str = "", resume: bool = False):
        self.id = job_id
        self.dir = S.JOBS / job_id
        self.source_dir = self.dir / "source"
        self.project_id = project_id
        self.model_id = model_id
        self.version_id = version_id
        self.version_name = version_name
        self.new_project_name = new_project_name
        self.new_model_name = new_model_name
        self.rvm_filename = rvm_filename
        self.txt_filename = txt_filename
        self.resume = resume               # 重试：源文件已在版本目录里，不需要重新上传
        # "有 TXT 走 txt_parser，只有 RVM 走 rvm_metadata 合成" —— 建单时先按文件名猜一个，
        # run_job 里按**实际源文件**校准（重试路径的文件名是老版本记录的，不能当依据）
        self.metadata_source = (S.METADATA_SOURCE_TXT if txt_filename
                                else S.METADATA_SOURCE_RVM)
        self.status = "queued"
        self.stage = "queued"
        self.error: dict | None = None
        self.uploaded = {"rvm": False, "txt": False}
        self.stages = [{"name": s, "status": "pending", "ms": None, "at": None}
                       for s in STAGES]
        self.createdAt = S.now_iso()
        self.result: dict | None = None
        self._log: list[str] = []
        self._uploads: set[str] = set()

    # ---- 序列化 ----
    @_locked
    def to_dict(self) -> dict:
        return copy.deepcopy({
            "jobId": self.id, "status": self.status, "stage": self.stage,
            "stages": self.stages, "error": self.error, "uploaded": self.uploaded,
            "resume": self.resume, "createdAt": self.createdAt,
            "uploading": sorted(self._uploads),
            "projectId": self.project_id, "modelId": self.model_id,
            "versionId": self.version_id, "versionName": self.version_name,
            "rvmFilename": self.rvm_filename, "txtFilename": self.txt_filename,
            "metadataSource": self.metadata_source,
            "result": self.result,
            "location": f"data/projects/{self.project_id}/models/{self.model_id}"
                        f"/versions/{self.version_id}",
        })

    @_locked
    def persist(self) -> None:
        S.write_json(self.dir / "job.json", self.to_dict())

    def log_text(self) -> str:
        return "\n".join(self._log)

    @_locked
    def _flush_log(self, extra: str | None = None) -> None:
        """把当前日志落到目标版本的 reports/conversion.log（边跑边写，便于失败后查）。"""
        if extra is not None:
            self._log.append(extra)
        out = (S.PROJECTS / self.project_id / "models" / self.model_id
               / "versions" / self.version_id / "reports" / "conversion.log")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(self.log_text(), encoding="utf-8")

    # ---- 阶段管理 ----
    @_locked
    def _enter(self, stage: str) -> None:
        self.stage = stage
        for s in self.stages:
            if s["name"] == stage:
                s["status"] = "running"
                s["at"] = S.now_iso()
        self.persist()

    @_locked
    def _done(self, stage: str, ms: int) -> None:
        for s in self.stages:
            if s["name"] == stage:
                s["status"] = "done"
                s["ms"] = ms
        self.persist()

    @_locked
    def fail(self, stage: str, message: str, detail: str | None = None) -> None:
        self.status = "failed"
        self.stage = "failed"
        for s in self.stages:
            if s["name"] == stage:
                s["status"] = "failed"
            elif s["status"] in ("pending", "running"):
                s["status"] = "skipped"
        self.error = {"stage": stage, "message": message}
        if detail:
            self.error["detail"] = detail[-2000:]
        # 失败也要落盘到 version.json：状态绝不能停在 importing（否则既不是 ready 也不是
        # failed，前端会一直等）。源文件保持不动，processed/ 里的半成品不注册为 ready。
        vj = (S.PROJECTS / self.project_id / "models" / self.model_id
              / "versions" / self.version_id / "version.json")
        if vj.exists():
            try:
                doc = S.read_json(vj)
                doc["status"] = S.STATUS_FAILED
                doc["error"] = {"stage": stage, "message": message}
                S.append_history(doc, S.STATUS_FAILED, stage)
                S.write_json(vj, doc)
            except Exception:  # noqa: BLE001
                pass
        self.persist()
        self._flush_log()
        self._flush_log(f"[failed] {stage}: {message}")


# ------------------------------------------------------------------ 流水线

@_locked
def create_job(*, project_id: str | None, model_id: str | None, version_name: str,
               version_id: str | None = None, new_project_name: str | None = None,
               new_model_name: str | None = None, new_project_id: str | None = None,
               new_model_id: str | None = None, rvm_filename: str = "",
               txt_filename: str = "", resume: bool = False) -> Job:
    """建 job 并预检：ID 合法性、目标是否已存在（ready 版本一律拒绝，不覆盖）。

    `new_project_id` / `new_model_id` 是用户在界面上填的 ASCII ID；不填则按名称自动生成
    （中文名生成不出 slug，会退化成 project-N）。
    """
    version_id = S.version_id_for(version_name, version_id)

    if project_id:
        S.require_project(project_id)
        project_id = S.validate_id(project_id, "project")
    else:
        if not new_project_name:
            raise S.StoreError("project_required", "必须选择已有 Project 或填写新 Project 名称")
        project_id = S.validate_id(
            new_project_id or S.suggest_id(new_project_name, "project"), "project")

    if model_id:
        S.require_model(project_id, model_id)
        model_id = S.validate_id(model_id, "model")
    else:
        if not new_model_name:
            raise S.StoreError("model_required", "必须选择已有 Model 或填写新 Model 名称")
        model_id = S.validate_id(
            new_model_id or S.suggest_id(new_model_name, "model"), "model")

    existing = S.version_dir(project_id, model_id, version_id)
    if (project_id, model_id, version_id) in S.ACTIVE_IMPORTS:
        raise S.StoreError("version_importing", "该版本已有待上传或运行中的导入任务", 409)
    if len(S.ACTIVE_IMPORTS) >= MAX_PENDING_IMPORTS:
        raise S.StoreError("import_capacity", "待处理导入任务已达上限，请先完成或清理已有任务", 429)
    if existing.is_dir():
        vj = existing / "version.json"
        if vj.exists():
            st = S.read_json(vj).get("status")
            if st == S.STATUS_READY:
                raise S.StoreError(
                    "version_exists",
                    f"版本 {version_name!r}（目录 {version_id}）已存在且已完成导入，"
                    f"不会覆盖。请换一个版本名，或先删除该版本。", 409)
            if not resume:
                raise S.StoreError("retry_required", "该版本已存在，请使用重试功能或另建版本", 409)
            if st not in (S.STATUS_FAILED, S.STATUS_IMPORTING):
                raise S.StoreError("version_not_retryable", "该版本状态不支持重试", 409)
        else:
            raise S.StoreError("version_incomplete", "版本目录缺少清单，请先删除后重新导入", 409)
    elif resume:
        raise S.StoreError("version_not_found", "重试版本不存在", 404)

    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(3).hex()
    job = Job(job_id, project_id=project_id, model_id=model_id, version_id=version_id,
              version_name=version_name, new_project_name=new_project_name,
              new_model_name=new_model_name, rvm_filename=rvm_filename,
              txt_filename=txt_filename, resume=resume)
    S.reserve_import(project_id, model_id, version_id, job_id)
    try:
        job.source_dir.mkdir(parents=True, exist_ok=True)
        job.persist()
        JOBS[job_id] = job
    except Exception:
        S.release_import(project_id, model_id, version_id, job_id)
        raise
    return job


@_locked
def retry_job(project_id: str, model_id: str, version_id: str) -> Job:
    """失败版本原地重跑：源文件已在 version/source/ 里，不重新上传。

    TXT 是否在场按**文件实际存在**判断，不看 version.json 里记的文件名 ——
    仅 RVM 版本本来就没有 TXT，重试必须能识别出来并继续走合成链路。
    """
    if sum(j.status == "running" for j in JOBS.values()) >= MAX_RUNNING_IMPORTS:
        raise S.StoreError("import_capacity", "同时运行的导入任务已达上限，请稍后重试", 429)
    vdir = S.require_version(project_id, model_id, version_id)
    doc = S.read_json(vdir / "version.json")
    src = vdir / "source"
    has_rvm = (src / S.SOURCE_RVM).is_file()
    has_txt = (src / S.SOURCE_TXT).is_file()
    if not has_rvm:
        raise S.StoreError("source_missing", "重试所需的 RVM 源文件不存在，请删除该版本后重新上传", 409)
    job = create_job(project_id=project_id, model_id=model_id,
                     version_name=doc.get("name") or version_id, version_id=version_id,
                     rvm_filename=doc.get("originalRvmFilename") or "",
                     txt_filename=(doc.get("originalTxtFilename") or "") if has_txt else "",
                     resume=True)
    job.uploaded = {"rvm": has_rvm, "txt": has_txt}
    job.metadata_source = S.METADATA_SOURCE_TXT if has_txt else S.METADATA_SOURCE_RVM
    job.persist()
    try:
        start_job(job)
    except Exception:
        if job.status == "queued":
            delete_job(job.id)
        raise
    return job


def get_job(job_id: str) -> Job | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)


def staged_path(job: Job, which: str) -> Path:
    if which not in ("rvm", "txt"):
        raise S.StoreError("bad_source", "源文件槽只能是 rvm / txt", 404)
    return job.source_dir / ("staged.rvm" if which == "rvm" else "staged.txt")


def save_upload(job: Job, which: str, data: bytes) -> int:
    return save_upload_stream(job, which, io.BytesIO(data), len(data))


def _require_queued(job: Job) -> None:
    if JOBS.get(job.id) is not job:
        raise S.StoreError("job_not_found", "导入任务不存在", 404)
    if job.status != "queued":
        raise S.StoreError("job_not_queued", "任务已启动或结束；失败版本请使用重试功能", 409)
    if S.ACTIVE_IMPORTS.get((job.project_id, job.model_id, job.version_id)) != job.id:
        raise S.StoreError("job_reservation_lost", "导入任务的版本预留已失效", 409)


def save_upload_stream(job: Job, which: str, stream, length: int) -> int:
    """Receive outside the store lock; publish only a complete, still-queued upload."""
    target = staged_path(job, which)
    if not isinstance(length, int) or isinstance(length, bool) or length <= 0:
        raise S.StoreError("invalid_upload_length", "源文件必须非空并提供有效长度", 400)
    with S.LOCK:
        _require_queued(job)
        if job.resume:
            raise S.StoreError("retry_source_readonly", "重试任务使用已保存的源文件", 409)
        if which in job._uploads:
            raise S.StoreError("upload_in_progress", "该源文件正在上传，请等待上传完成", 409)
        job._uploads.add(which)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=job.source_dir, prefix=f".{which}-",
                                         suffix=".part", delete=False) as output:
            temp_path = Path(output.name)
            remaining = length
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise S.StoreError("upload_truncated", "源文件上传中断，请重新上传", 400)
                if len(chunk) > remaining:
                    raise S.StoreError("upload_length_mismatch", "源文件长度与声明不一致", 400)
                output.write(chunk)
                remaining -= len(chunk)
        with S.LOCK:
            _require_queued(job)
            os.replace(temp_path, target)
            job.uploaded[which] = True
            job.persist()
        return length
    finally:
        try:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        finally:
            with S.LOCK:
                job._uploads.discard(which)


@_locked
def delete_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise S.StoreError("job_not_found", "导入任务不存在", 404)
    active = S.ACTIVE_IMPORTS.get((job.project_id, job.model_id, job.version_id)) == job.id
    if job._uploads or job.status == "running" or (active and job.status != "queued"):
        raise S.StoreError("job_running", "导入或上传正在进行，无法清理", 409)
    # Validate the final deletion boundary even though job IDs are generated here.
    directory = job.dir.resolve()
    if directory.parent != S.JOBS.resolve():
        raise S.StoreError("path_escape", "非法任务目录", 400)
    if directory.exists():
        shutil.rmtree(directory)
    JOBS.pop(job_id, None)
    S.release_import(job.project_id, job.model_id, job.version_id, job.id)
    return {"removed": job_id}


@_locked
def _claim_start(job: Job) -> None:
    _require_queued(job)
    if job._uploads:
        raise S.StoreError("upload_in_progress", "请等待源文件上传完成后再开始导入", 409)
    if sum(j.status == "running" for j in JOBS.values()) >= MAX_RUNNING_IMPORTS:
        raise S.StoreError("import_capacity", "同时运行的导入任务已达上限，请稍后再开始", 429)
    # RVM 是唯一必需项；TXT 可选（不给则元数据由 RVM 合成，只剩名字/层级/类型、无工程属性）
    if not job.resume and not job.uploaded["rvm"]:
        raise S.StoreError("source_missing", "还缺源文件：RVM")
    job.status = "running"
    job.stage = "queued"
    job.error = None
    for s in job.stages:
        s["status"] = "pending"
        s["ms"] = None
    job.persist()


@_locked
def start_job(job: Job) -> Job:
    _claim_start(job)
    t = threading.Thread(target=_guard, args=(job,), daemon=True)
    try:
        t.start()
    except Exception:
        job.status = "queued"
        job.persist()
        raise
    return job


def _guard(job: Job) -> dict:
    try:
        return _run_job(job)
    except S.StoreError as e:
        job.fail(job.stage, e.message)
    except Exception as e:  # noqa: BLE001
        job.fail(job.stage, f"未预期的错误：{e!r}")
    finally:
        # Keep the reservation until log/manifest writes are finished, even after
        # ready/failed has become visible to readers.
        S.release_import(job.project_id, job.model_id, job.version_id, job.id)
    return {"failed": True, "error": job.error}


def run_job(job: Job) -> dict:
    """Synchronous CLI entrypoint with the same atomic start checks as HTTP."""
    _claim_start(job)
    return _guard(job)


def _clean_derived(vdir: Path, job: "Job") -> int:
    """重试时清掉上一次留下的派生数据。

    刻意**不用 shutil.rmtree**：它遇到被占用的文件会整体抛异常，而这一步只是可选清理，
    不该因为它失败就让整个导入挂掉（Windows 上文件被编辑器/杀软占用很常见）。
    源文件（source/）任何情况下都不动。"""
    removed = 0
    for sub in ("processed", "reports"):
        d = vdir / sub
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        for f in sorted(d.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                if f.is_dir():
                    f.rmdir()
                else:
                    f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def _run_job(job: Job) -> dict:
    stages: dict[str, int] = {}
    job._log = [f"# import job {job.id}  {S.now_iso()}",
                f"# {_rel(S.PROJECTS / job.project_id)} → "
                f"{job.project_id}/{job.model_id}/{job.version_id}", ""]
    t_all = time.perf_counter()

    # ---------------- copying ----------------
    job._enter("copying")
    t0 = time.perf_counter()
    with S.LOCK:
        if job.project_id and not (S.PROJECTS / job.project_id).is_dir():
            S.create_project(job.new_project_name, job.project_id)
            job._log.append(f"[copying] 新建 Project {job.project_id}（{job.new_project_name}）")
        if not (S.PROJECTS / job.project_id / "models" / job.model_id).is_dir():
            S.create_model(job.project_id, job.new_model_name, job.model_id)
            job._log.append(f"[copying] 新建 Model {job.model_id}（{job.new_model_name}）")

    vdir = S.version_dir(job.project_id, job.model_id, job.version_id)

    # 本次到底有没有 TXT？以**实际文件**为准（暂存区里刚上传的，或重试时 source/ 里既有的），
    # 不看界面传进来的文件名 —— 仅 RVM 版本本来就没有 TXT。
    has_txt = (staged_path(job, "txt").is_file() or (vdir / "source" / S.SOURCE_TXT).is_file())
    job.metadata_source = (S.METADATA_SOURCE_TXT if has_txt else S.METADATA_SOURCE_RVM)

    fresh = not (vdir / "version.json").exists()
    if fresh:
        (vdir / "source").mkdir(parents=True, exist_ok=True)
        (vdir / "processed").mkdir(parents=True, exist_ok=True)
        (vdir / "reports").mkdir(parents=True, exist_ok=True)
        rvm_src = staged_path(job, "rvm")
        doc = S.new_version_doc(job.version_id, job.version_name,
                                S.file_mtime_iso(rvm_src),
                                original_rvm=job.rvm_filename,
                                original_txt=(job.txt_filename or None) if has_txt else None)
        S.write_json(vdir / "version.json", doc)
    else:
        # 重试：源文件已在位，只清理上一次的派生数据（源文件是只读的，任何情况下都不动）
        n_removed = _clean_derived(vdir, job)
        with S.LOCK:
            doc = S.read_json(vdir / "version.json")
            doc["status"] = S.STATUS_IMPORTING
            doc["error"] = None
            doc["importedAt"] = S.now_iso()
            S.append_history(doc, S.STATUS_IMPORTING, "retry")
            S.write_json(vdir / "version.json", doc)
        job._log.append(f"[copying] 重试：保留 source/，清理了 {n_removed} 个上一次的派生文件")

    for which, fixed in (("rvm", S.SOURCE_RVM), ("txt", S.SOURCE_TXT)):
        if which == "txt" and not has_txt:
            job._log.append("[copying] 未提供 TXT —— 元数据将由 RVM 合成"
                            "（只有名称、层级、类型；没有工程属性与设备定位图）")
            continue
        dst = vdir / "source" / fixed
        if not dst.exists():
            os.replace(staged_path(job, which), dst)
        job._log.append(f"[copying] source/{fixed}  "
                        f"{dst.stat().st_size:,} B  "
                        f"（原始文件名 {getattr(job, which + '_filename') or '—'}）")
    job._flush_log()
    stages["copying"] = int((time.perf_counter() - t0) * 1000)
    job._done("copying", stages["copying"])

    rel_v = _rel(vdir)
    rvm_rel = f"{rel_v}/source/{S.SOURCE_RVM}"
    txt_rel = f"{rel_v}/source/{S.SOURCE_TXT}"
    glb_rel = f"{rel_v}/processed/{S.GLB}"

    # ---------------- geometry（① 现有转换器）----------------
    job._enter("geometry")
    t0 = time.perf_counter()
    p = _run([PY, "converter/rvm_to_glb.py", "--source", rvm_rel, "--out", glb_rel,
              "--tolerance", str(TOLERANCE),
              "--log", f"{rel_v}/reports/convert.log",
              "--evidence-dir", f"{rel_v}/reports"], job._log)
    job._flush_log()
    if p.returncode != 0 or not (vdir / "processed" / S.GLB).exists():
        return _failed(job, "geometry", "RVM → GLB 转换失败", p)
    stages["geometry"] = int((time.perf_counter() - t0) * 1000)
    job._done("geometry", stages["geometry"])

    # ---------------- metadata（有 TXT：② 现有转换器 / 仅 RVM：合成）----------------
    fp_stats: dict = {}
    job._enter("metadata")
    t0 = time.perf_counter()
    if job.metadata_source == S.METADATA_SOURCE_TXT:
        p = _run([PY, "converter/txt_parser.py", "--source", txt_rel,
                  "--out", f"{rel_v}/processed/{S.METADATA}",
                  "--metamodel", f"{rel_v}/processed/{S.METAMODEL}"], job._log)
        job._flush_log()
        if p.returncode != 0 or not (vdir / "processed" / S.METADATA).exists():
            return _failed(job, "metadata", "TXT → metadata 解析失败", p)
        meta0 = S.read_json(vdir / "processed" / S.METADATA)
        if (meta0.get("stats", {}).get("objects") or 0) < 1:
            # 不是合法的 PDMS Data Listing（解析器不会为此报错，但 0 个对象没有意义）：
            # 提前在这个阶段失败，别让它跑到校验阶段才暴露
            return _failed(job, "metadata",
                           "TXT 解析出 0 个对象 —— 该文件不是 PDMS Data Listing，或用错了文件")

        # 同一份 source/model.txt 交给既有设备定位工具。该工具内部继续复用
        # PdmsDataListingParser + OutlineBuilder；Viewer 不维护第二套 PDMS TXT 解析逻辑。
        floorplan_path = vdir / "processed" / S.FLOORPLAN
        try:
            floorplan_exe = _floorplan_tool()
        except S.StoreError as e:
            return _failed(job, "metadata", e.message)
        p = _run([str(floorplan_exe), "floorplan", str(vdir / "source" / S.SOURCE_TXT),
                  str(floorplan_path)], job._log)
        if p.returncode != 0 or not floorplan_path.exists():
            return _failed(job, "metadata", "设备定位图 floorplan.json 导出失败", p)
        try:
            floorplan = S.read_json(floorplan_path)
            fp_stats = floorplan.get("stats") or {}
            floorplan_ok = (
                floorplan.get("schema") == "pdms-equipment-floorplan/1"
                and floorplan.get("units") == "mm"
                and floorplan.get("coordinateSystem") == "PDMS_WORLD_XY_Z_UP"
                and isinstance(floorplan.get("equipment"), list)
                and fp_stats.get("equipment") == len(floorplan["equipment"])
            )
        except Exception:  # noqa: BLE001
            floorplan, fp_stats, floorplan_ok = {}, {}, False
        if not floorplan_ok:
            return _failed(job, "metadata", "floorplan.json 合同校验失败")
    else:
        # 仅 RVM：先用 rvm_index 取「字节偏移 + 名称 + 层级」，再由 rvm_metadata 合成
        # Viewer 契约的 metadata.json + mapping.json。canonical 就是 RVM 组名，
        # 与 TXT 链路同构，所以 Viewer 侧加载逻辑一行都不用改。
        p = _run([PY, "converter/rvm_index.py", "--source", rvm_rel,
                  "--out", f"{rel_v}/processed/{S.RVM_INDEX}"], job._log)
        job._flush_log()
        if p.returncode != 0 or not (vdir / "processed" / S.RVM_INDEX).exists():
            return _failed(job, "metadata", "RVM 技术索引生成失败", p)

        p = _run([PY, "converter/rvm_metadata.py",
                  "--rvm-index", f"{rel_v}/processed/{S.RVM_INDEX}",
                  "--glb", glb_rel,
                  "--source", rvm_rel,
                  "--metadata", f"{rel_v}/processed/{S.METADATA}",
                  "--mapping", f"{rel_v}/processed/{S.MAPPING}",
                  "--evidence-dir", f"{rel_v}/reports"], job._log)
        job._flush_log()
        if p.returncode != 0 or not (vdir / "processed" / S.METADATA).exists() \
                or not (vdir / "processed" / S.MAPPING).exists():
            return _failed(job, "metadata", "仅 RVM 模式的元数据合成失败", p)
        meta0 = S.read_json(vdir / "processed" / S.METADATA)
        if (meta0.get("stats", {}).get("objects") or 0) < 1:
            return _failed(job, "metadata", "RVM 里没有任何组，无法合成元数据")
        job._log.append(
            f"[metadata] 仅 RVM 模式：{meta0['stats']['objects']:,} 个对象由 RVM 组名合成；"
            f"工程属性不可用（RVM 不含属性），设备定位图已跳过")
    job._flush_log()
    stages["metadata"] = int((time.perf_counter() - t0) * 1000)
    job._done("metadata", stages["metadata"])

    # ---------------- mapping（有 TXT：①附 rvm_index + ③ map_objects / 仅 RVM：已完成）----
    job._enter("mapping")
    t0 = time.perf_counter()
    if job.metadata_source == S.METADATA_SOURCE_TXT:
        p = _run([PY, "converter/rvm_index.py", "--source", rvm_rel,
                  "--out", f"{rel_v}/processed/{S.RVM_INDEX}"], job._log)
        job._flush_log()
        if p.returncode != 0 or not (vdir / "processed" / S.RVM_INDEX).exists():
            return _failed(job, "mapping", "RVM 技术索引生成失败", p)

        p = _run([PY, "converter/map_objects.py",
                  "--meta", f"{rel_v}/processed/{S.METADATA}",
                  "--rvm", f"{rel_v}/processed/{S.RVM_INDEX}",
                  "--glb", f"{rel_v}/processed/{S.GLB}",
                  "--out", f"{rel_v}/processed/{S.MAPPING}",
                  "--evidence-dir", f"{rel_v}/reports"], job._log)
        job._flush_log()
        if p.returncode != 0 or not (vdir / "processed" / S.MAPPING).exists():
            return _failed(job, "mapping", "RVM ↔ TXT 对象映射失败", p)
    else:
        # 仅 RVM 模式没有"两套元数据要对齐"这件事：canonical 就是 RVM 组名，
        # mapping 已在 metadata 阶段由 rvm_metadata.py 随 metadata 一并产出。
        job._log.append("[mapping] 仅 RVM 模式：canonical ↔ GLB 节点 ↔ RVM 字节偏移 "
                        "已随 metadata 一并合成，无需再跑 map_objects（本阶段无额外工作）")
        job._flush_log()
    stages["mapping"] = int((time.perf_counter() - t0) * 1000)
    job._done("mapping", stages["mapping"])

    # ---------------- validating（GLB 闸门恒跑；元数据闸门按来源选）----------------
    job._enter("validating")
    t0 = time.perf_counter()
    rep = vdir / "reports"
    checks: list[dict] = []

    glb_json = rep / "validation.glb.json"
    p = _run([PY, "converter/verify_glb.py", glb_rel, "--json", _rel(glb_json)], job._log)
    glb_res = S.read_json(glb_json) if glb_json.exists() else {}
    # verify_glb 本身只输出结构报告、不含判定，闸门取自它的三个客观条件
    g_ok = p.returncode == 0 and bool(glb_res) and glb_res.get("json_utf8_ok") is True \
        and (glb_res.get("counts", {}).get("nodes") or 0) > 0 \
        and (glb_res.get("geometry", {}).get("triangles") or 0) > 0
    checks.append({"name": "GLB 结构（UTF-8 JSON / 节点数 / 三角形数）", "ok": g_ok,
                   "detail": {"json_utf8_ok": glb_res.get("json_utf8_ok"),
                              "nodes": glb_res.get("counts", {}).get("nodes"),
                              "triangles": glb_res.get("geometry", {}).get("triangles")}})

    if job.metadata_source == S.METADATA_SOURCE_TXT:
        meta_json = rep / "validation.metadata.json"
        p = _run([PY, "converter/verify_metadata.py", "--source", txt_rel,
                  "--meta", f"{rel_v}/processed/{S.METADATA}",
                  "--json", _rel(meta_json)], job._log)
        meta_res = S.read_json(meta_json) if meta_json.exists() else {}
        m_fails = [c["name"] for c in meta_res.get("checks", []) if not c.get("ok")]
        checks.append({"name": f'metadata 独立校验（{len(meta_res.get("checks", []))} 项）',
                       "ok": p.returncode == 0, "detail": {"failed": m_fails[:12],
                                                           "failedCount": len(m_fails)}})

        map_json = rep / "validation.mapping.json"
        p = _run([PY, "converter/verify_mapping.py",
                  "--mapping", f"{rel_v}/processed/{S.MAPPING}",
                  "--meta", f"{rel_v}/processed/{S.METADATA}",
                  "--rvm-index", f"{rel_v}/processed/{S.RVM_INDEX}",
                  "--glb", f"{rel_v}/processed/{S.GLB}",
                  "--rvm", rvm_rel,
                  "--json", _rel(map_json)], job._log)
        map_res = S.read_json(map_json) if map_json.exists() else {}
        mp_fails = [c["name"] for c in map_res.get("checks", []) if not c.get("ok")]
        checks.append({"name": f'mapping 独立校验（{len(map_res.get("checks", []))} 项）',
                       "ok": p.returncode == 0, "detail": {"failed": mp_fails[:12],
                                                           "failedCount": len(mp_fails)}})
    else:
        # 仅 RVM：一条闸门同时覆盖 metadata 与 mapping（含逐条 rvmOffset 回读 RVM 二进制）
        rvm_json = rep / "validation.rvm-metadata.json"
        p = _run([PY, "converter/verify_rvm_metadata.py",
                  "--metadata", f"{rel_v}/processed/{S.METADATA}",
                  "--mapping", f"{rel_v}/processed/{S.MAPPING}",
                  "--rvm-index", f"{rel_v}/processed/{S.RVM_INDEX}",
                  "--glb", glb_rel,
                  "--rvm", rvm_rel,
                  "--json", _rel(rvm_json)], job._log)
        rvm_res = S.read_json(rvm_json) if rvm_json.exists() else {}
        r_fails = [c["name"] for c in rvm_res.get("checks", []) if not c.get("ok")]
        checks.append({"name": f'仅 RVM 合成校验（{len(rvm_res.get("checks", []))} 项，'
                               f'含 {rvm_res.get("readbackChecked", 0):,} 条字节偏移回读）',
                       "ok": p.returncode == 0, "detail": {"failed": r_fails[:12],
                                                           "failedCount": len(r_fails),
                                                           "source": S.METADATA_SOURCE_RVM}})
    job._flush_log()

    validation = {"schema": "pdms-import-validation/1", "at": S.now_iso(),
                  "pass": all(c["ok"] for c in checks), "checks": checks}
    S.write_json(rep / "validation.json", validation)
    if not validation["pass"]:
        bad = "；".join(c["name"] for c in checks if not c["ok"])
        return _failed(job, "validating", f"校验未通过：{bad}")
    stages["validating"] = int((time.perf_counter() - t0) * 1000)
    job._done("validating", stages["validating"])

    # ---------------- ready ----------------
    job._enter("ready")
    t0 = time.perf_counter()
    meta = S.read_json(vdir / "processed" / S.METADATA)
    mapping = S.read_json(vdir / "processed" / S.MAPPING)
    mst, gst = mapping.get("stats", {}), glb_res.get("geometry", {})
    rvm_groups = mst.get("rvmGroups") or 0
    final_stats = {
        "metadataSource": job.metadata_source,
        "rvmBytes": (vdir / "source" / S.SOURCE_RVM).stat().st_size,
        # 仅 RVM 版本没有 TXT：如实置 null，不写 0（0 会被读成"有一份空文件"）
        "txtBytes": ((vdir / "source" / S.SOURCE_TXT).stat().st_size if has_txt else None),
        "glbBytes": (vdir / "processed" / S.GLB).stat().st_size,
        "objectCount": meta.get("stats", {}).get("objects"),
        "namedNodes": mst.get("glbNamedNodes"),
        "rvmGroups": rvm_groups,
        "mappedObjects": mst.get("matched"),
        "mappingRate": round(mst.get("matched", 0) / rvm_groups, 4) if rvm_groups else None,
        "triangles": gst.get("triangles"),
        "meshes": glb_res.get("counts", {}).get("meshes"),
        "lines": gst.get("lines"),
        "floorplanEquipment": fp_stats.get("equipment"),
        "floorplanPositioned": fp_stats.get("equipmentWithPosition"),
        "floorplanOutlines": fp_stats.get("outlines"),
        "durationMs": int((time.perf_counter() - t_all) * 1000),
        "converterVersion": _tool_version(),
    }
    with S.LOCK:
        # Read the current manifest inside the same lock as rename/update APIs.
        # User fields may have changed while the converter was running.
        doc = S.read_json(vdir / "version.json")
        doc.update(status=S.STATUS_READY, error=None, importedAt=S.now_iso(),
                   metadataSource=job.metadata_source,
                   sourceTxt=f"source/{S.SOURCE_TXT}" if has_txt else None,
                   stats=final_stats)
        S.append_history(doc, S.STATUS_READY)
        S.write_json(vdir / "version.json", doc)
        stages["ready"] = int((time.perf_counter() - t0) * 1000)
        job._done("ready", stages["ready"])
        job.status = "ready"
        job.stage = "ready"
        job.result = {**doc, "assets": {k: S.url_of(vdir / "processed" / v)
                                      for k, v in [("glb", S.GLB), ("metadata", S.METADATA),
                                                   ("metamodel", S.METAMODEL),
                                                   ("rvmIndex", S.RVM_INDEX),
                                                   ("mapping", S.MAPPING),
                                                   ("floorplan", S.FLOORPLAN)]
                                      if (vdir / "processed" / v).exists()}}
        job._flush_log(f"[ready] 导入完成，总耗时 {doc['stats']['durationMs']} ms")
        job.persist()
    return job.result


def _failed(job: Job, stage: str, message: str,
            proc: subprocess.CompletedProcess | None = None) -> dict:
    detail = None
    if proc is not None:
        detail = ((proc.stdout or "") + (proc.stderr or ""))[-2000:]
    job.fail(stage, message, detail)
    return {"failed": True, "stage": stage, "message": message}


# ------------------------------------------------------------------ CLI

def main() -> int:
    ap = argparse.ArgumentParser(description="无界面导入（走同一套流水线）")
    ap.add_argument("--project", default=None, help="已有 Project ID")
    ap.add_argument("--new-project", default=None, help="新 Project 显示名（不存在时创建）")
    ap.add_argument("--model", default=None, help="已有 Model ID")
    ap.add_argument("--new-model", default=None, help="新 Model 显示名")
    ap.add_argument("--version", required=True, help="Version 名称（同时用作目录名 slug）")
    ap.add_argument("--version-id", default=None)
    ap.add_argument("--rvm", type=Path, required=True)
    ap.add_argument("--txt", type=Path, default=None,
                    help="PDMS Data Listing（可选）。不给则只按 RVM 合成元数据："
                         "有名称/层级/类型，没有工程属性与设备定位图")
    ap.add_argument("--create-project", action="store_true",
                    help="允许按 --new-project 自动建 Project")
    ap.add_argument("--create-model", action="store_true",
                    help="允许按 --new-model 自动建 Model")
    a = ap.parse_args()

    try:
        job = create_job(
            project_id=a.project or a.new_project,
            model_id=(a.model or a.new_model) if (a.project or a.new_project) else None,
            version_name=a.version, version_id=a.version_id,
            new_project_name=a.new_project if not a.project or a.create_project else None,
            new_model_name=a.new_model if not a.model or a.create_model else None,
            rvm_filename=a.rvm.name, txt_filename=(a.txt.name if a.txt else ""))
    except S.StoreError as e:
        print(f"[拒绝] {e.message}")
        return 2
    with a.rvm.open("rb") as source:
        save_upload_stream(job, "rvm", source, a.rvm.stat().st_size)
    if a.txt:
        with a.txt.open("rb") as source:
            save_upload_stream(job, "txt", source, a.txt.stat().st_size)
    run_job(job)                       # CLI 模式同步执行，日志直接打到 stdout
    print(job.log_text())
    print(f"状态：{job.status}  阶段：{job.stage}")
    if job.error:
        print(f"错误：{job.error['message']}")
    return 0 if job.status == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
