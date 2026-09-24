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

Fix: correct the claim in setup.sh. **Not** worth adding a retry for — the
existing supervision already handles it, and per CONVENTIONS.md, deleting a
mechanism beats adding a correction to one.

Uncertain: whether the trigger is the cdhash, the path change
(`reader/kindleocr` → `reader/bin/kindleocr`, as it was then named), or both. Both changed in the
same step. To separate them, restore a previously-run binary at the *new* path
and relaunch: if it captures first try, the cdhash is the trigger.
