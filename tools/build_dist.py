#!/usr/bin/env python3
"""把 web/editor、web/runner 各自打包成单文件 HTML，并生成一个导航首页。

产物（dist/）：
  index.html   入口：选择编辑器或跑酷
  editor.html  可视化编辑器（单文件，可离线 / 可嵌入 APK）
  runner.html  3D 跑酷游戏（单文件）

用法：python3 tools/build_dist.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
# 与 engine/skeleton.js 的 MAX_BONES 保持一致
MAX_BONES = 32
ESBUILD = os.environ.get("ESBUILD_BIN", "/tmp/z3dbuild/node_modules/.bin/esbuild")

PAGES = [
    {
        "name": "editor",
        "entry": os.path.join(ROOT, "web", "editor", "app.js"),
        "html": os.path.join(ROOT, "web", "editor", "index.html"),
        "css": os.path.join(ROOT, "web", "editor", "style.css"),
        "js": "app.js",
    },
    {
        "name": "runner",
        "entry": os.path.join(ROOT, "web", "runner", "game.js"),
        "html": os.path.join(ROOT, "web", "runner", "index.html"),
        "css": os.path.join(ROOT, "web", "runner", "style.css"),
        "js": "game.js",
    },
]

INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#14161a">
<title>Zorr3D</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(circle at 50% 0%, #1e2637, #10131a 62%);
    color: #d8dde6;
    font: 15px/1.5 -apple-system, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 28px;
  }
  .wrap { width: min(720px, 100%); }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: .5px; }
  h1 span { color: #4c9aff; }
  .sub { color: #8a93a3; margin: 0 0 28px; font-size: 14px; }
  .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  a.card {
    display: block; padding: 20px; border-radius: 14px;
    background: #1c1f25; border: 1px solid #2e333d;
    color: inherit; text-decoration: none; transition: border-color .15s, transform .15s;
  }
  a.card:hover { border-color: #4c9aff; transform: translateY(-2px); }
  .card h2 { margin: 0 0 6px; font-size: 17px; }
  .card p { margin: 0; color: #8a93a3; font-size: 13px; line-height: 1.55; }
  .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
         background: #23272f; color: #8a93a3; margin-bottom: 10px; }
  footer { margin-top: 26px; color: #5d6675; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Zorr<span>3D</span></h1>
  <p class="sub">自研 WebGL2 轻量 3D 引擎 · 编辑器与游戏共用同一渲染核心</p>
  <div class="cards">
    <a class="card" href="editor.html">
      <span class="tag">工具</span>
      <h2>3D 编辑器</h2>
      <p>层级、变换 Gizmo、PBR 材质、阴影与泛光、glTF/OBJ 导入、场景存档。</p>
    </a>
    <a class="card" href="runner.html">
      <span class="tag">游戏</span>
      <h2>金币之路</h2>
      <p>3D 跑酷：三车道换道跳跃，收集全部金币才会开启终点门。</p>
    </a>
  </div>
  <footer>纯静态产物，无外部依赖，可离线运行。</footer>
</div>
</body>
</html>
"""


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


SHADER_HEAD_RE = re.compile(r"`(#version 300 es[^`]{0,400})")


def verify_page(out):
    r"""守卫：着色器源码必须保持纯 ASCII，且以 #version 开头。

    压缩器会把非 ASCII 转成 \uXXXX 转义，驱动会因此拒绝编译。
    """
    text = open(out, encoding="utf-8").read()
    m = SHADER_HEAD_RE.search(text)
    if not m:
        sys.exit("%s: 未找到着色器源码" % out)
    head = m.group(1)
    if "\\u" in head:
        sys.exit("%s: 着色器源码含 \\u 转义，会破坏编译" % out)
    if any(ord(ch) > 127 for ch in head):
        sys.exit("%s: 着色器源码含非 ASCII 字符" % out)
    if "sampler2DShadow" in text and "precision highp sampler2DShadow" not in text:
        sys.exit("%s: 使用 sampler2DShadow 但缺少精度声明" % out)
    # 模板字符串没被求值会原样留下 ${...}，着色器直接编译失败、整个场景变黑
    if "${MAX_BONES}" in text:
        sys.exit("%s: 着色器里残留未求值的模板占位符 ${MAX_BONES}" % out)
    if "#define MAX_BONES" not in text:
        sys.exit("%s: 着色器缺少 MAX_BONES 宏" % out)
    if not head.startswith("#version 300 es"):
        sys.exit("%s: 着色器未以 #version 开头" % out)
    verify_shaders_compile(text, out)


def verify_shaders_compile(text, out):
    """用引擎源码里的着色器做严格编译校验（与运行时同一份源码）。"""
    validator = shutil.which("glslangValidator")
    if not validator:
        print("  （未安装 glslangValidator，跳过着色器编译校验）")
        return

    if "MAX_BONES" not in text:
        sys.exit("%s: 产物里找不到骨骼数组相关代码" % out)

    script = os.path.join(ROOT, "tools", "dump_shaders.mjs")
    tmp = tempfile.mkdtemp()
    try:
        res = subprocess.run(
            ["node", script, tmp],
            capture_output=True, text=True, cwd=ROOT,
        )
        if res.returncode != 0:
            sys.exit("%s: 导出着色器失败\n%s" % (out, (res.stderr or res.stdout)[:600]))
        files = sorted(os.listdir(tmp))
        if not files:
            sys.exit("%s: 没有导出任何着色器" % out)
        for name in files:
            r = subprocess.run([validator, os.path.join(tmp, name)], capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit("%s: 着色器 %s 编译失败\n%s" % (out, name, (r.stdout or "")[:600]))
        print("  着色器编译校验通过（%d 个）" % len(files))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_page(page):
    bundle = os.path.join(DIST, page["name"] + ".bundle.js")
    run([
        ESBUILD,
        page["entry"],
        "--bundle",
        "--format=iife",
        "--minify",
        "--target=es2017",
        "--outfile=" + bundle,
        "--log-level=warning",
    ])
    html = open(page["html"], encoding="utf-8").read()
    css = open(page["css"], encoding="utf-8").read()
    js = open(bundle, encoding="utf-8").read()

    html = re.sub(r'<link rel="stylesheet" href="[^"]+">', "<style>\n" + css + "\n</style>", html)
    html = re.sub(
        r'<script src="[^"]+"[^>]*></script>',
        lambda m: "<script>\n" + js + "\n</script>",
        html,
    )
    out = os.path.join(DIST, page["name"] + ".html")
    open(out, "w", encoding="utf-8").write(html)
    os.remove(bundle)
    verify_page(out)
    print("  产物 %s（%.1f KB）" % (os.path.relpath(out, ROOT), os.path.getsize(out) / 1024))
    return out


def main():
    if not os.path.exists(ESBUILD):
        sys.exit("找不到 esbuild：%s\n先执行 npm install --prefix /tmp/z3dbuild esbuild" % ESBUILD)

    os.makedirs(DIST, exist_ok=True)
    built = {}
    for page in PAGES:
        built[page["name"]] = build_page(page)

    open(os.path.join(DIST, "index.html"), "w", encoding="utf-8").write(INDEX_HTML)
    print("  产物 dist/index.html")

    # 供安卓 APK 使用：跑酷作为主入口，编辑器一并带上
    assets = os.path.join(ROOT, "app", "src", "main", "assets")
    os.makedirs(assets, exist_ok=True)
    for name in ("index", "editor", "runner"):
        shutil.copyfile(os.path.join(DIST, name + ".html"), os.path.join(assets, name + ".html"))
    print("  已同步到 app/src/main/assets/")


if __name__ == "__main__":
    main()
