# Refactor integration plan — executable handoff

**Audience: an agent executing the refactor.** [REFACTOR.md](REFACTOR.md) holds
the diagnosis and the measurements; this file holds the procedure. Read
[docs order](#step-1-read-order) first, then execute steps in order.

Every step states: goal → actions → **gate** → commit. **Do not proceed past a
failing gate.** Do not batch steps into one commit.

---

## The one invariant

> **Never mix a structural change with a behavioural change in the same commit.**

This is Kent Beck's "two hats" rule from *Tidy First?*: there are two kinds of
change, and you are always making exactly one of them
([Beck](https://medium.com/@kentbeck_7670/bs-changes-e574bc396aaa)). It is not
style advice here — it is what makes the byte-diff gate in Step 2 meaningful.
Every threshold in this codebase (0.6 em picket fence, 0.85 similarity, the
3-refusal bound, 50% visibility, 20×20 occlusion grid, 0.30/0.65 ruby ratios,
`IDLE_HIDE_MS = 8000`) was paid for with a measured bug. A refactor that
changes one by accident is invisible until a user hits it.

If you find a bug while moving code: **leave it, note it in a `FOUND-BUGS.md`,
keep moving.** Fix it in its own commit after the step's gate is green.

---

## Research findings that changed the plan

Six sources, plus two claims verified by direct test. Only what altered the
plan is listed.

**1. Electron's `main` / `preload` / `renderer` triple is the convention — adopt
the directory names, reject the bundler baggage.** Every mainstream Electron
scaffold converges on `src/main`, `src/preload`, `src/renderer`
([electron-vite](https://electron-vite.org/guide/dev),
[electron-app](https://github.com/daltonmenezes/electron-app/blob/main/docs/STRUCTURE.md)),
and preload is a *first-class top-level folder*, not a file living beside main.
That matters here: this project has **two** preloads (`preload.js`,
`preload-settings.js`) currently sitting in the same directory as both the code
they isolate and the code they expose. But nearly all of that advice assumes a
bundler, and this project deliberately has no build step (ARCHITECTURE §6). So:
take the three-folder convention, take nothing else — no `src/`→`out/` split, no
entry-point rewriting, plain CommonJS throughout.

**2. The renderer is already sandboxed; PLAN.md Stage 6 is smaller than it
looks.** Electron enables `contextIsolation` by default since 12.0.0 and process
sandboxing by default since 20.0.0; critically, *disabling `contextIsolation`
also disables sandboxing regardless of the `sandbox` setting*
([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)).
This app sets `contextIsolation: true, nodeIntegration: false` and never sets
`sandbox`, on Electron 43 — so both windows are already sandboxed, and both
preloads use only `contextBridge` + `ipcRenderer`, which are the
sandbox-compatible APIs. PLAN.md's *"`sandbox: true` where possible"* is a
**verification task, not an implementation task**. Do not spend a day on it.

**3. "Package by feature, not layer" — but read what the domain actually is.**
The canonical argument
([javapractices](http://www.javapractices.com/topic/TopicAction.do?Id=205)) is
that feature packages have high cohesion and low coupling, that they let you
narrow scope to package-private by default, and offers a sharp test:
*"an item has maximum modularity only if it can be deleted in a single
operation."* Applied honestly here: this is not a business app with features, so
top-level goes by domain (`ocr/`, `app/main/`, `app/renderer/`, `tools/`), and
*within* the OCR domain the split goes by **pipeline stage** — because Capture,
Recognition, Tategaki and Furigana are problem-domain words, not implementation
categories. That is the real test to apply to every folder name you invent:
**does it name the problem, or the mechanism?** `Recognition/`, `Tategaki.swift`
pass. `Models/`, `Services/`, `Helpers/`, `utils/` fail.
→ **Consequence: the `app/lib/` and `Support/` folders proposed in REFACTOR.md
are wrong.** Corrected below.

**4. Swift file organisation: rule of threes, MARK discipline, order by access
level.** *"Splitting large ideas into their own files lowers the cognitive load
of understanding what a file contains"*, balanced by the **rule of threes** —
group when three related parts appear, and no sooner
([Sundell](https://www.swiftbysundell.com/articles/structuring-swift-code/)).
`// MARK: - Label` (with hyphen) outside a type declaration, `// MARK: Label`
(no hyphen) inside; order file contents most-visible-first
([Microsoft swift-guide](https://microsoft.github.io/swift-guide/FileOrganization.html)).
The existing code already uses the hyphen form correctly at file scope.
→ **Consequence: apply the rule of threes as a *stopping* criterion.** The
20-file split in REFACTOR.md is a ceiling, not a target. Step 2 re-checks each.

**5. Phantom types are the established Swift idiom for exactly this problem, at
zero runtime cost.** Foundation's own `Measurement` API uses them so that
values of different units cannot be mixed
([Sundell](https://www.swiftbysundell.com/articles/phantom-types-in-swift/),
[Begemann](https://oleb.net/blog/2016/08/measurements-and-units-with-phantom-types/)).
The coordinate-space recommendation is not exotic; it is how the platform's own
stdlib solves the identical class of bug.

**6. Verified by direct test, not assumed** (run in a scratch directory):

| Claim | Result |
|---|---|
| `swiftc -O -parse-as-library *.swift -o out` builds from multiple files | ✅ works |
| Global `var` in one file, read from another | ✅ works |
| `@main` in a file, even one named `main.swift`, under `-parse-as-library` | ✅ works |

→ **Consequence: no `Package.swift` is needed and `build-app.sh`'s build line
changes by one glob.** But note the corollary the test does *not* cover:
**`private` at file scope becomes inaccessible once the file is split.**
`inkMask` and `runs` are `private` and used by *both* tategaki and furigana;
`shoot` is `private`. These must widen to `internal` — that is a mechanical,
expected part of Step 2, not a design compromise.

---

## Step 1: read order

Before touching anything, read in this order:

1. `docs/ARCHITECTURE.md` §1–9 — the load-bearing decisions. **These are
   requirements, not history.**
2. `docs/CONVENTIONS.md` — house style. Note the two rules this refactor
   deliberately breaks (Swift single-file; and *"no reformatting drive-bys"*,
   which stays in force — moves must be byte-identical).
3. `REFACTOR.md` — the diagnosis and per-file inventory.
4. `docs/PLAN.md` — what is already done. Several obvious-looking items are
   finished.

Then confirm the environment:

```bash
cd reader && ls bin/kindleocr 2>/dev/null || ls kindleocr
```

**GUI apps cannot be launched from an agent shell.** Every gate below that says
"launch the app" must be handed to the human with the exact checks to perform.
Batch those requests — do not interrupt per step.

---

## Step 0: the golden-master harness (do this first, always)

**Goal:** a byte-exact regression net that runs without permissions, without a
window, and while the overlay is running.

`kindleocr --image` is the ideal harness and already exists: it needs no
ScreenCaptureKit session, no Screen Recording grant, and no target window.

### Actions

1. Create `test/golden.sh`:

```bash
#!/bin/bash
# Golden-master harness for the refactor. Runs kindleocr over every ground-truth
# image and writes one NDJSON file per image. Structural changes must not move
# a single byte of the output.
#
#   test/golden.sh record  baseline    # capture the reference
#   test/golden.sh check   baseline    # diff current against it
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCR="${KINDLEOCR:-$HERE/../kindleocr}"
MODE="${1:?usage: golden.sh record|check DIR}"
OUT="${2:?usage: golden.sh record|check DIR}"
DEST="$HERE/golden/$OUT"

run() {
  mkdir -p "$DEST"
  find "$HERE/gt" -name '*.png' | sort | while read -r img; do
    key="$(echo "${img#$HERE/gt/}" | tr '/' '_')"
    "$OCR" --image "$img" --json > "$DEST/$key.json" 2> "$DEST/$key.err" || true
  done
}

case "$MODE" in
  record) run; echo "recorded $(ls "$DEST" | wc -l) files -> $DEST" ;;
  check)
    TMP="$(mktemp -d)"; DEST="$TMP" run
    if diff -r "$HERE/golden/$OUT" "$TMP" > /tmp/golden.diff 2>&1; then
      echo "GOLDEN OK — byte identical"
    else
      echo "GOLDEN FAILED — see /tmp/golden.diff"; head -40 /tmp/golden.diff; exit 1
    fi ;;
esac
```

Add `test/golden/` to `.gitignore`.

2. **Validate the premise before trusting it.** Vision is documented as
   nondeterministic *between captures*; on a fixed PNG it should be stable, but
   that is an assumption until measured:

```bash
test/golden.sh record probe-a && test/golden.sh record probe-b
diff -r test/golden/probe-a test/golden/probe-b && echo "DETERMINISTIC"
```

3. **If it is not deterministic:** do not proceed on hope. Fall back to a
   two-part gate and record it at the top of `test/golden.sh`:
   - `test/cer.py` delta must be exactly `0.00` on every category, and
   - every geometry field (`x`,`y`,`w`,`h`,`frame`,`vertical`,`ruby`) must match
     exactly; only `text` may vary, and only where CER is unchanged.

4. Record the real baseline: `test/golden.sh record baseline`

### Gate

`test/golden.sh check baseline` prints `GOLDEN OK` against an untouched tree.

### Commit

`test: golden-master harness for the refactor`

---

## Step 2: one path resolver (½ day) — blocks everything

**Goal:** separate the five roots that `paths.js` currently collapses into one,
**with the current directory layout still in place** so nothing observable moves.

Today seven places independently know the layout: `overlay/paths.js`,
`overlay/shell/bootstrap.js`, `overlay/build-app.sh`, `setup.sh`,
`overlay/build-index.py`, `overlay/main.js:450` (the `.venv` path), and four
test scripts (`REPO / "kindleocr"`).

### Actions

1. Rewrite `overlay/paths.js` to export five named roots:

```js
PROJECT_ROOT   // from YOMI_OVERLAY_DIR or the pointer file — what bootstrap found
APP_DIR        // the JS the bundle loads
DATA_DIR       // index.db, dictionaries.json, config.json, dicts/
BIN_DIR        // kindleocr
TOOLS_DIR      // .venv, mangaocr_sidecar.py
```

   Keep the existing derivation comment — it explains why these are derived and
   never literal, and that reasoning survives the change. **All five resolve to
   today's paths in this commit.**

2. Add `tools/paths.sh` and `tools/paths.py` exporting the same five, each
   derived from the script's own location. No literals anywhere.

3. Repoint every consumer at the resolver: `main.js` (`.venv`), `lookup.js`,
   `config.js`, `build-index.py`, `fetch-dicts.py`, `build-app.sh`, `setup.sh`,
   and the four test scripts.

4. Leave `bootstrap.js` **untouched** in this step. Its contract stays *"the
   pointer directory contains `main.js`"*.

### Gate

- `git diff --stat` shows no file moved.
- `python3 overlay/build-index.py --help` (or a dry run) resolves paths.
- **Human:** relaunch the app; it captures and looks up a word.

### Commit

`refactor: single path resolver, layout unchanged`

---

## Step 3: folder structure (½ day) — pure `git mv`

**Goal:** the target tree. **Zero content edits except the five path constants
from Step 2 and `bootstrap.js`'s `FALLBACK`.**

### Target tree

```
reader/
  ocr/
    Sources/*.swift
    build.sh                      swiftc -O -parse-as-library Sources/*.swift -o ../bin/kindleocr
  app/
    main.js                       entry the bundle loads (thin wiring)
    main/                         main-process modules
    preload/overlay.js            ← was overlay/preload.js
    preload/settings.js           ← was overlay/preload-settings.js
    renderer/                     overlay window
    settings/                     settings window: settings.html + its js
    shell/bootstrap.js            the bundle's entire contents
    vendor/yomitan/               third-party, untouched
  tools/
    build-index.py  fetch-dicts.py  mangaocr_sidecar.py
    build-app.sh    paths.sh  paths.py
  data/                           gitignored: index.db, dictionaries.json,
                                  config.json, dicts/, .venv/
  bin/                            gitignored: kindleocr
  test/
  docs/                           ARCHITECTURE CONVENTIONS PLAN INTEGRATION
                                  REFACTOR REFACTOR-INTEGRATION
```

`preload/` is top-level because Electron treats it as a third process context
with its own rules, and because these two files are the entire trust boundary
between the renderer and Node. Burying them next to the code they isolate is
what made that boundary easy to overlook.

### Actions

1. `git mv` everything. **One commit. Use `git mv`, never delete-and-create** —
   `git log --follow` must keep working on files carrying a decade of
   measurement comments.
2. Update the five path constants and `bootstrap.js`'s `FALLBACK`.
3. Collapse `.gitignore`'s six artifact rules to `data/` + `bin/`.
4. Update the file table in `docs/ARCHITECTURE.md` and the quick-facts paths in
   the root `CLAUDE.md`.

> ⚠️ **`bootstrap.js` lives inside the signed bundle, so this step costs one
> repackage.** The signing certificate is stable, so both permission grants
> survive (ARCHITECTURE §6) — but it must be verified, not assumed.

### Gate

- `git log --follow app/renderer/popup.js` shows history before the move.
- `test/golden.sh check baseline` → `GOLDEN OK`.
- **Human:** run `tools/build-app.sh`, then
  `codesign -d -r- "/Applications/Yomi Overlay.app"` — the designated
  requirement must still name the **certificate**, not a `cdhash`. If it says
  `cdhash`, stop: permissions will be lost on the next rebuild.
- **Human:** relaunch; capture + lookup work; both permissions still granted.

### Commit

`refactor: domain folder structure (pure move)`

---

## Step 4: split `KindleOCR.swift` (2–3 days)

Two phases, **many commits**, golden-master green after every one.

### Phase 4a — mechanical extraction

Move code into files. **No renames, no signature changes, no logic edits.** The
only permitted edit is widening `private` → `internal` where a split breaks
access (expected for `inkMask`, `runs`, `shoot`).

Target files (from REFACTOR.md, corrected):

```
ocr/Sources/
  Entry.swift                     @main; parse, dispatch to a command. ~60 lines
  CLI/Options.swift               Options, parseArgs, --help
  CLI/WatchCommand.swift          the watch loop (currently 250 lines of Main.main)
  CLI/ImageCommand.swift  CLI/ListCommand.swift
  CLI/EventsCommand.swift CLI/PermissionCommand.swift  CLI/FrameCommand.swift
  Capture/WindowSelection.swift   Target, chooseWindow, visibleFraction,
                                  occluders, stillVisible, windowRect,
                                  displayFrames, isTargetFrontmost
  Capture/Capture.swift           capture, captureOnce, shoot, contentExtent,
                                  trueOrigin, Capture, frameHash
  Capture/CropChannel.swift
  Recognition/Engine.swift        protocol + RecognizedLine / RecognizedChar
  Recognition/VisionEngine.swift
  Recognition/LiveTextEngine.swift   the ObjC binding, verbatim
  Recognition/Orientation.swift      recognizeAuto policy, looksPicketFence
  Recognition/Recognizer.swift       the slimmed recognize()
  Recognition/Voting.swift           voteLines
  Geometry/Spaces.swift           NBox, Geometry, the space conversions
  Geometry/Ink.swift              inkMask, runs, dumpImage, upscale2x,
                                  rotated90CCW  ← see rule-of-threes note
  Geometry/Tategaki.swift         tategakiCells, reflowStrip,
                                  reanchorVerticalChars, Cell
  Geometry/Furigana.swift         detectRubyBands, eraseBands, kanaFraction,
                                  markRuby, the band composite-and-read pass
  Model/Line.swift                Line, CharBox
  Output/Payload.swift            payload / heartbeat / covers + the writer
  Output/Diagnostics.swift        stderr logging, once-only dedupe
```

**Apply the rule of threes before creating each file.** REFACTOR.md's 20-file
list is a ceiling. `dumpImage` / `upscale2x` / `rotated90CCW` are exactly three
image operations, so they earn a home — put them in `Geometry/Ink.swift` beside
the other pixel work rather than inventing a `Support/` or `Utils/` folder,
which names a mechanism rather than the problem. **If a proposed file would hold
fewer than three related things, merge it into its neighbour.**

Per file, apply the house layout: `// MARK: - Label` at file scope (no hyphen
inside a type), contents ordered most-visible-first.

Update `ocr/build.sh` and `tools/build-app.sh` to
`swiftc -O -parse-as-library ocr/Sources/*.swift -o bin/kindleocr`. (Verified
working with globals across files and `@main` in any file.)

**Gate after 4a:** `test/golden.sh check baseline` → `GOLDEN OK`. Byte-exact.
Nothing else is acceptable here — this phase changed no logic.

### Phase 4b — the four abstractions, one commit each

Each carries a real risk of behaviour change. Golden-master after each.

**4b-1. `protocol RecognitionEngine`.** Vision and Live Text conform, both
returning `[RecognizedLine]`. `LiveText.RLine` becomes Live Text's private
detail and stops being the currency the Vision path is forced to speak.
**Two conformers, one protocol, no registry and no plugin system.** The
per-engine policy in `Orientation.swift` stays a plain `if/else` that names both
engines by name — those rules are measured product decisions (the comment at the
old `KindleOCR.swift:1462–1471`), not indirection to hide.

**4b-2. `RecognitionSession`.** A class owning `orientation`,
`flatReadNativeVertical`, `lastMixedNote`, `lastLoggedEngine`, `engineMode` —
today five file-scope `var`s. Sticky orientation is per-run state, and this is
what makes it injectable. `--assume-horizontal` stops being a production CLI
flag and becomes `RecognitionSession(orientation: .horizontal)` in tests. Keep
the flag as an alias in this commit; delete it in a later one.

**4b-3. Phantom-typed rects.** ⏸ **DEFERRED — measured, scoped, not started.**

Blast radius, measured 2026-08-13: **72 `CGRect`/`CGPoint`/`CGSize` sites across
16 of the 24 Swift files**, spanning five spaces — screen points, normalised
top-left, normalised bottom-left, image/subject pixels, strip pixels. Every one
needs a conversion at its boundary, and a rect type worth having must carry the
whole surface the code uses (`midX`, `midY`, `width`, `height`, `intersection`,
`union`, `contains`). Half-done, this is *worse* than `CGRect`: some call sites
converting, some not, and no compiler guarantee anywhere.

So it is its own piece of work, not a tail-end item. What follows is the scope.

**The specific hazard, which is live today.** `RecognizedLine.box` is normalised
**top-left**; `Line.box` is normalised **bottom-left**. Both are bare `CGRect`,
they sit one function apart, and `mapFlatLines` converts between them inside a
single expression:

```swift
box: CGRect(x: colX(l) - l.box.width / 2, y: 1 - l.box.maxY, …)
```

The `1 - maxY` is the whole conversion. Three comments warn about it
(`Mapping.swift:89`, `Engine.swift:30`, `Spaces.swift:12`); nothing enforces it.
`NBox` already exists precisely to make this conversion happen once, and its own
doc comment says why that paid off — *"four lines of arithmetic instead of a
sign-error hunt through three coordinate systems"*.

**Recommended first slice**, and it is genuinely self-contained: type only the
normalised pair, `NormalizedRect<TopLeft>` and `NormalizedRect<BottomLeft>`, and
make `NBox` the sole conversion between them. That covers the one adjacency that
is both dangerous and documented, touches `Engine.swift`, `Model/Line.swift`,
`Spaces.swift`, `VisionEngine.swift`, `LiveTextEngine.swift` and `Mapping.swift`
— six files, not sixteen — and leaves screen/pixel rects alone. Stop there and
judge whether the rest earns its cost.

Golden-master covers this fully: every one of these conversions is on the
`--image` path, and any sign error moves glyph boxes, so the harness fails loudly.

**4b-4. Break up `recognize()`** (343 lines → ~50). Extract
`stripFurigana(_:) -> (image, hints)`, `mapReflowedStrip(...)`,
`mapFlatLines(...)`, `attachHints(...)`. The furigana composite-and-read block
(old lines 1392–1436) moves whole into `Geometry/Furigana.swift` — it is a
self-contained "read many bands in one Vision call" routine with no business
inside a general recognition function.

### Gate for Step 4

- `test/golden.sh check baseline` → `GOLDEN OK` after **every** commit.
- **Human, overlay stopped, rig windows on the active Space:** all four suites —
  `test/verify.py`, `verify_vertical.py`, `verify_spaces.py`,
  `verify_fullscreen.py`. The vertical suite must still report
  **coverage ≥95%, placement ≥77%** (PLAN.md Stage 1 gate is placement ≥70%).

---

## Step 5: split the Electron main process (1–2 days)

```
app/main.js                    wiring only: build the pieces, connect them. ~80 lines
app/main/log.js                file-mirroring logger + process-level handlers
app/main/ndjson.js             lineSplitter(onObject)  ← kills 3 copies
app/main/supervised-child.js   class SupervisedChild
app/main/overlay-window.js     panel lifecycle, ensureCover, show/hide,
                               offset + covers dedupe and dispatch
app/main/ocr-source.js         the kindleocr watch child; routes
                               idle / heartbeat / capture / crop
app/main/trigger-source.js     the events child; screen→window coords
app/main/tier2.js              class Tier2Probe + editDistance (its only caller)
app/main/permissions.js        screen recording + accessibility, checks + dialogs
app/main/tray.js
app/main/settings-window.js
app/main/ipc.js                every ipcMain handler, in one file
app/main/window-list.js        --list-all + the skip-list filter
```

**Note the correction to REFACTOR.md:** `editDistance` goes into `tier2.js`, not
an `app/lib/`. It has exactly one caller, and a folder named `lib/` names a
mechanism rather than the problem — it fails the deletion test (you could never
delete it in one operation, and it would accrete). Promote it out only if a
second caller ever appears.

### Order (each its own commit)

1. `log.js` — smallest, zero dependents, proves the pattern.
2. `ndjson.js` + `supervised-child.js`, then convert `startOCR` to use it, then
   `startEvents`. **Convert one child at a time**; the two have different
   backoff policies (exponential vs flat 2s) and only the OCR child has the
   silence watchdog, so a shared class that silently unifies them is a
   behaviour change wearing a refactor's clothes.
3. `overlay-window.js` — absorbs `win`, `interactive`, `idleTimer`,
   `lastOffset`, `lastCovers`.
4. `tier2.js` — absorbs all nine sidecar bindings.
5. `permissions.js`, `tray.js`, `settings-window.js`, `window-list.js`.
6. `ipc.js` last — it depends on everything above.

After this, only `tray` and `settingsWin` remain at module scope, each owned by
its own module: **25 module globals → 2.**

### Gate

There are no automated tests for the main process, so the log **is** the test.
CONVENTIONS.md treats these diagnostics as load-bearing; their disappearance is
a regression.

**Human, with `/tmp/yomi-overlay.log` open:**

| Check | Expected |
|---|---|
| launch | `[trigger] …`, `[win] covering display …`, `engine: …` |
| point at a word | `layer@ …`, popup appears |
| swipe to another Space | overlay hides in ~0.15s (`[win] hidden — target has no visible window`) |
| drag a window over the target | `[win] covered by 1 window(s)`; lookups inside it do nothing |
| retarget in settings | glyph layer resets; `[win] target frame …` for the new window |
| `pkill kindleocr` | `[ocr] kindleocr exited …; restarting in 1000ms`, then recovery |
| hover a word twice | `[tier2] …ms d=… agree` or `DISAGREE` |
| quit with ⌃C | no orphan `kindleocr` (`pgrep kindleocr` empty) |

---

## Step 6: split the renderer (1–2 days)

The CSP already allows `script-src 'self'` and `popup.js` proves external
scripts load, so this costs nothing.

```
app/renderer/index.html            markup + link + script tags. ~25 lines
app/renderer/overlay.css           the 135-line style block, verbatim
app/renderer/glyph-layer.js        class GlyphLayer
app/renderer/placement.js          targetOrigin, applyPlacement, toFrame,
                                   covers, isCovered
app/renderer/trigger.js            modifier tables, hover dwell, mousemove
                                   routing, interactive latch
app/renderer/lookup-controller.js  pickGlyph, doLookup, pin/dismiss, tier2 probe
app/renderer/hud.js
app/renderer/popup.js              UNCHANGED — it is already the right shape
```

### `class GlyphLayer` is the centrepiece

It owns `lines`, `spans`, `spanIndex`, `contentSig`, `layoutRef`, `frameSig`,
`rejectedStreak` and enforces the single invariant those eight globals exist to
maintain: **`contentSig` describes the DOM, always.**

```js
layer.apply(payload)  // → 'identical' | 'patched' | 'kept' | 'rebuilt'
layer.isPageTurn(payload)
layer.charAt(li, ci)
layer.reset()
```

Those four return values are exactly the four branches of today's 149-line
`applyPayload()`. Naming them is what makes ARCHITECTURE §5 legible: the
similarity threshold, the 3-refusal bound, the layout-shift epsilon and the
vote-in-place fast path become four short private methods **with their
measurement comments attached**, instead of one function where the comments
outnumber the code.

`lookup-controller.js` keeps the pin/dismiss state machine and turn
confirmation — *when* a popup shows, mirroring popup.js's *how*. That completes
the boundary popup.js's header comment already declares.

### Free win while here

Moving the CSS to a file lets the CSP drop `style-src 'unsafe-inline'`. Do it
in a **separate commit** after the move is green.

### Gate

- All four `test/` suites (they assert on `layer@` through the live DOM, so they
  cover this directly).
- **Human:** hover a word; scroll the popup; move >90px away (dismisses); turn a
  page with a popup open (**dismisses on the second matching payload, not the
  first** — varying OCR garbage must never confirm itself); zoom the reader with
  a popup open, then look up (**the parked payload applies first** — this is the
  生/が bug at old `index.html:651`).

---

## Step 7: verify, don't implement (2 hours)

**Do not skip — this is where research saved a day of work.**

1. **Sandbox.** Confirm both `BrowserWindow`s report `sandbox: true`. Electron
   sandboxes renderers by default since 20.0.0 and this app is on 43 with
   `contextIsolation: true, nodeIntegration: false`; both preloads use only
   `contextBridge` + `ipcRenderer`, which are sandbox-compatible. Expected
   result: **already satisfied**. If so, tick PLAN.md Stage 6's *"`sandbox: true`
   where possible"* as done and record why — do not build anything.
2. **IPC payload validation.** The other half of that PLAN.md line is real work
   and is *not* done: `ipcMain.handle('lookup', …)` and `ipcMain.on('tier2', …)`
   accept whatever the renderer sends. Now that handlers live in one
   `app/main/ipc.js`, add shape checks at that one boundary. **Separate commit,
   and it is a behaviour change — not part of any refactor commit.**
3. Update `docs/CONVENTIONS.md`: replace *"Single file, no package manifest"*
   with the new build line and a one-file-per-concern rule, and say why it
   changed. Keep the type-checker-timeout warning — that trap is still real for
   any future string building. Update the file table in `docs/ARCHITECTURE.md`
   and the paths in the root `CLAUDE.md`.

---

## Sequencing, and what to do if time runs out

| Step | Cost | Blocks | Unblocks |
|---|---|---|---|
| 0 golden harness | 2h | everything | — |
| 2 path resolver | ½ day | Step 3 | — |
| 3 folders | ½ day | — | — |
| 4 Swift split | 2–3 days | — | PLAN.md Stage 3 (CER levers) |
| 5 main process | 1–2 days | — | PLAN.md Stage 4 (Anki) |
| 6 renderer | 1–2 days | — | PLAN.md Stage 5 (word status) |
| 7 verify + docs | 2h | — | — |

Steps 4, 5 and 6 are independent of each other. Step 2 blocks Step 3; Step 3
blocks nothing — the code splits work equally well before or after the move, so
**if the folder reshuffle feels risky, do 4–6 in place and move last.**

This ordering *is* "tidy first": each structural step is done specifically
because a planned behavioural change gets cheaper afterwards. PLAN.md Stage 3
needs per-lever CER deltas, which needs a recognition path you can construct
with injected state and swap engines in — that is Step 4b-1 and 4b-2 exactly.
Stage 4 (Anki) adds a sixth IPC handler, a third child process and a popup
button; `ipc.js`, `SupervisedChild` and the popup boundary are already the right
shape for it. Stage 5 (word status) colours existing glyph spans — a method on
`GlyphLayer`, or a fifth scattered global.

**If you must stop early, the highest value per hour is:** Step 0, then Step 5
(25 globals → 2, three duplicated parsers → one), then Step 4a (mechanical
split, no design risk), then Step 6. Steps 2–3 are the most disruptive and the
least urgent.

---

## Explicitly do not

- **Do not add TypeScript, a bundler, or any JS build step.** The
  edit-then-restart property is not convenience; it is what makes ARCHITECTURE
  §6's TCC trick work. A compiler between an edit and a running overlay
  re-opens the permissions question.
- **Do not add `Package.swift`.** `swiftc -O -parse-as-library Sources/*.swift`
  is verified working and keeps the build one line.
- **Do not build a plugin/registry architecture for engines.** Two engines, one
  protocol, explicit policy. The measured per-engine rules are the product.
- **Do not touch the load-bearing logic.** Every threshold moves verbatim, with
  its comment. Changing one is a separate PLAN.md item with its own
  measurement, never a refactor side-effect.
- **Do not remove or reword the measurement comments.** They travel with their
  code, unedited. CONVENTIONS.md: *"Do not remove these."*
- **Do not reformat.** Byte-diffable moves are the whole verification strategy.
- **Do not split `popup.js`, `lookup.js`, or `config.js`.** They are already the
  size they should be — `popup.js` is the model the rest is being moved toward.
- **Do not invent a `utils/`, `lib/`, `helpers/`, or `common/` folder.** Apply
  the test: does the name state the problem, or the mechanism? If a thing has
  one caller, it lives with its caller.

---

## Sources

- [Process Model | Electron](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Security | Electron](https://www.electronjs.org/docs/latest/tutorial/security) — contextIsolation default ≥12.0.0, sandbox default ≥20.0.0
- [electron-vite: Development](https://electron-vite.org/guide/dev) and [electron-app STRUCTURE.md](https://github.com/daltonmenezes/electron-app/blob/main/docs/STRUCTURE.md) — the main/preload/renderer convention
- [Package by feature, not layer — Java Practices](http://www.javapractices.com/topic/TopicAction.do?Id=205) — cohesion, scope minimisation, the single-delete modularity test
- [Structuring Swift code — Swift by Sundell](https://www.swiftbysundell.com/articles/structuring-swift-code/) — rule of threes
- [File Organization — Microsoft swift-guide](https://microsoft.github.io/swift-guide/FileOrganization.html) — MARK conventions, ordering by access level
- [Phantom types in Swift — Swift by Sundell](https://www.swiftbysundell.com/articles/phantom-types-in-swift/), [Measurements and Units with Phantom Types — Ole Begemann](https://oleb.net/blog/2016/08/measurements-and-units-with-phantom-types/)
- [SB Changes — Kent Beck](https://medium.com/@kentbeck_7670/bs-changes-e574bc396aaa) — structural vs behavioural, never both at once
