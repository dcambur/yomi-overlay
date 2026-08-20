# Architecture

Yomi Overlay puts a Yomitan-style popup dictionary over *any* macOS window by
reading pixels, not text. Nothing touches the source file and no DRM is
involved — it recognises what is already on screen.

```
yomi (Swift CLI)                Yomi Overlay (Electron)
  pick target window                   display-sized transparent NSPanel
  capture ONLY that window             one invisible <span> per glyph
  Vision OCR (ja-JP)          ──▶      Shift/click → lookup → popup
  per-glyph boxes, NDJSON                      │
  global shift/click monitor                   ▼
                                       index.db (SQLite) + Yomitan deinflector
```

## Where things live

```
ocr/Sources/          the capture + OCR helper (Swift, one binary: bin/yomi)
  CLI/                argument parsing, one file per subcommand
  Capture/            window selection, capture geometry, the crop channel
  Recognition/        the two engines, orientation policy, voting, per-run session
  Geometry/           coordinate spaces, ink masks, tategaki reflow, furigana
  Model/ Output/      what a recognised page is; the NDJSON contract
app/
  main.js             wiring: builds the parts, connects them, handles shutdown
  main/               main-process modules (see below)
  renderer/           the overlay window: glyph layer, placement, popup, hud
  settings/           the settings window
  preload/            the entire trust boundary between renderer and Node
  shell/              the app bundle's ENTIRE contents — see section 6
  vendor/jp-verbs/    third-party deinflection tables
tools/                build scripts, bundle inputs, the path resolvers
data/  bin/           generated: index.db, dicts, venv, config / compiled helpers
test/                 unit (unattended) · golden (unattended) · verify (hands-on)
```

| Piece | Role |
|---|---|
| [ocr/Sources/Capture/](../ocr/Sources/Capture/) | which window, and turning it into pixels with truthful geometry (§1–2) |
| [ocr/Sources/Recognition/](../ocr/Sources/Recognition/) | Vision and Live Text, the policy choosing between them, temporal voting |
| [ocr/Sources/Geometry/](../ocr/Sources/Geometry/) | tategaki reflow (§9), furigana stripping, the shared ink primitives |
| [app/main/supervised-child.js](../app/main/supervised-child.js) | both helper processes: spawn, NDJSON, restart, watchdog |
| [app/main/overlay-window.js](../app/main/overlay-window.js) | the panel; pinning it to a display and telling the renderer where the target is (§4) |
| [app/main/tier2.js](../app/main/tier2.js) | the manga-ocr second opinion, shadow mode only |
| [app/main/ipc.js](../app/main/ipc.js) | every channel the renderer can use, and the validation on it |
| [app/main/lookup.js](../app/main/lookup.js) | multi-length lookup + Yomitan deinflection (main process: `node:sqlite` is sync) |
| [app/renderer/glyph-layer.js](../app/renderer/glyph-layer.js) | one span per glyph, and the rebuild gate (§5) |
| [app/renderer/popup.js](../app/renderer/popup.js) | how a result looks — markup, pitch graphs, placement |
| [app/shell/bootstrap.js](../app/shell/bootstrap.js) | the *entire* app bundle; loads the real code from this directory (§6) |
| [app/main/index-builder.js](../app/main/index-builder.js) | Yomitan zips → `index.db` + `dictionaries.json`, in the app (§8, §13) |
| [app/main/dictionaries.js](../app/main/dictionaries.js) | downloading and importing dictionaries (§13) |

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
`yomi` and a rebuilt `index.db`.

A **release** bundle ([tools/build-release.sh](../tools/build-release.sh)) also
carries a copy of the app and `yomi` in `Contents/Resources`, so it runs on a
machine with no checkout. No dictionary is bundled — see section 9. That copy is the
**last** candidate `bootstrap.js` tries, after `$YOMI_OVERLAY_DIR` and the
pointer file — so a developer's bundle still loads their working copy and
everything above holds unchanged. `paths.js` notices which happened (`BUNDLED`)
and splits what was one `data/` into two ideas: read-only material inside the
signed bundle, and the user's own config and index under Application Support.
In a checkout both resolve to `data/`, which is why nothing about development
moved.

### 7. Two permissions, different failure modes

| Permission | Needed for | Without it |
|---|---|---|
| Screen Recording | all capture | nothing works; dialog on launch |
| Accessibility | global Shift/click trigger | silently degrades to Shift **+ mouse movement** |

The Accessibility degradation is invisible — the monitor runs, the log is clean,
Shift just does nothing when held still. `systemPreferences.isTrustedAccessibilityClient(false)`
detects it and the tray says so.

### 8. Structure is kept, and rendered at display time

This reverses the decision that stood here before, and the reason is the
dictionaries nobody has seen.

The old builder flattened each glossary into sense strings while indexing, by
parsing each dictionary's actual markup — JMdict sense nodes, 三省堂 語義/語釈,
the plain-text line formats. That is genuinely better than walking every string,
which yields 「き」「ぞく」「［」 as separate senses, and it was right for as long
as every dictionary in the index was one somebody had taught the builder about.

Dictionaries are now imported by the user, including commercial ones that can
never ship with the app. A format the builder was never taught falls through to
exactly that naive walk. So the glossary is stored as its dictionary wrote it
and turned into DOM when a popup opens, the way Yomitan itself works — an
unknown dictionary renders because nothing was thrown away.

Two measurements shaped the storage. Verbatim structure cost **1,670 MB**
against the old flattened index's 322 MB, because every entry is indexed under
both its surface form and its reading, and that duplicated the glossary:
1,068 MB across 2,005,802 rows, of which only 463 MB was distinct. Deduplicating
into a `glosses` table and deflating each blob (structured JSON compresses to
about 35%) lands at **510 MB** — 188 MB more than flattening, for a format
nobody has to anticipate.

[app/renderer/structured.js](../app/renderer/structured.js) is written against a
census of what these dictionaries actually contain — 14 tags, 7 style
properties, two node types — not against the format in the abstract. Yomitan's
own generator is ~550 lines because it also carries their media pipeline, Anki
rendering and language detection. An **unrecognised tag is not dropped**: it
becomes a neutral inline or block element and its children still render.

The old flattener is the regression test. Whatever text it displayed, the
renderer must still display; `test/unit/structured.test.js` asserts that over a
fixed slice of 3,000 keys — 7,918 senses across eight dictionaries, none lost.
It is a subsequence check rather than a substring one, because the new rendering
carries *more*: the old builder dropped the bracketed headword 三省堂 prints
between a sense number and its text.

`lookup.js` reads either shape, decided once at `open()` by whether a `glosses`
table exists, so an index built by the old builder keeps answering.

**Images are deferred.** 三省堂 and 旺文社 reference SVGs inside their archives
(10,732 `img` nodes across the set here, only 35% carrying a usable title), and
the renderer CSP is `default-src 'none'` with no `img-src`. They currently
render as their alt text. Doing it properly means extracting media at import and
serving it through a narrow custom protocol.

The popup still renders per **dictionary kind** (bilingual / monolingual /
grammar / names / kanji): bulleted English for bilingual, own ①❶ numbering with
hanging indent for monolingual, labelled 音/訓 rows for kanji. Plain-string
glossaries keep that formatting; structured ones are built as DOM inside it.

## Data flow, one pass

1. `yomi --json --watch` picks the frontmost active-Space window of the
   target (reusing the previous pass's window enumeration unless the window
   set changed — §10), captures, hashes the frame, and skips OCR when nothing moved
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

### 10. One window enumeration per pass, invalidated by measurement

`SCShareableContent` costs ~150ms (measured: an enumerate-and-exit run takes
0.16s against a 0.01s process floor), and a pass used to pay it **twice** —
once to choose the window, once inside `captureOnce` to build the filter. That
was 0.3s of the ~0.9s between a page turn and the recognition that reads it,
spent deriving the same answer twice.

The result is now cached and invalidated by the **set of windows the server is
compositing**, which CGWindowList reports in 0.5ms. Not by a timer alone: a
window that appeared between two timed refreshes would be missing from the
exclusion list and composited straight into the capture, breaking §1's scoping
guarantee. (A 10s age limit rides along for what that list cannot express.)

Caching the enumeration makes `SCWindow.frame` stale, so **geometry now comes
from CGWindowList every pass** — the same list `stillVisible` already reads.
`TargetWindow` pairs the handle with this instant's frame. The one path that
resolves geometry through the handle itself, the `including:` fallback for
fullscreen Spaces that refuse the display filter (-3811), re-enumerates first.

### 11. The second engine runs only when the first left something unread

`verticalRemainder` — one Live Text pass over every committed-horizontal frame
— exists because Vision reads no vertical Japanese at all, so manga dialogue
and vertical banners simply vanish. It also **more than doubled** the cost of
every changed pass: 1.35s against the 0.85s Vision read it supplements
(37-line page), whether or not there was anything to merge.

It is now gated on whether Vision left any mark unaccounted for: paint every
recognised line box out of the page, and if what survives is smaller than about
two characters' worth of ink (24 mask cells) there is by construction nothing
for a second engine to find. Measured on 38 committed-horizontal ground-truth
pages: **identical text on all 38**, the vertical read skipped on 34, 0.69s →
0.35s per page. On a full clean page, 1.8s → 0.83s.

The mask is NOT `inkMask`, which asks "where is the dark ink" for column
segmentation and is calibrated dark-on-light. Reusing it marked an entire
dark-mode block as ink — 671 of 3,133 cells survived as "unexplained" when
every one was background — and the reader's own dark mode would have defeated
the gate on every page. `standoutMask` takes a background per tile instead, so
both polarities and a mix of them work.

### 12. After real new text, look again immediately

The frame a pass recognises was captured before the recognition ran, so the
payload describes pixels up to a whole pass old (p50 2.2s on a real Kindle
page). Someone who just turned a page is often about to turn another. A pass
that emitted *new text* therefore waits 0.1s instead of the full interval,
bounded at three in a row so an animated page cannot pin the recogniser. Pixels
that move while the text does not are already a heartbeat, not new text, so
they never take this path.

### 13. The app ships with no dictionary

A release bundle carries the app and the capture helper and nothing else. The
dictionaries worth having are either a large download or licensed so they cannot
be redistributed, and a release that shipped one would be publishing it.

So [app/main/dictionaries.js](../app/main/dictionaries.js) fetches the
recommended free set on request — the same sources Yomitan recommends, resolved
at download time rather than pinned, because `jmdict-yomitan` rebuilds daily and
Kuuuube keeps old versions beside new — and imports a `.zip` the user already
owns. Both paths validate that the file really is a Yomitan archive before it is
given a name, so a 404 page cannot install itself as a dictionary.

Indexing runs in a forked worker (`ELECTRON_RUN_AS_NODE`, so it is the same
binary). `node:sqlite` is synchronous and a full rebuild is ~80 seconds; in the
main process that would freeze the tray, the settings window and the overlay
panel, which is drawn over whatever the user is reading.

Adding a dictionary rebuilds the index. **Removing one does not** — it deletes
that dictionary's rows. The earlier claim here, that a rebuild must be total
because frequency ordering is global, was wrong: frequency rows carry the
`source` they came from, so removing one dictionary cannot disturb another's
ranking, and nothing is recomputed across dictionaries. Measured on a
two-million-row index: 930 ms to delete the terms and 1,665 ms to drop the
glossaries nothing points at any more, against ~80,000 ms to rebuild.

That is why every table carries a `dict` column and why `idx_terms_gloss`
exists — without it the orphan sweep is 4,192 ms rather than 1,665 ms. An index
built before those columns existed cannot be pruned, says so, and is rebuilt
instead. `test/unit/prune.test.js` asserts the equivalence that justifies all of
it: an index with a dictionary pruned out holds exactly what an index built
without that dictionary holds, table by table.

Everything except lookups works before a dictionary exists — capture, OCR and
the glyph layer do not depend on one.

## Known gaps

- **Tategaki on real reader apps is young** — the engine passes the DOM-truth
  suite (95% coverage / 77% placement) but has not yet been validated against
  real Kindle pages with furigana. See [PLAN.md](PLAN.md) Stage 1 remainder.
- Per-glyph boxes are interpolated inside Vision's *word*-level boxes under
  `.accurate`; alignment is always slightly approximate.
- Words split across a line break can't be looked up as one unit.
- No Anki export yet.
</content>
