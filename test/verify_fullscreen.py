#!/usr/bin/env python3
"""Does kindleocr report a truthful frame for a FULLSCREEN window?

Fullscreen is the case the windowed test never exercised, and it is also the
game case: a fullscreen window lives on its own Space, and the capture falls
back to display-scoped filters. If the reported frame disagrees with where the
window really is, every glyph is displaced by that difference.

Ground truth: the window's own view of itself (window.screenX/screenY of its
web contents) plus its Electron bounds.
"""
import json, pathlib, subprocess, sys, time, urllib.request

# Derived, not written down: a literal path only describes one checkout.
REPO = pathlib.Path(__file__).resolve().parent.parent
OCR = str(REPO / "kindleocr")

def ctrl(path, timeout=20):
    return urllib.request.urlopen("http://127.0.0.1:43199" + path, timeout=timeout).read()

def ocr_frame(args, tries=3):
    for _ in range(tries):
        p = subprocess.run([OCR, "--json"] + args, capture_output=True, text=True, timeout=60)
        for line in p.stdout.splitlines():
            if line.strip():
                return json.loads(line)
        time.sleep(1)
    return None

def probe(label):
    bounds = json.loads(ctrl("/bounds"))["a"]
    origin = json.loads(ctrl("/contentorigin"))
    payload = ocr_frame(["--bundle", "com.github.Electron"])
    print(f"\n-- {label} --")
    print(f"  electron getBounds : {bounds['x']},{bounds['y']} {bounds['width']}x{bounds['height']}")
    print(f"  contents screenX/Y : {origin['sx']},{origin['sy']} {origin['iw']}x{origin['ih']}")
    if not payload:
        print("  kindleocr          : NO PAYLOAD (window not capturable)")
        return 1
    f = payload["frame"]
    w = payload.get("window", {})
    print(f"  coord origin       : {f['x']},{f['y']} {f['width']}x{f['height']} (captured region)")
    if w:
        print(f"  window self-report : {w['x']},{w['y']} {w['width']}x{w['height']}"
              + ("  <- STALE, correctly not used for positioning"
                 if abs(w.get('height', 0) - bounds['height']) > 2 else ""))

    fails = 0

    # Glyph check: content origin relative to the reported frame must place
    # DOM-known text at its true screen position.
    probes = json.loads(ctrl("/dom"))
    checked = aligned = 0
    for p in probes[:40]:
        t = p["text"].replace(" ", "")
        if len(t) < 4:
            continue
        hit = None
        for ln in payload["lines"]:
            i = ln["text"].replace(" ", "").find(t[:6])
            if i >= 0 and i < len(ln["chars"]):
                hit = ln["chars"][i]
                break
        if not hit:
            continue
        checked += 1
        # true screen pos of the DOM text  vs  frame + window-local glyph pos
        true_x, true_y = origin["sx"] + p["x"], origin["sy"] + p["y"]
        got_x, got_y = f["x"] + hit["x"], f["y"] + hit["y"]
        if abs(got_x - true_x) <= 12 and abs(got_y - true_y) <= max(10, p["h"] * 0.45):
            aligned += 1
        elif checked <= 3:
            print(f"    '{p['text'][:14]}' true=({true_x},{true_y}) got=({got_x},{got_y}) "
                  f"d=({got_x-true_x:+},{got_y-true_y:+})")
    # Zero matched probes is not a pass: it means the wrong window was captured
    # or nothing was recognised, and silently reporting PASS for that hid a
    # stale probe window standing in for the real target.
    if checked < 5:
        print(f"  glyph screen pos   : only {checked} probes matched — INCONCLUSIVE, treated as failure")
        fails += 1
    else:
        rate = aligned / checked
        print(f"  glyph screen pos   : {aligned}/{checked} correct ({rate:.0%})")
        if rate < 0.7:
            fails += 1
    print("  " + ("PASS" if not fails else "FAIL"))
    return fails

def main():
    total = 0
    ctrl("/front/a"); time.sleep(0.6)
    total += probe("WINDOWED")

    ctrl("/fullscreen", timeout=30); time.sleep(6)
    total += probe("FULLSCREEN (also the game case)")

    ctrl("/windowed", timeout=30); time.sleep(6)   # Space slide animates; capturing mid-slide reads a transient x
    total += probe("BACK TO WINDOWED")

    print(f"\nTOTAL FAILURES: {total}")
    sys.exit(1 if total else 0)

if __name__ == "__main__":
    main()
