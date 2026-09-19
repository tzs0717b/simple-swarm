#!/usr/bin/env python3
"""任务无关的 SVG 动画判分器：不认鹈鹕、不认北极熊，只认"这是不是一个真在动的动画"。
用法: python3 anim_grade.py a.svg [b.svg ...]"""
import os, re, subprocess, sys
import xml.etree.ElementTree as ET
from PIL import Image

def render(svg, png, ms):
    for n in ("chromium-browser", "chromium"):
        try:
            subprocess.run([n, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=900,700", "--force-device-scale-factor=1",
                            "--virtual-time-budget=" + str(ms), "--default-background-color=FFFFFFFF",
                            "--screenshot=" + png, "file://" + os.path.abspath(svg)],
                           capture_output=True, timeout=120)
            if os.path.exists(png) and os.path.getsize(png) > 0:
                return True
        except Exception:
            continue
    return False

def pixels(png, step=4):
    im = Image.open(png).convert("RGB"); p = im.load(); w, h = im.size
    out = []
    for y in range(0, h, step):
        for x in range(0, w, step):
            out.append(p[x, y])
    return out

def broken_loops(raw):
    bad = []
    for m in re.finditer(r"<animateTransform[^>]*>", raw):
        t = m.group(0)
        if 'type="rotate"' not in t:
            continue
        fm = re.search(r'from="([^"]+)"', t)
        tm = re.search(r'to="([^"]+)"', t)
        if fm and tm:
            try:
                a = float(fm.group(1).split()[0]); b = float(tm.group(1).split()[0])
                d = (b - a) % 360.0
                if d > 0.01 and abs(d - 360.0) > 0.01:
                    bad.append((round(a), round(b)))
            except Exception:
                pass
    return bad

for svg in sys.argv[1:]:
    raw = open(svg, encoding="utf-8", errors="ignore").read()
    name = os.path.basename(svg)
    vb = (re.search(r'viewBox="([^"]*)"', raw) or [None, "无"])[1]
    anim = len(re.findall(r"<animate", raw))
    try:
        ET.fromstring(raw); xml_ok = "合法"
    except Exception as e:
        xml_ok = "不合法:" + str(e).split(":")[0][:22]
    bad = broken_loops(raw)
    p1 = "/data/data/com.termux/files/home/code/.shots/ag_" + name + ".t1.png"
    p2 = "/data/data/com.termux/files/home/code/.shots/ag_" + name + ".t2.png"
    ok1 = render(svg, p1, 700)
    ok2 = render(svg, p2, 1500)
    motion = "?"
    nonwhite = -1
    if ok1 and ok2:
        a = pixels(p1); b = pixels(p2)
        diff = sum(1 for i in range(min(len(a), len(b))) if a[i] != b[i])
        motion = "%.1f%%" % (100.0 * diff / max(1, len(a)))
        nonwhite = sum(1 for c in a if c != (255, 255, 255))
    print("  %-32s vb=%-13s animate=%-3d xml=%-24s 循环=%-8s 非白=%-6d 两相位差异=%s" %
          (name, str(vb)[:13], anim, xml_ok, ("OK" if not bad else ("断" + str(bad[:2]))), nonwhite, motion))
