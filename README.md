# Yomi Overlay

Yomitan-style popup dictionary lookups over **any** macOS window — Kindle,
BOOK☆WALKER in a browser, a manga reader, a PDF viewer, a fullscreen game.

The target window is captured as pixels, OCR'd with Apple's Vision and Live Text
engines, and an invisible text layer is positioned over the real glyphs. Hold
**Shift** and point (or click) to look a word up. Nothing touches the source
file and no DRM is involved — it reads what is already on screen.

Handles horizontal (yokogaki) and vertical (tategaki) Japanese, including pages
that mix both, and strips furigana out of the pixels before recognition so ruby
text doesn't fuse into the base line.

```
kindleocr (Swift CLI)                Yomi Overlay (Electron)
  pick target window                   display-sized transparent NSPanel
  capture ONLY that window             one invisible <span> per glyph
  Vision / Live Text OCR (ja-JP) ──▶   Shift/click → lookup → popup
  per-glyph boxes, NDJSON                      │
  global shift/click monitor                   ▼
                                       index.db (SQLite) + Yomitan deinflector
```

## Requirements

| | |
|---|---|
| **macOS** | 13+ in principle (ScreenCaptureKit + Live Text). Developed and measured on **macOS 26.5, Apple Silicon** — that is the only configuration with numbers behind it. |
| **Xcode command line tools** | `swiftc`, to build the capture helper. `xcode-select --install` |
| **Node.js** | Only for `npm install`; the app runs on Electron 43's bundled Node 22 (`node:sqlite`). |
| **Python 3** | 3.8+, stdlib only, for the dictionary fetch and index build. |
| **Disk** | ~370 MB index + ~260 MB dictionary zips. The optional manga-ocr second-opinion tier adds ~2 GB of wheels and a ~450 MB model. |
| **Permissions** | Screen Recording (required) and Accessibility (for the trigger). See below. |

## Install

```bash
git clone https://github.com/dcambur/yomi-overlay.git
cd yomi-overlay
./setup.sh
```

`setup.sh` is idempotent — run it again after moving the project or upgrading
Electron and it redoes only what is missing. It:

1. creates a stable self-signed **"Yomi Overlay Dev"** signing certificate,
2. runs `npm install`,
3. downloads the freely licensed dictionaries (`overlay/fetch-dicts.py`),
4. builds `index.db` (a few minutes),
5. installs the optional manga-ocr sidecar venv (skippable; the app runs
   without it),
6. packages and installs `/Applications/Yomi Overlay.app`,
7. opens the two Privacy panes for you.

Expect up to two password/confirmation dialogs on the first run — trusting the
new certificate, and letting `codesign` use its key. That is the once.

**Build the OCR helper** (setup.sh does not, deliberately — it is a one-liner
you will re-run often):

```bash
swiftc -O -parse-as-library KindleOCR.swift -o kindleocr
```

### Permissions — two of them, different failure modes

| Permission | Needed for | Symptom without it |
|---|---|---|
| **Screen Recording** | all capture | nothing works; the app warns on launch |
| **Accessibility** | the global Shift/click trigger | silently degrades to Shift **+ mouse movement** |

System Settings → Privacy & Security → each list → add `/Applications/Yomi Overlay.app`.

The Accessibility degradation is invisible from the logs, so the menu-bar item
says when it is missing.

### Dictionaries

`overlay/fetch-dicts.py` downloads the freely licensed set: **Jitendex**,
**JMnedict**, **KANJIDIC**, **JPDB** and **BCCWJ** frequency lists.

Commercial monolinguals (三省堂, 明鏡, 旺文社, 実用) and NHK pitch accent are
**not** fetched and are not redistributed here. Drop your own Yomitan `.zip`
files into `overlay/dicts/` and re-run:

```bash
python3 overlay/build-index.py
```

Any zip is classified by the banks it contains, so a dictionary you add is
picked up without editing the script.

## Use

Launch from Spotlight. The app has no Dock icon (`LSUIElement`) — the **読**
menu-bar item is the way in:

- **Settings…** (⌘⌥S) — pick the target window, show/hide and reorder dictionaries
- **Restart capture**, **Quit**

In the window picker, click an **app** to follow whichever window it shows, or
**shift-click** to pin one specific window.

Reading: hold **Shift** and point, or click. The popup stays after you release
and closes when you move ~90 px clear of it. Hover mode (no modifier, dwell to
fire) is in Settings → Lookup.

## Configuration

`overlay/config.json` is written on first launch; `overlay/config.js` holds the
defaults. Settings covers the common keys; the rest are edit-and-restart.

| Key | Default | Meaning |
|---|---|---|
| `target` | — | bundle id / window id of the app being read |
| `interval` | `0.6` | seconds between capture passes |
| `trigger.mode` | `hover` | `hold` (modifier + point) or `hover` (dwell) |
| `trigger.modifier` | `shift` | `shift`\|`control`\|`option`\|`command` |
| `trigger.hoverDelayMs` | `70` | dwell before a hover lookup fires |
| `engine` | `auto` | `auto`\|`vision`\|`livetext` |
| `voting.passes` | `3` | re-OCR a static page N times and majority-vote per character |
| `voting.everyN` | `2` | vote on every Nth unchanged pass |
| `tier2.mode` | `shadow` | manga-ocr second opinion: `shadow` (log disagreements) or `off` |

**Deploying a change is: quit the app, relaunch.** No rebuild — the `.app`
bundle contains only a loader that reads `main.js`, `index.html` and `lookup.js`
from this directory and spawns `kindleocr` from it. That is also what makes the
macOS permission grants survive every code change (see
[ARCHITECTURE.md](ARCHITECTURE.md) §6). Rebuilding `kindleocr` or `index.db`
likewise needs only a restart.

## Troubleshooting

**Nothing appears.** Check `/tmp/yomi-overlay.log`. The overlay hides after 8 s
with no capture, which is the correct behaviour when the target's Space is not
on screen — macOS does not composite an inactive Space, so there are no pixels.

**Shift does nothing unless the mouse is moving.** Accessibility is not granted.

**Geometry looks wrong** (spans offset from the glyphs). Do not theorise. In
order: `./kindleocr --dump /tmp/x.png` and *look* at the image; compare the
`[win] target frame` line in the log against `./kindleocr --list-all`; check
whether the target window is on the active Space. ARCHITECTURE.md §1–4 explains
each.

**`kindleocr not found`.** Build it (above). If the path in the dialog is not
where the project lives, the loader resolved the wrong directory — fix
`~/Library/Application Support/Yomi Overlay/project-path`, or set
`YOMI_OVERLAY_DIR`.

**Captures hang while testing.** A running overlay holds a ScreenCaptureKit
session, which stalls one-shot captures. Quit the app first.

## Development

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything — it documents
the **load-bearing decisions**, each of which was paid for with a real bug
(stale fullscreen window bounds, cross-Space window selection, panel-chasing
races, glyph-layer drift). [CONVENTIONS.md](CONVENTIONS.md) is the house style;
[PLAN.md](PLAN.md) and [INTEGRATION.md](INTEGRATION.md) are the roadmap and the
measurement log.

| Path | Role |
|---|---|
| [KindleOCR.swift](KindleOCR.swift) | window selection, capture, OCR, per-glyph geometry, tategaki reflow, furigana stripping, global event monitor |
| [overlay/main.js](overlay/main.js) | panel, child-process supervision, tray, settings, IPC, permissions |
| [overlay/index.html](overlay/index.html) | glyph layer, hit-testing, popup show/dismiss state |
| [overlay/popup.js](overlay/popup.js) | popup presentation — markup, pitch graphs, placement |
| [overlay/lookup.js](overlay/lookup.js) | multi-length lookup + Yomitan deinflection |
| [overlay/build-index.py](overlay/build-index.py) | Yomitan zips → `index.db` + `dictionaries.json` |
| [overlay/shell/bootstrap.js](overlay/shell/bootstrap.js) | the *entire* app bundle; loads the real code from this directory |
| [test/](test/) | alignment/selection suites and the CER harness |

Tests take ground truth from a live DOM (`Range.getBoundingClientRect()` of real
text on a real page) and from the window server. They need the overlay
**stopped** and the rig's windows on the active Space. `test/gt/` corpora are
not in the repo — regenerate with `test/gt/gen_aozora.py`.

## Known gaps

- Per-glyph boxes are interpolated inside Vision's *word*-level boxes under
  `.accurate`; alignment is always slightly approximate.
- Words split across a line break can't be looked up as one unit.
- No Anki export yet.
- Tategaki on real reader apps is young — the engine passes the DOM-truth suite
  but has had limited validation against real Kindle pages with furigana.

## License and credits

**GPL-3.0-or-later** — see [LICENSE](LICENSE).

`overlay/yomitan/` is taken from [yomidevs/yomitan](https://github.com/yomidevs/yomitan)
(GPL-3.0), unmodified apart from two import paths. It provides the real,
condition-typed transform chains — not a reimplementation — so 信じられている
resolves to 信じる. That vendored code is why this project is GPL-3.0.

Dictionary data is **not** redistributed here. Jitendex, JMnedict and KANJIDIC
carry their own licenses; commercial dictionaries are the user's own to supply.

Personal-use tool. The loader-outside-bundle trick that keeps macOS permissions
alive is deliberately not distribution-safe, and there is no notarization or
updater.
