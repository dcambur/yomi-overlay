# Sentence explanation — design (⌘E)

A second action next to the dictionary lookup: point at a sentence, press ⌘E,
and the popup shows a translation, a word-by-word gloss and the grammar,
produced by Claude through [bot-api](../../bot-api) (`claude -p` on the user's
subscription). It is deliberately **not** merged into the dictionary popup:
a lookup answers "what is this word", this answers "what does this sentence
do", and the two arrive at different speeds (2 ms vs 4–8 s).

Read [ARCHITECTURE.md](ARCHITECTURE.md) §4–5 and [GROWTH.md](GROWTH.md) first;
every choice below is the smallest one that reuses a mechanism that exists.

## 0. Decisions

| Question | Decision | Why |
|---|---|---|
| How is it triggered? | Electron `globalShortcut` in main, default `CommandOrControl+E`, configurable | The Swift events monitor streams modifier/click events with pointer geometry; ⌘E needs only `screen.getCursorScreenPoint()`, which main has. Changing the key then needs no child restart (the modifier does — `ipc.js` `cfg:trigger`). |
| Where does the sentence come from? | The glyph layer, in the renderer: `sentenceAround(li, ci)` walks `glyphLayer.lineAt()` back and forward over non-ruby lines until `。！？` or a glyph cap | Lines arrive in reading order for both yokogaki and native tategaki (columns RTL), so one slice serves both. No new geometry, no new OCR pass. |
| How does the answer get here? | Main runs `bot ask --request` as a **one-shot child** (`execFile`, JSON on stdin, JSON on stdout) | The renderer's CSP is `default-src 'none'` — it cannot `fetch()` and should not start to. Main is the trust boundary already. No port, no CORS, no daemon to supervise; Python start-up (~0.3 s) is noise next to the model (4–8 s). `bot serve` stays for browser extensions. |
| Where is it shown? | The existing `#popup`, in a new `explain` mode: header = the sentence, body = `<bot-answer>` | Placement, tategaki flipping, scrolling, mouse capture, pin/dismiss and page-turn rules are all solved for that element (`renderer.js`). A second panel would re-solve each one (§4: panels are a race with the window manager). |
| What does a click on a word do? | `<bot-answer>` fires `lookup {surface, base}` → the existing `doLookup` path with a glyph array → the dictionary popup replaces the explanation | Explanation and dictionary stay two modes of one popup; ⌘E again brings the explanation back (cached, free). |
| What if bot-api is missing or logged out? | The popup shows one error line with the exact fix (`uv tool install`, `claude auth login`); nothing else changes | CONVENTIONS: degrade honestly — never a stale or partial answer. |

## 0.5 The picker

Model, thinking and effort for the next explanation are chosen from a half-disc
fanned around the cursor (`renderer/picker.js`) — the pen picker on an iPad, not
a settings tab three windows away. It opens from the chip in the explanation's
header or with the picker key (the explain key + Shift). Three rings, inner to
outer: model (skill's choice / sonnet / opus / fable), thinking (skill / on /
off), effort (default / low … max). A wedge click is saved through
`cfg:explain`; main pushes the merged settings back and both the chip and the
fan redraw from that, so what is shown is what was saved. It closes like the
popup does: when the cursor has moved well clear.

What the fan may offer is listed once, in `config.js` (`EXPLAIN_MODELS`,
`EXPLAIN_EFFORTS`), and pushed to the renderer with the settings.

## 1. Flow

```
⌘E (globalShortcut, main)
  └─ cursor → window-local (same math as onTriggerEvent)   send('explain', {x,y})
renderer/explain.js
  └─ pickGlyph → line li, char ci → sentenceAround(li, ci)
     cached?  ──yes──▶ popupView.renderExplain({sentence, answer})
     └─no─▶ popupView.renderExplain({sentence, loading}) ; overlay.explain(sentence)
main/explain.js
  └─ execFile(bot, ['ask','--request'], stdin = {prompt, skill:'ja', component:true})
     └─ AskResult JSON  ──▶  invoke() resolves
renderer/explain.js
  └─ seq check (a newer ⌘E wins) → view.result = res → cache[sentence] = res
```

Sentence slicing rules (`sentenceAround`), all testable on captured payloads:

- Start at the glyph under the cursor; extend backwards to the glyph after the
  last `。！？` (or line start if the previous line ends with one), forwards to
  the first `。！？` inclusive.
- Cross line boundaries only while the previous/next line is not `ruby` and
  the join stays under `MAX_SENTENCE_GLYPHS` (120 — Claude's cost is per
  token, the popup's width is per glyph; a manga bubble is ~20, a novel
  sentence ~60).
- `、` never terminates. Quotes `「」` are kept as text; do not try to pair them.
- If nothing under the cursor: HUD says "point at text, then ⌘E".

## 2. Files (≈ 300 lines added, nothing rewritten)

| File | Change |
|---|---|
| `app/main/explain.js` *(new, ~80)* | `createExplain({ overlayWindow, cfg })`: register/unregister the shortcut, cursor → window-local, `runBot(request)` via `execFile` with a 90 s timeout; resolves the bot executable from `explain.bin` or `~/.local/bin/bot`. One module, state owned, deps as arguments (CONVENTIONS main-process rules). |
| `app/main/ipc.js` | `ipcMain.handle('explain', text)` — validate `isStr(text, 512)`, forward to `explain.run`. |
| `app/main.js` | Wire `createExplain`; add its `stop` to `killChildren` (a running `bot ask` must not outlive the app). |
| `app/preload/overlay.js` | `onExplain(cb)` and `explain(sentence)`. |
| `app/renderer/explain.js` *(new, ~90)* | `sentenceAround`, the bounded cache (32 entries), the request sequence, and the glue to `popupView`. Exposes `window.explain`. |
| `app/renderer/popup.js` | `renderExplain({ sentence, anchorRect, vertical, loading, result })` — builds the header + `<bot-answer>`, then reuses the placement block of `render()` (extract it into `place(anchorRect, vertical)`; a pure move). |
| `app/renderer/bot-answer.js` | Vendored from `bot-api/src/bot_api/web/bot-answer.js`; header says where it came from and the version. CSP-safe: it uses a constructed stylesheet, not `<style>`. |
| `app/renderer/overlay.css` | `#popup.explain` — the `--ba-*` variables mapped to the popup's palette (`#d3b072`, `#9d9484`, Hiragino Mincho ProN), ~15 lines. |
| `app/renderer/index.html` | Two `<script>` tags, before `renderer.js`. |
| `app/main/config.js` | `explain: { enabled: true, shortcut: 'CommandOrControl+E', bin: null, skill: 'ja', model: null, timeoutS: 90 }`. |
| `app/settings/*` | One row: enable + shortcut. Skill/model stay in bot-api's own config (`bot skills use`, `bot models set`). |
| `test/unit/explain.test.js` *(new)* | `sentenceAround` against real captured payloads from `test/gt/` (ground truth, not fixtures we wrote): horizontal, native vertical, a ruby line between two text lines, no terminator on the page, the cap. |
| `docs/ARCHITECTURE.md` | One row in the table; one line in §5 that the explanation obeys the same dismiss rules as the popup. |

## 3. What is measured before it ships (GROWTH rule 1)

- `[explain] 62 glyphs → 5.1 s, 473 tok` per request in `/tmp/yomi-overlay.log`.
  If p50 is over ~8 s on real pages, the skill's Sonnet/thinking-off default is
  the first lever, not a spinner redesign.
- Sentence slice hit rate: on 20 real ⌘E presses on a Kindle novel and a manga
  page, how often the slice is the sentence a human would pick. Below ~17/20
  the walk rules are wrong, and that is a slicing bug — not a reason to send
  more context to the model.

## 4. Rejected

- **Swift monitor emits ⌘E** — needs a child restart per key change and buys
  nothing the cursor point does not already give.
- **Renderer `fetch()` to `bot serve`** — blocked by the CSP, and rightly.
- **Separate panel** — a second window means a second copy of placement,
  cover and Space logic that took months to get right.
- **Explanation inside the dictionary popup** — different question, different
  latency; the user asked for a separate function.
- **Streaming tokens into the popup** — `bot ask --stream` exists, but the
  component is a tree, not prose; it renders whole. A skeleton for 4–8 s is
  the honest state.

## 5. Prerequisites on the machine

```bash
cd ~/Desktop/projects/bot-api && uv tool install --editable .   # ~/.local/bin/bot
bot doctor                                                       # claude found, logged in
bot skills use ja
```

## 6. Status

Implemented on `feat/explain-sentence` (2026-09-19): every file in §2 plus the
picker, `test/unit/explain.test.js` (the slice on the captured pages) and three
black-box cases in `test/unit/renderer.js` (the key, a failed answer, a pick).
`tools/lint.sh` and `test/unit/run.sh` are green. Not yet measured on real
reading (§3): latency per request is logged as `[explain] N glyphs → ms`, the
slice hit-rate needs twenty real presses.
