#!/usr/bin/env python3
"""Cross-Space selection: does capture follow the window on the ACTIVE Space?

The observed failure: a browser fullscreen on Space 2 (what the user reads)
and another window of the same app on Space 1. Both show the same site, so
lookups appeared to work while every glyph was displaced by the difference
between the two windows' frames.

A window on an inactive Space is not composited, so the window server's
on-screen list is the authority. This asserts kindleocr agrees with it —
and never reports a frame that lies off every display.
"""
import json, pathlib, subprocess, sys, time, urllib.request

# Derived, not written down: a literal path only describes one checkout.
REPO = pathlib.Path(__file__).resolve().parent.parent
OCR = str(REPO / "kindleocr")

def ctrl(path, timeout=30):
    return urllib.request.urlopen("http://127.0.0.1:43199" + path, timeout=timeout).read()

def onscreen_ids():
    """Window ids the server composites on the active Space, front to back."""
    out = subprocess.run([OCR, "--list-all"], capture_output=True, text=True, timeout=30).stdout
    return {w["id"]: w for w in json.loads(out) if w["onScreen"]}

def chosen():
    p = subprocess.run([OCR, "--json", "--bundle", "com.github.Electron"],
                       capture_output=True, text=True, timeout=45)
    for line in p.stdout.splitlines():
        if line.strip():
            d = json.loads(line)
            # the captured window's own rect; "frame" is now the coordinate
            # origin (the display), which is deliberately not window-specific
            return d.get("window") or d["frame"]
    return None

def bounds(which):
    """Live bounds — must be re-read per case; park/unpark/fullscreen move them
    and macOS may clamp what was requested."""
    return json.loads(ctrl("/bounds"))[which]

def case(label, want=None):
    """Assert kindleocr agrees with the window server.

    The invariant, independent of which Space happens to be active: if the app
    has windows composited on the active Space, capture must target the
    frontmost of them, and never one that lies off every display. If it has
    none, capture must report nothing rather than silently adopting a window
    the user cannot see — that silent adoption was the alignment bug.
    """
    time.sleep(1.5)
    live = onscreen_ids()
    f = chosen()
    print(f"\n-- {label} --")
    mine = [(i, w["width"], w["height"]) for i, w in live.items()
            if w["bundle"] == "com.github.Electron"]
    print("  active-Space windows (this app): " + (str(mine) if mine else "none"))
    print(f"  kindleocr chose   : {f}")

    if not mine:
        ok = f is None
        print(f"  invariant         : nothing capturable -> {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1

    if f is None:
        print("  invariant         : should have captured a visible window -> FAIL")
        return 1
    # Off-display frames are never acceptable.
    if f["x"] + f["width"] <= 0 or f["y"] + f["height"] <= 0:
        print("  invariant         : frame lies off every display -> FAIL")
        return 1
    # Must match one of the app's active-Space windows by size...
    sizes = {(w, h) for _, w, h in mine}
    ok = (f["width"], f["height"]) in sizes
    # ...and the specific one we expect, when the caller knows which.
    if ok and want:
        ok = abs(f["x"] - want["x"]) <= 2 and abs(f["y"] - want["y"]) <= 2
        print(f"  expected          : {want['x']},{want['y']} "
              f"{want['width']}x{want['height']}")
    print(f"  invariant         : {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1

def main():
    fails = 0

    ctrl("/unpark"); ctrl("/front/a")
    fails += case("both windowed, A front", bounds("a"))

    ctrl("/front/b")
    fails += case("B raised — capture must follow the frontmost", bounds("b"))

    ctrl("/front/a")
    ctrl("/park")   # decoy parked off-desktop, raised to front
    fails += case("decoy parked off-desktop and raised — must be ignored", bounds("a"))

    ctrl("/unpark")
    ctrl("/fullscreen")          # A to its own Space; B stays on the main one
    time.sleep(3)
    fails += case("A FULLSCREEN on its own Space (B windowed elsewhere)",
                  {"x": 0, "y": 0, "width": 1440, "height": 900})

    ctrl("/windowed"); time.sleep(3)
    ctrl("/front/a")
    fails += case("back to windowed", bounds("a"))

    print(f"\nTOTAL FAILURES: {fails}")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
