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

Do not remove these. Do not add comments that restate the code.

**Tests assert against ground truth, not against ourselves.** [test/](../test/)
takes truth from the live DOM (`Range.getBoundingClientRect()` of real text on a
real page) and from the window server, then checks the pipeline against it. A
test that can pass when nothing was captured is a broken test — assert a minimum
match count.

**Prefer deleting a mechanism over adding a correction to it.** The panel used
to chase the window and correct for misplacement; removing the chase removed the
whole class of bug. Ask whether the compensation exists because the design is
racing something.

## Code style

### General
- Match the density and idiom of surrounding code. No reformatting drive-bys.
- Fix the general case; don't accumulate special cases.
- Keep the "capture only the target window" guarantee visible in any code that
  touches filters. It is a privacy property, not an implementation detail.

### Swift ([ocr/Sources/](../ocr/Sources/))
- Single file, no package manifest — built with
  `ocr/build.sh`.
- 4-space indent, ~90 column soft limit.
- Emit **NDJSON**, one object per line, `fflush` after each. stdout is data;
  stderr is diagnostics.
- Long string interpolations must be split into locals — the type-checker times
  out on big concatenations (it has, twice).
- Every capture path returns a `Capture` carrying its own geometry. Never let
  geometry be implied by a caller's assumption.

### JavaScript (main + renderer)
- CommonJS, 2-space indent, semicolons, single quotes.
- `contextIsolation: true`, `nodeIntegration: false`. The renderer reaches the
  main process only through the narrow surface in [app/preload/overlay.js](../app/preload/overlay.js);
  treat everything crossing IPC as untrusted.
- Heavy/synchronous work (SQLite) lives in the main process so hover never janks.
- Renderer logs go to the main log via the `console-message` hook — use them,
  they are the only visibility into a hidden panel.
- Diagnostics that earned their keep stay in (`layer@`, `[win] target frame`);
  temporary instrumentation comes out before finishing.

### Python (build scripts)
- Stdlib only, 4-space indent, module docstring explaining the data shape it
  consumes.
- Dictionary parsing is per-format and explicit. When adding a dictionary,
  add its shape to `flatten_glossary` — don't loosen the generic walker.

## Workflow

- **Deploying a change = quit and relaunch the app.** No rebuild. See
  [ARCHITECTURE.md](ARCHITECTURE.md) §6.
- Rebuild `yomi` with `ocr/build.sh`.
- Rebuild the app bundle (`tools/build-app.sh`) only when `bootstrap.js`,
  `extend.plist`, the icon, or the Electron version changes.
- Re-run `tools/build-index.py` after adding dictionaries to `data/dicts/`.
- Before claiming a geometry fix works, run [test/](../test/) — all three suites.
  They need the overlay **stopped** (its watch loop holds a ScreenCaptureKit
  session that stalls one-shot captures) and the rig's windows on the active
  Space.

## Gotchas that will bite again

- Concurrent SCK sessions: a running overlay makes one-shot `yomi` captures
  hang. Stop the app before testing.
- Ordinary windows cannot join another app's fullscreen Space; a test rig that
  must be visible there needs `type: 'panel'` + `visibleOnFullScreenScreen`.
- A Space transition animates: capturing mid-slide reads a transient x. Let it
  settle before asserting.
- GUI apps cannot be launched from the agent shell — ask the user to relaunch.
</content>
