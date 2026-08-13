#!/usr/bin/env python3
"""Cell-splitter benchmark — Phase 5.

Renders tategaki grid pages with EXACT known character positions across a
(font size x char pitch) matrix, runs `kindleocr --image --cells`, and scores
the detected cells against truth with no recognizer in the loop.

Metrics per page:
  recall    — truth chars whose center falls inside exactly one detected cell
  dup       — truth chars covered by 2+ cells (fragmentation)
  centerr   — median |cell center - truth char center| in px (matched only)
  cells/chars — detection count ratio (1.0 is perfect)

Usage: python3 cellbench.py [--keep]     (pages under /tmp/cellbench)
"""

import json
import statistics
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
# Where kindleocr lives is not this suite's business — ask the one file
# that knows the layout. Keeps the suites working across a move.
sys.path.insert(0, str(HERE.parent / "overlay"))
from paths import OCR_BIN as KINDLEOCR
OUT = Path("/tmp/cellbench")
MINCHO = "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc"

TEXT = ("ガストロ帝国。千年以上の歴史を持つ、大陸最古の成熟国家である。"
        "中でも、帝都の中心にそびえる天空宮殿は、壮麗かつ優美。"
        "豪奢の限りを尽くした皇居、上級貴族の邸宅が建ち並ぶ居住区。"
        "そんな華々しい舞台で、新任将官の任命式が執り行われた。")

MATRIX = [(30, 1.05), (30, 1.4), (24, 1.05), (24, 1.4), (20, 1.05),
          (18, 1.05), (18, 1.4), (14, 1.05), (14, 1.4)]


def render(size, pitch):
    """Returns (png path, truth centers [(x,y)] per char)."""
    font = ImageFont.truetype(MINCHO, size)
    margin = size
    height = 640
    per = int((height - 2 * margin) // (size * pitch))
    cols = [TEXT[i:i + per] for i in range(0, len(TEXT), per)]
    step_x = int(size * 1.8)
    W = 2 * margin + step_x * len(cols)
    img = Image.new("RGB", (W, height), "white")
    d = ImageDraw.Draw(img)
    truth = []
    for ci, col in enumerate(cols):
        x = W - margin - (ci + 1) * step_x
        for ri, ch in enumerate(col):
            y = margin + int(ri * size * pitch)
            d.text((x, y), ch, font=font, fill="black")
            truth.append((x + size / 2, y + size / 2))
    path = OUT / f"grid_{size}_{int(pitch*100)}.png"
    img.save(path)
    return path, truth


def score(path, truth):
    r = subprocess.run([str(KINDLEOCR), "--image", str(path), "--cells"],
                       capture_output=True, text=True, timeout=60)
    cols = json.loads(r.stdout)["columns"]
    cells = [c for col in cols for c in col]
    hits, dups, errs = 0, 0, []
    for tx, ty in truth:
        inside = [c for c in cells
                  if c["x"] <= tx <= c["x"] + c["w"]
                  and c["y"] <= ty <= c["y"] + c["h"]]
        if len(inside) == 1:
            hits += 1
            c = inside[0]
            errs.append(max(abs(c["x"] + c["w"] / 2 - tx),
                            abs(c["y"] + c["h"] / 2 - ty)))
        elif len(inside) > 1:
            dups += 1
    n = len(truth)
    return {"recall": hits / n, "dup": dups / n,
            "centerr": statistics.median(errs) if errs else -1,
            "ratio": len(cells) / n}


def main():
    OUT.mkdir(exist_ok=True)
    print(f"{'size':>4} {'pitch':>5} | {'recall':>6} {'dup':>5} "
          f"{'centerr':>7} {'cells/chars':>11}")
    worst = 1.0
    for size, pitch in MATRIX:
        path, truth = render(size, pitch)
        s = score(path, truth)
        worst = min(worst, s["recall"])
        print(f"{size:>4} {pitch:>5.2f} | {s['recall']:>6.2f} {s['dup']:>5.2f} "
              f"{s['centerr']:>7.1f} {s['ratio']:>11.2f}")
    print(f"\nworst recall: {worst:.2f}")


if __name__ == "__main__":
    main()
