#!/usr/bin/env python3
"""Generate a large ground-truth set from an EPUB novel, truth by construction.

Same idea as gen_aozora.py — render text we control, write the render input as
the truth file — but at corpus scale and with real furigana: EPUB novels carry
<ruby>base<rt>reading</rt></ruby> markup, so ruby is rendered the way a real
book sets it (half-size, above the line / right of the column) and recorded in
the sidecar as `#ruby:` lines per the gt/README.md convention.

Pipeline: spine HTML -> paragraphs (ruby kept as atomic segments) -> sentence
units -> passages packed to cycling length targets -> one horizontal and one
vertical render per passage, cycling font/size/spacing/width variants.

Output: gt/epub_h/ and gt/epub_v/ (auto-discovered by ../cer.py; they are
SYNTHETIC categories like aozora_* — they never replace real captured crops).
A full novel produces thousands of crops; score with `cer.py --sample N`.

Tategaki approximations are inherited from gen_aozora.py (chōonpu rotated,
、。 in the cell corner, brackets unrotated) — same honest PIL limits.

Usage:
  python3 gen_epub.py --epub /path/to/book.epub [--prefix wolf] [--limit N]
"""

import argparse
import itertools
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from gen_aozora import ROTATE, CORNER, MINCHO, GOTHIC

HERE = Path(__file__).resolve().parent

JP = re.compile(r"[぀-ヿ㐀-䶿一-鿿々〆ヶ]")
TERMINAL = "。！？"
CONTINUE = "」』）。！？…"


# --- EPUB -> paragraphs of segments -----------------------------------------
# A paragraph is a list of (text, ruby) segments; ruby is None for plain text.
# Ruby groups stay atomic through every later stage so a reading is never
# split across a line, column, or passage boundary.

class Extractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paras = []
        self.cur = None
        self.base = None
        self.rt = None
        self.in_rt = False
        self.in_rp = False
        self.skip = 0
        self.tainted = False   # paragraph contains an image (gaiji) — skip it

    def _open(self):
        self._flush()
        self.cur, self.tainted = [], False

    def _flush(self):
        if self.cur:
            merged = []
            for text, ruby in self.cur:
                if ruby is None and merged and merged[-1][1] is None:
                    merged[-1] = (merged[-1][0] + text, None)
                else:
                    merged.append((text, ruby))
            plain = "".join(t for t, _ in merged)
            if not self.tainted and len(JP.findall(plain)) >= 10:
                self.paras.append(merged)
        self.cur = None

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag == "p":
            self._open()
        elif tag == "br":
            if self.cur is not None:
                self._open()
        elif tag == "ruby" and self.cur is not None:
            self.base, self.rt = [], []
        elif tag == "rt":
            self.in_rt = True
        elif tag == "rp":
            self.in_rp = True
        elif tag == "img" and self.cur is not None:
            self.tainted = True

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag == "p":
            self._flush()
        elif tag == "rt":
            self.in_rt = False
        elif tag == "rp":
            self.in_rp = False
        elif tag == "ruby" and self.base is not None:
            b, r = "".join(self.base), "".join(self.rt)
            if b:
                self.cur.append((b, r or None))
            self.base = self.rt = None

    def handle_data(self, data):
        if self.skip or self.cur is None or self.in_rp:
            return
        data = re.sub(r"[​﻿\r\n\t]", "", data)
        if not data:
            return
        if self.base is not None:
            (self.rt if self.in_rt else self.base).append(data)
        else:
            self.cur.append((data, None))


def extract_paragraphs(epub_path):
    paras = []
    with zipfile.ZipFile(epub_path) as z:
        # Spine order == sorted name order for Calibre-style EPUBs; parsing
        # content.opf buys nothing for a truth set where order is cosmetic.
        docs = sorted(n for n in z.namelist()
                      if n.lower().endswith((".html", ".xhtml", ".htm")))
        for name in docs:
            ex = Extractor()
            ex.feed(z.read(name).decode("utf-8", errors="replace"))
            ex._flush()
            paras.extend(ex.paras)
    return paras


# --- passages ---------------------------------------------------------------
# unit = ("च", None) single plain char, or ("日和", "ひより") atomic ruby group

def units_of(segments):
    units = []
    for text, ruby in segments:
        if ruby:
            units.append((text, ruby))
        else:
            units.extend((ch, None) for ch in text)
    return units


def sentences(units):
    """Split a unit list at sentence ends (terminal punct not followed by a
    closer/another terminal). Coarse on purpose: passages are packed to length
    targets, so a boundary missed here just lands in the same passage."""
    out, cur = [], []
    for i, u in enumerate(units):
        cur.append(u)
        if u[1] is None and u[0] in TERMINAL:
            nxt = units[i + 1] if i + 1 < len(units) else None
            if not (nxt and nxt[1] is None and nxt[0] in CONTINUE):
                out.append(cur)
                cur = []
    if cur:
        out.append(cur)
    return out


def plain_len(units):
    return sum(len(t) for t, _ in units)


def pack_passages(paras, targets=(60, 90, 120, 160, 200), min_tail=40):
    cycle = itertools.cycle(targets)
    passages, cur, tgt = [], [], next(cycle)
    for para in paras:
        for sent in sentences(units_of(para)):
            cur.extend(sent)
            if plain_len(cur) >= tgt:
                passages.append(cur)
                cur, tgt = [], next(cycle)
    if plain_len(cur) >= min_tail:
        passages.append(cur)
    return passages


# --- rendering --------------------------------------------------------------

def render_horizontal(units, font_path, size, gap, width, dark=False):
    font = ImageFont.truetype(font_path, size)
    ruby_size = max(7, size // 2)
    ruby_font = ImageFont.truetype(font_path, ruby_size)
    margin = size
    top = margin + ruby_size          # first line's ruby needs headroom
    step = int(size * gap)
    d = ImageDraw.Draw(Image.new("RGB", (8, 8)))

    lines, cur, cur_w = [], [], 0     # line = [(unit, x)]
    max_w = width - 2 * margin
    for u in units:
        w = d.textlength(u[0], font=font)
        if cur and cur_w + w > max_w:
            lines.append(cur)
            cur, cur_w = [], 0
        cur.append((u, margin + cur_w))
        cur_w += w
    if cur:
        lines.append(cur)

    h = top + step * len(lines) + margin
    bg, fg = ("black", "white") if dark else ("white", "black")
    img = Image.new("RGB", (width, h), bg)
    dr = ImageDraw.Draw(img)
    ruby_out = []
    for li, line in enumerate(lines):
        y = top + li * step
        for (text, ruby), x in line:
            dr.text((x, y), text, font=font, fill=fg)
            if ruby:
                bw = dr.textlength(text, font=font)
                rw = dr.textlength(ruby, font=ruby_font)
                dr.text((x + (bw - rw) / 2, y - ruby_size - 1),
                        ruby, font=ruby_font, fill=fg)
                ruby_out.append(ruby)
    truth = "\n".join("".join(t for (t, _), _ in line) for line in lines)
    return img, truth, ruby_out


def render_vertical(units, font_path, size, gap, height):
    """Columns right-to-left, ruby half-size on the column's right side."""
    font = ImageFont.truetype(font_path, size)
    ruby_size = max(7, size // 2)
    ruby_font = ImageFont.truetype(font_path, ruby_size)
    margin = size
    cell = int(size * 1.05)
    ruby_cell = int(ruby_size * 1.05)
    per_col = max(1, (height - 2 * margin) // cell)

    cols, cur, used = [], [], 0       # col = [(unit, row)]
    for text, ruby in units:
        n = len(text)
        # A ruby group never splits across columns; one longer than a whole
        # column loses its ruby and flows as plain chars (rare, honest).
        if ruby and n > per_col:
            text, ruby = text, None
        if ruby is None:
            for ch in text:
                if used >= per_col:
                    cols.append(cur)
                    cur, used = [], 0
                cur.append(((ch, None), used))
                used += 1
            continue
        if used + n > per_col and cur:
            cols.append(cur)
            cur, used = [], 0
        cur.append(((text, ruby), used))
        used += n
    if cur:
        cols.append(cur)

    step_x = int(size * gap)
    width = 2 * margin + step_x * len(cols)
    img = Image.new("RGB", (width, height), "white")
    dr = ImageDraw.Draw(img)
    ruby_out = []
    for ci, col in enumerate(cols):
        x = width - margin - (ci + 1) * step_x
        for (text, ruby), row in col:
            for k, ch in enumerate(text):
                y = margin + (row + k) * cell
                if ch in ROTATE:
                    tile = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
                    ImageDraw.Draw(tile).text((size // 2, size // 2), ch,
                                              font=font, fill="black")
                    tile = tile.rotate(-90)
                    img.paste(tile, (x - size // 2, y - size // 2), tile)
                elif ch in CORNER:
                    dr.text((x + size // 2, y - size // 4), ch,
                            font=font, fill="black")
                else:
                    dr.text((x, y), ch, font=font, fill="black")
            if ruby:
                span = len(text) * cell
                rspan = len(ruby) * ruby_cell
                ry = margin + row * cell + max(0, (span - rspan) // 2)
                for k, rch in enumerate(ruby):
                    dr.text((x + size + 1, ry + k * ruby_cell),
                            rch, font=ruby_font, fill="black")
                ruby_out.append(ruby)
    truth = "\n".join(
        "".join(t for (t, _), _ in col) for col in cols)
    return img, truth, ruby_out


# --- main -------------------------------------------------------------------

H_VARIANTS = [   # (font, size, line-gap, page width, dark)
    (MINCHO, 22, 1.6, 860, False), (MINCHO, 16, 1.7, 760, False),
    (GOTHIC, 20, 1.7, 900, False), (MINCHO, 26, 1.8, 980, False),
    (GOTHIC, 14, 1.6, 700, False), (MINCHO, 20, 1.7, 860, True),
    (MINCHO, 18, 1.6, 820, False), (GOTHIC, 24, 1.7, 940, False),
]
V_VARIANTS = [   # (font, size, column-gap, page height)
    (MINCHO, 24, 1.9, 780), (MINCHO, 18, 1.8, 680),
    (MINCHO, 28, 2.0, 860), (GOTHIC, 22, 1.9, 760),
    (MINCHO, 20, 1.8, 720), (MINCHO, 16, 1.7, 620),
    (GOTHIC, 18, 1.9, 700), (MINCHO, 26, 2.0, 820),
]


def write_case(out_dir, stem, img, truth, ruby, note):
    img.save(out_dir / f"{stem}.png")
    lines = [f"# {note}", truth]
    lines += [f"#ruby:{r}" for r in ruby]
    (out_dir / f"{stem}.txt").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--epub", required=True, help="path to the .epub")
    ap.add_argument("--prefix", default="epub",
                    help="case filename prefix (default: epub)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap the number of passages (0 = all)")
    ap.add_argument("--per", type=int, default=1,
                    help="renders per passage per orientation, each under a "
                         "different size/font variant (default 1). Same text "
                         "at different glyph sizes fails differently — "
                         "measured: tier-2 agreement 94%% at 24px vs 27%% at "
                         "18px — so extra variants are real coverage.")
    args = ap.parse_args()

    paras = extract_paragraphs(args.epub)
    passages = pack_passages(paras)
    if args.limit:
        passages = passages[:args.limit]
    print(f"{len(paras)} paragraphs -> {len(passages)} passages "
          f"({sum(plain_len(p) for p in passages)} chars)")

    h_dir, v_dir = HERE / "epub_h", HERE / "epub_v"
    for d in (h_dir, v_dir):
        d.mkdir(exist_ok=True)
        for old in d.glob(f"{args.prefix}_*.*"):
            old.unlink()

    # Variant offset per repeat is prime-ish vs the variant list lengths so
    # repeats of one passage land on genuinely different size/font combos.
    n = 0
    for i, passage in enumerate(passages):
        for r in range(args.per):
            vi = i + r * 3
            stem = (f"{args.prefix}_{i:05d}" if args.per == 1
                    else f"{args.prefix}_{i:05d}{chr(97 + r)}")

            font, size, gap, width, dark = H_VARIANTS[vi % len(H_VARIANTS)]
            img, truth, ruby = render_horizontal(
                passage, font, size, gap, width, dark)
            write_case(h_dir, stem, img, truth, ruby,
                       f"h {Path(font).stem} {size}px gap{gap} w{width}"
                       + (" dark" if dark else ""))

            font, size, gap, height = V_VARIANTS[vi % len(V_VARIANTS)]
            img, truth, ruby = render_vertical(passage, font, size, gap, height)
            write_case(v_dir, stem, img, truth, ruby,
                       f"v {Path(font).stem} {size}px gap{gap} h{height}")
            n += 2

        if (i + 1) % 200 == 0:
            print(f"  rendered {i + 1}/{len(passages)} passages")

    print(f"wrote {n} crops across {h_dir.name}/ and {v_dir.name}/")


if __name__ == "__main__":
    main()
