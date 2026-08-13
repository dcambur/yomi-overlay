# Refactoring plan

Structural work only. Every load-bearing decision in
[ARCHITECTURE.md](ARCHITECTURE.md) §1–9 stays exactly as it behaves today —
this plan moves that logic and names it, it does not rethink it. The
measurement comments travel with their code, unedited.

## What is actually wrong

Measured, not asserted. Line counts as of today:

| File | Lines | Distinct concerns | Module-level mutable state |
|---|---|---|---|
| `KindleOCR.swift` | 2756 | 15 | 9 globals |
| `overlay/main.js` | 813 | 13 | 25 bindings |
| `overlay/index.html` | 739 (135 CSS + 5 markup + 580 JS) | 10 | 20 bindings |
| `overlay/popup.js` | 174 | 1 | 0 |
| `overlay/lookup.js` | 240 | 1 | 4 |
| `overlay/config.js` | 128 | 1 | 1 |

The bottom three are the shape the top three should be in. `popup.js` is
already the proof that this codebase can hold a boundary: *"this file decides
HOW a lookup result looks, index.html decides WHEN one shows"* — one sentence,
one seam, zero leakage. The plan is to do that ten more times.

### 1. Too many concerns per file

**`KindleOCR.swift`** holds: arg parsing, target model, a global keyboard/mouse
event monitor, window enumeration, occlusion measurement, capture, frame
hashing, ink masking, tategaki cell splitting, strip reflow, furigana band
detection and erasure, a private-ObjC Live Text binding, the Vision binding,
orientation policy, temporal voting, JSON serialisation, a stdin crop channel,
and six CLI subcommands. Two functions carry most of it:

- `recognize()` — **343 lines** (1339–1681). Reflow, furigana strip *including
  an inline composite-and-recognise pass*, engine dispatch, native-vertical
  shape detection, mixed-content merge, strip-position mapping, flat mapping,
  hint attachment. Seven jobs, one scope, four file-scope globals read or
  written along the way.
- `Main.main()` — **451 lines** (2305–2755), with every subcommand inlined. The
  leftover indentation on the `if opts.checkPerm { … }` bodies is a fossil of a
  `switch` that used to be there.

**`overlay/main.js`** holds: log plumbing, single-instance lock, panel
lifecycle, two child-process supervisors, a manga-ocr sidecar with its own
queue and lifecycle, Levenshtein distance, permission checks and their dialogs,
tray menu, settings window, seven IPC handlers scattered across 250 lines, the
window-picker's skip-list, and shutdown handling.

**`overlay/index.html`** holds a stylesheet, the glyph layer, the rebuild-gate
policy, page-turn confirmation, layer placement, cover-region hit refusal, the
trigger state machine, glyph hit-testing, lookup orchestration, the tier-2
probe geometry, and the HUD. `applyPayload()` alone is **149 lines** (363–511)
and is where the four subtlest decisions in the renderer live (§5 of
ARCHITECTURE, plus the vote-in-place path).

### 2. Missing abstractions

These are the specific ones. Each is a thing the code already *says* exists in
a comment but does not express in a type.

- **No engine protocol.** `recognize()` says *"Both engines are normalized to
  one intermediate shape … so the strip mapping and the flat path below never
  know which engine ran."* That shape is a protocol. Today `visionLines()`
  returns `[LiveText.RLine]` — the Vision path's return type is named after the
  *other* engine. That naming is the missing abstraction, visible.
- **No coordinate-space types.** Six spaces are in flight — image pixels,
  Vision's bottom-left normalised, top-left normalised, screen points,
  window-local points, strip pixels — and five of them are bare `CGRect`. Only
  `NBox` is typed, and its doc comment explains exactly why that paid off:
  *"Converting once, up front, is what makes the vertical-text rotation
  expressible as four lines of arithmetic instead of a sign-error hunt."*
  Every load-bearing bug in ARCHITECTURE §1–4 was a coordinate-space bug. This
  is the single highest-value type in the project and it exists once out of six
  times.
- **No supervised-child type (JS).** `startOCR()` and `startEvents()` both do:
  spawn → `error` handler → buffered NDJSON stdout → `exit` handler → restart
  with backoff → `deliberate` flag to suppress auto-restart. The NDJSON line
  splitter is written out **three times** (256–263, 369–374, 476–480), the
  restart-with-backoff twice, and the watchdog once but reaching into four
  module globals to do it.
- **No glyph-layer type (renderer).** `lines`, `spans`, `spanIndex`,
  `contentSig`, `layoutRef`, `frameSig`, `rejectedStreak`, `turnCandidate` are
  eight globals that are only ever meaningful together, plus one hard invariant
  binding them: *"`contentSig` must keep describing the DOM."* An invariant
  spanning eight globals across 300 lines is a class that hasn't been written.
- **Generic algorithms mixed into wiring.** `editDistance` (main.js 419),
  `jsonEscape` (Swift 1307), `runs()` / `inkMask()` (Swift 910–954, shared by
  tategaki *and* furigana), `morae()` (popup.js 31).
- **JSON by string concatenation.** `buildPayload`, `heartbeatJSON`,
  `coversJSON`, the `--list-all` and `--cells` emitters all hand-build JSON,
  with a comment noting the type-checker times out on the concatenations.
  `Encodable` removes both the concatenation and the timeout.
- **Sticky state as globals, not sessions.** `orientation`,
  `flatReadNativeVertical`, `lastMixedNote`, `lastLoggedEngine` are per-run
  recognition state kept as file-scope `var`. `--assume-horizontal` exists
  *only* because there is no way to inject that state — a debug CLI flag
  standing in for a constructor parameter.

### 3. Folder structure

```
reader/
  KindleOCR.swift      2756-line monolith at the root
  kindleocr            the binary it builds, beside it
  setup.sh
  overlay/             ← five unrelated things at one level:
    main.js …            main process
    index.html popup.js  renderer
    settings.html        settings window
    build-index.py       dictionary build pipeline
    mangaocr_sidecar.py  Python ML sidecar
    build-app.sh icon.icns extend.plist   app packaging
    index.db (~370 MB) dictionaries.json config.json dicts/ .venv/   generated data
    yomitan/           vendored third-party
    shell/             bundle loader
  test/
```

Neither domain- nor feature-separated. Source and generated data are
interleaved; `.gitignore` needs six entries to describe which is which.

**The reason it is like this is real, and any restructure must respect it:**
`paths.js` sets `DATA_DIR = __dirname` and `OCR_BIN = DATA_DIR/../kindleocr`,
i.e. *code location and data location are deliberately the same directory*, and
`shell/bootstrap.js` finds the app by probing that directory for `main.js`.
That coupling is what makes ARCHITECTURE §6 work (restart, don't rebuild;
permissions survive). So the folder work is gated on decoupling those two ideas
— which is Stage 0, and is itself one of the missing abstractions.

---

## The plan

Six stages. Each is independently shippable and independently verifiable.
**No stage mixes a move with a behaviour change** — that rule is what makes the
verification gate below meaningful.

### Stage 0 — One path resolver, then nothing else (½ day)

The prerequisite for every folder change. Today, seven places independently
know the layout: `paths.js`, `shell/bootstrap.js`, `build-app.sh`, `setup.sh`,
`build-index.py`, `main.js` (the `.venv` path, line 450), and four test scripts
(`REPO / "kindleocr"`).

Replace `paths.js` with a resolver that separates the three roots that are
currently one:

```js
PROJECT_ROOT   // from YOMI_OVERLAY_DIR / the pointer file — what bootstrap found
APP_DIR        // JS that the bundle loads
DATA_DIR       // index.db, dictionaries.json, config.json, dicts/
BIN_DIR        // kindleocr
TOOLS_DIR      // .venv, mangaocr_sidecar.py
```

Every consumer asks the resolver. The Python and shell scripts get the same
treatment via one `tools/paths.sh` + `tools/paths.py` pair, derived from the
script's own location — no literals.

Land this with the *current* directory layout, so all five roots still resolve
to today's paths and nothing observable changes. Then Stage 1 is a `git mv`
plus five constants.

> **`bootstrap.js` is the one file whose change costs a repackage** (it lives
> inside the signed bundle). Design the scheme so it changes exactly once, here:
> its contract stays *"the pointer directory contains `main.js`"*, and only its
> `FALLBACK` constant moves. The signing certificate is stable, so the
> repackage keeps both permission grants (ARCHITECTURE §6) — but budget for one
> `build-app.sh` run and one relaunch, and verify the designated requirement is
> still certificate-based afterwards.

**Gate:** app launches, captures, looks up a word, and `setup.sh` is idempotent
on a fresh clone.

### Stage 1 — Folder structure (½ day, pure `git mv`)

```
reader/
  ocr/                    Swift sources + build script
    Sources/*.swift
    build.sh
  app/
    main.js               entry point the bundle loads (thin)
    main/                 main-process modules
    renderer/             overlay window: index.html, css, modules
    settings/             settings window: html, preload, js
    shared/               ipc channel names, payload shape docs
    shell/bootstrap.js    the bundle's entire contents
    vendor/yomitan/       third-party, untouched
  tools/
    build-index.py  fetch-dicts.py  mangaocr_sidecar.py
    build-app.sh    paths.sh  paths.py
  data/                   gitignored: index.db, dictionaries.json,
                          config.json, dicts/, .venv/
  bin/                    gitignored: kindleocr
  test/
  docs/                   ARCHITECTURE.md CONVENTIONS.md PLAN.md
                          INTEGRATION.md REFACTOR.md
```

Wins beyond tidiness: `.gitignore` collapses from six artifact rules to
`data/` + `bin/`; "what is generated" becomes a directory rather than a list;
the settings window stops sharing a namespace with the overlay it configures.

**Gate:** `git log --follow` still works on every moved file (use `git mv`, one
commit, no content edits); app launches; `test/` runs green.

### Stage 2 — Split `KindleOCR.swift` (2–3 days)

Mechanical extraction first. `swiftc` takes a file list, so the build becomes
`swiftc -O -parse-as-library ocr/Sources/*.swift -o bin/kindleocr` — no
`Package.swift` needed, and the "single command, no manifest" property in
CONVENTIONS.md survives.

```
ocr/Sources/
  main.swift              @main; parse, dispatch to a Command. ~60 lines
  CLI/Options.swift       Options + parseArgs + --help
  CLI/Commands/           WatchCommand ImageCommand ListCommand
                          EventsCommand PermissionCommand FrameCommand
  Capture/WindowSelection.swift   Target, chooseWindow, visibleFraction,
                                  occluders, stillVisible, windowRect,
                                  displayFrames, isTargetFrontmost
  Capture/Capture.swift           capture, captureOnce, shoot, contentExtent,
                                  trueOrigin, Capture, frameHash
  Capture/CropChannel.swift
  Recognition/Engine.swift        protocol + RecognizedLine/RecognizedChar
  Recognition/VisionEngine.swift
  Recognition/LiveTextEngine.swift    the ObjC binding, moved verbatim
  Recognition/Orientation.swift       recognizeAuto policy, looksPicketFence
  Recognition/Recognizer.swift        the slimmed recognize()
  Recognition/Voting.swift            voteLines
  Geometry/Spaces.swift           NBox, Geometry, the space conversions
  Geometry/Ink.swift              inkMask, runs
  Geometry/Tategaki.swift         tategakiCells, reflowStrip,
                                  reanchorVerticalChars, Cell
  Geometry/Furigana.swift         detectRubyBands, eraseBands, kanaFraction,
                                  markRuby
  Model/Line.swift                Line, CharBox
  Output/Payload.swift            Encodable payload/heartbeat/covers + writer
  Support/Images.swift            dumpImage, upscale2x, rotated90CCW
  Support/Log.swift               stderr diagnostics, once-only dedupe
```

Then, in separate commits, the four abstractions:

1. **`protocol RecognitionEngine`** returning `[RecognizedLine]` — Vision and
   Live Text conform. `LiveText.RLine` stops being the shared currency and
   becomes Live Text's private detail. Two conformers, one protocol, **no
   registry and no plugin system** — the engine-choice policy in
   `Orientation.swift` stays a plain `if/else` that names both engines, because
   the policy is genuinely per-engine and the comment at 1462–1471 documents
   why per-engine.
2. **`RecognitionSession`** — a class owning `orientation`,
   `flatReadNativeVertical`, `lastMixedNote`, `lastLoggedEngine`, `engineMode`.
   Sticky orientation is per-run state, and this is what makes it injectable:
   `--assume-horizontal` stops being a production CLI flag and becomes
   `RecognitionSession(orientation: .horizontal)` in tests. Keep the flag as an
   alias for one release; delete it after.
3. **Phantom-typed rects** — `Rect<ImagePixels>`, `Rect<ScreenPoints>`,
   `Rect<WindowLocal>`, `Rect<NormalizedTopLeft>`, `Rect<StripPixels>`, with
   conversions that *require* the frame they convert against. Do this
   incrementally: `Geometry` first (it already carries `region` + `window`
   precisely to prevent one class of mix-up — make the compiler enforce what
   its doc comment currently only warns about), then the reflow mapping, then
   the flat mapping. Stop when the remaining `CGRect`s are all in one space.
4. **Break up `recognize()`** into `stripFurigana(_:) -> (image, hints)`,
   `mapReflowedStrip(...)`, `mapFlatLines(...)`, `attachHints(...)`, leaving an
   orchestrator of ~50 lines. The furigana composite-and-read block (1392–1436)
   moves whole into `Furigana.swift` — it is a self-contained "read many bands
   in one Vision call" routine that has no business being inside a general
   recognition function.

**Gate — this is the important one.** Before any Swift edit, capture golden
output: run `bin/kindleocr --image --json` over the whole `test/gt/` corpus
(plus the vertical, furigana and mixed pages) and store the NDJSON. After each
commit, re-run and diff **byte for byte**. The `--image` path needs no
permission, no window, and no ScreenCaptureKit session, so it runs anywhere and
runs while the overlay is up — it is the ideal harness for this, and it already
exists.

First, verify the premise: run the corpus twice today and confirm the output is
identical. Vision is nondeterministic *between captures*; on a fixed PNG it
should be stable. If it is not, fall back to a CER-delta gate via
`test/cer.py` (`Δ CER == 0.00`) plus exact-match on all geometry fields.

Then `test/verify.py`, `verify_vertical.py`, `verify_spaces.py`,
`verify_fullscreen.py` — all four, overlay stopped, per CONVENTIONS.md.

### Stage 3 — Split the Electron main process (1–2 days)

```
app/main.js                 wiring only: build the pieces, connect them. ~80 lines
app/main/log.js             the file-mirroring logger + process-level handlers
app/main/ndjson.js          lineSplitter(onObject) — kills 3 copies
app/main/supervised-child.js  class SupervisedChild
app/main/overlay-window.js  panel lifecycle, ensureCover, show/hide,
                            offset + covers dedupe and dispatch
app/main/ocr-source.js      the kindleocr watch child; routes idle /
                            heartbeat / capture / crop
app/main/trigger-source.js  the events child; screen→window coords
app/main/tier2.js           class Tier2Probe — sidecar lifecycle, queue,
                            pending map, idle kill, disagreement log
app/main/permissions.js     screen recording + accessibility, checks + dialogs
app/main/tray.js
app/main/settings-window.js
app/main/ipc.js             every ipcMain handler, in one file
app/main/window-list.js     --list-all + the skip-list filter
app/lib/edit-distance.js
```

`SupervisedChild` is the one that pays for itself immediately. It absorbs:
spawn + `reportSpawnFailure`, the `deliberate` kill flag, `stopChild`'s
SIGKILL escalation, the NDJSON line splitter, restart-on-exit with a
configurable backoff (exponential for OCR, flat 2s for events), and the silence
watchdog. That is ~120 lines of main.js today, in two nearly-identical copies
plus a third partial copy in the sidecar, replaced by one class with two call
sites.

The 25 module globals land in three owners — `OverlayWindow` (win, interactive,
idleTimer, lastOffset, lastCovers), `SupervisedChild` ×2 (all the ocr*/events
state), `Tier2Probe` (all nine sidecar bindings) — with only `tray` and
`settingsWin` left at module scope, each owned by its own small module.

**Gate:** launch; confirm in `/tmp/yomi-overlay.log` that the diagnostics that
earned their keep still appear (`[win] target frame`, `[win] covered by N
window(s)`, `[ocr] …`, `[tier2] … agree/DISAGREE`, `layer@`). CONVENTIONS.md
treats those as load-bearing, so their disappearance is a regression. Then:
swipe Spaces (overlay hides in ~0.15s, §3), drag a window over the target
(lookups refuse inside the cover, §2), retarget from settings (glyph layer
resets), kill `kindleocr` by hand (restarts with backoff), quit via ⌃C (no
orphan processes).

### Stage 4 — Split the renderer (1–2 days)

CSP already allows `script-src 'self'`; `popup.js` proves external scripts
load. So this is free.

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
app/renderer/popup.js              unchanged — it is already right
```

Moving the CSS out also lets the CSP drop `style-src 'unsafe-inline'`, which is
a free hardening win and one line of PLAN.md Stage 6.

**`class GlyphLayer` is the centrepiece.** It owns `lines`, `spans`,
`spanIndex`, `contentSig`, `layoutRef`, `frameSig`, `rejectedStreak` and
enforces the one invariant those eight globals exist to maintain:
*`contentSig` describes the DOM, always.* Surface:

```js
layer.apply(payload)  // → 'identical' | 'patched' | 'kept' | 'rebuilt'
layer.isPageTurn(payload)
layer.charAt(li, ci)
layer.reset()
```

The four return values are exactly the four branches of today's
`applyPayload()`, and naming them is what makes the §5 gate legible: the
similarity threshold, the 3-refusal bound, the layout-shift epsilon and the
vote-in-place fast path become four short private methods with their
measurement comments attached, instead of one 149-line function where the
comments outnumber the code.

`lookup-controller.js` keeps the pin/dismiss state machine and the
turn-confirmation logic — *when* a popup shows, mirroring popup.js's *how*.
That completes the boundary popup.js's header comment already declares.

**Gate:** all four `test/` suites (they assert on `layer@` through the DOM, so
they cover this directly), plus by hand: hover a word, scroll the popup, move
away >90px (dismisses), turn a page with a popup open (turn confirmed on the
second matching payload, not the first), and a page-zoom with a popup open
(the parked payload applies before the next lookup — the 生/が bug at line 651).

### Stage 5 — Utilities, JSON, and the small stuff (1 day)

- Swift payload emission → `Encodable` structs + one `NDJSONWriter`. Removes
  `jsonEscape`, all the manual interpolation, and the type-checker-timeout
  workaround comment (keep the *note* in CONVENTIONS.md; the trap is real for
  future string building).
- `runs()` / `inkMask()` → `Geometry/Ink.swift`, shared explicitly by tategaki
  and furigana rather than by file-scope proximity.
- `editDistance`, `morae` → `app/lib/`.
- `test/` → `test/suites/` (the four verifiers), `test/rig/` (the Electron rig
  + its package.json), `test/gt/` (unchanged), `test/bench/` (cer.py,
  cellbench.py).
- Update `docs/CONVENTIONS.md`: the Swift section currently mandates *"Single
  file, no package manifest"*. That is the one written convention this plan
  contradicts, deliberately — replace it with the new build line and a
  one-file-per-concern rule, and say why. Update the ARCHITECTURE.md file
  table and the CLAUDE.md quick-facts paths in the same commit.

---

## Not doing (and why)

- **No TypeScript, no bundler, no build step for the JS.** The
  "edit → restart, never rebuild" property is not convenience, it is what makes
  ARCHITECTURE §6's TCC trick work. A build step puts a compiler between an
  edit and a running overlay and re-opens the permissions question.
- **No `Package.swift`** unless something later needs it. `swiftc *.swift`
  keeps the build a single line and keeps `build-app.sh` unchanged.
- **No plugin/registry architecture for engines.** Two engines, one protocol,
  explicit policy. The measured per-engine rules (1462–1471) are the *product*,
  not an implementation detail to hide behind indirection.
- **No touching the load-bearing logic.** The similarity gate, the 3-refusal
  bound, the 0.6em picket-fence threshold, the 0.3/0.65 ruby ratios, the 50%
  visibility rule, the 20×20 occlusion grid, `IDLE_HIDE_MS = 8000` — all move
  verbatim, with their comments. Any change to one of these is a separate PLAN.md
  item with its own measurement, never a refactor side-effect.
- **No reformatting.** CONVENTIONS.md forbids drive-bys, and byte-diffable
  moves are the whole verification strategy.
- **Not splitting `popup.js`, `lookup.js`, or `config.js`.** They are the size
  they should be.

## Sequencing and cost

| Stage | Cost | Unblocks |
|---|---|---|
| 0 — path resolver | ½ day | everything |
| 1 — folders (`git mv`) | ½ day | — |
| 2 — Swift split + 4 abstractions | 2–3 days | testable recognition; PLAN.md Stage 3 |
| 3 — main process split | 1–2 days | PLAN.md Stage 4 (Anki) |
| 4 — renderer split | 1–2 days | PLAN.md Stage 5 (word status) |
| 5 — utilities, JSON, docs | 1 day | — |

Stages 3 and 4 are independent of each other and of Stage 2; either can go
first if a feature needs it. Stage 0 blocks Stage 1, and Stage 1 blocks
nothing — the code splits work equally well before or after the move, so if the
folder reshuffle feels risky, do Stages 2–5 in place and move last.

**Payoff against the existing roadmap:** PLAN.md Stage 3 (OCR accuracy levers)
wants per-lever CER deltas — that needs a recognition path you can construct
with injected state and swap engines in, which is Stage 2 items 1–2 exactly.
Stage 4 (Anki) adds a sixth IPC handler, a third child process and a popup
button; `app/main/ipc.js`, `SupervisedChild` and the popup boundary are already
the right shape for it. Stage 5 (word status) colours existing glyph spans —
that is a method on `GlyphLayer`, or a fifth scattered global.

## The one rule for every commit here

Move code, or change code. Never both.
