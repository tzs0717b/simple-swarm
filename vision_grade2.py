#!/usr/bin/env python3
"""二元问题版视觉判官 + 像素硬校验（先证明图上有东西，再问它）。
2026-09-18 教训：11B 判官看一张 93 字节的空 SVG 也能说出"侧视、有鸟骑在车上、5 分"，
所以必须先过像素门槛，再问一堆"是/否/看不清"的二元问题，绝不让它打总分。"""
import base64, io, json, os, subprocess, sys, urllib.request
from PIL import Image
BASE = os.environ.get("LLM_BASE_URL") or "http://127.0.0.1:3131/v1"
TOK = os.environ.get("LLM_API_KEY") or os.environ.get("KEYPOOL_PROXY_TOKEN", "")
JUDGES = ["meta/llama-3.2-11b-vision-instruct", "doubao-seed-1-6-flash-250615"]
Q = ("严格只看这张图，逐条回答，每行只写一个词（是/否/看不清），不要解释："
     "1) 画面是否几乎空白？ 2) 图中有自行车吗？ 3) 图中有鸟吗？ "
     "4) 如果有鸟：喙是指向画面一侧（侧视）还是朝向镜头（正脸）？ "
     "5) 鸟是否坐在自行车车座上方？")

def render(svg, png):
    for n in ("chromium-browser", "chromium", "google-chrome"):
        try:
            subprocess.run([n, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=800,600", "--force-device-scale-factor=1", "--virtual-time-budget=1200",
                            "--default-background-color=FFFFFFFF", "--screenshot=" + png, "file://" + os.path.abspath(svg)],
                           capture_output=True, timeout=90)
            if os.path.exists(png) and os.path.getsize(png) > 0:
                return True
        except Exception:
            continue
    return False

def stats(png):
    im = Image.open(png).convert("RGB"); px = im.load(); w, h = im.size
    pts = [(x, y) for y in range(0, h, 4) for x in range(0, w, 4)]
    nw = sum(1 for x, y in pts if px[x, y] != (255, 255, 255))
    cols = len(set(px[x, y] for x, y in pts))
    return nw, len(pts), cols

def b64(png, w=400):
    im = Image.open(png).convert("RGB"); im.thumbnail((w, w))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=75)
    return base64.b64encode(buf.getvalue()).decode()

def ask(model, b):
    body = {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": [
        {"type": "text", "text": Q},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b}}]}]}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                headers={"authorization": "Bearer " + TOK, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()

for svg in sys.argv[1:]:
    png = "/data/data/com.termux/files/home/code/.shots/vg2_" + os.path.basename(svg) + ".png"
    print("  === " + os.path.basename(svg) + " ===")
    if not render(svg, png):
        print("     渲染失败"); continue
    nw, tot, cols = stats(png)
    pct = 100.0 * nw / tot
    print("     像素硬校验: 非白 %.1f%%（%d/%d），颜色 %d 种 -> %s" %
          (pct, nw, tot, cols, "几乎空白，判官不用问了" if pct < 1.5 else "有内容，往下问"))
    if pct < 1.5:
        continue
    b = b64(png)
    for m in JUDGES:
        try:
            out = ask(m, b)
            print("     [%s]" % m.split("/")[-1][:22])
            for line in out.splitlines()[:6]:
                if line.strip(): print("        " + line.strip()[:110])
        except Exception as ex:
            print("     [%s] 调用失败: %s" % (m[:22], str(ex)[:90]))
