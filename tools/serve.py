#!/usr/bin/env python3
"""容器内运行 Zorr3D 编辑器。

默认：http://127.0.0.1:8770  静态服务 web/ 与 engine/
保存：POST /api/save 写入 scenes/scene.json（浏览器「保存」按钮优先走这里）

用法：
  python3 tools/serve.py            # 仅本机
  python3 tools/serve.py --host 0.0.0.0 --port 8770
"""

import argparse
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE_PATH = os.path.join(ROOT, "scenes", "scene.json")
MAX_BODY = 32 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_POST(self):
        if self.path.rstrip("/") != "/api/save":
            self.send_error(404, "not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self.send_error(413, "bad size")
            return
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            self.send_error(400, "invalid json: %s" % exc)
            return
        os.makedirs(os.path.dirname(SCENE_PATH), exist_ok=True)
        tmp = SCENE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, SCENE_PATH)
        body = json.dumps({"path": os.path.relpath(SCENE_PATH, ROOT), "bytes": len(raw)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 开发期避免缓存，改完刷新即生效
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()

    os.chdir(ROOT)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Zorr3D 编辑器: http://%s:%d/web/" % (args.host, args.port))
    print("场景保存到: %s" % os.path.relpath(SCENE_PATH, ROOT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
