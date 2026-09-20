"""本地静态服务器 —— 只监听 127.0.0.1，不对外暴露，不上传任何数据。

为什么需要它： viewer 用 ES module + fetch 加载 GLB，浏览器在 file:// 下会拦截。
所以必须走 http://127.0.0.1:<port>。

用法：
    python tools/serve.py [--port 8765] [--no-browser]
"""
from __future__ import annotations

import argparse
import functools
import http.server
import mimetypes
import socket
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args) :
            sys.stderr.write("  404: %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(preferred: int) -> int:
    for p in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("找不到可用端口（%d 起试 20 个）" % preferred)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    port = pick_port(a.port)
    url = f"http://127.0.0.1:{port}/viewer/index.html"

    missing = []
    if not (ROOT / "data" / "processed" / "model.glb").exists():
        missing.append("data/processed/model.glb")
    if not (ROOT / "viewer" / "vendor" / "three.module.js").exists():
        missing.append("viewer/vendor/three.module.js")

    print("=" * 68)
    print("  PDMS RVM Viewer — 本地运行")
    print("=" * 68)
    print(f"  根目录 : {ROOT}")
    print(f"  地址   : {url}")
    print("  仅监听 127.0.0.1，模型数据不出本机")
    if missing:
        print()
        for m in missing:
            print(f"  [缺] {m}")
        print("  → 请先运行 converter/rvm_to_glb.py 生成产物")
    print()
    print("  按 Ctrl+C 停止服务")
    print("=" * 68)

    handler = functools.partial(Handler, directory=str(ROOT))
    with Server(("127.0.0.1", port), handler) as httpd:
        if not a.no_browser:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
