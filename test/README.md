# Tests

One command, and no window opens on your screen — the one visible sign is the
app's own 読 menu-bar icon, for the ~10 s the real app is under test:

```
test/run.sh                  every lane (243 tests, ~40 s)
test/run.sh logic pages      just those
test/run.sh golden record|check NAME
VERBOSE=1 test/run.sh ...    with the pages' and the app's own output
```

| Lane | Needs | Sees | Time |
|---|---|---|---|
| `logic` | node | lookup, deinflection, the index builder, dictionary install/import/removal, config, Anki, child supervision | ~2 s |
| `pages` | Electron | the overlay page (glyph layer, rebuild gate, popup, card mark) and the settings page, real preload and CSP | ~10 s |
| `screen` | Electron, swiftc, Screen Recording for the terminal, the overlay **not** running | the real window server, capture helper and app: selection, covers, idle, glyph placement, scrolling, fullscreen, tategaki, the picker, and the app end to end | ~25 s |
| `golden` | a built `bin/yomi` | every byte `yomi --image` emits, against a recorded baseline | ~2 min |

A lane that cannot run on this machine says why and fails. "All green" never
means "the interesting part was skipped".

## `logic` — `unit/*.test.js`

Plain `node:test`, on fixtures the suites generate themselves. **No dictionary
is read.** `unit/fixtures/` writes the Yomitan archives each suite wants, so the
suites run in a fresh clone and on a runner. They used to read `data/dicts/`,
which is gitignored and largely commercial: everywhere but one laptop they
skipped, and "all green" meant "all absent". Add a case by generating the
dictionary that shows it (`make-dictionary.js`), never by adding a file to
`data/`.

`fixtures/legacy-index.js` is the exception that proves it: `lookup.js` must
keep reading indexes built by `tools/build-index.py`, so that test builds one by
calling the old builder's own loaders. It needs `python3`, and says so when it
skips.

## `pages` — `unit/pages.js`

`renderer.js` and `settings.js`, side by side in **one** Electron process that
is an accessory app: no Dock tile, no menu bar, never frontmost, and hidden
windows. They drive each page as a black box through the real preload and the
real IPC channel names, with payloads captured from the ground-truth corpus.

The trick that makes glyph-layer rebuilds observable from outside: a rebuild
does `layer.innerHTML = ''`, so a property set on a live span survives if and
only if the layer was *not* rebuilt.

## `screen` — `screen/stage.js`

The real thing, on a display nobody can see. `screen/virtual-display.swift`
creates a display the window server treats as real — it composites it,
ScreenCaptureKit captures it, a window made fullscreen there gets its own Space
— that no monitor shows, touching the real display at one corner only so the
cursor cannot wander onto it. Every window the suite opens lives there, and the
suite is an accessory app, so a run does not take focus from what you are
doing. The display belongs to the helper process and goes when it does: even a
`kill -9` removes it at once (measured).

What it asserts, against ground truth — the live DOM of the stage page for
where text really is, the window server for which window is the target:

- capture follows the **frontmost** of two windows of one app, and never a
  window parked off every display
- a window over half the target comes back as a **cover**; a buried target
  emits the **idle** marker at once (measured 77–224 ms) and recovers
- glyph boxes land on the real text — top of page, after a **scroll**, and
  with the target **fullscreen** on its own Space
- **tategaki**: coverage, placement and right-to-left column order, with no
  `--vertical` (the app never passes it)
- the **picker** lists an app with no bundle id and `--app` follows it
  (`screen/picker-rig.swift`, a bare executable named past the 31 bytes the
  window server keeps)
- **the app end to end**: the real `app/main.js`, with its own profile and
  user directory (`YOMI_USER_DIR`), a dictionary the suite builds, and a local
  AnkiConnect. It checks the glyph layer against the DOM, then drives the
  overlay page through the DevTools protocol: Shift over 猫 opens its entry, and
  the card mark adds a Lapis note with the sentence and a picture. It crashes
  the overlay page and checks that the layer comes back, crashes it again and
  checks the panel is given up and leaves the screen, checks that the overlay
  hides with the target, that quitting takes both capture children with it,
  and that the app logged each line once, into its own directory. The pointer
  events are delivered to the page itself; your cursor never moves.

`screen/horizontal.html` and `screen/vertical.html` are local, public-domain
(Aozora Bunko) pages, so the lane needs no network.

Caveats, measured:

- **The overlay must not be running.** A second ScreenCaptureKit session
  stalls behind its watch loop. The lane checks, and refuses to run.
- **The display is 1x.** macOS lists a 1440×900 2x mode for a virtual display
  but will not switch to it, so the Retina path is not what this lane
  exercises.
- **The first run after `ocr/build.sh` is slower, once.** A helper never run
  before spends its first read compiling Vision's model (29–64 s measured);
  the lane warms it up front, says so, and stamps `bin/test/.yomi-warm`.
- **Every wait is bounded**: DevTools 3–5 s, a test 20 s, the suite 60 s. A
  run is quick or it fails loudly.

Helpers (`virtual-display`, the picker rig) are compiled on demand into
`bin/test/`, which is gitignored like the rest of `bin/`.

## `golden` — `golden.sh`

Byte-exact regression net over `bin/yomi --image`: record before a structural
change to the Swift, require identical output after. It opens no capture
session, so it runs while the overlay is up. See the header of the script. The
corpus under `gt/` is not in the repo; `gt/gen_aozora.py` regenerates the
public-domain part of it.
