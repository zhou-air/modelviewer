"""Verify this workspace and its strict public listener before opening a tunnel."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener


def verify(local_port=8765, public_port=8766, root=None):
    root = Path(root or Path(__file__).resolve().parents[1]).resolve()
    opener = build_opener(ProxyHandler({}))

    def get(port, path):
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
            value = json.loads(response.read(65536))
        if not value.get("ok"):
            raise ValueError("Backend rejected preflight")
        return value["data"]

    try:
        health = get(local_port, "/api/health")
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise ValueError("Local management verification denied. To keep local login-free access, use TRUST_LOOPBACK=1 and do not list loopback in TRUSTED_PROXIES; restart the backend after changing configuration. The public port remains code-only.") from exc
        raise
    if (health.get("pipeline") != "pdms-import-pipeline/1"
            or Path(health.get("root", "")).resolve() != root
            or health.get("publicPort") != public_port):
        raise ValueError("Port belongs to a different workspace or an old backend; restart this workspace with start-lan.bat")
    public = get(public_port, "/api/access/status")
    if (public.get("publicEntry") is not True or public.get("role") != "ANONYMOUS"
            or not health.get("instanceId") or public.get("instanceId") != health["instanceId"]):
        raise ValueError("Public listener is not the same protected backend; sharing refused")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-port", type=int, default=8765)
    parser.add_argument("--public-port", type=int, default=8766)
    args = parser.parse_args()
    try:
        verify(args.local_port, args.public_port)
    except Exception as exc:
        print(f"[ERROR] Sharing refused: {exc}")
        raise SystemExit(1)
    print("Protected public listener verified; local/LAN management remains separate.")
