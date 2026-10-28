#!/bin/sh
# 容器内启动：同时提供编辑器与跑酷
# 用法：sh start.sh [端口]
set -e
cd "$(dirname "$0")"
PORT=${1:-8770}
echo "Zorr3D 已启动"
echo "  导航页  http://127.0.0.1:$PORT/dist/index.html"
echo "  编辑器  http://127.0.0.1:$PORT/dist/editor.html"
echo "  跑酷    http://127.0.0.1:$PORT/dist/runner.html"
echo "  开发态  http://127.0.0.1:$PORT/web/editor/"
echo "按 Ctrl+C 停止"
exec python3 tools/serve.py --host 0.0.0.0 --port "$PORT"
