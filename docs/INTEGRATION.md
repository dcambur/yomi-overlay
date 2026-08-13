# Research Integration Plan — Two-Tier OCR Architecture

Derived from `research/notes/final_report_local-japanese-ocr-overlay-a016d8.md`
(2026-08). This plan operationalizes the report's §7 recommended architecture and
§8 ranked levers against the actual codebase. It **supersedes PLAN.md Stage 3**
(OCR accuracy levers) and extends Stage 1's remainder; all other PLAN.md stages
(2, 4, 5, 6) are untouched and remain valid.

**Audience:** an AI agent (or human) implementing this without having read the
report. Every phase names its exact code anchor, acceptance gate, and revert
path. Read `ARCHITECTURE.md` and `CONVENTIONS.md` first — the load-bearing
decisions there are invariants for every phase below.

---

## 0. Ground rules (violating any of these is a plan failure)

1. **Instrument before changing.** No engine swap, no lever, no threshold lands
   before the Phase 0 ground-truth set and CER harness exist. The report's
   core meta-finding: nobody in this field publishes a CER, so the only
   decision-grade evidence is measured on this project's own content.
2. **The geometry layer is the invariant.** The ink-run cell splitter
   (`tategakiCells` / `reflowStrip` in `ocr/Sources/Geometry/Tategaki.swift`) and
   strip-position mapping (`:776-831`) stay, regardless of which recognizer
   supplies text. It is the only mechanism with a measured placement number
   (77%) and it is what makes recognizers swappable.
3. **Every correction lever is confidence-gated.** Measured: an ungated
   corrector flipped 575 chars for net +13; gated at certainty ≤ 80 it netted
   +151. No lever fires unconditionally.
4. **Private-API risk lives only in the cheap tier.** Live Text (private
   VisionKit) may only ever drive the watch loop, where failure degrades to
   "no popup until fallback". The accurate tier stands on versioned components.
5. **Existing invariants hold:** capture geometry from measured pixels;
   window selection from the active-Space list; panel never chases; glyph layer
   rebuilds only on real change; deploy = quit + relaunch; NDJSON hand-built
   via `jsonEscape` (no Codable — match the existing idiom); stdout is data,
   stderr diagnostics.
6. **Do-not-build list** (rejected on evidence, do not re-propose):
   - PaddleOCR-VL / PaddleOCR-VL-For-Manga as a resident engine at 8 GB
     (16 GB+ recommended by vendor; two-process split). Re-open only via
     Experiment E4 or a RAM upgrade.
   - ONNX → Core ML conversion of any transformer recognizer (two documented
     *silent* failure modes: FP16 downcast under default `NeuralNetwork`
     format; 25% node-coverage collapse on encoder-decoder attention).
   - Binarization (targets uneven paper illumination; destroys anti-aliased
     screen glyphs).
   - Rotation for tategaki (measured dead: Vision returns zero either way).
   - Whole-string LLM post-correction (worse on short segments; revisit only
     if Phases 2–6 leave measured CER on the table).
   - Yomitan GPL code ports (license).

---

## Progress log

- **2026-08-08 — Phase 0 landed.** `yomi --image PATH` (recognize a PNG,
  no SCK/permission), `test/cer.py` (NFKC + Levenshtein, per-category,
  `--from-json` for foreign engines), `test/gt/` scaffold + README. Synthetic
  smoke crops only so far — **the real 100-crop set is still to collect.**
- **2026-08-08 — Phase 1 landed (code).** `LiveText` binding in
  `ocr/Sources/Recognition/LiveTextEngine.swift` (runtime `VKCImageAnalyzer` lookup, dlopen of
  VisionKitCore, 10 s timeout, 3-strikes degrade to Vision, per-char
  `.children()` quads verified against known glyph positions);
  `--engine auto|vision|livetext` (+ `engine` config key, main.js passes it);
  Vision refactored into the shared intermediate shape; one-char-per-line
  artifact rule (flat read that is ≥70% single CJK chars → report nothing so
  the probe flips vertical). `engine:` stderr line says which engine really
  ran. Smoke CER: horizontal 0.00 both engines; forced-reflow strip 0.43
  (Vision) → 0.36 (Live Text).
  **Still open before calling Phase 1 done:** re-validate 618-vs-6 on a real
  Kindle tategaki page; run the four `test/` suites (needs the GUI rig);
  latency p50/p95 on watch passes; furigana `.children()` probe (E5).
- **2026-08-08 (later) — Phase 1 validated on measurement; three findings.**
  1. *VKC delivery contract:* the completion arrives via the main dispatch
     queue and ONLY while the main task is suspended — every synchronous wait
     (run-loop spin, worker thread, semaphore) times out in the capture path.
     `LiveText.analyze` is therefore `async` (continuation + 10 s watchdog),
     and `recognize`/`recognizeAuto` went async with it.
  2. *Native vertical read:* on real vertical-rl pages Live Text returns whole
     columns as lines with true page-position quads — measured BETTER than
     reflow (DOM-truth suite: 99% coverage / 89% placement vs 95/77 Vision
     reflow, 94/66 LT-on-strip). New `verticalNative` orientation state: LT
     reads pages only (never the strip — that stays Vision's), columns sorted
     RTL, payload `vertical:true`. `verify_vertical.py` PASSes.
  3. *Headless CER harness* (`test/gt/gen_aozora.py`, categories `aozora_h`
     / `aozora_v`, truth by construction): **Live Text 0.6% CER horizontal /
     1.1% vertical; Vision 0.3% / 98%.** The 618-vs-6 gap reproduced and
     quantified on 10 literary tategaki pages.
  - *Phase 5 input:* Vision reflow collapses to garbage at ~1.05 em char
    pitch (aozora_v, measured CER 0.98) — the known "line-height below ~1.4"
    gap, now reproducible headlessly.
  - Open: real-Kindle validation (needs a book open on screen), `verify.py`
    mid-suite window flake (rig/Space interference, pre-existing), latency
    p50/p95, E5 furigana probe.
- **2026-08-08 — Phase 1 DONE: validated on real content.** Captured a real
  kakuyomu chapter in vertical mode from the user's Chrome (fullscreen Space,
  Retina): auto-detected `verticalNative`, and on the hand-verified crop
  (`test/gt/tategaki/kakuyomu_01.png`, truth transcribed from the captured
  image): **Live Text CER 4.5%, Vision CER 100%** — the report's 618-vs-6
  claim reproduced on this machine's real content. Fixes along the way:
  native-vertical reading order now comes from CHAR quads (LT's vertical line
  boxes misorder adjacent columns), and text mode no longer re-sorts
  pre-ordered native-vertical lines (order()'s 0.04 column-tie threshold
  exceeds dense-page column spacing, 0.033 measured). `cer.py` folds
  ellipsis display variants (……/・・・・・・) as equivalent.
  - *Phase 4 input:* LT natively omits most furigana lines (no ruby pollution
    observed on the kakuyomu page) — but may eat an adjacent base char
    (梓 dropped next to its シシュン ruby). E5 refined: probe base-char loss
    beside ruby, not just quad stability.
  - Still open (minor): latency p50/p95 in watch mode; real-Kindle horizontal
    spot-check; `verify.py` flake.
- **2026-08-08 — Phase 2 landed.** (a) NFKC in `lookup.js` before the SQL
  query (glyph-count `matchLength` preserved; verified U+2F08 ⼈ now resolves
  to 人/にん). (b) `CharBox.conf` + payload `engine`/`vote` fields via new
  `buildPayload()`; `f` emitted per char only after voting. (c) Temporal
  voting in the watch loop (`--votes 3 --vote-every 2`, `voting` config key):
  re-OCRs static pages, majority-votes per character by GEOMETRY (32 px
  spatial hash, tol = half glyph), base layout = FIRST pass so renderer
  indices stay stable; transient bad reads (< half the base chars) are
  skipped; heartbeat contract preserved (verified live: vote=1→2→3 payloads
  then pure heartbeats). (d) Renderer applies vote≥2 payloads IN PLACE
  (spanIndex li:ci), updating `contentSig` to keep describing the DOM —
  without this the 85% gate silently dropped single-char corrections.
  Regression: aozora_v 1.1% / kakuyomu 4.5% CER unchanged; JS syntax-checked.
  - Cosmetic: payload `engine` reflects the LAST recognize() sub-call, so an
    orientation-probe pass can mislabel; self-corrects next pass.
  - Voting CER delta on real content: not yet measured (needs a live
    flickering source; the Phase 0 crops are single images). Gate stays open
    until measured — the lever ships enabled but is one config key to off.
  - *Measured:* Live Text is fully deterministic on identical pixels (6 runs,
    byte-identical). So same-engine voting corrects only capture-level pixel
    jitter; 3 voters is the right cap, and the big cross-voting gains belong
    to Phase 3's second engine (independent error distribution).
- **2026-08-08 — Phase 3 landed (shadow mode).** manga-ocr Tier-2 chain, all
  links verified: renderer sends the matched word's exact glyph-box union →
  `main.js` throttles (400 ms) → yomi crop command channel (stdin
  `crop id x y w h path`, served from the LAST captured frame on the main
  loop — no second SCK session, replies never interleave with payload
  writes, 2x upscale) → `overlay/mangaocr_sidecar.py` (venv, MPS, NDJSON,
  lazy spawn, 10 min idle kill, exit 2/3 = disabled for session) →
  disagreement logged as `[tier2] ... agree|DISAGREE`. Config
  `tier2: {mode:'shadow'|'off', idleKillMin}`; setup.sh step 4.5 installs
  the venv. E2E: `囮のウィ` → crop → sidecar → `囮のウィ`, 143 ms.
  - **Gate results:** latency ~140–190 ms/word on MPS (≤1.5 s ✓); sidecar
    RSS 227 MB after warm requests (<1.5 GB ✓; weights live in unified GPU
    memory); model load ~10 s once.
  - **Measured constraint that shaped the design:** manga-ocr hallucinates
    fluent nonsense on page- and even LINE-sized crops (81% CER on single
    aozora columns — its ViT resizes input to 224×224, and long thin strips
    become illegible). Word-sized regions read at ~14% CER, and most of that
    was crop-boundary overrun. Tier 2 therefore only ever sees tight
    word-region crops; never hand it a line. This also re-scopes E2: the
    head-to-head must run at word granularity.
  - Open: accumulate real shadow logs (agree/DISAGREE rate) from actual
    reading sessions before any non-shadow mode; per-category word-level CER
    comparison LT-vs-manga-ocr (E2) to decide if Tier 2 should ever override.
- **2026-08-08 — Phase 4 landed (filter + hints).** `markRuby()` in
  `ocr/Sources/Geometry/Furigana.swift` marks furigana lines: all guards required at once — page
  height-bimodal vs the MAX height (not a percentile: ruby lines OUTNUMBER
  base lines on dense pages, measured), ≥80% kana, 35–65% of an adjacent
  base line's height, positioned above (horizontal) / right (vertical)
  within 1.2 small-heights with ≥40% overlap. Ruby lines: dropped from text
  output, emitted with `"ruby":true` (renderer skips them in hit-testing),
  and their text becomes the base line's `"hint"`. `lookup(glyphs, hint)`
  stable-prefers entries whose reading the hint contains.
  **Measured:** furigana test set (new `test/gt/furigana/`, 6 rendered
  pages both orientations) CER 21.9% → 1.0% with the filter; hint ranking
  verified (生+なま → なま first, 生+せい → せい first — the report's
  zero-implementations-anywhere lever, now real); zero regression on
  ruby-free categories. Known remaining: LT eats an occasional base char
  beside ruby (神世七代 → 神世代) — E5's refined probe, a Tier-2/voting
  correction target, not a filter bug.
- **2026-08-08 — Tier-2 tested on real content (autonomous shadow replay).**
  Replayed the full shadow pipeline on 373 dictionary-segmented words from
  real prose: the captured kakuyomu page (100 words) + three pages rendered
  from a freshly fetched kakuyomu episode (273 words). Findings:
  - **Agreement (edge-punct-normalized): 94% at 24 px vertical, 86–90% on
    the real capture, 81% at 20 px horizontal gothic, 27% at 18 px** —
    tier-2 usefulness is glyph-size-gated; below ~20 px neither more margin,
    white padding, square padding, nor 4–6x upscale helped.
  - manga-ocr emits phantom edge punctuation/kana on isolated word crops
    ('.家具', 'お輝かしい') — comparison must strip crop-edge junk; a future
    non-shadow mode should too.
  - **Tier-1 quad drift found and quantified**: on dense columns LT char
    quads come back ~1.7x the true pitch and drift up to 2 rows by
    mid-column (verified against a known render grid). This is the
    user-visible placement shift on furigana-dense Kindle pages and the
    cause of the shifted tier-2 crops ('目覚める'→'覚めると').
  - Re-anchoring quads to ink cells was implemented and MEASURED OUT for
    now (`reanchorVerticalChars`, not wired): order-alignment repeats the
    index-mapping trap (dropped 梓 shifted a whole column), nearest-cell
    scored 82% vs 86% baseline, and the splitter fragments below ~20 px
    (4 px stroke cells). It is the Phase 5 starting point, with the guard
    conditions already written.
  - Suites re-verified after everything: verify_vertical PASS 99/89 + 95/77;
    CER regressions zero. (One suite timeout traced to the overlay running
    concurrently — the documented SCK conflict, not a code fault.)
- **2026-08-08 — Phase 5 landed: cell splitter rebuilt + quad re-anchoring.**
  New instrumentation first: `yomi --cells` + `test/cellbench.py`
  (renders exact-grid pages across a size×pitch matrix, scores cells with no
  recognizer in the loop). Baseline: recall 0.39–0.77, fragment/merge chaos
  below 20px. Splitter rebuilt (columns stay coarse; per-column rows at
  PIXEL resolution; stroke-merge with an ~1.15em cap — gap size alone cannot
  separate 二's strokes from tight-pitch neighbors, the em cap can; small
  cells normalized toward the em box, taking at most half of each gap):
  **recall 0.91–0.99, cells/chars ≈ 1.0, center error 1–3 px.**
  Downstream, all measured: reflow placement **77% → 86%** (coverage 95→99)
  on the DOM-truth suite; Vision-reflow CER on dense synthetic **98% → 20%**;
  `reanchorVerticalChars` REWIRED with the working design — page-level ink
  columns only (per-line crops re-derive quad drift; nearest-cell and DTW
  both failed, measured), lines→columns by mean x, cells repaired toward
  the recognizer's char count (merge ≤1.15em / split ≥1.4em, else keep
  quads) — kakuyomu word-crop agreement **86% → 92%**, dense-grid page
  54% → 73% on-grid. CER: zero regressions (all ≤ previous).
  Remaining known: columns where LT itself drops a char (梓 beside ruby)
  keep drifted quads by design — the Tier-2 disagreement log now points at
  exactly those; native placement 89% / reflow 86% vs the 90% target.
- **2026-08-08 — Phase 4b: furigana removal BEFORE recognition (the user's
  生→が bug).** Root cause, diagnosed from the user's real Kindle page via
  the shadow log + captured pixels: BOTH engines fuse tightly-set ruby into
  hallucinated characters (別天神+ことあまつかみ → 前実 in LT, 前笑雑 in
  Vision) and the width error smears down the line as a cumulative glyph
  shift — post-recognition line filtering can never see it. `stripFurigana`
  now erases ruby bands from the pixels first (the research's
  removal-before-recognition lever): per-SLICE row projection (full-width
  projection dies to sidebars/banners, measured zero bands), ruby = band
  30–65% the height of the band directly below within 0.8 of its height,
  erase padded to 2px short of the base band, bands read separately and
  attached as `hint`. Three found-by-measurement bugs en route: CGBitmapContext
  refuses alpha-less PNG formats (fixed RGBA context), a hardcoded `x: 0`
  erased only the left slice, and antialiased residue rows still caused
  fusion (hence padding). Gated on COMMITTED horizontal orientation — the
  h-probe of a vertical page must never strip (cost 5x CER on vertical
  suites when it did); recognizeAuto re-reads once after the probe commits.
  **Results: the Kindle line reads 別天神が生み出し with correct per-char
  boxes + hint 'こ：あまつかみかみよななよ'; furigana CER 1.0% → 0.5%; all
  other suites unchanged (verify_vertical PASS 99/89, 99/86). Residual:
  spread-glyph 七 still dropped beside its ruby (known LT quirk).**
- **2026-08-08 — engine policy: Vision for committed horizontal, LT for
  vertical (the span-shift endgame).** After the ruby strip fixed the TEXT,
  spans still sat one char off on ruby-spread lines at any zoom. Cause: LT
  emits multi-char tokens and the even-width subdivision drifts on
  letter-spaced text (別天神 spread for ruby). Vision's boundingBox(for:)
  has true per-char ranges and measured better horizontal CER anyway
  (0.3% vs 0.6%). recognize() now uses LT only for vertical/probe passes
  (its measured win) and Vision for committed-horizontal passes; forced
  --engine livetext bypasses. Verified on the Kindle page: 34/34 char boxes
  contain their glyph's ink, 神世七代 fully recovered, hint attached; CER
  suite zero regressions. Strip diagnostics (`furigana: stripped N bands`)
  now visible in the overlay log. Rig suites pending next overlay-off window.
- **2026-08-10 (later still) — furigana strip vets bands by TEXT (the
  magazine false positive).** User-reported: one specific body line on a
  decorated reference page was permanently unrecognizable. Cause: the
  pre-recognition strip's guards were purely geometric, and a small body
  line directly above a LARGER section header fits the same 30–65% height
  ratio as ruby — the line was erased from the pixels every pass.
  stripFurigana split into detectRubyBands + eraseBands; candidates are now
  read BEFORE erasing and vetted by kana fraction (≥0.7; furigana is kana
  by definition), judged per ROW GROUP not per slice — a lone slice's
  fragment reads kana-heavy (れてしまった。= 0.86, measured) even when the
  physical line is kanji-rich. Unreadable bands still erase (fusion-bug
  guard). Verified: synthetic magazine page reads the full line while real
  ruby still strips+hints; furigana suite exactly at baseline (0.52%)
  through the committed path; all categories unchanged.
  - *Perf fix, same day:* per-band Vision reads regressed pass time on
    decorated Kindle pages (6–9 candidates/pass; 8–22s between payloads, the
    overlay flapped hidden mid-read). All bands now composite into ONE strip
    (24px white gaps, lines mapped back by y) and read with a single Vision
    call. Furigana suite still 0.52%; magazine repro unchanged.
- **2026-08-10 (later) — mixed-content recognition: vertical text on
  committed-horizontal pages.** Root cause of "manga doesn't work": a
  bookwalker page commits horizontal (chrome + sfx win the vote) and
  committed passes were Vision-only, which reads no vertical Japanese —
  measured 11 lines / 105 glyphs of chrome, zero dialogue. Every
  committed-horizontal Vision pass now merges ONE LT flat read
  (`verticalRemainder`): keep only genuinely columnar lines (char-quad
  spread) that don't overlap a recognised horizontal line, flagged
  `vertical:true` per line. UNCONDITIONAL by user decision — no
  ink-coverage gate; a single vertical banner on a 90%-horizontal page must
  read too. Costs one LT pass per CHANGED frame; `--engine vision` still
  means Vision alone. Guard found by measurement: on a fully-vertical page
  the merge's weight defeated the picket escape and the strip mutilated the
  columns (furigana suite 0.5%→37% CER) — so merged-vertical DOMINANCE
  (vW > 2·hW) now re-probes into the native path instead. Verified: both
  synthetic mixed directions read everything; all five CER categories at
  baseline (0.5–1.2%). New debug flag `--assume-horizontal` exercises the
  committed path headlessly.
- **2026-08-10 — per-line orientation landed (the §2.2 deferral).** `Line`
  now carries `vertical`; payload lines emit `"vertical":true` and the
  page-level flag stays as majority fallback. Set by construction on reflow
  lines (they ARE columns), by char-quad spread per line on native LT reads
  (which return a vertical page's horizontal furniture in the same pass;
  single-char lines follow the page majority), false elsewhere. The renderer
  places the popup against the HIT line's orientation, not the page's — a
  horizontal title on a vertical kakuyomu page gets a below-the-word popup.
  Verified: synthetic mixed page flags title lines false / columns true;
  epub_v + aozora_v CER unchanged (0.8% / 1.2% samples). Same session:
  committed-horizontal escape hardened with the picket-fence check
  (cross-column misreads have median inter-char gaps > 0.6 em; h→v layout
  switches used to stay wedged horizontal with the furigana strip mutilating
  columns every pass).
- **2026-08-08 — stale-layer-on-zoom fix.** Payloads parked while the popup
  is pinned (`pendingPayload`) left the glyph layer describing the pre-zoom
  page; the next lookup hit-tested it and matched the wrong glyph (user
  repro: zoomed Kindle, 生 under cursor, popup showed が). `doLookup` now
  applies any parked payload BEFORE hit-testing. Log also showed rebuild
  flapping during Kindle's zoom-HUD fade (alternating 35/994 vs 46/956
  reads) — transient, settles when the HUD fades; watch it, no fix yet.

## Phase 0 — Measurement harness (hours–1 day) ["Stage 0" in the report]

**Goal:** a CER benchmark on this project's own content. Everything later is
gated on numbers from this harness.

### 0.1 Ground-truth set
- Collect **100 crops**: 20 each of (a) horizontal Kindle, (b) tategaki Kindle
  *with furigana*, (c) manga bubbles, (d) a game, (e) a browser page.
- Capture crops with the existing `yomi --dump /tmp/x.png` path (stop the
  overlay first — concurrent SCK sessions stall one-shot captures).
- Hand-transcribe each into a sidecar `.txt` (same basename). Store under
  `test/gt/{horizontal,tategaki,manga,game,browser}/`.
- Transcription convention: Unicode as displayed, **no** NFKC normalization in
  the ground truth (normalization is applied symmetrically at scoring time),
  furigana transcribed on separate lines prefixed `#ruby:` so scoring can
  include/exclude them.

### 0.2 CER scorer — `test/cer.py`
- Stdlib-only Python (match `build-index.py` convention; no new deps).
- Input: engine output text + ground truth. Pipeline: strip `#ruby:` lines
  (flag to include), NFKC-normalize both sides, strip whitespace, compute
  character-level Levenshtein. Report per-crop CER and per-category mean.
- Engine adapters: initially one — run `yomi` one-shot on a crop image.
  Add a `--from-json` mode reading any engine's text output so later engines
  (Live Text, manga-ocr, PaddleOCR) reuse the same scorer. `yomi` needs a
  small `--image PATH` mode (recognize a PNG from disk instead of capturing) —
  add it to `parseArgs()` (`ocr/Sources/CLI/Options.swift`) and route into
  `recognizeAuto` with a null geometry; this also makes every later
  head-to-head reproducible.
- A test that can pass with no input is broken: assert ≥ 90 crops scored.

**Gate:** baseline Vision CER recorded per category. Expect tategaki ≈ 100%
(total failure) — that number is the yardstick for Phase 1.

---

## Phase 1 — Live Text in the watch loop (≈1 day) [§8 lever 1 — highest value]

**Goal:** replace Vision with Apple Live Text (private VisionKit path) as the
Tier-1 recognizer. Categorical gain expected on vertical text (cited: 618 vs 6
chars on the same real Kindle page — a single third-party test that **this
phase must re-validate before anything depends on it**).

### 1.1 Implementation — `Recognition/LiveTextEngine.swift`, ObjC-runtime binding
No new process. Bind the private classes at runtime (Swift can do everything
`ocrmac` does via PyObjC):

- `NSClassFromString("VKCImageAnalyzer")` and
  `NSClassFromString("VKCImageAnalyzerRequest")`; request with
  `requestType = 1` (text analysis). Copy exact selector names from the
  `ocrmac` source (`ocrmac/ocrmac.py`) and WebKit's
  `VisionKitCoreSPI.h` — both are cited in the report as working bindings.
  The completion is a block whose signature must be hand-declared;
  in Swift use `@convention(block)`.
- Output walk: `analysis.allLines()` → per line `.string()`,
  `.quad().boundingBox()`, `.children()` (children are per-character quads
  for CJK — `VKWKLineInfo.children` of `VKWKTextInfo`, each with a quad).
- Drive it headless with a `CFRunLoopRunInMode` spin (the ocrmac pattern);
  no NSApplication needed — yomi already runs as a CLI.

### 1.2 Availability probe + fallback chain (mandatory, WebKit pattern)
- At startup: probe `NSClassFromString` for both classes **and** run a canary
  recognition on a small embedded test image. Any failure → log one line to
  stderr and set `liveTextAvailable = false` for the session.
- Fallback chain (design it, don't assume it):
  - Live Text unavailable + horizontal page → existing Vision path (works).
  - Live Text unavailable + vertical page → existing reflow path
    (`tategakiCells` + Vision on the strip — shares no code with Live Text).
- New flag `--engine vision|livetext|auto` (default `auto` = Live Text with
  probe fallback). `auto`'s decision is logged. This is the one-line revert.
- **Revisit after Phase 3:** the report's intended end-state vertical
  fallback is *cells + manga-ocr at reduced cadence* (shares no code with
  Live Text). At Phase 1 that engine doesn't exist yet, so cells+Vision is
  the interim fallback; once the Phase 3 sidecar lands, wire it in as the
  vertical fallback of record.

### 1.3 Vertical artifact post-processing
Live Text emits **one character per line on vertical text**. Rejoin: group
single-char lines into columns by x-overlap of their quads, sort columns
right-to-left, chars top-to-bottom (reuse the sorting conventions from
`tategakiCells` `:670`). This produces `Line`s in reading order compatible
with the existing payload shape.

### 1.4 Geometry policy (Tier 1 outputs are provisional)
- Horizontal: use Live Text `.children()` quads to fill `CharBox` directly
  (converted through the existing `Geometry.region` scaling at `:855-864`).
- Vertical: **keep the ink-run cell geometry as geometry of record.** Run
  `tategakiCells` as today; use Live Text text (from 1.3) in place of the
  strip's Vision text where it improves coverage. Simplest integration: keep
  the reflow pipeline unchanged and swap only the recognizer that reads the
  strip — the strip is horizontal, so no artifact rejoin needed on that path.
  Then attempt direct-page Live Text as a second step and compare placement
  via `verify_vertical.py`.
- Live Text emits **no confidence** (ocrmac hardcodes 1.0). Never treat its
  output as high-confidence; the Phase 2 cross-pass proxy is its only
  confidence source. (Known trap: vertical line boxes can collapse into
  horizontal bands — the OCRmyPDF plugin rebuilds geometry from raw quads;
  we sidestep by keeping cell geometry of record for vertical.)

### 1.5 Measurement & gates
- Re-run Phase 0 CER: expect tategaki to move from ~100% CER to a real read.
  **Gate: tategaki crops produce text at all; horizontal CER not worse than
  Vision baseline.**
- Run all four `test/` suites (need overlay stopped). **Gate:
  `verify_vertical.py` placement ≥ 0.7 (existing bar), no regression on
  `verify.py` alignment.**
- Measure Live Text latency on this M1 across 20 watch passes; log p50/p95.
  (Cited ordering on M3 Max: Vision-fast 131 < Live Text 174 < Vision-accurate
  207 ms — re-measure locally, don't trust absolutes.)
- Probe `.children()` on furigana-heavy crops — untested anywhere in the
  record. If character segmentation breaks on ruby, note it: it raises Phase 5
  priority (Experiment E5).

**Revert:** `--engine vision`.

---## Phase 2 — Confidence infrastructure + temporal voting + NFKC (days) [§8 levers 2, 3, 5]

**Goal:** manufacture the confidence signal every later lever needs, harvest
the free accuracy from re-OCR the loop already pays for, and erase the
codepoint-variant error class.

### 2.1 NFKC normalization (trivial — do first)
- `overlay/lookup.js`: NFKC-normalize the glyph string before index lookup
  (`String.prototype.normalize('NFKC')`). Verify `build-index.py` stored terms
  are NFKC-stable; if not, normalize at index build too and rebuild `index.db`.
- Erases the dominant catalogued residual class (full/half-width `！？`→`!?`,
  CJK radical variants U+2F08→U+4EBA). No gate needed; covered by existing
  lookup tests.

### 2.2 Extend the glyph record (the "stable internal representation")
The report's closing directive: per-character glyph records carrying position,
confidence, orientation, provenance — recognizers swappable behind it.
- Swift: extend `CharBox` (`ocr/Sources/Model/Line.swift`) with
  `conf: Double?` (nil = engine gave none) and keep emitting compact NDJSON:
  add `"f"` (confidence) only when present; payload stays
  backward-compatible (renderer ignores unknown keys). Line-level: add
  `"engine":"vision|livetext"`. Orientation today exists only as **one
  payload-level `vertical` boolean** (`ocr/Sources/Output/Payload.swift`) — sufficient
  while orientation is per-page; if mixed-orientation pages ever land, move
  it to per-line at that point.
- Renderer (`index.html:330-338`): store `c.f` on the span dataset; no visual
  change yet.

### 2.3 Temporal voting in the watch loop
Site: the watch loop in `ocr/Sources/CLI/WatchCommand.swift`, after the frame-hash check
(`:1105`) — the pixels-unchanged case currently short-circuits to an
`unchanged` heartbeat (`:1110`). Change:
- On unchanged frames, still re-OCR every Nth pass (N=2..3) up to **3 votes**
  per stable page, then stop re-OCRing until pixels change (preserves the
  battery/cadence win for genuinely static pages).
- **Heartbeat contract is inviolable:** every watch pass must still emit
  either a payload or the `"unchanged":true` heartbeat — including voting
  passes and the post-vote stable state. Without it an unchanged page looks
  identical to a vanished window and the overlay hides itself mid-read
  (the comment in `Recognition/Voting.swift` was paid for). Second trap:
  emission is deduped via `payload != lastText` (`:1162`) — a voted payload
  identical to the previous emission gets suppressed into the heartbeat
  branch; write the voting emit against that dedup, don't assume it lands.
- Vote **per character position, not per string**: align passes by cell (the
  vertical path already has cells; horizontal by x-overlap of `CharBox`es,
  reusing the >3px / overlap logic conventions). Majority text wins; emit the
  voted payload.
- **Cross-pass disagreement = the confidence proxy**: a char flickering across
  passes gets `conf` = agreement fraction (1/3, 2/3, 3/3). This is the free
  proxy for engines that emit none (Live Text, Vision). Measured motivation
  already in-repo: same static page → 80 lines one pass, 77 the next.
- Interaction with the rebuild gate (`index.html:307`, 85% similarity): voted
  payloads are *more* stable than raw passes, so the existing gate needs no
  change — but verify no rebuild-thrash via the `layer@` log lines.
- Anti-hallucination duty: voting is also the mitigation for manga-ocr in
  Phase 3 (it won't invent the same sentence three passes running).

**Gate:** CER delta on the Phase 0 set (batch mode: run 3-pass voting on crop
sequences) — cited analog +15.1 pts exact match on video, Japanese magnitude
unmeasured; **keep the lever only if local CER moves**. No jank: hover
latency unchanged (voting is in the Swift process, off the render path).

---

## Phase 3 — Tier 2: manga-ocr accurate tier, shadow mode first (days) [§8 lever 6]

**Goal:** on-demand accurate recognition of the cursor region. Text from
manga-ocr; geometry stays with the existing mechanisms. Ship in shadow mode:
log disagreements vs Tier 1, promote only on measured CER win.

### 3.1 Python sidecar — `overlay/mangaocr_sidecar.py`
There is no Python-at-runtime precedent in the repo (Python is build-time
only) — this creates one, deliberately minimal:
- Long-running process, spawned/supervised by `main.js` exactly like the two
  `yomi` children (`startOCR()` pattern at `main.js:207`, incl. the
  backoff/restart logic at `:283-290`). Model loads once, stays warm.
- Protocol: NDJSON over stdin/stdout — request
  `{"id":n,"image":"/path/crop.png"}`, reply
  `{"id":n,"text":"...","ms":123}`. stderr = diagnostics.
- Engine: `manga_ocr` package (kha-white/manga-ocr, ~400–444 MB weights),
  PyTorch with explicit `torch.device("mps")` override (upstream has no MPS
  wiring; the community wrapper proves it works). It reads a whole multi-line
  bubble/crop in one pass, both orientations, no line splitting, no reflow.
  It emits **no geometry and no confidence** — text only, by design.
- `setup.sh`: add a step creating `overlay/.venv` (first venv in the project —
  keep it out of the Electron packaging path) and `pip install manga-ocr
  torch`. Guard: if install or MPS init fails, sidecar exits nonzero and
  main.js disables Tier 2 for the session (degrade honestly — tray note, no
  silent substitute).
- RAM discipline: ~400 MB weights + PyTorch runtime is the biggest resident
  cost in the plan. Sidecar is **lazy** — spawn on first Tier-2 request, kill
  after configurable idle (default 10 min).

### 3.2 Crop plumbing
Trigger: Shift-point (existing `doLookup`, `index.html:465`) on a
low-confidence line, or explicit config `tier2.mode: 'always'|'gated'|'off'`.
- Renderer → `preload.js` → `main.js`: new IPC `tier2Lookup(lineRect)` carrying
  the line's frame-space rect (renderer already has per-char boxes; union the
  line).
- `main.js` → `yomi`: add a **stdin command channel** to the watch
  process — a line `crop x y w h path\n` makes it write that sub-rect of the
  *last captured frame* (upscaled 2×, matching PLAN.md's cursor-region
  re-OCR idea) to `path` and ack on stdout as
  `{"crop":{"id":...,"path":...}}`. Reusing the last frame avoids a second
  SCK session (concurrent sessions stall — measured, see CONVENTIONS).
- `main.js` sends the path to the sidecar, gets text back.

### 3.3 Text/geometry marriage (the report's core split)
- **Vertical:** manga-ocr text → existing cells via **strip-position mapping
  is not applicable** (no strip); instead map by count/order per column —
  manga-ocr returns reading-order text; assign chars to the column's cells
  top-to-bottom, RTL across columns (cells from `tategakiCells` on the crop).
  Mismatched counts (dropped/merged chars) resolve by the same philosophy as
  strip-position mapping: never shift the whole tail; align greedily and leave
  unmatched cells textless.
- **Horizontal:** Phase 3 uses Tier-1 geometry (Vision/Live Text char boxes)
  with manga-ocr text aligned by edit-distance alignment (stdlib alignment in
  the sidecar reply is fine). PaddleOCR `return_word_box` geometry is
  **Phase 6**, not here.
- **Shadow mode (default on landing):** Tier 2 runs, logs
  `{tier1Text, tier2Text, editDistance}` to `/tmp/yomi-overlay.log`, but the
  popup still uses Tier-1 text. Disagreement rate is the first real accuracy
  signal and costs a log file.

**Gates:**
- Sidecar p50 latency ≤ 1.5 s on a cursor-region crop on this M1 (budget
  around CPU, not GPU — recognition is MPS-fast, any detection is CPU).
- Phase 0 CER for manga-ocr per category (run all 100 crops through the
  sidecar). **Promote shadow → live only where measured CER beats Tier 1.**
  If manga-ocr lands above ~25–30% CER on our content, stop and run
  Experiment E2/E4 before promoting anything.
- Memory: RSS of sidecar bounded (< 1.5 GB) and no swap growth during use.

**Revert:** `tier2.mode:'off'` (config), sidecar never spawns.

---

## Phase 4 — Furigana: filter first, exploit second (days) [§8 levers 4, 10]

**Goal:** stop ruby lines polluting lookups (+5% avg CER on Manga109 cited for
removal-before-recognition; +7% furigana-heavy; −0.3% on sparse pages — hence
*conditional*).

### 4.1 Heuristic filter (PLAN.md Stage 2 item, now with a gate)
- In Swift, post-recognition: drop (mark, don't delete) lines whose glyph
  height is ~40–60% of an adjacent line's and which sit beside it (above for
  horizontal, right for vertical columns). Emit them with `"ruby":true`
  rather than removing — the renderer excludes ruby spans from hit-testing;
  the data is retained for 4.2.
- **Conditional rule:** apply only when the page shows a bimodal height
  distribution (guards the −0.3% regression on sparse pages, and the known
  failure where an over-aggressive filter suppresses the whole overlay).
- Simple thresholding is measured F1=0 **on comics** — accept that this
  heuristic is for text-page content (Kindle/browser); manga bubbles get
  theirs from Phase 3's detector work if/when comic-text-detector is added.

### 4.2 Furigana as reading hints (novel — zero implementations exist)
- When a ruby line is adjacent to a base line, attach `hint: "なま"` to the
  base chars' payload. In `lookup.js`, when multiple dictionary entries match
  the same surface form, prefer the entry whose reading matches the hint.
  Product-value lever, not a CER lever; near-zero cost once 4.1 exists.

**Gate:** on tategaki-with-furigana crops: ruby lines no longer appear as
lookup targets; CER on those crops improves or holds; `verify_vertical.py`
placement does not regress.

---

## Phase 5 — Geometry refinement (≈1 week) [§8 lever 11; PLAN.md Stage 1 remainder]

**Goal:** cell placement 77% → 90%+ on the DOM-truth suite, validated on real
Kindle pages.

- Attack the diagnosed failure: cell-boundary jitter on small kana and
  punctuation. Site: `tategakiCells` y-projection split (`:654`), the
  `0.3 * em` gap threshold and the equal-split of over-tall runs (`:657-665`).
  Candidate fixes (measure each): adaptive `minGap` from the page's own glyph
  height distribution; merge undersized trailing cells (ゃゅょっ、。)
  into neighbors by area ratio before equal-splitting.
- Validate on **real Kindle pages with furigana** (Phase 4's filter must land
  first or ruby noise dominates), not only the synthetic rig.
- **Transposition experiment:** run the same splitter on horizontal content
  (x/y swapped). Nothing about ink-run analysis privileges columns. If
  placement ≥ Vision's interpolated boxes (`boundingBox(for:)` path,
  `:846-864`), one mechanism serves both orientations and a code path
  retires (CONVENTIONS: prefer deleting a mechanism).
- Line-height robustness below ~1.4 line spacing (PLAN.md Stage 1 note) —
  the adaptive `minGap` addresses this; add a dense-layout page to the rig.

**Gate:** `verify_vertical.py` placement ≥ 0.9; coverage ≥ 0.95 held; real
Kindle spot-check documented with numbers in the PLAN.md style.

---

## Phase 6 — CTC component + gated rescoring (1 week+, conditional) [§8 levers 7, 8, 9]

**Only start after Phases 0–3 are landed and Experiment E1 has run.** This is
where lexicon rescoring becomes possible at all — position 7 is the
precondition for a third of the lever list.

### 6.1 PaddleOCR as geometry + confidence source (horizontal)
- Add to the Python sidecar (same process, second engine):
  PP-OCRv5_mobile / PP-OCRv6 tiny-to-mobile det+rec, CPU (no Metal for
  traditional pipelines — this is a known limit, not a bug), with
  `return_word_box=True` and `use_textline_orientation=True`.
- Consume **`word_col_list` CTC frame indices directly** — never the grouped
  word polygons (kana vs kanji group inconsistently; the per-char frame index
  survives grouping). Each char is localized by one peak frame → interpolate
  box extents between anchor frames. Rescale by `wh_ratio / max_wh_ratio` as
  `rec_postprocess.py` does.
- **Surface per-char posteriors:** patch/subclass `CTCLabelDecode` to return
  `text_prob[selection]` instead of its mean — the cited one-line change.
  Temperature-scale (calibration measurably improves conf↔accuracy
  correlation, 0.45→0.74 cited). Feed into the `conf` field of the glyph
  record (2.2).
- First thing to tune on M1: **operator thread count sweep 1–8**
  (Experiment E3) — the vendor's own M4 run shows ~1 busy core; a several-fold
  win may precede any model choice. Then DBNet detector thresholds (they
  bound everything downstream).

### 6.2 Lexicon rescoring, gated (lever 8)
- **Rescore, never hard-constrain** (names/onomatopoeia are out-of-lexicon;
  hard constraint measured to hurt below ~2% CER: 0.76%→1.04% cited).
- Mechanism: for low-confidence positions only (gate: conf below threshold
  tuned on Phase 0 set; start at the analog of "certainty ≤ 80"), enumerate
  top-k CTC alternatives per position, prefer candidate strings whose
  maximal-munch segmentation covers more of the 2M-term `index.db` (the
  index and deinflector already exist — `lookup.js`).
- Kanji confusion tie-breaking (lever 9) inside the rescorer only: when two
  lexicon candidates tie, prefer the one whose differing kanji is shape-near
  the recognized glyph (radical-decomposition distance; small measured gains,
  +0.3–1.3 pts — a tie-breaker, not a ranker; candidate generation is
  top-k posteriors, which is a strictly better generator than confusion
  matrices).

**Gates:** per-lever CER delta on Phase 0 set; **drop any lever that doesn't
move it** (PLAN.md Stage 3's own rule). Rescoring must show zero regression
on the clean-text categories (browser/Kindle horizontal) before enabling
anywhere.

---

## Phase 7 — Preprocessing odds and ends (as time allows) [§8 lever 12]

- **Dark-mode inversion** before recognition when the page is dark
  (mean-luminance check on the ink mask, which already samples pixels —
  `inkMask` `:578`). Nearly free; ships as a production flag elsewhere.
- **Super-resolution gated on measured glyph height** < ~12 px only (game UI
  text), anime-domain upscaler (waifu2x-class) — SR on Retina Kindle text is
  expected ~zero gain (already oversampled); do not run unconditionally.
- Skip binarization entirely (see do-not-build list).

**Gate:** CER delta on the game category of the Phase 0 set.

---

## Experiments appendix (each hours–half a day, run when its phase nears)

| # | Experiment | Flip condition → consequence |
|---|---|---|
| E1 | `return_word_box` on a 90°-rotated tategaki column crop | Boxes come back LTR regardless of orientation (documented inverted-text bug) → orientation split is *necessary*; ink-run splitter stays primary for vertical permanently |
| E2 | Head-to-head CER on Phase 0 set (NFKC'd): manga-ocr vs PP-OCRv5_server_rec vs PP-OCRv6_medium vs NDLOCR-Lite | PP-OCRv5 CER ≈ manga-ocr → single-runtime design wins retroactively; Tier 2 collapses to PaddleOCR. manga-ocr > ~25–30% CER → memory probe (E4) urgent |
| E3 | PaddlePaddle thread-count sweep 1–8 on M1 | No latency change → CPU path genuinely single-threaded/unfixable; promote NDLOCR-Lite's ONNX runtime |
| E4 | PaddleOCR-VL-For-Manga memory probe (Swift MLX single-process port first) | Cursor crop in 1–2 s, no swap, bounded RSS → becomes Tier-2 *text* engine (10.88% CER, replicated); never the geometry source |
| E5 | Live Text quad stability on furigana-heavy + mixed-orientation crops; plain `VNRecognizeTextRequest` on the same tategaki crop as control | `.children()` breaks on ruby → Tier-1 geometry claim narrows, Phase 5 priority rises. Vision now reads vertical CJK → fallback chain simplifies |
| E6 | meikiocr per-character output shape | Per-char x-positions are real → single component for text+geometry+confidence on horizontal/game content |

CRAFT zero-shot stays at the bottom of the queue; expect it to die there.

---

## Config additions (accumulate in `overlay/config.js` DEFAULTS)

```js
engine: 'auto',                 // Phase 1: 'vision' | 'livetext' | 'auto'
voting: { passes: 3, everyN: 2 },        // Phase 2
tier2:  { mode: 'shadow',                 // Phase 3: 'off'|'shadow'|'gated'|'always'
          idleKillMin: 10 },
furigana: { filter: true, hints: true },  // Phase 4
rescore: { enabled: false, gate: 0.8 },   // Phase 6
```

Settings UI rows follow the existing Lookup-tab pattern (hide irrelevant rows
per mode).

## Sequencing & dependency summary

```
P0 (harness) ──► P1 (Live Text) ──► P2 (conf+voting+NFKC) ──► P3 (manga-ocr shadow)
                                            │                      │
                                            ▼                      ▼
                                    P4 (furigana) ──► P5 (geometry 90%)
                                                           │
                                   E1,E2,E3 ──────────────► P6 (CTC + rescoring)
                                                            P7 (preprocessing)
```

Every phase is independently shippable and independently revertible; the
overlay never stops working. Absent by design: no rewrite, no second resident
server process (the sidecar is on-demand and idle-killed), no Core ML
conversion, no fine-tuning run.

## Horizon note (when to revisit this plan)

- At 16 GB RAM: PaddleOCR-VL-For-Manga flips gated → recommended (E4 becomes
  a promotion test); a second resident model becomes affordable. Memory-gated
  decisions flip; architecture-gated (per-char geometry self-service) and
  throughput-gated (Surya-class latency) ones do not.
- MLX is the credible future runtime (quantized VLMs, KV-cache quantization
  −76%, vision-feature caching >11× on repeated identical images — made for a
  loop staring at a static page). When someone measures that on an OCR VLM at
  8 GB, re-run E4 on evidence.
- The recognizers will keep changing; the glyph-record layer (2.2) is the
  part this project owns.
