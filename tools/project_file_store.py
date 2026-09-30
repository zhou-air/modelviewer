"""Project-scoped files with an atomic manifest and opaque on-disk names.

Files share the existing project read/write permissions, but never belong to a
Model or Version. Downloads must go through the API; this directory is private.
"""
from __future__ import annotations

import re
import shutil
import socket
import tempfile
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asset_store as S

MAX_FILE_BYTES = 100 * 1024 * 1024
SCHEMA = "pdms-project-files/1"
FILE_ID = re.compile(r"^[0-9a-f]{32}$")
TYPES = {
    "CAD": {"dwg", "dxf"},
    "PDF": {"pdf"},
    "Spreadsheet": {"xlsx", "xls", "csv"},
    "Document": {"doc", "docx"},
    "Image": {"png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico", "avif", "heic", "heif"},
}
_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_NAME_UNITS = 180  # Reserve room for suffixes and stay below Windows name limits.


def _exact_path(path: Path) -> Path:
    """Reject aliases/junctions as well as escapes into another project's files."""
    if path.resolve() != path:
        raise S.StoreError("project_file_path_unsafe", "项目文件存储路径无效", 403)
    return path


def _project_root(pid: str) -> Path:
    pid = S.validate_id(pid, "project")
    expected = S.PROJECTS.resolve() / pid
    project = S.require_project(pid)
    if project != expected:
        raise S.StoreError("project_file_path_unsafe", "项目文件存储路径无效", 403)
    return _exact_path(expected)


def _files_root(pid: str) -> Path:
    return _exact_path(_project_root(pid) / "files")


def _manifest_path(root: Path) -> Path:
    path = _exact_path(root / "files.json")
    _exact_path(root / "files.json.tmp")
    return path


def _read(pid: str) -> tuple[Path, dict]:
    root = _files_root(pid)
    path = _manifest_path(root)
    if not path.exists():
        return root, {"schema": SCHEMA, "projectId": pid, "files": []}
    doc = S.read_json(path)
    if (not isinstance(doc, dict) or doc.get("schema") != SCHEMA
            or doc.get("projectId") != pid or not isinstance(doc.get("files"), list)):
        raise S.StoreError("project_files_invalid", "项目文件记录无效", 500)
    ids = set()
    for record in doc["files"]:
        if (not isinstance(record, dict)
                or not isinstance(record.get("id"), str)
                or not FILE_ID.fullmatch(record["id"])
                or record["id"] in ids or record.get("projectId") != pid
                or not isinstance(record.get("fileName"), str)
                or not record["fileName"]
                or record.get("type") not in {*TYPES, "Other"}
                or type(record.get("size")) is not int
                or not 0 <= record["size"] <= MAX_FILE_BYTES
                or not isinstance(record.get("uploadedAt"), str)):
            raise S.StoreError("project_files_invalid", "项目文件记录无效", 500)
        ids.add(record["id"])
        try:
            uploaded = datetime.fromisoformat(record["uploadedAt"])
            if uploaded.utcoffset() is None:
                raise ValueError("timezone required")
        except (ValueError, TypeError):
            raise S.StoreError("project_files_invalid", "项目文件上传时间无效", 500)
    return root, doc


def list_files(pid: str) -> dict:
    with S.LOCK:
        _, doc = _read(pid)
        records = [dict(record, relatedModelId=record.get("relatedModelId"),
                        relatedVersionId=record.get("relatedVersionId"))
                   for record in doc["files"]]
        records.sort(key=lambda record: (record["uploadedAt"], record["id"]), reverse=True)
        return {"projectId": pid, "files": records, "maxFileBytes": MAX_FILE_BYTES}


def _units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _truncate(text: str, limit: int) -> str:
    return text.encode("utf-16-le")[:limit * 2].decode("utf-16-le", errors="ignore")


def _split_name(name: str) -> tuple[str, str]:
    stem, sep, tail = name.rpartition(".")
    if not sep or not stem:
        return name, ""
    return stem, "." + _truncate(tail, 24)


def _fit_name(stem: str, extension: str, suffix: str = "") -> str:
    stem = _truncate(stem, _NAME_UNITS - _units(extension + suffix)).rstrip(" .") or "file"
    return stem + suffix + extension


def sanitize_name(name: str) -> str:
    if not isinstance(name, str) or not name.strip():
        raise S.StoreError("file_name_required", "请选择要上传的文件", 400)
    name = unicodedata.normalize("NFC", name)
    name = "".join("_" if unicodedata.category(char) in {"Cc", "Cf", "Cs"} else char
                   for char in name)
    name = _INVALID_NAME.sub("_", name).strip().rstrip(" .") or "file"
    stem, extension = _split_name(name)
    base = stem.split(".")[0].rstrip(" .").casefold()
    reserved = S.WINDOWS_RESERVED | {f"{prefix}{digit}" for prefix in ("com", "lpt")
                                   for digit in ("¹", "²", "³")}
    if base in reserved:
        stem = "_" + stem
    return _fit_name(stem, extension)


def _unique_name(name: str, records: list[dict]) -> str:
    used = {unicodedata.normalize("NFC", record["fileName"]).casefold() for record in records}
    stem, extension = _split_name(name)
    candidate = name
    number = 1
    while candidate.casefold() in used:
        candidate = _fit_name(stem, extension, f" ({number})")
        number += 1
    return candidate


def classify(name: str) -> str:
    extension = Path(name).suffix[1:].casefold()
    return next((kind for kind, extensions in TYPES.items() if extension in extensions), "Other")


def _upload_time(records: list[dict]) -> str:
    now = datetime.now(timezone.utc)
    # Give every successful commit a distinct timestamp, including concurrent
    # uploads or a system clock correction, so newest-first ordering is stable.
    if records:
        latest = datetime.fromisoformat(max(record["uploadedAt"] for record in records))
        if latest >= now:
            now = latest + timedelta(microseconds=1)
    return now.isoformat(timespec="microseconds")


def upload(pid: str, name: str, stream, length: int) -> dict:
    if type(length) is not int or length < 0:
        raise S.StoreError("invalid_content_length", "上传长度无效", 400)
    if length > MAX_FILE_BYTES:
        raise S.StoreError("file_too_large", "单个文件不能超过 100 MB", 413)
    name = sanitize_name(name)
    with S.LOCK:
        _files_root(pid)  # Reject a missing/unsafe project before receiving bytes.
    # Receive before acquiring the store lock, and avoid holding a 100 MB body
    # in memory. TemporaryFile is removed on every success or failure path.
    with tempfile.TemporaryFile() as incoming:
        remaining = length
        while remaining:
            try:
                chunk = stream.read(min(1 << 20, remaining))
            except socket.timeout as error:
                raise S.StoreError("upload_timeout", "文件上传超时，请重试", 408) from error
            except OSError as error:
                raise S.StoreError("upload_interrupted", "文件上传中断，请重试", 400) from error
            if not chunk:
                raise S.StoreError("upload_truncated", "文件未完整上传，请重试", 400)
            incoming.write(chunk)
            remaining -= len(chunk)
        incoming.seek(0)
        with S.LOCK:
            root, doc = _read(pid)  # Project might have been removed during upload.
            root.mkdir(exist_ok=True)
            identity = uuid.uuid4().hex
            directory = _exact_path(root / identity)
            while directory.exists():
                identity = uuid.uuid4().hex
                directory = _exact_path(root / identity)
            record = {"id": identity, "projectId": pid,
                      "fileName": _unique_name(name, doc["files"]),
                      "type": classify(name), "size": length,
                      "uploadedAt": _upload_time(doc["files"]),
                      "relatedModelId": None, "relatedVersionId": None}
            directory.mkdir()
            try:
                with (directory / "content.bin").open("xb") as target:
                    shutil.copyfileobj(incoming, target, 1 << 20)
                S.write_json(directory / "record.json", record)
                doc["files"].append(record)
                S.write_json(_manifest_path(root), doc)
            except Exception:
                shutil.rmtree(directory)
                raise
            return record


def _find(pid: str, fid: str) -> tuple[Path, dict, dict]:
    if not isinstance(fid, str) or not FILE_ID.fullmatch(fid):
        raise S.StoreError("project_file_not_found", "项目文件不存在", 404)
    root, doc = _read(pid)
    record = next((record for record in doc["files"] if record["id"] == fid), None)
    if record is None:
        raise S.StoreError("project_file_not_found", "项目文件不存在", 404)
    return _exact_path(root / fid), doc, record


def open_download(pid: str, fid: str):
    with S.LOCK:
        directory, _, record = _find(pid, fid)
        path = _exact_path(directory / "content.bin")
        if not path.is_file() or path.stat().st_size != record["size"]:
            raise S.StoreError("project_file_unavailable", "项目文件内容不存在或不完整", 404)
        return dict(record), path.open("rb")


def delete_file(pid: str, fid: str) -> dict:
    with S.LOCK:
        directory, doc, record = _find(pid, fid)
        _exact_path(directory / "content.bin")
        _exact_path(directory / "record.json")
        _exact_path(directory / "record.json.tmp")
        # Keep file metadata with the bytes in the existing trash system.
        S.write_json(directory / "record.json", record)
        trashed = S._trash(directory, "project-file", f"{pid}--{fid}")
        doc["files"] = [item for item in doc["files"] if item["id"] != fid]
        try:
            S.write_json(_manifest_path(_files_root(pid)), doc)
        except Exception:
            trash_path = S.safe_under(S.ROOT, trashed.lstrip("/"))
            shutil.move(str(trash_path), str(directory))
            raise
        return {"removed": fid, "trashedTo": trashed}
