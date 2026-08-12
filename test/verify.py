#!/usr/bin/env python3
"""Deterministic verification of kindleocr + overlay alignment.

  1. SELECTION  — two same-bundle same-size windows; assert capture follows
                  the frontmost as z-order flips (the multi-Chrome-window bug).
  2. ALIGNMENT  — real kakuyomu.jp page; ground truth from live DOM rects;
                  assert OCR glyph boxes match across the whole viewport.
  3. SCROLL     — scroll the page, re-extract DOM truth, re-assert.
  4. E2E        — run the actual overlay pinned to the kakuyomu window and
                  assert its rendered layer position (layer@ log) against an
                  independent OCR pass.
"""
import json, os, pathlib, re, shutil, signal, subprocess, sys, time, urllib.request

# Derived, not written down: a literal path only describes one checkout.
REPO = pathlib.Path(__file__).resolve().parent.parent
OCR = str(REPO / "kindleocr")
OVERLAY_DIR = str(REPO / "overlay")
ELECTRON = OVERLAY_DIR + "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG = "/tmp/yomi-overlay.log"

def ctrl(path):
    return urllib.request.urlopen("http://127.0.0.1:43199" + path, timeout=10).read()

def ocr_shot(args):
    p = subprocess.run([OCR, "--json"] + args, capture_output=True, text=True, timeout=60)
    for line in p.stdout.splitlines():
        if line.strip():
            return json.loads(line)
    raise SystemExit(f"no OCR payload ({args}); stderr: {p.stderr[:300]}")

# "frame" is the coordinate origin glyph boxes are relative to (the captured
# display); "window" is the target window's own — possibly stale — rect, which
# is why it is no longer used for positioning.
def target_rect(payload):
    return payload.get("window") or payload["frame"]

def window_ids():
    out = subprocess.run([OCR, "--list-all"], capture_output=True, text=True, timeout=30).stdout
    b = json.loads(ctrl("/bounds"))
    ids = {}
    for w in json.loads(out):
        if w["bundle"] != "com.github.Electron":
            continue
        for k in ("a", "b"):
            bb = b[k]
            if w["width"] == bb["width"] and w["height"] == bb["height"]:
                # same size: disambiguate later by captured frame origin
                ids.setdefault("candidates", []).append(w["id"])
    return b, ids.get("candidates", [])

# ---------------------------------------------------------------- selection --
def test_selection(bounds):
    print("== 1. SELECTION (frontmost same-bundle window wins) ==")
    fails = 0
    for front, want in (("a", bounds["a"]), ("b", bounds["b"]), ("a", bounds["a"])):
        ctrl("/front/" + front)
        time.sleep(0.8)
        f = target_rect(ocr_shot(["--bundle", "com.github.Electron"]))
        good = abs(f["x"] - want["x"]) <= 2 and abs(f["y"] - want["y"]) <= 2
        print(f"  front={front}: captured frame {f['x']},{f['y']} want {want['x']},{want['y']} "
              + ("ok" if good else "WRONG WINDOW"))
        fails += not good
    return fails

# ---------------------------------------------------------------- alignment --
def norm(s):
    return re.sub(r"\s+", "", s)

def test_alignment(bounds, label, scroll=None):
    print(f"== {label} (real kakuyomu DOM vs OCR boxes) ==")
    if scroll is not None:
        ctrl(f"/scroll/{scroll}")
        time.sleep(1.2)
    probes = json.loads(ctrl("/dom"))
    # A probe whose text recurs on the page cannot be asserted against a single
    # position: if Vision misses one instance the matcher silently latches onto
    # another and reports a phantom misalignment. Keep unique-text probes only.
    def needle(p):
        t = norm(p["text"])
        return t[:6] if len(t) >= 6 else t
    counts = {}
    for p in probes:
        for q in probes:
            if needle(p) in norm(q["text"]):
                counts[needle(p)] = counts.get(needle(p), 0) + 1
    probes = [p for p in probes if counts.get(needle(p), 0) <= 1]
    ctrl("/front/a"); time.sleep(0.5)
    payload = ocr_shot(["--bundle", "com.github.Electron"])
    f = payload["frame"]                      # coordinate origin (display)
    tr = target_rect(payload)                 # which window was captured
    if abs(tr["x"] - bounds["a"]["x"]) > 2:
        print(f"  captured wrong window ({tr['x']},{tr['y']}) — selection broken"); return 1
    # DOM truth is window-relative; glyph boxes are region-relative. Compare in
    # absolute screen coordinates, which is what the overlay actually renders.
    org = json.loads(ctrl("/contentorigin"))

    lines = payload["lines"]
    matched = aligned = gross = 0
    worst = (0, "")
    for p in probes:
        pt = norm(p["text"])
        if len(pt) < 3:
            continue
        # Same text can occur many times on the page (nav items, genre tags on
        # every card). Alignment is asserted against the CLOSEST occurrence —
        # a systematic layer shift still fails, duplicates don't.
        hit = None
        best = 1e9
        needle = pt[:6] if len(pt) >= 6 else pt
        for ln in lines:
            lt = norm(ln["text"])
            i = lt.find(needle)
            if i >= 0 and i < len(ln["chars"]):
                c = ln["chars"][i]
                d = (abs((f["x"] + c["x"]) - (org["sx"] + p["x"]))
                     + abs((f["y"] + c["y"]) - (org["sy"] + p["y"])))
                if d < best:
                    best, hit = d, c
        if not hit:
            continue
        matched += 1
        # DOM rect top is the line box; the glyph box sits inside it. Allow the
        # half-leading plus OCR jitter.
        tol_y = max(10, p["h"] * 0.45)
        # absolute screen position: region origin + glyph  vs  content origin + DOM
        dx = (f["x"] + hit["x"]) - (org["sx"] + p["x"])
        dy = (f["y"] + hit["y"]) - (org["sy"] + p["y"])
        if abs(dx) <= 12 and abs(dy) <= tol_y:
            aligned += 1
        elif abs(dx) > 30 or abs(dy) > 30:
            gross += 1
            if max(abs(dx), abs(dy)) > worst[0]:
                worst = (max(abs(dx), abs(dy)), f"'{p['text']}' d=({dx:+},{dy:+})")
    rate = aligned / matched if matched else 0
    print(f"  probes={len(probes)} matched={matched} aligned={aligned} "
          f"({rate:.0%}) gross(>30px)={gross}" + (f" worst: {worst[1]}" if gross else ""))
    ok = matched >= 8 and rate >= 0.7 and gross == 0
    print("  " + ("PASS" if ok else "FAIL"))
    return (0 if ok else 1)

# ---------------------------------------------------------------------- e2e --
def test_e2e(bounds, win_id):
    print("== 4. E2E (overlay layer position vs independent OCR) ==")
    cfg_path = OVERLAY_DIR + "/config.json"
    backup = cfg_path + ".test-backup"
    shutil.copy(cfg_path, backup)
    cfg = json.load(open(cfg_path))
    cfg["target"] = {"bundle": "com.github.Electron", "windowId": win_id,
                     "label": "oa-test"}
    json.dump(cfg, open(cfg_path, "w"))
    open(LOG, "w").close()

    # Reference OCR BEFORE the overlay runs: its watch loop captures the same
    # window and the concurrent SCK sessions can stall a one-shot.
    ref = ocr_shot(["--window", str(win_id)])

    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    proc = subprocess.Popen([ELECTRON, OVERLAY_DIR], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 1
    try:
        time.sleep(8)
        log = open(LOG).read()
        m = None
        for m in re.finditer(r"layer@ (-?\d+),(-?\d+) '(.)'", log):
            pass
        if not m:
            print("  no layer@ line in overlay log — overlay never built a layer")
        else:
            lx, ly, ch = int(m.group(1)), int(m.group(2)), m.group(3)
            want = None
            for ln in ref["lines"]:
                if ln["chars"] and ln["chars"][0]["c"] == ch:
                    c = ln["chars"][0]
                    want = (ref["frame"]["x"] + c["x"], ref["frame"]["y"] + c["y"])
                    break
            if not want:
                print(f"  reference pass lacks a line starting with '{ch}' — inconclusive")
            else:
                dx, dy = lx - want[0], ly - want[1]
                good = abs(dx) <= 12 and abs(dy) <= 12
                print(f"  overlay layer '{ch}' at {lx},{ly}; independent OCR says "
                      f"{want[0]},{want[1]} d=({dx:+},{dy:+}) " + ("PASS" if good else "FAIL"))
                fails = 0 if good else 1
    finally:
        proc.send_signal(signal.SIGTERM)
        time.sleep(2)
        subprocess.run(["pkill", "-f", "kindleocr"], capture_output=True)
        shutil.move(backup, cfg_path)
    return fails

def main():
    bounds = json.loads(ctrl("/bounds"))
    b, cands = window_ids()
    # Identify window A's id by capturing it while frontmost.
    ctrl("/front/a"); time.sleep(0.8)
    a_id = None
    for cid in cands:
        f = ocr_shot(["--window", str(cid)])["frame"]
        if abs(f["x"] - bounds["a"]["x"]) <= 2 and abs(f["y"] - bounds["a"]["y"]) <= 2:
            a_id = cid
            break
    print(f"windows: candidates={cands} A id={a_id} bounds={bounds['a']}")

    total = 0
    total += test_selection(bounds)
    total += test_alignment(bounds, "2. ALIGNMENT top of page")
    total += test_alignment(bounds, "3. ALIGNMENT after scroll 900px", scroll=900)
    if a_id:
        ctrl("/scroll/0"); time.sleep(1.0)
        total += test_e2e(bounds, a_id)
    else:
        print("== 4. E2E skipped: could not pin window A id ==")
        total += 1
    print(f"\nTOTAL FAILURES: {total}")
    sys.exit(1 if total else 0)

if __name__ == "__main__":
    main()
