# Found while refactoring

Things noticed in passing that are **behaviour changes**, so they must not ride
along in a structural commit (REFACTOR-INTEGRATION.md: move code, or change
code, never both). Each needs its own commit, and a measurement before anyone
touches it. A fixed entry is deleted, and its number is not reused: 1, 3 and
4 were fixed on 2026-09-24 (the commits say how).

---

## 2. Rebuilding `yomi` costs one denied capture

[setup.sh](../setup.sh) claims:

> TCC attributes both Screen Recording and Accessibility to the *responsible
> app* (Yomi Overlay), not to the yomi child it spawns — so rebuilding
> yomi costs nothing either.

Almost right. Measured 2026-08-13: after `ocr/build.sh` produced a binary with
a new ad-hoc cdhash (`ef965068…` → `6123449e…`), the first capture of the next
app launch failed with

```
SCStreamErrorDomain Code=-3801 "The user declined TCCs for application, window, display capture"
```

`yomi` exited 1, the supervisor restarted it, and the error did not recur
— on that launch or the next. So the grant does survive a rebuild, but the
first attempt against a never-before-seen child binary is refused.

This is invisible in practice because the restart-with-backoff absorbs it, and
that is arguably the right outcome.

**And its first read is slow.** Measured 2026-09-24: a freshly built binary's
first recognition took 64 s (29 s on another build), the second 1.5 s — the
process sits in Apple's ANE compiler, compiling Vision's text model for the new
binary, once. So after `ocr/build.sh` the overlay shows nothing for up to a
minute. The screen test lane warms a new helper once for the same reason
(test/run.sh). Whether a release update pays it on a user's first launch is
not measured. What is wrong is the documentation: someone
debugging a fresh `-3801` will read setup.sh and conclude the grant was lost.

setup.sh's claim is corrected (2026-09-25), and the menu-bar item says
"Starting capture… the first read after an update takes a minute" once ten
seconds pass without one. **Not** worth adding a retry for — the existing
supervision already handles the refusal, and per CONVENTIONS.md, deleting a
mechanism beats adding a correction to one. What stays open is the
uncertainty below.

Uncertain: whether the trigger is the cdhash, the path change
(`reader/kindleocr` → `reader/bin/kindleocr`, as it was then named), or both. Both changed in the
same step. To separate them, restore a previously-run binary at the *new* path
and relaunch: if it captures first try, the cdhash is the trigger.

---

## 5. A window whose top rows are clear is read as drawn lower than it is

Found reviewing 70e189d (measure where the window was drawn). `contentRect`
takes the first opaque row and column of a capture for where ScreenCaptureKit
drew the window, and subtracts it from every glyph. A window whose own leading
rows are alpha 0 has its first opaque row where its *content* starts.

Measured 2026-09-25 on the invisible display: an Electron window at (300,150),
`transparent: true`, `backgroundColor: '#00000000'`, its text in a white block
60 px down. The capture's opaque rows began at 60; the payload's frame was
1000x620 for a 1000x700 window, and 吾 came back at y=48 where the page has it
at y=110 — every glyph 62 px high. (`transparent: true` alone is not enough:
Electron still paints the window white, and nothing shifts.)

Not fixed, on purpose. The obvious correction — take an edge only where the
window's offset on the display says it could have been drawn — was written and
measured against, and does not hold: in two captures of this setup SCK drew one
window at the image origin and another at its own offset (y=149 for 150). A
window drawn at its offset *and* starting with a clear band puts its first
opaque row at offset + band, which that rule gets wrong by the offset. The
readers this app targets (Kindle, browsers, PDF viewers, games) draw opaque
title bars or content at the top, so none has hit it.

To take it further: find a real target with clear leading rows, `--dump` its
captures a few times, and see where SCK draws it. The bottom edge against the
window's own height (known and correct for a window that is not fullscreen) is
the measurement a fix would most likely rest on.
