# Architecture

Yomi Overlay puts a Yomitan-style popup dictionary over *any* macOS window by
reading pixels, not text. Nothing touches the source file and no DRM is
involved — it recognises what is already on screen.

```
kindleocr (Swift CLI)                Yomi Overlay (Electron)
  pick target window                   display-sized transparent NSPanel
  capture ONLY that window             one invisible <span> per glyph
  Vision OCR (ja-JP)          ──▶      Shift/click → lookup → popup
  per-glyph boxes, NDJSON                      │
  global shift/click monitor                   ▼
                                       index.db (SQLite) + Yomitan deinflector
```

| File | Role |
|---|---|
| [ocr/Sources/](../ocr/Sources/) | window selection, capture, OCR, per-glyph geometry, window enumeration, global event monitor |
| [app/main.js](../app/main.js) | panel, child-process supervision, tray, settings, IPC, permissions |
| [app/renderer/index.html](../app/renderer/index.html) | glyph layer, hit-testing, popup show/dismiss state |
| [app/renderer/popup.js](../app/renderer/popup.js) | popup presentation only (markup, pitch graphs, placement) via `window.popupView` |
| [app/main/lookup.js](../app/main/lookup.js) | multi-length lookup + Yomitan deinflection (main process: `node:sqlite` is sync) |
| [tools/build-index.py](../tools/build-index.py) | Yomitan zips → `index.db` + `dictionaries.json` |
| [app/shell/bootstrap.js](../app/shell/bootstrap.js) | the *entire* app bundle; loads real code from this directory |
| [test/](../test/) | deterministic alignment/selection suites |

## The load-bearing decisions

Each of these was paid for with a bug. Changing one without understanding why
it exists will reintroduce that bug.

### 1. Capture geometry comes from measured pixels, never from a window's frame

macOS reports **stale bounds for fullscreen windows**. Measured: a fullscreen
Chrome window returned 1440×900 from `screencapture -l<id>` while both
`CGWindowList` and `SCWindow.frame` insisted on 1440×778 at y=122.

So:

- Capture is **display-scoped with all other windows excluded**. Still only the
  target's pixels (guarantee preserved by the filter), but not routed through
  the window's own rect.
- Such a capture composites the window at the **image origin, 1:1** (verified by
  dumping a capture of a window at (300,200): its top-left glyph landed at 0,0).
  Normalising against the display rect therefore yields *undistorted
  window-local* coordinates.
- The window's true **origin** is recovered by measuring the capture's content
  extent through the **alpha channel** — with every other window excluded, only
  the target is opaque, so the extent is the window's true size. Covers a
  display ⟹ it is that display's fullscreen occupant ⟹ origin is the display's.

A window-scoped filter instead scales content into the stale rect, skewing every
glyph by the full offset at the top of the window and zero at the bottom —
invisible while windowed, wrong in every fullscreen app and every game.

**`--dump PATH` writes the actual captured frame to a PNG.** What SCK hands back
cannot be inferred, only looked at. Reach for it first when geometry looks wrong.

### 2. Window selection follows the window server's active-Space list

`SCWindow.isOnScreen` returns true for windows on *inactive* Spaces. Trusting it
made the overlay track a windowed browser on Space 1 while the user read the same
site fullscreen on Space 2 — the page matched, so lookups "worked", but every
glyph was displaced.

`chooseWindow()` therefore takes candidates from
`CGWindowListCopyWindowInfo(.optionOnScreenOnly)` (front to back, active Space
only), requires ≥50% of the window to be on a display (the server parks
other-Space windows off-desktop, clamped to leave a sliver that still
"intersects"), and picks the frontmost. If nothing qualifies it reports
**nothing** rather than adopting a window the user cannot see.

"Visible" includes **not buried**. Capture excludes every other window (§1), so
a target with another app parked on top of it still yields pristine pixels: on
screen, on the active Space, fully hidden from the user. The overlay kept
painting its glyph layer and popups over whatever the user switched to. So the
same 50% test also subtracts the ordinary windows the server is compositing in
*front* of the candidate — sampled on a 20×20 grid, because overlapping
occluders double-count in an area sum. Measured against a rig (window A
800×600, window B raised over it): fully covered ⟹ no window reported;
B over A's right half ⟹ A still tracked, `covers` `[{400,0,400×600}]`; B in a
corner ⟹ `[{580,180,220×300}]`; B moved away ⟹ `[]`.

Only **layer 0** counts as an occluder. The menu bar, the Dock, notification
banners and the overlay's own panel (screen-saver level) sit above every
ordinary window and would report every target as buried. Transparent windows
hide nothing, so alpha ≤ 0.05 is skipped too (measured: a 1440×32 alpha-0
strip above a Claude window).

Partial cover is not a reason to hide — half a page is still readable — so the
regions ride along in every payload and heartbeat as `covers`, frame-local, and
the renderer refuses lookups inside them. A glyph that is behind another window
is not text the user can point at.

### 3. "Not visible" is measured between passes, not inferred from a gap

The panel joins every Space — the only way an overlay can float over a reader in
native fullscreen — so from the moment you swipe to another desktop it is drawn
over whatever is there: glyph layer, open popup and all. It leaves only when
this pipeline says the target is gone.

That used to be *inferred* — "captures only succeed while the reader's Space is
active, so a gap in payloads means it is not on screen" — with an 8s timeout on
the gap. Eight seconds of the overlay sitting on top of the music player you
swiped to, popup included.

So it is measured instead, and the check is deliberately the cheap one:
`stillVisible(id)` re-runs the §2 test from `CGWindowList` alone — no
`SCShareableContent`, no capture, 0.5ms measured — so the watcher can ask
it every 150ms *while it waits out the interval*, not just at the top of the
next pass. Leaving the active Space and being covered are the same question:
the window server stops listing a window on another Space at all.

A failed check emits the `idle` marker, and `main.js` hides on the marker
immediately (**not** after `IDLE_HIDE_MS`, which is now only the backstop for a
watcher that has gone silent altogether) and tells the renderer to drop the
popup with it. Measured: 0.15s from the target disappearing to the marker,
against 0.7s for the next heartbeat and 1.3s for the next OCR pass — and
against never, when the window was merely covered.

### 4. The panel never chases the target window

It is pinned once to the display and never moved. The renderer places the glyph
layer at `target frame − its own window.screenX/screenY`.

Moving the panel per-frame is a race with the window manager: moves apply
asynchronously, panels get clamped into the work area, and `getBounds()` can
report a position the server never honoured (observed: asked y=122, placed y=60).
Any offset derived from what was *asked for* drifts by exactly the discrepancy.

### 5. The glyph layer rebuilds only on real change — measured against the DOM

Vision is nondeterministic: the same static page recognises as 80 lines one pass
and 77 the next. Rebuilding per capture yanks spans out from under the cursor.

Rebuild when <85% of lines are shared with **what is actually built**, or when
geometry moved >3px. `contentSig` must keep describing the DOM: advancing it
while keeping old spans lets drift ratchet — a rotating carousel changes ~10% of
lines per step, every step stays >85% similar to the *previous* step, and the
layer ends up describing content several rotations gone.

The gate is bounded at three consecutive refusals. When a mostly-static line
set dominates the count, the changed part can never cross 15%: a game HUD held
14 of 16 lines while the dialogue box changed, so every payload sat ~88%
similar to the stale layer forever and lookups on the new text hit nothing
(measured 2026-08-09; only a manual capture restart recovered). Jitter on a
static page periodically matches the DOM exactly, resetting the streak; three
misses in a row is real change and forces the rebuild.

### 6. The app bundle contains only a loader

macOS keys Screen Recording and Accessibility to the app's designated
requirement. The bundle holds only `shell/bootstrap.js`, which loads `main.js`
from the project directory at launch. Ordinary code changes need a **restart, not
a rebuild**, and the bundle's hash never moves. A stable self-signed certificate
(created by [setup.sh](../setup.sh)) makes the requirement certificate-based so even
a real repackage keeps the grants.

**Deployment is: quit the app, relaunch.** Nothing else. This includes a rebuilt
`kindleocr` and a rebuilt `index.db`.

### 7. Two permissions, different failure modes

| Permission | Needed for | Without it |
|---|---|---|
| Screen Recording | all capture | nothing works; dialog on launch |
| Accessibility | global Shift/click trigger | silently degrades to Shift **+ mouse movement** |

The Accessibility degradation is invisible — the monitor runs, the log is clean,
Shift just does nothing when held still. `systemPreferences.isTrustedAccessibilityClient(false)`
detects it and the tray says so.

### 8. Structure is extracted at index time, not at render time

Yomitan dictionaries ship recursive `structuredContent` trees. `build-index.py`
parses each dictionary's actual markup (JMdict sense nodes, 三省堂 語義/語釈,
plain-text line formats) rather than walking every string — a naive walk yields
「き」「ぞく」「［」 as separate "senses" and truncates the real definition away.
`rt` (ruby) nodes are skipped or 迷惑 becomes "迷 めい 惑 わく".

The popup renders per **dictionary kind** (bilingual / monolingual / grammar /
names / kanji): bulleted English for bilingual, own ①❶ numbering with hanging
indent for monolingual, labelled 音/訓 rows for kanji.

## Data flow, one pass

1. `kindleocr --json --watch` picks the frontmost active-Space window of the
   target, captures, hashes the frame, and skips OCR when nothing moved
   (emitting an `unchanged` heartbeat so "static page" ≠ "window gone").
   When no window qualifies it emits an `idle` marker instead of going silent
   — main.js hides on it at once, and can tell "target off screen" from
   "watcher wedged" so its 2-minute watchdog only restarts the latter. The same
   marker is emitted mid-interval by the between-pass visibility check (§3). Discovery (`SCShareableContent`) is raced against the same 12s
   deadline as capture; a stalled call once produced 40 minutes of
   indistinguishable silence (measured 2026-08-09).
2. Emits `{frame, covers, window, lines:[{text, chars:[{c,x,y,w,h}]}]}` —
   `frame` is the coordinate origin (true origin + measured size); `covers` are
   the frame-local regions another window is drawn over (§2); `window` is the
   window's own self-report, diagnostics only.
3. `main.js` keeps the panel on the right display, ships the frame origin and
   the cover regions on every pass (heartbeats included — both change while the
   text does not), and forwards changed payloads.
4. The renderer positions the layer, rebuilds spans if the page really changed,
   and hit-tests `elementFromPoint` on Shift-hover — refusing points inside a
   cover region, and dropping a popup whose word has just been buried.
5. `lookup.js` deinflects and looks up EVERY prefix (12→1 glyphs) against
   `index.db`, Yomitan-style: each hit becomes a headword group, ordered by
   source length desc → fewest deinflection steps → frequency → term score
   (reimplementing Yomitan's `_sortTermDictionaryEntries` chain, not porting
   it). The longest match drives the highlight; `popup.js` renders all
   groups, scrolling instead of truncating.

### 9. Tategaki is re-flowed, never rotated

Vision cannot read vertical Japanese at all (measured: 189 chars on a real
vertical page, 0 recognised), and rotating the page does NOT fix it — the
columns become horizontal but every glyph is then on its side, and Vision
recognises nothing either way. Instead the pipeline segments columns and
character cells from an ink mask, composes the upright cells into a horizontal
strip, recognises that, and maps each character back to its source cell by its
position in the strip. Orientation is auto-detected (try horizontal; probe
vertical when it yields nothing) and sticky across watch passes.

Two traps encoded in the implementation, both paid for:
- Cells come from ink runs, not fixed pitch — line spacing is a reader setting,
  and pitch-slicing cut glyphs in half.
- Strip-position mapping, not string-index — Vision drops/merges characters,
  and index mapping shifted every glyph after the first discrepancy.

## Known gaps

- **Tategaki on real reader apps is young** — the engine passes the DOM-truth
  suite (95% coverage / 77% placement) but has not yet been validated against
  real Kindle pages with furigana. See [PLAN.md](PLAN.md) Stage 1 remainder.
- Per-glyph boxes are interpolated inside Vision's *word*-level boxes under
  `.accurate`; alignment is always slightly approximate.
- Words split across a line break can't be looked up as one unit.
- No Anki export yet.
</content>
