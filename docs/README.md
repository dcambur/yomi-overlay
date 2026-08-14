# Docs

Read in this order. The first two are not optional if you are going to change
anything.

| | What it is | Read it when |
|---|---|---|
| **[ARCHITECTURE](ARCHITECTURE.md)** | How the pieces fit, and the nine **load-bearing decisions** — each paid for with a real bug | Before changing anything. Especially before "simplifying" something that looks wrong |
| **[CONVENTIONS](CONVENTIONS.md)** | House style and the principles behind it: measure don't infer, no per-app special cases, degrade honestly, move-or-change-never-both | Before writing code, and before deleting a comment |
| **[GROWTH](GROWTH.md)** | How much code to add, where it goes, what to name it — and the "does it fire?" test a new mechanism has to pass | Before adding a mechanism, and before opening a PR |
| **[RELEASING](RELEASING.md)** | How a PR title becomes a version, and how to move each digit | Before opening a PR, and when you want a release to happen (or not) |
| [PLAN](PLAN.md) | The staged roadmap and what is already done | Before proposing work — several obvious-looking items are finished |
| [FOUND-BUGS](FOUND-BUGS.md) | Bugs found while refactoring and deliberately left, with the measurement | Before "fixing" one of them, or when one bites you |
| [INTEGRATION](INTEGRATION.md) | The design record for the OCR accuracy phases: Live Text, voting, tier-2, furigana. Why each is shaped the way it is | When touching recognition. It explains decisions, not current line numbers |
| [history/](history/) | The 2026-08 restructure: the diagnosis, and the plan executed against it | Only for archaeology — or for the one item it left unfinished |

## The short version, if you read nothing else

- **Deploying a change = quit and relaunch the app.** No rebuild. The bundle
  contains only a loader; the real code loads from this directory
  (ARCHITECTURE §6).
- **Rebuild the OCR helper** with `ocr/build.sh`.
- **Before a structural change to the Swift**, record `test/golden.sh` and
  require byte-identical output after. It needs no permission and no window.
- **`test/unit/run.sh`** runs in ~3 seconds and needs nothing. Run it.
- **When geometry looks wrong, don't theorise.** `bin/yomi --dump /tmp/x.png`
  and *look* at the image; compare `[win] target frame` in
  `/tmp/yomi-overlay.log` against `bin/yomi --list-all`; check whether the
  target is on the active Space. ARCHITECTURE §1–4.
