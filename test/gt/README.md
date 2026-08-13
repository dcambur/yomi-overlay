# Ground-truth set (Phase 0 of ../../INTEGRATION.md)

Target: **100 crops, 20 per directory** — `horizontal/` (Kindle),
`tategaki/` (Kindle, *with furigana*), `manga/` (bubbles), `game/`,
`browser/`. The two `smoke_*` files are synthetic plumbing tests, not
benchmark data; exclude them from reported numbers once real crops exist.

## Collecting a crop

1. Stop the overlay (a running watch loop stalls one-shot SCK captures).
2. Put real content on screen, then: `../../bin/kindleocr --dump /tmp/page.png`
   (or any screenshot). Crop the region you'll transcribe (Preview, or
   `sips -c`). Save as `<category>/<shortname>.png`.
3. Hand-type the truth into `<category>/<shortname>.txt`:
   - Unicode **as displayed** — do NOT normalize (scoring NFKC-normalizes
     both sides itself).
   - Reading order: vertical = columns right-to-left, top-to-bottom.
   - Furigana on their own lines prefixed `#ruby:` (excluded from scoring
     by default; `--include-ruby` scores them).
   - `#` lines are comments.

## Generated corpus sets (epub_h / epub_v)

`gen_epub.py --epub book.epub --prefix name --per 2` renders a whole novel
into thousands of truth-by-construction crops, both orientations, with the
book's real `<ruby>` furigana rendered half-size and recorded as `#ruby:`
lines. Like the aozora_* sets these are SYNTHETIC — they calibrate engines
and catch regressions at corpus scale, and never replace the hand-collected
real crops above. Current contents: 3,800 crops from 狼と香辛料 (`wolf_*`,
950 passages × 2 size/font variants × 2 orientations; baseline micro-CER
0.013 h / 0.012 v on a 15-crop sample, 2026-08-10).

Score them sampled — a full pass is thousands of engine runs:

```
python3 ../cer.py --category epub_h --category epub_v --sample 50
```

## Scoring

```
python3 ../cer.py                       # all categories, kindleocr engine
python3 ../cer.py --category tategaki --engine-arg=--vertical
python3 ../cer.py --from-json /path/outputs   # any other engine's outputs
python3 ../cer.py --min-crops 90        # the real gate once the set is full
```

Record baseline numbers in INTEGRATION.md Phase 0 before any engine change.
