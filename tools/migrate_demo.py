"""一次性迁移：把当前单一 demo（data/source + data/processed）注册为
    Project 启创项目 / Model Main Site / Version 2026-08-26

任务书 §30 要求：**不重新转换**。Phase 2–5 的产物已经过 33 + 21 项校验，这里只做搬运，
搬运后原地重跑三条校验器，证明"搬完还是同一份数据"。

安全策略：复制 → 逐项对账（sha256 + 字节数）→ 重跑校验 → 全部通过后把**原件整体挪到**
data/_legacy_demo_2026-08-26/（不删除，可随时回退）。

用法：
    python tools/migrate_demo.py            # 正式迁移
    python tools/migrate_demo.py --dry-run  # 只检查，不动文件
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asset_store as S  # noqa: E402

ROOT = S.ROOT
PY = sys.executable
LEGACY = S.DATA / "_legacy_demo_2026-08-26"

PROJECT_ID, PROJECT_NAME = "qichuang", "启创项目"
MODEL_ID, MODEL_NAME = "main-site", "Main Site"
VERSION_ID, VERSION_NAME = "2026-08-26", "2026-08-26"

PROCESSED_FILES = [S.GLB, S.METADATA, S.METAMODEL, S.RVM_INDEX, S.MAPPING]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def find_one(pattern: str, label: str) -> Path:
    cands = sorted((S.DATA / "source").glob(pattern))
    if len(cands) != 1:
        raise SystemExit(f"data/source 下 {label} 应有且仅有 1 个（{pattern}），实际 {len(cands)} 个")
    return cands[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    src_rvm = find_one("*.rvm", "RVM")
    src_txt = find_one("*.txt", "TXT")
    src_proc = S.DATA / "processed"
    missing = [f for f in PROCESSED_FILES if not (src_proc / f).exists()]
    if missing:
        raise SystemExit(f"data/processed 缺文件：{missing}")

    vdir = S.version_dir(PROJECT_ID, MODEL_ID, VERSION_ID)
    if (vdir / "version.json").exists():
        doc = S.read_json(vdir / "version.json")
        print(f"[跳过] 目标版本已存在（status={doc.get('status')}）：{vdir.relative_to(ROOT)}")
        return 0

    print("=" * 72)
    print("  迁移 demo → Project 启创项目 / Model Main Site / Version 2026-08-26")
    print("=" * 72)
    print(f"  RVM  {src_rvm.name}  {src_rvm.stat().st_size:,} B")
    print(f"  TXT  {src_txt.name}  {src_txt.stat().st_size:,} B")
    for f in PROCESSED_FILES:
        print(f"  产物 {f:32s} {(src_proc / f).stat().st_size:,} B")
    print(f"  目标 {vdir.relative_to(ROOT).as_posix()}")
    if a.dry_run:
        print("\n[dry-run] 未做任何改动。")
        return 0

    # ---------------- 1. 注册 Project / Model ----------------
    if not (S.PROJECTS / PROJECT_ID).is_dir():
        S.create_project(PROJECT_NAME, PROJECT_ID, description="从原始 QICHUANG 示例迁移")
        print(f"\n  [1] 新建 Project {PROJECT_ID}（{PROJECT_NAME}）")
    if not (S.PROJECTS / PROJECT_ID / "models" / MODEL_ID).is_dir():
        S.create_model(PROJECT_ID, MODEL_NAME, MODEL_ID)
        print(f"  [1] 新建 Model {MODEL_ID}（{MODEL_NAME}）")

    # ---------------- 2. 复制 ----------------
    (vdir / "source").mkdir(parents=True, exist_ok=True)
    (vdir / "processed").mkdir(parents=True, exist_ok=True)
    (vdir / "reports").mkdir(parents=True, exist_ok=True)
    copies = [(src_rvm, vdir / "source" / S.SOURCE_RVM),
              (src_txt, vdir / "source" / S.SOURCE_TXT)]
    copies += [(src_proc / f, vdir / "processed" / f) for f in PROCESSED_FILES]
    for src, dst in copies:
        shutil.copy2(src, dst)               # copy2 保留 mtime，version.createdAt 要用
    print(f"  [2] 复制 {len(copies)} 个文件完成")

    # ---------------- 3. 逐项对账 ----------------
    mism = []
    print("\n  [3] 逐项对账（sha256 必须完全一致）")
    for src, dst in copies:
        h1, h2 = sha256(src), sha256(dst)
        ok = h1 == h2 and src.stat().st_size == dst.stat().st_size
        mism += [] if ok else [dst.name]
        print(f"      {'OK ' if ok else 'BAD'} {dst.relative_to(vdir).as_posix():40s} "
              f"{dst.stat().st_size:>12,} B  {h2[:12]}")
    if mism:
        raise SystemExit(f"复制校验失败：{mism}")

    # ---------------- 4. 写 version.json（stats 从现有产物读出，不重算）----------------
    rel_v = vdir.relative_to(ROOT).as_posix()
    rep = vdir / "reports"
    print("\n  [4] 原地重跑三条校验器（证明搬运后仍是同一份数据）")
    run = lambda cmd: subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                                     encoding="utf-8", errors="replace")
    glb_json = rep / "validation.glb.json"
    p1 = run([PY, "converter/verify_glb.py", f"{rel_v}/processed/{S.GLB}",
              "--json", f"{rel_v}/reports/validation.glb.json"])
    meta_json = rep / "validation.metadata.json"
    p2 = run([PY, "converter/verify_metadata.py", "--source", f"{rel_v}/source/{S.SOURCE_TXT}",
              "--meta", f"{rel_v}/processed/{S.METADATA}",
              "--json", f"{rel_v}/reports/validation.metadata.json"])
    map_json = rep / "validation.mapping.json"
    p3 = run([PY, "converter/verify_mapping.py",
              "--mapping", f"{rel_v}/processed/{S.MAPPING}",
              "--meta", f"{rel_v}/processed/{S.METADATA}",
              "--rvm-index", f"{rel_v}/processed/{S.RVM_INDEX}",
              "--glb", f"{rel_v}/processed/{S.GLB}",
              "--rvm", f"{rel_v}/source/{S.SOURCE_RVM}",
              "--json", f"{rel_v}/reports/validation.mapping.json"])

    meta_res = S.read_json(meta_json) if meta_json.exists() else {}
    map_res = S.read_json(map_json) if map_json.exists() else {}
    glb_res = S.read_json(glb_json) if glb_json.exists() else {}
    checks = [
        {"name": f'GLB 结构（UTF-8 JSON / 节点数 / 三角形数）',
         "ok": bool(glb_res.get("json_utf8_ok")) and glb_res.get("counts", {}).get("nodes", 0) > 0,
         "detail": {"nodes": glb_res.get("counts", {}).get("nodes"),
                    "triangles": glb_res.get("geometry", {}).get("triangles")}},
        {"name": f'metadata 独立校验（{len(meta_res.get("checks", []))} 项）',
         "ok": p2.returncode == 0,
         "detail": {"failed": [c["name"] for c in meta_res.get("checks", []) if not c.get("ok")]}},
        {"name": f'mapping 独立校验（{len(map_res.get("checks", []))} 项）',
         "ok": p3.returncode == 0,
         "detail": {"failed": [c["name"] for c in map_res.get("checks", []) if not c.get("ok")],
                    "readbackChecked": map_res.get("readbackChecked")}},
    ]
    for c in checks:
        print(f"      {'OK ' if c['ok'] else 'BAD'} {c['name']}")
    validation = {"schema": "pdms-import-validation/1", "at": S.now_iso(),
                  "migrated": True, "pass": all(c["ok"] for c in checks), "checks": checks}
    S.write_json(rep / "validation.json", validation)
    if not validation["pass"]:
        raise SystemExit("迁移后校验未通过，已中止（原件未动）。")

    meta = S.read_json(vdir / "processed" / S.METADATA)
    mapping = S.read_json(vdir / "processed" / S.MAPPING)
    mst = mapping.get("stats", {})
    rvm_groups = mst.get("rvmGroups") or 0
    doc = S.new_version_doc(VERSION_ID, VERSION_NAME, S.file_mtime_iso(vdir / "source" / S.SOURCE_RVM),
                            original_rvm=src_rvm.name, original_txt=src_txt.name)
    doc["stats"] = {
        "rvmBytes": (vdir / "source" / S.SOURCE_RVM).stat().st_size,
        "txtBytes": (vdir / "source" / S.SOURCE_TXT).stat().st_size,
        "glbBytes": (vdir / "processed" / S.GLB).stat().st_size,
        "objectCount": meta.get("stats", {}).get("objects"),
        "namedNodes": mst.get("glbNamedNodes"),
        "rvmGroups": rvm_groups,
        "mappedObjects": mst.get("matched"),
        "mappingRate": round(mst.get("matched", 0) / rvm_groups, 4) if rvm_groups else None,
        "triangles": glb_res.get("geometry", {}).get("triangles"),
        "meshes": glb_res.get("counts", {}).get("meshes"),
        "lines": glb_res.get("geometry", {}).get("lines"),
        "durationMs": 0,
        "converterVersion": f"{S.PIPELINE_VERSION} · rvmparser/2f7025971a95 · tolerance 0.02 m "
                            f"· migrated (no re-conversion)",
    }
    doc["status"] = S.STATUS_READY
    S.append_history(doc, S.STATUS_READY, "migrated")
    S.write_json(vdir / "version.json", doc)
    print(f"  [5] version.json 已注册：objects={doc['stats']['objectCount']:,} "
          f"mapped={doc['stats']['mappedObjects']:,} rate={doc['stats']['mappingRate']}")

    # ---------------- 6. 原件移入 legacy（不删除）----------------
    LEGACY.mkdir(parents=True, exist_ok=True)
    for name in ("source", "processed"):
        src = S.DATA / name
        dst = LEGACY / name
        if src.is_dir() and not dst.exists():
            shutil.move(str(src), str(dst))
    print(f"  [6] 原件已移入 {LEGACY.relative_to(ROOT).as_posix()}/（未删除，可回退）")

    evid = ROOT / "reports" / "evidence" / "phase8-migration.json"
    S.write_json(evid, {
        "at": S.now_iso(), "target": rel_v,
        "files": [{"to": d.relative_to(vdir).as_posix(), "bytes": d.stat().st_size,
                   "sha256": sha256(d)} for _, d in copies],
        "validation": validation, "stats": doc["stats"],
        "legacy": LEGACY.relative_to(ROOT).as_posix(),
    })
    print(f"\n  证据 {evid.relative_to(ROOT).as_posix()}")
    print("  迁移完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
