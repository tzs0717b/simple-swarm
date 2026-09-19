#!/usr/bin/env python3
"""开放式观感判官（不再用"有没有 X"这种诱导提问）。
用法: python3 vision_grade3.py 文件.svg [更多.svg]
先做像素闸（非白太少就跳过判官），再让两个模型自由描述，最后打印原文由人判断。"""
import base64, io, json, os, subprocess, sys, urllib.request
from PIL import Image

BASE = os.environ.get("LLM_BASE_URL") or "http://127.0.0.1:3131/v1"
TOK = os.environ.get("LLM_API_KEY") or os.environ.get("KEYPOOL_PROXY_TOKEN", "")
JUDGES = ["meta/llama-3.2-11b-vision-instruct", "doubao-seed-1-6-flash-250615"]
PROMPT = ("这是从一段 SVG 动画里截取的一帧（白底）。请只描述你实际看到的东西，不要推测、不要脑补。"
          "从左到右依次列出画面里的主要物体，每个物体用一句话说清：它是什么、什么形状、什么姿态、什么颜色。"
          "如果画面基本是空白、或者只有零散的线条，就直接回答：几乎空白。")

def render(svg, png, ms, w=900, h=700):
    for n in ("chromium-browser", "chromium"):
        try:
            subprocess.run([n, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=" + str(w) + "," + str(h), "--force-device-scale-factor=1",
                            "--virtual-time-budget=" + str(ms), "--default-background-color=FFFFFFFF",
                            "--screenshot=" + png, "file://" + os.path.abspath(svg)],
                           capture_output=True, timeout=120)
            if os.path.exists(png) and os.path.getsize(png) > 0:
                return True
        except Exception:
            continue
    return False

def jpeg_b64(png):
    im = Image.open(png).convert("RGB")
    im.thumbnail((640, 640))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()

def nonwhite(png, step=4):
    im = Image.open(png).convert("RGB"); p = im.load(); w, h = im.size
    n = t = 0
    for y in range(0, h, step):
        for x in range(0, w, step):
            t += 1
            if p[x, y] != (255, 255, 255): n += 1
    return 100.0 * n / max(1, t)

def ask(model, b):
    body = {"model": model, "max_tokens": 300, "messages": [{"role": "user", "content": [
        {"type": "text", "text": PROMPT},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b}}]}]}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + TOK})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    return (d.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()

for svg in sys.argv[1:]:
    name = os.path.basename(svg)
    png = "/data/data/com.termux/files/home/code/.shots/vg_" + name + ".png"
    if not render(svg, png, 900):
        print("  %s : 渲不出来" % name); continue
    nw = nonwhite(png)
    if nw < 1.5:
        print("  %-24s 非白 %.1f%% → 像素闸挡下，不叫判官（基本空白）" % (name, nw)); continue
    b = jpeg_b64(png)
    print("  %-24s 非白 %.1f%% → 叫两个判官自由描述：" % (name, nw))
    for m in JUDGES:
        try:
            print("    [%s] %s" % (m.split("/")[-1][:22], ask(m, b)[:400]))
        except Exception as e:
            print("    [%s] 失败：%s" % (m.split("/")[-1][:22], str(e)[:80]))
