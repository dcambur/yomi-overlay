#!/bin/bash
# Golden-master harness for the refactor (REFACTOR-INTEGRATION.md step 0).
#
# Runs kindleocr over a fixed image corpus and stores one NDJSON payload plus
# one stderr transcript per image. A STRUCTURAL change must not move a single
# byte of either. Behaviour changes are expected to move bytes — that is the
# point: this harness is what makes "move code, or change code, never both"
# checkable rather than aspirational.
#
#   test/golden.sh record baseline    # capture the reference
#   test/golden.sh check  baseline    # diff current output against it
#
# Why --image and not a capture: this path opens no ScreenCaptureKit session
# and needs no Screen Recording grant, so it runs headlessly AND while the
# overlay is up. Measured: a full run with the overlay running succeeds, where
# a one-shot --dump capture would stall on the concurrent SCK session.
#
# stderr is captured as well as stdout because the engine/orientation/furigana
# diagnostics are the only visible signal for policy decisions that do not
# change the payload — an orientation probe that silently starts committing
# horizontal would otherwise pass a stdout-only diff.
#
# The corpus is a fixed list (test/golden-corpus.txt), not a find(1) walk:
# test/gt/ holds ~3800 rendered pages, and a full pass costs ~90 minutes.
# The list takes every image from the small hand-built categories and every
# 100th epub page, which covers all four orientations, furigana, and the
# vertical/mixed paths in ~2 minutes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCR="${KINDLEOCR:-$HERE/../kindleocr}"
CORPUS="$HERE/golden-corpus.txt"

MODE="${1:-}"
NAME="${2:-}"
[ -n "$MODE" ] && [ -n "$NAME" ] || { echo "usage: golden.sh record|check NAME" >&2; exit 2; }
[ -x "$OCR" ] || { echo "no kindleocr at $OCR" >&2; exit 2; }
[ -f "$CORPUS" ] || { echo "no corpus list at $CORPUS" >&2; exit 2; }

run_corpus() {
  local dest="$1" n=0
  mkdir -p "$dest"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    local img="$HERE/gt/$rel"
    # Flat, filesystem-safe key so a diff of two directories reads cleanly.
    local key="${rel//\//_}"
    key="${key%.png}"
    if [ ! -f "$img" ]; then
      echo "MISSING" > "$dest/$key.json"
      echo "missing image: $rel" > "$dest/$key.err"
      continue
    fi
    # Never abort the run on one bad image: a non-zero exit is itself part of
    # the recorded behaviour, so record it instead of losing the whole pass.
    set +e
    "$OCR" --image "$img" --json > "$dest/$key.json" 2> "$dest/$key.err"
    echo "exit=$?" >> "$dest/$key.err"
    set -e
    n=$((n + 1))
    printf '\r  %d/%d' "$n" "$(wc -l < "$CORPUS" | tr -d ' ')" >&2
  done < "$CORPUS"
  printf '\r' >&2
  assert_recognised "$dest"
}

# A harness that passes when nothing was recognised is a broken harness
# (CONVENTIONS.md). `check` already catches total failure — an all-empty run
# cannot match a populated baseline — but `record` would happily freeze one in,
# and every later check would then compare two identical piles of nothing.
# Measured floor at the time of writing: 66 payloads, 197 lines, 5116 glyphs,
# zero empty. The floor is deliberately slack (it guards against catastrophe,
# not drift); byte-exactness is what guards against drift.
assert_recognised() {
  python3 - "$1" <<'PY'
import json, pathlib, sys
d = pathlib.Path(sys.argv[1])
glyphs = nonempty = 0
for f in d.glob('*.json'):
    try:
        p = json.loads(f.read_text())
    except Exception:
        continue
    g = sum(len(l.get('chars', [])) for l in p.get('lines', []))
    glyphs += g
    nonempty += g > 0
if glyphs < 4500 or nonempty < 60:
    sys.exit(f"CORPUS TOO THIN: {nonempty} non-empty payloads, {glyphs} glyphs "
             f"(need >=60 and >=4500). The binary, the corpus, or recognition "
             f"itself is broken — do not trust this run.")
print(f"  {nonempty} non-empty payloads, {glyphs} glyphs")
PY
}

case "$MODE" in
  record)
    dest="$HERE/golden/$NAME"
    rm -rf "$dest"
    echo "recording -> test/golden/$NAME"
    run_corpus "$dest"
    echo "recorded $(ls "$dest" | wc -l | tr -d ' ') files"
    ;;
  check)
    ref="$HERE/golden/$NAME"
    [ -d "$ref" ] || { echo "no baseline at $ref — run: golden.sh record $NAME" >&2; exit 2; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    echo "checking against test/golden/$NAME"
    run_corpus "$tmp"
    if diff -r "$ref" "$tmp" > /tmp/golden.diff 2>&1; then
      echo "GOLDEN OK — byte identical ($(ls "$ref" | wc -l | tr -d ' ') files)"
    else
      echo "GOLDEN FAILED — full diff in /tmp/golden.diff"
      grep -c '^[<>]' /tmp/golden.diff | sed 's/^/  differing lines: /' || true
      head -40 /tmp/golden.diff
      exit 1
    fi
    ;;
  *)
    echo "usage: golden.sh record|check NAME" >&2; exit 2 ;;
esac
