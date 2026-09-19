#!/usr/bin/env python3
"""把渲染图交给视觉模型打分（操作者侧的"眼睛"，不给 swarm）。"""
import base64, io, json, os, subprocess, sys, urllib.request
from PIL import Image
BASE = os.environ.get("LLM_BASE_URL") or "http://127.0.0.1:3131/v1"
TOK = os.environ.get("LLM_API_KEY") or os.environ.get("KEYPOOL_PROXY_TOKEN", "")
MODEL = "meta/llama-3.2-11b-vision-instruct"
Q = "这是一张图片。请只回答三件事，各一行，不要客套：(1) 图里的鸟/物体是【侧视】还是【正脸】？(2) 有没有一只鸟骑在自行车上、位置合不合理？(3) 作为【鹈鹕骑自行车】的画面，0-10 分打几分？"

def render(svg, png, w=360):
    for n in ("chromium-browser", "chromium", "google-chrome"):
        try:
            subprocess.run([n, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=800,600", "--force-device-scale-factor=1", "--virtual-time-budget=1200",
                            "--default-background-color=FFFFFFFF", "--screenshot=" + png, "file://" + os.path.abspath(svg)],
                           capture_output=True, timeout=90)
            if os.path.exists(png) and os.path.getsize(png) > 0:
                im = Image.open(png).convert("RGB")
                im.thumbnail((w, w))
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=72)
                return base64.b64encode(buf.getvalue()).decode()
        except Exception:
            continue
    return None

def ask(b64):
    body = {"model": MODEL, "max_tokens": 220, "messages": [{"role": "user", "content": [
        {"type": "text", "text": Q},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                headers={"authorization": "Bearer " + TOK, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    return d["choices"][0]["message"]["content"]

for svg in sys.argv[1:]:
    png = "/data/data/com.termux/files/home/code/.shots/vg_" + os.path.basename(svg) + ".png"
    b = render(svg, png)
    print("  --- " + os.path.basename(svg) + " (%s) ---" % ("渲染 OK" if b else "渲染失败"))
    if not b:
        continue
    try:
        out = ask(b)
        for line in out.strip().splitlines()[:5]:
            print("     " + line[:150])
    except Exception as ex:
        print("     调用视觉模型失败: " + str(ex)[:130])
