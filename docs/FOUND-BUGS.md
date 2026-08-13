# Found while refactoring

Things noticed in passing that are **behaviour changes**, so they must not ride
along in a structural commit (REFACTOR-INTEGRATION.md: move code, or change
code, never both). Each needs its own commit, and the last two want a
measurement before anyone touches them.

---

## 1. `"capture recovered after N failure(s)"` is unreachable in watch mode

[ocr/Sources/Entry.swift:446](../ocr/Sources/Entry.swift#L446)

The recovery notice sits *after* the `if opts.json { … continue }` block, so
the JSON watch path — which is the only path the overlay ever uses — reaches
`continue` first and never prints it. `failures` is therefore also never reset
to 0 in watch mode, so the "log the 1st failure, then every 10th" throttle
drifts: after a transient failure, the next one logs as `2x` rather than `1x`.

Cost of the bug: when diagnosing a capture problem you cannot tell "failed once
and recovered" from "still failing", because only the failures are ever
visible. Measured 2026-08-13 while diagnosing exactly that: a single `-3811` at
09:24:01 was indistinguishable in the log from an ongoing outage, and the
question had to be answered with `--list-all` instead.

Fix: move the recovery check above the JSON branch, or emit it from both. Cheap
and low-risk, but it changes stderr, so the golden-master baseline must be
re-recorded in the same commit.

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
that is arguably the right outcome. What is wrong is the documentation: someone
debugging a fresh `-3801` will read setup.sh and conclude the grant was lost.

Fix: correct the claim in setup.sh. **Not** worth adding a retry for — the
existing supervision already handles it, and per CONVENTIONS.md, deleting a
mechanism beats adding a correction to one.

Uncertain: whether the trigger is the cdhash, the path change
(`reader/kindleocr` → `reader/bin/kindleocr`, as it was then named), or both. Both changed in the
same step. To separate them, restore a previously-run binary at the *new* path
and relaunch: if it captures first try, the cdhash is the trigger.
