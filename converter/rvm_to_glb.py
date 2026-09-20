"""① 几何层 —— RVM → GLB

职责单一：调用固定版本的 cdyk/rvmparser（MIT）把 PDMS RVM 转成 glTF/GLB。
不解析 TXT、不做对象映射、不改写几何。薄封装，便于将来替换解析器。

用法：
    python converter/rvm_to_glb.py                     # 用 data/source 里唯一的 .rvm
    python converter/rvm_to_glb.py --tolerance 0.02
    python converter/rvm_to_glb.py --source xxx.rvm --out yyy.glb
    python converter/rvm_to_glb.py --input a.rvm --output b.glb --log l.log --evidence-dir r/

（`--input/--output` 是 `--source/--out` 的同义参数，供本地后端按任意路径调用；
 转换算法与默认行为完全未变。）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "tools" / "rvmparser" / "rvmparser.exe"
SRC_DIR = ROOT / "data" / "source"
OUT_DIR = ROOT / "data" / "processed"
EVID = ROOT / "reports" / "evidence"

DEFAULT_TOLERANCE = 0.02


def pick_source() -> Path:
    cands = sorted(SRC_DIR.glob("*.rvm"))
    if not cands:
        raise SystemExit(f"data/source 下没有 .rvm 文件：{SRC_DIR}")
    return cands[0]


def under_root(p: Path) -> Path:
    """源/目标一律限定在项目根内：解析器把相对路径写进 GLB，跑出根目录外没有意义，
    也会让 ascii_rel() 产出 `../..` 这种带越级的名字。"""
    p = p.resolve() if p.is_absolute() else (ROOT / p).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise SystemExit(f"路径必须在项目根目录内：{p}")
    return p


def ascii_rel(p: Path) -> str:
    """把路径转成相对项目根的 ASCII 形式。

    必须这么做：rvmparser 会把源文件路径原样写进 glTF 的 JSON 块（File 节点的 name），
    而它在 Windows 下拿到的是 ANSI(GBK) 编码的 argv。只要路径里带非 ASCII 字符
    （例如项目目录名里的中文），写出来的 JSON 块就不是合法 UTF-8，GLB 变成非法文件。
    用相对路径 + ASCII 工作目录可以完全规避。
    """
    rel = os.path.relpath(p, ROOT).replace("\\", "/")
    if not rel.isascii():
        raise SystemExit(
            f"源路径含非 ASCII 字符，会导致 GLB 的 JSON 块非法：{rel}\n"
            f"请把源文件放到纯 ASCII 路径下（例如 data/source/），或在 converter 里做一次副本重命名。"
        )
    return rel


def validate_glb_json(out: Path) -> dict:
    """校验产出的 GLB：JSON 块必须是合法 UTF-8，且块结构自洽。"""
    import struct
    raw = out.read_bytes()
    magic, ver, length = struct.unpack_from("<4sII", raw, 0)
    report = {"magic": magic.decode("ascii", "replace"), "declared_len": length,
              "actual_len": len(raw), "json_ok": False, "bad_offsets": [], "file_node_name": None}
    if magic != b"glTF" or length != len(raw):
        report["structure_ok"] = False
        return report
    report["structure_ok"] = True
    clen, ctype = struct.unpack_from("<II", raw, 12)
    jc = raw[20:20 + clen]
    try:
        j = json.loads(jc.decode("utf-8"))
        report["json_ok"] = True
    except UnicodeDecodeError as e:
        report["bad_offsets"].append(e.start)
        return report
    except Exception as e:  # noqa: BLE001
        report["json_error"] = repr(e)
        return report
    for n in j.get("nodes", []):
        nm = n.get("name") or ""
        if "\\" in nm or nm.startswith("data/") or nm.startswith("./"):
            report["file_node_name"] = nm
            break
    report["nodes"] = len(j.get("nodes", []))
    return report


def run(source: Path, out: Path, tolerance: float, log_path: Path, extra: list[str] | None = None):
    if not EXE.exists():
        raise SystemExit(f"找不到解析器：{EXE}\n请见 README.md 的「固定解析器版本」一节。")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        os.path.relpath(EXE, ROOT).replace("\\", "/"),
        ascii_rel(source),
        f"--output-gltf={ascii_rel(out)}",
        "--output-gltf-attributes=true",
        "--output-gltf-rotate-z-to-y=true",   # PDMS 是 Z 向上，glTF 是 Y 向上
        "--output-gltf-merge-geos=true",      # 同组几何合并，保持「组 = 可选单元」粒度
        "--output-gltf-center=true",          # 移到包围盒中心，规避大坐标 float 精度
        f"--tolerance={tolerance}",
    ] + (extra or [])

    t0 = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", cwd=str(ROOT))
    wall_ms = int((time.perf_counter() - t0) * 1000)

    log = (proc.stdout or "") + (proc.stderr or "")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(log, encoding="utf-8")

    if proc.returncode != 0 or not out.exists():
        print(log[-4000:])
        raise SystemExit(f"转换失败，退出码 {proc.returncode}。日志：{log_path}")

    def grab(pat, cast=float):
        m = re.search(pat, log)
        return cast(m.group(1)) if m else None

    glb_check = validate_glb_json(out)
    if not glb_check.get("json_ok"):
        print("  [警告] 产出的 GLB 的 JSON 块不是合法 UTF-8，严格 loader 可能拒收：")
        print(f"         {glb_check}")
    if glb_check.get("file_node_name"):
        print(f"  [信息] GLB 内 File 节点名 = {glb_check['file_node_name']}")

    tess = re.search(
        r"Tessellated (\d+) items of (\d+) into (\d+) vertices and (\d+) triangles", log)
    stats = {
        "source": source.name,
        "source_bytes": source.stat().st_size,
        "glb": str(out.relative_to(ROOT)).replace("\\", "/"),
        "glb_bytes": out.stat().st_size,
        "tolerance_m": tolerance,
        "wall_ms": wall_ms,
        "parser_ms": grab(r"Exported gltf in (\d+)ms", int),
        "groups": grab(r"Groups\s+(\d+)", int),
        "geometries": grab(r"Geometries\s+(\d+)", int),
        "anchors_matched": grab(r"Matched (\d+) of (\d+) anchors", int),
        "anchors_total": grab(r"Matched \d+ of (\d+) anchors", int),
        "caps_discarded": grab(r"Discarded (\d+) caps", int),
        "tessellated_items": int(tess.group(1)) if tess else None,
        "triangles": int(tess.group(4)) if tess else None,
        "vertices": int(tess.group(3)) if tess else None,
        "exe_sha1": None,
        "glb_validation": glb_check,
    }
    import hashlib
    stats["exe_sha1"] = hashlib.sha1(EXE.read_bytes()).hexdigest()[:12]
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--input", type=Path, default=None, help="--source 的同义参数")
    ap.add_argument("--output", type=Path, default=None, help="--out 的同义参数")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    ap.add_argument("--log", type=Path, default=None,
                    help="解析器日志路径（缺省 scratch/convert-tol<t>.log）")
    ap.add_argument("--evidence-dir", type=str, default=None,
                    help="转换记录 JSON 的输出目录（缺省 reports/evidence；传空串则跳过）")
    a = ap.parse_args()

    source = under_root(a.input or a.source or pick_source())
    out = under_root(a.output or a.out or (OUT_DIR / "model.glb"))
    log_path = a.log or (ROOT / "scratch" / f"convert-tol{a.tolerance}.log")
    log_path = log_path if log_path.is_absolute() else (ROOT / log_path)
    if a.evidence_dir is None:
        evid = EVID
    elif a.evidence_dir.strip() == "":
        evid = None
    else:
        evid = Path(a.evidence_dir)

    stats = run(source, out, a.tolerance, log_path)
    if evid is not None:
        evid = evid if evid.is_absolute() else (ROOT / evid)
        evid.mkdir(parents=True, exist_ok=True)
        rec = evid / f"convert-records-tol{a.tolerance}.json"
        rec.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        rec = None

    print(f"RVM  {stats['source_bytes']:,} B  →  GLB {stats['glb_bytes']:,} B")
    print(f"tolerance={a.tolerance} m · 组 {stats['groups']} · 几何 {stats['geometries']}"
          f" · 三角形 {stats['triangles']:,} · 全流程 {stats['wall_ms']} ms")
    print(f"日志 {os.path.relpath(log_path, ROOT)}"
          + (f" · 记录 {os.path.relpath(rec, ROOT)}" if rec else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
