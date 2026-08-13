#!/usr/bin/env python3
"""CER harness — Phase 0 of INTEGRATION.md.

Scores an OCR engine against the hand-transcribed ground-truth set in
test/gt/. Ground truth is one .txt per crop image (same basename):

    gt/<category>/<name>.png      the crop (collected via kindleocr --dump
                                  or any screenshot tool, then cropped)
    gt/<category>/<name>.txt      hand-typed truth, Unicode as displayed.
                                  Lines starting with '#ruby:' are furigana
                                  and are excluded from scoring by default.
                                  Lines starting with '#' are comments.

Scoring pipeline (applied symmetrically to hypothesis and truth):
  strip #ruby:/# lines -> NFKC normalize -> drop all whitespace ->
  character-level Levenshtein.  CER = distance / len(truth).

Engines:
  --engine kindleocr   (default) runs ../kindleocr --image CROP and reads
                       stdout text. Add extra engine flags via --engine-arg
                       (e.g. --engine-arg=--vertical for forced tategaki).
  --from-json DIR      score pre-computed outputs instead of running an
                       engine: DIR/<category>/<name>.json in the kindleocr
                       NDJSON payload shape ({"lines":[{"text":...}]}), or
                       DIR/<category>/<name>.txt as plain text. This is how
                       later engines (Live Text, manga-ocr, PaddleOCR) reuse
                       the scorer without this script knowing about them.

A run that scores nothing must fail loudly (CONVENTIONS: a test that can
pass when nothing was captured is a broken test): --min-crops (default 1,
raise to 90 once the full set exists) gates the exit code.
"""

import argparse
import json
import random
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
GT_DIR = HERE / "gt"
# Where kindleocr lives is not this suite's business — ask the one file
# that knows the layout. Keeps the suites working across a move.
sys.path.insert(0, str(HERE.parent / "overlay"))
from paths import OCR_BIN as KINDLEOCR
# Canonical categories first, then any extra gt/ subdirectory (e.g. the
# generated aozora_* sets) discovered on disk.
_CANON = ("horizontal", "tategaki", "manga", "game", "browser")
CATEGORIES = _CANON + tuple(sorted(
    d.name for d in GT_DIR.iterdir()
    if d.is_dir() and d.name not in _CANON)) if GT_DIR.is_dir() else _CANON


def normalize(text, include_ruby=False):
    """Ground-truth/hypothesis text -> comparable character string."""
    kept = []
    for line in text.splitlines():
        if line.startswith("#ruby:"):
            if include_ruby:
                kept.append(line[len("#ruby:"):])
            continue
        if line.startswith("#"):
            continue
        kept.append(line)
    s = unicodedata.normalize("NFKC", "\n".join(kept))
    # Ellipsis display variants are equivalent for lookup purposes: vertical
    # renderers draw …… as dot runs and engines read them back as ・/. runs
    # (measured: LT reads kakuyomu's …… as ・・・・・・). Fold every 3+ dot
    # run — and NFKC's …→"..." expansion — into one mark, both sides.
    s = re.sub(r"[・.．…]{3,}", "…", s)
    return "".join(s.split())  # drop ALL whitespace, incl. line breaks


def levenshtein(a, b):
    """Plain O(len(a)*len(b)) edit distance; crops are short."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1,          # deletion
                           cur[j - 1] + 1,       # insertion
                           prev[j - 1] + (ca != cb)))  # substitution
        prev = cur
    return prev[-1]


def run_kindleocr(crop, extra_args):
    p = subprocess.run(
        [str(KINDLEOCR), "--image", str(crop), *extra_args],
        capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f"kindleocr exit {p.returncode}: {p.stderr.strip()}")
    return p.stdout


def read_precomputed(json_dir, category, stem):
    base = Path(json_dir) / category / stem
    j, t = base.with_suffix(".json"), base.with_suffix(".txt")
    if j.exists():
        payload = json.loads(j.read_text())
        return "\n".join(l["text"] for l in payload.get("lines", []))
    if t.exists():
        return t.read_text()
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine", default="kindleocr",
                    help="engine to run (default: kindleocr)")
    ap.add_argument("--engine-arg", action="append", default=[],
                    help="extra flag passed to the engine (repeatable)")
    ap.add_argument("--from-json", metavar="DIR",
                    help="score precomputed outputs from DIR instead")
    ap.add_argument("--category", action="append", choices=CATEGORIES,
                    help="restrict to category (repeatable; default all)")
    ap.add_argument("--include-ruby", action="store_true",
                    help="score furigana lines too (default: excluded)")
    ap.add_argument("--sample", type=int, metavar="N",
                    help="score at most N crops per category, picked with a "
                         "fixed seed so runs are comparable (the generated "
                         "epub_* sets hold thousands of crops)")
    ap.add_argument("--min-crops", type=int, default=1,
                    help="fail unless at least this many crops scored")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="per-crop hypothesis/truth dump on mismatch")
    args = ap.parse_args()

    categories = args.category or CATEGORIES
    results = {}   # category -> list of (name, cer, dist, truth_len)
    errors = []

    for cat in categories:
        cdir = GT_DIR / cat
        if not cdir.is_dir():
            continue
        crops = sorted(cdir.glob("*.png"))
        if args.sample and len(crops) > args.sample:
            crops = sorted(random.Random(0).sample(crops, args.sample))
        for crop in crops:
            truth_file = crop.with_suffix(".txt")
            if not truth_file.exists():
                errors.append(f"{crop.name}: no ground truth .txt")
                continue
            truth = normalize(truth_file.read_text(), args.include_ruby)
            if not truth:
                errors.append(f"{crop.name}: empty ground truth")
                continue
            try:
                if args.from_json:
                    raw = read_precomputed(args.from_json, cat, crop.stem)
                    if raw is None:
                        errors.append(f"{crop.name}: no precomputed output")
                        continue
                elif args.engine == "kindleocr":
                    raw = run_kindleocr(crop, args.engine_arg)
                else:
                    sys.exit(f"unknown engine: {args.engine}")
            except Exception as e:  # engine crash on one crop != run abort
                errors.append(f"{crop.name}: {e}")
                continue
            hyp = normalize(raw, args.include_ruby)
            dist = levenshtein(hyp, truth)
            cer = dist / len(truth)
            results.setdefault(cat, []).append((crop.stem, cer, dist, len(truth)))
            if args.verbose and dist:
                print(f"--- {cat}/{crop.stem}  CER {cer:.3f} ({dist}/{len(truth)})")
                print(f"    hyp:   {hyp[:80]}")
                print(f"    truth: {truth[:80]}")

    scored = sum(len(v) for v in results.values())
    print(f"\n== CER by category ({scored} crops) ==")
    total_dist = total_len = 0
    for cat in categories:
        rows = results.get(cat, [])
        if not rows:
            print(f"  {cat:<11} (no crops)")
            continue
        d = sum(r[2] for r in rows)
        n = sum(r[3] for r in rows)
        total_dist += d
        total_len += n
        mean = sum(r[1] for r in rows) / len(rows)
        print(f"  {cat:<11} crops={len(rows):<3} "
              f"micro-CER={d / n:.4f}  mean-CER={mean:.4f}")
    if total_len:
        print(f"  {'ALL':<11} crops={scored:<3} micro-CER={total_dist / total_len:.4f}")

    for e in errors:
        print(f"warn: {e}", file=sys.stderr)
    if scored < args.min_crops:
        sys.exit(f"FAIL: scored {scored} crops, need >= {args.min_crops}")


if __name__ == "__main__":
    main()
