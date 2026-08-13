# Yomi Overlay

Yomitan-style popup dictionary lookups over any macOS window. Kindle, BOOK☆WALKER in a browser, a manga reader, a PDF viewer, a fullscreen game. If it puts Japanese text on your screen, you can point at a word and get a definition.

Kindle doesn't expose its text, so this doesn't ask it to. It captures the target window as pixels, runs Apple's Vision and Live Text OCR over them, and lays an invisible text layer on top of the real glyphs. Hold Shift and point (or click) and you get a popup. Nothing touches the source file and there's no DRM anywhere in the picture; it just reads what's already on screen.

It handles horizontal (yokogaki) and vertical (tategaki) text, including pages that mix both, and it erases furigana from the pixels before OCR so the ruby text doesn't fuse into the base line.

Roughly how it fits together:

```
yomi (Swift CLI)                Yomi Overlay (Electron)
  pick target window                   display-sized transparent NSPanel
  capture ONLY that window             one invisible <span> per glyph
  Vision / Live Text OCR (ja-JP) ──▶   Shift/click → lookup → popup
  per-glyph boxes, NDJSON                      │
  global shift/click monitor                   ▼
                                       index.db (SQLite) + Yomitan deinflector
```

## Requirements

- macOS 13 or later in principle, since it needs ScreenCaptureKit and Live Text. In practice it's only been tested on macOS 26.5 on Apple Silicon.
- Xcode command line tools, for swiftc: `xcode-select --install`
- Node.js, but only for `npm install`. The app itself runs on Electron 43's bundled Node 22 (it uses node:sqlite).
- Python 3.8+, stdlib only. Used to fetch dictionaries and build the index.
- Disk space: the index is about 370 MB and the dictionary zips another 260 MB. The optional manga-ocr second-opinion tier adds around 2 GB of wheels plus a ~450 MB model.
- Two macOS permissions: Screen Recording (required) and Accessibility (for the trigger).

## Install

```bash
git clone https://github.com/dcambur/yomi-overlay.git
cd yomi-overlay
./setup.sh
```

setup.sh does everything: creates a stable self-signed "Yomi Overlay Dev" signing certificate, runs npm install, downloads the freely licensed dictionaries via tools/fetch-dicts.py, builds index.db (takes a few minutes), installs the optional manga-ocr sidecar venv (skippable, the app works without it), packages and installs /Applications/Yomi Overlay.app, and opens the two Privacy panes for you. It's idempotent, so it's safe to re-run after moving the project or upgrading Electron; it only redoes what's missing.

Expect up to two password/confirmation dialogs the first time: one to trust the new certificate and one to let codesign use its key. That only happens once.

The OCR helper builds separately, since you'll rebuild it far more often than the rest:

```bash
ocr/build.sh
```

## Permissions

Screen Recording is required for all capture. Without it nothing works, and the app warns you at launch. Accessibility powers the global Shift/click trigger. Without that one the app silently degrades: Shift only registers while the mouse is moving. That failure mode leaves nothing in the logs, which is annoying, so the menu-bar item tells you when the permission is missing. Add /Applications/Yomi Overlay.app under System Settings → Privacy & Security → each list.

## Dictionaries

tools/fetch-dicts.py downloads the freely licensed set: Jitendex, JMnedict, KANJIDIC, and the JPDB and BCCWJ frequency lists. The commercial monolinguals (三省堂, 明鏡, 旺文社, 実用) and NHK pitch accent are not fetched and not redistributed. If you own them, drop the Yomitan .zip files into data/dicts/ and rebuild:

```bash
python3 tools/build-index.py
```

The indexer classifies any zip by the banks it contains, so a dictionary you add gets picked up without editing the script.

## Using it

Launch from Spotlight. There's no Dock icon (LSUIElement); the 読 item in the menu bar is the way in. It has Settings… (⌘⌥S) for picking the target window and showing/hiding/reordering dictionaries, Restart capture, and Quit.

In the window picker, clicking an app follows whichever window that app is showing. Shift-click to pin one specific window instead.

Then read. Hold Shift and point, or click. The popup stays up after you release and closes once you move about 90px clear of it. There's also a hover mode (no modifier, dwell to fire) under Settings → Lookup.

## Configuration

data/config.json is written on first launch; the defaults live in app/main/config.js. The Settings window covers the common keys, the rest are edit-and-restart:

- `target` — bundle id / window id of the app being read
- `interval` — seconds between capture passes (default 0.6)
- `trigger.mode` — `hold` (modifier + point) or `hover` (dwell). Default hold.
- `trigger.modifier` — shift, control, option, or command. Default shift.
- `trigger.hoverDelayMs` — dwell before a hover lookup fires (default 250)
- `engine` — auto, vision, or livetext. Default auto.
- `voting.passes` — re-OCR a static page N times and majority-vote per character (default 3; 1 disables)
- `voting.everyN` — vote on every Nth unchanged pass (default 2)
- `tier2.mode` — the manga-ocr second opinion. `shadow` logs disagreements, `off` disables it. Default shadow.

## Deploying a change

Quit the app and relaunch. That's it, no rebuild. The .app bundle contains only a loader that reads the real code out of the project directory and spawns yomi from it. This is also what keeps the macOS permission grants alive across code changes ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 6 explains how). Rebuilding yomi or index.db also just needs a restart.

## Troubleshooting

Nothing appears: check /tmp/yomi-overlay.log. The overlay hides itself after 8 seconds with no capture, and that's correct behavior when the target's Space isn't on screen. macOS doesn't composite an inactive Space, so there are literally no pixels to read.

Shift does nothing unless the mouse is moving: Accessibility isn't granted.

Geometry looks wrong, spans offset from the glyphs: don't guess at it. Run `./bin/yomi --dump /tmp/x.png` and look at the image, compare the `[win] target frame` line in the log against `./bin/yomi --list-all`, and check whether the target window is on the active Space. Sections 1–4 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walk through each case.

"yomi not found": build it. If the path in the dialog isn't where the project actually lives, the loader resolved the wrong directory. Fix ~/Library/Application Support/Yomi Overlay/project-path, or set YOMI_OVERLAY_DIR.

Captures hang while you're testing: a running overlay holds a ScreenCaptureKit session, which stalls one-shot captures. Quit the app first.

## Development

Start with [docs/README.md](docs/README.md), which indexes the rest. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) documents the decisions that each cost a real bug to learn (stale fullscreen window bounds, cross-Space window selection, panel-chasing races, glyph-layer drift). Read it before changing things. [docs/CONVENTIONS.md](docs/CONVENTIONS.md) is house style.

Layout: ocr/Sources/ is the Swift capture and OCR helper. app/ is the Electron side, split into main/ (main process), renderer/ (the overlay window), preload/ (the IPC boundary), and shell/ (the loader). tools/ has the build scripts and test/ has the suites.

Tests: `test/unit/run.sh` runs in about 3 seconds and needs no permissions or windows. `test/golden.sh` is a byte-exact regression check over the OCR helper's output; it needs a built binary. The test/verify*.py suites take their ground truth from a live DOM and the window server, so they need the overlay stopped and Screen Recording granted. The test/gt/ corpora aren't in the repo; regenerate them with test/gt/gen_aozora.py.

## Known gaps

- Per-glyph boxes are interpolated inside Vision's word-level boxes, so alignment is always a bit approximate.
- A word split across a line break can't be looked up as one unit.
- No Anki export yet.
- Tategaki on real reader apps is young. It passes the DOM-truth test suite, but hasn't been validated much against real Kindle pages with furigana.

## License and credits

GPL-3.0-or-later, see [LICENSE](LICENSE). app/vendor/yomitan/ comes from [yomidevs/yomitan](https://github.com/yomidevs/yomitan) (GPL-3.0), unmodified except for two import paths. Vendoring it means the deinflector uses the real condition-typed transform chains rather than a reimplementation, which is how 信じられている resolves to 信じる. It's also why this project is GPL-3.0.

No dictionary data is redistributed here. Jitendex, JMnedict and KANJIDIC carry their own licenses, and commercial dictionaries are yours to supply.

This is a personal-use tool. The loader-outside-the-bundle trick that keeps permissions alive isn't distribution-safe, and there's no notarization and no updater.
