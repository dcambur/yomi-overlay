# What it costs to add code here

[CONVENTIONS](CONVENTIONS.md) says how to write code in this project. This says
how much of it to write, and where to put it. The two rules that matter:

> **A change should be the size of the problem, not the size of the idea.**
>
> **Code you add is code someone maintains forever. Code you delete is free.**

## The budget

There is no line limit, but there is a ratio to notice. An *optimisation* that
touches existing behaviour should be small — it is changing how something
already works, not adding a thing. If a "make it faster" change is coming out
at hundreds of lines, some of it is a feature wearing a performance costume.
Separate them and judge each on its own.

Worked example, and the reason this file exists. A capture-loop optimisation
came out at ~900 lines. Split up:

| Change | Code | Fired in real use? |
|---|---|---|
| Cache the window enumeration | ~110 lines | every pass |
| Gate the second OCR engine on unread ink | ~150 lines | every changed pass |
| Shorter wait after new text | ~15 lines | every page turn |
| Faster payload building | ~50 lines | every payload |
| **Re-read only the changed band of a page** | **~350 lines** | **never** |

The last one was a feature, not an optimisation. It was well built, bounded,
and tested — and on real pages it could not fire, because a page turn changes
the whole frame. It was deleted. The first four stayed and did the work.

## Three questions before adding a mechanism

**1. Does it fire?** Not "would it help" — does it actually run, on real input,
in the log? Add the diagnostic first, watch it in `/tmp/yomi-overlay.log`
during real use, and only then decide whether the mechanism is worth building.
A mechanism that never triggers is worse than nothing: it is maintenance cost
with no benefit and a bug surface with no coverage.

**2. Can an existing mechanism answer it?** Two functions walking the same
buffer, two fields doing "print only when this changes", three copies of an
emit branch — each looked local and reasonable when written. Grep for the verb
before writing it.

**3. Would deleting something achieve the same thing?** See CONVENTIONS,
"prefer deleting a mechanism over adding a correction to it". The panel stopped
chasing the window and a whole class of bug went with it.

## Where a new thing goes

The layout is a pipeline, so the question "where does this live" has one
answer: **the stage that owns the data at that moment.**

```
ocr/Sources/
  CLI/           one file per subcommand; argument parsing
  Capture/       which window, and pixels + truthful geometry
  Recognition/   the engines, the policy choosing between them, per-run state
  Geometry/      coordinate spaces and pixel primitives (no recognition)
  Model/ Output/ what a recognised page is; the NDJSON contract
app/
  main.js        wiring only — no module-scope mutable state
  main/          one module per concern, verb-shaped surface, deps as arguments
  renderer/      one IIFE per file exposing one window namespace
  preload/       the entire trust boundary
```

Rules that follow from it:

- **One caller means it lives with its caller.** Do not create a file to hold a
  function until a second stage needs it.
- **Per-run state goes on `RecognitionSession`**, never at file scope — a
  global cannot be constructed by a test.
- **New CLI flags are a cost.** Each one is a code path nothing runs by
  default. Add one only as a documented revert for a risky change
  (`--engine vision`) or as instrumentation that pays for itself
  (`--dump`, `--assume-horizontal`). Delete it when the risk is retired.
- **Test-only paths do not live in the production binary** unless they exercise
  a path production actually takes, and they drift the moment they don't.

## Naming

Extends "name the problem, not the mechanism" in CONVENTIONS. The patterns
already in use, so new code matches:

| Kind | Shape | In use |
|---|---|---|
| Function that answers a question | verb or predicate | `chooseWindow`, `stillVisible`, `worthAVerticalRead`, `looksPicketFence` |
| Function that transforms | `<verb><noun>` | `recognizeAuto`, `buildPayload`, `mapFlatLines`, `stripFurigana` |
| Type that is a thing on the page | the thing | `Line`, `CharBox`, `Capture`, `Geometry`, `TargetWindow` |
| Tuned constant | what it bounds, not its value | `IDLE_HIDE_MS`, `LAYOUT_EPSILON_PX`, `verticalReadInkFloor` |
| Boolean | reads true/false in an `if` | `vertical`, `unchanged`, `interactive` |

Avoid: `data`, `info`, `result`, `handle`, `process`, `manager`, `util`,
`helper`, and any name that would still fit after the function's job changed.

A tuned number gets a named constant **and** the measurement that produced it.
A number with no name and no citation will be "cleaned up" by someone later:

```swift
/// A cell is 8 pixels square. A vertical banner worth recovering — 30x200 px —
/// covers ~100 cells of which roughly a third carry ink, so 24 clears it with
/// margin while a scrollbar does not.
let verticalReadInkFloor = 24
```

## Comments

CONVENTIONS covers what a comment must say. What it must not do is repeat
[ARCHITECTURE](ARCHITECTURE.md). A load-bearing decision is explained once, in
ARCHITECTURE, and the code carries a one-line pointer to it plus the local
measurement. Prose duplicated in both places goes stale in one of them.

## Reviewing your own change

Before opening a PR, run the diff through this:

```bash
git diff origin/main HEAD --stat
git diff origin/main HEAD -- '*.swift' '*.js' '*.py' \
  | grep '^+' | grep -vcE '^\+\+\+|^\+\s*(//|///|$)'
```

The second number is added source lines, comments and docs excluded. If it surprises you, find
the largest single mechanism in the diff and ask the three questions above
about it. Then check the gates: `test/golden.sh check`, `test/unit/run.sh`,
`test/cer.py` if recognition moved, and `tools/check-conventions.sh`.
