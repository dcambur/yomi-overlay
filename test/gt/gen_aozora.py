#!/usr/bin/env python3
"""Generate literary-Japanese ground-truth pages, truth by construction.

Renders public-domain literary passages into page images the way an e-reader
would (Mincho/Gothic, realistic sizes and line spacing, yokogaki + tategaki,
one dark-mode case) and writes the exact rendered string as the truth file.
Because the truth IS the render input, no hand-transcription is needed.

These are SYNTHETIC pages — they calibrate engines and catch regressions
headlessly. They do not replace real Kindle/manga/game crops (see README.md);
that's why they live in their own aozora_h / aozora_v categories.

Tategaki approximations (honest limits of PIL typography): chōonpu ー is
rotated 90°, 、。 are shifted to the cell's top-right; bracket glyphs are
left unrotated. Keep that in mind if those glyphs dominate an error report.

Usage: python3 gen_aozora.py   (rewrites gt/aozora_h and gt/aozora_v)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
MINCHO = "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc"
GOTHIC = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"

# Public-domain literary passages (Aozora Bunko corpus authors: Natsume
# Sōseki, Dazai Osamu, Akutagawa, Miyazawa Kenji). Mixed kanji density,
# kana runs, katakana, punctuation, small kana — the shapes OCR gets wrong.
PASSAGES = [
    "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。"
    "何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
    "吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは"
    "書生という人間中で一番獰悪な種族であったそうだ。",
    "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。"
    "メロスには政治がわからぬ。メロスは、村の牧人である。",
    "笛を吹き、羊と遊んで暮して来た。けれども邪悪に対しては、人一倍に敏感であった。"
    "きょう未明メロスは村を出発し、野を越え山越え、十里はなれた此のシラクスの市にやって来た。",
    "或日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。"
    "広い門の下には、この男のほかに誰もいない。",
    "ただ、所々丹塗の剥げた、大きな円柱に、蟋蟀が一匹とまっている。"
    "羅生門が、朱雀大路にある以上は、この男のほかにも、雨やみをする市女笠や揉烏帽子が、もう二三人はありそうなものである。",
    "ジョバンニは、口笛を吹いているようなさびしい口付きで、檜のまっ黒にならんだ"
    "町の坂を下りて来たのでした。",
    "カムパネルラが手をあげました。それから四五人手をあげました。"
    "ジョバンニも手をあげようとして、急いでそのままやめました。",
    "山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。"
    "意地を通せば窮屈だ。とかくに人の世は住みにくい。",
    "住みにくさが高じると、安い所へ引き越したくなる。どこへ越しても住みにくいと"
    "悟った時、詩が生れて、画が出来る。",
]

# Tategaki cell-level fixes PIL cannot do natively.
ROTATE = set("ー〜…‥")          # long marks lie along the column
CORNER = set("、。")             # sit in the cell's top-right corner


def render_horizontal(text, font_path, size, width, line_gap, dark=False):
    font = ImageFont.truetype(font_path, size)
    margin = size
    max_w = width - 2 * margin
    lines, cur = [], ""
    d = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    for ch in text:
        if d.textlength(cur + ch, font=font) > max_w:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    step = int(size * line_gap)
    h = 2 * margin + step * len(lines)
    bg, fg = ("black", "white") if dark else ("white", "black")
    img = Image.new("RGB", (width, h), bg)
    dr = ImageDraw.Draw(img)
    for i, ln in enumerate(lines):
        dr.text((margin, margin + i * step), ln, font=font, fill=fg)
    return img, "\n".join(lines)


def render_vertical(text, font_path, size, height, col_gap):
    """Columns right-to-left, chars top-to-bottom. Returns (img, truth)."""
    font = ImageFont.truetype(font_path, size)
    margin = size
    per_col = (height - 2 * margin) // int(size * 1.05)
    cols = [text[i:i + per_col] for i in range(0, len(text), per_col)]
    step_x = int(size * col_gap)
    width = 2 * margin + step_x * len(cols)
    img = Image.new("RGB", (width, height), "white")
    dr = ImageDraw.Draw(img)
    for ci, col in enumerate(cols):
        x = width - margin - (ci + 1) * step_x
        for ri, ch in enumerate(col):
            y = margin + ri * int(size * 1.05)
            if ch in ROTATE:
                tile = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
                ImageDraw.Draw(tile).text((size // 2, size // 2), ch,
                                          font=font, fill="black")
                img.paste(tile.rotate(-90), (x - size // 2, y - size // 2), tile.rotate(-90))
            elif ch in CORNER:
                dr.text((x + size // 2, y - size // 4), ch, font=font, fill="black")
            else:
                dr.text((x, y), ch, font=font, fill="black")
    return img, "\n".join(cols)


def main():
    h_dir = HERE / "aozora_h"
    v_dir = HERE / "aozora_v"
    for d in (h_dir, v_dir):
        d.mkdir(exist_ok=True)
        for old in d.glob("aozora_*.*"):
            old.unlink()

    # Horizontal: vary font, size, spacing; one dark-mode page.
    variants = [
        (MINCHO, 22, 1.6, False), (MINCHO, 16, 1.5, False),
        (GOTHIC, 20, 1.7, False), (GOTHIC, 14, 1.5, False),
        (MINCHO, 26, 1.8, False), (MINCHO, 20, 1.6, True),
        (GOTHIC, 24, 1.6, False), (MINCHO, 18, 1.4, False),
        (GOTHIC, 16, 1.8, False), (MINCHO, 24, 1.5, False),
    ]
    for i, (passage, (font, size, gap, dark)) in enumerate(zip(PASSAGES, variants)):
        img, truth = render_horizontal(passage, font, size, 860, gap, dark)
        img.save(h_dir / f"aozora_{i:02d}.png")
        (h_dir / f"aozora_{i:02d}.txt").write_text(truth + "\n")

    # Vertical: Mincho-dominant (what novels use), two sizes + one gothic.
    v_variants = [
        (MINCHO, 24, 1.9), (MINCHO, 18, 1.8), (MINCHO, 28, 2.0),
        (GOTHIC, 22, 1.9), (MINCHO, 20, 1.7), (MINCHO, 16, 1.8),
        (GOTHIC, 18, 2.0), (MINCHO, 26, 1.9), (MINCHO, 22, 1.6),
        (GOTHIC, 24, 1.8),
    ]
    for i, (passage, (font, size, gap)) in enumerate(zip(PASSAGES, v_variants)):
        img, truth = render_vertical(passage, font, size, 780, gap)
        img.save(v_dir / f"aozora_{i:02d}.png")
        (v_dir / f"aozora_{i:02d}.txt").write_text(truth + "\n")

    print(f"wrote {len(PASSAGES)} pages each to {h_dir.name}/ and {v_dir.name}/")


if __name__ == "__main__":
    main()
