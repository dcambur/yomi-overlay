# Deterministic alignment & selection tests

Verifies the full pipeline against ground truth, no eyeballing:

1. **Selection** — two same-bundle, same-size Electron windows; asserts
   kindleocr follows the *frontmost* as z-order flips (the multi-Chrome-window
   failure mode).
2. **Alignment** — window A loads the real kakuyomu.jp homepage; ground truth
   is the live DOM (`Range.getBoundingClientRect()` of actual text nodes —
   real fonts, logos, carousel noise). Every OCR glyph box must match its DOM
   position. Duplicate-text probes are dropped (can't be asserted against a
   single position).
3. **Scroll** — scroll 900px, re-extract DOM truth, re-assert.
4. **E2E** — runs the actual overlay pinned to the kakuyomu window and asserts
   the rendered layer position (the renderer's `layer@` log line) against an
   independent OCR pass. Backs up and restores `overlay/config.json`.

Run:

```
cd test
env -u ELECTRON_RUN_AS_NODE ../overlay/node_modules/.bin/electron . &   # opens 2 windows
python3 verify.py                                                       # ~1 min
curl -s http://127.0.0.1:43199/quit                                     # tear down
```

Needs: built `../kindleocr`, network (loads kakuyomu.jp), Screen Recording
granted to the terminal's host app. The overlay app should not already be
running (E2E launches its own instance; single-instance lock would fire).

`page.html` is the older synthetic target (fixed-position probes at known
coordinates) — kept for offline runs; point `main.js` at it instead of
kakuyomu if the network is unavailable.
