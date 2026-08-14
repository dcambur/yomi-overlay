# Conventions & principles

House style for this project. It is deliberately opinionated; the codebase is
consistent with it and should stay that way.

## Principles

**Measure, don't infer.** Every hard bug here was solved by observing the system
and killed time by reasoning ahead of the data. The window server lies about
fullscreen bounds; ScreenCaptureKit composites windows somewhere non-obvious;
Electron reports positions macOS never honoured. When behaviour is surprising,
dump the artifact (`--dump` for captures, `/tmp/yomi-overlay.log` for placement)
and look at it. State findings as measurements, with numbers.

**No per-app special cases.** The overlay must work over browsers, Kindle, PDF
readers, manga viewers and fullscreen games. A fix that keys on a bundle id is
the wrong fix; find the property that is true for all of them (usually: what the
window server is actually compositing, or what the captured pixels actually show).

**Degrade honestly.** If the target isn't visible, report nothing and let the
overlay hide — never adopt a plausible-looking substitute. A silent wrong answer
(the overlay tracking an invisible window) costs far more than a visible gap.

**Comments explain *why*, and cite the measurement.** The codebase is full of
non-obvious constraints that look like mistakes to a reader who doesn't know the
history. Every one of them carries the reason and, where it exists, the number:

> `// Measured: a fullscreen Chrome returned 1440x900 from screencapture -l
> // while SCWindow.frame insisted on 1440x778 at y=122.`

Do not remove these. Do not add comments that restate the code, and do not add
archaeology either — "this used to be six variables in main.js" belongs in the
commit message, not the file.

**Tests assert against ground truth, not against ourselves.** Truth comes from
the live DOM (`Range.getBoundingClientRect()` of real text on a real page), from
the window server, and from real OCR output captured off the corpus — never from
hand-written fixtures that agree with us by construction. A test that can pass
when nothing was recognised is a broken test; assert a floor.

**Prefer deleting a mechanism over adding a correction to it.** The panel used
to chase the window and correct for misplacement; removing the chase removed the
whole class of bug. Ask whether the compensation exists because the design is
racing something.

**Move code, or change code — never both in one commit.** Structural and
behavioural changes have different risks and different evidence. A pure move is
provable (byte-identical output); a behaviour change needs an argument. Mixed
together, neither is checkable. If you find a bug while moving, note it in
[FOUND-BUGS.md](FOUND-BUGS.md) and keep moving.

**Add the smallest thing that works, and prove it runs.** How much code a
change is allowed to be, where a new thing goes, and how to name it are in
[GROWTH.md](GROWTH.md) — including the test a new mechanism has to pass before
it is worth keeping.

## Structure

- **One file knows the layout.** `app/paths.js`, `tools/paths.py` and
  `tools/paths.sh` derive every root from their own location. Nothing else names
  a directory. Moving the project is then a one-line change, not a sweep.
- **Name the problem, not the mechanism.** `Capture/`, `Recognition/`,
  `Tategaki.swift`, `glyph-layer.js` say what this program does. `utils/`,
  `helpers/`, `common/`, `Models/` say what kind of construct is inside, which
  the reader can already see. If a thing has one caller, it lives with its caller.
- Generated and licensed data lives under `data/`, compiled helpers under `bin/`.
  Both are gitignored wholesale, so "what is source" is a property of the layout
  rather than a list to maintain.

## Code style

### General
- Match the density and idiom of surrounding code. No reformatting drive-bys.
- Fix the general case; don't accumulate special cases.
- Keep the "capture only the target window" guarantee visible in any code that
  touches filters. It is a privacy property, not an implementation detail.

### Swift ([ocr/Sources/](../ocr/Sources/))
- One file per pipeline stage, grouped by what it does to the page: `Capture/`,
  `Recognition/`, `Geometry/`, `Output/`, `CLI/`. Split a file when it holds
  three separable things; not before.
- Built by `ocr/build.sh`, which globs `Sources/` — **no `Package.swift`.**
  Verified: globals cross files and `@main` works in any file under
  `-parse-as-library`, so a split costs nothing at the build line.
- `private` does not reach across a file. Anything two stages share is
  `internal` (see `Geometry/Ink.swift`, shared by Tategaki and Furigana).
- Import only what the file uses. The build is whole-module, so this is
  hygiene, not performance.
- 4-space indent, ~90 column soft limit. `// MARK: -` at file scope.
- Emit **NDJSON**, one object per line, `fflush` after each. stdout is data;
  stderr is diagnostics.
- Long string interpolations must be split into locals — the type-checker times
  out on big concatenations (it has, twice).
- Every capture path returns a `Capture` carrying its own geometry. Never let
  geometry be implied by a caller's assumption.
- Per-run state belongs on `RecognitionSession`, not at file scope. A global
  cannot be constructed for a test, which is why `--assume-horizontal` had to
  exist as a CLI flag.

### JavaScript — main process ([app/main/](../app/main/))
- CommonJS, 2-space indent, semicolons, single quotes.
- `app/main.js` is wiring: it requires the parts, connects them, and handles
  shutdown. It holds no mutable module state — if you are adding a `let` there,
  it belongs in one of the modules.
- A module owns its own state and exposes a verb-shaped surface. Take
  dependencies as arguments (`createTier2({ ocrChild })`) rather than reaching
  for them, so the real coupling is visible.
- Heavy/synchronous work (SQLite) lives here, not the renderer, so hover never
  janks.

### JavaScript — renderer ([app/renderer/](../app/renderer/))
- **IIFE exposing one `window` namespace per file**, in the shape `popup.js`
  established. These are classic scripts, not modules: they share one global
  scope, and load order in `index.html` is load-bearing.
- Nothing inline in `index.html`. The CSP grants neither `script-src` nor
  `style-src` `'unsafe-inline'`, and it should stay that way.
- `contextIsolation: true`, `nodeIntegration: false`. The renderer reaches the
  main process only through the narrow surface in
  [app/preload/overlay.js](../app/preload/overlay.js); treat everything crossing
  IPC as untrusted.
- Renderer logs go to the main log via the `console-message` hook — use them,
  they are the only visibility into a hidden panel.
- Diagnostics that earned their keep stay in (`layer@`, `[win] target frame`);
  temporary instrumentation comes out before finishing.

### Python (build scripts)
- Stdlib only, 4-space indent, module docstring explaining the data shape it
  consumes.
- Dictionary parsing is per-format and explicit. When adding a dictionary,
  add its shape to `flatten_glossary` — don't loosen the generic walker.

## Testing

Three tiers, by what they need. Reach for the cheapest one that can see your
change.

| Suite | Needs | Sees |
|---|---|---|
| `test/unit/run.sh` | nothing (`python3` for one) | lookup, the index builder, dictionary install/import/removal, settings, child supervision, the glyph layer |
| `test/golden.sh` | a built `bin/yomi` | every byte the OCR helper emits |
| `test/verify*.py` | Screen Recording, a live desktop, network | real capture geometry |

- **A test may not depend on a file we cannot ship.** The dictionary suites
  used to read `data/dicts/`, which is gitignored and mostly commercial: on a
  runner and in anyone else's clone they skipped, so CI ran two of them and
  green meant nothing. Generate the input instead — `test/unit/fixtures/`
  writes the Yomitan archives, and that is also the only way to test a bad
  CRC, an unknown bank, or two dictionaries claiming one title. The same rule
  is why `golden.sh` and `verify*.py` are separate tiers rather than skips.
- **Record `golden.sh` before any structural change to the Swift, and require
  byte-identical output after.** It runs off `--image`, so it needs no
  permission and no window, and works while the overlay is running.
- Golden cannot see `--list-all`, `--list`, `--frame` or `--check-permission`.
  If you touch those, exercise them by hand.
- The unattended suites do not load `app/main.js`. A five-second
  `electron app/main.js` run is the cheapest check that it still starts.

## Workflow

- **The PR title is the version.** Merges are squashed, so the title becomes the
  commit subject the release pipeline reads: `feat:` cuts a minor, `docs:` and
  `chore:` cut nothing, anything else cuts a patch. See
  [RELEASING.md](RELEASING.md).
- **Deploying a change = quit and relaunch the app.** No rebuild. See
  [ARCHITECTURE.md](ARCHITECTURE.md) §6.
- Rebuild `yomi` with `ocr/build.sh`. The first capture after a rebuild is
  refused once — see [FOUND-BUGS.md](FOUND-BUGS.md).
- Rebuild the app bundle (`tools/build-app.sh`) only when `bootstrap.js`,
  `extend.plist`, the icon, or the Electron version changes. Nothing else may
  live in `app/shell/`: electron-packager copies that directory wholesale.
- Re-run `tools/build-index.py` after adding dictionaries to `data/dicts/`.
- Before claiming a geometry fix works, run the `verify*.py` suites. They need
  the overlay **stopped** and the rig's windows on the active Space.

## Gotchas that will bite again

- Concurrent SCK sessions: a running overlay makes one-shot `yomi` captures
  hang. Stop the app before testing. `--image` is exempt — it opens no session,
  which is why the golden harness uses it.
- Ordinary windows cannot join another app's fullscreen Space; a test rig that
  must be visible there needs `type: 'panel'` + `visibleOnFullScreenScreen`.
- A Space transition animates: capturing mid-slide reads a transient x. Let it
  settle before asserting.
- Electron *can* be driven from a plain shell, including a hidden
  `show: false` window with real Chromium layout — that is how the renderer
  suite runs. What cannot be scripted is the packaged `.app` and its TCC
  prompts; ask a human to relaunch for those.
- `mapfile` is bash 4. macOS ships bash 3.2.
