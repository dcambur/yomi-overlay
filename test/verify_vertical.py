#!/usr/bin/env python3
"""Tategaki (vertical Japanese) recognition and alignment.

Ground truth is per-CHARACTER: a Range over each text node gives the exact rect
of every glyph on the page, which is the only usable anchor in vertical text —
a vertical paragraph is one tall column spanning many lines, so its element rect
locates nothing.

Reports, for whatever the pipeline currently does:
  coverage  — share of on-page characters recognised anywhere
  placement — share of recognised characters whose box lands on the real glyph
  order     — whether reading order is column-wise right-to-left
"""
import json, pathlib, subprocess, sys, time, urllib.request

# Derived, not written down: a literal path only describes one checkout.
REPO = pathlib.Path(__file__).resolve().parent.parent
# Where kindleocr lives is not this suite's business — ask the one file
# that knows the layout. Keeps the suites working across a move.
sys.path.insert(0, str(REPO / "tools"))
from paths import OCR_BIN
OCR = str(OCR_BIN)

def ctrl(path, timeout=30):
    return urllib.request.urlopen("http://127.0.0.1:43199" + path, timeout=timeout).read()

def ocr_shot(extra=()):
    p = subprocess.run([OCR, "--json", "--bundle", "com.github.Electron", *extra],
                       capture_output=True, text=True, timeout=90)
    for line in p.stdout.splitlines():
        if line.strip():
            return json.loads(line)
    print("   (no payload) " + p.stderr.strip()[:160])
    return None

def measure(label, extra=()):
    truth = json.loads(ctrl("/domchars"))
    org = json.loads(ctrl("/vertical/bounds"))
    payload = ocr_shot(extra)
    print(f"\n-- {label} --")
    if not payload:
        print("  FAIL: nothing captured")
        return None
    f = payload["frame"]

    # Flatten OCR glyphs to absolute screen coordinates.
    got = []
    for li, ln in enumerate(payload["lines"]):
        for ci, c in enumerate(ln["chars"]):
            got.append({"c": c["c"], "x": f["x"] + c["x"], "y": f["y"] + c["y"],
                        "w": c["w"], "h": c["h"], "li": li, "ci": ci})

    # Truth in absolute screen coordinates.
    want = [{"c": t["c"], "x": org["sx"] + t["x"], "y": org["sy"] + t["y"],
             "w": t["w"], "h": t["h"]} for t in truth]

    total_chars = sum(len(l["text"]) for l in payload["lines"])
    print(f"  page chars={len(want)}  recognised chars={total_chars} "
          f"lines={len(payload['lines'])}")

    # Coverage: each truth char matched to a recognised glyph of the same
    # character whose box overlaps its true position.
    placed = matched = 0
    for t in want:
        cands = [g for g in got if g["c"] == t["c"]]
        if not cands:
            continue
        matched += 1
        near = min(cands, key=lambda g: abs(g["x"] - t["x"]) + abs(g["y"] - t["y"]))
        tol = max(12, t["w"] * 0.7, t["h"] * 0.7)
        if abs(near["x"] - t["x"]) <= tol and abs(near["y"] - t["y"]) <= tol:
            placed += 1
    cov = matched / len(want) if want else 0
    plc = placed / len(want) if want else 0
    print(f"  coverage (char present)  : {matched}/{len(want)} ({cov:.0%})")
    print(f"  placement (box on glyph) : {placed}/{len(want)} ({plc:.0%})")

    # Reading order: in tategaki the first line should be the RIGHTMOST column
    # and characters within a line should descend.
    if payload["lines"]:
        firsts = [l["chars"][0] for l in payload["lines"] if l["chars"]]
        if len(firsts) >= 3:
            rtl = sum(1 for a, b in zip(firsts, firsts[1:]) if b["x"] < a["x"])
            downward = 0
            counted = 0
            for l in payload["lines"]:
                if len(l["chars"]) >= 3:
                    counted += 1
                    if l["chars"][-1]["y"] > l["chars"][0]["y"]:
                        downward += 1
            print(f"  columns right-to-left    : {rtl}/{len(firsts)-1}")
            print(f"  chars top-to-bottom      : {downward}/{counted}")
    sample = " ".join(l["text"][:12] for l in payload["lines"][:3])
    print(f"  sample: {sample[:90]}")
    return {"coverage": cov, "placement": plc, "lines": len(payload["lines"])}

def main():
    ctrl("/vertical", timeout=40)
    time.sleep(4.0)   # a freshly created panel takes a moment to be composited

    base = measure("BASELINE (horizontal assumption)")
    rot = measure("VERTICAL MODE (--vertical)", extra=("--vertical",))

    print("\n== summary ==")
    for name, r in (("baseline", base), ("--vertical", rot)):
        if r:
            print(f"  {name:12} coverage {r['coverage']:.0%}  placement {r['placement']:.0%}")
    try:
        ctrl("/vertical/close")
    except Exception:
        pass
    ok = rot and rot["placement"] >= 0.7
    print("\n" + ("PASS" if ok else "FAIL — vertical placement below 70%"))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
