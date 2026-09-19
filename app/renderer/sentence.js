// The sentence containing a glyph: which glyphs make it, how it reads with
// one word marked, and where on the page it sits. docs/ANKI.md §2.
//
// Pure: no DOM, no IPC. It is handed the glyph layer's lines and answers with
// glyph runs, so the caller can highlight, crop, or write them out.
(() => {
  const TERMINATORS = new Set(['。', '！', '？', '!', '?', '‼', '⁉']);
  // A manga bubble is ~20 glyphs and a novel sentence 40–70 on the fixture
  // pages; 120 takes a long literary sentence whole and stops a page with no
  // punctuation (a title screen, a table) from sending everything it holds.
  const MAX_SENTENCE_GLYPHS = 120;

  // --- where a sentence may cross a line break ------------------------------
  //
  // Punctuation alone is not enough: a heading, a metadata row (★73,648 ・
  // 書籍化 ・ 2026年9月18日更新) or the next column has no 。 to stop at, and a
  // syosetu ranking page read the author, the tags, the date and the NEXT
  // title as one "sentence". So lines are first grouped into blocks, and the
  // walk never leaves the block the glyph is in. A block boundary is any of:
  //   orientation   a yokogaki line beside a tategaki column
  //   column        the two lines share under 30% of the cross axis
  //   gap           the flow-axis gap is over 1.8× the page's median gap — a
  //                 paragraph, a heading, another bubble (page-a: 124–132px
  //                 at a paragraph or heading, 19–44px between the lines of
  //                 one; fixed thresholds fail across font sizes, the median
  //                 does not)
  //   not prose     under half of either line is kana/kanji — a stars-and-
  //                 dates row is its own block, never joined to a title
  // Deliberately NOT a rule: a line ending short of the block's edge. That
  // marks a paragraph end in justified prose but every line of a centred
  // manga bubble, which would split the bubble into one-line sentences.

  const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々]/;
  const GAP_RATIO = 1.8;
  const OVERLAP_MIN = 0.3;

  /** A line's box, glyph size and orientation — what the block rules compare. */
  function shape(line, pageVertical) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const sizes = [];
    for (const c of line.chars || []) {
      x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
      sizes.push(c.h);
    }
    sizes.sort((a, b) => a - b);
    const vertical = line.vertical !== undefined ? !!line.vertical : !!pageVertical;
    return { x0, y0, x1, y1, size: sizes[sizes.length >> 1] || 0, vertical };
  }

  /** Flow-axis gap from `a` to the line after it: down the page, or leftward. */
  function gapBetween(a, b) {
    return a.vertical ? a.x0 - b.x1 : b.y0 - a.y1;
  }

  /** Share of the cross axis two lines have in common — 0 for another column. */
  function overlap(a, b) {
    const [a0, a1, b0, b1] = a.vertical ? [a.y0, a.y1, b.y0, b.y1] : [a.x0, a.x1, b.x0, b.x1];
    const span = Math.min(a1 - a0, b1 - b0);
    return span > 0 ? Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / span : 0;
  }

  function prose(line) {
    let cjk = 0, n = 0;
    for (const c of line.chars || []) {
      if (/\s/.test(c.c)) continue;
      n++;
      if (CJK.test(c.c)) cjk++;
    }
    return n > 0 && cjk / n >= 0.5;
  }

  /**
   * Block id per line index; ruby lines get none.
   *
   * A line continues the nearest EARLIER line in its own column, not the
   * line before it in the payload: Vision lists a two-column page top to
   * bottom, so the array interleaves the columns and the neighbour in it is
   * usually the other column's line.
   */
  function blocks(lines, pageVertical) {
    const ids = new Array(lines.length).fill(-1);
    const order = [];
    for (let li = 0; li < lines.length; li++) {
      if (lines[li] && !lines[li].ruby && (lines[li].chars || []).length) order.push(li);
    }
    const shapes = order.map((li) => shape(lines[li], pageVertical));
    const pred = order.map(() => -1);
    for (let i = 0; i < order.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        if (shapes[j].vertical === shapes[i].vertical &&
            overlap(shapes[j], shapes[i]) >= OVERLAP_MIN) { pred[i] = j; break; }
      }
    }
    const gaps = [];
    for (let i = 0; i < order.length; i++) {
      if (pred[i] >= 0) gaps.push(gapBetween(shapes[pred[i]], shapes[i]));
    }
    gaps.sort((p, q) => p - q);
    // Under three gaps there is no "typical" gap to compare against.
    const median = gaps.length >= 3 ? gaps[gaps.length >> 1] : 0;
    let next = 0;
    for (let i = 0; i < order.length; i++) {
      const j = pred[i];
      const split = j < 0 ||
        (median > 0 && gapBetween(shapes[j], shapes[i]) > GAP_RATIO * median) ||
        !prose(lines[order[j]]) || !prose(lines[order[i]]);
      ids[order[i]] = split ? next++ : ids[order[j]];
    }
    return ids;
  }

  /**
   * Every glyph on the page with its block, block by block: within a block the
   * lines keep their order, so a column reads straight through even when the
   * payload interleaves it with another. Ruby lines left out.
   */
  function flatten(lines, pageVertical) {
    const ids = blocks(lines, pageVertical);
    const out = [];
    const seen = new Set();
    for (const first of ids) {
      if (first < 0 || seen.has(first)) continue;
      seen.add(first);
      for (let li = 0; li < lines.length; li++) {
        if (ids[li] !== first) continue;
        const chars = lines[li].chars;
        for (let ci = 0; ci < chars.length; ci++) {
          out.push({ li, ci, c: chars[ci].c, b: first });
        }
      }
    }
    return out;
  }

  /**
   * The sentence containing glyph (li, ci): back to the previous terminator,
   * forward through the next one, across line breaks inside the block — a
   * line is where the page wrapped, not where the sentence ended. Both
   * yokogaki lines and tategaki columns arrive in reading order, so one walk
   * serves both.
   *
   * Returns the text, the glyph runs per line and the count, or null when
   * the glyph is not on the page.
   */
  function around(lines, li, ci, pageVertical) {
    const flat = flatten(lines, pageVertical);
    const at = flat.findIndex((g) => g.li === li && g.ci === ci);
    if (at < 0) return null;
    const b = flat[at].b;
    let start = at, end = at;
    while (start > 0 && flat[start - 1].b === b && !TERMINATORS.has(flat[start - 1].c)) start--;
    while (end < flat.length - 1 && flat[end + 1].b === b &&
           !TERMINATORS.has(flat[end].c)) end++;
    // Over the cap, keep the glyph the reader pointed at in the middle: the
    // start of a sentence is usually more useful than its end, but the
    // pointed-at word must stay in.
    if (end - start + 1 > MAX_SENTENCE_GLYPHS) {
      start = Math.max(start, at - (MAX_SENTENCE_GLYPHS >> 1));
      end = Math.min(end, start + MAX_SENTENCE_GLYPHS - 1);
    }
    const runs = [];
    for (let i = start; i <= end; i++) {
      const g = flat[i];
      const last = runs[runs.length - 1];
      if (last && last.li === g.li && last.ci + last.n === g.ci) last.n++;
      else runs.push({ li: g.li, ci: g.ci, n: 1 });
    }
    const text = flat.slice(start, end + 1).map((g) => g.c).join('');
    return { text, runs, glyphs: end - start + 1 };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * The sentence as HTML with the matched glyphs — `hit` is {li, ci, n}, a
   * run on one line — inside one <b>. Lapis colours that word by pitch and
   * its audio card hides it, so the tag is the contract; everything else is
   * text, escaped.
   */
  function markup(lines, sentence, hit) {
    let html = '', open = false;
    for (const r of sentence.runs) {
      const chars = lines[r.li].chars;
      for (let k = 0; k < r.n; k++) {
        const ci = r.ci + k;
        const inHit = r.li === hit.li && ci >= hit.ci && ci < hit.ci + hit.n;
        if (inHit && !open) { html += '<b>'; open = true; }
        if (!inHit && open) { html += '</b>'; open = false; }
        html += esc(chars[ci].c);
      }
    }
    return open ? html + '</b>' : html;
  }

  /**
   * The frame-relative box the sentence's glyphs occupy, padded by one glyph
   * size on every side — enough margin to read as a clipping rather than a
   * strip of letters, not enough to take the next paragraph with it.
   */
  function region(lines, sentence) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const sizes = [];
    for (const r of sentence.runs) {
      const chars = lines[r.li].chars;
      for (let k = 0; k < r.n; k++) {
        const c = chars[r.ci + k];
        x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
        x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
        sizes.push(Math.max(c.w, c.h));
      }
    }
    if (!sizes.length) return null;
    sizes.sort((a, b) => a - b);
    const pad = sizes[sizes.length >> 1];
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }

  window.sentence = { around, markup, region, MAX_SENTENCE_GLYPHS };
})();
