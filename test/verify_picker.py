#!/usr/bin/env python3
"""Does the target picker offer an app that has no bundle id?

A game run through CrossOver is a bare Wine executable: the Dock names it
after the .exe and NSRunningApplication.bundleIdentifier is nil. The picker
used to drop every such window (issue #20), and nothing unattended could see
that — golden.sh never runs --list-all, and the settings suite is handed its
window list by the test.

Ground truth is a real process of the same shape: a Mach-O with no
Info.plist, compiled here, that opens one window and calls itself Rig.exe.
Asserted against the live window server:

  1. --list-all offers its window, with bundle "" and the process's own name
     as the app — the picker shows what the Dock shows
  2. --app <that name> --list resolves the same window through SCK — the name
     the picker shows is the name yomi follows

Needs swiftc and a live desktop (a window is opened, briefly). Step 2 needs
Screen Recording for the terminal and is reported, not failed, without it.
Run against a helper built from before the fix to watch step 1 fail.
"""
import json, os, pathlib, subprocess, sys, tempfile, time

# Derived, not written down: a literal path only describes one checkout.
REPO = pathlib.Path(__file__).resolve().parent.parent
# Where yomi lives is not this suite's business — ask the one file
# that knows the layout. Keeps the suites working across a move.
sys.path.insert(0, str(REPO / "tools"))
from paths import OCR_BIN
# YOMI_BIN overrides, as in golden.sh, for A/B-ing two builds.
OCR = os.environ.get("YOMI_BIN", str(OCR_BIN))

NAME = "Rig.exe"

# The rig prints what LaunchServices thinks it is, so the test can compare the
# picker's answer against the process's own rather than against a constant.
RIG = """
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 900, height: 650),
                 styleMask: [.titled, .closable], backing: .buffered, defer: false)
w.title = "rig window"
w.makeKeyAndOrderFront(nil)
let me = NSRunningApplication.current
print("\\(me.bundleIdentifier ?? "")\\t\\(me.localizedName ?? "")")
fflush(stdout)
app.run()
"""


def list_all():
    out = subprocess.run([OCR, "--list-all"], capture_output=True, text=True, timeout=20)
    return json.loads(out.stdout)


def main():
    if not pathlib.Path(OCR).exists():
        print(f"no yomi at {OCR} — run ocr/build.sh", file=sys.stderr)
        return 2
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp, "main.swift")
        src.write_text(RIG)
        exe = pathlib.Path(tmp, NAME)
        subprocess.run(["swiftc", "-o", str(exe), str(src)], check=True)
        rig = subprocess.Popen([str(exe)], stdout=subprocess.PIPE, text=True)
        try:
            bundle, name = rig.stdout.readline().rstrip("\n").split("\t")
            print(f"rig: bundle={bundle!r} name={name!r}")
            if bundle or name != NAME:
                print("  the rig is not the shape this test needs; nothing measured")
                return 2

            # 1. The picker offers it. Poll: the window server lists a new
            #    window a beat after orderFront returns.
            hit = None
            for _ in range(20):
                hit = next((w for w in list_all() if w["app"] == name), None)
                if hit:
                    break
                time.sleep(0.25)
            if hit and hit["bundle"] == "":
                print(f"ok    --list-all offers {name}: id={hit['id']} "
                      f"{hit['width']}x{hit['height']} bundle=\"\"")
            else:
                print(f"FAIL  --list-all does not offer {name} (got {hit})")
                failures += 1
                return 1

            # 2. The name it showed is the name yomi follows.
            perm = subprocess.run([OCR, "--check-permission"], capture_output=True,
                                  text=True, timeout=20)
            if not json.loads(perm.stdout or "{}").get("screenRecording"):
                print("skip  --app: this terminal has no Screen Recording grant")
                return 0
            out = subprocess.run([OCR, "--app", name, "--list"], capture_output=True,
                                 text=True, timeout=30)
            if f"id={hit['id']} " in out.stdout:
                print(f"ok    --app {name} --list resolves the same window through SCK")
            else:
                print(f"FAIL  --app {name} --list: rc={out.returncode} "
                      f"stdout={out.stdout.strip()!r} stderr={out.stderr.strip()!r}")
                failures += 1
        finally:
            rig.kill()
            rig.wait()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
