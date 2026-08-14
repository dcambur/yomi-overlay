# Tests

Three groups, by what they need to run:

| Suite | Needs | Runs unattended |
|---|---|---|
| `unit/run.sh` | nothing | ✅ yes |
| `golden.sh` | a built `bin/yomi` | ✅ yes |
| `verify*.py` | Screen Recording, a live desktop, network | ❌ no |

## Unattended: `unit/run.sh`

No permission, no window, no network — safe while the overlay is running.

```
test/unit/run.sh            # everything
test/unit/run.sh node       # pure-logic suites only
```

- **`*.test.js`** — lookup (deinflection, multi-length grouping, the ranking
  chain, the kanji fallback, NFKC), the index builder, dictionary
  install/import/removal, both index schemas, structured-content rendering,
  the settings dictionary list, the OCR child process and config sanitising.

  **No dictionary is needed and none is read.** `unit/fixtures/` writes the
  Yomitan archives each suite wants — index.json and bank files in a zip it
  builds itself — so the suites run in a fresh clone and on a runner, which is
  what they are for. They used to read `data/dicts/`, which is gitignored and
  largely commercial: everywhere but this laptop they skipped, and "all green"
  meant "all absent". Add a case by generating the dictionary that shows it
  (`make-dictionary.js`), never by adding a file to `data/`.

  `fixtures/legacy-index.js` is the exception that proves it: `lookup.js` must
  keep reading indexes built by `tools/build-index.py`, so that test builds one
  by calling the old builder's own loaders. It needs `python3`, and says so
  when it skips.
- **`renderer.js`** — the glyph layer driven as a black box in a *hidden*
  Electron window, through the real preload and the real IPC channels, with
  payloads captured from the ground-truth corpus. Covers the rebuild gate
  (ARCHITECTURE §5): identical / similar-and-refused / bounded-refusal escape
  / page turn / re-layout / voted-patch-in-place, plus placement, reset,
  dismiss and cover refusal.

  The trick that makes rebuilds observable from outside: a rebuild does
  `layer.innerHTML = ''`, so a property set on a live span survives if and only
  if the layer was *not* rebuilt.

## Unattended: `golden.sh`

Byte-exact regression net over `bin/yomi --image`. See the header of the
script.

## Hands-on: the alignment & selection suites


Verifies the full pipeline against ground truth, no eyeballing:

1. **Selection** — two same-bundle, same-size Electron windows; asserts
   yomi follows the *frontmost* as z-order flips (the multi-Chrome-window
   failure mode).
2. **Alignment** — window A loads the real kakuyomu.jp homepage; ground truth
   is the live DOM (`Range.getBoundingClientRect()` of actual text nodes —
   real fonts, logos, carousel noise). Every OCR glyph box must match its DOM
   position. Duplicate-text probes are dropped (can't be asserted against a
   single position).
3. **Scroll** — scroll 900px, re-extract DOM truth, re-assert.
4. **E2E** — runs the actual overlay pinned to the kakuyomu window and asserts
   the rendered layer position (the renderer's `layer@` log line) against an
   independent OCR pass. Backs up and restores `data/config.json`.

Run:

```
cd test
env -u ELECTRON_RUN_AS_NODE ../app/node_modules/.bin/electron . &   # opens 2 windows
python3 verify.py                                                       # ~1 min
curl -s http://127.0.0.1:43199/quit                                     # tear down
```

Needs: built `../bin/yomi`, network (loads kakuyomu.jp), Screen Recording
granted to the terminal's host app. The overlay app should not already be
running (E2E launches its own instance; single-instance lock would fire).

`page.html` is the older synthetic target (fixed-position probes at known
coordinates) — kept for offline runs; point `main.js` at it instead of
kakuyomu if the network is unavailable.
