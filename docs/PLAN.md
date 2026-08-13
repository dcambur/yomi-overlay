# Yomi Overlay — Improvement Plan

Derived from the research analysis (2026-07), scoped to macOS only
(cross-platform explicitly deferred). Ordered by learner-value ÷ cost.
Each stage has an acceptance benchmark — no stage is "done" on vibes.

## Already done (don't re-plan these)

- ✅ Pitch-accent graph (mora overline + downstep, Yomitan-style) — was the
  research doc's Stage 0 headliner.
- ✅ Type-aware popup rendering (bilingual / monolingual / grammar / names /
  kanji rendered differently; freq chips; deinflection chip).
- ✅ Shape-aware gloss extraction in `build-index.py` (JMdict sense nodes,
  三省堂 語義/語釈, plain-text splitters; ruby `rt` no longer pollutes text).
  *Full structuredContent JSON storage is still open — see Stage 2.*
- ✅ Deterministic alignment/selection test suite (`test/`) — real kakuyomu
  DOM as ground truth; selection, alignment, scroll, and E2E all green.
- ✅ Frontmost-window selection; self-truthing layer placement
  (screenX/Y-based); carousel/partial-change rebuild drift fixed;
  display-fallback coordinate rebasing; one-run `setup.sh` with stable
  signing identity.

## Stage 0 — Quick wins — DONE (2026-07-29)

- ✅ **13px gothic body text**; Mincho reserved for the headword (19px). Popup
  widened to match (`clamp(250px, 26vw, 410px)`).
- ✅ **Configurable trigger modifier** — shift/control/option/command, stored in
  `config.trigger`, passed to the event monitor as `--modifier`, and tested
  renderer-side against the matching `*Key` property. Changing it restarts only
  the events child.
- ✅ **Hover mode** — `trigger.mode = 'hold' | 'hover'` with `hoverDelayMs`
  dwell. Hover fires on settle, not per mousemove.
- ✅ **Settings → Lookup tab** exposing all three; irrelevant rows hide with the
  mode.

## Stage 1 — Vertical text (tategaki) — CORE LANDED (2026-07-29)

What was planned vs what measurement forced:

- **Rotation does not work and was abandoned on evidence**: Vision returns
  ZERO lines for tategaki both as-is and rotated 90°, because rotating the
  page leaves every CJK glyph on its side (they are upright inside a vertical
  column). The plan's "rotate + map boxes back" step is dead — kept here so
  it is not re-proposed.
- ✅ **Reflow engine instead** (`tategakiCells` / `reflowStrip` in
  KindleOCR.swift): ink-mask column detection → ink-run character cells
  (NOT fixed-pitch — line spacing is a reader setting; assuming 1 em cut
  glyphs in half) → upright cells composed into a horizontal strip → Vision
  reads the strip natively → each recognised character maps back to its
  source cell **by strip position**, not string index (Vision drops/merges
  the odd character; index mapping was 1% placement, position mapping fixed it).
- ✅ **Auto-detection**, sticky per session: horizontal first, probe vertical
  when horizontal yields nothing; 2× char-count margin so page furniture on a
  horizontal page never flips it. `--vertical` remains as a manual override.
- ✅ **Popup left of the column** on vertical pages (payload carries
  `vertical: true`); tail extraction needed no change — chars already arrive
  in reading order.
- ✅ **`test/verify_vertical.py`** — per-character DOM ground truth
  (`writing-mode: vertical-rl` page), measuring coverage / placement / order.

Current numbers on the test page: **coverage 95%, placement 77%, column
order 10/10 RTL, chars 10/10 top-to-bottom** (gate: placement ≥70%).

Remaining before calling the stage fully done:
- Validate on real Kindle/BOOK☆WALKER pages (fonts, furigana, margins differ
  from the rig; expect the furigana filter from Stage 2 to matter here).
- Push placement toward 90%+: the residual errors are cell-boundary jitter on
  small kana and punctuation cells.
- Line-height robustness below ~1.4 (dense layouts narrow the inter-glyph
  gap toward the 0.3 em split threshold).

## Stage 2 — Dictionary fidelity (≈1 week)

- **Store `structuredContent` JSON** per entry alongside the flattened lines
  (the flattened text stays as the search/fallback field). ~Index size cost:
  measure; if prohibitive, store only for dictionaries that need it
  (Jitendex examples, grammar dicts' tables).
- **Safe-subset renderer** in the popup (~200 lines): `ul/ol/li`, `ruby/rt`
  (furigana in examples!), `table/tr/td`, whitelisted span styles
  (bold/italic/color), `a` as non-navigating text. Do NOT port Yomitan's
  GPL StructuredContentGenerator.
- **Furigana line filtering in the overlay**: drop OCR lines whose glyph
  height is ~40–60% of an adjacent line and sits beside it — they're ruby,
  and they currently pollute lookups. (Later: use them as reading hints.)

*Benchmark: 明鏡/三省堂 sense hierarchy and Jitendex example sentences render
with furigana; ruby lines no longer appear as lookup targets.*

## Stage 3 — OCR accuracy levers (measure first, then apply) (1–2 weeks)

Build the measurement harness before touching accuracy:

- **Ground-truth set**: 50–100 crops from real Kindle (horizontal + vertical),
  BOOK☆WALKER, kakuyomu; hand-typed truth; CER as the metric (extend
  `test/verify.py` — the DOM-truth trick already gives free ground truth for
  browser content).

Then, in order of gain-per-effort, keeping only levers that move CER:

1. **Temporal fusion** — the watch loop re-OCRs static pages anyway; majority-
   vote across 2–4 passes before declaring lines stable. Nearly free.
2. **Cursor-region 2× re-OCR** — on Shift-point, re-OCR just that line's
   region upscaled 2×; correct the word the user actually cares about.
3. **Dictionary-constrained rescoring** — `topCandidates(k>1)` + kanji
   confusion pairs (日/目/自, 未/末…), prefer candidates that deinflect into
   the 2M-term index. The index already exists; this is a rescoring loop.
4. **Dark-mode/e-ink preprocessing** — invert dark pages, contrast-stretch
   low-contrast rendering before Vision.
5. **LLM post-correction** — explicitly deprioritized: gate behind low-
   confidence lines only if levers 1–3 leave measurable CER on the table
   (over-correction risk on clean text).

*Benchmark: per-lever CER delta on the ground-truth set; drop any lever that
doesn't move it.*

## Stage 4 — Anki mining loop (≈1 week)

The architecture makes this unusually cheap: the full OCR'd line set (sentence
context), the source-window pixels (screenshot), and the deinflected base form
already exist at lookup time.

- **AnkiConnect** `addNote` with word, reading, glosses, sentence, and a
  region screenshot (base64 `picture` payload); configurable deck/model/field
  mapping in settings; a small "+" button on the popup.
- **Audio**: macOS `AVSpeechSynthesizer` (ja-JP) as the zero-dependency
  default; optional VOICEVOX/AivisSpeech local HTTP if installed. Skip
  JapanesePod101 scraping (unlicensed).

*Benchmark: one click on the popup → complete card in Anki with sentence +
picture + audio; no popup jank while the card is built.*

## Stage 5 — Segmentation & word status (2+ weeks, split into two)

- **Pre-segmentation**: run a tokenizer (Vibrato or Lindera — embeddable,
  fast; no Python service) over OCR lines to fix longest-match-first errors
  at word boundaries; keep the Yomitan deinflector for the chosen span.
- **Word-status tracking** (known/learning/ignored): local store keyed by
  base form; color the existing glyph spans (they're already positioned —
  coloring is a CSS class). FSRS or simple staged intervals; JPDB sync later.
- **Clipboard/manual text mode**: a small window that runs the same
  lookup/popup over pasted or texthooker'd text — reuses the whole pipeline
  for near-zero cost, big reach win (games via Textractor/Agent).

*Benchmark: 見つけた no longer matches across a word boundary on test lines;
known words render dimmed on the glyph layer.*

## Stage 6 — Polish backlog (as time allows)

- Kanji detail view: KanjiVG stroke order, components.
- OCR-region pinning (manga bubbles / game dialogue templates).
- Adaptive capture: pause when target not frontmost; capture on page-turn
  only (frame-hash deltas already exist).
- Search history + export.
- Security hardening: validate IPC payloads, `sandbox: true` where possible.
- Packaging: notarization + updater — only relevant if the app is ever
  distributed; the loader-outside-bundle TCC trick is personal-use-only by
  design and would need rethinking for distribution.

## Explicitly out of scope (per current decision)

- Windows/Linux port, YomiNinja fork-vs-reference, iPad/"nantan" shared core
  — revisit after Stage 4 lands.

## Sequencing rationale

Stage 1 before Stage 2: a broken core use case outweighs popup fidelity.
Stage 3 after 2: accuracy work needs the furigana filter in place or ruby
noise dominates CER. Stage 4 anytime after 2 (independent of OCR work) —
it's the highest sustained-value feature for actual study. Stage 5 last
because segmentation touches the hot lookup path and benefits from the test
harness maturity built in Stages 1–3.
