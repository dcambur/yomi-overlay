# Tests

One command. Nothing it runs opens a window on your screen, takes focus
without saying so, or switches your Spaces — every window lives on an
invisible display, and a guard watches your real ones while a lane runs.

```
test/run.sh                  the everyday lanes: logic pages screen (~40 s)
test/run.sh all              every lane that needs nothing unshippable (~4 min)
test/run.sh idle spaces      just those
YOMI_BOOK=book.epub test/run.sh book      a real novel, page by page (~4 min)
test/run.sh golden record|check NAME      byte-exact OCR regression net
VERBOSE=1 test/run.sh ...    with the pages' and the app's own output
YOMI_ONLY=text test/run.sh ...            only the tests whose names contain it
```

| Lane | Needs | Sees | Time |
|---|---|---|---|
| `logic` | node | lookup, deinflection, the index builder, dictionaries, config, Anki, child supervision, the book lane's scorer | ~3 s |
| `pages` | Electron | the overlay page (glyph layer, rebuild gate, popup, card mark) and the settings page, through the real preload and CSP | ~10 s |
| `screen` | the stage¹ | the real window server, helper and app: selection, covers, idle, glyph placement, scrolling, fullscreen, tategaki, the picker, and the app end to end | ~25 s |
| `firstrun` | the stage | a fresh copy of the checkout: no config, no dictionary, no grant, no helper built; setup.sh run twice | ~25 s |
| `idle` | the stage | long idleness with the app's clock moved: the watchdog, the backstop, an hour away, a night asleep, a crashed page revived; a soak | ~100 s |
| `spaces` | the stage | Space switches — slow, fast, aggressive, parked, sliding, a real fullscreen Space — on the invisible display only | ~60 s |
| `book` | Electron, a built helper, `YOMI_BOOK`, the user's dictionaries | a real EPUB, 100 pages per orientation, every lookup through the real overlay page | ~4 min |
| `golden` | a built helper, `test/gt/` | every byte `yomi --image` emits, against a recorded baseline | ~2 min |

¹ *The stage*: Electron, swiftc, Screen Recording for the terminal, and the
overlay **not** running — a second capture session stalls behind its watch
loop, so the lane checks and refuses.

A lane that cannot run on this machine says why and fails. "All green" never
means "the interesting part was skipped". `book` and `golden` need files that
cannot ship (a book, dictionaries, a corpus), so they are never part of `all`.

## The rules every lane keeps

- **Ground truth, not ourselves.** Where text is comes from the live DOM
  (`Range.getBoundingClientRect()` of the real characters); which window is
  the target comes from the window server; what a word means comes from the
  same lookup against the same dictionary. A lane asserts a floor, so it
  cannot pass on nothing.
- **Quick or loud.** Every wait is bounded and says, when it times out, what
  it last saw. A test has 20 s unless it asks for more; a lane has a limit
  (150 s, the book 15 min) that stops it and fails it.
- **Your screen is not the stage.** `stage/user-screen.js` samples the
  window server every 0.5 s: a window of ours on one of your displays, or
  focus taken, fails the lane. A real fullscreen must take focus — macOS
  activates the app whose window goes fullscreen — so a test that does says
  so (`takingFocus`), and focus goes back to the app you had in front
  (measured 3.2 s for the screen lane, 7.5 s for spaces). Your windows all
  leaving the screen at once is how a Space switch looks from here; since
  you may be switching Spaces yourself, that is noted, not failed.
- **Nothing written to your files.** Each run gets one `TMPDIR`, removed
  however it ends. The app under test has its own Electron profile and
  `YOMI_USER_DIR` — its config, index and log — so it runs beside an
  installed Yomi Overlay without touching it. Only `book` reads your
  dictionaries, read-only.
- **A test that fails when the code is broken.** A fix is checked the other
  way too: the mutation that shows its bug must make its test fail, and the
  commit says which mutation it was.

## Where things are

```
test/
  run.sh          the one command; which lanes, and what each needs
  fixtures/       generated inputs every lane may use: Yomitan archives,
                  captured payloads, the AnkiConnect double, a stub child
  stage/          what every lane on the invisible display shares
    harness.js      test(), waitFor(), bounded(), children that die with it
    lane.js         a lane's main: the display, the guard, the limit, the summary
    display.js      the invisible display, and windows on it
    virtual-display.swift, VirtualDisplay.h   the display itself
    yomi.js         the capture helper, driven as the app drives it
    truth.js        ground truth from the DOM, and how well glyphs sit on it
    app.js          the real app: launched, reached over DevTools, looked up in
    in-app.js       the app's entry for lanes that must see what it shows
    user-screen.js  the guard on your real displays
    horizontal.html, vertical.html   public-domain stage pages
  logic/  pages/  screen/  firstrun/  idle/  spaces/  book/   one per lane
  golden.sh  cer.py  gt/                                      the OCR corpus
```

**Adding a test**: put it in the lane that already sees what it needs — the
cheapest one. A new lane is a directory with one Electron entry that calls
`runLane()` (or, like `book`, owns its main), plus a line in `run.sh`.

## `logic` — `logic/*.test.js`

Plain `node:test`, on fixtures the suites generate themselves. **No dictionary
is read.** `fixtures/` writes the Yomitan archives each suite wants, so the
suites run in a fresh clone and on a runner. They used to read `data/dicts/`,
which is gitignored and largely commercial: everywhere but one laptop they
skipped, and "all green" meant "all absent". Add a case by generating the
dictionary that shows it (`make-dictionary.js`), never by adding a file to
`data/`.

`fixtures/legacy-index.js` is the exception that proves it: `lookup.js` must
keep reading indexes built by `tools/build-index.py`, so that test builds one by
calling the old builder's own loaders. It needs `python3`, and says so when it
skips.

A failing supervision test used to leave its stub child alive and the lane
with it, for good; every stub is now stopped after each test, and
`--test-force-exit` ends a file whose tests are done.

## `pages` — `pages/pages.js`

`renderer.js` and `settings.js`, side by side in **one** Electron process that
is an accessory app: no Dock tile, no menu bar, never frontmost, and hidden
windows. They drive each page as a black box through the real preload and the
real IPC channel names, with payloads captured from the ground-truth corpus.
The Anki note a card sends is judged by main's own `validNote`, not a copy of
its limits. Run directly, a suite exits with a pointer instead of waiting for a
window forever.

The trick that makes glyph-layer rebuilds observable from outside: a rebuild
does `layer.innerHTML = ''`, so a property set on a live span survives if and
only if the layer was *not* rebuilt.

## `screen` — `screen/screen.js`

The real thing, on the invisible display. `stage/virtual-display.swift`
creates a display the window server treats as real — it composites it,
ScreenCaptureKit captures it, a window made fullscreen there gets its own Space
— that no monitor shows, touching the real display at one corner only so the
cursor cannot wander onto it. The display belongs to the helper process and
goes when it does: even a `kill -9` removes it at once (measured).

What it asserts:

- capture follows the **frontmost** of two windows of one app, and never a
  window parked off every display
- a window over half the target comes back as a **cover**; a buried target
  emits the **idle** marker within 4 s (measured 68–224 ms, 2.3 s at load 8)
  and recovers
- glyph boxes land on the real text — top of page, after a **scroll**, and
  with the target **fullscreen** on its own Space
- **tategaki**: coverage, placement and right-to-left column order, with no
  `--vertical`
- the **picker** lists an app with no bundle id and `--app` follows it
- **the app end to end**, with its own profile, user directory, dictionary
  and a local AnkiConnect: the glyph layer against the DOM, Shift over 猫, a
  Lapis note with sentence and picture, the overlay leaving within 4 s of the
  target (not at the 8 s backstop), a crashed page coming back, one that
  crashes twice given up and off the screen, quitting taking both children,
  each log line written once into its own directory, and a SIGKILLed app
  taking both children with it too.

This lane runs the app as it ships — its real menu-bar item shows for the
~10 s the app is up. The lanes below use `stage/in-app.js` instead.

Caveats, measured: the display is 1x (macOS lists a 2x mode for a virtual
display but will not switch to it — `book` covers recognition at 2x); the first
run after `ocr/build.sh` spends 29–64 s compiling Vision's model, once, up
front, and says so.

## `firstrun` — `firstrun/firstrun.js`

Someone who has just cloned the project and launched the app. Each case starts
from a fresh copy of this checkout's tracked files — what a clone holds: no
`bin/`, no `data/` — and runs the real app through `stage/in-app.js`, which
records what the app would show instead of showing it: the menu-bar item (a
Tray that draws nothing), message boxes (answered with their last button),
System Settings links, focus, the ⌘⌥S shortcut. `bin/yomi` in the copy is
`fake-yomi.sh`: the real helper, aimed at a window on the invisible display —
a first run captures its default target, which is your Kindle if it is open.

Permissions are yours and are never taken away; what the app does without one
is what it does when the helper says so, and that is what the fake says:

- a fresh install opens Settings and nothing else, and the menu says no
  window is chosen and there is no dictionary
- without Screen Recording: one dialog, a menu item that opens the pane, and
  capture retried with backoff (3 starts in ~5 s)
- without Accessibility: the menu says Shift needs the mouse to move
- no helper built: one dialog naming the path and `ocr/build.sh`, and the
  menu says capture could not start (not that it is slow)
- capture that keeps stopping keeps saying so between its restarts
- a first capture refused, as a rebuilt helper's is: recovers in ~3 s
- a slow first read: after 10 s the menu says the first read after an update
  takes a minute, then what it reads
- `setup.sh` in a sandbox, with `security`, `tccutil`, `open`, `codesign`
  and `build-app.sh` recording instead of acting: a second run keeps the
  grants the first had you give, and a first run that fails still has its
  re-run clear the grants of the ad-hoc build it replaces

## `idle` — `idle/idle.js`

Long idleness without the wait. `stage/in-app.js` moves the app's
main-process clock (`YOMI_TEST_CLOCK`): `advance()` is time passing, every
timer due by then firing; `jump()` is a machine waking from sleep, the wall
clock moved and the timers not. The helper and the page keep real time, and
every long timer is in the main process.

- a SIGSTOPped capture child is restarted by the 2-minute watchdog: 1.4 s
- total silence hides the overlay at the 8 s backstop
- an hour with the target away, in 100 s steps with the child's idle markers
  between them, keeps the same child; the overlay is back in ~1.2 s
- a night asleep does not restart a healthy child
- a page given up after two crashes says so in the menu — through the
  capture child's own restarts — and Restart capture brings it back
- a soak (`YOMI_IDLE_SOAK_S`, default 30) at the 0.1 s interval floor, passes
  counted off the helper's own heartbeats: the helper's and the app's memory
  are judged by their slope after the first read settles (a first read's
  buffers are let go over seconds: 137 MB → 38 MB), and the log by its growth
  (none, on a static page)

What cannot be emulated from here: a real sleep, a screen lock, display sleep —
each would take your Mac from you.

## `spaces` — `spaces/spaces.js`

A Space switch, as the window server shows one (ARCHITECTURE §2–3): the target
leaving the on-screen list, parked off the desktop with a sliver left, sliding
in, and a real fullscreen Space of its own — only on the invisible display.
After each, the overlay must have left with the target, come back with it, and
lie on the page's text again. Measured at load ~4: the overlay leaves
0.7–1.2 s after the target and is back 0.5–1.6 s after it; ten 300 ms absences
go unseen (a pass notices after ~0.4 s); 60 flips 40 ms apart make 4 show/hide
lines — no thrash.

## `book` — `book/book.js`

A real novel, the way a reader uses the app. Each page is rendered as a reader
shows it (whole columns or lines, the book's own ruby, 20 px Mincho), recognised
with `bin/yomi --image` at the display's scale, laid under the real overlay
page, and pointed at — a Shift press over ten words a page. Each popup is
checked against what the page's own text looks up, through the same lookup and
your dictionaries. Headless: no Screen Recording, and it runs with the
overlay up. Pages with a miss, and a report, land in `bin/test/book/`.

Measured on リビルドワールドI〈上〉 (2026-09-25):

|  | pages | characters | CER | placed | words right |
|---|---|---|---|---|---|
| vertical | 100 | 47,751 | 1.0% | 97.7% | 964/996 (96.8%) |
| horizontal | 100 | 50,696 | 1.1% | 98.9% | 978/1000 (97.8%) |

Every miss is on a line the OCR misread, and the lane asserts that: when the
text is right, pointing at a word opens that word. `logic/book-score.test.js`
tests the scorer itself.

## `golden` — `golden.sh`

Byte-exact regression net over `bin/yomi --image`: record before a structural
change to the Swift, require identical output after. It opens no capture
session, so it runs while the overlay is up. See the header of the script. The
corpus under `gt/` is not in the repo; `gt/gen_aozora.py` regenerates the
public-domain part of it.
